from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.category import Category, CatalogLevel
from app.models.product import Product
from app.models.user import User, UserRole
from app.schemas.category import CategoryCreate, CategoryUpdate, CategoryResponse
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.catalog_notify import notify_all_machines_for_merchant, notify_machine_catalog_changed

router = APIRouter(prefix="/categories", tags=["categories"])

_MERCHANT_ROLES = (
    UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
    UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
)


def _check_access(user: User, category: Category):
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.MERCHANT_ADMIN and category.merchant_id == user.merchant_id:
        return
    if user.role == UserRole.COMPANY_MANAGER and category.company_id == user.company_id:
        return
    if user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and category.shop_id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_circular(db: Session, category_id: str, parent_id: str) -> bool:
    if category_id == parent_id:
        return True
    current = parent_id
    visited: set = set()
    while current:
        if current in visited or current == category_id:
            return True
        visited.add(current)
        parent = db.query(Category).filter(Category.id == current).first()
        if not parent or not parent.parent_id:
            break
        current = str(parent.parent_id)
    return False


def _trigger_catalog_notify(db: Session, category: Category):
    mid = str(category.merchant_id) if category.merchant_id else None
    if not mid:
        return
    if category.pos_machine_id:
        notify_machine_catalog_changed(mid, str(category.pos_machine_id), reason="category_change")
    else:
        notify_all_machines_for_merchant(db, mid, reason="category_change")


@router.get("", response_model=List[CategoryResponse])
def list_categories(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    merchant_id: Optional[str] = Query(None, alias="merchantId"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    pos_machine_id: Optional[str] = Query(None, alias="posMachineId"),
    parent_id: Optional[str] = Query(None, alias="parentId"),
    catalog_level: Optional[str] = Query(None, alias="catalogLevel"),
    is_active: Optional[bool] = Query(None, alias="isActive"),
    include_children: bool = Query(False),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Category).filter(Category.tenant_id == active_tenant_id)

    if current_user.role == UserRole.MERCHANT_ADMIN:
        query = query.filter(Category.merchant_id == current_user.merchant_id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(Category.company_id == current_user.company_id)
    elif current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(Category.shop_id == current_user.shop_id)

    if merchant_id:
        query = query.filter(Category.merchant_id == merchant_id)
    if company_id:
        query = query.filter(Category.company_id == company_id)
    if shop_id:
        query = query.filter(Category.shop_id == shop_id)
    if pos_machine_id:
        query = query.filter(Category.pos_machine_id == pos_machine_id)
    if catalog_level:
        query = query.filter(Category.catalog_level == catalog_level)
    if parent_id:
        query = query.filter(Category.parent_id == parent_id)
    if is_active is not None:
        query = query.filter(Category.is_active == is_active)

    return query.order_by(Category.sort_order, Category.name).offset(skip).limit(limit).all()


@router.post("", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
def create_category(
    data: CategoryCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    merchant_id = data.merchant_id or current_user.merchant_id
    if not merchant_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="merchantId is required")

    if data.parent_id:
        parent = db.query(Category).filter(Category.id == data.parent_id).first()
        if not parent:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent category not found")

    category = Category(
        tenant_id=active_tenant_id,
        merchant_id=merchant_id,
        company_id=data.company_id,
        shop_id=data.shop_id,
        pos_machine_id=data.pos_machine_id,
        catalog_level=data.catalog_level,
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
    _trigger_catalog_notify(db, category)
    return category


@router.get("/{category_id}", response_model=CategoryResponse)
def get_category(
    category_id: str,
    include_children: bool = Query(False),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _check_access(current_user, category)
    return category


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: str,
    data: CategoryUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _check_access(current_user, category)

    if data.parent_id is not None:
        if _check_circular(db, category_id, str(data.parent_id)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Circular reference detected")
        if not db.query(Category).filter(Category.id == data.parent_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent category not found")

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(category, field, value)

    db.commit()
    db.refresh(category)
    _trigger_catalog_notify(db, category)
    return category


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _MERCHANT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _check_access(current_user, category)

    if db.query(Product).filter(Product.category_id == category_id).count():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Category has associated products")
    if db.query(Category).filter(Category.parent_id == category_id).count():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Category has child categories")

    merchant_id = str(category.merchant_id) if category.merchant_id else None
    machine_id = str(category.pos_machine_id) if category.pos_machine_id else None

    db.delete(category)
    db.commit()

    if merchant_id:
        if machine_id:
            notify_machine_catalog_changed(merchant_id, machine_id, reason="category_deleted")
        else:
            notify_all_machines_for_merchant(db, merchant_id, reason="category_deleted")
