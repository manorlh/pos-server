"""
Operational reports.

Two distinct audiences, two distinct authentication rules, and the split matters:

* `/reports/products`, `/reports/cashiers`, `/reports/tips` are **dashboard-only**.
  They depend on `get_current_user`, which explicitly rejects a machine JWT, and on
  `get_active_tenant_id`, which requires an X-Tenant-Id the caller is a member of.
  A till cannot reach them at all.

* `/reports/{machine_id}/shop-transactions` is **till-facing** and is the only
  endpoint here a machine token can call. It uses the same dependency as the
  `/sync/{machine_id}/...` endpoints, and derives its scope exclusively from the
  authenticated machine row — never from anything the caller sends.

Z-report history (a list of past Z reports over a range, scopeable by machine)
already lives at `GET /z-reports`; it is extended there rather than duplicated here.
"""
from datetime import date, datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
    ensure_same_tenant,
)
from app.routers.shops import _check_shop_access
from app.services.areas import parse_area_filter
from app.services.business_day import BASIS_QUERY_DESCRIPTION, basis_of, scope_of
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.schemas.reports import (
    CashierSalesReportResponse,
    DaySummaryReportResponse,
    OverviewResponse,
    ProductSalesReportResponse,
    SalesByAreaResponse,
    ShopTransactionsResponse,
    TipsRangeReportResponse,
)
from app.schemas.offline_authorization import OfflineAuthorizationReportResponse
from app.schemas.period_compare import EventOptionsResponse, PeriodCompareResponse, SideBySideResponse
from app.schemas.voucher_board import VoucherBoardResponse
from app.services import offline_authorizations
from app.services.overview import build_overview
from app.services.period_compare import (
    ITEMS_MAX,
    Period,
    build_period_compare,
    build_side_by_side,
    list_event_options,
    load_event_lens,
)
from app.services.voucher_board import build_voucher_board
from app.schemas.live_items import LiveItemsResponse
from app.services.live_items import (
    LIVE_ITEMS_DEFAULT,
    LIVE_ITEMS_MAX,
    PERIOD_DAY,
    PERIOD_RANGE,
    PERIOD_SHIFT,
    build_live_items,
)
from app.services.reports import (
    PRODUCT_ROWS_DEFAULT,
    PRODUCT_ROWS_MAX,
    SHOP_TRANSACTIONS_MAX_HOURS,
    build_cashier_sales_report,
    build_day_summary_report,
    build_product_sales_report,
    build_sales_by_area_report,
    build_tips_range_report,
    load_shop_transactions_for_machine,
    resolve_report_window,
)

router = APIRouter(prefix="/reports", tags=["reports"])


# Shared query-parameter documentation. `from`/`to` are calendar days in the report
# timezone; `fromHour`/`toHour` narrow every one of those days to an hour window.
_FROM_DESC = "Start day (inclusive), in the report timezone. Defaults to 30 days back."
_TO_DESC = "End day (inclusive), in the report timezone. Defaults to today."
_FROM_HOUR_DESC = (
    "Start hour (0-23, inclusive) applied to every day in the range. "
    "Must be sent together with toHour."
)
_TO_HOUR_DESC = (
    "End hour (1-24, exclusive) applied to every day in the range. "
    "fromHour > toHour is a window that wraps midnight, e.g. 22-2 for a late shift."
)
_AREA_DESC = (
    "An area's id, or `none`. Filters on the area each document's shift was stamped "
    "with when the cloud created it — never the till's area now. No shift is `none`."
)
_TZ_DESC = (
    "IANA timezone the days and hours are measured in. "
    "Defaults to the tenant's configured timezone, else Asia/Jerusalem."
)


@router.get(
    "/products",
    response_model=ProductSalesReportResponse,
    response_model_by_alias=True,
)
def get_product_sales_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM_DESC),
    to_date: Optional[date] = Query(None, alias="to", description=_TO_DESC),
    from_hour: Optional[int] = Query(None, alias="fromHour", description=_FROM_HOUR_DESC),
    to_hour: Optional[int] = Query(None, alias="toHour", description=_TO_HOUR_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    limit: int = Query(PRODUCT_ROWS_DEFAULT, ge=1, le=PRODUCT_ROWS_MAX),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    meals: str = Query("components", pattern="^(components|meals)$",
                       description="components: a meal's line as its components; meals: as the meal"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Units and revenue per product over the range. Dashboard-only (Clerk/user JWT).

    A credit note's lines reduce the product's `net` and `unitsNet`; they are never
    added to `gross`. Cancelled and pending documents are excluded. A meal is reported
    as its components, with its money allocated to them (`meals=meals`: as the meal).
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date,
        from_hour=from_hour, to_hour=to_hour, tz=tz,
        day_basis=basis_of(day_basis), scope=scope_of(shop_id=shop_id, machine_id=machine_id, area_id=area_id),
    )
    return build_product_sales_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id, limit=limit,
        area_filter=parse_area_filter(area_id), meals=meals,
    )


@router.get(
    "/cashiers",
    response_model=CashierSalesReportResponse,
    response_model_by_alias=True,
)
def get_cashier_sales_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM_DESC),
    to_date: Optional[date] = Query(None, alias="to", description=_TO_DESC),
    from_hour: Optional[int] = Query(None, alias="fromHour", description=_FROM_HOUR_DESC),
    to_hour: Optional[int] = Query(None, alias="toHour", description=_TO_HOUR_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Per pos_user over the range: documents, gross, refunds, net, cash/card split.
    Dashboard-only (Clerk/user JWT).
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date,
        from_hour=from_hour, to_hour=to_hour, tz=tz,
        day_basis=basis_of(day_basis), scope=scope_of(shop_id=shop_id, machine_id=machine_id, area_id=area_id),
    )
    return build_cashier_sales_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id,
        area_filter=parse_area_filter(area_id),
    )


@router.get(
    "/sales-by-area",
    response_model=SalesByAreaResponse,
    response_model_by_alias=True,
)
def get_sales_by_area_report(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    date_from: Optional[date] = Query(None, alias="dateFrom", description=_FROM_DESC),
    date_to: Optional[date] = Query(None, alias="dateTo", description=_TO_DESC),
    # The other reports' names for the same two days, so either spelling works.
    from_date: Optional[date] = Query(None, alias="from", description="Same as dateFrom."),
    to_date: Optional[date] = Query(None, alias="to", description="Same as dateTo."),
    from_hour: Optional[int] = Query(None, alias="fromHour", description=_FROM_HOUR_DESC),
    to_hour: Optional[int] = Query(None, alias="toHour", description=_TO_HOUR_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    One shop's sales per area over the range, plus `Unassigned`, and their totals.
    Dashboard-only (Clerk/user JWT).

    By each document's shift's stamped area, never its till's area now. Archived areas
    that took something are included (`archived: true`). The money is the per-cashier
    report's, and the rows add up exactly to that report's shop total for the same
    window. No server-side CSV: like the other reports, the dashboard exports the JSON.
    """
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=date_from or from_date, to_date=date_to or to_date,
        from_hour=from_hour, to_hour=to_hour, tz=tz,
        day_basis=basis_of(day_basis), scope=scope_of(shop_id=shop.id),
    )
    return build_sales_by_area_report(db, current_user, active_tenant_id, window, shop=shop)


@router.get(
    "/tips",
    response_model=TipsRangeReportResponse,
    response_model_by_alias=True,
)
def get_tips_range_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM_DESC),
    to_date: Optional[date] = Query(None, alias="to", description=_TO_DESC),
    from_hour: Optional[int] = Query(None, alias="fromHour", description=_FROM_HOUR_DESC),
    to_hour: Optional[int] = Query(None, alias="toHour", description=_TO_HOUR_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Tips over the range, split by tip payment method and per cashier.
    Dashboard-only (Clerk/user JWT).

    Distinct from `GET /shops/{shopId}/tips/report`, which stays as it is: that one
    answers "who is owed what" under the shop's tip-distribution policy for a
    trading day. This one answers "how much came in, on what tender, when".
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date,
        from_hour=from_hour, to_hour=to_hour, tz=tz,
        day_basis=basis_of(day_basis), scope=scope_of(shop_id=shop_id, machine_id=machine_id, area_id=area_id),
    )
    return build_tips_range_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id,
        area_filter=parse_area_filter(area_id),
    )


@router.get(
    "/{machine_id}/shop-transactions",
    response_model=ShopTransactionsResponse,
    response_model_by_alias=True,
)
def get_shop_transactions(
    hours: int = Query(24, ge=1, le=SHOP_TRANSACTIONS_MAX_HOURS),
    q: Optional[str] = Query(None, max_length=100),
    # Same authentication as every other /sync/{machine_id}/... till endpoint:
    # a machine JWT whose `sub` equals machine_id, or a dashboard user who passes
    # the machine RBAC check. Decommissioned machines are locked out here.
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Recent documents across every terminal in the shop this machine belongs to.

    Fixed contract — the shipped Android till calls this. Do not rename fields.

    Scope comes only from the authenticated machine's own `shop_id` and `tenant_id`.
    There is deliberately no shopId/tenantId/machineIds parameter: a machine token
    proves which terminal is calling, and must not also let the caller choose whose
    documents to read. A machine with no shop assigned gets an empty list, never a
    `shop_id IS NULL` filter (which would match unassigned machines tenant-wide).

    Capped at 200 rows, newest first.
    """
    rows, _truncated = load_shop_transactions_for_machine(db, machine, hours=hours, q=q)
    return ShopTransactionsResponse(
        server_time=datetime.now(timezone.utc).isoformat(),
        transactions=rows,
    )


@router.get(
    "/day-summary",
    response_model=DaySummaryReportResponse,
    response_model_by_alias=True,
)
def get_day_summary_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM_DESC),
    to_date: Optional[date] = Query(None, alias="to", description=_TO_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    shop_ids: Optional[List[uuid.UUID]] = Query(
        None,
        alias="shopIds",
        description="Restrict to these shops. Repeatable. Combines with machineIds as an intersection.",
    ),
    machine_ids: Optional[List[uuid.UUID]] = Query(
        None,
        alias="machineIds",
        description="Restrict to these tills. Repeatable. Combines with shopIds as an intersection.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Several tills' closed days rolled into one figure per trading day (סיכום יומי).

    Dashboard-only (Clerk/user JWT). Built from Z reports, so it agrees with the Zs the
    shop filed — and so a day no Z covers yet is **absent rather than zero**, because
    nothing has been declared for it.

    Each day lists the Z reports behind it; follow `zReportId` to `GET /z-reports/{id}`
    for the document itself rather than a restatement of it.

    Two figures are withheld instead of approximated. `variance` is null unless every
    contributing Z was actually counted — an unattended close has no counted cash, and
    reporting the shortfall as zero is the specific lie the `unattended` flag exists to
    prevent. `vat` is null unless every contributing Z declared it, since older reports
    predate the field and a partial sum presented as the day's VAT understates it. Both
    carry a count of what was missing.

    This is a management report, not a fiscal document: it is not a Z, it closes
    nothing, and it is deliberately not printable.

    No `fromHour`/`toHour`: a Z covers a whole trading day, so narrowing it to an hour
    would be meaningless. Days are selected on the Z's `business_date` (by default the
    shop-local date of its latest shift) — a shift past midnight belongs to the day it
    started.
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date, tz=tz,
    )
    return build_day_summary_report(
        db, current_user, active_tenant_id, window,
        shop_ids=shop_ids, machine_ids=machine_ids,
    )


@router.get(
    "/offline-authorizations",
    response_model=OfflineAuthorizationReportResponse,
    response_model_by_alias=True,
)
def get_offline_authorizations_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM_DESC),
    to_date: Optional[date] = Query(None, alias="to", description=_TO_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The tills' offline authorization runs over the range (עסקאות במצב לא מקוון), newest
    first: what each run approved, and each uid it declined matched to the till's card
    leg — or `matched: false` when no document of the till carries it.

    Dashboard-only (Clerk/user JWT). Days are on the run's `authorizedAt`, not on the
    original sale's time.
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date, tz=tz,
    )
    return offline_authorizations.build_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id,
    )


@router.get(
    "/overview",
    response_model=OverviewResponse,
    response_model_by_alias=True,
)
def get_overview_report(
    day: Optional[date] = Query(
        None,
        alias="date",
        description="The day, in the report timezone. Defaults to today.",
    ),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    from_date: Optional[date] = Query(
        None, alias="from", description="Start day of a range (instead of `date`); `to` defaults to today."
    ),
    to_date: Optional[date] = Query(
        None, alias="to", description="End day of a range (inclusive); `from` defaults to it."
    ),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The manager overview (לוח מנהל): one day's takings as company › shop › area › till —
    or a range's (`from`–`to`, up to the reports' 366 days), from the same grouped queries:
    the comparisons' breakdown of a week or a month under the scope.

    Dashboard-only (Clerk/user JWT). Lists every shop and active till the caller can
    see — with zeros where nothing was sold — and the day's money for each, the
    per-cashier report's figures exactly, from a fixed number of grouped queries.

    Sales only: whether a till is online, its open shift and its alerts are the
    machines list's (`GET /machines`); the dashboard joins the two on the till's id.
    """
    # The cockpit's day is the business day ("שעת סיום יום עסקי") unless asked otherwise.
    basis = dict(day_basis=basis_of(day_basis), scope=scope_of(company_id=company_id, shop_id=shop_id, machine_id=machine_id))
    # A handler called directly sees the `Query(...)` defaults themselves: no range.
    if isinstance(from_date, date) or isinstance(to_date, date):
        window = _day_range(db, active_tenant_id, from_date, to_date, tz, **basis)
    else:
        if not isinstance(day, date):
            # "Today" is the report timezone's (business) today, not the server's.
            day = resolve_report_window(db, active_tenant_id, from_date=None, to_date=None, tz=tz, **basis).to_date
        window = resolve_report_window(db, active_tenant_id, from_date=day, to_date=day, tz=tz, **basis)
    return build_overview(
        db, current_user, active_tenant_id, window,
        company_id=company_id, shop_id=shop_id, machine_id=machine_id,
    )


@router.get(
    "/live-items",
    response_model=LiveItemsResponse,
    response_model_by_alias=True,
)
def get_live_items_report(
    day: Optional[date] = Query(
        None, alias="date", description="One day, in the report timezone. Defaults to today."
    ),
    from_date: Optional[date] = Query(None, alias="from", description="Start day of a custom range."),
    to_date: Optional[date] = Query(None, alias="to", description="End day of a custom range."),
    shift: Optional[str] = Query(
        None,
        description="`open`: the documents of the shifts open now in the scope, from whenever "
        "each began, instead of a day.",
    ),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    limit: int = Query(LIVE_ITEMS_DEFAULT, ge=1, le=LIVE_ITEMS_MAX),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Live sales by item (מכירות לפי פריט — חי): per product, qty, gross, net and its
    share of the scope's net, best earner first. Dashboard-only (Clerk/user JWT).

    The product sales report's figures over the same documents, from one grouped query,
    scoped like every report; `companyId` / `shopId` / `areaId` / `machineId` only
    narrow. The period is `date` (default today), or `from`–`to`, or `shift=open`.
    """
    basis = dict(
        day_basis=basis_of(day_basis),
        scope=scope_of(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id),
    )
    if isinstance(shift, str) and shift.strip().lower() == "open":
        period = PERIOD_SHIFT
        window = resolve_report_window(db, active_tenant_id, from_date=None, to_date=None, tz=tz, **basis)
        window = resolve_report_window(
            db, active_tenant_id, from_date=window.to_date, to_date=window.to_date, tz=tz, **basis
        )
    elif isinstance(from_date, date) or isinstance(to_date, date):
        period = PERIOD_RANGE
        window = resolve_report_window(
            db, active_tenant_id,
            from_date=from_date if isinstance(from_date, date) else None,
            to_date=to_date if isinstance(to_date, date) else None,
            tz=tz, **basis,
        )
    else:
        period = PERIOD_DAY
        if not isinstance(day, date):
            day = resolve_report_window(
                db, active_tenant_id, from_date=None, to_date=None, tz=tz, **basis
            ).to_date
        window = resolve_report_window(db, active_tenant_id, from_date=day, to_date=day, tz=tz, **basis)
    return build_live_items(
        db, current_user, active_tenant_id, window,
        period=period, company_id=company_id, shop_id=shop_id, machine_id=machine_id,
        area_filter=parse_area_filter(area_id), limit=limit if isinstance(limit, int) else LIVE_ITEMS_DEFAULT,
    )



def _day_range(db, tenant_id, from_date, to_date, tz, day_basis=None, scope=None):
    """`from`–`to` as a window: `to` defaults to today, `from` to `to` (one day)."""
    basis = dict(day_basis=day_basis, scope=scope)
    end = to_date if isinstance(to_date, date) else None
    if end is None:
        end = resolve_report_window(db, tenant_id, from_date=None, to_date=None, tz=tz, **basis).to_date
    start = from_date if isinstance(from_date, date) else end
    return resolve_report_window(db, tenant_id, from_date=start, to_date=end, tz=tz, **basis)


def _periods(
    db, user, tenant_id, from_date, to_date, cmp_from, cmp_to, event_id, cmp_event_id, tz,
    day_basis=None, scope=None,
):
    """
    The two periods of a comparison: each days (`from`–`to`, `cmpFrom`–`cmpTo`) or an event
    (`eventId`, `cmpEventId`), which wins over days. No compared period: None.
    """
    has_from, has_to = isinstance(cmp_from, date), isinstance(cmp_to, date)
    if has_from != has_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cmpFrom and cmpTo must be supplied together",
        )
    if isinstance(event_id, uuid.UUID):
        current = Period.of_event(load_event_lens(db, user, tenant_id, event_id))
    else:
        current = Period(_day_range(db, tenant_id, from_date, to_date, tz, day_basis, scope))
    previous = None
    if isinstance(cmp_event_id, uuid.UUID):
        previous = Period.of_event(load_event_lens(db, user, tenant_id, cmp_event_id))
    elif has_from:
        previous = Period(resolve_report_window(
            db, tenant_id, from_date=cmp_from, to_date=cmp_to, tz=tz, day_basis=day_basis, scope=scope,
        ))
    return current, previous


_GRANULARITY_DESC = (
    "`hour` (by the hour of day) or `day` (by the n-th day of each period). Default: by the "
    "hour when every period is one day, else by the day."
)


@router.get(
    "/compare",
    response_model=PeriodCompareResponse,
    response_model_by_alias=True,
)
def get_period_compare_report(
    from_date: Optional[date] = Query(None, alias="from", description="Start day of the period. Defaults to `to`."),
    to_date: Optional[date] = Query(None, alias="to", description="End day of the period (inclusive). Defaults to today."),
    cmp_from: Optional[date] = Query(None, alias="cmpFrom", description="Start day of the period compared with."),
    cmp_to: Optional[date] = Query(None, alias="cmpTo", description="End day of the period compared with (inclusive)."),
    granularity: Optional[str] = Query(None, pattern="^(hour|day)$", description=_GRANULARITY_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    event_id: Optional[uuid.UUID] = Query(
        None, alias="eventId", description="The period is this event (its window and tills) instead of from–to."
    ),
    cmp_event_id: Optional[uuid.UUID] = Query(
        None, alias="cmpEventId", description="Compare with this event instead of cmpFrom–cmpTo."
    ),
    items: int = Query(0, ge=0, le=ITEMS_MAX, description="The best sellers to return (0: none)."),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    השוואות: a period (a day, a week, a month, any range, an event) against another, in one
    request.

    Dashboard-only (Clerk/user JWT), scoped like every report; `companyId` / `shopId` /
    `areaId` / `machineId` only narrow. Both periods' headline figures (the overview's
    definitions), each figure's change as a number and a percent (`pct` null from zero —
    "new" — never a division by zero), and the two curves aligned: by the hour for days,
    by the n-th day for longer periods. Without `cmpFrom`/`cmpTo` there is no comparison.

    An event (`eventId`, `cmpEventId` — "אירוע", docs/SPEC_EVENTS.md) is its exact window and
    its tills, read only when the caller may open the event; two events are aligned by the
    hours since each began.
    """
    current, previous = _periods(
        db, current_user, active_tenant_id, from_date, to_date, cmp_from, cmp_to, event_id, cmp_event_id, tz,
        basis_of(day_basis), scope_of(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id),
    )
    return build_period_compare(
        db, current_user, active_tenant_id, current, previous,
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        shop_id=shop_id if isinstance(shop_id, uuid.UUID) else None,
        area_filter=parse_area_filter(area_id),
        machine_id=machine_id if isinstance(machine_id, uuid.UUID) else None,
        granularity=granularity if isinstance(granularity, str) else None,
        items=items if isinstance(items, int) else 0,
    )


@router.get(
    "/side-by-side",
    response_model=SideBySideResponse,
    response_model_by_alias=True,
)
def get_side_by_side_report(
    kind: str = Query(..., pattern="^(shop|area|machine|cashier)$", description="What is compared."),
    ids: List[str] = Query(..., description="2–4 ids (repeatable): shops, areas, tills or cashiers."),
    from_date: Optional[date] = Query(None, alias="from", description="Start day of the period. Defaults to `to`."),
    to_date: Optional[date] = Query(None, alias="to", description="End day of the period (inclusive). Defaults to today."),
    granularity: Optional[str] = Query(None, pattern="^(hour|day)$", description=_GRANULARITY_DESC),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    event_id: Optional[uuid.UUID] = Query(
        None, alias="eventId", description="Over this event (its window and tills) instead of from–to."
    ),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId", description="Within this shop (the board's scope)."),
    area_id: Optional[str] = Query(None, alias="areaId", description=_AREA_DESC),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId", description="Within this till."),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    זה מול זה: up to four shops, points of sale, tills or cashiers over one period — each
    one's sales, documents, average ticket, items, tender split and curve.

    Dashboard-only (Clerk/user JWT). A shop, area or till the caller cannot see is left
    out (not listed with someone else's figures); a cashier is named only from documents
    the caller's scope reads. Three grouped queries whatever is compared. `shopId` / `areaId` /
    `machineId` narrow it to the board's scope: cashiers compared on shop A count shop A's
    sales only.
    """
    current, _ = _periods(
        db, current_user, active_tenant_id, from_date, to_date, None, None, event_id, None, tz,
        basis_of(day_basis), scope_of(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id),
    )
    return build_side_by_side(
        db, current_user, active_tenant_id, current,
        kind=kind,
        ids=ids if isinstance(ids, list) else [],
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        shop_id=shop_id if isinstance(shop_id, uuid.UUID) else None,
        area_filter=parse_area_filter(area_id),
        machine_id=machine_id if isinstance(machine_id, uuid.UUID) else None,
        granularity=granularity if isinstance(granularity, str) else None,
    )



@router.get(
    "/prepaid-vouchers",
    response_model=VoucherBoardResponse,
    response_model_by_alias=True,
)
def get_voucher_board_report(
    from_date: Optional[date] = Query(None, alias="from", description="Start day of the period. Defaults to `to`."),
    to_date: Optional[date] = Query(None, alias="to", description="End day of the period (inclusive). Defaults to today."),
    cmp_from: Optional[date] = Query(None, alias="cmpFrom", description="Start day of the period compared with."),
    cmp_to: Optional[date] = Query(None, alias="cmpTo", description="End day of the period compared with (inclusive)."),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(
        None, alias="areaId", description="An area's id, or `none`: the tills standing in it now."
    ),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    event_id: Optional[uuid.UUID] = Query(
        None, alias="eventId", description="The period is this event (its window and tills)."
    ),
    cmp_event_id: Optional[uuid.UUID] = Query(None, alias="cmpEventId", description="Compare with this event."),
    day_basis: Optional[str] = Query(None, alias="dayBasis", description=BASIS_QUERY_DESCRIPTION),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    שוברים: the prepaid vouchers redeemed in the scope over a period, by voucher name —
    vouchers used, redemptions, units and value — against a compared period.

    Dashboard-only (Clerk/user JWT), scoped by role like the overview; a reversed redemption
    counts nowhere. Open to a user with "דוחות" or "שוברי הפקה" (app/services/dashboard_sections.py).
    An event (`eventId`, `cmpEventId`) is its exact window and its tills.
    """
    current, previous = _periods(
        db, current_user, active_tenant_id, from_date, to_date, cmp_from, cmp_to, event_id, cmp_event_id, tz,
        basis_of(day_basis), scope_of(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id),
    )
    return build_voucher_board(
        db, current_user, active_tenant_id, current, previous,
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        shop_id=shop_id if isinstance(shop_id, uuid.UUID) else None,
        area_filter=parse_area_filter(area_id),
        machine_id=machine_id if isinstance(machine_id, uuid.UUID) else None,
    )



@router.get(
    "/event-options",
    response_model=EventOptionsResponse,
    response_model_by_alias=True,
)
def get_event_options(
    q: Optional[str] = Query(None, max_length=120, description="Part of the event's name."),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    ids: Optional[List[uuid.UUID]] = Query(
        None, description="Exactly these events (repeatable): a link to one older than the newest listed."
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The control board's "אירוע" filter: the events of the shops the caller sees, newest
    first, each with its window and tills — three queries, never one per event.
    """
    return EventOptionsResponse(
        events=list_event_options(
            db, current_user, active_tenant_id,
            q=q if isinstance(q, str) else None,
            shop_id=shop_id if isinstance(shop_id, uuid.UUID) else None,
            ids=[i for i in ids if isinstance(i, uuid.UUID)] if isinstance(ids, list) else [],
        )
    )


@router.get("/business-day")
def get_business_day(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    tz: Optional[str] = Query(None, description=_TZ_DESC),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שעת סיום יום עסקי" of a scope (app/services/business_day.py) and the business day it is now:
    `{endHour, today, timezone}`. The dashboard's management reports open on this "today" — at
    01:00 it is still yesterday's business day. The most specific level named wins; none — the
    parameter's default (04:00 unless a super admin changed it). Management only.
    """
    from app.services import business_day as BD
    from app.services.reports import resolve_report_timezone

    tz_name = resolve_report_timezone(db, active_tenant_id, tz if isinstance(tz, str) else None)
    hour = BD.end_hour_for(db, **BD.scope_of(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id))
    return {"endHour": hour, "today": BD.today(tz_name, hour).isoformat(), "timezone": tz_name}
