"""
"עיצוב קופה" — the till's order screens as the cloud designs them (docs/SPEC_TILL_DESIGN.md).

One versioned JSON config (camelCase on the wire), stored as PARTIAL override layers
company → shop → area (point of sale) → machine (`till_design_settings`), exactly like the
kiosk config (app/services/kiosk_config.py, whose schema nodes this module reuses):

    DEFAULT_CONFIG ⊕ company ⊕ shop ⊕ area ⊕ machine

Objects and the id-keyed `texts` map deep-merge; lists and scalars replace; in a layer a key
whose value is `null` means "inherit" and is dropped on save; unknown keys are refused.

**Nothing set = today's screens.** Every default is either today's look (`template: clean`
is the till's current table and quick-order screens) or "auto", which the till resolves from
what it already reads: the till parameters ("גודל ריבוע מוצר…", "כפתור תשלום מהיר 1/2", "שם
לקוח", "לקחת/לשבת", "סגנון מפת שולחנות"), the branding colour and the order settings
(`productOrder` / `categoryOrder`). `LEGACY_MAP` lists every overlap.

A device shows the config through its **profile** (`PROFILES`: the F20 handheld, a tablet held
sideways or upright, the iPad sizes kept for the future web / Windows till). `for_profile`
is the one algorithm that turns the config into what a profile shows; the dashboard
(client/src/lib/tillDesign.ts) and the till (pos-android domain/TillDesign.kt) mirror it, and
the shared fixture tests/fixtures/till_design_contract.json pins all three.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.services.kiosk_config import (
    ID,
    Bool,
    Color,
    Enum,
    Int,
    Issue,
    Map,
    Node,
    Obj,
    Str,
    UList,
    _INVALID,
    _dedupe,
    _fail,
    _is_int,
    _merge_node,
)

SCHEMA_VERSION = 1

# ── Vocabularies ─────────────────────────────────────────────────────────────

#: The phase-1 templates: the owner's six (runner-ipad-ui-claude.md), our quick-order and
#: table-order designs merged into them (classic → clean, photo → touch, list / keypad →
#: professional, seats → seated, speed / nightBar → fast, handheld → mobile).
TEMPLATES = ("clean", "touch", "professional", "seated", "fast", "mobile")
#: Phase 2 (docs/SPEC_TILL_DESIGN.md §10): shown in the dashboard as "בקרוב", refused on save.
PHASE2_TEMPLATES = ("courses", "payDock", "night", "visual")
#: Old names, read as their template (the till accepts them too; the cloud stores the new name).
TEMPLATE_ALIASES = {
    "classic": "clean",
    "photo": "touch",
    "list": "professional",
    "keypad": "professional",
    "seats": "seated",
    "speed": "fast",
    "nightBar": "fast",
    "handheld": "mobile",
}

#: The device profiles, with their screen in dp (CSS px for the iPad sizes).
PROFILES = ("handheld", "tabletLandscape", "tabletPortrait", "ipadPortrait", "ipadLandscape")
PROFILE_SIZES: Dict[str, Tuple[int, int]] = {
    "handheld": (360, 640),
    "tabletLandscape": (1280, 800),
    "tabletPortrait": (800, 1280),
    "ipadPortrait": (768, 1024),
    "ipadLandscape": (1024, 768),
}
#: Which profiles an Android till uses (the iPad ones are for the future web / Windows till).
ANDROID_PROFILES = ("handheld", "tabletLandscape", "tabletPortrait")

MODES = ("table", "quick")

TILE_SIZES = ("auto", "xs", "s", "m", "l")
TILE_STYLES = ("auto", "card", "photo", "row", "key")
DENSITIES = ("compact", "comfortable", "spacious")
#: Where the order (the bill) stands. In RTL "end" is the LEFT side, "start" the right.
#: "bottom": under the menu (on a handheld a summary bar that opens upward); "sheet": only a
#: bar with the total, the order opens as a sheet (today's table screen).
BILL_POSITIONS = ("auto", "end", "start", "bottom", "sheet")
CATEGORY_BARS = ("auto", "top", "side")
IMAGES = ("auto", "show", "hide")
TEXT_SIZES = ("normal", "large")
COLOR_MODES = ("auto", "light", "dark")
FIELD_MODES = ("auto", "off", "optional", "required")
FIELD_KEYS = ("customerName", "serviceType", "guests")
SUMMARY_STATES = ("auto", "open", "closed")
MAP_STYLES = ("auto", "classic", "modern")
SHOW_HIDE = ("auto", "show", "hide")

#: The action bar's buttons. A quick order's and a table's are separate lists.
QUICK_ACTIONS = (
    "pay", "fastCard", "cashWithChange", "fastCash", "cashNotes",
    "hold", "discount", "customer", "orderDetails", "clear",
)
TABLE_ACTIONS = ("send", "bill", "pay", "split", "move", "guests", "notes", "discount", "repeatRound")
#: The one button each list must keep when it is set: the payment screen / the kitchen.
REQUIRED_ACTION = {"quick": "pay", "table": "send"}
ACTION_BAR_MAX = 6
ACTION_LABEL_MAX = 24

#: Default labels (Hebrew, the till's language). A button's own `label` replaces it.
ACTION_LABELS: Dict[str, str] = {
    "send": "שדר למטבח",
    "bill": "מעבר לחשבון",
    "pay": "תשלום",
    "split": "פיצול",
    "move": "העבר",
    "guests": "סועדים",
    "notes": "הערות",
    "discount": "הנחה",
    "repeatRound": "עוד סבב",
    "fastCard": "אשראי מהיר",
    "cashWithChange": "מזומן עם עודף",
    "fastCash": "מזומן מהיר",
    "cashNotes": "שטרות",
    "hold": "השהה",
    "customer": "לקוח",
    "orderDetails": "פרטי הזמנה",
    "clear": "נקה הזמנה",
}

#: Banknotes / coin for "שטרות" ("cashNotes"): the next round amounts over the total when the
#: list is empty ("auto"), else these notes.
CASH_NOTE_VALUES = (10, 20, 50, 100, 200)
CASH_NOTES_MAX = 4
CASH_COUNT_MIN, CASH_COUNT_MAX = 1, 4

QUANTITY_PRESETS_MIN, QUANTITY_PRESETS_MAX = 2, 6
QUANTITY_MAX = 99
FAVORITES_MAX = 24
MENU_IDS_MAX = 2000
COLUMNS_CHOICES = (0, 2, 3, 4, 5, 6, 7, 8)

#: The screen texts a business may reword ("" = the default below).
TEXT_DEFAULTS: Dict[str, str] = {
    "sendToKitchen": "שדר למטבח",
    "newSuffix": "חדש",
    "allSent": "הכול שודר",
    "goToBill": "מעבר לחשבון",
    "pay": "תשלום",
    "orderTitle": "הזמנה",
    "summary": "סיכום ההזמנה",
    "emptyOrder": "ההזמנה ריקה",
    "serviceType": "סוג שירות",
    "takeAway": "לקחת",
    "eatIn": "לשבת",
    "customerName": "שם לקוח",
    "addToSeat": "הוספה לסועד",
    "seatGeneral": "כללי",
    "nextQuantity": "כמות לפריט הבא",
    "otherQuantity": "כמות אחרת",
    "favorites": "מועדפים",
    "repeatRound": "עוד סבב",
}
TEXT_KEYS = tuple(TEXT_DEFAULTS.keys())
TEXT_MAX = 40

# ── What each template is (the shared table; docs/SPEC_TILL_DESIGN.md §4) ────

_SIDE = {"handheld": "bottom", "tabletLandscape": "end", "tabletPortrait": "bottom",
         "ipadPortrait": "bottom", "ipadLandscape": "end"}


def _both(by_profile: Dict[str, str]) -> Dict[str, Dict[str, str]]:
    return {"table": dict(by_profile), "quick": dict(by_profile)}


#: Per template: its tiles, its bill (where, per mode and profile, and how), its default table
#: action bar, its extras. A quick order's default bar is always "auto" (the till parameters).
TEMPLATE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    # Today's screens: a table's order in a sheet over the dishes; the quick order on a
    # tablet beside (sideways) or under (upright) the catalogue, a page of its own on the F20.
    "clean": {
        "tileStyle": "card",
        "billStyle": "lines",
        "billPosition": {
            "table": {p: "sheet" for p in PROFILES},
            "quick": {"handheld": "sheet", "tabletLandscape": "end", "tabletPortrait": "bottom",
                      "ipadPortrait": "bottom", "ipadLandscape": "end"},
        },
        "tableActions": ["send"],
        "features": [],
        "summaryCollapsible": False,
    },
    # Big tiles (with the product's photo when it has one), the order's lines as cards with − / +.
    "touch": {
        "tileStyle": "photo",
        "billStyle": "cards",
        "billPosition": _both(_SIDE),
        "tableActions": ["send", "bill"],
        "features": [],
        "summaryCollapsible": False,
    },
    # A list of rows (name · price · +) beside a detailed bill; a search field over the list.
    "professional": {
        "tileStyle": "row",
        "billStyle": "lines",
        "billPosition": _both({"handheld": "sheet", "tabletLandscape": "end", "tabletPortrait": "end",
                               "ipadPortrait": "end", "ipadLandscape": "end"}),
        "tableActions": ["send", "bill"],
        "features": ["searchField"],
        "summaryCollapsible": False,
    },
    # Seat cards over the menu; every new line takes the chosen seat; the bill grouped by seat.
    "seated": {
        "tileStyle": "card",
        "billStyle": "seats",
        "billPosition": _both(_SIDE),
        "tableActions": ["send", "bill", "split"],
        "features": ["seatCards"],
        "summaryCollapsible": False,
    },
    # The bar: quantity for the next add (1 2 3 5, other), favourites, text keys, repeat round.
    "fast": {
        "tileStyle": "key",
        "billStyle": "compact",
        "billPosition": _both(_SIDE),
        "tableActions": ["send", "repeatRound", "bill"],
        "features": ["quantityPresets", "favorites"],
        "summaryCollapsible": False,
    },
    # The waiter's handheld: the menu in the middle, a summary that opens upward, actions below.
    "mobile": {
        "tileStyle": "card",
        "billStyle": "lines",
        "billPosition": _both({p: "bottom" for p in PROFILES}),
        "tableActions": ["send", "bill"],
        "features": ["seatPicker"],
        "summaryCollapsible": True,
    },
}

#: Where each "auto" comes from on the till (the dashboard shows it; the till applies it).
LEGACY_MAP: Dict[str, Tuple[str, ...]] = {
    "layout.tileSize": ("productTileSize", "productTileSizeTablet", "productTileSizeTables", "productTileSizeTabletTables"),
    "actionBar.quick": ("quickPayButton1", "quickPayButton2", "fastCard", "fastCash"),
    "fields.customerName": ("askOrderName",),
    "fields.serviceType": ("askEatInTakeAway",),
    "fields.guests": ("tablesAskGuests",),
    "tables.mapStyle": ("tablesMapStyle",),
    "tables.showChairs": ("tablesShowChairs",),
    "colors.accent": ("brandPrimaryColor",),
    "menu.categoryOrder": ("categoryOrder",),
    "menu.productOrder": ("productOrder",),
}

# ── Schema nodes ─────────────────────────────────────────────────────────────


class IntChoice(Node):
    """An integer from a fixed set (`columns`: 0 = automatic, else 2–8)."""

    def __init__(self, values: Sequence[int], nullable: bool = False):
        self.values, self.nullable = tuple(values), nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not _is_int(value) or value not in self.values:
            return _fail(errors, path, "invalid_value", f"must be one of: {', '.join(map(str, self.values))}")
        return value


class TemplateNode(Node):
    """A template id: one of TEMPLATES; a phase-2 one is refused with its own code."""

    def __init__(self, nullable: bool = False):
        self.nullable = nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if isinstance(value, str) and value in PHASE2_TEMPLATES:
            return _fail(errors, path, "template_not_available", "this template is not available yet (phase 2)")
        if not isinstance(value, str) or value not in TEMPLATES:
            return _fail(errors, path, "invalid_value", f"must be one of: {', '.join(TEMPLATES)}")
        return value


def _action_item(actions: Sequence[str]) -> Obj:
    return Obj(
        {"action": Enum(actions), "label": Str(ACTION_LABEL_MAX)},
        fill={"label": ""},
        merges=False,
    )


PROFILE_OVERRIDE = Obj({
    "template": TemplateNode(nullable=True),
    "tileSize": Enum(TILE_SIZES, nullable=True),
    "tileStyle": Enum(TILE_STYLES, nullable=True),
    "density": Enum(DENSITIES, nullable=True),
    "billPosition": Enum(BILL_POSITIONS, nullable=True),
    "categoryBar": Enum(CATEGORY_BARS, nullable=True),
    "columns": IntChoice(COLUMNS_CHOICES, nullable=True),
}, fill={k: None for k in ("template", "tileSize", "tileStyle", "density", "billPosition", "categoryBar", "columns")})

SCHEMA = Obj({
    "schemaVersion": IntChoice((SCHEMA_VERSION,)),
    "template": TemplateNode(),
    "layout": Obj({
        "tileSize": Enum(TILE_SIZES),
        "tileStyle": Enum(TILE_STYLES),
        "density": Enum(DENSITIES),
        "billPosition": Enum(BILL_POSITIONS),
        "categoryBar": Enum(CATEGORY_BARS),
        "images": Enum(IMAGES),
        "columns": IntChoice(COLUMNS_CHOICES),
        "textSize": Enum(TEXT_SIZES),
    }),
    "profiles": Obj({p: PROFILE_OVERRIDE for p in PROFILES}),
    "actionBar": Obj({
        "table": UList(_action_item(TABLE_ACTIONS), max_len=ACTION_BAR_MAX),
        "quick": UList(_action_item(QUICK_ACTIONS), max_len=ACTION_BAR_MAX),
    }),
    "quickCash": Obj({
        "notes": UList(IntChoice(CASH_NOTE_VALUES), max_len=CASH_NOTES_MAX, unique=True),
        "count": Int(CASH_COUNT_MIN, CASH_COUNT_MAX),
    }),
    "bar": Obj({
        "quantityPresets": UList(Int(1, QUANTITY_MAX), min_len=QUANTITY_PRESETS_MIN, max_len=QUANTITY_PRESETS_MAX, unique=True),
        "favorites": UList(ID, max_len=FAVORITES_MAX, unique=True),
        "repeatRound": Bool(),
    }),
    "menu": Obj({
        "categoryOrder": UList(ID, max_len=MENU_IDS_MAX, unique=True),
        "productOrder": UList(ID, max_len=MENU_IDS_MAX, unique=True),
        "hiddenCategories": UList(ID, max_len=MENU_IDS_MAX, unique=True),
    }),
    "colors": Obj({
        "accent": Color(nullable=True),
        "mode": Enum(COLOR_MODES),
    }),
    "texts": Map(Str(TEXT_MAX), keys=TEXT_KEYS),
    "fields": Obj({k: Enum(FIELD_MODES) for k in FIELD_KEYS}),
    "behavior": Obj({
        "summary": Enum(SUMMARY_STATES),
        "lineStatus": Bool(),
    }),
    "tables": Obj({
        "mapStyle": Enum(MAP_STYLES),
        "showChairs": Enum(SHOW_HIDE),
    }),
})

DEFAULT_CONFIG: Dict[str, Any] = {
    "schemaVersion": SCHEMA_VERSION,
    "template": "clean",
    "layout": {
        "tileSize": "auto",
        "tileStyle": "auto",
        "density": "comfortable",
        "billPosition": "auto",
        "categoryBar": "auto",
        "images": "auto",
        "columns": 0,
        "textSize": "normal",
    },
    "profiles": {p: {k: None for k in PROFILE_OVERRIDE.fields} for p in PROFILES},
    # [] = "auto": a table's from its template, a quick order's from the till parameters.
    "actionBar": {"table": [], "quick": []},
    "quickCash": {"notes": [], "count": 3},
    "bar": {"quantityPresets": [1, 2, 3, 5], "favorites": [], "repeatRound": True},
    "menu": {"categoryOrder": [], "productOrder": [], "hiddenCategories": []},
    "colors": {"accent": None, "mode": "auto"},
    "texts": {},
    "fields": {k: "auto" for k in FIELD_KEYS},
    "behavior": {"summary": "auto", "lineStatus": True},
    "tables": {"mapStyle": "auto", "showChairs": "auto"},
}


def default_config() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG)


class TillDesignInvalid(ValueError):
    """The config (or a layer) does not validate; `errors` is the list for the 422."""

    def __init__(self, errors: List[Issue]):
        super().__init__("invalid_till_design")
        self.errors = errors

    def detail(self) -> Dict[str, Any]:
        return {"code": "invalid_till_design", "errors": [e.to_wire() for e in self.errors]}


# ── Validation ───────────────────────────────────────────────────────────────


def _cross_field(cfg: Dict[str, Any], errors: List[Issue], *, layer: bool) -> None:
    """The rules one node cannot see: the action bars' required button and their duplicates;
    a quantity preset of 1 (the quantity returns to 1 after an add)."""
    bars = cfg.get("actionBar") if isinstance(cfg.get("actionBar"), dict) else {}
    for mode in MODES:
        items = bars.get(mode)
        if not isinstance(items, list) or not items:
            continue
        actions = [i.get("action") for i in items if isinstance(i, dict)]
        seen = set()
        for i, action in enumerate(actions):
            if action in seen:
                errors.append(Issue(f"actionBar.{mode}[{i}]", "duplicate", "this button is already on the bar"))
            seen.add(action)
        required = REQUIRED_ACTION[mode]
        if required not in actions:
            errors.append(Issue(f"actionBar.{mode}", f"action_bar_missing_{required}",
                                f"the bar must keep the '{required}' button"))
    bar = cfg.get("bar") if isinstance(cfg.get("bar"), dict) else {}
    presets = bar.get("quantityPresets")
    if isinstance(presets, list) and presets and 1 not in presets:
        errors.append(Issue("bar.quantityPresets", "quantity_presets_need_one", "the presets must include 1"))


def validate_layer(overrides: Any) -> Tuple[Dict[str, Any], List[Issue]]:
    """A partial layer as the dashboard sends it: `(cleaned, errors)` (nulls dropped)."""
    errors: List[Issue] = []
    cleaned = SCHEMA.check_layer(overrides, "", errors)
    if cleaned is _INVALID:
        cleaned = {}
    cleaned = _prune_empty(cleaned)
    _cross_field(cleaned, errors, layer=True)
    return cleaned, _dedupe(errors)


def _prune_empty(layer: Dict[str, Any]) -> Dict[str, Any]:
    """Drop objects a layer left empty (`{"layout": {}}`, a profile with nothing set)."""
    out: Dict[str, Any] = {}
    for key, value in layer.items():
        node = SCHEMA.fields.get(key)
        if key == "profiles" and isinstance(value, dict):
            value = {p: v for p, v in value.items() if isinstance(v, dict) and v}
        if isinstance(value, dict) and value == {} and isinstance(node, Obj):
            continue
        out[key] = value
    return out


def validate_config(cfg: Any) -> List[Issue]:
    """A complete config (an effective one): every rule, cross-field ones included."""
    errors: List[Issue] = []
    SCHEMA.check(cfg, "", errors)
    _cross_field(cfg if isinstance(cfg, dict) else {}, errors, layer=False)
    return _dedupe(errors)


def sanitize_stored_layer(overrides: Any) -> Dict[str, Any]:
    """A stored layer with whatever no longer validates dropped (never raises)."""
    if not isinstance(overrides, dict):
        return {}
    cleaned, errors = validate_layer(overrides)
    # A cross-field failure (an action bar that lost its required button to a narrowed
    # vocabulary) falls back to "auto" rather than reaching a till.
    for e in errors:
        if e.path.startswith("actionBar.") and e.code.startswith("action_bar_missing"):
            mode = e.path.split(".")[1].split("[")[0]
            cleaned.get("actionBar", {}).pop(mode, None)
        if e.path == "bar.quantityPresets":
            cleaned.get("bar", {}).pop("quantityPresets", None)
    return _prune_empty(cleaned)


# ── Merge, resolve, version ──────────────────────────────────────────────────


def merge(base: Dict[str, Any], *layers: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """base ⊕ layers, in order: objects deep-merge, lists / scalars replace, null inherits."""
    out = copy.deepcopy(base)
    for layer in layers:
        if layer:
            out = _merge_node(SCHEMA, out, layer)
    return out


def resolve(*stored_layers: Any) -> Dict[str, Any]:
    """DEFAULTS ⊕ the stored layers (sanitised): what a till gets."""
    return merge(DEFAULT_CONFIG, *[sanitize_stored_layer(layer) for layer in stored_layers])


def explicit_layers(*stored_layers: Any) -> Dict[str, Any]:
    """The stored layers merged over nothing: only what they set explicitly."""
    return merge({}, *[sanitize_stored_layer(layer) for layer in stored_layers])


def config_version(cfg: Dict[str, Any]) -> str:
    """First 16 hex chars of the SHA-256 of the canonical JSON (as the kiosk's)."""
    canonical = json.dumps(cfg, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def canonical_template(value: Any) -> str:
    """A template id as stored or as an older name; anything else (a phase-2 one) is clean."""
    if isinstance(value, str):
        value = TEMPLATE_ALIASES.get(value, value)
        if value in TEMPLATES:
            return value
    return "clean"


# ── What a profile shows (mirrored by tillDesign.ts and TillDesign.kt) ───────


def for_profile(cfg: Dict[str, Any], profile: str) -> Dict[str, Any]:
    """
    The config as one device profile shows it: the profile's overrides over the base, every
    "auto" that the config itself can settle settled (the bill position and the tile style
    from the template, the table's action bar), and what only the till knows left "auto"
    (the tile size, the quick order's buttons: the till parameters).

        template      profiles[p].template ?? template (an alias read as its template)
        tileSize      profiles[p].tileSize ?? layout.tileSize               ("auto" stays)
        tileStyle     profiles[p].tileStyle ?? layout.tileStyle; "auto" → the template's
        density       profiles[p].density ?? layout.density
        billPosition  profiles[p].billPosition ?? layout.billPosition; "auto" → the
                      template's for each mode; on the handheld a side (start / end)
                      becomes "bottom" — 360 dp holds no second column
        categoryBar   profiles[p].categoryBar ?? layout.categoryBar; "auto" → "top"; on
                      the handheld always "top"
        columns       profiles[p].columns ?? layout.columns (0 = by the tile size)
        actions       table: actionBar.table, or the template's; quick: actionBar.quick,
                      or [] — the till builds it from "כפתור תשלום מהיר 1/2" + "pay"
    """
    if profile not in PROFILES:
        profile = "handheld"
    over = (cfg.get("profiles") or {}).get(profile) or {}
    layout = cfg.get("layout") or {}

    def pick(key: str) -> Any:
        value = over.get(key)
        return value if value is not None else layout.get(key, DEFAULT_CONFIG["layout"].get(key))

    template = canonical_template(over.get("template") or cfg.get("template"))
    defaults = TEMPLATE_DEFAULTS[template]
    tile_style = pick("tileStyle")
    if tile_style not in TILE_STYLES or tile_style == "auto":
        tile_style = defaults["tileStyle"]
    bill: Dict[str, str] = {}
    chosen = pick("billPosition")
    for mode in MODES:
        position = chosen if chosen in BILL_POSITIONS and chosen != "auto" else defaults["billPosition"][mode][profile]
        if profile == "handheld" and position in ("start", "end"):
            position = "bottom"
        bill[mode] = position
    category_bar = pick("categoryBar")
    if category_bar not in CATEGORY_BARS or category_bar == "auto" or profile == "handheld":
        category_bar = "top"
    bars = cfg.get("actionBar") or {}
    table_actions = [dict(i) for i in (bars.get("table") or [])] or [
        {"action": a, "label": ""} for a in defaults["tableActions"]
    ]
    quick_actions = [dict(i) for i in (bars.get("quick") or [])]
    width, height = PROFILE_SIZES[profile]
    return {
        "profile": profile,
        "width": width,
        "height": height,
        "template": template,
        "tileSize": pick("tileSize"),
        "tileStyle": tile_style,
        "density": pick("density"),
        "billPosition": bill,
        "billStyle": defaults["billStyle"],
        "summaryCollapsible": defaults["summaryCollapsible"],
        "categoryBar": category_bar,
        "columns": pick("columns") or 0,
        "images": layout.get("images", "auto"),
        "textSize": layout.get("textSize", "normal"),
        "features": list(defaults["features"]),
        "actions": {"table": table_actions, "quick": quick_actions},
    }


def quick_cash_notes(total_agorot: int, notes: Sequence[int], count: int) -> List[int]:
    """
    The banknote buttons ("שטרות") for a total, in shekels, each over the total (so each shows
    a change): the chosen notes that cover it, else ("auto", `notes` empty) the next round
    amounts over it — the next 10, 20, 50, 100, 200 — without repeats, at most `count`.
    """
    count = max(CASH_COUNT_MIN, min(CASH_COUNT_MAX, int(count or 3)))
    if total_agorot <= 0:
        return []
    if notes:
        return [n for n in sorted(set(notes)) if n * 100 > total_agorot][:count]
    out: List[int] = []
    for step in (10, 20, 50, 100, 200):
        amount = ((total_agorot // (step * 100)) + 1) * step
        if amount not in out:
            out.append(amount)
    return sorted(out)[:count]


# ── The overlapping till parameters, for the dashboard ───────────────────────

_TILE_WORDS = {"קטן מאוד": "xs", "קטן": "s", "בינוני": "m", "גדול": "l"}
#: The quick-pay parameters' choices (Hebrew, or the payment order's ids) as actions.
_QUICK_PAY_WORDS = {
    "אשראי מהיר": "fastCard", "מזומן עם עודף": "cashWithChange", "מזומן מהיר": "fastCash",
    "fastcard": "fastCard", "cash": "cashWithChange", "fastcash": "fastCash",
}
_QUICK_PAY_ORDER = ("fastCard", "cashWithChange", "fastCash")
_DEFAULT_QUICK_PAY = ("fastCard", "cashWithChange")


def _quick_pay_word(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = value.strip()
    return _QUICK_PAY_WORDS.get(v) or _QUICK_PAY_WORDS.get(v.lower())


def legacy_quick_actions(parameters: Dict[str, Any]) -> List[Dict[str, str]]:
    """
    What a quick order's "auto" bar is on a till with these parameters: the two quick-pay
    buttons (domain/QuickCash.kt quickPayButtons: each slot its choice or its default, the
    second moved off a repeat, a disallowed one dropped) and "pay".
    """
    chosen = [
        _quick_pay_word(parameters.get(key)) or _DEFAULT_QUICK_PAY[slot]
        for slot, key in enumerate(("quickPayButton1", "quickPayButton2"))
    ]
    distinct: List[str] = []
    for action in chosen:
        if action in distinct:
            action = next(a for a in _QUICK_PAY_ORDER if a not in distinct)
        distinct.append(action)
    allowed = {"cashWithChange"}
    if parameters.get("fastCard", True) is not False:
        allowed.add("fastCard")
    if parameters.get("fastCash", True) is not False:
        allowed.add("fastCash")
    return [{"action": a, "label": ""} for a in distinct if a in allowed] + [{"action": "pay", "label": ""}]


def legacy_view(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """The "auto" values as the till parameters set them at a level (the editor's hints)."""

    def word(key: str) -> Optional[str]:
        value = parameters.get(key)
        return _TILE_WORDS.get(value.strip()) if isinstance(value, str) else None

    def flag(key: str) -> Optional[bool]:
        value = parameters.get(key)
        return value if isinstance(value, bool) else None

    map_style = parameters.get("tablesMapStyle")
    return {
        "tileSize": {
            "quick": word("productTileSize") or "m",
            "quickTablet": word("productTileSizeTablet") or word("productTileSize") or "m",
            "table": word("productTileSizeTables") or "m",
            "tableTablet": word("productTileSizeTabletTables") or word("productTileSizeTables") or "m",
        },
        "quickActions": legacy_quick_actions(parameters),
        "fields": {
            "customerName": "required" if flag("askOrderName") else "off",
            "serviceType": "required" if flag("askEatInTakeAway") else "off",
            "guests": "required" if flag("tablesAskGuests") else "off",
        },
        "tables": {
            "mapStyle": "modern" if isinstance(map_style, str) and map_style.startswith("מודרני") else "classic",
            "showChairs": "hide" if flag("tablesShowChairs") is False else "show",
        },
    }


def catalog() -> Dict[str, Any]:
    """The vocabularies and the template table, for the dashboard (`GET /till-design/defaults`)."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "templates": list(TEMPLATES),
        "phase2Templates": list(PHASE2_TEMPLATES),
        "templateAliases": dict(TEMPLATE_ALIASES),
        "profiles": list(PROFILES),
        "profileSizes": {p: list(s) for p, s in PROFILE_SIZES.items()},
        "androidProfiles": list(ANDROID_PROFILES),
        "templateDefaults": copy.deepcopy(TEMPLATE_DEFAULTS),
        "quickActions": list(QUICK_ACTIONS),
        "tableActions": list(TABLE_ACTIONS),
        "requiredAction": dict(REQUIRED_ACTION),
        "actionLabels": dict(ACTION_LABELS),
        "actionBarMax": ACTION_BAR_MAX,
        "actionLabelMax": ACTION_LABEL_MAX,
        "cashNoteValues": list(CASH_NOTE_VALUES),
        "textDefaults": dict(TEXT_DEFAULTS),
        "textMax": TEXT_MAX,
        "favoritesMax": FAVORITES_MAX,
        "legacyMap": {k: list(v) for k, v in LEGACY_MAP.items()},
        "vocab": {
            "tileSize": list(TILE_SIZES), "tileStyle": list(TILE_STYLES), "density": list(DENSITIES),
            "billPosition": list(BILL_POSITIONS), "categoryBar": list(CATEGORY_BARS), "images": list(IMAGES),
            "textSize": list(TEXT_SIZES), "colorMode": list(COLOR_MODES), "fieldMode": list(FIELD_MODES),
            "summary": list(SUMMARY_STATES), "mapStyle": list(MAP_STYLES), "showChairs": list(SHOW_HIDE),
            "columns": list(COLUMNS_CHOICES),
        },
    }


# ── Layers from the database ─────────────────────────────────────────────────

LEVELS = ("company", "shop", "area", "machine")


def layer_row(db: Session, level: str, entity_id) -> Any:
    """The stored `till_design_settings` row of this level and entity, or None."""
    from app.models.till_design import TillDesignSettings

    if entity_id is None or level not in LEVELS:
        return None
    column = {
        "company": TillDesignSettings.company_id,
        "shop": TillDesignSettings.shop_id,
        "area": TillDesignSettings.area_id,
        "machine": TillDesignSettings.machine_id,
    }[level]
    return db.query(TillDesignSettings).filter(TillDesignSettings.level == level, column == entity_id).first()


def _overrides(row) -> Dict[str, Any]:
    return row.overrides if row is not None and isinstance(row.overrides, dict) else {}


@dataclass
class Layers:
    """The stored layers along one till's path (any may be empty), and their newest change."""

    company: Dict[str, Any] = field(default_factory=dict)
    shop: Dict[str, Any] = field(default_factory=dict)
    area: Dict[str, Any] = field(default_factory=dict)
    machine: Dict[str, Any] = field(default_factory=dict)
    updated_at: Any = None

    def ordered(self) -> List[Dict[str, Any]]:
        return [self.company, self.shop, self.area, self.machine]


def layers_for(db: Session, *, company_id=None, shop_id=None, area_id=None, machine_id=None) -> Layers:
    rows = {
        "company": layer_row(db, "company", company_id),
        "shop": layer_row(db, "shop", shop_id),
        "area": layer_row(db, "area", area_id),
        "machine": layer_row(db, "machine", machine_id),
    }
    stamps = [r.updated_at for r in rows.values() if r is not None and r.updated_at is not None]
    return Layers(
        company=_overrides(rows["company"]),
        shop=_overrides(rows["shop"]),
        area=_overrides(rows["area"]),
        machine=_overrides(rows["machine"]),
        updated_at=max(stamps) if stamps else None,
    )


def machine_layers(db: Session, machine) -> Layers:
    from app.services.till_parameters import scope_chain_for_machine

    chain = scope_chain_for_machine(db, machine)
    return layers_for(
        db, company_id=chain.company_id, shop_id=chain.shop_id, area_id=chain.area_id, machine_id=machine.id,
    )


def effective_config(db: Session, machine) -> Dict[str, Any]:
    """What this till gets: DEFAULTS ⊕ company ⊕ shop ⊕ area ⊕ machine (sanitised)."""
    return resolve(*machine_layers(db, machine).ordered())


def sync_bundle(db: Session, machine) -> Dict[str, Any]:
    """`GET /sync/{id}/till-design`: `{schemaVersion, configVersion, config, updatedAt}`."""
    layers = machine_layers(db, machine)
    cfg = resolve(*layers.ordered())
    stamp = layers.updated_at
    return {
        "schemaVersion": SCHEMA_VERSION,
        "configVersion": config_version(cfg),
        "config": cfg,
        "updatedAt": stamp.isoformat() if stamp is not None else None,
    }
