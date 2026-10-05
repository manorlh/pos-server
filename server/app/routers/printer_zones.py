"""
"הפניית מדפסות לפי אזור שולחנות" — the per-zone printer redirect
(app/services/printer_zones.py, docs/SPEC_PRINT_BY_ZONE.md).

Dashboard (user JWT; the shop's managers, like the rest of the printers page):

GET /shops/{shop_id}/printer-zone-redirects            → every live table zone of the shop
                                                         with its redirect, and the shop's
                                                         kitchen printers
PUT /shops/{shop_id}/printer-zone-redirects/{zone_id}  → one zone's redirect, whole:
                                                         `{"redirects": {fromId: toId}}`
                                                         ({} clears it); the section again

The tills get it with their printers (`GET /sync/{m}/printers` → `zoneRedirects`), and are
told on a change (Ably `settings`, reason `printers_updated`).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.routers.printers import _config_changed, _shop
from app.schemas.printer_discovery import ZoneRedirectsIn
from app.services import printer_zones as Z
from app.services import printers as K

router = APIRouter(tags=["printers"])


@router.get("/shops/{shop_id}/printer-zone-redirects")
def get_zone_redirects(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    return Z.zone_redirects_out(db, shop)


@router.put("/shops/{shop_id}/printer-zone-redirects/{zone_id}")
def put_zone_redirects(
    shop_id: uuid.UUID,
    zone_id: uuid.UUID,
    body: ZoneRedirectsIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """422 `redirect_to_itself` / `printer_not_in_shop` / `printer_not_kitchen`; 404 `zone_not_found`."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    zone = Z.live_zone(db, shop, zone_id)
    Z.set_zone_redirects(db, shop, zone, body)
    _config_changed(db, shop, background_tasks)
    return Z.zone_redirects_out(db, shop)
