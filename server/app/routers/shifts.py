"""Dashboard reads of shifts and their X (docs/SHIFTS_API.md §2.1–§2.2)."""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.shift import Shift, ShiftStatus
from app.models.user import User
from app.models.z_report import ZReport
from app.schemas.shift import ShiftListResponse, ShiftOut
from app.services.areas import filter_on_column, parse_area_filter
from app.services.scoping import scope_query_by_user
from app.services.shift_totals import compute_totals
from app.services.shifts import register_number_of, shift_to_out
from app.services.offline_authorizations import declined_by_shift, offline_block
from app.services.transmissions import period_block

router = APIRouter(prefix="/shifts", tags=["shifts"])


def _scoped(db: Session, user: User, tenant_id):
    query = (
        db.query(Shift)
        .options(
            joinedload(Shift.machine),
            joinedload(Shift.shop),
            joinedload(Shift.z_report),
            joinedload(Shift.area),
        )
        .filter(Shift.tenant_id == tenant_id)
    )
    return scope_query_by_user(
        query, user, db, shop_column=Shift.shop_id, machine_column=Shift.machine_id
    )


def _out(shift: Shift, **kw) -> ShiftOut:
    return shift_to_out(
        shift,
        z_number=shift.z_report.z_number if shift.z_report is not None else None,
        machine_name=shift.machine.name if shift.machine is not None else None,
        shop_name=shift.shop.name if shift.shop is not None else None,
        pos_number=register_number_of(shift),
        **kw,
    )


@router.get("", response_model=ShiftListResponse, response_model_by_alias=True)
def list_shifts(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    status_: Optional[str] = Query(None, alias="status", pattern="^(open|closed)$"),
    awaiting_z: Optional[bool] = Query(None, alias="awaitingZ"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    area_id: Optional[str] = Query(
        None, alias="areaId", description="An area's id, or `none`. The shift's stamped area."
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Shifts (X reports), newest first. `awaitingZ=true`: closed and in no Z yet.

    `areaId` filters on the area the shift was stamped with when it was created, never
    on its till's area now.
    """
    area_filter = parse_area_filter(area_id)
    query = _scoped(db, current_user, active_tenant_id)
    if query is None:
        return ShiftListResponse(page=page, page_size=page_size, total=0, items=[])
    if shop_id:
        query = query.filter(Shift.shop_id == shop_id)
    if machine_id:
        query = query.filter(Shift.machine_id == machine_id)
    if status_:
        query = query.filter(Shift.status == ShiftStatus(status_))
    if awaiting_z is True:
        query = query.filter(Shift.status == ShiftStatus.CLOSED, Shift.z_report_id.is_(None))
    elif awaiting_z is False:
        query = query.filter(Shift.z_report_id.isnot(None))
    if from_date:
        query = query.filter(Shift.business_date >= from_date)
    if to_date:
        query = query.filter(Shift.business_date <= to_date)
    query = filter_on_column(query, Shift.area_id, area_filter)

    total = query.count()
    rows = (
        query.order_by(Shift.business_date.desc(), Shift.opened_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [_out(s) for s in rows]
    # One query for the page: the card legs of each shift an offline run declined.
    declined = declined_by_shift(db, [s.id for s in rows])
    for item in items:
        item.offline_declined_count, item.offline_declined_amount = declined.get(
            item.id, (0, Decimal("0.00"))
        )
    return ShiftListResponse(page=page, page_size=page_size, total=total, items=items)


@router.get("/{shift_id}", response_model=ShiftOut, response_model_by_alias=True)
def get_shift(
    shift_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One shift's X, with the tender breakdown recomputed from its documents."""
    query = _scoped(db, current_user, active_tenant_id)
    shift = query.filter(Shift.id == shift_id).first() if query is not None else None
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")
    out = _out(shift, payment_breakdown=compute_totals(db, [shift.id]).breakdown_json())
    if shift.machine is not None:
        # Informational only: the shift's card sales and the batches that carried them.
        out.transmission = period_block(db, shift.machine, [shift])
        out.offline = offline_block(db, shift.machine, [shift])
        out.offline_declined_count = out.offline["declinedCount"]
        out.offline_declined_amount = Decimal(out.offline["declinedAmount"])
    return out
