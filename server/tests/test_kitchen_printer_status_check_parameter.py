"""
"בדיקת מצב מדפסת בונים (DLE EOT)" — the till parameter `kitchenPrinterStatusCheck`.

The Android till's kitchen print queue reads the status of a network or Bluetooth kitchen printer
(`DLE EOT`) around every ticket, unless the till parameter `param.kitchenPrinterStatusCheck` says
false — for a printer that misbehaves on the query (pos-android hardware/kitchen/KitchenPrintService
`PARAM_STATUS_CHECK`, KitchenDelivery `WriteOnlyLink`). It was missing from the cloud's registry, so no
dashboard could set it. A built-in boolean, ON by default (as the till reads a missing value), set like
every parameter (a company's / a shop's value for all its tills, a till's own over it) and pulled with the
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
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "kitchenPrinterStatusCheck"


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


def test_it_is_a_builtin_boolean_on_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.label == "בדיקת מצב מדפסת בונים (DLE EOT)"
    assert spec.value_type == "boolean"
    # On unless it says false: the till's own default for a value it was never given.
    assert spec.default_value is True
    assert spec.enum_options is None
    assert spec.admin_only is False


def test_the_hint_says_what_it_does_both_ways():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    text = spec.description
    assert text.startswith("כשמופעל (ברירת מחדל): סביב כל בון שנשלח למדפסת רשת או Bluetooth")
    assert "DLE EOT" in text
    assert "כבוי — הבון נשלח בלי לקרוא את מצב המדפסת" in text


def test_the_key_is_a_valid_unique_one():
    assert TP.validate_key(KEY) == KEY
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(KEY) == 1


def test_it_is_edited_on_the_parameters_page_not_the_printers_page():
    """Nobody could set it before: it is a plain parameter, on the parameters page."""
    assert TP.managed_on(KEY) is None
    assert KEY not in TP.PRINTERS_PAGE_KEYS


def test_it_is_created_with_the_others(world):
    row = _definition(world)
    assert row.value_type == "boolean" and row.is_active and row.default_value is True
    assert row.label == "בדיקת מצב מדפסת בונים (DLE EOT)"
    # Created once: a second pass leaves it (and a super admin's re-wording) alone.
    assert KEY not in TP.ensure_builtin_parameters(world.db)


def test_on_on_every_till_until_set(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is True


def test_a_shop_value_and_a_till_override(world):
    t1, t2 = world.tills
    _set(world, "shop", world.shop.id, False)
    assert _pulled(world, t1) is False and _pulled(world, t2) is False
    # Another shop keeps the default.
    assert _pulled(world, world.other_till) is True
    # One till whose printer is fine again, over its shop's value.
    _set(world, "machine", t2.id, True)
    assert _pulled(world, t1) is False and _pulled(world, t2) is True
    assert TP.till_parameters_for_machine(world.db, t1).parameters[KEY] is False
    _set(world, "machine", world.other_till.id, False)
    assert _pulled(world, world.other_till) is False


@pytest.mark.parametrize("value", ["false", 0, "off", None])
def test_a_value_that_is_not_a_boolean_is_refused(world, value):
    with pytest.raises((HTTPException, ValueError)) as exc:
        _set(world, "shop", world.shop.id, value)
    status = getattr(exc.value, "status_code", 422)
    assert status == 422
    assert _pulled(world, world.tills[0]) is True
