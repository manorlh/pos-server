"""
"זרימה" (P:/specs/flow-design.md §9): the `flow` section of the till design (app/services/till_design.py).

* The shared fixture tests/fixtures/flow_design_contract.json — the same bytes in pos-android
  app/src/test/resources (FlowDesignContractTest pins the same SHA-256, LF-normalised): its catalog is the
  module's vocabulary; every case's layers, each `{"flow": <layer>}`, validated and merged through the
  module's own layer functions settle to its "expect" on every profile; every invalid layer is refused with
  its path and code; what the till reads tolerantly the server refuses on save and never syncs.
* Nothing set is no `flow` at all: the defaults, the sync bytes and till_design_contract.json as they were.
* Through the router: a level's `flow` reaches its tills, a bad value is a 422, `GET /till-design/targets`
  says which tills show "זרימה" (`flow`) and `GET /till-design/defaults` the first version that does.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.routers import till_design as R
from app.services import ably_notify
from app.services import till_design as T
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURE = Path(__file__).parent / "fixtures" / "flow_design_contract.json"
#: The fixture's SHA-256 (line endings read as LF) — the same constant in pos-android's FlowDesignContractTest.
#: Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "5737da6c0855c4cd80e9451f212ef9894c2fa185d89f5ad3800ad5e1b8541b9e"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / FIXTURE.name
#: till_design_contract.json: nothing set must still be its defaults, byte for byte.
DESIGN_CONTRACT = Path(__file__).parent / "fixtures" / "till_design_contract.json"


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


@pytest.fixture(scope="module")
def contract():
    return json.loads(_text(FIXTURE))


def _layers(case) -> list:
    """Each level's layer holds only its `flow`."""
    return [{T.FLOW_SECTION: layer} for layer in case["layers"]]


def _per_profile(expect, profile):
    return {**expect, "shell": expect["shell"][profile]}


# ── The shared fixture ────────────────────────────────────────────────────────


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(FIXTURE).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android (with feat/flow-design) is not checked out beside pos-server")
    assert _text(SIBLING) == _text(FIXTURE)


def test_the_catalog_is_the_modules_vocabulary(contract):
    catalog = contract["catalog"]
    assert catalog == T.flow_catalog()
    assert catalog["shells"] == list(T.FLOW_SHELLS) == ["classic", "flow"]
    assert catalog["profileValues"] == list(T.FLOW_PROFILE_VALUES) == [*T.FLOW_SHELLS, T.AS_BASE]
    assert catalog["profiles"] == list(T.PROFILES)
    assert catalog["homes"] == list(T.FLOW_HOMES)
    assert catalog["firstSteps"] == list(T.FLOW_FIRST_STEPS)
    assert catalog["askGuests"] == list(T.FLOW_ASK_GUESTS)
    assert catalog["pickupNames"] == list(T.FLOW_PICKUP_NAMES)
    assert catalog["defaults"] == T.FLOW_DEFAULTS
    # The schema takes exactly the catalog's words.
    assert set(T.FLOW.fields) == {"shell", "profiles", "home", "firstStep", "askGuests", "notes", "pickupName", "background"}
    assert set(T.FLOW.fields["profiles"].fields) == set(T.PROFILES)


def test_every_case_merges_and_settles_on_every_profile(contract):
    assert len(contract["cases"]) >= 10
    for case in contract["cases"]:
        name, expect = case["name"], case["expect"]
        cleaned = []
        for layer in _layers(case):
            got, errors = T.validate_layer(layer)
            assert errors == [], (name, errors)
            cleaned.append(got)
        # What a till gets (DEFAULTS ⊕ the stored layers), and the layers alone (the editor's explicit view).
        resolved = T.resolve(*_layers(case))
        assert T.merge(T.default_config(), *cleaned) == resolved, name
        assert T.validate_config(resolved) == [], name
        for cfg in (resolved, T.explicit_layers(*_layers(case)), resolved.get(T.FLOW_SECTION, {})):
            assert T.flow_view(cfg) == expect, name
            for profile in T.PROFILES:
                assert T.flow_for_profile(cfg, profile) == _per_profile(expect, profile), (name, profile)
                assert T.flow_shell(cfg, profile) == expect["shell"][profile], (name, profile)
        # The section never changes what a profile's order screen shows.
        for profile in T.PROFILES:
            assert T.for_profile(resolved, profile) == T.for_profile(T.default_config(), profile), (name, profile)


def test_every_invalid_layer_is_refused_with_its_path_and_code(contract):
    assert len(contract["invalid"]) >= 10
    for case in contract["invalid"]:
        cleaned, errors = T.validate_layer({T.FLOW_SECTION: case["flow"]})
        assert {(e.path, e.code) for e in errors} == {(case["path"], case["code"])}, case
        # Never stored: the bad key is dropped (and an emptied section with it).
        assert T.FLOW_SECTION not in cleaned, case


def test_what_the_till_reads_tolerantly_the_server_refuses_and_never_syncs(contract):
    for case in contract["tolerant"]:
        flow = case["flow"]
        profiles = flow.get("profiles", {})
        good = {p: v for p, v in profiles.items() if p in T.PROFILES and v in T.FLOW_PROFILE_VALUES}
        bad = {f"flow.{k}" for k in flow if k != "profiles"} | {f"flow.profiles.{p}" for p in profiles if p not in good}
        _cleaned, errors = T.validate_layer({T.FLOW_SECTION: flow})
        assert {e.path for e in errors} == bad, case["name"]
        assert all(e.code in ("invalid_value", "invalid_type", "invalid_color", "unknown_key") for e in errors)
        # A stored layer that holds them (written before a rule narrowed) reaches no till with them.
        assert T.sanitize_stored_layer({T.FLOW_SECTION: flow}) == ({T.FLOW_SECTION: {"profiles": good}} if good else {})
        # The server's own reading is the till's: a word it does not know is the key's default.
        assert T.flow_view(flow) == case["expect"], case["name"]


# ── Nothing set: today's till ─────────────────────────────────────────────────


def test_nothing_set_is_no_flow_and_todays_sync_bytes():
    assert T.FLOW_SECTION not in T.DEFAULT_CONFIG
    assert T.FLOW_SECTION not in T.default_config()
    assert T.validate_config(T.default_config()) == []
    for layers in ([], [{}, {}, {}, {}], [{"flow": {}}], [{"flow": {"shell": None, "profiles": {}}}], [{"flow": {"profiles": {"handheld": None}}}]):
        resolved = T.resolve(*layers)
        assert T.FLOW_SECTION not in resolved, layers
        assert resolved == T.default_config(), layers
    # The design's shared contract still holds its defaults and their version.
    design = json.loads(_text(DESIGN_CONTRACT))
    assert design["defaults"] == T.default_config()
    assert design["defaultsVersion"] == T.config_version(T.default_config())
    assert "flow" not in json.dumps(design["catalog"]) and T.catalog() == design["catalog"]
    # Nothing set: "רגיל" everywhere, every option its default.
    assert T.flow_view(T.default_config()) == {"shell": {p: "classic" for p in T.PROFILES}, **T.FLOW_DEFAULTS}
    assert T.validate_layer({"flow": {"profiles": {}}}) == ({}, [])


def test_levels_merge_per_key_and_base_follows_the_shell():
    company = {"flow": {"shell": "flow", "profiles": {"tabletLandscape": "classic"}, "background": "#1E3A8A"}}
    shop = {"flow": {"profiles": {"tabletPortrait": "classic"}, "pickupName": "ask"}}
    till = {"flow": {"profiles": {"tabletLandscape": "base"}, "notes": False}}
    eff = T.resolve(company, shop, {}, till)
    assert eff["flow"] == {
        "shell": "flow",
        "profiles": {"tabletLandscape": "base", "tabletPortrait": "classic"},
        "background": "#1E3A8A",
        "pickupName": "ask",
        "notes": False,
    }
    assert {p: T.flow_shell(eff, p) for p in T.ANDROID_PROFILES} == {
        "handheld": "flow", "tabletLandscape": "flow", "tabletPortrait": "classic",
    }
    # `shell` has no "base" (that is a profile's word); a background is #RRGGBB, any case, or "base".
    assert [(e.path, e.code) for e in T.validate_layer({"flow": {"shell": "base"}})[1]] == [("flow.shell", "invalid_value")]
    assert T.validate_layer({"flow": {"background": "#abcdef"}}) == ({"flow": {"background": "#abcdef"}}, [])
    # "ברירת המחדל שלנו" over the company's colour: the till keeps "base" and reads it as our palette.
    ours = T.resolve(company, shop, {}, {"flow": {"background": "base"}})
    assert ours["flow"]["background"] == "base"
    assert T.flow_view(ours)["background"] is None and T.validate_config(ours) == []
    assert [(e.path, e.code) for e in T.validate_layer({"flow": {"background": "brand"}})[1]] == [("flow.background", "invalid_color")]


# ── Through the router ────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.notified = []
    monkeypatch.setattr(
        ably_notify, "publish_settings_notify",
        lambda tenant_id, machine_id, **kw: world.notified.append((str(machine_id), kw.get("reason"))),
    )
    TP.ensure_builtin_parameters(world.db)
    world.area = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    world.db.add(world.area)
    world.db.flush()
    world.bar_till, world.counter_till = world.tills
    world.bar_till.area_id = world.area.id
    world.manager = User(
        id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id, company_id=world.company.id,
        shop_id=world.shop.id, email="mgr@x", username="mgr",
    )
    world.db.add(world.manager)
    world.db.commit()
    return world


def _put(w, level, entity_id, overrides):
    return R.put_settings(
        body=R.TillDesignSettingsIn(overrides=overrides), background_tasks=BackgroundTasks(),
        level=level, scope_id=entity_id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


class _Req:
    headers: dict = {}


def _sync(w, machine):
    return json.loads(R.get_till_design_sync(machine_id=str(machine.id), request=_Req(), machine=machine, db=w.db).body)


def test_a_levels_flow_reaches_its_tills_and_a_bad_value_is_a_422(w):
    before = _sync(w, w.bar_till)
    assert T.FLOW_SECTION not in before["config"] and before["config"] == T.default_config()
    view = _put(w, "shop", w.shop.id, {"flow": {"profiles": {"handheld": "flow"}, "home": "orders", "background": None}})
    assert view["overrides"] == {"flow": {"profiles": {"handheld": "flow"}, "home": "orders"}}
    _put(w, "machine", w.counter_till.id, {"flow": {"profiles": {"handheld": "base"}, "shell": "classic"}})
    bar = _sync(w, w.bar_till)
    assert bar["config"]["flow"] == {"profiles": {"handheld": "flow"}, "home": "orders"}
    assert bar["configVersion"] != before["configVersion"]
    assert T.flow_for_profile(bar["config"], "handheld")["shell"] == "flow"
    assert T.flow_for_profile(bar["config"], "tabletLandscape")["shell"] == "classic"
    counter = _sync(w, w.counter_till)["config"]
    assert T.flow_view(counter)["shell"]["handheld"] == "classic" and T.flow_view(counter)["home"] == "orders"
    with pytest.raises(HTTPException) as caught:
        _put(w, "shop", w.shop.id, {"flow": {"shell": "bee", "background": "navy"}})
    assert caught.value.status_code == 422
    assert {(e["path"], e["code"]) for e in caught.value.detail["errors"]} == {
        ("flow.shell", "invalid_value"), ("flow.background", "invalid_color"),
    }


def test_defaults_say_the_first_version_that_shows_flow(w):
    out = R.get_defaults(current_user=w.manager)
    assert out["flowMinVersion"] == T.flow_min_version() == f"0.1.{T.FLOW_MIN_VERSION_CODE}"
    assert T.FLOW_SECTION not in out["defaults"]
    # The first integration APK that ships pos-android feat/flow-design: 0.1.820 (integration/2026-10-17).
    assert T.FLOW_MIN_VERSION_CODE == 820


def test_targets_say_which_tills_show_flow(w):
    w.bar_till.app_version = f"0.1.{T.FLOW_MIN_VERSION_CODE}+abc1234-device"
    w.counter_till.app_version = "0.1.782+b6e07db"
    w.db.commit()
    out = R.get_targets(shop_id=w.shop.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    by_name = {m["name"]: m for m in out["machines"]}
    assert by_name["Till 1"]["flow"] is True and by_name["Till 1"]["phase2Templates"] is True
    assert by_name["Till 2"]["flow"] is False and by_name["Till 2"]["phase2Templates"] is True
    w.counter_till.app_version = f"0.1.{T.FLOW_MIN_VERSION_CODE - 1}+aaaaaaa-device"
    assert T.shows_flow(w.counter_till) is False
    w.counter_till.app_version = f"0.1.{T.FLOW_MIN_VERSION_CODE}+aaaaaaa-device"
    assert T.shows_flow(w.counter_till) is True
    # Never said, or not an Android till: unknown.
    w.counter_till.app_version = None
    assert T.shows_flow(w.counter_till) is None
    w.counter_till.app_version, w.counter_till.platform = "0.4.2", "windows"
    assert T.shows_flow(w.counter_till) is None
