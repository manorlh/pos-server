"""
"מבנה הקיוסק" (config `layout`, docs/SPEC_KIOSK_LAYOUTS.md): WHERE things sit and HOW the order
goes, beside "סגנון ממשק" (`theme.uiStyle`, how it looks). `standard` (the default) is the kiosk of
today, key for key — nothing changes until a business picks another layout.

What a kiosk gets (kiosk_config.resolve):

    DEFAULT_CONFIG ⊕ preset_layer(uiStyle) ⊕ layout_template_layer(template) ⊕ company ⊕ shop ⊕ kiosk

The vocabulary, the defaults and LAYOUT_TEMPLATES are pinned by the shared golden fixture
`tests/fixtures/kiosk_layout_templates.json` (the same bytes in pos-android), which
tests/test_kiosk_layout.py compares with these tables; the dashboard's src/lib/kioskLayout.ts and the
till's domain/KioskLayout.kt hold the same tables.

Also here: the category icons' ids (`catalog.categoryIconIds`) and the text registry (every text a
customer sees — `texts` / `textsByLang`), both read from the shared JSON beside this module
(`kiosk_shared/`, the same bytes as the fixtures). Pure: no database, no import of kiosk_config.
"""
from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ── The vocabulary ────────────────────────────────────────────────────────────

LAYOUT_TEMPLATE_IDS = ("standard", "guided", "tabs", "landing", "fastfood", "cafe", "combo", "list", "magazine", "wall",
                       "restaurant_rail")
LAYOUT_CATALOGS = ("rail", "top", "landing", "list", "shelves", "magazine", "wall")
LAYOUT_CATEGORY_ICONS = ("photo", "line", "filled", "duotone", "emoji", "none")
LAYOUT_RAIL_SIZES = ("s", "m", "l")
LAYOUT_LANDING_COLUMNS = (2, 3, 4)
#: "גודל מוצרים": the dishes' cards in every catalog — s: one column more (smaller cards), m: as
#: today, l: one fewer (larger; never under two tiles across from a 400 dp grid).
LAYOUT_PRODUCT_SIZES = ("s", "m", "l")
LAYOUT_HEROES = ("off", "manual", "auto")
LAYOUT_CARDS = ("tile", "row", "plate", "bleed", "button", "outlined")
LAYOUT_FLOWS = ("free", "guided")
LAYOUT_ITEM_VIEWS = ("sheet", "full", "modal", "inline", "steps", "popover")
#: "no_choices" (17.10, the default): straight in only when the dish has no choices and no add-ons at all
#: (app/services/kiosk_tap.py).
LAYOUT_QUICK_ADDS = ("off", "no_choices", "no_required", "always")
#: "כפתור פרטים" (ⓘ) on a dish's card: auto — when a tap skips its window and it holds more; always; off.
LAYOUT_INFO_BUTTONS = ("auto", "always", "off")
LAYOUT_MEAL_VIEWS = ("sheet", "steps", "tray")
LAYOUT_MEAL_UPSELLS = ("off", "first", "after")
LAYOUT_BASKETS = ("bar", "panel", "summary", "fab", "drawer", "receipt")
LAYOUT_SERVICES = ("cards", "split", "rows", "sheet")
LAYOUT_NAMES = ("card", "dock", "avatar")
LAYOUT_REACHES = ("normal", "low")
# "מסעדה — פס צד" (P:/specs/kiosk-rail-motion.md §3, §6): every key additive, its default today's look.
#: The rail's items: plain (today) or an icon in a circle with the name under it.
LAYOUT_RAIL_STYLES = ("plain", "circle")
#: How the chosen circle stands out (circle only): filled, scaled ×1.12, both, or not at all.
LAYOUT_RAIL_EMPHASES = ("none", "fill", "scale", "fill_scale")
#: paged — today (catalog.oneCategory decides); continuous — one list with category headings, the rail following.
LAYOUT_CATALOG_SCROLLS = ("paged", "continuous")
LAYOUT_ON_OFF = ("on", "off")
#: The windows' entrance (dish, add-ons, payment method); null — motion.sheet (today).
LAYOUT_SHEET_MOTIONS = ("slide_up", "fade", "none")
#: The top bar's buttons, in order; null — today's header.
LAYOUT_TOP_BAR_ITEMS = ("club", "cancel", "search", "lang")
LAYOUT_TOP_BAR_MAX = len(LAYOUT_TOP_BAR_ITEMS)
LAYOUT_HELP_BUTTONS = ("off", "float")
LAYOUT_DONE_SCREENS = ("classic", "card")
#: "איך תרצו לשלם?" as today's screen, or a window rising over the basket with a card per method.
LAYOUT_PAY_METHOD_VIEWS = ("screen", "sheet")
NAME_AVATARS_MAX = 12
NAME_AVATAR_MAX = 24

LAYOUT_VOCABULARY: Dict[str, Tuple[Any, ...]] = {
    "template": LAYOUT_TEMPLATE_IDS,
    "catalog": LAYOUT_CATALOGS,
    "categoryIcons": LAYOUT_CATEGORY_ICONS,
    "railSize": LAYOUT_RAIL_SIZES,
    "landingColumns": LAYOUT_LANDING_COLUMNS,
    "productSize": LAYOUT_PRODUCT_SIZES,
    "hero": LAYOUT_HEROES,
    "card": LAYOUT_CARDS,
    "flow": LAYOUT_FLOWS,
    "itemView": LAYOUT_ITEM_VIEWS,
    "quickAdd": LAYOUT_QUICK_ADDS,
    "infoButton": LAYOUT_INFO_BUTTONS,
    "mealView": LAYOUT_MEAL_VIEWS,
    "mealUpsell": LAYOUT_MEAL_UPSELLS,
    "basket": LAYOUT_BASKETS,
    "service": LAYOUT_SERVICES,
    "name": LAYOUT_NAMES,
    "reach": LAYOUT_REACHES,
    "railStyle": LAYOUT_RAIL_STYLES,
    "railEmphasis": LAYOUT_RAIL_EMPHASES,
    "catalogScroll": LAYOUT_CATALOG_SCROLLS,
    "railFollow": LAYOUT_ON_OFF,
    "pricePill": LAYOUT_ON_OFF,
    "sheetMotion": LAYOUT_SHEET_MOTIONS,
    "topBar": LAYOUT_TOP_BAR_ITEMS,
    "helpButton": LAYOUT_HELP_BUTTONS,
    "doneScreen": LAYOUT_DONE_SCREENS,
    "payMethodView": LAYOUT_PAY_METHOD_VIEWS,
}

#: The layout of today (template standard): every key as the kiosk drew it before `layout` existed.
LAYOUT_DEFAULTS: Dict[str, Any] = {
    "template": "standard",
    "catalog": None,
    "categoryIcons": None,
    "railSize": "m",
    "landingColumns": 3,
    "productSize": "m",
    "landingShowCounts": True,
    "hero": "off",
    "magazineFeed": False,
    "card": None,
    "flow": "free",
    "itemView": "sheet",
    # "הוספה מהירה": a tap on a dish with no choices and no add-ons puts it in (owner 17.10: "no_choices";
    # was "off", then "no_required"). A layer that chose a value keeps it — the stored layers hold only what a
    # level chose. app/services/kiosk_tap.py has the whole tap.
    "quickAdd": "no_choices",
    "infoButton": "auto",
    # "תג כמות" (P:/specs/kiosk-tap-add-count-badge.md): how many of the dish the basket holds, on its
    # card in every template — on unless a level turns it off (no template sets it).
    "cartCountBadge": True,
    "mealView": "sheet",
    "mealUpsell": "off",
    "basket": None,
    "service": "cards",
    "name": "card",
    "nameAvatars": [],
    "reach": "normal",
    "reachToggle": False,
    "railStyle": "plain",
    "railEmphasis": "fill",
    "catalogScroll": "paged",
    "railFollow": "on",
    "pricePill": "off",
    "sheetMotion": None,
    "topBar": None,
    "helpButton": "off",
    "doneScreen": "classic",
    "payMethodView": "screen",
}

#: The keys a template decides (every layout key but the template itself).
LAYOUT_TEMPLATE_KEYS = tuple(k for k in LAYOUT_DEFAULTS if k != "template")

#: Each template as a layer between the style's preset and the stored layers (the dashboard's
#: KIOSK_LAYOUT_TEMPLATES and the till's KioskLayoutTemplates, key for key). A template may set a
#: key of another section too (tabs: one scrolling menu; list: the search).
LAYOUT_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "standard": {"layout": {}},
    "guided": {"layout": {"catalog": "landing", "categoryIcons": "line", "flow": "guided", "itemView": "steps", "basket": "bar",
                          "service": "cards", "name": "card", "card": "row", "landingColumns": 2}},
    "tabs": {"layout": {"catalog": "top", "categoryIcons": "filled", "itemView": "full", "basket": "bar", "service": "sheet", "name": "card"},
             "catalog": {"oneCategory": False}},
    "landing": {"layout": {"catalog": "landing", "categoryIcons": "duotone", "itemView": "modal", "basket": "summary", "service": "cards",
                           "name": "card", "landingColumns": 3}},
    "fastfood": {"layout": {"catalog": "rail", "categoryIcons": "photo", "itemView": "sheet", "basket": "summary", "service": "split",
                            "name": "card", "railSize": "l", "mealUpsell": "first", "card": "plate"}},
    "cafe": {"layout": {"catalog": "shelves", "categoryIcons": "emoji", "itemView": "full", "basket": "fab", "service": "rows",
                        "name": "avatar", "hero": "manual"}},
    "combo": {"layout": {"catalog": "top", "categoryIcons": "filled", "itemView": "sheet", "basket": "summary", "service": "cards",
                         "name": "card", "mealView": "tray"}},
    "list": {"layout": {"catalog": "list", "categoryIcons": "none", "itemView": "inline", "basket": "drawer", "service": "cards",
                        "name": "dock"},
             "general": {"searchEnabled": True}},
    "magazine": {"layout": {"catalog": "magazine", "categoryIcons": "none", "itemView": "full", "basket": "bar", "service": "rows",
                            "name": "card", "magazineFeed": True}},
    "wall": {"layout": {"catalog": "wall", "categoryIcons": "emoji", "itemView": "popover", "basket": "receipt", "name": "avatar",
                        "quickAdd": "always"}},
    # "מסעדה — פס צד": circles on the rail, one continuous menu, price pills, windows rising (§6.4).
    "restaurant_rail": {"layout": {"catalog": "rail", "categoryIcons": "line", "railStyle": "circle", "railEmphasis": "fill_scale",
                                   "catalogScroll": "continuous", "railFollow": "on", "card": "tile", "pricePill": "on",
                                   "itemView": "sheet", "sheetMotion": "slide_up", "topBar": ["club", "cancel", "search"],
                                   "doneScreen": "card", "payMethodView": "sheet"},
                        "catalog": {"oneCategory": False}},
}

#: The templates the clients draw (the dashboard offers only these): all of them.
LAYOUT_TEMPLATES_READY = ("standard", "guided", "tabs", "landing", "fastfood", "cafe", "combo", "list", "magazine", "wall",
                          "restaurant_rail")

#: What an older kiosk (no `layout`) reads: theme.categoryLayout / cartStyle written from the layout.
LAYOUT_BACK_COMPAT: Dict[str, Dict[str, str]] = {
    "categoryLayout": {"rail": "side", "top": "top", "landing": "side", "list": "side", "shelves": "top", "magazine": "side", "wall": "side"},
    "cartStyle": {"bar": "bar", "panel": "panel", "summary": "bar", "fab": "bar", "drawer": "bar", "receipt": "bar"},
}

# ── "ברוכים הבאים" (attract.welcome) ─────────────────────────────────────────

WELCOME_POSITIONS = ("top", "middle", "bottom")
WELCOME_ALIGNS = ("start", "center", "end")
WELCOME_SIZES = ("s", "m", "l", "xl")
WELCOME_WEIGHTS = ("regular", "bold", "black")
WELCOME_BACKDROPS = ("scrim", "card", "blur", "none")
WELCOME_WIDTH_PCT = (40, 100)

#: The block of today: in the bottom stack above the button, start-aligned, displayMedium, ExtraBold,
#: white on its scrim. Its place among the blocks is `welcome` in attract.sections (absent: first).
WELCOME_DEFAULTS: Dict[str, Any] = {
    "enabled": True, "position": "bottom", "align": "start", "size": "l", "weight": "black",
    "titleColor": None, "subtitleColor": None, "backdrop": "scrim", "showSubtitle": True, "maxWidthPct": 100,
}


def template_of(*layers: Optional[Dict[str, Any]]) -> str:
    """The template the layers pick: the last that sets `layout.template` (a known one), else standard."""
    template = LAYOUT_DEFAULTS["template"]
    for layer in layers:
        picked = ((layer or {}).get("layout") or {}).get("template") if isinstance(layer, dict) else None
        if picked in LAYOUT_TEMPLATES:
            template = picked
    return template


def layout_template_layer(template: str) -> Dict[str, Any]:
    """The template as a layer (a copy)."""
    return copy.deepcopy(LAYOUT_TEMPLATES.get(template) or LAYOUT_TEMPLATES["standard"])


def repair_layout(cfg: Dict[str, Any]) -> None:
    """
    The layout's cross-field rules (kiosk_config.repair calls this): a known template; guided never
    with an inline / popover dish; a wall adds on a tap; reach low makes the add-to-cart a bounce (a
    flight would cross the display half). And for an older kiosk, theme.categoryLayout / cartStyle
    from the layout whenever it names the catalog / the basket.
    """
    layout = cfg.get("layout")
    if not isinstance(layout, dict):
        return
    if layout.get("template") not in LAYOUT_TEMPLATES:
        layout["template"] = "standard"
    if layout.get("flow") == "guided" and layout.get("itemView") in ("inline", "popover"):
        layout["itemView"] = "steps"
    if layout.get("catalog") == "wall" and layout.get("quickAdd") == "off":
        layout["quickAdd"] = "no_required"
    motion = cfg.get("motion")
    if layout.get("reach") == "low" and isinstance(motion, dict) and motion.get("addToCart") == "fly":
        motion["addToCart"] = "bounce"
    theme = cfg.get("theme")
    if isinstance(theme, dict):
        catalog = layout.get("catalog")
        if catalog in LAYOUT_BACK_COMPAT["categoryLayout"]:
            theme["categoryLayout"] = LAYOUT_BACK_COMPAT["categoryLayout"][catalog]
        basket = layout.get("basket")
        if basket in LAYOUT_BACK_COMPAT["cartStyle"]:
            theme["cartStyle"] = LAYOUT_BACK_COMPAT["cartStyle"][basket]


# ── The shared data: the icon set and the text registry ──────────────────────

SHARED_DIR = Path(__file__).parent / "kiosk_shared"


@lru_cache(maxsize=None)
def _shared(name: str) -> Dict[str, Any]:
    """A shared JSON beside this module; a missing / broken one is empty (never an API that cannot start)."""
    try:
        with open(SHARED_DIR / name, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


@lru_cache(maxsize=None)
def category_icon_ids() -> Tuple[str, ...]:
    """The built-in category icons' ids (`catalog.categoryIconIds` values)."""
    return tuple(i["id"] for i in _shared("kiosk_category_icons.json").get("icons", []))


@lru_cache(maxsize=None)
def text_registry() -> Dict[str, Dict[str, Any]]:
    """Every customer text by key: its default per language, `max` and named placeholders."""
    return {t["key"]: t for t in _shared("kiosk_text_registry.json").get("texts", [])}


def text_keys() -> Tuple[str, ...]:
    return tuple(text_registry().keys())


_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def placeholders_in(text: str) -> List[str]:
    return list(dict.fromkeys(_PLACEHOLDER.findall(text or "")))


TEXT_LANGUAGES = ("he", "en", "ar", "ru")
