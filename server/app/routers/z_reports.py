"""Dashboard read endpoints for Z reports (Clerk-user JWT). Contract: docs/SHIFTS_API.md §2.8."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.schemas.z_report import (
    ZReportBusinessOut,
    ZReportDetailOut,
    ZReportListResponse,
    ZReportOut,
)
from app.services.scoping import scope_query_by_user
from app.services.shifts import shift_to_out


router = APIRouter(prefix="/z-reports", tags=["z-reports"])


def _machine_z_ids(machine_ids):
    """Z ids containing a shift of any of `machine_ids`."""
    return select(Shift.z_report_id).where(
        Shift.machine_id.in_(machine_ids), Shift.z_report_id.isnot(None)
    )


def _scope_by_user(query, current_user: User, db: Session):
    """
    Role scoping for Z reports.

    Delegates to the shared rule for every role but the distributor, whose visibility is
    by machine. A cloud-built Z has no single machine (it spans the shop's tills), so a
    distributor sees a Z that contains a shift of one of their tills, or a legacy Z of one.
    """
    if current_user.role == UserRole.DISTRIBUTOR:
        mine = select(POSMachine.id).where(POSMachine.distributor_id == current_user.id)
        return query.filter(
            or_(ZReport.machine_id.in_(mine), ZReport.id.in_(_machine_z_ids(mine)))
        )
    return scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=ZReport.shop_id,
        machine_column=ZReport.machine_id,
    )


def z_to_out(z: ZReport, cls=ZReportOut):
    item = ZReportOut.model_validate(z)
    if cls is not ZReportOut:
        # Not validated from the row directly: its `shifts` relationship would be read
        # into the detail's `shifts` field as ORM rows. The caller fills that in.
        item = cls(**item.model_dump())
    item.legacy = z.per_machine is None and z.machine_id is not None
    if z.total_sales is not None:
        item.net_sales = Decimal(z.total_sales) - Decimal(z.total_refunds or 0)
        if z.discounts_total is not None:
            item.gross_sales = Decimal(z.total_sales) + Decimal(z.discounts_total)
    item.machine_name = z.machine.name if z.machine_id and z.machine else None
    item.shop_name = z.shop.name if z.shop else None
    return item


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
    Z report history over a range. Dashboard-only (Clerk/user JWT).

    `from`/`to` filter on the Z's `business_date`. `closedFrom`/`closedTo` are ISO
    datetimes on `closed_at`. `machineId`/`machineIds` match a Z containing that till
    (a shift of it, or a legacy till-issued Z).
    """
    query = (
        db.query(ZReport)
        .options(joinedload(ZReport.machine), joinedload(ZReport.shop))
        .filter(ZReport.tenant_id == active_tenant_id)
    )
    query = _scope_by_user(query, current_user, db)
    if query is None:
        return ZReportListResponse(page=page, page_size=page_size, total=0, items=[])

    wanted = list(machine_ids or [])
    if machine_id:
        wanted.append(machine_id)
    if wanted:
        query = query.filter(
            or_(ZReport.machine_id.in_(wanted), ZReport.id.in_(_machine_z_ids(wanted)))
        )
    if shop_id:
        query = query.filter(ZReport.shop_id == shop_id)

    if from_date is None and to_date is None and closed_from is None and closed_to is None:
        from_date = (datetime.now(timezone.utc) - timedelta(days=90)).date()

    if from_date is not None:
        query = query.filter(ZReport.business_date >= from_date)
    if to_date is not None:
        query = query.filter(ZReport.business_date <= to_date)

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
        query.order_by(ZReport.business_date.desc(), ZReport.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return ZReportListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=[z_to_out(r) for r in rows],
    )


def _with_derived_sales(section: dict) -> dict:
    """
    A per-till section with `grossSales` / `netSales`, derived for a Z built before they
    were stored — from its own stored figures, never recomputed from documents. Nothing
    else of a stored section is rewritten (its `posNumber` included).
    """
    out = dict(section)

    def dec(key):
        value = out.get(key)
        return None if value is None else Decimal(str(value))

    sales = dec("totalSales")
    if sales is not None:
        if "netSales" not in out:
            out["netSales"] = str((sales - (dec("totalRefunds") or Decimal("0"))).quantize(Decimal("0.01")))
        if "grossSales" not in out and out.get("discountsTotal") is not None:
            out["grossSales"] = str((sales + dec("discountsTotal")).quantize(Decimal("0.01")))
    return out


def _business_of(z: ZReport) -> Optional[ZReportBusinessOut]:
    """The header frozen on the Z at build time — never live settings."""
    if not z.header:
        return None
    return ZReportBusinessOut.model_validate(z.header)


@router.get("/{z_report_id}", response_model=ZReportDetailOut, response_model_by_alias=True)
def get_z_report(
    z_report_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One Z with its per-till sections, its shifts and the business header."""
    query = db.query(ZReport).filter(ZReport.id == z_report_id, ZReport.tenant_id == active_tenant_id)
    query = _scope_by_user(query, current_user, db)
    if query is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    z = query.first()
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")

    out = z_to_out(z, ZReportDetailOut)
    out.per_machine = [_with_derived_sales(section) for section in (z.per_machine or [])]
    shifts = (
        db.query(Shift)
        .options(joinedload(Shift.machine))
        .filter(Shift.z_report_id == z.id)
        .order_by(Shift.machine_id, Shift.sequence_number, Shift.opened_at)
        .all()
    )
    out.shifts = [
        shift_to_out(
            s,
            z_number=z.shop_sequence_number,
            machine_name=s.machine.name if s.machine else None,
        )
        for s in shifts
    ]
    out.business = _business_of(z)
    return out
