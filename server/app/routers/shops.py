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
    ShopProductCatalogRow,
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

router = APIRouter(prefix="/shops", tags=["shops"])


def _check_shop_access(user: User, shop: Shop, db: Session):
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return
    if user.role == UserRole.MERCHANT_ADMIN:
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if company and company.merchant_id == user.merchant_id:
            return
    if user.role == UserRole.COMPANY_MANAGER and shop.company_id == user.company_id:
        return
    if user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and shop.id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_shop_override_write(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.CASHIER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )
    _check_shop_access(user, shop, db)


@router.get("/{shop_id}/product-overrides", response_model=List[ShopProductCatalogRow])
def list_shop_product_overrides(
    shop_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
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

    q = (
        db.query(ShopProductOverride, Product)
        .join(Product, Product.id == ShopProductOverride.global_product_id)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            Product.merchant_id == company.merchant_id,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
        )
        .order_by(Product.name)
        .offset(skip)
        .limit(limit)
    )

    rows: List[ShopProductCatalogRow] = []
    for ovr, p in q.all():
        rows.append(
            ShopProductCatalogRow(
                global_product_id=p.id,
                name=p.name,
                sku=p.sku,
                category_id=p.category_id,
                global_price=float(p.price),
                override_price=float(ovr.price) if ovr.price is not None else None,
                is_listed=ovr.is_listed,
                is_available=ovr.is_available,
            )
        )
    return rows


@router.get("/{shop_id}/product-catalog-candidates", response_model=List[ShopProductCatalogCandidate])
def list_shop_product_catalog_candidates(
    shop_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    search: Optional[str] = Query(None, description="Filter by name or SKU (contains, case-insensitive)"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Global products for this merchant **not** yet assigned to the shop (library for Add)."""
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
        Product.merchant_id == company.merchant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
        ~Product.id.in_(assigned_ids),
    )
    if search and search.strip():
        term = f"%{search.strip()}%"
        q = q.filter(or_(Product.name.ilike(term), Product.sku.ilike(term)))
    q = q.order_by(Product.name).offset(skip).limit(limit)

    return [
        ShopProductCatalogCandidate(
            global_product_id=p.id,
            name=p.name,
            sku=p.sku,
            category_id=p.category_id,
            global_price=float(p.price),
        )
        for p in q.all()
    ]


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
    if g.merchant_id != company.merchant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in shop merchant")

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
            is_available=True,
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
    if g.merchant_id != company.merchant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in shop merchant")

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

    if "price" in payload:
        ovr.price = payload["price"]
    if "is_listed" in payload:
        ovr.is_listed = bool(payload["is_listed"])
    if "is_available" in payload:
        ovr.is_available = bool(payload["is_available"])

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
    merchant_id: Optional[str] = Query(None, alias="merchantId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Shop).filter(Shop.tenant_id == active_tenant_id)

    if current_user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(Shop.company_id == current_user.company_id)
    elif current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(Shop.id == current_user.shop_id)
    elif current_user.role == UserRole.MERCHANT_ADMIN:
        # Shops whose company belongs to this merchant
        company_ids = db.query(Company.id).filter(Company.merchant_id == current_user.merchant_id)
        query = query.filter(Shop.company_id.in_(company_ids))
    elif company_id:
        query = query.filter(Shop.company_id == company_id)

    if merchant_id:
        try:
            mid = uuid_mod.UUID(str(merchant_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid merchantId")
        if current_user.role == UserRole.MERCHANT_ADMIN:
            if current_user.merchant_id != mid:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        elif current_user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        m_company_ids = db.query(Company.id).filter(Company.merchant_id == mid)
        query = query.filter(Shop.company_id.in_(m_company_ids))

    return query.all()


@router.post("", response_model=ShopResponse, status_code=status.HTTP_201_CREATED)
def create_shop(
    data: ShopCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    company = db.query(Company).filter(Company.id == data.company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company not found")

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
    db.commit()
    db.refresh(shop)
    return shop


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
    _check_shop_access(current_user, shop, db)

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(shop, field, value)
    db.commit()
    db.refresh(shop)
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
    db.delete(shop)
    db.commit()
