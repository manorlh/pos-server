"""Tenant, company and shop POS settings (dashboard CRUD)."""
from typing import Any, Dict, List

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
from app.services.payment_options import (
    PAYMENT_OPTION_ALLOWED_KEYS,
    PAYMENT_OPTION_SETTING_KEYS,
    any_allowed,
    resolve_payment_options,
)
from app.services.refund_settings import REFUND_SETTING_KEYS, resolve_refund_settings
from app.services.sell_screen import SELL_SCREEN_SETTING_KEYS, resolve_sell_screen
from app.services.settings_merge import (
    BRANDING_SETTING_KEYS,
    deep_merge_settings,
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


def _payment_options_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """Payment option keys the caller explicitly sent, keeping an explicit `null`.

    Same reason as branding: the dashboard's "reset to inherited" on these keys
    sends `null`, meaning remove the key from this layer so the parent's value
    shows through again. `false` is not a substitute — it overrides, and hides.
    """
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in PAYMENT_OPTION_SETTING_KEYS if key in raw}


def _sell_screen_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """Sell-screen keys the caller explicitly sent, keeping an explicit `null`.

    The same switch-has-no-empty-state reason as the payment options: `null` is the
    dashboard's "reset to inherited", removing the key from this layer.
    """
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in SELL_SCREEN_SETTING_KEYS if key in raw}


def _refund_settings_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """Return-flow keys the caller explicitly sent, keeping an explicit `null` (reset)."""
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in REFUND_SETTING_KEYS if key in raw}


def _refuse_tenant_only_keys(data: PosSettingsV1Patch) -> None:
    """`zScope` decides how a tenant's Zs are produced; it has no company or shop layer."""
    if data.z_scope is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="zScope is a tenant setting",
        )


#: Who may change `zScope`. The same narrow set as branding, for the same reason: it is
#: one tenant-wide switch, and company managers are auto-granted TENANT_ADMIN (see
#: BRANDING_WRITE_ROLES), so with the tenant guard alone one merchant's manager could
#: change how every other merchant in the tenant produces its Zs.
Z_SCOPE_WRITE_ROLES = BRANDING_WRITE_ROLES


def _check_z_scope_write(user: User, data: PosSettingsV1Patch, stored: Any) -> None:
    """
    Refuse a `zScope` change from anyone outside `Z_SCOPE_WRITE_ROLES`.

    Only a *change* is refused: the dashboard sends the whole form on every save, so a
    tenant admin saving a printer name round-trips the stored `zScope` unchanged, and
    that must still go through.
    """
    if data.z_scope is None or user.role in Z_SCOPE_WRITE_ROLES:
        return
    current = (stored or {}).get("zScope") if isinstance(stored, dict) else None
    if data.z_scope == (current or "shop"):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions to change zScope",
    )


def _build_patch(data: PosSettingsV1Patch, user: User) -> Dict[str, Any]:
    branding = _branding_patch(data)
    _check_branding_write(user, branding)
    return {
        **patch_to_camel_dict(data),
        **branding,
        **_payment_options_patch(data),
        **_sell_screen_patch(data),
        **_refund_settings_patch(data),
    }


#: Stable code for the dashboard to match on; the message is for people and may change.
#: `msg` rather than `message` because that is the key the dashboard's generic error
#: formatter (client/src/lib/apiError.ts) already reads from FastAPI's own 422 items,
#: so an unhandled toast still shows words rather than a JSON blob.
NO_PAYMENT_OPTION_DETAIL = {
    "code": "no_payment_option_allowed",
    "msg": (
        "At least one payment option must stay allowed "
        "(fast cash, cash, fast card or card): with none, the till cannot take payment."
    ),
}


def _check_leaves_a_payment_option(
    parent_layers: List[Any], current: Any, patch: Dict[str, Any]
) -> None:
    """Refuse a write that would leave this layer's tills no way to take payment.

    Only the layer being written is checked, against its own parents. A tenant or
    company write can still leave a child shop with nothing allowed (the child's
    own overrides are not looked at here); the till shows a blocking message in
    that case, which is accepted for now rather than fanning this check out over
    every shop below. The check also only runs when the patch changes one of this
    layer's allowed keys (a new value, or a `null` that removes a stored one). The
    dashboard sends the whole form on every save, so without that a shop emptied
    from above could not even save a printer name through the API.
    """
    stored = current if isinstance(current, dict) else {}
    if not any(
        key in patch and patch[key] != stored.get(key) for key in PAYMENT_OPTION_ALLOWED_KEYS
    ):
        return
    after = deep_merge_settings(*parent_layers, patch_settings_json(current, patch))
    if not any_allowed(after):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=dict(NO_PAYMENT_OPTION_DETAIL),
        )


def _tenant_of(company: Company, db: Session):
    if not company.tenant_id:
        return None
    return db.query(Tenant).filter(Tenant.id == company.tenant_id).first()


def _settings_of(entity: Any) -> Any:
    return entity.settings if entity is not None else None


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

    _check_z_scope_write(current_user, data, tenant.settings)
    patch = _build_patch(data, current_user)
    if not patch:
        return EntitySettingsResponse(
            settings=tenant.settings or {},
            settings_updated_at=tenant.settings_updated_at,
        )

    _check_leaves_a_payment_option([], tenant.settings, patch)
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

    _refuse_tenant_only_keys(data)
    patch = _build_patch(data, current_user)
    if not patch:
        return EntitySettingsResponse(
            settings=company.settings or {},
            settings_updated_at=company.settings_updated_at,
        )

    _check_leaves_a_payment_option(
        [_settings_of(_tenant_of(company, db))], company.settings, patch
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
            tenant = _tenant_of(company, db)
            # Inherited preview = company (+ tenant) defaults without shop overrides.
            effective = merge_settings(company, tenant=tenant)
            # Payment options resolved here, so the dashboard shows what the shop
            # would actually get and never carries its own copy of the rule. Only
            # this preview is resolved: `settings` below stays the shop's raw JSON,
            # so a key the shop never set still reads as inherited, not overridden.
            # Tips as chosen, not as effective: see resolve_payment_options.
            effective.update(resolve_payment_options(effective, effective=False))
            # Sell-screen tools resolved for the same reason: an unset key is
            # "shown", and the dashboard should read that, not guess it.
            effective.update(resolve_sell_screen(effective))
            effective.update(resolve_refund_settings(effective))

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

    _refuse_tenant_only_keys(data)
    patch = _build_patch(data, current_user)
    if not patch:
        return ShopSettingsResponse(
            settings=shop.settings or {},
            settings_updated_at=shop.settings_updated_at,
        )

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    tenant = _tenant_of(company, db) if company else None
    _check_leaves_a_payment_option(
        [_settings_of(tenant), _settings_of(company)], shop.settings, patch
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
