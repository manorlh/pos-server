"""
"קיוסק — מה נחסם כשאין אינטרנט" — the till parameter `kioskOfflineBlockScope`.

The owner (14.10.2026, "כן אבל דינמי"): what the kiosk setting "חסימת הזמנות כשאין אינטרנט" blocks while the
kiosk is offline is chosen per company / shop / point of sale / till. `all` (the default) — every way to pay, the
kiosk rests on its "offline" screen (the Windows kiosk as it was); `pay_at_till` — only "תשלום בקופה" (the
Android web kiosk as it was). The Windows kiosk reads the parameter (`GET /sync/{m}/parameters`); the Android web
bundle reads its kiosk config, so a scope other than the default is put there too, as `general.offlineBlockScope`
(kiosk_config.effective_config) — at the default the config stays exactly as it was (no new configVersion).
kiosk-desktop core/offlineBlock.ts applies it on both.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.shop_area import ShopArea
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

KEY = "kioskOfflineBlockScope"
LABELS = {"all": "כל אמצעי התשלום (ברירת מחדל)", "pay_at_till": "תשלום בקופה בלבד"}


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.kiosk, w.till = w.tills
    w.kiosk.area_id = area.id
    w.area = area
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


def _spec():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    return spec


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
    world.db.commit()
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


# ── The definition ───────────────────────────────────────────────────────────


def test_a_builtin_enum_all_by_default_with_hebrew_labels():
    spec = _spec()
    assert spec.label == "קיוסק — מה נחסם כשאין אינטרנט"
    assert spec.value_type == "enum"
    assert spec.enum_options == ("all", "pay_at_till") == TP.KIOSK_OFFLINE_BLOCK_SCOPE_OPTIONS
    assert spec.default_value == "all" == TP.KIOSK_OFFLINE_BLOCK_SCOPE_DEFAULT
    assert spec.enum_labels == LABELS == TP.enum_labels(KEY)
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(KEY) == 1
    assert TP.validate_key(KEY) == KEY
    text = spec.description
    assert "חסימת הזמנות כשאין אינטרנט" in text
    for label in LABELS.values():
        assert f"«{label}»" in text
    assert "Windows" in text and "אנדרואיד" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_created_with_the_others(world):
    row = _definition(world)
    assert row.is_active and row.value_type == "enum"
    assert row.enum_options == ["all", "pay_at_till"]
    assert row.default_value == "all"
    assert row.label == _spec().label


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_till_gets_all_until_a_level_sets_it(world):
    assert _pulled(world, world.kiosk) == "all"
    assert TP.kiosk_offline_block_scope(world.db, world.kiosk) == "all"


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, "pay_at_till")
    assert _pulled(world, world.kiosk) == "pay_at_till"
    assert TP.kiosk_offline_block_scope(world.db, world.kiosk) == "pay_at_till"
    _set(world, "area", world.area.id, "all")
    assert TP.kiosk_offline_block_scope(world.db, world.kiosk) == "all"
    _set(world, "machine", world.kiosk.id, "pay_at_till")
    assert _pulled(world, world.kiosk) == "pay_at_till"
    assert TP.kiosk_offline_block_scope(world.db, world.kiosk) == "pay_at_till"


def test_an_inactive_definition_is_the_default(world):
    _set(world, "machine", world.kiosk.id, "pay_at_till")
    _definition(world).is_active = False
    world.db.commit()
    assert TP.kiosk_offline_block_scope(world.db, world.kiosk) == "all"


# ── In the kiosk's config (the Android web bundle reads it there) ────────────


def test_at_the_default_the_config_and_its_version_are_as_they_were(world):
    before = C.effective_bundle(world.db, world.kiosk)
    assert "offlineBlockScope" not in before["config"]["general"]
    _set(world, "shop", world.shop.id, "all")
    after = C.effective_bundle(world.db, world.kiosk)
    assert after["config"] == before["config"] and after["configVersion"] == before["configVersion"]


def test_pay_at_till_reaches_the_kiosk_config_with_a_new_version(world):
    before = C.effective_bundle(world.db, world.kiosk)
    _set(world, "shop", world.shop.id, "pay_at_till")
    bundle = C.effective_bundle(world.db, world.kiosk)
    assert bundle["config"]["general"]["offlineBlockScope"] == "pay_at_till"
    # Nothing else in the config moved; the kiosks take it as a new config.
    rest = dict(bundle["config"]["general"])
    rest.pop("offlineBlockScope")
    assert rest == before["config"]["general"]
    assert bundle["configVersion"] != before["configVersion"]
    assert bundle["configVersion"] == C.config_version(bundle["config"])
    # The kiosk's sync carries it.
    out = S.kiosk_sync(world.db, world.kiosk, {"flowState": "attract"})
    assert out["config"]["general"]["offlineBlockScope"] == "pay_at_till"
    assert out["configVersion"] == bundle["configVersion"]
    # Back to the default at the kiosk's own level: gone again, the old version back.
    _set(world, "machine", world.kiosk.id, "all")
    again = C.effective_bundle(world.db, world.kiosk)
    assert "offlineBlockScope" not in again["config"]["general"]
    assert again["configVersion"] == before["configVersion"]


def test_the_overlay_leaves_a_config_alone_without_the_parameter_tables(world):
    cfg = {"general": {"blockWhenOffline": True}}
    broken = MagicMock()
    broken.query.side_effect = RuntimeError("no such table")
    assert TP.kiosk_offline_block_overlay(broken, world.kiosk, cfg) is cfg
