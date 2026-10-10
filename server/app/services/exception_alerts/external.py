"""
Alerts that no stored row raises — recorded straight into the exceptions log, then matched
against the alert rules (SMS and push) like any other entry:

* `report_till_low_sales` — "קופה כמעט לא מוכרת": the hook for the insights' till anomaly
  rules (feat/insights-actions builds them; their rule is `till_low_sales`). Call it with the
  till and the figures when a till is flagged; one entry per till, per business day.

"יעד הושג" (`target_reached`) is not recorded here: its one source is "יעדים ותחרות"
(app/services/sales_targets.py — a `sales_target_hits` row, the log's `sales_target` source), the
event's target included (the live screen writes it there).

Idempotent through the log's `dedupe_key`; never raises to its caller.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.exception_alerts import ExceptionLogEntry
from app.services.exception_alerts import log as L

logger = logging.getLogger(__name__)


def _record_and_alert(db: Session, spec: L.EntrySpec, *, now: Optional[datetime] = None) -> Optional[ExceptionLogEntry]:
    """Write the entry; a NEW one goes through the alert rules. The caller commits."""
    from app.services.exception_alerts import engine as E

    entry, created = L.record(db, spec, now=now)
    if created:
        E.process_entry(db, entry, now=now)
    return entry


def report_till_low_sales(
    db: Session,
    *,
    machine,
    business_day: date,
    net_per_hour: Optional[float] = None,
    peers_median_per_hour: Optional[float] = None,
    ratio_pct: Optional[float] = None,
    event_id: Any = None,
    details: Optional[Dict[str, Any]] = None,
    now: Optional[datetime] = None,
) -> Optional[ExceptionLogEntry]:
    """
    The insights' "קופה כמעט לא מוכרת" (`till_low_sales`) for one till on one business day.

    `ratio_pct` — the till's sales per open hour as a percent of its peers' median (the
    measured value); `net_per_hour` / `peers_median_per_hour` in ₪. Safe to call on every
    evaluation: one entry per till and day.
    """
    try:
        shop_company = None
        if machine.shop_id is not None:
            from app.models.shop import Shop

            shop = db.get(Shop, machine.shop_id)
            shop_company = shop.company_id if shop is not None else None
        till = f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "קופה")
        summary = f"{till} מוכרת הרבה פחות מהקופות שלידה"
        if ratio_pct is not None:
            summary += f" ({round(ratio_pct)}% מהחציון)"
        extra = dict(details or {})
        extra.update({"netPerHour": net_per_hour, "peersMedianPerHour": peers_median_per_hour,
                      "businessDay": business_day.isoformat()})
        if event_id is not None:
            extra["eventId"] = str(event_id)
        spec = L.EntrySpec(
            source="insight",
            source_id=f"{machine.id}:{business_day.isoformat()}",
            dedupe_key=f"till_low_sales:{machine.id}:{business_day.isoformat()}",
            kind="till_low_sales",
            severity="medium",
            occurred_at=now or datetime.now(timezone.utc),
            tenant_id=machine.tenant_id,
            company_id=shop_company,
            shop_id=machine.shop_id,
            area_id=machine.area_id,
            machine_id=machine.id,
            value=ratio_pct,
            summary=summary,
            details=extra,
        )
        return _record_and_alert(db, spec, now=now)
    except Exception:  # noqa: BLE001 - an insight never fails over its alert
        logger.exception("till_low_sales alert for machine %s failed", getattr(machine, "id", None))
        return None
