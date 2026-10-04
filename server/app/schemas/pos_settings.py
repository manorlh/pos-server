"""POS till settings v1 — keys align with pos-desktop SQLite `settings` table."""
import re
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

#: Max characters for a branding image URL stored in settings JSONB.
BRAND_IMAGE_URL_MAX_LEN = 500

#: A card terminal number as Agamento reports it (`tmsRetailer`): digits only.
TERMINAL_NUMBER_PATTERN = re.compile(r"[0-9]{1,20}")
#: The clearing servers a till's Agamento can be pointed at (its `ashraitServer`).
CLEARING_SERVERS = ("SHVA", "PELECARD")
#: The longest tip question; the till cuts at the same length.
TIP_PROMPT_MAX = 80

#: The till's brand colour: six hex digits, as the till parses it (`Color.parseColor`).
BRAND_COLOR_PATTERN = re.compile(r"#[0-9A-Fa-f]{6}")

#: The range of `payInstallmentsMax`: one payment is the fast card's job, and 36 is the
#: most instalments an Israeli card terminal takes.
INSTALLMENTS_MIN = 2
INSTALLMENTS_MAX = 36

#: How many tip percentages a layer may offer: the till's tip screen lays them out as
#: square buttons, and six is what fits a 360 dp terminal at a size a customer can hit.
TIP_PRESETS_MAX = 6


def _is_own_media_url(v: str) -> bool:
    """A file in this server's own media store (app/services/local_media.py)."""
    from app.services import local_media

    return v.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/")


def _validate_brand_url(v: Optional[str]) -> Optional[str]:
    """Branding URLs must be absolute https:// (Android blocks cleartext) or "" (= no image).

    Any https URL the uploads return is accepted, a video included: `brandHeroUrl` may be
    a short MP4/WebM from `POST /images/media`, which the till plays instead of decoding.
    The one exception to https is this server's own media store, which a development
    server without Cloudinary serves over plain http (as the till parameters accept it,
    `validate_image_url` in app/services/till_parameters.py).
    """
    if v is None:
        return None
    v = v.strip()
    if v == "":
        return ""
    if not v.startswith("https://") and not _is_own_media_url(v):
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
    pay_manual_card_enabled: Optional[bool] = Field(None, alias="payManualCardEnabled")
    pay_manual_card_tips: Optional[bool] = Field(None, alias="payManualCardTips")
    #: The most instalments the till's instalments picker (the `card` option) offers,
    #: 2–36. Unset = the card terminal decides; `null` in a PATCH resets the layer to
    #: inherit (TIP_RESETTABLE_KEYS in app/routers/settings.py).
    pay_installments_max: Optional[int] = Field(
        None, alias="payInstallmentsMax", ge=INSTALLMENTS_MIN, le=INSTALLMENTS_MAX
    )
    # ── Optional tools on the till's sell screen ──
    # Unset = shown. Resolution lives in app/services/sell_screen.py.
    sell_search_enabled: Optional[bool] = Field(None, alias="sellSearchEnabled")
    sell_scan_enabled: Optional[bool] = Field(None, alias="sellScanEnabled")
    sell_calculator_enabled: Optional[bool] = Field(None, alias="sellCalculatorEnabled")
    # The till's return flow; both on unless switched off (app/services/refund_settings.py).
    unlinked_card_credit_enabled: Optional[bool] = Field(None, alias="unlinkedCardCreditEnabled")
    refund_customer_details_required: Optional[bool] = Field(
        None, alias="refundCustomerDetailsRequired"
    )
    #: The percentages the till offers on its tip screen, one square button each, in
    #: this order. Up to TIP_PRESETS_MAX of them, each 1–100, no repeats; an empty list
    #: offers no percentages (the till then asks for no tip). `null` in a PATCH resets
    #: the layer to inherit (TIP_RESETTABLE_KEYS in app/routers/settings.py).
    tip_presets: Optional[List[int]] = Field(None, alias="tipPresets")
    tip_distribution: Optional[Literal["direct", "equal_pool", "by_sales"]] = Field(
        None, alias="tipDistribution"
    )
    #: The question on the customer's tip screen ("כמה טיפ תרצו להשאיר?" when unset).
    #: Up to TIP_PROMPT_MAX characters; "" = the till's default; `null` in a PATCH resets.
    tip_prompt_text: Optional[str] = Field(None, alias="tipPromptText")

    @field_validator("tip_prompt_text")
    @classmethod
    def _check_tip_prompt(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = " ".join(v.split())
        if len(v) > TIP_PROMPT_MAX:
            raise ValueError(f"the tip question is at most {TIP_PROMPT_MAX} characters")
        return v

    @field_validator("tip_presets")
    @classmethod
    def _check_tip_presets(cls, v: Optional[List[int]]) -> Optional[List[int]]:
        if v is None:
            return v
        if len(v) > TIP_PRESETS_MAX:
            raise ValueError(f"at most {TIP_PRESETS_MAX} tip percentages")
        if any(p < 1 or p > 100 for p in v):
            raise ValueError("each tip percentage must be between 1 and 100")
        if len(set(v)) != len(v):
            raise ValueError("tip percentages must not repeat")
        return v
    receipt_printer_name: Optional[str] = Field(None, alias="receiptPrinterName")
    drawer_printer_name: Optional[str] = Field(None, alias="drawerPrinterName")
    business_info: Optional[Dict[str, Any]] = Field(None, alias="businessInfo")
    # ── White label (distributor branding shown on the till) ──────────────────
    # "" = deliberately no image at this level (overrides an inherited URL);
    # explicit null in a PATCH body = unset this level so it inherits again.
    # ── Z scope (tenant level only) ──
    # "shop" (default): one Z per shop over all its tills. "machine": the Z wizard
    # forces one till per Z — for an accountant who reads the regulation as a Z per
    # register. Not sent to tills.
    z_scope: Optional[Literal["shop", "machine"]] = Field(None, alias="zScope")
    brand_logo_url: Optional[str] = Field(None, alias="brandLogoUrl")
    brand_hero_url: Optional[str] = Field(None, alias="brandHeroUrl")
    #: The till's main colour, "#RRGGBB" — buttons, highlights and the tints derived
    #: from them. "" = the till's own default; `null` in a PATCH = inherit again.
    brand_primary_color: Optional[str] = Field(None, alias="brandPrimaryColor")
    #: Printed at the head of the till's receipts. Same rules as the logo.
    brand_receipt_logo_url: Optional[str] = Field(None, alias="brandReceiptLogoUrl")
    #: The card terminal number (Shva's "מספר מסוף") the till must be connected to. Set on
    #: a shop it is one number for every till there; set on a till it is that till's own.
    #: The till compares it with what its Agamento reports and refuses to work on a
    #: mismatch. "" = no check at this layer; `null` in a PATCH = inherit again.
    expected_terminal_number: Optional[str] = Field(None, alias="expectedTerminalNumber")
    #: Which clearing server Agamento sends card transactions to: "SHVA" or "PELECARD".
    #: The till switches its Agamento to it on sync (only while idle, with nothing left
    #: to transmit). "" = leave the terminal as it is; `null` in a PATCH = inherit again.
    clearing_server: Optional[str] = Field(None, alias="clearingServer")
    #: While true, a till whose Agamento reports a terminal number other than its
    #: effective `expectedTerminalNumber` writes the expected one into Agamento on its
    #: next sync (only while idle, with nothing left to transmit), reads it back and
    #: reports the result in its heartbeat. Unset = false; `null` in a PATCH = inherit.
    force_terminal_number: Optional[bool] = Field(None, alias="forceTerminalNumber")

    @field_validator("clearing_server")
    @classmethod
    def _check_clearing_server(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip().upper()
        if v not in CLEARING_SERVERS and v != "":
            raise ValueError(f"Clearing server must be one of {', '.join(CLEARING_SERVERS)}")
        return v

    @field_validator("expected_terminal_number")
    @classmethod
    def _check_terminal_number(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if v == "":
            return ""
        if not TERMINAL_NUMBER_PATTERN.fullmatch(v):
            raise ValueError("Terminal number must be 1–20 digits")
        return v

    @field_validator("brand_logo_url", "brand_hero_url", "brand_receipt_logo_url")
    @classmethod
    def _check_brand_urls(cls, v: Optional[str]) -> Optional[str]:
        return _validate_brand_url(v)

    @field_validator("brand_primary_color")
    @classmethod
    def _check_brand_color(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if v == "":
            return ""
        if not BRAND_COLOR_PATTERN.fullmatch(v):
            raise ValueError('Brand colour must be "#RRGGBB"')
        return v.upper()

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
    #: With `effective`: per key, the level that set the inherited value ("tenant",
    #: "company", "shop", "area"). A key no level above sets is absent (= the default).
    effective_sources: Optional[Dict[str, str]] = Field(None, alias="effectiveSources")


class MachineSettingsResponse(BaseModel):
    """A till's own layer. `settingsUpdatedAt` is null until it is first written."""

    settings: Dict[str, Any]
    settings_updated_at: Optional[datetime] = Field(None, alias="settingsUpdatedAt")
    effective: Optional[Dict[str, Any]] = None
    #: As on `ShopSettingsResponse`.
    effective_sources: Optional[Dict[str, str]] = Field(None, alias="effectiveSources")

    class Config:
        populate_by_name = True


class AreaSettingsResponse(MachineSettingsResponse):
    """A point of sale's (shop area's) own layer, between its shop and its tills.
    `settingsUpdatedAt` is null until it is first written."""


class SettingsSyncResponse(BaseModel):
    sync_type: Literal["full", "delta", "unchanged"] = Field(..., alias="syncType")
    server_time: datetime = Field(..., alias="serverTime")
    settings_updated_at: datetime = Field(..., alias="settingsUpdatedAt")
    settings: Dict[str, Any] = Field(default_factory=dict)
    business_info: Optional[BusinessInfoSync] = Field(None, alias="businessInfo")
    #: The till's area, `{id, name}`, or null for none (docs/AREAS_API.md §3). Sent on
    #: every response, "unchanged" included, so it is always the current truth.
    area: Optional[Dict[str, str]] = None

    class Config:
        populate_by_name = True
