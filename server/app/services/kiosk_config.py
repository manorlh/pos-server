"""
The self-order kiosk's config: defaults, validation, merge, version, fonts and media.

The config is JSON, camelCase on the wire, stored as PARTIAL override layers:
company → shop → machine (`kiosk_settings`). What a kiosk gets is

    DEFAULT_CONFIG ⊕ company ⊕ shop ⊕ machine

Merge: objects (and the id-keyed maps `texts`, `screenImages`, `catalog.productOrder`,
`catalog.categoryImages`) deep-merge; lists, MediaRefs and scalars replace. In a layer a
key whose value is `null` means "inherit" and is dropped on save. Unknown keys are refused
at every level.

Validation is driven by one declarative schema (`SCHEMA`) so the merge, the layer check,
the full check and the dashboard's limits (`limits()`) cannot drift apart. Errors are a
list of `{path, code, message}`: `path` is dotted with list indexes in brackets
(`messages[0].screens[1]`), `code` is a stable token for the dashboard, `message` a short
English explanation (for `kds_not_available` and `cash_not_supported` the message is the
token itself, as the contract names them).

A stored layer is never trusted blindly: `effective_config` drops whatever no longer
validates in a layer (a key the schema lost, a value out of a narrowed range) and repairs
the few cross-field rules a parent's later change can break below it (warningSec <
inactivitySec, pickup start < max, `bonMode: single` without a printer, the club's URL,
KDS while it is not available). So what a kiosk receives always validates.

KDS hook (docs/SPEC_KDS.md): `kds_available()` is False until the KDS agent ships its
release API. TODO(KDS): when it exists, make `kds_available()` read it, and release a
paid `fulfillmentMode: "KDS"` kiosk order through it — the till calls the KDS release for
the order it posts to `/sync/{id}/kiosk/orders` (source "kiosk", no table), or the server
does on receiving that order; either way the order's `fulfillment_mode` snapshot decides,
never the kiosk's current config.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

# ── The KDS hook ──────────────────────────────────────────────────────────────


def kds_available() -> bool:
    """
    Whether `fulfillmentMode: "KDS"` may be chosen. False until the KDS agent's release API
    exists (docs/SPEC_KDS.md); see the module docstring for the hook to wire then.
    """
    return False


# ── The font catalog (contract §1.2) ─────────────────────────────────────────

_GF = "https://raw.githubusercontent.com/google/fonts/main"


@dataclass(frozen=True)
class KioskFont:
    id: str
    label: str
    css_family: str
    regular: Optional[str] = None
    bold: Optional[str] = None
    variable: bool = False

    def to_wire(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "cssFamily": self.css_family,
            "regular": self.regular,
            "bold": self.bold,
            "variable": self.variable,
        }

    def files(self) -> List[str]:
        return [url for url in (self.regular, self.bold) if url]


FONT_CATALOG: Tuple[KioskFont, ...] = (
    KioskFont("system", "ברירת מחדל של המכשיר", "system-ui"),
    KioskFont("rubik", "Rubik", "Rubik", f"{_GF}/ofl/rubik/Rubik%5Bwght%5D.ttf", None, True),
    KioskFont("heebo", "Heebo", "Heebo", f"{_GF}/ofl/heebo/Heebo%5Bwght%5D.ttf", None, True),
    KioskFont("assistant", "Assistant", "Assistant", f"{_GF}/ofl/assistant/Assistant%5Bwght%5D.ttf", None, True),
    KioskFont(
        "noto_sans_hebrew", "Noto Sans Hebrew", "Noto Sans Hebrew",
        f"{_GF}/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf", None, True,
    ),
    KioskFont("alef", "Alef", "Alef", f"{_GF}/ofl/alef/Alef-Regular.ttf", f"{_GF}/ofl/alef/Alef-Bold.ttf", False),
    KioskFont("varela_round", "Varela Round", "Varela Round", f"{_GF}/ofl/varelaround/VarelaRound-Regular.ttf"),
    KioskFont("secular_one", "Secular One", "Secular One", f"{_GF}/ofl/secularone/SecularOne-Regular.ttf"),
    KioskFont("suez_one", "Suez One", "Suez One", f"{_GF}/ofl/suezone/SuezOne-Regular.ttf"),
    KioskFont(
        "frank_ruhl_libre", "Frank Ruhl Libre", "Frank Ruhl Libre",
        f"{_GF}/ofl/frankruhllibre/FrankRuhlLibre%5Bwght%5D.ttf", None, True,
    ),
)
FONTS_BY_ID: Dict[str, KioskFont] = {f.id: f for f in FONT_CATALOG}


def fonts_wire() -> List[Dict[str, Any]]:
    return [f.to_wire() for f in FONT_CATALOG]


# ── Vocabularies and limits ──────────────────────────────────────────────────

FULFILLMENT_MODES = ("BON", "KDS")
SERVICE_TYPES = ("take_away", "eat_in")
LANGUAGES = ("he", "en", "ar", "ru")
SKIP_CART = ("off", "direct", "confirm")
SOLD_OUT_MODES = ("disable", "hide")
THEME_MODES = ("light", "dark")
CARD_STYLES = ("elevated", "outlined", "flat")
BUTTON_SHAPES = ("pill", "rounded", "square")
GRID_DENSITIES = ("compact", "comfortable", "large")
IMAGE_RATIOS = ("1:1", "4:3", "16:9")
CATEGORY_STYLES = ("chips", "tabs", "images")
TEXT_KEYS = (
    "attractTitle", "attractSubtitle", "attractCta", "serviceTitle", "takeAwayLabel", "eatInLabel",
    "catalogTitle", "cartTitle", "checkoutCta", "payTitle", "payInstruction", "successTitle",
    "successBody", "pickupLabel", "customerTitle", "customerExplain", "pausedTitle", "pausedBody",
    "closedTitle", "closedBody", "helpText", "upsellTitle",
)
SCREEN_IMAGE_KEYS = ("service", "catalogHeader", "cart", "pay", "success", "paused")
ATTRACT_SECTIONS = ("hero", "promos", "categories", "club")
MESSAGE_KINDS = ("banner", "notice", "closed")
MESSAGE_SCREENS = ("attract", "service", "catalog", "cart", "pay", "success", "paused")
MESSAGE_STYLES = ("info", "promo", "warning", "success")
PAYMENT_METHODS = ("card",)
RECEIPT_POLICIES = ("always", "ask", "never")
CUSTOMER_FIELD_MODES = ("off", "optional", "required")
BON_MODES = ("routing", "single")
PICKUP_SCOPES = ("kiosk", "shop")
MEDIA_KINDS = ("image", "video", "font")

TEXT_MAX = 200
MESSAGES_MAX = 30
MESSAGE_TITLE_MAX = 80
MESSAGE_BODY_MAX = 300
PLAYLIST_MAX = 20
FEATURED_MAX = 12
HOURS_RANGES_MAX = 14
TIP_PRESETS_MAX = 4
URL_MAX = 1000
ID_LIST_MAX = 1000
ID_MAX = 64
PICKUP_PREFIX_MAX = 3
MIN_ORDER_MAX = 100_000_000

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_HHMM = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MESSAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_PICKUP_PREFIX = re.compile(r"^[A-Za-z0-9א-ת-]{0,3}$")
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


# ── The defaults (contract §1, exactly) ──────────────────────────────────────

DEFAULT_CONFIG: Dict[str, Any] = {
    "general": {
        "fulfillmentMode": "BON",
        "serviceTypes": ["take_away", "eat_in"],
        "askTableNumber": False,
        "languages": ["he"],
        "skipCart": "off",
        "upsellEnabled": True,
        "searchEnabled": False,
        "notesEnabled": True,
        "quickNotesEnabled": True,
        "showAllergens": True,
        "soldOutMode": "disable",
    },
    "theme": {
        "mode": "light",
        "font": "system",
        "primaryColor": "#1F6FEB",
        "accentColor": "#16A34A",
        "backgroundColor": None,
        "surfaceColor": None,
        "textColor": None,
        "buttonColor": None,
        "buttonTextColor": None,
        "backgroundImage": None,
        "logo": None,
        "cornerRadius": 20,
        "cardStyle": "elevated",
        "buttonShape": "pill",
        "gridDensity": "comfortable",
        "imageRatio": "4:3",
        "categoryStyle": "chips",
        "showDescriptions": True,
    },
    "texts": {},
    "screenImages": {},
    "attract": {
        "sections": ["hero", "promos", "categories"],
        "playlist": [],
        "videoMuted": True,
        "showHelp": True,
    },
    "catalog": {
        "categoryOrder": [],
        "hiddenCategories": [],
        "productOrder": {},
        "hiddenProducts": [],
        "categoryImages": {},
        "featuredProductIds": [],
    },
    "messages": [],
    "hours": {
        "enabled": False,
        "ranges": [{"days": [0, 1, 2, 3, 4, 5, 6], "open": "08:00", "close": "23:00"}],
    },
    "payment": {
        "methods": ["card"],
        "tipEnabled": False,
        "tipPresets": [10, 12, 15],
        "receiptPolicy": "ask",
        "customerName": "optional",
        "customerPhone": "off",
        "minOrderAgorot": 0,
    },
    "printing": {
        "bonMode": "routing",
        "bonPrinterId": None,
        "bonCopies": 1,
        "receiptPrinterId": None,
        # The small customer slip with the pickup number, on the receipt printer —
        # independent of `payment.receiptPolicy`.
        "pickupSlip": True,
    },
    "pickup": {"scope": "kiosk", "prefix": "", "start": 1, "max": 999},
    "timers": {"inactivitySec": 60, "warningSec": 20, "successSec": 12, "attractSlideSec": 8},
    "club": {"enabled": False, "joinUrl": "", "title": "", "body": ""},
    "operations": {"autoCloseAt": "", "pausedTitle": "", "pausedBody": ""},
}


def default_config() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG)


# ── Errors ───────────────────────────────────────────────────────────────────


@dataclass
class Issue:
    path: str
    code: str
    message: str

    def to_wire(self) -> Dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message}


class KioskConfigInvalid(ValueError):
    """The config (or a layer) does not validate; `errors` is the list for the 422."""

    def __init__(self, errors: List[Issue]):
        super().__init__("invalid_kiosk_config")
        self.errors = errors

    def detail(self) -> Dict[str, Any]:
        return {"code": "invalid_kiosk_config", "errors": [e.to_wire() for e in self.errors]}


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _index(path: str, i: int) -> str:
    return f"{path}[{i}]"


# ── The schema ───────────────────────────────────────────────────────────────


class Node:
    """A schema node. `check` validates a complete value; returns it normalised."""

    nullable: bool = False
    #: Objects and maps deep-merge; everything else replaces.
    merges: bool = False

    def check(self, value: Any, path: str, errors: List[Issue]) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError

    def check_layer(self, value: Any, path: str, errors: List[Issue]) -> Any:
        """A layer's value at this node: complete for a leaf; partial for an object / map."""
        return self.check(value, path, errors)


_INVALID = object()


def _fail(errors: List[Issue], path: str, code: str, message: str) -> Any:
    errors.append(Issue(path, code, message))
    return _INVALID


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class Bool(Node):
    def check(self, value, path, errors):
        if not isinstance(value, bool):
            return _fail(errors, path, "invalid_type", "must be true or false")
        return value


class Int(Node):
    def __init__(self, lo: int, hi: int, nullable: bool = False):
        self.lo, self.hi, self.nullable = lo, hi, nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not _is_int(value):
            return _fail(errors, path, "invalid_type", "must be an integer")
        if not self.lo <= value <= self.hi:
            return _fail(errors, path, "out_of_range", f"must be between {self.lo} and {self.hi}")
        return value


class Str(Node):
    def __init__(self, max_len: int, *, min_len: int = 0, pattern: Optional[re.Pattern] = None,
                 pattern_message: str = "invalid format", nullable: bool = False):
        self.max_len, self.min_len, self.pattern = max_len, min_len, pattern
        self.pattern_message, self.nullable = pattern_message, nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str):
            return _fail(errors, path, "invalid_type", "must be a string")
        if len(value) > self.max_len:
            return _fail(errors, path, "too_long", f"at most {self.max_len} characters")
        if len(value) < self.min_len:
            return _fail(errors, path, "required", f"at least {self.min_len} characters")
        if self.pattern is not None and not self.pattern.match(value):
            return _fail(errors, path, "invalid_format", self.pattern_message)
        return value


class Enum(Node):
    def __init__(self, values: Sequence[str], nullable: bool = False):
        self.values, self.nullable = tuple(values), nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or value not in self.values:
            return _fail(errors, path, "invalid_value", f"must be one of: {', '.join(self.values)}")
        return value


class Color(Node):
    def __init__(self, nullable: bool = False):
        self.nullable = nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or not _HEX_COLOR.match(value):
            return _fail(errors, path, "invalid_color", "must be a colour #RRGGBB")
        return value


class HHMM(Node):
    def __init__(self, allow_empty: bool = False):
        self.allow_empty = allow_empty

    def check(self, value, path, errors):
        if self.allow_empty and value == "":
            return value
        if not isinstance(value, str) or not _HHMM.match(value):
            return _fail(errors, path, "invalid_time", "must be a time HH:MM" + (' or ""' if self.allow_empty else ""))
        return value


class IsoDateTime(Node):
    def __init__(self, nullable: bool = True):
        self.nullable = nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or not value:
            return _fail(errors, path, "invalid_datetime", "must be an ISO date-time")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return _fail(errors, path, "invalid_datetime", "must be an ISO date-time")
        return value


def _http_url_ok(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= URL_MAX
        and (value.startswith("https://") or value.startswith("http://"))
        and len(value) > len("https://")
        and not any(ch.isspace() for ch in value)
    )


class Media(Node):
    """MediaRef = {url (http/https, ≤1000), kind, sha256 (64 lowercase hex) | null, bytes | null}."""

    merges = False
    KEYS = ("url", "kind", "sha256", "bytes")

    def __init__(self, kinds: Sequence[str], nullable: bool = False):
        self.kinds, self.nullable = tuple(kinds), nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_media", "must be a media reference {url, kind, sha256, bytes}")
        before = len(errors)
        for key in value:
            if key not in self.KEYS:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
        url = value.get("url")
        if not _http_url_ok(url):
            _fail(errors, _join(path, "url"), "invalid_url", f"must be an http(s) URL of at most {URL_MAX} characters")
        kind = value.get("kind")
        if kind not in self.kinds:
            _fail(errors, _join(path, "kind"), "invalid_value", f"must be one of: {', '.join(self.kinds)}")
        sha = value.get("sha256")
        if sha is not None and (not isinstance(sha, str) or not _SHA256.match(sha)):
            _fail(errors, _join(path, "sha256"), "invalid_sha256", "must be 64 lowercase hex characters or null")
        size = value.get("bytes")
        if size is not None and (not _is_int(size) or size < 0):
            _fail(errors, _join(path, "bytes"), "invalid_type", "must be a non-negative integer or null")
        if len(errors) > before:
            return _INVALID
        return {"url": url, "kind": kind, "sha256": sha, "bytes": size}


class UList(Node):
    """A list (replaced whole by a layer). `unique` refuses duplicates."""

    def __init__(self, item: Node, *, min_len: int = 0, max_len: int = ID_LIST_MAX, unique: bool = False):
        self.item, self.min_len, self.max_len, self.unique = item, min_len, max_len, unique

    def check(self, value, path, errors):
        if not isinstance(value, list):
            return _fail(errors, path, "invalid_type", "must be a list")
        before = len(errors)
        if len(value) > self.max_len:
            _fail(errors, path, "too_many", f"at most {self.max_len} items")
        if len(value) < self.min_len:
            _fail(errors, path, "too_few", f"at least {self.min_len} item(s)")
        out = []
        seen = set()
        for i, item in enumerate(value):
            cleaned = self.item.check(item, _index(path, i), errors)
            if cleaned is _INVALID:
                continue
            if self.unique:
                marker = json.dumps(cleaned, sort_keys=True)
                if marker in seen:
                    _fail(errors, _index(path, i), "duplicate", "duplicate value")
                    continue
                seen.add(marker)
            out.append(cleaned)
        if len(errors) > before:
            return _INVALID
        return out


class Obj(Node):
    """
    An object with fixed keys. Complete (`check`): every key required unless it has a
    `fill` default (list items), unknown keys refused. As a layer (`check_layer`): every
    key optional, `null` = inherit (dropped), unknown keys refused.
    """

    merges = True

    def __init__(self, fields: Dict[str, Node], *, fill: Optional[Dict[str, Any]] = None, merges: bool = True):
        self.fields = fields
        self.fill = fill or {}
        self.merges = merges

    def check(self, value, path, errors):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        before = len(errors)
        out: Dict[str, Any] = {}
        for key in value:
            if key not in self.fields:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
        for key, node in self.fields.items():
            if key in value:
                raw = value[key]
            elif key in self.fill:
                raw = copy.deepcopy(self.fill[key])
            else:
                _fail(errors, _join(path, key), "required", "required")
                continue
            cleaned = node.check(raw, _join(path, key), errors)
            if cleaned is not _INVALID:
                out[key] = cleaned
        if len(errors) > before:
            return _INVALID
        return out

    def check_layer(self, value, path, errors):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        out: Dict[str, Any] = {}
        for key, raw in value.items():
            node = self.fields.get(key)
            if node is None:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
                continue
            if raw is None:
                continue  # inherit
            cleaned = node.check_layer(raw, _join(path, key), errors) if node.merges else node.check(
                raw, _join(path, key), errors
            )
            if cleaned is not _INVALID:
                out[key] = cleaned
        return out


class Map(Node):
    """An id-keyed object (`texts`, `screenImages`, `productOrder`, `categoryImages`)."""

    merges = True

    def __init__(self, value: Node, *, keys: Optional[Sequence[str]] = None, max_keys: int = ID_LIST_MAX):
        self.value, self.keys, self.max_keys = value, tuple(keys) if keys else None, max_keys

    def _key_ok(self, key: Any) -> bool:
        if self.keys is not None:
            return key in self.keys
        return isinstance(key, str) and 0 < len(key) <= ID_MAX

    def _walk(self, value, path, errors, layer: bool):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        before = len(errors)
        if len(value) > self.max_keys:
            _fail(errors, path, "too_many", f"at most {self.max_keys} keys")
        out: Dict[str, Any] = {}
        for key, raw in value.items():
            if not self._key_ok(key):
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
                continue
            if raw is None and (layer or self.value.nullable):
                if not layer:
                    out[key] = None
                continue  # in a layer: inherit
            cleaned = self.value.check(raw, _join(path, key), errors)
            if cleaned is not _INVALID:
                out[key] = cleaned
        if not layer and len(errors) > before:
            return _INVALID
        return out

    def check(self, value, path, errors):
        return self._walk(value, path, errors, layer=False)

    def check_layer(self, value, path, errors):
        return self._walk(value, path, errors, layer=True)


ID = Str(ID_MAX, min_len=1)
PRINTER_ID = Str(36, min_len=36, pattern=_UUID, pattern_message="must be a printer id (UUID)", nullable=True)

MESSAGE = Obj(
    {
        "id": Str(40, min_len=1, pattern=_MESSAGE_ID, pattern_message="1-40 characters of A-Z a-z 0-9 _ -"),
        "kind": Enum(MESSAGE_KINDS),
        "enabled": Bool(),
        "title": Str(MESSAGE_TITLE_MAX),
        "body": Str(MESSAGE_BODY_MAX),
        "image": Media(("image",), nullable=True),
        "screens": UList(Enum(MESSAGE_SCREENS), max_len=len(MESSAGE_SCREENS), unique=True),
        "style": Enum(MESSAGE_STYLES),
        "productId": Str(ID_MAX, min_len=1, nullable=True),
        "startsAt": IsoDateTime(),
        "endsAt": IsoDateTime(),
    },
    fill={
        "enabled": True, "title": "", "body": "", "image": None, "screens": ["attract", "catalog"],
        "style": "promo", "productId": None, "startsAt": None, "endsAt": None,
    },
    merges=False,
)

PLAYLIST_ITEM = Obj(
    {"media": Media(("image", "video")), "durationSec": Int(2, 120)},
    fill={"durationSec": 8},
    merges=False,
)

HOURS_RANGE = Obj(
    {
        "days": UList(Int(0, 6), min_len=1, max_len=7, unique=True),
        "open": HHMM(),
        "close": HHMM(),
    },
    merges=False,
)

SCHEMA = Obj({
    "general": Obj({
        "fulfillmentMode": Enum(FULFILLMENT_MODES),
        "serviceTypes": UList(Enum(SERVICE_TYPES), min_len=1, max_len=len(SERVICE_TYPES), unique=True),
        "askTableNumber": Bool(),
        "languages": UList(Enum(LANGUAGES), min_len=1, max_len=len(LANGUAGES), unique=True),
        "skipCart": Enum(SKIP_CART),
        "upsellEnabled": Bool(),
        "searchEnabled": Bool(),
        "notesEnabled": Bool(),
        "quickNotesEnabled": Bool(),
        "showAllergens": Bool(),
        "soldOutMode": Enum(SOLD_OUT_MODES),
    }),
    "theme": Obj({
        "mode": Enum(THEME_MODES),
        "font": Enum(tuple(FONTS_BY_ID)),
        "primaryColor": Color(),
        "accentColor": Color(),
        "backgroundColor": Color(nullable=True),
        "surfaceColor": Color(nullable=True),
        "textColor": Color(nullable=True),
        "buttonColor": Color(nullable=True),
        "buttonTextColor": Color(nullable=True),
        "backgroundImage": Media(("image",), nullable=True),
        "logo": Media(("image",), nullable=True),
        "cornerRadius": Int(0, 40),
        "cardStyle": Enum(CARD_STYLES),
        "buttonShape": Enum(BUTTON_SHAPES),
        "gridDensity": Enum(GRID_DENSITIES),
        "imageRatio": Enum(IMAGE_RATIOS),
        "categoryStyle": Enum(CATEGORY_STYLES),
        "showDescriptions": Bool(),
    }),
    "texts": Map(Str(TEXT_MAX), keys=TEXT_KEYS),
    "screenImages": Map(Media(("image",), nullable=True), keys=SCREEN_IMAGE_KEYS),
    "attract": Obj({
        "sections": UList(Enum(ATTRACT_SECTIONS), max_len=len(ATTRACT_SECTIONS), unique=True),
        "playlist": UList(PLAYLIST_ITEM, max_len=PLAYLIST_MAX),
        "videoMuted": Bool(),
        "showHelp": Bool(),
    }),
    "catalog": Obj({
        "categoryOrder": UList(ID, unique=True),
        "hiddenCategories": UList(ID, unique=True),
        "productOrder": Map(UList(ID, unique=True)),
        "hiddenProducts": UList(ID, unique=True),
        "categoryImages": Map(Media(("image",))),
        "featuredProductIds": UList(ID, max_len=FEATURED_MAX, unique=True),
    }),
    "messages": UList(MESSAGE, max_len=MESSAGES_MAX),
    "hours": Obj({
        "enabled": Bool(),
        "ranges": UList(HOURS_RANGE, max_len=HOURS_RANGES_MAX),
    }),
    "payment": Obj({
        # "cash" is refused with its own code (`_cross_field`), before the enum would.
        "methods": UList(Str(32, min_len=1), min_len=1, max_len=4, unique=True),
        "tipEnabled": Bool(),
        "tipPresets": UList(Int(1, 50), max_len=TIP_PRESETS_MAX, unique=True),
        "receiptPolicy": Enum(RECEIPT_POLICIES),
        "customerName": Enum(CUSTOMER_FIELD_MODES),
        "customerPhone": Enum(CUSTOMER_FIELD_MODES),
        "minOrderAgorot": Int(0, MIN_ORDER_MAX),
    }),
    "printing": Obj({
        "bonMode": Enum(BON_MODES),
        "bonPrinterId": PRINTER_ID,
        "bonCopies": Int(1, 3),
        "receiptPrinterId": PRINTER_ID,
        "pickupSlip": Bool(),
    }),
    "pickup": Obj({
        "scope": Enum(PICKUP_SCOPES),
        "prefix": Str(PICKUP_PREFIX_MAX, pattern=_PICKUP_PREFIX, pattern_message="up to 3 of A-Z a-z 0-9 א-ת -"),
        "start": Int(1, 9998),
        "max": Int(2, 9999),
    }),
    "timers": Obj({
        "inactivitySec": Int(15, 600),
        "warningSec": Int(5, 120),
        "successSec": Int(4, 120),
        "attractSlideSec": Int(3, 60),
    }),
    "club": Obj({
        "enabled": Bool(),
        "joinUrl": Str(URL_MAX),
        "title": Str(MESSAGE_TITLE_MAX),
        "body": Str(MESSAGE_BODY_MAX),
    }),
    "operations": Obj({
        "autoCloseAt": HHMM(allow_empty=True),
        "pausedTitle": Str(MESSAGE_TITLE_MAX),
        "pausedBody": Str(MESSAGE_BODY_MAX),
    }),
})


def limits() -> Dict[str, Any]:
    """The ranges and vocabularies validation uses, for the dashboard's form (`GET /kiosks/defaults`)."""
    return {
        "theme": {"cornerRadius": {"min": 0, "max": 40}},
        "timers": {
            "inactivitySec": {"min": 15, "max": 600},
            "warningSec": {"min": 5, "max": 120, "lessThan": "inactivitySec"},
            "successSec": {"min": 4, "max": 120},
            "attractSlideSec": {"min": 3, "max": 60},
        },
        "attract": {"playlistMax": PLAYLIST_MAX, "durationSec": {"min": 2, "max": 120}},
        "catalog": {"featuredMax": FEATURED_MAX, "idListMax": ID_LIST_MAX},
        "messages": {
            "max": MESSAGES_MAX, "titleMax": MESSAGE_TITLE_MAX, "bodyMax": MESSAGE_BODY_MAX,
            "idPattern": _MESSAGE_ID.pattern,
        },
        "texts": {"max": TEXT_MAX},
        "hours": {"rangesMax": HOURS_RANGES_MAX},
        "payment": {
            "tipPresets": {"min": 1, "max": 50, "maxCount": TIP_PRESETS_MAX},
            "minOrderAgorot": {"min": 0, "max": MIN_ORDER_MAX},
        },
        "printing": {"bonCopies": {"min": 1, "max": 3}},
        "pickup": {"start": {"min": 1}, "max": {"max": 9999}, "prefixMax": PICKUP_PREFIX_MAX,
                   "prefixPattern": _PICKUP_PREFIX.pattern},
        "operations": {"pausedTitleMax": MESSAGE_TITLE_MAX, "pausedBodyMax": MESSAGE_BODY_MAX},
        "club": {"titleMax": MESSAGE_TITLE_MAX, "bodyMax": MESSAGE_BODY_MAX},
        "media": {"urlMax": URL_MAX, "kinds": list(MEDIA_KINDS)},
        "enums": {
            "fulfillmentMode": list(FULFILLMENT_MODES),
            "serviceTypes": list(SERVICE_TYPES),
            "languages": list(LANGUAGES),
            "skipCart": list(SKIP_CART),
            "soldOutMode": list(SOLD_OUT_MODES),
            "themeMode": list(THEME_MODES),
            "cardStyle": list(CARD_STYLES),
            "buttonShape": list(BUTTON_SHAPES),
            "gridDensity": list(GRID_DENSITIES),
            "imageRatio": list(IMAGE_RATIOS),
            "categoryStyle": list(CATEGORY_STYLES),
            "attractSections": list(ATTRACT_SECTIONS),
            "messageKinds": list(MESSAGE_KINDS),
            "messageScreens": list(MESSAGE_SCREENS),
            "messageStyles": list(MESSAGE_STYLES),
            "paymentMethods": list(PAYMENT_METHODS),
            "receiptPolicy": list(RECEIPT_POLICIES),
            "customerFieldModes": list(CUSTOMER_FIELD_MODES),
            "bonMode": list(BON_MODES),
            "pickupScope": list(PICKUP_SCOPES),
            "fonts": [f.id for f in FONT_CATALOG],
        },
        "textKeys": list(TEXT_KEYS),
        "screenImageKeys": list(SCREEN_IMAGE_KEYS),
    }


# ── Cross-field rules (on a complete config) ─────────────────────────────────


def _get(cfg: Dict[str, Any], *keys: str) -> Any:
    node: Any = cfg
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _cross_field(cfg: Dict[str, Any], errors: List[Issue]) -> None:
    if _get(cfg, "general", "fulfillmentMode") == "KDS" and not kds_available():
        errors.append(Issue("general.fulfillmentMode", "kds_not_available", "kds_not_available"))

    methods = _get(cfg, "payment", "methods")
    if isinstance(methods, list):
        for i, method in enumerate(methods):
            if method == "cash":
                errors.append(Issue(_index("payment.methods", i), "cash_not_supported", "cash_not_supported"))
            elif method not in PAYMENT_METHODS:
                errors.append(Issue(
                    _index("payment.methods", i), "invalid_value", f"must be one of: {', '.join(PAYMENT_METHODS)}"
                ))

    if _get(cfg, "payment", "tipEnabled") is True and _get(cfg, "payment", "tipPresets") == []:
        errors.append(Issue("payment.tipPresets", "too_few", "at least one preset when tips are on"))

    inactivity, warning = _get(cfg, "timers", "inactivitySec"), _get(cfg, "timers", "warningSec")
    if _is_int(inactivity) and _is_int(warning) and warning >= inactivity:
        errors.append(Issue("timers.warningSec", "must_be_less", "must be less than timers.inactivitySec"))

    start, top = _get(cfg, "pickup", "start"), _get(cfg, "pickup", "max")
    if _is_int(start) and _is_int(top) and start >= top:
        errors.append(Issue("pickup.start", "must_be_less", "must be less than pickup.max"))

    if _get(cfg, "printing", "bonMode") == "single" and not _get(cfg, "printing", "bonPrinterId"):
        errors.append(Issue("printing.bonPrinterId", "required", "required when bonMode is single"))

    club = _get(cfg, "club")
    if isinstance(club, dict) and club.get("enabled") is True:
        url = club.get("joinUrl")
        if not url:
            errors.append(Issue("club.joinUrl", "required", "required when the club is enabled"))
        elif isinstance(url, str) and not _http_url_ok(url):
            errors.append(Issue("club.joinUrl", "invalid_url", "must be an http(s) URL when the club is enabled"))

    messages = _get(cfg, "messages")
    if isinstance(messages, list):
        seen = set()
        for i, message in enumerate(messages):
            if not isinstance(message, dict):
                continue
            mid = message.get("id")
            if mid in seen:
                errors.append(Issue(_index("messages", i) + ".id", "duplicate", "duplicate message id"))
            seen.add(mid)
            if message.get("productId") is not None and message.get("kind") != "banner":
                errors.append(Issue(_index("messages", i) + ".productId", "banner_only", "only a banner opens a product"))
            starts, ends = _parse_dt(message.get("startsAt")), _parse_dt(message.get("endsAt"))
            if starts is not None and ends is not None:
                try:
                    later = ends > starts
                except TypeError:  # one naive, one aware
                    later = ends.replace(tzinfo=None) > starts.replace(tzinfo=None)
                if not later:
                    errors.append(Issue(_index("messages", i) + ".endsAt", "must_be_after", "must be after startsAt"))

    ranges = _get(cfg, "hours", "ranges")
    if isinstance(ranges, list):
        for i, r in enumerate(ranges):
            if isinstance(r, dict) and r.get("open") is not None and r.get("open") == r.get("close"):
                errors.append(Issue(_index("hours.ranges", i) + ".close", "must_differ", "must differ from open"))
    if _get(cfg, "hours", "enabled") is True and ranges == []:
        errors.append(Issue("hours.ranges", "too_few", "at least one range when hours are enabled"))


def _parse_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ── Public: validate, merge, effective ───────────────────────────────────────


def validate_layer(overrides: Any) -> Tuple[Dict[str, Any], List[Issue]]:
    """
    A partial layer as the dashboard sends it: `(cleaned, errors)`. `cleaned` has the
    `null`s dropped (inherit) and list items normalised; invalid parts are left out.
    """
    errors: List[Issue] = []
    cleaned = SCHEMA.check_layer(overrides, "", errors)
    if cleaned is _INVALID:
        cleaned = {}
    return _prune_empty(cleaned), errors


def _prune_empty(layer: Dict[str, Any]) -> Dict[str, Any]:
    """Drop objects a layer left empty (`{"theme": {}}` overrides nothing)."""
    out = {}
    for key, value in layer.items():
        node = SCHEMA.fields.get(key)
        if isinstance(value, dict) and value == {} and isinstance(node, Obj):
            continue
        out[key] = value
    return out


def validate_config(cfg: Any) -> List[Issue]:
    """A complete config (the effective one): every rule, cross-field ones included."""
    errors: List[Issue] = []
    SCHEMA.check(cfg, "", errors)
    _cross_field(cfg if isinstance(cfg, dict) else {}, errors)
    return _dedupe(errors)


def _dedupe(errors: Iterable[Issue]) -> List[Issue]:
    seen, out = set(), []
    for e in errors:
        key = (e.path, e.code)
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _merge_node(node: Node, base: Any, layer: Any) -> Any:
    if isinstance(node, Obj) and node.merges and isinstance(base, dict) and isinstance(layer, dict):
        out = dict(base)
        for key, value in layer.items():
            child = node.fields.get(key)
            if child is None or value is None:
                continue
            out[key] = _merge_node(child, base.get(key), value) if key in base else copy.deepcopy(value)
        return out
    if isinstance(node, Map) and isinstance(base, dict) and isinstance(layer, dict):
        out = dict(base)
        for key, value in layer.items():
            if value is None:
                continue
            out[key] = copy.deepcopy(value)
        return out
    return copy.deepcopy(layer)


def merge(base: Dict[str, Any], *layers: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """base ⊕ layers, in order: objects deep-merge, lists / MediaRefs / scalars replace, null inherits."""
    out = copy.deepcopy(base)
    for layer in layers:
        if layer:
            out = _merge_node(SCHEMA, out, layer)
    return out


def sanitize_stored_layer(overrides: Any) -> Dict[str, Any]:
    """A stored layer with whatever no longer validates dropped (never raises)."""
    if not isinstance(overrides, dict):
        return {}
    cleaned, _errors = validate_layer(overrides)
    return cleaned


def repair(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fix the cross-field rules a parent layer's later change can break below it, so what a
    kiosk receives always validates. The dashboard still sees the stored layers as they are.
    """
    general, timers, pickup = cfg["general"], cfg["timers"], cfg["pickup"]
    printing, club, payment = cfg["printing"], cfg["club"], cfg["payment"]
    if general.get("fulfillmentMode") == "KDS" and not kds_available():
        general["fulfillmentMode"] = "BON"
    if timers["warningSec"] >= timers["inactivitySec"]:
        timers["warningSec"] = max(5, timers["inactivitySec"] - 1)
    if pickup["start"] >= pickup["max"]:
        pickup["start"], pickup["max"] = DEFAULT_CONFIG["pickup"]["start"], DEFAULT_CONFIG["pickup"]["max"]
    if printing["bonMode"] == "single" and not printing.get("bonPrinterId"):
        printing["bonMode"] = "routing"
    if club.get("enabled") and not _http_url_ok(club.get("joinUrl") or ""):
        club["enabled"] = False
    methods = [m for m in payment.get("methods") or [] if m in PAYMENT_METHODS]
    payment["methods"] = methods or ["card"]
    if payment.get("tipEnabled") and not payment.get("tipPresets"):
        payment["tipPresets"] = list(DEFAULT_CONFIG["payment"]["tipPresets"])
    if cfg["hours"].get("enabled") and not cfg["hours"].get("ranges"):
        cfg["hours"]["enabled"] = False
    return cfg


def resolve(*stored_layers: Any) -> Dict[str, Any]:
    """DEFAULTS ⊕ the stored layers (sanitised), repaired: what a kiosk gets."""
    cfg = merge(DEFAULT_CONFIG, *[sanitize_stored_layer(layer) for layer in stored_layers])
    return repair(cfg)


def config_version(cfg: Dict[str, Any]) -> str:
    """First 16 hex chars of the SHA-256 of the canonical JSON (contract §1.1)."""
    canonical = json.dumps(cfg, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def font_of(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """The wire font object of `theme.font` (the system font for an unknown id)."""
    font_id = _get(cfg, "theme", "font")
    return FONTS_BY_ID.get(font_id, FONTS_BY_ID["system"]).to_wire()


def _media_refs(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    refs: List[Any] = [_get(cfg, "theme", "backgroundImage"), _get(cfg, "theme", "logo")]
    screen_images = _get(cfg, "screenImages") or {}
    refs += [screen_images.get(key) for key in SCREEN_IMAGE_KEYS]
    refs += [item.get("media") for item in (_get(cfg, "attract", "playlist") or []) if isinstance(item, dict)]
    category_images = _get(cfg, "catalog", "categoryImages") or {}
    refs += [category_images[key] for key in sorted(category_images)]
    refs += [m.get("image") for m in (_get(cfg, "messages") or []) if isinstance(m, dict)]
    return [r for r in refs if isinstance(r, dict) and r.get("url")]


def media_manifest(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Every MediaRef in the config plus the selected font's files (kind "font"), deduped by
    url — what the kiosk downloads to its local cache.
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    candidates = [
        {"url": r["url"], "kind": r.get("kind"), "sha256": r.get("sha256"), "bytes": r.get("bytes")}
        for r in _media_refs(cfg)
    ]
    font = FONTS_BY_ID.get(_get(cfg, "theme", "font"))
    if font is not None:
        candidates += [{"url": url, "kind": "font", "sha256": None, "bytes": None} for url in font.files()]
    for ref in candidates:
        if ref["url"] in seen:
            continue
        seen.add(ref["url"])
        out.append(ref)
    return out


# ── Layers from the database ─────────────────────────────────────────────────


def _layer_row(db: Session, level: str, entity_id) -> Any:
    from app.models.kiosk import KioskSettings

    if entity_id is None:
        return None
    column = {
        "company": KioskSettings.company_id,
        "shop": KioskSettings.shop_id,
        "machine": KioskSettings.machine_id,
    }[level]
    return db.query(KioskSettings).filter(KioskSettings.level == level, column == entity_id).first()


def layer_row(db: Session, level: str, entity_id):
    """The stored `kiosk_settings` row of this level and entity, or None."""
    return _layer_row(db, level, entity_id)


def _overrides(row) -> Dict[str, Any]:
    return row.overrides if row is not None and isinstance(row.overrides, dict) else {}


@dataclass
class Layers:
    """The stored layers along one kiosk's path (any may be empty)."""

    company: Dict[str, Any] = field(default_factory=dict)
    shop: Dict[str, Any] = field(default_factory=dict)
    machine: Dict[str, Any] = field(default_factory=dict)


def layers_for(db: Session, *, company_id=None, shop_id=None, machine_id=None) -> Layers:
    return Layers(
        company=_overrides(_layer_row(db, "company", company_id)),
        shop=_overrides(_layer_row(db, "shop", shop_id)),
        machine=_overrides(_layer_row(db, "machine", machine_id)),
    )


def machine_layers(db: Session, machine) -> Layers:
    shop = getattr(machine, "shop", None)
    return layers_for(
        db,
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        machine_id=machine.id,
    )


def effective_config(db: Session, machine) -> Dict[str, Any]:
    """What this kiosk gets: DEFAULTS ⊕ company ⊕ shop ⊕ machine (sanitised, repaired)."""
    layers = machine_layers(db, machine)
    return resolve(layers.company, layers.shop, layers.machine)


def effective_bundle(db: Session, machine) -> Dict[str, Any]:
    """`{configVersion, config, font, media}` — `GET /kiosks/{id}/effective` and the kiosk sync."""
    cfg = effective_config(db, machine)
    return {
        "configVersion": config_version(cfg),
        "config": cfg,
        "font": font_of(cfg),
        "media": media_manifest(cfg),
    }
