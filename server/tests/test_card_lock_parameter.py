"""
"חסימת אשראי כשיש תשלום לא מוכרע" — the till parameter `cardLockOnUnresolved`
(app/services/card_lock.py).

A built-in boolean, off by default: off, an unresolved card payment blocks only its own
transaction; on, it locks card payment on the till / kiosk until a manager handles it. Set like
every parameter (a shop's value for all its tills, a till's own over it) and pulled with the
others (`GET /sync/{machine_id}/parameters`).
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import card_lock as CL
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "cardLockOnUnresolved"


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _definition(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world).id,
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
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def test_it_is_a_builtin_boolean_off_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.label == "חסימת אשראי כשיש תשלום לא מוכרע"
    assert spec.value_type == "boolean"
    assert spec.default_value is False
    assert spec.enum_options is None
    assert spec.description == CL.DESCRIPTION


def test_the_hint_says_both_ways():
    text = CL.DESCRIPTION
    assert text.startswith("כבוי (ברירת מחדל): תשלום באשראי שתוצאתו לא ידועה חוסם רק את העסקה שלו")
    assert "ושאר העסקאות וההזמנות בקיוסק משלמות באשראי כרגיל" in text
    assert "התשלום הלא מוכרע נשאר כהתראה דחופה עד שמנהל מטפל בו" in text
    assert "פעיל: כל תשלום לא מוכרע חוסם את האשראי בקופה/בקיוסק עד שמנהל מטפל בו." in text


def test_it_is_created_with_the_others(world):
    row = _definition(world)
    assert row.value_type == "boolean" and row.is_active and row.default_value is False
    assert row.label == CL.LABEL and row.description == CL.DESCRIPTION
    assert KEY not in TP.ensure_builtin_parameters(world.db)


def test_off_on_every_till_until_set(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is False


def test_a_shop_value_and_a_till_override(world):
    t1, t2 = world.tills
    _set(world, "shop", world.shop.id, True)
    assert _pulled(world, t1) is True and _pulled(world, t2) is True
    # Another shop keeps the default.
    assert _pulled(world, world.other_till) is False
    _set(world, "machine", t2.id, False)
    assert _pulled(world, t1) is True and _pulled(world, t2) is False
    assert TP.till_parameters_for_machine(world.db, t2).parameters[KEY] is False
    _set(world, "machine", world.other_till.id, True)
    assert _pulled(world, world.other_till) is True


@pytest.mark.parametrize("value", ["yes", 1, "true"])
def test_a_value_that_is_not_a_boolean_is_refused(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, "shop", world.shop.id, value)
    assert exc.value.status_code == 422
    assert _pulled(world, world.tills[0]) is False
