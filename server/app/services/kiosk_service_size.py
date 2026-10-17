"""
"גודל כרטיסי לקחת / לשבת" (P:/specs/kiosk-service-size.md): the size of the two choices of "לאכול כאן או לקחת?" —
on their own screen and, with `general.servicePlacement` = attract, as the attract screen's two buttons.

The kiosk config's `general.serviceCardSize` = auto (absent: auto) | small | medium | large, and three optional
numeric overrides in dp: `serviceIconSize` (the icon's tinted square), `serviceCardMaxWidth` (one card's width at
most) and `serviceCardHeight` (one card's height). The same four keys may stand in the `landscape` block's
`general` section (kiosk_landscape.py): there they win only while the screen is on its side.

"auto" keeps today's portrait exactly (every measure null: the renderer's own) and, in landscape, caps the cards
so the two of them, the question and "להמשך" fit the window with room to spare (§2). Every chosen size is capped
the same way in landscape (never taller than LANDSCAPE_HEIGHT_SHARE_MAX of the screen).

This module is the reference of the rule every kiosk applies (client/src/lib/kioskServiceSize.ts for the Windows
kiosk, the browser kiosk /k, the Android web bundle and the dashboard's preview; pos-android KioskServiceSize.kt
for the Android native screens), pinned by the shared golden fixture kiosk_service_size_golden.json
(server/tests/test_kiosk_service_size.py). Pure, integers only (no float rounding differences between languages).
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

#: "גודל כרטיסי לקחת / לשבת".
SERVICE_CARD_SIZES: Tuple[str, ...] = ("auto", "small", "medium", "large")
DEFAULT_SERVICE_CARD_SIZE = "auto"

#: The numeric overrides: (min, max, step) in dp.
NUMBER_SPECS: Dict[str, Tuple[int, int, int]] = {
    # The icon's tinted square (the glyph is half of it).
    "serviceIconSize": (40, 160, 4),
    # One card's width at most (two side by side).
    "serviceCardMaxWidth": (160, 480, 4),
    # One card's height.
    "serviceCardHeight": (100, 400, 4),
}
NUMBER_KEYS = tuple(NUMBER_SPECS)
#: Every key of the size, in `general` and in `landscape.general`.
KEYS: Tuple[str, ...] = ("serviceCardSize",) + NUMBER_KEYS

#: The presets (dp): one card's width at most, its height, the icon.
PRESETS: Dict[str, Dict[str, int]] = {
    "small": {"cardMaxWidthDp": 220, "cardHeightDp": 150, "iconDp": 56},
    "medium": {"cardMaxWidthDp": 280, "cardHeightDp": 190, "iconDp": 72},
    "large": {"cardMaxWidthDp": 360, "cardHeightDp": 250, "iconDp": 96},
}

# ── "auto" in landscape ───────────────────────────────────────────────────────

#: A card's height: this share (percent) of the screen's height, between the floor and the cap below.
AUTO_HEIGHT_PCT = 26
AUTO_HEIGHT_MIN_DP = 120
AUTO_HEIGHT_MAX_DP = 220
#: The icon: this share (percent) of the card's height, at most AUTO_ICON_MAX_DP.
AUTO_ICON_PCT = 42
AUTO_ICON_MAX_DP = 96
#: A card's width: this share (percent) of its height, at most AUTO_WIDTH_MAX_DP.
AUTO_WIDTH_PCT = 145
AUTO_WIDTH_MAX_DP = 320

# ── The caps on every size ────────────────────────────────────────────────────

#: Landscape: a card never taller than this share (percent) of the screen's height.
LANDSCAPE_HEIGHT_SHARE_MAX_PCT = 45
#: The icon never more than this share (percent) of the card's height.
ICON_SHARE_MAX_PCT = 60
#: Two cards side by side: each at most (width − this) / 2 — the window's margins and the gap.
WIDTH_MARGIN_DP = 96
#: The floors after the caps (a tiny window): still a touchable card.
MIN_HEIGHT_DP = 96
MIN_ICON_DP = 32
MIN_WIDTH_DP = 120

#: The attract screen's two buttons: the space between them (dp).
ATTRACT_GAP_DP = 12


def _round_half_up_div(n: int, d: int) -> int:
    """round(n / d), half up, for n ≥ 0 and d > 0 — integer arithmetic."""
    return (2 * n + d) // (2 * d)


def number_value(key: str, raw: Any) -> Optional[int]:
    """One numeric override as a kiosk reads it: a number rounded half up to its step and clamped; anything else unset (None)."""
    lo, hi, step = NUMBER_SPECS[key]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw != raw or raw in (math.inf, -math.inf):
        return None
    stepped = int(math.floor(raw / step + 0.5)) * step
    return max(lo, min(hi, stepped))


def size_name(raw: Any) -> str:
    """`serviceCardSize` as a kiosk reads it: one of SERVICE_CARD_SIZES, anything else "auto"."""
    return raw if isinstance(raw, str) and raw in SERVICE_CARD_SIZES else DEFAULT_SERVICE_CARD_SIZE


def settings_in_force(general: Any, landscape_block: Any, landscape: bool) -> Dict[str, Any]:
    """The four keys in force: `general`'s, and in landscape the `landscape.general` ones that are set over them."""
    g = general if isinstance(general, dict) else {}
    out = {key: g.get(key) for key in KEYS}
    if landscape and isinstance(landscape_block, dict) and isinstance(landscape_block.get("general"), dict):
        for key in KEYS:
            value = landscape_block["general"].get(key)
            if value is not None:
                out[key] = value
    return out


def auto_landscape(height_dp: int) -> Dict[str, int]:
    """"auto" on a screen on its side `height_dp` high: the card, its width and its icon."""
    h = max(AUTO_HEIGHT_MIN_DP, min(AUTO_HEIGHT_MAX_DP, height_dp * AUTO_HEIGHT_PCT // 100))
    return {
        "cardMaxWidthDp": min(AUTO_WIDTH_MAX_DP, _round_half_up_div(h * AUTO_WIDTH_PCT, 100)),
        "cardHeightDp": h,
        "iconDp": min(AUTO_ICON_MAX_DP, _round_half_up_div(h * AUTO_ICON_PCT, 100)),
    }


def resolve(general: Any, landscape_block: Any, display: Dict[str, Any]) -> Dict[str, Any]:
    """
    The service cards' measures on this display (`{landscape, widthDp, heightDp}`): `{size, cardMaxWidthDp,
    cardHeightDp, iconDp}` — each in dp, or None: the renderer's own (today's). The order: the preset ("auto":
    portrait — nothing; landscape — auto_landscape), the numeric overrides over it, then the caps (landscape: the
    height share; the icon's share of the card; two cards across the width), then the floors.
    """
    landscape = bool(display.get("landscape"))
    width = int(math.floor(display.get("widthDp") or 0))
    height = int(math.floor(display.get("heightDp") or 0))
    s = settings_in_force(general, landscape_block, landscape)
    size = size_name(s["serviceCardSize"])
    if size == "auto":
        m: Dict[str, Optional[int]] = dict(auto_landscape(height)) if landscape and height > 0 else {"cardMaxWidthDp": None, "cardHeightDp": None, "iconDp": None}
    else:
        m = dict(PRESETS[size])
    for key, field in (("serviceCardMaxWidth", "cardMaxWidthDp"), ("serviceCardHeight", "cardHeightDp"), ("serviceIconSize", "iconDp")):
        value = number_value(key, s[key])
        if value is not None:
            m[field] = value
    if m["cardHeightDp"] is not None:
        if landscape and height > 0:
            m["cardHeightDp"] = min(m["cardHeightDp"], height * LANDSCAPE_HEIGHT_SHARE_MAX_PCT // 100)
        m["cardHeightDp"] = max(MIN_HEIGHT_DP, m["cardHeightDp"])
        if m["iconDp"] is not None:
            m["iconDp"] = min(m["iconDp"], m["cardHeightDp"] * ICON_SHARE_MAX_PCT // 100)
    if m["iconDp"] is not None:
        m["iconDp"] = max(MIN_ICON_DP, m["iconDp"])
    if m["cardMaxWidthDp"] is not None:
        if width > 0:
            m["cardMaxWidthDp"] = min(m["cardMaxWidthDp"], (width - WIDTH_MARGIN_DP) // 2)
        m["cardMaxWidthDp"] = max(MIN_WIDTH_DP, m["cardMaxWidthDp"])
    return {"size": size, **m}


def attract_buttons(box_w_dp: int, box_h_dp: int, measures: Dict[str, Any]) -> Dict[str, int]:
    """
    The attract screen's two buttons (servicePlacement = attract) in the start button's box: as high as the box,
    never higher than the card's height; each as wide as half the box (less the gap), never wider than the card's
    width. Centred in the box by the renderer.
    """
    h = box_h_dp if measures.get("cardHeightDp") is None else min(box_h_dp, measures["cardHeightDp"])
    each = max(0, (box_w_dp - ATTRACT_GAP_DP) // 2)
    w = each if measures.get("cardMaxWidthDp") is None else min(each, measures["cardMaxWidthDp"])
    return {"buttonWidthDp": w, "buttonHeightDp": h}
