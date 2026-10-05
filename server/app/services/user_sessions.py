"""
"עובד מחובר בקופה אחת בלבד" — an employee signed in at one till cannot sign in at another
until they sign out there (docs/SPEC_EXCLUSIVE_LOGIN.md).

The till asks before it lets an employee in (`claim`), says every minute that they are
still there (`heartbeat`), and lets go when they leave (`release`). The cloud keeps one
live `PosUserSession` per employee; the till parameters decide whether the rule applies
at all (`exclusiveUserLogin`, read for the till that asks) and after how long a till that
went silent stops holding anyone (`exclusiveUserLoginStaleMinutes`).

* **Off** — a claim or a heartbeat records nothing and always succeeds; switching the
  parameter on takes effect from the next sign-in, and for whoever is already signed in
  from their till's next heartbeat (about a minute).
* **Stale** — a session whose till has not been heard from for the stale minutes is
  released by the next claim of that employee anywhere (`released_by = "stale"`), so a
  till that crashed never locks anyone out for good.
* **Forced** — a manager's approval at the till the employee moved to releases the other
  session (`"manager"`), and is recorded as an exception (`user_session_release`).
* **Self-healing** — a till has one operator at a time, so a claim or heartbeat for one
  employee lets go of anyone else the same till still held (a release that never arrived).

A till that loses its session to a manager (forced at another till, or from the
dashboard) hears it on its next heartbeat (`SessionReleased`) and signs the employee out.
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
from app.services.areas import as_utc
from app.services.till_parameters import till_parameters_for_machine

logger = logging.getLogger(__name__)

PARAM_ENABLED = "exclusiveUserLogin"
PARAM_STALE_MINUTES = "exclusiveUserLoginStaleMinutes"
DEFAULT_STALE_MINUTES = 15
STALE_MINUTES_MIN = 2
STALE_MINUTES_MAX = 720

#: The exception a forced release is reported under (app/services/exceptions.py).
EXCEPTION_TYPE = "user_session_release"


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


@dataclass(frozen=True)
class Policy:
    enabled: bool
    stale_minutes: int = DEFAULT_STALE_MINUTES


def policy_of(parameters: Dict[str, Any]) -> Policy:
    return Policy(
        enabled=enabled_of(parameters.get(PARAM_ENABLED)),
        stale_minutes=stale_minutes_of(parameters.get(PARAM_STALE_MINUTES)),
    )


def policy_for_machine(db: Session, machine: POSMachine) -> Policy:
    return policy_of(till_parameters_for_machine(db, machine).parameters)


def is_stale(row: PosUserSession, now: datetime, stale_minutes: int) -> bool:
    seen = as_utc(row.last_seen_at) or as_utc(row.started_at)
    return seen is None or now - seen >= timedelta(minutes=stale_minutes)


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


# ── Outcomes ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Approval:
    """Who approved a forced release: a till user or a cloud account, by name."""

    name: Optional[str] = None
    user_id: Optional[uuid.UUID] = None
    pos_user_id: Optional[str] = None


class SignedInElsewhere(Exception):
    """The employee holds a live session at another till. `info` is `holder_info`."""

    def __init__(self, info: Dict[str, Any]):
        super().__init__("user_signed_in_elsewhere")
        self.info = info


class SessionReleased(Exception):
    """This till's session was released by a manager; the till must sign the employee out."""

    def __init__(self, info: Dict[str, Any]):
        super().__init__("user_session_released")
        self.info = info


@dataclass
class ClaimResult:
    #: claimed (a new session) | held (already this till's) | off (the rule is off here)
    status: str
    policy: Policy
    session: Optional[PosUserSession] = None
    #: The other till's session this claim released: its `holder_info` and how ("stale" / "manager").
    took_over: Optional[Dict[str, Any]] = None

    @property
    def forced(self) -> bool:
        return bool(self.took_over) and self.took_over.get("releasedBy") == "manager"

    def out(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "exclusive": self.policy.enabled,
            "staleMinutes": self.policy.stale_minutes,
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
        raise SignedInElsewhere(holder_info(db, winner) if winner is not None else {})
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
        if is_stale(active, now, policy.stale_minutes):
            took_over = {**holder_info(db, active), "releasedBy": "stale"}
            _release(active, "stale", now)
        elif approval is not None:
            took_over = {**holder_info(db, active), "releasedBy": "manager", "approvedBy": approval.name}
            _release(active, "manager", now, name=approval.name, machine_id=machine.id)
        else:
            raise SignedInElsewhere(holder_info(db, active))
    # The release reaches the table before the new row meets the one-live-session index.
    db.flush()
    row = _insert(db, machine, pos_user, now)
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
    Sign `pos_user` in at `machine`: free, already this till's, or stale elsewhere → the
    session is this till's. Live elsewhere → `SignedInElsewhere`, unless `approval` (a
    manager's, checked by the caller) releases the other one. The caller commits.
    """
    now = now or _now()
    policy = policy_for_machine(db, machine)
    if not policy.enabled:
        return ClaimResult("off", policy)
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
        "fromDashboard": mine.released_by_machine_id is None,
        "now": holder_info(db, active) if active is not None else None,
    }


def heartbeat(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    *,
    now: Optional[datetime] = None,
) -> ClaimResult:
    """
    The till still has `pos_user` signed in. Held here → refreshed. Taken from this till
    by a manager → `SessionReleased` (the till signs them out). Otherwise as a claim: a
    till that was offline at sign-in, or whose session went stale, takes it (back) when
    it is free — and hears `SignedInElsewhere` when someone else has it now.
    """
    now = now or _now()
    policy = policy_for_machine(db, machine)
    if not policy.enabled:
        return ClaimResult("off", policy)
    active = _active_for_user(db, pos_user.id, lock=True)
    if active is not None and _same(active.machine_id, machine.id):
        _release_others_on_machine(db, machine, pos_user.id, now)
        active.last_seen_at = now
        return ClaimResult("held", policy, session=active)
    mine = _latest_here(db, machine, pos_user.id)
    if mine is not None and mine.released_at is not None and mine.released_by == "manager":
        raise SessionReleased(released_info(db, mine, active))
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
    Report a forced release to the exceptions ("חריגות") as a till event of type
    `user_session_release`, about the employee, at the till they moved to. Never fails
    the sign-in: a savepoint, and an error is only logged.
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
        summary = " · ".join(
            p for p in (
                name,
                f"שוחרר/ה מ{from_till}" if from_till else None,
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
            },
            received_at=now,
        )
        with db.begin_nested():
            db.add(event)
            db.flush()
            EX.Detector(db).event(event)
    except Exception:  # noqa: BLE001 - an exception missed is found by a rescan
        logger.exception("could not report the forced release of %s to the exceptions", pos_user.id)


# ── The dashboard's side ─────────────────────────────────────────────────────


def active_sessions_for_shop(db: Session, shop_id: Any, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Who is signed in at which till of the shop now, oldest first; `stale` per its till's rule."""
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
            "stale": is_stale(row, now, policy.stale_minutes),
            "staleMinutes": policy.stale_minutes,
        })
    return out


def release_by_dashboard(db: Session, row: PosUserSession, user: User, *, now: Optional[datetime] = None) -> None:
    """A manager releases it from the dashboard; the till signs the employee out on its next heartbeat."""
    if row.released_at is not None:
        return
    _release(row, "manager", now or _now(), name=dashboard_user_name(user))
