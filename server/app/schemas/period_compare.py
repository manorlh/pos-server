"""
The control board's comparisons (השוואות): `GET /reports/compare` (a period against another),
`GET /reports/side-by-side` (2–4 shops, points of sale, tills or cashiers over one period)
and `GET /reports/event-options` (the "אירוע" filter's list). Money as float, like every
report schema; camelCase on the wire.
"""
from datetime import date, datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.schemas.reports import ReportWindowOut


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class CompareFigures(_Camel):
    """One period's (or one entity's) headline figures — the overview's definitions."""

    #: Net takings: gross − discounts − refunds.
    sales: float
    gross: float
    discounts: float
    refunds: float
    #: Sales + credit notes.
    documents: int
    sales_count: int
    refunds_count: int
    #: (gross − discounts) per sale; 0 with no sales (never a division by zero).
    average_ticket: float
    #: Units sold less units refunded.
    items: float
    #: The tender split of the net (cash + card + other = sales).
    cash: float
    card: float
    other: float
    tips: float


class CompareDelta(_Camel):
    #: current − previous.
    abs: float
    #: Percent change from previous; null when previous is 0 and current is not ("new"),
    #: 0 when both are 0.
    pct: Optional[float] = None


class SeriesPoint(_Camel):
    """
    One bucket of the curve, the two periods aligned: by hour of day (0–23) for days, by
    the n-th day of each period for longer ones (a week's Sunday on the other's Sunday, the
    1st of a month on the 1st) — or, with an event, by the hours since each one began.
    """

    index: int
    #: "08:00" by the hour; the current period's day (ISO) by the day.
    label: str
    current_date: Optional[date] = None
    previous_date: Optional[date] = None
    #: Net; null for a bucket that has not happened yet (or outside a shorter period).
    current: Optional[float] = None
    previous: Optional[float] = None
    current_documents: int = 0
    previous_documents: int = 0


class EventBrief(_Camel):
    """An event (`report_events`) as a filter sees it: its name, window and tills."""

    id: str
    name: str
    shop_id: str
    shop_name: Optional[str] = None
    company_id: Optional[str] = None
    starts_at: datetime
    ends_at: datetime
    #: The event's own local days and clock times ("18:00").
    start_date: date
    end_date: date
    start_time: str
    end_time: str
    timezone: str
    status: str
    machine_ids: List[str]


class CompareItem(_Camel):
    """One product, the current period's best sellers by net, with the compared period's."""

    key: str
    product_id: Optional[str] = None
    name: Optional[str] = None
    sku: Optional[str] = None
    qty: float
    net: float
    previous_qty: Optional[float] = None
    previous_net: Optional[float] = None


class PeriodCompareResponse(_Camel):
    window: ReportWindowOut
    #: Null with no comparison.
    compare_window: Optional[ReportWindowOut] = None
    #: While the current period is still running: the instant the compared period's figures
    #: stop (like for like — its start plus the time the current one has run). Its curve is whole.
    compare_cut_at: Optional[datetime] = None
    #: "hour" or "day".
    granularity: str
    #: "clock" (hour of day / n-th calendar day) or "elapsed" (since each period began —
    #: whenever an event is one of the periods).
    alignment: str = "clock"
    generated_at: datetime
    #: The event a period is, when it is one.
    event: Optional[EventBrief] = None
    compare_event: Optional[EventBrief] = None
    current: CompareFigures
    previous: Optional[CompareFigures] = None
    #: Per figure (the figures' camelCase names); null with no comparison.
    deltas: Optional[Dict[str, CompareDelta]] = None
    series: List[SeriesPoint]
    #: The best sellers, when asked for (`items`).
    top_items: List[CompareItem] = []


class SideBySideEntity(_Camel):
    #: The id asked for (a shop's, an area's, a till's, or a cashier's).
    id: str
    name: Optional[str] = None
    #: For a till: its register number; for a shop: its number.
    number: Optional[str] = None
    #: A cashier with no document in the caller's scope over the period is still listed
    #: (with zeros), but nameless: `found` false.
    found: bool = True
    figures: CompareFigures
    #: Net per bucket, aligned with the response's `buckets`.
    series: List[Optional[float]]


class SideBySideResponse(_Camel):
    window: ReportWindowOut
    #: "shop" | "area" | "machine" | "cashier".
    kind: str
    granularity: str
    alignment: str = "clock"
    generated_at: datetime
    event: Optional[EventBrief] = None
    #: The buckets' labels ("08:00" or the day, ISO), the same length as each series.
    buckets: List[str]
    entities: List[SideBySideEntity]


class EventOptionsResponse(_Camel):
    #: Newest first.
    events: List[EventBrief]
