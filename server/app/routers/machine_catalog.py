"""
A till's own catalog, from the dashboard: "all shop products" or a whitelist of them.

    GET /machines/{id}/catalog   → the till's mode, and every product of its shop with
                                   whether it is on the till's list
    PUT /machines/{id}/catalog   {"mode": "all"|"selected", "productIds": [...]}

The rule is in `app/services/machine_catalog.py`; this module checks who may read and
write, writes, and wakes the till. The till itself edits the same list through
`PUT /sync/{id}/machine-catalog` (app/routers/sync.py), on a manager's authority.

Permissions are the machine-level availability lock's, exactly
(`app/routers/product_availability.py`): the machine check (`_check_machine_access`)
*and*, to write, the assortment write check on the till's shop
(`_check_shop_override_write`); to read, shop access. Both refuse (403) before
anything is written. Every product id must be in the till's shop's catalog, which is
what keeps another company's or tenant's product off the list — a product that is not
in the shop answers 404 and nothing is written.
"""
from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    _check_machine_access,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
)
from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.schemas.machine_catalog import (
    MachineCatalogCategory,
    MachineCatalogProduct,
    MachineCatalogResponse,
    MachineCatalogSet,
)
from app.services import general_item
from app.services import machine_catalog
from app.services import product_availability as availability
from app.services import sales_channel

router = APIRouter(prefix="/machines", tags=["machine-catalog"])


def _allowed(check, *args) -> bool:
    try:
        check(*args)
    except HTTPException:
        return False
    return True


def machine_and_shop_or_error(db: Session, machine_id, active_tenant_id):
    """The till, in the caller's tenant, and the shop it stands in — or 404 / 400."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    if shop is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop"
        )
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return machine, shop


def build_picture(db: Session, machine: POSMachine, shop: Shop, can_edit: bool) -> MachineCatalogResponse:
    """Every product the shop sells — the general item aside — with its place on this till."""
    mode = machine_catalog.mode_of(machine)
    rows = [
        (ovr, p) for ovr, p in machine_catalog.shop_catalog(db, machine)
        if not general_item.is_general(p)
    ]
    ids = [p.id for _, p in rows]
    items = machine_catalog.catalog_items(db, machine.id)
    company_levels = availability.company_overrides(
        db, availability.company_level_company_id(shop), ids
    )
    area_levels = availability.area_overrides(db, machine.area_id, ids)
    machine_levels = availability.machine_overrides(db, machine.id, ids)

    products: List[MachineCatalogProduct] = []
    category_ids = set()
    for ovr, p in rows:
        key = str(p.id)
        item = items.get(key)
        included = bool(item is not None and item.is_included)
        listed = bool(ovr.is_listed) if ovr.is_listed is not None else True
        resolved = availability.resolve_rows(
            p, company_levels.get(key), ovr, machine_levels.get(key), area_row=area_levels.get(key)
        )[availability.Level.MACHINE]
        if p.category_id:
            category_ids.add(p.category_id)
        products.append(
            MachineCatalogProduct(
                product_id=p.id,
                name=p.name,
                sku=p.sku,
                barcode=p.barcode,
                price=float(ovr.price if ovr.price is not None else p.price),
                category_id=p.category_id,
                category_name=p.category.name if p.category is not None else None,
                image_url=p.image_url,
                included=included,
                shop_listed=listed,
                available=bool(listed and resolved.available),
                on_till=listed and machine_catalog.on_till(mode, included),
                sales_channel=sales_channel.out(getattr(p, "sales_channel", None)),
            )
        )

    categories: Dict[str, MachineCatalogCategory] = {}
    if category_ids:
        for c in db.query(Category).filter(Category.id.in_(list(category_ids))).all():
            categories[str(c.id)] = MachineCatalogCategory(
                id=c.id, name=c.name, sort_order=c.sort_order or 0
            )

    return MachineCatalogResponse(
        machine_id=machine.id,
        machine_name=machine.name,
        pos_number=machine.pos_number,
        shop_id=shop.id,
        shop_name=shop.name,
        mode=mode,
        mode_updated_at=machine.catalog_mode_updated_at,
        can_edit=can_edit,
        selected_count=sum(1 for p in products if p.included),
        total_count=len(products),
        products=products,
        categories=sorted(categories.values(), key=lambda c: (c.sort_order, c.name)),
    )


@router.get("/{machine_id}/catalog", response_model=MachineCatalogResponse)
def get_machine_catalog(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine, shop = machine_and_shop_or_error(db, machine_id, active_tenant_id)
    _check_machine_access(current_user, machine, db)
    _check_shop_access(current_user, shop, db)
    can_edit = _allowed(_check_shop_override_write, current_user, shop, db)
    return build_picture(db, machine, shop, can_edit)


@router.put("/{machine_id}/catalog", response_model=MachineCatalogResponse)
def set_machine_catalog(
    machine_id: str,
    body: MachineCatalogSet,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Replace the till's mode and list. Wakes the till when anything changed."""
    machine, shop = machine_and_shop_or_error(db, machine_id, active_tenant_id)
    _check_machine_access(current_user, machine, db)
    _check_shop_override_write(current_user, shop, db)
    change = apply_or_404(db, machine, body)
    db.commit()
    db.refresh(machine)
    if change.changed:
        machine_catalog.notify_change(machine)
    return build_picture(db, machine, shop, can_edit=True)


def apply_or_404(db: Session, machine: POSMachine, body: MachineCatalogSet):
    """`set_machine_catalog`, with a product outside the till's shop turned into a 404."""
    try:
        return machine_catalog.set_machine_catalog(db, machine, body.mode, body.product_ids)
    except machine_catalog.NotInShopCatalog as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "product_not_in_shop_catalog",
                "productIds": exc.product_ids[:50],
            },
        )
