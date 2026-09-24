"""POS till settings v1 — keys align with pos-desktop SQLite `settings` table."""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

#: Max characters for a branding image URL stored in settings JSONB.
BRAND_IMAGE_URL_MAX_LEN = 500


def _validate_brand_url(v: Optional[str]) -> Optional[str]:
    """Branding URLs must be absolute https:// (Android blocks cleartext) or "" (= no image)."""
    if v is None:
        return None
    v = v.strip()
    if v == "":
        return ""
    if not v.startswith("https://"):
        raise ValueError("Branding image URL must be an absolute https:// URL")
    if len(v) > BRAND_IMAGE_URL_MAX_LEN:
        raise ValueError(f"Branding image URL must be at most {BRAND_IMAGE_URL_MAX_LEN} characters")
    return v


class PosSettingsV1Patch(BaseModel):
    """Partial update for tenant/company/shop settings JSONB."""

    global_tax_rate: Optional[int] = Field(None, alias="globalTaxRate", ge=0, le=100)
    hide_out_of_stock_products: Optional[bool] = Field(None, alias="hideOutOfStockProducts")
    language: Optional[Literal["he", "en"]] = None
    nayax_enabled: Optional[bool] = Field(None, alias="nayaxEnabled")
    nayax_device_host: Optional[str] = Field(None, alias="nayaxDeviceHost")
    nayax_device_port: Optional[str] = Field(None, alias="nayaxDevicePort")
    nayax_spicy_path: Optional[str] = Field(None, alias="nayaxSpicyPath")
    out_of_stock_policy: Optional[Literal["block", "warn", "allow"]] = Field(
        None, alias="outOfStockPolicy"
    )
    # Legacy tip switches. Still accepted and stored: layers already hold them, and
    # they are the fallback for any option whose own tips key below is unset
    # (see app/services/payment_options.py).
    tips_enabled: Optional[bool] = Field(None, alias="tipsEnabled")
    cash_tips_enabled: Optional[bool] = Field(None, alias="cashTipsEnabled")
    # ── Payment options offered on the till, and whether each asks for a tip ──
    # Unset = offered / legacy tip rule. Resolution lives in payment_options.py.
    pay_fast_cash_enabled: Optional[bool] = Field(None, alias="payFastCashEnabled")
    pay_fast_cash_tips: Optional[bool] = Field(None, alias="payFastCashTips")
    pay_cash_enabled: Optional[bool] = Field(None, alias="payCashEnabled")
    pay_cash_tips: Optional[bool] = Field(None, alias="payCashTips")
    pay_fast_card_enabled: Optional[bool] = Field(None, alias="payFastCardEnabled")
    pay_fast_card_tips: Optional[bool] = Field(None, alias="payFastCardTips")
    pay_card_enabled: Optional[bool] = Field(None, alias="payCardEnabled")
    pay_card_tips: Optional[bool] = Field(None, alias="payCardTips")
    tip_presets: Optional[List[int]] = Field(None, alias="tipPresets")
    tip_distribution: Optional[Literal["direct", "equal_pool", "by_sales"]] = Field(
        None, alias="tipDistribution"
    )
    receipt_printer_name: Optional[str] = Field(None, alias="receiptPrinterName")
    drawer_printer_name: Optional[str] = Field(None, alias="drawerPrinterName")
    business_info: Optional[Dict[str, Any]] = Field(None, alias="businessInfo")
    # ── White label (distributor branding shown on the till) ──────────────────
    # "" = deliberately no image at this level (overrides an inherited URL);
    # explicit null in a PATCH body = unset this level so it inherits again.
    brand_logo_url: Optional[str] = Field(None, alias="brandLogoUrl")
    brand_hero_url: Optional[str] = Field(None, alias="brandHeroUrl")

    @field_validator("brand_logo_url", "brand_hero_url")
    @classmethod
    def _check_brand_urls(cls, v: Optional[str]) -> Optional[str]:
        return _validate_brand_url(v)

    class Config:
        populate_by_name = True


class BusinessInfoSync(BaseModel):
    vat_number: str = Field(..., alias="vatNumber")
    company_name: str = Field(..., alias="companyName")
    company_address: str = Field(..., alias="companyAddress")
    company_address_number: str = Field("1", alias="companyAddressNumber")
    company_city: str = Field(..., alias="companyCity")
    company_zip: str = Field("", alias="companyZip")
    company_reg_number: Optional[str] = Field(None, alias="companyRegNumber")
    has_branches: bool = Field(False, alias="hasBranches")
    branch_id: Optional[str] = Field(None, alias="branchId")

    class Config:
        populate_by_name = True


class EntitySettingsResponse(BaseModel):
    settings: Dict[str, Any]
    settings_updated_at: datetime = Field(..., alias="settingsUpdatedAt")

    class Config:
        populate_by_name = True


class ShopSettingsResponse(EntitySettingsResponse):
    effective: Optional[Dict[str, Any]] = None


class SettingsSyncResponse(BaseModel):
    sync_type: Literal["full", "delta", "unchanged"] = Field(..., alias="syncType")
    server_time: datetime = Field(..., alias="serverTime")
    settings_updated_at: datetime = Field(..., alias="settingsUpdatedAt")
    settings: Dict[str, Any] = Field(default_factory=dict)
    business_info: Optional[BusinessInfoSync] = Field(None, alias="businessInfo")

    class Config:
        populate_by_name = True
