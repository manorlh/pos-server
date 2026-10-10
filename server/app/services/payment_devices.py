"""
"מכשירי תשלום" — several card terminals for a till WITHOUT one of its own.

A till or tablet with no built-in clearing (a P18 — not an F20, whose Agamento is its own)
can work with several payment devices of its shop. Each has a nickname; at card payment the
till sends the transaction to one of them. The kinds:

* `zcredit_pinpad` — a Z-Credit PinPad: only its `pinpadId`. The terminal number and password
  are the branch's (the shop's / till's Z-Credit settings), shared by all its pinpads — a
  `terminalNumber` / `mode` / `zcreditPassword` sent for a pinpad is silently dropped.
* `synqpay` — a SynqPay terminal (model, connection lan | usb, host on lan, protocol, port, TLS,
  USB device, serial number, optional terminal number); secret: the API key (`synqpayApiKey`),
  normally sent up by the till that paired with it (`POST /sync/{m}/synqpay/pairing` with
  `paymentDeviceId`).
* `agamento_lan` — a Nayax handheld running only Agamento, reached over the LAN (TweezerComm
  over plain HTTP, port 8080, path /SPICy; optional MAC and terminal number); no secret.

A Nayax C4 on a USB cable is never a device: it is a till's own terminal (`paymentIntegration`
= `nayax_usb`, 422 `kind_usb_terminal` for such a kind), and a till on it may not also charge on
a SynqPay device on USB — one USB terminal per till (`usb_terminal_conflict`, 422
`usb_terminal_second`).

A device belongs to its shop. Several devices may share one terminal number (nothing is unique
about it). Which devices a till uses is a setting on the usual layers (shop = the default for its
tills, area, till; refused on a tenant or company — they have no devices; absent = inherit):

* `multiPaymentDevices` — the feature switch.
* `paymentDeviceMode` — "fixed" ("מכשיר קבוע": every card goes to one device, no picker) or
  "group" ("קבוצת מכשירים לבחירה": the cashier picks; the till preselects the last one used,
  else the first by sort order). Absent = a group of all the shop's devices.
* `fixedPaymentDeviceId` — the fixed device, a device of that shop. A layer that writes mode
  "fixed" must end up with one — its own, or one a layer above gives (checked on that layer
  merged with the layers above it, when the mode or the device changes).
* `paymentDeviceGroup` — device ids of that shop; empty / absent = every device of the shop.

The kiosk is out of scope: it keeps its one pinpad, is sent nothing here, and its own layer
refuses these keys.

What the till gets (`GET /sync/{m}/settings`, inside `settings`), only with `paymentDevices`:

* `paymentDevices` — a JSON *string*: ALL the devices of its shop, inactive ones included (the
  till refuses a card on one switched off, and still follows up one left unresolved), by
  `sort_order` then nickname: `[{"id", "nickname", "kind", "active", "sortOrder", "config"}]`.
  Absent when the shop has none, and for a kiosk.
* `paymentDeviceSecrets` — a JSON *string* `{"<deviceId>": {"synqpayApiKey": "…"}}` in the
  clear, only to a till without a built-in terminal. Absent when empty. Never logged, never in a
  dashboard answer.
* `paymentDeviceMode` — the merged value, only when "fixed" or "group".
* `fixedPaymentDeviceId` — the merged value, only when it names one of the shop's devices.
* `paymentDeviceGroup` — a JSON *string* of the merged list, filtered to the shop's devices;
  absent when unrestricted (the till's settings table would flatten a raw list).
* `paymentDevicesTerminalNumber` — the merged `expectedTerminalNumber` of ALL the layers
  (tenant → … → till), NOT filtered by terminal_config_guard: a read-only value the till
  compares a device's reported terminal with (its card lock), never written to a terminal.

Every change here (a device created, edited, deleted, a secret, a pairing) moves the shop's
`settings_updated_at` — the till's settings watermark — and tells the shop's tills to pull.

Secrets live in `payment_integration_secrets` (encrypted, app/services/payment_secrets.py) with
level "payment_device" and the device's id; they never reach the layers' lookups, which match
on (level, id) pairs of the settings layers only.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.payment_device import NICKNAME_MAX, PAYMENT_DEVICE_KINDS, PaymentDevice
from app.models.payment_secret import ORIGIN_DASHBOARD, ORIGIN_TILL_PAIRING, PaymentIntegrationSecret
from app.models.pos_machine import POSMachine, set_kiosk_cache
from app.models.shop import Shop
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services.payment_terminal import (
    DEFAULT_PATH,
    DEFAULT_PORT,
    PinpadAddressError,
    clean_pinpad_host,
    clean_pinpad_path,
)
from app.services.settings_merge import deep_merge_settings, patch_settings_json, utc_now

logger = logging.getLogger(__name__)

# ── Kinds ────────────────────────────────────────────────────────────────────

ZCREDIT_PINPAD = "zcredit_pinpad"
SYNQPAY = "synqpay"
AGAMENTO_LAN = "agamento_lan"
KINDS: Tuple[str, ...] = PAYMENT_DEVICE_KINDS

KIND_LABELS_HE: Dict[str, str] = {
    ZCREDIT_PINPAD: "Z-Credit PinPad",
    SYNQPAY: "SynqPay",
    AGAMENTO_LAN: "Agamento ברשת (Nayax)",
}

#: The secrets each kind uses; any other sent for it is dropped, and a kind change removes
#: the old kind's. A Z-Credit pinpad has none: the password is the branch's.
KIND_SECRETS: Dict[str, Tuple[str, ...]] = {
    ZCREDIT_PINPAD: (),
    SYNQPAY: (PS.SYNQPAY_API_KEY,),
    AGAMENTO_LAN: (),
}
DEVICE_SECRET_KEYS: Tuple[str, ...] = (PS.SYNQPAY_API_KEY,)

#: `payment_integration_secrets.level` of a device's secret (entity_id = the device's id).
SECRET_LEVEL = "payment_device"

# ── Settings keys (managed: app/services/settings_merge.py) ───────────────────

MULTI_KEY = "multiPaymentDevices"
MODE_KEY = "paymentDeviceMode"
FIXED_KEY = "fixedPaymentDeviceId"
GROUP_KEY = "paymentDeviceGroup"
SETTING_KEYS: Tuple[str, ...] = (MULTI_KEY, MODE_KEY, FIXED_KEY, GROUP_KEY)
#: The keys that name devices (or how a till picks one): shop, area and till layers only.
CHOICE_KEYS: Tuple[str, ...] = (MODE_KEY, FIXED_KEY, GROUP_KEY)
MODE_FIXED = "fixed"
MODE_GROUP = "group"
MODES: Tuple[str, ...] = (MODE_FIXED, MODE_GROUP)
# The earlier "default device" (`defaultPaymentDeviceId`) is gone: not managed, never sent,
# removed from every layer by migration 3b8f6d2a9c41.

#: Keys of the till's settings sync.
SYNC_DEVICES_KEY = "paymentDevices"
SYNC_SECRETS_KEY = "paymentDeviceSecrets"
SYNC_TERMINAL_KEY = "paymentDevicesTerminalNumber"
EXPECTED_TERMINAL_KEY = "expectedTerminalNumber"

NOTIFY_REASON = "payment_devices_updated"

SORT_ORDER_MAX = 9999
GROUP_MAX = 200

# ── Errors ───────────────────────────────────────────────────────────────────

MESSAGES_HE: Dict[str, str] = {
    "nickname_required": "יש להזין כינוי למכשיר",
    "nickname_too_long": f"כינוי המכשיר — עד {NICKNAME_MAX} תווים",
    "nickname_invalid": "כינוי המכשיר מכיל תווים לא חוקיים",
    "nickname_taken": "כבר יש בסניף מכשיר תשלום בכינוי הזה",
    "kind_required": "יש לבחור סוג מכשיר",
    "kind_invalid": "סוג מכשיר לא מוכר — Z-Credit PinPad, SynqPay או Agamento ברשת (Nayax)",
    "config_invalid": "הגדרות המכשיר אינן תקינות",
    "host_required": "יש להזין כתובת IP של המכשיר",
    "host_invalid": "כתובת IP או שם מארח לא תקינים",
    "port_invalid": "פורט — מספר בין 1 ל-65535",
    "path_invalid": "נתיב לא תקין: מתחיל ב-/, אותיות באנגלית, ספרות ו- / . _ ~ - בלבד, עד 100 תווים",
    "https_invalid": "ערך HTTPS לא תקין",
    "mac_invalid": "כתובת MAC לא תקינה (למשל aa:bb:cc:dd:ee:ff)",
    "terminal_number_invalid": "מספר מסוף — ספרות בלבד, עד 20",
    "pinpad_required": "יש להזין מזהה PinPad",
    "pinpad_invalid": "מזהה PinPad — אותיות באנגלית וספרות בלבד, עם או בלי הקידומת PINPAD",
    "model_required": "יש לבחור את דגם המסוף",
    "model_invalid": "דגם מסוף לא מוכר",
    "connection_required": "יש לבחור סוג חיבור — רשת או USB",
    "connection_invalid": "סוג חיבור לא מוכר",
    "protocol_invalid": "פרוטוקול — TCP או HTTP",
    "tls_invalid": "ערך TLS לא תקין",
    "usb_device_invalid": "התקן USB — VVVV:PPPP בהקס (למשל 0B00:0080), או ריק לזיהוי אוטומטי",
    "serial_invalid": "מספר סידורי — 4–32 אותיות באנגלית, ספרות או מקף",
    "sort_order_invalid": f"סדר — מספר שלם בין 0 ל-{SORT_ORDER_MAX}",
    "active_invalid": "ערך 'פעיל' לא תקין",
    "secret_invalid": "עד 200 תווים, ללא תווי בקרה",
    "synqpay_key_invalid": "מפתח API — אותיות באנגלית וספרות בלבד, עד 64 תווים",
    "payment_device_not_found": "מכשיר התשלום לא נמצא",
    "payment_device_level_invalid": "בחירת מכשירי התשלום לקופות נקבעת ברמת סניף, נקודת מכירה או קופה בלבד",
    "payment_device_not_in_shop": "המכשיר שנבחר אינו מכשיר תשלום של הסניף",
    "payment_device_kiosk": "קיוסק עובד עם המסופון שלו — אין לו מכשירי תשלום",
    "fixed_payment_device_required": "במצב 'מכשיר קבוע' יש לבחור את המכשיר",
    "payment_device_not_synqpay": "המכשיר אינו מסוף SynqPay",
    # One USB terminal per till (the owner, 08.10.2026): `usb_terminal_conflict` below.
    "kind_usb_terminal": "מסופון בחיבור USB הוא מסוף הקופה עצמה בלבד — לא אחד ממכשירי התשלום "
    "(בוחרים אותו בסוג אינטגרציית האשראי של הקופה: Nayax — מסופון בחיבור USB)",
    "usb_terminal_second": PI.ONE_USB_TERMINAL_HE,
}


class PaymentDeviceError(HTTPException):
    """
    A refusal with a machine-readable `detail.code`, the Hebrew `detail.msg` (the key the
    dashboard's error formatter reads) and, for a field, `detail.field` ("nickname",
    "config.host", "synqpayApiKey", "fixedPaymentDeviceId", "paymentDeviceGroup"…).
    """

    def __init__(self, code: str, *, field: Optional[str] = None, status_code: int = 422):
        detail: Dict[str, Any] = {"code": code, "msg": MESSAGES_HE.get(code, code)}
        if field:
            detail["field"] = field
        super().__init__(status_code=status_code, detail=detail)
        self.code = code
        self.field = field


# ── Small values ─────────────────────────────────────────────────────────────


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _as_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_TERMINAL = re.compile(r"^[0-9]{1,20}$")
_HEX12 = re.compile(r"^[0-9a-f]{12}$")
_MAC_SEPARATORS = re.compile(r"[:\-.\s]")
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://(.*)$")


def clean_nickname(value: Any) -> str:
    """Trimmed, inner whitespace collapsed; 1–40 characters, no control characters."""
    if not isinstance(value, str) or not value.strip():
        raise PaymentDeviceError("nickname_required", field="nickname")
    if _CONTROL.search(value.replace("\t", " ").replace("\n", " ").replace("\r", " ")):
        raise PaymentDeviceError("nickname_invalid", field="nickname")
    text = " ".join(value.split())
    if len(text) > NICKNAME_MAX:
        raise PaymentDeviceError("nickname_too_long", field="nickname")
    return text


#: A Nayax C4 on USB is the till's own terminal (`paymentIntegration` = `nayax_usb`), never a
#: device: these spellings get a refusal that says where it is set instead.
_USB_TERMINAL_KINDS = ("nayax_usb", "c4_usb", "agamento_usb", "usb")


def _reads_usb(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower().replace("-", "_") in ("usb", "usb_serial", "serial")


def clean_kind(value: Any) -> str:
    if _blank(value):
        raise PaymentDeviceError("kind_required", field="kind")
    text = str(value).strip().lower().replace("-", "_") if isinstance(value, str) else ""
    if text in _USB_TERMINAL_KINDS:
        raise PaymentDeviceError("kind_usb_terminal", field="kind")
    if text not in KINDS:
        raise PaymentDeviceError("kind_invalid", field="kind")
    return text


def clean_sort_order(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise PaymentDeviceError("sort_order_invalid", field="sortOrder")
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if not isinstance(value, int) or not 0 <= value <= SORT_ORDER_MAX:
        raise PaymentDeviceError("sort_order_invalid", field="sortOrder")
    return value


def clean_active(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise PaymentDeviceError("active_invalid", field="active")
    return value


def clean_mac(value: Any) -> Optional[str]:
    """A MAC in any common spelling as "aa:bb:cc:dd:ee:ff"; None for blank."""
    if _blank(value):
        return None
    if not isinstance(value, str):
        raise PaymentDeviceError("mac_invalid", field="config.mac")
    text = _MAC_SEPARATORS.sub("", value.strip().lower())
    if not _HEX12.match(text):
        raise PaymentDeviceError("mac_invalid", field="config.mac")
    return ":".join(text[i:i + 2] for i in range(0, 12, 2))


def clean_terminal_number(value: Any) -> Optional[str]:
    """Digits, 1–20, leading zeros kept; None for blank. Never unique: devices may share one."""
    if _blank(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise PaymentDeviceError("terminal_number_invalid", field="config.terminalNumber")
    text = str(value).strip()
    if not _TERMINAL.match(text):
        raise PaymentDeviceError("terminal_number_invalid", field="config.terminalNumber")
    return text


def clean_port(value: Any, default: Optional[int] = None) -> Optional[int]:
    """1–65535 (a number or its digits); blank → [default]."""
    if _blank(value):
        return default
    if isinstance(value, bool):
        raise PaymentDeviceError("port_invalid", field="config.port")
    if isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            raise PaymentDeviceError("port_invalid", field="config.port")
        value = int(text)
    if not isinstance(value, int) or not 1 <= value <= 65535:
        raise PaymentDeviceError("port_invalid", field="config.port")
    return value


def _clean_flag(value: Any, code: str, field: str, default: bool = False) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise PaymentDeviceError(code, field=field)
    return value


def split_address(text: str) -> Tuple[str, Optional[str], Optional[str], Optional[bool]]:
    """
    "http://192.168.1.20:8080/SPICy" as typed into the host field: (host, port, path, https).
    Parts not in the text are None; a plain host comes back as it is.
    """
    rest = text.strip()
    https: Optional[bool] = None
    m = _SCHEME.match(rest)
    if m:
        scheme = m.group(1).lower()
        if scheme not in ("http", "https"):
            raise PaymentDeviceError("host_invalid", field="config.host")
        https = scheme == "https"
        rest = m.group(2)
    path: Optional[str] = None
    if "/" in rest:
        rest, tail = rest.split("/", 1)
        path = "/" + tail if tail else None
    port: Optional[str] = None
    if ":" in rest:
        rest, port = rest.rsplit(":", 1)
    return rest, port, path, https


# ── Config, per kind ─────────────────────────────────────────────────────────


def _agamento_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    # An Agamento handheld is a device on the LAN only: a C4 on a USB cable is a till's own.
    if _reads_usb(raw.get("connection")):
        raise PaymentDeviceError("kind_usb_terminal", field="config.connection")
    host_raw = raw.get("host")
    if _blank(host_raw):
        raise PaymentDeviceError("host_required", field="config.host")
    if not isinstance(host_raw, str):
        raise PaymentDeviceError("host_invalid", field="config.host")
    host_text, url_port, url_path, url_https = split_address(host_raw)
    try:
        host = clean_pinpad_host(host_text)
    except PinpadAddressError as exc:
        raise PaymentDeviceError(
            "host_required" if exc.code == "host_required" else "host_invalid", field="config.host"
        ) from None
    port_raw = raw.get("port")
    if _blank(port_raw) and url_port is not None:
        port_raw = url_port
    port = clean_port(port_raw, DEFAULT_PORT)
    path_raw = raw.get("path")
    if _blank(path_raw) and url_path is not None:
        path_raw = url_path
    try:
        path = clean_pinpad_path(path_raw)
    except PinpadAddressError:
        raise PaymentDeviceError("path_invalid", field="config.path") from None
    https_raw = raw.get("https")
    if https_raw is None and url_https is not None:
        https_raw = url_https
    out: Dict[str, Any] = {
        "host": host,
        "port": port,
        "path": path,
        "https": _clean_flag(https_raw, "https_invalid", "config.https"),
    }
    mac = clean_mac(raw.get("mac"))
    if mac:
        out["mac"] = mac
    terminal = clean_terminal_number(raw.get("terminalNumber"))
    if terminal:
        out["terminalNumber"] = terminal
    return out


def _zcredit_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Only the PinPad: the terminal number, mode and password are the branch's (dropped here)."""
    if _blank(raw.get("pinpadId")):
        raise PaymentDeviceError("pinpad_required", field="config.pinpadId")
    if isinstance(raw.get("pinpadId"), bool):
        raise PaymentDeviceError("pinpad_invalid", field="config.pinpadId")
    try:
        pinpad = PI.clean_pinpad_id(raw.get("pinpadId"))
    except ValueError:
        raise PaymentDeviceError("pinpad_invalid", field="config.pinpadId") from None
    return {"pinpadId": pinpad}


def _synqpay_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    try:
        model = PI.validate_synqpay_model(raw.get("model"))
    except ValueError:
        raise PaymentDeviceError("model_invalid", field="config.model") from None
    if model is None:
        raise PaymentDeviceError("model_required", field="config.model")
    try:
        connection = PI.validate_synqpay_connection(raw.get("connection"))
    except ValueError:
        raise PaymentDeviceError("connection_invalid", field="config.connection") from None
    if connection is None:
        raise PaymentDeviceError("connection_required", field="config.connection")
    out: Dict[str, Any] = {"model": model, "connection": connection}
    if connection in PI.SYNQPAY_ADDRESSED:
        try:
            host = PI.validate_synqpay_host(raw.get("host"))
        except ValueError:
            raise PaymentDeviceError("host_invalid", field="config.host") from None
        if host is None:
            raise PaymentDeviceError("host_required", field="config.host")
        out["host"] = host
    try:
        protocol = PI.validate_synqpay_protocol(raw.get("protocol"))
    except ValueError:
        raise PaymentDeviceError("protocol_invalid", field="config.protocol") from None
    out["protocol"] = protocol or "tcp"
    port = clean_port(raw.get("port"))
    if port is not None:
        out["port"] = port
    out["tls"] = _clean_flag(raw.get("tls"), "tls_invalid", "config.tls")
    try:
        usb = PI.validate_synqpay_usb_device(raw.get("usbDevice"))
    except ValueError:
        raise PaymentDeviceError("usb_device_invalid", field="config.usbDevice") from None
    if usb:
        out["usbDevice"] = usb
    try:
        serial = PI.validate_synqpay_serial(raw.get("serialNumber"))
    except ValueError:
        raise PaymentDeviceError("serial_invalid", field="config.serialNumber") from None
    if serial:
        out["serialNumber"] = serial
    terminal = clean_terminal_number(raw.get("terminalNumber"))
    if terminal:
        out["terminalNumber"] = terminal
    return out


_CONFIG_CLEANERS = {AGAMENTO_LAN: _agamento_config, ZCREDIT_PINPAD: _zcredit_config, SYNQPAY: _synqpay_config}


def clean_config(kind: str, raw: Any) -> Dict[str, Any]:
    """
    The kind's non-secret fields, validated and normalised as the till reads them (unknown
    keys dropped, keys with no value left out, defaults filled in). `PaymentDeviceError`
    with the field ("config.host"…) otherwise.
    """
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise PaymentDeviceError("config_invalid", field="config")
    return _CONFIG_CLEANERS[clean_kind(kind)](raw)


def till_config(kind: str, config: Any) -> Dict[str, Any]:
    """A stored config as the till gets it: no null / empty values, the kind's defaults."""
    out = {k: v for k, v in _as_dict(config).items() if v is not None and v != ""}
    if kind == AGAMENTO_LAN:
        out.setdefault("port", DEFAULT_PORT)
        out.setdefault("path", DEFAULT_PATH)
        out.setdefault("https", False)
    elif kind == SYNQPAY:
        out.setdefault("protocol", "tcp")
        out.setdefault("tls", False)
    elif kind == ZCREDIT_PINPAD:
        # The branch's terminal number and mode, never the pinpad's (a row from before).
        out = {k: v for k, v in out.items() if k == "pinpadId"}
    return out


# ── The shop's tills ─────────────────────────────────────────────────────────


def shop_tills(db: Session, shop_id: Any, *, active_only: bool = True) -> List[POSMachine]:
    """The shop's tills that can use a device: not kiosks (they keep their own pinpad)."""
    query = db.query(POSMachine).filter(POSMachine.shop_id == _uuid(shop_id))
    if active_only:
        query = query.filter(POSMachine.is_active.is_(True))
    machines = query.order_by(POSMachine.pos_number, POSMachine.name).all()
    kiosks = _kiosk_ids(db, [m.id for m in machines])
    for m in machines:
        set_kiosk_cache(m, m.id in kiosks)
    return [m for m in machines if m.id not in kiosks]


def _kiosk_ids(db: Session, machine_ids: Sequence[Any]) -> set:
    ids = [i for i in (_uuid(x) for x in machine_ids) if i is not None]
    if not ids:
        return set()
    from app.models.kiosk import KioskDevice

    return {_uuid(row[0]) for row in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id.in_(ids)).all()}


# ── Devices ──────────────────────────────────────────────────────────────────


def _order(device: PaymentDevice) -> Tuple[int, str, str]:
    return (int(device.sort_order or 0), (device.nickname or "").casefold(), str(device.id))


def shop_devices(db: Session, shop_id: Any) -> List[PaymentDevice]:
    """The shop's devices by sort order, then nickname."""
    rows = db.query(PaymentDevice).filter(PaymentDevice.shop_id == _uuid(shop_id)).all()
    return sorted(rows, key=_order)


def get_device(db: Session, device_id: Any) -> Optional[PaymentDevice]:
    ident = _uuid(device_id)
    if ident is None:
        return None
    return db.query(PaymentDevice).filter(PaymentDevice.id == ident).first()


def _check_nickname_free(db: Session, shop_id: Any, nickname: str, *, except_id: Any = None) -> None:
    folded = nickname.casefold()
    for other in db.query(PaymentDevice).filter(PaymentDevice.shop_id == _uuid(shop_id)).all():
        if except_id is not None and _uuid(other.id) == _uuid(except_id):
            continue
        if (other.nickname or "").casefold() == folded:
            raise PaymentDeviceError("nickname_taken", field="nickname", status_code=status.HTTP_409_CONFLICT)


def secret_patch(body: Any) -> Dict[str, Optional[str]]:
    """
    The write-only secret a body carries (SynqPay's API key): key → value to store, or None to
    remove. Only when sent; the dashboard's mask ("••••") echoed back is left out (keep). Never
    echoes a value in an error.
    """
    sent = getattr(body, "model_fields_set", set())
    out: Dict[str, Optional[str]] = {}
    if "synqpay_api_key" not in sent:
        return out
    raw = getattr(body, "synqpay_api_key", None)
    if PS.is_mask(raw):
        return out
    try:
        value = PS.clean_secret(raw)
    except PS.PaymentSecretError:
        raise PaymentDeviceError("secret_invalid", field=PS.SYNQPAY_API_KEY) from None
    if value is not None and not PS.is_synqpay_api_key(value):
        raise PaymentDeviceError("synqpay_key_invalid", field=PS.SYNQPAY_API_KEY)
    out[PS.SYNQPAY_API_KEY] = value
    return out


def _secret_rows(db: Session, device_ids: Iterable[Any]) -> Dict[uuid.UUID, Dict[str, PaymentIntegrationSecret]]:
    ids = [i for i in (_uuid(x) for x in device_ids) if i is not None]
    if not ids:
        return {}
    out: Dict[uuid.UUID, Dict[str, PaymentIntegrationSecret]] = {}
    rows = (
        db.query(PaymentIntegrationSecret)
        .filter(PaymentIntegrationSecret.level == SECRET_LEVEL, PaymentIntegrationSecret.entity_id.in_(ids))
        .all()
    )
    for row in rows:
        out.setdefault(_uuid(row.entity_id), {})[row.key] = row
    return out


def _new_secret_row(device: PaymentDevice, key: str) -> PaymentIntegrationSecret:
    return PaymentIntegrationSecret(
        id=uuid.uuid4(), level=SECRET_LEVEL, entity_id=_uuid(device.id), key=key, tenant_id=_uuid(device.tenant_id)
    )


def apply_device_secrets(db: Session, device: PaymentDevice, patch: Dict[str, Optional[str]], *, user_id: Any = None) -> bool:
    """
    Store / remove the device's secrets (encrypted). Secrets of a kind the device is not are
    removed whatever the patch says (a kind change, a pinpad's old password), and never stored.
    True when anything changed.
    """
    allowed = KIND_SECRETS.get(device.kind, ())
    rows = dict(_secret_rows(db, [device.id]).get(_uuid(device.id), {}))
    changed = False
    for key, row in list(rows.items()):
        if key not in allowed:
            db.delete(row)
            rows.pop(key)
            changed = True
    for key, value in patch.items():
        if key not in allowed:
            continue
        row = rows.get(key)
        if value is None:
            if row is not None:
                db.delete(row)
                rows.pop(key)
                changed = True
            continue
        if row is None:
            row = _new_secret_row(device, key)
            db.add(row)
            rows[key] = row
        elif PS.decrypt(row.ciphertext) == value:
            continue
        row.ciphertext = PS.encrypt(value)
        row.updated_by = _uuid(user_id)
        row.updated_at = datetime.now(timezone.utc)
        PS._set_origin(row, ORIGIN_DASHBOARD)
        changed = True
    if changed:
        db.flush()
    return changed


def remove_device_secrets(db: Session, device_id: Any) -> None:
    for row in _secret_rows(db, [device_id]).get(_uuid(device_id), {}).values():
        db.delete(row)


def secrets_status(db: Session, rows: Dict[str, PaymentIntegrationSecret]) -> Dict[str, Dict[str, Any]]:
    """For the dashboard: whether a SynqPay key is stored, and its pairing. Never the value."""
    row = rows.get(PS.SYNQPAY_API_KEY)
    entry: Dict[str, Any] = {"set": row is not None, "updatedAt": row.updated_at if row is not None else None}
    entry.update(PS.pairing_status(db, row))
    return {PS.SYNQPAY_API_KEY: entry}


def till_device(device: PaymentDevice) -> Dict[str, Any]:
    """One device as the till gets it."""
    return {
        "id": str(device.id),
        "nickname": device.nickname,
        "kind": device.kind,
        "active": bool(device.active),
        "sortOrder": int(device.sort_order or 0),
        "config": till_config(device.kind, device.config),
    }


def device_out(db: Session, device: PaymentDevice, rows: Optional[Dict[str, PaymentIntegrationSecret]] = None) -> Dict[str, Any]:
    """One device as the dashboard gets it: the till's shape, times, secret status."""
    if rows is None:
        rows = _secret_rows(db, [device.id]).get(_uuid(device.id), {})
    return {
        **till_device(device),
        "shopId": str(device.shop_id),
        "createdAt": device.created_at,
        "updatedAt": device.updated_at,
        "secrets": secrets_status(db, rows),
    }


def touch_shop(shop: Shop) -> None:
    """Move the shop's settings stamp: the tills' settings watermark covers it."""
    shop.settings_updated_at = utc_now()


def notify_shop(db: Session, shop_id: Any) -> None:
    """After the commit: the shop's tills pull their settings again."""
    from app.services.settings_notify import notify_machines_for_shop_settings

    try:
        notify_machines_for_shop_settings(db, str(shop_id), reason=NOTIFY_REASON)
    except Exception:  # pragma: no cover - best effort; tills also pull on sync
        logger.warning("payment devices: notifying the tills of shop %s failed", shop_id, exc_info=True)


def create_device(db: Session, shop: Shop, body: Any, *, user_id: Any = None) -> PaymentDevice:
    """A new device of [shop] from a `PaymentDeviceIn`. The caller commits and notifies."""
    nickname = clean_nickname(body.nickname)
    kind = clean_kind(body.kind)
    config = clean_config(kind, body.config)
    sort_order = clean_sort_order(body.sort_order)
    active = clean_active(body.active)
    secrets = secret_patch(body)
    _check_nickname_free(db, shop.id, nickname)
    ident = uuid.uuid4()
    _check_usb_device(db, shop, ident, nickname, kind, config, sort_order)
    device = PaymentDevice(
        id=ident,
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        nickname=nickname,
        kind=kind,
        config=config,
        active=active,
        sort_order=sort_order,
    )
    db.add(device)
    db.flush()
    apply_device_secrets(db, device, secrets, user_id=user_id)
    touch_shop(shop)
    return device


def update_device(db: Session, shop: Shop, device: PaymentDevice, body: Any, *, user_id: Any = None) -> PaymentDevice:
    """
    Change the fields the body sends (absent = keep). A new kind validates the config for it
    (the stored one when the kind is unchanged and no config is sent) and removes the old
    kind's secrets. Deactivating clears nothing: the till refuses a card on it instead.
    """
    sent = getattr(body, "model_fields_set", set())
    nickname = clean_nickname(body.nickname) if "nickname" in sent else device.nickname
    kind = clean_kind(body.kind) if "kind" in sent else device.kind
    if "config" in sent:
        raw_config = body.config
    else:
        raw_config = device.config if kind == device.kind else {}
    config = clean_config(kind, raw_config)
    sort_order = clean_sort_order(body.sort_order, int(device.sort_order or 0)) if "sort_order" in sent else device.sort_order
    active = clean_active(body.active, bool(device.active)) if "active" in sent else device.active
    secrets = secret_patch(body)
    if nickname.casefold() != (device.nickname or "").casefold():
        _check_nickname_free(db, shop.id, nickname, except_id=device.id)
    # Only a device that turns into a USB one is checked (a rename of one never blocks).
    if not is_usb_device(device.kind, device.config):
        _check_usb_device(db, shop, device.id, nickname, kind, config, sort_order)

    device.nickname = nickname
    device.kind = kind
    device.config = config
    device.sort_order = sort_order
    device.active = active
    device.updated_at = datetime.now(timezone.utc)
    db.flush()
    apply_device_secrets(db, device, secrets, user_id=user_id)
    touch_shop(shop)
    return device


def strip_device_from_settings(settings: Any, device_id: str) -> Optional[Dict[str, Any]]:
    """
    A layer's settings without [device_id]: out of `paymentDeviceGroup` (a group left empty is
    removed — the layer inherits again rather than turning into "every device"), and as
    `fixedPaymentDeviceId` (with the layer's own mode "fixed", which has nothing left to point
    at). None when the layer did not name the device.
    """
    out = _as_dict(settings)
    changed = False
    if out.get(FIXED_KEY) == device_id:
        out.pop(FIXED_KEY)
        if out.get(MODE_KEY) == MODE_FIXED:
            out.pop(MODE_KEY)
        changed = True
    group = out.get(GROUP_KEY)
    if isinstance(group, list) and any(str(x) == device_id for x in group):
        rest = [x for x in group if str(x) != device_id]
        if rest:
            out[GROUP_KEY] = rest
        else:
            out.pop(GROUP_KEY)
        changed = True
    return out if changed else None


def delete_device(db: Session, shop: Shop, device: PaymentDevice) -> None:
    """
    Delete it, its secrets, and every reference to it — `fixedPaymentDeviceId` and
    `paymentDeviceGroup` of the shop, its areas and its tills — in the same transaction,
    moving each changed layer's stamp. The caller commits and notifies.
    """
    from app.models.shop_area import ShopArea

    now = utc_now()
    ident = str(device.id)
    stripped = strip_device_from_settings(shop.settings, ident)
    if stripped is not None:
        shop.settings = stripped
    for area in db.query(ShopArea).filter(ShopArea.shop_id == _uuid(shop.id)).all():
        stripped = strip_device_from_settings(area.settings, ident)
        if stripped is not None:
            area.settings = stripped
            area.settings_updated_at = now
    for machine in db.query(POSMachine).filter(POSMachine.shop_id == _uuid(shop.id)).all():
        stripped = strip_device_from_settings(machine.settings, ident)
        if stripped is not None:
            machine.settings = stripped
            machine.settings_updated_at = now
    remove_device_secrets(db, device.id)
    db.delete(device)
    touch_shop(shop)


# ── What a till uses ─────────────────────────────────────────────────────────


def _str_ids(values: Any) -> List[str]:
    """Device ids as canonical strings, once each, in order; anything else left out."""
    out: List[str] = []
    if not isinstance(values, (list, tuple)):
        return out
    for v in values:
        ident = _uuid(v)
        if ident is not None and str(ident) not in out:
            out.append(str(ident))
    return out


def till_choice(merged: Dict[str, Any], device_ids: Sequence[str]) -> Dict[str, Any]:
    """
    How a till picks a device, from its merged settings and its shop's device ids:
    `{enabled, mode, fixedDeviceId, groupDeviceIds}` — mode "group" when unset; the fixed device
    only when it is one of the shop's; the group filtered to the shop's devices, None = all.
    """
    ids = [str(x) for x in device_ids]
    mode = merged.get(MODE_KEY) if merged.get(MODE_KEY) in MODES else MODE_GROUP
    fixed = merged.get(FIXED_KEY)
    group = [g for g in _str_ids(merged.get(GROUP_KEY)) if g in ids]
    return {
        "enabled": merged.get(MULTI_KEY) is True,
        "mode": mode,
        "fixedDeviceId": fixed if isinstance(fixed, str) and fixed in ids else None,
        "groupDeviceIds": group or None,
    }


def _tills_summary(db: Session, shop: Shop, devices: List[PaymentDevice]) -> List[Dict[str, Any]]:
    """Each non-kiosk till of the shop, its hardware and how it picks a device (merged layers)."""
    from app.models.company import Company
    from app.models.shop_area import ShopArea
    from app.models.tenant import Tenant

    company = db.query(Company).filter(Company.id == shop.company_id).first() if shop.company_id else None
    tenant = (
        db.query(Tenant).filter(Tenant.id == company.tenant_id).first()
        if company is not None and company.tenant_id
        else None
    )
    areas = {a.id: a for a in db.query(ShopArea).filter(ShopArea.shop_id == _uuid(shop.id)).all()}
    ids = [str(d.id) for d in devices]
    out: List[Dict[str, Any]] = []
    for m in shop_tills(db, shop.id):
        area = areas.get(getattr(m, "area_id", None))
        merged = deep_merge_settings(
            _as_dict(getattr(tenant, "settings", None)),
            _as_dict(getattr(company, "settings", None)),
            _as_dict(shop.settings),
            _as_dict(getattr(area, "settings", None)),
            _as_dict(m.settings),
        )
        own = _as_dict(m.settings)
        out.append({
            "id": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "hasBuiltinTerminal": bool(m.has_builtin_terminal),
            "choice": till_choice(merged, ids),
            #: The till's own layer sets one of these keys (else it follows the shop / its area).
            "ownChoice": any(k in own for k in SETTING_KEYS),
        })
    return out


# ── The dashboard's pages ────────────────────────────────────────────────────


def _inherited_multi(db: Session, shop: Shop) -> Tuple[Optional[bool], Optional[str]]:
    """`multiPaymentDevices` as the shop inherits it from its company and tenant, and from where."""
    from app.models.company import Company
    from app.models.tenant import Tenant

    company = db.query(Company).filter(Company.id == shop.company_id).first() if shop.company_id else None
    tenant = (
        db.query(Tenant).filter(Tenant.id == company.tenant_id).first()
        if company is not None and company.tenant_id
        else None
    )
    value: Optional[bool] = None
    source: Optional[str] = None
    for level, entity in (("tenant", tenant), ("company", company)):
        own = _as_dict(getattr(entity, "settings", None)).get(MULTI_KEY) if entity is not None else None
        if isinstance(own, bool):
            value, source = own, level
    return value, source


def dashboard_page(db: Session, shop: Shop, *, can_edit: bool) -> Dict[str, Any]:
    """`GET /shops/{id}/payment-devices`."""
    devices = shop_devices(db, shop.id)
    rows = _secret_rows(db, [d.id for d in devices])
    own = _as_dict(shop.settings)
    inherited, source = _inherited_multi(db, shop)
    return {
        "shopId": str(shop.id),
        "devices": [device_out(db, d, rows.get(_uuid(d.id), {})) for d in devices],
        # Each non-kiosk till: its hardware and how it picks a device now (the per-till summary).
        "machines": _tills_summary(db, shop, devices),
        "multiPaymentDevices": own.get(MULTI_KEY) if isinstance(own.get(MULTI_KEY), bool) else None,
        "multiPaymentDevicesInherited": inherited,
        "multiPaymentDevicesInheritedSource": source,
        # The shop's own choice: the default for its tills.
        "paymentDeviceMode": own.get(MODE_KEY) if own.get(MODE_KEY) in MODES else None,
        "fixedPaymentDeviceId": own.get(FIXED_KEY) if isinstance(own.get(FIXED_KEY), str) else None,
        "paymentDeviceGroup": _str_ids(own.get(GROUP_KEY)) if isinstance(own.get(GROUP_KEY), list) else None,
        "kinds": [{"value": k, "label": KIND_LABELS_HE[k]} for k in KINDS],
        "canEdit": can_edit,
    }


def machine_page(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """`GET /machines/{id}/payment-devices`: the devices of the till's shop (none for a kiosk)."""
    kiosk = bool(machine.is_kiosk)
    devices: List[PaymentDevice] = []
    if machine.shop_id is not None and not kiosk:
        devices = shop_devices(db, machine.shop_id)
    rows = _secret_rows(db, [d.id for d in devices])
    return {
        "machineId": str(machine.id),
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "hasBuiltinTerminal": bool(machine.has_builtin_terminal),
        "isKiosk": kiosk,
        "devices": [device_out(db, d, rows.get(_uuid(d.id), {})) for d in devices],
    }


# ── Settings PATCH (app/routers/settings.py) ──────────────────────────────────


def _layers_above(db: Session, level: str, entity: Any) -> List[Dict[str, Any]]:
    """The settings of the layers above [entity] that may hold a device choice, least specific first."""
    if level == "area":
        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first()
        return [_as_dict(getattr(shop, "settings", None))]
    if level == "machine":
        from app.services.areas import get_area

        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first() if entity.shop_id else None
        area = get_area(db, getattr(entity, "area_id", None)) if shop is not None else None
        return [_as_dict(getattr(shop, "settings", None)), _as_dict(getattr(area, "settings", None))]
    return []


def check_settings_patch(db: Session, level: str, entity: Any, patch: Dict[str, Any]) -> None:
    """
    The device choice written on a layer (`paymentDeviceMode`, `fixedPaymentDeviceId`,
    `paymentDeviceGroup`):

    * shop, area and till only (422 `payment_device_level_invalid` on a tenant / company), and
      not a kiosk's own layer (422 `payment_device_kiosk`);
    * every id a device of that shop — a till's: its shop's (422 `payment_device_not_in_shop`);
    * a layer whose own mode ends up "fixed" must have a fixed device, its own or one a layer
      above gives (422 `fixed_payment_device_required`);
    * one USB terminal per till, on every level: no till the layer reaches may end up on
      `nayax_usb` with a SynqPay device on USB among the devices it charges on (422
      `usb_terminal_second`, `check_usb_terminal_patch`).

    Only a *change* is checked: the dashboard sends the whole form on every save, so a value
    stored earlier round-trips unchanged without blocking an unrelated save. A `null` (inherit
    again) is never refused, except where it leaves a "fixed" mode without its device.
    """
    _check_device_choice(db, level, entity, patch)
    check_usb_terminal_patch(db, level, entity, patch)


def _check_device_choice(db: Session, level: str, entity: Any, patch: Dict[str, Any]) -> None:
    """`check_settings_patch`'s device-choice rules (all but the one-USB one)."""
    stored = _as_dict(getattr(entity, "settings", None))
    changed = [k for k in CHOICE_KEYS if k in patch and patch[k] != stored.get(k)]
    if not changed:
        return
    writes = [k for k in changed if patch[k] is not None]
    if writes and level not in ("shop", "area", "machine"):
        raise PaymentDeviceError("payment_device_level_invalid", field=writes[0])
    if writes and level == "machine" and bool(getattr(entity, "is_kiosk", False)):
        raise PaymentDeviceError("payment_device_kiosk", field=writes[0])
    if level not in ("shop", "area", "machine"):
        return
    shop_id = entity.id if level == "shop" else getattr(entity, "shop_id", None)
    ids = {str(d.id) for d in shop_devices(db, shop_id)} if shop_id is not None else set()
    if FIXED_KEY in writes and patch[FIXED_KEY] not in ids:
        raise PaymentDeviceError("payment_device_not_in_shop", field=FIXED_KEY)
    if GROUP_KEY in writes and any(g not in ids for g in _str_ids(patch[GROUP_KEY])):
        raise PaymentDeviceError("payment_device_not_in_shop", field=GROUP_KEY)
    after = patch_settings_json(stored, {k: patch[k] for k in CHOICE_KEYS if k in patch})
    if after.get(MODE_KEY) == MODE_FIXED and (MODE_KEY in changed or FIXED_KEY in changed):
        merged = deep_merge_settings(*_layers_above(db, level, entity), after)
        if not (isinstance(merged.get(FIXED_KEY), str) and merged[FIXED_KEY]):
            raise PaymentDeviceError("fixed_payment_device_required", field=FIXED_KEY)


# ── One USB terminal per till (the owner, 08.10.2026) ─────────────────────────
#
# A Nayax C4 on the till's USB (`paymentIntegration` = `nayax_usb`) is the till's own terminal;
# the only payment device that can be on a USB cable is a SynqPay one (`connection` "usb"). Two
# CDC-ACM terminals on one till cannot work (the first found would take the other's frames), so a
# till that resolves to `nayax_usb` must not have such a device among the devices it charges on:
# with `multiPaymentDevices` on, its fixed device in mode "fixed", else its group (absent = every
# device of its shop). Refused (422 `usb_terminal_second`) wherever that could start — a settings
# PATCH on any level (`check_settings_patch`), a device created or turned into a USB one, and the
# till's own "חיבור USB" (`PUT /sync/{m}/payment-terminal`). LAN / Z-Credit devices are fine.

#: The settings whose change can put a USB device beside a till's own USB C4.
USB_RULE_KEYS: Tuple[str, ...] = (PI.KEY, MULTI_KEY, MODE_KEY, FIXED_KEY, GROUP_KEY)
USB_TERMINAL_CODE = "usb_terminal_second"


def is_usb_device(kind: Any, config: Any) -> bool:
    """A SynqPay device on a USB cable (the only kind of payment device that can be on one)."""
    return kind == SYNQPAY and _reads_usb(_as_dict(config).get("connection"))


def till_device_ids(merged: Dict[str, Any], device_ids: Sequence[str]) -> List[str]:
    """
    The devices a till may charge on, from its merged settings: none with the switch off; its
    fixed device in mode "fixed"; else its group, else every device of its shop.
    """
    choice = till_choice(merged, device_ids)
    if not choice["enabled"]:
        return []
    if choice["mode"] == MODE_FIXED and choice["fixedDeviceId"]:
        return [choice["fixedDeviceId"]]
    return list(choice["groupDeviceIds"] or [str(x) for x in device_ids])


def usb_terminal_conflict(
    db: Session,
    machines: Sequence[Any],
    *,
    layer: Optional[Tuple[str, Any, Dict[str, Any]]] = None,
    device: Optional[Any] = None,
) -> Optional[Tuple[Any, Any]]:
    """
    The first `(till, device)` among [machines] (kiosks skipped: they have no devices) that breaks
    the rule. [layer] `(level, entity id, settings)` stands for that layer's settings as a write
    would leave them; [device] for a device as it is about to be saved (id, shop_id, kind, config,
    nickname, sort_order), replacing the stored one with its id or added.
    """
    from app.models.company import Company
    from app.models.shop_area import ShopArea
    from app.models.tenant import Tenant

    tills = [m for m in machines if m is not None and getattr(m, "shop_id", None) is not None]
    kiosks = _kiosk_ids(db, [m.id for m in tills])
    tills = [m for m in tills if _uuid(m.id) not in kiosks]
    if not tills:
        return None
    shop_ids = list({_uuid(m.shop_id) for m in tills})
    by_shop: Dict[uuid.UUID, List[Any]] = {}
    for d in db.query(PaymentDevice).filter(PaymentDevice.shop_id.in_(shop_ids)).all():
        by_shop.setdefault(_uuid(d.shop_id), []).append(d)
    if device is not None:
        sid = _uuid(device.shop_id)
        by_shop[sid] = [d for d in by_shop.get(sid, []) if _uuid(d.id) != _uuid(device.id)] + [device]
    if not any(is_usb_device(d.kind, d.config) for ds in by_shop.values() for d in ds):
        return None

    def load(model, ids):
        wanted = [i for i in {_uuid(x) for x in ids} if i is not None]
        return {_uuid(r.id): r for r in db.query(model).filter(model.id.in_(wanted)).all()} if wanted else {}

    shops = load(Shop, shop_ids)
    companies = load(Company, (s.company_id for s in shops.values()))
    tenants = load(Tenant, (c.tenant_id for c in companies.values()))
    areas = load(ShopArea, (getattr(m, "area_id", None) for m in tills))

    def settings_of(level: str, entity: Any) -> Any:
        if layer is not None and layer[0] == level and _uuid(layer[1]) == _uuid(entity.id):
            return layer[2]
        return getattr(entity, "settings", None)

    for m in tills:
        devices = sorted(by_shop.get(_uuid(m.shop_id), []), key=_order)
        if not any(is_usb_device(d.kind, d.config) for d in devices):
            continue
        shop = shops.get(_uuid(m.shop_id))
        company = companies.get(_uuid(shop.company_id)) if shop is not None else None
        tenant = tenants.get(_uuid(company.tenant_id)) if company is not None else None
        area = areas.get(_uuid(getattr(m, "area_id", None)))
        layers = [
            (level, settings_of(level, entity))
            for level, entity in (("tenant", tenant), ("company", company), ("shop", shop), ("area", area), ("machine", m))
            if entity is not None
        ]
        resolved = PI.resolve(
            layers, bool(getattr(m, "has_builtin_terminal", True)), synqpay_device=PI.is_synqpay_device(m)
        )
        if resolved.integration != PI.NAYAX_USB:
            continue
        merged = deep_merge_settings(*(_as_dict(s) for _, s in layers))
        chosen = set(till_device_ids(merged, [str(d.id) for d in devices]))
        for d in devices:
            if str(d.id) in chosen and is_usb_device(d.kind, d.config):
                return m, d
    return None


def usb_terminal_message(conflict: Tuple[Any, Any]) -> str:
    """The Hebrew refusal, naming the till and the device."""
    machine, device = conflict
    till = getattr(machine, "name", None) or "הקופה"
    return f'{PI.ONE_USB_TERMINAL_HE}: מכשיר התשלום "{device.nickname}" (SynqPay בחיבור USB) זמין לקופה "{till}"'


def usb_terminal_error(conflict: Tuple[Any, Any], *, field: Optional[str] = None) -> PaymentDeviceError:
    """422 `usb_terminal_second` with the message, and which till and device collide."""
    machine, device = conflict
    err = PaymentDeviceError(USB_TERMINAL_CODE, field=field)
    err.detail["msg"] = usb_terminal_message(conflict)
    err.detail["machineId"] = str(machine.id)
    err.detail["deviceId"] = str(device.id)
    return err


def _machines_in_scope(db: Session, level: str, entity: Any) -> List[Any]:
    """The tills a write on [level] reaches (active ones; a till's own layer: that till)."""
    if level == "machine":
        return [entity]
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if level == "area":
        query = query.filter(POSMachine.area_id == _uuid(entity.id))
    elif level == "shop":
        query = query.filter(POSMachine.shop_id == _uuid(entity.id))
    elif level == "company":
        shop_ids = [s.id for s in db.query(Shop).filter(Shop.company_id == _uuid(entity.id)).all()]
        if not shop_ids:
            return []
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    elif level == "tenant":
        query = query.filter(POSMachine.tenant_id == _uuid(entity.id))
    else:
        return []
    return query.all()


def check_usb_terminal_patch(db: Session, level: str, entity: Any, patch: Dict[str, Any]) -> None:
    """
    A settings PATCH on [level] that changes the integration or the device choice: refused (422
    `usb_terminal_second`, the field the first changed key) when it would leave a till it reaches
    on `nayax_usb` with a SynqPay USB device to charge on. Unchanged values never block a save.
    """
    stored = _as_dict(getattr(entity, "settings", None))
    changed = [k for k in USB_RULE_KEYS if k in patch and patch[k] != stored.get(k)]
    if not changed:
        return
    after = patch_settings_json(stored, {k: patch[k] for k in USB_RULE_KEYS if k in patch})
    conflict = usb_terminal_conflict(db, _machines_in_scope(db, level, entity), layer=(level, entity.id, after))
    if conflict is not None:
        raise usb_terminal_error(conflict, field=changed[0])


def _check_usb_device(
    db: Session, shop: Shop, ident: Any, nickname: str, kind: str, config: Dict[str, Any], sort_order: Any
) -> None:
    """A device about to be saved as a SynqPay one on USB: refused beside a till's own USB C4."""
    if not is_usb_device(kind, config):
        return
    from types import SimpleNamespace

    candidate = SimpleNamespace(
        id=ident, shop_id=shop.id, nickname=nickname, kind=kind, config=config, sort_order=sort_order
    )
    conflict = usb_terminal_conflict(db, shop_tills(db, shop.id), device=candidate)
    if conflict is not None:
        raise usb_terminal_error(conflict, field="config.connection")


# ── The till ─────────────────────────────────────────────────────────────────


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def till_devices(db: Session, machine: Any, shop: Any) -> List[PaymentDevice]:
    """The devices [machine] gets: all its shop's; none for a kiosk."""
    if shop is None or machine is None or bool(getattr(machine, "is_kiosk", False)):
        return []
    return shop_devices(db, shop.id)


def till_sync_fields(db: Session, machine: Any, shop: Any, merged: Optional[Dict[str, Any]] = None) -> Dict[str, Optional[str]]:
    """
    What the till's settings sync adds or replaces (see the module docstring). [merged] is the
    till's merged settings of ALL layers, before terminal_config_guard. A key mapped to None is
    removed from the sync's settings: none of them goes out without `paymentDevices`.
    """
    merged = merged or {}
    out: Dict[str, Optional[str]] = {
        SYNC_DEVICES_KEY: None,
        SYNC_SECRETS_KEY: None,
        MODE_KEY: None,
        FIXED_KEY: None,
        GROUP_KEY: None,
        SYNC_TERMINAL_KEY: None,
    }
    devices = till_devices(db, machine, shop)
    if not devices:
        return out
    out[SYNC_DEVICES_KEY] = _dumps([till_device(d) for d in devices])
    choice = till_choice(merged, [str(d.id) for d in devices])
    if merged.get(MODE_KEY) in MODES:
        out[MODE_KEY] = merged[MODE_KEY]
    out[FIXED_KEY] = choice["fixedDeviceId"]
    if choice["groupDeviceIds"]:
        out[GROUP_KEY] = _dumps(choice["groupDeviceIds"])
    terminal = merged.get(EXPECTED_TERMINAL_KEY)
    if isinstance(terminal, str) and terminal.strip():
        out[SYNC_TERMINAL_KEY] = terminal.strip()
    if bool(getattr(machine, "has_builtin_terminal", True)):
        return out
    rows = _secret_rows(db, [d.id for d in devices])
    secrets: Dict[str, Dict[str, str]] = {}
    for device in devices:
        entry: Dict[str, str] = {}
        for key in KIND_SECRETS.get(device.kind, ()):
            row = rows.get(_uuid(device.id), {}).get(key)
            value = PS.decrypt(row.ciphertext) if row is not None else None
            if value:
                entry[key] = value
        if entry:
            secrets[str(device.id)] = entry
    if secrets:
        out[SYNC_SECRETS_KEY] = _dumps(secrets)
    return out


def device_for_till(db: Session, machine: Any, device_id: Any) -> PaymentDevice:
    """A device of the till's own shop; 404 `payment_device_not_found` otherwise."""
    device = get_device(db, device_id)
    if device is None or getattr(machine, "shop_id", None) is None or _uuid(device.shop_id) != _uuid(machine.shop_id):
        raise PaymentDeviceError("payment_device_not_found", field="paymentDeviceId", status_code=status.HTTP_404_NOT_FOUND)
    return device


def check_pairing_target(device: PaymentDevice, machine: Any) -> None:
    """A SynqPay device (409 `payment_device_not_synqpay`)."""
    if device.kind != SYNQPAY:
        raise PaymentDeviceError("payment_device_not_synqpay", field="paymentDeviceId", status_code=status.HTTP_409_CONFLICT)


def store_device_pairing(
    db: Session,
    device: PaymentDevice,
    machine: Any,
    api_key: str,
    *,
    serial: Optional[str] = None,
    pos_user_id: Any = None,
    user_id: Any = None,
    now: Optional[datetime] = None,
) -> PaymentIntegrationSecret:
    """
    The key a till got by pairing with this SynqPay device: the device's secret, encrypted, with
    when / which till / whose authority / the serial; the serial lands in the device's config
    when it names none. The caller bumps the shop, commits and notifies.
    """
    value = PS.clean_secret(api_key)
    if value is None or not PS.is_synqpay_api_key(value):
        raise PS.PaymentSecretError("secret_invalid")
    row = _secret_rows(db, [device.id]).get(_uuid(device.id), {}).get(PS.SYNQPAY_API_KEY)
    at = now or datetime.now(timezone.utc)
    if row is None:
        row = _new_secret_row(device, PS.SYNQPAY_API_KEY)
        db.add(row)
    row.ciphertext = PS.encrypt(value)
    row.updated_by = _uuid(user_id)
    row.updated_at = at
    PS._set_origin(
        row, ORIGIN_TILL_PAIRING, paired_at=at, machine_id=machine.id,
        pos_user_id=pos_user_id, user_id=user_id, serial=serial,
    )
    config = _as_dict(device.config)
    if serial and not (isinstance(config.get("serialNumber"), str) and config["serialNumber"].strip()):
        config["serialNumber"] = serial
        device.config = config
        device.updated_at = at
    db.flush()
    return row


# ── "קישור מחדש": an Agamento handheld that moved on the LAN ──────────────────

#: The till event that records each move (`till_events.event_type`, 32 characters at most).
DEVICE_HOST_EVENT = "payment_device_host_set"


class DeviceRelinkRefused(Exception):
    """A move the cloud does not make. [code] is the API's `detail`, [status_code] its status."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message


def _merged_expected_terminal(db: Session, machine: Any) -> Optional[str]:
    """The till's `expectedTerminalNumber` merged over ALL its layers (as `paymentDevicesTerminalNumber`)."""
    from app.models.company import Company
    from app.models.tenant import Tenant
    from app.services.areas import get_area
    from app.services.settings_merge import merge_all_settings_layers

    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    company = db.query(Company).filter(Company.id == shop.company_id).first() if shop is not None else None
    if company is None:
        return None
    tenant = db.query(Tenant).filter(Tenant.id == company.tenant_id).first() if company.tenant_id else None
    area = get_area(db, getattr(machine, "area_id", None))
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    value = merged.get(EXPECTED_TERMINAL_KEY)
    return value.strip() if isinstance(value, str) and value.strip() else None


def relink_device_host(
    db: Session,
    machine: Any,
    device_id: Any,
    *,
    host: Any,
    port: Any = None,
    reason: str = "relocated",
    terminal_number: Optional[str] = None,
    serial: Optional[str] = None,
    previous_host: Optional[str] = None,
    mac: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    `PUT /sync/{machine_id}/payment-devices/{device_id}/host` — an Agamento LAN handheld of the
    till's shop, found by the till at a new address (its read-only sweep, as the kiosk's
    PinpadRelinker), or picked on the technician screen. The rules of `relink_pinpad`
    (app/services/payment_terminal.py), for a device instead of the till's own pinpad:

    * a device of the till's shop (404 `payment_device_not_found`), an `agamento_lan` one
      (409 `payment_device_not_agamento_lan`); never from a kiosk (409 `payment_device_kiosk`);
    * a private IPv4 address (422 `host_invalid` / `host_not_private` / `port_invalid`);
    * a move the till made by itself (`relocated`) names the terminal it found there, and it must
      be the device's own terminal number — else the till's merged expected one — when one is set
      (422 `terminal_number_required`, 409 `terminal_mismatch`): never another business's pinpad.

    Only `config.host` (and `config.port` when given) change; path, https, MAC and terminal number
    stay. The same address again is answered `unchanged` with nothing written. A move is a till
    event (`payment_device_host_set`, naming the device) and a log line; the shop's stamp moves.
    The caller commits and notifies the shop's tills.
    """
    import ipaddress

    from app.models.audit_exception import TillEvent
    from app.services.payment_terminal import (
        RELINK_REASONS,
        RELINK_RELOCATED,
        clean_pinpad_port,
        same_terminal,
    )

    reason = (reason or RELINK_RELOCATED).strip()
    if reason not in RELINK_REASONS:
        raise DeviceRelinkRefused(422, "reason_invalid", "סיבה לא מוכרת")
    if bool(getattr(machine, "is_kiosk", False)):
        raise DeviceRelinkRefused(409, "payment_device_kiosk", MESSAGES_HE["payment_device_kiosk"])
    device = get_device(db, device_id)
    if device is None or getattr(machine, "shop_id", None) is None or _uuid(device.shop_id) != _uuid(machine.shop_id):
        raise DeviceRelinkRefused(404, "payment_device_not_found", MESSAGES_HE["payment_device_not_found"])
    if device.kind != AGAMENTO_LAN:
        raise DeviceRelinkRefused(409, "payment_device_not_agamento_lan", "המכשיר אינו מסופון Agamento ברשת")
    try:
        clean_host = clean_pinpad_host(host)
        clean_port = clean_pinpad_port(port) if port is not None else None
    except PinpadAddressError as exc:
        raise DeviceRelinkRefused(422, exc.code, "כתובת המכשיר אינה תקינה") from None
    try:
        private = ipaddress.IPv4Address(clean_host).is_private
    except ValueError:
        private = False
    if not private:
        raise DeviceRelinkRefused(422, "host_not_private", "המכשיר חייב להיות בכתובת IP פרטית ברשת המקומית")

    config = _as_dict(device.config)
    current = config.get("host")
    current_port = config.get("port") if isinstance(config.get("port"), int) else DEFAULT_PORT
    own_terminal = config.get("terminalNumber") if isinstance(config.get("terminalNumber"), str) else None
    expected = own_terminal or _merged_expected_terminal(db, machine)
    number = (terminal_number or "").strip() or None
    if reason == RELINK_RELOCATED:
        if number is None:
            raise DeviceRelinkRefused(422, "terminal_number_required", "חסר מספר המסוף שנמצא בכתובת החדשה")
        if expected is not None and not same_terminal(expected, number):
            raise DeviceRelinkRefused(
                409, "terminal_mismatch",
                f"המסופון שנמצא (מסוף {number}) אינו המסוף של המכשיר \"{device.nickname}\" ({expected})",
            )
    unchanged = current == clean_host and (clean_port is None or clean_port == current_port)
    out = {
        "deviceId": str(device.id),
        "host": clean_host,
        "port": clean_port if clean_port is not None else current_port,
        "previousHost": current,
        "reason": reason,
        "terminalMatches": same_terminal(expected, number) if expected is not None and number is not None else None,
        "unchanged": unchanged,
    }
    if unchanged:
        return out
    moment = now or datetime.now(timezone.utc)
    config["host"] = clean_host
    if clean_port is not None:
        config["port"] = clean_port
    device.config = config
    device.updated_at = moment
    shop = db.query(Shop).filter(Shop.id == device.shop_id).first()
    if shop is not None:
        touch_shop(shop)
    db.add(TillEvent(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        event_type=DEVICE_HOST_EVENT,
        occurred_at=moment,
        details={
            "deviceId": str(device.id),
            "deviceNickname": device.nickname,
            "from": current,
            "fromPort": current_port,
            "to": clean_host,
            "toPort": out["port"],
            "reason": reason,
            "terminalNumber": number,
            "expectedTerminalNumber": expected,
            "serial": (serial or "").strip()[:60] or None,
            "mac": (mac or "").strip()[:32] or None,
            "tillPreviousHost": (previous_host or "").strip()[:300] or None,
        },
    ))
    logger.info(
        "payment device %s (%s) moved %s:%s -> %s:%s by till %s (%s, terminal %s, expected %s)",
        device.id, device.nickname, current, current_port, clean_host, out["port"], machine.id, reason, number, expected,
    )
    db.flush()
    return out


def mark_device_key_rejected(db: Session, device: PaymentDevice, machine: Any, *, now: Optional[datetime] = None):
    """The device refused its key, as [machine] reported: marked once. None when it has no key."""
    row = _secret_rows(db, [device.id]).get(_uuid(device.id), {}).get(PS.SYNQPAY_API_KEY)
    if row is None:
        return None
    if row.rejected_at is None:
        row.updated_at = PaymentIntegrationSecret.updated_at
        row.rejected_at = now or datetime.now(timezone.utc)
        row.rejected_by_machine_id = _uuid(machine.id)
        db.flush()
    return row
