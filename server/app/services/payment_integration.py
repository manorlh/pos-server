"""
"סוג אינטגרציית אשראי": which card integration a till charges on.

`paymentIntegration` is a managed setting on the usual layers (tenant → company → shop →
area → till, the till's own winning), so a shop chosen once at creation reaches all its
tills and one till (a tablet) can be set apart. The values:

* `auto` — today's behaviour, and what an unset key means: a till with a terminal of its
  own charges on Agamento, unless `nayaxEnabled` sends it to a Nayax pinpad; a till
  without one (a P18) charges on a Nayax pinpad.
* `agamento` — "מובנה — Agamento במכשיר". Only for a till that has a terminal; refused
  on a till that has none (422 `agamento_needs_builtin_terminal`).
* `nayax_lan` — "Nayax — מסופון ברשת" (the `nayax*` address keys).
* `nayax_usb` — "Nayax — מסופון בחיבור USB": a Nayax C4 on the till's own USB cable (its own
  CDC-ACM port, the same TweezerComm frames as on the network, framed for the line). No address
  and nothing required; the optional `nayaxUsbDevice` ("VVVV:PPPP") names the C4 when the till
  has several such devices (blank = the first CDC-ACM device). An external terminal, and one per
  till: never one of the shop's payment devices ("מכשירי תשלום" stay LAN / Z-Credit / SynqPay),
  and never beside a SynqPay device on USB the till could also charge on
  (app/services/payment_devices.py `usb_terminal_conflict`).
* `zcredit` — "Z-Credit — מסופון חיצוני" (`zcreditTerminalNumber`, `zcreditPinpadId`,
  `zcreditMode`, and the write-only `zcreditPassword`, app/services/payment_secrets.py).
* `synqpay` — "SynqPay — מסוף חיצוני" (docs/SPEC_SYNQPAY.md): the `synqpay*` keys (device
  model, connection USB/LAN and its parameters) and the write-only `synqpayApiKey` — which
  the till normally gets itself, by pairing with the terminal (§2.2), so it is not required.
* `tap_to_pay` — "Tap to Pay במכשיר (iPOSpays)" (P:/specs/tap-to-pay.md): the card is tapped on
  the till's own NFC through iPOSpays' In-App SDK (Israel, Z-Credit behind it). `tapToPayTpn`,
  `tapToPayEnvironment` (sandbox | production) and the write-only `tapToPayMerchantCode`
  (app/services/payment_secrets.py). Not on a device known to have no NFC, and not on a kiosk
  (stage 1): both a 422 on the till's own layer (`check_machine_choice`); a till that inherits it
  anyway says so itself and takes no card. Off unless a layer picks it.
* `none` — "ללא אשראי (מזומן ואמצעים אחרים)" (P:/specs/payment-integration-none.md): the till
  takes no card at all — cash and the other methods only. Any till may be set so, one with a
  terminal of its own too. Nothing is required, and nothing about a terminal is asked or
  warned of: no missing fields, no pinpad address, no terminal number, no card lock, no
  kiosk terminal alerts. Its sync carries the three card switches off whatever the layers say
  (`CARD_OFF`), so an older till that reads `none` as `auto` still shows no card; the stored
  switches are untouched, and back on `auto` they apply again. A write that would move a till
  with open card sales (not in a Z, not transmitted, not decided) to it is refused — 409
  `payment_integration_open_card`, no force (§6, `check_no_card_switch`).

`auto` is never stored: written, it removes the layer's own value (inherit again), so a
shop left on "אוטומטי" never hides its company's choice. Resolving walks the layers from
the till up and takes the first explicit choice the till can use: a till without a
terminal of its own skips an inherited `agamento` (it has none) and lands on the external
type set above it, or on the automatic one.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services.payment_options import PAYMENT_OPTIONS
from app.services.payment_secrets import SYNQPAY_API_KEY, TAP_TO_PAY_MERCHANT_CODE, ZCREDIT_KEY, ZCREDIT_PASSWORD
from app.services.payment_terminal import PinpadAddressError, clean_pinpad_host, merged_pinpad_host

KEY = "paymentIntegration"

AUTO = "auto"
AGAMENTO = "agamento"
NAYAX_LAN = "nayax_lan"
NAYAX_USB = "nayax_usb"
ZCREDIT = "zcredit"
SYNQPAY = "synqpay"
TAP_TO_PAY = "tap_to_pay"
NONE = "none"

INTEGRATIONS: Tuple[str, ...] = (AUTO, AGAMENTO, NAYAX_LAN, NAYAX_USB, ZCREDIT, SYNQPAY, TAP_TO_PAY, NONE)
#: Shown as "בקרוב" and refused on write (none today: Tap to Pay was, until 16.10.2026).
RESERVED: Tuple[str, ...] = ()
#: Integrations that charge on a terminal outside the till: the only ones a till without
#: a terminal of its own can use.
EXTERNAL: Tuple[str, ...] = (NAYAX_LAN, NAYAX_USB, ZCREDIT, SYNQPAY, TAP_TO_PAY)

LABELS_HE: Dict[str, str] = {
    AUTO: "אוטומטי",
    AGAMENTO: "מובנה — Agamento במכשיר",
    NAYAX_LAN: "Nayax — מסופון ברשת",
    NAYAX_USB: "Nayax — מסופון בחיבור USB",
    ZCREDIT: "Z-Credit — מסופון חיצוני",
    SYNQPAY: "SynqPay — מסוף חיצוני",
    TAP_TO_PAY: "Tap to Pay במכשיר (iPOSpays)",
    NONE: "ללא אשראי (מזומן ואמצעים אחרים)",
}
#: "מובנה" on a SynqPay terminal: the till charges on SynqPay on the device (SPEC_SYNQPAY.md §1.5).
BUILTIN_SYNQPAY_LABEL_HE = "מובנה — SynqPay במכשיר"

# ── Z-Credit's settings (non-secret; managed keys like any other) ──────────────
ZCREDIT_TERMINAL_NUMBER = "zcreditTerminalNumber"
ZCREDIT_PINPAD_ID = "zcreditPinpadId"
ZCREDIT_MODE = "zcreditMode"
ZCREDIT_MODES: Tuple[str, ...] = ("test", "production")

# ── SynqPay's settings (docs/SPEC_SYNQPAY.md) ─────────────────────────────────
SYNQPAY_DEVICE_MODEL = "synqpayDeviceModel"
SYNQPAY_CONNECTION = "synqpayConnection"
SYNQPAY_HOST = "synqpayHost"
SYNQPAY_PROTOCOL = "synqpayProtocol"
SYNQPAY_PORT = "synqpayPort"
SYNQPAY_TLS = "synqpayTls"
SYNQPAY_USB_DEVICE = "synqpayUsbDevice"
SYNQPAY_SERIAL_NUMBER = "synqpaySerialNumber"

#: The terminal models SynqPay's docs name (getDeviceInfo's example, the changelog), and "other".
SYNQPAY_MODELS: Tuple[str, ...] = ("dx8000", "dx6000", "ex8000", "rx5000", "s1p2", "s1u2_m4", "verifone", "other")
SYNQPAY_MODEL_LABELS_HE: Dict[str, str] = {
    "dx8000": "Ingenico DX8000",
    "dx6000": "DX6000",
    "ex8000": "EX8000",
    "rx5000": "RX5000",
    "s1p2": "Castles S1P2",
    "s1u2_m4": "Castles S1U2-M4 (לא מאויש)",
    "verifone": "Verifone",
    "other": "אחר",
}
#: How a till reaches an EXTERNAL SynqPay terminal (the owner: "LAN/USB זה כשמדובר בקופה עם
#: מסופון חיצוני"): `lan` the shop's network (host, port, TLS — "IP over USB" is this too, at the
#: address the terminal takes on the cable); `usb` SynqPay's serial link on a USB cable, the device
#: found by itself. The built-in terminal is no setting: a till running ON a SynqPay terminal
#: charges on it by itself, as an F20 on Agamento (SPEC_SYNQPAY.md §1.5, app/models/synqpay_devices.py).
SYNQPAY_CONNECTIONS: Tuple[str, ...] = ("lan", "usb")
#: Earlier spellings read as today's.
_SYNQPAY_CONNECTION_ALIASES: Dict[str, str] = {"usb_serial": "usb", "serial": "usb"}
#: The connections that reach the terminal at an address (and so need `synqpayHost`).
SYNQPAY_ADDRESSED: Tuple[str, ...] = ("lan",)
SYNQPAY_PROTOCOLS: Tuple[str, ...] = ("tcp", "http")
#: The only model SynqPay documents a serial (UART) API link for (changelog 1.3.1).
SYNQPAY_SERIAL_DOCUMENTED: Tuple[str, ...] = ("rx5000",)
_SYNQPAY_USB_DEVICE = re.compile(r"^(?:[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}|COM[0-9]{1,3})$")
_SYNQPAY_SERIAL = re.compile(r"^[A-Za-z0-9-]{4,32}$")

# ── Tap to Pay's settings (P:/specs/tap-to-pay.md) ────────────────────────────
#: The TPN (Terminal Profile Number) iPOSpays gives the merchant's Tap on Phone terminal.
TAP_TO_PAY_TPN = "tapToPayTpn"
#: Which iPOSpays environment the TPN lives in. The SDK build decides where the till really
#: goes (a test AAR talks to the sandbox only); the till refuses to charge when the two differ.
TAP_TO_PAY_ENVIRONMENT = "tapToPayEnvironment"
TAP_TO_PAY_ENVIRONMENTS: Tuple[str, ...] = ("sandbox", "production")
TAP_TO_PAY_ENVIRONMENT_LABELS_HE: Dict[str, str] = {"sandbox": "סביבת בדיקות (Sandbox)", "production": "ייצור"}
#: A TPN as the portal shows it: letters and digits (12 in the docs' examples).
_TAP_TO_PAY_TPN = re.compile(r"^[A-Za-z0-9]{4,20}$")

# ── A Nayax C4 on the till's USB (`nayax_usb`) ────────────────────────────────
#: The C4's USB ids, "VVVV:PPPP" (hex vendor:product, upper case), when the till must pick it
#: among several devices; unset / blank = the first CDC-ACM device attached.
NAYAX_USB_DEVICE = "nayaxUsbDevice"
_NAYAX_USB_DEVICE = re.compile(r"^[0-9A-F]{4}:[0-9A-F]{4}$")

#: The settings keys this module owns, all managed (sent to the till) and all reset to
#: inherited by an explicit `null` in a PATCH.
SETTING_KEYS: Tuple[str, ...] = (
    KEY,
    NAYAX_USB_DEVICE,
    ZCREDIT_TERMINAL_NUMBER,
    ZCREDIT_PINPAD_ID,
    ZCREDIT_MODE,
    SYNQPAY_DEVICE_MODEL,
    SYNQPAY_CONNECTION,
    SYNQPAY_HOST,
    SYNQPAY_PROTOCOL,
    SYNQPAY_PORT,
    SYNQPAY_TLS,
    SYNQPAY_USB_DEVICE,
    SYNQPAY_SERIAL_NUMBER,
    TAP_TO_PAY_TPN,
    TAP_TO_PAY_ENVIRONMENT,
)
#: The Nayax address keys, resettable with `null` too, so clearing a field in the
#: device dialog brings the shop's value back instead of keeping the old one.
NAYAX_KEYS: Tuple[str, ...] = ("nayaxEnabled", "nayaxDeviceHost", "nayaxDevicePort", "nayaxSpicyPath")
RESETTABLE_KEYS: Tuple[str, ...] = SETTING_KEYS + NAYAX_KEYS

#: The secrets the till gets (the WebCheckout key is not used by a till: it is stored
#: for the merchant's other channels and never leaves the server), each only to a till
#: that charges on its integration.
TILL_SECRET_KEYS: Tuple[str, ...] = (ZCREDIT_PASSWORD, SYNQPAY_API_KEY, TAP_TO_PAY_MERCHANT_CODE)
TILL_SECRET_INTEGRATION: Dict[str, str] = {
    ZCREDIT_PASSWORD: ZCREDIT,
    SYNQPAY_API_KEY: SYNQPAY,
    TAP_TO_PAY_MERCHANT_CODE: TAP_TO_PAY,
}

#: Z-Credit terminal numbers are digits, leading zeros kept ("0882…").
_TERMINAL_NUMBER = re.compile(r"^[0-9]{1,20}$")
#: A PinPad id as Z-Credit issues it, without the "PINPAD" prefix the API wants in Track2.
_PINPAD_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")

#: The fields each integration needs before its first card, in the order the form shows
#: them. Missing ones are listed on the machines page and on the till ("חסר: מספר מסוף").
REQUIRED_FIELDS: Dict[str, Tuple[str, ...]] = {
    AGAMENTO: (),
    NAYAX_LAN: ("nayaxDeviceHost",),
    # No address: the C4 is on the cable; `nayaxUsbDevice` is optional.
    NAYAX_USB: (),
    ZCREDIT: (ZCREDIT_TERMINAL_NUMBER, ZCREDIT_PASSWORD, ZCREDIT_PINPAD_ID, ZCREDIT_MODE),
    # The host only on the network (lan): see missing_fields. No API key: the till pairs with
    # the terminal itself and sends the key up (SPEC_SYNQPAY.md §2.2) — a till with none yet is
    # "not paired", shown beside the form, not a field missing from it.
    SYNQPAY: (SYNQPAY_DEVICE_MODEL, SYNQPAY_CONNECTION, SYNQPAY_HOST),
    TAP_TO_PAY: (TAP_TO_PAY_TPN, TAP_TO_PAY_MERCHANT_CODE, TAP_TO_PAY_ENVIRONMENT),
    # No terminal: nothing to ask for, so nothing is ever "חסר".
    NONE: (),
}

#: "ללא אשראי": the payment options' card switches (app/services/payment_options.py:
#: `payFastCardEnabled`, `payCardEnabled`, `payManualCardEnabled`) as the till's sync sends
#: them for `none`, over whatever the layers store.
CARD_OFF: Dict[str, bool] = {o.allowed_key: False for o in PAYMENT_OPTIONS if o.tender == "card"}

#: "לקיוסק לא יישאר אמצעי תשלום": a kiosk on `none` takes payment only at the till ("תשלום
#: בקופה", `cash_at_till` in its `payment.methods`). Without it the save says so — a warning
#: beside the saved answer, never a refusal (`kiosk_warnings`).
KIOSK_PAY_AT_TILL = "cash_at_till"
#: "מזומן" at the shop's cash station (P:/specs/cash-paylink.md §11.6) takes payment with no card too.
KIOSK_CASH_DEVICE = "cash_device"
#: The kiosk methods that take payment with no card at all.
KIOSK_NON_CARD_METHODS = (KIOSK_PAY_AT_TILL, KIOSK_CASH_DEVICE)
KIOSK_NO_PAYMENT_CODE = "kiosk_no_payment_method"
KIOSK_NO_PAYMENT_HE = "לקיוסק לא יישאר אמצעי תשלום"

FIELD_LABELS_HE: Dict[str, str] = {
    "nayaxDeviceHost": "כתובת IP של המסופון",
    NAYAX_USB_DEVICE: "מזהה USB של המסופון",
    ZCREDIT_TERMINAL_NUMBER: "מספר מסוף",
    ZCREDIT_PASSWORD: "סיסמת מסוף",
    ZCREDIT_PINPAD_ID: "מזהה PinPad",
    ZCREDIT_MODE: "מצב בדיקה / ייצור",
    ZCREDIT_KEY: "מפתח (Key)",
    SYNQPAY_DEVICE_MODEL: "דגם המסוף",
    SYNQPAY_CONNECTION: "סוג החיבור",
    SYNQPAY_HOST: "כתובת IP של המסוף",
    SYNQPAY_PROTOCOL: "פרוטוקול",
    SYNQPAY_PORT: "פורט",
    SYNQPAY_TLS: "חיבור מוצפן (TLS)",
    SYNQPAY_USB_DEVICE: "התקן USB",
    SYNQPAY_SERIAL_NUMBER: "מספר סידורי של המסוף",
    SYNQPAY_API_KEY: "מפתח API",
    TAP_TO_PAY_TPN: "TPN",
    TAP_TO_PAY_MERCHANT_CODE: "קוד סוחר (Merchant Code)",
    TAP_TO_PAY_ENVIRONMENT: "סביבה (בדיקות / ייצור)",
}

#: The 422 a till without a terminal of its own gets for `agamento` on its own layer.
NEEDS_BUILTIN_DETAIL = {
    "code": "agamento_needs_builtin_terminal",
    "msg": "לקופה הזו אין מסוף מובנה (למשל טאבלט P18): ניתן לבחור רק אינטגרציה חיצונית — "
    "Nayax מסופון ברשת, Nayax מסופון בחיבור USB, Z-Credit מסופון חיצוני או SynqPay מסוף חיצוני — "
    "או ללא אשראי.",
}

#: The 422s of `tap_to_pay` on a till's own layer where it cannot work (P:/specs/tap-to-pay.md).
TAP_TO_PAY_NEEDS_NFC_DETAIL = {
    "code": "tap_to_pay_needs_nfc",
    "msg": "למכשיר הזה אין NFC — Tap to Pay דורש מכשיר עם NFC.",
}
TAP_TO_PAY_NOT_ON_KIOSK_DETAIL = {
    "code": "tap_to_pay_not_on_kiosk",
    "msg": "Tap to Pay עדיין לא נתמך בקיוסק — רק בקופה.",
}

#: One USB terminal per till (the owner, 08.10.2026): a till on `nayax_usb` may not also charge
#: on a SynqPay payment device connected by USB (app/services/payment_devices.py). The same words
#: as the till's own rule (UsbTerminalRule.kt), which refuses such a device at the counter too.
ONE_USB_TERMINAL_HE = "בקופה מוגדר מסופון בחיבור USB — מסוף USB נוסף אינו נתמך (מסוף USB אחד לקופה)"


# ── Values ───────────────────────────────────────────────────────────────────


def clean_integration(value: Any) -> Optional[str]:
    """A stored or sent value as one of INTEGRATIONS, or None for nothing / unknown."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower().replace("-", "_")
    return text if text in INTEGRATIONS else None


def validate_integration(value: Optional[str]) -> Optional[str]:
    """For the PATCH schema: a known, selectable value (none is RESERVED today)."""
    if value is None:
        return None
    cleaned = clean_integration(value)
    if cleaned is None:
        raise ValueError(f"paymentIntegration must be one of {', '.join(INTEGRATIONS)}")
    if cleaned in RESERVED:
        raise ValueError(f"payment_integration_reserved: {cleaned} is not available yet")
    return cleaned


def validate_tap_to_pay_tpn(value: Optional[str]) -> Optional[str]:
    """A TPN as the portal shows it (letters and digits, kept as typed); None for blank."""
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if not _TAP_TO_PAY_TPN.match(text):
        raise ValueError("tapToPayTpn must be 4–20 letters or digits")
    return text


def validate_tap_to_pay_environment(value: Optional[str]) -> Optional[str]:
    """`sandbox` or `production` (`test` reads as `sandbox`); None for blank."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if text == "":
        return None
    if text in ("test", "uat"):
        text = "sandbox"
    if text not in TAP_TO_PAY_ENVIRONMENTS:
        raise ValueError("tapToPayEnvironment must be 'sandbox' or 'production'")
    return text


def validate_terminal_number(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if not _TERMINAL_NUMBER.match(text):
        raise ValueError("zcreditTerminalNumber must be digits only (leading zeros kept)")
    return text


def clean_pinpad_id(value: Any) -> Optional[str]:
    """
    The PinPad id without its "PINPAD" prefix (a technician may type either form), or
    None when blank. ValueError for anything that is not one.
    """
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if text.upper().startswith("PINPAD"):
        text = text[len("PINPAD"):]
    if not _PINPAD_ID.match(text):
        raise ValueError("zcreditPinpadId must be letters and digits (with or without the PINPAD prefix)")
    return text


def validate_mode(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text == "":
        return None
    if text not in ZCREDIT_MODES:
        raise ValueError("zcreditMode must be 'test' or 'production'")
    return text


# ── SynqPay's values (docs/SPEC_SYNQPAY.md §2) ─────────────────────────────────


def _choice(value: Optional[str], allowed: Sequence[str], name: str) -> Optional[str]:
    """A value of [allowed] (lower case, `-` read as `_`), None for blank."""
    if value is None:
        return None
    text = str(value).strip().lower().replace("-", "_")
    if text == "":
        return None
    if text not in allowed:
        raise ValueError(f"{name} must be one of {', '.join(allowed)}")
    return text


def validate_synqpay_model(value: Optional[str]) -> Optional[str]:
    return _choice(value, SYNQPAY_MODELS, SYNQPAY_DEVICE_MODEL)


def validate_synqpay_connection(value: Optional[str]) -> Optional[str]:
    """`lan` or `usb` (an external terminal); `usb_serial` reads as `usb`."""
    if isinstance(value, str):
        value = _SYNQPAY_CONNECTION_ALIASES.get(value.strip().lower().replace("-", "_"), value)
    return _choice(value, SYNQPAY_CONNECTIONS, SYNQPAY_CONNECTION)


def validate_synqpay_protocol(value: Optional[str]) -> Optional[str]:
    return _choice(value, SYNQPAY_PROTOCOLS, SYNQPAY_PROTOCOL)


def validate_synqpay_host(value: Optional[str]) -> Optional[str]:
    """An IPv4 address or a host name, as a Nayax pinpad's (no scheme, port or path)."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None
    try:
        return clean_pinpad_host(value)
    except PinpadAddressError:
        raise ValueError("synqpayHost must be an IPv4 address or a host name, without a scheme or a port") from None


def validate_synqpay_port(value: Any) -> Optional[str]:
    """1–65535, stored as text like `nayaxDevicePort`; None/blank = the protocol's default."""
    if isinstance(value, bool):
        raise ValueError("synqpayPort must be 1–65535")
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if not text.isdigit() or not 1 <= int(text) <= 65535:
        raise ValueError("synqpayPort must be 1–65535")
    return str(int(text))


def validate_synqpay_usb_device(value: Optional[str]) -> Optional[str]:
    """"VVVV:PPPP" (hex vendor:product, upper-cased) or "COMn"; None/blank = detect."""
    if value is None:
        return None
    text = str(value).strip().upper()
    if text == "":
        return None
    if not _SYNQPAY_USB_DEVICE.match(text):
        raise ValueError("synqpayUsbDevice must be VVVV:PPPP (hex) or COMn, or empty to detect")
    return text


def validate_synqpay_serial(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if not _SYNQPAY_SERIAL.match(text):
        raise ValueError("synqpaySerialNumber must be 4–32 letters, digits or '-'")
    return text


def validate_nayax_usb_device(value: Optional[str]) -> Optional[str]:
    """"VVVV:PPPP" (hex vendor:product, upper-cased); None/blank = the first CDC-ACM device."""
    if value is None:
        return None
    text = str(value).strip().upper()
    if text == "":
        return None
    if not _NAYAX_USB_DEVICE.match(text):
        raise ValueError("nayaxUsbDevice must be VVVV:PPPP (hex vendor:product), or empty for the first USB device")
    return text


def synqpay_default_port(protocol: Optional[str], tls: Optional[bool]) -> int:
    """The documented ports: TCP 9000 / TLS 9443, HTTP 8000 / HTTPS 8443."""
    if (protocol or "tcp") == "http":
        return 8443 if tls else 8000
    return 9443 if tls else 9000


# ── PATCH helpers (app/routers/settings.py) ─────────────────────────────────


def resettable_patch(data: Any) -> Dict[str, Any]:
    """The keys of RESETTABLE_KEYS the caller sent, keeping an explicit `null` (reset)."""
    raw = data.model_dump(exclude_unset=True, by_alias=True)
    return {key: raw[key] for key in RESETTABLE_KEYS if key in raw}


def normalize_patch(patch: Dict[str, Any]) -> Dict[str, Any]:
    """`auto` is not stored: it removes the layer's own choice (inherit again)."""
    if clean_integration(patch.get(KEY)) == AUTO:
        patch = {**patch, KEY: None}
    return patch


def check_machine_choice(machine: Any, patch: Dict[str, Any]) -> None:
    """
    Refuse, on a till's own layer, `agamento` on a till without a terminal of its own
    (NEEDS_BUILTIN_DETAIL), and `tap_to_pay` on a device known to have no NFC or on a kiosk
    (TAP_TO_PAY_NEEDS_NFC_DETAIL / TAP_TO_PAY_NOT_ON_KIOSK_DETAIL). Raises `HTTPException(422)`.
    """
    chosen = clean_integration(patch.get(KEY))
    detail: Optional[Dict[str, str]] = None
    if chosen == AGAMENTO and not getattr(machine, "has_builtin_terminal", True):
        detail = NEEDS_BUILTIN_DETAIL
    elif chosen == TAP_TO_PAY:
        if getattr(machine, "is_kiosk", False) is True:
            detail = TAP_TO_PAY_NOT_ON_KIOSK_DETAIL
        elif device_has_nfc(machine) is False:
            detail = TAP_TO_PAY_NEEDS_NFC_DETAIL
    if detail is None:
        return
    from fastapi import HTTPException, status

    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=dict(detail))


def tap_to_pay_reason(machine: Any) -> Optional[str]:
    """
    Why a till cannot charge on Tap to Pay, or None when it may (or is not known not to):
    `not_on_kiosk` (stage 1 is the till only) or `needs_nfc` (it reported no NFC).
    """
    if machine is None:
        return None
    if getattr(machine, "is_kiosk", False) is True:
        return "not_on_kiosk"
    if device_has_nfc(machine) is False:
        return "needs_nfc"
    return None


# ── Resolution ───────────────────────────────────────────────────────────────


@dataclass
class Resolution:
    """What a till charges on, and why."""

    #: One of AGAMENTO, NAYAX_LAN, NAYAX_USB, ZCREDIT, SYNQPAY, NONE; never AUTO.
    integration: str
    #: The level the explicit choice comes from ("tenant" … "machine"); None = automatic.
    source: Optional[str] = None
    #: True when no layer chose and the till's hardware and `nayaxEnabled` decided.
    automatic: bool = True
    #: Fields the integration needs that no layer gives (REQUIRED_FIELDS), in form order.
    missing: List[str] = field(default_factory=list)

    @property
    def explicit(self) -> Optional[str]:
        """The value the till is sent as `paymentIntegration`; None leaves it automatic."""
        return None if self.automatic else self.integration


def no_card(res: Any) -> bool:
    """
    [res] (a Resolution, or None for unknown) is "ללא אשראי": the till takes no card, and has
    no terminal to watch or warn about.
    """
    return getattr(res, "integration", None) == NONE


def _as_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def resolve(
    layers: Sequence[Tuple[str, Any]],
    has_builtin_terminal: bool,
    *,
    secrets_set: Sequence[str] = (),
    synqpay_device: bool = False,
) -> Resolution:
    """
    The integration for a till under [layers] — `(level, settings dict)` least specific
    first, as the settings merge — with the fields it is still missing. [secrets_set]
    lists the secret keys some layer of this till holds (app/services/payment_secrets.py).
    [synqpay_device]: the till runs ON a SynqPay terminal (`is_synqpay_device`) — `synqpay` is
    then its own terminal, the built-in one ("מובנה", SPEC_SYNQPAY.md §1.5), not an external one.
    """
    chosen: Optional[Resolution] = None
    for level, settings in reversed(list(layers)):
        value = clean_integration(_as_dict(settings).get(KEY))
        if value in (None, AUTO) or value in RESERVED:
            continue
        if value == AGAMENTO and not has_builtin_terminal:
            # A tablet under a shop of 55Fs: the shop's "built-in" is not this till's.
            continue
        if value == SYNQPAY and synqpay_device:
            value = AGAMENTO
        chosen = Resolution(value, level, automatic=False)
        break
    merged: Dict[str, Any] = {}
    for _, settings in layers:
        merged.update(_as_dict(settings))
    if chosen is None:
        nayax = merged.get("nayaxEnabled") is True
        chosen = Resolution(NAYAX_LAN if (not has_builtin_terminal or nayax) else AGAMENTO)
    chosen.missing = missing_fields(chosen.integration, merged, secrets_set)
    return chosen


def missing_fields(integration: str, merged: Dict[str, Any], secrets_set: Sequence[str] = ()) -> List[str]:
    """The REQUIRED_FIELDS of [integration] that the merged settings and secrets lack."""
    out: List[str] = []
    for key in REQUIRED_FIELDS.get(integration, ()):
        if key == "nayaxDeviceHost":
            if merged_pinpad_host(merged) is None:
                out.append(key)
        elif key in (ZCREDIT_PASSWORD, SYNQPAY_API_KEY, TAP_TO_PAY_MERCHANT_CODE):
            if key not in secrets_set:
                out.append(key)
        elif key == SYNQPAY_HOST:
            # Only the network needs an address; USB finds its device itself.
            connection = merged.get(SYNQPAY_CONNECTION)
            if connection in SYNQPAY_ADDRESSED and not (isinstance(merged.get(key), str) and merged[key].strip()):
                out.append(key)
        else:
            value = merged.get(key)
            if not (isinstance(value, str) and value.strip()):
                out.append(key)
    return out


# ── The till's sync and the machines list ────────────────────────────────────


def secret_layers(tenant: Any, company: Any, shop: Any, area: Any, machine: Any) -> List[Tuple[str, Any]]:
    """`(level, entity id)` of a till's layers, least specific first, those that exist."""
    out: List[Tuple[str, Any]] = []
    for level, entity in (("tenant", tenant), ("company", company), ("shop", shop), ("area", area), ("machine", machine)):
        if entity is not None and getattr(entity, "id", None) is not None:
            out.append((level, entity.id))
    return out


def settings_layers(tenant: Any, company: Any, shop: Any, area: Any, machine: Any) -> List[Tuple[str, Any]]:
    """`(level, settings dict)` of a till's layers, least specific first."""
    out: List[Tuple[str, Any]] = []
    for level, entity in (("tenant", tenant), ("company", company), ("shop", shop), ("area", area), ("machine", machine)):
        if entity is not None:
            out.append((level, getattr(entity, "settings", None)))
    return out


def resolve_machine(db: Any, machine: Any) -> Resolution:
    """
    What [machine] charges on over its stored layers — for a check that needs only the type
    ("ללא אשראי" or not): `missing` is worked out without the secrets.
    """
    from app.routers.settings import _machine_parents

    area, shop, company, tenant = _machine_parents(db, machine)
    return resolve(
        settings_layers(tenant, company, shop, area, machine),
        bool(getattr(machine, "has_builtin_terminal", True)),
        synqpay_device=is_synqpay_device(machine),
    )


def till_sync_fields(db: Any, machine: Any, tenant: Any, company: Any, shop: Any, area: Any) -> Dict[str, Any]:
    """
    What the till's settings sync says about its card integration, over the merged
    managed keys: `paymentIntegration` as the explicit choice down the layers (absent
    when automatic, so the till keeps deciding by its hardware as before), and, for a
    till on Z-Credit, `zcreditPassword` in the clear — its only way out of the server (so
    too SynqPay's key and Tap to Pay's merchant code, each to a till on its integration).
    Keys mapped to None are to be removed from the sync's settings. `nayax_usb` has no
    secret: the till gets the value and, when some layer names the C4, `nayaxUsbDevice`
    (a managed key, merged like the rest).
    """
    from app.services import payment_secrets

    layers = settings_layers(tenant, company, shop, area, machine)
    ids = secret_layers(tenant, company, shop, area, machine)
    rows = payment_secrets.secrets_for_layers(db, ids)
    merged_secrets = payment_secrets.merged_secret_sources(ids, rows)
    has_builtin = bool(getattr(machine, "has_builtin_terminal", True))
    res = resolve(layers, has_builtin, secrets_set=list(merged_secrets), synqpay_device=is_synqpay_device(machine))
    out: Dict[str, Any] = {KEY: res.explicit}
    for key in TILL_SECRET_KEYS:
        hit = merged_secrets.get(key) if res.integration == TILL_SECRET_INTEGRATION[key] else None
        out[key] = payment_secrets.decrypt(hit[1].ciphertext) if hit else None
    return out


def without_card(merged: Dict[str, Any]) -> Dict[str, Any]:
    """
    [merged] as a till "ללא אשראי" reads its payment options: the card switches off (CARD_OFF),
    and so no tip asked on them. A view for the sync, never written back to a layer.
    """
    return {**merged, **CARD_OFF}


def kiosk_pays_at_till(cfg: Any) -> bool:
    """
    A kiosk config that takes payment with no card: "תשלום בקופה" (`cash_at_till`) or "מזומן" at the cash
    station (`cash_device`) is on.
    """
    payment = cfg.get("payment") if isinstance(cfg, dict) else None
    methods = payment.get("methods") if isinstance(payment, dict) else None
    return isinstance(methods, list) and any(m in methods for m in KIOSK_NON_CARD_METHODS)


def kiosk_warnings(db: Any, machines: Sequence[Any]) -> List[Dict[str, Any]]:
    """
    "לקיוסק לא יישאר אמצעי תשלום": of [machines], the kiosks "ללא אשראי" whose config does not
    take payment at the till. One warning naming them (`{code, message, machineIds, names}`), or
    none. For a save's answer: shown beside it, never a refusal (the owner, 14.10.2026).
    """
    from app.models.kiosk import KioskDevice
    from app.services import kiosk_config

    ids = [m.id for m in machines if getattr(m, "id", None) is not None]
    if not ids:
        return []
    devices = {
        d.machine_id: d
        for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids), KioskDevice.home_role.is_(None)).all()
    }
    found: List[Tuple[str, str]] = []
    for machine in machines:
        device = devices.get(machine.id)
        if device is None or not no_card(resolve_machine(db, machine)):
            continue
        if kiosk_pays_at_till(kiosk_config.effective_config(db, machine)):
            continue
        found.append((str(machine.id), device.name or machine.name or ""))
    if not found:
        return []
    return [{
        "code": KIOSK_NO_PAYMENT_CODE,
        "message": KIOSK_NO_PAYMENT_HE,
        "machineIds": [mid for mid, _ in found],
        "names": [name for _, name in found],
    }]


# ── No "ללא אשראי" over open card sales (spec §6) ─────────────────────────────

#: The 409 of a save that would move a till with open card sales to `none` (the owner,
#: 14.10.2026: "אי אפשר להעביר קופה ללא אשראי שיש בה עסקאות אשראי"). No force: Z first.
OPEN_CARD_CODE = "payment_integration_open_card"
OPEN_CARD_TAIL_HE = "יש לבצע שידור ו-Z לפני המעבר ל'ללא אשראי'"


@dataclass
class OpenCard:
    """A till's card sales not yet done with: not in a Z, not transmitted, not decided."""

    machine: Any
    #: Card documents in shifts no Z has taken yet.
    card_sales: int = 0
    #: Card transactions not transmitted: the till's own transmission report, else the cloud's count.
    untransmitted: int = 0
    #: Card payments "לא הוכרע".
    unresolved: int = 0

    @property
    def any(self) -> bool:
        return bool(self.card_sales or self.untransmitted or self.unresolved)

    def as_json(self) -> Dict[str, Any]:
        number = (getattr(self.machine, "pos_number", None) or "").strip()
        return {
            "machineId": str(self.machine.id),
            "name": getattr(self.machine, "name", None),
            "posNumber": number or None,
            "cardSales": self.card_sales,
            "untransmitted": self.untransmitted,
            "unresolved": self.unresolved,
        }


def _till_label_he(machine: Any) -> str:
    number = (getattr(machine, "pos_number", None) or "").strip()
    return f"קופה {number}" if number else (getattr(machine, "name", None) or "קופה")


def open_card_line_he(open_card: OpenCard) -> str:
    """"בקופה 3 יש 12 עסקאות אשראי שלא נסגרו ב-Z (2 לא שודרו, 1 לא מוכרעת)"."""
    o = open_card
    untransmitted = (f"{o.untransmitted} לא שודרה" if o.untransmitted == 1 else f"{o.untransmitted} לא שודרו") if o.untransmitted else None
    unresolved = (f"{o.unresolved} לא מוכרעת" if o.unresolved == 1 else f"{o.unresolved} לא מוכרעות") if o.unresolved else None
    where = f"ב{_till_label_he(o.machine)} יש"
    if o.card_sales:
        sales = "עסקת אשראי אחת שלא נסגרה ב-Z" if o.card_sales == 1 else f"{o.card_sales} עסקאות אשראי שלא נסגרו ב-Z"
        extra = ", ".join(p for p in (untransmitted, unresolved) if p)
        return f"{where} {sales}" + (f" ({extra})" if extra else "")
    # Nothing left for a Z, and still a batch to transmit or a card to decide.
    parts = []
    if o.untransmitted:
        parts.append("עסקת אשראי אחת שלא שודרה" if o.untransmitted == 1 else f"{o.untransmitted} עסקאות אשראי שלא שודרו")
    if o.unresolved:
        parts.append("תשלום אשראי אחד לא מוכרע" if o.unresolved == 1 else f"{o.unresolved} תשלומי אשראי לא מוכרעים")
    return f"{where} " + ", ".join(parts)


def open_card_message_he(open_cards: Sequence[OpenCard]) -> str:
    """The lines of every till that holds the save back, then what to do."""
    return "; ".join(open_card_line_he(o) for o in open_cards) + ". " + OPEN_CARD_TAIL_HE


def open_card_counts(db: Any, machines: Sequence[Any]) -> Dict[Any, OpenCard]:
    """
    Per till of [machines] (by id), its open card sales — three queries for the whole list:

    1. card documents (completed / refunded) in a shift no Z has taken yet;
    2. card transactions not transmitted — the till's own count from its transmission report
       when it sent one, else the cloud's untransmitted card legs (app/services/transmissions.py);
    3. card payments "לא הוכרע" (`failed_payment_attempts.outcome` = unresolved).
    """
    from sqlalchemy import func

    from app.models.failed_payment import OUTCOME_UNRESOLVED, FailedPaymentAttempt
    from app.models.shift import Shift
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment
    from app.services import transmissions

    out = {m.id: OpenCard(m) for m in machines}
    ids = list(out)
    if not ids:
        return out
    for machine_id, count in (
        db.query(Transaction.machine_id, func.count(func.distinct(Transaction.id)))
        .join(TransactionPayment, TransactionPayment.transaction_id == Transaction.id)
        .join(Shift, Shift.id == Transaction.shift_id)
        .filter(
            Transaction.machine_id.in_(ids),
            TransactionPayment.method == transmissions.CARD_METHOD,
            Transaction.status.in_(transmissions.TRANSMITTABLE_STATUSES),
            Shift.z_report_id.is_(None),
        )
        .group_by(Transaction.machine_id)
        .all()
    ):
        out[machine_id].card_sales = int(count)
    legs = transmissions.untransmitted_summary(db, ids)
    for m in machines:
        pending = transmissions.machine_transmission(m, legs.get(m.id), None).pending_count
        out[m.id].untransmitted = int(pending or 0)
    for machine_id, count in (
        db.query(FailedPaymentAttempt.machine_id, func.count(FailedPaymentAttempt.id))
        .filter(FailedPaymentAttempt.machine_id.in_(ids), FailedPaymentAttempt.outcome == OUTCOME_UNRESOLVED)
        .group_by(FailedPaymentAttempt.machine_id)
        .all()
    ):
        out[machine_id].unresolved = int(count)
    return out


def turning_no_card(db: Any, machines: Sequence[Any], level: str, entity_id: Any, after: Any) -> List[Any]:
    """
    Of [machines], the tills a write of [after] as the settings of the [level] layer [entity_id]
    moves to "ללא אשראי": `none` after it, and not before (a till already on it is left alone —
    a form saved again round-trips its value). Their parents are loaded once for the list.
    """
    from app.models.company import Company
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.models.tenant import Tenant

    def by_id(model, wanted) -> Dict[Any, Any]:
        keys = {w for w in wanted if w is not None}
        return {r.id: r for r in db.query(model).filter(model.id.in_(list(keys))).all()} if keys else {}

    shops = by_id(Shop, (m.shop_id for m in machines))
    companies = by_id(Company, (s.company_id for s in shops.values()))
    tenants = by_id(Tenant, (c.tenant_id for c in companies.values()))
    areas = by_id(ShopArea, (getattr(m, "area_id", None) for m in machines))
    target = str(entity_id)
    out: List[Any] = []
    for m in machines:
        shop = shops.get(m.shop_id)
        company = companies.get(shop.company_id) if shop is not None else None
        tenant = tenants.get(company.tenant_id) if company is not None else None
        area = areas.get(getattr(m, "area_id", None)) if shop is not None else None
        entities = [
            (lvl, e)
            for lvl, e in (("tenant", tenant), ("company", company), ("shop", shop), ("area", area), ("machine", m))
            if e is not None
        ]
        before = [(lvl, getattr(e, "settings", None)) for lvl, e in entities]
        changed = [
            (lvl, after if lvl == level and str(e.id) == target else getattr(e, "settings", None)) for lvl, e in entities
        ]
        builtin = bool(getattr(m, "has_builtin_terminal", True))
        synqpay = is_synqpay_device(m)
        if no_card(resolve(changed, builtin, synqpay_device=synqpay)) and not no_card(
            resolve(before, builtin, synqpay_device=synqpay)
        ):
            out.append(m)
    return out


def check_no_card_switch(db: Any, machines: Sequence[Any], level: str, entity_id: Any, after: Any) -> None:
    """
    Refuse a write that moves a till with open card sales to "ללא אשראי": 409
    `payment_integration_open_card` with the Hebrew line per till (`msg`) and its counts
    (`tills`). A till with none moves as usual; there is no force — a Z first.
    """
    moving = turning_no_card(db, machines, level, entity_id, after)
    if not moving:
        return
    counts = open_card_counts(db, moving)
    blocking = [counts[m.id] for m in moving if counts[m.id].any]
    if not blocking:
        return
    from fastapi import HTTPException, status

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": OPEN_CARD_CODE,
            "msg": open_card_message_he(blocking),
            "tills": [o.as_json() for o in blocking],
        },
    )


def machine_fields(res: Optional[Resolution]) -> Dict[str, Any]:
    """The integration fields of a machine's list/detail response (the badge)."""
    if res is None:
        return {
            "paymentIntegration": None,
            "paymentIntegrationSource": None,
            "paymentIntegrationAutomatic": None,
            "paymentIntegrationMissing": [],
        }
    return {
        "paymentIntegration": res.integration,
        "paymentIntegrationSource": res.source,
        "paymentIntegrationAutomatic": res.automatic,
        "paymentIntegrationMissing": list(res.missing),
    }


def is_synqpay_device(machine: Any) -> bool:
    """The till runs ON a SynqPay terminal (its model is one, app/models/synqpay_devices.py)."""
    from app.models.synqpay_devices import synqpay_device_model

    return synqpay_device_model(getattr(machine, "device_model", None)) is not None


def device_has_nfc(machine: Any) -> Optional[bool]:
    """
    Whether the till has NFC (Tap to Pay needs it): what it reported at pairing
    (`device_info.nfc`), else known for its model (a P18 has it), else unknown (None).
    """
    info = getattr(machine, "device_info", None)
    if isinstance(info, dict):
        reported = info.get("nfc")
        if isinstance(reported, bool):
            return reported
    if getattr(machine, "device_model", None) == "P18":
        return True
    return None
