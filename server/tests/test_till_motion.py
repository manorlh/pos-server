"""
"הנפשות" in "עיצוב קופה" (P:/specs/till-motion.md "תיקון 14.10"): the kiosk's Motion Engine on the till.

* **The engine** (app/services/kiosk_motion.py, surface "till"): the till's events (two of them its own,
  `tableOpen` and `tabSwitch`, which a kiosk refuses), its presets — "legacy" by default, exactly today's
  till (a push / pop of 300 ms, payment and the windows 330 ms, the tabs 140 ms, the iOS curve; nothing
  else moves), and "none", every event off whatever a level set — `payment` as the payment screen rising,
  and the seven ways to open a table (zoom, slide, rise, fade, flip, scale, none), each with the usual
  parameters. Pinned by the shared golden's `till` section (byte-identical in pos-android).
* **Storage**: the till design's `motion`, per company → shop → point of sale → till, merged per event and
  parameter; validated by the same rules as the kiosk's (one schema builder, kiosk_config.motion_engine_fields).
* **The payload**: in the till's `GET /sync/{id}/till-design` config, its version moving with it.
* **Who**: whoever writes the till design (the till design's own rule and route) — never a cashier, a shop
  manager only below the company.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from app.services import kiosk_config as C
from app.services import kiosk_motion as M
from app.services import till_design as T
from test_till_design import body_of, get, put, put_and_run, refused, sync, w  # noqa: F401  (the world fixture)

FIXTURES = Path(__file__).parent / "fixtures"
GOLD = json.loads((FIXTURES / "kiosk_motion_engine.json").read_text(encoding="utf-8"))
TILL = GOLD["till"]
TABLE_KINDS = ("zoom", "slide", "rise", "fade", "flip", "scale", "none")


def _till(motion, event=None, **kw):
    if event is None:
        return M.resolve_all(motion, surface="till", **kw)
    return M.resolve_event(motion, event, surface="till", **kw)


def _lists(v):
    if isinstance(v, dict):
        return {k: _lists(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_lists(x) for x in v]
    return v


# ── The shared golden's till section ─────────────────────────────────────────


def test_the_golden_till_section_is_the_engines_own():
    assert tuple(TILL["events"]) == M.TILL_EVENTS == M.surface_events("till")
    assert tuple(TILL["onlyEvents"]) == M.TILL_ONLY_EVENTS == ("tableOpen", "tabSwitch")
    assert set(M.TILL_EVENTS) <= set(M.EVENTS) and len(set(M.TILL_EVENTS)) == len(M.TILL_EVENTS)
    assert tuple(TILL["presets"]) == M.TILL_PRESETS and TILL["defaultPreset"] == "legacy" and TILL["nonePreset"] == "none"
    assert TILL["eventTypes"] == _lists(M.TILL_EVENT_TYPES) and TILL["standard"] == M.TILL_STANDARD
    assert TILL["legacy"] == M.TILL_LEGACY and TILL["light"] == _lists(M.TILL_LIGHT)
    # The catalogue: tableOpen's seven kinds are in the library.
    assert tuple(GOLD["eventTypes"]["tableOpen"]) == TABLE_KINDS == M.EVENT_TYPES["tableOpen"]
    assert set(TABLE_KINDS) <= set(M.TYPES)
    assert GOLD["easingCurves"]["ios"] == [0.32, 0.72, 0.0, 1.0]
    for case in TILL["cases"]:
        got = _till(case["motion"], reduce_motion=case["reduceMotion"], profile=case["profile"])
        assert got == case["expect"], case["name"]
        assert M.global_multiplier(case["motion"], case["profile"]) == case["multiplier"], case["name"]


# ── The engine on the till ───────────────────────────────────────────────────


def test_no_motion_is_todays_till():
    r = _till(None)
    assert r == _till({}) == _till({"preset": "legacy"})
    assert set(r) == set(M.TILL_EVENTS)
    # The screens as IosTransitions.kt plays them: a push / pop 300, payment and the windows 330, the tabs 140.
    page, sheet, pay, tab, table = (r[e] for e in ("pageTransition", "modalOpen", "payment", "tabSwitch", "tableOpen"))
    assert (page["animationType"], page["durationMs"], page["easing"]) == ("slideIn", 300, "ios")
    assert (pay["animationType"], pay["direction"], pay["durationMs"], pay["easing"]) == ("slideIn", "up", 330, "ios")
    assert (sheet["animationType"], sheet["direction"], sheet["durationMs"], sheet["easing"]) == ("slideIn", "up", 330, "ios")
    assert (tab["animationType"], tab["durationMs"]) == ("crossfade", 140)
    assert (table["animationType"], table["durationMs"]) == ("fade", 140)
    assert M.EASING_CURVES["ios"] == (0.32, 0.72, 0.0, 1.0)
    # Nothing moves inside a screen.
    moving = {e for e, s in r.items() if s["animationType"] != "none"}
    assert moving == {"pageTransition", "modalOpen", "payment", "tabSwitch", "tableOpen"}
    # Reduced motion, as today: no transition at all.
    assert all(s["animationType"] == "none" for s in _till(None, reduce_motion=True).values())


def test_an_in_screen_event_switched_on_in_legacy_plays_at_the_fast_pace():
    r = _till({"events": {"addToCart": {"enabled": True}}}, "addToCart")
    assert (r["enabled"], r["animationType"], r["durationMs"]) == (True, "flyToCart", 550)


def test_the_presets_on_the_till():
    std = _till({"preset": "standard"})
    assert (std["tableOpen"]["animationType"], std["tableOpen"]["durationMs"]) == ("zoom", 650)
    assert (std["payment"]["animationType"], std["payment"]["direction"], std["payment"]["durationMs"]) == ("slideIn", "up", 650)
    assert (std["tabSwitch"]["animationType"], std["tabSwitch"]["durationMs"]) == ("crossfade", 450)
    assert std["addToCart"]["durationMs"] == 750 and std["productPress"]["durationMs"] == 450
    for e in M.TILL_EVENTS:
        slow, fast = _till({"preset": "slow"}, e)["durationMs"], _till({"preset": "fast"}, e)["durationMs"]
        assert slow >= std[e]["durationMs"] >= fast, e
    # The global speed multiplies whatever is not set explicitly.
    slow = _till({"preset": "standard", "globalSpeed": "slow", "events": {"addToCart": {"durationMs": 1050}}})
    assert slow["tableOpen"]["durationMs"] == 845 and slow["addToCart"]["durationMs"] == 1050


def test_none_switches_every_event_off_whatever_a_level_set():
    motion = {"preset": "none", "events": {e: {"enabled": True, "durationMs": 500} for e in M.TILL_EVENTS}}
    for e, s in _till(motion).items():
        assert (s["enabled"], s["animationType"], s["durationMs"]) == (False, "none", 0), e
    # A kiosk has no "none" preset: it falls back to its default.
    assert M.preset_of({"preset": "none"}) == "standard"
    assert M.preset_of({"preset": "none"}, "till") == "none"


def test_the_tills_payment_is_the_screen_rising():
    assert M.event_types("payment", "till") == ("slideIn", "fadeIn", "fadeScale", "none")
    assert M.event_types("payment") == M.EVENT_TYPES["payment"]  # the kiosk's: the button filling
    assert _till({"preset": "standard", "events": {"payment": {"animationType": "buttonFill"}}}, "payment")["animationType"] == "slideIn"
    assert _till({"preset": "standard", "events": {"payment": {"animationType": "fadeIn"}}}, "payment")["animationType"] == "fadeIn"


@pytest.mark.parametrize("kind", TABLE_KINDS)
def test_each_way_to_open_a_table_validates_and_resolves_with_its_parameters(kind):
    ev = {"animationType": kind, "durationMs": 520, "easing": "ios", "intensity": 140, "direction": "left"}
    cleaned, errors = T.validate_layer({"motion": {"preset": "standard", "events": {"tableOpen": ev}}})
    assert errors == [] and cleaned["motion"]["events"]["tableOpen"] == ev
    r = _till({"preset": "standard", "globalSpeed": "fast", "events": {"tableOpen": ev}}, "tableOpen")
    if kind == "none":
        assert (r["animationType"], r["durationMs"]) == ("none", 0)
    else:
        # The override ignores the global speed; the curve, intensity and direction are the event's.
        assert (r["animationType"], r["durationMs"], r["easing"], r["intensity"], r["direction"]) == (kind, 520, "ios", 140, "left")
        # Without an override the speed applies: Standard's 650 × 0.75.
        bare = _till({"preset": "standard", "globalSpeed": "fast", "events": {"tableOpen": {"animationType": kind}}}, "tableOpen")
        assert (bare["animationType"], bare["durationMs"]) == (kind, 488)
        # A weak device: its fade, at the fast pace, never shorter than LIGHT_SCREEN_MIN_MS; reduced motion: a
        # fade, half the time.
        light = _till({"preset": "standard", "events": {"tableOpen": {"animationType": kind}}}, "tableOpen", profile="light")
        assert (light["animationType"], light["durationMs"]) == ("fade", 488)
        quick = _till({"preset": "fast", "events": {"tableOpen": {"animationType": kind}}}, "tableOpen", profile="light")
        assert (quick["animationType"], quick["durationMs"]) == ("fade", M.LIGHT_SCREEN_MIN_MS)
        reduced = _till({"preset": "standard", "events": {"tableOpen": {"animationType": kind}}}, "tableOpen", reduce_motion=True)
        assert (reduced["animationType"], reduced["durationMs"], reduced["distancePx"]) == ("fadeIn", 325, 0)


def test_values_a_till_cannot_take_are_refused_on_save_and_ignored_when_stored():
    _c, errors = T.validate_layer({"motion": {
        "preset": "turbo",
        "globalSpeed": "warp",
        "speedMultiplier": 3,
        "events": {
            "tableOpen": {"animationType": "slideIn", "durationMs": 9000, "intensity": "max"},
            "payment": {"animationType": "buttonFill"},
            "tabSwitch": {"animationType": "zoom"},
            "remove": {"holdMs": 1000},
            "idle": {"enabled": False},  # a kiosk's event, not a till's
            "addToCart": {"spin": 1},
        },
    }})
    got = {e.path: e.code for e in errors}
    assert got["motion.preset"] == "invalid_value"
    assert got["motion.globalSpeed"] == "invalid_value"
    assert got["motion.speedMultiplier"] == "out_of_range"
    assert got["motion.events.tableOpen.animationType"] == "invalid_value"
    assert got["motion.events.tableOpen.durationMs"] == "out_of_range"
    assert got["motion.events.tableOpen.intensity"] == "invalid_type"
    assert got["motion.events.payment.animationType"] == "invalid_value"
    assert got["motion.events.tabSwitch.animationType"] == "invalid_value"
    assert got["motion.events.remove.holdMs"] == "out_of_range"  # Undo at least 3 s, as on the kiosk
    assert got["motion.events.idle"] == "unknown_key"
    assert got["motion.events.addToCart.spin"] == "unknown_key"
    # Stored anyway (an older layer): what no longer validates is dropped, the rest kept.
    kept = T.sanitize_stored_layer({"motion": {"preset": "turbo", "events": {"tableOpen": {"animationType": "flip", "durationMs": 9000}}}})
    assert kept == {"motion": {"events": {"tableOpen": {"animationType": "flip"}}}}
    # null inherits; an empty event or section sets nothing.
    cleaned, errors = T.validate_layer({"motion": {"preset": None, "events": {"toast": {}, "error": {"durationMs": None}}}})
    assert errors == [] and cleaned == {}


def test_every_till_presets_values_are_valid_till_values():
    for preset in M.TILL_PRESETS:
        for e in M.TILL_EVENTS:
            values = M.preset_values(preset, e, "till")
            assert set(values) == set(M.PARAMS), (preset, e)
            _cleaned, errors = T.validate_layer({"motion": {"preset": preset, "events": {e: values}}})
            assert errors == [], (preset, e, errors)


def test_a_kiosk_refuses_the_tills_own_events_and_plays_exactly_as_before():
    _c, errors = C.validate_layer({"motion": {"events": {"tableOpen": {"animationType": "zoom"}, "tabSwitch": {}}}})
    assert {e.path for e in errors} == {"motion.events.tableOpen", "motion.events.tabSwitch"}
    _c, errors = C.validate_layer({"motion": {"preset": "none"}})
    assert [e.path for e in errors] == ["motion.preset"]
    assert set(M.resolve_all({"preset": "standard"})) == set(M.KIOSK_EVENTS)
    # The kiosk's payment is still the pay button filling, and its default preset Runner Standard.
    assert M.resolve_event({}, "payment")["animationType"] == "buttonFill"
    assert C.default_config()["motion"]["preset"] == "standard"


# ── Stored per level in the till design, merged per event and parameter ──────


def test_the_motion_is_set_per_level_and_merges_per_event_and_parameter(w):
    put(w, "company", w.company.id, {"motion": {"preset": "standard", "events": {"tableOpen": {"animationType": "flip", "durationMs": 700}}}})
    put(w, "shop", w.shop.id, {"motion": {"globalSpeed": "fast", "events": {"tableOpen": {"easing": "ios"}, "addToCart": {"enabled": False}}}})
    put(w, "area", w.area.id, {"motion": {"events": {"tableOpen": {"animationType": "rise"}}}})
    view = put(w, "machine", w.bar_till.id, {"motion": {"events": {"payment": {"animationType": "fadeIn"}}}})

    eff = view["effective"]["motion"]
    assert eff["preset"] == "standard" and eff["globalSpeed"] == "fast"
    # Per parameter: the area's kind, the shop's curve, the company's time.
    assert eff["events"]["tableOpen"] == {"animationType": "rise", "durationMs": 700, "easing": "ios"}
    assert eff["events"]["addToCart"] == {"enabled": False}
    assert eff["events"]["payment"] == {"animationType": "fadeIn"}
    assert view["overrides"] == {"motion": {"events": {"payment": {"animationType": "fadeIn"}}}}
    assert view["inherited"]["motion"]["events"]["tableOpen"]["animationType"] == "rise"
    assert "payment" not in view["inherited"]["motion"]["events"]

    # What each till plays.
    bar = _till(body_of(sync(w, w.bar_till))["config"]["motion"])
    assert (bar["tableOpen"]["animationType"], bar["tableOpen"]["durationMs"], bar["tableOpen"]["easing"]) == ("rise", 700, "ios")
    assert bar["payment"]["animationType"] == "fadeIn" and bar["addToCart"]["animationType"] == "none"
    counter = body_of(sync(w, w.counter_till))["config"]["motion"]
    assert counter["events"]["tableOpen"] == {"animationType": "flip", "durationMs": 700, "easing": "ios"}
    assert _till(counter, "payment")["animationType"] == "slideIn"
    north = body_of(sync(w, w.other_till))["config"]["motion"]
    assert north == {"preset": "standard", "events": {"tableOpen": {"animationType": "flip", "durationMs": 700}}}

    # A level that clears its own goes back to what it inherits.
    view = put(w, "area", w.area.id, {})
    assert view["effective"]["motion"]["events"]["tableOpen"]["animationType"] == "flip"


def test_none_at_a_shop_wins_over_the_events_a_level_above_set(w):
    put(w, "company", w.company.id, {"motion": {"preset": "standard", "events": {"addToCart": {"durationMs": 900}}}})
    put(w, "shop", w.shop.id, {"motion": {"preset": "none"}})
    motion = body_of(sync(w, w.counter_till))["config"]["motion"]
    assert motion["preset"] == "none"
    assert all(s["animationType"] == "none" for s in _till(motion).values())
    # The other shop keeps the company's.
    assert _till(body_of(sync(w, w.other_till))["config"]["motion"], "addToCart")["durationMs"] == 900


def test_an_invalid_motion_is_a_422_with_its_paths(w):
    err = refused(put, w, "shop", w.shop.id, {"motion": {"preset": "turbo", "events": {"tableOpen": {"animationType": "spin"}}}})
    assert err.status_code == 422 and err.detail["code"] == "invalid_till_design"
    codes = {(e["path"], e["code"]) for e in err.detail["errors"]}
    assert ("motion.preset", "invalid_value") in codes
    assert ("motion.events.tableOpen.animationType", "invalid_value") in codes


# ── The payload ──────────────────────────────────────────────────────────────


def test_a_till_with_nothing_set_gets_no_motion_and_plays_legacy(w):
    cfg = body_of(sync(w, w.counter_till))["config"]
    assert "motion" not in cfg and cfg == T.default_config()
    assert T.validate_config(cfg) == []
    assert _till(cfg.get("motion"))["pageTransition"]["durationMs"] == 300


def test_a_motion_change_is_a_new_version_for_the_tills_under_the_level(w):
    first = sync(w, w.bar_till)
    etag = first.headers["ETag"]
    other = sync(w, w.other_till).headers["ETag"]
    put_and_run(w, "shop", w.shop.id, {"motion": {"preset": "standard", "events": {"tableOpen": {"animationType": "scale"}}}})
    assert sorted(w.notified) == sorted([(str(t.id), "till_design_updated") for t in w.tills])
    changed = sync(w, w.bar_till, etag)
    assert changed.status_code == 200
    body = body_of(changed)
    assert body["config"]["motion"]["events"]["tableOpen"] == {"animationType": "scale"}
    assert body["configVersion"] == T.config_version(body["config"]) and f'"{body["configVersion"]}"' != etag
    assert T.validate_config(body["config"]) == []
    # Another shop's till: unchanged, still 304.
    assert sync(w, w.other_till, other).status_code == 304


def test_a_stored_bad_motion_never_reaches_a_till(w):
    from app.models.till_design import TillDesignSettings

    w.db.add(TillDesignSettings(
        id=uuid.uuid4(), tenant_id=w.tenant.id, level="machine", machine_id=w.counter_till.id,
        overrides={"motion": {"preset": "warp", "events": {"tableOpen": {"animationType": "spin", "durationMs": 400}, "idle": {}}}},
    ))
    w.db.commit()
    cfg = body_of(sync(w, w.counter_till))["config"]
    assert cfg["motion"] == {"events": {"tableOpen": {"durationMs": 400}}}
    assert T.validate_config(cfg) == []


# ── Who edits it: whoever writes the till design ─────────────────────────────


def test_who_may_edit_the_motion(w):
    layer = {"motion": {"preset": "fast"}}
    # A company manager: the company and below.
    assert put(w, "company", w.company.id, layer, user=w.company_manager)["effective"]["motion"]["preset"] == "fast"
    # A shop manager: its shop, its points of sale and tills; never the company or another shop.
    assert put(w, "shop", w.shop.id, {"motion": {"preset": "none"}}, user=w.manager)["overrides"] == {"motion": {"preset": "none"}}
    assert put(w, "machine", w.bar_till.id, layer, user=w.manager)["level"] == "machine"
    assert refused(put, w, "company", w.company.id, layer, user=w.manager).status_code == 403
    assert refused(put, w, "shop", w.other_shop.id, layer, user=w.manager).status_code == 403
    # A cashier: neither reads nor writes it.
    assert refused(put, w, "shop", w.shop.id, layer, user=w.cashier).status_code == 403
    assert refused(get, w, "shop", w.shop.id, user=w.cashier).status_code == 403
    # The super admin.
    assert put(w, "area", w.area.id, layer)["effective"]["motion"]["preset"] == "fast"


def test_the_write_is_the_till_designs_route_and_section():
    from app.middleware.auth import get_current_machine_admin
    from app.routers import till_design as R
    from app.services import dashboard_sections as DS

    route = next(r for r in R.router.routes if getattr(r, "path", "") == "/till-design/settings" and "PUT" in r.methods)
    deps = {d.call for d in route.dependant.dependencies}
    assert get_current_machine_admin in deps
    fixture = (FIXTURES / "dashboard_route_sections.txt").read_text(encoding="utf-8").splitlines()
    assert "PUT /till-design/settings -> till_design:edit" in fixture
    assert "GET /till-design/settings -> till_design:view" in fixture
    assert any(s.id == "till_design" for s in DS.SECTIONS)
