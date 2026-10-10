"""
"בדיקות ומידע קיוסק" (docs/SPEC_KIOSK.md, "מסך טכנאי"): where a till stands, for the kiosk's
technician screen (pos-android ui/kiosk/KioskTechnician.kt).

GET /sync/{machine_id}/kiosk/technician → app/services/kiosk_technician.identity

Read only; `get_pos_machine_for_sync_path` (the machine's own token, path = token machine).
Its answer is also the screen's "cloud API" check: it proves the till's token and measures
the round trip.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.services import kiosk_technician as svc

till_router = APIRouter(prefix="/sync", tags=["kiosks"])


@till_router.get("/{machine_id}/kiosk/technician")
def get_kiosk_technician_identity(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    return svc.identity(db, machine)
