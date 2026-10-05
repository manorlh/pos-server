"""Merge tenant → company → shop → area → till settings for POS sync."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional, Sequence, Tuple

from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.schemas.pos_settings import BusinessInfoSync
from app.services.payment_options import PAYMENT_OPTION_SETTING_KEYS
from app.services.refund_settings import REFUND_SETTING_KEYS
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
    # The most instalments the `card` option's picker offers; unset = the terminal decides.
    "payInstallmentsMax",
    # sellSearchEnabled, sellScanEnabled, sellCalculatorEnabled — spelled out once in
    # sell_screen.py.
    *SELL_SCREEN_SETTING_KEYS,
    # unlinkedCardCreditEnabled, refundCustomerDetailsRequired — refund_settings.py.
    *REFUND_SETTING_KEYS,
    "tipPresets",
    # "סידור פריטים": the till's buttons in this order (product ids), set from a till's
    # edit mode at the shop, the point of sale or the till itself.
    "productOrder",
    # The customer's tip question; the till falls back to its own wording when unset.
    "tipPromptText",
    "tipDistribution",
    "receiptPrinterName",
    "drawerPrinterName",
    "brandLogoUrl",
    "brandHeroUrl",
    "brandPrimaryColor",
    "brandReceiptLogoUrl",
    # The card terminal number each till must be connected to; the till checks it.
    "expectedTerminalNumber",
    # Shva or Pelecard: the till points its Agamento there on sync.
    "clearingServer",
    # Whether the till writes the expected terminal number into its Agamento.
    "forceTerminalNumber",
)

#: White-label keys. Written at any layer, but only by BRANDING_WRITE_ROLES
#: (see app/routers/settings.py) — a shop manager must not repaint the
#: distributor's brand on the tills in their store. `brandPrimaryColor` is the
#: till's main colour, "#RRGGBB"; the till derives its whole palette from it.
#: `brandReceiptLogoUrl` is printed at the head of the till's receipts.
BRANDING_SETTING_KEYS = ("brandLogoUrl", "brandHeroUrl", "brandPrimaryColor", "brandReceiptLogoUrl")


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
    machine: Optional[Any] = None,
    area: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    Full merged settings dict including businessInfo nested overrides.

    Tenant → company → shop → area → till, the later layer winning: a till's own value
    beats its point of sale's (its `ShopArea`), which beats its shop's, which beats its
    company's. [machine] is a `POSMachine` and [area] its `ShopArea`; most of either have
    no settings of their own and add nothing.
    """
    layers = [_as_dict(tenant.settings if tenant else None)]
    layers.append(_as_dict(company.settings))
    if shop:
        layers.append(_as_dict(shop.settings))
    if area is not None:
        layers.append(_as_dict(area.settings))
    if machine is not None:
        layers.append(_as_dict(machine.settings))
    return deep_merge_settings(*layers)


def merge_settings(
    company: Company,
    shop: Optional[Shop] = None,
    tenant: Optional[Tenant] = None,
    machine: Optional[Any] = None,
    area: Optional[Any] = None,
) -> Dict[str, Any]:
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    return {k: merged[k] for k in MANAGED_SETTING_KEYS if k in merged}


def settings_sources(layers: Sequence[Tuple[str, Any]]) -> Dict[str, str]:
    """
    Per top-level key, the level whose layer the merged value comes from.

    `layers` is `(level name, stored settings)` least specific first, as merged. A key
    no layer sets is absent: its value is the option's default, not any level's.
    """
    out: Dict[str, str] = {}
    for level, settings in layers:
        for key in _as_dict(settings):
            out[key] = level
    return out


def effective_settings_updated_at(
    company: Company,
    shop: Optional[Shop] = None,
    tenant: Optional[Tenant] = None,
    machine: Optional[Any] = None,
    area: Optional[Any] = None,
) -> datetime:
    stamps = [
        company.settings_updated_at,
        company.updated_at,
    ]
    if shop:
        stamps.extend([shop.settings_updated_at, shop.updated_at])
    if tenant:
        stamps.extend([tenant.settings_updated_at, tenant.updated_at])
    # Not the machine's `updated_at`: every heartbeat moves it, and the settings
    # watermark must only move when settings did. The area's own settings stamp the
    # same way (its `updated_at` is already in the till's watermark, for its name).
    for layer in (area, machine):
        stamp = getattr(layer, "settings_updated_at", None) if layer is not None else None
        if isinstance(stamp, datetime):
            stamps.append(stamp)
    # Naive stamps (SQLite in tests) are UTC; mixing them with aware ones in max() raises.
    return max(
        s if s.tzinfo is not None else s.replace(tzinfo=timezone.utc)
        for s in stamps
        if s is not None
    )


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
