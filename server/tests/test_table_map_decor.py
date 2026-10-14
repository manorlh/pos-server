"""
The decor symbols on the tables map ("סמלים": restrooms, the entrance, the exit, the bar, a
DJ booth, plants… — specs/table-map-decor.md; schema 3: service, guests, atmosphere, safety,
greenery, the arrow and coloured areas — P:/specs/table-map-decor-v3.md): a zone's sketch, in
the zone's canvas units.

The golden layout (`fixtures/table_map_decor_golden.json`) is shared with pos-android
(`app/src/test/resources/`, the same bytes; TableMapDecorTest pins the same SHA-256): it is
what a till receives — a map zone whose sketch carries every kind and variant of schema 2
(zone 0, unchanged since), a second one with every kind, variant and area of schema 3 (zone 1),
and their tables. What is pinned here, and how it could look fine while doing damage:

* the dashboard's save stores the sketch exactly as the golden file has it, and the till's
  state carries it unchanged — the till parses the very same bytes;
* a variant is checked against its kind (a restroom for men, a U bar, a plain exit, a beer bar,
  the staff entrance, a large plant); an area's fill, opacity and polygon; a symbol's colour;
* a till from before a schema that saves its plan cannot erase what it never knew: a
  schema-1 designer drops a DJ booth and flattens a U bar / a men's restroom / a plain exit,
  a schema-2 one drops a coffee station, a tree or an area and flattens a cocktail bar / the
  main entrance / a large plant — the cloud keeps them. A till of the current schema saves
  what it sends.
* decor is never a table: the state's tables are the zones' tables only.
* "מקרא ותצוגה" (§3): `mapDecor`, `mapLegend`, `mapSymbolLabels`, `mapSymbolScale` — till
  parameters with the owner's defaults, per level, in the till's payload, refused when the till
  could not parse them, and on the tables page's card.
"""
from __future__ import annotations

import copy
import hashlib
import json
import uuid
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.routers import tables as R
from app.schemas.tables import (
    SKETCH_FIELD_SINCE,
    SKETCH_KIND_SINCE,
    SKETCH_KINDS,
    SKETCH_KINDS_3,
    SKETCH_SCHEMA,
    SKETCH_VARIANT_SINCE,
    SKETCH_VARIANTS,
    SketchIn,
    TableCreate,
    TillLayoutIn,
    ZoneCreate,
    ZoneUpdate,
)
from app.services import table_map_display as MD
from app.services import tables as T
from app.services import till_parameters as TPAR
from app.services.permissions import Scope
from test_tables import ctx, run, w  # noqa: F401  (w: the tables world fixture)

GOLDEN = Path(__file__).parent / "fixtures" / "table_map_decor_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: TableMapDecorTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "8ac0b871bcd954ffecbdaa5f00f2688e96142288d3025b5866a9b61eab6d7c76"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name

#: The kinds drawn with the drawing tools: not decor symbols, not in the golden layout.
DRAWN = {"line", "polyline", "freehand", "rect"}


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def golden() -> dict:
    return json.loads(_text(GOLDEN))


def golden_sketch() -> dict:
    """Zone 0: every kind and variant of schema 2."""
    return golden()["zones"][0]["sketch"]


def golden_sketch_3() -> dict:
    """Zone 1: every kind, variant and area of schema 3."""
    return golden()["zones"][1]["sketch"]


def golden_sketch_4() -> dict:
    """Zone 2: schema 4's styled texts and logos (P:/specs/table-map-decor-v3.md §8)."""
    return golden()["zones"][2]["sketch"]


def as_old_till_sends(sketch: dict) -> dict:
    """The plan as a till's designer before schema 2 saves it (TableSketch.kt sanitized + elementJson)."""
    out = copy.deepcopy(sketch)
    elements = []
    for e in out["elements"]:
        if SKETCH_KIND_SINCE.get(e["kind"], 1) > 1:
            continue  # not in its SketchKinds.ALL (a DJ booth; any schema-3 kind): dropped
        if e["kind"] == "counter":
            e["variant"] = "L" if e.get("variant") == "L" else "straight"
        else:
            e.pop("variant", None)  # only a counter's variant is written
        elements.append(e)
    out["elements"] = elements
    return out


def as_schema_2_till_sends(sketch: dict) -> dict:
    """
    The plan as a schema-2 till's designer saves it (pos-android TableSketch.kt as merged for
    schema 2: `sanitized` keeps the kinds of SketchKinds.ALL — up to the DJ booth — and `variantOf`
    the variants of its VARIANTS — counter, restroom, exit; its colour, any kind's; fill and
    opacity it never knew).
    """
    out = copy.deepcopy(sketch)
    elements = []
    for e in out["elements"]:
        if SKETCH_KIND_SINCE.get(e["kind"], 1) > 2:
            continue
        if e["kind"] in ("bar", "door", "plant"):
            e.pop("variant", None)
        elements.append(e)
    out["elements"] = elements
    return out


def save_from_till(w, body: dict):
    till = w.a
    actor = R.require_catalog_authority(Scope.CATALOG_WRITE)(
        machine=till, elevation_token=None, operator_id=str(w.manager.id), db=w.db,
    )
    tasks = BackgroundTasks()
    out = R.save_till_layout(str(till.id), TillLayoutIn.model_validate(body), tasks, machine=till, actor=actor, db=w.db)
    run(tasks)
    return out


def stored(w) -> dict:
    return json.loads(json.dumps(w.db.get(type(w.hall), w.hall.id).sketch))


def by_id(sketch: dict) -> dict:
    return {e["id"]: e for e in sketch["elements"]}


# ── The golden layout ─────────────────────────────────────────────────────────


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    assert _text(SIBLING) == _text(GOLDEN)


def test_the_fixture_has_every_kind_and_variant_of_the_decor():
    sketch = golden_sketch()
    kinds = {e["kind"] for e in sketch["elements"]}
    assert {"restroom", "door", "exit", "counter", "dj_booth", "plant", "wall", "kitchen", "stairs", "cashier", "label"} <= kinds
    # Zone 0 is schema 2 as it was; zone 1 adds every kind of schema 3.
    assert all(SKETCH_KIND_SINCE.get(k, 1) <= 2 for k in kinds)
    kinds_3 = {e["kind"] for e in golden_sketch_3()["elements"]}
    assert set(SKETCH_KINDS_3) <= kinds_3
    every = [e for z in golden()["zones"] for e in z["sketch"]["elements"]]
    assert {e["kind"] for e in every} <= set(SKETCH_KINDS)
    assert {e["kind"] for e in every} >= set(SKETCH_KINDS) - DRAWN - {"window", "column", "host", "stage", "sofa", "logo"}
    variants = {(e["kind"], e.get("variant")) for e in every}
    for kind, allowed in SKETCH_VARIANTS.items():
        for v in allowed:
            if (kind, v) != ("counter", "straight"):
                assert (kind, v) in variants, (kind, v)
    # An area as a rectangle and as a polygon; a symbol in a colour of its own.
    areas = [e for e in every if e["kind"] == "area"]
    assert any("points" in a for a in areas) and any("points" not in a for a in areas)
    assert any(e.get("color") and e["kind"] in SKETCH_KINDS_3 for e in every)
    # Zones 0 and 1 have none of schema 4's fields; zone 2 has every one of them (§8).
    for z in golden()["zones"][:2]:
        for e in z["sketch"]["elements"]:
            assert not set(SKETCH_FIELD_SINCE.get(e["kind"], {})) & set(e), e["id"]
    styled = golden_sketch_4()["elements"]
    for kind, fields in SKETCH_FIELD_SINCE.items():
        have = {f for e in styled if e["kind"] == kind for f in e}
        assert set(fields) <= have, kind
    assert SKETCH_SCHEMA == 4


@pytest.mark.parametrize("which", [0, 1, 2])
def test_the_dashboard_stores_the_decor_exactly_as_the_golden_layout_has_it(w, which):
    zone_golden = golden()["zones"][which]
    sketch = zone_golden["sketch"]
    assert T.sketch_json(SketchIn.model_validate(sketch)) == sketch
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({
        "sketch": sketch, "canvasWidth": zone_golden["canvasWidth"], "canvasHeight": zone_golden["canvasHeight"],
    }), BackgroundTasks(), **ctx(w))
    assert stored(w) == sketch
    # The dashboard's layout and the till's state carry it unchanged.
    zone = next(z for z in R.get_layout(w.shop.id, **ctx(w))["zones"] if z["id"] == str(w.hall.id))
    assert zone["sketch"] == sketch
    state = T.till_state(w.db, w.a)
    zone = next(z for z in state["zones"] if z["id"] == str(w.hall.id))
    assert json.loads(json.dumps(zone["sketch"])) == sketch
    assert (zone["canvasWidth"], zone["canvasHeight"]) == (zone_golden["canvasWidth"], zone_golden["canvasHeight"])


def test_decor_is_never_a_table(w):
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": golden_sketch()}), BackgroundTasks(), **ctx(w))
    garden = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name="גינה ומרפסת", layout="map"))
    w.db.commit()
    R.update_zone(garden.id, ZoneUpdate.model_validate({"sketch": golden_sketch_3()}), BackgroundTasks(), **ctx(w))
    for t in golden()["tables"]:
        T.create_table(w.db, w.hall, TableCreate(
            zoneId=w.hall.id, number=100 + t["number"], seats=t["seats"], shape=t["shape"],
            x=t["x"], y=t["y"], width=t["width"], height=t["height"],
        ))
    w.db.commit()
    state = T.till_state(w.db, w.a)
    hall = [t for t in state["tables"] if t["zoneId"] == str(w.hall.id)]
    # The world's four tables and the golden six — not one of the 65 shapes.
    assert len(hall) == 4 + len(golden()["tables"]) == 10
    assert not [t for t in state["tables"] if t["zoneId"] == str(garden.id)]
    assert len(next(z for z in state["zones"] if z["id"] == str(garden.id))["sketch"]["elements"]) == 39
    ids = {e["id"] for z in golden()["zones"] for e in z["sketch"]["elements"]}
    assert len(ids) == 65
    assert not ids & {t["id"] for t in state["tables"]}


# ── Variants ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind, variant", [
    ("counter", "men"), ("restroom", "U"), ("restroom", "plain"), ("exit", "women"), ("exit", "L"),
    # Schema 3: a bar pours cocktails, beer or wine; an entrance is the main, a side or the staff's;
    # a plant is large or small — and none of them takes another kind's.
    ("bar", "U"), ("bar", "main"), ("bar", "large"), ("door", "cocktail"), ("door", "plain"), ("door", "small"),
    ("plant", "beer"), ("plant", "side"), ("plant", "men"), ("restroom", "wine"), ("counter", "staff"), ("exit", "main"),
])
def test_a_variant_belongs_to_its_kind(kind, variant):
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "e", "kind": kind, "x": 0, "y": 0, "w": 10, "h": 10, "variant": variant}]})


def test_an_unheard_of_variant_is_refused_on_any_kind():
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "e", "kind": "tree", "x": 0, "y": 0, "w": 10, "h": 10, "variant": "oak"}]})


@pytest.mark.parametrize("kind, variants", sorted((k, v) for k, v in SKETCH_VARIANTS.items() if k in ("bar", "door", "plant")))
def test_the_schema_3_variants_are_kept_on_their_kind(kind, variants):
    s = SketchIn.model_validate({"elements": [
        {"id": f"e{i}", "kind": kind, "x": 0, "y": 0, "w": 10, "h": 10, "variant": v} for i, v in enumerate(variants)
    ] + [{"id": "none", "kind": kind, "x": 0, "y": 0, "w": 10, "h": 10}]})
    out = T.sketch_json(s)["elements"]
    assert [e.get("variant") for e in out] == [*variants, None]
    assert "variant" not in out[-1]  # none: the kind's own sign ("בר", "כניסה", the usual pot)


def test_a_variant_on_a_kind_without_any_is_not_kept():
    s = SketchIn.model_validate({"elements": [
        {"id": "w", "kind": "wall", "x": 0, "y": 0, "w": 10, "h": 10, "variant": "U"},
        {"id": "r", "kind": "restroom", "x": 0, "y": 0, "w": 10, "h": 10},
        {"id": "c", "kind": "counter", "x": 0, "y": 0, "w": 10, "h": 10},
        {"id": "t", "kind": "tree", "x": 0, "y": 0, "w": 10, "h": 10, "variant": "large"},
        {"id": "a", "kind": "area", "x": 0, "y": 0, "w": 10, "h": 10, "variant": "main"},
    ]})
    out = by_id(T.sketch_json(s))
    assert "variant" not in out["w"] and "variant" not in out["r"]
    assert "variant" not in out["t"] and "variant" not in out["a"]
    assert (out["c"]["variant"], out["c"]["stools"]) == ("straight", 0)


def test_an_unknown_kind_is_still_refused():
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "x", "kind": "pool", "x": 0, "y": 0, "w": 1, "h": 1}]})


# ── Schema 3: the new symbols, areas and colours (v3 §1, §2, §4) ──────────────


@pytest.mark.parametrize("kind", SKETCH_KINDS_3)
def test_each_new_kind_is_saved_and_reaches_the_till(w, kind):
    el = {"id": "k1", "kind": kind, "x": 100, "y": 120, "w": 90, "h": 70, "rotation": 270 if kind != "arrow" else 135}
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": {"elements": [el]}}), BackgroundTasks(), **ctx(w))
    got = T.till_state(w.db, w.a)["zones"][0]["sketch"]["elements"]
    assert [(e["kind"], e["rotation"], e["x"], e["w"]) for e in got] == [(kind, el["rotation"], 100, 90)]
    assert SKETCH_KIND_SINCE[kind] == 3


def test_every_new_kind_is_known_to_the_model_and_the_schema_alike():
    from app.models.tables import SKETCH_KINDS as MODEL_KINDS

    assert tuple(MODEL_KINDS) == tuple(SKETCH_KINDS)
    assert len(SKETCH_KINDS_3) == len(set(SKETCH_KINDS_3)) == 30
    assert not set(SKETCH_KINDS_3) & set(SKETCH_KINDS[: -len(SKETCH_KINDS_3)])
    assert {k for (k, _v), s in SKETCH_VARIANT_SINCE.items() if s == 3} == {"bar", "door", "plant"}


def area(**extra) -> dict:
    return {"id": "a1", "kind": "area", "x": 20, "y": 30, "w": 300, "h": 200, "text": "מרפסת", **extra}


def test_an_area_keeps_its_fill_opacity_and_polygon():
    polygon = [20, 30, 320, 30, 320, 230, 120, 230.04]
    out = T.sketch_json(SketchIn.model_validate({"elements": [
        area(fill="#8B5CF6", opacity=45, points=polygon, color="#5B21B6"),
    ]}))["elements"][0]
    assert (out["fill"], out["opacity"], out["color"], out["text"]) == ("#8b5cf6", 45, "#5b21b6", "מרפסת")
    assert out["points"] == [20, 30, 320, 30, 320, 230, 120, 230.0]


def test_an_area_without_a_fill_or_an_opacity_gets_the_defaults_stored():
    out = T.sketch_json(SketchIn.model_validate({"elements": [area()]}))["elements"][0]
    assert (out["fill"], out["opacity"]) == ("#22c55e", 30)
    assert "points" not in out  # a rectangle: its box


@pytest.mark.parametrize("extra", [
    dict(opacity=9), dict(opacity=61), dict(opacity=30.5), dict(fill="green"), dict(fill="#12345"),
    dict(points=[0, 0, 10, 10]),  # two corners: not a polygon
    dict(points=[0, 0, 10, 10, 20]),  # odd
    dict(color="blue"),
])
def test_an_area_out_of_bounds_is_refused(extra):
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [area(**extra)]})


@pytest.mark.parametrize("opacity", [10, 60])
def test_an_area_s_opacity_is_ten_to_sixty_percent(opacity):
    out = T.sketch_json(SketchIn.model_validate({"elements": [area(opacity=opacity)]}))["elements"][0]
    assert out["opacity"] == opacity


def test_fill_and_opacity_are_an_area_s_only():
    out = T.sketch_json(SketchIn.model_validate({"elements": [
        {"id": "t", "kind": "tree", "x": 0, "y": 0, "w": 50, "h": 50, "fill": "#22c55e", "opacity": 40},
    ]}))["elements"][0]
    assert "fill" not in out and "opacity" not in out


def test_a_symbol_keeps_a_colour_of_its_own_and_none_is_the_theme_s():
    out = by_id(T.sketch_json(SketchIn.model_validate({"elements": [
        {"id": "c", "kind": "coffee_station", "x": 0, "y": 0, "w": 80, "h": 60, "color": "#DB2777"},
        {"id": "r", "kind": "restroom", "x": 0, "y": 0, "w": 80, "h": 60, "color": "#2563eb", "variant": "women"},
        {"id": "p", "kind": "parking", "x": 0, "y": 0, "w": 80, "h": 60},
    ]})))
    assert out["c"]["color"] == "#db2777" and out["r"]["color"] == "#2563eb"
    assert "color" not in out["p"]
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "c", "kind": "heater", "x": 0, "y": 0, "w": 1, "h": 1, "color": "#red"}]})


def test_an_arrow_points_any_way():
    for rotation in (0, 1, 135, 359):
        el = {"id": "a", "kind": "arrow", "x": 0, "y": 0, "w": 100, "h": 30, "rotation": rotation}
        assert T.sketch_json(SketchIn.model_validate({"elements": [el]}))["elements"][0]["rotation"] == rotation
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "a", "kind": "arrow", "x": 0, "y": 0, "w": 1, "h": 1, "rotation": 360}]})


# ── Tills from before the decor symbols ──────────────────────────────────────


def test_an_old_till_saving_its_plan_keeps_what_it_cannot_know(w):
    sketch = golden_sketch()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = as_old_till_sends(sketch)
    # The old designer moved the kitchen and the U bar; it never saw the DJ booths.
    for e in sent["elements"]:
        if e["id"] in ("dkit0001", "dbar0001"):
            e["x"] += 10
    assert "ddj00001" not in by_id(sent) and by_id(sent)["dbar0001"]["variant"] == "straight"
    save_from_till(w, {"zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = stored(w)
    expected = copy.deepcopy(sketch)
    for e in expected["elements"]:
        if e["id"] in ("dkit0001", "dbar0001"):
            e["x"] += 10
    # Everything as it was — the moves kept, the DJ booths after the till's own shapes (here
    # last already), the U bar a U, the restrooms whose they were, the plain exit plain.
    assert after == expected
    assert [e["id"] for e in after["elements"]] == [e["id"] for e in sketch["elements"]]


def test_an_old_till_may_still_change_a_variant_it_knows_and_remove_what_it_shows(w):
    sketch = golden_sketch()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = as_old_till_sends(sketch)
    by_id(sent)["dbar0001"]["variant"] = "L"  # chosen on its own chips
    sent["elements"] = [e for e in sent["elements"] if e["id"] not in ("dpl00001", "dwc00002")]
    save_from_till(w, {"zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = by_id(stored(w))
    assert after["dbar0001"]["variant"] == "L"
    assert "dpl00001" not in after and "dwc00002" not in after  # shapes it knows: its to remove
    assert {"ddj00001", "ddj00002"} <= set(after)
    assert after["dwc00003"]["variant"] == "women"


def test_an_old_till_clearing_the_plan_clears_it(w):
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": golden_sketch()}), BackgroundTasks(), **ctx(w))
    save_from_till(w, {"zones": [{"id": str(w.hall.id), "sketch": None}]})
    assert w.db.get(type(w.hall), w.hall.id).sketch is None


def test_a_till_of_schema_2_saves_what_it_sends(w):
    sketch = golden_sketch()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = copy.deepcopy(sketch)
    sent["elements"] = [e for e in sent["elements"] if e["id"] != "ddj00001"]
    by_id(sent)["dbar0001"]["variant"] = "straight"
    by_id(sent)["dwc00002"].pop("variant")
    save_from_till(w, {"sketchSchema": 2, "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = stored(w)
    assert after == sent
    assert "ddj00001" not in by_id(after)


def golden_both() -> dict:
    """Both golden plans in one zone's sketch (zone 0's shapes, then zone 1's)."""
    return {**golden_sketch(), "elements": golden_sketch()["elements"] + golden_sketch_3()["elements"]}


@pytest.mark.parametrize("schema", [None, 2])
def test_a_schema_2_or_older_till_saving_its_plan_keeps_the_schema_3_decor(w, schema):
    sketch = golden_both()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = as_schema_2_till_sends(sketch) if schema == 2 else as_old_till_sends(sketch)
    # It never saw the coffee station, the tree or the areas; it moved the kitchen and the beer bar.
    assert "gcf00001" not in by_id(sent) and "gare0001" not in by_id(sent) and "gtre0001" not in by_id(sent)
    assert "variant" not in by_id(sent)["gbrb0001"] and "variant" not in by_id(sent)["gdrm0001"]
    for e in sent["elements"]:
        if e["id"] in ("dkit0001", "gbrb0001"):
            e["x"] += 10
    save_from_till(w, {**({"sketchSchema": schema} if schema else {}), "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = stored(w)
    expected = copy.deepcopy(sketch)
    for e in expected["elements"]:
        if e["id"] in ("dkit0001", "gbrb0001"):
            e["x"] += 10
    # Everything as it was: the moves kept, the beer bar still beer, the main entrance still main,
    # the large plant large, the areas with their fill and polygon, the coloured symbols coloured.
    assert by_id(after) == by_id(expected)
    # What it left out comes after its own shapes, in the plan's order.
    known = [e["id"] for e in sent["elements"]]
    assert [e["id"] for e in after["elements"]][: len(known)] == known
    assert set(e["id"] for e in after["elements"]) == set(e["id"] for e in sketch["elements"])


def test_a_schema_2_till_may_change_and_remove_what_it_shows(w):
    sketch = golden_both()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = as_schema_2_till_sends(sketch)
    # A men's restroom made women's on its chips (schema 2 knows it); a bar and a plant removed.
    by_id(sent)["dwc00002"]["variant"] = "women"
    sent["elements"] = [e for e in sent["elements"] if e["id"] not in ("gbrw0001", "gplS0001", "ddj00001")]
    save_from_till(w, {"sketchSchema": 2, "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = by_id(stored(w))
    assert after["dwc00002"]["variant"] == "women"
    # Shapes it shows are its to remove (the wine bar, the small plant, a DJ booth — schema 2 has them).
    assert not {"gbrw0001", "gplS0001", "ddj00001"} & set(after)
    # What it cannot show stays, as it was.
    assert after["gbrc0001"]["variant"] == "cocktail" and after["gplL0001"]["variant"] == "large"
    assert after["gare0002"]["points"] == by_id(sketch)["gare0002"]["points"]


def test_a_till_of_schema_3_saves_what_it_sends(w):
    sketch = golden_both()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = copy.deepcopy(sketch)
    sent["elements"] = [e for e in sent["elements"] if e["id"] not in ("gcf00001", "gare0001")]
    by_id(sent)["gbrb0001"].pop("variant")
    by_id(sent)["gplL0001"].pop("variant")
    by_id(sent)["gkd00001"].pop("color")
    save_from_till(w, {"sketchSchema": 3, "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = stored(w)
    # Nothing of schema 4 in these plans: a schema-3 till's save is what it sent.
    assert after == sent
    assert SKETCH_SCHEMA == 4


def test_an_old_till_s_new_zone_and_floor_change_are_untouched(w):
    sketch = golden_sketch()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    # A floor only (no plan sent): the plan stays whole, the floor changes.
    save_from_till(w, {"zones": [{"id": str(w.hall.id), "background": "wood"}]})
    after = stored(w)
    assert after["background"] == "wood" and after["elements"] == sketch["elements"]
    # A new zone from an old till: nothing to keep from.
    out = save_from_till(w, {"zones": [{"clientId": "n", "name": "מרפסת", "sketch": as_old_till_sends(sketch)}]})
    z = next(z for z in out["zones"] if z["name"] == "מרפסת")
    assert "ddj00001" not in by_id(z["sketch"])


def test_keep_decor_unknown_to_till_only_restores_the_old_designer_s_own_word():
    before = {"elements": [
        {"id": "c", "kind": "counter", "variant": "U"},
        {"id": "r", "kind": "restroom", "variant": "men"},
        {"id": "x", "kind": "exit", "variant": "plain"},
        {"id": "d", "kind": "dj_booth"},
        {"id": "p", "kind": "plant"},
    ]}
    saved = {"template": None, "background": None, "elements": [
        {"id": "c", "kind": "counter", "variant": "straight"},
        {"id": "r", "kind": "restroom"},
        {"id": "x", "kind": "door"},  # the same id, another kind now: left as sent
    ]}
    out = T.keep_decor_unknown_to_till(before, saved, 1)
    assert out["elements"] == [
        {"id": "c", "kind": "counter", "variant": "U"},
        {"id": "r", "kind": "restroom", "variant": "men"},
        {"id": "x", "kind": "door"},
        {"id": "d", "kind": "dj_booth"},
    ]
    # A till of the current schema: nothing to keep for it.
    assert T.keep_decor_unknown_to_till(before, saved, SKETCH_SCHEMA)["elements"] == saved["elements"]
    assert T.keep_decor_unknown_to_till(None, saved) is saved
    assert T.keep_decor_unknown_to_till(before, None) is None


def test_keep_decor_unknown_to_a_schema_2_till():
    before = {"elements": [
        {"id": "b", "kind": "bar", "variant": "beer"},
        {"id": "d", "kind": "door", "variant": "staff"},
        {"id": "p", "kind": "plant", "variant": "small"},
        {"id": "u", "kind": "counter", "variant": "U"},
        {"id": "a", "kind": "area", "fill": "#22c55e", "opacity": 30},
        {"id": "t", "kind": "tree", "color": "#166534"},
        {"id": "j", "kind": "dj_booth"},
        {"id": "k", "kind": "kids_corner"},
    ]}
    saved = {"template": None, "background": None, "elements": [
        {"id": "b", "kind": "bar"},
        {"id": "d", "kind": "door", "variant": "staff"},  # nothing to restore: sent as it was
        {"id": "p", "kind": "plant"},
        {"id": "u", "kind": "counter", "variant": "straight"},  # schema 2 knows U: its own choice
        {"id": "k", "kind": "label"},  # the same id, another kind: left as sent
    ]}
    out = T.keep_decor_unknown_to_till(before, saved, 2)
    assert out["elements"] == [
        {"id": "b", "kind": "bar", "variant": "beer"},
        {"id": "d", "kind": "door", "variant": "staff"},
        {"id": "p", "kind": "plant", "variant": "small"},
        {"id": "u", "kind": "counter", "variant": "straight"},
        {"id": "k", "kind": "label"},
        {"id": "a", "kind": "area", "fill": "#22c55e", "opacity": 30},
        {"id": "t", "kind": "tree", "color": "#166534"},
    ]
    # The DJ booth is schema 2's: removed by it, removed.
    assert "j" not in by_id(out)


# ── "מקרא ותצוגה": the till parameters (v3 §3) ────────────────────────────────

MAP_DEFAULTS = {"mapDecor": "full", "mapLegend": "button", "mapSymbolLabels": "auto", "mapSymbolScale": 100}


def _put_level(w, scope_type, scope_id, values):
    from app.routers import table_restore as RR

    body = RR.TableRestoreParamsIn(scopeType=scope_type, scopeId=scope_id, values=values)
    return RR.put_table_restore_params(str(w.company.id), body, **ctx(w))


def _synced(w, till) -> dict:
    from app.routers.sync import get_till_parameters_sync

    return get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db).parameters


class TestMapDisplayParameters:
    def test_built_in_with_the_owner_s_defaults_and_every_till_gets_them(self, w):
        specs = {p.key: p for p in TPAR.BUILTIN_PARAMETERS}
        for key, default in MAP_DEFAULTS.items():
            assert specs[key].default_value == default, key
            assert specs[key].label and specs[key].description and not specs[key].admin_only, key
        assert MD.LEVEL_KEYS == tuple(MAP_DEFAULTS)
        assert specs["mapDecor"].enum_options == ("full", "symbols", "off")
        assert specs["mapLegend"].enum_options == ("off", "button", "always")
        assert specs["mapSymbolLabels"].enum_options == ("auto", "always", "never")
        assert specs["mapSymbolScale"].value_type == "integer"
        assert TPAR.enum_labels("mapDecor")["symbols"] == "רק סמלים, בלי מבנה"
        assert set(TPAR.enum_labels("mapLegend")) == {"off", "button", "always"}
        # In the till's parameters payload (`GET /sync/{machine}/parameters` → `parameters`).
        for till in (w.a, w.b):
            got = _synced(w, till)
            assert {k: got[k] for k in MAP_DEFAULTS} == MAP_DEFAULTS

    def test_levels_company_shop_area_till(self, w):
        from app.models.shop_area import ShopArea

        area_ = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="מרפסת")
        w.db.add(area_)
        w.db.flush()
        w.b.area_id = area_.id
        w.db.commit()
        _put_level(w, "company", w.company.id, {"mapDecor": "symbols", "mapSymbolScale": 120})
        _put_level(w, "shop", w.shop.id, {"mapLegend": "always"})
        _put_level(w, "area", area_.id, {"mapSymbolLabels": "never", "mapSymbolScale": 80})
        view = _put_level(w, "machine", w.a.id, {"mapDecor": "off"})
        assert view["own"] == {"mapDecor": "off"} and view["inherited"]["mapDecor"] == "symbols"
        a, b = _synced(w, w.a), _synced(w, w.b)
        assert (a["mapDecor"], a["mapLegend"], a["mapSymbolLabels"], a["mapSymbolScale"]) == ("off", "always", "auto", 120)
        assert (b["mapDecor"], b["mapLegend"], b["mapSymbolLabels"], b["mapSymbolScale"]) == ("symbols", "always", "never", 80)
        # Cleared at the till: the company's again.
        _put_level(w, "machine", w.a.id, {"mapDecor": None})
        assert _synced(w, w.a)["mapDecor"] == "symbols"

    @pytest.mark.parametrize("key, value, stored", [
        ("mapDecor", "symbols", "symbols"), ("mapLegend", "off", "off"), ("mapSymbolLabels", "always", "always"),
        ("mapSymbolScale", 70, 70), ("mapSymbolScale", 150, 150), ("mapSymbolScale", 110.0, 110),
    ])
    def test_values_the_till_parses(self, key, value, stored):
        assert TPAR.validate_keyed_value(key, value) == stored

    @pytest.mark.parametrize("key, value", [
        ("mapDecor", "walls"), ("mapDecor", "Full"), ("mapLegend", "sometimes"), ("mapSymbolLabels", "auto "),
        ("mapSymbolScale", 69), ("mapSymbolScale", 151), ("mapSymbolScale", 100.5), ("mapSymbolScale", "100"),
        ("mapSymbolScale", True),
    ])
    def test_a_value_the_till_cannot_parse_is_refused(self, w, key, value):
        with pytest.raises(TPAR.TillParameterValueError):
            TPAR.validate_keyed_value(key, value)
        with pytest.raises(HTTPException) as e:
            _put_level(w, "company", w.company.id, {key: value})
        assert e.value.status_code == 422

    def test_on_the_tables_page_card_in_a_group_of_their_own_after_restore(self, w):
        from app.routers import table_restore as RR

        got = RR.get_table_restore_params(str(w.company.id), scope_type="shop", scope_id=w.shop.id, **ctx(w))
        # After restoring and the payments; then the waiters' assignment (P:/specs/table-waiter-assignment.md),
        # the courses' auto-fire (P:/specs/courses-fire-v2.md §1), and last "מתי עיקריות?" / scheduled items
        # (P:/specs/fire-restaurant-flow.md §8.1).
        assert [g["key"] for g in got["groups"]] == ["staffTables", "restore", "mapDisplay", "waiters", "courses", "fireFlow"]
        mine = [p for p in got["parameters"] if p["group"] == "mapDisplay"]
        assert [p["key"] for p in mine] == list(MAP_DEFAULTS)
        assert [p["key"] for p in got["parameters"]][-21:-17] == list(MAP_DEFAULTS)
        by_key = {p["key"]: p for p in mine}
        assert by_key["mapDecor"]["enumLabels"]["full"] and by_key["mapSymbolScale"]["valueType"] == "integer"
        assert {k: got["inherited"][k] for k in MAP_DEFAULTS} == MAP_DEFAULTS

    def test_symbols_leave_out_the_room_s_frame_only(self):
        assert set(MD.STRUCTURE_KINDS) == {"wall", "window", "column", "sofa", "logo", "line", "polyline", "freehand", "rect"}
        assert set(MD.STRUCTURE_KINDS) <= set(SKETCH_KINDS)
        assert not set(MD.STRUCTURE_KINDS) & set(SKETCH_KINDS_3)


# ── "טקסט ולוגו" (schema 4, §8) ──────────────────────────────────────────────


def label(**extra) -> dict:
    return {"id": "l1", "kind": "label", "x": 10, "y": 10, "w": 300, "h": 60, "text": "ברוכים הבאים", **extra}


def logo(**extra) -> dict:
    return {"id": "g1", "kind": "logo", "x": 10, "y": 10, "w": 160, "h": 120, **extra}


def one(el: dict) -> dict:
    return T.sketch_json(SketchIn.model_validate({"elements": [el]}))["elements"][0]


@pytest.mark.parametrize("size", ["s", "m", "l", "xl", 10, 24, 72, 30.0])
def test_a_text_s_size_is_a_name_or_ten_to_seventy_two(size):
    out = one(label(fontSize=size))
    assert out["fontSize"] == (int(size) if isinstance(size, float) else size)


def test_a_text_s_style_is_kept_and_only_what_differs():
    out = one(label(fontSize="xl", bold=True, color="#1E293B", bg="#FEF3C7", bgOpacity=85, align="right", rotation=30))
    assert {k: out[k] for k in ("fontSize", "bold", "color", "bg", "bgOpacity", "align", "rotation")} == {
        "fontSize": "xl", "bold": True, "color": "#1e293b", "bg": "#fef3c7", "bgOpacity": 85, "align": "right", "rotation": 30,
    }
    # A chip with no opacity: a whole one; centred, regular, no size: nothing stored.
    plain = one(label(bg="#ffffff", align="center", bold=False))
    assert plain["bgOpacity"] == 100 and plain["bg"] == "#ffffff"
    assert not {"align", "bold", "fontSize"} & set(plain)
    # An opacity with no chip: nothing.
    assert not {"bg", "bgOpacity"} & set(one(label(bgOpacity=50)))
    # A text as before §8: exactly as it was stored.
    assert one(label(color="#2563eb")) == {
        "id": "l1", "kind": "label", "x": 10, "y": 10, "w": 300, "h": 60, "rotation": 0, "text": "ברוכים הבאים", "color": "#2563eb",
    }


def test_a_text_takes_several_lines_up_to_two_hundred_characters():
    text = "שעות פתיחה\r\nא׳–ה׳ 12:00–23:00\rו׳ 10:00–15:00"
    assert one(label(text=text))["text"] == "שעות פתיחה\nא׳–ה׳ 12:00–23:00\nו׳ 10:00–15:00"
    assert len(one(label(text="א" * 200))["text"]) == 200
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [label(text="א" * 201)]})
    # Any other kind: 60, as before.
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "b", "kind": "bar", "x": 0, "y": 0, "w": 9, "h": 9, "text": "א" * 61}]})
    assert one({"id": "b", "kind": "bar", "x": 0, "y": 0, "w": 9, "h": 9, "text": "א" * 60})["text"] == "א" * 60


@pytest.mark.parametrize("extra", [
    dict(fontSize="xxl"), dict(fontSize="M"), dict(fontSize=9), dict(fontSize=73), dict(fontSize=20.5),
    dict(fontSize=True), dict(fontSize="20"), dict(bg="yellow"), dict(bg="#fff"), dict(bgOpacity=9),
    dict(bgOpacity=101), dict(align="justify"), dict(align="start"), dict(rotation=360),
])
def test_a_text_s_style_out_of_bounds_is_refused(extra):
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [label(**extra)]})


def test_the_style_of_a_text_is_a_text_s_only():
    out = one({"id": "c", "kind": "coffee_station", "x": 0, "y": 0, "w": 80, "h": 60,
               "fontSize": "xl", "bold": True, "bg": "#ffffff", "bgOpacity": 50, "align": "left", "keepAspect": False, "source": "image"})
    assert not {"fontSize", "bold", "bg", "bgOpacity", "align", "keepAspect", "source"} & set(out)


def test_a_logo_s_source_opacity_and_stretch():
    url = "https://media.example.com/uploads/logo.png"
    business = one(logo(source="business", src=url, opacity=60, rotation=15))
    # The business's: no picture of its own kept.
    assert (business["source"], business["opacity"], business["rotation"]) == ("business", 60, 15)
    assert "src" not in business
    image = one(logo(source="image", src=url, opacity=35, keepAspect=False))
    assert (image["source"], image["src"], image["opacity"], image["keepAspect"]) == ("image", url, 35, False)
    # As before §8: `src` decides; a whole opacity and a fitted picture are not stored.
    before = one(logo(src=url, opacity=100, keepAspect=True))
    assert before == {"id": "g1", "kind": "logo", "x": 10, "y": 10, "w": 160, "h": 120, "rotation": 0, "text": None, "src": url}
    assert one(logo())["kind"] == "logo" and "src" not in one(logo())


@pytest.mark.parametrize("extra", [
    dict(source="image"),  # an uploaded picture with no picture
    dict(source="brand"), dict(opacity=19), dict(opacity=101), dict(opacity=50.5),
    dict(src="ftp://x/logo.png"), dict(keepAspect="no"),
])
def test_a_logo_out_of_bounds_is_refused(extra):
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [logo(**extra)]})


def test_an_area_s_opacity_is_still_ten_to_sixty_and_a_logo_s_twenty_to_a_hundred():
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [area(opacity=70)]})
    assert one(logo(opacity=20))["opacity"] == 20
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [logo(opacity=10)]})


def as_schema_3_till_sends(sketch: dict) -> dict:
    """The plan as a schema-3 till's designer saves it: every kind and variant, none of §8's fields."""
    out = copy.deepcopy(sketch)
    for e in out["elements"]:
        for field in SKETCH_FIELD_SINCE.get(e["kind"], {}):
            e.pop(field, None)
    return out


@pytest.mark.parametrize("schema", [None, 2, 3])
def test_an_older_till_saving_its_plan_keeps_the_texts_and_logos_style(w, schema):
    sketch = golden_sketch_4()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = as_schema_3_till_sends(sketch)
    # It moved the welcome text and the business's logo.
    for e in sent["elements"]:
        if e["id"] in ("tlbl0001", "tlgo0001"):
            e["x"] += 10
    assert "fontSize" not in by_id(sent)["tlbl0001"] and "opacity" not in by_id(sent)["tlgo0001"]
    save_from_till(w, {**({"sketchSchema": schema} if schema else {}), "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    after = by_id(stored(w))
    expected = by_id(copy.deepcopy(sketch))
    for i in ("tlbl0001", "tlgo0001"):
        expected[i]["x"] += 10
    assert after == expected


def test_a_till_of_schema_4_saves_the_style_it_sends(w):
    sketch = golden_sketch_4()
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    sent = copy.deepcopy(sketch)
    by_id(sent)["tlbl0001"].pop("bold")
    by_id(sent)["tlbl0003"].pop("bg")
    by_id(sent)["tlbl0003"].pop("bgOpacity")
    by_id(sent)["tlgo0002"].pop("keepAspect")
    save_from_till(w, {"sketchSchema": 4, "zones": [{"id": str(w.hall.id), "sketch": sent}]})
    assert stored(w) == sent


def test_keep_decor_restores_a_style_field_only_on_the_same_kind():
    before = {"elements": [
        {"id": "l", "kind": "label", "text": "א", "fontSize": "xl", "bg": "#ffffff", "bgOpacity": 40},
        {"id": "g", "kind": "logo", "source": "business", "opacity": 50},
        {"id": "x", "kind": "label", "bold": True},
    ]}
    saved = {"template": None, "background": None, "elements": [
        {"id": "l", "kind": "label", "text": "ב", "bg": "#000000"},  # it sent a chip of its own: kept as sent
        {"id": "g", "kind": "logo"},
        {"id": "x", "kind": "tree"},  # another kind now: left as sent
    ]}
    out = by_id(T.keep_decor_unknown_to_till(before, saved, 3))
    assert out["l"] == {"id": "l", "kind": "label", "text": "ב", "bg": "#000000", "fontSize": "xl", "bgOpacity": 40}
    assert out["g"] == {"id": "g", "kind": "logo", "source": "business", "opacity": 50}
    assert out["x"] == {"id": "x", "kind": "tree"}
    # Schema 4: what it sent.
    assert T.keep_decor_unknown_to_till(before, saved, 4)["elements"] == saved["elements"]
