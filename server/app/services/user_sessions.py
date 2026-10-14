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
* **From any device, tables and all** (§8) — "עובדים מחוברים" at any till, handheld or phone, and
  the dashboard, release through `manager_release`: the employee's open tables stay theirs (or are
  handed on, `exclusiveReleaseTables = ask`), and a silent device's locks on them are freed in the
  same action, with what that means said to the manager.

A till that loses its session to a manager (forced at another device, or from the dashboard)
or to a duplicate hears it on its next heartbeat (`SessionReleased`) and signs the employee out.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

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
PARAM_RELEASE_TABLES = TPARAMS.EXCLUSIVE_RELEASE_TABLES_KEY
RELEASE_TABLES_KEEP = TPARAMS.EXCLUSIVE_RELEASE_TABLES_KEEP
RELEASE_TABLES_ASK = TPARAMS.EXCLUSIVE_RELEASE_TABLES_ASK
RELEASE_TABLES_MODES = (RELEASE_TABLES_KEEP, RELEASE_TABLES_ASK)

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
    #: keep | ask — a manager's release keeps the employee's open tables, or asks to hand them on (§8ב).
    release_tables: str = RELEASE_TABLES_KEEP

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
            "releaseTables": self.release_tables,
        }


def policy_of(parameters: Dict[str, Any]) -> Policy:
    return Policy(
        enabled=enabled_of(parameters.get(PARAM_ENABLED)),
        stale_minutes=stale_minutes_of(parameters.get(PARAM_STALE_MINUTES)),
        auto_release=choice_of(parameters.get(PARAM_AUTO_RELEASE), AUTO_RELEASE_MODES, AUTO_RELEASE_OFF),
        offline=choice_of(parameters.get(PARAM_OFFLINE), OFFLINE_MODES, OFFLINE_ALLOW),
        duplicate=choice_of(parameters.get(PARAM_DUPLICATE), DUPLICATE_MODES, DUPLICATE_WARN),
        release_tables=choice_of(parameters.get(PARAM_RELEASE_TABLES), RELEASE_TABLES_MODES, RELEASE_TABLES_KEEP),
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
            # The employee moves here and carries on their tables (§8ב); a silent device's locks on them go.
            took_over = {
                **holder_info(db, active), "releasedBy": "manager", "approvedBy": approval.name, "via": approval.via,
                **_tables_on_release(db, active, approval, now),
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
        open_tables = took_over.get("openTables") or 0
        unlocked = took_over.get("tablesUnlocked") or []
        moved = took_over.get("tablesTransferred") or []
        summary = " · ".join(
            p for p in (
                name,
                f"שוחרר/ה מ{from_till}" if from_till else None,
                how,
                f"אישר: {approval.name}" if approval.name else None,
                f"{open_tables} שולחנות פתוחים" if open_tables else None,
                f"שוחררו נעילות: {_tables_text(unlocked)}" if unlocked else None,
                f"הועברו: {_moves_text(moved)}" if moved else None,
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
                # §8ב: the tables that were the employee's, those a silent device held and lost, and
                # those handed on ("החלפת מלצר").
                "openTables": open_tables,
                "tablesUnlocked": unlocked,
                "tablesTransferred": moved,
                "warnings": took_over.get("warnings") or [],
            },
            received_at=now,
        )
        with db.begin_nested():
            db.add(event)
            db.flush()
            EX.Detector(db).event(event)
    except Exception:  # noqa: BLE001 - an exception missed is found by a rescan
        logger.exception("could not report the release of %s to the exceptions", pos_user.id)


# ── The employee's tables at a release (§8ב) ─────────────────────────────────


class TablesKeep(Exception):
    """A hand-over asked for where `exclusiveReleaseTables` is `keep`: the tables stay the employee's."""


def _table_label(number: Any, name: Any) -> str:
    return str(number) if number not in (None, "") else (str(name) if name else "?")


def _tables_text(tables: List[Dict[str, Any]]) -> str:
    return ", ".join(f"שולחן {_table_label(t.get('number'), t.get('name'))}" for t in tables)


def _moves_text(moves: List[Dict[str, Any]]) -> str:
    return ", ".join(
        f"שולחן {_table_label(m.get('number'), m.get('name'))} ל{m.get('toName') or '?'}" for m in moves
    )


def open_tables_of(db: Session, shop_id: Any, pos_user_id: Any) -> List[Dict[str, Any]]:
    """The employee's open tables as the cloud has them (theirs as the waiter, else as the opener)."""
    from app.services.attendance import open_tables_for

    try:
        with db.begin_nested():
            return open_tables_for(db, shop_id, pos_user_id)
    except Exception:  # noqa: BLE001 - no tables here (a database without them): none
        logger.debug("open tables of %s not read", pos_user_id)
        return []


def free_silent_tables(
    db: Session, row: PosUserSession, approval: Approval, now: datetime,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    A manager releases an employee whose device stopped reporting: the tables that device still
    locks for them are released in the same action (as TABLE_UNLOCK's forced release, in each
    table's history), and the manager is told what that means — what the dead device never saved
    is not in the cloud. A device that reports keeps its tables: it leaves them at the end of its
    operation, then signs the employee out. Returns (the tables freed, the warnings).
    """
    silent = silent_since(row, now)
    if silent is None:
        return [], []
    try:
        from sqlalchemy import or_

        from app.models.tables import DiningTable
        from app.services import tables as T

        with db.begin_nested():
            held = (
                db.query(DiningTable)
                .filter(
                    DiningTable.lock_machine_id == row.machine_id,
                    or_(DiningTable.lock_pos_user_id == str(row.pos_user_id), DiningTable.lock_pos_user_id.is_(None)),
                )
                .all()
            )
            freed: List[Dict[str, Any]] = []
            warnings: List[str] = []
            since = _local_hhmm(db, row.tenant_id, silent)
            for table in held:
                if not T.lock_live(table, now):
                    continue
                holder = T.lock_out(db, table, now)
                order = T.open_order(db, table.id)
                T.clear_lock(db, table)
                T.record_event(
                    db, "force_release", table, order, user_id=approval.user_id, now=now,
                    details={
                        "heldBy": holder, "approvedBy": approval.name, "from": "user_session_release",
                        "via": approval.via, "silentSince": _iso(silent),
                    },
                )
                label = _table_label(table.number, table.name)
                freed.append({
                    "tableId": str(table.id),
                    "number": table.number,
                    "name": table.name,
                    "orderId": str(order.id) if order is not None else None,
                })
                warnings.append(
                    f"שולחן {label} נפתח במכשיר שלא מדווח מאז {since}. שינויים שלא נשמרו שם לא יופיעו."
                )
            db.flush()
        return freed, warnings
    except Exception:  # noqa: BLE001 - the release itself never fails for the tables
        logger.exception("the tables of a silent device were not freed for %s", row.pos_user_id)
        return [], []


def _tables_on_release(db: Session, row: PosUserSession, approval: Approval, now: datetime) -> Dict[str, Any]:
    """What a manager's release of `row` reports about the employee's tables (the claim's `tookOver`)."""
    open_tables = open_tables_of(db, row.shop_id, row.pos_user_id)
    freed, warnings = free_silent_tables(db, row, approval, now)
    return {"openTables": len(open_tables), "tablesUnlocked": freed, "warnings": warnings}


def transfer_tables(
    db: Session,
    shop: Any,
    pos_user: PosUser,
    transfers: List[Dict[str, Any]],
    approval: Approval,
    now: datetime,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    "להעביר ל…" (§8ב, `exclusiveReleaseTables = ask`): each `{orderId, toPosUserId}` is "החלפת מלצר" on
    that table — the cloud's tables only (a LAN host's or a single till's copy is the host's to hand
    on: `why: lan` / `single`), only a table that is the employee's, never one another device is inside
    (`table_in_use`; the silent device's locks are gone by now). Each in the table's history.
    Returns (handed on, not handed on).
    """
    from app.models.tables import DiningTable, TableOrder
    from app.services import course_auto_fire as F
    from app.services import remote_table_cancel as RTC
    from app.services import table_actions as TA
    from app.services import tables as T

    moved: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    mine = str(pos_user.id)
    for item in transfers or []:
        order_id = T._uuid(item.get("orderId"))
        order = db.get(TableOrder, order_id) if order_id is not None else None
        if order is None or str(order.shop_id) != str(shop.id) or order.status != "open":
            skipped.append({"orderId": item.get("orderId"), "why": "table_not_open"})
            continue
        ref = {"orderId": str(order.id), "tableId": str(order.table_id), "number": order.table_number, "name": order.table_name}
        if str(order.waiter_pos_user_id or order.opened_by_pos_user_id or "") != mine:
            skipped.append({**ref, "why": "not_theirs"})
            continue
        if order.source != "synced":
            skipped.append({**ref, "why": "lan" if RTC.is_lan_copy(order) else "single"})
            continue
        target = TA.waiter_of(db, shop, item.get("toPosUserId"))
        if target is None:
            skipped.append({**ref, "why": "waiter_not_found"})
            continue
        table = db.get(DiningTable, order.table_id)
        if table is None:
            skipped.append({**ref, "why": "table_not_open"})
            continue
        try:
            table, order = TA._lock_rows(db, table, order)
        except Exception:  # noqa: BLE001 - a row a till's write holds right now: not this time
            skipped.append({**ref, "why": "table_busy"})
            continue
        if T.lock_live(table, now):
            skipped.append({**ref, "why": "table_in_use"})
            continue
        to_name = pos_user_name(target)
        from_name = order.waiter_pos_user_name or order.opened_by_pos_user_name
        extras = F.extras_of(order.extras_json)
        extras["waiter"] = {"id": str(target.id), "name": to_name}
        order.extras_json = F.encode_extras(extras)
        order.waiter_pos_user_id = str(target.id)
        order.waiter_pos_user_name = to_name
        TA._touch(order, now)
        db.flush()
        T.record_event(
            db, "waiter", table, order, user_id=approval.user_id, now=now,
            details={
                "fromName": from_name, "toName": to_name, "toPosUserId": str(target.id),
                "from": "user_session_release", "by": approval.name, "via": approval.via,
            },
        )
        moved.append({**ref, "toPosUserId": str(target.id), "toName": to_name})
    return moved, skipped


def manager_release(
    db: Session,
    row: PosUserSession,
    approval: Approval,
    *,
    at_machine: Optional[POSMachine] = None,
    transfers: Optional[List[Dict[str, Any]]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    A manager releases `row` from wherever they are (§8א): "עובדים מחוברים" at any till, handheld or
    phone (`at_machine`: that device), or the dashboard (`at_machine` None). The employee's tables stay
    theirs — unless `exclusiveReleaseTables = ask` and the manager hands them on (`transfers`); a silent
    device's locks on them go. Recorded as an exception — at `at_machine`, or at the device released
    from. The holder hears it on its next heartbeat. `TablesKeep` for a hand-over where tables stay.
    The caller commits.
    """
    now = now or _now()
    if row.released_at is not None:
        return {"status": "not_held"}
    holder_machine = db.get(POSMachine, row.machine_id)
    pos_user = db.get(PosUser, row.pos_user_id)
    policy = policy_for_machine(db, holder_machine) if holder_machine is not None else Policy(enabled=False)
    if transfers and policy.release_tables != RELEASE_TABLES_ASK:
        raise TablesKeep()
    info = holder_info(db, row)
    silent = silent_since(row, now)
    open_tables = open_tables_of(db, row.shop_id, row.pos_user_id)
    freed, warnings = free_silent_tables(db, row, approval, now)
    moved: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    if transfers and pos_user is not None:
        from app.models.shop import Shop

        shop = db.get(Shop, row.shop_id)
        if shop is not None:
            moved, skipped = transfer_tables(db, shop, pos_user, transfers, approval, now)
    _release(row, "manager", now, name=approval.name, machine_id=at_machine.id if at_machine is not None else None)
    db.flush()
    took_over = {
        **info, "releasedBy": "manager", "approvedBy": approval.name, "via": approval.via,
        "openTables": len(open_tables), "tablesUnlocked": freed, "tablesTransferred": moved, "warnings": warnings,
    }
    where = at_machine or holder_machine
    if where is not None and pos_user is not None:
        record_forced_release(db, where, pos_user, took_over, approval, now=now)
    return {
        "status": "released",
        "posUserId": str(row.pos_user_id),
        "posUserName": info.get("posUserName"),
        "holderSilentSince": _iso(silent),
        "openTables": len(open_tables),
        "tablesUnlocked": freed,
        "tablesTransferred": moved,
        "tablesNotTransferred": skipped,
        "warnings": warnings,
        "tablesChanged": bool(freed or moved),
    }


def live_sessions(
    db: Session, shop_id: Any, *, here: Optional[POSMachine] = None, now: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    "עובדים מחוברים" (§8א) / "מחוברים כעת במכשירים": who is signed in at which device of the shop, oldest
    first — the device, since when, whether it still reports (`silent`, `silentSince`), auto release
    (`stale`), the employee's open tables (`openTables`, `tables`) and what a release does with them
    (`releaseTables`, the holder device's). [here]: the till asking (`here` on its own rows).
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
        tables = open_tables_of(db, shop_id, row.pos_user_id)
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
            "releaseTables": policy.release_tables,
            "openTables": len(tables),
            "tables": [
                {k: t.get(k) for k in ("orderId", "tableId", "number", "name", "total", "openedAt")} for t in tables
            ],
            **({"here": here is not None and str(here.id) == str(row.machine_id)} if here is not None else {}),
        })
    return out


def transfer_candidates(db: Session, shop: Any, sessions: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """The waiters to hand tables to (`table_actions.waiters`), only when a release would ask (else None)."""
    if not any(s.get("releaseTables") == RELEASE_TABLES_ASK and s.get("openTables") for s in sessions):
        return None
    from app.services import table_actions as TA

    try:
        return TA.waiters(db, shop)
    except Exception:  # noqa: BLE001 - no list: the manager picks on the till's roster
        logger.exception("waiters for a hand-over not read for shop %s", getattr(shop, "id", None))
        return []


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
    """The dashboard's "מחוברים כעת במכשירים" — `live_sessions`."""
    return live_sessions(db, shop_id, now=now)


def release_by_dashboard(
    db: Session,
    row: PosUserSession,
    user: User,
    *,
    transfers: Optional[List[Dict[str, Any]]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    A manager releases it from the dashboard (or the phone's "מחוברים כעת במכשירים"): `manager_release`,
    approved by the dashboard user. The device signs the employee out at the end of its operation.
    """
    name = dashboard_user_name(user)
    return manager_release(
        db, row, Approval(name=name, user_id=getattr(user, "id", None), via=VIA_DASHBOARD),
        transfers=transfers, now=now,
    )
