"""Dashboard read endpoints for Z-reports (Clerk-user JWT)."""
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.user import User
from app.models.z_report import ZReport
from app.schemas.z_report import ZReportListResponse, ZReportOut
from app.services.scoping import scope_query_by_user


router = APIRouter(prefix="/z-reports", tags=["z-reports"])


def _scope_by_user(query, current_user: User, db: Session):
    """Role scoping for Z-reports.

    This was a verbatim copy of `scope_transactions_by_user`. It now delegates to the
    shared implementation, so the company-manager rule (which follows the company tree)
    cannot be right in one endpoint and stale in the other.
    """
    return scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=ZReport.shop_id,
        machine_column=ZReport.machine_id,
    )


@router.get("", response_model=ZReportListResponse, response_model_by_alias=True)
def list_z_reports(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    closed_from: Optional[datetime] = Query(None, alias="closedFrom"),
    closed_to: Optional[datetime] = Query(None, alias="closedTo"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Z-report history over a range. Dashboard-only (Clerk/user JWT).

    `from`/`to` filter on `day_date` — the trading day the till itself filed the
    close under, which is the right key for "show me the Z reports for last week"
    and is deliberately not derived from a timestamp.

    `closedFrom`/`closedTo` are optional ISO datetimes on `closed_at` and are how an
    hour-precision question gets asked here ("which tills closed after 23:00 last
    night"). A Z report covers a whole trading day, so an hour-of-day *filter* on
    the report itself would be meaningless; the hour that carries information is
    when it was closed.
    """
    query = (
        db.query(ZReport)
        .options(joinedload(ZReport.machine), joinedload(ZReport.shop))
        .filter(ZReport.tenant_id == active_tenant_id)
    )
    query = _scope_by_user(query, current_user, db)
    if query is None:
        return ZReportListResponse(page=page, page_size=page_size, total=0, items=[])

    if machine_id:
        query = query.filter(ZReport.machine_id == machine_id)
    if machine_ids:
        query = query.filter(ZReport.machine_id.in_(machine_ids))
    if shop_id:
        query = query.filter(ZReport.shop_id == shop_id)

    if from_date is None and to_date is None and closed_from is None and closed_to is None:
        from_date = (datetime.now(timezone.utc) - timedelta(days=90)).date()

    if from_date is not None:
        query = query.filter(ZReport.day_date >= from_date)
    if to_date is not None:
        query = query.filter(ZReport.day_date <= to_date)

    # A naive datetime from a caller is read as UTC, matching /dashboard/stats.
    if closed_from is not None:
        if closed_from.tzinfo is None:
            closed_from = closed_from.replace(tzinfo=timezone.utc)
        query = query.filter(ZReport.closed_at >= closed_from)
    if closed_to is not None:
        if closed_to.tzinfo is None:
            closed_to = closed_to.replace(tzinfo=timezone.utc)
        query = query.filter(ZReport.closed_at <= closed_to)

    total = query.count()
    rows = (
        query.order_by(ZReport.day_date.desc(), ZReport.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = []
    for r in rows:
        item = ZReportOut.model_validate(r)
        item.machine_name = r.machine.name if r.machine else None
        item.shop_name = r.shop.name if r.shop else None
        items.append(item)

    return ZReportListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=items,
    )


@router.get("/{z_report_id}", response_model=ZReportOut)
def get_z_report(
    z_report_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(ZReport).filter(ZReport.id == z_report_id, ZReport.tenant_id == active_tenant_id)
    query = _scope_by_user(query, current_user, db)
    if query is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    z = query.first()
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    return z
