"""
"עובד מחובר בקופה אחת בלבד" — an employee signed in at one device cannot sign in at another
until they sign out there (docs/SPEC_EXCLUSIVE_LOGIN.md; v2: P:/specs/exclusive-login-v2.md).

The till asks before it lets an employee in (`claim`), says every minute that they are
still there (`heartbeat`), and lets go when they leave (`release`). The cloud keeps one
live `PosUserSession` per employee; the till parameters, read for the till that asks, decide
whether the rule applies there at all (`exclusiveUserLogin`) and how it behaves
(`exclusiveUserLoginAutoRelease`, `…StaleMinutes`, `…Offline`, `…Duplicate` — `Policy`).

* **Off** — a claim or a heartbeat records nothing and always succeeds; switching the
  parameter on takes effect from the next sign-in, and for whoever is already signed in
  from their till's next heartbeat (about a minute).
* **Exempt** — an employee whose till permission "עבודה בכמה מכשירים במקביל"
  (`MULTI_DEVICE_LOGIN`) is `allow` (by default a supervisor and a manager, or anyone by an
  override on their card) is not bound: `exempt`, nothing recorded.
* **Auto release** — off by default (the owner: only a manager releases). With `minutes`, a
  session whose till has not been heard from for the stale minutes is released by the next
  claim of that employee anywhere (`released_by = "stale"`), as in v1. Either way the 409
  says when the other device went silent (`holderSilentSince`), so a manager knows it is safe.
* **Forced** — a manager's approval at the device the employee moved to releases the other
  session (`"manager"`): a code typed at the till, the signed-in manager themselves, or an
  approval from the phone ("בקשת שחרור ממנהל", remote-approval type `user_release`). A manager
  can also release from the dashboard. Every one of them is recorded as an exception
  (`user_session_release`).
* **Duplicate** — an employee found signed in at two devices after an offline sign-in: the
  heartbeat's 409 carries `duplicate` (`warn` — a banner; `signout` — the device that signed in
  last signs them out at the end of its operation). With `signout`, a till whose own sign-in
  (`signedInAt`) came first takes the session, and the other device hears it as a release
  (`released_by = "duplicate"`).
* **Self-healing** — a till has one operator at a time, so a claim or heartbeat for one
  employee lets go of anyone else the same till still held (a release that never arrived).

A till that loses its session to a manager (forced at another device, or from the dashboard)
or to a duplicate hears it on its next heartbeat (`SessionReleased`) and signs the employee out.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.pos_user_session import PosUserSession
from app.models.user import User
from app.services import till_parameters as TPARAMS
from app.services.areas import as_utc
from app.services.till_parameters import till_parameters_for_machine

logger = logging.getLogger(__name__)

PARAM_ENABLED = "exclusiveUserLogin"
PARAM_STALE_MINUTES = "exclusiveUserLoginStaleMinutes"
PARAM_AUTO_RELEASE = TPARAMS.EXCLUSIVE_AUTO_RELEASE_KEY
PARAM_OFFLINE = TPARAMS.EXCLUSIVE_OFFLINE_KEY
PARAM_DUPLICATE = TPARAMS.EXCLUSIVE_DUPLICATE_KEY
DEFAULT_STALE_MINUTES = 15
STALE_MINUTES_MIN = 2
STALE_MINUTES_MAX = 720

AUTO_RELEASE_OFF = TPARAMS.EXCLUSIVE_AUTO_RELEASE_OFF
AUTO_RELEASE_MINUTES = TPARAMS.EXCLUSIVE_AUTO_RELEASE_MINUTES
AUTO_RELEASE_MODES = (AUTO_RELEASE_OFF, AUTO_RELEASE_MINUTES)
OFFLINE_ALLOW = TPARAMS.EXCLUSIVE_OFFLINE_ALLOW
OFFLINE_LAN = TPARAMS.EXCLUSIVE_OFFLINE_LAN
OFFLINE_MANAGER = TPARAMS.EXCLUSIVE_OFFLINE_MANAGER
OFFLINE_MODES = (OFFLINE_ALLOW, OFFLINE_LAN, OFFLINE_MANAGER)
DUPLICATE_WARN = TPARAMS.EXCLUSIVE_DUPLICATE_WARN
DUPLICATE_SIGNOUT = TPARAMS.EXCLUSIVE_DUPLICATE_SIGNOUT
DUPLICATE_MODES = (DUPLICATE_WARN, DUPLICATE_SIGNOUT)

#: The till permission that exempts an employee ("עבודה בכמה מכשירים במקביל").
PERMISSION_EXEMPT = "MULTI_DEVICE_LOGIN"
#: The dashboard permission ("שחרור עובד מחובר במכשיר") a release from the dashboard needs.
RELEASE_SECTION = "user_sessions_release"

#: A till heartbeats every minute while someone is signed in: three missed ones and it is
#: "not reporting" — the 409's `holderSilentSince`, the dashboard's "לא מדווח".
SILENT_AFTER = timedelta(minutes=3)
#: A till's clock may run a little ahead of ours: a `signedInAt` beyond this is not believed.
_CLOCK_SKEW = timedelta(minutes=2)

#: The exception a manager's release is reported under (app/services/exceptions.py).
EXCEPTION_TYPE = "user_session_release"
#: How a manager released it (the exception's `via`).
VIA_TILL = "till"
VIA_REMOTE = "remote"
VIA_DASHBOARD = "dashboard"
#: The releases a till hears on its heartbeat and signs the employee out for.
KICKED_BY = ("manager", "duplicate")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment is not None else None


def _same(a: Any, b: Any) -> bool:
    return a is not None and b is not None and str(a) == str(b)


# ── The parameters ───────────────────────────────────────────────────────────


def enabled_of(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "כן")
    return False


def stale_minutes_of(value: Any) -> int:
    """The stale minutes as set, within 2–720; anything unusable is the default 15."""
    if isinstance(value, bool) or value is None:
        return DEFAULT_STALE_MINUTES
    try:
        minutes = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return DEFAULT_STALE_MINUTES
    if minutes <= 0:
        return DEFAULT_STALE_MINUTES
    return max(STALE_MINUTES_MIN, min(STALE_MINUTES_MAX, minutes))


def choice_of(value: Any, options: tuple, default: str) -> str:
    """One of `options` as set; anything else (unset, unknown, mistyped) is the default."""
    if isinstance(value, str) and value.strip().lower() in options:
        return value.strip().lower()
    return default


@dataclass(frozen=True)
class Policy:
    enabled: bool
    stale_minutes: int = DEFAULT_STALE_MINUTES
    #: off (the default: only a manager releases) | minutes (after `stale_minutes`, as v1).
    auto_release: str = AUTO_RELEASE_OFF
    #: allow | lan | manager — read by the till; the cloud only says it.
    offline: str = OFFLINE_ALLOW
    #: warn | signout — two devices found after an offline sign-in.
    duplicate: str = DUPLICATE_WARN

    @property
    def releases_stale(self) -> bool:
        return self.auto_release == AUTO_RELEASE_MINUTES

    def out(self) -> Dict[str, Any]:
        """The fields every claim / heartbeat answer (200 or 409) carries."""
        return {
            "exclusive": self.enabled,
            "staleMinutes": self.stale_minutes,
            "autoRelease": self.auto_release,
            "offline": self.offline,
            "duplicate": self.duplicate,
        }


def policy_of(parameters: Dict[str, Any]) -> Policy:
    return Policy(
        enabled=enabled_of(parameters.get(PARAM_ENABLED)),
        stale_minutes=stale_minutes_of(parameters.get(PARAM_STALE_MINUTES)),
        auto_release=choice_of(parameters.get(PARAM_AUTO_RELEASE), AUTO_RELEASE_MODES, AUTO_RELEASE_OFF),
        offline=choice_of(parameters.get(PARAM_OFFLINE), OFFLINE_MODES, OFFLINE_ALLOW),
        duplicate=choice_of(parameters.get(PARAM_DUPLICATE), DUPLICATE_MODES, DUPLICATE_WARN),
    )


def policy_for_machine(db: Session, machine: POSMachine) -> Policy:
    return policy_of(till_parameters_for_machine(db, machine).parameters)


def is_stale(row: PosUserSession, now: datetime, stale_minutes: int) -> bool:
    seen = as_utc(row.last_seen_at) or as_utc(row.started_at)
    return seen is None or now - seen >= timedelta(minutes=stale_minutes)


def silent_since(row: PosUserSession, now: datetime) -> Optional[datetime]:
    """When the session's till was last heard from, if it has stopped reporting; else None."""
    seen = as_utc(row.last_seen_at) or as_utc(row.started_at)
    if seen is None or now - seen >= SILENT_AFTER:
        return seen
    return None


def is_exempt(pos_user: PosUser) -> bool:
    """"עבודה בכמה מכשירים במקביל" at `allow` — the role's, or the employee's own override."""
    from app.services.till_roles import pos_user_allows

    return pos_user_allows(pos_user, PERMISSION_EXEMPT)


# ── Names ────────────────────────────────────────────────────────────────────


def pos_user_name(pos_user: Optional[PosUser]) -> Optional[str]:
    if pos_user is None:
        return None
    full = " ".join(p for p in (pos_user.first_name or "", pos_user.last_name or "") if p).strip()
    return full or pos_user.username


def dashboard_user_name(user: Optional[User]) -> Optional[str]:
    if user is None:
        return None
    return user.username or user.email


def till_label(machine: Optional[POSMachine]) -> Optional[str]:
    """"קופה 3 (בר)": its number and its name, whichever it has."""
    if machine is None:
        return None
    number = machine.pos_number or machine.machine_code
    if not number:
        return machine.name or None
    head = f"קופה {number}"
    if machine.name and machine.name.strip() != head:
        return f"{head} ({machine.name.strip()})"
    return head


def holder_info(db: Session, row: PosUserSession) -> Dict[str, Any]:
    """Where an employee is signed in: the till's name and number, since when."""
    machine = db.get(POSMachine, row.machine_id)
    pos_user = db.get(PosUser, row.pos_user_id)
    return {
        "sessionId": str(row.id),
        "posUserId": str(row.pos_user_id),
        "posUserName": pos_user_name(pos_user),
        "machineId": str(row.machine_id),
        "machineName": machine.name if machine is not None else None,
        "posNumber": (machine.pos_number or machine.machine_code) if machine is not None else None,
        "since": _iso(row.started_at),
        "lastSeenAt": _iso(row.last_seen_at),
    }


def conflict_info(db: Session, row: PosUserSession, now: datetime) -> Dict[str, Any]:
    """`holder_info` and, when that device has stopped reporting, since when (`holderSilentSince`)."""
    return {**holder_info(db, row), "holderSilentSince": _iso(silent_since(row, now))}


# ── Outcomes ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Approval:
    """Who approved a forced release: a till user or a cloud account, by name, and how."""

    name: Optional[str] = None
    user_id: Optional[uuid.UUID] = None
    pos_user_id: Optional[str] = None
    #: till (a code typed, or the signed-in manager) | remote (from the phone) | dashboard
    via: str = VIA_TILL
    #: The phone's request (`approval_requests.id`) when `via` is remote.
    approval_request_id: Optional[str] = None


class SignedInElsewhere(Exception):
    """The employee holds a live session at another till. `info` is `conflict_info`."""

    def __init__(self, info: Dict[str, Any], policy: Optional[Policy] = None):
        super().__init__("user_signed_in_elsewhere")
        self.info = info
        self.policy = policy

    def detail(self) -> Dict[str, Any]:
        return {**(self.info or {}), **(self.policy.out() if self.policy is not None else {})}


class SessionReleased(Exception):
    """This till's session was released by a manager (or a duplicate); the till must sign the employee out."""

    def __init__(self, info: Dict[str, Any], policy: Optional[Policy] = None):
        super().__init__("user_session_released")
        self.info = info
        self.policy = policy

    def detail(self) -> Dict[str, Any]:
        return {**(self.info or {}), **(self.policy.out() if self.policy is not None else {})}


@dataclass
class ClaimResult:
    #: claimed (a new session) | held (already this till's) | off (the rule is off here) |
    #: exempt (the employee may work on several devices — nothing recorded)
    status: str
    policy: Policy
    session: Optional[PosUserSession] = None
    #: The other till's session this claim released: its `holder_info` and how ("stale" / "manager" / "duplicate").
    took_over: Optional[Dict[str, Any]] = None

    @property
    def forced(self) -> bool:
        return bool(self.took_over) and self.took_over.get("releasedBy") == "manager"

    def out(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            **self.policy.out(),
            "sessionId": str(self.session.id) if self.session is not None else None,
            "since": _iso(self.session.started_at) if self.session is not None else None,
            "tookOver": self.took_over,
        }


# ── The till's side ──────────────────────────────────────────────────────────


def _active_for_user(db: Session, pos_user_id: Any, *, lock: bool = False) -> Optional[PosUserSession]:
    query = db.query(PosUserSession).filter(
        PosUserSession.pos_user_id == pos_user_id, PosUserSession.released_at.is_(None)
    )
    if lock:
        query = query.with_for_update()
    return query.first()


def _release(
    row: PosUserSession,
    how: str,
    now: datetime,
    *,
    name: Optional[str] = None,
    machine_id: Any = None,
) -> None:
    row.released_at = now
    row.released_by = how
    row.released_by_name = name
    row.released_by_machine_id = machine_id


def _release_others_on_machine(db: Session, machine: POSMachine, keep_pos_user_id: Any, now: datetime) -> int:
    """A till has one operator: anyone else it still holds left without a release arriving."""
    rows = (
        db.query(PosUserSession)
        .filter(
            PosUserSession.machine_id == machine.id,
            PosUserSession.released_at.is_(None),
            PosUserSession.pos_user_id != keep_pos_user_id,
        )
        .all()
    )
    for row in rows:
        _release(row, "self", now)
    return len(rows)


def _exempt(db: Session, machine: POSMachine, pos_user: PosUser, policy: Policy, now: datetime) -> ClaimResult:
    """
    An employee the rule does not bind: nothing recorded. Whatever this till still held — someone
    before them, or their own session from before they got the permission — is let go.
    """
    _release_others_on_machine(db, machine, pos_user.id, now)
    release(db, machine, pos_user.id, now=now)
    return ClaimResult("exempt", policy)


def _insert(db: Session, machine: POSMachine, pos_user: PosUser, now: datetime) -> PosUserSession:
    row = PosUserSession(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        shop_id=machine.shop_id,
        pos_user_id=pos_user.id,
        machine_id=machine.id,
        started_at=now,
        last_seen_at=now,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        # Another till claimed the same employee in the same moment and won the index.
        winner = _active_for_user(db, pos_user.id)
        raise SignedInElsewhere(conflict_info(db, winner, now) if winner is not None else {})
    return row


def _claim(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    policy: Policy,
    now: datetime,
    *,
    approval: Optional[Approval] = None,
) -> ClaimResult:
    _release_others_on_machine(db, machine, pos_user.id, now)
    active = _active_for_user(db, pos_user.id, lock=True)
    if active is not None and _same(active.machine_id, machine.id):
        active.last_seen_at = now
        return ClaimResult("held", policy, session=active)

    took_over = None
    if active is not None:
        if policy.releases_stale and is_stale(active, now, policy.stale_minutes):
            took_over = {**holder_info(db, active), "releasedBy": "stale"}
            _release(active, "stale", now)
        elif approval is not None:
            took_over = {
                **holder_info(db, active), "releasedBy": "manager", "approvedBy": approval.name, "via": approval.via,
            }
            _release(active, "manager", now, name=approval.name, machine_id=machine.id)
        else:
            raise SignedInElsewhere(conflict_info(db, active, now), policy)
    # The release reaches the table before the new row meets the one-live-session index.
    db.flush()
    try:
        row = _insert(db, machine, pos_user, now)
    except SignedInElsewhere as lost:
        lost.policy = policy
        raise
    return ClaimResult("claimed", policy, session=row, took_over=took_over)


def claim(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    *,
    approval: Optional[Approval] = None,
    now: Optional[datetime] = None,
) -> ClaimResult:
    """
    Sign `pos_user` in at `machine`: free, already this till's, or (auto release on) stale
    elsewhere → the session is this till's. Live elsewhere → `SignedInElsewhere`, unless
    `approval` (a manager's, checked by the caller) releases the other one. Off here, or an
    employee the rule does not bind → nothing recorded. The caller commits.
    """
    now = now or _now()
    policy = policy_for_machine(db, machine)
    if not policy.enabled:
        return ClaimResult("off", policy)
    if is_exempt(pos_user):
        return _exempt(db, machine, pos_user, policy, now)
    return _claim(db, machine, pos_user, policy, now, approval=approval)


def _latest_here(db: Session, machine: POSMachine, pos_user_id: Any) -> Optional[PosUserSession]:
    return (
        db.query(PosUserSession)
        .filter(PosUserSession.machine_id == machine.id, PosUserSession.pos_user_id == pos_user_id)
        .order_by(PosUserSession.started_at.desc())
        .first()
    )


def released_info(db: Session, mine: PosUserSession, active: Optional[PosUserSession]) -> Dict[str, Any]:
    return {
        "releasedBy": mine.released_by,
        "releasedByName": mine.released_by_name,
        "releasedAt": _iso(mine.released_at),
        "fromDashboard": mine.released_by == "manager" and mine.released_by_machine_id is None,
        "now": holder_info(db, active) if active is not None else None,
    }


def _believed(signed_in_at: Optional[datetime], now: datetime) -> Optional[datetime]:
    """The till's own sign-in time, unless it reads as later than now (a clock far ahead)."""
    moment = as_utc(signed_in_at)
    if moment is None or moment > now + _CLOCK_SKEW:
        return None
    return moment


def heartbeat(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    *,
    signed_in_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> ClaimResult:
    """
    The till still has `pos_user` signed in (since `signed_in_at`, its own clock, if it says).
    Held here → refreshed. Taken from this till by a manager or a duplicate after that sign-in →
    `SessionReleased` (the till signs them out). Otherwise as a claim: a till that was offline at
    sign-in, or whose session went stale, takes it (back) when it is free — and hears
    `SignedInElsewhere` when someone else has it now, unless (`duplicate = signout`) its own
    sign-in came first: then the other device signed in last and loses it.
    """
    now = now or _now()
    policy = policy_for_machine(db, machine)
    if not policy.enabled:
        return ClaimResult("off", policy)
    if is_exempt(pos_user):
        return _exempt(db, machine, pos_user, policy, now)
    active = _active_for_user(db, pos_user.id, lock=True)
    if active is not None and _same(active.machine_id, machine.id):
        _release_others_on_machine(db, machine, pos_user.id, now)
        active.last_seen_at = now
        return ClaimResult("held", policy, session=active)
    since = _believed(signed_in_at, now)
    mine = _latest_here(db, machine, pos_user.id)
    if mine is not None and mine.released_at is not None and mine.released_by in KICKED_BY:
        # A sign-in here after that release (offline, so no claim recorded it) is a new one.
        if since is None or since <= as_utc(mine.released_at):
            raise SessionReleased(released_info(db, mine, active), policy)
    if (
        active is not None
        and policy.duplicate == DUPLICATE_SIGNOUT
        and since is not None
        and since < as_utc(active.started_at)
        and not (policy.releases_stale and is_stale(active, now, policy.stale_minutes))
    ):
        # Signed in here first (offline); the other device signed in last — it signs them out.
        _release_others_on_machine(db, machine, pos_user.id, now)
        took_over = {**holder_info(db, active), "releasedBy": "duplicate"}
        _release(active, "duplicate", now, machine_id=machine.id)
        db.flush()
        try:
            row = _insert(db, machine, pos_user, now)
        except SignedInElsewhere as lost:
            lost.policy = policy
            raise
        return ClaimResult("claimed", policy, session=row, took_over=took_over)
    return _claim(db, machine, pos_user, policy, now)


def release(db: Session, machine: POSMachine, pos_user_id: Any, *, now: Optional[datetime] = None) -> bool:
    """The employee left this till. Only this till's session; idempotent. The caller commits."""
    now = now or _now()
    rows = (
        db.query(PosUserSession)
        .filter(
            PosUserSession.machine_id == machine.id,
            PosUserSession.pos_user_id == pos_user_id,
            PosUserSession.released_at.is_(None),
        )
        .all()
    )
    for row in rows:
        _release(row, "self", now)
    return bool(rows)


def record_forced_release(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    took_over: Dict[str, Any],
    approval: Approval,
    *,
    now: Optional[datetime] = None,
) -> None:
    """
    Report a manager's release to the exceptions ("חריגות") as a till event of type
    `user_session_release`, about the employee — at the device they moved to (a code at the
    till, an approval from the phone), or at the device they were released from (the
    dashboard: nobody moved anywhere yet). Never fails the release: a savepoint, and an error
    is only logged.
    """
    now = now or _now()
    try:
        from app.models.audit_exception import TillEvent
        from app.services import exceptions as EX

        if EXCEPTION_TYPE not in getattr(EX, "RULES_BY_TYPE", {}):
            return
        name = pos_user_name(pos_user)
        from_till = " ".join(
            p for p in (
                f"קופה {took_over.get('posNumber')}" if took_over.get("posNumber") else None,
                f"({took_over.get('machineName')})" if took_over.get("machineName") else None,
            ) if p
        )
        how = {VIA_REMOTE: "באישור מהנייד", VIA_DASHBOARD: "מהדשבורד"}.get(approval.via)
        summary = " · ".join(
            p for p in (
                name,
                f"שוחרר/ה מ{from_till}" if from_till else None,
                how,
                f"אישר: {approval.name}" if approval.name else None,
            ) if p
        )
        event = TillEvent(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            machine_id=machine.id,
            shop_id=machine.shop_id,
            area_id=machine.area_id,
            shift_id=None,
            event_type=EXCEPTION_TYPE,
            occurred_at=now,
            pos_user_id=str(pos_user.id),
            amount=None,
            transaction_id=None,
            details={
                "source": "exclusive_login",
                "via": approval.via,
                "summary": summary,
                "posUserName": name,
                "fromMachineId": took_over.get("machineId"),
                "fromMachineName": took_over.get("machineName"),
                "fromPosNumber": took_over.get("posNumber"),
                "signedInSince": took_over.get("since"),
                "lastSeenAt": took_over.get("lastSeenAt"),
                "approvedBy": approval.name,
                "approvedByPosUserId": approval.pos_user_id,
                "approvedByUserId": str(approval.user_id) if approval.user_id else None,
                "approvalRequestId": approval.approval_request_id,
            },
            received_at=now,
        )
        with db.begin_nested():
            db.add(event)
            db.flush()
            EX.Detector(db).event(event)
    except Exception:  # noqa: BLE001 - an exception missed is found by a rescan
        logger.exception("could not report the release of %s to the exceptions", pos_user.id)


# ── "בקשת שחרור ממנהל" (the phone) ───────────────────────────────────────────


def _local_hhmm(db: Session, tenant_id: Any, moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    if moment is None:
        return None
    try:
        from app.services.reports import _load_zoneinfo, resolve_report_timezone

        zone = _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
        return moment.astimezone(zone).strftime("%H:%M")
    except Exception:  # noqa: BLE001 - a zone that does not read: the time as UTC
        return moment.strftime("%H:%M")


def approval_payload(
    db: Session,
    machine: POSMachine,
    pos_user: Optional[PosUser],
    payload: Optional[Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The remote-approval request "שחרור עובד מחובר" (`user_release`) as the cloud fills it in: the
    employee (`posUserId`, the till's word or the requester), where they are signed in now
    (`holder`, with `holderSilentSince`) and the line the approver reads ("דנה מנסה להתחבר
    בקופה 3, ומחובר/ת בקופה 1 מאז 14:05") — the till's own payload kept beside it.
    """
    now = now or _now()
    out = dict(payload or {})
    target = pos_user
    wanted = out.get("posUserId")
    if wanted and (target is None or str(target.id) != str(wanted)):
        try:
            target = (
                db.query(PosUser)
                .filter(PosUser.id == uuid.UUID(str(wanted)), PosUser.shop_id == machine.shop_id)
                .first()
            )
        except (TypeError, ValueError):
            target = None
    if target is None:
        return out
    name = pos_user_name(target)
    out["posUserId"] = str(target.id)
    out["posUserName"] = name
    here = till_label(machine)
    active = _active_for_user(db, target.id)
    parts = [f"{name} מנסה להתחבר" + (f" ב{here}" if here else "")]
    if active is not None and not _same(active.machine_id, machine.id):
        info = conflict_info(db, active, now)
        out["holder"] = info
        there = till_label(db.get(POSMachine, active.machine_id))
        since = _local_hhmm(db, machine.tenant_id, active.started_at)
        parts.append(
            "ומחובר/ת" + (f" ב{there}" if there else " במכשיר אחר") + (f" מאז {since}" if since else "")
        )
        silent = silent_since(active, now)
        if silent is not None:
            parts.append(f"המכשיר לא מדווח מאז {_local_hhmm(db, machine.tenant_id, silent)}")
    out["summary"] = ", ".join(parts)
    return out


def remote_grant_user(db: Session, approval_request_id: Any) -> Optional[str]:
    """The employee a phone's "שחרור עובד מחובר" approval was given for (its payload), if it says."""
    from app.models.remote_approval import ApprovalRequest

    req = db.get(ApprovalRequest, approval_request_id) if approval_request_id is not None else None
    if req is None:
        return None
    payload = req.payload if isinstance(req.payload, dict) else {}
    wanted = payload.get("posUserId") or (str(req.requester_pos_user_id) if req.requester_pos_user_id else None)
    return str(wanted) if wanted else None


# ── The dashboard's side ─────────────────────────────────────────────────────


def may_release_from_dashboard(db: Session, user: Any) -> bool:
    """
    "שחרור עובד מחובר במכשיר" (`user_sessions_release`): a role that may release at all (the
    super admin, a distributor, a company manager, a shop manager — permission_matrix
    `USER_SESSION`) whose dashboard permissions hold it at edit (a template or a grant; "גישה
    מלאה לפי תפקיד" holds every section). The rows a manager may touch are still their shops only.
    """
    from app.services import dashboard_access as DA
    from app.services.dashboard_sections import EDIT
    from app.services.permission_matrix import Action, Resource, may

    if user is None or not may(getattr(user, "role", None), Resource.USER_SESSION, Action.WRITE):
        return False
    return DA.effective_access(db, user).allows(RELEASE_SECTION, EDIT)


def active_sessions_for_shop(db: Session, shop_id: Any, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    Who is signed in at which till of the shop now, oldest first. `silent`: the till stopped
    reporting (since `silentSince`); `stale`: auto release is on there and the next claim
    elsewhere would take it.
    """
    now = now or _now()
    rows = (
        db.query(PosUserSession)
        .filter(PosUserSession.shop_id == shop_id, PosUserSession.released_at.is_(None))
        .order_by(PosUserSession.started_at)
        .all()
    )
    if not rows:
        return []
    machines = {
        str(m.id): m
        for m in db.query(POSMachine).filter(POSMachine.id.in_({r.machine_id for r in rows})).all()
    }
    users = {
        str(u.id): u
        for u in db.query(PosUser).filter(PosUser.id.in_({r.pos_user_id for r in rows})).all()
    }
    policies: Dict[str, Policy] = {}
    out: List[Dict[str, Any]] = []
    for row in rows:
        machine = machines.get(str(row.machine_id))
        pos_user = users.get(str(row.pos_user_id))
        if machine is not None and str(machine.id) not in policies:
            policies[str(machine.id)] = policy_for_machine(db, machine)
        policy = policies.get(str(row.machine_id)) or Policy(enabled=False)
        silent = silent_since(row, now)
        out.append({
            "id": str(row.id),
            "posUserId": str(row.pos_user_id),
            "posUserName": pos_user_name(pos_user),
            "username": pos_user.username if pos_user is not None else None,
            "machineId": str(row.machine_id),
            "machineName": machine.name if machine is not None else None,
            "posNumber": (machine.pos_number or machine.machine_code) if machine is not None else None,
            "startedAt": _iso(row.started_at),
            "lastSeenAt": _iso(row.last_seen_at),
            "silent": silent is not None,
            "silentSince": _iso(silent),
            "stale": policy.releases_stale and is_stale(row, now, policy.stale_minutes),
            "autoRelease": policy.auto_release,
            "staleMinutes": policy.stale_minutes,
        })
    return out


def release_by_dashboard(db: Session, row: PosUserSession, user: User, *, now: Optional[datetime] = None) -> bool:
    """
    A manager releases it from the dashboard (or the phone's "מחוברים כעת במכשירים"); the till
    signs the employee out on its next heartbeat. Recorded as an exception, at that till.
    False when it was no longer live.
    """
    if row.released_at is not None:
        return False
    now = now or _now()
    info = holder_info(db, row)
    name = dashboard_user_name(user)
    _release(row, "manager", now, name=name)
    machine = db.get(POSMachine, row.machine_id)
    pos_user = db.get(PosUser, row.pos_user_id)
    if machine is not None and pos_user is not None:
        db.flush()
        record_forced_release(
            db, machine, pos_user, info,
            Approval(name=name, user_id=getattr(user, "id", None), via=VIA_DASHBOARD),
            now=now,
        )
    return True
