"""
"קופה לא מחוברת" — a till that went offline while trading, for the exceptions log and the
phone (push) alerts.

A till (fiscal, active, not a kiosk — kiosks have `kiosk_offline`) with an OPEN shift (opened
in the last 18 hours — one forgotten open overnight is not trading) whose
last heartbeat is older than the exceptions rule's minutes (`till_offline.offlineMinutes`,
default 10; the rule can be switched off per company / shop / till like every exception rule)
gets one `audit_exceptions` row per outage: `till_offline:<machine>:<last heartbeat>`,
`occurred_at` = when it was last heard from. The ORM hooks carry it to the log and the
alerts. When the till is heard from again, the open row gets `details.backAt` and the minutes
it was away (`value`) — the log entry follows; nothing is sent for the return.

Runs every minute in the exception alerts' background pass (worker.py). Idempotent: the
dedupe key is unique; a second API process loses the insert race quietly. A row a manager
already reviewed or dismissed is never touched.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.services.machine_status import is_online

logger = logging.getLogger(__name__)

EXCEPTION_TYPE = "till_offline"
DEFAULT_MINUTES = 10
#: Never alert on a heartbeat older than this: a till switched off for days with a shift left
#: open is a shift problem, not news.
LOOKBACK = timedelta(hours=12)
#: Nor for a shift opened longer ago than this (forgotten open overnight: not trading now).
SHIFT_MAX_AGE = timedelta(hours=18)


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def threshold_of(db: Session, machine: POSMachine) -> Optional[int]:
    """The rule's minutes for this till; None when the rule is off there."""
    try:
        from app.services import exceptions

        rule = exceptions.rules_for_machine(db, machine).get(EXCEPTION_TYPE)
    except Exception:  # noqa: BLE001 - never fail the pass over one till's settings
        return DEFAULT_MINUTES
    if rule is None:
        return DEFAULT_MINUTES
    if not rule.enabled:
        return None
    return int(rule.params.get("offlineMinutes") or DEFAULT_MINUTES)


def _open_rows(db: Session, machine_id) -> List[AuditException]:
    rows = (
        db.query(AuditException)
        .filter(AuditException.exception_type == EXCEPTION_TYPE, AuditException.machine_id == machine_id)
        .order_by(AuditException.occurred_at.desc())
        .limit(5)
        .all()
    )
    return [r for r in rows if not (r.details or {}).get("backAt")]


def _write(db: Session, machine: POSMachine, since: datetime, threshold: int, now: datetime) -> Optional[AuditException]:
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    till = f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "קופה")
    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=machine.area_id,
        machine_id=machine.id,
        exception_type=EXCEPTION_TYPE,
        severity="high",
        dedupe_key=f"{EXCEPTION_TYPE}:{machine.id}:{since.strftime('%Y%m%dT%H%M%S')}",
        value=int((now - since).total_seconds() // 60),
        threshold=threshold,
        details={
            "summary": f"{till} לא מחוברת לענן",
            "till": machine.name,
            "offlineSince": since.isoformat(),
            "backAt": None,
            "pendingDocuments": machine.pending_documents,
        },
        occurred_at=since,
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None  # this outage is already recorded (another process, an earlier pass)
    return row


def scan(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: new outages recorded, returns closed. Returns how many rows it wrote or changed. Caller commits."""
    now = _utc(now) or datetime.now(timezone.utc)
    changed = 0
    kiosks = db.query(KioskDevice.machine_id)
    candidates = (
        db.query(POSMachine)
        .join(Shift, Shift.machine_id == POSMachine.id)
        .filter(
            Shift.status == ShiftStatus.OPEN,
            Shift.opened_at > now - SHIFT_MAX_AGE,
            POSMachine.is_active.is_(True),
            POSMachine.is_fiscal.is_(True),
            POSMachine.last_heartbeat_at.isnot(None),
            POSMachine.last_heartbeat_at < now - timedelta(minutes=2),
            POSMachine.last_heartbeat_at > now - LOOKBACK,
            POSMachine.id.notin_(kiosks),
        )
        .distinct()
        .all()
    )
    for machine in candidates:
        beat = _utc(machine.last_heartbeat_at)
        threshold = threshold_of(db, machine)
        if threshold is None or now - beat < timedelta(minutes=threshold):
            continue
        if _open_rows(db, machine.id):
            continue
        if _write(db, machine, beat, threshold, now) is not None:
            changed += 1
    # Back: an open outage whose till is heard from again.
    recent = (
        db.query(AuditException)
        .filter(AuditException.exception_type == EXCEPTION_TYPE, AuditException.occurred_at > now - timedelta(days=2))
        .all()
    )
    for row in recent:
        details = dict(row.details or {})
        if details.get("backAt") or row.machine_id is None:
            continue
        machine = db.get(POSMachine, row.machine_id)
        beat = _utc(machine.last_heartbeat_at) if machine is not None else None
        since = _utc(row.occurred_at)
        if beat is None or since is None or beat <= since or not is_online(beat, now=now):
            continue
        details["backAt"] = beat.isoformat()
        row.details = details
        if row.status == "new":
            row.value = int((beat - since).total_seconds() // 60)
        changed += 1
    db.flush()
    return changed
