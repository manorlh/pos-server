"""
"מדפסת חלופית" — the log of tickets / receipts sent to another printer when theirs was not
available (app/services/print_redirects.py, till parameter `printerFailoverPrompt`).

Till (machine JWT):
POST /sync/{m}/print-redirects        → log one (idempotent by `id`)

Dashboard (the shop's managers):
GET  /shops/{shop_id}/print-redirects → `{"redirects": [...]}`, the last `days` (7) days
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.routers.printers import _shop
from app.schemas.printer_discovery import PrintRedirectIn
from app.services import print_redirects as PR
from app.services import printers as K

router = APIRouter(tags=["printers"])


@router.post("/sync/{machine_id}/print-redirects", status_code=status.HTTP_201_CREATED)
def post_print_redirect(
    machine_id: str,
    body: PrintRedirectIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    row = PR.log_redirect(db, machine, body)
    out = PR.redirect_out(row, {str(machine.id): machine})
    db.commit()
    return out


@router.get("/shops/{shop_id}/print-redirects")
def get_print_redirects(
    shop_id: uuid.UUID,
    days: int = Query(PR.DEFAULT_DAYS, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    return {"redirects": PR.shop_redirects(db, shop, days)}
