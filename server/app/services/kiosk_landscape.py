"""
"עיצוב לרוחב" (P:/specs/kiosk-landscape-design.md): the kiosk's own design for a screen on its side.

`landscape` is an optional block of the kiosk config. It holds a subset of the design keys — they win only
while the device is in landscape — and the landscape sizes ("לא ענקיים": the category column, a category's
tile and picture, a dish's tile, its columns and its picture, the text). Missing keys fall back to the
normal design; an absent or empty block is today's kiosk, and the config's version does not move.

This module is the reference of the rules every kiosk applies (pos-android KioskLandscape.kt,
client/src/lib/kioskLandscape.ts): the constants, the sizes' defaults and ranges, and the pure functions
the shared golden fixture `kiosk_landscape_golden.json` pins (server/tests/test_kiosk_landscape.py).
"""

from __future__ import annotations

import copy
import math
from typing import Any, Dict, Optional, Tuple

# ── The sizes ─────────────────────────────────────────────────────────────────

#: Every landscape size: (default, min, max, step). dp are the device's effective dp (DisplayProfile).
SIZE_SPECS: Dict[str, Tuple[int, int, int, int]] = {
    # "רוחב טור הקטגוריות": the category column (never wider than CATEGORY_COLUMN_MAX_SHARE of the screen).
    "categoryColumnDp": (232, 160, 360, 4),
    # "גובה קטגוריה": one category's tile in the column (never under MIN_TOUCH_DP).
    "categoryItemMaxDp": (96, 56, 200, 4),
    # "תמונת קטגוריה": the category's picture / icon, in the column and on the tabs.
    "categoryImageMaxDp": (64, 32, 160, 4),
    # "רוחב מנה מרבי": a dish's tile is never wider — one more column instead.
    "productTileMaxDp": (240, 160, 480, 4),
    # "מינימום עמודות": the dishes' columns in landscape (as many as fit MIN_TILE_DP tiles, at most).
    "productMinColumns": (3, 2, 8, 1),
    # "גובה תמונת מנה": a dish's picture is never taller (the picture is cropped, as `cover`).
    "productImageMaxDp": (160, 80, 400, 4),
    # "גודל טקסט לרוחב": on top of the screen's own landscape text scale (DisplayProfile.kioskTypeScale).
    "textScalePct": (100, 80, 130, 5),
}
SIZE_KEYS = tuple(SIZE_SPECS)
SIZE_DEFAULTS: Dict[str, int] = {k: v[0] for k, v in SIZE_SPECS.items()}

#: The space between two dish tiles (dp) the column rule counts.
GAP_DP = 12
#: The columns never make a dish's tile narrower than this (dp), whatever the minimum says.
MIN_TILE_DP = 140
#: The category column never takes more than this share of the screen's width.
CATEGORY_COLUMN_MAX_SHARE = 0.3
#: Every touch target (dp): a category's tile is never lower.
MIN_TOUCH_DP = 48

# ── The design keys a landscape block may set ────────────────────────────────

#: section → keys. Their vocabularies are the normal design's (kiosk_config.SCHEMA).
OVERRIDE_KEYS: Dict[str, Tuple[str, ...]] = {
    "theme": ("categoryLayout", "cartStyle", "gridDensity", "categoryStyle", "imageRatio", "typeScale", "backgroundImage"),
    "layout": ("catalog", "basket", "railSize", "productSize", "categoryIcons", "card"),
    "attract": ("playlist",),
}

#: layout.catalog / layout.basket → theme.categoryLayout / cartStyle (kiosk_layout.LAYOUT_BACK_COMPAT, the same).
BACK_COMPAT_CATEGORY = {"rail": "side", "top": "top", "landing": "side", "list": "side", "shelves": "top", "magazine": "side", "wall": "side"}
BACK_COMPAT_CART = {"bar": "bar", "panel": "panel", "summary": "bar", "fab": "bar", "drawer": "bar", "receipt": "bar"}


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def size_value(key: str, raw: Any) -> int:
    """One size as a kiosk reads it: a number rounded to its step and clamped to its range; anything else its default."""
    default, lo, hi, step = SIZE_SPECS[key]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw != raw or raw in (math.inf, -math.inf):
        return default
    stepped = _round_half_up(raw / step) * step
    return max(lo, min(hi, stepped))


def resolve_sizes(block: Any) -> Dict[str, int]:
    """The landscape sizes in force: the block's own (`sizes`), each missing or broken one its default."""
    sizes = block.get("sizes") if isinstance(block, dict) else None
    sizes = sizes if isinstance(sizes, dict) else {}
    return {key: size_value(key, sizes.get(key)) for key in SIZE_KEYS}


def category_column_dp(width_dp: float, sizes: Dict[str, int]) -> int:
    """The category column's width on a screen `width_dp` wide."""
    return min(sizes["categoryColumnDp"], int(math.floor(width_dp * CATEGORY_COLUMN_MAX_SHARE)))


def category_item_dp(computed_dp: float, sizes: Dict[str, int]) -> int:
    """One category's tile height: what the layout gives, capped; never under a touch target."""
    return max(MIN_TOUCH_DP, min(int(round(computed_dp)), sizes["categoryItemMaxDp"]))


def category_image_dp(computed_dp: float, sizes: Dict[str, int]) -> int:
    """A category's picture: what the layout gives, capped."""
    return min(int(round(computed_dp)), sizes["categoryImageMaxDp"])


def product_columns(columns: int, grid_dp: float, sizes: Dict[str, int]) -> int:
    """
    The dishes' columns in a grid `grid_dp` wide: never fewer than the layout's own, enough that no tile is
    wider than productTileMaxDp, at least productMinColumns — but never so many that a tile is under MIN_TILE_DP.
    """
    need = int(math.ceil((grid_dp + GAP_DP) / (sizes["productTileMaxDp"] + GAP_DP)))
    upper = max(1, int(math.floor((grid_dp + GAP_DP) / (MIN_TILE_DP + GAP_DP))))
    return max(columns, min(max(need, sizes["productMinColumns"]), upper))


def tile_dp(columns: int, grid_dp: float) -> float:
    """A tile's width with `columns` across `grid_dp` (GAP_DP between)."""
    return (grid_dp - GAP_DP * (columns - 1)) / columns


def product_image_dp(computed_dp: float, sizes: Dict[str, int]) -> int:
    """A dish's picture height: what its ratio gives on the tile, capped."""
    return min(int(round(computed_dp)), sizes["productImageMaxDp"])


def text_scale(display_scale: float, sizes: Dict[str, int]) -> float:
    """The landscape text scale: the screen's own times the block's percent (4 places)."""
    return round(display_scale * sizes["textScalePct"] / 100.0, 4)


# ── The design in landscape ───────────────────────────────────────────────────


def _set(block: Any, section: str, key: str) -> Any:
    part = block.get(section) if isinstance(block, dict) else None
    return part.get(key) if isinstance(part, dict) else None


def apply(cfg: Dict[str, Any], display: Dict[str, Any]) -> Dict[str, Any]:
    """
    The config as a kiosk draws it on this display (`{landscape, sideCart, rail}` — KioskDisplayDecisions):
    portrait — exactly as it is. Landscape — the block's keys win; layout.catalog / basket bring their
    categoryLayout / cartStyle unless the block names those too; a wall adds on a tap; then the automatic
    landscape rules (P:/specs/kiosk-landscape-till-mode.md §4) only for what the block left unset: the side
    cart where there is room, the top tabs where the rail does not fit. Returns `{config, explicit}`:
    `explicit.categories` / `explicit.cart` — the block decided them (the kiosk adjusts nothing there).
    """
    if not display.get("landscape"):
        return {"config": cfg, "explicit": {"categories": False, "cart": False}}
    block = cfg.get("landscape") if isinstance(cfg.get("landscape"), dict) else {}
    out = copy.deepcopy(cfg)
    for section, keys in OVERRIDE_KEYS.items():
        for key in keys:
            value = _set(block, section, key)
            if value is not None:
                out.setdefault(section, {})[key] = copy.deepcopy(value)
    theme, layout = out.setdefault("theme", {}), out.setdefault("layout", {})
    catalog, basket = _set(block, "layout", "catalog"), _set(block, "layout", "basket")
    own_categories, own_cart = _set(block, "theme", "categoryLayout"), _set(block, "theme", "cartStyle")
    if catalog in BACK_COMPAT_CATEGORY and own_categories is None:
        theme["categoryLayout"] = BACK_COMPAT_CATEGORY[catalog]
    if basket in BACK_COMPAT_CART and own_cart is None:
        theme["cartStyle"] = BACK_COMPAT_CART[basket]
    if layout.get("catalog") == "wall" and layout.get("quickAdd") == "off":
        layout["quickAdd"] = "no_required"
    explicit_categories = own_categories is not None or catalog is not None
    explicit_cart = own_cart is not None or basket is not None
    if not explicit_categories and theme.get("categoryLayout", "side") == "side" and display.get("rail") is False:
        theme["categoryLayout"] = "top"
    if not explicit_cart and display.get("sideCart"):
        theme["cartStyle"] = "panel"
    return {"config": out, "explicit": {"categories": explicit_categories, "cart": explicit_cart}}


def media_refs(block: Optional[Dict[str, Any]]) -> list:
    """The block's pictures and videos (the kiosk downloads them as the normal design's)."""
    if not isinstance(block, dict):
        return []
    refs = [_set(block, "theme", "backgroundImage")]
    refs += [item.get("media") for item in (_set(block, "attract", "playlist") or []) if isinstance(item, dict)]
    return [r for r in refs if isinstance(r, dict) and r.get("url")]
