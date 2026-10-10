"""
"מצב שאין אינטרנט — תתריע" for self-order kiosks (docs/SPEC_KIOSK.md §8.1): a kiosk that
stops talking to the cloud for longer than the exceptions rule's minutes (default 5) during
its opening hours raises a `kiosk_offline` exception ("חריגות"), and the exception records
when the kiosk came back.

There is no scheduler on this server, so detection runs where the facts arrive:

* while it is offline — whenever the dashboard lists kiosks (`GET /kiosks`, polled every
  15 s by the kiosks tab): a kiosk last seen too long ago during its hours gets its exception;
* when it comes back — at its first `kiosk/sync` after the gap: the open exception is closed
  (`details.backAt`, `value` = minutes offline), or, if nobody was looking meanwhile, one is
  recorded for the whole gap, already closed.

"Opening hours": the kiosk's own `hours` when it has them on; otherwise whether the kiosk
reported an open shift before it went quiet (it was trading). Idempotent: one exception per
outage (`kiosk_offline:<machine>:<last seen>`); a reviewed or dismissed one is the manager's
and is never touched again.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.shop import Shop

EXCEPTION_TYPE = "kiosk_offline"
DEFAULT_MINUTES = 5


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _minutes_of(value: Any) -> Optional[int]:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    try:
        h, m = int(value[:2]), int(value[3:])
    except ValueError:
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def in_hours(ranges: Any, local: datetime) -> bool:
    """The kiosk's `hours.ranges` (days 0 = Sunday) at a local time; past midnight belongs to the day before."""
    day = (local.weekday() + 1) % 7
    yesterday = (day + 6) % 7
    minute = local.hour * 60 + local.minute
    for r in ranges or []:
        if not isinstance(r, dict):
            continue
        days = set(r.get("days") or [])
        start, end = _minutes_of(r.get("open")), _minutes_of(r.get("close"))
        if start is None or end is None:
            continue
        if start == end and day in days:
            return True
        if start < end and day in days and start <= minute < end:
            return True
        if start > end and ((day in days and minute >= start) or (yesterday in days and minute < end)):
            return True
    return False


def _local(db: Session, machine: POSMachine, at: datetime) -> datetime:
    from zoneinfo import ZoneInfo

    from app.services.reports import resolve_report_timezone

    name = resolve_report_timezone(db, machine.tenant_id, None)
    try:
        return at.astimezone(ZoneInfo(name)) if name else at
    except Exception:  # noqa: BLE001 - an unreadable zone is UTC
        return at


def trading(db: Session, machine: POSMachine, device: KioskDevice, cfg: Dict[str, Any], at: datetime) -> bool:
    """Whether the kiosk should have been up at [at]: inside its hours, or — with none set — trading."""
    hours = cfg.get("hours") or {}
    if hours.get("enabled"):
        from app.services import kiosk_schedule

        return kiosk_schedule.is_open(hours, _local(db, machine, at))
    status = device.status if isinstance(device.status, dict) else {}
    return bool(status.get("shiftOpen"))


def rule_of(db: Session, machine: POSMachine) -> Optional[int]:
    """The rule's minutes when it is on for this kiosk; None when off (or unknown to this server)."""
    try:
        from app.services import exceptions

        rule = exceptions.rules_for_machine(db, machine).get(EXCEPTION_TYPE)
    except Exception:  # noqa: BLE001 - never fail a listing or a sync over an alert
        return DEFAULT_MINUTES
    if rule is None:
        return DEFAULT_MINUTES
    if not rule.enabled:
        return None
    return int(rule.params.get("offlineMinutes") or DEFAULT_MINUTES)


def _open_for(db: Session, machine_id) -> Optional[AuditException]:
    rows = (
        db.query(AuditException)
        .filter(AuditException.exception_type == EXCEPTION_TYPE, AuditException.machine_id == machine_id)
        .order_by(AuditException.occurred_at.desc())
        .limit(5)
        .all()
    )
    for row in rows:
        details = row.details if isinstance(row.details, dict) else {}
        if not details.get("backAt"):
            return row
    return None


def _company_of(db: Session, machine: POSMachine):
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    return shop.company_id if shop is not None else None


def _write(db: Session, machine: POSMachine, device: KioskDevice, since: datetime, until: Optional[datetime],
           threshold: int, now: datetime) -> Optional[AuditException]:
    minutes = int(((until or now) - since).total_seconds() // 60)
    details = {
        "kiosk": device.name,
        "offlineSince": since.isoformat(),
        "backAt": until.isoformat() if until is not None else None,
    }
    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        company_id=_company_of(db, machine),
        shop_id=machine.shop_id,
        area_id=machine.area_id,
        machine_id=machine.id,
        exception_type=EXCEPTION_TYPE,
        severity="high",
        dedupe_key=f"{EXCEPTION_TYPE}:{machine.id}:{since.strftime('%Y%m%dT%H%M%S')}",
        value=minutes,
        threshold=threshold,
        details=details,
        occurred_at=since,
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None
    return row


def note_listing(db: Session, machine: POSMachine, device: KioskDevice, cfg: Dict[str, Any],
                 *, now: Optional[datetime] = None) -> Optional[AuditException]:
    """While offline: the exception of a kiosk quiet for longer than the rule during its hours."""
    now = _utc(now) or datetime.now(timezone.utc)
    seen = _utc(device.last_kiosk_sync_at)
    if seen is None or not device.enabled:
        return None
    threshold = rule_of(db, machine)
    if threshold is None or now - seen < timedelta(minutes=threshold):
        return None
    if _open_for(db, machine.id) is not None or not trading(db, machine, device, cfg, seen):
        return None
    return _write(db, machine, device, seen, None, threshold, now)


def note_back(db: Session, machine: POSMachine, device: KioskDevice, cfg: Dict[str, Any], previous_seen: Optional[datetime],
              *, now: Optional[datetime] = None) -> Optional[AuditException]:
    """At the first sync after a gap: the open exception closed, or one recorded for the whole gap."""
    now = _utc(now) or datetime.now(timezone.utc)
    previous_seen = _utc(previous_seen)
    open_row = _open_for(db, machine.id)
    if open_row is not None:
        details = dict(open_row.details or {})
        since = _utc(open_row.occurred_at) or previous_seen or now
        details["backAt"] = now.isoformat()
        open_row.details = details
        if open_row.status == "new":
            open_row.value = int((now - since).total_seconds() // 60)
        db.flush()
        return open_row
    if previous_seen is None:
        return None
    threshold = rule_of(db, machine)
    if threshold is None or now - previous_seen < timedelta(minutes=threshold):
        return None
    if not trading(db, machine, device, cfg, previous_seen):
        return None
    return _write(db, machine, device, previous_seen, now, threshold, now)
