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
    #: "פתיחת פריטים אוטומטית אחרי Z" (docs/SPEC_AVAILABILITY.md): "off" (the default),
    #: "day" — reopen what was locked or marked sold out during the day the Z closes —
    #: or "all" — reopen every lock not marked "חסימה קבועה". `null` = inherit again.
    auto_reopen_after_z: Optional[Literal["off", "day", "all"]] = Field(None, alias="autoReopenAfterZ")
    #: Reopen an item that tracks stock even while it has none. Unset = false.
    auto_reopen_ignore_stock: Optional[bool] = Field(None, alias="autoReopenIgnoreStock")
    #: "אזל אוטומטי": a product that tracks stock is blocked "אזל" by itself when the stock its
    #: devices sell from reaches 0 (app/services/sold_out.py). Unset = on.
    auto_sold_out_at_zero: Optional[bool] = Field(None, alias="autoSoldOutAtZero")
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
    # ── The production voucher ("שובר הפקה") on the till's payment screen ──
    # Unset = on; `null` in a PATCH resets the layer to inherit. With every option above
    # off, either one on keeps the till payable: a voucher-only till (payment_options.py).
    pay_voucher_enabled: Optional[bool] = Field(None, alias="payVoucherEnabled")
    #: "שובר ידני": typing the voucher's code by hand.
    pay_voucher_manual_enabled: Optional[bool] = Field(None, alias="payVoucherManualEnabled")
    # ── How the till enters a production voucher's redemption (app/services/voucher_redeem_settings.py) ──
    #: "דרך מימוש שובר": items first, the voucher first, or both ways in (unset = both).
    #: Anything else is a 422; `null` in a PATCH resets the layer to inherit.
    voucher_redeem_flow: Optional[Literal["items_first", "voucher_first", "both"]] = Field(
        None, alias="voucherRedeemFlow"
    )
    #: "פריטים זכאים שאינם זמינים": shown blocked with the reason (unset = true) or hidden.
    voucher_show_unavailable: Optional[bool] = Field(None, alias="voucherShowUnavailable")
    #: "בירור יתרת שובר" in the till's menu (app/services/voucher_balance_check.py): "auto" (unset —
    #: on while the till has an active production voucher batch), "on" or "off". Anything else is a
    #: 422; `null` in a PATCH resets the layer to inherit.
    voucher_balance_check: Optional[Literal["auto", "on", "off"]] = Field(None, alias="voucherBalanceCheck")
    # ── Closing on their own and the voucher station (app/services/voucher_station_settings.py) ──
    #: "סגירה אוטומטית כשהשובר מכסה הכל": "on" (unset — today's behaviour) or "off".
    voucher_auto_close: Optional[Literal["on", "off"]] = Field(None, alias="voucherAutoClose")
    #: "עמדת שובר (מסך סריקה בלבד)": "off" (unset) or "on". Anything else is a 422 for both;
    #: `null` in a PATCH resets the layer to inherit.
    voucher_station: Optional[Literal["off", "on"]] = Field(None, alias="voucherStation")
    #: "רכישה נוספת בתשלום בעמדת שובר": "off" (unset — vouchers only) or "on" (items paid for at the
    #: regular price added at the station after the voucher). Anything else is a 422; `null` in a
    #: PATCH resets the layer to inherit.
    voucher_station_paid_items: Optional[Literal["off", "on"]] = Field(None, alias="voucherStationPaidItems")
    #: "הצג לקופאי מה מגיע ללקוח בסריקת שובר": "on" (unset — a card on every voucher scan, never
    #: stopping the redemption) or "off". Anything else is a 422; `null` in a PATCH resets the layer.
    voucher_show_entitlement: Optional[Literal["on", "off"]] = Field(None, alias="voucherShowEntitlement")
    #: "מימוש אוטומטי בסריקת שובר": "on" (unset — a voucher scanned over a cart is applied at once to
    #: the matching lines, no redeem sheet, when no choice is needed) or "off" (the sheet opens, as
    #: before). Anything else is a 422; `null` in a PATCH resets the layer.
    voucher_auto_apply: Optional[Literal["on", "off"]] = Field(None, alias="voucherAutoApply")
    #: "מסך הצלחה במימוש שובר": "always" (unset — a large green screen after every sale that redeemed a
    #: voucher), "auto_close" (only when the voucher closed the sale by itself) or "off". Anything else
    #: is a 422; `null` in a PATCH resets the layer.
    voucher_success_screen: Optional[Literal["always", "auto_close", "off"]] = Field(
        None, alias="voucherSuccessScreen"
    )
    #: "משך מסך ההצלחה (שניות)": 1–10 (unset — 3). Outside the range is a 422; `null` in a PATCH resets
    #: the layer.
    voucher_success_seconds: Optional[int] = Field(None, alias="voucherSuccessSeconds", ge=1, le=10)
    #: "סגירת מסך 'שובר מומש'": "auto" (unset — by itself after the seconds above, or on a touch) or
    #: "confirm" (until the cashier presses "אישור"; a new scan counts as the press). Anything else is a
    #: 422; `null` in a PATCH resets the layer.
    voucher_success_dismiss: Optional[Literal["auto", "confirm"]] = Field(None, alias="voucherSuccessDismiss")
    #: "צליל אישור במימוש שובר" / "צליל סירוב במימוש שובר": "on" (unset — a strong sound when a
    #: voucher is accepted / refused) or "off". Anything else is a 422; `null` in a PATCH resets the layer.
    voucher_sound_approve: Optional[Literal["on", "off"]] = Field(None, alias="voucherSoundApprove")
    voucher_sound_reject: Optional[Literal["on", "off"]] = Field(None, alias="voucherSoundReject")
    # ── The voucher fast mode, 13.10.2026 (P:/specs/voucher-fast-mode.md §0; resolved in
    # app/services/voucher_station_settings.py). Anything outside a choice's values is a 422; `null`
    # in a PATCH resets the layer to inherit.
    #: "מצב מהיר: מימוש בלי בחירה כשהשובר ברור": "off", "station" (unset — at the voucher station only)
    #: or "all".
    voucher_fast_mode: Optional[Literal["off", "station", "all"]] = Field(None, alias="voucherFastMode")
    #: "סגירה לבד במצב מהיר": "on" (unset) or "off".
    voucher_fast_auto_close: Optional[Literal["on", "off"]] = Field(None, alias="voucherFastAutoClose")
    #: "מצלמה בעמדת שובר": "off", "always" (a live camera all the time) or "tap" (unset — on a tap).
    voucher_station_camera: Optional[Literal["off", "always", "tap"]] = Field(None, alias="voucherStationCamera")
    #: "איזו מצלמה בעמדת שובר": "back" (unset) or "front".
    voucher_station_camera_facing: Optional[Literal["back", "front"]] = Field(
        None, alias="voucherStationCameraFacing"
    )
    #: "רטט במימוש שובר": "off", "approve", "reject" or "both" (unset) — a device with a vibrator only.
    voucher_vibrate: Optional[Literal["off", "approve", "reject", "both"]] = Field(None, alias="voucherVibrate")
    #: "הגברת צליל שובר לעוצמה מקסימלית": "on" (unset) or "off".
    voucher_sound_boost: Optional[Literal["on", "off"]] = Field(None, alias="voucherSoundBoost")
    #: "מעבר מעמדת שובר לקטלוג רגיל": "off", "manager" (unset — with a manager's code) or "free".
    voucher_station_catalog_switch: Optional[Literal["off", "manager", "free"]] = Field(
        None, alias="voucherStationCatalogSwitch"
    )
    #: "כותרת במסך עמדת שובר": "logo" (unset), "text", "both" or "none".
    voucher_station_header: Optional[Literal["logo", "text", "both", "none"]] = Field(
        None, alias="voucherStationHeader"
    )
    #: "כיתוב בראש עמדת שובר": free text, whitespace collapsed and trimmed; over 40 characters is a 422
    #: with a Hebrew message (`voucher_station_title_too_long`); blank = `null`, the layer inherits.
    voucher_station_title: Optional[str] = Field(None, alias="voucherStationTitle")

    @field_validator("voucher_station_title")
    @classmethod
    def _check_voucher_station_title(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        from pydantic_core import PydanticCustomError

        from app.services.voucher_station_settings import (
            STATION_TITLE_MAX,
            STATION_TITLE_TOO_LONG,
            normalize_station_title,
            station_title_too_long_message,
        )

        v = normalize_station_title(v)
        if len(v) > STATION_TITLE_MAX:
            raise PydanticCustomError(
                STATION_TITLE_TOO_LONG,
                station_title_too_long_message(len(v)),
                {"value": len(v), "limit": STATION_TITLE_MAX},
            )
        return v or None

    #: The most instalments the till's instalments picker (the `card` option) offers,
    #: 2–36. Unset = the card terminal decides; `null` in a PATCH resets the layer to
    #: inherit (TIP_RESETTABLE_KEYS in app/routers/settings.py).
    pay_installments_max: Optional[int] = Field(
        None, alias="payInstallmentsMax", ge=INSTALLMENTS_MIN, le=INSTALLMENTS_MAX
    )
    #: "סדר אמצעי התשלום": the payment methods' ids in the order the till lists them
    #: (DEFAULT_PAY_ORDER in app/services/payment_options.py) — known ids only, no repeats;
    #: any left out follow in the default order. Unset = the default order; `null` in a
    #: PATCH resets the layer to inherit (TIP_RESETTABLE_KEYS in app/routers/settings.py).
    pay_order: Optional[List[str]] = Field(None, alias="payOrder")

    @field_validator("pay_order")
    @classmethod
    def _check_pay_order(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        from app.services.payment_options import validate_pay_order

        return validate_pay_order(v)

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
    #: "חזרה אוטומטית לקיוסק" (app/services/desktop_idle_return.py): R2M POS for Windows back in
    #: full screen after this many idle minutes on the desktop; 0 = never; unset = 10; `null` in
    #: a PATCH resets the layer to inherit (TIP_RESETTABLE_KEYS in app/routers/settings.py).
    desktop_idle_return_minutes: Optional[int] = Field(None, alias="desktopIdleReturnMinutes")

    @field_validator("desktop_idle_return_minutes", mode="before")
    @classmethod
    def _check_desktop_idle_return(cls, v: Any) -> Optional[int]:
        if v is None:
            return None
        from app.services.desktop_idle_return import clean_minutes

        return clean_minutes(v)

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
    # ── "סוג אינטגרציית אשראי" (app/services/payment_integration.py) ──
    #: auto | agamento | nayax_lan | nayax_usb | zcredit | synqpay (tap_to_pay is reserved and
    #: refused). "auto" or `null` in a PATCH = inherit again; `agamento` on a till without a
    #: terminal of its own is a 422 (`agamento_needs_builtin_terminal`); `nayax_usb` beside a
    #: SynqPay payment device on USB is a 422 (`usb_terminal_second`, one USB terminal per till).
    payment_integration: Optional[str] = Field(None, alias="paymentIntegration")
    #: `nayax_usb`: the C4's USB ids, "VVVV:PPPP" (hex, stored upper-case); "" or `null` = this
    #: layer names none (the till takes the first CDC-ACM device, or the value inherited).
    nayax_usb_device: Optional[str] = Field(None, alias="nayaxUsbDevice")
    #: Z-Credit's terminal number (digits, leading zeros kept), its PinPad id (with or
    #: without the "PINPAD" prefix; stored without) and "test" | "production".
    zcredit_terminal_number: Optional[str] = Field(None, alias="zcreditTerminalNumber")
    zcredit_pinpad_id: Optional[str] = Field(None, alias="zcreditPinpadId")
    zcredit_mode: Optional[str] = Field(None, alias="zcreditMode")
    #: Write-only secrets: never dumped into the layer's settings JSON (`exclude`), stored
    #: encrypted apart (app/services/payment_secrets.py). "" or `null` removes this
    #: layer's; the dashboard's "••••" sent back unchanged keeps it.
    zcredit_password: Optional[str] = Field(None, alias="zcreditPassword", exclude=True, repr=False)
    zcredit_key: Optional[str] = Field(None, alias="zcreditKey", exclude=True, repr=False)
    #: SynqPay (docs/SPEC_SYNQPAY.md): the terminal's model, how it is connected
    #: (lan | usb — an external terminal) and where; the API key is write-only like the password.
    synqpay_device_model: Optional[str] = Field(None, alias="synqpayDeviceModel")
    synqpay_connection: Optional[str] = Field(None, alias="synqpayConnection")
    synqpay_host: Optional[str] = Field(None, alias="synqpayHost")
    synqpay_protocol: Optional[str] = Field(None, alias="synqpayProtocol")
    synqpay_port: Optional[str] = Field(None, alias="synqpayPort")
    synqpay_tls: Optional[bool] = Field(None, alias="synqpayTls")
    synqpay_usb_device: Optional[str] = Field(None, alias="synqpayUsbDevice")
    synqpay_serial_number: Optional[str] = Field(None, alias="synqpaySerialNumber")
    synqpay_api_key: Optional[str] = Field(None, alias="synqpayApiKey", exclude=True, repr=False)
    #: "מכשירי תשלום" (app/services/payment_devices.py): a till without built-in clearing
    #: works with several payment devices of its shop. Set on a shop for all its tills, on a
    #: till to override it; `null` in a PATCH = inherit again.
    multi_payment_devices: Optional[bool] = Field(None, alias="multiPaymentDevices")
    #: How a till picks its device: "fixed" ("מכשיר קבוע", `fixedPaymentDeviceId`) or "group"
    #: ("קבוצת מכשירים לבחירה", `paymentDeviceGroup`). Shop (the default for its tills), area
    #: and till only (422 on a tenant / company, and on a kiosk); `null` = inherit again; unset
    #: everywhere = a group of all the shop's devices.
    payment_device_mode: Optional[Literal["fixed", "group"]] = Field(None, alias="paymentDeviceMode")
    #: The fixed device (a device id of that shop). "" or `null` = inherit again.
    fixed_payment_device_id: Optional[str] = Field(None, alias="fixedPaymentDeviceId")
    #: The devices a till chooses from (device ids of that shop); `[]` = every device of the
    #: shop; `null` = inherit again.
    payment_device_group: Optional[List[str]] = Field(None, alias="paymentDeviceGroup")

    @field_validator("fixed_payment_device_id")
    @classmethod
    def _check_fixed_payment_device(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v.strip() == "":
            return None
        import uuid

        try:
            return str(uuid.UUID(v.strip()))
        except ValueError:
            raise ValueError("fixedPaymentDeviceId must be a payment device id") from None

    @field_validator("payment_device_group")
    @classmethod
    def _check_payment_device_group(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        import uuid

        out: List[str] = []
        for item in v:
            try:
                ident = str(uuid.UUID(str(item).strip()))
            except ValueError:
                raise ValueError("paymentDeviceGroup must be a list of payment device ids") from None
            if ident not in out:
                out.append(ident)
        if len(out) > 200:
            raise ValueError("paymentDeviceGroup: at most 200 devices")
        return out

    @field_validator("payment_integration")
    @classmethod
    def _check_payment_integration(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_integration

        return validate_integration(v)

    @field_validator("nayax_usb_device")
    @classmethod
    def _check_nayax_usb_device(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_nayax_usb_device

        return validate_nayax_usb_device(v)

    @field_validator("zcredit_terminal_number")
    @classmethod
    def _check_zcredit_terminal(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_terminal_number

        return validate_terminal_number(v)

    @field_validator("zcredit_pinpad_id")
    @classmethod
    def _check_zcredit_pinpad(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import clean_pinpad_id

        return clean_pinpad_id(v)

    @field_validator("zcredit_mode")
    @classmethod
    def _check_zcredit_mode(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_mode

        return validate_mode(v)

    @field_validator("synqpay_device_model")
    @classmethod
    def _check_synqpay_model(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_model

        return validate_synqpay_model(v)

    @field_validator("synqpay_connection")
    @classmethod
    def _check_synqpay_connection(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_connection

        return validate_synqpay_connection(v)

    @field_validator("synqpay_host")
    @classmethod
    def _check_synqpay_host(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_host

        return validate_synqpay_host(v)

    @field_validator("synqpay_protocol")
    @classmethod
    def _check_synqpay_protocol(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_protocol

        return validate_synqpay_protocol(v)

    @field_validator("synqpay_port", mode="before")
    @classmethod
    def _check_synqpay_port(cls, v: Any) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_port

        return validate_synqpay_port(v)

    @field_validator("synqpay_usb_device")
    @classmethod
    def _check_synqpay_usb_device(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_usb_device

        return validate_synqpay_usb_device(v)

    @field_validator("synqpay_serial_number")
    @classmethod
    def _check_synqpay_serial(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_synqpay_serial

        return validate_synqpay_serial(v)

    # The secrets are checked in the router (payment_secrets.secret_patch), not here: a
    # validation error would echo the value back in its `input`, and into the error log.

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
    #: "סוג עוסק" of the company (docs/SPEC_BUSINESS_TYPE.md): "company" | "licensed" |
    #: "exempt". `vatNumber` above is then the ח.פ., the עוסק מורשה or the עוסק פטור number.
    dealer_type: str = Field("company", alias="dealerType")
    #: The business's phone under the receipt header (`businessInfo.phone` on the company's settings
    #: layer — "טלפון לחשבונית"); null prints none. The till has printed it since it had a field
    #: for it; the cloud never sent one before.
    phone: Optional[str] = None

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
    #: "מצב הדרכה" (docs/SPEC_TRAINING_MODE.md): the shop's flag, on every response,
    #: "unchanged" included (also `settings.trainingMode` on a full / delta pull).
    training_mode: bool = Field(False, alias="trainingMode")
    #: "סניף לא פעיל" (P:/specs/shop-code-and-inactive.md §3): false — the shop was turned off
    #: by the super admin and the device locks. On every response, "unchanged" included (also
    #: `settings.shopActive` on a full / delta pull); true for a device in no shop.
    shop_active: bool = Field(True, alias="shopActive")
    #: Where each terminal-config key (`clearingServer`, `expectedTerminalNumber`,
    #: `forceTerminalNumber`) comes from — "machine", "area", "shop", "company", "tenant" —
    #: on a full / delta pull. A kiosk or a till on an external pinpad writes its terminal only
    #: over a "machine" value (app/services/terminal_config_guard.py). Absent on "unchanged".
    terminal_config_sources: Optional[Dict[str, str]] = Field(None, alias="terminalConfigSources")

    class Config:
        populate_by_name = True
