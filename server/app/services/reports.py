"""
Operational reports: product sales, per-cashier, tips, and the shop-wide feed.

Three things in here are easy to get quietly wrong, so they are centralised:

1. **Which documents count.** Exactly the statuses the till's own Z-report counts
   (`REPORTABLE_STATUSES` in `domain/ZReport.kt`), which the server already mirrors
   as `SALE_STATUSES` in `app/services/dashboard_stats.py`. That constant is
   imported rather than re-declared: a report that counts cancelled or pending
   documents is worse than no report, and every declined card tap is a `cancelled`
   row sitting in the same table.

2. **Timezone.** Documents are stamped in UTC; the merchant thinks in Israel local
   time. Day boundaries are resolved in Python via `zoneinfo` (DST-correct), and
   the hour-of-day filter is evaluated by Postgres with `timezone(tz, created_at)`
   so it uses Postgres' own tzdata. Nothing anywhere assumes UTC == local.

3. **Refund direction.** A credit note is its own document (type 330) linked to the
   original, and its amounts are stored POSITIVE. So refunds are summed separately
   and SUBTRACTED. A credit note must never inflate a product's takings.

A note on the line-level amount conventions, which are asymmetric in the data and
therefore asymmetric here (see `SaleRepository.kt` / `RefundMath.kt`):

* sale line:        `total_price` is GROSS, `discount` is the money taken off
                    → net = total_price - discount
* credit-note line: `total_price` is ALREADY NET of the apportioned discount, and
                    `discount` repeats that same apportioned share
                    → refunded = total_price, and subtracting `discount` again
                      would credit the shop back money it never took.

At document level the same holds: a sale's `total_amount` is the gross of its line
totals with `document_discount` carrying the sum of line discounts, while a credit
note's `total_amount` is the net sum, i.e. exactly the money handed back.
"""
from __future__ import annotations

import uuid as uuid_mod
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import Integer, String, and_, case, cast, func, or_
from sqlalchemy.orm import Query, Session, joinedload

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZReport
from app.models.user import User
from app.schemas.reports import (
    CashierSalesReportResponse,
    CashierSalesRow,
    DaySummaryContributor,
    DaySummaryReportResponse,
    DaySummaryRow,
    DaySummaryTotals,
    ProductSalesReportResponse,
    ProductSalesRow,
    ProductSalesTotals,
    ReportWindowOut,
    ShopTransactionRow,
    TipMethodRow,
    TipsByCashierRow,
    TipsRangeReportResponse,
)
from app.services.dashboard_stats import SALE_STATUSES
from app.services.scoping import scope_query_by_user, scope_transactions_by_user
from app.services.tenders import CREDIT_NOTE_DOCUMENT_TYPE as _CREDIT_NOTE_DOCUMENT_TYPE
from app.services.tenders import normalize_tender as _normalize_tender
from app.services.tenders import (
    signed_tender_amount_expr,
    tender_method_expr,
)

# Israeli Tax Authority document type for a credit note (refund). 320 is the
# invoice/receipt. Mirrors `domain/Documents.kt` on the till. Imported rather than
# re-declared so this module and the tender rules cannot drift apart on which
# document type means "money went back out".
CREDIT_NOTE_DOCUMENT_TYPE = _CREDIT_NOTE_DOCUMENT_TYPE

# Fallback reporting timezone. The merchant is Israeli and every document in this
# system is stamped UTC, so "no timezone configured" must not silently mean UTC —
# that is exactly the failure this is here to avoid.
DEFAULT_REPORT_TIMEZONE = "Asia/Jerusalem"

# Longest day span a single report may cover. Guards against a UI sending
# from=1970 and asking Postgres to group the whole table.
MAX_REPORT_DAYS = 366

# Default span when the caller names neither end (30 days, inclusive), matching
# GET /transactions.
DEFAULT_REPORT_DAYS = 30

# Row caps. Reports are read straight into a dashboard table, so the cap is about
# keeping one careless request from returning a catalogue-sized payload.
PRODUCT_ROWS_DEFAULT = 200
PRODUCT_ROWS_MAX = 1000
CASHIER_ROWS_MAX = 500

# Hard cap on the till-facing shop feed. The screen shows "the last day of
# trading" and is scrolled by a cashier on a 5" terminal over a shop's wifi; more
# than this is not a longer list, it is a slower one.
SHOP_TRANSACTIONS_ROW_CAP = 200
SHOP_TRANSACTIONS_MAX_HOURS = 24 * 14


# ── Window resolution ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ReportWindow:
    """
    A day range plus an optional hour-of-day window, both in `tz_name` local time.

    Why a day range + hour window rather than two ISO datetimes: the question the
    owner actually asked ("choose specific hours in day for reports") is usually
    "what do my evenings look like", i.e. 18:00–22:00 across every day in a range.
    A single contiguous datetime span cannot express that at all, whereas a day
    range with an hour window expresses both it and the contiguous case (one day,
    one hour window). ISO datetimes would also have pushed the timezone question
    onto the caller, and a naive datetime from a UI is the single easiest way to
    end up reporting the wrong hours.
    """

    from_date: date
    to_date: date
    from_hour: Optional[int]
    to_hour: Optional[int]
    tz_name: str
    #: Absolute UTC bounds of the outer day range. `end` is exclusive.
    start: datetime
    end: datetime

    @property
    def wraps_midnight(self) -> bool:
        """True for a night shift such as 22:00–02:00."""
        return (
            self.from_hour is not None
            and self.to_hour is not None
            and self.from_hour > self.to_hour
        )

    def to_schema(self) -> ReportWindowOut:
        return ReportWindowOut(
            from_date=self.from_date,
            to_date=self.to_date,
            from_hour=self.from_hour,
            to_hour=self.to_hour,
            timezone=self.tz_name,
            window_start=self.start,
            window_end=self.end,
        )


def _load_zoneinfo(tz_name: str):
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown timezone '{tz_name}'",
        ) from exc


def resolve_report_timezone(
    db: Session,
    tenant_id: Optional[uuid_mod.UUID],
    tz_param: Optional[str],
) -> str:
    """
    Pick the timezone the report's days and hours are measured in.

    Order: explicit `tz` query param → the tenant's configured timezone → Israel.

    A tenant whose timezone is still the column default "UTC" is treated as
    unconfigured and falls through to Israel. That is deliberate: `Tenant.timezone`
    defaults to "UTC" while the provisioning path writes "Asia/Jerusalem", so "UTC"
    in practice means nobody ever set it — and honouring it would report a
    Jerusalem shop's evening trade under the wrong hours with no visible error.
    Callers that genuinely want UTC pass `tz=UTC` explicitly.
    """
    if tz_param:
        return tz_param
    if tenant_id is not None:
        row = db.query(Tenant.timezone).filter(Tenant.id == tenant_id).first()
        configured = (row[0] or "").strip() if row else ""
        if configured and configured.upper() != "UTC":
            return configured
    return DEFAULT_REPORT_TIMEZONE


def resolve_report_window(
    db: Session,
    tenant_id: Optional[uuid_mod.UUID],
    *,
    from_date: Optional[date],
    to_date: Optional[date],
    from_hour: Optional[int] = None,
    to_hour: Optional[int] = None,
    tz: Optional[str] = None,
) -> ReportWindow:
    """Validate the range and turn local day boundaries into absolute UTC bounds."""
    tz_name = resolve_report_timezone(db, tenant_id, tz)
    tzinfo = _load_zoneinfo(tz_name)

    today_local = datetime.now(timezone.utc).astimezone(tzinfo).date()
    if to_date is None:
        to_date = today_local
    if from_date is None:
        from_date = to_date - timedelta(days=DEFAULT_REPORT_DAYS - 1)

    if from_date > to_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="from must be before or equal to to",
        )
    span_days = (to_date - from_date).days + 1
    if span_days > MAX_REPORT_DAYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Range too wide ({span_days} days). Maximum is {MAX_REPORT_DAYS} days.",
        )

    if (from_hour is None) != (to_hour is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="fromHour and toHour must be supplied together",
        )
    if from_hour is not None and to_hour is not None:
        if not (0 <= from_hour <= 23):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="fromHour must be between 0 and 23",
            )
        if not (1 <= to_hour <= 24):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="toHour must be between 1 and 24 (exclusive upper bound)",
            )
        if from_hour == to_hour:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="fromHour and toHour must differ; use 0/24 for a whole day",
            )
        if from_hour == 0 and to_hour == 24:
            # A whole day — drop the filter rather than make Postgres evaluate it.
            from_hour = to_hour = None

    # Local midnight → the actual UTC instant, via zoneinfo so DST transitions are
    # handled. Israel's clocks move; a fixed +02:00/+03:00 offset would silently
    # shift a whole report by an hour for part of the year.
    start = datetime.combine(from_date, time.min, tzinfo=tzinfo).astimezone(timezone.utc)
    end = (
        datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=tzinfo)
        .astimezone(timezone.utc)
    )

    return ReportWindow(
        from_date=from_date,
        to_date=to_date,
        from_hour=from_hour,
        to_hour=to_hour,
        tz_name=tz_name,
        start=start,
        end=end,
    )


def local_hour_expr(window: ReportWindow, column=Transaction.created_at):
    """
    Hour-of-day of `column` in the report's timezone, as evaluated by Postgres.

    `timezone(tz, timestamptz)` returns the local wall-clock timestamp, so the
    extracted hour is the hour the cashier saw on the wall — DST included, because
    Postgres applies its own tzdata rather than a fixed offset.
    """
    return cast(func.extract("hour", func.timezone(window.tz_name, column)), Integer)


def hour_window_predicate(window: ReportWindow, column=Transaction.created_at):
    """
    Predicate for the hour window, or None when the whole day is in scope.

    `fromHour` is inclusive, `toHour` exclusive. A window that wraps midnight
    (fromHour > toHour, e.g. 22→2) is matched per calendar day inside the range:
    22:00–24:00 *and* 00:00–02:00 of each day. That is the useful reading for a bar
    asking "how does the late shift do", and it is what the response's echoed
    fromHour/toHour let the UI state plainly.
    """
    if window.from_hour is None or window.to_hour is None:
        return None
    hour = local_hour_expr(window, column)
    if window.wraps_midnight:
        return or_(hour >= window.from_hour, hour < window.to_hour)
    return and_(hour >= window.from_hour, hour < window.to_hour)


# ── Shared predicates and helpers ─────────────────────────────────────────────

def _is_refund_condition():
    """
    A credit note. Both signals are checked because either alone has a gap: a
    legacy row may have a null `document_type`, and a credit note raised outside
    the refund flow may not carry the back-link.
    """
    return or_(
        Transaction.document_type == CREDIT_NOTE_DOCUMENT_TYPE,
        Transaction.refund_of_transaction_id.isnot(None),
    )


def _to_float(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def build_scoped_transaction_query(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
) -> Optional[Query]:
    """
    The reportable-document set for a dashboard user, already time- and hour-filtered.

    Returns None when the user's role grants access to nothing, which every caller
    turns into an empty report rather than an error (same convention as
    `/dashboard/stats` and `/transactions`).
    """
    query = db.query(Transaction).filter(Transaction.tenant_id == tenant_id)
    query = scope_transactions_by_user(query, current_user, db)
    if query is None:
        return None

    query = query.filter(
        Transaction.created_at >= window.start,
        Transaction.created_at < window.end,
        # The one filter no report may omit. See module docstring.
        Transaction.status.in_(SALE_STATUSES),
    )
    hour_pred = hour_window_predicate(window)
    if hour_pred is not None:
        query = query.filter(hour_pred)

    if shop_id is not None:
        query = query.filter(Transaction.shop_id == shop_id)
    if machine_id is not None:
        query = query.filter(Transaction.machine_id == machine_id)
    if cashier_id:
        query = query.filter(Transaction.cashier_id == str(cashier_id))
    return query


def _load_cashier_names(db: Session, cashier_ids: Sequence[str]) -> Dict[str, PosUser]:
    """
    Resolve pos_user rows for the cashier ids seen on the documents.

    `transactions.cashier_id` is a free-text String(100), while `pos_users.id` is a
    UUID column — so non-UUID values (legacy rows, a desktop that wrote a username)
    are filtered out here. Passing them straight into the IN clause would make
    Postgres reject the whole query, taking the report down over one bad row.
    """
    valid: List[uuid_mod.UUID] = []
    for raw in cashier_ids:
        if not raw:
            continue
        try:
            valid.append(uuid_mod.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not valid:
        return {}
    return {
        str(pu.id): pu
        for pu in db.query(PosUser).filter(PosUser.id.in_(valid)).all()
    }


def _display_name(pu: Optional[PosUser]) -> Optional[str]:
    if pu is None:
        return None
    parts = [pu.first_name or "", pu.last_name or ""]
    return " ".join(p for p in parts if p).strip() or pu.username


def normalize_tender(method: Optional[str]) -> str:
    """
    Collapse a payment method to cash / card / other for the tender splits.

    Re-exported from `app.services.tenders`, which is where the tender rules live now
    that a document can have several. Kept as a name here because callers and tests
    already import it from this module.
    """
    return _normalize_tender(method)


# ── 2a. Product sales report ──────────────────────────────────────────────────

def build_product_sales_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
    limit: int = PRODUCT_ROWS_DEFAULT,
) -> ProductSalesReportResponse:
    now = datetime.now(timezone.utc)
    empty_totals = ProductSalesTotals(
        units_sold=0.0, units_refunded=0.0, units_net=0.0,
        gross=0.0, discounts=0.0, refunds=0.0, net=0.0, product_count=0,
    )
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window,
        shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id,
    )
    if tx_q is None:
        return ProductSalesReportResponse(
            window=window.to_schema(), generated_at=now, truncated=False,
            row_limit=limit, totals=empty_totals, rows=[],
        )

    # Carry the refund flag out of the transaction into the line-level aggregate,
    # so a credit note's lines can be summed on the other side of the ledger.
    tx_sub = tx_q.with_entities(
        Transaction.id.label("tx_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()

    is_refund = tx_sub.c.is_refund
    qty = TransactionItem.quantity
    line_gross = TransactionItem.total_price
    line_discount = func.coalesce(TransactionItem.discount, 0)

    rows = (
        db.query(
            TransactionItem.product_id.label("product_id"),
            TransactionItem.sku.label("sku"),
            TransactionItem.product_name.label("product_name"),
            func.coalesce(func.sum(case((is_refund.is_(False), qty), else_=0)), 0).label("units_sold"),
            func.coalesce(func.sum(case((is_refund.is_(True), qty), else_=0)), 0).label("units_refunded"),
            func.coalesce(
                func.sum(case((is_refund.is_(False), line_gross), else_=0)), 0
            ).label("gross"),
            func.coalesce(
                func.sum(case((is_refund.is_(False), line_discount), else_=0)), 0
            ).label("discounts"),
            # `total_price` on a credit-note line is ALREADY net of the apportioned
            # discount, so it is taken as-is. Subtracting `discount` here as well
            # would refund the shop money it never paid out.
            func.coalesce(
                func.sum(case((is_refund.is_(True), line_gross), else_=0)), 0
            ).label("refunds"),
            func.coalesce(func.sum(case((is_refund.is_(False), 1), else_=0)), 0).label("lines_sold"),
            func.coalesce(func.sum(case((is_refund.is_(True), 1), else_=0)), 0).label("lines_refunded"),
        )
        .select_from(TransactionItem)
        .join(tx_sub, tx_sub.c.tx_id == TransactionItem.transaction_id)
        # Grouped on the snapshot triple, not just product_id: the snapshot is what
        # keeps a line readable after the product is renamed or deleted, and lines
        # with a null product_id would otherwise collapse into one nameless row.
        .group_by(
            TransactionItem.product_id,
            TransactionItem.sku,
            TransactionItem.product_name,
        )
        .all()
    )

    out_rows: List[ProductSalesRow] = []
    t_units_sold = t_units_refunded = t_gross = t_discounts = t_refunds = 0.0
    for r in rows:
        units_sold = _to_float(r.units_sold)
        units_refunded = _to_float(r.units_refunded)
        gross = _to_float(r.gross)
        discounts = _to_float(r.discounts)
        refunds = _to_float(r.refunds)
        t_units_sold += units_sold
        t_units_refunded += units_refunded
        t_gross += gross
        t_discounts += discounts
        t_refunds += refunds
        out_rows.append(
            ProductSalesRow(
                product_id=r.product_id,
                product_name=r.product_name,
                sku=r.sku,
                units_sold=units_sold,
                units_refunded=units_refunded,
                units_net=units_sold - units_refunded,
                gross=gross,
                discounts=discounts,
                refunds=refunds,
                net=gross - discounts - refunds,
                lines_sold=int(r.lines_sold or 0),
                lines_refunded=int(r.lines_refunded or 0),
            )
        )

    # Sorted by net takings: the merchant's first question is what earns, and a
    # product whose credit notes outweigh its sales sinks to the bottom where it
    # is visible rather than hiding mid-table.
    out_rows.sort(key=lambda x: x.net, reverse=True)
    truncated = len(out_rows) > limit

    # Totals are computed over every row before the cap, so the header figures
    # still describe the whole window even when the table is trimmed.
    totals = ProductSalesTotals(
        units_sold=t_units_sold,
        units_refunded=t_units_refunded,
        units_net=t_units_sold - t_units_refunded,
        gross=t_gross,
        discounts=t_discounts,
        refunds=t_refunds,
        net=t_gross - t_discounts - t_refunds,
        product_count=len(out_rows),
    )
    return ProductSalesReportResponse(
        window=window.to_schema(),
        generated_at=now,
        truncated=truncated,
        row_limit=limit,
        totals=totals,
        rows=out_rows[:limit],
    )


# ── 2b. Per-cashier report ────────────────────────────────────────────────────

def _empty_cashier_row(**kwargs) -> CashierSalesRow:
    base = dict(
        cashier_id=None, cashier_name=None, worker_number=None,
        document_count=0, sales_count=0, refunds_count=0,
        gross=0.0, discounts=0.0, refunds=0.0, net=0.0, average_basket=0.0,
        cash_net=0.0, card_net=0.0, other_net=0.0, tips=0.0,
    )
    base.update(kwargs)
    return CashierSalesRow(**base)


def build_cashier_sales_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> CashierSalesReportResponse:
    now = datetime.now(timezone.utc)
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id,
    )
    if tx_q is None:
        return CashierSalesReportResponse(
            window=window.to_schema(), generated_at=now,
            totals=_empty_cashier_row(cashier_name="Total"), rows=[],
        )

    refund_cond = _is_refund_condition()
    # A sale's total_amount is gross of line discounts (document_discount carries
    # their sum); a credit note's total_amount is already the money handed back.
    sale_gross = Transaction.total_amount
    sale_discount = func.coalesce(Transaction.document_discount, 0)

    # Document-level figures. Deliberately NOT grouped by tender any more: a document
    # can now carry several, and grouping the document's own gross/discounts/tips by
    # tender would either double-count them across the legs or force an arbitrary
    # choice of which leg owns them. The tender split is a second query below.
    rows = (
        tx_q.with_entities(
            Transaction.cashier_id.label("cashier_id"),
            func.coalesce(func.sum(case((refund_cond, 0), else_=sale_gross)), 0).label("gross"),
            func.coalesce(func.sum(case((refund_cond, 0), else_=sale_discount)), 0).label("discounts"),
            func.coalesce(func.sum(case((refund_cond, Transaction.total_amount), else_=0)), 0).label("refunds"),
            func.coalesce(func.sum(case((refund_cond, 0), else_=1)), 0).label("sales_count"),
            func.coalesce(func.sum(case((refund_cond, 1), else_=0)), 0).label("refunds_count"),
            func.coalesce(func.sum(Transaction.tip_amount), 0).label("tips"),
        )
        .group_by(Transaction.cashier_id)
        .all()
    )

    def _new_bucket() -> Dict[str, float]:
        return {
            "gross": 0.0, "discounts": 0.0, "refunds": 0.0, "tips": 0.0,
            "sales_count": 0, "refunds_count": 0,
            "cash_net": 0.0, "card_net": 0.0, "other_net": 0.0,
        }

    agg: Dict[Optional[str], Dict[str, float]] = {}
    for r in rows:
        key = r.cashier_id or None
        bucket = agg.setdefault(key, _new_bucket())
        bucket["gross"] += _to_float(r.gross)
        bucket["discounts"] += _to_float(r.discounts)
        bucket["refunds"] += _to_float(r.refunds)
        bucket["tips"] += _to_float(r.tips)
        bucket["sales_count"] += int(r.sales_count or 0)
        bucket["refunds_count"] += int(r.refunds_count or 0)

    # Tender split, from the tender rows rather than from `transactions.payment_method`.
    #
    # This is the whole point of split tender: a ₪50-cash / ₪73-card sale used to land
    # ₪123 in whichever single bucket the document claimed, which is wrong by ₪123 in
    # two columns at once.
    #
    # Still NET money, so cashNet + cardNet + otherNet == net exactly as before: a leg
    # amount is the money applied to the document, i.e. already after its discount,
    # and a credit note's legs are signed negative — so a refund handed back in cash
    # reduces the cash line, the way the till's own Z-report signs it.
    #
    # OUTER join, so a document with no leg rows (anything written before this feature,
    # or anything the backfill missed) still contributes via its own `payment_method`
    # and collectable amount — the pre-split behaviour, unchanged.
    method_expr = tender_method_expr()
    tender_rows = (
        tx_q.outerjoin(
            TransactionPayment, TransactionPayment.transaction_id == Transaction.id
        )
        .with_entities(
            Transaction.cashier_id.label("cashier_id"),
            method_expr.label("method"),
            func.coalesce(func.sum(signed_tender_amount_expr()), 0).label("net"),
        )
        .group_by(Transaction.cashier_id, method_expr)
        .all()
    )
    for r in tender_rows:
        bucket = agg.setdefault(r.cashier_id or None, _new_bucket())
        bucket[f"{normalize_tender(r.method)}_net"] += _to_float(r.net)

    pos_users = _load_cashier_names(db, [k for k in agg.keys() if k])

    out_rows: List[CashierSalesRow] = []
    for cashier_id, b in agg.items():
        pu = pos_users.get(cashier_id) if cashier_id else None
        sales_count = int(b["sales_count"])
        net = b["gross"] - b["discounts"] - b["refunds"]
        out_rows.append(
            CashierSalesRow(
                cashier_id=cashier_id,
                # Falls back to the raw cashier_id so an unmatched operator is still
                # identifiable in the table rather than showing as a blank row.
                cashier_name=_display_name(pu) or (cashier_id if cashier_id else None),
                worker_number=pu.worker_number if pu else None,
                document_count=sales_count + int(b["refunds_count"]),
                sales_count=sales_count,
                refunds_count=int(b["refunds_count"]),
                gross=b["gross"],
                discounts=b["discounts"],
                refunds=b["refunds"],
                net=net,
                average_basket=(b["gross"] - b["discounts"]) / sales_count if sales_count else 0.0,
                cash_net=b["cash_net"],
                card_net=b["card_net"],
                other_net=b["other_net"],
                tips=b["tips"],
            )
        )

    out_rows.sort(key=lambda x: x.net, reverse=True)
    out_rows = out_rows[:CASHIER_ROWS_MAX]

    total_sales_count = sum(r.sales_count for r in out_rows)
    total_gross = sum(r.gross for r in out_rows)
    total_discounts = sum(r.discounts for r in out_rows)
    totals = _empty_cashier_row(
        cashier_name="Total",
        document_count=sum(r.document_count for r in out_rows),
        sales_count=total_sales_count,
        refunds_count=sum(r.refunds_count for r in out_rows),
        gross=total_gross,
        discounts=total_discounts,
        refunds=sum(r.refunds for r in out_rows),
        net=sum(r.net for r in out_rows),
        average_basket=(total_gross - total_discounts) / total_sales_count if total_sales_count else 0.0,
        cash_net=sum(r.cash_net for r in out_rows),
        card_net=sum(r.card_net for r in out_rows),
        other_net=sum(r.other_net for r in out_rows),
        tips=sum(r.tips for r in out_rows),
    )
    return CashierSalesReportResponse(
        window=window.to_schema(), generated_at=now, totals=totals, rows=out_rows,
    )


# ── 2c. Tips report ───────────────────────────────────────────────────────────

def build_tips_range_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> TipsRangeReportResponse:
    now = datetime.now(timezone.utc)
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id,
    )
    if tx_q is None:
        return TipsRangeReportResponse(
            window=window.to_schema(), generated_at=now,
            tips_total=0.0, tips_cash=0.0, tips_card=0.0, tips_other=0.0,
            by_method=[], by_cashier=[],
        )

    refund_cond = _is_refund_condition()
    sale_net = Transaction.total_amount - func.coalesce(Transaction.document_discount, 0)

    rows = (
        tx_q.with_entities(
            Transaction.cashier_id.label("cashier_id"),
            Transaction.tip_payment_method.label("tip_method"),
            Transaction.payment_method.label("payment_method"),
            func.coalesce(func.sum(Transaction.tip_amount), 0).label("tips"),
            func.coalesce(
                func.sum(case((Transaction.tip_amount > 0, 1), else_=0)), 0
            ).label("tipped_count"),
            # Net takings alongside the tips, so the UI can show tips as a share of
            # sales without a second round trip.
            func.coalesce(func.sum(case((refund_cond, 0), else_=sale_net)), 0).label("sales_gross_net"),
            func.coalesce(
                func.sum(case((refund_cond, Transaction.total_amount), else_=0)), 0
            ).label("refunds"),
        )
        .group_by(
            Transaction.cashier_id,
            Transaction.tip_payment_method,
            Transaction.payment_method,
        )
        .all()
    )

    by_method: Dict[str, Dict[str, float]] = {
        m: {"amount": 0.0, "documents": 0} for m in ("cash", "card", "other")
    }
    by_cashier: Dict[Optional[str], Dict[str, float]] = {}

    for r in rows:
        tips = _to_float(r.tips)
        tipped = int(r.tipped_count or 0)
        # `tip_payment_method` is the truth when the till sent it; otherwise the tip
        # rode on the sale's own tender. Same fallback as services/tips.py and
        # dashboard_stats, so the three surfaces cannot disagree.
        #
        # A split-tender document has no single tender for the tip to have ridden on,
        # so its `payment_method` reads "mixed" and the fallback lands in `other`
        # rather than guessing a leg. That is the honest answer: only the till knows
        # which tender the tip went on, and it says so in `tip_payment_method`.
        method = normalize_tender(r.tip_method or r.payment_method)

        by_method[method]["amount"] += tips
        by_method[method]["documents"] += tipped

        key = r.cashier_id or None
        bucket = by_cashier.setdefault(
            key,
            {
                "tips_total": 0.0, "cash": 0.0, "card": 0.0, "other": 0.0,
                "tipped": 0, "sales_net": 0.0,
            },
        )
        bucket["tips_total"] += tips
        bucket[method] += tips
        bucket["tipped"] += tipped
        bucket["sales_net"] += _to_float(r.sales_gross_net) - _to_float(r.refunds)

    pos_users = _load_cashier_names(db, [k for k in by_cashier.keys() if k])

    cashier_rows: List[TipsByCashierRow] = []
    for cashier_id, b in by_cashier.items():
        pu = pos_users.get(cashier_id) if cashier_id else None
        cashier_rows.append(
            TipsByCashierRow(
                cashier_id=cashier_id,
                cashier_name=_display_name(pu) or (cashier_id if cashier_id else None),
                worker_number=pu.worker_number if pu else None,
                tips_total=b["tips_total"],
                tips_cash=b["cash"],
                tips_card=b["card"],
                tips_other=b["other"],
                tipped_document_count=int(b["tipped"]),
                sales_net=b["sales_net"],
            )
        )
    cashier_rows.sort(key=lambda x: x.tips_total, reverse=True)
    cashier_rows = cashier_rows[:CASHIER_ROWS_MAX]

    return TipsRangeReportResponse(
        window=window.to_schema(),
        generated_at=now,
        tips_total=sum(v["amount"] for v in by_method.values()),
        tips_cash=by_method["cash"]["amount"],
        tips_card=by_method["card"]["amount"],
        tips_other=by_method["other"]["amount"],
        by_method=[
            TipMethodRow(
                method=m,
                amount=by_method[m]["amount"],
                document_count=int(by_method[m]["documents"]),
            )
            for m in ("cash", "card", "other")
        ],
        by_cashier=cashier_rows,
    )


# ── 2e. Shop-wide recent documents (till-facing) ──────────────────────────────

def load_shop_transactions_for_machine(
    db: Session,
    machine: POSMachine,
    *,
    hours: int,
    q: Optional[str] = None,
) -> Tuple[List[ShopTransactionRow], bool]:
    """
    Recent documents from every terminal in the authenticated machine's own shop.

    Scope is derived **solely** from the authenticated machine row: `machine.shop_id`
    and `machine.tenant_id`. The caller cannot name a shop, tenant, or machine list —
    a machine token proves "I am this terminal", it does not entitle its holder to
    choose whose documents to read.

    `machine.shop_id` is nullable (a paired-but-unassigned terminal), and a null here
    is returned as an empty result rather than becoming a filter. `shop_id IS NULL`
    would match every unassigned machine in every tenant, which is a cross-tenant
    leak written as a WHERE clause.

    Returns (rows, truncated).
    """
    if machine.shop_id is None:
        return [], False

    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    query = (
        db.query(
            Transaction.id,
            Transaction.transaction_number,
            Transaction.document_type,
            Transaction.total_amount,
            Transaction.payment_method,
            Transaction.status,
            Transaction.cashier_id,
            Transaction.created_at,
            POSMachine.name.label("machine_name"),
        )
        .join(POSMachine, POSMachine.id == Transaction.machine_id)
        .filter(
            Transaction.shop_id == machine.shop_id,
            Transaction.created_at >= since,
            # Same status gate as every other report: a cashier hunting for a sale
            # must not be shown the cancelled shell of a declined card tap.
            Transaction.status.in_(SALE_STATUSES),
        )
    )
    # Belt and braces on top of the shop filter. Shop ids are UUIDs and so unique in
    # practice, but tenant is the hard isolation boundary in this schema and every
    # other read carries it; a shop-only predicate would be one data accident away
    # from a cross-tenant read.
    #
    # A legacy machine paired before tenants existed can have a null tenant_id while
    # still being assigned to a shop (see `_scope_machines_by_tenant` in the machines
    # router). Rather than drop the tenant predicate for those — or lock the terminal
    # out — the tenant is recovered from its shop. Only if the shop has none too does
    # the query fall back to shop-only scoping, which is still a single concrete
    # shop_id and never a null-matching predicate.
    tenant_id = machine.tenant_id
    if tenant_id is None:
        row = db.query(Shop.tenant_id).filter(Shop.id == machine.shop_id).first()
        tenant_id = row[0] if row else None
    if tenant_id is not None:
        query = query.filter(Transaction.tenant_id == tenant_id)

    if q:
        needle = q.strip()
        if needle:
            like = f"%{needle}%"
            # Mirrors the till's local history search (`matchesHistoryQuery`):
            # case-insensitive substring on the document number, or a plain-string
            # substring on the amount — the cashier types "1" and expects 21.50 and
            # 100.00 both to match, exactly as they do offline.
            query = query.filter(
                or_(
                    Transaction.transaction_number.ilike(like),
                    cast(Transaction.total_amount, String).like(like),
                )
            )

    rows = (
        query.order_by(Transaction.created_at.desc())
        .limit(SHOP_TRANSACTIONS_ROW_CAP + 1)
        .all()
    )
    truncated = len(rows) > SHOP_TRANSACTIONS_ROW_CAP
    rows = rows[:SHOP_TRANSACTIONS_ROW_CAP]

    pos_users = _load_cashier_names(db, [r.cashier_id for r in rows])

    out: List[ShopTransactionRow] = []
    for r in rows:
        status_val = r.status.value if hasattr(r.status, "value") else (
            str(r.status) if r.status is not None else None
        )
        pu = pos_users.get(str(r.cashier_id)) if r.cashier_id else None
        out.append(
            ShopTransactionRow(
                id=str(r.id),
                transaction_number=r.transaction_number,
                document_type=r.document_type,
                total=_to_float(r.total_amount),
                payment_method=r.payment_method,
                status=status_val,
                cashier_name=_display_name(pu) or (r.cashier_id or None),
                machine_name=r.machine_name,
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
        )
    return out, truncated


# ── Day summary ───────────────────────────────────────────────────────────────
#
# Several tills' Z reports, rolled into one figure per trading day.
#
# Deliberately built on Z reports and not on transactions. A Z is the till's own
# declaration of what its day came to — the same numbers on the paper the shop keeps —
# so a summary made of them agrees with those documents by construction. Summing
# transactions instead would drift the moment a till's document set and its Z disagree
# (a sale that never synced, a purge, a clock skew), and the manager would have two
# irreconcilable answers with nothing to say which was right.
#
# The consequence is that a day with no Z is absent rather than zero: an open day has
# not declared anything yet. That is the honest answer, and it is why this is a summary
# of closed days and not a live figure.

#: One Z per till per day, so this bounds a year of a large chain rather than a page.
MAX_DAY_SUMMARY_Z_REPORTS = 5_000


def _z_vat(z: ZReport) -> Optional[Decimal]:
    """
    The VAT a Z declared.

    A cloud-built Z carries it in `vat_total` (null when a document declared none). A
    legacy, till-issued Z has it only in its payload blob, as below.

    `taxCollected` is where the till puts it; there is no column. Absent on Z reports
    filed before the till sent it, and a non-numeric value is treated as absent rather
    than coerced — the payload is client-supplied JSON, and a report that silently reads
    garbage as 0.00 understates a tax figure.
    """
    if z.per_machine is not None:
        return z.vat_total
    payload = z.payload or {}
    raw = payload.get("taxCollected")
    if raw is None or isinstance(raw, bool):
        return None
    try:
        return Decimal(str(raw))
    except (ArithmeticError, ValueError):
        return None


@dataclass
class _Accumulator:
    """Running totals for one day (or for the whole range)."""

    sales: Decimal = Decimal("0")
    refunds: Decimal = Decimal("0")
    cash_sales: Decimal = Decimal("0")
    card_sales: Decimal = Decimal("0")
    tips: Decimal = Decimal("0")
    cash_tips: Decimal = Decimal("0")
    card_tips: Decimal = Decimal("0")
    transactions_count: int = 0
    opening_cash: Decimal = Decimal("0")
    expected_cash: Decimal = Decimal("0")
    vat: Decimal = Decimal("0")
    vat_missing: int = 0
    actual_cash: Decimal = Decimal("0")
    variance: Decimal = Decimal("0")
    uncounted: int = 0
    #: Z reports rolled in. Zero means there is nothing to reconcile and nothing to
    #: declare, which is not the same as a reconciliation that came to zero.
    z_count: int = 0

    def add(self, z: ZReport) -> None:
        self.z_count += 1
        self.sales += _dec_or_zero(z.total_sales)
        self.refunds += _dec_or_zero(z.total_refunds)
        self.cash_sales += _dec_or_zero(z.total_cash_sales)
        self.card_sales += _dec_or_zero(z.total_card_sales)
        self.tips += _dec_or_zero(z.total_tips)
        self.cash_tips += _dec_or_zero(z.total_cash_tips)
        self.card_tips += _dec_or_zero(z.total_card_tips)
        self.transactions_count += int(z.transactions_count or 0)
        self.opening_cash += _dec_or_zero(z.opening_cash)
        self.expected_cash += _dec_or_zero(z.expected_cash)

        vat = _z_vat(z)
        if vat is None:
            self.vat_missing += 1
        else:
            self.vat += vat

        # `actual_cash` is NULL when nobody counted — an unattended close, or a Z from
        # before the till sent a count. Both make the day's variance unknowable, and
        # neither may be read as zero.
        variance = _z_variance(z)
        if z.actual_cash is None or variance is None:
            self.uncounted += 1
        else:
            self.actual_cash += _dec_or_zero(z.actual_cash)
            self.variance += variance

    def to_totals(self) -> DaySummaryTotals:
        # An empty selection has no variance and no VAT to report. Returning 0.00 would
        # show a day nobody closed as balanced and exempt, which reads as a finding
        # rather than as the absence of one.
        counted = self.z_count > 0 and self.uncounted == 0
        declared_vat = self.z_count > 0 and self.vat_missing == 0
        return DaySummaryTotals(
            sales=_to_float(self.sales),
            refunds=_to_float(self.refunds),
            net=_to_float(self.sales - self.refunds),
            cash_sales=_to_float(self.cash_sales),
            card_sales=_to_float(self.card_sales),
            transactions_count=self.transactions_count,
            tips=_to_float(self.tips),
            cash_tips=_to_float(self.cash_tips),
            card_tips=_to_float(self.card_tips),
            opening_cash=_to_float(self.opening_cash),
            expected_cash=_to_float(self.expected_cash),
            vat=_to_float(self.vat) if declared_vat else None,
            vat_missing_count=self.vat_missing,
            actual_cash=_to_float(self.actual_cash) if counted else None,
            variance=_to_float(self.variance) if counted else None,
            uncounted_count=self.uncounted,
        )


def _z_variance(z: ZReport) -> Optional[Decimal]:
    """
    A Z's over/short, or None when it is unknown.

    A cloud Z's is its own `discrepancy`: the sum of each shift's over/short, NULL if
    any shift was uncounted. It is *not* counted − expected — a till's drawer figures
    are its last shift's, and a shortfall in an earlier shift of the same Z is in the
    discrepancy only (`app.services.z_builder.till_cash_summary`). A legacy till-issued
    Z has one drawer and one count, so counted − expected is its variance.
    """
    if z.per_machine is not None:
        return None if z.discrepancy is None else _dec_or_zero(z.discrepancy)
    if z.actual_cash is None:
        return None
    return _dec_or_zero(z.actual_cash) - _dec_or_zero(z.expected_cash)


def _dec_or_zero(value) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _float_or_none(value) -> Optional[float]:
    return _to_float(_dec_or_zero(value)) if value is not None else None


def _contributors_of(z: ZReport) -> List[DaySummaryContributor]:
    """
    One contributor per till in a Z: its per-till sections, or the legacy Z itself.

    The per-till section is the drill-down unit a bookkeeper needs, because a register's
    figures are what the regulation ties a Z to (docs: shifts-plan §3).
    """
    common = dict(
        z_report_id=z.id,
        shop_sequence_number=z.shop_sequence_number,
        shop_id=z.shop_id,
        shop_name=z.shop.name if z.shop else None,
        closed_at=z.closed_at,
    )
    if z.per_machine is None:
        return [
            DaySummaryContributor(
                **common,
                machine_id=z.machine_id,
                machine_name=z.machine.name if z.machine else None,
                unattended=bool(z.unattended),
                reconstructed=bool(z.reconstructed),
                uncounted=z.actual_cash is None,
                sales=_to_float(_dec_or_zero(z.total_sales)),
                refunds=_to_float(_dec_or_zero(z.total_refunds)),
                net=_to_float(_dec_or_zero(z.total_sales) - _dec_or_zero(z.total_refunds)),
                cash_sales=_to_float(_dec_or_zero(z.total_cash_sales)),
                card_sales=_to_float(_dec_or_zero(z.total_card_sales)),
                tips=_to_float(_dec_or_zero(z.total_tips)),
                transactions_count=int(z.transactions_count or 0),
                expected_cash=_to_float(_dec_or_zero(z.expected_cash)),
                actual_cash=_to_float(z.actual_cash) if z.actual_cash is not None else None,
                discrepancy=_to_float(z.discrepancy) if z.discrepancy is not None else None,
            )
        ]
    out = []
    for section in z.per_machine:
        sales = _dec_or_zero(section.get("totalSales"))
        refunds = _dec_or_zero(section.get("totalRefunds"))
        out.append(
            DaySummaryContributor(
                **common,
                machine_id=section.get("machineId"),
                machine_name=section.get("machineName"),
                unattended=bool(section.get("unattendedShiftCount")),
                reconstructed=bool(section.get("reconstructedShiftCount")),
                # An earlier shift left uncounted withholds the over/short even when
                # the last one was counted.
                uncounted=(
                    section.get("countedCash") is None
                    or section.get("overShort") is None
                ),
                sales=_to_float(sales),
                refunds=_to_float(refunds),
                net=_to_float(sales - refunds),
                cash_sales=_to_float(_dec_or_zero(section.get("totalCash"))),
                card_sales=_to_float(_dec_or_zero(section.get("totalCard"))),
                tips=_to_float(_dec_or_zero(section.get("totalTips"))),
                transactions_count=int(section.get("transactionsCount") or 0),
                expected_cash=_to_float(_dec_or_zero(section.get("expectedCash"))),
                actual_cash=_float_or_none(section.get("countedCash")),
                discrepancy=_float_or_none(section.get("overShort")),
            )
        )
    return out


def build_day_summary_report(
    db: Session,
    current_user: User,
    tenant_id: Optional[uuid_mod.UUID],
    window: ReportWindow,
    *,
    shop_ids: Optional[Sequence[uuid_mod.UUID]] = None,
    machine_ids: Optional[Sequence[uuid_mod.UUID]] = None,
) -> DaySummaryReportResponse:
    """
    Z reports in the range, grouped by the business date they were filed under.

    Filtered on `business_date` rather than on `closed_at`: a Z produced the next morning
    for Monday's shifts is Monday's trading, not whatever closed between 00:00 and 23:59.

    Contributors are the per-till sections of each Z (a cloud Z spans the shop's tills);
    a legacy, till-issued Z is its own single section.

    `shop_ids` and `machine_ids` narrow the selection and combine as an intersection —
    asking for a shop and a machine outside it is a contradiction and correctly returns
    nothing, rather than quietly widening to either.
    """
    query = (
        db.query(ZReport)
        .options(joinedload(ZReport.machine), joinedload(ZReport.shop))
        .filter(ZReport.tenant_id == tenant_id)
        .filter(ZReport.business_date >= window.from_date)
        .filter(ZReport.business_date <= window.to_date)
    )
    scoped = scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=ZReport.shop_id,
        machine_column=ZReport.machine_id,
    )
    if scoped is None:
        # No access is an empty report, not an error — same as every other report here.
        return DaySummaryReportResponse(
            window=window.to_schema(),
            generated_at=datetime.now(timezone.utc),
            totals=_Accumulator().to_totals(),
            days=[],
        )
    query = scoped

    if shop_ids:
        query = query.filter(ZReport.shop_id.in_(list(shop_ids)))
    if machine_ids:
        from sqlalchemy import select as _select
        from app.models.shift import Shift as _Shift

        wanted = list(machine_ids)
        query = query.filter(
            or_(
                ZReport.machine_id.in_(wanted),
                ZReport.id.in_(
                    _select(_Shift.z_report_id).where(
                        _Shift.machine_id.in_(wanted), _Shift.z_report_id.isnot(None)
                    )
                ),
            )
        )

    rows: List[ZReport] = (
        query.order_by(ZReport.business_date.desc(), ZReport.closed_at.desc())
        .limit(MAX_DAY_SUMMARY_Z_REPORTS + 1)
        .all()
    )
    if len(rows) > MAX_DAY_SUMMARY_Z_REPORTS:
        # Refused rather than truncated. A silently short list reads as "this is the
        # whole range", and the totals under it would be wrong with no sign of it.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Too many Z reports in range (over {MAX_DAY_SUMMARY_Z_REPORTS}). "
                "Narrow the date range, or select fewer shops."
            ),
        )

    per_day: Dict[date, _Accumulator] = {}
    contributors: Dict[date, List[DaySummaryContributor]] = {}
    machines_seen: Dict[date, set] = {}
    overall = _Accumulator()

    for z in rows:
        day = z.business_date
        acc = per_day.setdefault(day, _Accumulator())
        acc.add(z)
        overall.add(z)
        for contributor in _contributors_of(z):
            machines_seen.setdefault(day, set()).add(contributor.machine_id)
            contributors.setdefault(day, []).append(contributor)

    days = [
        DaySummaryRow(
            day_date=day,
            machine_count=len(machines_seen.get(day, ())),
            z_report_count=len({c.z_report_id for c in contributors.get(day, ())}),
            totals=acc.to_totals(),
            contributors=contributors.get(day, []),
        )
        for day, acc in sorted(per_day.items(), reverse=True)
    ]

    return DaySummaryReportResponse(
        window=window.to_schema(),
        generated_at=datetime.now(timezone.utc),
        totals=overall.to_totals(),
        days=days,
    )
