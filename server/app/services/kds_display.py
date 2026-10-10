"""
"עיצוב המסך" — how a KDS screen and the "מוכן / לא מוכן" board look (docs/SPEC_KDS.md §14).

Stored per screen in `kds_devices.display` and, as the shop's defaults, in
`shops.settings["kdsDisplayDefaults"] = {"kds": {...}, "board": {...}}` (no new column: the shop's
settings JSON already holds the shop's own keys; `settings_merge.MANAGED_SETTING_KEYS` keeps it out
of the tills' settings sync).

Version 2 (`"v": 2`) adds the layouts and options to version 1's board look (`theme`, `accent`,
`sound`, `showPreparing`, `title` — migration e7d1b4a9c3f6). Every key has a default that is the
screen's look before this module (the "tickets" kitchen screen, the two-column board), so a stored
v1 value, a missing key or an unknown value draws exactly what it drew before.

What a screen gets (`device.display` in `kds/board` and `kds/device`): its own value when it has
one, else the shop's default for its kind ("board" for a pickup screen, "kds" for the rest), else
null (the built-in defaults). A v1 value on a kitchen screen (written when it was a pickup screen)
is a board look only: the kitchen screen falls through to the shop's default.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

DISPLAY_VERSION = 2
DEFAULTS_KEY = "kdsDisplayDefaults"

THEMES = ("dark", "light", "contrast", "brand")
KDS_LAYOUTS = ("tickets", "columns", "rail", "list", "big")
BOARD_LAYOUTS = ("columns", "spotlight", "grid", "split", "ticker")
COLUMNS_BY = ("station", "course")
DENSITIES = ("compact", "normal", "large")
SOUND_TONES = ("chime", "bell", "knock", "beep", "off")
SOUND_EVENTS = ("new", "change", "late")
FIELDS = ("table", "name", "waiter", "guests", "course", "notes", "allergens", "modifiers")
MEDIA_KINDS = ("image", "video")

#: Today's sounds: a new order chimes, a cancellation / note knocks, nothing when a card turns late.
DEFAULT_SOUNDS = {"new": "chime", "change": "knock", "late": "off"}
FONT_SCALE_MIN, FONT_SCALE_MAX = 0.8, 1.6
WARN_MAX, LATE_MAX = 240, 480
READY_MINUTES_MAX = 240
MEDIA_MAX = 12
MEDIA_URL_MAX = 1000
MEDIA_SECONDS_MIN, MEDIA_SECONDS_MAX, MEDIA_SECONDS_DEFAULT = 3, 300, 8
TITLE_MAX = 60
PROMO_MAX = 140

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_SHA = re.compile(r"^[0-9a-fA-F]{64}$")
_URL = re.compile(r"^https?://\S+$")


def kind_of(role: Optional[str]) -> str:
    """Which look a screen of this role has: the board's (pickup) or the kitchen's."""
    return "board" if role == "pickup" else "kds"


def version_of(raw: Any) -> int:
    v = raw.get("v") if isinstance(raw, dict) else None
    return v if isinstance(v, int) and not isinstance(v, bool) else 1


def _one_of(value: Any, allowed, default):
    return value if value in allowed else default


def _flag(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return " ".join(value.split())[:limit] or None


def _int_in(value: Any, low: int, high: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (math.isnan(value) or value != int(value)):
        return None
    n = int(value)
    return n if low <= n <= high else None


def _font_scale(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(float(value)):
        return 1.0
    return round(min(FONT_SCALE_MAX, max(FONT_SCALE_MIN, float(value))), 2)


def _media(value: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(value, list):
        return out
    for m in value:
        if not isinstance(m, dict):
            continue
        url = m.get("url")
        if not isinstance(url, str) or len(url) > MEDIA_URL_MAX or not _URL.match(url):
            continue
        sha = m.get("sha256")
        size = m.get("bytes")
        out.append({
            "url": url,
            "kind": _one_of(m.get("kind"), MEDIA_KINDS, "image"),
            "sha256": sha.lower() if isinstance(sha, str) and _SHA.match(sha) else None,
            "bytes": size if isinstance(size, int) and not isinstance(size, bool) and size >= 0 else None,
            "durationSec": _int_in(m.get("durationSec"), MEDIA_SECONDS_MIN, MEDIA_SECONDS_MAX) or MEDIA_SECONDS_DEFAULT,
        })
        if len(out) >= MEDIA_MAX:
            break
    return out


def _thresholds(raw: Dict[str, Any]) -> tuple:
    """Both or neither: a screen's own age colours, else its stations' ("null" = the station settings)."""
    warn = _int_in(raw.get("warnMinutes"), 1, WARN_MAX)
    late = _int_in(raw.get("lateMinutes"), 1, LATE_MAX)
    if warn is None or late is None or late <= warn:
        return None, None
    return warn, late


def display_out(raw: Any) -> Optional[Dict[str, Any]]:
    """
    A stored look (v1 or v2), cleaned for the screens: every key present, an unknown or missing
    value replaced by its default (today's look). None when nothing is stored.
    """
    if not isinstance(raw, dict):
        return None
    fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
    sounds = raw.get("sounds") if isinstance(raw.get("sounds"), dict) else {}
    accent = raw.get("accent")
    warn, late = _thresholds(raw)
    return {
        "v": DISPLAY_VERSION,
        # Both kinds.
        "theme": _one_of(raw.get("theme"), THEMES, "dark"),
        "accent": accent.lower() if isinstance(accent, str) and _HEX.match(accent) else None,
        "title": _text(raw.get("title"), TITLE_MAX),
        # The board.
        "sound": raw.get("sound") is not False,
        "showPreparing": raw.get("showPreparing") is not False,
        "boardLayout": _one_of(raw.get("boardLayout"), BOARD_LAYOUTS, "columns"),
        "readyMinutes": _int_in(raw.get("readyMinutes"), 1, READY_MINUTES_MAX),
        "media": _media(raw.get("media")),
        "promoText": _text(raw.get("promoText"), PROMO_MAX),
        # The kitchen screen.
        "layout": _one_of(raw.get("layout"), KDS_LAYOUTS, "tickets"),
        "columnsBy": _one_of(raw.get("columnsBy"), COLUMNS_BY, "station"),
        "density": _one_of(raw.get("density"), DENSITIES, "normal"),
        "fontScale": _font_scale(raw.get("fontScale")),
        "ageColors": _flag(raw.get("ageColors"), True),
        "warnMinutes": warn,
        "lateMinutes": late,
        "fields": {f: _flag(fields.get(f), True) for f in FIELDS},
        "sounds": {e: _one_of(sounds.get(e), SOUND_TONES, DEFAULT_SOUNDS[e]) for e in SOUND_EVENTS},
        "clock": _flag(raw.get("clock"), True),
        "counts": _flag(raw.get("counts"), True),
    }


def display_in(body: Any) -> Dict[str, Any]:
    """A validated `KdsDisplayIn` (app/schemas/kds.py) as it is stored: v2, cleaned."""
    data = body.model_dump(by_alias=True) if hasattr(body, "model_dump") else dict(body)
    out = display_out(data)
    assert out is not None
    return out


def shop_defaults(shop: Any) -> Dict[str, Optional[Dict[str, Any]]]:
    """The shop's defaults per kind (cleaned), None where the shop has none."""
    settings = getattr(shop, "settings", None) if shop is not None else None
    stored = settings.get(DEFAULTS_KEY) if isinstance(settings, dict) else None
    stored = stored if isinstance(stored, dict) else {}
    return {kind: display_out(stored.get(kind)) for kind in ("kds", "board")}


def own_display(device: Any) -> Optional[Dict[str, Any]]:
    """The screen's own look when it applies to its role (a v1 value is a board look only)."""
    raw = getattr(device, "display", None)
    if not isinstance(raw, dict):
        return None
    if kind_of(getattr(device, "role", None)) == "kds" and version_of(raw) < DISPLAY_VERSION:
        return None
    return display_out(raw)


def effective(device: Any, shop: Any) -> Optional[Dict[str, Any]]:
    """What the screen draws: its own look, else the shop's default for its kind, else None."""
    own = own_display(device)
    if own is not None:
        return own
    return shop_defaults(shop).get(kind_of(getattr(device, "role", None)))


def set_shop_defaults(shop: Any, values: Dict[str, Optional[Dict[str, Any]]]) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Sets the shop's defaults for the kinds in `values` (a stored v2 dict, or None to remove).
    Kinds not in `values` stay. The JSONB column is reassigned (it only sees a new value).
    """
    settings = dict(shop.settings) if isinstance(shop.settings, dict) else {}
    current = dict(settings.get(DEFAULTS_KEY)) if isinstance(settings.get(DEFAULTS_KEY), dict) else {}
    for kind, value in values.items():
        if kind not in ("kds", "board"):
            continue
        if value is None:
            current.pop(kind, None)
        else:
            current[kind] = value
    if current:
        settings[DEFAULTS_KEY] = current
    else:
        settings.pop(DEFAULTS_KEY, None)
    shop.settings = settings
    return shop_defaults(shop)


def ready_minutes(display: Optional[Dict[str, Any]]) -> Optional[int]:
    """How long a ready number stays on this board (None: as the cloud keeps it)."""
    if not isinstance(display, dict):
        return None
    return _int_in(display.get("readyMinutes"), 1, READY_MINUTES_MAX)
