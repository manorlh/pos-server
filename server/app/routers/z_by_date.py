"""
Zs by date — the day's and the month's Zs with their totals (app/services/z_by_date.py).
Dashboard-only (Clerk/user JWT), scoped like `GET /z-reports`: the caller's role decides what it
sees. Presentation only: no figure, document, VAT or uniform-file output is changed by it.

GET /z-reports/by-date/summary → the Zs of a day or a range: lines, totals, by shop / area / kind / day
GET /z-reports/by-date/month   → the same over one month, with each Z's documents by document month

Both take the filters of `GET /z-reports` (shop, shops, till, area, Z types, origin) and
`dateBasis` — `production` (the default here: the local date the Z was produced, in the shop's
timezone) or `business` (the Z's business date).
"""
from __future__ import annotations

import calendar
import uuid
from datetime import date, datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.models.z_report import ZReport
from app.services import z_by_date, z_table
from app.services.areas import parse_area_filter
from app.services.reports import _load_zoneinfo, resolve_report_timezone

router = APIRouter(prefix="/z-reports/by-date", tags=["z-reports"])

#: "דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך" — on every month answer, for whoever reads it.
DOCUMENT_DATE_NOTE = "דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך"


def _ids(single, many) -> List[uuid.UUID]:
    out = [m for m in (many if isinstance(many, list) else []) if m is not None]
    if isinstance(single, uuid.UUID) and single not in out:
        out.append(single)
    return out


def _str(value) -> Optional[str]:
    """A query value as given; a direct call (the tests) leaves the `Query` default: unset."""
    return value if isinstance(value, str) else None


def _zs(
    db: Session, user: User, tenant_id, *, from_date: date, to_date: date, date_basis: str, tzinfo,
    shop_id, shop_ids, machine_id, machine_ids, area_id, z_types, origin,
    closed_from: Optional[datetime] = None, closed_to: Optional[datetime] = None,
) -> List[ZReport]:
    query = z_table.filtered_z_query(
        db, user, tenant_id,
        from_date=from_date, to_date=to_date, date_basis=date_basis, tzinfo=tzinfo,
        shop_ids=_ids(shop_id, shop_ids), machine_ids=_ids(machine_id, machine_ids),
        z_types=z_table.parse_z_types(z_types if isinstance(z_types, list) else None),
        origin=_str(origin),
        area_filter=parse_area_filter(_str(area_id)),
        closed_from=closed_from, closed_to=closed_to,
    )
    if query is None:
        return []
    total = query.count()
    if total > z_table.Z_TABLE_MAX:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"יותר מ-{z_table.Z_TABLE_MAX:,} דוחות Z ({total:,}) — צמצמו את טווח התאריכים או את הסינון",
        )
    order = (
        (ZReport.closed_at.desc(), ZReport.created_at.desc())
        if date_basis == "production"
        else (ZReport.business_date.desc(), ZReport.closed_at.desc(), ZReport.created_at.desc())
    )
    return query.order_by(*order).all()


@router.get("/summary")
def get_z_summary_by_date(
    from_date: Optional[date] = Query(None, alias="from", description="First day (inclusive). Defaults to today."),
    to_date: Optional[date] = Query(None, alias="to", description="Last day (inclusive). Defaults to `from`."),
    date_basis: Literal["production", "business"] = Query(
        "production", alias="dateBasis",
        description="`production`: the local date the Z was produced (`closedAt`); `business`: its business date.",
    ),
    tz: Optional[str] = Query(None, description="IANA zone; defaults to the tenant's, else Asia/Jerusalem."),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    area_id: Optional[str] = Query(None, alias="areaId", description="The area a Z was started for, or `none`."),
    z_types: Optional[List[str]] = Query(None, alias="zTypes"),
    origin: Optional[str] = Query(None, pattern="^(cloud|till)$"),
    closed_from: Optional[datetime] = Query(None, alias="closedFrom", description="As the list: an instant on `closedAt`."),
    closed_to: Optional[datetime] = Query(None, alias="closedTo"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "Zs produced on 1.10": every Z of the day (or range) the filters match — the count, the grand
    totals, the same by shop, area, kind and day, and one line per Z (newest first). With the
    list's `closedFrom`/`closedTo` too, so its CSV is exactly the list.
    """
    basis = _str(date_basis) or "production"
    tz_name = resolve_report_timezone(db, active_tenant_id, _str(tz))
    tzinfo = _load_zoneinfo(tz_name)
    from_date = from_date if isinstance(from_date, date) else None
    to_date = to_date if isinstance(to_date, date) else None
    if from_date is None and to_date is None:
        from_date = to_date = datetime.now(timezone.utc).astimezone(tzinfo).date()
    from_date = from_date or to_date
    to_date = to_date or from_date
    if to_date < from_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="`to` is before `from`")
    zs = _zs(
        db, current_user, active_tenant_id, from_date=from_date, to_date=to_date, date_basis=basis, tzinfo=tzinfo,
        shop_id=shop_id, shop_ids=shop_ids, machine_id=machine_id, machine_ids=machine_ids,
        area_id=area_id, z_types=z_types, origin=origin,
        closed_from=closed_from if isinstance(closed_from, datetime) else None,
        closed_to=closed_to if isinstance(closed_to, datetime) else None,
    )
    window = {"from": from_date.isoformat(), "to": to_date.isoformat(), "dateBasis": basis, "timezone": tz_name}
    return {"window": window, **z_by_date.build_summary(db, zs, tzinfo, date_basis=basis)}


@router.get("/month")
def get_z_month_by_date(
    month: str = Query(..., pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="YYYY-MM"),
    date_basis: Literal["production", "business"] = Query("production", alias="dateBasis"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    z_types: Optional[List[str]] = Query(None, alias="zTypes"),
    origin: Optional[str] = Query(None, pattern="^(cloud|till)$"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "Zs produced in October": the month's Zs and totals, as the summary, and on each Z its
    documents split by the month each is dated in (`documentMonths`) — with the note that VAT
    reporting and the uniform file go by the document's date, not the Z's.
    """
    basis = _str(date_basis) or "production"
    year, mon = (int(p) for p in month.split("-"))
    first = date(year, mon, 1)
    last = date(year, mon, calendar.monthrange(year, mon)[1])
    tz_name = resolve_report_timezone(db, active_tenant_id, _str(tz))
    tzinfo = _load_zoneinfo(tz_name)
    zs = _zs(
        db, current_user, active_tenant_id, from_date=first, to_date=last, date_basis=basis, tzinfo=tzinfo,
        shop_id=shop_id, shop_ids=shop_ids, machine_id=machine_id, machine_ids=machine_ids,
        area_id=area_id, z_types=z_types, origin=origin,
    )
    window = {
        "month": month, "from": first.isoformat(), "to": last.isoformat(), "dateBasis": basis, "timezone": tz_name,
    }
    return {
        "window": window,
        "note": DOCUMENT_DATE_NOTE,
        **z_by_date.build_summary(db, zs, tzinfo, date_basis=basis, with_document_months=True),
    }
