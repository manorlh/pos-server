"""Dashboard read endpoints for Z reports (Clerk-user JWT). Contract: docs/SHIFTS_API.md §2.8."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Literal, Optional
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
from app.models.z_report import ZOrigin, ZReport
from app.schemas.z_report import (
    ZReportBusinessOut,
    ZReportDetailOut,
    ZReportListResponse,
    ZReportOut,
    ZReportWindow,
)
from app.services.areas import filter_on_column, parse_area_filter
from app.services import card_brands, offline_authorizations, z_print
from app.services.shift_totals import compute_totals
from app.services.z_waiters import waiter_breakdown
from app.services.reports import _load_zoneinfo, resolve_report_timezone
from app.services.scoping import scope_query_by_user
from app.services.shifts import shift_to_out


router = APIRouter(prefix="/z-reports", tags=["z-reports"])

#: With no range at all, a Z list covers the last 90 days of business dates.
DEFAULT_WINDOW_DAYS = 90


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


def _between_shift_adjustments(sections) -> Optional[Decimal]:
    """
    The Z's cash moved between shifts: the sum of its sections' own, as stored.

    None when there are no sections (a legacy Z) or any section predates the figure — a
    Z keeps the numbers it was built with, and a partial sum would be a new one.
    """
    if not sections:
        return None
    values = [section.get("betweenShiftAdjustments") for section in sections]
    if any(v is None for v in values):
        return None
    return sum((Decimal(str(v)) for v in values), Decimal("0"))


def _local_midnight_utc(day: date, tzinfo) -> datetime:
    """The instant `day` starts in `tzinfo`, in UTC."""
    return datetime.combine(day, datetime.min.time(), tzinfo=tzinfo).astimezone(timezone.utc)


def z_to_out(z: ZReport, cls=ZReportOut, tzinfo=None):
    item = ZReportOut.model_validate(z)
    if cls is not ZReportOut:
        # Not validated from the row directly: its `shifts` relationship would be read
        # into the detail's `shifts` field as ORM rows. The caller fills that in.
        item = cls(**item.model_dump())
    # A till Z has a machine too, but also its section: legacy is the shape, not the till.
    item.legacy = z.per_machine is None and z.machine_id is not None
    item.origin = z.origin or ZOrigin.CLOUD
    if z.is_till_z and z.per_machine:
        item.pos_number = z.per_machine[0].get("posNumber")
    if z.total_sales is not None:
        item.net_sales = Decimal(z.total_sales) - Decimal(z.total_refunds or 0)
        if z.discounts_total is not None:
            item.gross_sales = Decimal(z.total_sales) + Decimal(z.discounts_total)
    item.between_shift_adjustments = _between_shift_adjustments(z.per_machine)
    offline = offline_authorizations.z_totals(z.per_machine)
    if offline is not None:
        item.offline_authorization_count = offline["authorization_count"]
        item.offline_approved_count = offline["approved_count"]
        item.offline_declined_count = offline["declined_count"]
        item.offline_declined_amount = offline["declined_amount"]
    item.machine_name = z.machine.name if z.machine_id and z.machine else None
    item.shop_name = z.shop.name if z.shop else None
    item.shop_number = z.shop.shop_number if z.shop else None
    # The frozen name, never the area's name today: a Z keeps what it was filed as.
    item.area_name = (z.header or {}).get("areaName") if z.area_id is not None else None
    if tzinfo is not None and z.closed_at is not None:
        closed = z.closed_at if z.closed_at.tzinfo else z.closed_at.replace(tzinfo=timezone.utc)
        item.production_date = closed.astimezone(tzinfo).date()
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
    area_id: Optional[str] = Query(
        None, alias="areaId", description="The area a Z was started for, or `none`."
    ),
    date_basis: Literal["business", "production"] = Query(
        "business",
        alias="dateBasis",
        description="What `from`/`to` and the order are on: the business date, or the "
        "local date the Z was produced (`closedAt`).",
    ),
    tz: Optional[str] = Query(
        None,
        description="IANA timezone production dates are measured in. Defaults to the "
        "tenant's configured timezone, else Asia/Jerusalem.",
    ),
    origin: Optional[str] = Query(
        None, pattern="^(cloud|till)$", description="`till`: the tills' own Zs (§5); `cloud`: Z runs'."
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Z report history over a range. Dashboard-only (Clerk/user JWT).

    `from`/`to` filter on the Z's `business_date`, or with `dateBasis=production` on the
    local date of its `closed_at` (when it was produced) in the tenant's timezone — a Z
    produced at 00:30 belongs to that new day. The order follows the same date. Every row
    carries both (`businessDate`, `productionDate`). `closedFrom`/`closedTo` are ISO
    datetimes on `closed_at`. `machineId`/`machineIds` match a Z containing that till
    (a shift of it, or a legacy till-issued Z). `areaId` matches the area a Z was run
    for; `none` is every whole-shop, hand-picked or legacy Z. `origin` keeps the tills'
    own Zs (`till`, docs/SHIFTS_API.md §5) or the Z runs' (`cloud`); a till Z is listed
    among its shop's, ordered by when it closed within its business date.
    """
    area_filter = parse_area_filter(area_id)
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
    query = filter_on_column(query, ZReport.area_id, area_filter)
    if isinstance(origin, str):  # (a direct call leaves the Query default in place)
        query = query.filter(ZReport.origin == origin)

    # A direct call (the tests) leaves the Query defaults in place: read them as unset.
    if not isinstance(date_basis, str):
        date_basis = "business"
    tz_name = resolve_report_timezone(db, active_tenant_id, tz if isinstance(tz, str) else None)
    tzinfo = _load_zoneinfo(tz_name)
    production = date_basis == "production"

    defaulted = from_date is None and to_date is None and closed_from is None and closed_to is None
    if defaulted:
        now = datetime.now(timezone.utc)
        from_date = ((now.astimezone(tzinfo) if production else now) - timedelta(days=DEFAULT_WINDOW_DAYS)).date()
    window = ZReportWindow(
        from_date=from_date,
        to_date=to_date,
        defaulted=defaulted,
        date_basis=date_basis,
        timezone=tz_name,
    )

    if production:
        # Local days as absolute bounds, so the filter stays on the indexed instant.
        if from_date is not None:
            query = query.filter(ZReport.closed_at >= _local_midnight_utc(from_date, tzinfo))
        if to_date is not None:
            query = query.filter(
                ZReport.closed_at < _local_midnight_utc(to_date + timedelta(days=1), tzinfo)
            )
    else:
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
    order = (
        (ZReport.closed_at.desc(), ZReport.created_at.desc())
        if production
        else (ZReport.business_date.desc(), ZReport.created_at.desc())
    )
    rows = (
        query.order_by(*order)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return ZReportListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=[z_to_out(r, tzinfo=tzinfo) for r in rows],
        window=window,
    )


# ── Print documents (the till's 80 mm Z) ──────────────────────────────────────

#: Zs one print request may carry — a sequence, or a range, for one sitting at a printer.
PRINT_DOCUMENTS_MAX = 200


def _print_order(query):
    """Z-number order: a sequence prints as the shop's counter runs."""
    return query.order_by(
        ZReport.shop_sequence_number.is_(None),
        ZReport.shop_sequence_number.asc(),
        ZReport.business_date.asc(),
        ZReport.closed_at.asc(),
    )


def _parse_ids(raw: str) -> List[uuid.UUID]:
    out: List[uuid.UUID] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = uuid.UUID(part)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid Z-report id '{part}'")
        if value not in out:
            out.append(value)
    return out


def _too_many(count: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"too_many_z_reports: {count} Z reports match; at most {PRINT_DOCUMENTS_MAX} print at once",
    )


@router.get("/print-documents")
def get_z_print_documents(
    ids: Optional[str] = Query(None, description="Comma-separated Z ids."),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_number: Optional[int] = Query(None, alias="fromNumber", ge=0),
    to_number: Optional[int] = Query(None, alias="toNumber", ge=0),
    date_basis: Literal["business", "production"] = Query("business", alias="dateBasis"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Several Zs as 80 mm print documents (`app/services/z_print.py`), in Z-number order,
    for printing a sequence: `ids=a,b,c`, or one shop's range — `shopId` with `from`/`to`
    (dates on `dateBasis`) and/or `fromNumber`/`toNumber` (its Z numbers). At most
    PRINT_DOCUMENTS_MAX; a larger request is refused (400) rather than cut short. Scoped
    like `GET /z-reports/{id}`: an id the caller may not see is a 404.
    """
    query = (
        db.query(ZReport)
        .options(joinedload(ZReport.machine), joinedload(ZReport.shop))
        .filter(ZReport.tenant_id == active_tenant_id)
    )
    wanted: List[uuid.UUID] = []
    if ids:
        wanted = _parse_ids(ids)
        if not wanted:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No Z-report ids")
        if len(wanted) > PRINT_DOCUMENTS_MAX:
            raise _too_many(len(wanted))
        query = query.filter(ZReport.id.in_(wanted))
    elif shop_id is not None:
        if from_date is None and to_date is None and from_number is None and to_number is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A range needs from/to dates or fromNumber/toNumber",
            )
        query = query.filter(ZReport.shop_id == shop_id)
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Pass ids, or shopId with a range")

    tzinfo = _load_zoneinfo(resolve_report_timezone(db, active_tenant_id, None))
    if not wanted:
        if date_basis == "production":
            if from_date is not None:
                query = query.filter(ZReport.closed_at >= _local_midnight_utc(from_date, tzinfo))
            if to_date is not None:
                query = query.filter(ZReport.closed_at < _local_midnight_utc(to_date + timedelta(days=1), tzinfo))
        else:
            if from_date is not None:
                query = query.filter(ZReport.business_date >= from_date)
            if to_date is not None:
                query = query.filter(ZReport.business_date <= to_date)
        if from_number is not None:
            query = query.filter(ZReport.shop_sequence_number >= from_number)
        if to_number is not None:
            query = query.filter(ZReport.shop_sequence_number <= to_number)

    query = _scope_by_user(query, current_user, db)
    if query is None:
        if wanted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
        return {"items": [], "total": 0}

    rows = _print_order(query).limit(PRINT_DOCUMENTS_MAX + 1).all()
    if wanted and len(rows) != len(wanted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    if len(rows) > PRINT_DOCUMENTS_MAX:
        raise _too_many(query.count())
    printed_at = datetime.now(timezone.utc)
    return {
        "items": [
            {
                "id": str(z.id),
                "number": z.z_number,
                "shopId": str(z.shop_id) if z.shop_id else None,
                "document": z_print.build_print_document(z, tzinfo, printed_at=printed_at),
            }
            for z in rows
        ],
        "total": len(rows),
    }


@router.get("/{z_report_id}/print-document")
def get_z_print_document(
    z_report_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One Z as the 80 mm print document the till prints (`app/services/z_print.py`)."""
    query = db.query(ZReport).filter(ZReport.id == z_report_id, ZReport.tenant_id == active_tenant_id)
    query = _scope_by_user(query, current_user, db)
    z = query.first() if query is not None else None
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    tzinfo = _load_zoneinfo(resolve_report_timezone(db, active_tenant_id, None))
    return z_print.build_print_document(z, tzinfo)


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
    return z_detail_out(db, z)


def z_detail_out(db: Session, z: ZReport) -> ZReportDetailOut:
    """
    The Z with its sections, shifts and frozen header — the dashboard's detail, and the
    body a till gets back for its own Z (docs/SHIFTS_API.md §5.2), so both print one thing.
    """
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
            z_number=z.z_number,
            machine_name=s.machine.name if s.machine else None,
        )
        for s in shifts
    ]
    out.business = _business_of(z)
    sections = [s for s in (z.per_machine or []) if isinstance(s, dict)]
    if any("cardBrands" in s for s in sections):
        out.card_brands = card_brands.merge_breakdowns(s.get("cardBrands") for s in sections)
        out.card_brands_source = "stored"
    elif z.per_machine is not None and shifts:
        out.card_brands = compute_totals(db, [s.id for s in shifts]).card_brands_json()
        out.card_brands_source = "documents"
    stored_waiters = (z.header or {}).get("byWaiter")
    if isinstance(stored_waiters, list):
        out.by_waiter = stored_waiters
        out.by_waiter_source = "stored"
    elif z.per_machine is not None and shifts:
        out.by_waiter = waiter_breakdown(db, [s.id for s in shifts], z.shop_id)
        out.by_waiter_source = "documents"
    out.till_totals = z.till_totals
    return out
