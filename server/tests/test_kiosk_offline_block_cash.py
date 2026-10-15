"""
"קיוסק — לחסום מזומן (עמדת מזומן) כשאין אינטרנט" — the till parameter `kioskOfflineBlockCash`.

The owner (14.10.2026, P:/specs/cash-paylink.md §13: "תשאיר את זה כבוי, שימשיך לעבוד בלי אינטרנט, כי מזומן זה
מקומי"): the cash station is on the shop's LAN, so "חסימת הזמנות כשאין אינטרנט" never blocks `cash_device` unless
this is set. Off by default. The Windows kiosk reads the parameter (`GET /sync/{m}/parameters`); the Android web
bundle its kiosk config, where it is put as `general.offlineBlockCash: true` only when on — off, the config and its
version stay exactly as they were (§11.12).
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import kiosks as KR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kiosk import KioskCreateIn
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify
from app.services import kiosk_config as C
from app.services import kiosk_control as S
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "kioskOfflineBlockCash"


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    w = make_world()
    w.kiosk, w.till = w.tills
    w.db.commit()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    KR.create_kiosk(
        body=KioskCreateIn(machineId=w.kiosk.id, name=None, controllerMachineIds=[str(w.till.id)], lockDevice=False),
        current_user=w.admin,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=world.db.query(TillParameter).filter(TillParameter.key == KEY).one().id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    world.db.commit()
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def test_a_builtin_boolean_off_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.value_type == "boolean" and spec.default_value is False == TP.KIOSK_OFFLINE_BLOCK_CASH_DEFAULT
    assert "חסימת הזמנות כשאין אינטרנט" in spec.description and "עמדת המזומן" in spec.description
    assert "חברה, סניף, נקודת מכירה או קופה" in spec.description
    assert TP.validate_key(KEY) == KEY


def test_the_kiosk_reads_it_off_until_a_level_sets_it(world):
    assert _pulled(world, world.kiosk) is False
    assert TP.kiosk_offline_block_cash(world.db, world.kiosk) is False
    _set(world, "shop", world.shop.id, True)
    assert _pulled(world, world.kiosk) is True and TP.kiosk_offline_block_cash(world.db, world.kiosk) is True
    _set(world, "machine", world.kiosk.id, False)
    assert TP.kiosk_offline_block_cash(world.db, world.kiosk) is False


def test_off_the_config_and_its_version_are_as_they_were(world):
    before = C.effective_bundle(world.db, world.kiosk)
    assert "offlineBlockCash" not in before["config"]["general"]
    _set(world, "shop", world.shop.id, False)
    after = C.effective_bundle(world.db, world.kiosk)
    assert after["config"] == before["config"] and after["configVersion"] == before["configVersion"]


def test_on_it_reaches_the_kiosk_config_with_a_new_version(world):
    before = C.effective_bundle(world.db, world.kiosk)
    _set(world, "company", world.company.id, True)
    bundle = C.effective_bundle(world.db, world.kiosk)
    assert bundle["config"]["general"]["offlineBlockCash"] is True
    rest = dict(bundle["config"]["general"])
    rest.pop("offlineBlockCash")
    assert rest == before["config"]["general"]
    assert bundle["configVersion"] != before["configVersion"]
    out = S.kiosk_sync(world.db, world.kiosk, {"flowState": "attract"})
    assert out["config"]["general"]["offlineBlockCash"] is True
    # Beside a non-default scope, both are said.
    scope = world.db.query(TillParameter).filter(TillParameter.key == TP.KIOSK_OFFLINE_BLOCK_SCOPE_KEY).one()
    tasks = BackgroundTasks()
    R.set_till_parameter_value(
        parameter_id=scope.id,
        body=TillParameterValueIn(scopeType="shop", scopeId=world.shop.id, value="pay_at_till"),
        background_tasks=tasks, _admin=_admin(), db=world.db,
    )
    world.db.commit()
    general = C.effective_bundle(world.db, world.kiosk)["config"]["general"]
    assert (general["offlineBlockScope"], general["offlineBlockCash"]) == ("pay_at_till", True)
