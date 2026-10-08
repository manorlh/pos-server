"""
The control board's comparisons (השוואות).

Two questions, each answered in one request with a fixed number of grouped queries,
whatever the size of the organization or the length of the period — a phone asks them,
and a month is never thirty requests:

* `build_period_compare` — a period (a day, a week, a month, any range up to the reports'
  366 days, or an event) against another: the previous period, the same one last year, any
  range, another event. The headline figures of both, the change of each (as a number and a
  percent), the two curves aligned — by the hour of day for days, by the n-th day for longer
  periods, by the hours since it began for an event — and, when asked, the best sellers.
* `build_side_by_side` — 2–4 shops, points of sale, tills or cashiers over one period (or an
  event): each one's figures and its curve.

The money is the overview's (`_sales_buckets`, the per-cashier report's definition), so a
figure here equals the overview's for the same scope and days. Who sees what is decided as
on every report: `build_scoped_transaction_query` (the role), narrowed — never widened — by
the company / shop / point of sale / till asked for. An entity outside the caller's scope is
not listed; a period with nothing in it is zeros, never an error; and a change from zero is
"new" (`pct` null), never a division by zero.

An **event** ("אירוע", `report_events`, docs/SPEC_EVENTS.md) is a lens: its exact window
(`starts_at` → `ends_at`) and its tills, read through `report_events.crud.load_event` (which
refuses an event of a shop the caller cannot see). Nothing here writes to the events.
"""
from __future__ import annotations

import math
import uuid as uuid_mod
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import Date, Integer, case, cast, func, select
from sqlalchemy.orm import Query, Session

from app.models.pos_machine import POSMachine
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.schemas.period_compare import (
    CompareDelta,
    CompareFigures,
    CompareItem,
    EventBrief,
    PeriodCompareResponse,
    SeriesPoint,
    SideBySideEntity,
    SideBySideResponse,
)
from app.services.company_hierarchy import descendant_company_ids
from app.services.extra_reports import _pg, _signed_document_net
from app.services.overview import _visible_machines_query, _visible_shops_query
from app.services.reports import (
    ReportWindow,
    _cents,
    _display_name,
    _is_refund_condition,
    _load_cashier_names,
    _load_zoneinfo,
    _new_sales_bucket,
    _sales_buckets,
    _to_float,
    build_scoped_transaction_query,
    resolve_report_window,
)

GRANULARITY_HOUR = "hour"
GRANULARITY_DAY = "day"
GRANULARITIES = (GRANULARITY_HOUR, GRANULARITY_DAY)
ALIGN_CLOCK = "clock"
ALIGN_ELAPSED = "elapsed"
#: An event longer than this is drawn by the day since it began, not by the hour.
EVENT_HOURLY_UP_TO = timedelta(hours=48)

SIDE_SHOP = "shop"
SIDE_AREA = "area"
SIDE_MACHINE = "machine"
SIDE_CASHIER = "cashier"
SIDE_KINDS = (SIDE_SHOP, SIDE_AREA, SIDE_MACHINE, SIDE_CASHIER)
#: Side by side is for a glance, not a league table: at most four columns.
SIDE_MAX = 4
#: The best sellers a comparison returns at most (an export asks for the most).
ITEMS_MAX = 1000
#: The events the filter lists at most (newest first).
EVENT_OPTIONS_MAX = 300

#: The figures' wire names, in the order the dashboard shows them; `deltas` uses the same.
FIGURE_KEYS = (
    "sales", "gross", "discounts", "refunds", "documents", "salesCount", "refundsCount",
    "averageTicket", "items", "cash", "card", "other", "tips",
)


# ── Small pure rules ─────────────────────────────────────────────────────────


def window_days(window: ReportWindow) -> int:
    return (window.to_date - window.from_date).days + 1


def pick_granularity(requested: Optional[str], *windows: Optional[ReportWindow]) -> str:
    """The caller's, or: by the hour when every period is one day, else by the day."""
    if requested in GRANULARITIES:
        return requested  # type: ignore[return-value]
    if all(w is None or window_days(w) == 1 for w in windows):
        return GRANULARITY_HOUR
    return GRANULARITY_DAY


def pct_change(current: float, previous: float) -> Optional[float]:
    """Percent change from `previous`; 0 when both are 0, null ("new") from 0 to anything."""
    if previous == 0:
        return 0.0 if current == 0 else None
    return round((current - previous) / abs(previous) * 100, 2)


def figure_delta(key: str, current: float, previous: float) -> CompareDelta:
    places = 3 if key == "items" else 2
    return CompareDelta(abs=round(current - previous, places), pct=pct_change(current, previous))


def _figures(bucket: Dict[str, float], items: float) -> CompareFigures:
    gross, discounts, refunds = bucket["gross"], bucket["discounts"], bucket["refunds"]
    sales_count = int(bucket["sales_count"])
    refunds_count = int(bucket["refunds_count"])
    return CompareFigures(
        sales=_cents(gross - discounts - refunds),
        gross=_cents(gross),
        discounts=_cents(discounts),
        refunds=_cents(refunds),
        documents=sales_count + refunds_count,
        sales_count=sales_count,
        refunds_count=refunds_count,
        average_ticket=_cents((gross - discounts) / sales_count) if sales_count else 0.0,
        items=round(items, 3),
        cash=_cents(bucket["cash_net"]),
        card=_cents(bucket["card_net"]),
        # `exchange` nets to zero over a complete basket; folded into "other" so
        # cash + card + other is the net, as on the overview.
        other=_cents(bucket["other_net"] + bucket["exchange_net"]),
        tips=_cents(bucket["tips"]),
    )


def figure_deltas(current: CompareFigures, previous: CompareFigures) -> Dict[str, CompareDelta]:
    a = current.model_dump(by_alias=True)
    b = previous.model_dump(by_alias=True)
    return {key: figure_delta(key, float(a[key]), float(b[key])) for key in FIGURE_KEYS}


# ── Events ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EventLens:
    """An event as a filter: its exact window, its tills, and the days that cover it."""

    brief: EventBrief
    start: datetime
    end: datetime
    machine_ids: Tuple[uuid_mod.UUID, ...]
    window: ReportWindow


def _utc(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _event_brief(event: ReportEvent, machine_ids: Sequence, shop_name: Optional[str]) -> EventBrief:
    zone = _load_zoneinfo(event.timezone or "Asia/Jerusalem")
    starts, ends = _utc(event.starts_at), _utc(event.ends_at)
    s_local, e_local = starts.astimezone(zone), ends.astimezone(zone)
    return EventBrief(
        id=str(event.id),
        name=event.name,
        shop_id=str(event.shop_id),
        shop_name=shop_name,
        company_id=str(event.company_id) if event.company_id else None,
        starts_at=starts,
        ends_at=ends,
        start_date=s_local.date(),
        end_date=e_local.date(),
        start_time=s_local.strftime("%H:%M"),
        end_time=e_local.strftime("%H:%M"),
        timezone=event.timezone or "Asia/Jerusalem",
        status=event.status,
        machine_ids=[str(m) for m in machine_ids],
    )


def load_event_lens(db: Session, user: User, tenant_id, event_id) -> EventLens:
    """The event, if the caller may read it (404 / 403 as on its own page), as a lens."""
    from app.services.report_events.crud import load_event

    event = load_event(db, user, tenant_id, event_id)
    machine_ids = tuple(
        row[0] for row in db.query(ReportEventMachine.machine_id).filter(ReportEventMachine.event_id == event.id)
    )
    shop = db.query(Shop.name).filter(Shop.id == event.shop_id).first()
    brief = _event_brief(event, machine_ids, shop[0] if shop else None)
    zone = _load_zoneinfo(brief.timezone)
    starts, ends = brief.starts_at, brief.ends_at
    last_day = (ends - timedelta(microseconds=1)).astimezone(zone).date()
    window = resolve_report_window(
        db, tenant_id, from_date=starts.astimezone(zone).date(), to_date=max(last_day, brief.start_date),
        tz=brief.timezone,
    )
    return EventLens(brief=brief, start=starts, end=ends, machine_ids=machine_ids, window=window)


def list_event_options(
    db: Session, user: User, tenant_id, *, q: Optional[str] = None, shop_id: Optional[uuid_mod.UUID] = None,
) -> List[EventBrief]:
    """
    The events of the shops the caller sees (the shops list's rule — the same shops whose
    events `load_event` lets them open), newest first, with their tills: three queries.
    """
    shops_q = _visible_shops_query(db, user, tenant_id)
    if shops_q is None:
        return []
    shops = {s.id: s.name for s in shops_q.with_entities(Shop.id, Shop.name)}
    if shop_id is not None:
        shops = {k: v for k, v in shops.items() if k == shop_id}
    if not shops:
        return []
    events_q = db.query(ReportEvent).filter(
        ReportEvent.tenant_id == tenant_id, ReportEvent.shop_id.in_(list(shops)),
    )
    text = (q or "").strip()
    if text:
        events_q = events_q.filter(ReportEvent.name.ilike(f"%{text}%"))
    events = events_q.order_by(ReportEvent.starts_at.desc()).limit(EVENT_OPTIONS_MAX).all()
    tills: Dict[object, List] = defaultdict(list)
    if events:
        for event_id, machine_id in db.query(ReportEventMachine.event_id, ReportEventMachine.machine_id).filter(
            ReportEventMachine.event_id.in_([e.id for e in events])
        ):
            tills[event_id].append(machine_id)
    return [_event_brief(e, tills.get(e.id, []), shops.get(e.shop_id)) for e in events]


# ── Periods ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Period:
    """Days (a report window) or an event (its lens; the window covers its days)."""

    window: ReportWindow
    lens: Optional[EventLens] = None

    @staticmethod
    def of_event(lens: EventLens) -> "Period":
        return Period(window=lens.window, lens=lens)

    @property
    def start(self) -> datetime:
        return self.lens.start if self.lens is not None else self.window.start

    @property
    def end(self) -> datetime:
        return self.lens.end if self.lens is not None else self.window.end


def _apply_lens(tx_q: Query, lens: Optional[EventLens]) -> Query:
    if lens is None:
        return tx_q
    return tx_q.filter(
        Transaction.created_at >= lens.start,
        Transaction.created_at < lens.end,
        Transaction.machine_id.in_(list(lens.machine_ids)),
    )


# ── Queries ──────────────────────────────────────────────────────────────────


def _scoped_query(
    db: Session,
    user: User,
    tenant_id: uuid_mod.UUID,
    period: Period,
    *,
    company_id: Optional[uuid_mod.UUID] = None,
    shop_id: Optional[uuid_mod.UUID] = None,
    area_filter=None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> Optional[Query]:
    """The role's documents over the period, narrowed by what was asked (never widened)."""
    tx_q = build_scoped_transaction_query(
        db, user, tenant_id, period.window, shop_id=shop_id, machine_id=machine_id, area_filter=area_filter,
    )
    if tx_q is not None and company_id is not None:
        # A holding company means the group, as on the overview.
        group = descendant_company_ids(db, company_id)
        tx_q = tx_q.filter(Transaction.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group))))
    if tx_q is not None:
        tx_q = _apply_lens(tx_q, period.lens)
    return tx_q


def _key_str(raw) -> Optional[str]:
    return None if raw is None else str(raw)


def _merge(into: Dict[str, float], bucket: Dict[str, float]) -> None:
    for key, value in bucket.items():
        into[key] += value


def _money_by(tx_q: Query, key=None, joins=()) -> Dict[Optional[str], Dict[str, float]]:
    """`_sales_buckets` by `key` — or one bucket for the whole query (`key` None)."""
    # The tenant is one value inside a scoped query: grouping on it is "everything".
    agg = _sales_buckets(tx_q, key if key is not None else Transaction.tenant_id, joins=joins)
    if key is not None:
        return {_key_str(k): v for k, v in agg.items()}
    total = _new_sales_bucket()
    for bucket in agg.values():
        _merge(total, bucket)
    return {None: total}


def _tx_subquery(tx_q: Query, key=None, joins=()):
    q = tx_q
    for entity, onclause in joins:
        q = q.outerjoin(entity, onclause)
    cols = [
        Transaction.id.label("tx_id"),
        case((_is_refund_condition(), 1), else_=0).label("is_refund"),
    ]
    if key is not None:
        cols.append(key.label("k"))
    return q.with_entities(*cols).subquery()


def _items_by(db: Session, tx_q: Query, key=None, joins=()) -> Dict[Optional[str], float]:
    """Units sold less units refunded, by `key` (or in all): one grouped query."""
    sub = _tx_subquery(tx_q, key, joins)
    signed = case((sub.c.is_refund == 1, -TransactionItem.quantity), else_=TransactionItem.quantity)
    picked = [func.coalesce(func.sum(signed), 0).label("qty")]
    if key is not None:
        picked.insert(0, sub.c.k)
    rows_q = db.query(*picked).select_from(TransactionItem).join(sub, sub.c.tx_id == TransactionItem.transaction_id)
    if key is not None:
        return {_key_str(r.k): _to_float(r.qty) for r in rows_q.group_by(sub.c.k).all()}
    row = rows_q.one()
    return {None: _to_float(row.qty)}


def _products(db: Session, tx_q: Query) -> Dict[str, dict]:
    """Per product: units and net (the live items report's definitions), one grouped query."""
    sub = _tx_subquery(tx_q)
    refund = sub.c.is_refund == 1
    qty = TransactionItem.quantity
    line_total = TransactionItem.total_price
    line_discount = (
        func.coalesce(TransactionItem.discount, 0)
        + func.coalesce(TransactionItem.promotion_discount, 0)
        + func.coalesce(TransactionItem.voucher_discount, 0)
    )
    rows = (
        db.query(
            TransactionItem.product_id.label("product_id"),
            TransactionItem.sku.label("sku"),
            TransactionItem.product_name.label("name"),
            func.coalesce(func.sum(case((refund, -qty), else_=qty)), 0).label("qty"),
            # A credit-note line's total is already net of its discount.
            func.coalesce(func.sum(case((refund, -line_total), else_=line_total - line_discount)), 0).label("net"),
        )
        .select_from(TransactionItem)
        .join(sub, sub.c.tx_id == TransactionItem.transaction_id)
        .group_by(TransactionItem.product_id, TransactionItem.sku, TransactionItem.product_name)
        .all()
    )
    out: Dict[str, dict] = {}
    for r in rows:
        key = str(r.product_id) if r.product_id is not None else f"name:{r.name or ''}"
        row = out.setdefault(
            key,
            {"product_id": _key_str(r.product_id), "name": r.name, "sku": r.sku, "qty": 0.0, "net": 0.0},
        )
        row["qty"] += _to_float(r.qty)
        row["net"] += _to_float(r.net)
    return out


# ── Buckets ──────────────────────────────────────────────────────────────────


def _step(granularity: str) -> timedelta:
    return timedelta(hours=1) if granularity == GRANULARITY_HOUR else timedelta(days=1)


def _bucket_expr(db: Session, period: Period, granularity: str, alignment: str):
    if not _pg(db):
        # SQLite (the tests): the instant, binned below.
        return Transaction.created_at
    if alignment == ALIGN_ELAPSED:
        seconds = _step(granularity).total_seconds()
        return cast(
            func.floor((func.extract("epoch", Transaction.created_at) - period.start.timestamp()) / seconds), Integer,
        )
    local = func.timezone(period.window.tz_name, Transaction.created_at)
    if granularity == GRANULARITY_HOUR:
        return cast(func.extract("hour", local), Integer)
    return cast(local, Date)


def _bucket_index(db: Session, period: Period, granularity: str, alignment: str, raw) -> Optional[int]:
    if raw is None:
        return None
    if _pg(db):
        if alignment == ALIGN_ELAPSED or granularity == GRANULARITY_HOUR:
            return int(raw)
        day = raw.date() if isinstance(raw, datetime) else raw if isinstance(raw, date) else date.fromisoformat(str(raw)[:10])
        return (day - period.window.from_date).days
    moment = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw))
    moment = _utc(moment)
    if alignment == ALIGN_ELAPSED:
        return int((moment - period.start).total_seconds() // _step(granularity).total_seconds())
    local = moment.astimezone(_load_zoneinfo(period.window.tz_name))
    return local.hour if granularity == GRANULARITY_HOUR else (local.date() - period.window.from_date).days


def _series_by(
    db: Session, tx_q: Query, period: Period, granularity: str, alignment: str, key=None, joins=()
) -> Dict[Tuple[Optional[str], int], List[float]]:
    """Net and documents per (key, bucket): one grouped query."""
    q = tx_q
    for entity, onclause in joins:
        q = q.outerjoin(entity, onclause)
    bucket = _bucket_expr(db, period, granularity, alignment)
    cols = [
        bucket.label("b"),
        func.coalesce(func.sum(_signed_document_net()), 0).label("net"),
        func.count(Transaction.id).label("docs"),
    ]
    group = [bucket]
    if key is not None:
        cols.insert(0, key.label("k"))
        group.insert(0, key)
    out: Dict[Tuple[Optional[str], int], List[float]] = defaultdict(lambda: [0.0, 0])
    for r in q.with_entities(*cols).group_by(*group).all():
        index = _bucket_index(db, period, granularity, alignment, r.b)
        if index is None:
            continue
        cell = out[(_key_str(r.k) if key is not None else None, index)]
        cell[0] += _to_float(r.net)
        cell[1] += int(r.docs or 0)
    return out


def _bucket_count(period: Period, granularity: str, alignment: str) -> int:
    if alignment == ALIGN_ELAPSED:
        return max(1, math.ceil((period.end - period.start) / _step(granularity)))
    return 24 if granularity == GRANULARITY_HOUR else window_days(period.window)


def _bucket_start(period: Period, granularity: str, alignment: str, index: int) -> datetime:
    if alignment == ALIGN_ELAPSED:
        return period.start + _step(granularity) * index
    zone = _load_zoneinfo(period.window.tz_name)
    if granularity == GRANULARITY_HOUR:
        # Only a one-day period can be in the future hour by hour (several days add up).
        return datetime.combine(period.window.from_date, time(index), tzinfo=zone)
    return datetime.combine(period.window.from_date + timedelta(days=index), time.min, tzinfo=zone)


def _is_future(period: Period, granularity: str, alignment: str, index: int, now: datetime) -> bool:
    if alignment == ALIGN_CLOCK and granularity == GRANULARITY_HOUR and window_days(period.window) != 1:
        return False
    return _bucket_start(period, granularity, alignment, index) > now


def _value_at(series, key, index: int, period: Period, granularity: str, alignment: str, now: datetime):
    if index >= _bucket_count(period, granularity, alignment):
        return None
    if _is_future(period, granularity, alignment, index, now):
        return None
    return _cents(series.get((key, index), [0.0, 0])[0])


def _bucket_label(period: Period, granularity: str, alignment: str, index: int) -> str:
    if alignment == ALIGN_CLOCK:
        if granularity == GRANULARITY_HOUR:
            return f"{index:02d}:00"
        return (period.window.from_date + timedelta(days=index)).isoformat()
    local = _bucket_start(period, granularity, alignment, index).astimezone(_load_zoneinfo(period.window.tz_name))
    return local.strftime("%H:%M") if granularity == GRANULARITY_HOUR else local.date().isoformat()


def _bucket_date(period: Period, granularity: str, alignment: str, index: int) -> Optional[date]:
    if index >= _bucket_count(period, granularity, alignment):
        return None
    if granularity == GRANULARITY_HOUR:
        return None
    start = _bucket_start(period, granularity, alignment, index)
    return start.astimezone(_load_zoneinfo(period.window.tz_name)).date()


def _alignment_for(*periods: Optional[Period]) -> str:
    return ALIGN_ELAPSED if any(p is not None and p.lens is not None for p in periods) else ALIGN_CLOCK


def _granularity_for(requested: Optional[str], alignment: str, *periods: Optional[Period]) -> str:
    if alignment == ALIGN_ELAPSED:
        if requested in GRANULARITIES:
            return requested  # type: ignore[return-value]
        longest = max((p.end - p.start) for p in periods if p is not None)
        return GRANULARITY_HOUR if longest <= EVENT_HOURLY_UP_TO else GRANULARITY_DAY
    return pick_granularity(requested, *(p.window if p is not None else None for p in periods))


# ── A period against another ─────────────────────────────────────────────────


def build_period_compare(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window,
    compare_window=None,
    *,
    company_id: Optional[uuid_mod.UUID] = None,
    shop_id: Optional[uuid_mod.UUID] = None,
    area_filter=None,
    machine_id: Optional[uuid_mod.UUID] = None,
    granularity: Optional[str] = None,
    items: int = 0,
    now: Optional[datetime] = None,
) -> PeriodCompareResponse:
    """`window` / `compare_window`: a `ReportWindow` (days) or a `Period` (days or an event)."""
    now = now or datetime.now(timezone.utc)
    current_p = window if isinstance(window, Period) else Period(window)
    previous_p = (
        compare_window if isinstance(compare_window, Period) or compare_window is None else Period(compare_window)
    )
    alignment = _alignment_for(current_p, previous_p)
    gran = _granularity_for(granularity, alignment, current_p, previous_p)
    want_items = max(0, min(int(items or 0), ITEMS_MAX))

    def run(p: Period):
        tx_q = _scoped_query(
            db, current_user, tenant_id, p,
            company_id=company_id, shop_id=shop_id, area_filter=area_filter, machine_id=machine_id,
        )
        if tx_q is None:
            return _figures(_new_sales_bucket(), 0.0), {}, {}
        money = _money_by(tx_q)[None]
        units = _items_by(db, tx_q)[None]
        products = _products(db, tx_q) if want_items else {}
        return _figures(money, units), _series_by(db, tx_q, p, gran, alignment), products

    current, current_series, current_products = run(current_p)
    previous, previous_series, previous_products = (None, {}, {})
    if previous_p is not None:
        previous, previous_series, previous_products = run(previous_p)

    length = max(
        _bucket_count(current_p, gran, alignment),
        _bucket_count(previous_p, gran, alignment) if previous_p is not None else 0,
    )
    points: List[SeriesPoint] = []
    for i in range(length):
        in_a = i < _bucket_count(current_p, gran, alignment)
        label_from = current_p if in_a or previous_p is None else previous_p
        points.append(
            SeriesPoint(
                index=i,
                label=_bucket_label(label_from, gran, alignment, i),
                current_date=_bucket_date(current_p, gran, alignment, i),
                previous_date=_bucket_date(previous_p, gran, alignment, i) if previous_p is not None else None,
                current=_value_at(current_series, None, i, current_p, gran, alignment, now),
                previous=(
                    _value_at(previous_series, None, i, previous_p, gran, alignment, now)
                    if previous_p is not None
                    else None
                ),
                current_documents=int(current_series.get((None, i), [0.0, 0])[1]),
                previous_documents=int(previous_series.get((None, i), [0.0, 0])[1]),
            )
        )

    top: List[CompareItem] = []
    if want_items:
        ranked = sorted(current_products.items(), key=lambda kv: (-kv[1]["net"], -kv[1]["qty"], str(kv[1]["name"] or "")))
        for key, row in ranked[:want_items]:
            if row["net"] == 0 and row["qty"] == 0:
                continue
            other = previous_products.get(key)
            top.append(
                CompareItem(
                    key=key,
                    product_id=row["product_id"],
                    name=row["name"],
                    sku=row["sku"],
                    qty=round(row["qty"], 3),
                    net=_cents(row["net"]),
                    previous_qty=round(other["qty"], 3) if other else (0.0 if previous_p is not None else None),
                    previous_net=_cents(other["net"]) if other else (0.0 if previous_p is not None else None),
                )
            )

    return PeriodCompareResponse(
        window=current_p.window.to_schema(),
        compare_window=previous_p.window.to_schema() if previous_p is not None else None,
        granularity=gran,
        alignment=alignment,
        generated_at=now,
        event=current_p.lens.brief if current_p.lens is not None else None,
        compare_event=previous_p.lens.brief if previous_p is not None and previous_p.lens is not None else None,
        current=current,
        previous=previous,
        deltas=figure_deltas(current, previous) if previous is not None else None,
        series=points,
        top_items=top,
    )


# ── Side by side ─────────────────────────────────────────────────────────────


def _parse_ids(kind: str, ids: Sequence[str]) -> List[str]:
    cleaned: List[str] = []
    for raw in ids:
        value = str(raw or "").strip()
        if not value:
            continue
        if kind != SIDE_CASHIER:
            try:
                value = str(uuid_mod.UUID(value))
            except (ValueError, AttributeError):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Not an id: {raw!r}"
                ) from None
        if value not in cleaned:
            cleaned.append(value)
    if not cleaned:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="ids is required")
    if len(cleaned) > SIDE_MAX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"At most {SIDE_MAX} side by side",
        )
    return cleaned


def _visible_shop_ids(db: Session, user: User, tenant_id) -> List[uuid_mod.UUID]:
    shops_q = _visible_shops_query(db, user, tenant_id)
    return [row.id for row in shops_q.with_entities(Shop.id).all()] if shops_q is not None else []


def build_side_by_side(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window,
    *,
    kind: str,
    ids: Sequence[str],
    company_id: Optional[uuid_mod.UUID] = None,
    granularity: Optional[str] = None,
    now: Optional[datetime] = None,
) -> SideBySideResponse:
    """`window`: a `ReportWindow` (days) or a `Period` (days or an event)."""
    if kind not in SIDE_KINDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"kind must be one of: {', '.join(SIDE_KINDS)}",
        )
    wanted = _parse_ids(kind, ids)
    now = now or datetime.now(timezone.utc)
    period = window if isinstance(window, Period) else Period(window)
    alignment = _alignment_for(period)
    gran = _granularity_for(granularity, alignment, period)
    count = _bucket_count(period, gran, alignment)
    labels = [_bucket_label(period, gran, alignment, i) for i in range(count)]

    # Who may be listed: the structure the caller sees (GET /shops, GET /machines); a
    # cashier is named only from the documents the caller's scope reads.
    named: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    key = None
    joins: tuple = ()
    narrow = None
    if kind in (SIDE_SHOP, SIDE_MACHINE, SIDE_AREA):
        visible_shops = _visible_shop_ids(db, current_user, tenant_id)
        as_uuids = [uuid_mod.UUID(i) for i in wanted]
        if kind == SIDE_SHOP:
            if visible_shops:
                for shop in db.query(Shop).filter(Shop.id.in_(as_uuids), Shop.id.in_(visible_shops)).all():
                    named[str(shop.id)] = (shop.name, str(shop.shop_number) if shop.shop_number is not None else None)
            key = Transaction.shop_id
            narrow = Transaction.shop_id.in_([uuid_mod.UUID(i) for i in named])
        elif kind == SIDE_MACHINE:
            if visible_shops:
                for m in _visible_machines_query(db, current_user, tenant_id, visible_shops).filter(
                    POSMachine.id.in_(as_uuids)
                ):
                    named[str(m.id)] = (m.name, (m.pos_number or "").strip() or None)
            key = Transaction.machine_id
            narrow = Transaction.machine_id.in_([uuid_mod.UUID(i) for i in named])
        else:
            if visible_shops:
                areas = db.query(ShopArea).filter(ShopArea.id.in_(as_uuids), ShopArea.shop_id.in_(visible_shops)).all()
                for area in areas:
                    named[str(area.id)] = (area.name, None)
            key = Shift.area_id
            joins = ((Shift, Shift.id == Transaction.shift_id),)
            narrow = Transaction.shift_id.in_(
                select(Shift.id).where(Shift.area_id.in_([uuid_mod.UUID(i) for i in named]))
            )
        listed = [i for i in wanted if i in named]
    else:
        key = Transaction.cashier_id
        narrow = Transaction.cashier_id.in_(wanted)
        listed = list(wanted)

    money: Dict[Optional[str], Dict[str, float]] = {}
    units: Dict[Optional[str], float] = {}
    series: Dict[Tuple[Optional[str], int], List[float]] = {}
    if listed:
        tx_q = _scoped_query(db, current_user, tenant_id, period, company_id=company_id)
        if tx_q is not None:
            tx_q = tx_q.filter(narrow)
            money = _money_by(tx_q, key, joins)
            units = _items_by(db, tx_q, key, joins)
            series = _series_by(db, tx_q, period, gran, alignment, key, joins)

    if kind == SIDE_CASHIER:
        present = [i for i in listed if i in money]
        people = _load_cashier_names(db, present)
        for cashier_id in present:
            person = people.get(cashier_id)
            named[cashier_id] = (
                _display_name(person) or cashier_id,
                str(person.worker_number) if person is not None and getattr(person, "worker_number", None) else None,
            )

    entities: List[SideBySideEntity] = []
    for entity_id in listed:
        name, number = named.get(entity_id, (None, None))
        entities.append(
            SideBySideEntity(
                id=entity_id,
                name=name,
                number=number,
                found=entity_id in named,
                figures=_figures(money.get(entity_id) or _new_sales_bucket(), units.get(entity_id, 0.0)),
                series=[_value_at(series, entity_id, i, period, gran, alignment, now) for i in range(count)],
            )
        )
    return SideBySideResponse(
        window=period.window.to_schema(),
        kind=kind,
        granularity=gran,
        alignment=alignment,
        generated_at=now,
        event=period.lens.brief if period.lens is not None else None,
        buckets=labels,
        entities=entities,
    )
