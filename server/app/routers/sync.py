"""
REST sync endpoint — used by POS as HTTP fallback when MQTT is unavailable.

GET  /sync/{machine_id}/catalog?since=ISO_TS   → full or delta catalog
POST /sync/{machine_id}/catalog                → retired (410); see `post_catalog_changes`
PUT  /sync/{machine_id}/machine-catalog        → the till's own mode and list, on a
                                                 manager's authority
PUT  /sync/{machine_id}/products/{id}/availability
PUT  /sync/{machine_id}/categories/{id}/availability
                                               → make a product / category inactive (or
                                                 active) for this till, its area or its
                                                 shop, on a manager's authority
DELETE /sync/{machine_id}/products/{id}, /categories/{id}
                                               → refused (409): deactivate instead
GET  /sync/{machine_id}/app-update             → the app release offered to this till
                                                 (?platform=windows for the Windows app,
                                                 ?platform=kiosk_web for the kiosk's web bundle)
GET  /sync/{machine_id}/app-update/{id}/apk    → its APK / Windows installer (alias …/file)
POST /sync/{machine_id}/app-update/status      → how taking it is going
"""
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
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
from app.services.payment_options import (
    PAY_ORDER_KEY,
    legacy_tip_flags,
    resolve_pay_order,
    resolve_payment_options,
)
from app.services.refund_settings import resolve_refund_settings
from app.services.sell_screen import resolve_sell_screen
from app.services import general_item
from app.services import item_ticket
from app.services.areas import as_utc, get_area, machine_area_for_sync
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
from app.services import category_availability
from app.schemas.product_availability import TillAvailabilityResponse, TillAvailabilitySet
from app.services.product_validation import validate_open_price_update
from app.services.sku_sequence import resolve_sku_for_create
from app.services.tenant_sku_sequence import allocate_global_sku
from app.services.sync import (
    category_sent_to_machine,
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
from app.services.stock import effective_stock_updated_at, get_levels_for_shop, levels_for_machine
from app.schemas.transmission import TransmissionReportIn, TransmitAckIn
from app.services import transmissions, transmit_requests
from app.schemas.offline_authorization import OfflineAuthorizationIn
from app.services import offline_authorizations
from app.models.z_report import ZReport
from app.services import z_print
from app.services import failed_payments
from app.services.reports import _load_zoneinfo, resolve_report_timezone
from app.schemas.till_parameter import TillParametersSyncResponse
from app.services.till_parameters import till_parameters_for_machine
from app.models.app_release import AppRelease, AppReleaseMachineStatus
from app.schemas.app_release import AppUpdateOffer, AppUpdateStatusIn, AppUpdateStatusOut
from app.services import app_updates
from app.schemas.till_z import TillZAckIn, TillZIn
from app.services import till_z
from app.routers.z_reports import z_detail_out

logger = logging.getLogger(__name__)
# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_MACHINE_TOKEN, FISCAL_SYNC_PATH

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
    # The menu layer — modifier groups, note chips, meals, upsells, courses
    # (docs/SPEC_MENU_MODIFIERS.md §10.1), whole. On a full pull always; on a delta pull
    # only when the menu changed after `since` — absent means "keep what you have". An
    # older till ignores the key.
    menu: Optional[Dict[str, Any]] = None
    # "תפריטים" (docs/SPEC_MENUS.md): the menus assigned along this till's chain, their
    # schedules and assignments, and its fallback — the till works out which is active on
    # its own clock. Full pull: always; delta: only when they changed after `since` —
    # absent means "keep what you have". An older till ignores the key.
    catalog_menus: Optional[Dict[str, Any]] = Field(None, alias="catalogMenus")

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
    # "סקירת שינויים לפני שידור לקופות" (docs/SPEC_MENU_BROADCAST_REVIEW.md): a shop in
    # review mode (tables on) is served the menu of its latest broadcast, not the live
    # catalog tables (the draft); what is the till's own stays live. Any other shop: as
    # always — `live_since` is None only once, right after a shop left review mode.
    from app.services import menu_broadcast

    review_pull = menu_broadcast.catalog_pull(db, machine, since_dt)
    published = review_pull.published
    if published is not None:
        products, categories = published.products, published.categories
        # "מופיע ב": the publication holds each product's stored code; this device reads its own.
        from app.services import product_channels

        products = product_channels.project_rows(db, machine, list(products or []))
    else:
        products = get_products_for_sync(db, tid, mqid, since=review_pull.live_since)
        categories = get_categories_for_sync(db, tid, mqid, since=review_pull.live_since)
    vouchers = get_vouchers_for_sync(db, tid, since=since_dt)
    # Same `since` semantics as everything else in this payload: on a delta pull only
    # customers touched after `since` come back. Unlike products there is no merge
    # step, because nothing in the payload references a customer by id — a customer is
    # attached to a *document*, which travels the other way.
    customers = get_customers_for_sync(db, tid, since=since_dt)
    if since_dt and products:
        # The published catalog merges its own (from the publication).
        if published is None and review_pull.live_since is not None:
            categories = merge_categories_referenced_by_products(db, machine, products, categories)
        vouchers = merge_vouchers_referenced_by_products(db, products, vouchers)

    # Read before the stamp below, so a menu edit landing during this pull is not lost
    # between `serverTime` and the next delta.
    from app.services import menu as menu_service

    if published is not None:
        menu = published.menu
    else:
        menu = menu_service.menu_block(db, machine) if (
            machine.tenant_id is not None
            and menu_service.include_menu(db, machine, review_pull.live_since)
        ) else None
    # "תפריטים": live, or the shop's publication in review mode (app/services/catalog_menus.py).
    from app.services import catalog_menus as catalog_menus_service

    catalog_menus = catalog_menus_service.block_for_pull(db, machine, since_dt, review_pull)

    update_machine_sync_timestamp(db, mqid)

    return CatalogSyncResponse(
        sync_type=sync_type,
        server_time=datetime.now(timezone.utc).isoformat(),
        products=products,
        categories=categories,
        vouchers=vouchers,
        customers=customers,
        machine_catalog=machine_catalog_for_sync(machine),
        menu=menu,
        catalog_menus=catalog_menus,
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
#   * there is no delete any more (409 `delete_disabled_use_deactivate`). A till makes
#     a product or category inactive for itself, its area or its shop instead
#     (`.../availability`), which every till it reaches picks up on sync and which the
#     same screen can undo. The master always survives —
#     `transaction_items.product_id` is a foreign key with no ON DELETE.
#
# Categories have no shop tier for their own fields — `get_categories_for_sync` serves
# tenant globals to any machine with a shop — so a till may add one and rename it for
# its own shop (`shop_category_overrides`), and switch it off per till, area or shop.

#: The answer to a till's DELETE of a product or a category.
DELETE_DISABLED = "delete_disabled_use_deactivate"

#: The answer when a till asks for its area's scope while standing in none.
MACHINE_HAS_NO_AREA = "machine_has_no_area"


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
        ticket_mode=item_ticket.normalize(data.ticket_mode),
        ticket_entries=data.ticket_entries,
        is_open_price=data.is_open_price,
        is_weighed=data.is_weighed,
        unit_label=data.unit_label,
        no_discount=data.no_discount,
        # "מחייב אישור מנהל במכירה" is the dashboard's to set, never a till's (restricted_items.py).
        requires_manager_approval=False,
        dietary_tags=data.dietary_tags or None,
        # "היכן הפריט נמכר" from the till's product dialog (app/services/sales_channel.py).
        sales_channel=data.sales_channel,
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
    # Listed in this shop alone: the other shops' tills have nothing to pull.
    notify_machines_for_shop(db, str(shop.id), reason="product_created")
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
    # "מחייב אישור מנהל במכירה": the dashboard's alone — a till that echoes it changes nothing.
    updates.pop("requires_manager_approval", None)
    if "is_listed" in updates and not updates["is_listed"]:
        general_item.refuse_general_item_unlist(product)
    # The item-ticket ("שובר") mode set from the till's catalog screen: written on the
    # product itself — replacing whatever it had, including "inherit the category" —
    # and allowed on a shared product too, unlike the rest of the master record. The
    # till asks the cashier to confirm that it overrides the cloud's setting.
    ticket_mode_set = "ticket_mode" in updates
    if ticket_mode_set:
        product.ticket_mode = item_ticket.normalize(updates.pop("ticket_mode"))
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

    # Kitchen / bar printers ("מדפסות בונים") of this shop, from the till's product dialog.
    if data.kitchen_printers is not None:
        from app.services import printers as kitchen_printers

        kitchen_printers.apply_patch(
            db, shop, "product", product.id, data.kitchen_printers, machine_id=machine.id
        )

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
    Refused: a till no longer removes products. 409 `delete_disabled_use_deactivate`,
    and nothing is written.

    It used to unlist the product from the till's shop. A manager at one till cannot
    see what that takes away from the shop's other tills and from the dashboard's
    assortment, so the till now makes a product inactive instead — for itself, its
    area or its shop — through `PUT .../products/{id}/availability`, which can be undone
    from the same screen. Still gated like every catalog write, so a cashier's till gets
    the usual 401 before learning anything.
    """
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DELETE_DISABLED)


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
    Add a category from the till, for its own shop.

    Placed on the shop (`shop_id`), so `get_categories_for_sync` sends it to that shop's
    tills only, and the dashboard lists it under the shop. Global level all the same:
    products — which are company masters — may be filed under it.
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
        # This shop's own: `get_categories_for_sync` sends a shop-placed category to
        # that shop's tills only. Global level all the same, so products may use its id.
        shop_id=shop.id,
        pos_machine_id=None,
        catalog_level=CategoryCatalogLevel.GLOBAL,
        name=data.name,
        description=data.description,
        color=data.color,
        image_url=data.image_url,
        parent_id=data.parent_id,
        # "מחייב אישור מנהל במכירה" is the dashboard's to set, never a till's.
        requires_manager_approval=False,
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
    # Only this shop's tills can see it, so only they need waking.
    notify_machines_for_shop(db, str(shop.id), reason="category_created")
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

    # Kitchen / bar printers ("מדפסות בונים") of this shop, from the till's category dialog.
    if data.kitchen_printers is not None:
        from app.services import printers as kitchen_printers

        kitchen_printers.apply_patch(db, shop, "category", category.id, data.kitchen_printers)

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
    """
    Refused: a till no longer removes categories. 409 `delete_disabled_use_deactivate`,
    and nothing is written.

    Deleting from a till removed a tenant row that other shops' tills and the dashboard
    may still use. The till now makes a category inactive instead — for itself, its area
    or its shop — through `PUT .../categories/{id}/availability`. Removing a category
    for good stays the dashboard's.
    """
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DELETE_DISABLED)


# ── Active / inactive from the till, per till, area or shop ───────────────────
#
# The till's replacement for delete. One body for products and categories:
# `{"scope": "machine"|"area"|"shop", "active": true|false|null}`, null clearing that
# scope back to inherit. The scope's target is always derived from the authenticated
# machine — its own id, its `area_id`, its `shop_id` — never read from the request, so
# a till can only ever reach its own shop. The rule each one feeds is in
# `product_availability` and `category_availability`; the answer's `effectiveActive` is
# what this till resolves to after the change, the same value its next sync carries.


def _scope_target(machine: POSMachine, scope: str):
    """The id the scope names for this till; 400 `machine_has_no_area` for "area" without one."""
    if scope == "machine":
        return machine.id
    if scope == "area":
        if machine.area_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=MACHINE_HAS_NO_AREA
            )
        return machine.area_id
    return machine.shop_id


@router.put(
    "/{machine_id}/products/{product_id}/availability",
    response_model=TillAvailabilityResponse,
)
def machine_set_product_availability(
    machine_id: str,
    product_id: str,
    body: TillAvailabilitySet,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Make a product inactive (locked: shown, not sellable) or active again for this till,
    its area or its shop — the till's own, area and shop levels of
    `product_availability`. The product must be in this shop's assortment (404
    otherwise), as for the dashboard's per-till setting.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    product = _machine_editable_product(db, machine, product_id)
    row = _override_for(db, shop.id, product.id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment"
        )
    target = _scope_target(machine, body.scope)

    if body.scope == "machine":
        availability.set_machine_availability(
            db, target, product.id, body.active, body.permanent, body.blocked_at
        )
    elif body.scope == "area":
        availability.set_area_availability(
            db, target, product.id, body.active, body.permanent, body.blocked_at
        )
    else:
        availability.set_shop_availability(row, body.active, body.permanent, body.blocked_at)
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.UPDATE,
        entity_id=product.id,
        note=f"availability scope={body.scope} active={body.active}",
    )
    db.commit()

    effective = bool(row.is_listed) and availability.effective_availability(db, product, machine)
    if body.scope == "machine":
        availability.notify_machine_change(machine)
    elif body.scope == "area":
        availability.notify_area_change(db, target)
    else:
        availability.notify_shop_change(db, shop.id)
    return TillAvailabilityResponse(
        id=product.id, scope=body.scope, active=body.active, effective_active=effective
    )


class ProductOrderIn(BaseModel):
    """"סידור פריטים" from a till's edit mode: the buttons' order, saved at a level."""

    scope: Literal["machine", "area", "shop"]
    #: The products' order; absent = this write leaves it as it is.
    product_ids: Optional[List[str]] = Field(None, alias="productIds", max_length=5000)
    #: The categories' order (the tabs above the buttons); absent = left as it is.
    category_ids: Optional[List[str]] = Field(None, alias="categoryIds", max_length=2000)

    class Config:
        populate_by_name = True


@router.put("/{machine_id}/product-order")
def machine_set_product_order(
    machine_id: str,
    body: ProductOrderIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    The order of the till's product buttons (`productOrder` in the settings layers) for
    this till, its point of sale or its shop — a manager's, as any catalog write from a
    till. Saved at the shop or the point of sale, this till's own lower levels let go of
    theirs so the new order shows here too; other tills keep any order of their own.
    An empty list clears the level (back to inherit, then to the names' order).
    """
    from app.services.settings_merge import patch_settings_json, utc_now
    from app.services import settings_notify
    from app.models.shop_area import ShopArea

    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    target = _scope_target(machine, body.scope)

    def clean(raw_ids) -> List[str]:
        out: List[str] = []
        seen = set()
        for raw in raw_ids or []:
            pid = str(raw).strip()
            if pid and pid not in seen:
                seen.add(pid)
                out.append(pid)
        return out

    patch: Dict[str, Any] = {}
    if body.product_ids is not None:
        patch["productOrder"] = clean(body.product_ids) or None
    if body.category_ids is not None:
        patch["categoryOrder"] = clean(body.category_ids) or None
    if not patch:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="nothing_to_order")
    ids = patch.get("productOrder") or []
    now = utc_now()

    def write(row) -> None:
        row.settings = patch_settings_json(row.settings, patch)
        row.settings_updated_at = now

    def clear(row) -> None:
        held = row.settings if row is not None and isinstance(row.settings, dict) else None
        if held is not None and any(k in held for k in patch):
            row.settings = patch_settings_json(held, {k: None for k in patch})
            row.settings_updated_at = now

    area = db.get(ShopArea, machine.area_id) if machine.area_id else None
    if body.scope == "machine":
        write(machine)
    elif body.scope == "area":
        write(area)
        clear(machine)
    else:
        write(shop)
        clear(area)
        clear(machine)
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.UPDATE,
        entity_id=None,
        note=f"order scope={body.scope} products={len(ids)} categories={len(patch.get('categoryOrder') or [])}",
    )
    db.commit()
    if body.scope == "machine":
        settings_notify.notify_machine_settings(db, machine, reason="product_order")
    elif body.scope == "area":
        settings_notify.notify_machines_for_area_settings(db, str(target), reason="product_order")
    else:
        settings_notify.notify_machines_for_shop_settings(db, str(shop.id), reason="product_order")
    return {"scope": body.scope, "count": len(ids)}


class PaymentTerminalIn(BaseModel):
    """The till's Nayax pinpad, as a manager set it up at the till: on the network, or on its USB."""

    model_config = {"populate_by_name": True}

    #: An IPv4 address or a host name; validated in app/services/payment_terminal.py. Needed on
    #: the network only ("" or absent with `connection` "usb").
    host: Optional[str] = Field(None, max_length=300)
    #: SPICy's port; absent = 8080.
    port: Optional[int] = Field(None, ge=1, le=65535)
    #: SPICy's path; absent = "/SPICy".
    path: Optional[str] = Field(None, max_length=200)
    #: "lan" (absent: as before) or "usb" — "חיבור USB": a Nayax C4 on the till's USB cable.
    connection: Optional[str] = Field(None, max_length=10)
    #: With "usb": the C4's USB ids "VVVV:PPPP" (`nayaxUsbDevice`); "" removes the till's own
    #: (the first CDC-ACM device); absent leaves it as it is.
    usb_device: Optional[str] = Field(None, alias="usbDevice", max_length=20)


#: `PaymentTerminalIn.connection`: absent = the network, as before the USB choice.
PAYMENT_TERMINAL_CONNECTIONS = ("lan", "usb")


def _till_integration(db: Session, machine: POSMachine, own_settings: Any) -> str:
    """What [machine] charges on with [own_settings] as its own layer (payment_integration.resolve)."""
    from app.services import payment_integration as PI

    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    company = db.query(Company).filter(Company.id == shop.company_id).first() if shop is not None and shop.company_id else None
    tenant = (
        db.query(Tenant).filter(Tenant.id == company.tenant_id).first()
        if company is not None and company.tenant_id
        else None
    )
    area = get_area(db, getattr(machine, "area_id", None)) if shop is not None else None
    layers = [
        (level, getattr(entity, "settings", None))
        for level, entity in (("tenant", tenant), ("company", company), ("shop", shop), ("area", area))
        if entity is not None
    ]
    layers.append(("machine", own_settings))
    return PI.resolve(
        layers, bool(getattr(machine, "has_builtin_terminal", True)), synqpay_device=PI.is_synqpay_device(machine)
    ).integration


@router.put("/{machine_id}/payment-terminal", dependencies=FISCAL_SYNC_PATH)
def machine_set_payment_terminal(
    machine_id: str,
    body: PaymentTerminalIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    The Nayax pinpad this till charges on, set up at the till: a till with no card terminal
    of its own (a P18) asks for it before its first card payment. A manager's write, gated
    like the till's other manager writes (a signed-in manager, or a manager's grant), to the
    till's own settings layer, where the dashboard's per-till settings show it and can change it.

    * `connection` "lan" (or absent — as before): the address (`nayaxEnabled`, `nayaxDeviceHost`,
      `nayaxDevicePort`, `nayaxSpicyPath`). A till that would still charge on a C4 on its USB
      (`paymentIntegration` = `nayax_usb`, its own or inherited) is moved to `nayax_lan` on its
      own layer. 422 with `host_invalid`, `host_required`, `port_invalid` or `path_invalid` for
      an address the till must not be sent.
    * `connection` "usb" ("חיבור USB"): `paymentIntegration` = `nayax_usb` on its own layer, no
      address; `usbDevice` names the C4 (`nayaxUsbDevice`, 422 `usb_device_invalid`). One USB
      terminal per till: 422 (the Hebrew reason as `detail`) while the till could also charge on
      a SynqPay payment device on USB (app/services/payment_devices.py `usb_terminal_conflict`).
    * Anything else: 422 `connection_invalid`.
    """
    from app.services import payment_devices, payment_integration as PI, payment_terminal, settings_notify
    from app.services.settings_merge import patch_settings_json, utc_now

    _require_assigned_machine(machine)
    connection = (body.connection or "lan").strip().lower()
    if connection not in PAYMENT_TERMINAL_CONNECTIONS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="connection_invalid")
    if connection == "usb":
        patch: Dict[str, Any] = {PI.KEY: PI.NAYAX_USB}
        if body.usb_device is not None:
            try:
                patch[PI.NAYAX_USB_DEVICE] = PI.validate_nayax_usb_device(body.usb_device)
            except ValueError:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="usb_device_invalid")
        after = patch_settings_json(machine.settings, patch)
        conflict = payment_devices.usb_terminal_conflict(db, [machine], layer=("machine", machine.id, after))
        if conflict is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=payment_devices.usb_terminal_message(conflict),
            )
        machine.settings = after
        machine.settings_updated_at = utc_now()
        usb_device = after.get(PI.NAYAX_USB_DEVICE)
        logger.info(
            "payment terminal set from till %s: Nayax on USB (%s) (user %s, till user %s)",
            machine.id, usb_device or "first CDC-ACM device", actor.user_id, actor.pos_user_id,
        )
        db.commit()
        settings_notify.notify_machine_settings(db, machine, reason="payment_terminal")
        return {"connection": "usb", "paymentIntegration": PI.NAYAX_USB, "usbDevice": usb_device}

    try:
        host = payment_terminal.clean_pinpad_host(body.host)
        port = payment_terminal.clean_pinpad_port(body.port)
        path = payment_terminal.clean_pinpad_path(body.path)
    except payment_terminal.PinpadAddressError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code)
    after = patch_settings_json(machine.settings, payment_terminal.pinpad_settings_patch(host, port, path))
    # Back from the cable to the network: the address alone would not move a till on `nayax_usb`.
    if _till_integration(db, machine, after) == PI.NAYAX_USB:
        after = patch_settings_json(after, {PI.KEY: PI.NAYAX_LAN})
    machine.settings = after
    machine.settings_updated_at = utc_now()
    # No SyncLog row: its entity types are a database enum, and a new one is a migration.
    # The write is the till's own layer, and the log names who made it.
    logger.info(
        "payment terminal set from till %s: %s:%s%s (user %s, till user %s)",
        machine.id, host, port, path, actor.user_id, actor.pos_user_id,
    )
    db.commit()
    settings_notify.notify_machine_settings(db, machine, reason="payment_terminal")
    return {"nayaxEnabled": True, "host": host, "port": port, "path": path}


class PinpadHostIn(BaseModel):
    """The till's own pinpad at a new address on its LAN (app/services/payment_terminal.py `relink_pinpad`)."""

    model_config = {"populate_by_name": True}

    host: str = Field(..., max_length=300)
    #: SPICy's port; absent = unchanged.
    port: Optional[int] = Field(None, ge=1, le=65535)
    #: "technician" (picked on the technician screen) | "relocated" (found by the till itself).
    reason: str = Field(..., max_length=16)
    #: The terminal number the pinpad at [host] said it is (`getRetailerInfo`).
    terminal_number: Optional[str] = Field(None, alias="terminalNumber", max_length=20)
    serial: Optional[str] = Field(None, max_length=60)
    #: The address the till charged on before, as it held it.
    previous_host: Optional[str] = Field(None, alias="previousHost", max_length=300)
    #: The pinpad's MAC when Android let the till read it (a hint only).
    mac: Optional[str] = Field(None, max_length=32)


@router.put("/{machine_id}/pinpad-host", dependencies=FISCAL_MACHINE_TOKEN)
def machine_set_pinpad_host(
    machine_id: str,
    body: PinpadHostIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    "קישור מסופון מחדש" / a pinpad that moved (DHCP): the till writes its own pinpad's new
    address — `nayaxDeviceHost` (and `nayaxDevicePort`) on its own settings layer and nothing
    else, with its machine token alone (nobody at a kiosk is a manager). Only for a till that
    already charges on a network Nayax pinpad, only a private IPv4 address, and a move the
    till made by itself only to the same terminal (`terminal_mismatch`). Audited as the till
    event `pinpad_host_set`. `422 host_invalid | host_not_private | port_invalid |
    reason_invalid | terminal_number_required` · `409 pinpad_not_in_use | terminal_mismatch`.
    """
    from app.services import payment_terminal, settings_notify

    _require_assigned_machine(machine)
    try:
        out = payment_terminal.relink_pinpad(
            db, machine,
            host=body.host, port=body.port, reason=body.reason, terminal_number=body.terminal_number,
            serial=body.serial, previous_host=body.previous_host, mac=body.mac,
        )
    except payment_terminal.PinpadRelinkRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content={"detail": refused.code, "message": refused.message})
    db.commit()
    if not out["unchanged"]:
        settings_notify.notify_machine_settings(db, machine, reason="pinpad_host")
    return out


@router.post("/{machine_id}/products/{product_id}/image")
async def machine_upload_product_image(
    machine_id: str,
    product_id: str,
    file: UploadFile = File(...),
    keep_background: bool = Query(False, alias="keepBackground"),
    enhance: bool = Query(True, alias="enhance"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    A product's picture taken or picked on the till: stored as the dashboard's upload
    stores it — the background cut out unless `keepBackground`, the upload kept beside
    it (`originalUrl`, to go back to with a product update) — and set on the product.
    "שפר תמונה" (`enhance`, on unless the till says false): the same enhancement the till
    applied to the picture it shows (app/services/product_image_processing.py `enhance_image`),
    so the cloud's refined picture (`processed`: not the bytes sent) replaces it looking alike.
    The picture is the product's own, so only for a product this shop alone lists
    (403 `shared_product_master_readonly`), as for every master field from a till.
    """
    from app.routers import images

    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    product = _machine_editable_product(db, machine, product_id)
    if not _product_belongs_only_to(db, product, shop.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="shared_product_master_readonly")
    if file.content_type not in images._ALLOWED_TYPES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="unsupported_image_type")
    contents = await file.read()
    if len(contents) > images._MAX_SIZE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="image_too_large")
    # Called directly (a test), the Query default is not a bool: the till's default, on.
    enhance = enhance if isinstance(enhance, bool) else True
    stored = await images.store_upload(contents, machine.tenant_id, "products", keep_background, enhance=enhance)
    product.image_url = stored.url
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.PRODUCTS,
        action=SyncAction.UPDATE,
        entity_id=product.id,
        note="image" + (" background removed" if stored.background_removed else "")
        + (" enhanced" if stored.enhanced else ""),
    )
    db.commit()
    notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="product_updated")
    return {
        "url": stored.url,
        "originalUrl": stored.original_url,
        "backgroundRemoved": stored.background_removed,
        "processed": stored.processed,
    }


@router.delete("/{machine_id}/products/{product_id}/image")
def machine_remove_product_image(
    machine_id: str,
    product_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    "הסרת תמונה" from the till's product dialog: the product goes back to no picture.
    Gated exactly like the upload above — a manager's authority, and only for a product
    this shop alone lists (403 `shared_product_master_readonly`). Removing a picture the
    product does not have is a no-op that still answers 200, so a till replaying a
    queued removal never sees a refusal for it.
    """
    _require_assigned_machine(machine)
    shop = _shop_or_400(db, machine)
    product = _machine_editable_product(db, machine, product_id)
    if not _product_belongs_only_to(db, product, shop.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="shared_product_master_readonly")
    if product.image_url is not None:
        product.image_url = None
        _audit(
            db,
            machine=machine,
            actor=actor,
            entity=SyncEntityType.PRODUCTS,
            action=SyncAction.UPDATE,
            entity_id=product.id,
            note="image removed",
        )
        db.commit()
        notify_all_machines_for_tenant(db, str(machine.tenant_id), reason="product_updated")
    return {"url": None}


@router.put(
    "/{machine_id}/categories/{category_id}/availability",
    response_model=TillAvailabilityResponse,
)
def machine_set_category_availability(
    machine_id: str,
    category_id: str,
    body: TillAvailabilitySet,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    Switch a category off (or on again) for this till, its area or its shop. The
    category's own tenant-wide flag stays the dashboard's and stays the floor: a till
    cannot switch on what the tenant switched off. The category must be one this till
    is sent (404 otherwise).
    """
    _require_assigned_machine(machine)
    _shop_or_400(db, machine)
    category = _machine_editable_category(db, machine, category_id)
    if not category_sent_to_machine(db, machine, category):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    target = _scope_target(machine, body.scope)

    category_availability.set_override(
        db, body.scope, target, category.id, body.active, body.permanent, body.blocked_at
    )
    _audit(
        db,
        machine=machine,
        actor=actor,
        entity=SyncEntityType.CATEGORIES,
        action=SyncAction.UPDATE,
        entity_id=category.id,
        note=f"availability scope={body.scope} active={body.active}",
    )
    db.commit()

    effective = category_availability.effective_active(db, category, machine)
    category_availability.notify_level(db, body.scope, target, machine=machine)
    return TillAvailabilityResponse(
        id=category.id, scope=body.scope, active=body.active, effective_active=effective
    )


# ── Transactions (POS → server) ────────────────────────────────────

@router.post(
    "/{machine_id}/transactions",
    response_model=TransactionsBatchResponse,
    status_code=status.HTTP_200_OK,
    dependencies=FISCAL_SYNC_PATH,
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

    # "מצב הדרכה": training documents go to the quarantine and are answered like real ones
    # (app/services/training_mode.py); the real documents go on below exactly as before.
    from app.services import training_mode as TM

    positions, real_documents, training = TM.divert_transactions(db, machine, body.transactions)
    valid, refused, unidentified = validate_documents(real_documents)
    # "מסמך שנדחה בענן": the documents as sent, for the refusal record written after the
    # upsert (app/services/document_refusals.py) — before positions are remapped.
    from app.services import document_refusals as DR

    raw_by_ref = {DR.document_ref(raw, i).lower(): raw for i, raw in enumerate(real_documents)}
    unidentified_raw = [
        (u.index, real_documents[u.index] if 0 <= u.index < len(real_documents) else None, u.reason)
        for u in unidentified
    ]
    if training:
        # Back to the positions in the till's own batch.
        valid = [(positions[i], tx, w) for i, tx, w in valid]
        refused = [(positions[i], r) for i, r in refused]
        for u in unidentified:
            u.index = positions[u.index]
    try:
        upserted = upsert_transactions(db, machine, [tx for _i, tx, _w in valid])
    except ShiftConflict as conflict:
        db.rollback()
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=conflict.body())
    for (_i, _tx, warnings), r in zip(valid, upserted):
        # Unreadable links (dropped before the model) first, then unknown ones (dropped
        # by the upsert, which names nothing here).
        if warnings:
            r.warnings = [*warnings, *(r.warnings or ())]
    # In the order the till sent them.
    results = [
        r for _i, r in sorted(
            [(i, r) for (i, _tx, _w), r in zip(valid, upserted)] + refused, key=lambda pair: pair[0]
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
            # The warnings keep the values of the links dropped to store the document.
            conflict_note="; ".join(
                part for part in (
                    r.reason if isinstance(r.id, uuid.UUID) or r.reason is None
                    else f"id {r.id!r}: {r.reason}",
                    *(r.warnings or ()),
                ) if part
            ) or None,
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
    # Every refusal recorded (machine, document, reason, first / last seen, payload) and every
    # stored document marked landed — never failing the push.
    DR.record_push_safely(
        db, machine, raw_by_ref=raw_by_ref, results=results, unidentified=unidentified_raw,
    )
    db.commit()

    if accepted_count > 0:
        publish_transactions_synced(machine.tenant_id, machine.id, accepted_count)
        # Exceptions ("חריגות"), after the commit and never failing the push.
        from app.services.exceptions import detect_safely, detect_transactions

        detect_safely(db, detect_transactions, [r.id for r in results if r.status == "accepted"])

    if training:
        # The training answers too, in the order the till sent them.
        results = [
            r for _i, r in sorted(
                [(i, r) for (i, _tx, _w), r in zip(valid, upserted)] + refused + training,
                key=lambda pair: pair[0],
            )
        ]
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


@router.post("/{machine_id}/shifts", response_model=ShiftOut, response_model_by_alias=True, dependencies=FISCAL_MACHINE_TOKEN)
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
    # "מצב הדרכה": a training shift is quarantined, never a real shift.
    from app.services import training_mode as TM

    training = TM.divert_shift_open(db, machine, data)
    if training is not None:
        db.commit()
        return training
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
    dependencies=FISCAL_MACHINE_TOKEN,
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
    # "מצב הדרכה": a training shift's close is quarantined and answered like a real one —
    # before the checks below, which look for its documents in the real table.
    from app.services import training_mode as TM

    training = TM.divert_shift_close(db, machine, shift_id, body)
    if training is not None:
        db.commit()
        return training

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
    if outcome == "accepted":
        # Exceptions ("חריגות"): the cash difference at close. Never fails the close.
        from app.services.exceptions import detect_safely, detect_shift_close

        detect_safely(db, detect_shift_close, shift.id)
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
    dependencies=FISCAL_MACHINE_TOKEN,
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
    if body.error_code == "held_sales":
        # The list the manager sees before confirming "בטל מכירות מושהות וסגור".
        from app.services import held_sales_close

        held_sales_close.note_reported(db, machine, body.request_id, body.held_sales)
        db.commit()
    return ShiftCloseAckResponse(ok=True, item_status=item_status)


# ── Card transmission (docs/SHIFTS_API.md §4) ─────────────────────────────────


@router.post("/{machine_id}/transmissions", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_MACHINE_TOKEN)
def post_transmission_report(
    machine_id: str,
    body: TransmissionReportIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One `doPeriodic` attempt of this till (§4.1). Idempotent by `id`: `201` the first
    time, `200` after. A success marks the card legs it carried. Not refused for a till
    that has left its shop: a batch is money, whatever the till's assignment now.
    """
    outcome = transmissions.record_report(db, machine, body)
    transmit_requests.on_report(db, machine, outcome.transmission)
    db.commit()
    payload = {
        "ok": True,
        "transmissionId": str(outcome.transmission.id),
        "status": outcome.transmission.status,
        "created": outcome.created,
        "legsMarked": outcome.legs_marked,
        # Of the sales kept with the batch, those the terminal never named (SPEC_REPORTS §7).
        "legsAssumed": outcome.legs_assumed,
    }
    return JSONResponse(
        status_code=status.HTTP_201_CREATED if outcome.created else status.HTTP_200_OK,
        content=payload,
    )


@router.get("/{machine_id}/transmissions")
def list_own_transmissions(
    machine_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    This till's own transmission history, newest first — the same rows and shape the
    dashboard reads (`GET /machines/{id}/transmissions`), but with the machine token, so
    the till's "היסטוריית שידורים" shows every attempt the cloud holds for the device,
    not only the few still in its local database.
    """
    return transmissions.list_for_machine(db, machine, limit=limit, offset=offset)


def _own_shop_z_query(db: Session, machine: POSMachine):
    """The Zs of this till's shop, in its tenant. A Z belongs to a shop, not a till."""
    _require_assigned_machine(machine)
    return db.query(ZReport).filter(
        ZReport.shop_id == machine.shop_id, ZReport.tenant_id == machine.tenant_id
    )


@router.get("/{machine_id}/z-reports")
def list_own_shop_z_reports(
    machine_id: str,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The Zs of this till's shop, newest first, for the till's "reprint a Z" list. Each
    row prints from `GET /sync/{machine_id}/z-reports/{id}/print-document`.
    """
    query = _own_shop_z_query(db, machine)
    total = query.count()
    rows = (
        query.order_by(
            ZReport.shop_sequence_number.is_(None),
            ZReport.shop_sequence_number.desc(),
            ZReport.closed_at.desc(),
        )
        .offset(offset)
        .limit(limit)
        .all()
    )
    tzinfo = _load_zoneinfo(resolve_report_timezone(db, machine.tenant_id, None))
    return {"items": [z_print.list_item(z, tzinfo) for z in rows], "total": total}


@router.get("/{machine_id}/z-reports/{z_report_id}/print-document")
def get_own_shop_z_print_document(
    machine_id: str,
    z_report_id: uuid.UUID,
    part: Optional[str] = Query(None, description="summary: the shop's totals and one line per till"),
    till: Optional[uuid.UUID] = Query(None, description="one till's detail, as a document of its own"),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One Z of this till's shop as the 80 mm print document (`app/services/z_print.py`) —
    the same document the dashboard's till view prints. Another shop's Z is a 404.

    In parts, for a shop Z over several tills (what the master till prints): `?part=summary`
    — the shop's totals and one compact line per till, with `tills` to print apart — and
    `?till=<machineId>` — that till's detail with its own header (404 if the Z has none).
    """
    z = _own_shop_z_query(db, machine).filter(ZReport.id == z_report_id).first()
    if z is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    tzinfo = _load_zoneinfo(resolve_report_timezone(db, machine.tenant_id, None))
    # isinstance: called as a plain function (the tests do), the defaults are Query objects.
    if isinstance(till, uuid.UUID):
        doc = z_print.build_till_document(z, till, tzinfo)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="till_not_in_z")
        # "עסקאות שלא הושלמו" / "מכירות שבוטלו" of that till (informational, docs/SPEC_FAILED_PAYMENTS.md).
        return failed_payments.with_print_sections(db, z, doc, tzinfo, machine_id=till)
    if isinstance(part, str) and part == "summary":
        return z_print.build_summary_document(z, tzinfo)
    return failed_payments.with_print_sections(db, z, z_print.build_print_document(z, tzinfo), tzinfo)


@router.post("/{machine_id}/transmit/ack", dependencies=FISCAL_MACHINE_TOKEN)
def post_transmit_ack(
    machine_id: str,
    body: TransmitAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The till acknowledges a transmit instruction (§4.5)."""
    req = transmit_requests.apply_ack(
        db,
        machine,
        request_id=body.request_id,
        phase=body.phase,
        transmission_id=body.transmission_id,
        error_code=body.error_code,
        error_message=body.error_message,
    )
    db.commit()
    return {"ok": True, "requestStatus": req.status}


# ── Z on the till (docs/SHIFTS_API.md §5) ─────────────────────────────────────


def _till_z_refusal(db: Session, refused: "till_z.TillZRefused") -> JSONResponse:
    if refused.keep:
        db.commit()
    else:
        db.rollback()
    return JSONResponse(status_code=refused.status_code, content=refused.body)


@router.post("/{machine_id}/till-z", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_MACHINE_TOKEN)
def post_till_z(
    machine_id: str,
    body: TillZIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    A till in `zMode = till` asks for its Z (§5.2), after its last shift close was
    accepted. Built here, in one transaction, by the same builder as a cloud Z over this
    till's closed shifts up to `throughShiftId`, and numbered in the till's own run.

    `201 created` · `200 duplicate` (this `clientRequestId` was answered before: the same
    Z, nothing new numbered) · `409 till_z_disabled | shift_not_closed | shift_unknown |
    nothing_to_report | z_run_in_progress:<runId>` · `403 shift_belongs_to_another_machine`.
    """
    _require_assigned_machine(machine)
    # "מצב הדרכה": a training Z is the till's own — quarantined, no cloud Z is built.
    from app.services import training_mode as TM

    training = TM.divert_till_z(db, machine, body)
    if training is not None:
        db.commit()
        return JSONResponse(status_code=training[0], content=training[1])
    try:
        z, outcome = till_z.produce_till_z(db, machine, body)
        db.commit()
    except till_z.TillZRefused as refused:
        return _till_z_refusal(db, refused)
    except IntegrityError:
        # Only a second attempt racing past the counter lock could get here (the lock
        # makes it wait, then find the first's Z). Answer the Z that won.
        db.rollback()
        z = (
            db.query(ZReport)
            .filter(ZReport.client_request_id == body.client_request_id, ZReport.machine_id == machine.id)
            .first()
        )
        if z is None:
            raise
        outcome = "duplicate"
    db.refresh(z)
    return JSONResponse(
        status_code=status.HTTP_201_CREATED if outcome == "created" else status.HTTP_200_OK,
        content={
            "status": outcome,
            "zReport": z_detail_out(db, z).model_dump(by_alias=True, mode="json"),
            "shiftIds": [str(i) for i in till_z.z_shift_ids(db, z)],
            "totalsMismatch": bool(z.totals_mismatch),
            "serverTime": datetime.now(timezone.utc).isoformat(),
            # A kiosk's Z a controlling till prints itself: the kiosk does not (app/services/kiosk_z.py).
            **_kiosk_z_extra(db, machine, body),
        },
    )


def _kiosk_z_extra(db: Session, machine: POSMachine, body: TillZIn) -> dict:
    from app.services import kiosk_z

    return kiosk_z.till_z_answer_extra(db, machine, body)


@router.get("/{machine_id}/till-zs")
def get_till_z_history(
    machine_id: str,
    days: int = Query(till_z.TILL_Z_HISTORY_DAYS, ge=1, le=400),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    This till's own Zs of the last `days` days (default 31), oldest first, and always its
    newest — each as the `POST till-z` answer reads, so the till keeps and reprints it —
    with `lastTillZNumber`. What a new or reset till pulls before it may ever close a Z
    with no connection (docs/SPEC_OFFLINE_TILL_Z.md §4.3).
    """
    from app.services.z_sequence import last_machine_z_number

    from app.services.z_sequence import current_machine_epoch

    zs = till_z.till_z_history(db, machine, days=days)
    epoch, started = current_machine_epoch(db, machine.id)
    return {
        "lastTillZNumber": last_machine_z_number(db, machine.id),
        # The run the till numbers in now (SPEC_INDEPENDENT_TILL §3.1).
        "tillZEpoch": epoch,
        "tillZEpochStartedAt": started.isoformat() if started is not None else None,
        "serverTime": datetime.now(timezone.utc).isoformat(),
        "items": [
            {
                "status": "history",
                "zReport": z_detail_out(db, z).model_dump(by_alias=True, mode="json"),
                "shiftIds": [str(i) for i in till_z.z_shift_ids(db, z)],
                "totalsMismatch": bool(z.totals_mismatch),
            }
            for z in zs
        ],
    }


@router.post("/{machine_id}/till-z/ack", dependencies=FISCAL_MACHINE_TOKEN)
def post_till_z_ack(
    machine_id: str,
    body: TillZAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The till acknowledges a dashboard request for its Z (§5.3). Never completes it."""
    req = till_z.apply_ack(
        db,
        machine,
        request_id=body.request_id,
        phase=body.phase,
        error_code=body.error_code,
        error_message=body.error_message,
    )
    if body.error_code == "held_sales":
        from app.services import held_sales_close

        held_sales_close.note_reported(db, machine, body.request_id, body.held_sales)
    db.commit()
    return {"ok": True, "status": req.status}


# ── A reset ordered from the cloud by support (docs/SPEC_OFFLINE_TILL_Z.md §4.7) ──


class TillResetResultIn(BaseModel):
    """What the till did with `pendingReset`: carried it out, or refused and why."""

    model_config = {"populate_by_name": True}

    command_id: str = Field(..., alias="commandId", max_length=64)
    #: done | refused | failed
    status: str = Field(..., max_length=16)
    #: Why it refused or failed: outbox_not_empty | unknown_kind | not_paired | failed.
    code: Optional[str] = Field(None, max_length=64)
    message: Optional[str] = Field(None, max_length=500)
    executed_at: Optional[str] = Field(None, alias="executedAt", max_length=40)
    transactions_deleted: Optional[int] = Field(None, alias="transactionsDeleted", ge=0)
    outbox_pending: Optional[int] = Field(None, alias="outboxPending", ge=0)
    kept_zs: Optional[int] = Field(None, alias="keptZs", ge=0)
    kept_z_numbers: Optional[List[int]] = Field(None, alias="keptZNumbers", max_length=400)
    kept_shop_zs: Optional[int] = Field(None, alias="keptShopZs", ge=0)
    #: {"before": {...}, "after": {...}} — the till's Z run and document series.
    counters: Optional[Dict[str, Dict[str, Optional[int]]]] = None
    app_version: Optional[str] = Field(None, alias="appVersion", max_length=64)


@router.post("/{machine_id}/till-reset/result")
def post_till_reset_result(
    machine_id: str,
    body: TillResetResultIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The till's answer to a reset support ordered (§4.7). Idempotent; `404 unknown_command`
    for a command this till was never given.
    """
    from app.services import till_reset

    record = till_reset.apply_result(
        db,
        machine,
        command_id=body.command_id,
        result_status=body.status,
        code=body.code,
        message=body.message,
        details={
            "executedAt": body.executed_at,
            "transactionsDeleted": body.transactions_deleted,
            "outboxPending": body.outbox_pending,
            "keptZs": body.kept_zs,
            "keptZNumbers": body.kept_z_numbers,
            "keptShopZs": body.kept_shop_zs,
            "counters": body.counters,
            "appVersion": body.app_version,
        },
    )
    db.commit()
    return {"ok": True, "status": record.get("status")}


# ── Offline card authorization (Agamento `authorizePendingTransactions`) ──────


@router.post("/{machine_id}/offline-authorizations", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_MACHINE_TOKEN)
def post_offline_authorization(
    machine_id: str,
    body: OfflineAuthorizationIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One run that sent the terminal's offline-approved card sales for authorization, with
    the uids approved and declined. Idempotent by `id`: `201` the first time, `200` after;
    another till's id is `409`. Not refused for a till that has left its shop, as for a
    transmission report.
    """
    outcome = offline_authorizations.record_report(db, machine, body)
    db.commit()
    return JSONResponse(
        status_code=status.HTTP_201_CREATED if outcome.created else status.HTTP_200_OK,
        content={
            "ok": True,
            "authorizationId": str(outcome.authorization.id),
            "created": outcome.created,
        },
    )


# ── Removed with the move to shifts (docs/SHIFTS_API.md §1.8) ─────────────────
#
# Still authenticated first, so an unpaired caller gets 401/403 and a paired till
# running a pre-shift build learns it must upgrade rather than that it is forbidden.


def _upgrade_required() -> None:
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="upgrade_required")


@router.post("/{machine_id}/z-report", status_code=status.HTTP_410_GONE)
def post_z_report_removed(machine_id: str, machine: POSMachine = Depends(get_pos_machine_for_sync_path)):
    """
    Removed: the Z is built in the cloud; the till closes shifts. Stays 410 for a
    pre-shift build — a till in `zMode = till` asks with `POST /till-z` (§5.2).
    """
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

    # "תפקידים והרשאות": each row carries the user's effective permissions, resolved here.
    from app.services.till_roles import effective_for_users, sync_fields

    effective = effective_for_users(db, rows)

    def _row(r: PosUser) -> PosUserSyncRow:
        row = PosUserSyncRow.model_validate(r)
        for key, value in sync_fields(effective[r.id]).items():
            if key == "till_role_id":
                value = uuid.UUID(value) if value else None
            setattr(row, key, value)
        return row

    return PosUsersSyncResponse(
        sync_type=sync_type,
        server_time=datetime.now(timezone.utc),
        users=[_row(r) for r in rows],
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
    area, area_stamps = machine_area_for_sync(db, machine)

    if not machine.shop_id:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
            area=area,
        )

    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if not shop:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
            area=area,
        )

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company:
        return SettingsSyncResponse(
            sync_type="full",
            server_time=server_time,
            settings_updated_at=server_time,
            settings={},
            business_info=None,
            area=area,
        )

    tenant = None
    if company.tenant_id:
        tenant = db.query(Tenant).filter(Tenant.id == company.tenant_id).first()

    # The till's area is part of what it shows, so a move between areas (the machine's
    # `area_changed_at`) and a rename (the area's `updated_at`) move the watermark too —
    # otherwise a delta pull after the notification would answer "unchanged".
    # The till's own settings layer moves it too (`pos_machines.settings_updated_at`).
    # The till's point of sale has a settings layer of its own, between the shop and the
    # till (`shop_areas.settings`); its `settings_updated_at` moves the watermark too.
    area_layer = get_area(db, getattr(machine, "area_id", None))
    watermark = max(
        [as_utc(effective_settings_updated_at(company, shop, tenant, machine, area_layer))] + area_stamps
    )
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
            area=area,
            training_mode=bool(shop.training_mode),
        )

    # Tenant → company → shop → area → this till: the till's own overrides win.
    all_settings = merge_all_settings_layers(company, shop, tenant, machine, area_layer)
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
    # The return-flow switches too (unset -> on).
    effective.update(resolve_refund_settings(all_settings))
    # And the force switch (unset -> off): a layer reset to inherit must reach the till
    # as `false`, not as a missing key it might read as "keep what you had".
    effective["forceTerminalNumber"] = all_settings.get("forceTerminalNumber") is True
    # "סדר אמצעי התשלום": the deepest level's order, completed with every method it does
    # not list; `[]` when no level sets one — the till then keeps each screen's own
    # (today's) order. Always sent, so a reset to inherit reaches the till on any pull.
    effective[PAY_ORDER_KEY] = resolve_pay_order(all_settings) or []
    # "חזרה אוטומטית לקיוסק" (Windows): resolved, default 10 — always sent, like the order.
    from app.services import desktop_idle_return

    effective[desktop_idle_return.KEY] = desktop_idle_return.resolve(all_settings)
    # "סוג אינטגרציית אשראי": the explicit choice down the layers (absent = automatic),
    # and Z-Credit's password for a till that charges there — its only way out of the
    # server (app/services/payment_integration.py).
    from app.services import payment_integration

    for key, value in payment_integration.till_sync_fields(
        db, machine, tenant, company, shop, area_layer
    ).items():
        if value is None:
            effective.pop(key, None)
        else:
            effective[key] = value
    # "מכשירי תשלום": all the shop's devices (`paymentDevices`, a JSON string, inactive ones
    # included), their secrets to a till without built-in clearing (`paymentDeviceSecrets`),
    # how this till picks one (`paymentDeviceMode`, `fixedPaymentDeviceId`, `paymentDeviceGroup`
    # as a JSON string) and the merged expected terminal number of all the layers, unguarded
    # (`paymentDevicesTerminalNumber`) — app/services/payment_devices.py.
    from app.services import payment_devices

    for key, value in payment_devices.till_sync_fields(db, machine, shop, all_settings).items():
        if value is None:
            effective.pop(key, None)
        else:
            effective[key] = value
    # "מצב הדרכה": the shop's flag, never a layer's setting (docs/SPEC_TRAINING_MODE.md).
    effective["trainingMode"] = bool(shop.training_mode)
    business_info = build_business_info(company, shop, all_settings)
    # "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md): the company's, on every full / delta pull,
    # beside the identity. The till picks its document type and VAT by it.
    effective["dealerType"] = business_info.dealer_type
    # Terminal configuration (clearing server, forced terminal number) is never inherited
    # onto a kiosk or a till on an external pinpad: only its own layer's value goes out, and
    # where each value comes from, for the till's own check (terminal_config_guard.py).
    from app.services import terminal_config_guard

    effective, terminal_sources = terminal_config_guard.guard(
        effective,
        machine=machine,
        merged=all_settings,
        layers=terminal_config_guard.layers_of(tenant, company, shop, area_layer, machine),
    )

    update_machine_sync_timestamp(db, str(machine.id))

    return SettingsSyncResponse(
        sync_type="delta" if since_dt else "full",
        server_time=server_time,
        settings_updated_at=watermark,
        settings=effective,
        business_info=business_info,
        area=area,
        training_mode=bool(shop.training_mode),
        terminal_config_sources=terminal_sources,
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

    from app.models.shop import Shop as _Shop

    shop_row = db.get(_Shop, machine.shop_id)
    watermark = effective_stock_updated_at(db, machine.shop_id, shop_row.company_id if shop_row else None)
    moved = getattr(machine, "area_changed_at", None)
    if moved is not None:
        moved = moved if moved.tzinfo else moved.replace(tzinfo=timezone.utc)
        watermark = max(watermark, moved)
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

    # One level per product: the stock location this till sells it from (app/services/stock.py).
    levels = levels_for_machine(db, machine, since=since_dt)
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
            level=l.location.level,
            target_id=l.location.target_id,
            reset_at=l.reset_at,
        )
        for l in levels
    ]

    return StockSyncResponse(
        sync_type="delta" if since_dt else "full",
        server_time=server_time,
        stock_updated_at=watermark,
        levels=out,
    )


@router.get(
    "/{machine_id}/parameters",
    response_model=TillParametersSyncResponse,
    response_model_by_alias=True,
)
def get_till_parameters_sync(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """
    This till's parameters ("פרמטרים לקופות"), resolved till → area → shop → company →
    default (app/services/till_parameters.py). Always the full set:
    `{"parameters": {key: value}, "updatedAt": ISO-8601 | null}`. Pulled on start and
    on an Ably `settings` notify with reason `till_parameters_updated`.
    """
    resolved = till_parameters_for_machine(db, machine)
    body = TillParametersSyncResponse(
        parameters=resolved.parameters,
        updated_at=resolved.updated_at,
    )
    # Only changes cross the wire: the till pulls this on every heartbeat, so an answer
    # identical to the one it holds is a bare 304. The ETag is a hash of the resolved
    # map itself — a deleted value or a deactivated parameter changes it too, which a
    # timestamp watermark would miss.
    if request is None:  # called directly, not over HTTP
        return body
    import hashlib
    import json as _json

    from fastapi.responses import JSONResponse, Response as _Response

    payload = body.model_dump(mode="json", by_alias=True)
    etag = '"' + hashlib.sha1(
        _json.dumps(payload["parameters"], sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest() + '"'
    if request is not None and request.headers.get("if-none-match") == etag:
        return _Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    return JSONResponse(content=payload, headers={"ETag": etag})


# ── App updates ("עדכון קופות", server → POS) ────────────────────────────────


@router.get(
    "/{machine_id}/app-update",
    response_model=AppUpdateOffer,
    response_model_by_alias=True,
)
def get_app_update(
    machine_id: str,
    version_code: int = Query(..., alias="versionCode"),
    version_name: Optional[str] = Query(None, alias="versionName"),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
    # Annotated, so a direct call (the tests) that leaves it out gets a plain None.
    platform: Annotated[Optional[str], Query()] = None,
):
    """
    The release assigned to this device, if it should take it. Asked on every sync with
    the version the device runs. `platform` "android" (absent — the Android till's call)
    or "windows" (the Windows app); `422 invalid_platform` otherwise. Only releases of
    that platform count. Resolved device → area → shop → company → tenant, newest at a
    level, rollout stage applied (app/services/app_updates.py); `available` only when
    that release is not what the device runs and not a lower versionCode — unless the
    assignment allows a (Windows) rollback (`allowDowngrade`). Every key is always present.
    """
    try:
        platform = app_updates.normalize_platform(platform)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_platform")
    resolved = app_updates.resolved_for_machine(db, machine, platform=platform)
    if resolved is None:
        return AppUpdateOffer(available=False, platform=platform)
    assignment, release = resolved
    allow_downgrade = app_updates.allows_downgrade(assignment, release)
    if not app_updates.offer_for(release, version_code, version_name, allow_downgrade=allow_downgrade):
        return AppUpdateOffer(available=False, platform=platform)
    return AppUpdateOffer(
        available=True,
        release_id=str(release.id),
        version_code=release.version_code,
        version_name=release.version_name,
        sha256=release.sha256,
        size_bytes=release.size_bytes,
        notes=release.notes,
        auto_install=bool(assignment.auto_install),
        platform=app_updates.release_platform(release),
        allow_downgrade=allow_downgrade,
        rollout_percent=assignment.rollout_percent if assignment.rollout_percent is not None else 100,
        install_window=app_updates.install_window_of(assignment),
        bridge_api=getattr(release, "bridge_api", None),
    )


#: Per platform: the download's media type and file name.
_RELEASE_DOWNLOAD = {
    "android": ("application/vnd.android.package-archive", "app-{version}.apk"),
    "windows": ("application/vnd.microsoft.portable-executable", "R2M-POS-Windows-{version}-setup.exe"),
    "kiosk_web": ("application/zip", "kiosk-web-{version}.zip"),
}


@router.get("/{machine_id}/app-update/{release_id}/apk")
@router.get("/{machine_id}/app-update/{release_id}/file")
def get_app_update_apk(
    machine_id: str,
    release_id: uuid.UUID,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    The file of the release this device resolves to now — the APK, or the Windows
    installer (`/apk` and its alias `/file` serve both). The release is looked up by id
    and the device resolved among releases of THAT release's platform: `404` unless it is
    the resolved one, so a device can only ever fetch what it was sent. Streamed from disk.
    """
    release = db.query(AppRelease).filter(AppRelease.id == release_id).first()
    if release is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release not found")
    platform = app_updates.release_platform(release)
    resolved = app_updates.resolved_for_machine(db, machine, platform=platform)
    if resolved is None or resolved[1].id != release_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release not found")
    release = resolved[1]
    if not os.path.isfile(release.file_path):
        logger.error("app release %s: file missing at %s", release.id, release.file_path)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release file missing")
    media_type, filename = _RELEASE_DOWNLOAD.get(platform, _RELEASE_DOWNLOAD["android"])
    return FileResponse(
        release.file_path,
        media_type=media_type,
        filename=filename.format(version=release.version_name),
    )


@router.post(
    "/{machine_id}/app-update/status",
    response_model=AppUpdateStatusOut,
    response_model_by_alias=True,
)
def post_app_update_status(
    machine_id: str,
    body: AppUpdateStatusIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    How taking a release is going on this till. One row per (till, release), replaced
    by each report. `404` for an unknown release; any known one is accepted, assigned
    or not, so a report that crosses a cancellation is still recorded.
    """
    release = db.query(AppRelease).filter(AppRelease.id == body.release_id).first()
    if release is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release not found")
    now = datetime.now(timezone.utc)
    row = (
        db.query(AppReleaseMachineStatus)
        .filter(
            AppReleaseMachineStatus.machine_id == machine.id,
            AppReleaseMachineStatus.release_id == release.id,
        )
        .first()
    )
    if row is None:
        row = AppReleaseMachineStatus(
            id=uuid.uuid4(),
            machine_id=machine.id,
            release_id=release.id,
            created_at=now,
        )
        db.add(row)
    row.status = body.status
    row.message = body.message
    row.version_name = body.version_name
    row.updated_at = now
    try:
        db.commit()
    except IntegrityError:
        # Two reports of one pair raced; the other one's row is there now — update it.
        db.rollback()
        row = (
            db.query(AppReleaseMachineStatus)
            .filter(
                AppReleaseMachineStatus.machine_id == machine.id,
                AppReleaseMachineStatus.release_id == release.id,
            )
            .one()
        )
        row.status = body.status
        row.message = body.message
        row.version_name = body.version_name
        row.updated_at = now
        db.commit()
    return AppUpdateStatusOut(release_id=release.id, status=row.status, updated_at=row.updated_at)
