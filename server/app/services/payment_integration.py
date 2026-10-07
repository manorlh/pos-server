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
* `zcredit` — "Z-Credit — מסופון חיצוני" (`zcreditTerminalNumber`, `zcreditPinpadId`,
  `zcreditMode`, and the write-only `zcreditPassword`, app/services/payment_secrets.py).
* `synqpay` — "SynqPay — מסוף חיצוני" (docs/SPEC_SYNQPAY.md): the `synqpay*` keys (device
  model, connection USB/LAN and its parameters) and the write-only `synqpayApiKey` — which
  the till normally gets itself, by pairing with the terminal (§2.2), so it is not required.
* `tap_to_pay` — "Tap to Pay במכשיר (iPOSpays)": reserved, refused on write for now.

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

from app.services.payment_secrets import SYNQPAY_API_KEY, ZCREDIT_KEY, ZCREDIT_PASSWORD
from app.services.payment_terminal import PinpadAddressError, clean_pinpad_host, merged_pinpad_host

KEY = "paymentIntegration"

AUTO = "auto"
AGAMENTO = "agamento"
NAYAX_LAN = "nayax_lan"
ZCREDIT = "zcredit"
SYNQPAY = "synqpay"
TAP_TO_PAY = "tap_to_pay"

INTEGRATIONS: Tuple[str, ...] = (AUTO, AGAMENTO, NAYAX_LAN, ZCREDIT, SYNQPAY, TAP_TO_PAY)
#: Shown as "בקרוב" and refused on write.
RESERVED: Tuple[str, ...] = (TAP_TO_PAY,)
#: Integrations that charge on a terminal outside the till: the only ones a till without
#: a terminal of its own can use.
EXTERNAL: Tuple[str, ...] = (NAYAX_LAN, ZCREDIT, SYNQPAY, TAP_TO_PAY)

LABELS_HE: Dict[str, str] = {
    AUTO: "אוטומטי",
    AGAMENTO: "מובנה — Agamento במכשיר",
    NAYAX_LAN: "Nayax — מסופון ברשת",
    ZCREDIT: "Z-Credit — מסופון חיצוני",
    SYNQPAY: "SynqPay — מסוף חיצוני",
    TAP_TO_PAY: "Tap to Pay במכשיר (iPOSpays)",
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

#: The settings keys this module owns, all managed (sent to the till) and all reset to
#: inherited by an explicit `null` in a PATCH.
SETTING_KEYS: Tuple[str, ...] = (
    KEY,
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
)
#: The Nayax address keys, resettable with `null` too, so clearing a field in the
#: device dialog brings the shop's value back instead of keeping the old one.
NAYAX_KEYS: Tuple[str, ...] = ("nayaxEnabled", "nayaxDeviceHost", "nayaxDevicePort", "nayaxSpicyPath")
RESETTABLE_KEYS: Tuple[str, ...] = SETTING_KEYS + NAYAX_KEYS

#: The secrets the till gets (the WebCheckout key is not used by a till: it is stored
#: for the merchant's other channels and never leaves the server), each only to a till
#: that charges on its integration.
TILL_SECRET_KEYS: Tuple[str, ...] = (ZCREDIT_PASSWORD, SYNQPAY_API_KEY)
TILL_SECRET_INTEGRATION: Dict[str, str] = {ZCREDIT_PASSWORD: ZCREDIT, SYNQPAY_API_KEY: SYNQPAY}

#: Z-Credit terminal numbers are digits, leading zeros kept ("0882…").
_TERMINAL_NUMBER = re.compile(r"^[0-9]{1,20}$")
#: A PinPad id as Z-Credit issues it, without the "PINPAD" prefix the API wants in Track2.
_PINPAD_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")

#: The fields each integration needs before its first card, in the order the form shows
#: them. Missing ones are listed on the machines page and on the till ("חסר: מספר מסוף").
REQUIRED_FIELDS: Dict[str, Tuple[str, ...]] = {
    AGAMENTO: (),
    NAYAX_LAN: ("nayaxDeviceHost",),
    ZCREDIT: (ZCREDIT_TERMINAL_NUMBER, ZCREDIT_PASSWORD, ZCREDIT_PINPAD_ID, ZCREDIT_MODE),
    # The host only on the network (lan): see missing_fields. No API key: the till pairs with
    # the terminal itself and sends the key up (SPEC_SYNQPAY.md §2.2) — a till with none yet is
    # "not paired", shown beside the form, not a field missing from it.
    SYNQPAY: (SYNQPAY_DEVICE_MODEL, SYNQPAY_CONNECTION, SYNQPAY_HOST),
    TAP_TO_PAY: (),
}

FIELD_LABELS_HE: Dict[str, str] = {
    "nayaxDeviceHost": "כתובת IP של המסופון",
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
}

#: The 422 a till without a terminal of its own gets for `agamento` on its own layer.
NEEDS_BUILTIN_DETAIL = {
    "code": "agamento_needs_builtin_terminal",
    "msg": "לקופה הזו אין מסוף מובנה (למשל טאבלט P18): ניתן לבחור רק אינטגרציה חיצונית — "
    "Nayax מסופון ברשת, Z-Credit מסופון חיצוני או SynqPay מסוף חיצוני.",
}


# ── Values ───────────────────────────────────────────────────────────────────


def clean_integration(value: Any) -> Optional[str]:
    """A stored or sent value as one of INTEGRATIONS, or None for nothing / unknown."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower().replace("-", "_")
    return text if text in INTEGRATIONS else None


def validate_integration(value: Optional[str]) -> Optional[str]:
    """For the PATCH schema: a known, selectable value. `tap_to_pay` is not yet."""
    if value is None:
        return None
    cleaned = clean_integration(value)
    if cleaned is None:
        raise ValueError(f"paymentIntegration must be one of {', '.join(INTEGRATIONS)}")
    if cleaned in RESERVED:
        raise ValueError("payment_integration_reserved: Tap to Pay is not available yet")
    return cleaned


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
    Refuse `agamento` on the own layer of a till without a terminal of its own. Raises
    `HTTPException(422, NEEDS_BUILTIN_DETAIL)`.
    """
    if clean_integration(patch.get(KEY)) != AGAMENTO:
        return
    if getattr(machine, "has_builtin_terminal", True):
        return
    from fastapi import HTTPException, status

    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=dict(NEEDS_BUILTIN_DETAIL))


# ── Resolution ───────────────────────────────────────────────────────────────


@dataclass
class Resolution:
    """What a till charges on, and why."""

    #: One of AGAMENTO, NAYAX_LAN, ZCREDIT; never AUTO.
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
        elif key in (ZCREDIT_PASSWORD, SYNQPAY_API_KEY):
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


def till_sync_fields(db: Any, machine: Any, tenant: Any, company: Any, shop: Any, area: Any) -> Dict[str, Any]:
    """
    What the till's settings sync says about its card integration, over the merged
    managed keys: `paymentIntegration` as the explicit choice down the layers (absent
    when automatic, so the till keeps deciding by its hardware as before), and, for a
    till on Z-Credit, `zcreditPassword` in the clear — its only way out of the server.
    Keys mapped to None are to be removed from the sync's settings.
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
    Whether the till has NFC (for Tap to Pay, reserved): what it reported at pairing
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
