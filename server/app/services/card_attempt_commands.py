"""
"תשלום לא מוכרע" — a card attempt whose result is unknown, and what a manager can do about it.

The owner: "אני לא רואה איפה התשלום התקוע הזה בשום מקום — תוודא שלא יקרה יותר". A card attempt
the terminal took and never answered used to live only on the device (and the kiosk's
`card_unknown` alert). Now the till uploads it to "עסקאות שלא הושלמו" as outcome `unresolved`
(app/services/failed_payments.py lists it first), and a manager may act on it from there:

* `check` ("בדוק במסוף") — the till runs the lookup by the attempt's vuid on the terminal and
  reports what it found;
* `mark_approved` ("סמן כאושר") — the card was charged: the till completes the pending documents;
* `mark_not_approved` ("סמן כלא אושר") — it was not: the till voids them.

**The channel** is the one of a support reset (`pendingReset`, app/services/till_reset.py): a
command row per request; while pending it is said on every heartbeat (`pendingCardCommands`:
`[{commandId, vuid, action, requestedBy, requestedAt}]`) — and the till is woken at once by the
realtime event `card-command` when it is online — until the till answers
(`POST /sync/{m}/card-commands/{id}/result`: done | failed | not_found | busy, with what it
found) or 24 h pass (`expired`). The attempt row itself is updated by the till's normal
failed-payment upload (`approved_late`, or a not-charged outcome).

**Who**: the people of a remote credit ("זיכוי מרחוק", the closest existing cloud action on a
till's money) — owner / manager roles (`get_current_machine_admin`) who may act on that till
(`check_shift_admin_access`). Only for an `unresolved` attempt with a vuid, one pending command
per attempt at a time (a pending one may be withdrawn). Every command keeps who asked, when,
and what the till answered.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.card_attempt_command import (
    ACTIONS,
    RESULT_OUTCOMES,
    STATUS_PENDING,
    TILL_STATUSES,
    CardAttemptCommand,
)
from app.models.failed_payment import OUTCOME_UNRESOLVED, FailedPaymentAttempt
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: A pending command is said on the heartbeat for this long, then `expired`.
TTL_HOURS = 24
RESULT_MESSAGE_MAX = 300
NOTIFY_EVENT = "card-command"

ACTION_LABELS_HE = {
    "check": "בדיקה במסוף",
    "mark_approved": "סימון כאושר",
    "mark_not_approved": "סימון כלא אושר",
}
STATUS_LABELS_HE = {
    "pending": "נשלח לקופה",
    "done": "בוצע",
    "failed": "נכשל",
    "not_found": "לא נמצא בקופה",
    "busy": "הקופה עסוקה",
    "expired": "פג תוקף — הקופה לא ענתה",
    "cancelled": "בוטל",
}
RESULT_LABELS_HE = {"approved": "אושר", "not_charged": "לא חויב", "unknown": "עדיין לא ידוע"}


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _aware(moment)
    return m.isoformat() if m is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _who(user: Any) -> Optional[str]:
    return getattr(user, "username", None) or getattr(user, "email", None) or (str(user.id) if getattr(user, "id", None) else None)


def _refuse(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "msg": message})


# ── Expiry ────────────────────────────────────────────────────────────────────


def expire_overdue(db: Session, *, machine_id: Any = None, now: Optional[datetime] = None) -> int:
    """Pending commands past their time become `expired` (of one till, or all). The caller commits."""
    now = _now(now)
    query = db.query(CardAttemptCommand).filter(CardAttemptCommand.status == STATUS_PENDING)
    if machine_id is not None:
        query = query.filter(CardAttemptCommand.machine_id == _uuid(machine_id))
    count = 0
    for cmd in query.all():
        if _aware(cmd.expires_at) is not None and _aware(cmd.expires_at) <= now:
            cmd.status = "expired"
            cmd.answered_at = None
            count += 1
    if count:
        db.flush()
    return count


# ── The dashboard ────────────────────────────────────────────────────────────


def create(
    db: Session,
    attempt: FailedPaymentAttempt,
    machine: POSMachine,
    action: str,
    user: Any,
    *,
    now: Optional[datetime] = None,
) -> CardAttemptCommand:
    """
    A manager's command for an unresolved attempt, to the till that made it. The caller has
    checked the user may act on that till; commits; and then `notify`.

    `422 card_command_action_invalid` · `409 attempt_not_unresolved` (only an `unresolved`
    attempt) · `409 attempt_without_vuid` (the till finds it by its vuid) ·
    `409 card_command_pending` (one pending command per attempt; withdraw it first).
    """
    now = _now(now)
    if action not in ACTIONS:
        raise _refuse(422, "card_command_action_invalid", "פעולה לא מוכרת")
    if attempt.outcome != OUTCOME_UNRESOLVED:
        raise _refuse(409, "attempt_not_unresolved", "אפשר לשלוח פקודה רק לתשלום שלא הוכרע")
    if not (attempt.vuid or "").strip():
        raise _refuse(409, "attempt_without_vuid", "לתשלום הזה אין מזהה עסקה במסוף — יש להכריע בקופה עצמה")
    expire_overdue(db, machine_id=machine.id, now=now)
    pending = (
        db.query(CardAttemptCommand)
        .filter(
            CardAttemptCommand.failed_payment_attempt_id == attempt.id,
            CardAttemptCommand.status == STATUS_PENDING,
        )
        .first()
    )
    if pending is not None:
        raise _refuse(409, "card_command_pending", "כבר נשלחה לקופה פקודה על התשלום הזה והיא ממתינה לתשובה")
    cmd = CardAttemptCommand(
        id=uuid.uuid4(),
        tenant_id=attempt.tenant_id or machine.tenant_id,
        shop_id=attempt.shop_id or machine.shop_id,
        machine_id=machine.id,
        failed_payment_attempt_id=attempt.id,
        vuid=attempt.vuid.strip(),
        action=action,
        requested_by_user_id=_uuid(getattr(user, "id", None)),
        requested_by_name=(_who(user) or "")[:200] or None,
        requested_at=now,
        expires_at=now + timedelta(hours=TTL_HOURS),
        status=STATUS_PENDING,
    )
    db.add(cmd)
    db.flush()
    logger.info(
        "card command %s (%s) for attempt %s (vuid %s) to till %s by %s",
        cmd.id, action, attempt.id, cmd.vuid, machine.id, cmd.requested_by_name,
    )
    return cmd


def cancel(db: Session, cmd: CardAttemptCommand, user: Any, *, now: Optional[datetime] = None) -> CardAttemptCommand:
    """Withdraw a pending command (`409 card_command_not_pending` otherwise). The caller commits."""
    now = _now(now)
    expire_overdue(db, machine_id=cmd.machine_id, now=now)
    if cmd.status != STATUS_PENDING:
        raise _refuse(409, "card_command_not_pending", "הפקודה כבר לא ממתינה")
    cmd.status = "cancelled"
    cmd.cancelled_by_name = (_who(user) or "")[:200] or None
    cmd.answered_at = None
    db.flush()
    return cmd


def notify(machine: POSMachine, cmd: CardAttemptCommand, *, now: Optional[datetime] = None) -> None:
    """The fast path: wake an online till (the heartbeat hands it over otherwise). Never raises."""
    from app.services import ably_notify
    from app.services.machine_status import is_online

    now = _now(now)
    try:
        if not machine.tenant_id or not ably_notify.is_enabled() or not is_online(machine.last_heartbeat_at, now=now):
            return
        ably_notify.publish_card_command_notify(
            str(machine.tenant_id), str(machine.id), command_out_for_till(cmd)
        )
        if cmd.delivered_at is None:
            cmd.delivered_at = now
    except Exception:  # noqa: BLE001 - a wake-up only
        logger.warning("card command %s: realtime notify failed", cmd.id, exc_info=True)


def command_out(cmd: Optional[CardAttemptCommand]) -> Optional[Dict[str, Any]]:
    """One command as the dashboard shows it on the attempt's row."""
    if cmd is None:
        return None
    return {
        "id": str(cmd.id),
        "attemptId": str(cmd.failed_payment_attempt_id) if cmd.failed_payment_attempt_id else None,
        "machineId": str(cmd.machine_id),
        "vuid": cmd.vuid,
        "action": cmd.action,
        "actionLabel": ACTION_LABELS_HE.get(cmd.action, cmd.action),
        "status": cmd.status,
        "statusLabel": STATUS_LABELS_HE.get(cmd.status, cmd.status),
        "requestedByUserId": str(cmd.requested_by_user_id) if cmd.requested_by_user_id else None,
        "requestedByName": cmd.requested_by_name,
        "requestedAt": _iso(cmd.requested_at),
        "expiresAt": _iso(cmd.expires_at),
        "deliveredAt": _iso(cmd.delivered_at),
        "answeredAt": _iso(cmd.answered_at),
        "resultOutcome": cmd.result_outcome,
        "resultLabel": RESULT_LABELS_HE.get(cmd.result_outcome or "", None),
        "resultMessage": cmd.result_message,
        "cancelledByName": cmd.cancelled_by_name,
    }


def latest_by_attempt(db: Session, attempt_ids: Iterable[Any]) -> Dict[uuid.UUID, CardAttemptCommand]:
    """The newest command of each attempt (one query)."""
    ids = [i for i in (_uuid(x) for x in attempt_ids) if i is not None]
    if not ids:
        return {}
    out: Dict[uuid.UUID, CardAttemptCommand] = {}
    rows = (
        db.query(CardAttemptCommand)
        .filter(CardAttemptCommand.failed_payment_attempt_id.in_(ids))
        .order_by(CardAttemptCommand.requested_at.desc(), CardAttemptCommand.id)
        .all()
    )
    for row in rows:
        out.setdefault(_uuid(row.failed_payment_attempt_id), row)
    return out


def for_attempt(db: Session, attempt_id: Any) -> List[CardAttemptCommand]:
    """Every command of an attempt, newest first."""
    return (
        db.query(CardAttemptCommand)
        .filter(CardAttemptCommand.failed_payment_attempt_id == _uuid(attempt_id))
        .order_by(CardAttemptCommand.requested_at.desc(), CardAttemptCommand.id)
        .all()
    )


# ── The till ─────────────────────────────────────────────────────────────────


def command_out_for_till(cmd: CardAttemptCommand) -> Dict[str, Any]:
    """`{commandId, vuid, action, requestedBy, requestedAt}` — the heartbeat's item and the wake-up's body."""
    return {
        "commandId": str(cmd.id),
        "vuid": cmd.vuid,
        "action": cmd.action,
        "requestedBy": cmd.requested_by_name,
        "requestedAt": _iso(cmd.requested_at),
    }


def take_pending(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[List[Dict[str, Any]]]:
    """`pendingCardCommands` for the heartbeat, oldest first; None when there are none. Expires this till's overdue ones."""
    now = _now(now)
    expire_overdue(db, machine_id=machine.id, now=now)
    rows = (
        db.query(CardAttemptCommand)
        .filter(CardAttemptCommand.machine_id == machine.id, CardAttemptCommand.status == STATUS_PENDING)
        .order_by(CardAttemptCommand.requested_at, CardAttemptCommand.id)
        .all()
    )
    if not rows:
        return None
    for row in rows:
        if row.delivered_at is None:
            row.delivered_at = now
    db.flush()
    return [command_out_for_till(r) for r in rows]


def apply_result(
    db: Session,
    machine: POSMachine,
    command_id: Any,
    *,
    result_status: str,
    outcome: Optional[str] = None,
    message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> CardAttemptCommand:
    """
    The till's answer. `404 unknown_command` for a command not given to this till;
    `422 result_status_invalid` / `result_outcome_invalid`. A command already answered keeps
    its first answer (a repeated report changes nothing); one that expired or was withdrawn
    still takes the till's answer — the till may have acted before it heard. The caller commits.
    """
    now = _now(now)
    cmd = db.get(CardAttemptCommand, _uuid(command_id)) if _uuid(command_id) is not None else None
    if cmd is None or _uuid(cmd.machine_id) != _uuid(machine.id):
        raise _refuse(404, "unknown_command", "פקודה לא מוכרת לקופה הזו")
    if result_status not in TILL_STATUSES:
        raise _refuse(422, "result_status_invalid", "סטטוס לא מוכר")
    if outcome is not None and outcome not in RESULT_OUTCOMES:
        raise _refuse(422, "result_outcome_invalid", "תוצאה לא מוכרת")
    if cmd.status in TILL_STATUSES:
        return cmd
    cmd.status = result_status
    cmd.result_outcome = outcome
    text = (message or "").strip()
    cmd.result_message = text[:RESULT_MESSAGE_MAX] or None
    cmd.answered_at = now
    if cmd.delivered_at is None:
        cmd.delivered_at = now
    db.flush()
    logger.info(
        "card command %s (%s, vuid %s) answered by till %s: %s %s",
        cmd.id, cmd.action, cmd.vuid, machine.id, result_status, outcome or "-",
    )
    return cmd
