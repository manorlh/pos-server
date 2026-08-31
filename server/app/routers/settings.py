"""Tenant, company and shop POS settings (dashboard CRUD)."""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers.companies import _check_company_access
from app.routers.shops import _check_shop_access
from app.routers.tenants import _can_manage_tenant
from app.services.company_hierarchy import user_covers_company
from app.schemas.pos_settings import (
    EntitySettingsResponse,
    PosSettingsV1Patch,
    ShopSettingsResponse,
)
from app.services.settings_merge import (
    BRANDING_SETTING_KEYS,
    effective_settings_updated_at,
    merge_settings,
    patch_settings_json,
    patch_to_camel_dict,
    utc_now,
)
from app.services.settings_notify import (
    notify_machines_for_company_settings,
    notify_machines_for_shop_settings,
    notify_machines_for_tenant_settings,
)

router = APIRouter(tags=["settings"])

COMPANY_SETTINGS_WRITE_ROLES = {
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.COMPANY_MANAGER,
}


def _check_company_settings_write(user: User, company: Company, db: Session) -> None:
    if user.role in COMPANY_SETTINGS_WRITE_ROLES:
        if user.role == UserRole.COMPANY_MANAGER and not user_covers_company(
            db, user, company.id
        ):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _check_shop_settings_write(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.CASHIER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    _check_shop_access(user, shop, db)


# White label is the distributor's (or the merchant's) identity, not the store's.
# A shop manager may set printer names for their branch but must not repaint the
# brand on the tills; a cashier may write nothing at any level.
BRANDING_WRITE_ROLES = {
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
}
"""
Who may change the white label.

COMPANY_MANAGER is deliberately absent, and the reason is a chain rather than a
single check. `_ensure_membership_for_user_home_tenant` auto-grants TENANT_ADMIN to
every company manager, and it runs on GET /tenants/mine, which the dashboard calls on
every load. `_can_manage_tenant` accepts TENANT_ADMIN. So with company_manager in this
set, both guards on the tenant endpoint passed and one merchant could replace the
distributor's brand on every terminal in the tenant — including tills belonging to
other merchants entirely.

Branding is the distributor's asset. It is the one tenant-level setting whose whole
purpose is that the people below cannot change it, which is exactly why it needs a
narrower rule than the printer names and tax rates alongside it. Company managers keep
every other company-level setting they had.
"""


def _branding_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """Branding keys the caller explicitly sent, keeping an explicit `null`.

    `patch_to_camel_dict` drops `None`, so a null can never delete a key through it.
    Branding needs deletion: `null` unsets this layer (inherit again), while `""`
    stores an empty string (deliberately no image, overriding any inherited URL).
    """
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in BRANDING_SETTING_KEYS if key in raw}


def _check_branding_write(user: User, branding: Dict[str, Any]) -> None:
    if branding and user.role not in BRANDING_WRITE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to change branding",
        )


def _build_patch(data: PosSettingsV1Patch, user: User) -> Dict[str, Any]:
    branding = _branding_patch(data)
    _check_branding_write(user, branding)
    return {**patch_to_camel_dict(data), **branding}


@router.get(
    "/tenants/{tenant_id}/settings",
    response_model=EntitySettingsResponse,
    response_model_by_alias=True,
)
def get_tenant_settings(
    tenant_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    if not _can_manage_tenant(current_user, tenant.id, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return EntitySettingsResponse(
        settings=tenant.settings or {},
        settings_updated_at=tenant.settings_updated_at,
    )


@router.patch(
    "/tenants/{tenant_id}/settings",
    response_model=EntitySettingsResponse,
    response_model_by_alias=True,
)
def patch_tenant_settings(
    tenant_id: str,
    data: PosSettingsV1Patch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    if not _can_manage_tenant(current_user, tenant.id, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    patch = _build_patch(data, current_user)
    if not patch:
        return EntitySettingsResponse(
            settings=tenant.settings or {},
            settings_updated_at=tenant.settings_updated_at,
        )

    tenant.settings = patch_settings_json(tenant.settings, patch)
    tenant.settings_updated_at = utc_now()
    db.commit()
    db.refresh(tenant)
    notify_machines_for_tenant_settings(db, str(tenant.id), reason="tenant_settings_updated")
    return EntitySettingsResponse(
        settings=tenant.settings or {},
        settings_updated_at=tenant.settings_updated_at,
    )


@router.get(
    "/companies/{company_id}/settings",
    response_model=EntitySettingsResponse,
    response_model_by_alias=True,
)
def get_company_settings(
    company_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company, db)
    return EntitySettingsResponse(
        settings=company.settings or {},
        settings_updated_at=company.settings_updated_at,
    )


@router.patch(
    "/companies/{company_id}/settings",
    response_model=EntitySettingsResponse,
    response_model_by_alias=True,
)
def patch_company_settings(
    company_id: str,
    data: PosSettingsV1Patch,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company, db)
    _check_company_settings_write(current_user, company, db)

    patch = _build_patch(data, current_user)
    if not patch:
        return EntitySettingsResponse(
            settings=company.settings or {},
            settings_updated_at=company.settings_updated_at,
        )

    company.settings = patch_settings_json(company.settings, patch)
    company.settings_updated_at = utc_now()
    db.commit()
    db.refresh(company)
    notify_machines_for_company_settings(db, str(company.id), reason="company_settings_updated")
    return EntitySettingsResponse(
        settings=company.settings or {},
        settings_updated_at=company.settings_updated_at,
    )


@router.get(
    "/shops/{shop_id}/settings",
    response_model=ShopSettingsResponse,
    response_model_by_alias=True,
)
def get_shop_settings(
    shop_id: str,
    include_effective: bool = Query(False, alias="includeEffective"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)

    effective = None
    if include_effective:
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if company:
            tenant = None
            if company.tenant_id:
                tenant = db.query(Tenant).filter(Tenant.id == company.tenant_id).first()
            # Inherited preview = company (+ tenant) defaults without shop overrides.
            effective = merge_settings(company, tenant=tenant)

    return ShopSettingsResponse(
        settings=shop.settings or {},
        settings_updated_at=shop.settings_updated_at,
        effective=effective,
    )


@router.patch(
    "/shops/{shop_id}/settings",
    response_model=ShopSettingsResponse,
    response_model_by_alias=True,
)
def patch_shop_settings(
    shop_id: str,
    data: PosSettingsV1Patch,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_settings_write(current_user, shop, db)

    patch = _build_patch(data, current_user)
    if not patch:
        return ShopSettingsResponse(
            settings=shop.settings or {},
            settings_updated_at=shop.settings_updated_at,
        )

    shop.settings = patch_settings_json(shop.settings, patch)
    shop.settings_updated_at = utc_now()
    db.commit()
    db.refresh(shop)
    notify_machines_for_shop_settings(db, str(shop.id), reason="shop_settings_updated")
    return ShopSettingsResponse(
        settings=shop.settings or {},
        settings_updated_at=shop.settings_updated_at,
    )
