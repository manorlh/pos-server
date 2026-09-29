"""
Shop areas from the dashboard (docs/AREAS_API.md §2.1).

Reading a shop's areas takes whatever reading the shop takes (`_check_shop_access`).
Writing one — and seating tills in it — takes whatever `PUT /shops/{id}` takes
(`_check_shop_override_write`): an area is part of how a shop is set up, not a new
thing to hand a role.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.schemas.area import AreaCreate, AreaMembershipIn, AreaOut, AreaUpdate
from app.services import areas as A

router = APIRouter(tags=["areas"])


def _shop(db: Session, shop_id: uuid.UUID, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _area_for_write(db: Session, area_id: uuid.UUID, user: User, tenant_id) -> ShopArea:
    area = A.get_area(db, area_id)
    if area is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
    ensure_same_tenant(area.tenant_id, tenant_id)
    _check_shop_override_write(user, _shop(db, area.shop_id, tenant_id), db)
    return area


@router.get(
    "/shops/{shop_id}/areas",
    response_model=list[AreaOut],
    response_model_by_alias=True,
)
def list_shop_areas(
    shop_id: uuid.UUID,
    include_archived: bool = Query(False, alias="includeArchived"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's areas by `sortOrder, name`, each with its tills and status roll-up."""
    shop = _shop(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    return A.areas_out(db, A.shop_areas(db, shop.id, include_archived=include_archived))


@router.post(
    "/shops/{shop_id}/areas",
    response_model=AreaOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def create_shop_area(
    shop_id: uuid.UUID,
    body: AreaCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """`409 area_name_taken` when a live area of the shop has the name, in any case."""
    shop = _shop(db, shop_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)
    area = A.create_area(db, shop, name=body.name, sort_order=body.sort_order)
    db.commit()
    db.refresh(area)
    return A.area_out(db, area)


@router.patch("/areas/{area_id}", response_model=AreaOut, response_model_by_alias=True)
def update_shop_area(
    area_id: uuid.UUID,
    body: AreaUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Rename / reorder. `409 area_name_taken`; `409 area_archived` for a rename."""
    area = _area_for_write(db, area_id, current_user, active_tenant_id)
    renamed = A.update_area(db, area, name=body.name, sort_order=body.sort_order)
    tills = A.area_tills(db, area.id) if renamed else []
    db.commit()
    db.refresh(area)
    # The tills show the area's name: each refetches its settings to learn the new one.
    A.notify_tills(tills)
    return A.area_out(db, area)


@router.post("/areas/{area_id}/archive", response_model=AreaOut, response_model_by_alias=True)
def archive_shop_area(
    area_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Idempotent. `409 area_has_machines` while an active till is in it."""
    area = _area_for_write(db, area_id, current_user, active_tenant_id)
    A.archive_area(db, area)
    db.commit()
    db.refresh(area)
    return A.area_out(db, area)


@router.post("/areas/{area_id}/restore", response_model=AreaOut, response_model_by_alias=True)
def restore_shop_area(
    area_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Idempotent. `409 area_name_taken` when a live area took the name meanwhile."""
    area = _area_for_write(db, area_id, current_user, active_tenant_id)
    A.restore_area(db, area)
    db.commit()
    db.refresh(area)
    return A.area_out(db, area)


@router.put("/areas/{area_id}/machines", response_model=AreaOut, response_model_by_alias=True)
def set_area_machines(
    area_id: uuid.UUID,
    body: AreaMembershipIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The area's tills become exactly `machineIds`; tills left out become unassigned.

    `400 machine_not_in_shop:<id>` for anything that is not an active till of the area's
    shop (nothing is changed then), `409 area_archived`.
    """
    area = _area_for_write(db, area_id, current_user, active_tenant_id)
    changed = A.set_membership(db, area, body.machine_ids)
    db.commit()
    db.refresh(area)
    A.notify_tills(changed)
    return A.area_out(db, area)
