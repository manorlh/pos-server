"""
"תפקידים והרשאות" — the dashboard's till roles per company, their matrix, the assignment
of till users and the audit (docs/SPEC_ROLES_PERMISSIONS.md).

    GET    /till-permissions/catalogue                       the catalogue, states, built-in defaults
    GET    /companies/{id}/till-roles                        the company's roles (built-ins created on first read)
    POST   /companies/{id}/till-roles                        a custom role (blank from a template, or a duplicate)
    PUT    /companies/{id}/till-roles/matrix                 several roles' permissions at once (the matrix editor)
    PUT    /companies/{id}/till-roles/{role_id}              rename / describe / permissions / limits
    DELETE /companies/{id}/till-roles/{role_id}?reassignTo=  a custom role (built-ins are never deleted)
    POST   /companies/{id}/till-roles/apply-spec-defaults    "החל ברירות מחדל לפי האפיון"
    GET    /companies/{id}/till-roles/changes                the audit
    GET    /companies/{id}/till-roles/users?shopId=          the till users, their role and overrides
    PUT    /shops/{shop_id}/pos-users/{id}/till-role         assign a role (+ overrides)
    GET    /companies/{id}/till-drawer-params?scopeType=&scopeId=   the drawer's parameters at a level (spec §17)
    PUT    /companies/{id}/till-drawer-params                set / clear them at a level

Who: reading — the super admin, a distributor, a company manager over the company, and a
shop's managers / shift supervisors for their own shop's company. Defining roles — the
super admin, a distributor and a company manager over the company. Assigning a role — who
may staff the shop's tills (`pos_users._check_write`).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.till_role import TillRole, TillRoleChange
from app.models.user import User, UserRole
from app.routers.pos_users import _check_write as _check_pos_user_write
from app.services import till_permissions as TP
from app.services import till_roles as svc
from app.services.company_hierarchy import user_covers_company

router = APIRouter(tags=["till-roles"])


class RoleCreateIn(BaseModel):
    name: str
    description: Optional[str] = None
    base_key: Optional[str] = Field(None, alias="baseKey")
    copy_from_role_id: Optional[uuid.UUID] = Field(None, alias="copyFromRoleId")
    permissions: Optional[Dict[str, Optional[str]]] = None
    limits: Optional[Dict[str, Optional[Dict[str, Optional[float]]]]] = None

    model_config = {"populate_by_name": True}


class RoleUpdateIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[Dict[str, Optional[str]]] = None
    limits: Optional[Dict[str, Optional[Dict[str, Optional[float]]]]] = None

    model_config = {"populate_by_name": True}


class MatrixRoleIn(BaseModel):
    id: uuid.UUID
    permissions: Dict[str, Optional[str]] = Field(default_factory=dict)
    limits: Dict[str, Optional[Dict[str, Optional[float]]]] = Field(default_factory=dict)


class MatrixIn(BaseModel):
    roles: List[MatrixRoleIn]


class ApplyDefaultsIn(BaseModel):
    reset_builtins: bool = Field(True, alias="resetBuiltins")
    move_legacy_users: bool = Field(False, alias="moveLegacyUsers")

    model_config = {"populate_by_name": True}


class AssignIn(BaseModel):
    till_role_id: uuid.UUID = Field(..., alias="tillRoleId")
    #: `{"states": {...}, "limits": {...}}`; omitted = leave as is; null = clear.
    overrides: Optional[Dict[str, Any]] = None
    clear_overrides: bool = Field(False, alias="clearOverrides")

    model_config = {"populate_by_name": True}


# ── Auth ──────────────────────────────────────────────────────────────────────


def _company(db: Session, company_id: Any, tenant_id) -> Company:
    ident = svc._uuid(company_id)
    company = db.get(Company, ident) if ident else None
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, tenant_id)
    return company


def may_edit(db: Session, user: User, company: Company) -> bool:
    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    return role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, company.id)


def may_read(db: Session, user: User, company: Company) -> bool:
    if may_edit(db, user, company):
        return True
    if getattr(user, "role", None) in (UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR):
        shop_id = getattr(user, "shop_id", None)
        if shop_id is None:
            return False
        shop = db.get(Shop, shop_id)
        return shop is not None and str(shop.company_id) == str(company.id)
    return False


def _readable(db: Session, company_id, user: User, tenant_id) -> Company:
    company = _company(db, company_id, tenant_id)
    if not may_read(db, user, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return company


def _editable(db: Session, company_id, user: User, tenant_id) -> Company:
    company = _company(db, company_id, tenant_id)
    if not may_edit(db, user, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return company


def _role(db: Session, company: Company, role_id: Any) -> TillRole:
    ident = svc._uuid(role_id)
    role = db.get(TillRole, ident) if ident else None
    if role is None or role.company_id != company.id or role.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    return role


def _fail(err: svc.TillRoleError) -> HTTPException:
    return HTTPException(status_code=err.status, detail={"code": err.code, "message": str(err)})


def _roles_response(db: Session, company: Company, user: User) -> Dict[str, Any]:
    roles = svc.ensure_company_roles(db, company)
    counts = svc.user_counts(db, roles)
    return {
        "companyId": str(company.id),
        "roles": [svc.role_out(r, counts.get(r.id, 0)) for r in roles],
        "canEdit": may_edit(db, user, company),
    }


# ── Catalogue ─────────────────────────────────────────────────────────────────


@router.get("/till-permissions/catalogue")
def get_catalogue(current_user: User = Depends(get_current_user)):
    return TP.catalogue_out()


# ── Roles ─────────────────────────────────────────────────────────────────────


@router.get("/companies/{company_id}/till-roles")
def list_till_roles(
    company_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _readable(db, company_id, current_user, active_tenant_id)
    out = _roles_response(db, company, current_user)
    db.commit()
    return out


@router.post("/companies/{company_id}/till-roles", status_code=status.HTTP_201_CREATED)
def create_till_role(
    company_id: str,
    body: RoleCreateIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _editable(db, company_id, current_user, active_tenant_id)
    svc.ensure_company_roles(db, company)
    source = _role(db, company, body.copy_from_role_id) if body.copy_from_role_id else None
    try:
        role = svc.create_role(
            db, company, name=body.name, user=current_user, description=body.description,
            base_key=body.base_key, copy_from=source, permissions=body.permissions, limits=body.limits,
        )
    except svc.TillRoleError as err:
        db.rollback()
        raise _fail(err)
    db.commit()
    return svc.role_out(role, 0)


@router.put("/companies/{company_id}/till-roles/matrix")
def save_till_role_matrix(
    company_id: str,
    body: MatrixIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The matrix editor's save: each listed role's own permissions and limits, replaced."""
    company = _editable(db, company_id, current_user, active_tenant_id)
    shops: set = set()
    try:
        for item in body.roles:
            role = _role(db, company, item.id)
            shops |= svc.update_role(
                db, company, role, user=current_user, permissions=item.permissions, limits=item.limits,
            )
    except svc.TillRoleError as err:
        db.rollback()
        raise _fail(err)
    db.commit()
    svc.notify_shops(db, shops)
    return _roles_response(db, company, current_user)


@router.put("/companies/{company_id}/till-roles/{role_id}")
def update_till_role(
    company_id: str,
    role_id: str,
    body: RoleUpdateIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _editable(db, company_id, current_user, active_tenant_id)
    role = _role(db, company, role_id)
    sent = body.model_dump(exclude_unset=True)
    try:
        shops = svc.update_role(
            db, company, role, user=current_user,
            **{k: v for k, v in sent.items() if k in ("name", "description", "permissions", "limits")},
        )
    except svc.TillRoleError as err:
        db.rollback()
        raise _fail(err)
    db.commit()
    svc.notify_shops(db, shops)
    return svc.role_out(role, svc.user_counts(db, [role]).get(role.id, 0))


@router.delete("/companies/{company_id}/till-roles/{role_id}")
def delete_till_role(
    company_id: str,
    role_id: str,
    reassign_to: Optional[uuid.UUID] = Query(None, alias="reassignTo"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _editable(db, company_id, current_user, active_tenant_id)
    role = _role(db, company, role_id)
    target = _role(db, company, reassign_to) if reassign_to else None
    try:
        shops = svc.delete_role(db, company, role, user=current_user, reassign_to=target)
    except svc.TillRoleError as err:
        db.rollback()
        raise _fail(err)
    db.commit()
    svc.notify_shops(db, shops)
    return {"deleted": str(role.id)}


@router.post("/companies/{company_id}/till-roles/apply-spec-defaults")
def apply_spec_defaults(
    company_id: str,
    body: ApplyDefaultsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _editable(db, company_id, current_user, active_tenant_id)
    result = svc.apply_spec_defaults(
        db, company, user=current_user, reset_builtins=body.reset_builtins,
        move_legacy_users=body.move_legacy_users,
    )
    db.commit()
    svc.notify_shops(db, result["shops"])
    out = _roles_response(db, company, current_user)
    out["applied"] = {"resetRoles": result["resetRoles"], "movedUsers": result["movedUsers"]}
    return out


@router.get("/companies/{company_id}/till-roles/changes")
def list_till_role_changes(
    company_id: str,
    limit: int = Query(200, ge=1, le=1000),
    role_id: Optional[uuid.UUID] = Query(None, alias="roleId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _readable(db, company_id, current_user, active_tenant_id)
    q = db.query(TillRoleChange).filter(TillRoleChange.company_id == company.id)
    if role_id is not None:
        q = q.filter(TillRoleChange.role_id == role_id)
    rows = q.order_by(TillRoleChange.created_at.desc()).limit(limit).all()
    return {"changes": [svc.change_out(r) for r in rows]}


@router.get("/companies/{company_id}/till-roles/users")
def list_till_role_users(
    company_id: str,
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    include_inactive: bool = Query(False, alias="includeInactive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _readable(db, company_id, current_user, active_tenant_id)
    svc.ensure_company_roles(db, company)
    shop_ids = svc.company_shop_ids(db, company.id)
    if current_user.role in (UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR):
        shop_ids = [s for s in shop_ids if str(s) == str(current_user.shop_id)]
    if shop_id is not None:
        shop_ids = [s for s in shop_ids if s == shop_id]
    users: List[PosUser] = []
    if shop_ids:
        q = db.query(PosUser).filter(PosUser.shop_id.in_(shop_ids))
        if not include_inactive:
            q = q.filter(PosUser.is_active.is_(True))
        users = q.order_by(PosUser.username).all()
    effective = svc.effective_for_users(db, users)
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(shop_ids))} if shop_ids else {}
    db.commit()
    return {
        "users": [
            {
                "id": str(u.id),
                "shopId": str(u.shop_id),
                "shopName": shops.get(u.shop_id),
                "username": u.username,
                "firstName": u.first_name,
                "lastName": u.last_name,
                "isActive": bool(u.is_active),
                "role": getattr(u.role, "value", u.role),
                "tillRoleId": str(u.till_role_id) if u.till_role_id else None,
                "tillRoleName": effective[u.id].role_name,
                "overrides": u.permission_overrides,
                "permissions": effective[u.id].states,
                "limits": effective[u.id].limits,
            }
            for u in users
        ],
    }


# ── The drawer's parameters per level (spec §17) ──────────────────────────────


class DrawerParamsIn(BaseModel):
    scope_type: str = Field(..., alias="scopeType")
    scope_id: uuid.UUID = Field(..., alias="scopeId")
    #: key → value; null clears this level's own value (it inherits again).
    values: Dict[str, Any]

    model_config = {"populate_by_name": True}


def _level_access(db: Session, company: Company, scope_type: str, scope_id: Any, user: User, *, write: bool) -> None:
    from app.services import cash_drawer as CD

    if scope_type not in CD.SCOPE_TYPES:
        raise HTTPException(status_code=422, detail="bad_scope_type")
    level_company, level_shop = CD.scope_company(db, scope_type, scope_id)
    if level_company is None or str(level_company) != str(company.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="level_not_in_company")
    if may_edit(db, user, company):
        return
    if not write and may_read(db, user, company):
        return
    # A shop's manager sets their own shop's levels (not the company's).
    if (
        write
        and getattr(user, "role", None) == UserRole.SHOP_MANAGER
        and level_shop is not None
        and str(getattr(user, "shop_id", None)) == str(level_shop)
    ):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


@router.get("/companies/{company_id}/till-drawer-params")
def get_drawer_params(
    company_id: str,
    scope_type: str = Query(..., alias="scopeType"),
    scope_id: uuid.UUID = Query(..., alias="scopeId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import cash_drawer as CD

    company = _readable(db, company_id, current_user, active_tenant_id)
    _level_access(db, company, scope_type, scope_id, current_user, write=False)
    view = CD.level_view(db, scope_type, scope_id)
    view["canEdit"] = may_edit(db, current_user, company) or (
        scope_type != "company"
        and current_user.role == UserRole.SHOP_MANAGER
        and str(CD.scope_company(db, scope_type, scope_id)[1]) == str(current_user.shop_id)
    )
    db.commit()
    return view


@router.put("/companies/{company_id}/till-drawer-params")
def put_drawer_params(
    company_id: str,
    body: DrawerParamsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import cash_drawer as CD
    from app.services.till_parameters import TillParameterValueError, publish_parameters_notify

    company = _company(db, company_id, active_tenant_id)
    _level_access(db, company, body.scope_type, body.scope_id, current_user, write=True)
    try:
        targets = CD.save_values(db, body.scope_type, body.scope_id, body.values, user=current_user)
    except TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": "invalid_value", "message": str(exc)})
    db.commit()
    publish_parameters_notify(targets)
    return CD.level_view(db, body.scope_type, body.scope_id)


@router.put("/shops/{shop_id}/pos-users/{pos_user_id}/till-role")
def assign_till_role(
    shop_id: str,
    pos_user_id: str,
    body: AssignIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop_ident = svc._uuid(shop_id)
    shop = db.get(Shop, shop_ident) if shop_ident else None
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_pos_user_write(current_user, shop, db)
    ident = svc._uuid(pos_user_id)
    pu = db.query(PosUser).filter(PosUser.id == ident, PosUser.shop_id == shop.id).first() if ident else None
    if pu is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
    company = db.get(Company, shop.company_id)
    if company is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="shop_without_company")
    svc.ensure_company_roles(db, company)
    role = _role(db, company, body.till_role_id)
    sent = body.model_dump(exclude_unset=True)
    try:
        shops = svc.assign_role(db, company, pu, role, user=current_user)
        if body.clear_overrides:
            shops |= svc.set_overrides(db, company, pu, None, user=current_user)
        elif "overrides" in sent:
            shops |= svc.set_overrides(db, company, pu, body.overrides, user=current_user)
    except svc.TillRoleError as err:
        db.rollback()
        raise _fail(err)
    db.commit()
    svc.notify_shops(db, shops | {shop.id})
    eff = svc.effective_for_pos_user(pu)
    return {
        "id": str(pu.id),
        "tillRoleId": str(pu.till_role_id) if pu.till_role_id else None,
        "tillRoleName": eff.role_name,
        "role": getattr(pu.role, "value", pu.role),
        "overrides": pu.permission_overrides,
        "permissions": eff.states,
        "limits": eff.limits,
    }
