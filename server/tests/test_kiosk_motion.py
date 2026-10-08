"""
"מנוע הנפשות" — the kiosk's Motion Engine (app/services/kiosk_motion.py): the shared golden, the
spec's presets and resolveDuration, the migration of the older choices, the validation of the
`motion` section, the company → shop → kiosk hierarchy, and the config reaching the kiosk.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app.models.kiosk import KioskSettings
from app.services import kiosk_config as C
from app.services import kiosk_motion as M
from test_kiosks import convert, get_settings, paths, put, sync, w  # noqa: F401  (the world fixture)

FIXTURES = Path(__file__).parent / "fixtures"
GOLD = json.loads((FIXTURES / "kiosk_motion_engine.json").read_text(encoding="utf-8"))
OLD_GOLD = json.loads((FIXTURES / "kiosk_motion_timings.json").read_text(encoding="utf-8"))


# ── The shared golden (byte-identical in pos-android app/src/test/resources) ──


def _tuples_to_lists(v):
    if isinstance(v, dict):
        return {k: _tuples_to_lists(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_tuples_to_lists(x) for x in v]
    return v


def test_the_golden_is_the_engines_own_tables():
    assert tuple(GOLD["events"]) == M.EVENTS and len(M.EVENTS) == len(set(M.EVENTS))
    assert tuple(GOLD["types"]) == M.TYPES
    # The spec's library: at least 30 kinds, every one playable by some event.
    assert len([t for t in M.TYPES if t != "none"]) >= 30
    assert {t for kinds in M.EVENT_TYPES.values() for t in kinds} == set(M.TYPES)
    assert GOLD["eventTypes"] == _tuples_to_lists(M.EVENT_TYPES)
    assert tuple(GOLD["directions"]) == M.DIRECTIONS and tuple(GOLD["easings"]) == M.EASINGS
    assert GOLD["easingCurves"] == _tuples_to_lists(M.EASING_CURVES)
    assert set(M.EASINGS) - {"auto"} == set(M.EASING_CURVES)
    assert tuple(GOLD["fallbacks"]) == M.FALLBACKS and tuple(GOLD["presets"]) == M.PRESETS
    assert GOLD["defaultPreset"] == M.DEFAULT_PRESET == "standard"
    assert tuple(GOLD["globalSpeeds"]) == M.GLOBAL_SPEEDS
    assert GOLD["speedFactors"] == M.SPEED_FACTORS and GOLD["legacySpeedFactors"] == M.LEGACY_SPEED_FACTORS
    assert GOLD["standard"] == M.STANDARD and GOLD["presetDeltas"] == M.PRESET_DELTAS
    assert GOLD["legacyKinds"] == {e: {"key": k, "map": t} for e, (k, t) in M.LEGACY_KINDS.items()}
    assert GOLD["legacyOnlyKinds"] == {e: {"key": k, "map": t} for e, (k, t) in M.LEGACY_ONLY_KINDS.items()}
    assert GOLD["legacyDurations"] == M.LEGACY_DURATIONS and GOLD["staggerFactors"] == M.STAGGER_FACTORS
    assert GOLD["light"] == {
        "fadeEvents": list(M.LIGHT_FADE_EVENTS), "noneEvents": list(M.LIGHT_NONE_EVENTS), "replace": M.LIGHT_REPLACE,
        "screenEvents": list(M.LIGHT_SCREEN_EVENTS), "slideKinds": list(M.LIGHT_SLIDE_KINDS),
        "screenShiftPx": M.LIGHT_SCREEN_SHIFT_PX, "screenMinMs": M.LIGHT_SCREEN_MIN_MS,
    }
    assert (GOLD["lightMaxMultiplier"], GOLD["reducedFactor"], GOLD["removeMinHoldMs"]) == (0.75, 0.5, 3000)
    for case in GOLD["cases"]:
        got = M.resolve_all(case["motion"], reduce_motion=case["reduceMotion"], profile=case["profile"])
        assert got == case["expect"], case["name"]
        assert M.global_multiplier(case["motion"], case["profile"]) == case["multiplier"], case["name"]


def test_resolve_duration_is_the_specs_example():
    # Spec §7: AddToCart 700 ms on Slow is 910 ms; an override of 1050 ms is 1050 ms.
    assert M.resolve_duration(1.30, 700) == 910
    assert M.resolve_duration(1.30, 700, 1050) == 1050
    assert M.resolve_duration(0.75, 650) == 488  # halves up, as roundToInt / Math.round
    for c in GOLD["resolveDuration"]:
        assert M.resolve_duration(c["multiplier"], c["eventDefault"], c["override"]) == c["expect"], c


# ── The presets (spec §2, §8) ───────────────────────────────────────────────


def _ms(preset, event, **motion):
    return M.resolve_event({"preset": preset, **motion}, event)["durationMs"]


def test_the_presets_are_the_specs_examples():
    expect = {
        "standard": (450, 750, 650, 1000),
        "slow": (600, 950, 800, 1300),
        "fast": (350, 550, 450, 800),
        "custom": (450, 750, 650, 1000),  # Standard, to be set event by event
    }
    for preset, (press, add, page, success) in expect.items():
        got = (_ms(preset, "productPress"), _ms(preset, "addToCart"), _ms(preset, "pageTransition"), _ms(preset, "success"))
        assert got == (press, add, page, success), preset
    # A new kiosk is Runner Standard, at normal speed.
    assert C.default_config()["motion"]["preset"] == "standard"
    assert M.global_multiplier(C.default_config()["motion"]) == 1.0
    # Slow is clearer than Standard, Fast quicker, for every event.
    for e in M.EVENTS:
        assert _ms("slow", e) >= _ms("standard", e) >= _ms("fast", e), e


def test_runner_standard_keeps_the_specs_ranges():
    """Spec §2, §16: clarity before speed — every meaningful feedback 450–800 ms, success 0.8–1.2 s."""
    ranges = {
        "productPress": (350, 550), "select": (450, 650), "addToCart": (650, 1000), "remove": (550, 800),
        "categorySwitch": (500, 750), "modalOpen": (550, 800), "pageTransition": (550, 850),
        "priceChange": (500, 750), "error": (450, 700), "success": (800, 1200), "cartBadge": (450, 700),
        "quantityChange": (450, 650), "continueReady": (500, 800), "serviceChoice": (450, 700),
    }
    for e, (lo, hi) in ranges.items():
        assert lo <= _ms("standard", e) <= hi, e
    std = M.resolve_all({"preset": "standard"})
    assert 1500 <= std["toast"]["holdMs"] <= 3000  # a confirmation stays 1.5–3 s
    assert std["remove"]["holdMs"] >= 3000  # Undo at least 3 s
    assert 500 <= std["serviceChoice"]["autoAdvanceDelayMs"] <= 700  # the choice shown before moving on
    assert 50 <= std["itemsEnter"]["staggerMs"] <= 100  # Staggered Entry
    assert 2000 <= std["idle"]["durationMs"] <= 4000 and std["idle"]["repeat"] == 0  # a slow loop
    assert std["continueReady"]["repeat"] == 1  # a single pulse
    # No meaningful feedback disappears under 800 ms (§16).
    assert std["addToCart"]["holdMs"] >= 800


def test_every_presets_values_are_valid_event_values():
    for preset in M.PRESETS:
        for e in M.EVENTS:
            values = M.preset_values(preset, e)
            assert set(values) == set(M.PARAMS), (preset, e)
            cleaned, errors = C.validate_layer({"motion": {"events": {e: values}}})
            assert errors == [], (preset, e, errors)


# ── Migration: the older choices map onto the engine ─────────────────────────


def test_legacy_plays_exactly_the_old_transition_table():
    """
    kiosk_motion_timings.json (before the engine): "legacy" gives every transition its old time — but
    for one change on purpose: on a weak device (the light profile) a change of screen is now seen
    (LIGHT_SCREEN_MIN_MS; the owner on the HIT kiosk, 08.10.2026).
    """
    for ex in OLD_GOLD["examples"]:
        expect = dict(ex["transitions"])
        if ex.get("light") and expect["screenMs"] > 0:
            expect["screenMs"] = max(expect["screenMs"], M.LIGHT_SCREEN_MIN_MS)
        motion = dict(ex["motion"], preset="legacy")
        r = M.resolve_all(motion, profile="light" if ex.get("light") else "full")
        it = r["itemsEnter"]

        def delay(i):
            if it["animationType"] == "none" or it["staggerMs"] <= 0 or i <= 0:
                return 0
            return min(min(i, 11) * it["staggerMs"], it["staggerCapMs"])

        assert {
            "categoryMs": r["categorySwitch"]["durationMs"],
            "itemMs": it["durationMs"],
            "staggerMs": it["staggerMs"],
            "staggerCapMs": it["staggerCapMs"],
            "screenMs": r["pageTransition"]["durationMs"],
            "sheetMs": r["modalOpen"]["durationMs"],
            "gridEnterMs": 0 if it["animationType"] == "none" else delay(11) + it["durationMs"],
        } == expect, ex["motion"]
    # The lively pop-and-fly, ~560 ms at normal speed, the total counting in 360.
    legacy = M.resolve_all({"preset": "legacy", "addToCart": "fly", "speed": "normal"})
    assert legacy["addToCart"]["durationMs"] == 560 and legacy["priceChange"]["durationMs"] == 360
    # Reduced motion as before: no transitions at all, the add a short fade (280 ms).
    reduced = M.resolve_all({"preset": "legacy", "addToCart": "fly"}, reduce_motion=True)
    assert reduced["pageTransition"]["animationType"] == reduced["categorySwitch"]["animationType"] == "none"
    assert reduced["modalOpen"]["animationType"] == "none"
    assert (reduced["addToCart"]["animationType"], reduced["addToCart"]["durationMs"]) == ("fadeIn", 280)


def test_the_light_profile_keeps_a_change_of_screen_seen():
    """
    The owner on the HIT kiosk (light profile), 08.10.2026: "המעבר ממסך ראשי לתפריט בקיוסק לא מונפש".
    Attract → service → menu is pageTransition, the cart cartOpen, back home homeReturn: on a weak
    device each is still played — a short slide (a layer's translation and alpha) or a fade — and
    never shorter than LIGHT_SCREEN_MIN_MS, in every preset and every older screen choice.
    """
    for preset in M.PRESETS:
        for screen in ("slide", "fade", "zoom"):
            r = M.resolve_all({"preset": preset, "screenChange": screen, "speed": "fast"}, profile="light")
            for e in M.LIGHT_SCREEN_EVENTS:
                s = r[e]
                assert s["animationType"] in ("slideIn", "fadeIn"), (preset, screen, e, s["animationType"])
                assert s["durationMs"] >= M.LIGHT_SCREEN_MIN_MS, (preset, screen, e, s["durationMs"])
                if s["animationType"] == "slideIn":
                    assert 0 < s["distancePx"] <= M.LIGHT_SCREEN_SHIFT_PX, (preset, screen, e)
            # The rest of the light profile is as before: the category and the windows fade, fast.
            assert r["categorySwitch"]["animationType"] == r["modalOpen"]["animationType"] == "fadeIn"
            assert r["itemsEnter"]["animationType"] == "none"
    std = M.resolve_all({"preset": "standard"}, profile="light")
    assert (std["pageTransition"]["animationType"], std["pageTransition"]["durationMs"], std["pageTransition"]["distancePx"]) == ("slideIn", 488, 40)
    legacy = M.resolve_all({"preset": "legacy", "screenChange": "slide"}, profile="light")
    assert (legacy["pageTransition"]["animationType"], legacy["pageTransition"]["durationMs"]) == ("slideIn", 400)
    # A time set on purpose is kept; so is "none" (no screen change at all); reduced motion keeps its fade.
    own = M.resolve_all({"events": {"pageTransition": {"durationMs": 250}}}, profile="light")
    assert own["pageTransition"]["durationMs"] == 250
    off = M.resolve_all({"preset": "legacy", "screenChange": "none"}, profile="light")
    assert off["pageTransition"]["animationType"] == "none" and off["pageTransition"]["durationMs"] == 0
    reduced = M.resolve_all({"preset": "standard"}, reduce_motion=True, profile="light")
    assert (reduced["pageTransition"]["animationType"], reduced["pageTransition"]["distancePx"]) == ("fadeIn", 0)
    # The full profile is untouched.
    assert M.resolve_all({"preset": "legacy", "screenChange": "slide"})["pageTransition"]["durationMs"] == 220


def test_older_choices_give_their_events_kinds_and_speed():
    old = {"categorySwitch": "push", "itemsEnter": "rise", "screenChange": "zoom", "sheet": "slide_up", "addToCart": "bounce", "speed": "relaxed"}
    r = M.resolve_all(old)
    assert r["categorySwitch"]["animationType"] == "swipeTransition"
    assert (r["itemsEnter"]["animationType"], r["itemsEnter"]["direction"]) == ("slideIn", "up")
    assert (r["pageTransition"]["animationType"], r["pageTransition"]["scaleFrom"]) == ("fadeScale", 0.92)
    assert (r["modalOpen"]["animationType"], r["modalOpen"]["direction"]) == ("slideIn", "up")
    assert r["addToCart"]["animationType"] == "bounce"
    # No globalSpeed: the older `speed` (relaxed is 1.35, exactly as before).
    assert M.global_multiplier(old) == 1.35
    for value, kind in (("slide", "slideIn"), ("fade", "fadeIn"), ("fade_scale", "fadeScale"), ("none", "none")):
        assert M.resolve_event({"categorySwitch": value}, "categorySwitch")["animationType"] == kind, value
    # An event's own kind wins over the older choice.
    both = {**old, "events": {"categorySwitch": {"animationType": "crossfade"}}}
    assert M.resolve_event(both, "categorySwitch")["animationType"] == "crossfade"
    # Only "legacy" plays the cart and the way home with the screens' choice (as before the engine).
    assert M.resolve_event({"screenChange": "fade"}, "cartOpen")["animationType"] == "slideIn"
    assert M.resolve_event({"screenChange": "fade", "preset": "legacy"}, "cartOpen")["animationType"] == "fadeIn"


def test_the_dashboard_writes_the_older_speed_beside_the_global_one():
    assert M.speed_of_global("slow") == "relaxed" and M.speed_of_global("fast") == "fast"
    assert M.speed_of_global("normal") == "normal" and M.speed_of_global(None) == "normal"
    assert [M.speed_of_global("custom", k) for k in (0.6, 1.0, 1.5)] == ["fast", "normal", "relaxed"]
    assert M.global_multiplier({"globalSpeed": "custom", "speedMultiplier": 9}) == M.MULTIPLIER_MAX
    assert M.global_multiplier({"globalSpeed": "slow", "speed": "fast"}) == 1.3  # the new key wins


# ── Validation of the `motion` section ───────────────────────────────────────


def test_engine_keys_validate_as_a_layer():
    good = {"motion": {
        "preset": "custom", "globalSpeed": "custom", "speedMultiplier": 1.15,
        "events": {
            "addToCart": {"animationType": "flyToCart", "durationMs": 1050, "intensity": 120, "easing": "overshoot"},
            "categorySwitch": {"durationMs": 700, "direction": "left", "scaleFrom": 0.9},
            "remove": {"holdMs": 5000},
            "idle": {"enabled": False},
        },
    }}
    cleaned, errors = C.validate_layer(good)
    assert errors == [] and cleaned == good
    _c, errors = C.validate_layer({"motion": {
        "preset": "turbo", "globalSpeed": "warp", "speedMultiplier": 3,
        "events": {
            "addToCart": {"animationType": "confetti", "durationMs": 9000, "intensity": "max", "spin": 1},
            "remove": {"holdMs": 2000},
            "error": {"scaleFrom": True, "direction": "sideways", "repeat": 1.5},
            "teleport": {},
        },
    }})
    got = paths(errors)
    assert got["motion.preset"] == "invalid_value"
    assert got["motion.globalSpeed"] == "invalid_value"
    assert got["motion.speedMultiplier"] == "out_of_range"
    assert got["motion.events.addToCart.animationType"] == "invalid_value"  # not a kind the add plays
    assert got["motion.events.addToCart.durationMs"] == "out_of_range"
    assert got["motion.events.addToCart.intensity"] == "invalid_type"
    assert got["motion.events.addToCart.spin"] == "unknown_key"
    assert got["motion.events.remove.holdMs"] == "out_of_range"  # Undo at least 3 s
    assert got["motion.events.error.scaleFrom"] == "invalid_type"
    assert got["motion.events.error.direction"] == "invalid_value"
    assert got["motion.events.error.repeat"] == "invalid_type"
    assert got["motion.events.teleport"] == "unknown_key"
    # null inherits; an event left empty sets nothing.
    cleaned, errors = C.validate_layer({"motion": {"globalSpeed": None, "events": {"toast": {}, "select": {"durationMs": None}}}})
    assert errors == [] and cleaned == {}
    # The effective configs validate, with and without the engine's keys (an older stored config).
    assert C.validate_config(C.resolve(good)) == []
    older = C.default_config()
    for key in ("preset", "globalSpeed", "speedMultiplier", "events"):
        older["motion"].pop(key)
    assert C.validate_config(older) == []


def test_the_dashboard_gets_the_engines_vocabulary():
    lim = C.limits()
    assert lim["enums"]["motionPreset"] == list(M.PRESETS)
    assert lim["enums"]["motionGlobalSpeed"] == ["slow", "normal", "fast", "custom"]
    eng = lim["motionEngine"]
    assert eng["events"] == list(M.EVENTS) and eng["eventTypes"]["addToCart"] == list(M.EVENT_TYPES["addToCart"])
    assert eng["params"]["durationMs"] == {"min": 0, "max": 5000}
    assert eng["eventParams"]["remove"]["holdMs"]["min"] == 3000
    assert eng["speedFactors"] == {"slow": 1.3, "normal": 1.0, "fast": 0.75}


def test_reach_low_never_flies_the_engines_copy_either():
    cfg = C.resolve({"layout": {"reach": "low"}, "motion": {"events": {"addToCart": {"animationType": "flyToCart"}}}})
    assert cfg["motion"]["events"]["addToCart"]["animationType"] == "bounce"
    assert cfg["motion"]["addToCart"] == "bounce"
    assert C.validate_config(cfg) == []


# ── The hierarchy: company → shop → kiosk (spec §11), saved and synced (§12) ─


def test_hierarchy_company_standard_shop_slow_kiosk_custom(w):
    """The spec's example: the company Runner Standard, one shop Runner Slow, kiosk 4 Custom with
    AddToCart 1050 ms and the category transition 700 ms."""
    convert(w)
    second = w.tills[1]
    convert(w, second, controllers=[], name="Kiosk 2")
    convert(w, w.other_till, controllers=[], name="North kiosk")
    put(w, "company", w.company.id, {"motion": {"preset": "standard"}})
    put(w, "shop", w.shop.id, {"motion": {"preset": "slow"}})
    put(w, "machine", w.kiosk.id, {"motion": {
        "preset": "custom", "events": {"addToCart": {"durationMs": 1050}, "categorySwitch": {"durationMs": 700}},
    }})
    four = M.resolve_all(sync(w, w.kiosk)["config"]["motion"])
    assert four["addToCart"]["durationMs"] == 1050 and four["categorySwitch"]["durationMs"] == 700
    assert four["productPress"]["durationMs"] == 450  # custom: Standard underneath
    same_shop = M.resolve_all(sync(w, second)["config"]["motion"])
    assert same_shop["addToCart"]["durationMs"] == 950 and same_shop["productPress"]["durationMs"] == 600
    north = M.resolve_all(sync(w, w.other_till)["config"]["motion"])
    assert north["addToCart"]["durationMs"] == 750 and north["pageTransition"]["durationMs"] == 650
    # The kiosk's own layer holds only what it sets; what it inherits is the shop's and the company's.
    view = get_settings(w, "machine", w.kiosk.id)
    assert view["overrides"]["motion"]["events"] == {"addToCart": {"durationMs": 1050}, "categorySwitch": {"durationMs": 700}}
    assert view["inheritedLayers"]["motion"] == {"preset": "slow"}
    # A shop-level event override reaches every kiosk of the shop; the kiosk's own value still wins.
    put(w, "shop", w.shop.id, {"motion": {"preset": "slow", "globalSpeed": "fast", "events": {"addToCart": {"durationMs": 800, "intensity": 140}}}})
    four = M.resolve_all(sync(w, w.kiosk)["config"]["motion"])
    same_shop = M.resolve_all(sync(w, second)["config"]["motion"])
    assert four["addToCart"]["durationMs"] == 1050 and four["addToCart"]["intensity"] == 140
    assert same_shop["addToCart"]["durationMs"] == 800  # an override ignores the global speed
    assert same_shop["productPress"]["durationMs"] == 450  # Slow's 600 × Fast's 0.75


def test_an_engine_change_is_a_new_config_version_for_the_kiosk(w):
    convert(w)
    before = sync(w, w.kiosk)["configVersion"]
    put(w, "company", w.company.id, {"motion": {"events": {"success": {"durationMs": 1200}}}})
    out = sync(w, w.kiosk)
    assert out["configVersion"] != before and out["configVersion"] == C.config_version(out["config"])
    assert out["config"]["motion"]["events"]["success"] == {"durationMs": 1200}
    # Refused with the contract's 422 shape.
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as caught:
        put(w, "machine", w.kiosk.id, {"motion": {"events": {"remove": {"holdMs": 500}}}})
    assert caught.value.status_code == 422
    assert {"path": "motion.events.remove.holdMs", "code": "out_of_range"}.items() <= caught.value.detail["errors"][0].items()


# ── The migration (b3e7c1a9d5f2): the kiosks of today keep their pace ─────────


def _run_migration(db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parent.parent / "alembic" / "versions" / "b3e7c1a9d5f2_kiosk_motion_engine_legacy_pace.py"
    spec = importlib.util.spec_from_file_location("kiosk_motion_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    ctx = MigrationContext.configure(db.connection())
    with Operations.context(ctx):
        module.upgrade()
    db.expire_all()


def test_the_migration_stamps_legacy_on_the_companies_with_kiosks(w):
    convert(w)
    assert C.effective_config(w.db, w.kiosk)["motion"]["preset"] == "standard"
    _run_migration(w.db)
    row = w.db.query(KioskSettings).filter(KioskSettings.level == "company", KioskSettings.company_id == w.company.id).one()
    assert row.overrides == {"motion": {"preset": "legacy"}}
    assert C.effective_config(w.db, w.kiosk)["motion"]["preset"] == "legacy"
    # Idempotent: a second run changes nothing; a company that chose a preset is never overwritten.
    _run_migration(w.db)
    assert w.db.query(KioskSettings).filter(KioskSettings.level == "company").count() == 1
    put(w, "company", w.company.id, {"theme": {"uiStyle": "ios"}, "motion": {"preset": "slow"}})
    _run_migration(w.db)
    row = w.db.query(KioskSettings).filter(KioskSettings.level == "company", KioskSettings.company_id == w.company.id).one()
    assert row.overrides["motion"] == {"preset": "slow"} and row.overrides["theme"] == {"uiStyle": "ios"}


def test_the_migration_keeps_a_company_layers_other_settings(w):
    convert(w)
    put(w, "company", w.company.id, {"theme": {"primaryColor": "#112233"}, "motion": {"speed": "fast"}})
    _run_migration(w.db)
    row = w.db.query(KioskSettings).filter(KioskSettings.level == "company", KioskSettings.company_id == w.company.id).one()
    assert row.overrides == {"theme": {"primaryColor": "#112233"}, "motion": {"speed": "fast", "preset": "legacy"}}


def test_the_migration_leaves_companies_without_a_kiosk(w):
    _run_migration(w.db)
    assert w.db.query(KioskSettings).count() == 0
