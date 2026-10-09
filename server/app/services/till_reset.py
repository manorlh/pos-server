"""
"איפוס נתוני קופה (תמיכה)" — a reset of a till's data, ordered from the cloud by support
(docs/SPEC_OFFLINE_TILL_Z.md §4.7).

The owner: "איפוס זדים קורה רק מהענן ובאמצעות סופר אדמין בתמיכה". The till has no reset of
its own any more. Support — the super admin — orders one from the machine page:

* **"מחיקת תנועות מקומיות"** (`transactions`): the till deletes its local documents and
  shifts; catalog, staff, settings and pairing stay.
* **"איפוס מלא"** (`full`): the till clears its database and pulls itself back from the cloud.

Either way the till carries it out under its own guards and refuses otherwise: nothing
unsynced (an empty outbox — a queued document may be the only copy of a sale), its own Zs
of the last 31 days, every Z not in the cloud yet and always its newest are kept, and
**no counter goes down** — not its Z run, not a document series. It reports what it did,
or why it refused.

The command travels on the heartbeat (`pendingReset`) while pending, for 36 h; the till
answers `POST /sync/{machineId}/till-reset/result`. One exception (`till_reset`) holds who,
when, why, what the cloud saw before, and the till's result.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.user import User
from app.services.machine_status import is_online
from app.services.support_z import _iso, _now, _who, check_permission  # noqa: F401 - re-exported

logger = logging.getLogger(__name__)

#: What support may order — the two resets the till used to offer locally.
KINDS: Dict[str, str] = {
    "transactions": "מחיקת תנועות מקומיות",
    "full": "איפוס מלא",
}
EXCEPTION_TYPE = "till_reset"
#: As long as a remote close or a till Z request: a till off overnight still gets it.
TTL_HOURS = 36
#: How the till ends a command.
RESULT_STATUSES = ("done", "refused", "failed")
#: Why a till refuses (the till says; the dashboard words them).
REFUSAL_CODES = ("outbox_not_empty", "unknown_kind", "not_paired", "failed")
COUNTER_SERIES = ("320", "330", "400")
MIN_REASON = 3


def _parse(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _pending(record: Optional[dict], now: datetime) -> bool:
    if not record or record.get("status") != "pending":
        return False
    expires = _parse(record.get("expiresAt"))
    return expires is None or now < expires


def _expire(machine: POSMachine, now: datetime) -> Optional[dict]:
    """Lazily: a pending command past its time is expired. Returns the record as it stands."""
    record = getattr(machine, "till_reset", None)
    if record and record.get("status") == "pending" and not _pending(record, now):
        record = {**record, "status": "expired", "completedAt": now.isoformat()}
        machine.till_reset = record
    return record


# ── What it would do ──────────────────────────────────────────────────────────


def preview(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> dict:
    """
    What the cloud knows before a reset: what the till still holds unsynced (as it last
    said), the Zs it will keep, and the counters that stay as they are.
    """
    from app.services import till_z
    from app.services.shifts import highest_transaction_numbers
    from app.services.z_sequence import last_machine_z_number

    now = _now(now)
    record = _expire(machine, now)
    kept = till_z.till_z_history(db, machine, days=till_z.TILL_Z_HISTORY_DAYS, now=now)
    outbox = machine.pending_count
    documents = machine.pending_documents
    offline_pending = getattr(machine, "offline_till_z_pending", None)
    warnings = []
    if outbox:
        warnings.append("outbox_not_empty")
    if offline_pending:
        warnings.append("offline_zs_kept")
    return {
        "machineId": str(machine.id),
        "machineName": machine.name,
        "posNumber": machine.pos_number,
        "online": is_online(machine.last_heartbeat_at, now=now),
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "kinds": KINDS,
        # What the till still holds and the cloud does not, as its last heartbeat said. The
        # till refuses while its outbox has anything; the Zs it holds are kept, not lost.
        "unsynced": {
            "outbox": outbox,
            "documents": documents,
            "at": _iso(getattr(machine, "pending_count_at", None)),
            "offlineTillZs": offline_pending,
            "offlineTillZConflict": bool(getattr(machine, "offline_till_z_conflict", False)),
        },
        "warnings": warnings,
        # The Zs the till keeps: its own of the last 31 days, and always its newest —
        # the ones the cloud has — plus every one it holds not in the cloud yet.
        "keptZs": {
            "days": till_z.TILL_Z_HISTORY_DAYS,
            "numbers": [z.machine_sequence_number for z in kept if z.machine_sequence_number is not None],
            "awaitingOnTill": offline_pending or 0,
        },
        # Nothing here moves: the till's Z run, every document series, the shift count.
        "counters": {
            "stay": True,
            "lastTillZNumber": last_machine_z_number(db, machine.id),
            "reportedLastZNumber": getattr(machine, "offline_till_z_last_number", None),
            "documentCounters": {
                "cloud": highest_transaction_numbers(db, machine.id),
                "reported": getattr(machine, "reported_document_counters", None),
            },
        },
        "pending": record if _pending(record, now) else None,
        "last": record,
    }


# ── Ordering it ───────────────────────────────────────────────────────────────


def request(
    db: Session,
    user: User,
    machine: POSMachine,
    *,
    kind: str,
    reason: Optional[str],
    now: Optional[datetime] = None,
) -> dict:
    """
    Order the reset. Support alone (`403 super_admin_only`); an assigned till (`409
    machine_not_assigned`); a kind from the list (`422 invalid_kind`) and a reason (`422
    reason_required`); one at a time (`409 reset_pending`). The caller commits.
    """
    check_permission(user)
    now = _now(now)
    if machine.pairing_status != PairingStatus.ASSIGNED:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    if kind not in KINDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_kind")
    reason = (reason or "").strip()
    if len(reason) < MIN_REASON:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reason_required")
    previous = _expire(machine, now)
    if _pending(previous, now):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "reset_pending",
                "message": "כבר נשלחה לקופה פקודת איפוס שעוד לא בוצעה.",
                "commandId": previous.get("id"),
            },
        )
    before = preview(db, machine, now=now)
    who = _who(user)
    record = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "kindText": KINDS[kind],
        "reason": reason[:500],
        "by": who,
        "byUserId": str(user.id),
        "requestedAt": now.isoformat(),
        "expiresAt": (now + timedelta(hours=TTL_HOURS)).isoformat(),
        "status": "pending",
        "before": {
            "unsynced": before["unsynced"],
            "keptZs": before["keptZs"],
            "counters": before["counters"],
            "lastHeartbeatAt": before["lastHeartbeatAt"],
        },
        "result": None,
        "previous": (
            {k: previous.get(k) for k in ("id", "kind", "status", "requestedAt", "completedAt")}
            if previous else None
        ),
    }
    machine.till_reset = record
    db.flush()
    exception_id = _record(db, machine, record, now)
    logger.warning("support ordered a reset of machine %s: %s", machine.id, record)
    return {**record, "exceptionId": exception_id}


def take_pending(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """`pendingReset` on the heartbeat while a command waits for the till."""
    now = _now(now)
    record = _expire(machine, now)
    if not _pending(record, now):
        return None
    return {
        "commandId": record["id"],
        "kind": record["kind"],
        "reason": record.get("reason"),
        "requestedBy": record.get("by"),
        "requestedAt": record.get("requestedAt"),
    }


# ── The till's answer ─────────────────────────────────────────────────────────


def counters_lowered(before: Optional[Dict[str, Any]], after: Optional[Dict[str, Any]]) -> list:
    """The counters the till says went down (should never be any). Pure."""
    out = []
    for key, was in (before or {}).items():
        now_value = (after or {}).get(key)
        try:
            if was is not None and now_value is not None and int(now_value) < int(was):
                out.append({"counter": key, "before": int(was), "after": int(now_value)})
        except (TypeError, ValueError):
            continue
    return out


def apply_result(
    db: Session,
    machine: POSMachine,
    *,
    command_id: str,
    result_status: str,
    code: Optional[str] = None,
    message: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    now: Optional[datetime] = None,
) -> dict:
    """
    The till carried out the command, or refused it and says why. Idempotent: a second
    report of the same command changes nothing. `404 unknown_command` for a command this
    till was never given. The caller commits.
    """
    now = _now(now)
    record = getattr(machine, "till_reset", None)
    if not record or record.get("id") != command_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown_command")
    if result_status not in RESULT_STATUSES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_status")
    if record.get("status") in RESULT_STATUSES:
        return record
    details = dict(details or {})
    counters = details.get("counters") or {}
    lowered = counters_lowered(counters.get("before"), counters.get("after"))
    result = {
        "status": result_status,
        "code": code,
        "message": (message or "")[:500] or None,
        "reportedAt": now.isoformat(),
        "lateAfterExpiry": record.get("status") == "expired",
        **{k: v for k, v in details.items() if k in (
            "executedAt", "transactionsDeleted", "outboxPending", "keptZs", "keptZNumbers",
            "keptShopZs", "counters", "appVersion",
        )},
        "countersLowered": lowered,
    }
    record = {**record, "status": result_status, "completedAt": now.isoformat(), "result": result}
    machine.till_reset = record
    if lowered:
        logger.error("machine %s reports counters lowered by a reset: %s", machine.id, lowered)
    _record(db, machine, record, now)
    return record


# ── The record ────────────────────────────────────────────────────────────────


STATUS_TEXT = {
    "pending": "ממתין לקופה",
    "done": "בוצע בקופה",
    "refused": "הקופה סירבה",
    "failed": "נכשל בקופה",
    "expired": "פג תוקף — הקופה לא קיבלה",
}


def _record(db: Session, machine: POSMachine, record: dict, now: datetime) -> Optional[str]:
    """The one exception per command: written when ordered, updated with the result."""
    from app.services.exceptions import record_z_exception

    key = f"{EXCEPTION_TYPE}:{machine.id}:{record['id']}"
    parts = [
        f"{record['kindText']} — הוזמן ע״י {record['by']}: {record['reason']}",
        STATUS_TEXT.get(record.get("status"), record.get("status") or ""),
    ]
    result = record.get("result") or {}
    if result.get("code"):
        parts.append(f"סיבה: {result['code']}")
    if result.get("transactionsDeleted") is not None:
        parts.append(f"נמחקו {result['transactionsDeleted']} מסמכים מקומיים")
    if result.get("countersLowered"):
        parts.append("מונה ירד — לבדיקה")
    try:
        record_z_exception(
            db, machine,
            exception_type=EXCEPTION_TYPE,
            key=key,
            occurred_at=_parse(record.get("requestedAt")) or now,
            details={**record, "summary": " · ".join(p for p in parts if p)},
        )
    except Exception:  # noqa: BLE001 - the command is what matters; the log keeps the rest
        logger.exception("could not record the reset of machine %s", machine.id)
        return None
    row = db.query(AuditException).filter(AuditException.dedupe_key == key[:200]).first()
    return str(row.id) if row is not None else None
