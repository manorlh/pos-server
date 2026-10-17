"""
"קיוסק: לחיצה על פריט מוסיפה לסל, ותג כמות על הפריט" (P:/specs/kiosk-tap-add-count-badge.md).

`layout.cartCountBadge` — how many of a dish the basket holds, on the dish's card in every template:
on by default (no template sets it), a level may turn it off and a lower one back on, refused when it
is not a boolean, and it reaches the kiosk in its config (a new config version when it changes).
`layout.quickAdd` ("הוספה מהירה"): since 17.10 (owner) no_required by default — a tap on a dish with nothing to
choose puts it in — always on the wall; a level that chose "off" keeps it (only an unset key follows the default).
`layout.infoButton` ("כפתור פרטים", ⓘ): auto | always | off, default auto.
"""
from __future__ import annotations

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_layout as L
from test_kiosks import convert, get_settings, paths, put, refused, sync, w  # noqa: F401  (the world fixture)


# ── The default ──────────────────────────────────────────────────────────────


def test_the_badge_is_on_by_default_and_quick_add_is_no_required():
    assert L.LAYOUT_DEFAULTS["cartCountBadge"] is True
    assert C.DEFAULT_CONFIG["layout"]["cartCountBadge"] is True
    assert L.LAYOUT_DEFAULTS["quickAdd"] == "no_required"
    assert C.DEFAULT_CONFIG["layout"]["quickAdd"] == "no_required"
    assert L.LAYOUT_DEFAULTS["infoButton"] == "auto" and "infoButton" in L.LAYOUT_TEMPLATE_KEYS
    assert "cartCountBadge" in L.LAYOUT_TEMPLATE_KEYS
    assert C.validate_config(C.default_config()) == []


@pytest.mark.parametrize("template", L.LAYOUT_TEMPLATE_IDS)
def test_every_template_draws_the_badge_and_keeps_its_quick_add(template):
    assert "cartCountBadge" not in L.LAYOUT_TEMPLATES[template].get("layout", {})
    for style in C.UI_PRESETS:
        cfg = C.resolve({"theme": {"uiStyle": style}, "layout": {"template": template}})
        assert cfg["layout"]["cartCountBadge"] is True, style
        assert cfg["layout"]["quickAdd"] == ("always" if template == "wall" else "no_required"), style
        assert cfg["layout"]["infoButton"] == "auto", style
        assert C.validate_config(cfg) == []


def test_an_older_stored_layer_without_the_key_gets_the_badge():
    cfg = C.resolve({"layout": {"template": "list", "quickAdd": "no_required"}})
    assert cfg["layout"]["cartCountBadge"] is True and cfg["layout"]["quickAdd"] == "no_required"


# ── Validation ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [True, False])
def test_a_boolean_saves(value):
    clean, errors = C.validate_layer({"layout": {"cartCountBadge": value}})
    assert errors == [] and clean == {"layout": {"cartCountBadge": value}}


def test_null_inherits_and_is_dropped():
    clean, errors = C.validate_layer({"layout": {"cartCountBadge": None}})
    assert errors == [] and clean == {}


@pytest.mark.parametrize("bad", ["yes", "on", 1, 0, [], {}])
def test_anything_but_a_boolean_is_refused(bad):
    _clean, errors = C.validate_layer({"layout": {"cartCountBadge": bad}})
    assert paths(errors) == {"layout.cartCountBadge": "invalid_type"}


def test_a_complete_config_with_a_bad_badge_is_refused():
    cfg = C.default_config()
    cfg["layout"]["cartCountBadge"] = "true"
    assert "layout.cartCountBadge" in {e.path for e in C.validate_config(cfg)}


# ── The levels ───────────────────────────────────────────────────────────────


def test_resolved_per_level_like_every_layout_key():
    off = C.resolve({"layout": {"template": "magazine"}}, {"layout": {"cartCountBadge": False}})
    assert off["layout"]["cartCountBadge"] is False and off["layout"]["catalog"] == "magazine"
    back = C.resolve({"layout": {"cartCountBadge": False}}, {}, {"layout": {"cartCountBadge": True}})
    assert back["layout"]["cartCountBadge"] is True
    # Picking another template at a lower level keeps the level's own choice.
    kept = C.resolve({"layout": {"template": "tabs", "cartCountBadge": False}}, {}, {"layout": {"template": "wall"}})
    assert kept["layout"]["cartCountBadge"] is False and kept["layout"]["quickAdd"] == "always"


def test_the_badge_is_saved_per_level_and_reaches_the_kiosk(w):
    convert(w)
    before = sync(w, w.kiosk)
    assert before["config"]["layout"]["cartCountBadge"] is True

    put(w, "company", w.company.id, {"layout": {"cartCountBadge": False, "quickAdd": "no_required"}})
    out = sync(w, w.kiosk)
    assert out["config"]["layout"]["cartCountBadge"] is False
    assert out["config"]["layout"]["quickAdd"] == "no_required"
    assert out["configVersion"] != before["configVersion"]
    shop = get_settings(w, "shop", w.shop.id)
    assert shop["effective"]["layout"]["cartCountBadge"] is False and shop["overrides"] == {}

    # The kiosk turns it back on for itself; the company's stays off for the rest.
    view = put(w, "machine", w.kiosk.id, {"layout": {"cartCountBadge": True}})
    assert view["overrides"] == {"layout": {"cartCountBadge": True}}
    assert view["inheritedLayers"]["layout"]["cartCountBadge"] is False
    assert sync(w, w.kiosk)["config"]["layout"]["cartCountBadge"] is True
    assert get_settings(w, "shop", w.shop.id)["effective"]["layout"]["cartCountBadge"] is False

    # null at the kiosk inherits the company's again.
    put(w, "machine", w.kiosk.id, {"layout": {"cartCountBadge": None}})
    assert sync(w, w.kiosk)["config"]["layout"]["cartCountBadge"] is False


def test_a_bad_value_is_refused_with_the_contract_shape(w):
    convert(w)
    err = refused(put, w, "machine", w.kiosk.id, {"layout": {"cartCountBadge": "yes"}})
    assert err.status_code == 422
    assert {"path": "layout.cartCountBadge", "code": "invalid_type"}.items() <= err.detail["errors"][0].items()


# ── "הוספה מהירה" by default (17.10): explicit wins ──────────────────────────


def test_a_level_that_chose_off_keeps_it():
    assert C.resolve({"layout": {"quickAdd": "off"}})["layout"]["quickAdd"] == "off"
    # The company's "off" reaches a shop and a kiosk that never chose; a lower level may still turn it on.
    assert C.resolve({"layout": {"quickAdd": "off"}}, {}, {})["layout"]["quickAdd"] == "off"
    assert C.resolve({"layout": {"quickAdd": "off"}}, {}, {"layout": {"quickAdd": "always"}})["layout"]["quickAdd"] == "always"
    # …and a template picked below does not take it back.
    assert C.resolve({"layout": {"quickAdd": "off"}}, {"layout": {"template": "magazine"}})["layout"]["quickAdd"] == "off"


def test_a_level_that_never_chose_gets_the_new_default():
    for layers in ([], [{}], [{"layout": {"cartCountBadge": False}}], [{"theme": {"uiStyle": "wolt"}}, {}, {"layout": {"template": "list"}}]):
        assert C.resolve(*layers)["layout"]["quickAdd"] == "no_required", layers


def test_off_saves_as_an_explicit_choice_and_reaches_the_kiosk(w):
    convert(w)
    assert sync(w, w.kiosk)["config"]["layout"]["quickAdd"] == "no_required"
    view = put(w, "company", w.company.id, {"layout": {"quickAdd": "off"}})
    assert view["overrides"] == {"layout": {"quickAdd": "off"}}
    assert sync(w, w.kiosk)["config"]["layout"]["quickAdd"] == "off"


# ── "כפתור פרטים" (layout.infoButton) ───────────────────────────────────────


@pytest.mark.parametrize("value", ["auto", "always", "off"])
def test_the_info_button_saves(value):
    clean, errors = C.validate_layer({"layout": {"infoButton": value}})
    assert errors == [] and clean == {"layout": {"infoButton": value}}


@pytest.mark.parametrize("bad", ["sometimes", True, 1])
def test_an_unknown_info_button_is_refused(bad):
    _clean, errors = C.validate_layer({"layout": {"infoButton": bad}})
    assert "layout.infoButton" in paths(errors)


def test_the_info_button_golden_speaks_the_servers_vocabulary():
    import hashlib
    import json
    from pathlib import Path

    data = (Path(__file__).parent / "fixtures" / "kiosk_info_button_golden.json").read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == INFO_GOLDEN_SHA256
    doc = json.loads(data)
    assert tuple(doc["constants"]["modes"]) == L.LAYOUT_INFO_BUTTONS
    assert doc["constants"]["default"] == L.LAYOUT_DEFAULTS["infoButton"]


#: The same constant in the dashboard's kioskInfoButton.test.ts and pos-android's KioskInfoButtonTest.
INFO_GOLDEN_SHA256 = "c2b7a0eee3c6d2e649ec4145485332d1a14dc7089435d5aa31d8f61c49e175dc"
