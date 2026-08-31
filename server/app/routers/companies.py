from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.company import Company
from app.models.user import User, UserRole
from app.schemas.company import CompanyCreate, CompanyUpdate, CompanyResponse
from app.middleware.auth import get_current_user, get_current_distributor, get_active_tenant_id, ensure_same_tenant
from app.services.company_hierarchy import (
    MAX_COMPANY_DEPTH,
    company_depth,
    company_scope_ids,
    descendant_company_ids,
    invalidate_company_hierarchy_cache,
    subtree_height,
    user_covers_company,
)
from app.services.settings_notify import notify_machines_for_company_settings

router = APIRouter(prefix="/companies", tags=["companies"])

_COMPANY_PROFILE_FIELDS = frozenset({"name", "vat_number", "address", "city"})

#: Who may move a company inside the group tree. Reparenting hands the new parent's
#: managers every shop, till, transaction and staff row underneath, so it is an
#: org-structure decision and not part of editing a company's profile — even though a
#: company manager may edit that profile.
_REPARENT_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR})

#: Sentinel: `parentCompanyId` absent from the request body, which is not the same
#: request as `"parentCompanyId": null` (detach from the group).
_UNCHANGED = object()


def _same_parent(requested, current) -> bool:
    if requested is None or current is None:
        return requested is None and current is None
    return str(requested) == str(current)


def _check_company_write(user: User, company: Company, db: Session) -> None:
    """
    Company access for a write.

    Mirrors `_check_shop_override_write` in the shops router: reading a company is
    reasonable for anyone attached to it, editing it is not. Without this a cashier
    could rename the company and change the VAT number that every receipt is printed
    with.
    """
    if user.role == UserRole.CASHIER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )
    _check_company_access(user, company, db)


def _check_company_access(user: User, company: Company, db: Session):
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return
    if user.role in (UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.CASHIER):
        # A company manager of a holding group reaches the group's subsidiaries; a shop
        # manager and a cashier stay on their own company. See company_hierarchy.
        if user_covers_company(db, user, company.id):
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _resolve_parent_company(
    db: Session,
    parent_company_id,
    active_tenant_id,
    *,
    company: Optional[Company] = None,
) -> Company:
    """
    Validate a proposed parent: exists, same tenant, no cycle, within the depth limit.

    `company` is None on create (nothing can be a descendant of a row that does not
    exist yet, so only the tenant and depth checks apply).
    """
    parent = db.query(Company).filter(Company.id == parent_company_id).first()
    if not parent:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Parent company not found"
        )
    # A parent and a child must not straddle tenants. The descendant CTE refuses to walk
    # such an edge, so it would be an invisible dead link — and if anything ever did
    # follow it, it would be a cross-tenant leak. Rejected here, in the one place an
    # edge is created.
    ensure_same_tenant(parent.tenant_id, active_tenant_id)
    child_tenant_id = company.tenant_id if company is not None else active_tenant_id
    # Stricter than `ensure_same_tenant`, which tolerates a null entity tenant: an edge
    # between a legacy null-tenant company and a tenant-scoped one is exactly the
    # inert-but-confusing case above.
    if parent.tenant_id != child_tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Parent company belongs to a different tenant",
        )

    height = 0
    if company is not None:
        if str(parent.id) == str(company.id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Circular reference detected",
            )
        # The only other way to build a cycle is to adopt one of your own descendants.
        if parent.id in set(descendant_company_ids(db, company.id)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Circular reference detected",
            )
        height = subtree_height(db, company.id)

    if company_depth(db, parent.id) + 1 + height > MAX_COMPANY_DEPTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Company nesting cannot exceed {MAX_COMPANY_DEPTH + 1} levels",
        )
    return parent


@router.get("", response_model=List[CompanyResponse])
def list_companies(
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Company).filter(Company.tenant_id == active_tenant_id)

    if current_user.role in (UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.CASHIER):
        # A group manager lists the group and its subsidiaries; the other two roles get
        # exactly their own company, as before.
        query = query.filter(Company.id.in_(company_scope_ids(db, current_user)))

    return query.all()


@router.post("", response_model=CompanyResponse, status_code=status.HTTP_201_CREATED)
def create_company(
    data: CompanyCreate,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if data.parent_company_id is not None:
        _resolve_parent_company(db, data.parent_company_id, active_tenant_id)

    company = Company(
        tenant_id=active_tenant_id,
        parent_company_id=data.parent_company_id,
        name=data.name,
        vat_number=data.vat_number,
        address=data.address,
        city=data.city,
        is_active=data.is_active,
    )
    db.add(company)
    db.commit()
    db.refresh(company)
    invalidate_company_hierarchy_cache(db)
    return company


@router.get("/{company_id}", response_model=CompanyResponse)
def get_company(
    company_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company, db)
    return company


@router.put("/{company_id}", response_model=CompanyResponse)
def update_company(
    company_id: str,
    data: CompanyUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_write(current_user, company, db)

    updates = data.model_dump(exclude_unset=True, by_alias=False)

    requested_parent = updates.get("parent_company_id", _UNCHANGED)
    # Only an actual *move* is gated. A dashboard that PUTs the whole company back,
    # `parentCompanyId` included, is not restructuring anything, and 403-ing a company
    # manager for echoing a field they were shown would break every profile edit.
    if requested_parent is not _UNCHANGED and not _same_parent(
        requested_parent, company.parent_company_id
    ):
        if current_user.role not in _REPARENT_ROLES:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a distributor can change a company's parent",
            )
        if requested_parent is not None:
            _resolve_parent_company(
                db, requested_parent, active_tenant_id, company=company
            )

    profile_changed = bool(_COMPANY_PROFILE_FIELDS & set(updates.keys()))
    for field, value in updates.items():
        setattr(company, field, value)
    db.commit()
    db.refresh(company)
    invalidate_company_hierarchy_cache(db)
    if profile_changed:
        notify_machines_for_company_settings(db, str(company.id), reason="company_profile_updated")
    return company


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_company(
    company_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)

    # A parent with children is refused, not cascaded and not silently detached —
    # mirroring "Category has child categories". Deleting a holding company must not
    # decide the fate of the trading companies (and the shops, tills and fiscal
    # documents) hanging off them; the caller reparents or deletes the children first.
    # Note this is about *structure*: deactivating a parent (isActive=false) is a
    # separate, non-cascading operation — a dormant holding company must not stop its
    # subsidiaries' tills from selling.
    if db.query(Company).filter(Company.parent_company_id == company.id).count():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Company has child companies",
        )

    db.delete(company)
    db.commit()
    invalidate_company_hierarchy_cache(db)
