import uuid as uuid_mod
from types import SimpleNamespace
from typing import Annotated, Iterable, List, Optional, Set
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.company import Company
from app.models.product import Product, CatalogLevel
from app.models.category import Category
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.voucher import Voucher
from app.models.user import User, UserRole
from app.routers.companies import _check_company_access
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.services.permission_matrix import SHOP_SCOPED_ROLES, Action, Resource, roles_for
from app.schemas.product import (
    ProductCreate,
    ProductListResponse,
    ProductResponse,
    ProductShopRow,
    ProductUpdate,
    ShopPriceIn,
    ShopScopeIn,
    ShopScopePreviewRequest,
    ShopScopePreviewResponse,
    ShopScopePreviewShop,
)
from app.middleware.auth import (
    _check_machine_access,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
)
from app.models.pos_machine import POSMachine
from app.services import general_item
from app.services import item_ticket
from app.services import product_alerts
from app.services import product_list_filters as list_filters
from app.services import product_shop_scope as scope_svc
from app.services.catalog_notify import (
    notify_all_machines_for_tenant,
    notify_machine_catalog_changed,
    notify_machines_for_shop,
)
from app.services.company_hierarchy import (
    catalog_visibility_filter,
    company_scope_ids,
    user_covers_company,
)
from app.services.product_validation import validate_open_price_update
from app.services.sku_sequence import resolve_sku_for_create
from app.services.tenant_sku_sequence import allocate_global_sku

router = APIRouter(prefix="/products", tags=["products"])

#: From the shared grid — see `app/services/permission_matrix.py`. This used to
#: be a tuple retyped in five routers, each one an edit away from disagreeing.
_CATALOG_ROLES = roles_for(Resource.CATALOG, Action.WRITE)


def _check_product_access(user: User, product: Product, db: Session):
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_company(
        db, user, product.company_id
    ):
        return
    if user.role in SHOP_SCOPED_ROLES and product.shop_id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_catalog_placement(
    db: Session,
    user: User,
    active_tenant_id,
    *,
    company_id,
    shop_id=None,
    pos_machine_id=None,
) -> None:
    """
    403 unless a new catalog row (product or category) lands inside the caller's scope.

    A new row names up to three owners — a company, a shop, a till — and each one decides
    who may see, edit or sell it afterwards. Reading an existing row is already scoped
    (`_check_product_access`, the categories router's `_check_access`); this is the same
    rule on the way in, so a manager cannot create a row in a sibling's or a parent's
    company, or put one on another company's shop or till. Tenant-wide roles are bounded
    by the tenant guard alone, as everywhere else. Call it before anything is written.
    """
    if user.role in _TENANT_WIDE_ROLES:
        return
    if company_id is not None and not user_covers_company(db, user, company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if shop_id is not None:
        shop = db.query(Shop).filter(Shop.id == shop_id).first()
        if not shop:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop not found")
        ensure_same_tenant(shop.tenant_id, active_tenant_id)
        _check_shop_access(user, shop, db)
    if pos_machine_id is not None:
        machine = db.query(POSMachine).filter(POSMachine.id == pos_machine_id).first()
        if not machine:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Machine not found")
        ensure_same_tenant(machine.tenant_id, active_tenant_id)
        _check_machine_access(user, machine, db)


def _validate_voucher_id(db: Session, voucher_id, active_tenant_id):
    if voucher_id is None:
        return
    voucher = db.query(Voucher).filter(Voucher.id == voucher_id).first()
    if not voucher:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Voucher not found")
    ensure_same_tenant(voucher.tenant_id, active_tenant_id)


def _trigger_catalog_notify(db: Session, product: Product):
    tid = str(product.tenant_id) if product.tenant_id else None
    if not tid:
        return
    if product.pos_machine_id:
        notify_machine_catalog_changed(tid, str(product.pos_machine_id), reason="product_change")
    else:
        notify_all_machines_for_tenant(db, tid, reason="product_change")


# ── Where a product is sold ──────────────────────────────────────────────────
#
# The rule itself lives in app/services/product_shop_scope.py. What is here is the HTTP
# half: validating the request, and refusing the *whole* request when it would put the
# product on a shop the caller may not write assortment for — never silently dropping
# that shop and saving the rest.

_TENANT_WIDE_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


def _require_global_catalog_product(product) -> None:
    if product.catalog_level not in (CatalogLevel.GLOBAL, "global") or product.pos_machine_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Shops can only be chosen for a global catalog product",
        )


def _validate_scope_company(db: Session, user: User, product, company_id, active_tenant_id) -> None:
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scope company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    if str(company.tenant_id) != str(product.tenant_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scope company not found")
    if user.role not in _TENANT_WIDE_ROLES and not user_covers_company(db, user, company.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Scope company is outside your companies")
    if not scope_svc.scope_company_allowed(db, product, company.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This product cannot be sold in that company's shops",
        )


def _load_explicit_shops(db: Session, product, shop_ids, active_tenant_id) -> List[Shop]:
    ids = list(shop_ids)
    if not ids:
        return []
    shops = db.query(Shop).filter(Shop.id.in_(ids)).all()
    found = {str(s.id): s for s in shops}
    missing = [str(i) for i in ids if str(i) not in found]
    if missing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop not found")
    ordered = [found[str(i)] for i in ids]
    for shop in ordered:
        ensure_same_tenant(shop.tenant_id, active_tenant_id)
        if not scope_svc.product_allowed_in_shop(db, product, shop):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Product not in shop company")
    return ordered


def _require_shop_writes(db: Session, user: User, shop_ids: Iterable) -> None:
    """403 unless the caller may write assortment for every one of these shops."""
    ids = sorted({str(i) for i in shop_ids})
    if not ids:
        return
    shops = db.query(Shop).filter(Shop.id.in_(ids)).all()
    for shop in shops:
        _check_shop_override_write(user, shop, db)


def _scope_target_shops(db: Session, product, scope: ShopScopeIn, active_tenant_id) -> List[Shop]:
    """Validate the scope's company or shops, and return the shops it would sell in."""
    if scope.mode == scope_svc.MODE_COMPANY:
        return scope_svc.shops_for_company_scope(
            db, product, scope.company_id, scope.include_subcompanies, active_only=True
        )
    return _load_explicit_shops(db, product, scope.shop_ids or [], active_tenant_id)


def _apply_shop_scope(
    db: Session, user: User, product: Product, scope: ShopScopeIn, active_tenant_id
) -> Set[str]:
    _require_global_catalog_product(product)
    if scope.mode == scope_svc.MODE_COMPANY:
        _validate_scope_company(db, user, product, scope.company_id, active_tenant_id)
    targets = _scope_target_shops(db, product, scope, active_tenant_id)

    scope_svc.set_scope_fields(product, scope.mode, scope.company_id, scope.include_subcompanies)
    plan = scope_svc.plan_scope_change(db, product, scope.mode, shop_ids=[s.id for s in targets])
    # Every shop the scope sells in, plus every shop the change would unlist.
    _require_shop_writes(db, user, {str(s.id) for s in targets} | plan.shop_ids())
    return scope_svc.execute_plan(db, product, plan)


def _apply_shop_prices(
    db: Session, user: User, product: Product, prices: List[ShopPriceIn], active_tenant_id
) -> Set[str]:
    if not prices:
        return set()
    _require_global_catalog_product(product)
    db.flush()  # rows the scope just created must be visible to the lookups below
    rows = []
    for entry in prices:
        shop = db.query(Shop).filter(Shop.id == entry.shop_id).first()
        if not shop:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop not found")
        ensure_same_tenant(shop.tenant_id, active_tenant_id)
        _check_shop_override_write(user, shop, db)
        row = (
            db.query(ShopProductOverride)
            .filter(
                ShopProductOverride.shop_id == shop.id,
                ShopProductOverride.global_product_id == product.id,
            )
            .first()
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Product is not sold in that shop",
            )
        rows.append((row, entry.price))
    for row, price in rows:
        row.price = price  # None = back to the product's base price
    return {str(row.shop_id) for row, _ in rows}


def _notify_shops(db: Session, shop_ids: Iterable[str], reason: str) -> None:
    for shop_id in shop_ids:
        notify_machines_for_shop(db, shop_id, reason=reason)


def _available_at_scope(db: Session, user: User, active_tenant_id, raw: str):
    """
    `availableAt` -> the (sold there, active there) conditions, after checking the target
    is in the tenant and within the caller's reach - the same reads the availability
    picture allows. 400 on a malformed value, 404 on a missing target, 403 out of reach.
    """
    level, _, target_id = raw.partition(":")
    if level not in list_filters.SCOPE_LEVELS or not target_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid availableAt")
    try:
        uuid_mod.UUID(target_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid availableAt")

    def _missing(what: str) -> HTTPException:
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")

    if level == "company":
        company = db.query(Company).filter(Company.id == target_id).first()
        if not company:
            raise _missing("Company")
        ensure_same_tenant(company.tenant_id, active_tenant_id)
        _check_company_access(user, company, db)
        return list_filters.scope_conditions("company", company)
    if level == "machine":
        machine = db.query(POSMachine).filter(POSMachine.id == target_id).first()
        if not machine:
            raise _missing("Machine")
        ensure_same_tenant(machine.tenant_id, active_tenant_id)
        _check_machine_access(user, machine, db)
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
        if shop is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop"
            )
        return list_filters.scope_conditions("machine", machine, shop=shop)
    if level == "area":
        area = db.query(ShopArea).filter(ShopArea.id == target_id).first()
        if not area:
            raise _missing("Area")
        ensure_same_tenant(area.tenant_id, active_tenant_id)
        shop = db.query(Shop).filter(Shop.id == area.shop_id).first()
        if not shop:
            raise _missing("Shop")
        _check_shop_access(user, shop, db)
        return list_filters.scope_conditions("area", area, shop=shop)
    shop = db.query(Shop).filter(Shop.id == target_id).first()
    if not shop:
        raise _missing("Shop")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(user, shop, db)
    return list_filters.scope_conditions("shop", shop)


@router.get("", response_model=ProductListResponse)
def list_products(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    pos_machine_id: Optional[str] = Query(None, alias="posMachineId"),
    category_id: Optional[str] = Query(None, alias="categoryId"),
    catalog_level: Optional[str] = Query(None, alias="catalogLevel"),
    in_stock: Optional[bool] = Query(None, alias="inStock"),
    search: Optional[str] = Query(None, description="Filter by name, SKU, global SKU, or barcode"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
    # Annotated, so a direct call (the tests) that leaves them out gets a plain None.
    category_ids: Annotated[
        Optional[List[str]],
        Query(alias="categoryIds", description="Any of these categories (repeat the param)"),
    ] = None,
    uncategorized: Annotated[
        Optional[bool],
        Query(description="Also (or only) products whose category no longer exists"),
    ] = None,
    product_status: Annotated[
        Optional[str],
        Query(
            alias="status",
            description='"active" / "inactive" - at `availableAt` when given, else anywhere',
        ),
    ] = None,
    available_at: Annotated[
        Optional[str],
        Query(
            alias="availableAt",
            description='"company:<id>", "shop:<id>", "area:<id>" or "machine:<id>"',
        ),
    ] = None,
):
    """
    The catalog, a page at a time. Search and filters are described in
    `app/services/product_list_filters.py`; every one of them is part of the one query.
    """
    query = db.query(Product).filter(Product.tenant_id == active_tenant_id)

    # A tenant-wide product carries no company at all, so membership alone hid every
    # global row from every merchant-side role: a shop manager authorised to edit the
    # catalog saw an empty one. Globals belong to everybody in the tenant; anything
    # company-scoped is bounded by `catalog_company_ids`, which reads *upwards* because
    # a catalog is inherited downwards.
    catalog_filter = catalog_visibility_filter(db, current_user, Product)
    if catalog_filter is not None:
        query = query.filter(catalog_filter)

    if company_id:
        query = query.filter(Product.company_id == company_id)
    if shop_id:
        query = query.filter(Product.shop_id == shop_id)
    if pos_machine_id:
        query = query.filter(Product.pos_machine_id == pos_machine_id)
    if category_id:
        query = query.filter(Product.category_id == category_id)
    if catalog_level:
        query = query.filter(Product.catalog_level == catalog_level)
    if in_stock is not None:
        query = query.filter(Product.in_stock == in_stock)
    matches = list_filters.search_condition(search)
    if matches is not None:
        query = query.filter(matches)
    in_categories = list_filters.category_condition(
        [c for c in (category_ids or []) if c], bool(uncategorized), active_tenant_id
    )
    if in_categories is not None:
        query = query.filter(in_categories)
    if product_status is not None and product_status not in list_filters.STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown status")
    scope = (
        _available_at_scope(db, current_user, active_tenant_id, available_at)
        if available_at
        else None
    )
    by_status = list_filters.status_condition(product_status, scope)
    if by_status is not None:
        query = query.filter(by_status)

    total = query.count()
    items = (
        query.order_by(Product.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return ProductListResponse(page=page, page_size=page_size, total=total, items=items)


@router.post("", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
def create_product(
    data: ProductCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    general_item.check_general_item_create(data)

    company_id = data.company_id or current_user.company_id
    # Before the SKU allocators below, which advance tenant counters.
    _check_catalog_placement(
        db,
        current_user,
        active_tenant_id,
        company_id=company_id,
        shop_id=data.shop_id,
        pos_machine_id=data.pos_machine_id,
    )

    final_sku, sku_auto_assigned = resolve_sku_for_create(db, active_tenant_id, data.sku)

    global_sku = None
    if data.catalog_level == CatalogLevel.GLOBAL or data.catalog_level == "global":
        global_sku = allocate_global_sku(db, active_tenant_id)

    category = db.query(Category).filter(Category.id == data.category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _validate_voucher_id(db, data.voucher_id, active_tenant_id)

    product = Product(
        tenant_id=active_tenant_id,
        company_id=company_id,
        shop_id=data.shop_id,
        pos_machine_id=data.pos_machine_id,
        category_id=data.category_id,
        global_product_id=data.global_product_id,
        catalog_level=data.catalog_level,
        is_local_override=False,
        name=data.name,
        description=data.description,
        price=data.price,
        sku=final_sku,
        global_sku=global_sku,
        sku_auto_assigned=sku_auto_assigned,
        image_url=data.image_url,
        in_stock=data.in_stock,
        is_available=True,
        stock_quantity=data.stock_quantity,
        barcode=data.barcode,
        tax_rate=data.tax_rate,
        voucher_id=data.voucher_id,
        ticket_mode=item_ticket.normalize(data.ticket_mode),
        ticket_entries=data.ticket_entries,
        track_stock=data.track_stock,
        is_open_price=data.is_open_price,
        is_weighed=data.is_weighed,
        unit_label=data.unit_label,
        no_discount=data.no_discount,
        # "סימוני תזונה", already cleaned by the schema (app/services/dietary.py).
        dietary_tags=data.dietary_tags or None,
        # "היכן הפריט נמכר", validated by the schema (app/services/sales_channel.py).
        sales_channel=data.sales_channel,
        # Only `ensure_general_item` makes a general item (the request cannot ask).
        is_general=False,
    )
    # An explicit id so the shop rows below can reference it before the insert.
    product.id = uuid_mod.uuid4()
    # "הודעות לעובד" / "פריטים נלווים": only what the request sent.
    product_alerts.apply(db, product, data, active_tenant_id)
    db.add(product)
    if data.shop_scope is not None:
        _apply_shop_scope(db, current_user, product, data.shop_scope, active_tenant_id)
    if data.shop_prices:
        if data.shop_scope is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="shopPrices needs shopScope on a new product",
            )
        _apply_shop_prices(db, current_user, product, data.shop_prices, active_tenant_id)
    db.commit()
    db.refresh(product)
    # Tenant-wide notify already covers every shop the scope touched.
    _trigger_catalog_notify(db, product)
    return product


@router.get("/{product_id}", response_model=ProductResponse)
def get_product(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product, db)
    return product


@router.put("/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: str,
    data: ProductUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product, db)

    if data.category_id and not db.query(Category).filter(Category.id == data.category_id).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found")

    if data.category_id:
        cat = db.query(Category).filter(Category.id == data.category_id).first()
        ensure_same_tenant(cat.tenant_id, active_tenant_id)

    if "voucher_id" in data.model_dump(exclude_unset=True, by_alias=False):
        _validate_voucher_id(db, data.voucher_id, active_tenant_id)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
    # Not columns: applied through the scope service below, after the product's own fields.
    updates.pop("shop_scope", None)
    updates.pop("shop_prices", None)
    # What the general item is stays fixed; only its echo is accepted. Checked before
    # anything is written. `is_general` itself is never written from a request.
    general_item.check_general_item_update(product, updates)
    general_item.check_general_item_scope(product, data.shop_scope)
    updates.pop("is_general", None)
    validate_open_price_update(product, updates)
    if product.sku_auto_assigned and "sku" in updates and updates["sku"] != product.sku:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot change auto-assigned SKU; create a new product or use manual SKU at create time",
        )
    if "global_sku" in updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Global SKU cannot be changed",
        )
    if "sku" in updates and updates["sku"] is not None:
        new_sku = str(updates["sku"]).strip()
        if new_sku != product.sku:
            if db.query(Product).filter(
                Product.tenant_id == product.tenant_id,
                Product.sku == new_sku,
                Product.id != product.id,
            ).first():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="SKU already exists for this tenant",
                )
        updates["sku"] = new_sku

    if "ticket_mode" in updates:
        # "inherit" is stored as NULL.
        updates["ticket_mode"] = item_ticket.normalize(updates["ticket_mode"])
    if "dietary_tags" in updates:
        # Cleaned by the schema; none at all is stored as NULL, like the allergens.
        updates["dietary_tags"] = updates["dietary_tags"] or None

    for field, value in updates.items():
        setattr(product, field, value)
    # "הודעות לעובד" / "פריטים נלווים" (not in `updates`): what the request sent, validated.
    product_alerts.apply(db, product, data, active_tenant_id)

    # The general item's scope can only be restated (checked above), and restating it
    # has nothing to apply — so it never asks for write access to every shop.
    if data.shop_scope is not None and not general_item.is_general(product):
        _apply_shop_scope(db, current_user, product, data.shop_scope, active_tenant_id)
    if data.shop_prices:
        _apply_shop_prices(db, current_user, product, data.shop_prices, active_tenant_id)

    db.commit()
    db.refresh(product)
    _trigger_catalog_notify(db, product)
    return product


@router.post("/shop-scope/preview", response_model=ShopScopePreviewResponse)
def preview_shop_scope(
    body: ShopScopePreviewRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "Will appear in 4 shops, on 11 tills" — before saving. Read-only, and refused exactly
    where the save would be, so the form cannot promise what the save would reject.
    """
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    if body.product_id is not None:
        product = db.query(Product).filter(Product.id == body.product_id).first()
        if not product:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
        ensure_same_tenant(product.tenant_id, active_tenant_id)
        _check_product_access(current_user, product, db)
        _require_global_catalog_product(product)
        # Refused where the save would refuse it.
        general_item.check_general_item_scope(product, body.shop_scope)
    else:
        # A product not created yet: the company it will be created with (see create).
        product = SimpleNamespace(
            id=None,
            tenant_id=active_tenant_id,
            company_id=body.company_id or current_user.company_id,
        )

    scope = body.shop_scope
    if scope.mode == scope_svc.MODE_COMPANY:
        _validate_scope_company(db, current_user, product, scope.company_id, active_tenant_id)
    shops = _scope_target_shops(db, product, scope, active_tenant_id)
    _require_shop_writes(db, current_user, [s.id for s in shops])

    return ShopScopePreviewResponse(
        shop_count=len(shops),
        machine_count=scope_svc.machine_count(db, [s.id for s in shops]),
        shops=[ShopScopePreviewShop(id=s.id, name=s.name, company_id=s.company_id) for s in shops],
    )


@router.get("/{product_id}/shops", response_model=List[ProductShopRow])
def list_product_shops(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Every shop this product is assigned to, listed or not, with its price there.

    A shop's price is edited with the existing
    `PUT /shops/{shopId}/product-overrides/{productId}` and body `{"price": n | null}`
    (null = back to the base price) — the same write the assortment page makes.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product, db)

    rows = (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.global_product_id == product.id)
        .all()
    )
    shop_ids = [r.shop_id for r in rows]
    shops = {str(s.id): s for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()} if shop_ids else {}
    company_ids = list({s.company_id for s in shops.values()})
    companies = (
        {str(c.id): c for c in db.query(Company).filter(Company.id.in_(company_ids)).all()}
        if company_ids
        else {}
    )

    out: List[ProductShopRow] = []
    for row in rows:
        shop = shops.get(str(row.shop_id))
        if shop is None:
            continue
        try:
            _check_shop_access(current_user, shop, db)
        except HTTPException:
            continue  # a shop outside the caller's reach is not theirs to see
        company = companies.get(str(shop.company_id))
        out.append(
            ProductShopRow(
                shop_id=shop.id,
                shop_name=shop.name,
                company_id=shop.company_id,
                company_name=company.name if company else None,
                price=float(row.price) if row.price is not None else None,
                effective_price=float(row.price if row.price is not None else product.price),
                is_listed=bool(row.is_listed),
                assigned_by_rule=bool(row.assigned_by_rule),
            )
        )
    out.sort(key=lambda r: ((r.company_name or ""), r.shop_name))
    return out


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product, db)
    general_item.refuse_general_item_delete(product)

    tenant_id = str(product.tenant_id) if product.tenant_id else None
    machine_id = str(product.pos_machine_id) if product.pos_machine_id else None

    db.delete(product)
    db.commit()

    if tenant_id:
        if machine_id:
            notify_machine_catalog_changed(tenant_id, machine_id, reason="product_deleted")
        else:
            notify_all_machines_for_tenant(db, tenant_id, reason="product_deleted")
