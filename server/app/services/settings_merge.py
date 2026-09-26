"""Merge company/shop (and optional tenant) settings for POS sync."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.schemas.pos_settings import BusinessInfoSync
from app.services.payment_options import PAYMENT_OPTION_SETTING_KEYS
from app.services.sell_screen import SELL_SCREEN_SETTING_KEYS

MANAGED_SETTING_KEYS = (
    "globalTaxRate",
    "hideOutOfStockProducts",
    "language",
    "nayaxEnabled",
    "nayaxDeviceHost",
    "nayaxDevicePort",
    "nayaxSpicyPath",
    "outOfStockPolicy",
    "tipsEnabled",
    "cashTipsEnabled",
    # payFastCashEnabled, payFastCashTips, payCashEnabled, ... — the eight payment
    # option keys, spelled out once in payment_options.py.
    *PAYMENT_OPTION_SETTING_KEYS,
    # sellSearchEnabled, sellScanEnabled — spelled out once in sell_screen.py.
    *SELL_SCREEN_SETTING_KEYS,
    "tipPresets",
    "tipDistribution",
    "receiptPrinterName",
    "drawerPrinterName",
    "brandLogoUrl",
    "brandHeroUrl",
)

#: White-label keys. Written at any layer, but only by BRANDING_WRITE_ROLES
#: (see app/routers/settings.py) — a shop manager must not repaint the
#: distributor's brand on the tills in their store.
BRANDING_SETTING_KEYS = ("brandLogoUrl", "brandHeroUrl")


def _as_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def deep_merge_settings(*layers: Dict[str, Any]) -> Dict[str, Any]:
    """Later layers override earlier; nested dicts (e.g. businessInfo) merge shallowly."""
    out: Dict[str, Any] = {}
    for layer in layers:
        for key, val in _as_dict(layer).items():
            if (
                key in out
                and isinstance(out[key], dict)
                and isinstance(val, dict)
            ):
                out[key] = {**out[key], **val}
            else:
                out[key] = val
    return out


def merge_all_settings_layers(
    company: Company,
    shop: Optional[Shop] = None,
    tenant: Optional[Tenant] = None,
) -> Dict[str, Any]:
    """Full merged settings dict including businessInfo nested overrides."""
    layers = [_as_dict(tenant.settings if tenant else None)]
    layers.append(_as_dict(company.settings))
    if shop:
        layers.append(_as_dict(shop.settings))
    return deep_merge_settings(*layers)


def merge_settings(
    company: Company,
    shop: Optional[Shop] = None,
    tenant: Optional[Tenant] = None,
) -> Dict[str, Any]:
    merged = merge_all_settings_layers(company, shop, tenant)
    return {k: merged[k] for k in MANAGED_SETTING_KEYS if k in merged}


def effective_settings_updated_at(
    company: Company,
    shop: Optional[Shop] = None,
    tenant: Optional[Tenant] = None,
) -> datetime:
    stamps = [
        company.settings_updated_at,
        company.updated_at,
    ]
    if shop:
        stamps.extend([shop.settings_updated_at, shop.updated_at])
    if tenant:
        stamps.extend([tenant.settings_updated_at, tenant.updated_at])
    return max(stamps)


def build_business_info(
    company: Company,
    shop: Optional[Shop] = None,
    merged_settings: Optional[Dict[str, Any]] = None,
) -> BusinessInfoSync:
    merged = merged_settings or merge_all_settings_layers(company, shop)
    bi_override = _as_dict(merged.get("businessInfo"))

    address = shop.address if shop and shop.address else (company.address or "")
    city = shop.city if shop and shop.city else (company.city or "")
    branch_id = shop.branch_id if shop else None
    has_branches = bool(branch_id)

    return BusinessInfoSync(
        vat_number=bi_override.get("vatNumber") or company.vat_number or "",
        company_name=bi_override.get("companyName") or company.name,
        company_address=bi_override.get("companyAddress") or address or "",
        company_address_number=bi_override.get("companyAddressNumber") or "1",
        company_city=bi_override.get("companyCity") or city or "",
        company_zip=bi_override.get("companyZip") or "",
        company_reg_number=bi_override.get("companyRegNumber"),
        has_branches=bi_override.get("hasBranches", has_branches),
        branch_id=bi_override.get("branchId") or branch_id,
    )


def patch_settings_json(current: Any, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a camelCase patch dict into stored JSONB settings."""
    out = _as_dict(current)
    for key, val in patch.items():
        if val is None:
            out.pop(key, None)
        elif key == "businessInfo" and isinstance(val, dict):
            existing = _as_dict(out.get("businessInfo"))
            out["businessInfo"] = {**existing, **val}
        else:
            out[key] = val
    return out


def patch_to_camel_dict(patch_model) -> Dict[str, Any]:
    """Convert PosSettingsV1Patch dump to camelCase keys for JSONB storage."""
    raw = patch_model.model_dump(exclude_unset=True, by_alias=True)
    return {k: v for k, v in raw.items() if v is not None}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
