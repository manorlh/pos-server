from typing import List, Optional
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.services import licenses
from app.database import get_db
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.permission_matrix import Action, Resource, roles_for
from app.services.org_numbers import assign_company_number
from app.schemas.company import (
    CompanyCreate,
    CompanyResponse,
    CompanyUpdate,
    ParentOption,
    ParentOptionsResponse,
)
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
from app.services.catalog_notify import notify_machines_for_shop
from app.services.general_item import ensure_general_item, remove_general_item_with_company
from app.services.product_shop_scope import reconcile_company_subtree
from app.services.settings_notify import notify_machines_for_company_settings

router = APIRouter(prefix="/companies", tags=["companies"])

_COMPANY_PROFILE_FIELDS = frozenset({"name", "vat_number", "address", "city"})

#: Who may move a company inside the group tree. Reparenting hands the new parent's
#: managers every shop, till, transaction and staff row underneath, so it is an
#: org-structure decision and not part of editing a company's profile — even though a
#: company manager may edit that profile.
_REPARENT_ROLES = roles_for(Resource.COMPANY_TREE, Action.WRITE)

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


@router.get("/parent-options", response_model=ParentOptionsResponse, response_model_by_alias=True)
def get_parent_options(
    company_id: Optional[uuid_mod.UUID] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Which companies may be this one's parent, and what a move would carry.

    Exists so the picker cannot offer something the save would refuse. The rules — no
    self, no descendant, and the combined chain within `MAX_COMPANY_DEPTH` — are the same
    ones `_resolve_parent_company` enforces on write, asked here rather than reimplemented
    in the dashboard, where they would drift the first time either changed.

    Impossible parents are returned *disabled with a reason* rather than omitted. A
    picker that silently drops a company leaves the operator hunting for one they can
    see on the page behind the dialog; "would exceed 5 levels" answers the question.

    Omit `companyId` for a company being created. Nothing exists under it yet, so
    everything in the tenant is a candidate and the move counts are zero — which is
    precisely why setting a parent at creation is safe and moving one later is not.

    Distributor-only, matching the write path: re-parenting rearranges who can see whose
    takings, so even the list of possibilities is not a company manager's business.
    """
    companies = (
        db.query(Company)
        .filter(Company.tenant_id == active_tenant_id)
        .order_by(Company.name)
        .all()
    )

    moving: Optional[Company] = None
    blocked: set = set()
    height = 0
    moves_shops = moves_machines = moves_companies = 0

    if company_id is not None:
        moving = db.query(Company).filter(Company.id == company_id).first()
        if not moving:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(moving.tenant_id, active_tenant_id)
        subtree = descendant_company_ids(db, moving.id)
        # Its own subtree, itself included: adopting any of them builds a cycle.
        blocked = {str(cid) for cid in subtree}
        height = subtree_height(db, moving.id)
        moves_companies = max(len(subtree) - 1, 0)
        shop_ids = [
            row[0]
            for row in db.query(Shop.id).filter(Shop.company_id.in_(subtree)).all()
        ]
        moves_shops = len(shop_ids)
        moves_machines = (
            db.query(POSMachine).filter(POSMachine.shop_id.in_(shop_ids)).count()
            if shop_ids
            else 0
        )

    options = []
    for candidate in companies:
        depth = company_depth(db, candidate.id)
        allowed, reason = True, None
        if str(candidate.id) in blocked:
            allowed = False
            reason = (
                "itself" if moving is not None and candidate.id == moving.id
                else "already below this company"
            )
        elif depth + 1 + height > MAX_COMPANY_DEPTH:
            allowed = False
            reason = f"would exceed {MAX_COMPANY_DEPTH + 1} levels"
        options.append(
            ParentOption(id=candidate.id, name=candidate.name, depth=depth,
                         allowed=allowed, reason=reason)
        )

    return ParentOptionsResponse(
        options=options,
        moves_shops=moves_shops,
        moves_machines=moves_machines,
        moves_companies=moves_companies,
        # Detaching only means something for a company that currently has a parent.
        may_detach=moving is not None and moving.parent_company_id is not None,
    )


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
    # "לקוח קבוע / זמני": the super admin's to set (app/services/licenses.py).
    licenses.apply_license(
        current_user, company, data.model_dump(include=set(licenses.FIELDS)), creating=True
    )
    db.add(company)
    db.flush()
    # Company 1, 2, 3 in the tenant, drawn in this transaction so a failed create
    # gives it back.
    assign_company_number(db, company)
    # Every company has its general item from the start, in the same transaction, so
    # there is never a company whose tills' calculator has nothing to sell through.
    # A new company has no shops, so nobody to notify.
    ensure_general_item(db, company)
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
    # The license fields leave `updates` here: the super admin's only.
    licenses.apply_license(current_user, company, updates)

    requested_parent = updates.get("parent_company_id", _UNCHANGED)
    # Only an actual *move* is gated. A dashboard that PUTs the whole company back,
    # `parentCompanyId` included, is not restructuring anything, and 403-ing a company
    # manager for echoing a field they were shown would break every profile edit.
    moved = requested_parent is not _UNCHANGED and not _same_parent(
        requested_parent, company.parent_company_id
    )
    if moved:
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
    touched = set()
    if moved:
        # The shops beneath this company now sit under different ancestors, so the
        # "all shops of X, sub-companies included" rules that reach them have changed:
        # the new parent's rules add rows, the old parent's rule rows are unlisted.
        db.flush()
        invalidate_company_hierarchy_cache(db)
        touched = reconcile_company_subtree(db, company.id)
    db.commit()
    db.refresh(company)
    invalidate_company_hierarchy_cache(db)
    for shop_id in touched:
        notify_machines_for_shop(db, shop_id, reason="company_moved")
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

    # The company's own general item goes with it — otherwise it would outlive its
    # company as an undeletable tenant-wide product.
    remove_general_item_with_company(db, company)
    db.delete(company)
    db.commit()
    invalidate_company_hierarchy_cache(db)
