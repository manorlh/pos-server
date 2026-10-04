"""
"מצב דו״ח Z" on a shop page: who produces the Zs of the shop's tills — the shop's Z run
("Z סניפי", `zMode = cloud`) or each till its own ("Z בקופה", `zMode = till`,
docs/SHIFTS_API.md §5) — set for the whole shop, or for one point of sale of it.

GET /shops/{shop_id}/z-mode → every till of the shop with its mode, and the shop's points
                              of sale
PUT /shops/{shop_id}/z-mode → `{zMode, areaId?}`: every till of the shop (or of that point
                              of sale) switched, all or nothing — the super admin's alone,
                              only with each till's shift closed and its shifts in a Z
                              (app/services/z_mode_policy.py); `409` names the till

A single till is switched on its own page (`PUT /machines/{id}`), by the same rules.
"""
from __future__ import annotations

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import printers as K
from app.services import till_z
from app.services import z_mode_policy
from app.services import z_runs as ZR

router = APIRouter(tags=["z-mode"])


class ZModeIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    z_mode: Literal["cloud", "till"] = Field(..., alias="zMode")
    #: One point of sale of the shop; absent — the whole shop.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    K.check_read(db, user, shop)
    return shop


def _out(db: Session, shop: Shop, user: User) -> dict:
    tills = sorted(ZR.shop_tills(db, shop.id), key=lambda m: (str(m.pos_number or "~"), m.name or ""))
    return {
        "shopId": str(shop.id),
        "tills": [
            {
                "machineId": str(m.id),
                "posNumber": m.pos_number,
                "name": m.name,
                "areaId": str(m.area_id) if m.area_id else None,
                "zMode": till_z.z_mode_of(m),
            }
            for m in tills
            if ZR.is_seated_in(m, shop.id)
        ],
        "areas": [{"id": str(a.id), "name": a.name} for a in K.shop_areas(db, shop.id)],
        "canEdit": user.role == UserRole.SUPER_ADMIN,
    }


@router.get("/shops/{shop_id}/z-mode")
def get_z_mode(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return _out(db, _shop(db, shop_id, current_user, active_tenant_id), current_user)


@router.put("/shops/{shop_id}/z-mode")
def put_z_mode(
    shop_id: uuid.UUID,
    body: ZModeIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    tills = [m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)]
    if body.area_id is not None:
        tills = [m for m in tills if str(m.area_id) == str(body.area_id)]
    try:
        z_mode_policy.switch_all(db, current_user, tills, body.z_mode)
    except till_z.TillZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    db.commit()
    return _out(db, shop, current_user)
