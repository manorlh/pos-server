"""
"עיצוב קופה" — the till design (app/services/till_design.py, app/routers/till_design.py,
docs/SPEC_TILL_DESIGN.md).

* The schema: the defaults validate and ARE today's screens (template clean, every overlap
  "auto"); strict validation with paths and stable codes (phase-2 templates refused, the
  action bars keep pay / send, presets keep 1…).
* The shared contract (tests/fixtures/till_design_contract.json, same bytes in pos-android):
  this implementation reproduces every case — `for_profile`, merges, banknotes, the legacy
  quick-pay mapping, validation, defaults and the template table.
* Layering company → shop → area → machine through the router functions: objects merge,
  lists replace, null inherits, a lower level resets a bar to "auto", a 422 with errors,
  the access rules, the parameters shown as the "auto" values at each level.
* The sync payload: the effective config with its version, ETag / 304, a stored layer that no
  longer validates sanitised away, the notify to the tills a save reaches.
* The migration: revision chain, idempotent create.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import re
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_design import TillDesignSettings
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_design as R
from app.services import ably_notify
from app.services import till_design as T
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "till_design_contract.json")


@pytest.fixture(scope="module")
def contract():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


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
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    return world


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def put(w, level, entity_id, overrides, user=None):
    return R.put_settings(
        body=R.TillDesignSettingsIn(overrides=overrides), background_tasks=BackgroundTasks(),
        level=level, scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def put_and_run(w, level, entity_id, overrides, user=None):
    tasks = BackgroundTasks()
    view = R.put_settings(
        body=R.TillDesignSettingsIn(overrides=overrides), background_tasks=tasks,
        level=level, scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return view


def get(w, level, entity_id, user=None):
    return R.get_settings(level=level, scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


class _Req:
    def __init__(self, etag=None):
        self.headers = {"if-none-match": etag} if etag else {}


def sync(w, machine, etag=None):
    return R.get_till_design_sync(machine_id=str(machine.id), request=_Req(etag), machine=machine, db=w.db)


def body_of(response):
    return json.loads(response.body)


def set_param(w, key, value, scope_type="shop", scope_id=None):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id or w.shop.id, value=value,
    ))
    w.db.commit()


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


# ── The schema: defaults = today ──────────────────────────────────────────────


def test_defaults_validate_and_are_todays_screens():
    cfg = T.default_config()
    assert T.validate_config(cfg) == []
    assert cfg["template"] == "clean" and cfg["schemaVersion"] == 1
    assert cfg["layout"]["tileSize"] == "auto" and cfg["layout"]["billPosition"] == "auto"
    assert cfg["actionBar"] == {"table": [], "quick": []}
    assert cfg["fields"] == {"customerName": "auto", "serviceType": "auto", "guests": "auto"}
    assert cfg["colors"] == {"accent": None, "mode": "auto"}
    assert cfg["tables"] == {"mapStyle": "auto", "showChairs": "auto"}
    assert all(v is None for p in T.PROFILES for v in cfg["profiles"][p].values())


def test_default_view_per_profile_is_todays_layout():
    cfg = T.default_config()
    for profile in T.PROFILES:
        view = T.for_profile(cfg, profile)
        assert view["template"] == "clean"
        # A table's order is a sheet over the dishes on every device, as today.
        assert view["billPosition"]["table"] == "sheet"
        # Today's table bar: the mini cart and "שלח למטבח"; the quick bar from the parameters.
        assert view["actions"] == {"table": [{"action": "send", "label": ""}], "quick": []}
        assert view["tileSize"] == "auto"
    quick = {p: T.for_profile(cfg, p)["billPosition"]["quick"] for p in T.ANDROID_PROFILES}
    assert quick == {"handheld": "sheet", "tabletLandscape": "end", "tabletPortrait": "bottom"}


def test_every_template_has_a_complete_row():
    for template in T.TEMPLATES:
        row = T.TEMPLATE_DEFAULTS[template]
        assert row["tileStyle"] in T.TILE_STYLES and row["tileStyle"] != "auto"
        for mode in T.MODES:
            assert set(row["billPosition"][mode]) == set(T.PROFILES)
        assert row["tableActions"][0] == "send"
        assert set(row["tableActions"]) <= set(T.TABLE_ACTIONS)
    assert not set(T.PHASE2_TEMPLATES) & set(T.TEMPLATES)


def test_profile_overrides_and_handheld_never_has_a_side_panel():
    layer, errors = T.validate_layer({
        "template": "professional",
        "layout": {"billPosition": "start", "categoryBar": "side"},
        "profiles": {"handheld": {"template": "mobile"}, "tabletPortrait": {"columns": 4, "density": "compact"}},
    })
    assert errors == []
    cfg = T.resolve(layer)
    hand = T.for_profile(cfg, "handheld")
    assert hand["template"] == "mobile" and hand["billPosition"] == {"table": "bottom", "quick": "bottom"}
    assert hand["categoryBar"] == "top" and hand["summaryCollapsible"] is True
    portrait = T.for_profile(cfg, "tabletPortrait")
    assert portrait["template"] == "professional" and portrait["columns"] == 4 and portrait["density"] == "compact"
    assert portrait["billPosition"]["quick"] == "start" and portrait["categoryBar"] == "side"
    assert portrait["tileStyle"] == "row" and portrait["features"] == ["searchField"]


def test_aliases_and_phase2_read_as_a_template_on_the_wire():
    assert T.canonical_template("classic") == "clean"
    assert T.canonical_template("nightBar") == "fast"
    assert T.canonical_template("seats") == "seated"
    assert T.canonical_template("courses") == "clean"
    assert T.canonical_template(None) == "clean"


# ── Validation ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "layer,path,code",
    [
        ({"template": "visual"}, "template", "template_not_available"),
        ({"profiles": {"handheld": {"template": "payDock"}}}, "profiles.handheld.template", "template_not_available"),
        ({"template": "fancy"}, "template", "invalid_value"),
        ({"actionBar": {"quick": [{"action": "cashNotes"}]}}, "actionBar.quick", "action_bar_missing_pay"),
        ({"actionBar": {"table": [{"action": "bill"}]}}, "actionBar.table", "action_bar_missing_send"),
        ({"actionBar": {"quick": [{"action": "pay"}, {"action": "pay"}]}}, "actionBar.quick[1]", "duplicate"),
        ({"actionBar": {"table": [{"action": "send"}, {"action": "hold"}]}}, "actionBar.table[1].action", "invalid_value"),
        ({"bar": {"quantityPresets": [2, 5]}}, "bar.quantityPresets", "quantity_presets_need_one"),
        ({"bar": {"quantityPresets": [1]}}, "bar.quantityPresets", "too_few"),
        ({"quickCash": {"notes": [500]}}, "quickCash.notes[0]", "invalid_value"),
        ({"quickCash": {"count": 9}}, "quickCash.count", "out_of_range"),
        ({"layout": {"columns": 9}}, "layout.columns", "invalid_value"),
        ({"colors": {"accent": "#12345"}}, "colors.accent", "invalid_color"),
        ({"texts": {"pay": "x" * 41}}, "texts.pay", "too_long"),
        ({"fields": {"customerName": "always"}}, "fields.customerName", "invalid_value"),
        ({"menu": {"categoryOrder": ["a", "a"]}}, "menu.categoryOrder[1]", "duplicate"),
        ({"bogus": 1}, "bogus", "unknown_key"),
    ],
)
def test_validation_codes(layer, path, code):
    _cleaned, errors = T.validate_layer(layer)
    assert (path, code) in {(e.path, e.code) for e in errors}


def test_a_layer_drops_nulls_and_empty_objects():
    cleaned, errors = T.validate_layer({
        "template": None, "layout": {"density": None}, "profiles": {"handheld": {"template": None}},
        "colors": {"accent": None, "mode": "dark"},
    })
    assert errors == []
    assert cleaned == {"colors": {"mode": "dark"}}


def test_a_stored_layer_that_no_longer_validates_is_sanitised():
    stored = {
        "template": "courses",  # phase 2: refused on save, but a script could have put it there
        "actionBar": {"quick": [{"action": "fastCard"}]},  # lost its "pay"
        "bar": {"quantityPresets": [2, 3]},
        "layout": {"density": "compact"},
    }
    assert T.sanitize_stored_layer(stored) == {"layout": {"density": "compact"}}
    assert T.sanitize_stored_layer("junk") == {}


# ── The shared contract ───────────────────────────────────────────────────────


def test_contract_defaults_and_catalog(contract):
    assert contract["schemaVersion"] == T.SCHEMA_VERSION
    assert contract["defaults"] == T.default_config()
    assert contract["defaultsVersion"] == T.config_version(T.default_config())
    assert contract["catalog"] == json.loads(json.dumps(T.catalog()))


def test_contract_for_profile(contract):
    assert len(contract["forProfile"]) >= 30
    for case in contract["forProfile"]:
        cfg = case["raw"] if "raw" in case else T.resolve(*case["layers"])
        assert T.for_profile(cfg, case["profile"]) == case["expected"], (case["name"], case["profile"])


def test_contract_merge_quick_cash_legacy_validation(contract):
    for case in contract["merge"]:
        resolved = T.resolve(*case["layers"])
        assert resolved == case["expected"], case["name"]
        assert T.config_version(resolved) == case["expectedVersion"]
    for case in contract["quickCash"]:
        assert T.quick_cash_notes(case["totalAgorot"], case["notes"], case["count"]) == case["expected"], case
    for case in contract["legacyQuickActions"]:
        assert T.legacy_quick_actions(case["parameters"]) == case["expected"], case
    for case in contract["validation"]:
        _cleaned, errors = T.validate_layer(case["layer"])
        got = sorted({(e.path, e.code) for e in errors})
        assert got == [(e["path"], e["code"]) for e in case["errors"]], case["name"]


def test_banknotes_show_a_change_for_each_note():
    assert T.quick_cash_notes(11720, [], 3) == [120, 150, 200]
    assert T.quick_cash_notes(10000, [], 3) == [110, 120, 150]
    assert all(n * 100 > 4800 for n in T.quick_cash_notes(4800, [20, 50, 100, 200], 4))
    assert T.quick_cash_notes(0, [], 3) == []


def test_legacy_quick_actions_mirror_the_till():
    assert T.legacy_quick_actions({}) == [
        {"action": "fastCard", "label": ""}, {"action": "cashWithChange", "label": ""}, {"action": "pay", "label": ""},
    ]
    # The same choice twice: the second moves to the first one not taken.
    same = T.legacy_quick_actions({"quickPayButton1": "מזומן מהיר", "quickPayButton2": "מזומן מהיר"})
    assert [a["action"] for a in same] == ["fastCash", "fastCard", "pay"]
    # "אשראי מהיר" switched off takes its button away.
    assert [a["action"] for a in T.legacy_quick_actions({"fastCard": False})] == ["cashWithChange", "pay"]


# ── Layering through the router ───────────────────────────────────────────────


def test_company_shop_area_machine_layers(w):
    put(w, "company", w.company.id, {"template": "touch", "bar": {"favorites": ["p1", "p2"]}, "texts": {"pay": "לתשלום"}})
    put(w, "shop", w.shop.id, {"layout": {"density": "spacious"}, "bar": {"favorites": ["p3"]}})
    put(w, "area", w.area.id, {"template": "fast"})
    view = put(w, "machine", w.bar_till.id, {"profiles": {"handheld": {"template": "mobile"}}, "colors": {"accent": "#1663D6"}})

    eff = view["effective"]
    assert eff["template"] == "fast"  # the area's
    assert eff["layout"]["density"] == "spacious"  # the shop's, merged into the defaults
    assert eff["bar"]["favorites"] == ["p3"]  # lists replace
    assert eff["texts"] == {"pay": "לתשלום"}  # the company's text, kept through the merge
    assert eff["profiles"]["handheld"]["template"] == "mobile"
    assert view["inherited"]["template"] == "fast" and view["inheritedLayers"]["template"] == "fast"
    assert view["overrides"] == {"profiles": {"handheld": {"template": "mobile"}}, "colors": {"accent": "#1663D6"}}

    # The till outside the area takes the shop's: touch, not fast.
    counter = body_of(sync(w, w.counter_till))["config"]
    assert counter["template"] == "touch" and counter["colors"]["accent"] is None
    bar = body_of(sync(w, w.bar_till))["config"]
    assert bar == eff


def test_null_inherits_and_a_lower_level_resets_a_bar_to_auto(w):
    put(w, "shop", w.shop.id, {"actionBar": {"quick": [{"action": "cashNotes"}, {"action": "pay"}]}})
    view = put(w, "machine", w.counter_till.id, {"actionBar": {"quick": []}, "template": None})
    assert view["effective"]["actionBar"]["quick"] == []
    assert view["overrides"] == {"actionBar": {"quick": []}}
    assert body_of(sync(w, w.bar_till))["config"]["actionBar"]["quick"][0]["action"] == "cashNotes"


def test_a_save_replaces_the_layer(w):
    put(w, "shop", w.shop.id, {"template": "seated", "layout": {"columns": 4}})
    view = put(w, "shop", w.shop.id, {"layout": {"columns": 5}})
    assert view["overrides"] == {"layout": {"columns": 5}}
    assert view["effective"]["template"] == "clean"
    assert w.db.query(TillDesignSettings).filter(TillDesignSettings.level == "shop").count() == 1


def test_invalid_layer_is_a_422_with_paths(w):
    err = refused(put, w, "shop", w.shop.id, {"template": "night", "actionBar": {"table": [{"action": "bill"}]}})
    assert err.status_code == 422
    assert err.detail["code"] == "invalid_till_design"
    codes = {(e["path"], e["code"]) for e in err.detail["errors"]}
    assert ("template", "template_not_available") in codes
    assert ("actionBar.table", "action_bar_missing_send") in codes
    assert w.db.query(TillDesignSettings).count() == 0


def test_access_rules(w):
    # A shop manager: its shop, its points of sale and tills; never the company or another shop.
    assert put(w, "shop", w.shop.id, {"template": "touch"}, user=w.manager)["level"] == "shop"
    assert put(w, "area", w.area.id, {"template": "fast"}, user=w.manager)["level"] == "area"
    assert refused(put, w, "company", w.company.id, {}, user=w.manager).status_code == 403
    assert refused(put, w, "shop", w.other_shop.id, {}, user=w.manager).status_code == 403
    assert refused(get, w, "machine", w.other_till.id, user=w.manager).status_code == 403
    assert refused(get, w, "shop", w.shop.id, user=w.north_manager).status_code == 403
    # A company manager reaches the company; a cashier nothing.
    assert put(w, "company", w.company.id, {"colors": {"mode": "dark"}}, user=w.company_manager)["level"] == "company"
    assert refused(get, w, "shop", w.shop.id, user=w.cashier).status_code == 403
    # Unknown entities.
    assert refused(get, w, "area", uuid.uuid4()).status_code == 404
    assert refused(get, w, "machine", uuid.uuid4()).status_code == 404


def test_targets_list_the_shops_points_of_sale_and_tills(w):
    out = R.get_targets(shop_id=w.shop.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["areas"] == [{"id": str(w.area.id), "name": "בר"}]
    by_name = {m["name"]: m for m in out["machines"]}
    assert set(by_name) == {"Till 1", "Till 2"}
    assert by_name["Till 1"]["areaId"] == str(w.area.id) and by_name["Till 1"]["areaName"] == "בר"
    assert by_name["Till 2"]["areaId"] is None


def test_the_parameters_show_as_the_auto_values_at_each_level(w):
    set_param(w, "quickPayButton1", "מזומן עם עודף", "shop", w.shop.id)
    set_param(w, "productTileSize", "גדול", "company", w.company.id)
    set_param(w, "askOrderName", True, "area", w.area.id)
    company = get(w, "company", w.company.id)["legacy"]
    assert company["tileSize"]["quick"] == "l"
    assert company["quickActions"][0]["action"] == "fastCard"  # the shop's choice is below
    shop = get(w, "shop", w.shop.id)["legacy"]
    assert [a["action"] for a in shop["quickActions"]] == ["cashWithChange", "fastCard", "pay"]
    assert shop["fields"]["customerName"] == "off"
    assert get(w, "area", w.area.id)["legacy"]["fields"]["customerName"] == "required"
    assert get(w, "machine", w.bar_till.id)["legacy"]["fields"]["customerName"] == "required"


def test_defaults_endpoint(w):
    out = R.get_defaults(current_user=w.manager)
    assert out["defaults"] == T.default_config()
    assert out["catalog"]["templates"] == list(T.TEMPLATES)
    assert out["catalog"]["phase2Templates"] == list(T.PHASE2_TEMPLATES)
    assert refused(R.get_defaults, current_user=w.cashier).status_code == 403


# ── The sync payload ──────────────────────────────────────────────────────────


def test_a_till_with_nothing_set_gets_the_defaults(w, contract):
    response = sync(w, w.counter_till)
    body = body_of(response)
    assert body["schemaVersion"] == 1
    assert body["config"] == T.default_config()
    assert body["configVersion"] == contract["defaultsVersion"]
    assert body["updatedAt"] is None
    assert response.headers["ETag"] == f'"{body["configVersion"]}"'


def test_etag_and_304(w):
    first = sync(w, w.bar_till)
    etag = first.headers["ETag"]
    assert sync(w, w.bar_till, etag).status_code == 304
    put(w, "area", w.area.id, {"template": "mobile"})
    changed = sync(w, w.bar_till, etag)
    assert changed.status_code == 200
    body = body_of(changed)
    assert body["config"]["template"] == "mobile" and body["updatedAt"] is not None
    # The other till's design did not change: still 304 on its own ETag.
    other = sync(w, w.counter_till).headers["ETag"]
    assert sync(w, w.counter_till, other).status_code == 304


def test_a_stored_bad_layer_never_reaches_a_till(w):
    w.db.add(TillDesignSettings(
        id=uuid.uuid4(), tenant_id=w.tenant.id, level="machine", machine_id=w.counter_till.id,
        overrides={"template": "visual", "layout": {"tileSize": "huge", "density": "compact"}, "junk": True},
    ))
    w.db.commit()
    cfg = body_of(sync(w, w.counter_till))["config"]
    assert T.validate_config(cfg) == []
    assert cfg["template"] == "clean" and cfg["layout"]["tileSize"] == "auto" and cfg["layout"]["density"] == "compact"


def test_a_save_notifies_the_tills_it_reaches(w):
    put_and_run(w, "area", w.area.id, {"template": "fast"})
    assert w.notified == [(str(w.bar_till.id), "till_design_updated")]
    w.notified.clear()
    put_and_run(w, "shop", w.shop.id, {"template": "touch"})
    assert sorted(w.notified) == sorted([(str(t.id), "till_design_updated") for t in w.tills])


# ── The migration ─────────────────────────────────────────────────────────────


def _migration():
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "d4e8b2f6a1c9_till_design_settings.py")
    spec = importlib.util.spec_from_file_location("till_design_settings_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_chain_and_single_head():
    module = _migration()
    assert module.revision == "d4e8b2f6a1c9" and module.down_revision == "e7d1b4a9c3f6"
    versions = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    on_top = re.compile(r"down_revision[^=]*=\s*[\"']d4e8b2f6a1c9[\"']")
    downs = {
        name for name in os.listdir(versions)
        if name.endswith(".py") and on_top.search(open(os.path.join(versions, name), encoding="utf-8").read())
    }
    assert downs == set(), "nothing may sit on top of the till design migration yet"


def test_migration_is_idempotent(monkeypatch):
    module = _migration()
    op = MagicMock()
    module.op = op
    inspector = MagicMock()
    monkeypatch.setattr(module.sa, "inspect", lambda bind: inspector)

    # The table already made by the API's create_all, with two of its indexes: only the rest.
    inspector.has_table.return_value = True
    inspector.get_indexes.return_value = [{"name": "ix_till_design_settings_tenant_id"}, {"name": "uq_till_design_settings_shop"}]
    module.upgrade()
    op.create_table.assert_not_called()
    made = [c.args[0] for c in op.create_index.call_args_list]
    assert made == ["uq_till_design_settings_company", "uq_till_design_settings_area", "uq_till_design_settings_machine"]

    # A fresh database: the table and every index.
    op.reset_mock()
    inspector.has_table.side_effect = [False]
    inspector.get_indexes.return_value = []
    module.upgrade()
    op.create_table.assert_called_once()
    assert len(op.create_index.call_args_list) == len(module.INDEXES)
