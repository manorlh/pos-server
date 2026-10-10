"""
The report center (docs/SPEC_REPORTS.md): the consolidated Z table, the all-in-one report,
the reconciliation, and the card transmissions across tills. Dashboard-only (Clerk/user
JWT), scoped like every other report — the caller's role decides what it sees, and a shop
or till outside it is simply not in the answer.

GET /report-center/z-table          → every Z of the filters as rows + per-till lines (§3)
GET /report-center/all-in-one       → "דוח שמכיל הכל" (§5)
GET /report-center/reconciliation   → transactions ↔ Zs ↔ transmissions (§6)
GET /report-center/transmissions    → card transmission reports across tills (§7)
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.models.z_report import ZReport
from app.services import z_table
from app.services.areas import parse_area_filter
from app.services.reports import _load_zoneinfo, resolve_report_timezone, resolve_report_window

router = APIRouter(prefix="/report-center", tags=["report-center"])

_FROM = "Start day (inclusive), in the report timezone. Defaults to 30 days back."
_TO = "End day (inclusive), in the report timezone. Defaults to today."


def _ids(single: Optional[uuid.UUID], many: Optional[List[uuid.UUID]]) -> List[uuid.UUID]:
    out = [m for m in (many if isinstance(many, list) else []) if m is not None]
    if isinstance(single, uuid.UUID) and single not in out:
        out.append(single)
    return out


@router.get("/z-table")
def get_z_table(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    date_basis: Literal["business", "production"] = Query("business", alias="dateBasis"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    z_types: Optional[List[str]] = Query(None, alias="zTypes"),
    origin: Optional[str] = Query(None, pattern="^(cloud|till)$"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    closed_from: Optional[datetime] = Query(None, alias="closedFrom"),
    closed_to: Optional[datetime] = Query(None, alias="closedTo"),
    tz: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "טבלת זדים מרוכזת": every Z the filters match — the same filters as `GET /z-reports`
    plus several shops and the Z types — one row per Z (numbers, counts, gross / net / VAT,
    each payment method, refunds, discounts, tips, the card transmission linked to it) and
    one row per till section (`tills`). With no dates: the last 90 days of business dates.
    More than Z_TABLE_MAX Zs is a 400, never a cut table.
    """
    from datetime import timedelta, timezone

    tz_name = resolve_report_timezone(db, active_tenant_id, tz if isinstance(tz, str) else None)
    tzinfo = _load_zoneinfo(tz_name)
    closed_from = closed_from if isinstance(closed_from, datetime) else None
    closed_to = closed_to if isinstance(closed_to, datetime) else None
    if from_date is None and to_date is None and closed_from is None and closed_to is None:
        from_date = (datetime.now(timezone.utc).astimezone(tzinfo) - timedelta(days=90)).date()
    query = z_table.filtered_z_query(
        db, current_user, active_tenant_id,
        from_date=from_date, to_date=to_date, date_basis=date_basis if isinstance(date_basis, str) else "business",
        tzinfo=tzinfo, shop_ids=_ids(shop_id, shop_ids), machine_ids=_ids(machine_id, machine_ids),
        z_types=z_table.parse_z_types(z_types), origin=origin if isinstance(origin, str) else None,
        area_filter=parse_area_filter(area_id) if isinstance(area_id, str) else None,
        closed_from=closed_from, closed_to=closed_to,
    )
    window = {"from": from_date.isoformat() if from_date else None, "to": to_date.isoformat() if to_date else None,
              "dateBasis": date_basis if isinstance(date_basis, str) else "business", "timezone": tz_name}
    if query is None:
        return {"window": window, "total": 0, "zs": [], "tills": [], "paymentMethods": []}
    total = query.count()
    if total > z_table.Z_TABLE_MAX:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"יותר מ-{z_table.Z_TABLE_MAX:,} דוחות Z ({total:,}) — צמצמו את טווח התאריכים או את הסינון",
        )
    production = date_basis == "production"
    order = (
        (ZReport.closed_at.desc(), ZReport.created_at.desc())
        if production
        else (ZReport.business_date.desc(), ZReport.closed_at.desc(), ZReport.created_at.desc())
    )
    rows = query.order_by(*order).all()
    return {"window": window, **z_table.build_z_table(db, rows, tzinfo)}


@router.get("/all-in-one")
def get_all_in_one(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    z_date_basis: Literal["business", "production"] = Query(
        "business", alias="zDateBasis",
        description="Which Zs its Z section lists over the same days: by business date (default), or "
        "`production` — the local date each Z was produced. The documents' sections are unchanged.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"דוח שמכיל הכל" over local days (and hours) and the shops / tills chosen (§5)."""
    from app.services.all_in_one import build_all_in_one

    window = resolve_report_window(
        db, active_tenant_id, from_date=from_date, to_date=to_date,
        from_hour=from_hour if isinstance(from_hour, int) else None,
        to_hour=to_hour if isinstance(to_hour, int) else None,
        tz=tz if isinstance(tz, str) else None,
    )
    return build_all_in_one(
        db, current_user, active_tenant_id, window,
        shop_ids=_ids(shop_id, shop_ids), machine_ids=_ids(machine_id, machine_ids),
        z_date_basis=z_date_basis if isinstance(z_date_basis, str) else "business",
    )


@router.get("/reconciliation")
def get_reconciliation(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    checks: Optional[List[str]] = Query(None, description="documents_z, z_totals, document_numbers, z_numbers, card_legs, transmissions, refused_documents"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The reconciliation report (§6): every row with a status (תואם / הפרש / חסר / ממתין) and why."""
    from app.services.reconciliation import CHECKS, build_reconciliation

    wanted = []
    for raw in checks if isinstance(checks, list) else []:
        wanted += [c.strip() for c in str(raw).split(",") if c.strip()]
    bad = [c for c in wanted if c not in CHECKS]
    if bad:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown checks: {', '.join(bad)}")
    window = resolve_report_window(
        db, active_tenant_id, from_date=from_date, to_date=to_date, tz=tz if isinstance(tz, str) else None,
    )
    return build_reconciliation(
        db, current_user, active_tenant_id, window,
        shop_ids=_ids(shop_id, shop_ids), machine_ids=_ids(machine_id, machine_ids),
        checks=tuple(wanted) or CHECKS,
    )


@router.get("/transmissions")
def get_transmissions(
    from_date: Optional[date] = Query(None, alias="from", description=_FROM),
    to_date: Optional[date] = Query(None, alias="to", description=_TO),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shop_ids: Optional[List[uuid.UUID]] = Query(None, alias="shopIds"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שידורים": every card transmission report the tills in scope sent in the window, newest
    first, and per till its attempts, successes, failures, amount and last success — with what
    each till says now (pending, last success) and our own untransmitted count beside it.
    """
    from app.services import transmissions as T
    from app.services.all_in_one import machines_in_scope, transmissions_section

    window = resolve_report_window(
        db, active_tenant_id, from_date=from_date, to_date=to_date, tz=tz if isinstance(tz, str) else None,
    )
    machines = machines_in_scope(db, current_user, active_tenant_id, _ids(shop_id, shop_ids), _ids(machine_id, machine_ids))
    out = transmissions_section(db, machines, window)
    untransmitted = T.untransmitted_summary(db, [m.id for m in machines])
    latest = T.latest_by_machine(db, [m.id for m in machines])
    tills = []
    for m in machines:
        state = T.machine_transmission(m, untransmitted.get(m.id), latest.get(m.id))
        fields = T.machine_fields(state)
        tills.append({
            "machineId": str(m.id),
            "machineName": m.name,
            "posNumber": m.pos_number,
            "shopId": str(m.shop_id) if m.shop_id else None,
            "trackingStartedAt": fields["transmissionTrackingStartedAt"].isoformat() if fields["transmissionTrackingStartedAt"] else None,
            "lastTransmissionAt": fields["lastTransmissionAt"].isoformat() if fields["lastTransmissionAt"] else None,
            "lastError": fields["lastTransmissionError"],
            "tillPendingCount": m.transmission_pending_count,
            "tillReportedAt": m.transmission_reported_at.isoformat() if m.transmission_reported_at else None,
            "untransmittedCardLegs": fields["untransmittedCardLegs"],
            "untransmittedCardAmount": fields["untransmittedCardAmount"],
        })
    # "מסמך שנדחה בענן": documents of these tills the cloud refused — every one still refused,
    # and those seen in the window that landed since (app/services/document_refusals.py).
    from app.services import document_refusals as DR

    names = {m.id: m for m in machines}
    refused = []
    for r in DR.refusals_for(db, list(names), since=window.start, until=window.end):
        row = DR.as_row(r)
        machine = names.get(r.machine_id)
        row.update(machineName=machine.name if machine else None, posNumber=machine.pos_number if machine else None)
        refused.append(row)
    return {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"), **out, "tills": tills,
        "refusedDocuments": refused,
    }
