"""
"מכשיר מזומן (CashMag)" — the CashMag recycler's till parameters (app/services/cashmag_params.py, P:/specs/cashmag.md §4.1).

Built-ins, every default keeping today's till (CashMag off, the currency ILS, the jar protocol), set per level like
every till parameter and pulled with the others (`GET /sync/{machine_id}/parameters`); what the till could not use
is refused on save (422).
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
from app.services import cashmag_params as CM
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEYS = (
    CM.ENABLED_KEY, CM.PROTOCOL_KEY, CM.HOST_KEY, CM.PORT_KEY, CM.TERMINAL_KEY, CM.USER_CODE_KEY, CM.CURRENCY_KEY,
    CM.ROUNDING_KEY, CM.QUEUE_TIMEOUT_KEY, CM.AUTO_CANCEL_KEY, CM.CALL_TIMEOUT_KEY,
)


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


def _definition(world, key) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == key).one()


def _set(world, key, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world, key).id,
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
    return resp.model_dump(mode="json", by_alias=True)["parameters"]


def test_the_keys_are_the_tills_and_every_default_is_todays():
    specs = {p.key: p for p in TP.BUILTIN_PARAMETERS if p.key in KEYS}
    assert set(specs) == set(KEYS)
    # The names the till reads (pos-android domain/CashMag.kt CashMagConfig.PARAM_*).
    assert KEYS == (
        "cashmagEnabled", "cashmagProtocol", "cashmagHost", "cashmagPort", "cashmagTerminal", "cashmagUserCode",
        "cashmagCurrency", "cashmagRounding", "cashmagQueueTimeoutSec", "cashmagAutoCancelSec", "cashmagCallTimeoutSec",
    )
    assert specs[CM.ENABLED_KEY].value_type == "boolean" and specs[CM.ENABLED_KEY].default_value is False
    assert specs[CM.PROTOCOL_KEY].enum_options == ("jar", "rlp") and specs[CM.PROTOCOL_KEY].default_value == "jar"
    assert specs[CM.CURRENCY_KEY].default_value == "ILS"
    assert specs[CM.ROUNDING_KEY].enum_options == ("nearest_10", "none") and specs[CM.ROUNDING_KEY].default_value == "nearest_10"
    # First come, first served: the other client waits until the machine is free (0 = no limit).
    assert specs[CM.QUEUE_TIMEOUT_KEY].default_value == 0
    assert specs[CM.AUTO_CANCEL_KEY].default_value == 0
    assert specs[CM.CALL_TIMEOUT_KEY].default_value == 30
    for key in (CM.HOST_KEY, CM.PORT_KEY, CM.TERMINAL_KEY, CM.USER_CODE_KEY):
        assert specs[key].default_value is None, key
    for spec in specs.values():
        assert spec.label.startswith("מכשיר מזומן CashMag — "), spec.key
        assert "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה" in spec.description
        assert not spec.admin_only
    assert len({s.label for s in specs.values()}) == len(specs)
    assert TP.enum_labels(CM.PROTOCOL_KEY) == CM.PROTOCOL_LABELS


def test_they_are_created_with_the_others(world):
    for key in KEYS:
        row = _definition(world, key)
        assert row.is_active
    assert not set(KEYS) & set(TP.ensure_builtin_parameters(world.db))


def test_off_on_every_till_until_a_level_turns_it_on(world):
    t1, t2 = world.tills
    pulled = _pulled(world, t1)
    assert pulled[CM.ENABLED_KEY] is False
    assert pulled[CM.CURRENCY_KEY] == "ILS" and pulled[CM.PROTOCOL_KEY] == "jar"
    assert pulled.get(CM.HOST_KEY) is None and pulled.get(CM.USER_CODE_KEY) is None
    _set(world, CM.ENABLED_KEY, "shop", world.shop.id, True)
    _set(world, CM.HOST_KEY, "shop", world.shop.id, " 192.168.1.40 ")
    _set(world, CM.PORT_KEY, "shop", world.shop.id, 8080)
    _set(world, CM.USER_CODE_KEY, "shop", world.shop.id, "4321")
    _set(world, CM.CURRENCY_KEY, "shop", world.shop.id, "ils")
    # The till's own level over the shop's.
    _set(world, CM.ENABLED_KEY, "machine", t2.id, False)
    one, two = _pulled(world, t1), _pulled(world, t2)
    assert one[CM.ENABLED_KEY] is True and two[CM.ENABLED_KEY] is False
    assert one[CM.HOST_KEY] == "192.168.1.40" and one[CM.PORT_KEY] == 8080 and one[CM.USER_CODE_KEY] == "4321"
    assert one[CM.CURRENCY_KEY] == "ILS"
    # Another shop keeps the defaults.
    assert _pulled(world, world.other_till)[CM.ENABLED_KEY] is False


@pytest.mark.parametrize(
    "key,value",
    [
        (CM.USER_CODE_KEY, "12a"),
        (CM.USER_CODE_KEY, "1234567890123"),
        (CM.CURRENCY_KEY, "SHEKEL"),
        (CM.CURRENCY_KEY, "il"),
        (CM.HOST_KEY, "cash mag"),
        (CM.PORT_KEY, 0),
        (CM.PORT_KEY, 70000),
        (CM.QUEUE_TIMEOUT_KEY, 1801),
        (CM.CALL_TIMEOUT_KEY, 4),
        (CM.TERMINAL_KEY, "x" * 41),
        (CM.PROTOCOL_KEY, "soap"),
        (CM.ENABLED_KEY, "yes"),
    ],
)
def test_what_the_till_could_not_use_is_refused(world, key, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, key, "shop", world.shop.id, value)
    assert exc.value.status_code == 422
    assert _pulled(world, world.tills[0])[CM.ENABLED_KEY] is False


def test_clean_value_keeps_what_is_good():
    assert CM.clean_value(CM.USER_CODE_KEY, " 0042 ") == "0042"
    assert CM.clean_value(CM.USER_CODE_KEY, "") == ""
    assert CM.clean_value(CM.CURRENCY_KEY, "eur") == "EUR"
    assert CM.clean_value(CM.HOST_KEY, "cashmag-pc.local") == "cashmag-pc.local"
    assert CM.clean_value(CM.TERMINAL_KEY, " קופה 1 ") == "קופה 1"
    assert CM.clean_value(CM.PORT_KEY, 55110) == 55110
    assert CM.clean_value(CM.QUEUE_TIMEOUT_KEY, 0) == 0
    assert CM.clean_value(CM.ENABLED_KEY, True) is True
    with pytest.raises(ValueError):
        CM.clean_value(CM.PORT_KEY, True)
