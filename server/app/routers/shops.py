import uuid as uuid_mod
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.shop import Shop
from app.models.company import Company
from app.models.product import Product, CatalogLevel
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
from app.schemas.shop import ShopCreate, ShopUpdate, ShopResponse
from app.schemas.shop_product_override import (
    ShopProductCatalogCandidate,
    ShopProductCatalogCandidateListResponse,
    ShopProductCatalogRow,
    ShopProductCatalogRowListResponse,
    ShopProductOverrideUpsert,
    ShopProductOverrideWriteResponse,
)
from app.middleware.auth import (
    get_current_user,
    get_current_distributor,
    get_active_tenant_id,
    ensure_same_tenant,
)
from app.services.catalog_notify import notify_machines_for_shop
from app.services import product_availability as availability
from app.services import general_item
from app.services.company_hierarchy import (
    ancestor_company_ids,
    company_scope_ids,
    user_covers_company,
)
from app.services.product_shop_scope import product_allowed_in_shop, reconcile_shops
from app.services.pos_user_defaults import ensure_default_pos_user
from app.services.register_number import peek_next_register_number, set_machine_shop
from app.services.settings_notify import notify_machines_for_shop_settings
from app.services.permission_matrix import SHOP_SCOPED_ROLES

router = APIRouter(prefix="/shops", tags=["shops"])

_SHOP_PROFILE_FIELDS = frozenset({"name", "branch_id", "address", "city"})


def _global_product_company_scope(db: Session, shop: Shop):
    """
    Tenant-wide catalog (company_id null), or products of the shop's company or of any
    company above it: a catalog is inherited downwards, so a holding company's product
    is one its branches sell. A sibling company's products match neither.
    """
    company_ids = [shop.company_id] + ancestor_company_ids(db, shop.company_id)
    return or_(Product.company_id.is_(None), Product.company_id.in_(company_ids))


def _global_product_allowed_for_shop(db: Session, product: Product, shop: Shop) -> bool:
    """Same tenant, and the shop's company is the product's company or beneath it."""
    return product_allowed_in_shop(db, product, shop)


def _check_shop_access(user: User, shop: Shop, db: Session):
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, shop.company_id):
        return
    if user.role in SHOP_SCOPED_ROLES and shop.id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_shop_override_write(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.CASHIER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )
    _check_shop_access(user, shop, db)


@router.get("/{shop_id}/product-overrides", response_model=ShopProductCatalogRowListResponse)
def list_shop_product_overrides(
    shop_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Paginated products **assigned** to this shop (explicit assortment), with override fields."""
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")

    base_q = (
        db.query(ShopProductOverride, Product)
        .join(Product, Product.id == ShopProductOverride.global_product_id)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            Product.tenant_id == shop.tenant_id,
            _global_product_company_scope(db, shop),
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
        )
    )
    total = base_q.count()
    page_rows = (
        base_q.order_by(Product.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # The shop's own company is the only company level consulted here (and everywhere).
    company_levels = availability.company_overrides(
        db, availability.company_level_company_id(shop), [p.id for _, p in page_rows]
    )

    items: List[ShopProductCatalogRow] = []
    for ovr, p in page_rows:
        levels = availability.resolve_rows(p, company_levels.get(str(p.id)), ovr)
        items.append(
            ShopProductCatalogRow(
                global_product_id=p.id,
                name=p.name,
                sku=p.sku,
                category_id=p.category_id,
                global_price=float(p.price),
                override_price=float(ovr.price) if ovr.price is not None else None,
                is_listed=ovr.is_listed,
                is_available=ovr.is_available,
                effective_available=levels[availability.Level.SHOP].available,
                inherited_available=levels[availability.Level.COMPANY].available,
                is_general=general_item.is_general(p),
            )
        )
    return ShopProductCatalogRowListResponse(page=page, page_size=page_size, total=total, items=items)


@router.get("/{shop_id}/product-catalog-candidates", response_model=ShopProductCatalogCandidateListResponse)
def list_shop_product_catalog_candidates(
    shop_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
    search: Optional[str] = Query(None, description="Filter by name or SKU (contains, case-insensitive)"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Global products for this shop's company (or tenant-wide) not yet assigned (library for Add)."""
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")

    assigned_ids = (
        db.query(ShopProductOverride.global_product_id)
        .filter(ShopProductOverride.shop_id == shop.id)
    )

    q = db.query(Product).filter(
        Product.tenant_id == shop.tenant_id,
        _global_product_company_scope(db, shop),
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
        ~Product.id.in_(assigned_ids),
        # A parent company's general item is not this shop's to add: its own company
        # has one (app/services/general_item.py).
        or_(Product.is_general.is_(False), Product.company_id == shop.company_id),
    )
    if search and search.strip():
        term = f"%{search.strip()}%"
        q = q.filter(or_(Product.name.ilike(term), Product.sku.ilike(term)))

    total = q.count()
    products = (
        q.order_by(Product.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return ShopProductCatalogCandidateListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=[
            ShopProductCatalogCandidate(
                global_product_id=p.id,
                name=p.name,
                sku=p.sku,
                category_id=p.category_id,
                global_price=float(p.price),
            )
            for p in products
        ],
    )


@router.post(
    "/{shop_id}/product-overrides/{global_product_id}",
    response_model=ShopProductOverrideWriteResponse,
)
def assign_shop_product(
    shop_id: str,
    global_product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Add a global product to the shop assortment (idempotent if already assigned)."""
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")

    g = db.query(Product).filter(Product.id == global_product_id).first()
    if not g or g.catalog_level != CatalogLevel.GLOBAL or g.pos_machine_id is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Global product not found")
    if not _global_product_allowed_for_shop(db, g, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in shop company")
    general_item.refuse_general_item_in_foreign_shop(g, shop)

    ovr = (
        db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            ShopProductOverride.global_product_id == g.id,
        )
        .first()
    )
    if ovr is None:
        ovr = ShopProductOverride(
            shop_id=shop.id,
            global_product_id=g.id,
            price=None,
            is_listed=True,
            is_available=None,  # not set for this shop: inherit
        )
        db.add(ovr)

    db.commit()
    db.refresh(ovr)
    notify_machines_for_shop(db, str(shop.id), reason="shop_product_assigned")

    return ShopProductOverrideWriteResponse(
        global_product_id=g.id,
        override_price=float(ovr.price) if ovr.price is not None else None,
        is_listed=ovr.is_listed,
        is_available=ovr.is_available,
    )


@router.delete(
    "/{shop_id}/product-overrides/{global_product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def unassign_shop_product(
    shop_id: str,
    global_product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Remove product from shop assortment."""
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)

    ovr = (
        db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            ShopProductOverride.global_product_id == global_product_id,
        )
        .first()
    )
    if not ovr:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment")
    general_item.refuse_general_item_unlist(
        db.query(Product).filter(Product.id == ovr.global_product_id).first()
    )

    db.delete(ovr)
    db.commit()
    notify_machines_for_shop(db, str(shop.id), reason="shop_product_unassigned")
    return None


@router.put(
    "/{shop_id}/product-overrides/{global_product_id}",
    response_model=ShopProductOverrideWriteResponse,
)
def upsert_shop_product_override(
    shop_id: str,
    global_product_id: str,
    body: ShopProductOverrideUpsert,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")

    g = db.query(Product).filter(Product.id == global_product_id).first()
    if not g or g.catalog_level != CatalogLevel.GLOBAL or g.pos_machine_id is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Global product not found")
    if not _global_product_allowed_for_shop(db, g, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in shop company")

    payload = body.model_dump(exclude_unset=True, by_alias=False)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one of price, isListed, isAvailable must be provided",
        )

    ovr = (
        db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            ShopProductOverride.global_product_id == g.id,
        )
        .first()
    )
    if ovr is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not in shop assortment — use POST to assign first",
        )

    if "is_listed" in payload and not payload["is_listed"]:
        general_item.refuse_general_item_unlist(g)

    if "price" in payload:
        ovr.price = payload["price"]
    if "is_listed" in payload:
        listed = bool(payload["is_listed"])
        if listed != ovr.is_listed and ovr.assigned_by_rule:
            # Somebody chose, by hand, whether this shop shows the product. From here
            # on the row is theirs: the product's shop scope never lists or unlists a
            # hand-managed row, so it cannot undo that choice on the next shop event.
            # A price edit alone does not do this — that is what per-shop prices are.
            ovr.assigned_by_rule = False
        ovr.is_listed = listed
    if "is_available" in payload:
        # The shop's availability level. `null` clears it back to inherit — it used to
        # be read as `bool(None)`, i.e. a lock.
        availability.set_shop_availability(ovr, payload["is_available"])

    db.commit()
    db.refresh(ovr)
    notify_machines_for_shop(db, str(shop.id), reason="shop_product_override")

    return ShopProductOverrideWriteResponse(
        global_product_id=g.id,
        override_price=float(ovr.price) if ovr.price is not None else None,
        is_listed=ovr.is_listed,
        is_available=ovr.is_available,
    )


@router.get("", response_model=List[ShopResponse])
def list_shops(
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Shop).filter(Shop.tenant_id == active_tenant_id)

    if current_user.role == UserRole.COMPANY_MANAGER:
        # The group's own shops plus every subsidiary's.
        query = query.filter(Shop.company_id.in_(company_scope_ids(db, current_user)))
    elif current_user.role in SHOP_SCOPED_ROLES:
        query = query.filter(Shop.id == current_user.shop_id)
    elif company_id:
        query = query.filter(Shop.company_id == company_id)

    return query.all()


@router.post("", response_model=ShopResponse, status_code=status.HTTP_201_CREATED)
def create_shop(
    data: ShopCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    company = db.query(Company).filter(Company.id == data.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    # Management flows downwards: a company manager opens shops in their own company or
    # a subsidiary, never in a sibling's or a parent's. Checked before anything is
    # written, because creating a shop seeds its operator and runs every product rule
    # that covers the new shop, filling it with that company's catalog.
    if current_user.role == UserRole.COMPANY_MANAGER and not user_covers_company(
        db, current_user, company.id
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    shop = Shop(
        tenant_id=active_tenant_id,
        company_id=data.company_id,
        name=data.name,
        branch_id=data.branch_id,
        address=data.address,
        city=data.city,
        is_active=data.is_active,
    )
    db.add(shop)
    # Flush to materialise shop.id, then seed the default POS user in the same transaction
    # so a shop can never exist without an operator a till can sign in as.
    db.flush()
    ensure_default_pos_user(db, shop)
    # A new shop receives every product whose "all shops of company X" rule covers it.
    # No till can be paired to it yet, so there is nobody to notify.
    reconcile_shops(db, [shop])
    db.commit()
    db.refresh(shop)
    return shop


@router.get("/{shop_id}/next-register-number")
def get_next_register_number(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The register number this shop's next till would get — for prefilling "קופה 3".

    A peek, not an allocation: nothing is locked or written, so opening a pairing
    dialog and cancelling it leaves the shop's numbering exactly as it was. The number
    is actually drawn when a machine lands in the shop, and if another till gets there
    first this one gets the next.
    """
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    return {
        "shopId": str(shop.id),
        "nextRegisterNumber": peek_next_register_number(db, shop.id),
    }


@router.get("/{shop_id}", response_model=ShopResponse)
def get_shop(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    return shop


@router.put("/{shop_id}", response_model=ShopResponse)
def update_shop(
    shop_id: str,
    data: ShopUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    # The write helper, not the read one. `_check_shop_access` admits CASHIER — correct
    # for GET, wrong here: it let a cashier rename its own shop and edit its profile.
    # `_check_shop_override_write` already existed for exactly this and was simply not
    # called on this endpoint.
    _check_shop_override_write(current_user, shop, db)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
    profile_changed = bool(_SHOP_PROFILE_FIELDS & set(updates.keys()))
    was_active, old_company_id = shop.is_active, shop.company_id
    for field, value in updates.items():
        setattr(shop, field, value)
    # Back into a rule's scope: reactivated, or (should the company ever become
    # editable here) moved to another company. `reconcile_shops` also finds the rules
    # that covered the old company, through the rows they created.
    touched = set()
    if (shop.is_active and not was_active) or str(shop.company_id) != str(old_company_id):
        touched = reconcile_shops(db, [shop])
    db.commit()
    db.refresh(shop)
    if profile_changed:
        notify_machines_for_shop_settings(db, str(shop.id), reason="shop_profile_updated")
    for touched_shop_id in touched:
        notify_machines_for_shop(db, touched_shop_id, reason="shop_scope_rule")
    return shop


@router.delete("/{shop_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shop(
    shop_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    # The ORM would null these machines' `shop_id` on its own when the shop goes; doing
    # it here instead also drops their register numbers, which mean nothing without the
    # shop. The shop's counter row goes with it (ON DELETE CASCADE).
    from app.services.shifts import refuse_leaving_shop_with_shifts

    # A till with an open shift or shifts awaiting a Z keeps its shop (409).
    for machine in list(shop.machines):
        refuse_leaving_shop_with_shifts(db, machine)
    for machine in list(shop.machines):
        set_machine_shop(db, machine, None)
    db.delete(shop)
    db.commit()
