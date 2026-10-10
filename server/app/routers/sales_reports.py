"""
The reports of docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3. Dashboard-only (Clerk/user JWT),
scoped like every other report (`app/routers/reports.py`): the caller's role decides what
it sees, and asking for a shop outside it returns an empty report, not someone else's.

Mounted under `/reports` beside that router; every path here is one segment, so none
collides with `/reports/{machine_id}/shop-transactions`.
"""
from datetime import date
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.schemas.extra_reports import (
    CardBrandsReportResponse,
    CashVarianceResponse,
    DepartmentReportResponse,
    DocumentSequenceResponse,
    HourlyReportResponse,
    PaymentMethodsReportResponse,
)
from app.services import extra_reports as svc
from app.services.areas import parse_area_filter
from app.services.reports import resolve_report_window

router = APIRouter(prefix="/reports", tags=["reports"])

_FROM = "Start day (inclusive), in the report timezone. Defaults to 30 days back."
_TO = "End day (inclusive), in the report timezone. Defaults to today."


def _window(db, tenant_id, from_date, to_date, from_hour, to_hour, tz):
    return resolve_report_window(
        db, tenant_id, from_date=from_date, to_date=to_date, from_hour=from_hour, to_hour=to_hour, tz=tz
    )


@router.get("/payment-methods", response_model=PaymentMethodsReportResponse, response_model_by_alias=True)
def get_payment_methods_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Net takings per tender method, per local day, shop and till (מכירות לפי אמצעי תשלום)."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return svc.build_payment_methods_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )


@router.get("/card-brands", response_model=CardBrandsReportResponse, response_model_by_alias=True)
def get_card_brands_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Card legs per brand (מותג) and acquirer (חברת סליקה), refunds apart (דוח סליקה)."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return svc.build_card_brands_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )


@router.get("/hourly", response_model=HourlyReportResponse, response_model_by_alias=True)
def get_hourly_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Narrow to this company and its subsidiaries."
    ),
    area_id: Optional[str] = Query(
        None,
        alias="areaId",
        description="An area's id, or `none`: the area each document's shift was stamped with.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Net per weekday × hour (מכירות לפי שעה), for a heat map and shift planning."""
    window = _window(db, active_tenant_id, from_date, to_date, None, None, tz)
    return svc.build_hourly_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id,
        # A handler called directly sees the `Query(...)` defaults themselves: no filter.
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        area_filter=parse_area_filter(area_id),
    )


@router.get("/departments", response_model=DepartmentReportResponse, response_model_by_alias=True)
def get_department_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    cashier_id: Optional[str] = Query(None, alias="cashierId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Units and money per product category, with each one's share of the net (מכירות לפי מחלקה)."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return svc.build_department_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )


@router.get("/document-sequence", response_model=DocumentSequenceResponse, response_model_by_alias=True)
def get_document_sequence_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Gaps and duplicates in each till's document numbers, per document type (רצף מסמכים)."""
    window = _window(db, active_tenant_id, from_date, to_date, None, None, tz)
    return svc.build_document_sequence_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )


@router.get("/cash-variance", response_model=CashVarianceResponse, response_model_by_alias=True)
def get_cash_variance_report(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Expected vs counted cash per closed shift, and per cashier (הפרשי קופה)."""
    window = _window(db, active_tenant_id, from_date, to_date, None, None, tz)
    return svc.build_cash_variance_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )
