from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.category import Category, CatalogLevel
from app.services import item_ticket
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.services import category_availability
from app.services.permission_matrix import SHOP_SCOPED_ROLES, Action, Resource, roles_for
from app.schemas.category import (
    CategoryCreate,
    CategoryInactiveAt,
    CategoryReorderRequest,
    CategoryReorderResponse,
    CategoryResponse,
    CategoryUpdate,
)
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.routers.products import _check_catalog_placement
from app.services.catalog_notify import notify_all_machines_for_tenant, notify_machine_catalog_changed
from app.services.company_hierarchy import (
    catalog_visibility_filter,
    company_scope_ids,
    user_covers_company,
)

router = APIRouter(prefix="/categories", tags=["categories"])

#: From the shared grid — see `app/services/permission_matrix.py`. This used to
#: be a tuple retyped in five routers, each one an edit away from disagreeing.
_CATALOG_ROLES = roles_for(Resource.CATALOG, Action.WRITE)


def _check_access(user: User, category: Category, db: Session):
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_company(
        db, user, category.company_id
    ):
        return
    if user.role in SHOP_SCOPED_ROLES and category.shop_id == user.shop_id:
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
    tid = str(category.tenant_id) if category.tenant_id else None
    if not tid:
        return
    if category.pos_machine_id:
        notify_machine_catalog_changed(tid, str(category.pos_machine_id), reason="category_change")
    else:
        notify_all_machines_for_tenant(db, tid, reason="category_change")


def _trigger_catalog_notify_batch(db: Session, categories: List[Category]) -> None:
    """`_trigger_catalog_notify` for several categories at once, collapsed.

    Same signals as the single-row writes emit — one reorder must not publish a
    tenant-wide fan-out once per moved category.
    """
    tenant_wide: set = set()
    machine_scoped: set = set()
    for category in categories:
        tid = str(category.tenant_id) if category.tenant_id else None
        if not tid:
            continue
        if category.pos_machine_id:
            machine_scoped.add((tid, str(category.pos_machine_id)))
        else:
            tenant_wide.add(tid)

    for tid in tenant_wide:
        notify_all_machines_for_tenant(db, tid, reason="category_change")
    for tid, machine_id in machine_scoped:
        if tid not in tenant_wide:  # already covered by the tenant-wide notify
            notify_machine_catalog_changed(tid, machine_id, reason="category_change")


@router.get("", response_model=List[CategoryResponse])
def list_categories(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
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

    # Same rule as products, and it has to be the same or the two disagree: a product
    # visible under a category that is not would render grouped beneath nothing. See
    # `catalog_company_ids` for why the scope reads upwards.
    catalog_filter = catalog_visibility_filter(db, current_user, Category)
    if catalog_filter is not None:
        query = query.filter(catalog_filter)

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

    rows = query.order_by(Category.sort_order, Category.name).offset(skip).limit(limit).all()
    return _with_inactive_at(db, rows)


def _with_inactive_at(db: Session, rows: List[Category]) -> List[CategoryResponse]:
    """Each category with the shops, areas and tills that switched it off."""
    off = category_availability.inactive_targets(db, [c.id for c in rows])
    ids = {level: set() for level in category_availability.LEVELS}
    for found in off.values():
        for row in found:
            ids[row.level].add(row.target_id)
    names = {}
    for level, model in (
        (category_availability.SHOP, Shop),
        (category_availability.AREA, ShopArea),
        (category_availability.MACHINE, POSMachine),
    ):
        if ids[level]:
            for target in db.query(model).filter(model.id.in_(list(ids[level]))).all():
                names[(level, str(target.id))] = target.name
    out = []
    for c in rows:
        response = CategoryResponse.model_validate(c)
        response.inactive_at = [
            CategoryInactiveAt(
                level=row.level,
                target_id=row.target_id,
                name=names.get((row.level, str(row.target_id))),
            )
            for row in sorted(
                off.get(str(c.id), []),
                key=lambda r: (category_availability.LEVELS.index(r.level), str(r.target_id)),
            )
            # A shop, area or till that no longer exists switches nothing off.
            if (row.level, str(row.target_id)) in names
        ]
        out.append(response)
    return out


@router.post("", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
def create_category(
    data: CategoryCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    company_id = data.company_id or current_user.company_id
    # The same rule as a new product: only into a company, shop or till the caller covers.
    _check_catalog_placement(
        db,
        current_user,
        active_tenant_id,
        company_id=company_id,
        shop_id=data.shop_id,
        pos_machine_id=data.pos_machine_id,
    )

    if data.parent_id:
        parent = db.query(Category).filter(Category.id == data.parent_id).first()
        if not parent:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent category not found")
        ensure_same_tenant(parent.tenant_id, active_tenant_id)

    category = Category(
        tenant_id=active_tenant_id,
        company_id=company_id,
        shop_id=data.shop_id,
        pos_machine_id=data.pos_machine_id,
        catalog_level=data.catalog_level,
        name=data.name,
        description=data.description,
        color=data.color,
        image_url=data.image_url,
        parent_id=data.parent_id,
        voucher_id=data.voucher_id,
        ticket_mode=item_ticket.normalize(data.ticket_mode),
        # "מחייב אישור מנהל במכירה" (app/services/restricted_items.py).
        requires_manager_approval=data.requires_manager_approval,
        is_active=data.is_active,
        sort_order=data.sort_order,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    _trigger_catalog_notify(db, category)
    return category


@router.put("/reorder", response_model=CategoryReorderResponse)
def reorder_categories(
    data: CategoryReorderRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set the position of several categories in one transaction.

    Reordering used to mean N separate `PUT /categories/{id}` calls: not atomic, and two
    dashboards dragging at once could interleave into an order neither of them chose.
    Here every position lands or none does.

    Declared **above** `PUT /categories/{category_id}` on purpose — routes match in
    declaration order, and the other way round `reorder` is swallowed as a category id.
    """
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    ids = [item.id for item in data.order]

    # Tenant filter in the *lookup*, not in a check afterwards: an id belonging to
    # another tenant simply does not come back, and the count check below turns that
    # into a 404. A caller can neither renumber nor probe for another tenant's rows.
    rows = (
        db.query(Category)
        .filter(Category.id.in_(ids), Category.tenant_id == active_tenant_id)
        .all()
    )
    by_id = {row.id: row for row in rows}
    if len(by_id) != len(ids):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="One or more categories not found",
        )

    # Role scoping on top of the tenant scope: a company manager reorders their own
    # (and their subsidiaries') categories, a shop manager their shop's.
    for row in rows:
        _check_access(current_user, row, db)

    moved = []
    for item in data.order:
        row = by_id[item.id]
        if row.sort_order != item.sort_order:
            row.sort_order = item.sort_order
            moved.append(row)

    # One commit for the whole batch: the session has held every change until now, so a
    # failure anywhere above leaves the previous order intact.
    db.commit()

    if moved:
        _trigger_catalog_notify_batch(db, moved)

    return CategoryReorderResponse(updated=len(data.order))


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
    _check_access(current_user, category, db)
    return category


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: str,
    data: CategoryUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _check_access(current_user, category, db)

    if data.parent_id is not None:
        if _check_circular(db, category_id, str(data.parent_id)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Circular reference detected")
        if not db.query(Category).filter(Category.id == data.parent_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent category not found")

    patch = data.model_dump(exclude_unset=True, by_alias=False)
    voucher_changed = "voucher_id" in patch and patch["voucher_id"] != category.voucher_id
    if "ticket_mode" in patch:
        patch["ticket_mode"] = item_ticket.normalize(patch["ticket_mode"])
    # Products without their own mode inherit this one, and the till reads the resolved
    # mode off each product — so a change has to reach them through delta sync too.
    ticket_changed = "ticket_mode" in patch and patch["ticket_mode"] != category.ticket_mode

    for field, value in patch.items():
        setattr(category, field, value)

    # Products inherit the category voucher when they have none of their own. Their own
    # updated_at is unchanged by a category edit, so bump it to keep delta sync correct.
    if voucher_changed or ticket_changed:
        db.query(Product).filter(Product.category_id == category.id).update(
            {Product.updated_at: func.now()}, synchronize_session=False
        )

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
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    ensure_same_tenant(category.tenant_id, active_tenant_id)
    _check_access(current_user, category, db)

    if db.query(Product).filter(Product.category_id == category_id).count():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Category has associated products")
    if db.query(Category).filter(Category.parent_id == category_id).count():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Category has child categories")

    tenant_id = str(category.tenant_id) if category.tenant_id else None
    machine_id = str(category.pos_machine_id) if category.pos_machine_id else None

    db.delete(category)
    db.commit()

    if tenant_id:
        if machine_id:
            notify_machine_catalog_changed(tenant_id, machine_id, reason="category_deleted")
        else:
            notify_all_machines_for_tenant(db, tenant_id, reason="category_deleted")
