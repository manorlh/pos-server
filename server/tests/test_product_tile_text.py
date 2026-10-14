"""
"שם פריט מלא על הכפתור, ותג i" (P:/specs/product-tile-text.md, app/services/product_tile_text.py).

* The four till parameters: `productNameFit` (fit / wrap / clip, fit), `productNameMaxLines` (1–4, 3),
  `productNameMinTextSize` (s / m / l, s), `productInfoBadge` (auto / always / off, auto) — built-ins
  with their Hebrew, set per company → shop → point of sale → till (the most specific wins), pulled with
  the others, a value the till does not know refused.
* "עיצוב קופה": the same four as `productText.<key>` of the design (§5), which wins over the parameter;
  "params" undoes a level above's value; nothing set is no `productText` at all (the sync bytes of a till
  with nothing set do not move); the editor's `legacy` carries the parameters' four.
* The catalogs carry what the item's sheet shows (§4): the till's sync rows (description, picture,
  dietary tags, allergens, blocks) and the dashboard's till catalog the preview reads.

Runs on the in-memory SQLite worlds of tests/shift_world.py and tests/test_product_availability.py.
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_design as D
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterUpdate, TillParameterValueIn
from app.services import ably_notify
from app.services import product_tile_text as PT
from app.services import till_design as T
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world
from test_machine_catalog import _get, _sync, w  # noqa: F401
from test_product_availability import world  # noqa: F401

KEYS = ("productNameFit", "productNameMaxLines", "productNameMinTextSize", "productInfoBadge")
DEFAULTS = {"productNameFit": "fit", "productNameMaxLines": 3, "productNameMinTextSize": "s", "productInfoBadge": "auto"}
CODES = {
    "productNameFit": ["fit", "wrap", "clip"],
    "productNameMinTextSize": ["s", "m", "l"],
    "productInfoBadge": ["auto", "always", "off"],
}


@pytest.fixture
def tw(monkeypatch):
    accept_str_uuids(monkeypatch)
    world_ = make_world()
    world_.notified = []
    record = lambda tenant, machine, reason=None, **kw: world_.notified.append((str(machine), reason))  # noqa: E731
    monkeypatch.setattr(TP, "publish_settings_notify", record)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", record)
    area = ShopArea(id=uuid.uuid4(), tenant_id=world_.tenant.id, shop_id=world_.shop.id, name="בר")
    world_.db.add(area)
    world_.db.flush()
    world_.tills[0].area_id = area.id
    world_.area = area
    world_.manager = User(
        id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world_.tenant.id, company_id=world_.company.id,
        shop_id=world_.shop.id, email="mgr@x", username="mgr",
    )
    world_.db.add(world_.manager)
    world_.db.commit()
    TP.ensure_builtin_parameters(world_.db)
    world_.db.commit()
    return world_


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _spec(key):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == key]
    return spec


def _definition(tw, key) -> TillParameter:
    return tw.db.query(TillParameter).filter(TillParameter.key == key).one()


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _set(tw, key, scope_type, scope_id, value):
    """The parameters page's write (`PUT /till-parameters/{id}/values`)."""
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(tw, key).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=tw.db,
    )
    _run(tasks)
    return out


def _pulled(tw, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=tw.db)
    params = resp.model_dump(mode="json", by_alias=True)["parameters"]
    return {k: params.get(k) for k in KEYS}


def _design_put(tw, level, entity_id, overrides):
    return D.put_settings(
        body=D.TillDesignSettingsIn(overrides=overrides), background_tasks=BackgroundTasks(),
        level=level, scope_id=entity_id, current_user=tw.admin, active_tenant_id=tw.tenant.id, db=tw.db,
    )


def _design_get(tw, level, entity_id):
    return D.get_settings(level=level, scope_id=entity_id, current_user=tw.admin, active_tenant_id=tw.tenant.id, db=tw.db)


class _Req:
    headers: dict = {}


def _design_sync(tw, till):
    response = D.get_till_design_sync(machine_id=str(till.id), request=_Req(), machine=till, db=tw.db)
    return json.loads(response.body)


# ── The definitions ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("key", KEYS)
def test_four_builtins_with_todays_defaults(key):
    spec = _spec(key)
    assert spec.value_type == ("integer" if key == "productNameMaxLines" else "enum")
    if key in CODES:
        assert list(spec.enum_options) == CODES[key]
    assert spec.default_value == DEFAULTS[key]
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(key) == 1
    assert TP.validate_key(key) == key
    assert TP.managed_on(key) is None
    assert PT.DEFAULTS == DEFAULTS and PT.KEYS == KEYS


def test_the_hebrew_of_each_code_and_the_descriptions_say_where_and_how():
    assert TP.enum_labels("productNameFit") == {
        "fit": "התאמה — כל השם נכנס (ברירת מחדל)",
        "wrap": "שבירת שורות — הכפתור גדל",
        "clip": "קיצור עם \"…\" — כמו היום",
    }
    assert TP.enum_labels("productNameMinTextSize") == {"s": "קטן", "m": "בינוני", "l": "גדול"}
    assert TP.enum_labels("productInfoBadge") == {
        "auto": "אוטומטי — כשיש תיאור או שהשם לא נכנס", "always": "תמיד", "off": "כבוי",
    }
    fit = _spec("productNameFit").description
    for words in ("בטלפון", "בטאבלט", "במכשיר הנייד", "בהזמנת שולחן", "במועדפים", "קופת Windows", "קופת web", "לא בקיוסק"):
        assert words in fit
    assert "המחיר תמיד מוצג במלואו" in fit and "\".00\"" in fit
    badge = _spec("productInfoBadge").description
    for words in ("בפינה העליונה השמאלית", "לא מוסיפה לסל", "עריכת מסך", "הוסף לסל", "אזל", "חסום"):
        assert words in badge
    for key in KEYS:
        description = _spec(key).description
        assert "חברה, סניף, נקודת מכירה או קופה" in description
        assert "עיצוב קופה" in description and "מראה" in description and "גובר על הפרמטר" in description
    assert "1–4" in _spec("productNameMaxLines").description


def test_the_floors_and_the_badges_touch_target():
    assert PT.MIN_TEXT_SP == {"s": 11, "m": 13, "l": 15}
    assert PT.PRICE_MIN_SP == PT.MIN_TEXT_SP["s"]
    assert PT.INFO_BADGE_TOUCH_DP >= 32


def test_they_are_created_with_the_others_and_left_alone_afterwards(tw):
    for key in KEYS:
        row = _definition(tw, key)
        assert row.is_active and row.default_value == DEFAULTS[key]
    _definition(tw, "productNameFit").label = "שם"
    tw.db.commit()
    assert not set(KEYS) & set(TP.ensure_builtin_parameters(tw.db))
    assert _definition(tw, "productNameFit").label == "שם"


def test_the_dashboard_list_carries_the_hebrew_of_each_code(tw):
    rows = {r.key: r.model_dump(mode="json", by_alias=True) for r in R.list_till_parameters(_admin=_admin(), db=tw.db)}
    for key in KEYS:
        assert rows[key]["defaultValue"] == DEFAULTS[key]
        assert rows[key]["managedOn"] is None and rows[key]["adminOnly"] is False
        if key in CODES:
            assert rows[key]["enumOptions"] == CODES[key]
            assert rows[key]["enumLabels"] == TP.enum_labels(key)


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_till_pulls_the_defaults_until_someone_sets_them(tw):
    for till in (*tw.tills, tw.other_till):
        assert _pulled(tw, till) == DEFAULTS


def test_the_most_specific_level_wins(tw):
    t_area, t_shop = tw.tills
    _set(tw, "productNameFit", "company", tw.company.id, "clip")
    _set(tw, "productNameFit", "shop", tw.shop.id, "wrap")
    _set(tw, "productNameMaxLines", "area", tw.area.id, 2)
    _set(tw, "productNameMinTextSize", "machine", t_area.id, "l")
    _set(tw, "productInfoBadge", "company", tw.company.id, "always")

    assert _pulled(tw, t_area) == {
        "productNameFit": "wrap", "productNameMaxLines": 2, "productNameMinTextSize": "l", "productInfoBadge": "always",
    }
    assert _pulled(tw, t_shop) == {**DEFAULTS, "productNameFit": "wrap", "productInfoBadge": "always"}
    assert _pulled(tw, tw.other_till) == {**DEFAULTS, "productNameFit": "clip", "productInfoBadge": "always"}


@pytest.mark.parametrize("key,value", [
    ("productNameFit", "shrink"), ("productNameFit", "Fit"), ("productNameFit", True),
    ("productNameMaxLines", 0), ("productNameMaxLines", 5), ("productNameMaxLines", "3"), ("productNameMaxLines", 2.5),
    ("productNameMinTextSize", "xs"), ("productNameMinTextSize", 11),
    ("productInfoBadge", "on"), ("productInfoBadge", ""),
])
def test_a_value_the_till_does_not_know_is_refused(tw, key, value):
    with pytest.raises(HTTPException) as exc:
        _set(tw, key, "shop", tw.shop.id, value)
    assert exc.value.status_code == 422
    assert tw.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(tw, key).id).count() == 0
    assert _pulled(tw, tw.tills[0]) == DEFAULTS


def test_the_lines_take_a_whole_float_as_its_number(tw):
    _set(tw, "productNameMaxLines", "shop", tw.shop.id, 4.0)
    assert _pulled(tw, tw.tills[1])["productNameMaxLines"] == 4


def test_the_till_knows_its_codes_even_if_the_options_are_re_edited(tw):
    R.update_till_parameter(
        parameter_id=_definition(tw, "productInfoBadge").id,
        body=TillParameterUpdate(enumOptions=["auto", "always", "off", "hover"]),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=tw.db,
    )
    with pytest.raises(HTTPException) as exc:
        _set(tw, "productInfoBadge", "machine", tw.tills[0].id, "hover")
    assert exc.value.status_code == 422 and "auto, always, off" in exc.value.detail


def test_a_change_moves_the_parameters_etag(tw):
    till = tw.tills[0]
    request = MagicMock()
    request.headers = {}
    first = get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=tw.db)
    assert {k: json.loads(first.body)["parameters"][k] for k in KEYS} == DEFAULTS
    etag = first.headers["etag"]
    _set(tw, "productNameFit", "area", tw.area.id, "clip")
    request.headers = {"if-none-match": etag}
    second = get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=tw.db)
    assert second.status_code == 200 and second.headers["etag"] != etag
    assert json.loads(second.body)["parameters"]["productNameFit"] == "clip"
    assert (str(till.id), TP.NOTIFY_REASON) in tw.notified


# ── The design wins over the parameter (§5) ──────────────────────────────────


def test_resolve_the_design_wins_params_and_unknown_follow_the_parameter():
    params = {"productNameFit": "clip", "productNameMaxLines": 2, "productNameMinTextSize": "m", "productInfoBadge": "off"}
    assert PT.resolve(None, {}) == DEFAULTS
    assert PT.resolve({}, params) == params
    assert PT.resolve({"productNameFit": "wrap", "productNameMaxLines": 4}, params) == {**params, "productNameFit": "wrap", "productNameMaxLines": 4}
    # "params", null, an unknown code, a bool for the lines: the parameter.
    design = {"productNameFit": "params", "productNameMaxLines": True, "productNameMinTextSize": None, "productInfoBadge": "hover"}
    assert PT.resolve(design, params) == params
    # A parameter the till does not know is its default.
    assert PT.resolve({}, {"productNameFit": "shrink", "productNameMaxLines": 9}) == DEFAULTS


def test_the_design_section_validates_codes_and_params():
    layer = {"productText": {"productNameFit": "wrap", "productNameMaxLines": 4, "productNameMinTextSize": "l", "productInfoBadge": "always"}}
    cleaned, errors = T.validate_layer(layer)
    assert errors == [] and cleaned == layer
    cleaned, errors = T.validate_layer({"productText": {k: "params" for k in KEYS}})
    assert errors == [] and cleaned == {"productText": {k: "params" for k in KEYS}}
    # Nulls inherit and an emptied section is no section.
    assert T.validate_layer({"productText": {"productNameFit": None}}) == ({}, [])
    bad = {"productText": {
        "productNameFit": "shrink", "productNameMaxLines": 5, "productNameMinTextSize": "xl", "productInfoBadge": True, "size": 3,
    }}
    _cleaned, errors = T.validate_layer(bad)
    assert sorted((e.path, e.code) for e in errors) == [
        ("productText.productInfoBadge", "invalid_value"),
        ("productText.productNameFit", "invalid_value"),
        ("productText.productNameMaxLines", "out_of_range"),
        ("productText.productNameMinTextSize", "invalid_value"),
        ("productText.size", "unknown_key"),
    ]
    assert [e.code for e in T.validate_layer({"productText": {"productNameMaxLines": "3"}})[1]] == ["invalid_type"]


def test_nothing_set_is_no_section_and_todays_sync_bytes():
    cfg = T.default_config()
    assert "productText" not in cfg
    assert T.validate_config(cfg) == []
    assert T.resolve({}, {}, {}, {}) == cfg
    resolved = T.resolve({"productText": {"productNameFit": "wrap"}})
    assert resolved["productText"] == {"productNameFit": "wrap"}
    assert T.validate_config(resolved) == []
    # The section never changes what a profile shows.
    for profile in T.PROFILES:
        assert T.for_profile(resolved, profile) == T.for_profile(cfg, profile)


def test_levels_merge_key_by_key_and_params_undoes_a_level_above():
    company = {"productText": {"productNameFit": "wrap", "productInfoBadge": "off"}}
    shop = {"productText": {"productNameMaxLines": 2}}
    till = {"productText": {"productNameFit": "params"}}
    eff = T.resolve(company, shop, {}, till)
    assert eff["productText"] == {"productNameFit": "params", "productInfoBadge": "off", "productNameMaxLines": 2}
    params = {"productNameFit": "clip"}
    assert PT.resolve(eff["productText"], params) == {
        "productNameFit": "clip", "productNameMaxLines": 2, "productNameMinTextSize": "s", "productInfoBadge": "off",
    }


def test_through_the_router_the_till_gets_the_section_and_legacy_the_parameters(tw):
    t_area, t_shop = tw.tills
    _set(tw, "productNameFit", "shop", tw.shop.id, "clip")
    _set(tw, "productNameMaxLines", "area", tw.area.id, 4)
    _set(tw, "productInfoBadge", "company", tw.company.id, "always")
    before = _design_sync(tw, t_shop)
    assert "productText" not in before["config"]

    view = _design_put(tw, "shop", tw.shop.id, {"productText": {"productNameFit": "wrap", "productNameMinTextSize": "m"}})
    assert view["overrides"] == {"productText": {"productNameFit": "wrap", "productNameMinTextSize": "m"}}
    assert view["legacy"]["productText"] == {**DEFAULTS, "productNameFit": "clip", "productInfoBadge": "always"}
    after = _design_sync(tw, t_shop)
    assert after["config"]["productText"] == {"productNameFit": "wrap", "productNameMinTextSize": "m"}
    assert after["configVersion"] != before["configVersion"]

    # The point of sale's till: "params" over the shop's fit, the area's 4 lines from the parameters.
    _design_put(tw, "area", tw.area.id, {"productText": {"productNameFit": "params"}})
    cfg = _design_sync(tw, t_area)["config"]
    assert cfg["productText"] == {"productNameFit": "params", "productNameMinTextSize": "m"}
    area_legacy = _design_get(tw, "area", tw.area.id)["legacy"]["productText"]
    assert area_legacy == {**DEFAULTS, "productNameFit": "clip", "productNameMaxLines": 4, "productInfoBadge": "always"}
    assert PT.resolve(cfg["productText"], _pulled(tw, t_area)) == {
        "productNameFit": "clip", "productNameMaxLines": 4, "productNameMinTextSize": "m", "productInfoBadge": "always",
    }

    with pytest.raises(HTTPException) as exc:
        _design_put(tw, "shop", tw.shop.id, {"productText": {"productInfoBadge": "sometimes"}})
    assert exc.value.status_code == 422
    assert ("productText.productInfoBadge", "invalid_value") in {(e["path"], e["code"]) for e in exc.value.detail["errors"]}


def test_legacy_reads_the_four_parameters():
    assert "productText" not in T.catalog()["legacyMap"]
    for key in KEYS:
        assert key in T.legacy_parameter_keys()
    assert T.legacy_view({})["productText"] == DEFAULTS
    assert T.legacy_view({"productNameFit": "wrap", "productNameMaxLines": 7})["productText"] == {**DEFAULTS, "productNameFit": "wrap"}


# ── What the item's sheet reads (§4) ─────────────────────────────────────────


def test_the_tills_catalog_rows_carry_what_the_sheet_shows(w):  # noqa: F811
    p = w.P
    p.description = "קולה קרה בבקבוק זכוכית, 330 מ\"ל."
    p.image_url = "https://img.example/cola.png"
    p.allergens = ["gluten", "milk"]
    p.dietary_tags = ["dairy", "vegetarian"]
    w.db.commit()
    row = _sync(w, w.h1)[str(p.id)]
    assert row["name"] == "Cola" and row["categoryId"] == str(p.category_id)
    assert row["description"] == "קולה קרה בבקבוק זכוכית, 330 מ\"ל."
    assert row["imageUrl"] == "https://img.example/cola.png"
    assert row["allergens"] == ["gluten", "milk"]
    assert row["dietaryTags"] == ["vegetarian", "dairy"]
    # "אזל" / "חסום" with the reason travel as the blocks in force (kind, note, by, until).
    assert row["blocks"] == [] and row["isAvailable"] is True and "availabilityLock" in row


def test_the_dashboards_till_catalog_carries_them_for_the_preview(w):  # noqa: F811
    w.P.description = "קולה קרה"
    w.P.allergens = ["milk", 7]
    w.P.dietary_tags = ["vegan"]
    w.db.commit()
    picture = _get(w, w.h1).model_dump(mode="json", by_alias=True)
    by_id = {p["productId"]: p for p in picture["products"]}
    cola = by_id[str(w.P.id)]
    assert cola["description"] == "קולה קרה"
    assert cola["dietaryTags"] == ["vegan"]
    assert cola["allergens"] == ["milk"]
    soda = by_id[str(w.Q.id)]
    assert soda["description"] is None and soda["dietaryTags"] == [] and soda["allergens"] == []
