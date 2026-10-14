"""
"מסעדה — פס צד" (P:/specs/kiosk-rail-motion.md §6): the layout's new keys, the theme's new colours,
`payment.paymentChooserSkip` and the template `restaurant_rail` — all additive. Every config that
resolved before them resolves the same (the baseline fixture, taken on main before the change), the new
keys at their defaults; unknown values are refused on save; colours are "#RRGGBB".
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_layout as L

FIX = Path(__file__).parent / "fixtures"
BASELINE = json.loads((FIX / "kiosk_resolve_baseline_1013.json").read_bytes().decode("utf-8"))["cases"]

NEW_LAYOUT_KEYS = ("railStyle", "railEmphasis", "catalogScroll", "railFollow", "pricePill", "sheetMotion", "topBar", "helpButton",
                   "doneScreen", "payMethodView",
                   # Added after the baseline (14.10, "תג כמות" — tests/test_kiosk_count_badge.py), on by default.
                   "cartCountBadge")


def _without_new_keys(cfg):
    out = copy.deepcopy(cfg)
    for k in NEW_LAYOUT_KEYS:
        out["layout"].pop(k)
    for k in C.RAIL_MOTION_COLOR_KEYS:
        out["theme"].pop(k)
    out["payment"].pop("paymentChooserSkip")
    return out


# ── Nothing that existed changes ─────────────────────────────────────────────


@pytest.mark.parametrize("case", BASELINE, ids=lambda c: c["name"][:60])
def test_every_existing_template_and_style_resolves_as_before(case):
    cfg = C.resolve(*case["layers"])
    assert _without_new_keys(cfg) == case["resolved"]
    assert {k: cfg["layout"][k] for k in NEW_LAYOUT_KEYS} == {k: L.LAYOUT_DEFAULTS[k] for k in NEW_LAYOUT_KEYS}
    assert all(cfg["theme"][k] is None for k in C.RAIL_MOTION_COLOR_KEYS)
    assert cfg["payment"]["paymentChooserSkip"] == "auto"


def test_the_baseline_covers_every_older_template_in_every_style():
    names = {c["name"] for c in BASELINE}
    for style in C.UI_PRESETS:
        for template in L.LAYOUT_TEMPLATE_IDS:
            if template != "restaurant_rail":
                assert f"{template} in {style}" in names


def test_the_defaults_are_todays_look():
    d = C.DEFAULT_CONFIG
    assert d["layout"]["railStyle"] == "plain" and d["layout"]["catalogScroll"] == "paged"
    assert d["layout"]["pricePill"] == "off" and d["layout"]["sheetMotion"] is None and d["layout"]["topBar"] is None
    assert d["layout"]["helpButton"] == "off" and d["layout"]["doneScreen"] == "classic" and d["layout"]["payMethodView"] == "screen"
    assert d["payment"]["paymentChooserSkip"] == "auto"
    assert C.validate_config(C.default_config()) == []


# ── The template ─────────────────────────────────────────────────────────────


def test_restaurant_rail_sets_the_whole_look():
    cfg = C.resolve({"layout": {"template": "restaurant_rail"}})
    lay = cfg["layout"]
    assert (lay["catalog"], lay["railStyle"], lay["railEmphasis"], lay["catalogScroll"]) == ("rail", "circle", "fill_scale", "continuous")
    assert (lay["card"], lay["pricePill"], lay["itemView"], lay["sheetMotion"], lay["doneScreen"]) == ("tile", "on", "sheet", "slide_up", "card")
    assert lay["topBar"] == ["club", "cancel", "search"] and lay["payMethodView"] == "sheet"
    # An older kiosk (no catalogScroll) still draws one continuous list on a side rail.
    assert cfg["catalog"]["oneCategory"] is False and cfg["theme"]["categoryLayout"] == "side"
    assert C.validate_config(cfg) == []
    assert "restaurant_rail" in C.limits()["layout"]["ready"]


def test_the_template_follows_the_style_and_explicit_keys_win():
    cfg = C.resolve({"theme": {"uiStyle": "minimal_dark"}, "layout": {"template": "restaurant_rail"}},
                    {"layout": {"railStyle": "plain", "topBar": []}, "theme": {"pricePillBg": "#C9A227"}})
    assert cfg["theme"]["uiStyle"] == "minimal_dark" and cfg["theme"]["mode"] == "dark"
    assert cfg["layout"]["railStyle"] == "plain" and cfg["layout"]["topBar"] == []
    assert cfg["layout"]["catalogScroll"] == "continuous"
    assert cfg["theme"]["pricePillBg"] == "#C9A227"


# ── Validation ───────────────────────────────────────────────────────────────


def _paths(errors):
    return {e.path for e in errors}


def test_the_new_layout_keys_save_and_null_inherits():
    layer = {"layout": {"railStyle": "circle", "railEmphasis": "scale", "catalogScroll": "continuous", "railFollow": "off",
                        "pricePill": "on", "sheetMotion": "fade", "topBar": ["lang", "search"], "helpButton": "float",
                        "doneScreen": "card", "payMethodView": "sheet"}}
    clean, errors = C.validate_layer(layer)
    assert errors == [] and clean == layer
    clean, errors = C.validate_layer({"layout": {"sheetMotion": None, "topBar": None}})
    assert errors == [] and clean == {}


def test_unknown_values_of_the_new_keys_are_refused():
    _clean, errors = C.validate_layer({"layout": {
        "railStyle": "hexagon", "railEmphasis": "glow", "catalogScroll": "infinite", "railFollow": True, "pricePill": "yes",
        "sheetMotion": "spin", "helpButton": "corner", "doneScreen": "poster", "payMethodView": "modal",
    }})
    assert _paths(errors) == {f"layout.{k}" for k in ("railStyle", "railEmphasis", "catalogScroll", "railFollow", "pricePill", "sheetMotion",
                                                      "helpButton", "doneScreen", "payMethodView")}


def test_the_top_bar_is_a_short_list_of_known_buttons():
    assert C.validate_layer({"layout": {"topBar": []}})[1] == []
    _c, errors = C.validate_layer({"layout": {"topBar": ["club", "points"]}})
    assert _paths(errors) == {"layout.topBar[1]"}
    _c, errors = C.validate_layer({"layout": {"topBar": ["club", "club"]}})
    assert any(e.code == "duplicate" for e in errors)
    _c, errors = C.validate_layer({"layout": {"topBar": "club"}})
    assert _paths(errors) == {"layout.topBar"}
    _c, errors = C.validate_layer({"layout": {"topBar": ["club", "cancel", "search", "lang", "club"]}})
    assert "layout.topBar" in _paths(errors)


@pytest.mark.parametrize("key", C.RAIL_MOTION_COLOR_KEYS)
def test_the_new_colours_are_rrggbb(key):
    clean, errors = C.validate_layer({"theme": {key: "#1f6feb"}})
    assert errors == [] and clean == {"theme": {key: "#1f6feb"}}
    for bad in ("red", "#FFF", "#12345678", "1F6FEB", 0x1F6FEB):
        _c, errors = C.validate_layer({"theme": {key: bad}})
        assert {(e.path, e.code) for e in errors} == {(f"theme.{key}", "invalid_color")}, bad


def test_the_screen_background_is_the_existing_background_colour():
    """§6.2: "background" is theme.backgroundColor — no second key for the same thing."""
    assert "background" not in C.DEFAULT_CONFIG["theme"]
    _c, errors = C.validate_layer({"theme": {"background": "#FFFFFF"}})
    assert _paths(errors) == {"theme.background"}


# ── "דלג על בחירת אמצעי תשלום" ────────────────────────────────────────────────


def test_payment_chooser_skip_is_auto_or_never():
    assert C.validate_layer({"payment": {"paymentChooserSkip": "never"}})[1] == []
    _c, errors = C.validate_layer({"payment": {"paymentChooserSkip": "always"}})
    assert _paths(errors) == {"payment.paymentChooserSkip"}
    assert C.limits()["enums"]["paymentChooserSkip"] == ["auto", "never"]


@pytest.mark.parametrize("methods,skip,mode", [
    (["card"], "auto", "off"),               # the card alone: straight to the card (as always)
    (["card"], "never", "required"),         # the window always
    (["card", "voucher"], "auto", "required"),
    (["card", "split_card"], "auto", "required"),
    (["cash_at_till"], "auto", "required"),
    (["card", "cash_at_till"], "never", "required"),
])
def test_the_pay_method_step_skips_only_the_card_alone_in_auto(methods, skip, mode):
    cfg = C.resolve({"payment": {"methods": methods, "paymentChooserSkip": skip}})
    assert C.step_mode(cfg, "payMethod") == mode


def test_an_explicit_off_step_still_wins_over_never():
    cfg = C.resolve({"payment": {"methods": ["card"], "paymentChooserSkip": "never", "stepModes": {"payMethod": "off"}}})
    assert C.step_mode(cfg, "payMethod") == "off"
