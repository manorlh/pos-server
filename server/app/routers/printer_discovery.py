"""
"חיפוש מדפסות ברשת" — network printer discovery (app/services/printer_discovery.py).

Dashboard (user JWT; the shop's managers, like the rest of the printers page):

POST /shops/{shop_id}/printer-scan   → ask a till of the shop to scan its LAN (`machineId`
                                       optional; else the print server, else the till
                                       seen last). 409 `no_till_online`. The state.
GET  /shops/{shop_id}/printer-scan   → `{request, last, scanner, tills}`: the scan under
                                       way (or how the last ended), the last results — each
                                       marked when the shop already has it — and which
                                       till a new scan would go to.

Till (machine JWT):

POST /sync/{m}/printers/discovered   → a scan's results (`requestId` when it answers the
                                       dashboard; the request is handed out by
                                       `GET /sync/{m}/print-jobs/pending` → `scan`)
POST /sync/{m}/printers              → add a network printer it found, for the shop: a
                                       manager's write (a signed-in manager, or a manager's
                                       grant in `X-Elevation-Token`). 409
                                       `printer_already_configured`.
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    CatalogActor,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
    require_catalog_authority,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.routers.printers import _shop
from app.schemas.printer_discovery import PrinterScanReportIn, PrinterScanRequestIn, TillNetworkPrinterIn
from app.services import printer_discovery as PD
from app.services import printers as K
from app.services.permissions import Scope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["printers"])


@router.post("/shops/{shop_id}/printer-scan", status_code=status.HTTP_201_CREATED)
def request_printer_scan(
    shop_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    body: Optional[PrinterScanRequestIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A scan already under way for the shop is returned, never a second one."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    scan, created = PD.request_scan(db, current_user, shop, body.machine_id if body else None)
    targets = [(str(scan.tenant_id), str(scan.machine_id))] if created and scan.machine_id else []
    out = PD.scan_state(db, shop)
    db.commit()
    if targets:
        # Wakes the till at once: its `print-job` handler polls, and the poll hands it the scan.
        background_tasks.add_task(K.publish_job_notify, targets)
    return out


@router.get("/shops/{shop_id}/printer-scan")
def get_printer_scan(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    out = PD.scan_state(db, shop)
    db.commit()  # an expiry, if this read noticed one
    return out


@router.post("/sync/{machine_id}/printers/discovered")
def report_discovered_printers(
    machine_id: str,
    body: PrinterScanReportIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """`{id, status, printers}` — each printer with `configuredPrinterId` / `Name` when the shop has it."""
    scan = PD.report_scan(db, machine, body)
    out = PD.till_scan_out(db, scan)
    db.commit()
    return out


@router.post("/sync/{machine_id}/printers", status_code=status.HTTP_201_CREATED)
def add_network_printer_from_till(
    machine_id: str,
    body: TillNetworkPrinterIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    A network printer found on the LAN, added at the till for the whole shop with the
    shop's defaults — the dashboard's create, with its validation. Every till of the shop
    is told (Ably `settings`, reason `printers_updated`).
    """
    printer = PD.add_from_till(db, machine, body)
    targets = K.shop_targets(db, machine.shop_id)
    logger.info(
        "printer added from till %s: %s %s:%s (%s) — user %s, till user %s",
        machine.id, printer.id, printer.host, printer.port, printer.purpose, actor.user_id, actor.pos_user_id,
    )
    db.commit()
    background_tasks.add_task(K.publish_config_notify, targets)
    db.refresh(printer)
    return K.printer_out(printer)
