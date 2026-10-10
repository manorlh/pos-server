"""
The decor symbols on the tables map ("סמלים": restrooms, the entrance, the exit, the bar, a
DJ booth, plants… — specs/table-map-decor.md): a zone's sketch, in the zone's canvas units.

The golden layout (`fixtures/table_map_decor_golden.json`) is shared with pos-android
(`app/src/test/resources/`, the same bytes; TableMapDecorTest pins the same SHA-256): it is
what a till receives — a map zone whose sketch carries every kind and variant of schema 2,
and its tables. What is pinned here, and how it could look fine while doing damage:

* the dashboard's save stores the sketch exactly as the golden file has it, and the till's
  state carries it unchanged — the till parses the very same bytes;
* a variant is checked against its kind (a restroom for men, a U bar, a plain exit);
* a till from before schema 2 that saves its plan cannot erase what it never knew: its
  designer drops a DJ booth and flattens a U bar / a men's restroom / a plain exit — the
  cloud keeps them. A till that speaks schema 2 saves what it sends.
* decor is never a table: the state's tables are the zone's tables only.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.routers import tables as R
from app.schemas.tables import (
    SKETCH_KINDS,
    SKETCH_SCHEMA,
    SKETCH_VARIANTS,
    SketchIn,
    TableCreate,
    TillLayoutIn,
    ZoneUpdate,
)
from app.services import tables as T
from app.services.permissions import Scope
from test_tables import ctx, run, w  # noqa: F401  (w: the tables world fixture)

GOLDEN = Path(__file__).parent / "fixtures" / "table_map_decor_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: TableMapDecorTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "12a8484576012e282b6376165fe61ee1d1fe188439c31c15c0ff94b0ad8eaf44"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def golden() -> dict:
    return json.loads(_text(GOLDEN))


def golden_sketch() -> dict:
    return golden()["zones"][0]["sketch"]


def as_old_till_sends(sketch: dict) -> dict:
    """The plan as a till's designer before schema 2 saves it (TableSketch.kt sanitized + elementJson)."""
    out = copy.deepcopy(sketch)
    elements = []
    for e in out["elements"]:
        if e["kind"] == "dj_booth":
            continue  # not in its SketchKinds.ALL: dropped
        if e["kind"] == "counter":
            e["variant"] = "L" if e.get("variant") == "L" else "straight"
        else:
            e.pop("variant", None)  # only a counter's variant is written
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
    assert kinds <= set(SKETCH_KINDS)
    variants = {(e["kind"], e.get("variant")) for e in sketch["elements"]}
    for kind, allowed in SKETCH_VARIANTS.items():
        for v in allowed:
            if (kind, v) != ("counter", "straight"):
                assert (kind, v) in variants, (kind, v)
    assert SKETCH_SCHEMA == 2


def test_the_dashboard_stores_the_decor_exactly_as_the_golden_layout_has_it(w):
    sketch = golden_sketch()
    assert T.sketch_json(SketchIn.model_validate(sketch)) == sketch
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
    assert stored(w) == sketch
    # The dashboard's layout and the till's state carry it unchanged.
    zone = next(z for z in R.get_layout(w.shop.id, **ctx(w))["zones"] if z["id"] == str(w.hall.id))
    assert zone["sketch"] == sketch
    state = T.till_state(w.db, w.a)
    zone = next(z for z in state["zones"] if z["id"] == str(w.hall.id))
    assert json.loads(json.dumps(zone["sketch"])) == sketch
    assert (zone["canvasWidth"], zone["canvasHeight"]) == (1000, 700)


def test_decor_is_never_a_table(w):
    R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": golden_sketch()}), BackgroundTasks(), **ctx(w))
    for t in golden()["tables"]:
        T.create_table(w.db, w.hall, TableCreate(
            zoneId=w.hall.id, number=100 + t["number"], seats=t["seats"], shape=t["shape"],
            x=t["x"], y=t["y"], width=t["width"], height=t["height"],
        ))
    w.db.commit()
    state = T.till_state(w.db, w.a)
    hall = [t for t in state["tables"] if t["zoneId"] == str(w.hall.id)]
    # The world's four tables and the golden four — not one of the 19 shapes.
    assert len(hall) == 8
    ids = {e["id"] for e in golden_sketch()["elements"]}
    assert not ids & {t["id"] for t in state["tables"]}


# ── Variants ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind, variant", [
    ("counter", "men"), ("restroom", "U"), ("restroom", "plain"), ("exit", "women"), ("exit", "L"),
])
def test_a_variant_belongs_to_its_kind(kind, variant):
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "e", "kind": kind, "x": 0, "y": 0, "w": 10, "h": 10, "variant": variant}]})


def test_a_variant_on_a_kind_without_any_is_not_kept():
    s = SketchIn.model_validate({"elements": [
        {"id": "w", "kind": "wall", "x": 0, "y": 0, "w": 10, "h": 10, "variant": "U"},
        {"id": "r", "kind": "restroom", "x": 0, "y": 0, "w": 10, "h": 10},
        {"id": "c", "kind": "counter", "x": 0, "y": 0, "w": 10, "h": 10},
    ]})
    out = by_id(T.sketch_json(s))
    assert "variant" not in out["w"] and "variant" not in out["r"]
    assert (out["c"]["variant"], out["c"]["stools"]) == ("straight", 0)


def test_an_unknown_kind_is_still_refused():
    with pytest.raises(ValidationError):
        SketchIn.model_validate({"elements": [{"id": "x", "kind": "pool", "x": 0, "y": 0, "w": 1, "h": 1}]})


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
