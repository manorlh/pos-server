"""
"שליטה מרחוק" — remote actions on tills (and kiosks) from the dashboard, with delivery and
acknowledgement.

**Actions** (app/models/device_command.py `DEVICE_ACTIONS`):

* `lock` / `unlock` — "נעל קופה" / "שחרר": a full-screen lock with a message. The lock is a *state*
  (`device_remote_states`), so a device that missed the command still locks on its next pull; the
  till applies it only after the sale in progress ends, and a manager code on the till unlocks it
  too (`unlock_from_till`, audited as a command with source "till").
* `sync_now` / `refresh_catalog` — a nudge: the till syncs (a full catalog pull for the second).
* `sign_out` — the operator is signed out after the sale in progress.
* `restart_app` / `install_update` — only at rest (no sale, no card payment); an update only when
  one is downloaded and verified. A till that cannot do it now refuses (`refused`, with the reason).

**Delivery** — every command wakes its device at once (Ably event `device-command`, then the till
pulls `GET /sync/{m}/device-commands`); without realtime the till's heartbeat pulls it (≤ 2 min).
Pulling marks `pending` → `delivered`; the till answers `done` / `refused` / `failed`
(`POST /sync/{m}/device-commands/{id}/ack`). A command not picked up within a day expires.

**Who** — the dashboard section `device_control` (app/services/dashboard_sections.py) and the
machine admins' scope (app/services/kiosk_control.py `check_machine_scope`): a super admin, a
distributor (own devices), a company manager (their companies), a shop manager (their shop).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.device_command import (
    DEVICE_ACTIONS,
    FINAL_STATUSES,
    OPEN_STATUSES,
    DeviceCommand,
    DeviceRemoteState,
)
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: A command nobody picked up within this long is `expired`.
EXPIRES_AFTER = timedelta(hours=24)
#: The Ably event the device listens for.
NOTIFY_EVENT = "device-command"
#: What a lock says when the dashboard gave no message.
DEFAULT_LOCK_MESSAGE = "הקופה נעולה — פנו למנהל"
#: The answers a device may give.
ACK_STATUSES = ("done", "refused", "failed")
#: Refusal reasons a till sends (shown in Hebrew by the dashboard).
REFUSAL_REASONS = ("sale_in_progress", "payment_in_progress", "no_update", "not_supported", "kiosk")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def state_of(db: Session, machine_id: Any) -> Optional[DeviceRemoteState]:
    return db.get(DeviceRemoteState, machine_id)


def state_out(row: Optional[DeviceRemoteState]) -> Dict[str, Any]:
    if row is None or not row.locked:
        return {"locked": False, "message": None, "lockedAt": None, "lockedBy": None}
    return {
        "locked": True,
        "message": row.lock_message or DEFAULT_LOCK_MESSAGE,
        "lockedAt": _iso(row.locked_at),
        "lockedBy": row.locked_by,
    }


def command_out(row: DeviceCommand) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "machineId": str(row.machine_id),
        "batchId": str(row.batch_id) if row.batch_id else None,
        "action": row.action,
        "message": row.message,
        "status": row.status,
        "detail": row.detail if row.detail not in (WAS_LOCKED, WAS_UNLOCKED) else None,
        "source": row.source,
        "createdBy": row.created_by_name,
        "createdAt": _iso(row.created_at),
        "deliveredAt": _iso(row.delivered_at),
        "doneAt": _iso(row.done_at),
        "expiresAt": _iso(row.expires_at),
    }


#: What a kiosk never takes (its own pause is the kiosks' tab).
KIOSK_REFUSES = ("lock", "unlock", "sign_out")

#: Words an older build wrote in `detail` for the state before a lock / unlock (never shown).
WAS_LOCKED, WAS_UNLOCKED = "was_locked", "was_unlocked"


def _snapshot(state: Optional[DeviceRemoteState]) -> Dict[str, Any]:
    """The lock as it is now — what a cancel puts back."""
    if state is None:
        return {"locked": False}
    return {
        "locked": bool(state.locked),
        "message": state.lock_message,
        "lockedAt": _iso(state.locked_at),
        "lockedBy": state.locked_by,
        "unlockedAt": _iso(state.unlocked_at),
        "unlockedBy": state.unlocked_by,
    }


def _restore(db: Session, machine_id: Any, tenant_id: Any, snap: Dict[str, Any], now: datetime) -> None:
    state = state_of(db, machine_id)
    if state is None:
        if not snap.get("locked"):
            return
        state = DeviceRemoteState(machine_id=machine_id, tenant_id=tenant_id, locked=False)
        db.add(state)
    state.locked = bool(snap.get("locked"))
    state.lock_message = snap.get("message")
    state.locked_at = _parse_instant(snap.get("lockedAt"))
    state.locked_by = snap.get("lockedBy")
    state.unlocked_at = _parse_instant(snap.get("unlockedAt"))
    state.unlocked_by = snap.get("unlockedBy")
    state.updated_at = now


def _parse_instant(value: Any) -> Optional[datetime]:
    """An ISO instant (any offset, "Z", microseconds or none) as an aware UTC datetime, or None."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def same_instant(a: Optional[datetime], b: Optional[datetime]) -> bool:
    """Two instants equal to the millisecond (a device keeps what it was sent, perhaps rounded)."""
    if a is None or b is None:
        return False
    return abs((_aware(a) - _aware(b)).total_seconds()) < 0.001


def _set_lock(db: Session, machine: POSMachine, locked: bool, *, message: Optional[str], by: Optional[str], now: datetime) -> DeviceRemoteState:
    row = state_of(db, machine.id)
    if row is None:
        row = DeviceRemoteState(machine_id=machine.id, tenant_id=machine.tenant_id, locked=False)
        db.add(row)
    if locked:
        row.locked = True
        row.lock_message = (message or "").strip()[:300] or DEFAULT_LOCK_MESSAGE
        row.locked_at = now
        row.locked_by = (by or None) and by[:200]
    else:
        row.locked = False
        row.unlocked_at = now
        row.unlocked_by = (by or None) and by[:200]
    row.updated_at = now
    return row


def wake(machines: Iterable[POSMachine]) -> None:
    """After the commit: the devices pull their commands now (Ably; a no-op without it)."""
    from app.services.ably_notify import _notify_base, publish_notify

    for m in machines:
        if m.tenant_id is None:
            continue
        try:
            body = _notify_base()
            body["reason"] = "device_command"
            publish_notify(str(m.tenant_id), str(m.id), NOTIFY_EVENT, body)
        except Exception:  # noqa: BLE001 - the heartbeat pulls it anyway
            logger.warning("could not wake %s for a device command", m.id)


def create(
    db: Session,
    machines: Sequence[POSMachine],
    action: str,
    *,
    message: Optional[str] = None,
    user: Any = None,
    by_name: Optional[str] = None,
    source: str = "dashboard",
    now: Optional[datetime] = None,
) -> List[DeviceCommand]:
    """One command per device, one batch (the caller commits, then `wake`s them)."""
    if action not in DEVICE_ACTIONS:
        raise _bad("invalid_action", "פעולה לא מוכרת")
    if not machines:
        raise _bad("no_devices", "לא נבחרו מכשירים")
    if action in KIOSK_REFUSES:
        # A kiosk is paused from the kiosks' tab, never locked or signed out (a batch skips them).
        from app.models.kiosk import KioskDevice

        kiosks = {r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_([m.id for m in machines])).all()}
        machines = [m for m in machines if m.id not in kiosks]
        if not machines:
            raise _bad("kiosk_use_pause", "קיוסק לא ננעל ולא מנותק מרחוק — עוצרים אותו בלשונית הקיוסקים")
    now = now or utc_now()
    who = by_name or getattr(user, "username", None) or getattr(user, "email", None)
    batch_id = uuid.uuid4() if len(machines) > 1 else None
    out: List[DeviceCommand] = []
    for machine in machines:
        # An earlier lock / unlock still waiting is overtaken by this one.
        prev: Optional[Dict[str, Any]] = None
        if action in ("lock", "unlock"):
            prev = _snapshot(state_of(db, machine.id))
            for old in (
                db.query(DeviceCommand)
                .filter(
                    DeviceCommand.machine_id == machine.id,
                    DeviceCommand.action.in_(("lock", "unlock")),
                    DeviceCommand.status.in_(OPEN_STATUSES),
                )
                .all()
            ):
                # The state before a chain of waiting commands is the first one's.
                if old.status == "pending" and old.prev_state is not None:
                    prev = old.prev_state
                old.status = "cancelled"
                old.detail = "superseded"
                old.updated_at = now
            _set_lock(db, machine, action == "lock", message=message, by=who, now=now)
        row = DeviceCommand(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            shop_id=machine.shop_id,
            machine_id=machine.id,
            batch_id=batch_id,
            action=action,
            message=((message or "").strip()[:300] or None) if action == "lock" else None,
            status="pending",
            prev_state=prev,
            source=source,
            created_by_user_id=getattr(user, "id", None),
            created_by_name=(who or None) and who[:200],
            created_at=now,
            expires_at=now + EXPIRES_AFTER,
            updated_at=now,
        )
        db.add(row)
        out.append(row)
    db.flush()
    return out


#: A command the device took but never answered lapses: a restart or a sign-out after 10 minutes
#: (later it would land on another customer or another cashier), anything else after a day.
ANSWER_WITHIN = {"restart_app": timedelta(minutes=10), "sign_out": timedelta(minutes=10)}


#: An answer that arrives this soon after the command expired is still kept (the device did it).
ANSWER_GRACE = timedelta(minutes=15)


def answer_window(action: str) -> timedelta:
    return ANSWER_WITHIN.get(action, EXPIRES_AFTER)


def expire_old(db: Session, *, machine_id: Any = None, now: Optional[datetime] = None) -> None:
    """Pending past their end, and delivered but unanswered past their action's window: expired."""
    now = now or utc_now()
    q = db.query(DeviceCommand).filter(
        DeviceCommand.status == "pending", DeviceCommand.expires_at.isnot(None), DeviceCommand.expires_at <= now,
    )
    if machine_id is not None:
        q = q.filter(DeviceCommand.machine_id == machine_id)
    for row in q.all():
        row.status = "expired"
        row.updated_at = now
    shortest = min([EXPIRES_AFTER, *ANSWER_WITHIN.values()])
    dq = db.query(DeviceCommand).filter(
        DeviceCommand.status == "delivered", DeviceCommand.delivered_at.isnot(None),
        DeviceCommand.delivered_at <= now - shortest,
    )
    if machine_id is not None:
        dq = dq.filter(DeviceCommand.machine_id == machine_id)
    for row in dq.all():
        if _aware(row.delivered_at) + answer_window(row.action) <= now:
            row.status = "expired"
            row.detail = row.detail or "not_answered"
            row.updated_at = now


def cancel(db: Session, command: DeviceCommand, *, now: Optional[datetime] = None) -> DeviceCommand:
    """
    Before the device took it only; 409 after. A lock / unlock cancelled puts the lock back as it
    was before it (the device never saw it).
    """
    now = now or utc_now()
    if command.status != "pending":
        raise _bad("not_pending", "הפקודה כבר נמסרה לקופה", status.HTTP_409_CONFLICT)
    if command.action in ("lock", "unlock") and command.prev_state is not None:
        # Exactly as before it: locked or not, the same message, the same `lockedAt` the device knows.
        _restore(db, command.machine_id, command.tenant_id, command.prev_state, now)
    elif command.action in ("lock", "unlock") and command.detail in (WAS_LOCKED, WAS_UNLOCKED):
        # A pending lock / unlock written by the previous build: its word in `detail`.
        state = state_of(db, command.machine_id)
        if state is not None:
            state.locked = command.detail == WAS_LOCKED
            state.updated_at = now
    command.status = "cancelled"
    command.updated_at = now
    return command


# ── The device ───────────────────────────────────────────────────────────────


def pull(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    `GET /sync/{m}/device-commands`: what the device must be (the lock) and its open commands,
    oldest first; `pending` ones become `delivered`. The caller commits.
    """
    now = now or utc_now()
    expire_old(db, machine_id=machine.id, now=now)
    rows = (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id == machine.id, DeviceCommand.status.in_(OPEN_STATUSES))
        .order_by(DeviceCommand.created_at, DeviceCommand.id)
        .all()
    )
    for row in rows:
        if row.status == "pending":
            row.status = "delivered"
            row.delivered_at = now
            row.updated_at = now
    db.flush()
    return {
        "serverTime": now.isoformat(),
        "state": state_out(state_of(db, machine.id)),
        "commands": [command_out(r) for r in rows],
    }


def ack(
    db: Session, machine: POSMachine, command_id: Any, ack_status: str, detail: Optional[str], *, now: Optional[datetime] = None,
) -> DeviceCommand:
    """The device's answer. A final command keeps its first answer (a resend is harmless)."""
    now = now or utc_now()
    if ack_status not in ACK_STATUSES:
        raise _bad("invalid_status", "invalid status")
    try:
        ident = uuid.UUID(str(command_id))
    except (TypeError, ValueError):
        raise _bad("command_not_found", "command not found", status.HTTP_404_NOT_FOUND)
    row = db.get(DeviceCommand, ident)
    if row is None or row.machine_id != machine.id:
        raise _bad("command_not_found", "command not found", status.HTTP_404_NOT_FOUND)
    if row.status == "expired" and _aware(row.updated_at) is not None and now - _aware(row.updated_at) <= ANSWER_GRACE:
        # The device did it and its answer came just after the cloud gave up waiting: what happened.
        pass
    elif row.status in FINAL_STATUSES:
        return row
    row.status = ack_status
    row.detail = (detail or None) and str(detail)[:300]
    row.done_at = now
    if row.delivered_at is None:
        row.delivered_at = now
    row.updated_at = now
    db.flush()
    return row


def unlock_from_till(
    db: Session,
    machine: POSMachine,
    *,
    manager_name: Optional[str],
    locked_at: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[DeviceCommand]:
    """
    A manager code on the till released its lock: the state, and an audited command (done).
    `locked_at`: the lock the till released (its `lockedAt`); a report that arrives after a newer
    lock (the till was offline) releases nothing — None, and the till locks again on its pull.
    """
    now = now or utc_now()
    state = state_of(db, machine.id)
    # Only the very lock the till released: named by its instant (never "whatever is locked now"),
    # compared as instants (not as strings).
    if state is None or not state.locked or not same_instant(state.locked_at, _parse_instant(locked_at)):
        return None
    _set_lock(db, machine, False, message=None, by=manager_name, now=now)
    for old in (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id == machine.id, DeviceCommand.action == "lock", DeviceCommand.status.in_(OPEN_STATUSES))
        .all()
    ):
        old.status = "done"
        old.done_at = old.done_at or now
        old.updated_at = now
    row = DeviceCommand(
        id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, machine_id=machine.id,
        action="unlock", status="done", source="till", created_by_name=(manager_name or None) and manager_name[:200],
        detail="manager_code", created_at=now, delivered_at=now, done_at=now, updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


# ── The dashboard ────────────────────────────────────────────────────────────


def devices_status(db: Session, machines: Sequence[POSMachine], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Per device: online, the lock, and its last few commands — the panel's rows."""
    from app.models.kiosk import KioskDevice
    from app.services.machine_status import is_online

    now = now or utc_now()
    ids = [m.id for m in machines]
    if not ids:
        return []
    expire_old(db, now=now)
    states = {s.machine_id: s for s in db.query(DeviceRemoteState).filter(DeviceRemoteState.machine_id.in_(ids)).all()}
    kiosks = {k.machine_id for k in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_(ids)).all()}
    recent = (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id.in_(ids), DeviceCommand.created_at > now - timedelta(days=2))
        .order_by(DeviceCommand.created_at.desc())
        .all()
    )
    by_machine: Dict[Any, List[DeviceCommand]] = {}
    for r in recent:
        by_machine.setdefault(r.machine_id, []).append(r)
    out = []
    for m in machines:
        cmds = by_machine.get(m.id, [])
        out.append({
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "shopId": str(m.shop_id) if m.shop_id else None,
            "areaId": str(m.area_id) if getattr(m, "area_id", None) else None,
            "isKiosk": m.id in kiosks,
            "online": is_online(m.last_heartbeat_at, now=now),
            "lastSeenAt": _iso(m.last_heartbeat_at),
            "state": state_out(states.get(m.id)),
            "open": [command_out(c) for c in cmds if c.status in OPEN_STATUSES],
            "recent": [command_out(c) for c in cmds[:5]],
        })
    return out
