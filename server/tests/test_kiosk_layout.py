"""
"מבנה הקיוסק" (app/services/kiosk_layout.py, docs/SPEC_KIOSK_LAYOUTS.md): the layout's templates and
their resolution, "ברוכים הבאים", the category icons and the text registry.

The three shared golden fixtures — tests/fixtures/kiosk_layout_templates.json,
kiosk_category_icons.json, kiosk_text_registry.json — are the same bytes in pos-android's
src/test/resources (the till's KioskLayoutTest) and read by the dashboard's kioskLayout.test.ts; all
three suites pin their SHA-256 (line endings read as LF). Change a fixture in both repositories, run
server/scripts/gen_kiosk_layout_data.py, and change the constants together.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_layout as L

FIX = Path(__file__).parent / "fixtures"

#: The fixtures' SHA-256 — the same constants in pos-android's KioskLayoutTest and the dashboard's kioskLayout.test.ts.
TEMPLATES_SHA256 = "0edfa5f4f70d2cfd5fa5776d7c169edac3ecb35b2cdafaec945181782ff52752"
ICONS_SHA256 = "75ac9c79776f320370b5c73429009e4daa77a13bf3d90fbdccd8b94dd5c64fa6"
REGISTRY_SHA256 = "604e2b58954849c25cb1883a74705114ae56d12e0f60003a0d892acec56ee5a6"


def _text(name: str) -> str:
    return (FIX / name).read_bytes().replace(b"\r\n", b"\n").decode("utf-8")


def _sha(name: str) -> str:
    return hashlib.sha256(_text(name).encode("utf-8")).hexdigest()


TEMPLATES = json.loads(_text("kiosk_layout_templates.json"))


def _at(cfg, path):
    node = cfg
    for part in path.split("."):
        node = node.get(part) if isinstance(node, dict) else None
    return node


# ── The fixtures ─────────────────────────────────────────────────────────────


def test_the_fixtures_are_the_pinned_ones():
    assert _sha("kiosk_layout_templates.json") == TEMPLATES_SHA256
    assert _sha("kiosk_category_icons.json") == ICONS_SHA256
    assert _sha("kiosk_text_registry.json") == REGISTRY_SHA256


@pytest.mark.parametrize("name", ["kiosk_category_icons.json", "kiosk_text_registry.json"])
def test_the_runtime_copies_are_the_fixtures(name):
    assert (L.SHARED_DIR / name).read_bytes().replace(b"\r\n", b"\n").decode("utf-8") == _text(name)


def test_the_till_has_the_same_fixtures_when_it_is_checked_out_beside():
    till = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources"
    if not till.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    for name in ("kiosk_layout_templates.json", "kiosk_category_icons.json", "kiosk_text_registry.json"):
        assert (till / name).read_bytes().replace(b"\r\n", b"\n").decode("utf-8") == _text(name), name


def test_the_vocabulary_defaults_templates_and_back_compat_are_the_fixtures():
    assert {k: list(v) for k, v in L.LAYOUT_VOCABULARY.items()} == TEMPLATES["vocabulary"]
    assert L.LAYOUT_DEFAULTS == TEMPLATES["defaults"]
    assert L.LAYOUT_TEMPLATES == TEMPLATES["templates"]
    assert list(L.LAYOUT_TEMPLATES_READY) == TEMPLATES["implemented"]
    assert L.LAYOUT_BACK_COMPAT == TEMPLATES["backCompat"]
    assert L.WELCOME_DEFAULTS == TEMPLATES["welcome"]["defaults"]
    assert C.DEFAULT_CONFIG["layout"] == L.LAYOUT_DEFAULTS
    assert C.DEFAULT_CONFIG["attract"]["welcome"] == L.WELCOME_DEFAULTS


@pytest.mark.parametrize("case", TEMPLATES["resolveCases"], ids=lambda c: c["name"][:60])
def test_every_resolve_case(case):
    cfg = C.resolve(*case["layers"])
    for path, want in case["expect"].items():
        assert _at(cfg, path) == want, path
    assert [e for e in C.validate_config(cfg)] == []


# ── Resolution ───────────────────────────────────────────────────────────────


def test_standard_is_the_kiosk_of_today():
    today = C.resolve({"theme": {"uiStyle": "classic"}})
    assert today["layout"]["template"] == "standard"
    assert today["theme"]["categoryLayout"] == "side" and today["theme"]["cartStyle"] == "panel"
    assert today["catalog"]["oneCategory"] is True


def test_a_template_never_beats_an_explicit_key_of_any_level():
    cfg = C.resolve({"catalog": {"oneCategory": True}}, {"layout": {"template": "tabs"}})
    assert cfg["layout"]["catalog"] == "top"
    assert cfg["catalog"]["oneCategory"] is True


def test_an_invalid_template_in_a_stored_layer_is_dropped_never_an_error():
    cfg = C.resolve({"layout": {"template": "spaceship", "railSize": "l"}})
    assert cfg["layout"]["template"] == "standard" and cfg["layout"]["railSize"] == "l"


# ── Validation ───────────────────────────────────────────────────────────────


def _codes(errors):
    return {(e.path, e.code) for e in errors}


def test_a_layer_with_unknown_layout_values_is_refused():
    _clean, errors = C.validate_layer({"layout": {"template": "spaceship", "railSize": "xl", "landingColumns": 5, "nope": 1}})
    paths = {e.path for e in errors}
    assert {"layout.template", "layout.railSize", "layout.landingColumns", "layout.nope"} <= paths


def test_a_layer_may_set_any_layout_key_and_null_inherits():
    clean, errors = C.validate_layer({"layout": {"template": "guided", "catalog": None, "reach": "low", "reachToggle": True,
                                                 "nameAvatars": ["🦊 שועל", "🐼 פנדה"]}})
    assert errors == []
    assert clean == {"layout": {"template": "guided", "reach": "low", "reachToggle": True, "nameAvatars": ["🦊 שועל", "🐼 פנדה"]}}
    _clean, errors = C.validate_layer({"layout": {"nameAvatars": ["🦊", "🦊"]}})
    assert any(e.code == "duplicate" for e in errors)


def test_the_welcome_block_and_its_place_among_the_blocks():
    clean, errors = C.validate_layer({"attract": {"sections": ["hero", "welcome", "categories"],
                                                  "welcome": {"position": "top", "align": "center", "size": "xl", "titleColor": "#E4572E"}}})
    assert errors == []
    assert C.resolve(clean)["attract"]["welcome"]["position"] == "top"
    _clean, errors = C.validate_layer({"attract": {"welcome": {"position": "left", "maxWidthPct": 10, "titleColor": "red"}}})
    assert {"attract.welcome.position", "attract.welcome.maxWidthPct", "attract.welcome.titleColor"} <= {e.path for e in errors}


def test_category_icons_are_known_icons():
    clean, errors = C.validate_layer({"catalog": {"categoryIconIds": {"c1": "burger", "c2": "coffee"}}})
    assert errors == [] and clean["catalog"]["categoryIconIds"] == {"c1": "burger", "c2": "coffee"}
    _clean, errors = C.validate_layer({"catalog": {"categoryIconIds": {"c1": "spaceship"}}})
    assert [e.path for e in errors] == ["catalog.categoryIconIds.c1"]
    assert len(L.category_icon_ids()) >= 40 and "burger" in L.category_icon_ids()


# ── The texts ────────────────────────────────────────────────────────────────


def test_the_registry_holds_every_text_key_of_before():
    keys = set(L.text_keys())
    assert set(C.TEXT_KEYS) <= keys
    assert len(keys) >= 250


def test_texts_by_language_merge_key_by_key_through_the_levels():
    company = {"textsByLang": {"en": {"cartTitle": "Basket", "catalogTitle": "Menu"}}}
    shop = {"textsByLang": {"en": {"cartTitle": "My basket"}, "ar": {"cartTitle": "السلة"}}}
    cfg = C.resolve(company, shop)
    assert cfg["textsByLang"] == {"en": {"cartTitle": "My basket", "catalogTitle": "Menu"}, "ar": {"cartTitle": "السلة"}}
    assert C.validate_config(cfg) == []


def test_any_registry_text_may_be_set_for_the_first_language_too():
    clean, errors = C.validate_layer({"texts": {"landingTitle": "מה תרצו?", "cartTitle": "הסל"}})
    assert errors == [] and clean["texts"]["landingTitle"] == "מה תרצו?"


def test_texts_by_language_are_checked_against_the_registry():
    _clean, errors = C.validate_layer({"textsByLang": {"en": {"nope": "x"}, "xx": {"cartTitle": "x"}}})
    assert {"textsByLang.en.nope", "textsByLang.xx"} <= {e.path for e in errors}
    cfg = C.resolve({})
    cfg["textsByLang"] = {"en": {"cartTitle": "x" * 199, "guidedToBasket": "{count} items {foo}"}}
    codes = _codes(C.validate_config(cfg))
    limit = L.text_registry()["cartTitle"]["max"]
    if limit < 199:
        assert ("textsByLang.en.cartTitle", "too_long") in codes
    assert ("textsByLang.en.guidedToBasket", "unknown_placeholder") in codes


def test_the_limits_offer_the_layouts_icons_and_texts():
    lim = C.limits()
    assert lim["layout"]["ready"] == list(L.LAYOUT_TEMPLATES_READY)
    assert lim["layout"]["vocabulary"]["template"] == list(L.LAYOUT_TEMPLATE_IDS)
    assert "burger" in lim["categoryIconIds"]
    assert "landingTitle" in lim["textRegistryKeys"]


def test_an_older_kiosk_reads_the_layout_it_can():
    """theme.categoryLayout / cartStyle follow the layout; an old APK reads only those."""
    cfg = C.resolve({"layout": {"template": "tabs"}})
    old_apk_view = copy.deepcopy(cfg)
    del old_apk_view["layout"]
    assert old_apk_view["theme"]["categoryLayout"] == "top"
    assert old_apk_view["catalog"]["oneCategory"] is False


def test_the_product_size_is_validated_and_m_by_default():
    """"גודל מוצרים" (layout.productSize, the owner 07.10.2026): s / m / l; m is today."""
    assert C.DEFAULT_CONFIG["layout"]["productSize"] == "m"
    assert C.resolve({"layout": {"template": "landing", "productSize": "l"}})["layout"]["productSize"] == "l"
    cleaned, errors = C.validate_layer({"layout": {"productSize": "s"}})
    assert errors == [] and cleaned == {"layout": {"productSize": "s"}}
    _clean, errors = C.validate_layer({"layout": {"productSize": "xl"}})
    assert {e.path for e in errors} == {"layout.productSize"}
