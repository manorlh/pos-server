"""
"איך המסך מדפיס" — a kitchen screen / the board that prints through a till of the shop with nothing
installed (app/services/kds_print.py).

The screen (its machine token):
* `GET /sync/{m}/kds/print` — its path and, through a till, where the next bon goes (or why nowhere).
* `POST /sync/{m}/kds/print-jobs` — `{id, ticket}` (a bon as the KDS prints it) or `{id, test: true}`;
  idempotent by `id`; 201 with the job (`status`, `targetMachineName`…). 409 `{"code": ...}`:
  `not_a_screen`, `kds_print_not_relay`, `remote_print_off`, `no_host`, `host_not_found`, `host_not_allowed`,
  `printer_not_found`, `printer_out_of_scope`.
* `GET /sync/{m}/kds/print-jobs/status?ids=` — its jobs as they stand (`pending` / `printing` / `done` /
  `failed` / `expired`).

The dashboard (the KDS page, "מסכי מטבח" → a screen → "הדפסה"; who may edit the shop's printers):
* `GET /kds/shops/{shop}/devices/{machine}/print` — the card: the screen's own values, what it resolves
  to, the places it may print, its last jobs.
* `PUT /kds/shops/{shop}/devices/{machine}/print` — `{path, hostMachineId, printerId}` for this screen
  (null — as its shop / point of sale says).
* `POST /kds/shops/{shop}/devices/{machine}/print/test` — "הדפסת בדיקה" on the screen's path.
"""
from __future__ import annotations

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.kitchen_printers import TicketIn
from app.services import kds_print as KP
from app.services import printers as K

router = APIRouter(tags=["kds"])


class KdsPrintJobIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Chosen by the screen, so a retried upload is the same job.
    id: uuid.UUID
    ticket: Optional[TicketIn] = None
    #: "הדפסת בדיקה" from the screen's technician panel (the ticket is the cloud's).
    test: bool = False

    @model_validator(mode="after")
    def _what(self):
        if not self.test and self.ticket is None:
            raise ValueError("a bon needs ticket")
        return self


class KdsPrintSettingsIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    path: Optional[Literal["device", "none", "relay", "bridge", "app"]] = None
    host_machine_id: Optional[uuid.UUID] = Field(None, alias="hostMachineId")
    printer_id: Optional[uuid.UUID] = Field(None, alias="printerId")


def _after_job(background_tasks: Optional[BackgroundTasks], db: Session, machine: POSMachine, job, created: bool,
               printer_made: bool) -> None:
    if background_tasks is None:
        return
    if printer_made:
        # A till's own printer got its entry: the tills pull their printers again (the host learns it hosts it).
        background_tasks.add_task(K.publish_config_notify, KP.notify_hosts(db, machine))
    if created:
        background_tasks.add_task(K.publish_job_notify, K.job_targets(db, [job]))


# ── The screen ───────────────────────────────────────────────────────────────


@router.get("/sync/{machine_id}/kds/print")
def get_screen_print(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = KP.status_of(db, machine)
    db.commit()
    return out


@router.post("/sync/{machine_id}/kds/print-jobs", status_code=status.HTTP_201_CREATED)
def post_screen_print_job(
    machine_id: str,
    body: KdsPrintJobIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    ticket = body.ticket.model_dump(by_alias=True) if body.ticket is not None else None
    job, created, made = KP.create_job(db, machine, body.id, ticket, test=body.test)
    out = KP.job_view(db, job)
    db.commit()
    _after_job(background_tasks, db, machine, job, created, made)
    return out


@router.get("/sync/{machine_id}/kds/print-jobs/status")
def get_screen_print_jobs(
    machine_id: str,
    ids: str = Query(""),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    from app.models.printers import KitchenPrintJob

    wanted = []
    for raw in (ids.split(",") if ids else [])[:100]:
        try:
            wanted.append(uuid.UUID(raw.strip()))
        except (TypeError, ValueError):
            continue
    jobs = (
        db.query(KitchenPrintJob)
        .filter(KitchenPrintJob.id.in_(wanted), KitchenPrintJob.source_machine_id == machine.id)
        .all()
        if wanted else []
    )
    K.expire_jobs(db, jobs)
    out = [KP.job_view(db, j) for j in jobs]
    db.commit()
    return {"jobs": out}


# ── The dashboard ────────────────────────────────────────────────────────────


def _screen(db: Session, shop_id: uuid.UUID, machine_id: uuid.UUID, user: User, tenant_id, edit: bool):
    from app.routers.kds import _shop

    shop = _shop(db, shop_id, tenant_id)
    (K.check_edit if edit else K.check_read)(db, user, shop)
    return shop, KP.screen_of_shop(db, shop, machine_id)


@router.get("/kds/shops/{shop_id}/devices/{machine_id}/print")
def get_screen_print_card(
    shop_id: uuid.UUID,
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop, machine = _screen(db, shop_id, machine_id, current_user, active_tenant_id, edit=False)
    out = KP.card(db, machine)
    out["canEdit"] = K.can_edit(db, current_user, shop)
    db.commit()
    return out


@router.put("/kds/shops/{shop_id}/devices/{machine_id}/print")
def put_screen_print(
    shop_id: uuid.UUID,
    machine_id: uuid.UUID,
    body: KdsPrintSettingsIn,
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop, machine = _screen(db, shop_id, machine_id, current_user, active_tenant_id, edit=True)
    KP.save(
        db, machine, body.path,
        str(body.host_machine_id) if body.host_machine_id else None,
        str(body.printer_id) if body.printer_id else None,
    )
    out = KP.card(db, machine)
    out["canEdit"] = True
    db.commit()
    if background_tasks is not None:
        from app.services.till_parameters import publish_parameters_notify

        background_tasks.add_task(publish_parameters_notify, [(str(shop.tenant_id), str(machine.id))])
    return out


@router.post("/kds/shops/{shop_id}/devices/{machine_id}/print/test", status_code=status.HTTP_201_CREATED)
def post_screen_print_test(
    shop_id: uuid.UUID,
    machine_id: uuid.UUID,
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop, machine = _screen(db, shop_id, machine_id, current_user, active_tenant_id, edit=True)
    job, created, made = KP.create_job(db, machine, uuid.uuid4(), None, test=True, user=current_user)
    out = KP.job_view(db, job)
    db.commit()
    _after_job(background_tasks, db, machine, job, created, made)
    return out
