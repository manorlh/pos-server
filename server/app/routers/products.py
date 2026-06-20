from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.product import Product, CatalogLevel
from app.models.category import Category
from app.models.merchant import Merchant
from app.models.user import User, UserRole
from app.schemas.product import ProductCreate, ProductUpdate, ProductResponse
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.catalog_notify import notify_all_machines_for_merchant, notify_machine_catalog_changed
from app.services.sku_sequence import resolve_sku_for_create
from app.services.tenant_sku_sequence import allocate_global_sku

router = APIRouter(prefix="/products", tags=["products"])

_MERCHANT_ROLES = (
    UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
    UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
)


def _check_product_access(user: User, product: Product):
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.MERCHANT_ADMIN and product.merchant_id == user.merchant_id:
        return
    if user.role == UserRole.COMPANY_MANAGER and product.company_id == user.company_id:
        return
    if user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and product.shop_id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _trigger_catalog_notify(db: Session, product: Product):
    mid = str(product.merchant_id) if product.merchant_id else None
    if not mid:
        return
    if product.pos_machine_id:
        notify_machine_catalog_changed(mid, str(product.pos_machine_id), reason="product_change")
    else:
        notify_all_machines_for_merchant(db, mid, reason="product_change")


@router.get("", response_model=List[ProductResponse])
def list_products(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    merchant_id: Optional[str] = Query(None, alias="merchantId"),
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
):
    query = db.query(Product).filter(Product.tenant_id == active_tenant_id)

    if current_user.role == UserRole.MERCHANT_ADMIN:
        query = query.filter(Product.merchant_id == current_user.merchant_id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(Product.company_id == current_user.company_id)
    elif current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(Product.shop_id == current_user.shop_id)

    if merchant_id:
        query = query.filter(Product.merchant_id == merchant_id)
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
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                Product.name.ilike(term),
                Product.sku.ilike(term),
                Product.global_sku.ilike(term),
                Product.barcode.ilike(term),
            )
        )

    return query.order_by(Product.name).offset(skip).limit(limit).all()


@router.post("", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
def create_product(
    data: ProductCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    merchant_id = data.merchant_id or current_user.merchant_id
    if not merchant_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="merchantId is required")

    merchant = db.query(Merchant).filter(Merchant.id == merchant_id).first()
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
    ensure_same_tenant(merchant.tenant_id, active_tenant_id)

    final_sku, sku_auto_assigned = resolve_sku_for_create(db, merchant_id, data.sku)

    global_sku = None
    if data.catalog_level == CatalogLevel.GLOBAL or data.catalog_level == "global":
        global_sku = allocate_global_sku(db, active_tenant_id)

    category = db.query(Category).filter(Category.id == data.category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)

    product = Product(
        tenant_id=active_tenant_id,
        merchant_id=merchant_id,
        company_id=data.company_id,
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
    )
    db.add(product)
    db.commit()
    db.refresh(product)
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
    _check_product_access(current_user, product)
    return product


@router.put("/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: str,
    data: ProductUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product)

    if data.category_id and not db.query(Category).filter(Category.id == data.category_id).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category not found")

    if data.category_id:
        cat = db.query(Category).filter(Category.id == data.category_id).first()
        ensure_same_tenant(cat.tenant_id, active_tenant_id)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
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
                Product.merchant_id == product.merchant_id,
                Product.sku == new_sku,
                Product.id != product.id,
            ).first():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="SKU already exists for this merchant",
                )
        updates["sku"] = new_sku

    for field, value in updates.items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)
    _trigger_catalog_notify(db, product)
    return product


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _check_product_access(current_user, product)

    merchant_id = str(product.merchant_id) if product.merchant_id else None
    machine_id = str(product.pos_machine_id) if product.pos_machine_id else None

    db.delete(product)
    db.commit()

    if merchant_id:
        if machine_id:
            notify_machine_catalog_changed(merchant_id, machine_id, reason="product_deleted")
        else:
            notify_all_machines_for_merchant(db, merchant_id, reason="product_deleted")
