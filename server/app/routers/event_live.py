"""
"מצב אירוע חי" — the event's live screen (app/services/report_events/live.py).

Dashboard-only (Clerk/user JWT + X-Tenant-Id). Reading follows the event's shop, exactly
like the event report (`crud.load_event`); setting the target takes the events' managing
roles too (super admin, distributor, company manager, shop manager).

GET /report-events/live/current?shopId=   → the events worth a live screen now: live,
                                             starting within 12 h or ended within 3 h
GET /report-events/{id}/live?bucket=1|5   → the live view (totals, chart, target, pace,
                                             top items, tills, KDS, vouchers)
PUT /report-events/{id}/live-target       → `{target: ₪ | null}` — the event's target in "יעדים
                                             ותחרות" (its shop target for the event), made, changed
                                             or archived; its "יעד הושג" is that module's
GET /report-events/{id}/live/push         → Ably push for the screen: a subscribe-only token
                                             for the event's channel, or `enabled: false`
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.report_event import ReportEvent
from app.models.user import User
from app.services.report_events import crud as C
from app.services.report_events import live as L
from app.services.report_events import live_push as P
from app.services.report_events.common import money
from app.services.report_events.targets import clean_target, target_for_event

router = APIRouter(prefix="/report-events", tags=["report-events"])


def _now() -> datetime:
    """The wall clock; a test freezes it here."""
    return datetime.now(timezone.utc)


@router.get("/live/current")
def get_current_live_events(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Live now, starting soon, or just over — of the shops the caller may read."""
    now = _now()
    q = db.query(ReportEvent).filter(
        ReportEvent.tenant_id == active_tenant_id,
        ReportEvent.starts_at <= now + timedelta(hours=L.UPCOMING_HOURS),
        ReportEvent.ends_at >= now - timedelta(hours=L.RECENT_END_HOURS),
    )
    if shop_id is not None:
        C.load_shop(db, current_user, active_tenant_id, shop_id, write=False)
        q = q.filter(ReportEvent.shop_id == shop_id)
    allowed: Dict[Any, bool] = {}
    visible = []
    for event in q.order_by(ReportEvent.starts_at).limit(200).all():
        if event.shop_id not in allowed:
            try:
                C.load_shop(db, current_user, active_tenant_id, event.shop_id, write=False)
                allowed[event.shop_id] = True
            except HTTPException:
                allowed[event.shop_id] = False
        if allowed[event.shop_id]:
            visible.append(event)
    return {"now": now.isoformat(), "events": L.current_events(db, visible, now)}


@router.get("/{event_id}/live")
def get_event_live(
    event_id: uuid.UUID,
    bucket: int = Query(L.DEFAULT_BUCKET, description="Minutes per chart point: 1 or 5."),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if bucket not in L.BUCKETS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bucket must be 1 or 5")
    event = C.load_event(db, current_user, active_tenant_id, event_id)
    out = L.build_live(db, event, now=_now(), bucket=bucket)
    from app.services import dashboard_access

    from app.services.kiosk_control import KIOSK_ROLES

    # Setting the target writes the event's target in "יעדים ותחרות": its roles too.
    out["canSetTarget"] = (
        current_user.role in C.WRITE_ROLES
        and current_user.role in KIOSK_ROLES
        and dashboard_access.effective_access(db, current_user).allows("live_event", "edit")
    )
    return out


@router.put("/{event_id}/live-target")
def put_event_live_target(
    event_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.models.shop import Shop
    from app.services import kiosk_control, sales_targets

    event = C.load_event(db, current_user, active_tenant_id, event_id, write=True)
    try:
        amount = clean_target(body.get("target"))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "target_invalid", "message": "יעד המכירות חייב להיות סכום חיובי"},
        ) from None
    # The event's target lives in "יעדים ותחרות" (one source, one "יעד הושג"): the targets page's rule too.
    shop = db.get(Shop, event.shop_id)
    kiosk_control.check_shop_scope(db, current_user, shop, active_tenant_id)
    row = sales_targets.set_event_target(db, event, amount, user=current_user, now=_now())
    event.live_target = None  # the old place of a typed target: never two of them
    db.commit()
    db.refresh(event)
    target = target_for_event(db, event)
    return {
        "targetId": str(row.id) if row is not None else None,
        "target": {"amount": money(target.amount), "source": target.source} if target else None,
    }


@router.get("/{event_id}/live/push")
def get_event_live_push(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    event = C.load_event(db, current_user, active_tenant_id, event_id)
    return P.token_for(event)
