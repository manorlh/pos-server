"""
"עיצוב קופה → שולחנות ומפה" (P:/specs/till-design-tables.md, the contract §5): the tables' look —
`tableTileStyle`, `tableTileInfo`, `tableStateColors`, `tableOverdueMinutes`, `tableNumberSize`
(app/services/table_tile_look.py) — till parameters per company → shop → point of sale → till, and
the till design's card that edits them with the map's display (`/till-design/table-display`).

* Built in with the owner's defaults; every till gets them in its parameters payload. The colours'
  default is pinned byte for byte: it is the contract the till implements (TableVisuals.kt today).
* What the till parses is normalised (the info list in its order, the colours whole and lower case);
  anything else is refused (422), whatever route writes it.
* The levels, through the till design's router functions; null inherits again; the tills under the
  level are told.
* The card: its groups and keys in order, the inherited values, `canEdit`; the till design's access.
* "הרשאות דשבורד": the card's routes are the till design's (the floor editor's stay the tables').

Runs on the in-memory SQLite world of tests/shift_world.py (the till design tests' `w`).
"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi import HTTPException

from app.models.till_parameter import TillParameterValue
from app.routers import till_design as R
from app.services import dashboard_sections as DS
from app.services import table_map_display as MD
from app.services import table_restore as TR
from app.services import table_tile_look as TL
from app.services import till_parameters as TP
from test_till_design import refused, w  # noqa: F401  (w: the till design world fixture)

TILE_DEFAULTS = {
    "tableTileStyle": "soft",
    "tableTileInfo": "guests,time,amount",
    "tableStateColors": (
        '{"free":"#34c759","occupied":"#3b82f6","kitchen":"#f97316","toPay":"#ff9500",'
        '"otherTill":"#af52de","overdue":"#ff3b30","reserved":"#30b0c7"}'
    ),
    "tableOverdueMinutes": 45,
    "tableNumberSize": "m",
}
MAP_DEFAULTS = {"mapDecor": "full", "mapLegend": "button", "mapSymbolLabels": "auto", "mapSymbolScale": 100}


@pytest.fixture
def told(w, monkeypatch):
    """The tills told to pull their parameters (`till_parameters_updated`)."""
    out = []
    monkeypatch.setattr(
        TP, "publish_settings_notify", lambda tenant_id, machine_id, **kw: out.append((str(machine_id), kw.get("reason"))),
    )
    return out


def get(w, level, entity_id, user=None):
    return R.get_table_display(
        level=level, scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def put(w, level, entity_id, values, user=None):
    return R.put_table_display(
        body=R.TableDisplayIn(values=values), level=level, scope_id=entity_id,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def synced(w, till) -> dict:
    from app.routers.sync import get_till_parameters_sync

    return get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db).parameters


def stored_rows(w) -> int:
    from app.models.till_parameter import TillParameter

    ids = [p.id for p in w.db.query(TillParameter).filter(TillParameter.key.in_(TL.LEVEL_KEYS)).all()]
    return w.db.query(TillParameterValue).filter(TillParameterValue.parameter_id.in_(ids)).count()


# ── Built in, the defaults, the payload ───────────────────────────────────────


def test_built_in_with_the_owner_s_defaults_and_every_till_gets_them(w):
    specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    assert TL.LEVEL_KEYS == tuple(TILE_DEFAULTS)
    for key, default in TILE_DEFAULTS.items():
        spec = specs[key]
        assert spec.default_value == default, key
        assert spec.label and spec.description and not spec.admin_only, key
        # Hebrew for the dashboard and the parameters page.
        assert any("\u0590" <= ch <= "\u05ff" for ch in spec.label), key
    assert specs["tableTileStyle"].enum_options == ("soft", "filled", "outline")
    assert specs["tableNumberSize"].enum_options == ("s", "m", "l")
    assert specs["tableTileInfo"].value_type == "string"
    assert specs["tableStateColors"].value_type == "string"
    assert specs["tableOverdueMinutes"].value_type == "integer"
    assert set(TP.enum_labels("tableTileStyle")) == {"soft", "filled", "outline"}
    assert TP.enum_labels("tableNumberSize") == {"s": "קטן", "m": "רגיל", "l": "גדול"}
    for till in (*w.tills, w.other_till):
        got = synced(w, till)
        assert {k: got[k] for k in TILE_DEFAULTS} == TILE_DEFAULTS


def test_the_colours_default_is_the_till_s_today_and_the_contract_s():
    # pos-android ui/tables/TableVisuals.kt — classicBadgeColor / stateRing(SENT); the spec's §5.
    assert TL.DEFAULT_COLORS == {
        "free": "#34c759", "occupied": "#3b82f6", "kitchen": "#f97316", "toPay": "#ff9500",
        "otherTill": "#af52de", "overdue": "#ff3b30", "reserved": "#30b0c7",
    }
    assert TL.COLORS_DEFAULT == TILE_DEFAULTS["tableStateColors"]
    assert list(json.loads(TL.COLORS_DEFAULT)) == list(TL.STATES)
    assert TL.STATES == ("free", "occupied", "kitchen", "toPay", "otherTill", "overdue", "reserved")
    assert TL.INFO_FIELDS == ("guests", "time", "amount", "waiter", "course", "seats")
    assert set(TL.STATE_LABELS) == set(TL.STATES) and set(TL.INFO_LABELS) == set(TL.INFO_FIELDS)


# ── Values: normalised, or refused ────────────────────────────────────────────


@pytest.mark.parametrize("key, value, stored", [
    ("tableTileStyle", "soft", "soft"),
    ("tableTileStyle", "filled", "filled"),
    ("tableTileStyle", "outline", "outline"),
    ("tableNumberSize", "s", "s"),
    ("tableNumberSize", "l", "l"),
    ("tableTileInfo", "guests,time,amount", "guests,time,amount"),
    # The till's order, whatever order it was typed in; spaces and case dropped.
    ("tableTileInfo", "waiter, guests", "guests,waiter"),
    ("tableTileInfo", "SEATS,Course", "course,seats"),
    ("tableTileInfo", "seats,course,waiter,amount,time,guests", "guests,time,amount,waiter,course,seats"),
    ("tableTileInfo", "none", "none"),
    ("tableTileInfo", " None ", "none"),
    ("tableOverdueMinutes", 5, 5),
    ("tableOverdueMinutes", 600, 600),
    ("tableOverdueMinutes", 90.0, 90),
])
def test_values_the_till_parses(key, value, stored):
    assert TP.validate_keyed_value(key, value) == stored


def test_the_colours_are_stored_whole_lower_case_and_in_order():
    got = TP.validate_keyed_value("tableStateColors", '{"occupied": "#16A34A", "free": "#FFFFFF"}')
    want = dict(TL.DEFAULT_COLORS, occupied="#16a34a", free="#ffffff")
    assert json.loads(got) == want
    assert got == json.dumps({s: want[s] for s in TL.STATES}, separators=(",", ":"))
    # Nothing given: every default; an object (not its text) is read the same.
    assert TP.validate_keyed_value("tableStateColors", "{}") == TL.COLORS_DEFAULT
    assert TL.clean_value("tableStateColors", {"reserved": "#0891b2"}) == TL.colors_text(dict(TL.DEFAULT_COLORS, reserved="#0891b2"))


@pytest.mark.parametrize("key, value", [
    ("tableTileStyle", "Soft"),
    ("tableTileStyle", "flat"),
    ("tableNumberSize", "xl"),
    ("tableNumberSize", "M"),
    ("tableTileInfo", ""),
    ("tableTileInfo", "guests,,time"),
    ("tableTileInfo", "guests,price"),
    ("tableTileInfo", "guests,guests"),
    ("tableTileInfo", "none,guests"),
    ("tableTileInfo", 5),
    ("tableStateColors", "not json"),
    ("tableStateColors", "[]"),
    ("tableStateColors", '"#ffffff"'),
    ("tableStateColors", '{"busy": "#000000"}'),
    ("tableStateColors", '{"free": "#fff"}'),
    ("tableStateColors", '{"free": "green"}'),
    ("tableStateColors", '{"free": "#12345g"}'),
    ("tableStateColors", '{"free": 123}'),
    ("tableStateColors", '{"free": null}'),
    ("tableOverdueMinutes", 4),
    ("tableOverdueMinutes", 601),
    ("tableOverdueMinutes", 45.5),
    ("tableOverdueMinutes", "45"),
    ("tableOverdueMinutes", True),
])
def test_a_value_the_till_cannot_parse_is_refused_on_every_route(w, told, key, value):
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == key)
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value(key, TP.validate_value(spec.value_type, value, spec.enum_options))
    # With a good value beside it: refused all the same.
    good = {"tableTileStyle": "filled"} if key != "tableTileStyle" else {"tableNumberSize": "l"}
    e = refused(put, w, "company", w.company.id, {**good, key: value})
    assert e.status_code == 422 and e.detail["code"] == "invalid_value"
    # Nothing written, nobody told.
    assert stored_rows(w) == 0 and told == []


def test_a_key_not_on_the_card_is_refused(w, told):
    e = refused(put, w, "shop", w.shop.id, {"restoreWindow": "any"})
    assert e.status_code == 422 and "restoreWindow" in e.detail["message"]
    assert refused(put, w, "shop", w.shop.id, {"tableColour": "x"}).status_code == 422


# ── Levels ────────────────────────────────────────────────────────────────────


def test_levels_company_shop_area_till_and_null_inherits(w, told):
    bar, counter = w.bar_till, w.counter_till  # the bar till is in the point of sale `w.area`
    green = json.dumps({"occupied": "#16a34a"})
    put(w, "company", w.company.id, {"tableStateColors": green, "tableOverdueMinutes": 30})
    put(w, "shop", w.shop.id, {"tableTileInfo": "waiter,guests", "mapDecor": "symbols"})
    put(w, "area", w.area.id, {"tableTileStyle": "filled"})
    view = put(w, "machine", counter.id, {"tableNumberSize": "l", "tableOverdueMinutes": 60})
    assert view["own"] == {"tableNumberSize": "l", "tableOverdueMinutes": 60}
    assert view["inherited"]["tableOverdueMinutes"] == 30 and view["inherited"]["tableTileInfo"] == "guests,waiter"

    b, c = synced(w, bar), synced(w, counter)
    assert json.loads(b["tableStateColors"])["occupied"] == "#16a34a"
    assert json.loads(b["tableStateColors"])["free"] == "#34c759"
    assert (b["tableTileStyle"], b["tableTileInfo"], b["tableOverdueMinutes"], b["tableNumberSize"]) == (
        "filled", "guests,waiter", 30, "m")
    assert (c["tableTileStyle"], c["tableTileInfo"], c["tableOverdueMinutes"], c["tableNumberSize"]) == (
        "soft", "guests,waiter", 60, "l")
    assert b["mapDecor"] == c["mapDecor"] == "symbols"
    # Another shop of the company: the company's only.
    north = synced(w, w.other_till)
    assert north["tableOverdueMinutes"] == 30 and north["tableTileInfo"] == TILE_DEFAULTS["tableTileInfo"]

    # Cleared at the till: the company's again.
    put(w, "machine", counter.id, {"tableOverdueMinutes": None})
    assert synced(w, counter)["tableOverdueMinutes"] == 30
    assert get(w, "machine", counter.id)["own"] == {"tableNumberSize": "l"}


def test_the_tills_under_the_level_are_told(w, told):
    put(w, "area", w.area.id, {"tableTileStyle": "outline"})
    assert told == [(str(w.bar_till.id), "till_parameters_updated")]
    told.clear()
    put(w, "shop", w.shop.id, {"tableNumberSize": "s"})
    assert sorted(m for m, _ in told) == sorted(str(t.id) for t in w.tills)


def test_the_parameters_page_route_refuses_what_the_card_refuses(w):
    # The generic validation every route runs (app/routers/till_parameters.py → validate_keyed_value).
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value("tableStateColors", '{"free": "#fff"}')
    assert TP.validate_keyed_value("tableTileInfo", "time,guests") == "guests,time"


# ── The card ──────────────────────────────────────────────────────────────────


def test_the_card_lists_the_look_then_the_map_s_display(w):
    got = get(w, "shop", w.shop.id)
    assert [g["key"] for g in got["groups"]] == ["tileLook", "mapDisplay"]
    assert [p["key"] for p in got["parameters"]] == [*TILE_DEFAULTS, *MAP_DEFAULTS]
    assert {p["key"]: p["group"] for p in got["parameters"]} == {
        **{k: "tileLook" for k in TILE_DEFAULTS}, **{k: "mapDisplay" for k in MAP_DEFAULTS},
    }
    by_key = {p["key"]: p for p in got["parameters"]}
    assert by_key["tableTileStyle"]["enumLabels"]["filled"] and by_key["mapDecor"]["enumLabels"]["full"]
    assert by_key["tableStateColors"]["defaultValue"] == TILE_DEFAULTS["tableStateColors"]
    assert got["own"] == {} and got["canEdit"] is True
    assert {k: got["inherited"][k] for k in TILE_DEFAULTS} == TILE_DEFAULTS
    assert {k: got["inherited"][k] for k in MAP_DEFAULTS} == MAP_DEFAULTS
    assert TL.till_design_keys() == (*TILE_DEFAULTS, *MAP_DEFAULTS)
    assert MD.LEVEL_KEYS == tuple(MAP_DEFAULTS)


def test_the_tables_page_card_is_unchanged(w):
    # Its own groups (whatever other groups it has): never the tables' look, which is the till design's.
    groups = [g for g, _l, _k in TR._page_groups()]
    assert groups[:3] == ["staffTables", "restore", "mapDisplay"] and TL.TILE_LOOK_GROUP not in groups
    assert not set(TL.LEVEL_KEYS) & set(TR.page_keys())


def test_the_till_design_s_access(w, told):
    # A shop manager: its shop, its points of sale and tills; never the company or another shop.
    assert put(w, "shop", w.shop.id, {"tableTileStyle": "filled"}, user=w.manager)["own"] == {"tableTileStyle": "filled"}
    assert put(w, "area", w.area.id, {"tableNumberSize": "l"}, user=w.manager)["canEdit"] is True
    assert put(w, "machine", w.counter_till.id, {"tableOverdueMinutes": 20}, user=w.manager)["canEdit"] is True
    assert get(w, "shop", w.shop.id, user=w.manager)["canEdit"] is True
    assert refused(put, w, "company", w.company.id, {"tableTileStyle": "filled"}, user=w.manager).status_code == 403
    assert refused(get, w, "company", w.company.id, user=w.manager).status_code == 403
    assert refused(put, w, "shop", w.other_shop.id, {"tableTileStyle": "filled"}, user=w.manager).status_code == 403
    assert refused(get, w, "machine", w.other_till.id, user=w.manager).status_code == 403
    assert refused(get, w, "shop", w.shop.id, user=w.north_manager).status_code == 403
    # A company manager: the company; a cashier: nothing.
    assert put(w, "company", w.company.id, {"tableNumberSize": "s"}, user=w.company_manager)["own"] == {"tableNumberSize": "s"}
    assert refused(get, w, "shop", w.shop.id, user=w.cashier).status_code == 403
    assert refused(put, w, "shop", w.shop.id, {"tableNumberSize": "s"}, user=w.cashier).status_code == 403
    # Unknown places.
    assert refused(get, w, "area", uuid.uuid4()).status_code == 404
    assert refused(get, w, "machine", uuid.uuid4()).status_code == 404


def test_writing_needs_a_machine_admin(w):
    from app.middleware.auth import get_current_machine_admin

    with pytest.raises(HTTPException) as e:
        get_current_machine_admin(current_user=w.cashier)
    assert e.value.status_code == 403
    assert get_current_machine_admin(current_user=w.manager) is w.manager


# ── "הרשאות דשבורד": the routes ────────────────────────────────────────────────


@pytest.mark.parametrize("method, path, needed", [
    ("GET", "/till-design/table-display", "till_design:view"),
    ("PUT", "/till-design/table-display", "till_design:edit"),
])
def test_the_route_sections(method, path, needed):
    assert DS.rule_for(method, path).describe(method) == needed
