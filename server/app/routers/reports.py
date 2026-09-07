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

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.reports import (
    CashierSalesReportResponse,
    DaySummaryReportResponse,
    ProductSalesReportResponse,
    ShopTransactionsResponse,
    TipsRangeReportResponse,
)
from app.services.reports import (
    PRODUCT_ROWS_DEFAULT,
    PRODUCT_ROWS_MAX,
    SHOP_TRANSACTIONS_MAX_HOURS,
    build_cashier_sales_report,
    build_day_summary_report,
    build_product_sales_report,
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
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    limit: int = Query(PRODUCT_ROWS_DEFAULT, ge=1, le=PRODUCT_ROWS_MAX),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Units and revenue per product over the range. Dashboard-only (Clerk/user JWT).

    A credit note's lines reduce the product's `net` and `unitsNet`; they are never
    added to `gross`. Cancelled and pending documents are excluded.
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date,
        from_hour=from_hour, to_hour=to_hour, tz=tz,
    )
    return build_product_sales_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id, limit=limit,
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
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
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
    )
    return build_cashier_sales_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id,
    )


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
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
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
    )
    return build_tips_range_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id,
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

    Dashboard-only (Clerk/user JWT). Built from Z reports, so it agrees with the paper
    each till printed — and so a day nobody has closed yet is **absent rather than
    zero**, because an open day has not declared anything.

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
    would be meaningless. Days are selected on `day_date`, the day the till filed the
    close under — a shift that runs past midnight still belongs to the day it started.
    """
    window = resolve_report_window(
        db, active_tenant_id,
        from_date=from_date, to_date=to_date, tz=tz,
    )
    return build_day_summary_report(
        db, current_user, active_tenant_id, window,
        shop_ids=shop_ids, machine_ids=machine_ids,
    )
