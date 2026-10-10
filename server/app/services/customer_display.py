"""
"מסך לקוח" — the customer-facing screen of a till (P:/specs/customer-display.md).

Two routes, one configuration:

* **A second screen on the till itself** (Android `Presentation`): iMin / SUNMI dual-screen
  units, LANDI / Feitian docks with a second screen, an HDMI or USB-C monitor. The till finds
  it by itself; nothing is paired.
* **A separate device paired as the customer display of till X**: an Android device running
  the APK, or any browser at `/display`. Non-fiscal (`is_fiscal = false`), role
  `customer_display`; which till it mirrors is its own layer's `mirrorTillId`. It reads the
  till's screen state over the shop's LAN first (the till's LAN server, `GET /display/state`
  with the till's display token), else through the cloud relay here (`customer_display_states`).

**The settings** are one key, `customerDisplay` (an object), in the settings JSON every layer
already has: company → shop → area (point of sale) → machine. Merged field by field, the
deepest layer that sets a field winning (`playlist` and `show` replace as a whole); defaults
below. Nothing here touches the till's settings sync (`MANAGED_SETTING_KEYS`): the device pulls
its resolved configuration from `GET /sync/{m}/customer-display`.

**Read only.** The state a till publishes is what the customer sees anyway: lines, totals,
the tip, the payment's progress, the change. Never the cashier, the customer, a card or a
document number — the relay keeps only a bounded JSON object and gives it back as it is.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

#: The key in each layer's settings JSON.
SETTINGS_KEY = "customerDisplay"
#: The levels a value may be set at, least specific first.
LEVELS = ("company", "shop", "area", "machine")

LAYOUTS = ("auto", "split", "full")
THEMES = ("dark", "light", "brand")
LANGUAGES = ("auto", "he", "en")
#: What the screen may show; each one a switch, all on by default.
SHOW_KEYS = ("items", "prices", "modifiers", "promotions", "vouchers", "totals", "tip", "payment", "change", "thanks")
MEDIA_KINDS = ("image", "video")

PLAYLIST_MAX = 20
DURATION_MIN, DURATION_MAX, DURATION_DEFAULT = 3, 300, 8
IDLE_MIN, IDLE_MAX, IDLE_DEFAULT = 0, 3600, 30
THANKS_MIN, THANKS_MAX, THANKS_DEFAULT = 2, 60, 6
TEXT_MAX = 80
URL_MAX = 500
#: One file of the playlist at most — the upload's own limit (`POST /images/media`, 25 MB).
MEDIA_MAX_BYTES = 25 * 1024 * 1024

DEFAULTS: Dict[str, Any] = {
    "enabled": False,
    "layout": "auto",
    "theme": "dark",
    "show": {k: True for k in SHOW_KEYS},
    "playlist": [],
    "logoUrl": "",
    "language": "auto",
    "idleTimeoutSec": IDLE_DEFAULT,
    "thanksSec": THANKS_DEFAULT,
    "welcomeText": "",
    "thanksText": "",
}

#: Set by the server only, on a paired display device's own layer (`apply_on_pairing`): the
#: machine is a customer display. Never accepted from the dashboard, never dropped by its writes.
DEVICE_FLAG = "device"
MIRROR_KEY = "mirrorTillId"
FIELDS = tuple(DEFAULTS) + (MIRROR_KEY,)

#: The relay: a state at most this big, and one older than this reads as idle (a till that
#: stopped publishing mid-sale must not leave a basket on the customer's screen for ever).
STATE_MAX_BYTES = 64 * 1024
STATE_STALE_AFTER = timedelta(minutes=10)

#: How often the devices ask — sent with the configuration, so the cloud can slow them down.
POLL = {"configSec": 120, "relayMs": 1500, "lanMs": 700, "pushCoalesceMs": 400}


class CustomerDisplayError(ValueError):
    """A layer the dashboard sent that does not fit: `code` for the client, `message` in Hebrew."""

    def __init__(self, code: str, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field

    def body(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.field:
            out["field"] = self.field
        return out


def _bad(field: str, message: str) -> CustomerDisplayError:
    return CustomerDisplayError("customer_display_invalid", message, field)


# ── One field ────────────────────────────────────────────────────────────────


def _int_in(value: Any, low: int, high: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        value = int(value)
    return value if low <= value <= high else None


def _url(value: Any) -> Optional[str]:
    """An https:// URL, or this server's own media store (a development server serves it over http)."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or len(v) > URL_MAX:
        return None
    if v.startswith("https://"):
        return v
    from app.services import local_media

    if v.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/"):
        return v
    return None


def _text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = " ".join(value.split())
    return v if len(v) <= TEXT_MAX else None


def clean_playlist_item(raw: Any) -> Optional[Dict[str, Any]]:
    """One slide as stored: `{url, kind, durationSec, bytes?}`, or None when it does not fit."""
    if not isinstance(raw, dict):
        return None
    url = _url(raw.get("url"))
    kind = raw.get("kind")
    if url is None or kind not in MEDIA_KINDS:
        return None
    duration = raw.get("durationSec", DURATION_DEFAULT)
    duration = _int_in(duration, DURATION_MIN, DURATION_MAX)
    if duration is None:
        return None
    item: Dict[str, Any] = {"url": url, "kind": kind, "durationSec": duration}
    size = raw.get("bytes")
    if size is not None:
        size = _int_in(size, 1, MEDIA_MAX_BYTES)
        if size is None:
            return None
        item["bytes"] = size
    return item


def clean_field(key: str, value: Any) -> Any:
    """`value` as stored for `key`; raises `CustomerDisplayError` (Hebrew) when it does not fit."""
    if key == "enabled":
        if not isinstance(value, bool):
            raise _bad(key, "\"הפעלה\" צריך להיות כן או לא.")
        return value
    if key == "layout":
        if value not in LAYOUTS:
            raise _bad(key, "פריסה לא מוכרת.")
        return value
    if key == "theme":
        if value not in THEMES:
            raise _bad(key, "ערכת צבע לא מוכרת.")
        return value
    if key == "language":
        if value not in LANGUAGES:
            raise _bad(key, "שפה לא מוכרת.")
        return value
    if key == "show":
        if not isinstance(value, dict) or set(value) - set(SHOW_KEYS):
            raise _bad(key, "\"מה להציג\" מכיל ערך לא מוכר.")
        if not all(isinstance(v, bool) for v in value.values()):
            raise _bad(key, "כל מתג ב\"מה להציג\" הוא כן או לא.")
        # Completed: a switch left out is on, so a stored `show` is always the whole set.
        return {k: value.get(k, True) for k in SHOW_KEYS}
    if key == "playlist":
        if not isinstance(value, list):
            raise _bad(key, "המצגת צריכה להיות רשימה.")
        if len(value) > PLAYLIST_MAX:
            raise _bad(key, f"עד {PLAYLIST_MAX} תמונות וסרטונים במצגת.")
        out = []
        for i, raw in enumerate(value):
            item = clean_playlist_item(raw)
            if item is None:
                raise _bad(
                    key,
                    f"פריט {i + 1} במצגת לא תקין: נדרשים קישור https מההעלאה, סוג (תמונה / סרטון) "
                    f"ומשך של {DURATION_MIN}–{DURATION_MAX} שניות.",
                )
            out.append(item)
        return out
    if key == "logoUrl":
        if value == "":
            return ""
        url = _url(value)
        if url is None:
            raise _bad(key, "הלוגו צריך להיות קישור https מההעלאה.")
        return url
    if key == "idleTimeoutSec":
        v = _int_in(value, IDLE_MIN, IDLE_MAX)
        if v is None:
            raise _bad(key, f"זמן עד מצגת: מספר שלם של {IDLE_MIN}–{IDLE_MAX} שניות.")
        return v
    if key == "thanksSec":
        v = _int_in(value, THANKS_MIN, THANKS_MAX)
        if v is None:
            raise _bad(key, f"זמן מסך התודה: מספר שלם של {THANKS_MIN}–{THANKS_MAX} שניות.")
        return v
    if key in ("welcomeText", "thanksText"):
        v = _text(value)
        if v is None:
            raise _bad(key, f"טקסט של עד {TEXT_MAX} תווים.")
        return v
    if key == MIRROR_KEY:
        if value is None:
            return None
        try:
            return str(uuid.UUID(str(value)))
        except (TypeError, ValueError, AttributeError):
            raise _bad(key, "הקופה לשיקוף לא תקינה.")
    raise _bad(key, f"שדה לא מוכר: {key}")


def clean_layer(raw: Any, *, level: str) -> Optional[Dict[str, Any]]:
    """
    A layer as the dashboard sends it, cleaned for storage: only the fields it sets (the rest
    inherit), `None` = the layer holds nothing (inherits everything). `mirrorTillId` belongs to
    a device's own layer only; the server's own `device` flag is never accepted from outside.
    """
    if raw is None:
        return None
    if level not in LEVELS:
        raise CustomerDisplayError("customer_display_level", "רמה לא מוכרת.")
    if not isinstance(raw, dict):
        raise _bad(SETTINGS_KEY, "ההגדרות צריכות להיות אובייקט.")
    out: Dict[str, Any] = {}
    for key, value in raw.items():
        if key == DEVICE_FLAG:
            continue
        if key == MIRROR_KEY and level != "machine":
            raise _bad(key, "קופה לשיקוף נקבעת רק במכשיר מסך הלקוח עצמו.")
        if key not in FIELDS:
            raise _bad(key, f"שדה לא מוכר: {key}")
        if value is None:
            continue
        out[key] = clean_field(key, value)
    return out


# ── The layers ───────────────────────────────────────────────────────────────


def layer_of(settings: Any) -> Dict[str, Any]:
    """The `customerDisplay` object a layer's settings JSON holds, or {}."""
    if not isinstance(settings, dict):
        return {}
    raw = settings.get(SETTINGS_KEY)
    return dict(raw) if isinstance(raw, dict) else {}


def resolve(layers: Sequence[Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """
    The configuration and, per field, the level it comes from. `layers` are `(level, layer
    dict)` least specific first. A stored value that no longer fits (written around the API,
    an older shape) is passed over, so the field falls through to the level above — the device
    never receives something it cannot read.
    """
    effective = json.loads(json.dumps(DEFAULTS))
    sources: Dict[str, str] = {}
    for level, layer in layers:
        if not isinstance(layer, dict):
            continue
        for key in DEFAULTS:
            if key not in layer or layer[key] is None:
                continue
            try:
                effective[key] = clean_field(key, layer[key])
            except CustomerDisplayError:
                continue
            sources[key] = level
    return effective, sources


def _area_of(db: Session, machine: Any):
    from app.services.areas import get_area

    return get_area(db, getattr(machine, "area_id", None)) if getattr(machine, "shop_id", None) else None


def _parents(db: Session, machine: Any):
    from app.models.company import Company
    from app.models.shop import Shop

    shop = db.get(Shop, machine.shop_id) if getattr(machine, "shop_id", None) else None
    company = db.get(Company, shop.company_id) if shop is not None else None
    return company, shop, _area_of(db, machine)


def chain_for_machine(db: Session, machine: Any) -> List[Tuple[str, Dict[str, Any]]]:
    company, shop, area = _parents(db, machine)
    return [
        ("company", layer_of(getattr(company, "settings", None))),
        ("shop", layer_of(getattr(shop, "settings", None))),
        ("area", layer_of(getattr(area, "settings", None))),
        ("machine", layer_of(getattr(machine, "settings", None))),
    ]


def effective_for_machine(db: Session, machine: Any) -> Tuple[Dict[str, Any], Dict[str, str]]:
    return resolve(chain_for_machine(db, machine))


# ── Display devices ──────────────────────────────────────────────────────────


def is_display_device(machine: Any) -> bool:
    """A machine paired as a customer display: non-fiscal, flagged on its own layer."""
    if getattr(machine, "is_fiscal", True) is not False:
        return False
    return layer_of(getattr(machine, "settings", None)).get(DEVICE_FLAG) is True


def mirrored_till_id(machine: Any) -> Optional[str]:
    raw = layer_of(getattr(machine, "settings", None)).get(MIRROR_KEY)
    try:
        return str(uuid.UUID(str(raw))) if raw else None
    except (TypeError, ValueError, AttributeError):
        return None


def displays_of_shop(db: Session, shop_id: Any) -> List[Any]:
    """The active customer-display devices of a shop."""
    from app.models.pos_machine import POSMachine

    if shop_id is None:
        return []
    rows = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(False))
        .all()
    )
    return [m for m in rows if is_display_device(m)]


def displays_of_till(db: Session, till: Any) -> List[Any]:
    tid = str(getattr(till, "id", ""))
    return [d for d in displays_of_shop(db, getattr(till, "shop_id", None)) if mirrored_till_id(d) == tid]


def check_till_for_display(db: Session, display_shop_id: Any, till_id: Any) -> Any:
    """The till a display may mirror: an active fiscal machine of the same shop. Raises otherwise."""
    from app.models.pos_machine import POSMachine

    try:
        ident = uuid.UUID(str(till_id))
    except (TypeError, ValueError, AttributeError):
        raise CustomerDisplayError("customer_display_till_invalid", "הקופה לשיקוף לא תקינה.", MIRROR_KEY)
    till = db.get(POSMachine, ident)
    if (
        till is None
        or not getattr(till, "is_active", False)
        or getattr(till, "is_fiscal", True) is False
        or str(getattr(till, "shop_id", None)) != str(display_shop_id)
    ):
        raise CustomerDisplayError(
            "customer_display_till_invalid",
            "הקופה לשיקוף צריכה להיות קופה פעילה באותו סניף של מסך הלקוח.",
            MIRROR_KEY,
        )
    return till


def display_token(till_id: Any) -> str:
    """
    What a customer display presents to its till's LAN server (`Authorization: Bearer …` on
    `GET /display/state`). Derived, not stored — like the shop's print secret, but its own:
    it opens the till's screen state and nothing else.
    """
    from app.config import get_settings

    key = (get_settings().jwt_secret_key or "").encode("utf-8")
    return hmac.new(key, f"customer-display:{till_id}".encode("utf-8"), hashlib.sha256).hexdigest()[:40]


def machine_label(machine: Any) -> str:
    number = (getattr(machine, "pos_number", None) or "").strip()
    name = (getattr(machine, "name", None) or "").strip()
    if number and name:
        return f"קופה {number} · {name}"
    return f"קופה {number}" if number else (name or "קופה")


# ── What a device pulls ──────────────────────────────────────────────────────


def _branding(db: Session, machine: Any, effective: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.settings_merge import merge_all_settings_layers

    company, shop, area = _parents(db, machine)
    merged: Dict[str, Any] = {}
    if company is not None:
        tenant = None
        if getattr(company, "tenant_id", None):
            from app.models.tenant import Tenant

            tenant = db.get(Tenant, company.tenant_id)
        merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    logo = effective.get("logoUrl") or merged.get("brandLogoUrl") or ""
    return {
        "shopName": getattr(shop, "name", None) or getattr(company, "name", None) or "",
        "logoUrl": logo if isinstance(logo, str) else "",
        "primaryColor": merged.get("brandPrimaryColor") if isinstance(merged.get("brandPrimaryColor"), str) else None,
    }


def media_of(effective: Dict[str, Any], branding: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The files the device keeps on its own disk (the kiosk's media cache): the logo first, then
    the playlist in order. Every upload has a URL of its own, so a URL is its version.
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    logo = branding.get("logoUrl")
    if logo:
        out.append({"url": logo, "kind": "image", "bytes": None})
        seen.add(logo)
    for item in effective.get("playlist") or []:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        out.append({"url": item["url"], "kind": item["kind"], "bytes": item.get("bytes")})
    return out


def lan_of(db: Session, till: Any) -> Dict[str, Any]:
    """Where the till's LAN server listens, as it last reported (`kitchen_print_hosts`)."""
    from app.models.printers import DEFAULT_LAN_PORT, KitchenPrintHost

    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == till.id).first()
    address = row.lan_address if row is not None and row.lan_address else None
    return {"address": address, "port": (row.port or DEFAULT_LAN_PORT) if address else None}


def device_payload(db: Session, machine: Any) -> Dict[str, Any]:
    """
    `GET /sync/{m}/customer-display`: the resolved configuration, the shop's branding, the
    media to keep, and the device's part:

    * a till (`role: "till"`): its LAN display token, and `serve` — whether a paired display
      mirrors it (then it serves its state on the LAN and pushes it to the relay);
    * a paired display (`role: "display"`): the till it mirrors, where that till listens on the
      LAN, and the token to show it.
    """
    effective, sources = effective_for_machine(db, machine)
    branding = _branding(db, machine, effective)
    body: Dict[str, Any] = {
        "config": effective,
        "sources": sources,
        "branding": branding,
        "media": media_of(effective, branding),
        "poll": dict(POLL),
    }
    if is_display_device(machine):
        body["role"] = "display"
        till_id = mirrored_till_id(machine)
        till = None
        if till_id:
            try:
                till = check_till_for_display(db, machine.shop_id, till_id)
            except CustomerDisplayError:
                till = None
        body["till"] = (
            {
                "machineId": str(till.id),
                "name": machine_label(till),
                "lan": lan_of(db, till),
                "token": display_token(till.id),
            }
            if till is not None
            else None
        )
    elif getattr(machine, "is_fiscal", True) is False:
        # A KDS / board: a screen of its own, never a customer display (nor a till to mirror).
        body["role"] = "none"
    else:
        displays = displays_of_till(db, machine)
        body["role"] = "till"
        body["token"] = display_token(machine.id)
        body["serve"] = bool(displays)
        body["displays"] = len(displays)
    return body


def etag_of(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return '"' + hashlib.sha1(raw).hexdigest() + '"'


# ── Writing a layer (the dashboard) ──────────────────────────────────────────


def write_layer(entity: Any, level: str, layer: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Store `layer` (already cleaned) as the entity's `customerDisplay`, keeping the server's own
    `device` flag on a display device's layer; `None` / {} clears it. Returns the stored layer.
    A new dict is assigned, so the JSONB change is seen.
    """
    from app.services.settings_merge import utc_now

    settings = dict(entity.settings) if isinstance(entity.settings, dict) else {}
    current = layer_of(settings)
    stored: Dict[str, Any] = dict(layer or {})
    if level == "machine" and current.get(DEVICE_FLAG) is True:
        stored[DEVICE_FLAG] = True
        # A display device keeps the till it mirrors unless the write names another one.
        if MIRROR_KEY not in stored and current.get(MIRROR_KEY):
            stored[MIRROR_KEY] = current[MIRROR_KEY]
    if stored:
        settings[SETTINGS_KEY] = stored
    else:
        settings.pop(SETTINGS_KEY, None)
    entity.settings = settings
    entity.settings_updated_at = utc_now()
    return stored


def apply_on_pairing(machine: Any, options: Optional[Dict[str, Any]]) -> None:
    """
    A customer-display code paired this (non-fiscal) machine: it is a display device from now
    on, showing on, mirroring the till the code named (if any). The caller commits.
    """
    options = options if isinstance(options, dict) else {}
    layer: Dict[str, Any] = {DEVICE_FLAG: True, "enabled": True}
    till = options.get(MIRROR_KEY)
    if till:
        layer[MIRROR_KEY] = str(till)
    settings = dict(machine.settings) if isinstance(machine.settings, dict) else {}
    settings[SETTINGS_KEY] = {**layer_of(settings), **layer}
    machine.settings = settings
    from app.services.settings_merge import utc_now

    machine.settings_updated_at = utc_now()


# ── The relay ────────────────────────────────────────────────────────────────


def clean_state(raw: Any) -> Dict[str, Any]:
    """A till's screen state for the relay: an object of version 1, small. Kept as it is otherwise."""
    if not isinstance(raw, dict) or raw.get("v") != 1:
        raise CustomerDisplayError("customer_display_state_invalid", "מצב מסך לא תקין.")
    if len(json.dumps(raw, ensure_ascii=False).encode("utf-8")) > STATE_MAX_BYTES:
        raise CustomerDisplayError("customer_display_state_too_large", "מצב המסך גדול מדי.")
    return raw


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def put_state(db: Session, till: Any, state: Dict[str, Any]) -> int:
    """The till's latest screen state, replacing the last; its sequence number. The caller commits."""
    from app.models.customer_display import CustomerDisplayState

    state = clean_state(state)
    row = db.get(CustomerDisplayState, till.id)
    if row is None:
        row = CustomerDisplayState(till_machine_id=till.id, seq=0)
        db.add(row)
    row.seq = int(row.seq or 0) + 1
    row.state = state
    row.updated_at = _now()
    db.flush()
    return row.seq


def idle_state() -> Dict[str, Any]:
    return {"v": 1, "seq": 0, "phase": "idle", "lines": [], "promotions": [], "vouchers": [],
            "discount": 0, "total": 0, "itemCount": 0, "tip": None, "payment": None, "cash": None, "thanks": None}


def get_state(db: Session, till_id: Any, after: Optional[int] = None, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    What a display shows: `{seq, state, updatedAt, stale}` — None when nothing newer than
    `after`. A state older than STATE_STALE_AFTER comes back as idle (`stale: true`).
    """
    from app.models.customer_display import CustomerDisplayState

    row = db.get(CustomerDisplayState, uuid.UUID(str(till_id)))
    if row is None:
        if after is not None and after >= 0:
            return None
        return {"seq": 0, "state": idle_state(), "updatedAt": None, "stale": True}
    seq = int(row.seq or 0)
    stamp = _utc(row.updated_at)
    stale = stamp is None or ((now or _now()) - stamp) > STATE_STALE_AFTER
    if after is not None and seq <= after and not stale:
        return None
    return {
        "seq": seq,
        "state": idle_state() if stale else row.state,
        "updatedAt": stamp.isoformat() if stamp else None,
        "stale": stale,
    }


# ── The dashboard's views ────────────────────────────────────────────────────


def layer_view(level: str, entity: Any, parents: Iterable[Tuple[str, Any]]) -> Dict[str, Any]:
    """A layer as the dashboard edits it: its own fields, and what it inherits from above."""
    own = layer_of(getattr(entity, "settings", None))
    own.pop(DEVICE_FLAG, None)
    inherited, inherited_sources = resolve([(lvl, layer_of(getattr(e, "settings", None))) for lvl, e in parents if e is not None])
    effective, sources = resolve(
        [(lvl, layer_of(getattr(e, "settings", None))) for lvl, e in parents if e is not None] + [(level, own)]
    )
    return {
        "level": level,
        "entityId": str(entity.id),
        "own": own,
        "inherited": inherited,
        "inheritedSources": inherited_sources,
        "effective": effective,
        "sources": sources,
        "isDisplayDevice": level == "machine" and is_display_device(entity),
        "settingsUpdatedAt": entity.settings_updated_at.isoformat() if getattr(entity, "settings_updated_at", None) else None,
    }


def display_row(db: Session, display: Any, tills: Dict[str, Any]) -> Dict[str, Any]:
    till_id = mirrored_till_id(display)
    till = tills.get(till_id) if till_id else None
    effective, _ = effective_for_machine(db, display)
    return {
        "machineId": str(display.id),
        "name": display.name,
        "platform": getattr(display, "platform", None),
        "enabled": bool(effective.get("enabled")),
        "mirrorTillId": till_id if till is not None else None,
        "mirrorTillName": machine_label(till) if till is not None else None,
        "lastSeenAt": display.last_heartbeat_at.isoformat() if getattr(display, "last_heartbeat_at", None) else None,
    }
