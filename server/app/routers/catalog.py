"""
Catalog management: push global products to shops/machines.
"""
import uuid
from typing import Dict, List, Optional, Set, Union
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.product import Product, CatalogLevel
from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.pos_machine import POSMachine
from app.models.user import User, UserRole
from app.models.shop_product_override import ShopProductOverride
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.catalog_notify import notify_machine_catalog_changed

router = APIRouter(prefix="/catalog", tags=["catalog"])


# ── Request / Response schemas ──────────────────────────────────────────────

class CatalogPushTargets(BaseModel):
    shop_ids: Optional[List[uuid.UUID]] = Field(None, alias="shopIds")
    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds")

    class Config:
        populate_by_name = True


class CatalogPushRequest(BaseModel):
    """
    Push global catalog items to target shops or machines.
    product_ids / category_ids: list of UUIDs, or "all" to push everything.
    """
    product_ids: Union[List[uuid.UUID], str] = Field("all", alias="productIds")
    category_ids: Union[List[uuid.UUID], str] = Field("all", alias="categoryIds")
    targets: CatalogPushTargets

    class Config:
        populate_by_name = True


class CatalogPushResult(BaseModel):
    machines_notified: int = Field(..., alias="machinesNotified")
    products_pushed: int = Field(..., alias="productsPushed")
    categories_pushed: int = Field(..., alias="categoriesPushed")

    class Config:
        populate_by_name = True


# ── Helpers ──────────────────────────────────────────────────────────────────

def _resolve_machines(targets: CatalogPushTargets, active_tenant_id: uuid.UUID, db: Session) -> List[POSMachine]:
    """Resolve target shop_ids + machine_ids into a flat list of active machines."""
    machines: List[POSMachine] = []

    if targets.machine_ids:
        machines += db.query(POSMachine).filter(
            POSMachine.id.in_(targets.machine_ids),
            POSMachine.tenant_id == active_tenant_id,
            POSMachine.is_active.is_(True),
        ).all()

    if targets.shop_ids:
        shop_machines = db.query(POSMachine).filter(
            POSMachine.shop_id.in_(targets.shop_ids),
            POSMachine.tenant_id == active_tenant_id,
            POSMachine.is_active.is_(True),
        ).all()
        # Deduplicate
        existing_ids = {m.id for m in machines}
        machines += [m for m in shop_machines if m.id not in existing_ids]

    return machines


def _copy_product_to_machine(
    global_product: Product,
    machine: POSMachine,
    db: Session,
) -> Product:
    """
    Create (or update) a LOCAL copy of a global product for a specific machine.
    If a copy already exists it is updated in place (prices/stock synced).
    """
    existing = db.query(Product).filter(
        Product.global_product_id == global_product.id,
        Product.pos_machine_id == machine.id,
    ).first()

    if existing:
        # Refresh non-overridden fields from global
        if not existing.is_local_override:
            existing.name = global_product.name
            existing.description = global_product.description
            existing.price = global_product.price
            existing.image_url = global_product.image_url
            existing.tax_rate = global_product.tax_rate
            existing.barcode = global_product.barcode
        existing.in_stock = global_product.in_stock
        existing.stock_quantity = global_product.stock_quantity
        db.flush()
        return existing

    local = Product(
        merchant_id=global_product.merchant_id,
        company_id=global_product.company_id,
        shop_id=machine.shop_id,
        pos_machine_id=machine.id,
        category_id=global_product.category_id,
        global_product_id=global_product.id,
        catalog_level=CatalogLevel.LOCAL,
        is_local_override=False,
        name=global_product.name,
        description=global_product.description,
        price=global_product.price,
        sku=global_product.sku,
        image_url=global_product.image_url,
        in_stock=global_product.in_stock,
        stock_quantity=global_product.stock_quantity,
        barcode=global_product.barcode,
        tax_rate=global_product.tax_rate,
    )
    db.add(local)
    db.flush()
    return local


def _copy_category_to_machine(
    global_cat: Category,
    machine: POSMachine,
    db: Session,
) -> Category:
    """Create (or reuse) a LOCAL copy of a global category for a machine."""
    existing = db.query(Category).filter(
        Category.merchant_id == global_cat.merchant_id,
        Category.name == global_cat.name,
        Category.pos_machine_id == machine.id,
        Category.catalog_level == CategoryCatalogLevel.LOCAL,
    ).first()

    if existing:
        return existing

    local = Category(
        merchant_id=global_cat.merchant_id,
        company_id=global_cat.company_id,
        shop_id=machine.shop_id,
        pos_machine_id=machine.id,
        catalog_level=CategoryCatalogLevel.LOCAL,
        name=global_cat.name,
        description=global_cat.description,
        color=global_cat.color,
        image_url=global_cat.image_url,
        is_active=global_cat.is_active,
        sort_order=global_cat.sort_order,
    )
    db.add(local)
    db.flush()
    return local


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/push", response_model=CatalogPushResult)
def push_catalog(
    body: CatalogPushRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Push global catalog products/categories to one or more shops/machines.
    Creates LOCAL copies on the server and triggers an MQTT sync message
    to each affected machine.
    """
    if current_user.role not in (
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
        UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER,
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    if not body.targets.shop_ids and not body.targets.machine_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one shopId or machineId is required",
        )

    machines = _resolve_machines(body.targets, active_tenant_id, db)
    if not machines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active machines found for the given targets",
        )

    # Resolve global products
    prod_query = db.query(Product).filter(
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.tenant_id == active_tenant_id,
    )
    if current_user.role in (UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER):
        prod_query = prod_query.filter(Product.merchant_id == current_user.merchant_id)
    if isinstance(body.product_ids, list) and body.product_ids:
        prod_query = prod_query.filter(Product.id.in_(body.product_ids))
    global_products = prod_query.all()

    # Resolve global categories
    cat_query = db.query(Category).filter(
        Category.catalog_level == CategoryCatalogLevel.GLOBAL,
        Category.tenant_id == active_tenant_id,
    )
    if current_user.role in (UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER):
        cat_query = cat_query.filter(Category.merchant_id == current_user.merchant_id)
    if isinstance(body.category_ids, list) and body.category_ids:
        cat_query = cat_query.filter(Category.id.in_(body.category_ids))
    global_categories = cat_query.all()

    shop_ids_in_batch = {m.shop_id for m in machines if m.shop_id}
    shop_assigned_global_ids: Dict[uuid.UUID, Set[uuid.UUID]] = {}
    for sid in shop_ids_in_batch:
        rows = (
            db.query(ShopProductOverride.global_product_id)
            .filter(ShopProductOverride.shop_id == sid)
            .all()
        )
        shop_assigned_global_ids[sid] = {r[0] for r in rows}

    products_pushed = 0
    categories_pushed = 0

    for machine in machines:
        ensure_same_tenant(machine.tenant_id, active_tenant_id)
        for gcat in global_categories:
            _copy_category_to_machine(gcat, machine, db)
            categories_pushed += 1

        allowed = None
        if machine.shop_id:
            allowed = shop_assigned_global_ids.get(machine.shop_id, set())

        for gprod in global_products:
            if allowed is not None and gprod.id not in allowed:
                continue
            _copy_product_to_machine(gprod, machine, db)
            products_pushed += 1

    db.commit()

    for machine in machines:
        if machine.merchant_id:
            notify_machine_catalog_changed(
                str(machine.merchant_id),
                str(machine.id),
                reason="catalog_push",
            )

    return CatalogPushResult(
        machines_notified=len(machines),
        products_pushed=products_pushed // max(len(machines), 1),
        categories_pushed=categories_pushed // max(len(machines), 1),
    )
