"""
"עיצוב לרוחב" (P:/specs/kiosk-landscape-design.md; app/services/kiosk_landscape.py, kiosk_config.py `landscape`).

* The shared golden fixture kiosk_landscape_golden.json: the same bytes as kiosk-desktop's and the till's (SHA
  pinned here, in kiosk-desktop/test/kioskLandscape.test.ts and in pos-android KioskLandscapeTest.kt), and every
  rule of the reference against it: the sizes, the columns, the category column, the pictures, the text, the
  four screens the owner checks, and the design as drawn in landscape (`apply`).
* The config: `landscape` optional and absent by default (an empty block is no block — the same configVersion);
  every key validated with the normal design's vocabulary and the sizes' ranges and steps; the block merges
  across company → shop → machine; its media are downloaded; `GET /kiosks/defaults` carries the sizes' ranges.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_landscape as L
from test_kiosks import convert, put, w  # noqa: F401  (the fixture)

FIXTURE = Path(__file__).parent / "fixtures" / "kiosk_landscape_golden.json"
#: kiosk_landscape_golden.json, LF-normalised (the same constant in kiosk-desktop's and pos-android's tests).
GOLDEN_SHA256 = "4bb0c99e5398d36f5a6f46bcbc4c2ce8fddeeb4f6d3c7eb4ba64ed6f35a5fb3e"
SHA = "a" * 64


@pytest.fixture(scope="module")
def golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_golden_is_the_shared_bytes():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


def test_the_sizes_defaults_ranges_and_constants(golden):
    assert golden["sizes"]["defaults"] == L.SIZE_DEFAULTS
    assert golden["sizes"]["ranges"] == {k: {"min": v[1], "max": v[2], "step": v[3]} for k, v in L.SIZE_SPECS.items()}
    assert golden["constants"] == {
        "gapDp": L.GAP_DP, "minTileDp": L.MIN_TILE_DP,
        "categoryColumnMaxShare": L.CATEGORY_COLUMN_MAX_SHARE, "minTouchDp": L.MIN_TOUCH_DP,
    }
    assert golden["overrideKeys"] == {k: list(v) for k, v in L.OVERRIDE_KEYS.items()}
    # "לא ענקיים" out of the box: a category column 200–260 dp, a dish's tile at most 240 dp.
    assert 200 <= L.SIZE_DEFAULTS["categoryColumnDp"] <= 260
    assert L.SIZE_DEFAULTS["productTileMaxDp"] <= 240 and L.SIZE_DEFAULTS["productImageMaxDp"] <= 160


def test_every_golden_rule(golden):
    for case in golden["resolveSizes"]:
        assert L.resolve_sizes(case["block"]) == case["expect"], case["name"]
    sized = lambda s: L.resolve_sizes({"sizes": s})  # noqa: E731
    for case in golden["productColumns"]:
        assert L.product_columns(case["columns"], case["gridDp"], sized(case["sizes"])) == case["expect"], case
    for case in golden["categoryColumn"]:
        assert L.category_column_dp(case["widthDp"], sized(case["sizes"])) == case["expect"], case
    for case in golden["categoryItem"]:
        assert L.category_item_dp(case["computedDp"], sized(case["sizes"])) == case["expect"], case
    for case in golden["categoryImage"]:
        assert L.category_image_dp(case["computedDp"], sized(case["sizes"])) == case["expect"], case
    for case in golden["productImage"]:
        assert L.product_image_dp(case["computedDp"], sized(case["sizes"])) == case["expect"], case
    for case in golden["textScale"]:
        assert L.text_scale(case["displayScale"], sized(case["sizes"])) == case["expect"], case
    for case in golden["apply"]:
        out = L.apply(case["config"], case["display"])
        got = {"theme": out["config"]["theme"], "layout": out["config"]["layout"], "attract": out["config"]["attract"],
               "explicit": out["explicit"]}
        assert got == case["expect"], case["name"]


def test_the_owners_screens_are_not_huge(golden):
    """1920×1080, 1536×864 (14" at 125%), 1366×768, 1280×800: no dish tile over 240 dp, the column 232 dp."""
    by_name = {s["name"]: s["expect"] for s in golden["screens"]}
    for name in ("1920x1080", "1536x864 (14in at 125%)", "1366x768", "1280x800"):
        e = by_name[name]
        assert e["tileDp"] <= L.SIZE_DEFAULTS["productTileMaxDp"] and e["tileDp"] >= L.MIN_TILE_DP, name
        assert e["categoryColumnDp"] == 232 and e["imageDp43"] <= 160, name
    assert by_name["1920x1080"]["columns"] == 5


# ── The config ───────────────────────────────────────────────────────────────


def _media(url, kind="image"):
    return {"url": url, "kind": kind, "sha256": SHA, "bytes": 10}


FULL_BLOCK = {
    "theme": {"categoryLayout": "top", "cartStyle": "bar", "gridDensity": "compact", "categoryStyle": "images",
              "imageRatio": "16:9", "typeScale": "large", "backgroundImage": _media("https://cdn.example/bg-wide.jpg")},
    "layout": {"catalog": "wall", "basket": "panel", "railSize": "s", "productSize": "s", "categoryIcons": "line",
               "card": "tile"},
    "attract": {"playlist": [{"media": _media("https://cdn.example/wide.mp4", "video"), "durationSec": 20}]},
    "sizes": {"categoryColumnDp": 200, "categoryItemMaxDp": 80, "categoryImageMaxDp": 48, "productTileMaxDp": 220,
              "productMinColumns": 4, "productImageMaxDp": 140, "textScalePct": 90},
}


def test_absent_by_default_and_an_empty_block_keeps_the_version():
    assert "landscape" not in C.DEFAULT_CONFIG
    base = C.resolve({})
    assert "landscape" not in base
    assert C.validate_config(base) == []
    for empty in ({"landscape": {}}, {"landscape": {"theme": {}, "sizes": {}}}, {"landscape": {"theme": {"cartStyle": None}}}):
        cleaned, errors = C.validate_layer(empty)
        assert errors == [] and cleaned == {}, empty
        assert C.config_version(C.resolve(empty)) == C.config_version(base)


def test_a_full_block_validates_and_reaches_the_kiosk():
    cleaned, errors = C.validate_layer({"landscape": FULL_BLOCK})
    assert errors == []
    playlist = [{"media": FULL_BLOCK["attract"]["playlist"][0]["media"], "durationSec": 20}]
    assert cleaned["landscape"]["attract"]["playlist"] == playlist
    cfg = C.resolve({"landscape": FULL_BLOCK})
    assert C.validate_config(cfg) == []
    assert cfg["landscape"]["sizes"] == FULL_BLOCK["sizes"]
    assert cfg["landscape"]["layout"]["catalog"] == "wall"
    # The normal design is untouched: portrait is today's.
    assert cfg["theme"]["categoryLayout"] == "side" and cfg["layout"]["catalog"] is None
    assert C.config_version(cfg) != C.config_version(C.resolve({}))
    urls = [m["url"] for m in C.media_manifest(cfg)]
    assert "https://cdn.example/wide.mp4" in urls and "https://cdn.example/bg-wide.jpg" in urls


@pytest.mark.parametrize("block, path, code", [
    ({"sizes": {"categoryColumnDp": 100}}, "landscape.sizes.categoryColumnDp", "out_of_range"),
    ({"sizes": {"productTileMaxDp": 999}}, "landscape.sizes.productTileMaxDp", "out_of_range"),
    ({"sizes": {"categoryColumnDp": 230}}, "landscape.sizes.categoryColumnDp", "invalid_step"),
    ({"sizes": {"textScalePct": 103}}, "landscape.sizes.textScalePct", "invalid_step"),
    ({"sizes": {"productMinColumns": 3.5}}, "landscape.sizes.productMinColumns", "invalid_type"),
    ({"sizes": {"productMinColumns": True}}, "landscape.sizes.productMinColumns", "invalid_type"),
    ({"sizes": {"huge": 1}}, "landscape.sizes.huge", "unknown_key"),
    ({"theme": {"cartStyle": "drawer"}}, "landscape.theme.cartStyle", "invalid_value"),
    ({"theme": {"primaryColor": "#000000"}}, "landscape.theme.primaryColor", "unknown_key"),
    ({"layout": {"template": "wall"}}, "landscape.layout.template", "unknown_key"),
    ({"layout": {"catalog": "carousel"}}, "landscape.layout.catalog", "invalid_value"),
    ({"attract": {"sections": ["hero"]}}, "landscape.attract.sections", "unknown_key"),
    ({"texts": {}}, "landscape.texts", "unknown_key"),
    ("wide", "landscape", "invalid_type"),
])
def test_the_block_is_validated(block, path, code):
    _cleaned, errors = C.validate_layer({"landscape": block})
    assert (path, code) in [(e.path, e.code) for e in errors], errors


def test_a_stored_block_with_a_broken_key_keeps_the_rest():
    layer = C.sanitize_stored_layer({"landscape": {"sizes": {"categoryColumnDp": 1000, "productTileMaxDp": 200}}})
    assert layer == {"landscape": {"sizes": {"productTileMaxDp": 200}}}


def test_the_block_merges_across_the_levels(w):  # noqa: F811
    convert(w)
    put(w, "company", w.company.id, {"landscape": {"sizes": {"categoryColumnDp": 240, "productTileMaxDp": 260},
                                                   "theme": {"cartStyle": "panel"}}})
    put(w, "shop", w.shop.id, {"landscape": {"sizes": {"productTileMaxDp": 200}}})
    out = put(w, "machine", w.kiosk.id, {"landscape": {"theme": {"cartStyle": "bar", "gridDensity": "compact"},
                                                       "sizes": {"categoryColumnDp": None}}})
    assert out["overrides"] == {"landscape": {"theme": {"cartStyle": "bar", "gridDensity": "compact"}}}
    eff = out["effective"]
    assert eff["landscape"] == {
        "sizes": {"categoryColumnDp": 240, "productTileMaxDp": 200},
        "theme": {"cartStyle": "bar", "gridDensity": "compact"},
    }
    assert C.validate_config(eff) == []
    # A level that saves an empty block stores nothing.
    out = put(w, "machine", w.kiosk.id, {"landscape": {}})
    assert out["overrides"] == {} and out["effective"]["landscape"]["theme"] == {"cartStyle": "panel"}


def test_the_defaults_endpoint_carries_the_sizes():
    sizes = C.limits()["landscape"]["sizes"]
    assert sizes["categoryColumnDp"] == {"default": 232, "min": 160, "max": 360, "step": 4}
    assert set(sizes) == set(L.SIZE_KEYS)
    assert C.limits()["landscape"]["overrideKeys"]["layout"] == list(L.OVERRIDE_KEYS["layout"])


def test_the_reference_reads_any_value_without_breaking():
    for raw in (None, "x", True, float("nan"), float("inf"), [], {}):
        assert L.size_value("productTileMaxDp", raw) == 240
    assert L.size_value("productTileMaxDp", 10_000) == 480 and L.size_value("productTileMaxDp", -5) == 160
    assert L.apply({"theme": {}, "layout": {}, "landscape": "broken"}, {"landscape": True, "sideCart": True, "rail": True})[
        "config"]["theme"] == {"cartStyle": "panel"}
