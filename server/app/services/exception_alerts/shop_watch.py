"""
The shop's day, watched in the background (P:/specs/push-more.md §C) — every minute in the
exception alerts' pass (worker.py), each kind off until a level switches it on ("הגדרות חריגות").

* **"הסניף לא נפתח"** (`shop_not_opened`, `scan_not_opened`): on a working day (`days` — the
  digits 1–7, 1 = Sunday; default every day), by `time` (10 = 10:00, 9.5 = 9:30, or HHMM:
  930 = 9:30; default 10:00) no shift opened at the shop's tills and nothing was sold there. One
  row per shop and business day (`shop_not_opened:<shop>:<day>`), written at most six hours after
  the deadline (later it is not news). Closed by itself when the shop opens (a shift or a sale),
  with when.
  The cloud keeps no opening hours for a shop (only a kiosk has hours), so the deadline is the
  rule's `time`; a self-order kiosk's shift does not count as the shop opening (it opens by itself)
  — its sales do.
* **"קצב מכירות נמוך"** (`sales_pace_low`, `scan_sales_pace`): today's net so far (from the start
  of the business day to now) under `pacePercent`% (60) of the average of the same weekday, to the
  same local hour, over the `weeks` (4) before — a week with no sales at all is no reference (a
  holiday, the shop closed), and at least two references are needed (one when `weeks` is 1). Only
  once the shop has been open `minHoursOpen` hours (2; from its first shift or sale of the day).
  Judged at most once an hour per shop, recorded at most once a day
  (`sales_pace_low:<shop>:<day>`); not closed by itself — a slow day stays a fact.

Both read the rule at the tenant, company and shop levels. The money is the reports' net
(gross − discounts − refunds, app/services/reports.py `_sales_buckets`) of the documents a report
counts, as the sales targets read it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.services.exception_alerts import watch as WT

logger = logging.getLogger(__name__)

NOT_OPENED = "shop_not_opened"
SALES_PACE = "sales_pace_low"
DEFAULT_TIME = time(10, 0)
#: After this long past the deadline a shop that did not open is not news any more.
LATE_LIMIT = timedelta(hours=6)
#: An open shift opened this long before the business day still counts as the shop open (a bar's night).
OPEN_SHIFT_MAX_AGE = timedelta(hours=18)


# ── Shared reads ─────────────────────────────────────────────────────────────


def watched_shops(db: Session, exception_type: str) -> List[Shop]:
    """Active, live (not in training) shops of the tenants where the kind is on somewhere."""
    tenants = WT.enabled_tenants(db, exception_type)
    if not tenants:
        return []
    return (
        db.query(Shop)
        .filter(Shop.tenant_id.in_(list(tenants)), Shop.is_active.is_(True), Shop.training_mode.is_(False))
        .order_by(Shop.id)
        .all()
    )


def not_kiosk_shift():
    return Shift.machine_id.notin_(db_kiosks())


def db_kiosks():
    from sqlalchemy import select

    return select(KioskDevice.machine_id).where(KioskDevice.home_role.is_(None), KioskDevice.machine_id.isnot(None))


def has_tills(db: Session, shop: Shop) -> bool:
    """The shop has a till of its own (active, fiscal, not a self-order kiosk)."""
    return (
        db.query(POSMachine.id)
        .filter(
            POSMachine.shop_id == shop.id,
            POSMachine.is_active.is_(True),
            POSMachine.is_fiscal.is_(True),
            POSMachine.id.notin_(db_kiosks()),
        )
        .first()
        is not None
    )


@dataclass
class Opening:
    at: datetime
    how: str  # "shift" | "sale"
    machine_id: Any = None


def first_activity(db: Session, shop: Shop, start: datetime, now: datetime) -> Optional[Opening]:
    """
    When the shop opened on the business day starting at `start`: its first shift (not a
    kiosk's) or its first sale — or `start` itself for a shift still open from before it.
    """
    from app.services.dashboard_stats import SALE_STATUSES

    found: List[Opening] = []
    shift = (
        db.query(Shift.opened_at, Shift.machine_id)
        .filter(Shift.shop_id == shop.id, Shift.opened_at >= start, Shift.opened_at <= now, not_kiosk_shift())
        .order_by(Shift.opened_at)
        .first()
    )
    if shift is not None:
        found.append(Opening(WT.utc(shift[0]), "shift", shift[1]))
    carried = (
        db.query(Shift.machine_id)
        .filter(
            Shift.shop_id == shop.id, Shift.status == ShiftStatus.OPEN,
            Shift.opened_at < start, Shift.opened_at > now - OPEN_SHIFT_MAX_AGE, not_kiosk_shift(),
        )
        .first()
    )
    if carried is not None:
        found.append(Opening(start, "shift", carried[0]))
    sale = (
        db.query(Transaction.created_at, Transaction.machine_id)
        .filter(
            Transaction.tenant_id == shop.tenant_id, Transaction.shop_id == shop.id,
            Transaction.created_at >= start, Transaction.created_at < now,
            Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False),
        )
        .order_by(Transaction.created_at)
        .first()
    )
    if sale is not None:
        found.append(Opening(WT.utc(sale[0]), "sale", sale[1]))
    return min(found, key=lambda o: o.at) if found else None


def documents(db: Session, shop: Shop, start: datetime, end: datetime):
    """The documents a report counts, of the shop, created in [start, end)."""
    from app.services.dashboard_stats import SALE_STATUSES

    return db.query(Transaction).filter(
        Transaction.tenant_id == shop.tenant_id,
        Transaction.shop_id == shop.id,
        Transaction.created_at >= start,
        Transaction.created_at < end,
        Transaction.status.in_(SALE_STATUSES),
        Transaction.duplicate_copy.is_(False),
    )


def buckets(db: Session, shop: Shop, start: datetime, end: datetime) -> Dict[str, float]:
    """The reports' money of the shop over [start, end): gross, discounts, refunds, counts, tips."""
    from app.services.reports import _new_sales_bucket, _sales_buckets

    if end <= start:
        return _new_sales_bucket()
    out = _sales_buckets(documents(db, shop, start, end), Transaction.shop_id)
    return out.get(shop.id) or next(iter(out.values()), None) or _new_sales_bucket()


def net_of(b: Dict[str, float]) -> Decimal:
    return (Decimal(str(b["gross"])) - Decimal(str(b["discounts"])) - Decimal(str(b["refunds"]))).quantize(Decimal("0.01"))


def net_between(db: Session, shop: Shop, start: datetime, end: datetime) -> Decimal:
    return net_of(buckets(db, shop, start, end))


# ── "הסניף לא נפתח" ──────────────────────────────────────────────────────────


def deadline_clock(value: Any) -> time:
    """The rule's `time`: hours (10, 9.5) under 24, HHMM (930, 1030) from 100; anything else 10:00."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIME
    if 0 <= v < 24:
        hours = int(v)
        minutes = int(round((v - hours) * 60))
        if minutes >= 60:
            hours, minutes = hours + 1, 0
        return time(hours % 24, minutes)
    if 100 <= v <= 2359 and float(int(v)) == v:
        hours, minutes = divmod(int(v), 100)
        if hours < 24 and minutes < 60:
            return time(hours, minutes)
    return DEFAULT_TIME


def working_days(value: Any) -> set:
    """The rule's `days`: its digits 1–7 (1 = Sunday); none valid = every day."""
    try:
        digits = {int(c) for c in str(int(float(value))) if c in "1234567"}
    except (TypeError, ValueError):
        digits = set()
    return digits or set(range(1, 8))


def scan_not_opened(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: shops past their deadline with nothing open recorded, opened ones closed. Caller commits."""
    now = WT.utc(now) or datetime.now(timezone.utc)
    zones = WT.Zones(db)
    changed = 0
    for shop in watched_shops(db, NOT_OPENED):
        rule = WT.shop_rule(db, shop, NOT_OPENED)
        if rule is None:
            continue
        zone_name = zones.name(shop.tenant_id)
        day = WT.business_today(now, zone_name)
        if WT.weekday_digit(day) not in working_days(rule.params.get("days")):
            continue
        clock = deadline_clock(rule.params.get("time"))
        deadline = WT.local_at(day, clock, zone_name)
        if now < deadline or now > deadline + LATE_LIMIT:
            continue
        key = f"{NOT_OPENED}:{shop.id}:{day.isoformat()}"
        if WT.find(db, key) is not None or not has_tills(db, shop):
            continue
        start, _end = WT.business_day_range(day, zone_name)
        if first_activity(db, shop, start, now) is not None:
            continue
        at = clock.strftime("%H:%M")
        row = WT.write(
            db, exception_type=NOT_OPENED, dedupe_key=key, occurred_at=deadline, now=now, severity="medium",
            tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id,
            details={
                "summary": f"עד {at} אין משמרת פתוחה ואין מכירה בסניף",
                "businessDay": day.isoformat(),
                "dayStart": start.isoformat(),
                "deadline": deadline.isoformat(),
                "time": at,
            },
        )
        if row is not None:
            changed += 1
    for row in WT.open_rows(db, NOT_OPENED, now=now, days=3):
        shop = db.get(Shop, row.shop_id) if row.shop_id else None
        start = WT.parse_iso((row.details or {}).get("dayStart"))
        if shop is None or start is None:
            continue
        opened = first_activity(db, shop, start, now)
        if opened is None:
            continue
        zone_name = zones.name(shop.tenant_id)
        when = WT.hhmm(opened.at, zone_name)
        how = "משמרת נפתחה" if opened.how == "shift" else "נרשמה מכירה"
        if WT.resolve(row, now=now, at=opened.at, why=f"הסניף נפתח ב-{when} ({how})",
                      extra={"openedAt": opened.at.isoformat(), "openedBy": opened.how,
                             "openedMachineId": str(opened.machine_id) if opened.machine_id else None}):
            changed += 1
    db.flush()
    return changed


# ── "קצב מכירות נמוך" ────────────────────────────────────────────────────────

#: Per shop, the (business day, local hour) last judged in this process — at most hourly.
_judged: Dict[Any, Tuple[date, int]] = {}


def reset() -> None:
    """Forget what was judged this hour (tests; a process restart does the same)."""
    _judged.clear()


def scan_sales_pace(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: each watched shop judged at most once an hour, recorded at most once a day. Caller commits."""
    now = WT.utc(now) or datetime.now(timezone.utc)
    zones = WT.Zones(db)
    written = 0
    for shop in watched_shops(db, SALES_PACE):
        rule = WT.shop_rule(db, shop, SALES_PACE)
        if rule is None:
            continue
        zone_name = zones.name(shop.tenant_id)
        day = WT.business_today(now, zone_name)
        hour_key = (day, now.astimezone(WT.zone(zone_name)).hour)
        if _judged.get(shop.id) == hour_key:
            continue
        _judged[shop.id] = hour_key
        key = f"{SALES_PACE}:{shop.id}:{day.isoformat()}"
        if WT.find(db, key) is not None:
            continue
        if judge_pace(db, shop, rule, day, zone_name, now, key) is not None:
            written += 1
    db.flush()
    return written


def judge_pace(db: Session, shop: Shop, rule, day: date, zone_name: str, now: datetime, key: str):
    percent = Decimal(str(WT.param(rule, "pacePercent", 60)))
    min_hours = WT.param(rule, "minHoursOpen", 2)
    weeks = max(1, int(WT.param(rule, "weeks", 4)))
    start, _end = WT.business_day_range(day, zone_name)
    opened = first_activity(db, shop, start, now)
    if opened is None or now - opened.at < timedelta(hours=min_hours):
        return None
    today = net_between(db, shop, start, now)
    refs: List[Dict[str, Any]] = []
    for k in range(1, weeks + 1):
        ref_day = day - timedelta(days=7 * k)
        ref_start, _ = WT.business_day_range(ref_day, zone_name)
        ref_end = WT.same_clock_days_before(now, 7 * k, zone_name)
        net = net_between(db, shop, ref_start, ref_end)
        if net > 0:
            refs.append({"day": ref_day.isoformat(), "net": float(net)})
    if len(refs) < min(2, weeks):
        return None
    average = (sum(Decimal(str(r["net"])) for r in refs) / len(refs)).quantize(Decimal("0.01"))
    if average <= 0:
        return None
    ratio = (today / average * 100).quantize(Decimal("0.1"))
    if ratio >= percent:
        return None
    at = WT.hhmm(now, zone_name)
    summary = (
        f"מכירות {WT.money(today)} עד {at} — {ratio.normalize():f}% מהממוצע ({WT.money(average)}) "
        f"של {len(refs)} ימים כאלה קודמים"
    )
    return WT.write(
        db, exception_type=SALES_PACE, dedupe_key=key, occurred_at=now, now=now, severity="medium",
        tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id,
        amount=today, value=ratio, threshold=percent,
        details={
            "summary": summary,
            "businessDay": day.isoformat(),
            "asOf": at,
            "todayNet": float(today),
            "averageNet": float(average),
            "references": refs,
            "openedAt": opened.at.isoformat(),
        },
    )
