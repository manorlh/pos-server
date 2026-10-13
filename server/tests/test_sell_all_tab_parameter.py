"""
"לשונית 'הכל' בקטלוג ההזמנה" — the till parameter `sellAllTab`.

The owner (13.10.2026): in an order, the catalog's category bar starts with a "הכל" tab showing every
product — let it be hidden or moved. A built-in enum the till reads: `first` (as today, the default),
`last`, `hidden` (no "הכל"; the order opens on the first category, and search still covers every
product). On every order screen with a category bar: phone, tablet, a table's order and the designed
templates. Set like every till parameter — company, shop, point of sale, till; the most specific wins —
each change in `till_parameter_changes`, and pulled with the others (`GET /sync/{machine_id}/parameters`,
`parameters.sellAllTab`). The dashboard shows each code's Hebrew (`enumLabels`).
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterUpdate, TillParameterValueIn
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "sellAllTab"
LABELS = {
    "first": "ראשונה — כמו היום",
    "last": "אחרונה",
    "hidden": "מוסתרת — נפתחת המחלקה הראשונה",
}


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _spec():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    return spec


def _definition(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    return out


def _clear(world, scope_type, scope_id):
    row = (
        world.db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == _definition(world).id,
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == scope_id,
        )
        .one()
    )
    tasks = BackgroundTasks()
    R.delete_till_parameter_value(
        parameter_id=_definition(world).id, value_id=row.id, background_tasks=tasks, _admin=_admin(), db=world.db,
    )
    _run(tasks)


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def _changes(world):
    return (
        world.db.query(TillParameterChange)
        .filter(TillParameterChange.parameter_key == KEY)
        .order_by(TillParameterChange.created_at)
        .all()
    )


# ── The definition ───────────────────────────────────────────────────────────


def test_a_builtin_enum_of_three_codes_first_by_default():
    spec = _spec()
    assert spec.label == "לשונית 'הכל' בקטלוג ההזמנה"
    assert spec.value_type == "enum"
    assert spec.enum_options == ("first", "last", "hidden") == TP.SELL_ALL_TAB_OPTIONS
    # As today: "הכל" first.
    assert spec.default_value == "first"
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(KEY) == 1
    assert TP.validate_key(KEY) == KEY


def test_each_code_has_its_hebrew_for_the_dashboard():
    assert _spec().enum_labels == LABELS
    assert TP.enum_labels(KEY) == LABELS
    # Only where the options are codes: a Hebrew-worded enum has none.
    assert TP.enum_labels("productTileSize") is None
    assert TP.enum_labels("noSuchKey") is None


def test_the_description_says_where_the_tab_sits_and_what_hidden_does():
    text = _spec().description
    assert "\"הכל\"" in text and "סרגל המחלקות" in text
    for where in ("בטלפון", "בטאבלט", "בהזמנת שולחן", "בתבניות המעוצבות"):
        assert where in text
    for label in LABELS.values():
        assert f"«{label}»" in text
    assert "(ברירת מחדל)" in text
    assert "ההזמנה נפתחת על המחלקה הראשונה" in text
    assert "החיפוש עדיין מחפש בכל המוצרים" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_it_is_edited_on_the_parameters_page():
    assert TP.managed_on(KEY) is None
    assert KEY not in TP.PRINTERS_PAGE_KEYS


def test_it_is_created_with_the_others_and_left_alone_afterwards(world):
    row = _definition(world)
    assert row.is_active and row.value_type == "enum"
    assert row.enum_options == ["first", "last", "hidden"]
    assert row.default_value == "first"
    assert row.label == "לשונית 'הכל' בקטלוג ההזמנה"

    row.label = "לשונית הכל"
    world.db.commit()
    assert KEY not in TP.ensure_builtin_parameters(world.db)
    assert _definition(world).label == "לשונית הכל"


def test_the_dashboard_list_carries_the_hebrew_of_each_code(world):
    rows = R.list_till_parameters(_admin=_admin(), db=world.db)
    (out,) = [r.model_dump(mode="json", by_alias=True) for r in rows if r.key == KEY]
    assert out["enumOptions"] == ["first", "last", "hidden"]
    assert out["enumLabels"] == LABELS
    assert out["defaultValue"] == "first"
    assert out["managedOn"] is None and out["adminOnly"] is False
    # Any other parameter: no labels.
    (other,) = [r.model_dump(mode="json", by_alias=True) for r in rows if r.key == "productTileSize"]
    assert other["enumLabels"] is None


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_till_gets_first_until_someone_sets_it(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == "first"


def test_the_most_specific_level_wins(world):
    t_area, t_shop = world.tills  # tills[0] is in the area, tills[1] straight under the shop

    _set(world, "company", world.company.id, "last")
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == "last"

    _set(world, "shop", world.shop.id, "hidden")
    assert _pulled(world, t_area) == "hidden" and _pulled(world, t_shop) == "hidden"
    assert _pulled(world, world.other_till) == "last"  # the other shop keeps the company's

    _set(world, "area", world.area.id, "first")
    assert _pulled(world, t_area) == "first"
    assert _pulled(world, t_shop) == "hidden"  # same shop, not in the area

    _set(world, "machine", t_area.id, "last")
    _set(world, "machine", t_shop.id, "first")
    assert _pulled(world, t_area) == "last" and _pulled(world, t_shop) == "first"

    # A level cleared inherits again.
    _clear(world, "machine", t_area.id)
    assert _pulled(world, t_area) == "first"  # the area's
    _clear(world, "area", world.area.id)
    assert _pulled(world, t_area) == "hidden"  # the shop's
    assert TP.till_parameters_for_machine(world.db, t_area).parameters[KEY] == "hidden"


def test_a_new_default_reaches_every_till_with_no_value_of_its_own(world):
    _set(world, "machine", world.tills[0].id, "first")
    R.update_till_parameter(
        parameter_id=_definition(world).id, body=TillParameterUpdate(defaultValue="hidden"),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
    )
    assert _pulled(world, world.tills[0]) == "first"
    assert _pulled(world, world.tills[1]) == "hidden"
    assert _pulled(world, world.other_till) == "hidden"


# ── Unknown values ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", ["middle", "First", "ראשונה — כמו היום", "", True, 1, None])
def test_a_value_that_is_not_one_of_the_three_codes_is_refused(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, "shop", world.shop.id, value)
    assert exc.value.status_code == 422
    assert world.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(world).id).count() == 0
    assert _changes(world) == []
    assert _pulled(world, world.tills[0]) == "first"


def test_a_default_that_is_not_one_of_the_codes_is_refused(world):
    with pytest.raises(HTTPException) as exc:
        R.update_till_parameter(
            parameter_id=_definition(world).id, body=TillParameterUpdate(defaultValue="middle"),
            background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
        )
    assert exc.value.status_code == 422
    assert _definition(world).default_value == "first"


def test_the_till_knows_three_codes_even_if_the_options_are_re_edited(world):
    # A super admin adds an option to the definition: still not a value the till understands.
    R.update_till_parameter(
        parameter_id=_definition(world).id,
        body=TillParameterUpdate(enumOptions=["first", "last", "hidden", "middle"]),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
    )
    assert "middle" in _definition(world).enum_options
    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, "middle")
    assert exc.value.status_code == 422
    assert "first, last, hidden" in exc.value.detail
    assert _pulled(world, world.tills[0]) == "first"


# ── The change log ───────────────────────────────────────────────────────────


def test_every_change_is_logged_with_who_where_and_from_what_to_what(world):
    _set(world, "shop", world.shop.id, "hidden")
    _set(world, "shop", world.shop.id, "hidden")  # the same again: nothing changed, nothing logged
    _set(world, "shop", world.shop.id, "last")
    _set(world, "machine", world.tills[1].id, "first")
    _clear(world, "shop", world.shop.id)

    rows = _changes(world)
    assert [(r.action, r.scope_type, r.old_value, r.new_value) for r in rows] == [
        ("set", "shop", None, "hidden"),
        ("set", "shop", "hidden", "last"),
        ("set", "machine", None, "first"),
        ("clear", "shop", "last", None),
    ]
    assert [TP.as_uuid(r.scope_id) for r in rows] == [world.shop.id, world.shop.id, world.tills[1].id, world.shop.id]
    assert all(r.user_email == "owner@x" and r.parameter_id == _definition(world).id for r in rows)


def test_a_change_of_the_default_is_logged_too(world):
    R.update_till_parameter(
        parameter_id=_definition(world).id, body=TillParameterUpdate(defaultValue="last"),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
    )
    ((row),) = _changes(world)
    assert (row.action, row.scope_type, row.old_value, row.new_value) == ("default", "default", "first", "last")


# ── What the till pulls ──────────────────────────────────────────────────────


def _http_pull(world, till, etag=None):
    request = MagicMock()
    request.headers = {"if-none-match": etag} if etag else {}
    return get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=world.db)


def test_the_sync_payload_carries_it_as_a_plain_string_and_its_etag_moves(world):
    till = world.tills[0]
    first = _http_pull(world, till)
    body = json.loads(first.body)
    assert body["parameters"][KEY] == "first"
    etag = first.headers["etag"]
    # Nothing changed: a bare 304.
    assert _http_pull(world, till, etag).status_code == 304

    _set(world, "area", world.area.id, "hidden")
    second = _http_pull(world, till, etag)
    assert second.status_code == 200
    assert json.loads(second.body)["parameters"][KEY] == "hidden"
    assert second.headers["etag"] != etag
    # The other till in the shop, outside the area, still pulls the default.
    assert json.loads(_http_pull(world, world.tills[1]).body)["parameters"][KEY] == "first"


def test_a_change_notifies_the_tills_it_reaches(world, monkeypatch):
    sent = []
    monkeypatch.setattr(TP, "publish_settings_notify", lambda tenant, machine, reason: sent.append((machine, reason)))
    _set(world, "area", world.area.id, "last")
    assert sent == [(str(world.tills[0].id), TP.NOTIFY_REASON)]
