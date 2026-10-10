"""
"סדר תצוגה" — the one ordering editor's API for the four channels (app/services/display_ordering.py,
specs/digital-menu-ordering-cards-plan.md §5).

* `GET /display-orderings/view?channel=&level=&targetId=` — what this level shows (effective order and
  its source), its own ordering (bound, or "implicit" — read from today's keys), and "מקושר ל…".
* `PUT /display-orderings/view` — save at this level (`version` checked: 409 `ordering_changed`).
  Every level linked to the same ordering moves too; the tills' and kiosks' keys are written through.
* `POST /display-orderings/link` · `/unlink` · `/copy` — link to another level's ordering, take a copy
  of the shared one (positions unchanged), or copy another's order once.
* `DELETE /display-orderings/view?…` — back to inherit (the level's keys go too).
* `GET /display-orderings/catalog?level=&targetId=` — the categories and products the editor arranges.

The caller must reach the target (its company / shop), and write the catalog to change it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.category import Category
from app.models.product import CatalogLevel, Product
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
from app.services import display_ordering as DO
from app.services.permission_matrix import SHOP_SCOPED_ROLES, Action, Resource, roles_for

router = APIRouter(prefix="/display-orderings", tags=["display-orderings"])

_WRITE_ROLES = roles_for(Resource.CATALOG, Action.WRITE)
_TENANT_WIDE = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


class TargetIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    channel: str
    level: str
    target_id: str = Field(..., alias="targetId")


class SaveIn(TargetIn):
    version: Optional[int] = None
    ordering: Dict[str, Any]


class LinkIn(TargetIn):
    source: TargetIn


def _check_reach(db: Session, user: User, target: DO.Target) -> None:
    """403 unless the caller reaches the target (the tenant-wide roles reach every level)."""
    from app.services.company_hierarchy import user_covers_company

    if user.role in _TENANT_WIDE:
        return
    if target.level == "tenant":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if user.role == UserRole.COMPANY_MANAGER and target.company_id is not None and user_covers_company(db, user, target.company_id):
        return
    if user.role in SHOP_SCOPED_ROLES and target.shop_id is not None and str(target.shop_id) == str(user.shop_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _target(db: Session, user: User, tenant_id, channel: str, level: str, target_id: str, *, write: bool) -> DO.Target:
    if write and user.role not in _WRITE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    DO.check_channel_level(channel, level)
    target = DO.resolve_target(db, level, target_id, tenant_id)
    _check_reach(db, user, target)
    return target


def _with_catalog(db: Session, view: Dict[str, Any], target: DO.Target) -> Dict[str, Any]:
    """The view with the target's catalog and that catalog arranged in the effective order."""
    from app.services import display_ordering_rules as R

    catalog = catalog_of(db, target)
    view["catalog"] = catalog
    view["arranged"] = R.arrange(view["effective"], catalog["categories"], catalog["products"])
    return view


@router.get("/view")
def get_view(
    channel: str = Query(...),
    level: str = Query(...),
    target_id: str = Query(..., alias="targetId"),
    include_catalog: bool = Query(False, alias="includeCatalog"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, channel, level, target_id, write=False)
    view = DO.resolve_view(db, channel, target)
    return _with_catalog(db, view, target) if include_catalog else view


@router.put("/view")
def put_view(
    body: SaveIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, body.channel, body.level, body.target_id, write=True)
    wake = DO.save(db, target, body.channel, body.ordering, version=body.version, user=current_user)
    DO.wake_after_commit(db, wake)
    db.commit()
    return DO.resolve_view(db, body.channel, target)


@router.delete("/view")
def delete_view(
    channel: str = Query(...),
    level: str = Query(...),
    target_id: str = Query(..., alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, channel, level, target_id, write=True)
    DO.wake_after_commit(db, DO.clear(db, target, channel, user=current_user))
    db.commit()
    return DO.resolve_view(db, channel, target)


@router.post("/link")
def post_link(
    body: LinkIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, body.channel, body.level, body.target_id, write=True)
    source = _target(db, current_user, active_tenant_id, body.source.channel, body.source.level, body.source.target_id, write=False)
    DO.wake_after_commit(db, DO.link(db, target, body.channel, source, body.source.channel, user=current_user))
    db.commit()
    return DO.resolve_view(db, body.channel, target)


@router.post("/unlink")
def post_unlink(
    body: TargetIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, body.channel, body.level, body.target_id, write=True)
    DO.wake_after_commit(db, DO.unlink(db, target, body.channel, user=current_user))
    db.commit()
    return DO.resolve_view(db, body.channel, target)


@router.post("/copy")
def post_copy(
    body: LinkIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    target = _target(db, current_user, active_tenant_id, body.channel, body.level, body.target_id, write=True)
    source = _target(db, current_user, active_tenant_id, body.source.channel, body.source.level, body.source.target_id, write=False)
    DO.wake_after_commit(db, DO.copy_from(db, target, body.channel, source, body.source.channel, user=current_user))
    db.commit()
    return DO.resolve_view(db, body.channel, target)


@router.get("/catalog")
def get_catalog(
    level: str = Query(...),
    target_id: str = Query(..., alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The categories and products the editor arranges at this target (a shop's own assortment below the company)."""
    target = DO.resolve_target(db, level, target_id, active_tenant_id)
    _check_reach(db, current_user, target)
    return catalog_of(db, target)


def catalog_of(db: Session, target: DO.Target) -> Dict[str, Any]:
    q = db.query(Product).filter(
        Product.tenant_id == target.tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
    )
    if target.shop_id is not None:
        q = q.join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id).filter(
            ShopProductOverride.shop_id == target.shop_id,
        )
    products = q.order_by(Product.name).limit(5000).all()
    cat_ids = {p.category_id for p in products if p.category_id is not None}
    categories = (
        db.query(Category).filter(Category.id.in_(list(cat_ids))).all() if cat_ids else []
    )
    out_categories: List[Dict[str, Any]] = [
        {"id": str(c.id), "name": c.name, "sortOrder": c.sort_order or 0, "parentId": str(c.parent_id) if c.parent_id else None}
        for c in sorted(categories, key=lambda c: (c.sort_order or 0, c.name or "", str(c.id)))
    ]
    return {
        "categories": out_categories,
        "products": [
            {
                "id": str(p.id), "name": p.name, "categoryId": str(p.category_id) if p.category_id else None,
                "price": float(p.price) if p.price is not None else None, "imageUrl": p.image_url,
            }
            for p in products
        ],
    }
