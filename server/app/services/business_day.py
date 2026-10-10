"""
"שעת סיום יום עסקי" — which business day a moment belongs to, for management reports.

The owner (10.10): a bar's 01:00 sale on 1.10 is part of the evening of 30.9. The dynamic
parameter `businessDayEndHour` (0–12, default 4 = 04:00) says when a business day ends:

    business day of a moment = its local date, minus one day when its local hour < end hour

It is set like every till parameter, company → shop → area → till (the most specific wins,
app/services/till_parameters.py), so a sale belongs to the business day of the till that made it.

**Management only.** Nothing here changes a fiscal date: a Z is dated when it was produced, an
invoice or a receipt when it was issued, and VAT and the uniform file (מבנה אחיד) go by the
document's date. This module only decides how sales, comparisons, targets, the cockpit, insights
and the shift / Z lists' "יום עסקי" column group by day.

One function per language, pinned by the same golden fixture (`business_day_golden.json`, in
server/tests/fixtures and pos-android app/src/test/resources, the same bytes):

* Python — here (`business_day`, `business_day_start`, `normalize_end_hour`, `document_months`);
* TypeScript — client/src/lib/businessDay.ts;
* Kotlin — pos-android domain/BusinessDay.kt.

The rule is wall-clock arithmetic, so a DST change never moves a sale to another day: the local
time is what the cashier saw. A day's start is that local time on the day; when it does not
exist (the spring gap) it is the first instant after it, and when it is ambiguous (the autumn
overlap) the first of the two — Python's `fold=0`, java.time's default.
"""
from __future__ import annotations

import uuid
import weakref
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import Date, Integer, case, cast, func, literal
from sqlalchemy.orm import Session

#: The till parameter (app/services/till_parameters.py) and its bounds.
PARAMETER_KEY = "businessDayEndHour"
DEFAULT_END_HOUR = 4
MIN_END_HOUR = 0
MAX_END_HOUR = 12

LABEL = "שעת סיום יום עסקי"

#: Registered with the till parameters (app/services/till_parameters.py).
PARAMETER_SPECS = (
    dict(
        key=PARAMETER_KEY,
        label=LABEL,
        value_type="integer",
        default_value=DEFAULT_END_HOUR,
        description=(
            "השעה שבה מסתיים יום עסקי, 0–12 (ברירת מחדל 4 — 04:00). מכירה לפני השעה הזו שייכת ליום "
            "העסקי של אתמול: עם 4, מכירה ב-01:00 ב-1.10 נספרת ביום העסקי 30.9. 0 — יום קלנדרי (חצות). "
            "קובע איך מקובצים לפי יום דוחות המכירות, ההשוואות, היעדים והמובילים, לוח הבקרה, התובנות, "
            "ועמודת \"יום עסקי\" ברשימות המשמרות וה-Z — בדשבורד ובקופה. ניהולי בלבד: תאריך ה-Z הוא "
            "תאריך ההפקה שלו, תאריך חשבונית או קבלה הוא תאריך ההפקה שלה, ומע\"מ ומבנה אחיד תמיד לפי "
            "תאריך המסמך — אף אחד מהם לא משתנה. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)

#: The report's day basis (`dayBasis`): the business day (management's default) or the
#: document's calendar date (the basis of VAT and the uniform file).
BASIS_BUSINESS = "business"
BASIS_DOCUMENT = "document"
DAY_BASES = (BASIS_BUSINESS, BASIS_DOCUMENT)


# ── The rule ────────────────────────────────────────────────────────────────────


def normalize_end_hour(value: Any) -> int:
    """
    An end hour as the reports use it: a whole number clamped into 0–12; anything else
    (missing, text, a fraction, a boolean) is the default, 4.
    """
    if isinstance(value, bool) or value is None:
        return DEFAULT_END_HOUR
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")) or not value.is_integer():
            return DEFAULT_END_HOUR
        value = int(value)
    if isinstance(value, Decimal):
        if not value.is_finite() or value != value.to_integral_value():
            return DEFAULT_END_HOUR
        value = int(value)
    if not isinstance(value, int):
        return DEFAULT_END_HOUR
    return max(MIN_END_HOUR, min(MAX_END_HOUR, value))


def _zone(tz_name: str):
    from zoneinfo import ZoneInfo

    return ZoneInfo(tz_name)


def local_time(moment: datetime, tz_name: str) -> datetime:
    """`moment` on the wall clock of `tz_name` (a naive moment is UTC)."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_zone(tz_name))


def business_day_of_local(local: datetime, end_hour: int) -> date:
    """The business day of a wall-clock time: its date, or the day before when its hour < end hour."""
    day = local.date()
    return day - timedelta(days=1) if local.hour < normalize_end_hour(end_hour) else day


def business_day(moment: datetime, tz_name: str, end_hour: int) -> date:
    """The business day `moment` (UTC, or aware) belongs to in `tz_name`."""
    return business_day_of_local(local_time(moment, tz_name), end_hour)


def business_day_start(day: date, tz_name: str, end_hour: int) -> datetime:
    """
    The UTC instant business day `day` begins: `end_hour`:00 local on `day` — the first
    instant after the gap when the clocks skip it, the first of the two when they repeat it.
    """
    local = datetime.combine(day, time(hour=normalize_end_hour(end_hour)), tzinfo=_zone(tz_name))
    return local.astimezone(timezone.utc)


def business_day_range(first: date, last: date, tz_name: str, end_hour: int) -> Tuple[datetime, datetime]:
    """`[start of first, start of the day after last)` in UTC."""
    return (
        business_day_start(first, tz_name, end_hour),
        business_day_start(last + timedelta(days=1), tz_name, end_hour),
    )


def today(tz_name: str, end_hour: int, now: Optional[datetime] = None) -> date:
    """The business day it is now."""
    return business_day(now or datetime.now(timezone.utc), tz_name, end_hour)


# ── A Z's documents by calendar month (the cross-month line) ──────────────────────


def document_months(documents: Iterable[Tuple[datetime, Any]], tz_name: str) -> List[Dict[str, str]]:
    """
    `[{month: "YYYY-MM", total: "123.45"}]` — documents `(issued at, signed amount)` summed per
    calendar month of their DOCUMENT date in `tz_name`, oldest month first.

    A Z of the night of 30.9 can hold documents issued on 1.10; VAT is reported by the
    document's date, so the Z says how much of it belongs to each month. More than one entry
    = the cross-month line is shown (`cross_month_line`).
    """
    sums: Dict[str, Decimal] = {}
    for issued_at, amount in documents:
        if issued_at is None:
            continue
        local = local_time(issued_at, tz_name)
        key = f"{local.year:04d}-{local.month:02d}"
        sums[key] = sums.get(key, Decimal("0")) + Decimal(str(amount if amount is not None else 0))
    return [
        {"month": key, "total": str(sums[key].quantize(Decimal("0.01")))}
        for key in sorted(sums)
    ]


HEBREW_MONTHS = (
    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
    "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
)


def cross_month_line(months: Sequence[Mapping[str, str]]) -> Optional[str]:
    """
    "מתוך ה-Z: ₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר (לדיווח לפי תאריך המסמך)", or None when
    the Z's documents are all of one month (the line is shown only when relevant).
    """
    if len(months) < 2:
        return None
    parts = []
    for entry in months:
        month = int(str(entry["month"])[5:7])
        parts.append(f"{shekels(entry['total'])} מסמכי {HEBREW_MONTHS[month - 1]}")
    return "מתוך ה-Z: " + " · ".join(parts) + " (לדיווח לפי תאריך המסמך)"


def shekels(value: Any) -> str:
    """₪1,234.50 — a negative as -₪1,234.50 (the Z's own money format, app/services/z_print.py)."""
    amount = Decimal(str(value)).quantize(Decimal("0.01"))
    sign = "-" if amount < 0 else ""
    return f"{sign}₪{abs(amount):,.2f}"


# ── The end hour of a scope, and of each till ──────────────────────────────────────


@dataclass(frozen=True)
class EndHours:
    """
    The end hour a report uses: `default` for the report's scope, and each till's own where it
    differs (`by_machine`). A document goes by its till's hour, so one report over tills with
    different hours still files every sale under its own till's business day.
    """

    default: int = DEFAULT_END_HOUR
    by_machine: Mapping[uuid.UUID, int] = field(default_factory=dict)

    @classmethod
    def calendar(cls) -> "EndHours":
        """The document's calendar date ("לפי תאריך מסמך"): every day ends at midnight."""
        return cls(default=0, by_machine={})

    def for_machine(self, machine_id: Any) -> int:
        if machine_id is None:
            return self.default
        try:
            key = machine_id if isinstance(machine_id, uuid.UUID) else uuid.UUID(str(machine_id))
        except (TypeError, ValueError):
            return self.default
        return self.by_machine.get(key, self.default)

    @property
    def uniform(self) -> bool:
        return all(h == self.default for h in self.by_machine.values())

    @property
    def hours(self) -> Tuple[int, ...]:
        return tuple(sorted({self.default, *self.by_machine.values()}))

    def hour_sql(self, machine_col=None):
        """The end hour as SQL: a constant, or per till (`CASE machine_id …`)."""
        if machine_col is None or self.uniform:
            return literal(self.default, Integer)
        whens = [(machine_col == mid, hour) for mid, hour in self.by_machine.items() if hour != self.default]
        return case(*whens, else_=self.default)

    def day_sql(self, ts_col, tz_name: str, machine_col=None):
        """
        The business day of `ts_col` (timestamptz) as Postgres computes it — the same rule:
        the wall clock in `tz_name` (Postgres' own tzdata), minus the end hour, its date.
        """
        local = func.timezone(tz_name, ts_col)
        if machine_col is None or self.uniform:
            if self.default == 0:
                return cast(local, Date)
            return cast(local - func.make_interval(0, 0, 0, 0, self.default), Date)
        return cast(local - func.make_interval(0, 0, 0, 0, self.hour_sql(machine_col)), Date)

    def bounds(self, first: date, last: date, tz_name: str) -> Tuple[datetime, datetime]:
        """
        UTC bounds that hold every document of business days `first`..`last` of any of the
        hours (exact when they are uniform; `range_sql` narrows to each till's own).
        """
        starts = [business_day_start(first, tz_name, h) for h in self.hours]
        ends = [business_day_start(last + timedelta(days=1), tz_name, h) for h in self.hours]
        return min(starts), max(ends)

    def range_sql(self, ts_col, tz_name: str, first: date, last: date, machine_col=None):
        """
        The exact predicate "business day of the document in `first`..`last`" — the UTC bounds
        (index-friendly), and, with tills on different hours, each document's own business day.
        """
        from sqlalchemy import and_

        start, end = self.bounds(first, last, tz_name)
        clauses = [ts_col >= start, ts_col < end]
        if machine_col is not None and not self.uniform:
            day = self.day_sql(ts_col, tz_name, machine_col)
            clauses.extend([day >= first, day <= last])
        return and_(*clauses)

    def day_of(self, moment: datetime, tz_name: str, machine_id: Any = None) -> date:
        return business_day(moment, tz_name, self.for_machine(machine_id))


#: Per engine: whether the till parameters' tables exist (always, but in a test world built of
#: a few tables) — an absent table is the default hour, never an error in a report.
_TABLES_PRESENT: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _parameters_present(db: Session) -> bool:
    bind = db.get_bind()
    engine = getattr(bind, "engine", bind)
    try:
        known = _TABLES_PRESENT.get(engine)
    except TypeError:
        known = None
    if known is None:
        from sqlalchemy import inspect as sa_inspect

        try:
            # On the session's own connection: a second checkout of a single-connection pool
            # (SQLite in memory) would roll the session's transaction back on return.
            known = bool(sa_inspect(db.connection()).has_table("till_parameters"))
        except Exception:  # pragma: no cover - an unreadable catalogue: the default hour
            known = False
        try:
            _TABLES_PRESENT[engine] = known
        except TypeError:  # pragma: no cover
            pass
    return known


def _parameter(db: Session):
    from app.models.till_parameter import TillParameter

    if not _parameters_present(db):
        return None
    return db.query(TillParameter).filter(TillParameter.key == PARAMETER_KEY).first()


def _scope_default(parameter) -> int:
    """The parameter's own default (a super admin may change it), else 4; inactive → 4."""
    if parameter is None or not parameter.is_active:
        return DEFAULT_END_HOUR
    return normalize_end_hour(parameter.default_value) if parameter.default_value is not None else DEFAULT_END_HOUR


def _as_uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _values_by_scope(db: Session, parameter) -> Dict[Tuple[str, uuid.UUID], int]:
    from app.models.till_parameter import TillParameterValue

    out: Dict[Tuple[str, uuid.UUID], int] = {}
    if parameter is None or not parameter.is_active:
        return out
    for row in db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all():
        scope_id = _as_uuid(row.scope_id)
        # A stored value the parameter no longer accepts is passed over, as for the tills.
        if scope_id is None or isinstance(row.value, bool) or not isinstance(row.value, (int, float)):
            continue
        out[(row.scope_type, scope_id)] = normalize_end_hour(row.value)
    return out


def _resolve(values: Mapping[Tuple[str, uuid.UUID], int], default: int, chain: Sequence[Tuple[str, Any]]) -> int:
    for kind, ident in chain:
        ident = _as_uuid(ident)
        if ident is not None and (kind, ident) in values:
            return values[(kind, ident)]
    return default


def end_hour_for(
    db: Session,
    *,
    company_id: Any = None,
    shop_id: Any = None,
    area_id: Any = None,
    machine_id: Any = None,
) -> int:
    """
    The end hour of one scope — the till's, else its area's, its shop's, its company's, the
    parameter's default. Missing levels are looked up (a till's area and shop, a shop's company).
    """
    return end_hours_for_scope(
        db, company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id, with_machines=False
    ).default


def end_hours_for_scope(
    db: Session,
    *,
    tenant_id: Any = None,
    company_id: Any = None,
    shop_id: Any = None,
    area_id: Any = None,
    machine_id: Any = None,
    machine_ids: Optional[Iterable[Any]] = None,
    with_machines: bool = True,
) -> EndHours:
    """
    The end hours of a report's scope: its own level's hour as the default, and every till in
    it (or in `machine_ids`) that resolves differently. One query for the values, one for tills.
    """
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea

    parameter = _parameter(db)
    base = _scope_default(parameter)
    values = _values_by_scope(db, parameter)
    machine_id, area_id, shop_id, company_id = map(_as_uuid, (machine_id, area_id, shop_id, company_id))

    # Fill the chain upwards from the most specific level named.
    if machine_id is not None and (area_id is None or shop_id is None):
        row = db.query(POSMachine.area_id, POSMachine.shop_id).filter(POSMachine.id == machine_id).first()
        if row:
            area_id = area_id or row[0]
            shop_id = shop_id or row[1]
    if area_id is not None and shop_id is None:
        row = db.query(ShopArea.shop_id).filter(ShopArea.id == area_id).first()
        shop_id = row[0] if row else None
    if shop_id is not None and company_id is None:
        row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
        company_id = row[0] if row else None

    chain = [("machine", machine_id), ("area", area_id), ("shop", shop_id), ("company", company_id)]
    default = _resolve(values, base, chain)
    if not with_machines or not values:
        return EndHours(default=default, by_machine={})

    query = (
        db.query(POSMachine.id, POSMachine.area_id, POSMachine.shop_id, Shop.company_id)
        .outerjoin(Shop, Shop.id == POSMachine.shop_id)
    )
    wanted = [m for m in map(_as_uuid, machine_ids or ()) if m is not None]
    if wanted:
        query = query.filter(POSMachine.id.in_(wanted))
    elif machine_id is not None:
        query = query.filter(POSMachine.id == machine_id)
    elif area_id is not None:
        query = query.filter(POSMachine.area_id == area_id)
    elif shop_id is not None:
        query = query.filter(POSMachine.shop_id == shop_id)
    elif company_id is not None:
        query = query.filter(Shop.company_id == company_id)
    elif tenant_id is not None:
        query = query.filter(POSMachine.tenant_id == _as_uuid(tenant_id))
    by_machine: Dict[uuid.UUID, int] = {}
    for mid, m_area, m_shop, m_company in query.all():
        hour = _resolve(values, base, [("machine", mid), ("area", m_area), ("shop", m_shop), ("company", m_company)])
        if hour != default:
            by_machine[_as_uuid(mid)] = hour
    return EndHours(default=default, by_machine=by_machine)


def end_hours_for_basis(db: Session, basis: Optional[str], **scope) -> EndHours:
    """`dayBasis` → the hours: the business day's (default), or the document's calendar date."""
    if (basis or BASIS_BUSINESS) == BASIS_DOCUMENT:
        return EndHours.calendar()
    return end_hours_for_scope(db, **scope)


BASIS_QUERY_DESCRIPTION = (
    "`business` (the default for management reports): each sale on its till's business day — "
    "a day ends at the \"שעת סיום יום עסקי\" parameter (04:00 unless set), so a 01:00 sale is "
    "the evening before. `document`: on the document's calendar date (VAT and the uniform file "
    "are always on this)."
)


def scope_of(
    *, company_id: Any = None, shop_id: Any = None, area_id: Any = None, machine_id: Any = None,
    machine_ids: Optional[Iterable[Any]] = None, shop_ids: Optional[Iterable[Any]] = None,
) -> Dict[str, Any]:
    """
    A report's filters as the `scope` of `end_hours_for_scope`: ids only (an area filter of
    `none`, a FastAPI `Query` default or a bad id adds nothing). One shop of several = that shop.
    """
    out: Dict[str, Any] = {}
    for key, value in (("company_id", company_id), ("shop_id", shop_id), ("area_id", area_id), ("machine_id", machine_id)):
        ident = _as_uuid(value) if isinstance(value, (uuid.UUID, str)) else None
        if ident is not None:
            out[key] = ident
    if isinstance(machine_ids, (list, tuple, set)):
        wanted = [m for m in (_as_uuid(x) for x in machine_ids) if m is not None]
        if wanted:
            out["machine_ids"] = wanted
    if "shop_id" not in out and isinstance(shop_ids, (list, tuple, set)):
        shops = [s for s in (_as_uuid(x) for x in shop_ids) if s is not None]
        if len(shops) == 1:
            out["shop_id"] = shops[0]
    return out


def basis_of(value: Any) -> str:
    """A handler's `dayBasis` (a FastAPI `Query` default when called directly = not given), or 400."""
    return check_basis(value if isinstance(value, str) else None)


def check_basis(value: Optional[str]) -> str:
    """A `dayBasis` query value, or 400."""
    if value in (None, ""):
        return BASIS_BUSINESS
    if value not in DAY_BASES:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"dayBasis must be one of {', '.join(DAY_BASES)}",
        )
    return value


# ── A business date for a shift or a Z that came without one ─────────────────────────


def machine_business_day(db: Optional[Session], machine: Any, moment: Optional[datetime]) -> Optional[date]:
    """
    The business day of `moment` at till `machine` — its tenant's report timezone, its own end
    hour. For a shift (or a waiting bucket) the till sent no business date for: the fallback used
    to be the UTC date, which put an evening's sale on tomorrow.
    """
    if moment is None:
        return None
    if db is None:
        return business_day(moment, "Asia/Jerusalem", DEFAULT_END_HOUR)
    from app.services.reports import resolve_report_timezone

    tz_name = resolve_report_timezone(db, getattr(machine, "tenant_id", None), None)
    machine_id = getattr(machine, "id", None)
    hour = end_hour_for(db, machine_id=machine_id) if machine_id is not None else DEFAULT_END_HOUR
    return business_day(moment, tz_name, hour)


def shop_business_day(db: Session, tenant_id: Any, shop_id: Any, moment: datetime) -> date:
    """The business day of `moment` at a shop (its tenant's timezone, its end hour)."""
    from app.services.reports import resolve_report_timezone

    return business_day(moment, resolve_report_timezone(db, tenant_id, None), end_hour_for(db, shop_id=shop_id))
