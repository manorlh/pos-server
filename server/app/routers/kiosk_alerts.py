"""
The tills' side of a kiosk's alerts ("התראות לקופות", docs/SPEC_KIOSK.md §16;
app/services/kiosk_ops.py):

* `GET  /sync/{machine_id}/kiosk/alerts` — the open alerts routed to this till (printer,
  card terminal, help), with who should see them (`audience`). Polled on the heartbeat's
  cadence and right after a realtime wake-up.
* `POST /sync/{machine_id}/kiosk/alerts/{alert_id}/ack` — "בדרך" on a help request (it
  clears; the kiosk shows "הצוות בדרך"), or "הבנתי" on another alert. Only a till the
  alert was routed to (404 otherwise); idempotent.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.services import kiosk_ops

till_router = APIRouter(prefix="/sync", tags=["kiosks"])


class KioskAlertAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=64)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=100)


@till_router.get("/{machine_id}/kiosk/alerts")
def till_kiosk_alerts(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = kiosk_ops.alerts_for_till(db, machine)
    # "נעילת הקופה לנקודת המכירה שלה" (app/services/area_lock.py): a locked till keeps the alerts
    # of its area's devices and of the shop's area-less ones.
    from app.services import area_lock

    areas = area_lock.areas_of_machines(db, [a.get("kioskMachineId") for a in out])
    out = area_lock.keep_shared_devices(
        db, machine, out, lambda a: areas.get(area_lock._as_uuid(a.get("kioskMachineId")))
    )
    db.commit()
    return {"alerts": out, "serverTime": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}


@till_router.post("/{machine_id}/kiosk/alerts/{alert_id}/ack")
def till_kiosk_alert_ack(
    machine_id: str,
    alert_id: str,
    body: Optional[KioskAlertAckIn] = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = kiosk_ops.acknowledge(db, machine, alert_id, pos_user_name=body.pos_user_name if body else None)
    db.commit()
    return out
