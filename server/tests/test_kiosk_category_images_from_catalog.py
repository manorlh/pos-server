"""
"תמונת מחלקה מהקטלוג" (P:/specs/category-color-image.md §3): `catalog.categoryImagesFromCatalog` in the
kiosk config (app/services/kiosk_config.py). On by default: a category with no picture of the kiosk's
own (`catalog.categoryImages`) shows the catalog's (`categories.image_url`), and with none there its
initial on the catalog's colour. The kiosk's own pictures always win; off — the kiosk's own only.
Additive: every config that resolved before it resolves the same, the key at its default
(tests/test_kiosk_rail_motion.py holds the baseline).
"""
from __future__ import annotations

from app.services import kiosk_config as C

KEY = "categoryImagesFromCatalog"


def test_on_by_default_and_the_defaults_still_validate():
    assert C.DEFAULT_CONFIG["catalog"][KEY] is True
    assert C.default_config()["catalog"][KEY] is True
    assert C.resolve()["catalog"][KEY] is True
    assert C.validate_config(C.default_config()) == []


def test_a_level_turns_it_off_and_a_lower_one_on_again():
    off = {"catalog": {KEY: False}}
    assert C.resolve(off)["catalog"][KEY] is False
    assert C.resolve(off, {"catalog": {KEY: True}})["catalog"][KEY] is True
    # null inherits.
    assert C.resolve(off, {"catalog": {KEY: None}})["catalog"][KEY] is False
    # The kiosk's own pictures are left as they are either way.
    own = {"catalog": {KEY: False, "categoryImages": {"c1": {"url": "https://x/c1.png", "kind": "image"}}}}
    cfg = C.resolve(own)
    assert cfg["catalog"]["categoryImages"]["c1"]["url"] == "https://x/c1.png"


def test_only_a_boolean():
    cleaned, errors = C.validate_layer({"catalog": {KEY: False}})
    assert errors == [] and cleaned == {"catalog": {KEY: False}}
    for bad in ("yes", 1, "true", [], {}):
        _cleaned, errors = C.validate_layer({"catalog": {KEY: bad}})
        assert [e.path for e in errors] == [f"catalog.{KEY}"], bad


def test_a_stored_layer_from_before_the_key_reads_it_on():
    stored = {"catalog": {"categoryOrder": ["a"], "oneCategory": False}}
    cfg = C.resolve(stored)
    assert cfg["catalog"][KEY] is True and cfg["catalog"]["categoryOrder"] == ["a"]
