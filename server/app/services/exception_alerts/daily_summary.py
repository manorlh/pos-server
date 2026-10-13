"""
"סיכום יום" (`daily_summary`, P:/specs/push-more.md §C) — a shop's business day in figures, on
the phone: net sales, the number of sales and their average, against the same weekday a week
before (to the same hour), refunds, discounts and the cash differences counted at the shifts' close.

**When** (the exception rule's `at`, per tenant / company / shop; off by default):

* `at` = -1 (the default once on) — after the shop's Z: a Z of the shop exists for the business
  day and none of its tills (a self-order kiosk aside) still has an open shift of that day. Looked
  for on today's and yesterday's business day, for a Z closed in the last 36 hours (switching the
  rule on never sums up old days).
* `at` = 0–23 — at that hour of the business day (00:00–03:59 is the night that ends it), the day
  so far; nothing when nothing was sold.

**Information, not a problem** (`catalog.INFO_KINDS`): written straight into the exceptions log
(source `daily_summary`, never an `audit_exceptions` row — it is not an exception), severity low,
kept out of the open-problem counts. One per shop and business day
(`daily_summary:<shop>:<day>`); a new entry goes through the alert rules like any other (the push
category "סיכום יום"; an SMS rule only when it names it).

The money is the reports' (gross − discounts − refunds; the average ticket = (gross − discounts) ÷
sales; discounts without production vouchers' deductions, as the reports show them), over the
business day (04:00 to 04:00 local) — the same reading for the day and for last week's. The cash
differences are the closed shifts of that business day (`shifts.business_date`) with one.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.z_report import ZReport
from app.services.exception_alerts import log as L
from app.services.exception_alerts import shop_watch as SW
from app.services.exception_alerts import watch as WT

logger = logging.getLogger(__name__)

KIND = "daily_summary"
AFTER_Z = -1
#: A Z older than this is not summed up any more (the rule switched on later, a forgotten day).
Z_LOOKBACK = timedelta(hours=36)
#: An open shift older than this does not hold the summary back (forgotten open).
OPEN_SHIFT_MAX_AGE = timedelta(hours=36)

_CENT = Decimal("0.01")


def _d(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(_CENT)


def figures(db: Session, shop: Shop, day: date, cut: datetime, zone_name: str) -> Dict[str, Any]:
    """The day's figures over [its start, `cut`), and last week's over the same span."""
    start, end = WT.business_day_range(day, zone_name)
    cut = min(cut, end)
    b = SW.buckets(db, shop, start, cut)
    net = SW.net_of(b)
    sales = int(b["sales_count"] or 0)
    discounts = _d(Decimal(str(b["discounts"])) - Decimal(str(b.get("voucher_deductions") or 0)))
    average = ((_d(b["gross"]) - _d(b["discounts"])) / sales).quantize(_CENT) if sales else None
    week_day = day - timedelta(days=7)
    week_start, _ = WT.business_day_range(week_day, zone_name)
    week_cut = end - timedelta(days=7) if cut >= end else WT.same_clock_days_before(cut, 7, zone_name)
    week = SW.buckets(db, shop, week_start, max(week_start, week_cut))
    week_net = SW.net_of(week)
    change = ((net - week_net) / week_net * 100).quantize(Decimal("0.1")) if week_net > 0 else None
    shifts = (
        db.query(Shift.discrepancy)
        .filter(
            Shift.shop_id == shop.id, Shift.business_date == day, Shift.status == ShiftStatus.CLOSED,
            Shift.discrepancy.isnot(None),
        )
        .all()
    )
    differences = [_d(s[0]) for s in shifts if s[0] is not None and _d(s[0]) != 0]
    return {
        "net": net,
        "sales": sales,
        "average": average,
        "refunds": _d(b["refunds"]),
        "refundsCount": int(b["refunds_count"] or 0),
        "discounts": discounts,
        "tips": _d(b["tips"]),
        "documents": sales + int(b["refunds_count"] or 0),
        "lastWeekNet": week_net,
        "lastWeekSales": int(week["sales_count"] or 0),
        "changePct": change,
        "cashDifference": sum(differences, Decimal("0")),
        "cashDifferenceShifts": len(differences),
        "from": start,
        "to": cut,
    }


def summary_text(f: Dict[str, Any]) -> str:
    """"₪12,340 נטו · 210 עסקאות · ממוצע ₪58.76 · +12% מול שבוע שעבר · זיכויים ₪120 (2) · הנחות ₪300 · הפרשי קופה -₪15 (1)"."""
    parts: List[str] = [f"{WT.money(f['net'])} נטו", f"{f['sales']} עסקאות"]
    if f["average"] is not None:
        parts.append(f"ממוצע {WT.money(f['average'])}")
    if f["changePct"] is not None:
        sign = "+" if f["changePct"] > 0 else ""
        parts.append(f"{sign}{f['changePct'].normalize():f}% מול שבוע שעבר")
    elif f["lastWeekNet"] <= 0:
        parts.append("אין נתונים משבוע שעבר")
    if f["refundsCount"]:
        parts.append(f"זיכויים {WT.money(f['refunds'])} ({f['refundsCount']})")
    if f["discounts"]:
        parts.append(f"הנחות {WT.money(f['discounts'])}")
    if f["cashDifferenceShifts"]:
        parts.append(f"הפרשי קופה {WT.money(f['cashDifference'])} ({f['cashDifferenceShifts']})")
    else:
        parts.append("ללא הפרשי קופה")
    return " · ".join(parts)


def _details(f: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    def num(v: Any) -> Any:
        return float(v) if isinstance(v, Decimal) else v

    out = {k: (v.isoformat() if isinstance(v, datetime) else num(v)) for k, v in f.items()}
    out["info"] = True
    out.update(extra)
    return out


def record(db: Session, shop: Shop, day: date, f: Dict[str, Any], *, now: datetime, trigger: str,
           z: Optional[ZReport] = None):
    """Write the day's entry (once) and, when new, send it through the alert rules. The caller commits."""
    from app.services.exception_alerts import engine as E

    spec = L.EntrySpec(
        source=KIND,
        source_id=f"{shop.id}:{day.isoformat()}",
        dedupe_key=f"{KIND}:{shop.id}:{day.isoformat()}",
        kind=KIND,
        severity="low",
        occurred_at=now,
        tenant_id=shop.tenant_id,
        company_id=shop.company_id,
        shop_id=shop.id,
        amount=f["net"],
        value=f["changePct"],
        summary=summary_text(f),
        details=_details(f, businessDay=day.isoformat(), trigger=trigger,
                         zNumber=(z.shop_sequence_number or z.machine_sequence_number) if z is not None else None),
        z_report_id=z.id if z is not None else None,
        received_at=now,
    )
    entry, created = L.record(db, spec, now=now)
    if created:
        E.process_entry(db, entry, now=now)
    return entry if created else None


def _exists(db: Session, shop: Shop, day: date) -> bool:
    return L.find(db, f"{KIND}:{shop.id}:{day.isoformat()}") is not None


def _z_of(db: Session, shop: Shop, day: date, now: datetime) -> Optional[ZReport]:
    return (
        db.query(ZReport)
        .filter(ZReport.shop_id == shop.id, ZReport.business_date == day, ZReport.closed_at > now - Z_LOOKBACK,
                ZReport.closed_at <= now)
        .order_by(ZReport.closed_at.desc())
        .first()
    )


def _still_open(db: Session, shop: Shop, day_end: datetime, now: datetime) -> bool:
    """A till of the shop (not a kiosk) still has a shift of that day open."""
    return (
        db.query(Shift.id)
        .filter(
            Shift.shop_id == shop.id, Shift.status == ShiftStatus.OPEN, Shift.opened_at < day_end,
            Shift.opened_at > now - OPEN_SHIFT_MAX_AGE, SW.not_kiosk_shift(),
        )
        .first()
        is not None
    )


def scan(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass over the shops where the summary is on. Returns how many were written. Caller commits."""
    now = WT.utc(now) or datetime.now(timezone.utc)
    zones = WT.Zones(db)
    written = 0
    for shop in SW.watched_shops(db, KIND):
        rule = WT.shop_rule(db, shop, KIND)
        if rule is None:
            continue
        zone_name = zones.name(shop.tenant_id)
        today = WT.business_today(now, zone_name)
        at = int(WT.param(rule, "at", AFTER_Z))
        if at < 0:
            for day in (today - timedelta(days=1), today):
                if _exists(db, shop, day):
                    continue
                z = _z_of(db, shop, day, now)
                if z is None:
                    continue
                _start, end = WT.business_day_range(day, zone_name)
                if _still_open(db, shop, end, now):
                    continue
                f = figures(db, shop, day, min(now, end), zone_name)
                if record(db, shop, day, f, now=now, trigger="z", z=z) is not None:
                    written += 1
            continue
        from datetime import time as clock

        fire_at = WT.local_at(today, clock(min(max(at, 0), 23), 0), zone_name)
        if now < fire_at or _exists(db, shop, today):
            continue
        f = figures(db, shop, today, now, zone_name)
        if f["documents"] == 0:
            continue  # nothing sold: nothing to sum up
        if record(db, shop, today, f, now=now, trigger="hour") is not None:
            written += 1
    db.flush()
    return written
