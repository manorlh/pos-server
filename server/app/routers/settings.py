"""Tenant, company, shop, area (point of sale) and till POS settings (dashboard CRUD)."""
from typing import Any, Dict, List, Optional

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
from app.schemas.terminal import TerminalNumberForceRequest
from app.schemas.pos_settings import (
    AreaSettingsResponse,
    EntitySettingsResponse,
    MachineSettingsResponse,
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
    MANAGED_SETTING_KEYS,
    deep_merge_settings,
    effective_settings_updated_at,
    patch_settings_json,
    settings_sources,
    patch_to_camel_dict,
    utc_now,
)
from app.services.settings_notify import (
    notify_machine_settings,
    notify_machines_for_area_settings,
    notify_machines_for_company_settings,
    notify_machines_for_shop_settings,
    notify_machines_for_tenant_settings,
)
from app.middleware.auth import get_current_machine_admin
from app.services.areas import get_area
from app.models.pos_machine import POSMachine
from app.routers.machines import _machine_for_read
from app.services.terminal_status import machine_terminal_fields, terminal_settings_for
from app.services import payment_integration, payment_secrets

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


#: Keys that a `null` resets to inherited, as the switches above do: the tip settings,
#: the expected terminal number (and whether to force it), the clearing server and the
#: most instalments. Without
#: this a layer that once set its own value could never go back to its parent's — a
#: till could never rejoin its shop's number.
TIP_RESETTABLE_KEYS = (
    "tipPresets",
    "tipDistribution",
    "tipPromptText",
    "expectedTerminalNumber",
    "clearingServer",
    "forceTerminalNumber",
    "payInstallmentsMax",
)


def _tip_settings_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """Tip keys the caller explicitly sent, keeping an explicit `null` (reset)."""
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in TIP_RESETTABLE_KEYS if key in raw}


def _refuse_tenant_only_keys(data: PosSettingsV1Patch) -> None:
    """`zScope` decides how a tenant's Zs are produced; it has no company or shop layer."""
    if data.z_scope is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="zScope is a tenant setting",
        )


#: Who may change `zScope`: the super admin alone — it decides how a tenant's Zs are
#: produced and how the books read them (the owner's rule, as for a till's `zMode`).
Z_SCOPE_WRITE_ROLES = {UserRole.SUPER_ADMIN}


def _guard_z_scope_change(
    db: Session, data: PosSettingsV1Patch, stored: Any, machines, *, default: Optional[str]
) -> None:
    """
    A change of Z mode only over a clean break: 409 `z_scope_tills_open` (with the tills)
    while any till it applies to has an open shift or closed shifts no Z has taken.
    """
    if "z_scope" not in data.model_fields_set:
        return
    current = (stored or {}).get("zScope") if isinstance(stored, dict) else None
    if (data.z_scope or default) == (current or default):
        return
    from app.services import z_runs as ZR

    blocking = ZR.tills_not_closed(db, list(machines()))
    if blocking:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "z_scope_tills_open", "tills": blocking},
        )


def _tenant_tills(db: Session, tenant_id) -> list:
    from app.models.pos_machine import POSMachine

    return db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id).all()


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
    return payment_integration.normalize_patch({
        **patch_to_camel_dict(data),
        **branding,
        **_payment_options_patch(data),
        **_sell_screen_patch(data),
        **_refund_settings_patch(data),
        **_tip_settings_patch(data),
        # The integration type and Z-Credit's fields: `null` resets, "auto" is not stored.
        **payment_integration.resettable_patch(data),
    })


def _secret_patch(data: PosSettingsV1Patch) -> Dict[str, Any]:
    """The write-only secrets in a PATCH (`zcreditPassword`…), apart from the settings JSON."""
    try:
        return payment_secrets.secret_patch(data)
    except payment_secrets.PaymentSecretError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "msg": "A secret must be at most 200 characters, with no control characters."},
        )


def _store_secrets(db: Session, level: str, entity: Any, secrets: Dict[str, Any], user: User) -> None:
    """Store a layer's secrets encrypted (app/services/payment_secrets.py), never in its JSON."""
    if not secrets:
        return
    tenant_id = entity.id if level == "tenant" else getattr(entity, "tenant_id", None)
    payment_secrets.apply_secret_patch(
        db, level, entity.id, secrets, tenant_id=tenant_id, user_id=getattr(user, "id", None)
    )


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


def _inherited_preview(layers: List[Any]):
    """
    What a layer inherits from `layers` — `(level name, entity)` of its parents, least
    specific first, a missing one None — and the level each inherited key comes from.

    Payment options, sell-screen tools and return-flow switches are resolved, so the
    dashboard shows what the layer would actually get and never carries its own copy
    of the rule (an unset key is "shown", and the dashboard should read that, not guess
    it). Only this preview is resolved: the layer's own `settings` stay its raw JSON, so
    a key it never set still reads as inherited, not overridden. Tips as chosen, not as
    effective: see resolve_payment_options.
    """
    present = [(level, _settings_of(entity)) for level, entity in layers if entity is not None]
    merged = deep_merge_settings(*(settings or {} for _, settings in present))
    effective = {k: merged[k] for k in MANAGED_SETTING_KEYS if k in merged}
    effective.update(resolve_payment_options(effective, effective=False))
    effective.update(resolve_sell_screen(effective))
    effective.update(resolve_refund_settings(effective))
    return effective, settings_sources(present)


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
    _guard_z_scope_change(db, data, tenant.settings, lambda: _tenant_tills(db, tenant.id), default="shop")
    patch = _build_patch(data, current_user)
    secrets = _secret_patch(data)
    if not patch and not secrets:
        return EntitySettingsResponse(
            settings=tenant.settings or {},
            settings_updated_at=tenant.settings_updated_at,
        )

    _check_leaves_a_payment_option([], tenant.settings, patch)
    tenant.settings = patch_settings_json(tenant.settings, patch)
    _store_secrets(db, "tenant", tenant, secrets, current_user)
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
    response_model=ShopSettingsResponse,
    response_model_by_alias=True,
)
def get_company_settings(
    company_id: str,
    include_effective: bool = Query(False, alias="includeEffective"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company, db)
    effective = sources = None
    if include_effective:
        # Inherited preview = the tenant's settings alone.
        effective, sources = _inherited_preview([("tenant", _tenant_of(company, db))])
    return ShopSettingsResponse(
        settings=company.settings or {},
        settings_updated_at=company.settings_updated_at,
        effective=effective,
        effective_sources=sources,
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
    secrets = _secret_patch(data)
    if not patch and not secrets:
        return EntitySettingsResponse(
            settings=company.settings or {},
            settings_updated_at=company.settings_updated_at,
        )

    _check_leaves_a_payment_option(
        [_settings_of(_tenant_of(company, db))], company.settings, patch
    )
    company.settings = patch_settings_json(company.settings, patch)
    _store_secrets(db, "company", company, secrets, current_user)
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

    effective = sources = None
    if include_effective:
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if company:
            # Inherited preview = company (+ tenant) defaults without shop overrides.
            effective, sources = _inherited_preview(
                [("tenant", _tenant_of(company, db)), ("company", company)]
            )

    return ShopSettingsResponse(
        settings=shop.settings or {},
        settings_updated_at=shop.settings_updated_at,
        effective=effective,
        effective_sources=sources,
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
    secrets = _secret_patch(data)
    if not patch and not secrets:
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
    _store_secrets(db, "shop", shop, secrets, current_user)
    shop.settings_updated_at = utc_now()
    db.commit()
    db.refresh(shop)
    notify_machines_for_shop_settings(db, str(shop.id), reason="shop_settings_updated")
    return ShopSettingsResponse(
        settings=shop.settings or {},
        settings_updated_at=shop.settings_updated_at,
    )


# ── One point of sale (shop area): between its shop and its tills ─────────────


def _area_and_shop(db: Session, area_id: str, active_tenant_id):
    area = get_area(db, area_id)
    if area is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
    ensure_same_tenant(area.tenant_id, active_tenant_id)
    shop = db.query(Shop).filter(Shop.id == area.shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    return area, shop


@router.get(
    "/areas/{area_id}/settings",
    response_model=AreaSettingsResponse,
    response_model_by_alias=True,
)
def get_area_settings(
    area_id: str,
    include_effective: bool = Query(False, alias="includeEffective"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    This point of sale's own overrides, and with `includeEffective` what it inherits
    from its shop, company and tenant. Read by whoever may read the shop.
    """
    area, shop = _area_and_shop(db, area_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    effective = sources = None
    if include_effective:
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if company:
            effective, sources = _inherited_preview(
                [("tenant", _tenant_of(company, db)), ("company", company), ("shop", shop)]
            )
    return AreaSettingsResponse(
        settings=area.settings or {},
        settings_updated_at=area.settings_updated_at,
        effective=effective,
        effective_sources=sources,
    )


@router.patch(
    "/areas/{area_id}/settings",
    response_model=AreaSettingsResponse,
    response_model_by_alias=True,
)
def patch_area_settings(
    area_id: str,
    data: PosSettingsV1Patch,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Write this point of sale's own overrides. Whoever may write its shop's settings may
    (`_check_shop_settings_write`), under the shop's rules: no tenant-only keys, branding
    only by its owners, and never a layer left with no way to take payment. The tills
    standing in the area are told.
    """
    area, shop = _area_and_shop(db, area_id, active_tenant_id)
    _check_shop_settings_write(current_user, shop, db)
    _refuse_tenant_only_keys(data)
    patch = _build_patch(data, current_user)
    secrets = _secret_patch(data)
    if not patch and not secrets:
        return AreaSettingsResponse(
            settings=area.settings or {},
            settings_updated_at=area.settings_updated_at,
        )

    company = db.query(Company).filter(Company.id == shop.company_id).first()
    tenant = _tenant_of(company, db) if company else None
    _check_leaves_a_payment_option(
        [_settings_of(tenant), _settings_of(company), _settings_of(shop)], area.settings, patch
    )
    area.settings = patch_settings_json(area.settings, patch)
    _store_secrets(db, "area", area, secrets, current_user)
    area.settings_updated_at = utc_now()
    db.commit()
    db.refresh(area)
    notify_machines_for_area_settings(db, str(area.id), reason="area_settings_updated")
    return AreaSettingsResponse(
        settings=area.settings or {},
        settings_updated_at=area.settings_updated_at,
    )


# ── One till: the last layer, under its area and shop ─────────────────────────


def _machine_parents(db: Session, machine: POSMachine):
    """The till's area, shop, company and tenant — the layers its own settings sit on."""
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    company = db.query(Company).filter(Company.id == shop.company_id).first() if shop else None
    tenant = _tenant_of(company, db) if company else None
    area = get_area(db, getattr(machine, "area_id", None)) if shop else None
    return area, shop, company, tenant


@router.get(
    "/machines/{machine_id}/settings",
    response_model=MachineSettingsResponse,
    response_model_by_alias=True,
)
def get_machine_settings(
    machine_id: str,
    include_effective: bool = Query(False, alias="includeEffective"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    This till's own overrides, and with `includeEffective` what it inherits from its
    area, shop, company and tenant — the same shape as the shop's, two layers down.
    """
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    effective = sources = None
    if include_effective:
        area, shop, company, tenant = _machine_parents(db, machine)
        if company:
            # Inherited preview = tenant + company + shop + area, without the till's own values.
            effective, sources = _inherited_preview(
                [("tenant", tenant), ("company", company), ("shop", shop), ("area", area)]
            )
    return MachineSettingsResponse(
        settings=machine.settings or {},
        settings_updated_at=machine.settings_updated_at,
        effective=effective,
        effective_sources=sources,
    )


@router.patch(
    "/machines/{machine_id}/settings",
    response_model=MachineSettingsResponse,
    response_model_by_alias=True,
)
def patch_machine_settings(
    machine_id: str,
    data: PosSettingsV1Patch,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Write this till's own overrides. Whoever may manage the till may; a cashier may not
    (`get_current_machine_admin`). The same rules as the shop's: no tenant-only keys,
    branding only by its owners, and never a till left with no way to take payment.
    """
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    _refuse_tenant_only_keys(data)
    patch = _build_patch(data, current_user)
    # A till without a terminal of its own (a P18) may only be given an external one.
    payment_integration.check_machine_choice(machine, patch)
    secrets = _secret_patch(data)
    if not patch and not secrets:
        return MachineSettingsResponse(
            settings=machine.settings or {},
            settings_updated_at=machine.settings_updated_at,
        )

    area, shop, company, tenant = _machine_parents(db, machine)
    _check_leaves_a_payment_option(
        [_settings_of(tenant), _settings_of(company), _settings_of(shop), _settings_of(area)],
        machine.settings,
        patch,
    )
    machine.settings = patch_settings_json(machine.settings, patch)
    _store_secrets(db, "machine", machine, secrets, current_user)
    machine.settings_updated_at = utc_now()
    db.commit()
    db.refresh(machine)
    notify_machine_settings(db, machine, reason="machine_settings_updated")
    return MachineSettingsResponse(
        settings=machine.settings or {},
        settings_updated_at=machine.settings_updated_at,
    )


# ── The card terminal number, forced from the cloud ───────────────────────────


def _machines_under(db: Session, level: str, target_id: str) -> List[POSMachine]:
    """The active tills a write at `level` reaches, the same set its notify tells."""
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if level == "machine":
        query = query.filter(POSMachine.id == target_id)
    elif level == "area":
        query = query.filter(POSMachine.area_id == target_id)
    elif level == "shop":
        query = query.filter(POSMachine.shop_id == target_id)
    else:
        shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id == target_id).all()]
        if not shop_ids:
            return []
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    return query.all()


def _till_order(machine: POSMachine):
    """By shop, then register number ("קופה 2" before "קופה 10"), then name."""
    number = machine.pos_number or ""
    return (str(machine.shop_id), int(number) if number.isdigit() else 0, machine.name or "")


@router.post("/machines/terminal-number/force")
def force_terminal_number(
    body: TerminalNumberForceRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set `forceTerminalNumber` (and, with `terminalNumber`, `expectedTerminalNumber`) on
    one level — a company, shop, area or till. The write goes through that level's own
    settings PATCH, so it is allowed exactly when editing that level's settings is, and
    its tills are told the same way. `force: false` writes `false`, so a till under a
    forcing shop can be held out of it; a `null` through the settings PATCH inherits again.

    Answers the tills the write reaches, each with its terminal status as of now (the
    till only reports the outcome on its next sync and heartbeat).
    """
    patch: Dict[str, Any] = {"forceTerminalNumber": body.force}
    if body.terminal_number is not None:
        patch["expectedTerminalNumber"] = body.terminal_number
    data = PosSettingsV1Patch.model_validate(patch)
    target = str(body.target_id)
    if body.level == "company":
        patch_company_settings(target, data, current_user, active_tenant_id, db)
    elif body.level == "shop":
        patch_shop_settings(target, data, current_user, active_tenant_id, db)
    elif body.level == "area":
        patch_area_settings(target, data, current_user, active_tenant_id, db)
    else:
        patch_machine_settings(
            target, data, get_current_machine_admin(current_user), active_tenant_id, db
        )

    machines = _machines_under(db, body.level, target)
    machines.sort(key=_till_order)
    terminal = terminal_settings_for(db, machines)
    return {
        "level": body.level,
        "targetId": target,
        "forceTerminalNumber": body.force,
        "expectedTerminalNumber": body.terminal_number,
        "machines": [
            {
                "id": m.id,
                "name": m.name,
                "shopId": m.shop_id,
                "areaName": m.area_name,
                "posNumber": m.pos_number,
                **machine_terminal_fields(m, terminal[m.id]),
            }
            for m in machines
        ],
    }
