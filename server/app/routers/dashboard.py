"""Dashboard KPI endpoints (Clerk-user JWT)."""
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.dashboard import DashboardBreakdownResponse, DashboardStatsResponse
from app.services.dashboard_stats import compute_breakdown, compute_sales_summary
from app.services.scoping import scope_transactions_by_user

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _resolve_window(
    from_dt: Optional[datetime],
    to_dt: Optional[datetime],
) -> Tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    if to_dt is None:
        to_dt = now
    if from_dt is None:
        from_dt = to_dt - timedelta(hours=24)
    if from_dt.tzinfo is None:
        from_dt = from_dt.replace(tzinfo=timezone.utc)
    if to_dt.tzinfo is None:
        to_dt = to_dt.replace(tzinfo=timezone.utc)
    return from_dt, to_dt


def _scoped_company_query(
    db: Session,
    current_user: User,
    active_tenant_id,
    company_id: Optional[uuid.UUID],
):
    query = db.query(Transaction).filter(Transaction.tenant_id == active_tenant_id)
    query = scope_transactions_by_user(query, current_user, db)
    if query is not None and company_id:
        shop_ids = db.query(Shop.id).filter(Shop.company_id == company_id)
        query = query.filter(Transaction.shop_id.in_(shop_ids))
    return query


@router.get(
    "/stats",
    response_model=DashboardStatsResponse,
    response_model_by_alias=True,
)
def get_dashboard_stats(
    from_dt: Optional[datetime] = Query(None, alias="from"),
    to_dt: Optional[datetime] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from_dt, to_dt = _resolve_window(from_dt, to_dt)
    query = _scoped_company_query(db, current_user, active_tenant_id, company_id)

    if query is not None:
        if shop_id:
            query = query.filter(Transaction.shop_id == shop_id)
        if machine_id:
            query = query.filter(Transaction.machine_id == machine_id)

    return compute_sales_summary(db, query, from_dt, to_dt)


@router.get(
    "/breakdown",
    response_model=DashboardBreakdownResponse,
    response_model_by_alias=True,
)
def get_dashboard_breakdown(
    from_dt: Optional[datetime] = Query(None, alias="from"),
    to_dt: Optional[datetime] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from_dt, to_dt = _resolve_window(from_dt, to_dt)
    group_by = "shop" if company_id else "company"
    query = _scoped_company_query(db, current_user, active_tenant_id, company_id)
    rows = compute_breakdown(db, query, from_dt, to_dt, group_by)
    return DashboardBreakdownResponse(group_by=group_by, rows=rows, from_=from_dt, to=to_dt)
