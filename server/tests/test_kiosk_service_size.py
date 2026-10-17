"""
"גודל כרטיסי לקחת / לשבת" (P:/specs/kiosk-service-size.md; app/services/kiosk_service_size.py, kiosk_config.py).

* The shared golden fixture kiosk_service_size_golden.json: the same bytes as kiosk-desktop's and the till's (SHA
  pinned here, in kiosk-desktop/test/kioskServiceSize.test.ts and in pos-android KioskServiceSizeTest.kt), and every
  rule of the reference against it.
* "auto" is sensible: portrait is today's (nothing set), landscape keeps the cards, the question and "להמשך" in the
  window (a card at most 45% of the height, the icon at most 96 dp).
* The config: `general.serviceCardSize` and the numeric overrides optional and absent by default (the same
  configVersion); validated (enum, range, step); allowed in the `landscape` block's `general`; merged by level.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_service_size as S
from test_kiosks import convert, put, w  # noqa: F401  (the fixture)

FIXTURE = Path(__file__).parent / "fixtures" / "kiosk_service_size_golden.json"
#: kiosk_service_size_golden.json, LF-normalised (the same constant in kiosk-desktop's and pos-android's tests).
GOLDEN_SHA256 = "8077021f835924a916e1256b1da9dc999449dfbf01d1cbabb7e75dfb7abe04d5"


@pytest.fixture(scope="module")
def golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_golden_is_the_shared_bytes():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


def test_the_vocabulary_ranges_and_presets(golden):
    assert golden["sizes"] == list(S.SERVICE_CARD_SIZES) and golden["default"] == "auto"
    assert golden["keys"] == list(S.KEYS)
    assert golden["numbers"] == {k: {"min": lo, "max": hi, "step": st} for k, (lo, hi, st) in S.NUMBER_SPECS.items()}
    assert golden["presets"] == S.PRESETS
    # Small < medium < large in every measure.
    for field in ("cardMaxWidthDp", "cardHeightDp", "iconDp"):
        assert S.PRESETS["small"][field] < S.PRESETS["medium"][field] < S.PRESETS["large"][field]


def test_every_golden_rule(golden):
    for case in golden["numberValue"]:
        assert S.number_value(case["key"], case["raw"]) == case["expect"], case
    for case in golden["sizeName"]:
        assert S.size_name(case["raw"]) == case["expect"], case
    for case in golden["settingsInForce"]:
        assert S.settings_in_force(case["general"], case["landscapeBlock"], case["landscape"]) == case["expect"], case["name"]
    for case in golden["autoLandscape"]:
        assert S.auto_landscape(case["heightDp"]) == case["expect"], case
    for case in golden["resolve"]:
        assert S.resolve(case["general"], case["landscapeBlock"], case["display"]) == case["expect"], case["name"]
    for case in golden["attractButtons"]:
        assert S.attract_buttons(case["boxWDp"], case["boxHDp"], case["measures"]) == case["expect"], case["name"]


@pytest.mark.parametrize("w_dp, h_dp", [(1536, 864), (1920, 1080), (1815, 1080), (1366, 768), (1280, 800), (853, 533)])
def test_auto_in_landscape_fits_with_room_to_spare(w_dp, h_dp):
    m = S.resolve({}, None, {"landscape": True, "widthDp": w_dp, "heightDp": h_dp})
    assert m["iconDp"] <= 96
    assert m["cardHeightDp"] <= h_dp * 0.45
    # Two cards side by side never wider than the window less its margins.
    assert 2 * m["cardMaxWidthDp"] + 16 <= w_dp - 64
    # The owner's 14" at 125%: about a quarter of the height, not two thirds of it (0.5.9).
    if (w_dp, h_dp) == (1536, 864):
        assert m == {"size": "auto", "cardMaxWidthDp": 319, "cardHeightDp": 220, "iconDp": 92}


def test_auto_in_portrait_is_todays():
    for size in ({}, {"serviceCardSize": "auto"}):
        m = S.resolve(size, None, {"landscape": False, "widthDp": 1080, "heightDp": 1920})
        assert m == {"size": "auto", "cardMaxWidthDp": None, "cardHeightDp": None, "iconDp": None}


def test_a_chosen_size_is_still_capped_in_landscape():
    m = S.resolve({"serviceCardSize": "large", "serviceCardHeight": 400}, None, {"landscape": True, "widthDp": 1366, "heightDp": 768})
    assert m["cardHeightDp"] == 768 * 45 // 100
    m = S.resolve({"serviceIconSize": 160, "serviceCardHeight": 100}, None, {"landscape": False, "widthDp": 1080, "heightDp": 1920})
    assert m["iconDp"] == 60  # never more than 60% of its card


# ── The config ───────────────────────────────────────────────────────────────


def test_absent_by_default_and_the_version_does_not_move():
    assert all(k not in C.DEFAULT_CONFIG["general"] for k in S.KEYS)
    base = C.resolve({})
    assert all(k not in base["general"] for k in S.KEYS)
    assert C.validate_config(base) == []
    cleaned, errors = C.validate_layer({"general": {"serviceCardSize": None, "serviceIconSize": None}})
    assert errors == [] and cleaned == {}
    assert C.config_version(C.resolve(cleaned)) == C.config_version(base)


def test_a_full_setting_validates_and_reaches_the_kiosk():
    layer = {
        "general": {"serviceCardSize": "small", "serviceIconSize": 64, "serviceCardMaxWidth": 240, "serviceCardHeight": 160},
        "landscape": {"general": {"serviceCardSize": "medium", "serviceCardHeight": 180}},
    }
    cleaned, errors = C.validate_layer(layer)
    assert errors == [] and cleaned == layer
    cfg = C.resolve(layer)
    assert C.validate_config(cfg) == []
    assert cfg["general"]["serviceCardSize"] == "small" and cfg["landscape"]["general"]["serviceCardHeight"] == 180
    assert C.config_version(cfg) != C.config_version(C.resolve({}))


@pytest.mark.parametrize("layer, path, code", [
    ({"general": {"serviceCardSize": "huge"}}, "general.serviceCardSize", "invalid_value"),
    ({"general": {"serviceIconSize": 30}}, "general.serviceIconSize", "out_of_range"),
    ({"general": {"serviceIconSize": 81}}, "general.serviceIconSize", "invalid_step"),
    ({"general": {"serviceCardMaxWidth": 999}}, "general.serviceCardMaxWidth", "out_of_range"),
    ({"general": {"serviceCardHeight": "200"}}, "general.serviceCardHeight", "invalid_type"),
    ({"general": {"serviceCardHeight": True}}, "general.serviceCardHeight", "invalid_type"),
    ({"landscape": {"general": {"serviceCardSize": "xl"}}}, "landscape.general.serviceCardSize", "invalid_value"),
    ({"landscape": {"general": {"serviceIconSize": 200}}}, "landscape.general.serviceIconSize", "out_of_range"),
    ({"landscape": {"general": {"serviceSelect": "instant"}}}, "landscape.general.serviceSelect", "unknown_key"),
])
def test_the_settings_are_validated(layer, path, code):
    _cleaned, errors = C.validate_layer(layer)
    assert (path, code) in [(e.path, e.code) for e in errors], errors


def test_a_stored_layer_with_a_broken_size_keeps_the_rest():
    layer = C.sanitize_stored_layer({"general": {"serviceIconSize": 1000, "serviceCardSize": "large"}})
    assert layer == {"general": {"serviceCardSize": "large"}}


def test_the_size_merges_across_the_levels(w):  # noqa: F811
    convert(w)
    put(w, "company", w.company.id, {"general": {"serviceCardSize": "large", "serviceIconSize": 80},
                                     "landscape": {"general": {"serviceCardSize": "small"}}})
    put(w, "shop", w.shop.id, {"general": {"serviceCardSize": "medium"}})
    out = put(w, "machine", w.kiosk.id, {"general": {"serviceIconSize": None, "serviceCardHeight": 200}})
    eff = out["effective"]
    assert eff["general"]["serviceCardSize"] == "medium"
    assert eff["general"]["serviceIconSize"] == 80 and eff["general"]["serviceCardHeight"] == 200
    assert eff["landscape"]["general"] == {"serviceCardSize": "small"}
    assert C.validate_config(eff) == []


def test_the_defaults_endpoint_carries_the_ranges():
    lim = C.limits()
    assert lim["serviceSize"]["sizes"] == ["auto", "small", "medium", "large"]
    assert lim["serviceSize"]["numbers"]["serviceIconSize"] == {"min": 40, "max": 160, "step": 4}
    assert lim["landscape"]["generalKeys"] == list(S.KEYS)


def test_the_reference_reads_any_value_without_breaking():
    for raw in (None, "x", True, float("nan"), float("inf"), [], {}):
        assert S.number_value("serviceIconSize", raw) is None
        assert S.size_name(raw) == "auto"
    assert S.resolve("broken", "broken", {"landscape": True, "widthDp": 1536, "heightDp": 864})["size"] == "auto"
    assert S.resolve({}, None, {"landscape": True})["cardHeightDp"] is None  # no measures: the renderer's own
