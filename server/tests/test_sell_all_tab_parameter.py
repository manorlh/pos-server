"""
"לשונית 'הכל' בקטלוג ההזמנה" — the till parameter `sellAllTab`.

The owner (13.10.2026): in an order, the catalog's category bar starts with a "הכל" tab showing every
product — let it be hidden or moved. A built-in enum the till reads: `first`, `last`, `hidden` (no
"הכל"; the order opens on the first category, and search still covers every product). The owner,
14.10.2026: `hidden` is the default for every customer; whoever wants "הכל" sets first or last. An
existing database gets the new default from the migration 5d1f8b3e7a92 (only while its default is
still the old built-in "first"), and a level that set a value keeps it. On every order screen with a category bar: phone, tablet, a table's order and the designed
templates. Set like every till parameter — company, shop, point of sale, till; the most specific wins —
each change in `till_parameter_changes`, and pulled with the others (`GET /sync/{machine_id}/parameters`,
`parameters.sellAllTab`). The dashboard shows each code's Hebrew (`enumLabels`).
"""
from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path
from types import SimpleNamespace
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
from app.services.till_parameters import TillScopeChain, resolve_till_parameters
from shift_world import accept_str_uuids, make_world

KEY = "sellAllTab"
LABELS = {
    "first": "ראשונה",
    "last": "אחרונה",
    "hidden": "מוסתרת — נפתחת המחלקה הראשונה (ברירת מחדל)",
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


def test_a_builtin_enum_of_three_codes_hidden_by_default():
    spec = _spec()
    assert spec.label == "לשונית 'הכל' בקטלוג ההזמנה"
    assert spec.value_type == "enum"
    assert spec.enum_options == ("first", "last", "hidden") == TP.SELL_ALL_TAB_OPTIONS
    # The owner, 14.10.2026: no "הכל" unless someone asks for it.
    assert spec.default_value == "hidden" == TP.SELL_ALL_TAB_DEFAULT
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
    # The default is said once, on hidden — and nothing is "as today" any more.
    assert text.count("(ברירת מחדל)") == 1
    assert "«מוסתרת — נפתחת המחלקה הראשונה (ברירת מחדל)»" in text
    assert "כמו היום" not in text
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
    assert row.default_value == "hidden"
    assert row.description == _spec().description
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
    assert out["defaultValue"] == "hidden"
    assert out["managedOn"] is None and out["adminOnly"] is False
    # Any other parameter: no labels.
    (other,) = [r.model_dump(mode="json", by_alias=True) for r in rows if r.key == "productTileSize"]
    assert other["enumLabels"] is None


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_till_gets_hidden_until_someone_sets_it(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == "hidden"


def test_the_hidden_default_reaches_a_till_with_no_value_at_any_level(world):
    # No value anywhere for this parameter: the till pulls the built-in default, hidden.
    assert world.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(world).id).count() == 0
    till = world.tills[1]
    assert _pulled(world, till) == "hidden"
    assert TP.till_parameters_for_machine(world.db, till).parameters[KEY] == "hidden"
    assert json.loads(_http_pull(world, till).body)["parameters"][KEY] == "hidden"

    # Whoever wants "הכל" sets it back at a level: only the tills under it get it.
    _set(world, "machine", world.tills[0].id, "first")
    assert _pulled(world, world.tills[0]) == "first"
    assert _pulled(world, till) == "hidden" and _pulled(world, world.other_till) == "hidden"


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
    _set(world, "machine", world.tills[0].id, "hidden")
    R.update_till_parameter(
        parameter_id=_definition(world).id, body=TillParameterUpdate(defaultValue="first"),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
    )
    assert _pulled(world, world.tills[0]) == "hidden"
    assert _pulled(world, world.tills[1]) == "first"
    assert _pulled(world, world.other_till) == "first"


# ── Unknown values ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", ["middle", "First", "ראשונה — כמו היום", "", True, 1, None])
def test_a_value_that_is_not_one_of_the_three_codes_is_refused(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, "shop", world.shop.id, value)
    assert exc.value.status_code == 422
    assert world.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(world).id).count() == 0
    assert _changes(world) == []
    assert _pulled(world, world.tills[0]) == "hidden"


def test_a_default_that_is_not_one_of_the_codes_is_refused(world):
    with pytest.raises(HTTPException) as exc:
        R.update_till_parameter(
            parameter_id=_definition(world).id, body=TillParameterUpdate(defaultValue="middle"),
            background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
        )
    assert exc.value.status_code == 422
    assert _definition(world).default_value == "hidden"


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
    assert _pulled(world, world.tills[0]) == "hidden"


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
    assert (row.action, row.scope_type, row.old_value, row.new_value) == ("default", "default", "hidden", "last")


# ── What the till pulls ──────────────────────────────────────────────────────


def _http_pull(world, till, etag=None):
    request = MagicMock()
    request.headers = {"if-none-match": etag} if etag else {}
    return get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=world.db)


def test_the_sync_payload_carries_it_as_a_plain_string_and_its_etag_moves(world):
    till = world.tills[0]
    first = _http_pull(world, till)
    body = json.loads(first.body)
    assert body["parameters"][KEY] == "hidden"
    etag = first.headers["etag"]
    # Nothing changed: a bare 304.
    assert _http_pull(world, till, etag).status_code == 304

    _set(world, "area", world.area.id, "first")
    second = _http_pull(world, till, etag)
    assert second.status_code == 200
    assert json.loads(second.body)["parameters"][KEY] == "first"
    assert second.headers["etag"] != etag
    # The other till in the shop, outside the area, still pulls the default.
    assert json.loads(_http_pull(world, world.tills[1]).body)["parameters"][KEY] == "hidden"


def test_a_change_notifies_the_tills_it_reaches(world, monkeypatch):
    sent = []
    monkeypatch.setattr(TP, "publish_settings_notify", lambda tenant, machine, reason: sent.append((machine, reason)))
    _set(world, "area", world.area.id, "last")
    assert sent == [(str(world.tills[0].id), TP.NOTIFY_REASON)]


# ── The migration on an existing database (5d1f8b3e7a92) ─────────────────────


def _migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "5d1f8b3e7a92_sell_all_tab_hidden_default.py"
    spec = importlib.util.spec_from_file_location("sell_all_tab_hidden_default_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Conn:
    """`till_parameters`' one row as Postgres returns it (JSONB decoded), and the updates made."""

    def __init__(self, default, description):
        self.row = {"id": "p-1", "default_value": default, "description": description}
        self.updates = []

    def execute(self, statement, params):
        sql = str(statement)
        if sql.startswith("SELECT"):
            row = self.row
            return SimpleNamespace(
                first=lambda: None if row is None else (row["id"], row["default_value"], row["description"])
            )
        self.updates.append(sql)
        if "default_value" in sql:
            self.row["default_value"] = json.loads(params["value"])
        if "SET description" in sql:
            self.row["description"] = params["description"]
        return None


def _migrate(module, conn, step):
    module.op = SimpleNamespace(get_bind=lambda: conn)
    getattr(module, step)()


def test_the_migration_speaks_the_built_in_definition():
    m = _migration()
    assert (m.KEY, m.OLD_DEFAULT, m.NEW_DEFAULT) == (KEY, "first", "hidden")
    assert m.NEW_DESCRIPTION == _spec().description
    assert "«ראשונה — כמו היום» (ברירת מחדל)" in m.OLD_DESCRIPTION


def test_the_migration_moves_the_old_default_and_wording_once_and_back():
    m = _migration()
    conn = _Conn("first", m.OLD_DESCRIPTION)
    _migrate(m, conn, "upgrade")
    assert conn.row == {"id": "p-1", "default_value": "hidden", "description": _spec().description}
    assert len(conn.updates) == 2
    # Again: nothing to do.
    _migrate(m, conn, "upgrade")
    assert len(conn.updates) == 2
    _migrate(m, conn, "downgrade")
    assert conn.row == {"id": "p-1", "default_value": "first", "description": m.OLD_DESCRIPTION}


def test_the_migration_keeps_what_a_super_admin_chose():
    m = _migration()
    conn = _Conn("last", "התיאור שלנו")
    _migrate(m, conn, "upgrade")
    assert conn.row == {"id": "p-1", "default_value": "last", "description": "התיאור שלנו"}
    assert conn.updates == []


def test_the_migration_leaves_a_database_with_no_definition_yet_to_the_built_in_one():
    m = _migration()
    conn = _Conn(None, None)
    conn.row = None
    _migrate(m, conn, "upgrade")
    assert conn.updates == []


def test_after_the_migration_a_till_with_no_value_gets_hidden_and_a_level_that_set_one_keeps_it():
    m = _migration()
    conn = _Conn("first", m.OLD_DESCRIPTION)
    _migrate(m, conn, "upgrade")
    definition = SimpleNamespace(
        id=uuid.uuid4(), key=KEY, value_type="enum", enum_options=list(TP.SELL_ALL_TAB_OPTIONS),
        default_value=conn.row["default_value"], is_active=True, updated_at=None,
    )
    chain = TillScopeChain(machine_id=uuid.uuid4(), area_id=None, shop_id=uuid.uuid4(), company_id=uuid.uuid4())
    assert resolve_till_parameters([definition], [], chain).parameters == {KEY: "hidden"}
    for scope_type, scope_id in (("company", chain.company_id), ("machine", chain.machine_id)):
        kept = SimpleNamespace(
            parameter_id=definition.id, scope_type=scope_type, scope_id=scope_id, value="first", updated_at=None,
        )
        assert resolve_till_parameters([definition], [kept], chain).parameters == {KEY: "first"}


def test_the_migration_is_the_single_head_on_the_release_merge():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    # Not resolve(): under the dev box's short P: path the versions stay under MAX_PATH.
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "5d1f8b3e7a92" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("5d1f8b3e7a92").down_revision == "ba584f6fb704"
