"""
"מצב הדרכה" — a shop's training mode (app/services/training_mode.py,
docs/SPEC_TRAINING_MODE.md) — and the demo menu (app/services/demo_menu.py).

Dashboard (the shop page's "מצב הדרכה" and "תפריט דמה" cards):

GET  /shops/{shop_id}/training-mode                  → the flag, who / when, the
                                                       quarantined counts, the log
POST /shops/{shop_id}/training-mode/enable           → turn it on; 409 `training_not_available`
                                                       (no device implements it yet), 409
                                                       `real_shift_open`
GET  /shops/{shop_id}/training-mode/disable-preview  → what leaving would delete, and
                                                       what holds it back (blockers)
POST /shops/{shop_id}/training-mode/disable          → `{confirmName, removeDemoMenu, force}`
GET  /shops/{shop_id}/training-mode/report           → the training sales, summarised

GET  /demo-menu/templates                            → the templates and what each makes
GET  /demo-menu/status?companyId=&shopId=            → the loads reaching that shop
POST /demo-menu/load                                 → `{companyId, shopId?, template}`
GET  /demo-menu/loads/{load_id}/remove-preview       → what a removal deletes / keeps
POST /demo-menu/loads/{load_id}/remove

Till (machine JWT):

POST /sync/{machine_id}/training-documents           → the till's own training Z / X (and
                                                       any other training document with
                                                       no real endpoint), quarantined

Turning the flag on or off wakes the shop's tills (a settings signal; the flag rides the
settings sync and `GET /machines/me`); leaving also wakes them for the tables it cleared.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import demo_menu as DM
from app.services import training_mode as TM

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_MACHINE_TOKEN

router = APIRouter(tags=["training-mode"])


# ── Bodies ────────────────────────────────────────────────────────────────────


class DisableIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The shop's name, typed by the person confirming.
    confirm_name: str = Field("", alias="confirmName", max_length=255)
    remove_demo_menu: bool = Field(False, alias="removeDemoMenu")
    #: Leave even though a till has unsynced documents or a table is open.
    force: bool = False


class DemoLoadIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    company_id: uuid.UUID = Field(..., alias="companyId")
    #: Sold in this shop only; absent / null: every shop of the company (the company rule).
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    template: str = Field(..., max_length=32)


class TrainingDocumentIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["transaction", "shift", "z", "x", "other"]
    #: The till's own id of the document; idempotency key with `kind`.
    id: str = Field(..., min_length=1, max_length=100)
    #: Its number as printed ("ה-3"), if any.
    number: Optional[str] = Field(None, max_length=100)
    payload: Any = None


class TrainingDocumentsIn(BaseModel):
    documents: List[TrainingDocumentIn] = Field(default_factory=list, max_length=500)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _shop(db: Session, shop_id: uuid.UUID, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _notify_flag(shop_id: str, tenant_id: Optional[str], table_targets) -> None:
    """After the commit: the shop's tills pull their settings (the flag), and tables."""
    from app.database import SessionLocal
    from app.services.settings_notify import notify_machines_for_shop_settings
    from app.services.tables import publish_tables_notify

    db = SessionLocal()
    try:
        notify_machines_for_shop_settings(db, shop_id, reason=TM.NOTIFY_REASON)
    except Exception:  # pragma: no cover - best effort; the tills also pull on their own
        pass
    finally:
        db.close()
    if table_targets:
        try:
            publish_tables_notify(table_targets)
        except Exception:  # pragma: no cover
            pass


# ── Training mode ─────────────────────────────────────────────────────────────


@router.get("/shops/{shop_id}/training-mode")
def get_training_mode(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    TM.check_read(db, current_user, shop)
    return TM.status_out(db, shop, current_user)


@router.post("/shops/{shop_id}/training-mode/enable")
def enable_training_mode(
    shop_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    TM.check_manage(db, current_user, shop)
    was_on = TM.is_on(shop)
    TM.start(db, shop, current_user)
    out = TM.status_out(db, shop, current_user)
    db.commit()
    if not was_on:
        background_tasks.add_task(_notify_flag, str(shop.id), str(shop.tenant_id), None)
    return out


@router.get("/shops/{shop_id}/training-mode/disable-preview")
def get_disable_preview(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    TM.check_read(db, current_user, shop)
    return TM.disable_preview(db, shop)


@router.post("/shops/{shop_id}/training-mode/disable")
def disable_training_mode(
    shop_id: uuid.UUID,
    body: DisableIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import tables as tables_service

    shop = _shop(db, shop_id, active_tenant_id)
    TM.check_manage(db, current_user, shop)
    if body.remove_demo_menu:
        DM.check_manage(db, current_user, shop.company_id)
    result = TM.stop(
        db, shop, current_user,
        confirm_name=body.confirm_name,
        remove_demo_menu=body.remove_demo_menu,
        force=body.force,
    )
    out = {**result, "status": TM.status_out(db, shop, current_user)}
    table_targets = tables_service.notify_targets(db, shop.id) if result["deleted"]["tableOrders"] else None
    if table_targets is not None:
        # The tills' tables state changed: a new version (app/services/tables_state.py), last.
        from app.services import tables_state as TS

        TS.bump(db, shop.id)
    catalog_targets = DM.catalog_targets(db, shop.tenant_id) if result.get("demoMenu") else None
    db.commit()
    background_tasks.add_task(_notify_flag, str(shop.id), str(shop.tenant_id), table_targets)
    if catalog_targets:
        background_tasks.add_task(_notify_catalog, catalog_targets)
    return out


@router.get("/shops/{shop_id}/training-mode/report")
def get_training_report(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    TM.check_read(db, current_user, shop)
    return TM.report(db, shop)


# ── The till's training documents ─────────────────────────────────────────────


@router.post("/sync/{machine_id}/training-documents", dependencies=FISCAL_MACHINE_TOKEN)
def post_training_documents(
    machine_id: str,
    body: TrainingDocumentsIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Quarantine the till's own training documents (its training Z / X…): `accepted` the
    first time, `duplicate` after (by kind and id), `dropped` once its shop has left
    training mode (logged, kept nowhere). Never written to a real table.
    """
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    results = TM.receive_documents(db, machine, body.documents)
    db.commit()
    return {"results": results, "serverTime": datetime.now(timezone.utc).isoformat()}


# ── Demo menu ─────────────────────────────────────────────────────────────────


def _notify_catalog(targets) -> None:
    from app.services import menu as M
    from app.services.catalog_import import publish_catalog_notify

    publish_catalog_notify(targets)
    try:
        M.publish_menu_notify(targets)
    except Exception:  # pragma: no cover - best effort
        pass


def _demo_read(db: Session, user: User, company_id, shop_id, tenant_id) -> None:
    """The card is for whoever may manage the company, or manage the shop it is on."""
    from app.models.company import Company
    from app.services.printers import can_edit

    company = db.get(Company, company_id)
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, tenant_id)
    if DM.can_manage(db, user, company.id):
        return
    if shop_id is not None:
        shop = _shop(db, shop_id, tenant_id)
        if str(shop.company_id) == str(company.id) and can_edit(db, user, shop):
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


@router.get("/demo-menu/templates")
def list_demo_templates(current_user: User = Depends(get_current_user)):
    return DM.templates_out()


@router.get("/demo-menu/status")
def get_demo_status(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _demo_read(db, current_user, company_id, shop_id, active_tenant_id)
    return DM.status_out(db, current_user, company_id, shop_id)


@router.post("/demo-menu/load", status_code=status.HTTP_201_CREATED)
def load_demo_menu(
    body: DemoLoadIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    out = DM.load(db, current_user, active_tenant_id, body.company_id, body.shop_id, body.template)
    background_tasks.add_task(_notify_catalog, DM.catalog_targets(db, active_tenant_id))
    return out


def _load_rows(db: Session, user: User, tenant_id, load_id: uuid.UUID):
    rows = DM.load_rows(db, tenant_id, load_id)
    DM.check_manage(db, user, rows[0].company_id)
    return rows


@router.get("/demo-menu/loads/{load_id}/remove-preview")
def get_demo_remove_preview(
    load_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rows = _load_rows(db, current_user, active_tenant_id, load_id)
    return DM.remove_preview(db, rows)


@router.post("/demo-menu/loads/{load_id}/remove")
def remove_demo_menu(
    load_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _load_rows(db, current_user, active_tenant_id, load_id)
    result = DM.remove(db, current_user, load_id)
    targets = DM.catalog_targets(db, active_tenant_id)
    db.commit()
    background_tasks.add_task(_notify_catalog, targets)
    return result
