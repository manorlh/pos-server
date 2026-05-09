"""
REST sync endpoint — used by POS as HTTP fallback when MQTT is unavailable.

GET  /sync/{machine_id}/catalog?since=ISO_TS   → full or delta catalog
POST /sync/{machine_id}/catalog                → batch of POS-side catalog changes
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.product import Product, CatalogLevel
from app.models.sync_log import SyncLog, SyncAction, SyncDirection, SyncEntityType, SyncStatus
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate
from app.schemas.pos_user import PosUsersSyncResponse, PosUserSyncRow
from app.schemas.transaction import (
    TransactionsBatchRequest,
    TransactionsBatchResponse,
)
from app.schemas.trading_day import TradingDayOut
from app.schemas.z_report import (
    ZReportIn,
    ZReportMissingResponse,
    ZReportUpsertResponse,
)
from app.services.catalog_notify import notify_all_machines_for_merchant
from app.services.sync import (
    get_categories_for_sync,
    get_products_for_sync,
    merge_categories_referenced_by_products,
    update_machine_sync_timestamp,
)
from app.services.transactions import (
    apply_z_report,
    check_z_report_preconditions,
    find_open_trading_day,
    publish_transactions_synced,
    publish_z_report_closed,
    upsert_transactions,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sync", tags=["sync"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CatalogChangeItem(BaseModel):
    action: Literal["create", "update", "delete"]
    entity: Literal["product", "category"]
    local_id: str = Field(..., alias="localId")
    cloud_id: Optional[str] = Field(None, alias="cloudId")
    updated_at: str = Field(..., alias="updatedAt")
    data: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class CatalogBatchRequest(BaseModel):
    changes: List[CatalogChangeItem]


class CatalogSyncResponse(BaseModel):
    sync_type: str = Field(..., alias="syncType")
    server_time: str = Field(..., alias="serverTime")
    products: List[Dict[str, Any]]
    categories: List[Dict[str, Any]]

    class Config:
        populate_by_name = True


# ── Helpers ───────────────────────────────────────────────────────────────────

def _apply_product_change(
    item: CatalogChangeItem, machine: POSMachine, db: Session
) -> SyncStatus:
    """
    Apply a single product change coming from the POS.
    Conflict rule: latest updated_at wins.
    """
    incoming_ts = datetime.fromisoformat(item.updated_at.replace("Z", "+00:00"))

    if item.action == "delete":
        if item.cloud_id:
            product = db.query(Product).filter(Product.id == item.cloud_id).first()
            if product:
                db.delete(product)
        return SyncStatus.SUCCESS

    if not item.data:
        return SyncStatus.FAILED

    # Find existing record
    product: Optional[Product] = None
    if item.cloud_id:
        product = db.query(Product).filter(Product.id == item.cloud_id).first()

    if product:
        # Conflict resolution: only apply if incoming is newer
        if product.updated_at and incoming_ts <= product.updated_at.replace(tzinfo=timezone.utc):
            return SyncStatus.CONFLICT_RESOLVED
        # Apply update
        allowed = (
            "name",
            "description",
            "price",
            "image_url",
            "in_stock",
            "is_available",
            "stock_quantity",
            "barcode",
            "tax_rate",
        )
        for key in allowed:
            camel = "".join(w.capitalize() if i else w for i, w in enumerate(key.split("_")))
            if camel in item.data:
                setattr(product, key, item.data[camel])
        product.is_local_override = True
    else:
        # New product from POS — create as local catalog entry
        product = Product(
            tenant_id=machine.tenant_id,
            merchant_id=machine.merchant_id,
            shop_id=machine.shop_id,
            pos_machine_id=machine.id,
            catalog_level=CatalogLevel.LOCAL,
            is_local_override=True,
            name=item.data.get("name", ""),
            description=item.data.get("description"),
            price=item.data.get("price", 0),
            sku=item.data.get("sku", item.local_id),
            image_url=item.data.get("imageUrl"),
            in_stock=item.data.get("inStock", True),
            is_available=item.data.get("isAvailable", True),
            stock_quantity=item.data.get("stockQuantity", 0),
            barcode=item.data.get("barcode"),
            tax_rate=item.data.get("taxRate"),
            category_id=item.data.get("categoryId"),
        )
        db.add(product)

    return SyncStatus.SUCCESS


def _apply_category_change(
    item: CatalogChangeItem, machine: POSMachine, db: Session
) -> SyncStatus:
    incoming_ts = datetime.fromisoformat(item.updated_at.replace("Z", "+00:00"))

    if item.action == "delete":
        if item.cloud_id:
            cat = db.query(Category).filter(Category.id == item.cloud_id).first()
            if cat:
                db.delete(cat)
        return SyncStatus.SUCCESS

    if not item.data:
        return SyncStatus.FAILED

    cat: Optional[Category] = None
    if item.cloud_id:
        cat = db.query(Category).filter(Category.id == item.cloud_id).first()

    if cat:
        if cat.updated_at and incoming_ts <= cat.updated_at.replace(tzinfo=timezone.utc):
            return SyncStatus.CONFLICT_RESOLVED
        allowed = ("name", "description", "color", "image_url", "is_active", "sort_order")
        for key in allowed:
            camel = "".join(w.capitalize() if i else w for i, w in enumerate(key.split("_")))
            if camel in item.data:
                setattr(cat, key, item.data[camel])
    else:
        cat = Category(
            tenant_id=machine.tenant_id,
            merchant_id=machine.merchant_id,
            shop_id=machine.shop_id,
            pos_machine_id=machine.id,
            catalog_level=CategoryCatalogLevel.LOCAL,
            name=item.data.get("name", ""),
            description=item.data.get("description"),
            color=item.data.get("color"),
            image_url=item.data.get("imageUrl"),
            is_active=item.data.get("isActive", True),
            sort_order=item.data.get("sortOrder", 0),
        )
        db.add(cat)

    return SyncStatus.SUCCESS


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

    mid = str(machine.merchant_id) if machine.merchant_id else None
    mqid = str(machine.id)

    products = get_products_for_sync(db, mid, mqid, since=since_dt)
    categories = get_categories_for_sync(db, mid, mqid, since=since_dt)
    if since_dt and products:
        categories = merge_categories_referenced_by_products(db, machine, products, categories)

    update_machine_sync_timestamp(db, mqid)

    return CatalogSyncResponse(
        sync_type=sync_type,
        server_time=datetime.now(timezone.utc).isoformat(),
        products=products,
        categories=categories,
    )


@router.post("/{machine_id}/catalog", status_code=status.HTTP_200_OK)
def post_catalog_changes(
    machine_id: str,
    body: CatalogBatchRequest,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Optional batch upload from POS (legacy). Prefer creating catalog via cloud APIs first.
    """

    results = {"applied": 0, "conflicts": 0, "failed": 0}
    logs: List[SyncLog] = []

    for item in body.changes:
        try:
            if item.entity == "product":
                result_status = _apply_product_change(item, machine, db)
            else:
                result_status = _apply_category_change(item, machine, db)

            logs.append(SyncLog(
                machine_id=machine.id,
                direction=SyncDirection.POS_TO_SERVER,
                entity_type=SyncEntityType.PRODUCTS if item.entity == "product" else SyncEntityType.CATEGORIES,
                action=SyncAction(item.action),
                status=result_status,
                payload=item.model_dump(by_alias=True),
            ))

            if result_status == SyncStatus.SUCCESS:
                results["applied"] += 1
            elif result_status == SyncStatus.CONFLICT_RESOLVED:
                results["conflicts"] += 1
            else:
                results["failed"] += 1

        except Exception as e:
            logger.error(f"Error applying catalog change {item.local_id}: {e}")
            results["failed"] += 1

    db.bulk_save_objects(logs)
    db.commit()
    update_machine_sync_timestamp(db, machine_id)

    return {
        "serverTime": datetime.now(timezone.utc).isoformat(),
        **results,
    }


@router.post(
    "/{machine_id}/products",
    response_model=ProductResponse,
    status_code=status.HTTP_201_CREATED,
)
def machine_create_cloud_product(
    machine_id: str,
    data: ProductCreate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """POS: create a global catalog product on the cloud (source of truth)."""
    if not machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a merchant",
        )

    if db.query(Product).filter(
        Product.merchant_id == machine.merchant_id,
        Product.sku == data.sku,
    ).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="SKU already exists for this merchant",
        )

    cat = db.query(Category).filter(Category.id == data.category_id).first()
    if not cat or cat.merchant_id != machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category not found for this merchant",
        )

    product = Product(
        tenant_id=machine.tenant_id,
        merchant_id=machine.merchant_id,
        company_id=data.company_id,
        shop_id=data.shop_id,
        pos_machine_id=None,
        category_id=data.category_id,
        global_product_id=data.global_product_id,
        catalog_level=CatalogLevel.GLOBAL,
        is_local_override=False,
        name=data.name,
        description=data.description,
        price=data.price,
        sku=data.sku,
        image_url=data.image_url,
        in_stock=data.in_stock,
        is_available=True,
        stock_quantity=data.stock_quantity,
        barcode=data.barcode,
        tax_rate=data.tax_rate,
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    notify_all_machines_for_merchant(db, str(machine.merchant_id), reason="product_created")
    return product


@router.post(
    "/{machine_id}/categories",
    response_model=CategoryResponse,
    status_code=status.HTTP_201_CREATED,
)
def machine_create_cloud_category(
    machine_id: str,
    data: CategoryCreate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """POS: create a global category on the cloud (source of truth)."""
    if not machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a merchant",
        )

    if data.parent_id:
        parent = db.query(Category).filter(Category.id == data.parent_id).first()
        if not parent or parent.merchant_id != machine.merchant_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Parent category not found for this merchant",
            )

    category = Category(
        tenant_id=machine.tenant_id,
        merchant_id=machine.merchant_id,
        company_id=data.company_id,
        shop_id=data.shop_id,
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
    db.commit()
    db.refresh(category)
    notify_all_machines_for_merchant(db, str(machine.merchant_id), reason="category_created")
    return category


def _machine_may_edit_global_product(machine: POSMachine, product: Product) -> None:
    if not machine.merchant_id or product.merchant_id != machine.merchant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in machine merchant")
    if product.pos_machine_id is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Machine-local catalog rows cannot be edited via this endpoint",
        )
    if product.catalog_level != CatalogLevel.GLOBAL:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only global catalog products")


def _machine_may_edit_global_category(machine: POSMachine, category: Category) -> None:
    if not machine.merchant_id or category.merchant_id != machine.merchant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Category not in machine merchant")
    if category.pos_machine_id is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Machine-local categories cannot be edited via this endpoint",
        )
    if category.catalog_level != CategoryCatalogLevel.GLOBAL:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only global categories")


@router.put("/{machine_id}/products/{product_id}", response_model=ProductResponse)
def machine_update_cloud_product(
    machine_id: str,
    product_id: str,
    data: ProductUpdate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    _machine_may_edit_global_product(machine, product)

    if data.category_id and not db.query(Category).filter(Category.id == data.category_id).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found")

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)
    notify_all_machines_for_merchant(db, str(machine.merchant_id), reason="product_updated")
    return product


@router.delete("/{machine_id}/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def machine_delete_cloud_product(
    machine_id: str,
    product_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    _machine_may_edit_global_product(machine, product)

    mid = str(product.merchant_id)
    db.delete(product)
    db.commit()
    notify_all_machines_for_merchant(db, mid, reason="product_deleted")
    return None


@router.put("/{machine_id}/categories/{category_id}", response_model=CategoryResponse)
def machine_update_cloud_category(
    machine_id: str,
    category_id: str,
    data: CategoryUpdate,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    _machine_may_edit_global_category(machine, category)

    if data.parent_id is not None:
        parent = db.query(Category).filter(Category.id == data.parent_id).first()
        if not parent or parent.merchant_id != machine.merchant_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent category not found")

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(category, field, value)

    db.commit()
    db.refresh(category)
    notify_all_machines_for_merchant(db, str(machine.merchant_id), reason="category_updated")
    return category


@router.delete("/{machine_id}/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def machine_delete_cloud_category(
    machine_id: str,
    category_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    _machine_may_edit_global_category(machine, category)

    if db.query(Product).filter(Product.category_id == category_id).count():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Category has associated products",
        )

    mid = str(category.merchant_id)
    db.delete(category)
    db.commit()
    notify_all_machines_for_merchant(db, mid, reason="category_deleted")
    return None


# ── Transactions + Z-report (POS → server) ────────────────────────────────────

@router.post(
    "/{machine_id}/transactions",
    response_model=TransactionsBatchResponse,
    status_code=status.HTTP_200_OK,
)
def post_transactions(
    machine_id: str,
    body: TransactionsBatchRequest,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Idempotent transactions upsert. Same id retried returns status='duplicate'."""
    if not machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a merchant",
        )

    results = upsert_transactions(db, machine, body.transactions)

    accepted_count = sum(1 for r in results if r.status == "accepted")
    db.bulk_save_objects([
        SyncLog(
            machine_id=machine.id,
            direction=SyncDirection.POS_TO_SERVER,
            entity_type=SyncEntityType.TRANSACTIONS,
            entity_id=r.id,
            action=SyncAction.CREATE if r.status == "accepted" else SyncAction.UPDATE,
            status=SyncStatus.SUCCESS if r.status != "rejected" else SyncStatus.FAILED,
            conflict_note=r.reason,
        )
        for r in results
    ])
    db.commit()

    if accepted_count > 0:
        publish_transactions_synced(machine.merchant_id, machine.id, accepted_count)

    return TransactionsBatchResponse(
        server_time=datetime.now(timezone.utc),
        results=results,
    )


@router.post(
    "/{machine_id}/z-report",
    status_code=status.HTTP_200_OK,
    responses={
        409: {"model": ZReportMissingResponse},
        200: {"model": ZReportUpsertResponse},
    },
)
def post_z_report(
    machine_id: str,
    body: ZReportIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Close a trading day with a Z-report. Idempotent: a retry returns status='duplicate'.
    Returns 409 with missing transaction ids if any expected tx is not yet on the cloud
    (POS must flush those tx and retry).
    """
    if not machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a merchant",
        )

    missing, stale = check_z_report_preconditions(db, machine, body)
    if missing or stale:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=ZReportMissingResponse(
                missing_ids=missing,
                stale_ids=stale,
            ).model_dump(by_alias=True, mode="json"),
        )

    z_report, outcome = apply_z_report(db, machine, body)
    db.add(SyncLog(
        machine_id=machine.id,
        direction=SyncDirection.POS_TO_SERVER,
        entity_type=SyncEntityType.Z_REPORT,
        entity_id=z_report.id,
        action=SyncAction.CREATE,
        status=SyncStatus.SUCCESS,
        conflict_note=None if outcome == "accepted" else "duplicate z-report",
    ))
    db.commit()
    db.refresh(z_report)

    if outcome == "accepted":
        publish_z_report_closed(machine.merchant_id, machine.id, z_report.id, z_report.trading_day_id)

    return ZReportUpsertResponse(
        status=outcome,
        z_report_id=z_report.id,
        trading_day_id=z_report.trading_day_id,
        server_time=datetime.now(timezone.utc),
    )


@router.get(
    "/{machine_id}/trading-day/current",
    response_model=Optional[TradingDayOut],
)
def get_current_trading_day(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Helper for POS recovery after restart — returns the open trading day if any."""
    return find_open_trading_day(db, machine.id)


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
