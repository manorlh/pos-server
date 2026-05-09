"""Dashboard read endpoints for Z-reports (Clerk-user JWT)."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.pos_machine import POSMachine
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.schemas.z_report import ZReportListResponse, ZReportOut


router = APIRouter(prefix="/z-reports", tags=["z-reports"])


def _scope_by_user(query, current_user: User):
    if current_user.role == UserRole.SUPER_ADMIN:
        return query
    if current_user.role == UserRole.DISTRIBUTOR:
        return query.join(POSMachine, POSMachine.id == ZReport.machine_id).filter(
            POSMachine.distributor_id == current_user.id
        )
    if current_user.role == UserRole.MERCHANT_ADMIN and current_user.merchant_id:
        return query.filter(ZReport.merchant_id == current_user.merchant_id)
    if current_user.role == UserRole.COMPANY_MANAGER and current_user.company_id:
        return query.join(POSMachine, POSMachine.id == ZReport.machine_id).filter(
            POSMachine.merchant_id == current_user.merchant_id
        )
    if current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and current_user.shop_id:
        return query.filter(ZReport.shop_id == current_user.shop_id)
    return None


@router.get("", response_model=ZReportListResponse)
def list_z_reports(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(ZReport).filter(ZReport.tenant_id == active_tenant_id)
    query = _scope_by_user(query, current_user)
    if query is None:
        return ZReportListResponse(page=page, page_size=page_size, total=0, items=[])

    if machine_id:
        query = query.filter(ZReport.machine_id == machine_id)
    if shop_id:
        query = query.filter(ZReport.shop_id == shop_id)

    if from_date is None and to_date is None:
        from_date = (datetime.now(timezone.utc) - timedelta(days=90)).date()

    if from_date is not None:
        query = query.filter(ZReport.day_date >= from_date)
    if to_date is not None:
        query = query.filter(ZReport.day_date <= to_date)

    total = query.count()
    rows = (
        query.order_by(ZReport.day_date.desc(), ZReport.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return ZReportListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=[ZReportOut.model_validate(r) for r in rows],
    )


@router.get("/{z_report_id}", response_model=ZReportOut)
def get_z_report(
    z_report_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(ZReport).filter(ZReport.id == z_report_id, ZReport.tenant_id == active_tenant_id)
    query = _scope_by_user(query, current_user)
    if query is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    z = query.first()
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    return z
