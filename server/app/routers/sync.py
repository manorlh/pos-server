"""
REST sync endpoint — used by POS as HTTP fallback when MQTT is unavailable.

GET  /sync/{machine_id}/catalog?since=ISO_TS   → full or delta catalog
POST /sync/{machine_id}/catalog                → retired (410); see `post_catalog_changes`
PUT  /sync/{machine_id}/machine-catalog        → the till's own mode and list, on a
                                                 manager's authority
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ELEVATION_HEADER,
    CatalogActor,
    elevation_if_offered,
    get_pos_machine_for_sync_path,
    get_pos_machine_from_sync_machine_token,
    require_catalog_authority,
)
from app.models.elevated_session import ElevatedSession
from app.models.shop_product_override import ShopProductOverride
from app.models.shop_category_override import ShopCategoryOverride
from app.services.permissions import Scope
from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.services.elevation import consume_per_action_use
from app.models.pos_user import PosUser
from app.models.product import Product, CatalogLevel
from app.models.sync_log import SyncLog, SyncAction, SyncDirection, SyncEntityType, SyncStatus
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate
from app.schemas.pos_user import PosUsersSyncResponse, PosUserSyncRow
from app.schemas.pos_settings import SettingsSyncResponse
from app.schemas.stock import StockLevelOut, StockSyncResponse
from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.services.settings_merge import (
    MANAGED_SETTING_KEYS,
    build_business_info,
    effective_settings_updated_at,
    merge_all_settings_layers,
)
from app.services.payment_options import legacy_tip_flags, resolve_payment_options
from app.services.sell_screen import resolve_sell_screen
from app.services import general_item
from app.schemas.transaction import (
    TransactionsBatchEnvelope,
    TransactionsBatchResponse,
)
from app.schemas.shift import (
    LastClosedShift,
    ShiftCloseAckIn,
    ShiftCloseAckResponse,
    ShiftCloseIn,
    ShiftCloseResponse,
    ShiftMissingResponse,
    ShiftOpenIn,
    ShiftOut,
)
from app.services.catalog_notify import notify_all_machines_for_tenant, notify_machines_for_shop
from app.services import product_availability as availability
from app.services.product_validation import validate_open_price_update
from app.services.sku_sequence import resolve_sku_for_create
from app.services.tenant_sku_sequence import allocate_global_sku
from app.services.sync import (
    get_categories_for_sync,
    get_customers_for_sync,
    get_products_for_sync,
    get_vouchers_for_sync,
    merge_categories_referenced_by_products,
    merge_vouchers_referenced_by_products,
    machine_catalog_for_sync,
    update_machine_sync_timestamp,
)
from app.services import machine_catalog
from app.schemas.machine_catalog import MachineCatalogSet, MachineCatalogWriteResponse
from app.services.transactions import (
    publish_transactions_synced,
    upsert_transactions,
    validate_documents,
)
from app.services.shifts import (
    ShiftConflict,
    ShiftUnknown,
    apply_shift_close,
    check_close_preconditions,
    last_closed_shift,
    refuse_foreign_shift,
    report_shift_open,
    shift_to_out,
    shift_totals_out,
    z_number_of,
)
from app.services.remote_close import apply_close_shift_ack, on_shift_close_accepted
from app.services.stock import effective_stock_updated_at, get_levels_for_shop

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sync", tags=["sync"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CatalogSyncResponse(BaseModel):
    sync_type: str = Field(..., alias="syncType")
    server_time: str = Field(..., alias="serverTime")
    products: List[Dict[str, Any]]
    categories: List[Dict[str, Any]]
    vouchers: List[Dict[str, Any]] = Field(default_factory=list)
    # Business customers, so the till can put a name and a ח.פ. on a חשבונית מס.
    # Defaulted rather than required: an older till build ignores the key, and this
    # response is also produced for machines with no tenant resolved at all.
    customers: List[Dict[str, Any]] = Field(default_factory=list)
    # The till's own catalog mode — "all" or "selected" — sent on every pull, full or
    # delta. The product rows carry `inMachineCatalog`; this says how to apply it. An
    # older till ignores both and keeps selling the shop's whole catalog.
    machine_catalog: Optional[Dict[str, Any]] = Field(None, alias="machineCatalog")

    class Config:
        populate_by_name = True


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_assigned_machine(machine: POSMachine) -> None:
    if not machine.shop_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a shop",
        )
    if not machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine tenant context required",
        )


def _ensure_shop_general_item(db: Session, machine: POSMachine) -> None:
    """
    Safety net: the till's calculator needs its company's general item.

    Every company gets one when it is created, and migration e7f8a9b0c1d2 made one for
    every company before that — but a company created by the previous build while the
    migration and the deploy were a minute apart would have none, and its calculator
    would have nothing to sell through. So the catalog pull makes sure, before building
    the payload, so the item is in this very response. One indexed lookup when it
    exists, which is every time but the first.

    Never fails the pull: another till of the same company creating it at the same
    moment meets the unique index, and this one simply rolls back and carries on.
    """
    if not machine.shop_id:
        return
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is None or shop.company_id is None:
        return
    company = db.query(Company).filter(Company.id == shop.company_id).first()
    try:
        ensured = general_item.ensure_general_item(db, company)
        if not ensured.created:
            return
        db.commit()
    except IntegrityError:
        db.rollback()
        return
    logger.warning(
        "general item was missing and was created at catalog pull company_id=%s machine_id=%s",
        shop.company_id,
        machine.id,
    )
    # The other tills of these shops; this one gets it in the response it is pulling.
    for shop_id in ensured.shop_ids:
        notify_machines_for_shop(db, shop_id, reason="general_item_created")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{machine_id}/catalog", response_model=CatalogSyncResponse)
def get_catalog_sync(
    machine_id: str,
    since: Optional[str] = Query(None, description="ISO-8601 timestamp for delta sync"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Return the full or delta catalog for a machine.
    POS calls this after MQTT catalog/notify (or on connect). Pass `since` for delta sync.
    Authenticate with machine JWT or dashboard user JWT.
    """

    since_dt: Optional[datetime] = None
    sync_type = "full"
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            sync_type = "delta"
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid 'since' timestamp")

    tid = str(machine.tenant_id) if machine.tenant_id else None
    mqid = str(machine.id)

    _ensure_shop_general_item(db, machine)
    products = get_products_for_sync(db, tid, mqid, since=since_dt)
    categories = get_categories_for_sync(db, tid, mqid, since=since_dt)
    vouchers = get_vouchers_for_sync(db, tid, since=since_dt)
    # Same `since` semantics as everything else in this payload: on a delta pull only
    # customers touched after `since` come back. Unlike products there is no merge
    # step, because nothing in the payload references a customer by id — a customer is
    # attached to a *document*, which travels the other way.
    customers = get_customers_for_sync(db, tid, since=since_dt)
    if since_dt and products:
        categories = merge_categories_referenced_by_products(db, machine, products, categories)
        vouchers = merge_vouchers_referenced_by_products(db, products, vouchers)

    update_machine_sync_timestamp(db, mqid)

    return CatalogSyncResponse(
        sync_type=sync_type,
        server_time=datetime.now(timezone.utc).isoformat(),
        products=products,
        categories=categories,
        vouchers=vouchers,
        customers=customers,
        machine_catalog=machine_catalog_for_sync(machine),
    )


@router.post("/{machine_id}/catalog", status_code=status.HTTP_410_GONE)
def post_catalog_changes(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
):
    """
    Retired. Catalog changes from a till go through the per-entity endpoints below.

    This was the original batch upload, and it wrote with nothing but a machine token:
    it looked products and categories up by id **with no tenant check**, so any paired
    till could rename, reprice or delete any tenant's catalog by guessing or harvesting
    an id. Neither client calls it — the Android till only ever GETs this path, and the
    desktop POS refuses to queue catalog writes at all — so it is closed rather than
    repaired: a second write path beside the guarded ones is a second thing to keep
    guarded. Still authenticates, so an unpaired caller gets the usual 401/403 and a
    paired one learns the path is gone rather than that it is forbidden.
    """
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="catalog_batch_retired")


# ── Catalog editing from the till ─────────────────────────────────────────────
#
# These endpoints used to take a machine token and nothing else, and to write
# tenant-wide GLOBAL rows: a till in one shop could rename, reprice or delete a
# product belonging to a different company in the same tenant, and every write was
# pushed to every till. Nothing in the shipped Android app ever called them.
#
# They now require two credentials — the machine token says which till, an
# `X-Elevation-Token` grant says which manager authorised it — and they write at
# *shop* scope:
#
#   * a new product becomes a tenant master **plus an assortment row for this
#     shop**, so it is listed exactly where it was created. (Without that row the
#     catalog sync would not serve it back, so a product created from a till was
#     previously invisible on the till that created it.)
#   * price and availability changes write this shop's `shop_product_overrides`
#     row and never touch the master, so one shop cannot reprice the chain.
#   * the master's own fields — name, barcode, category — may only be edited when
#     the product is listed in this shop and nowhere else, i.e. when it is
#     effectively this shop's own item.
#   * "delete" unlists from this shop. The master survives, which is both the right
#     meaning ("take it off my till", not "erase it from the chain") and the only
#     safe one: `transaction_items.product_id` is a foreign key with no ON DELETE,
#     so removing a product that has ever been sold raises IntegrityError.
#
# Categories have no shop tier at all — `get_categories_for_sync` serves tenant
# globals to any machine with a shop — so a till may add one, but may only rename
# or remove one whose products all belong to this shop alone.


def _audit(
    db: Session,
    *,
    machine: POSMachine,
    actor: CatalogActor,
    entity: SyncEntityType,
    action: SyncAction,
    entity_id,
    note: Optional[str] = None,
) -> None:
    """Record who did this, not only which till it came from."""
    db.add(
        SyncLog(
            machine_id=machine.id,
            actor_user_id=actor.user_id,
            actor_pos_user_id=actor.pos_user_id,
            direction=SyncDirection.POS_TO_SERVER,
            entity_type=entity,
            entity_id=entity_id,
            action=action,
            status=SyncStatus.SUCCESS,
            conflict_note=note,
        )
    )


def _shop_or_400(db: Session, machine: POSMachine) -> Shop:
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a shop",
        )
    return shop


def _listed_shop_ids(db: Session, product_id) -> List[Any]:
    rows = (
        db.query(ShopProductOverride.shop_id)
        .filter(
            ShopProductOverride.global_product_id == product_id,
            ShopProductOverride.is_listed.is_(True),
        )
        .all()
    )
    return [r[0] for r in rows]


def _product_belongs_only_to(db: Session, product: Product, shop_id) -> bool:
    """
    Is this product listed in `shop_id` and nowhere else?

    The test for "this shop's own item". A product listed in no shop at all fails
    it deliberately: an unlisted master is still chain data, and editing it from one
    till is not obviously that shop's business.
    """
    listed = {str(s) for s in _listed_shop_ids(db, product.id)}
    return listed == {str(shop_id)}


def _override_for(db: Session, shop_id, product_id) -> Optional[ShopProductOverride]:
    return (
        db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id == shop_id,
            ShopProductOverride.global_product_id == product_id,
        )
        .first()
    )


#: The one category field with a shop-level meaning. See `machine_update_cloud_category`.
_CATEGORY_OVERRIDE_FIELDS = {"name"}


#: Fields a till may change on *any* product listed in its shop. They map onto the
#: assortment row, so they change what this shop sells and charges without touching
#: what anyone else does.
_OVERRIDE_FIELDS = {"price", "is_available", "is_listed"}


def _machine_editable_product(db: Session, machine: POSMachine, product_id: str) -> Product:
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    if not machine.tenant_id or product.tenant_id != machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Product not in machine tenant"
        )
    if product.pos_machine_id is not None and str(product.pos_machine_id) != str(machine.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Product belongs to another terminal",
        )
    return product


@router.post(
    "/{machine_id}/products",
    response_model=ProductResponse,
    status_code=status.HTTP_201_CREATED,
)
def machine_create_cloud_product(
    machine_id: str,
    data: ProductCreate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """Create a product from the till, listed in the till's own shop."""
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    general_item.check_general_item_create(data)

    final_sku, sku_auto_assigned = resolve_sku_for_create(db, machine.tenant_id, data.sku)
    global_sku = allocate_global_sku(db, machine.tenant_id)

    cat = db.query(Category).filter(Category.id == data.category_id).first()
    if not cat or cat.tenant_id != machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category not found for this tenant",
        )

    product = Product(
        tenant_id=machine.tenant_id,
        # Derived from the till's own shop, never read from the request body: a
        # machine token must not let the caller choose whose catalog it writes into.
        company_id=shop.company_id,
        shop_id=None,
        pos_machine_id=None,
        category_id=data.category_id,
        global_product_id=None,
        catalog_level=CatalogLevel.GLOBAL,
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
        is_open_price=data.is_open_price,
        is_weighed=data.is_weighed,
        unit_label=data.unit_label,
        # Only `ensure_general_item` makes a general item (the request cannot ask).
        is_general=False,
    )
    db.add(product)
    db.flush()

    # The assortment row is what makes it appear on the till that just created it.
    db.add(
        ShopProductOverride(
            shop_id=shop.id,
            global_product_id=product.id,
            price=None,
            is_listed=True,
            # Not set for this shop: the product's own flag (true) decides, until the
            # company, the shop or a till sets something.
            is_available=None,
        )
    )
    # A till selling only its own list would hide the product from the manager who
    # just created it there. The shop's other "selected" tills are not touched: a
    # product new to the shop is not added to anyone else's list.
    machine_catalog.include_product(db, machine, product)
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.CREATE,
        entity_id=product.id,
    )
    db.commit()
    db.refresh(product)
    notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="product_created")
    return product


@router.put("/{machine_id}/products/{product_id}", response_model=ProductResponse)
def machine_update_cloud_product(
    machine_id: str,
    product_id: str,
    data: ProductUpdate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Change a product from the till.

    Price and availability land on this shop's assortment row. Anything else is a
    change to the chain's master record, so it is allowed only for a product this
    shop alone lists.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    product = _machine_editable_product(db, machine, product_id)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
    # The general item's fixed fields, checked whoever may edit the rest of it. The
    # flag itself is never written from a request, so an echo of it is dropped here
    # rather than counted as a change to the chain's master record.
    general_item.check_general_item_update(product, updates)
    updates.pop("is_general", None)
    if "is_listed" in updates and not updates["is_listed"]:
        general_item.refuse_general_item_unlist(product)
    master_fields = {k: v for k, v in updates.items() if k not in _OVERRIDE_FIELDS}
    override_fields = {k: v for k, v in updates.items() if k in _OVERRIDE_FIELDS}

    if master_fields and not _product_belongs_only_to(db, product, shop.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="shared_product_master_readonly",
        )

    if master_fields:
        if master_fields.get("category_id") and not db.query(Category).filter(
            Category.id == master_fields["category_id"]
        ).first():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found"
            )
        validate_open_price_update(product, master_fields)
        for field, value in master_fields.items():
            setattr(product, field, value)

    if override_fields:
        override = _override_for(db, shop.id, product.id)
        if override is None:
            # Never a row for another company's general item: this shop has its own.
            general_item.refuse_general_item_in_foreign_shop(product, shop)
            override = ShopProductOverride(
                shop_id=shop.id,
                global_product_id=product.id,
                is_listed=True,
                is_available=None,
            )
            db.add(override)
        for field, value in override_fields.items():
            if field == "is_available":
                # The shop level, tri-state: true = available here even if the company
                # locked it, false = locked here, null = back to inherit.
                availability.set_shop_availability(override, value)
            else:
                setattr(override, field, value)

    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.UPDATE,
        entity_id=product.id,
        note="master" if master_fields else "shop_override",
    )
    db.commit()
    db.refresh(product)
    notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="product_updated")
    return product


@router.delete("/{machine_id}/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def machine_delete_cloud_product(
    machine_id: str,
    product_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Take a product off this shop's tills.

    Unlists rather than deletes. The master row is chain data and may be referenced
    by issued invoices — `transaction_items.product_id` has no ON DELETE, so a hard
    delete of anything ever sold raises IntegrityError rather than removing it.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    product = _machine_editable_product(db, machine, product_id)
    general_item.refuse_general_item_delete(product)

    override = _override_for(db, shop.id, product.id)
    if override is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Product not listed in this shop"
        )
    override.is_listed = False
    db.add(override)

    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.DELETE,
        entity_id=product.id,
        note="unlisted_from_shop",
    )
    db.commit()
    notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="product_deleted")
    return None


@router.put("/{machine_id}/machine-catalog", response_model=MachineCatalogWriteResponse)
def machine_set_own_catalog(
    machine_id: str,
    body: MachineCatalogSet,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    The till's own mode and list, from its manager screen.

    The same write as the dashboard's `PUT /machines/{id}/catalog` and the same rule:
    every id must be a product this till's shop sells, else 404 and nothing is written.
    The authority is a catalog grant or a signed-in operator who holds it, like every
    other catalog write from a till; a cashier's till gets 401 `elevation_required`.
    A till only ever writes its own list — the path's machine is the token's.

    Online only. The till does not queue this: the cloud is the source of truth and a
    queued list replayed later would overwrite whatever the dashboard set meanwhile.
    """
    _require_assigned_machine(machine)
    _shop_or_400(db, machine)
    try:
        change = machine_catalog.set_machine_catalog(db, machine, body.mode, body.product_ids)
    except machine_catalog.NotInShopCatalog as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "product_not_in_shop_catalog", "productIds": exc.product_ids[:50]},
        )
    if change.changed:
        _audit(
            db,
            machine=machine,
            actor=actor,
            entity=SyncEntityType.PRODUCTS,
            action=SyncAction.UPDATE,
            entity_id=None,
            note=f"machine_catalog mode={body.mode} +{len(change.added)} -{len(change.removed)}",
        )
    db.commit()
    db.refresh(machine)
    if change.changed:
        machine_catalog.notify_change(machine)
    return MachineCatalogWriteResponse(
        mode=machine_catalog.mode_of(machine),
        selected_count=len(machine_catalog.included_ids(db, machine.id)),
        changed=change.changed,
    )


def _category_belongs_only_to(db: Session, category: Category, shop_id) -> bool:
    """True when every product in this category is listed by this shop alone."""
    products = db.query(Product).filter(Product.category_id == category.id).all()
    for product in products:
        if not _product_belongs_only_to(db, product, shop_id):
            return False
    return True


def _machine_editable_category(db: Session, machine: POSMachine, category_id: str) -> Category:
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    if not machine.tenant_id or category.tenant_id != machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Category not in machine tenant"
        )
    if category.pos_machine_id is not None and str(category.pos_machine_id) != str(machine.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category belongs to another terminal",
        )
    return category


@router.post(
    "/{machine_id}/categories",
    response_model=CategoryResponse,
    status_code=status.HTTP_201_CREATED,
)
def machine_create_cloud_category(
    machine_id: str,
    data: CategoryCreate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Add a category from the till.

    Tenant-wide, because `get_categories_for_sync` serves tenant globals to every
    machine that has a shop — there is no shop tier for categories to live in. That
    is acceptable for *adding* one (additive, and invisible until something is filed
    under it) but not for renaming one, which is why the edit path is narrower.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)

    if data.parent_id:
        parent = db.query(Category).filter(Category.id == data.parent_id).first()
        if not parent or parent.tenant_id != machine.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Parent category not found for this tenant",
            )

    category = Category(
        tenant_id=machine.tenant_id,
        company_id=shop.company_id,
        shop_id=None,
        pos_machine_id=None,
        catalog_level=CategoryCatalogLevel.GLOBAL,
        name=data.name,
        description=data.description,
        color=data.color,
        image_url=data.image_url,
        parent_id=data.parent_id,
        is_active=data.is_active,
        sort_order=data.sort_order,
    )
    db.add(category)
    db.flush()
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.CATEGORIES,
        action=SyncAction.CREATE,
        entity_id=category.id,
    )
    db.commit()
    db.refresh(category)
    notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="category_created")
    return category


@router.put("/{machine_id}/categories/{category_id}", response_model=CategoryResponse)
def machine_update_cloud_category(
    machine_id: str,
    category_id: str,
    data: CategoryUpdate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Rename a category *for this shop*.

    A category has no shop tier — `get_categories_for_sync` hands every tenant category
    to every till with a shop — so writing the category row renamed it on every till in
    the tenant. The old guard, "every product in it is listed only here", did not stop
    that: it was vacuously true for an empty category, which is exactly the one a shop
    is most likely to be tidying, and even when it held, the other tills still showed
    the new name.

    So a rename from a till lands on this shop's `shop_category_overrides` row, the way
    a till's price change lands on its `shop_product_overrides` row, and the tenant
    category is never written. Renaming back to the tenant's own name clears the
    override rather than storing a copy that would silently stop following a later
    rename from the dashboard. Every other field is tenant-wide display data with no
    shop-level meaning, and stays the dashboard's to change.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    category = _machine_editable_category(db, machine, category_id)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
    tenant_fields = sorted(k for k in updates if k not in _CATEGORY_OVERRIDE_FIELDS)
    if tenant_fields:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="shared_category_readonly"
        )

    override = (
        db.query(ShopCategoryOverride)
        .filter(
            ShopCategoryOverride.shop_id == shop.id,
            ShopCategoryOverride.category_id == category.id,
        )
        .first()
    )
    if "name" in updates:
        name = (updates["name"] or "").strip()
        if override is None:
            override = ShopCategoryOverride(shop_id=shop.id, category_id=category.id)
            db.add(override)
        override.name = None if name == category.name else name
        # Set explicitly: `onupdate` does not fire on an INSERT, and the till's delta
        # pull finds this change by this timestamp and nothing else.
        override.updated_at = datetime.now(timezone.utc)

    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.CATEGORIES,
        action=SyncAction.UPDATE,
        entity_id=category.id,
        note="shop_override",
    )
    db.commit()
    db.refresh(category)
    # This shop's tills only: no other shop's button changed.
    notify_machines_for_shop(db, str(shop.id), reason="category_updated")

    response = CategoryResponse.model_validate(category)
    if override is not None and override.name:
        response.name = override.name
    return response


@router.delete("/{machine_id}/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def machine_delete_cloud_category(
    machine_id: str,
    category_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    category = _machine_editable_category(db, machine, category_id)

    if not _category_belongs_only_to(db, category, shop.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="shared_category_readonly"
        )
    if db.query(Product).filter(Product.category_id == category_id).count():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Category has associated products",
        )

    tid = str(category.tenant_id)
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.CATEGORIES,
        action=SyncAction.DELETE,
        entity_id=category.id,
    )
    db.delete(category)
    db.commit()
    notify_all_machines_for_tenant(db, tid, reason="category_deleted")
    return None


# ── Transactions (POS → server) ────────────────────────────────────

@router.post(
    "/{machine_id}/transactions",
    response_model=TransactionsBatchResponse,
    status_code=status.HTTP_200_OK,
)
def post_transactions(
    machine_id: str,
    body: TransactionsBatchEnvelope,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Idempotent transactions upsert. Same id retried returns status='duplicate'.

    Each document is validated on its own: one the model refuses is answered
    `rejected` with the field and the message, and stored nowhere, while the rest of
    the batch is written. Only a malformed envelope is a 422.

    409 `another_shift_open` for the whole batch, with nothing written, when a document
    names a shift the cloud cannot accept yet (docs/SHIFTS_API.md §1.2).
    """
    _require_assigned_machine(machine)

    valid, refused, unidentified = validate_documents(body.transactions)
    try:
        upserted = upsert_transactions(db, machine, [tx for _i, tx in valid])
    except ShiftConflict as conflict:
        db.rollback()
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=conflict.body())
    # In the order the till sent them.
    results = [
        r for _i, r in sorted(
            [(i, r) for (i, _tx), r in zip(valid, upserted)] + refused, key=lambda pair: pair[0]
        )
    ]

    accepted_count = sum(1 for r in results if r.status == "accepted")
    db.bulk_save_objects([
        SyncLog(
            machine_id=machine.id,
            direction=SyncDirection.POS_TO_SERVER,
            entity_type=SyncEntityType.TRANSACTIONS,
            entity_id=r.id if isinstance(r.id, uuid.UUID) else None,
            action=SyncAction.CREATE if r.status == "accepted" else SyncAction.UPDATE,
            status=SyncStatus.SUCCESS if r.status != "rejected" else SyncStatus.FAILED,
            conflict_note=(
                r.reason if isinstance(r.id, uuid.UUID) or r.reason is None
                else f"id {r.id!r}: {r.reason}"
            ),
        )
        for r in results
    ] + [
        SyncLog(
            machine_id=machine.id,
            direction=SyncDirection.POS_TO_SERVER,
            entity_type=SyncEntityType.TRANSACTIONS,
            entity_id=None,
            action=SyncAction.CREATE,
            status=SyncStatus.FAILED,
            conflict_note=f"batch index {u.index}: {u.reason}",
        )
        for u in unidentified
    ])
    db.commit()

    if accepted_count > 0:
        publish_transactions_synced(machine.tenant_id, machine.id, accepted_count)

    return TransactionsBatchResponse(
        server_time=datetime.now(timezone.utc),
        results=results,
        unidentified=unidentified or None,
    )


# ── Shifts (POS → server) ─────────────────────────────────────────────────────
#
# The till opens and closes shifts; the cloud records them and recomputes each X from
# the documents it holds. Closing a shift files no Z — a Z is built in the cloud over
# closed shifts (`app/routers/z_runs.py`). Contract: docs/SHIFTS_API.md §1.


@router.post("/{machine_id}/shifts", response_model=ShiftOut, response_model_by_alias=True)
def post_shift_open(
    machine_id: str,
    data: ShiftOpenIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Record a shift the till has already opened. Idempotent by id.

    409 `another_shift_open:<id>` while the cloud still has another shift of this till
    open — with an ordered outbox that means the previous close has not arrived yet.
    """
    _require_assigned_machine(machine)
    shift = report_shift_open(db, machine, data)
    db.commit()
    db.refresh(shift)
    return shift_to_out(shift, z_number=z_number_of(db, shift))


@router.get(
    "/{machine_id}/shifts/last-closed",
    response_model=LastClosedShift,
    response_model_by_alias=True,
)
def get_last_closed_shift(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The till's last closed shift, to prefill the next opening float. All null if none."""
    return last_closed_shift(db, machine.id)


@router.post(
    "/{machine_id}/shifts/{shift_id}/close",
    status_code=status.HTTP_200_OK,
    responses={409: {"model": ShiftMissingResponse}, 200: {"model": ShiftCloseResponse}},
)
def post_shift_close(
    machine_id: str,
    shift_id: uuid.UUID,
    body: ShiftCloseIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    approval: Optional[ElevatedSession] = Depends(elevation_if_offered(Scope.SHIFT_CLOSE)),
    db: Session = Depends(get_db),
):
    """
    Close a shift. Accepted only when every listed document is on the cloud (409 with
    `missingIds`/`staleIds` otherwise — push them and retry). The X is recomputed from
    the documents; the till's own figures are stored and compared. Creates no Z.

    Elevation is accepted, never demanded: a cashier may close a shift alone. A grant
    that is presented is checked strictly and spent only once the close is certain.
    """
    _require_assigned_machine(machine)

    # Before the missing-ids check: another till's shift is a 403 whatever the till
    # lists — its documents are not this till's, so the 409 loop could never end.
    refuse_foreign_shift(db, machine, shift_id)

    missing, stale = check_close_preconditions(db, machine, shift_id, body.transaction_ids)
    if missing or stale:
        # Before the grant is spent: a 409 means "push those and come straight back".
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=ShiftMissingResponse(
                missing_ids=missing, stale_ids=stale
            ).model_dump(by_alias=True, mode="json"),
        )

    approved_by = None
    approved_by_pos_user = None
    if approval is not None:
        if not consume_per_action_use(db, approval):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="elevation_expired",
                headers={"WWW-Authenticate": ELEVATION_HEADER},
            )
        approved_by = approval.user_id
        approved_by_pos_user = approval.pos_user_id

    try:
        shift, outcome = apply_shift_close(
            db,
            machine,
            shift_id,
            body,
            approved_by_user_id=approved_by,
            approved_by_pos_user_id=approved_by_pos_user,
        )
    except ShiftUnknown:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="shift_unknown")

    # A duplicate too: the shift may have been closed (administratively, or by a close
    # that raced the instruction) before a run or request waiting on it existed.
    on_shift_close_accepted(db, machine, shift)
    db.add(SyncLog(
        machine_id=machine.id,
        direction=SyncDirection.POS_TO_SERVER,
        entity_type=SyncEntityType.Z_REPORT,
        entity_id=shift.id,
        action=SyncAction.CREATE,
        status=SyncStatus.SUCCESS,
        conflict_note="shift close" if outcome == "accepted" else "duplicate shift close",
    ))
    db.commit()
    db.refresh(shift)

    return ShiftCloseResponse(
        status=outcome,
        shift_id=shift.id,
        server_totals=shift_totals_out(shift),
        totals_mismatch=bool(shift.totals_mismatch),
        z_report_id=shift.z_report_id,
        z_number=z_number_of(db, shift),
        server_time=datetime.now(timezone.utc),
    )


@router.post(
    "/{machine_id}/shift-close/ack",
    response_model=ShiftCloseAckResponse,
    response_model_by_alias=True,
)
def post_shift_close_ack(
    machine_id: str,
    body: ShiftCloseAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The till acknowledges a remote close-shift instruction (`requestId`)."""
    _require_assigned_machine(machine)
    item_status = apply_close_shift_ack(
        db,
        machine,
        request_id=body.request_id,
        phase=body.phase,
        shift_id=body.shift_id,
        error_code=body.error_code,
        error_message=body.error_message,
    )
    return ShiftCloseAckResponse(ok=True, item_status=item_status)


# ── Removed with the move to shifts (docs/SHIFTS_API.md §1.8) ─────────────────
#
# Still authenticated first, so an unpaired caller gets 401/403 and a paired till
# running a pre-shift build learns it must upgrade rather than that it is forbidden.


def _upgrade_required() -> None:
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="upgrade_required")


@router.post("/{machine_id}/z-report", status_code=status.HTTP_410_GONE)
def post_z_report_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """Removed: the Z is built in the cloud; the till closes shifts."""
    _upgrade_required()


@router.post("/{machine_id}/trading-day", status_code=status.HTTP_410_GONE)
def post_trading_day_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """Removed: `POST /shifts`."""
    _upgrade_required()


@router.get("/{machine_id}/trading-day/current", status_code=status.HTTP_410_GONE)
def get_trading_day_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """Removed."""
    _upgrade_required()


@router.get("/{machine_id}/last-close", status_code=status.HTTP_410_GONE)
def get_last_close_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """Removed: `GET /shifts/last-closed`."""
    _upgrade_required()


@router.post("/{machine_id}/close-day/ack", status_code=status.HTTP_410_GONE)
def post_close_day_ack_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """Removed: `POST /shift-close/ack`."""
    _upgrade_required()


# ── POS users (server → POS) ──────────────────────────────────────────────────

@router.get(
    "/{machine_id}/pos-users",
    response_model=PosUsersSyncResponse,
)
def get_pos_users_sync(
    machine_id: str,
    since: Optional[str] = Query(None, description="ISO-8601 timestamp for delta sync"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Return active POS users for this machine's shop. Each row carries the bcrypt PIN
    hash so POS-desktop can authenticate cashiers fully offline.

    `since` enables delta sync. Soft-deleted (is_active=false) users are still returned
    so POS can disable them locally.
    """
    if not machine.shop_id:
        return PosUsersSyncResponse(
            sync_type="full",
            server_time=datetime.now(timezone.utc),
            users=[],
        )

    sync_type = "full"
    since_dt: Optional[datetime] = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            sync_type = "delta"
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid 'since' timestamp")

    q = db.query(PosUser).filter(PosUser.shop_id == machine.shop_id)
    if since_dt:
        q = q.filter(PosUser.updated_at > since_dt)
    rows = q.order_by(PosUser.updated_at.asc()).all()

    update_machine_sync_timestamp(db, str(machine.id))

    return PosUsersSyncResponse(
        sync_type=sync_type,
        server_time=datetime.now(timezone.utc),
        users=[PosUserSyncRow.model_validate(r) for r in rows],
    )


# ── Settings (server → POS) ───────────────────────────────────────────────────

@router.get(
    "/{machine_id}/settings",
    response_model=SettingsSyncResponse,
    response_model_by_alias=True,
)
def get_settings_sync(
    machine_id: str,
    since: Optional[str] = Query(None, description="ISO-8601 timestamp for delta sync"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Return merged POS settings for this machine's shop → company hierarchy.
    POS applies to local SQLite; cloud is source of truth for managed keys.
    """
    server_time = datetime.now(timezone.utc)

    if not machine.shop_id:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
        )

    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if not shop:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
        )

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
        )

    tenant = None
    if company.tenant_id:
        tenant = db.query(Tenant).filter(Tenant.id == company.tenant_id).first()

    watermark = effective_settings_updated_at(company, shop, tenant)
    since_dt: Optional[datetime] = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid 'since' timestamp")

    if since_dt and since_dt >= watermark:
        return SettingsSyncResponse(
            sync_type="unchanged",
            server_time=server_time,
            settings_updated_at=watermark,
            settings={},
            business_info=None,
        )

    all_settings = merge_all_settings_layers(company, shop, tenant)
    effective = {k: all_settings[k] for k in MANAGED_SETTING_KEYS if k in all_settings}
    # The payment option keys always go out, resolved, so the till never has to
    # guess what an absent key means. The legacy pair is overwritten with values
    # derived from them: a till still on an APK that predates the per-option keys
    # reads only tipsEnabled/cashTipsEnabled, and should still ask for a tip where
    # the merchant turned one on through the new keys alone. View only — nothing
    # here is written back to any layer's stored settings.
    payment_options = resolve_payment_options(all_settings)
    effective.update(payment_options)
    effective.update(legacy_tip_flags(payment_options))
    # The sell-screen tools likewise always go out as real bools (unset -> shown),
    # so the till reads a value rather than deciding what a missing key means.
    effective.update(resolve_sell_screen(all_settings))
    business_info = build_business_info(company, shop, all_settings)

    update_machine_sync_timestamp(db, str(machine.id))

    return SettingsSyncResponse(
        sync_type="delta" if since_dt else "full",
        server_time=server_time,
        settings_updated_at=watermark,
        settings=effective,
        business_info=business_info,
    )


# ── Stock (server → POS) ──────────────────────────────────────────────────────

@router.get(
    "/{machine_id}/stock",
    response_model=StockSyncResponse,
    response_model_by_alias=True,
)
def get_stock_sync(
    machine_id: str,
    since: Optional[str] = Query(None, description="ISO-8601 timestamp for delta sync"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Return per-shop stock levels for this machine's shop (delta by updated_at)."""
    server_time = datetime.now(timezone.utc)

    if not machine.shop_id:
        return StockSyncResponse(
            sync_type="full",
            server_time=server_time,
            stock_updated_at=server_time,
            levels=[],
        )

    watermark = effective_stock_updated_at(db, machine.shop_id)
    since_dt: Optional[datetime] = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid 'since' timestamp")

    if since_dt and since_dt >= watermark:
        return StockSyncResponse(
            sync_type="unchanged",
            server_time=server_time,
            stock_updated_at=watermark,
            levels=[],
        )

    levels = get_levels_for_shop(db, machine.shop_id, since=since_dt)
    out = [
        StockLevelOut(
            product_id=l.product_id,
            product_name=l.product.name if l.product else None,
            sku=l.product.sku if l.product else None,
            quantity=l.quantity,
            reorder_min=l.reorder_min,
            reorder_max=l.reorder_max,
            reorder_opt=l.reorder_opt,
            updated_at=l.updated_at,
        )
        for l in levels
    ]

    return StockSyncResponse(
        sync_type="delta" if since_dt else "full",
        server_time=server_time,
        stock_updated_at=watermark,
        levels=out,
    )
