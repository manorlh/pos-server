"""
"עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md, app/services/kiosk_designs.py): the library of a
company's (and its shops') saved kiosk designs. Assigning one to a level is `PUT /kiosks/settings/design`
(app/routers/kiosks.py). Reads: any kiosk role in scope; writes: the machine admins in scope (a company design:
company manager and above; a shop's own: that shop's manager too).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
from app.models.user import User
from app.services import kiosk_config as cfgsvc
from app.services import kiosk_designs as svc

router = APIRouter(prefix="/kiosk-designs", tags=["kiosk-designs"])


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class DesignCreateIn(_Camel):
    name: str = Field(..., max_length=200)
    groups: List[str] = Field(default_factory=list)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    #: A shop's own design ("רק לסניף הזה").
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: "שמירה כעיצוב…": the whole config the editor shows, cut to the groups.
    config: Optional[Dict[str, Any]] = None
    #: …or a partial layer.
    overrides: Optional[Dict[str, Any]] = None


class DesignUpdateIn(_Camel):
    revision: Optional[int] = None
    name: Optional[str] = Field(None, max_length=200)
    groups: Optional[List[str]] = None
    overrides: Optional[Dict[str, Any]] = None


class DesignDuplicateIn(_Camel):
    name: Optional[str] = Field(None, max_length=200)
    #: Omitted: where the original is; null: the company's; an id: that shop's own.
    shop_id: Optional[Any] = Field("same", alias="shopId")


def _invalid(invalid: cfgsvc.KioskConfigInvalid) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=invalid.detail())


@router.get("")
def list_designs(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    archived: bool = Query(False),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.list_designs(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id, archived=archived)


@router.get("/groups")
def get_groups(current_user: User = Depends(get_current_user)):
    return {"groups": svc.groups_wire()}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_design(
    body: DesignCreateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        design = svc.create(
            db, current_user, active_tenant_id, company_id=body.company_id, shop_id=body.shop_id,
            name=body.name, groups=body.groups, overrides=body.overrides, config=body.config,
        )
    except cfgsvc.KioskConfigInvalid as invalid:
        db.rollback()
        raise _invalid(invalid)
    db.commit()
    return svc.detail(db, design)


@router.get("/{design_id}")
def get_design(
    design_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.detail(db, svc.get_design(db, current_user, active_tenant_id, design_id))


@router.put("/{design_id}")
def update_design(
    design_id: uuid.UUID,
    body: DesignUpdateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Rename / groups / the layer. 409 `kiosk_design_changed` from an older copy; 422 as `PUT /kiosks/settings`."""
    design = svc.get_design(db, current_user, active_tenant_id, design_id, write=True)
    try:
        svc.update(db, current_user, design, revision=body.revision, name=body.name, groups=body.groups, overrides=body.overrides)
    except cfgsvc.KioskConfigInvalid as invalid:
        db.rollback()
        raise _invalid(invalid)
    db.commit()
    return svc.detail(db, design)


@router.post("/{design_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_design(
    design_id: uuid.UUID,
    body: Optional[DesignDuplicateIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    body = body or DesignDuplicateIn()
    design = svc.get_design(db, current_user, active_tenant_id, design_id)
    copy_ = svc.duplicate(db, current_user, active_tenant_id, design, name=body.name, shop_id=body.shop_id)
    db.commit()
    return svc.detail(db, copy_)


@router.post("/{design_id}/archive")
def archive_design(
    design_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    design = svc.get_design(db, current_user, active_tenant_id, design_id, write=True)
    svc.set_archived(db, current_user, design, True)
    db.commit()
    return svc.detail(db, design)


@router.post("/{design_id}/restore")
def restore_design(
    design_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    design = svc.get_design(db, current_user, active_tenant_id, design_id, write=True)
    svc.set_archived(db, current_user, design, False)
    db.commit()
    return svc.detail(db, design)


@router.delete("/{design_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_design(
    design_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Only when no level assigns it: 409 `kiosk_design_in_use` with the levels (archive it instead)."""
    design = svc.get_design(db, current_user, active_tenant_id, design_id, write=True)
    svc.delete(db, current_user, design)
    db.commit()
    return None
