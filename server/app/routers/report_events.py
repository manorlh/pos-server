"""
Temporary events ("אירועים") — tills grouped at report level only (docs/SPEC_EVENTS.md).

A till in an overlapping draft event is never taken silently: create, edit and the bulk
assignment refuse it (409 `till_in_overlapping_event`) unless it is named in the move list
("העבר לאירוע הזה"), which takes editing that other event as well.

Dashboard-only (Clerk/user JWT + X-Tenant-Id). Reading follows the shop's access (as
"sales by area"); creating, editing, deleting and confirming take a managing role
(super admin, distributor, company manager, shop manager) as well. Nothing here writes to
a till, a document, a shift or a Z.

GET    /report-events                       → the events (`shopId`, `status` narrow)
POST   /report-events                       → create (local date + hour for start and end)
GET    /report-events/tills                 → the shop's tills, marked when in an overlapping event
GET    /report-events/compare?ids=a,b       → 2–6 events side by side
GET    /report-events/{id}                  → the event
PUT    /report-events/{id}                  → edit (draft only)
DELETE /report-events/{id}                  → delete (draft only)
POST   /report-events/{id}/tills            → add / remove / move tills in one go, all or nothing (draft only)
GET    /report-events/{id}/till-changes     → who added, removed or moved which till, and when
GET    /report-events/{id}/report           → the producer report (the snapshot once confirmed)
GET    /report-events/{id}/readiness        → what stands between the event and its confirmation
GET    /report-events/{id}/export           → the report as Excel (`bucket` 15 / 30 / 60)
POST   /report-events/{id}/confirm          → "נותן תוקף": freeze, release the tills
"""
from __future__ import annotations

import uuid
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.schemas.report_event import (
    ReportEventConfirm,
    ReportEventCreate,
    ReportEventTillsChange,
    ReportEventUpdate,
)
from app.services.report_events import crud as C
from app.services.report_events.export import XLSX_MEDIA_TYPE, build_workbook, file_name
from app.services.report_events.report import event_block, report_for

router = APIRouter(prefix="/report-events", tags=["report-events"])


@router.get("")
def list_report_events(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    status_filter: Optional[str] = Query(None, alias="status", pattern="^(draft|confirmed)$"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return {"events": C.list_events(db, current_user, active_tenant_id, shop_id=shop_id, status_filter=status_filter)}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_report_event(
    body: ReportEventCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    with C.atomic(db):
        event = C.create_event(db, current_user, active_tenant_id, body)
    db.refresh(event)
    return event_block(db, event)


@router.get("/tills")
def get_report_event_tills(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    start_date: Optional[str] = Query(None, alias="startDate"),
    start_time: Optional[str] = Query(None, alias="startTime"),
    end_date: Optional[str] = Query(None, alias="endDate"),
    end_time: Optional[str] = Query(None, alias="endTime"),
    exclude_event_id: Optional[uuid.UUID] = Query(None, alias="excludeEventId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's tills; with a full window, each till already in an overlapping event is marked."""
    window = None
    if start_date and start_time and end_date and end_time:
        starts, ends, _tz = C.resolve_window(db, active_tenant_id, start_date, start_time, end_date, end_time)
        window = (starts, ends)
    return C.tills_view(db, current_user, active_tenant_id, shop_id, window, exclude_event_id)


@router.get("/compare")
def compare_report_events(
    ids: str = Query(..., description="Comma-separated event ids (2–6)."),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    wanted = [i.strip() for i in ids.split(",") if i.strip()]
    return C.compare_events(db, current_user, active_tenant_id, wanted)


@router.get("/{event_id}")
def get_report_event(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return event_block(db, C.load_event(db, current_user, active_tenant_id, event_id))


@router.put("/{event_id}")
def update_report_event(
    event_id: uuid.UUID,
    body: ReportEventUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    with C.atomic(db):
        event = C.load_event(db, current_user, active_tenant_id, event_id, write=True, draft=True)
        event = C.update_event(db, current_user, active_tenant_id, event, body)
    db.refresh(event)
    return event_block(db, event)


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report_event(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    with C.atomic(db):
        event = C.load_event(db, current_user, active_tenant_id, event_id, write=True, draft=True)
        C.delete_event(db, event)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{event_id}/tills")
def change_report_event_tills(
    event_id: uuid.UUID,
    body: ReportEventTillsChange,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שיוך קופות מהיר לאירוע": add, remove and move tills in one transaction. Any refusal rolls
    the whole request back — no till moves unless every till does. Two requests racing on the
    same events or tills run one after the other (row locks: events, then tills); a deadlock or a
    duplicate the database still catches is a 409, never a 500.
    """
    with C.atomic(db):
        event = C.load_event(db, current_user, active_tenant_id, event_id, write=True, draft=True)
        changes = C.change_tills(
            db, current_user, active_tenant_id, event, add=body.add, remove=body.remove, move=body.move,
        )
    db.refresh(event)
    return {**event_block(db, event), "changes": changes}


@router.get("/{event_id}/till-changes")
def get_report_event_till_changes(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    event = C.load_event(db, current_user, active_tenant_id, event_id)
    return {"changes": C.till_changes(db, event, user=current_user, tenant_id=active_tenant_id)}


@router.get("/{event_id}/report")
def get_report_event_report(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return report_for(db, C.load_event(db, current_user, active_tenant_id, event_id))


@router.get("/{event_id}/readiness")
def get_report_event_readiness(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    event = C.load_event(db, current_user, active_tenant_id, event_id)
    report = report_for(db, event)
    return {**report["readiness"], "status": event.status}


@router.get("/{event_id}/export")
def export_report_event(
    event_id: uuid.UUID,
    bucket: int = Query(30, description="Timeline bucket in minutes: 15, 30 or 60."),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if bucket not in (15, 30, 60):
        bucket = 30
    report = report_for(db, C.load_event(db, current_user, active_tenant_id, event_id))
    name = file_name(report)
    return Response(
        content=build_workbook(report, bucket),
        media_type=XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f"attachment; filename=\"event-report.xlsx\"; filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store",
        },
    )


@router.post("/{event_id}/confirm")
def confirm_report_event(
    event_id: uuid.UUID,
    body: ReportEventConfirm,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    with C.atomic(db):
        event = C.load_event(db, current_user, active_tenant_id, event_id, write=True, draft=True)
        report = C.confirm_event(db, current_user, active_tenant_id, event, force=body.force, note=body.note)
    return report
