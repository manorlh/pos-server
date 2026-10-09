"""
"רקע הקיוסק" and "גודל טקסט" (the owner: the kiosk's background — a picture or a colour — on every
screen; the text size of the products, their descriptions and so on): the theme keys the cloud
validates and resolves. The colours a kiosk paints with, the picture's veil and the sizes' range are
pinned by the shared golden tests/fixtures/kiosk_theme_colors_golden.json, which the dashboard's
kioskConfig.test.ts and the till's KioskBackgroundTest read too (pos-android app/src/test/resources,
byte for byte).
"""
from __future__ import annotations

import json
from pathlib import Path

from app.services import kiosk_config as C

GOLDEN = Path(__file__).parent / "fixtures" / "kiosk_theme_colors_golden.json"


def paths(errors):
    return {e.path: e.code for e in errors}


def gold():
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_the_defaults_veil_at_70_on_every_screen_every_text_at_100():
    theme = C.default_config()["theme"]
    assert theme["backgroundOverlay"] == 70
    assert theme["backgroundScope"] == "all"
    assert theme["textSizes"] == {key: 100 for key in C.TEXT_SIZE_KEYS}
    assert C.validate_config(C.default_config()) == []


def test_the_shared_golden_is_the_servers_vocabulary():
    g = gold()
    assert g["overlay"] == {
        "min": C.BACKGROUND_OVERLAY_MIN, "max": C.BACKGROUND_OVERLAY_MAX, "default": C.BACKGROUND_OVERLAY_DEFAULT,
    }
    assert tuple(g["scopes"]) == C.BACKGROUND_SCOPES
    ts = g["textSizes"]
    assert tuple(ts["keys"]) == C.TEXT_SIZE_KEYS
    assert (ts["min"], ts["max"], ts["step"], ts["default"]) == (
        C.TEXT_SIZE_MIN, C.TEXT_SIZE_MAX, C.TEXT_SIZE_STEP, C.TEXT_SIZE_DEFAULT,
    )
    # Every golden colour case names a theme the cloud accepts.
    for case in g["colors"]:
        layer = {"theme": {k: case[k] for k in ("mode", "backgroundColor", "surfaceColor", "textColor") if case[k] is not None}}
        _c, errors = C.validate_layer(layer)
        assert errors == [], (case["name"], errors)


def test_a_layer_sets_the_veil_the_scope_and_any_one_size():
    _c, errors = C.validate_layer({"theme": {
        "backgroundOverlay": 40, "backgroundScope": "rest", "textSizes": {"productName": 120, "buttons": 80},
    }})
    assert errors == []
    for overlay in (0, 90):
        assert C.validate_layer({"theme": {"backgroundOverlay": overlay}})[1] == []


def test_refused_out_of_range_off_step_unknown():
    cases = [
        ({"backgroundOverlay": 95}, "theme.backgroundOverlay", "out_of_range"),
        ({"backgroundOverlay": -1}, "theme.backgroundOverlay", "out_of_range"),
        ({"backgroundOverlay": 50.5}, "theme.backgroundOverlay", "invalid_type"),
        ({"backgroundOverlay": True}, "theme.backgroundOverlay", "invalid_type"),
        ({"textSizes": {"productName": 160}}, "theme.textSizes.productName", "out_of_range"),
        ({"textSizes": {"productName": 70}}, "theme.textSizes.productName", "out_of_range"),
        ({"textSizes": {"cartLines": 115}}, "theme.textSizes.cartLines", "invalid_step"),
        ({"textSizes": {"headline": 100}}, "theme.textSizes.headline", "unknown_key"),
        ({"textSizes": 120}, "theme.textSizes", "invalid_type"),
    ]
    for theme, path, code in cases:
        _c, errors = C.validate_layer({"theme": theme})
        assert paths(errors).get(path) == code, (theme, paths(errors))
    _c, errors = C.validate_layer({"theme": {"backgroundScope": "sometimes"}})
    assert "theme.backgroundScope" in paths(errors)


def test_each_level_sets_its_own_sizes_and_the_rest_are_inherited():
    cfg = C.resolve(
        {"theme": {"textSizes": {"productName": 120}, "backgroundOverlay": 40}},
        {"theme": {"textSizes": {"cartLines": 90}}},
        {"theme": {"textSizes": {"productName": 140}, "backgroundScope": "rest"}},
    )
    sizes = cfg["theme"]["textSizes"]
    assert sizes["productName"] == 140
    assert sizes["cartLines"] == 90
    assert sizes["buttons"] == 100
    assert cfg["theme"]["backgroundOverlay"] == 40
    assert cfg["theme"]["backgroundScope"] == "rest"
    assert C.validate_config(cfg) == []


def test_a_style_never_resets_them():
    for style in C.UI_STYLES:
        cfg = C.resolve({"theme": {"uiStyle": style, "backgroundOverlay": 30, "textSizes": {"itemName": 150}}})
        assert cfg["theme"]["backgroundOverlay"] == 30, style
        assert cfg["theme"]["textSizes"]["itemName"] == 150, style
        assert cfg["theme"]["backgroundScope"] == "all", style
        # The style's own background colour stays a style key (a picked one still wins).
        assert "backgroundOverlay" not in C.UI_PRESETS[style]
        assert "textSizes" not in C.UI_PRESETS[style]


def test_the_dashboards_form_gets_the_ranges():
    lim = C.limits()
    assert lim["theme"]["backgroundOverlay"] == {"min": 0, "max": 90}
    assert lim["theme"]["textSize"] == {"min": 80, "max": 150, "step": 10, "keys": list(C.TEXT_SIZE_KEYS)}
    assert lim["enums"]["backgroundScope"] == ["all", "rest"]


def test_the_picture_still_travels_to_the_kiosk():
    """The background picture is among the media a kiosk downloads, whichever screens show it."""
    good = {"url": "https://cdn.example/bg.jpg", "kind": "image", "sha256": "a" * 64, "bytes": 1234}
    for scope in C.BACKGROUND_SCOPES:
        cfg = C.resolve({"theme": {"backgroundImage": good, "backgroundScope": scope}})
        assert good["url"] in [m["url"] for m in C._media_refs(cfg)], scope
