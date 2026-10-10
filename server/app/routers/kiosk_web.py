"""
The Android kiosk's web renderer ("מסכי ווב"): its status, as it reports it.

POST /sync/{machine_id}/kiosk-web/status → upsert the one `kiosk_web_device_status` row

The bundles themselves are app releases of platform "kiosk_web": offered by
`GET /sync/{id}/app-update?platform=kiosk_web`, downloaded from `…/app-update/{id}/file`,
their progress reported to `POST /sync/{id}/app-update/status` (app/routers/sync.py).
This is the kiosk's own view — what it shows now, what its config asks (`general.renderer`),
its active / previous / pending bundle and why it fell back to the built-in screens — which
the dashboard's rollout shows on the kiosk's "kiosk_web" row.

`get_pos_machine_for_sync_path`, as every `/sync/{machine_id}/…` route.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.kiosk_web import KioskWebDeviceStatus
from app.models.pos_machine import POSMachine
from app.schemas.kiosk_web import KioskWebStatusIn, KioskWebStatusOut

till_router = APIRouter(prefix="/sync", tags=["kiosks"])


def _apply(row: KioskWebDeviceStatus, body: KioskWebStatusIn, now: datetime) -> None:
    row.renderer = body.renderer
    row.configured = body.configured
    row.bundle_version = body.bundle_version
    row.bundle_version_code = body.bundle_version_code
    row.bundle_source = body.bundle_source
    row.previous_version = body.previous_version
    row.pending_version = body.pending_version
    row.apk_bridge_api = body.apk_bridge_api
    row.fallback_reason = body.fallback_reason
    row.message = body.message
    row.updated_at = now


@till_router.post(
    "/{machine_id}/kiosk-web/status",
    response_model=KioskWebStatusOut,
    response_model_by_alias=True,
)
def post_kiosk_web_status(
    machine_id: str,
    body: KioskWebStatusIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Replace this machine's kiosk-web status with the report (every field, as sent: an
    absent one is null). `422` for a `renderer` / `configured` other than "native" | "web";
    texts are clipped to their columns. `{"ok": true, "updatedAt": …}`.
    """
    now = datetime.now(timezone.utc)
    row = db.get(KioskWebDeviceStatus, machine.id)
    if row is None:
        row = KioskWebDeviceStatus(machine_id=machine.id, created_at=now)
        db.add(row)
    _apply(row, body, now)
    try:
        db.commit()
    except IntegrityError:
        # Two first reports raced; the other one's row is there now — update it.
        db.rollback()
        row = db.get(KioskWebDeviceStatus, machine.id)
        _apply(row, body, now)
        db.commit()
    return KioskWebStatusOut(ok=True, updated_at=row.updated_at)
