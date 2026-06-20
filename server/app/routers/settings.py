"""Company and shop POS settings (dashboard CRUD)."""
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
from app.schemas.pos_settings import (
    EntitySettingsResponse,
    PosSettingsV1Patch,
    ShopSettingsResponse,
)
from app.services.settings_merge import (
    effective_settings_updated_at,
    merge_settings,
    patch_settings_json,
    patch_to_camel_dict,
    utc_now,
)
from app.services.settings_notify import (
    notify_machines_for_company_settings,
    notify_machines_for_shop_settings,
)

router = APIRouter(tags=["settings"])

COMPANY_SETTINGS_WRITE_ROLES = {
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.COMPANY_MANAGER,
}


def _check_company_settings_write(user: User, company: Company) -> None:
    if user.role in COMPANY_SETTINGS_WRITE_ROLES:
        if user.role == UserRole.COMPANY_MANAGER and company.id != user.company_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _check_shop_settings_write(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.CASHIER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    _check_shop_access(user, shop, db)


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
    _check_company_access(current_user, company)
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
    _check_company_access(current_user, company)
    _check_company_settings_write(current_user, company)

    patch = patch_to_camel_dict(data)
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

    patch = patch_to_camel_dict(data)
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
