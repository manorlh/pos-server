"""
Customer CRUD (dashboard, Clerk-user JWT).

Shaped on `app/routers/vouchers.py`: tenant-scoped rows, `_CATALOG_ROLES` on every
handler including the reads, `ensure_same_tenant` on every single-row fetch, and a
catalog notify after every write so the tills pull the change instead of waiting for
their next poll — customers ride the catalog sync, so a new customer is as urgent as
a new product.

**Role gating.** Reads and writes are both restricted to
`super_admin / distributor / company_manager / shop_manager`, i.e. cashiers are
excluded from both. That is the same conclusion the recent role-guard work reached
for vouchers, and for a sharper reason here: this table is personal and commercial
data — names, phone numbers, email addresses, ח.פ. numbers of the merchant's business
customers — and it is scoped to the *tenant*, while a cashier's every other view is
scoped to one shop. A tenant-wide customer list is exactly the kind of read a cashier
account should not be able to make, and excluding them costs nothing: a cashier does
not need this endpoint, because the till receives customers through the machine-token
catalog sync (`GET /sync/{machine_id}/catalog`), not through here.

Delete is a tombstone, never a DELETE — see the note on `delete_customer`.
"""
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, ensure_same_tenant
from app.models.customer import Customer
from app.models.user import User, UserRole
from app.services.permission_matrix import Action, Resource, roles_for
from app.schemas.customer import (
    CustomerCreate,
    CustomerListResponse,
    CustomerResponse,
    CustomerUpdate,
)
from app.services.catalog_notify import notify_all_machines_for_tenant

router = APIRouter(prefix="/customers", tags=["customers"])

#: From the shared grid — see `app/services/permission_matrix.py`. This used to
#: be a tuple retyped in five routers, each one an edit away from disagreeing.
_CATALOG_ROLES = roles_for(Resource.CUSTOMER, Action.WRITE)


def _require_role(current_user: User) -> None:
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _trigger_catalog_notify(db: Session, tenant_id) -> None:
    tid = str(tenant_id) if tenant_id else None
    if tid:
        notify_all_machines_for_tenant(db, tid, reason="customer_change")


def _load(db: Session, customer_id: str, active_tenant_id) -> Customer:
    customer = db.query(Customer).filter(Customer.id == customer_id).first()
    if not customer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    ensure_same_tenant(customer.tenant_id, active_tenant_id)
    return customer


def _assert_vat_number_free(
    db: Session, tenant_id, vat_number: Optional[str], *, exclude_id=None
) -> None:
    """
    One ח.פ. per tenant.

    Enforced here as well as by the unique constraint so the caller gets a 409 with a
    sentence in it rather than a 500 from a constraint violation. Deleted rows are
    included in the check on purpose: the number is still spoken for, and silently
    creating a second customer with the same registration is how a merchant ends up
    with two sets of invoices for one legal entity.
    """
    if not vat_number:
        return
    query = db.query(Customer.id).filter(
        Customer.tenant_id == tenant_id,
        Customer.vat_number == vat_number,
    )
    if exclude_id is not None:
        query = query.filter(Customer.id != exclude_id)
    if query.first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A customer with this VAT number already exists for this tenant",
        )


@router.get("", response_model=CustomerListResponse, response_model_by_alias=True)
def list_customers(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
    is_active: Optional[bool] = Query(None, alias="isActive"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    search: Optional[str] = Query(None, description="Filter by name, VAT number, phone or email"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role(current_user)

    query = db.query(Customer).filter(Customer.tenant_id == active_tenant_id)
    if not include_deleted:
        query = query.filter(Customer.deleted_at.is_(None))
    if is_active is not None:
        query = query.filter(Customer.is_active == is_active)
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                Customer.name.ilike(term),
                Customer.vat_number.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )

    total = query.count()
    items = (
        query.order_by(Customer.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return CustomerListResponse(page=page, page_size=page_size, total=total, items=items)


@router.post(
    "",
    response_model=CustomerResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def create_customer(
    data: CustomerCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role(current_user)
    _assert_vat_number_free(db, active_tenant_id, data.vat_number)

    customer = Customer(
        tenant_id=active_tenant_id,
        name=data.name,
        vat_number=data.vat_number,
        phone=data.phone,
        email=str(data.email) if data.email else None,
        address=data.address,
        address_number=data.address_number,
        city=data.city,
        postal_code=data.postal_code,
        country=data.country,
        notes=data.notes,
        is_active=data.is_active,
    )
    db.add(customer)
    db.commit()
    db.refresh(customer)
    _trigger_catalog_notify(db, active_tenant_id)
    return customer


@router.get("/{customer_id}", response_model=CustomerResponse, response_model_by_alias=True)
def get_customer(
    customer_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role(current_user)
    return _load(db, customer_id, active_tenant_id)


@router.put("/{customer_id}", response_model=CustomerResponse, response_model_by_alias=True)
def update_customer(
    customer_id: str,
    data: CustomerUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role(current_user)
    customer = _load(db, customer_id, active_tenant_id)

    updates = data.model_dump(exclude_unset=True, by_alias=False)
    if "vat_number" in updates:
        _assert_vat_number_free(
            db, active_tenant_id, updates["vat_number"], exclude_id=customer.id
        )
    if "email" in updates and updates["email"] is not None:
        updates["email"] = str(updates["email"])

    for field, value in updates.items():
        setattr(customer, field, value)

    db.commit()
    db.refresh(customer)
    _trigger_catalog_notify(db, active_tenant_id)
    return customer


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Remove a customer from the tills without removing them from the books.

    A tombstone (`deleted_at` + `is_active=false`), not a DELETE, and not because
    deleting is hard — because a till that has been offline can push a sale tomorrow
    for a customer deleted today. That document is a tax invoice; if the row it points
    at is gone it can no longer say who it was issued to, and the FK on
    `transactions.customer_ref_id` would refuse the write outright.

    So the row stays, stops reaching new sales (the catalog sync ships it with
    `deleted: true` and the till drops it), and keeps answering for the documents
    already issued against it.
    """
    _require_role(current_user)
    customer = _load(db, customer_id, active_tenant_id)

    if customer.deleted_at is None:
        customer.deleted_at = datetime.now(timezone.utc)
        customer.is_active = False
        db.commit()
        _trigger_catalog_notify(db, active_tenant_id)
