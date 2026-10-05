"""
Promotions ("מבצעים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1).

Dashboard (Clerk/user JWT; writes by the catalog roles, see app/services/promotions.py):

GET    /promotions                    → the promotions the caller can see, newest first,
                                        with status (active / scheduled / ended / paused)
                                        and `canEdit`; `?search=`, `?status=`
GET    /promotions/{id}
POST   /promotions                    → create
PUT    /promotions/{id}               → replace
POST   /promotions/{id}/pause         → `{"paused": true|false}`
POST   /promotions/{id}/duplicate     → a paused copy
DELETE /promotions/{id}
GET    /reports/promotions            → times applied and discount, by promotion, shop,
                                        till and day

Till (machine JWT, like its other pulls):

GET    /sync/{machine_id}/promotions[?etag=…] → the promotions this till runs; the ETag
                                        of the last pull back answers "unchanged"

Every write wakes the organization's tills after the commit (Ably `settings` notify,
reason `promotions_updated`), best effort; tills also pull on every sync.
"""
from __future__ import annotations

from datetime import date
from typing import Optional
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.promotion import PromotionIn, PromotionPauseIn
from app.services import promotions as P
from app.services.reports import resolve_report_window

router = APIRouter(tags=["promotions"])

#: Appended to a duplicate's name.
COPY_SUFFIX = "(עותק)"


def _changed(db: Session, tenant_id, background_tasks: BackgroundTasks) -> None:
    targets = P.notify_targets(db, tenant_id)
    db.commit()
    background_tasks.add_task(P.publish_promotions_notify, targets)


@router.get("/promotions")
def list_promotions(
    search: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """`{"items": [...], "counts": {status: n}, "canCreate": bool}`."""
    return P.list_promotions(db, current_user, active_tenant_id, search=search, status_filter=status_filter)


@router.get("/promotions/{promotion_id}")
def get_promotion(
    promotion_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    promotion = P.get_promotion(db, active_tenant_id, promotion_id)
    return P.one_out(db, current_user, active_tenant_id, promotion)


@router.post("/promotions", status_code=status.HTTP_201_CREATED)
def create_promotion(
    body: PromotionIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    promotion = P.create_promotion(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return P.one_out(db, current_user, active_tenant_id, promotion)


@router.put("/promotions/{promotion_id}")
def update_promotion(
    promotion_id: str,
    body: PromotionIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    promotion = P.get_promotion(db, active_tenant_id, promotion_id)
    P.update_promotion(db, current_user, active_tenant_id, promotion, body)
    _changed(db, active_tenant_id, background_tasks)
    return P.one_out(db, current_user, active_tenant_id, promotion)


@router.post("/promotions/{promotion_id}/pause")
def pause_promotion(
    promotion_id: str,
    body: PromotionPauseIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Pause (`paused: true`) or resume; idempotent."""
    promotion = P.get_promotion(db, active_tenant_id, promotion_id)
    P.set_paused(db, current_user, active_tenant_id, promotion, body.paused)
    _changed(db, active_tenant_id, background_tasks)
    return P.one_out(db, current_user, active_tenant_id, promotion)


@router.post("/promotions/{promotion_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_promotion(
    promotion_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A copy, paused, so nothing reaches a till until it is edited and resumed."""
    promotion = P.get_promotion(db, active_tenant_id, promotion_id)
    copy = P.duplicate_promotion(db, current_user, active_tenant_id, promotion, COPY_SUFFIX)
    db.commit()
    return P.one_out(db, current_user, active_tenant_id, copy)


@router.delete("/promotions/{promotion_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_promotion(
    promotion_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    promotion = P.get_promotion(db, active_tenant_id, promotion_id)
    P.delete_promotion(db, current_user, active_tenant_id, promotion)
    _changed(db, active_tenant_id, background_tasks)


@router.get("/reports/promotions")
def get_promotions_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    promotion_id: Optional[uuid.UUID] = Query(None, alias="promotionId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """דוח מבצעים: per promotion, shop, till and day — applications, documents, discount."""
    window = resolve_report_window(
        db, active_tenant_id, from_date=from_date, to_date=to_date, from_hour=from_hour, to_hour=to_hour, tz=tz
    )
    return P.build_promotions_report(
        db, current_user, active_tenant_id, window,
        shop_id=shop_id, machine_id=machine_id, promotion_id=promotion_id,
    )


# ── The till's side ───────────────────────────────────────────────────────────


@router.get("/sync/{machine_id}/promotions")
def get_own_promotions(
    machine_id: str,
    etag: Optional[str] = Query(None),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    `{"syncType": "full"|"unchanged", "etag", "serverTime", "promotions": [...]}`. Each
    promotion: `id`, `name`, `type`, `priority`, `validFrom`/`validTo` (local dates),
    `weekdays` (0 = Sunday), `startTime`/`endTime` ("HH:MM", may cross midnight),
    `maxApplications`, and `config` with category ids already including sub-categories.
    """
    return P.sync_response(db, machine, etag)
