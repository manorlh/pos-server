"""
"כפתור תשלום מהיר 1 / 2" (`quickPayButton1`, `quickPayButton2`): the tablet quick order's two
quick-pay buttons, in their order.

Two built-in enums of the same three choices — "אשראי מהיר", "מזומן עם עודף", "מזומן מהיר" —
by default card first (the right, in Hebrew) and cash with change second. Read by the till
only (pos-android domain/QuickCash.kt). Resolved per till like every parameter — till, then
area, then shop, then company, then the default. They replace "מזומן עם חישוב עודף בפאנל
ההזמנה (טאבלט)" (`cashChangeInPanel`), whose cash box left the panel.
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import till_parameters as TP
from shift_world import make_world

FIRST = "quickPayButton1"
SECOND = "quickPayButton2"
CARD = "אשראי מהיר"
CASH_CHANGE = "מזומן עם עודף"
FAST_CASH = "מזומן מהיר"


@pytest.fixture
def world(monkeypatch):
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
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _param(world, key) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == key).one()


def _set(world, key, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_param(world, key).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    params = resp.model_dump(mode="json", by_alias=True)["parameters"]
    return params.get(FIRST), params.get(SECOND)


def _spec(key):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == key]
    return spec


# ── The definitions ──────────────────────────────────────────────────────────


def test_two_builtin_enums_of_the_same_three_choices():
    for key in (FIRST, SECOND):
        spec = _spec(key)
        assert spec.value_type == "enum"
        assert spec.enum_options == (CARD, CASH_CHANGE, FAST_CASH)
    assert _spec(FIRST).label == "כפתור תשלום מהיר 1 (הזמנה מהירה בטאבלט)"
    assert _spec(SECOND).label == "כפתור תשלום מהיר 2 (הזמנה מהירה בטאבלט)"


def test_card_first_and_cash_with_change_second_by_default():
    assert _spec(FIRST).default_value == CARD
    assert _spec(SECOND).default_value == CASH_CHANGE


def test_the_description_says_where_they_stand_and_what_hides_one():
    for key in (FIRST, SECOND):
        text = _spec(key).description
        assert "מימין" in text and "משמאלו" in text
        assert "\"תשלום\"" in text and "פיצול" in text
        for choice in (CARD, CASH_CHANGE, FAST_CASH):
            assert f"«{choice}»" in text
        assert "לא מוצג" in text and "כל הרוחב" in text
        assert "אותה בחירה בשני הכפתורים" in text
        assert "חברה, סניף, נקודת מכירה או קופה" in text
    assert _spec(FIRST).description.startswith("הכפתור הראשון (מימין).")
    assert _spec(SECOND).description.startswith("הכפתור השני (משמאל).")


def test_the_cash_box_switch_is_no_longer_a_builtin():
    assert "cashChangeInPanel" not in {p.key for p in TP.BUILTIN_PARAMETERS}


def test_they_are_created_with_the_others_and_left_alone_afterwards(world):
    first = _param(world, FIRST)
    assert first.is_active and first.enum_options == [CARD, CASH_CHANGE, FAST_CASH]
    assert first.default_value == CARD
    assert _param(world, SECOND).default_value == CASH_CHANGE

    # A super admin re-words one; the next startup keeps their wording.
    first.label = "כפתור ימני"
    world.db.commit()
    created = TP.ensure_builtin_parameters(world.db)
    assert FIRST not in created and SECOND not in created
    assert _param(world, FIRST).label == "כפתור ימני"


# ── Per company, shop, area and till ─────────────────────────────────────────


def test_every_till_gets_the_defaults_until_someone_sets_them(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == (CARD, CASH_CHANGE)


def test_the_order_is_swapped_for_a_whole_company(world):
    _set(world, FIRST, "company", world.company.id, CASH_CHANGE)
    _set(world, SECOND, "company", world.company.id, CARD)
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == (CASH_CHANGE, CARD)


def test_the_most_specific_level_wins_for_each_button_on_its_own(world):
    _set(world, SECOND, "company", world.company.id, FAST_CASH)
    _set(world, FIRST, "shop", world.shop.id, FAST_CASH)
    _set(world, SECOND, "shop", world.shop.id, CARD)
    # The shop's choices beat the company's; the other shop keeps the company's second.
    assert _pulled(world, world.tills[1]) == (FAST_CASH, CARD)
    assert _pulled(world, world.other_till) == (CARD, FAST_CASH)

    _set(world, FIRST, "area", world.area.id, CASH_CHANGE)
    assert _pulled(world, world.tills[0]) == (CASH_CHANGE, CARD)  # in the area
    assert _pulled(world, world.tills[1]) == (FAST_CASH, CARD)  # same shop, no area

    _set(world, SECOND, "machine", world.tills[1].id, CASH_CHANGE)
    assert _pulled(world, world.tills[1]) == (FAST_CASH, CASH_CHANGE)


@pytest.mark.parametrize("value", ["אשראי", "cash", True, 1, ""])
def test_a_value_that_is_not_one_of_the_choices_is_refused(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, FIRST, "machine", world.tills[0].id, value)
    assert exc.value.status_code == 422


# ── The migration that retires the cash box switch ───────────────────────────


def _migration():
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "3f8b6d2a9c41_retire_cash_change_in_panel.py"
    )
    spec = importlib.util.spec_from_file_location("retire_cash_change_in_panel", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_deactivates_the_old_switch_and_keeps_its_values():
    module = _migration()
    assert module.KEY == "cashChangeInPanel" == TP.RETIRED_CASH_CHANGE_IN_PANEL_KEY
    assert module.down_revision == "7d2b9e4a1c63"

    executed = []
    bind = MagicMock()
    bind.execute.side_effect = lambda sql, params: executed.append((str(sql), params))
    op = MagicMock()
    op.get_bind.return_value = bind
    module.op = op

    module.upgrade()
    ((sql, params),) = executed
    assert params == {"key": "cashChangeInPanel"}
    assert "SET is_active = false" in sql and "updated_at = now()" in sql
    assert "DELETE" not in sql.upper()

    executed.clear()
    module.downgrade()
    ((sql, params),) = executed
    assert "SET is_active = true" in sql and params == {"key": "cashChangeInPanel"}
