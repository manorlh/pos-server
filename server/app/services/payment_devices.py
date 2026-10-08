"""
"מכשירי תשלום" — several card terminals for a till WITHOUT one of its own.

A till or tablet with no built-in clearing (a P18 — not an F20, whose Agamento is its own)
can work with several payment devices of its shop. Each has a nickname; at card payment the
cashier sends the transaction to one of them. The kinds:

* `zcredit_pinpad` — a Z-Credit PinPad (`pinpadId`; `terminalNumber` / `mode` when this pinpad
  is not on the till's merged `zcreditTerminalNumber` / `zcreditMode`); secret: the terminal
  password (`zcreditPassword`).
* `synqpay` — a SynqPay terminal (model, connection lan | usb, host on lan, protocol, port, TLS,
  USB device, serial number); secret: the API key (`synqpayApiKey`), normally sent up by the
  till that paired with it (`POST /sync/{m}/synqpay/pairing` with `paymentDeviceId`).
* `agamento_lan` — a Nayax handheld running only Agamento, reached over the LAN (TweezerComm
  over plain HTTP, port 8080, path /SPICy); no secret.

It is a feature switch on the usual settings layers: `multiPaymentDevices` (a shop for all its
tills, a till overriding its shop; absent = inherit), and `defaultPaymentDeviceId` (the device
preselected at payment — a shop's, an area's or a till's; refused on a tenant or company, which
have no devices). The kiosk is out of scope: it keeps its one pinpad and is sent nothing here.

What the till gets (`GET /sync/{m}/settings`, inside `settings`):

* `paymentDevices` — a JSON *string*: the devices of its shop that apply to it (`machine_ids`
  empty or naming it), inactive ones included (a card left unresolved on a device switched off
  must still be followed up), by `sort_order` then nickname:
  `[{"id", "nickname", "kind", "active", "sortOrder", "config": {...}}]`. Absent when none.
* `paymentDeviceSecrets` — a JSON *string* `{"<deviceId>": {"zcreditPassword"?, "synqpayApiKey"?}}`
  in the clear, only to a till without a built-in terminal, only for the devices above. Absent
  when empty. Never logged, never in a dashboard answer.
* `defaultPaymentDeviceId` — the merged value, sent only when it names one of those devices.

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
from app.services.settings_merge import patch_settings_json, utc_now

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
#: the old kind's.
KIND_SECRETS: Dict[str, Tuple[str, ...]] = {
    ZCREDIT_PINPAD: (PS.ZCREDIT_PASSWORD,),
    SYNQPAY: (PS.SYNQPAY_API_KEY,),
    AGAMENTO_LAN: (),
}
DEVICE_SECRET_KEYS: Tuple[str, ...] = (PS.ZCREDIT_PASSWORD, PS.SYNQPAY_API_KEY)

#: `payment_integration_secrets.level` of a device's secret (entity_id = the device's id).
SECRET_LEVEL = "payment_device"

# ── Settings keys (managed: app/services/settings_merge.py) ───────────────────

MULTI_KEY = "multiPaymentDevices"
DEFAULT_KEY = "defaultPaymentDeviceId"
SETTING_KEYS: Tuple[str, ...] = (MULTI_KEY, DEFAULT_KEY)
#: Keys of the till's settings sync (JSON strings).
SYNC_DEVICES_KEY = "paymentDevices"
SYNC_SECRETS_KEY = "paymentDeviceSecrets"

NOTIFY_REASON = "payment_devices_updated"

SORT_ORDER_MAX = 9999

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
    "mode_invalid": "מצב — בדיקה או ייצור",
    "model_required": "יש לבחור את דגם המסוף",
    "model_invalid": "דגם מסוף לא מוכר",
    "connection_required": "יש לבחור סוג חיבור — רשת או USB",
    "connection_invalid": "סוג חיבור לא מוכר",
    "protocol_invalid": "פרוטוקול — TCP או HTTP",
    "tls_invalid": "ערך TLS לא תקין",
    "usb_device_invalid": "התקן USB — VVVV:PPPP בהקס (למשל 0B00:0080), או ריק לזיהוי אוטומטי",
    "serial_invalid": "מספר סידורי — 4–32 אותיות באנגלית, ספרות או מקף",
    "machine_ids_invalid": "רשימת הקופות אינה תקינה",
    "machine_not_in_shop": "אחת הקופות שנבחרו אינה קופה של הסניף",
    "machine_is_kiosk": "קיוסק עובד עם המסופון שלו — לא ניתן לשייך לו מכשיר תשלום",
    "sort_order_invalid": f"סדר — מספר שלם בין 0 ל-{SORT_ORDER_MAX}",
    "active_invalid": "ערך 'פעיל' לא תקין",
    "secret_invalid": "עד 200 תווים, ללא תווי בקרה",
    "synqpay_key_invalid": "מפתח API — אותיות באנגלית וספרות בלבד, עד 64 תווים",
    "payment_device_not_found": "מכשיר התשלום לא נמצא",
    "payment_device_level_invalid": "מכשיר ברירת מחדל נקבע ברמת סניף, נקודת מכירה או קופה בלבד",
    "payment_device_not_in_shop": "המכשיר שנבחר אינו מכשיר תשלום של הסניף",
    "payment_device_not_for_machine": "המכשיר שנבחר אינו משויך לקופה הזו",
    "payment_device_not_synqpay": "המכשיר אינו מסוף SynqPay",
}


class PaymentDeviceError(HTTPException):
    """
    A refusal with a machine-readable `detail.code`, the Hebrew `detail.msg` (the key the
    dashboard's error formatter reads) and, for a field, `detail.field` ("nickname",
    "config.host", "machineIds", "zcreditPassword", "defaultPaymentDeviceId"…).
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


def clean_kind(value: Any) -> str:
    if _blank(value):
        raise PaymentDeviceError("kind_required", field="kind")
    text = str(value).strip().lower().replace("-", "_") if isinstance(value, str) else ""
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
    """Digits, 1–20, leading zeros kept; None for blank."""
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
    if _blank(raw.get("pinpadId")):
        raise PaymentDeviceError("pinpad_required", field="config.pinpadId")
    if isinstance(raw.get("pinpadId"), bool):
        raise PaymentDeviceError("pinpad_invalid", field="config.pinpadId")
    try:
        pinpad = PI.clean_pinpad_id(raw.get("pinpadId"))
    except ValueError:
        raise PaymentDeviceError("pinpad_invalid", field="config.pinpadId") from None
    out: Dict[str, Any] = {"pinpadId": pinpad}
    terminal = clean_terminal_number(raw.get("terminalNumber"))
    if terminal:
        out["terminalNumber"] = terminal
    try:
        mode = PI.validate_mode(raw.get("mode"))
    except ValueError:
        raise PaymentDeviceError("mode_invalid", field="config.mode") from None
    if mode:
        out["mode"] = mode
    return out


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

    return {_uuid(row[0]) for row in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_(ids)).all()}


def clean_machine_ids(db: Session, shop: Shop, raw: Any, previous: Iterable[Any] = ()) -> List[str]:
    """
    The tills a device is for (ids as strings, repeats removed, in the order given); empty =
    every till of the shop. Each must be a till of the shop (422 `machine_not_in_shop`), not a
    kiosk (422 `machine_is_kiosk`). An id the device already had that is no longer the shop's
    (the till moved away) is dropped rather than refused, so its form still saves.
    """
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        raise PaymentDeviceError("machine_ids_invalid", field="machineIds")
    wanted: List[uuid.UUID] = []
    for item in raw:
        ident = _uuid(item)
        if ident is None or isinstance(item, bool):
            raise PaymentDeviceError("machine_ids_invalid", field="machineIds")
        if ident not in wanted:
            wanted.append(ident)
    if not wanted:
        return []
    found = {
        m.id: m
        for m in db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all()
        if _uuid(m.shop_id) == _uuid(shop.id)
    }
    kiosks = _kiosk_ids(db, list(found))
    before = {_uuid(x) for x in previous or ()}
    out: List[str] = []
    for ident in wanted:
        if ident not in found or ident in kiosks:
            if ident in before:
                continue
            raise PaymentDeviceError(
                "machine_is_kiosk" if ident in kiosks else "machine_not_in_shop", field="machineIds"
            )
        out.append(str(ident))
    return out


def applies_to(device: PaymentDevice, machine_id: Any) -> bool:
    """For every till of its shop (no list), or for the tills listed."""
    ids = device.machine_ids or []
    if not ids:
        return True
    wanted = _uuid(machine_id)
    return any(_uuid(x) == wanted for x in ids)


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
    The write-only secrets a body carries: key → value to store, or None to remove. Only the
    fields sent; the dashboard's mask ("••••") echoed back is left out (keep). Never echoes a
    value in an error.
    """
    sent = getattr(body, "model_fields_set", set())
    out: Dict[str, Optional[str]] = {}
    for field, key in (("zcredit_password", PS.ZCREDIT_PASSWORD), ("synqpay_api_key", PS.SYNQPAY_API_KEY)):
        if field not in sent:
            continue
        raw = getattr(body, field, None)
        if PS.is_mask(raw):
            continue
        try:
            value = PS.clean_secret(raw)
        except PS.PaymentSecretError:
            raise PaymentDeviceError("secret_invalid", field=key) from None
        if key == PS.SYNQPAY_API_KEY and value is not None and not PS.is_synqpay_api_key(value):
            raise PaymentDeviceError("synqpay_key_invalid", field=key)
        out[key] = value
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
    removed whatever the patch says (a kind change), and never stored. True when anything changed.
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
    """For the dashboard: per secret, whether one is stored (and SynqPay's pairing). Never the value."""
    out: Dict[str, Dict[str, Any]] = {}
    for key in DEVICE_SECRET_KEYS:
        row = rows.get(key)
        entry: Dict[str, Any] = {"set": row is not None, "updatedAt": row.updated_at if row is not None else None}
        if key == PS.SYNQPAY_API_KEY:
            entry.update(PS.pairing_status(db, row))
        out[key] = entry
    return out


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
    """One device as the dashboard gets it: the till's shape, its tills, times, secret status."""
    if rows is None:
        rows = _secret_rows(db, [device.id]).get(_uuid(device.id), {})
    return {
        **till_device(device),
        "shopId": str(device.shop_id),
        "machineIds": [str(x) for x in (device.machine_ids or [])],
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
    machine_ids = clean_machine_ids(db, shop, body.machine_ids)
    sort_order = clean_sort_order(body.sort_order)
    active = clean_active(body.active)
    secrets = secret_patch(body)
    _check_nickname_free(db, shop.id, nickname)
    device = PaymentDevice(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        nickname=nickname,
        kind=kind,
        config=config,
        machine_ids=machine_ids,
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
    kind's secrets. A till taken off the device loses it as its own default device.
    """
    sent = getattr(body, "model_fields_set", set())
    nickname = clean_nickname(body.nickname) if "nickname" in sent else device.nickname
    kind = clean_kind(body.kind) if "kind" in sent else device.kind
    if "config" in sent:
        raw_config = body.config
    else:
        raw_config = device.config if kind == device.kind else {}
    config = clean_config(kind, raw_config)
    machine_ids = (
        clean_machine_ids(db, shop, body.machine_ids, previous=device.machine_ids or [])
        if "machine_ids" in sent
        else [str(x) for x in (device.machine_ids or [])]
    )
    sort_order = clean_sort_order(body.sort_order, int(device.sort_order or 0)) if "sort_order" in sent else device.sort_order
    active = clean_active(body.active, bool(device.active)) if "active" in sent else device.active
    secrets = secret_patch(body)
    if nickname.casefold() != (device.nickname or "").casefold():
        _check_nickname_free(db, shop.id, nickname, except_id=device.id)

    device.nickname = nickname
    device.kind = kind
    device.config = config
    device.machine_ids = machine_ids
    device.sort_order = sort_order
    device.active = active
    device.updated_at = datetime.now(timezone.utc)
    db.flush()
    apply_device_secrets(db, device, secrets, user_id=user_id)
    if machine_ids:
        covered = {_uuid(x) for x in machine_ids}
        _clear_machine_defaults(db, shop, device.id, keep=lambda m: _uuid(m.id) in covered)
    touch_shop(shop)
    return device


def delete_device(db: Session, shop: Shop, device: PaymentDevice) -> None:
    """
    Delete it, its secrets, and every `defaultPaymentDeviceId` naming it — the shop's, its
    areas' and its tills' — in the same transaction. The caller commits and notifies.
    """
    now = utc_now()
    if _as_dict(shop.settings).get(DEFAULT_KEY) == str(device.id):
        shop.settings = patch_settings_json(shop.settings, {DEFAULT_KEY: None})
    from app.models.shop_area import ShopArea

    for area in db.query(ShopArea).filter(ShopArea.shop_id == _uuid(shop.id)).all():
        if _as_dict(area.settings).get(DEFAULT_KEY) == str(device.id):
            area.settings = patch_settings_json(area.settings, {DEFAULT_KEY: None})
            area.settings_updated_at = now
    _clear_machine_defaults(db, shop, device.id, keep=lambda m: False)
    remove_device_secrets(db, device.id)
    db.delete(device)
    touch_shop(shop)


def _clear_machine_defaults(db: Session, shop: Shop, device_id: Any, *, keep) -> None:
    """Remove `defaultPaymentDeviceId` = [device_id] from the shop's tills' own layers, but [keep]'s."""
    now = utc_now()
    for machine in db.query(POSMachine).filter(POSMachine.shop_id == _uuid(shop.id)).all():
        if _as_dict(machine.settings).get(DEFAULT_KEY) != str(device_id) or keep(machine):
            continue
        machine.settings = patch_settings_json(machine.settings, {DEFAULT_KEY: None})
        machine.settings_updated_at = now


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
        "machines": [
            {
                "id": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "hasBuiltinTerminal": bool(m.has_builtin_terminal),
            }
            for m in shop_tills(db, shop.id)
        ],
        "multiPaymentDevices": own.get(MULTI_KEY) if isinstance(own.get(MULTI_KEY), bool) else None,
        "multiPaymentDevicesInherited": inherited,
        "multiPaymentDevicesInheritedSource": source,
        "defaultPaymentDeviceId": own.get(DEFAULT_KEY) if isinstance(own.get(DEFAULT_KEY), str) else None,
        "kinds": [{"value": k, "label": KIND_LABELS_HE[k]} for k in KINDS],
        "canEdit": can_edit,
    }


def machine_page(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """`GET /machines/{id}/payment-devices`: the devices of the till's shop that apply to it."""
    kiosk = bool(machine.is_kiosk)
    devices: List[PaymentDevice] = []
    if machine.shop_id is not None and not kiosk:
        devices = [d for d in shop_devices(db, machine.shop_id) if applies_to(d, machine.id)]
    rows = _secret_rows(db, [d.id for d in devices])
    return {
        "machineId": str(machine.id),
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "hasBuiltinTerminal": bool(machine.has_builtin_terminal),
        "isKiosk": kiosk,
        "devices": [device_out(db, d, rows.get(_uuid(d.id), {})) for d in devices],
    }


# ── Settings PATCH (app/routers/settings.py) ──────────────────────────────────


def check_settings_patch(db: Session, level: str, entity: Any, patch: Dict[str, Any]) -> None:
    """
    `defaultPaymentDeviceId` written on a layer: a device of that shop (a till's: its shop's,
    and one that applies to it). Refused on a tenant or a company — they have no devices. Only
    a *change* is checked: the dashboard sends the whole form on every save, so a value stored
    earlier round-trips unchanged without blocking an unrelated save.
    """
    if DEFAULT_KEY not in patch:
        return
    value = patch.get(DEFAULT_KEY)
    if value is None:
        return
    stored = _as_dict(getattr(entity, "settings", None)).get(DEFAULT_KEY)
    if stored == value:
        return
    field = DEFAULT_KEY
    if level not in ("shop", "area", "machine"):
        raise PaymentDeviceError("payment_device_level_invalid", field=field)
    shop_id = entity.id if level == "shop" else getattr(entity, "shop_id", None)
    device = get_device(db, value)
    if device is None or shop_id is None or _uuid(device.shop_id) != _uuid(shop_id):
        raise PaymentDeviceError("payment_device_not_in_shop", field=field)
    if level == "machine" and not applies_to(device, entity.id):
        raise PaymentDeviceError("payment_device_not_for_machine", field=field)


# ── The till ─────────────────────────────────────────────────────────────────


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def till_devices(db: Session, machine: Any, shop: Any) -> List[PaymentDevice]:
    """The devices [machine] gets: its shop's that apply to it; none for a kiosk."""
    if shop is None or machine is None or bool(getattr(machine, "is_kiosk", False)):
        return []
    return [d for d in shop_devices(db, shop.id) if applies_to(d, machine.id)]


def till_sync_fields(db: Session, machine: Any, shop: Any, merged_default: Any = None) -> Dict[str, Optional[str]]:
    """
    What the till's settings sync adds: `paymentDevices`, `paymentDeviceSecrets` (JSON strings)
    and `defaultPaymentDeviceId` (kept only when it names one of the till's devices). A key
    mapped to None is removed from the sync's settings.
    """
    out: Dict[str, Optional[str]] = {SYNC_DEVICES_KEY: None, SYNC_SECRETS_KEY: None, DEFAULT_KEY: None}
    devices = till_devices(db, machine, shop)
    if not devices:
        return out
    out[SYNC_DEVICES_KEY] = _dumps([till_device(d) for d in devices])
    ids = {str(d.id) for d in devices}
    if isinstance(merged_default, str) and merged_default in ids:
        out[DEFAULT_KEY] = merged_default
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
    """A SynqPay device the till uses (409 `payment_device_not_synqpay` / `payment_device_not_for_machine`)."""
    if device.kind != SYNQPAY:
        raise PaymentDeviceError("payment_device_not_synqpay", field="paymentDeviceId", status_code=status.HTTP_409_CONFLICT)
    if not applies_to(device, machine.id):
        raise PaymentDeviceError(
            "payment_device_not_for_machine", field="paymentDeviceId", status_code=status.HTTP_409_CONFLICT
        )


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
