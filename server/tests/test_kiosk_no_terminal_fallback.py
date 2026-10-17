"""
"קיוסק — כשאין מסופון אשראי" — the till parameter `kioskNoTerminalFallback`.

The owner (16.10.2026, "גם אם אין מסופון שיעלה"): a kiosk with no card terminal to charge on — none set up, "ללא
אשראי", or one that does not answer — and nothing else that pays still comes up and takes orders: at the payment it
offers "תשלום בקופה" (`pay_at_till`, the default); `block` keeps the "התשלום אינו זמין כרגע" rest. Chosen per company /
shop / point of sale / till. The Windows kiosk reads the parameter (`GET /sync/{m}/parameters`), the Android kiosk too
(`param.kioskNoTerminalFallback`); the Android web bundle reads its kiosk config, so a choice other than the default is
put there as `general.noTerminalFallback` (kiosk_config.effective_config) — at the default the config stays exactly as it
was (no new configVersion). A kiosk that does not know the parameter behaves as the default.

"לקיוסק לא יישאר אמצעי תשלום" (payment_integration.kiosk_warnings): a kiosk "ללא אשראי" whose fallback is `pay_at_till`
still takes payment at the till — no warning; with `block` it warns as before.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import BackgroundTasks

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import kiosks as KR
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify, settings_notify
from app.services import kiosk_config as C
from app.services import kiosk_control as S
from app.services import payment_integration as PI
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "kioskNoTerminalFallback"
LABELS = {
    "pay_at_till": "הקיוסק עובד ומציע תשלום בקופה (ברירת מחדל)",
    "block": "הקיוסק לא מקבל הזמנות",
}


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_company_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
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
        body=KioskCreateIn(machineId=w.kiosk.id, name="קיוסק רויאל", controllerMachineIds=[str(w.till.id)], lockDevice=False),
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


def _patch_machine(world, till, **body):
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=PosSettingsV1Patch(**body), current_user=world.admin,
            active_tenant_id=world.tenant.id, db=world.db,
        )


def _put_kiosk(world, overrides):
    return KR.put_settings(
        body=KioskSettingsIn(overrides=overrides), level="machine", scope_id=world.kiosk.id,
        current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )


# ── The definition ───────────────────────────────────────────────────────────


def test_a_builtin_enum_pay_at_till_by_default_with_hebrew_labels():
    spec = _spec()
    assert spec.label == "קיוסק — כשאין מסופון אשראי"
    assert spec.value_type == "enum"
    assert spec.enum_options == ("pay_at_till", "block") == TP.KIOSK_NO_TERMINAL_FALLBACK_OPTIONS
    assert spec.default_value == "pay_at_till" == TP.KIOSK_NO_TERMINAL_FALLBACK_DEFAULT
    assert spec.enum_labels == LABELS == TP.enum_labels(KEY)
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(KEY) == 1
    assert TP.validate_key(KEY) == KEY
    text = spec.description
    for label in LABELS.values():
        assert f"«{label}»" in text
    for words in ("תשלום בקופה", "ללא אשראי", "לתשלום בקופה", "לא מפיק מסמך", "התשלום אינו זמין כרגע", "חסימת הזמנות כשאין אינטרנט"):
        assert words in text
    assert "Windows" in text and "אנדרואיד" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_created_with_the_others(world):
    row = _definition(world)
    assert row.is_active and row.value_type == "enum"
    assert row.enum_options == ["pay_at_till", "block"]
    assert row.default_value == "pay_at_till"
    assert row.label == _spec().label


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_kiosk_gets_pay_at_till_until_a_level_sets_it(world):
    assert _pulled(world, world.kiosk) == "pay_at_till"
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, "block")
    assert _pulled(world, world.kiosk) == "block"
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "block"
    _set(world, "shop", world.shop.id, "pay_at_till")
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"
    _set(world, "area", world.area.id, "block")
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "block"
    _set(world, "machine", world.kiosk.id, "pay_at_till")
    assert _pulled(world, world.kiosk) == "pay_at_till"
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"


def test_an_inactive_or_missing_definition_is_the_default(world):
    _set(world, "machine", world.kiosk.id, "block")
    _definition(world).is_active = False
    world.db.commit()
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"
    world.db.delete(_definition(world))
    world.db.commit()
    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"


# ── In the kiosk's config (the Android web bundle reads it there) ────────────


def test_at_the_default_the_config_and_its_version_are_as_they_were(world):
    before = C.effective_bundle(world.db, world.kiosk)
    assert "noTerminalFallback" not in before["config"]["general"]
    _set(world, "shop", world.shop.id, "pay_at_till")
    after = C.effective_bundle(world.db, world.kiosk)
    assert after["config"] == before["config"] and after["configVersion"] == before["configVersion"]


def test_block_reaches_the_kiosk_config_with_a_new_version(world):
    before = C.effective_bundle(world.db, world.kiosk)
    _set(world, "shop", world.shop.id, "block")
    bundle = C.effective_bundle(world.db, world.kiosk)
    assert bundle["config"]["general"]["noTerminalFallback"] == "block"
    # Nothing else in the config moved; the kiosks take it as a new config.
    rest = dict(bundle["config"]["general"])
    rest.pop("noTerminalFallback")
    assert rest == before["config"]["general"]
    assert bundle["configVersion"] != before["configVersion"]
    assert bundle["configVersion"] == C.config_version(bundle["config"])
    # The kiosk's sync carries it.
    out = S.kiosk_sync(world.db, world.kiosk, {"flowState": "attract"})
    assert out["config"]["general"]["noTerminalFallback"] == "block"
    assert out["configVersion"] == bundle["configVersion"]
    # Back to the default at the kiosk's own level: gone again, the old version back.
    _set(world, "machine", world.kiosk.id, "pay_at_till")
    again = C.effective_bundle(world.db, world.kiosk)
    assert "noTerminalFallback" not in again["config"]["general"]
    assert again["configVersion"] == before["configVersion"]


def test_both_overlays_together(world):
    _set(world, "shop", world.shop.id, "block")
    tasks_scope = world.db.query(TillParameter).filter(TillParameter.key == "kioskOfflineBlockScope").one()
    tasks = BackgroundTasks()
    R.set_till_parameter_value(
        parameter_id=tasks_scope.id,
        body=TillParameterValueIn(scopeType="shop", scopeId=world.shop.id, value="pay_at_till"),
        background_tasks=tasks, _admin=_admin(), db=world.db,
    )
    world.db.commit()
    general = C.effective_config(world.db, world.kiosk)["general"]
    assert (general["noTerminalFallback"], general["offlineBlockScope"]) == ("block", "pay_at_till")


def test_the_overlay_leaves_a_config_alone_without_the_parameter_tables(world):
    cfg = {"general": {"blockWhenOffline": True}}
    broken = MagicMock()
    broken.query.side_effect = RuntimeError("no such table")
    assert TP.kiosk_no_terminal_fallback_overlay(broken, world.kiosk, cfg) is cfg


# ── "לקיוסק לא יישאר אמצעי תשלום" ────────────────────────────────────────────


def test_none_on_a_card_only_kiosk_warns_only_with_block(world):
    # `pay_at_till` (the default): the kiosk offers "תשלום בקופה" itself — nothing to warn of.
    _put_kiosk(world, {"payment": {"methods": ["card"]}})
    assert _patch_machine(world, world.kiosk, paymentIntegration="none").warnings == []
    assert PI.kiosk_takes_payment_without_card(world.db, world.kiosk) is True
    # `block`: as before — the kiosk is left with no way to pay.
    _set(world, "machine", world.kiosk.id, "block")
    _patch_machine(world, world.kiosk, paymentIntegration="auto")
    out = _patch_machine(world, world.kiosk, paymentIntegration="none")
    assert [x["code"] for x in out.warnings] == ["kiosk_no_payment_method"]
    assert out.warnings[0]["machineIds"] == [str(world.kiosk.id)]
    assert PI.kiosk_takes_payment_without_card(world.db, world.kiosk) is False
    # "תשלום בקופה" in the config: never a warning, whatever the fallback.
    assert _put_kiosk(world, {"payment": {"methods": ["card", "cash_at_till"]}})["warnings"] == []


def test_the_kiosk_form_is_told_it_still_pays_at_the_till(world):
    def context(machine):
        with patch("app.routers.machines._machine_for_read", return_value=machine):
            return pi_router.get_payment_integration_context(
                level="machine", target_id=str(machine.id), current_user=world.admin,
                active_tenant_id=world.tenant.id, db=world.db,
            )

    _put_kiosk(world, {"payment": {"methods": ["card"]}})
    assert context(world.kiosk)["kioskPaysAtTill"] is True
    _set(world, "machine", world.kiosk.id, "block")
    assert context(world.kiosk)["kioskPaysAtTill"] is False
    assert context(world.till)["kioskPaysAtTill"] is None  # a till


# ── The managers still told (the coordinator 16.10: a push when a kiosk has no card) ─────────

NOT_SET = {"kind": "terminal", "key": "terminal", "reason": "not_configured"}
NOT_ANSWERING = {"kind": "terminal", "key": "terminal", "reason": "unreachable", "detail": {"address": "10.0.0.5:8080"}}


def test_the_terminal_alert_stays_an_exception_for_the_managers_while_the_till_is_offered(world):
    """
    The kiosk keeps reporting its terminal alert while it offers "תשלום בקופה" instead (kiosk-desktop
    core/kioskHealth.ts terminalAlertReason, pos-android KioskAlertRules): none set up — `not_configured`,
    not answering — `unreachable`. Both are the exception "תקלת מסוף אשראי בקיוסק" (`kiosk_terminal`), pushed
    as "card_terminal"; the alert clears ("recovered") once the kiosk stops saying so — the card works again.
    """
    from app.models.kiosk_ops import KioskAlert
    from app.services.exception_alerts import push as P
    from app.services.exception_alerts import sources as SRC

    assert TP.kiosk_no_terminal_fallback(world.db, world.kiosk) == "pay_at_till"

    def sync(alerts):
        S.kiosk_sync(world.db, world.kiosk, {"flowState": "attract", "alerts": alerts})
        world.db.commit()

    def rows():
        return world.db.query(KioskAlert).filter(KioskAlert.kiosk_machine_id == world.kiosk.id, KioskAlert.key == "terminal").all()

    def entry(row):
        (spec,) = SRC.capture(world.db, SRC.by_name("kiosk_alert"), row)
        return spec

    sync([NOT_SET])
    (row,) = [r for r in rows() if r.cleared_at is None]
    assert row.reason == "not_configured" and "המסופון לא מוגדר" in row.text
    spec = entry(row)
    assert spec.kind == "kiosk_terminal" and P.category_of(spec) == "card_terminal"

    sync([NOT_ANSWERING])
    (row,) = [r for r in rows() if r.cleared_at is None]
    assert row.reason == "unreachable" and "אין תקשורת למסופון האשראי" in row.text
    spec = entry(row)
    assert spec.kind == "kiosk_terminal" and P.category_of(spec) == "card_terminal"

    # The card works again: the kiosk says nothing of its terminal — the alert is over.
    sync([])
    assert [r for r in rows() if r.cleared_at is None] == []
    assert {r.clear_reason for r in rows()} == {"recovered"}
    # The card lock's reasons are the other exception ("מסוף אשראי לא תואם").
    assert SRC.kiosk_alert_kind("terminal", "terminal_not_configured") == "terminal_mismatch"
    assert SRC.kiosk_alert_kind("terminal", "not_configured") == "kiosk_terminal"
