"""
"ללא אשראי (מזומן ואמצעים אחרים)" — `paymentIntegration` = `none` (P:/specs/payment-integration-none.md).

* A choice like the others: at any level, the most specific winning; on any device (a tablet
  and a till with a terminal of its own alike); nothing required, so nothing is ever missing.
* The sync: the three card switches go out off whatever the layers store (an older till reads
  `none` as `auto`), the stored layers untouched — back to `auto` brings them back.
* No terminal warnings: no pinpad address, no terminal number check, no card lock; the
  inherited terminal configuration never reaches it.
* A kiosk: its terminal alerts dropped and the open ones closed (their exceptions-log entry
  too), its health's terminal part off; a save that leaves it without "תשלום בקופה" warns.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.models.kiosk import KioskDevice
from app.models.kiosk_ops import KioskAlert
from app.routers import kiosks as kiosks_router
from app.routers import machines as machines_router
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.shop import ShopCreate
from app.services import ably_notify, kiosk_control, kiosk_health
from app.services import kiosk_ops as OPS
from app.services import payment_integration as PI
from app.services import settings_notify
from app.services.exception_alerts import sources as SRC
from shift_world import accept_str_uuids, make_world

T0 = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
CARD_KEYS = ("payFastCardEnabled", "payCardEnabled", "payManualCardEnabled")
#: A made-up Z-Credit password for the layers (never a real one).
SHOP_PASS = "shop-pass"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(settings_router, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_company_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(ably_notify, "publish_notify", lambda *a, **k: None)
    for name in ("publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    return world


@pytest.fixture
def k(w):
    """The world with its first till made a kiosk ("קיוסק רויאל"), controlled by the second."""
    w.kiosk, w.main = w.tills
    kiosks_router.create_kiosk(
        body=KioskCreateIn(machineId=w.kiosk.id, name="קיוסק רויאל", controllerMachineIds=[str(w.main.id)]),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    w.db.commit()
    return w


def _patch_machine(w, till, **body):
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def _patch_shop(w, **body):
    with patch.object(settings_router, "_check_shop_settings_write", lambda *a: None):
        return settings_router.patch_shop_settings(
            shop_id=str(w.shop.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def _pulled(w, till):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db).settings


def _row(w, till):
    rows = {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}
    return rows[till.id]


def _put_kiosk(w, overrides):
    return kiosks_router.put_settings(
        body=KioskSettingsIn(overrides=overrides), level="machine", scope_id=w.kiosk.id,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _kiosk_sync(w, status, now=T0):
    out = kiosk_control.kiosk_sync(w.db, w.kiosk, status, now=now)
    w.db.commit()
    return out


# ── The choice ───────────────────────────────────────────────────────────────

LEVELS = ("tenant", "company", "shop", "area", "machine")


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("builtin", [True, False])
def test_none_resolves_from_each_level_with_nothing_missing(level, builtin):
    # Every layer above it chose something else; `auto` below it is transparent.
    layers = []
    for lvl in LEVELS:
        if lvl == level:
            layers.append((lvl, {"paymentIntegration": "none", "nayaxEnabled": True}))
        elif LEVELS.index(lvl) < LEVELS.index(level):
            layers.append((lvl, {"paymentIntegration": "zcredit"}))
        else:
            layers.append((lvl, {"paymentIntegration": "auto"}))
    res = PI.resolve(layers, has_builtin_terminal=builtin)
    assert (res.integration, res.source, res.automatic, res.explicit, res.missing) == ("none", level, False, "none", [])
    assert PI.no_card(res)


def test_a_more_specific_choice_wins_over_none():
    res = PI.resolve([("shop", {"paymentIntegration": "none"}), ("machine", {"paymentIntegration": "agamento"})], True)
    assert (res.integration, res.source) == ("agamento", "machine")
    assert not PI.no_card(res) and not PI.no_card(None)
    # On a SynqPay terminal "none" is still none (never its built-in terminal).
    res = PI.resolve([("machine", {"paymentIntegration": "none"})], True, synqpay_device=True)
    assert res.integration == "none"


def test_none_is_a_valid_value_with_its_labels_and_no_required_fields():
    assert PI.INTEGRATIONS[-1] == "none" and "none" not in PI.RESERVED and "none" not in PI.EXTERNAL
    assert PI.LABELS_HE["none"] == "ללא אשראי (מזומן ואמצעים אחרים)"
    assert PI.REQUIRED_FIELDS["none"] == ()
    assert PI.validate_integration(" None ") == "none"
    assert PosSettingsV1Patch(paymentIntegration="none").payment_integration == "none"
    assert ShopCreate(name="S", companyId=uuid.uuid4(), paymentIntegration="none").payment_integration == "none"


def test_a_tablet_and_a_built_in_till_may_both_be_set_to_none(w):
    p18, f20 = w.tills
    p18.device_model = "P18"
    w.db.commit()
    _patch_machine(w, p18, paymentIntegration="none")
    _patch_machine(w, f20, paymentIntegration="none")
    assert p18.settings["paymentIntegration"] == f20.settings["paymentIntegration"] == "none"
    # "אוטומטי" removes it again.
    _patch_machine(w, f20, paymentIntegration="auto")
    assert "paymentIntegration" not in f20.settings


def test_the_context_offers_none_at_every_level(w):
    p18 = w.tills[0]
    p18.device_model = "P18"
    w.db.commit()
    _patch_machine(w, p18, paymentIntegration="none")
    with patch("app.routers.machines._machine_for_read", return_value=p18):
        ctx = pi_router.get_payment_integration_context(
            level="machine", target_id=str(p18.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
    options = {o["value"]: o for o in ctx["options"]}
    assert options["none"] == {
        "value": "none", "label": "ללא אשראי (מזומן ואמצעים אחרים)", "selectable": True, "reason": None,
    }
    assert ctx["requiredFields"]["none"] == []
    assert ctx["resolved"] == {"integration": "none", "source": "machine", "automatic": False, "missing": []}
    shop_ctx = pi_router.get_payment_integration_context(
        level="shop", target_id=str(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )
    assert {o["value"]: o["selectable"] for o in shop_ctx["options"]}["none"] is True


# ── The sync: card off, the layers untouched ────────────────────────────────


def test_the_sync_turns_the_three_card_switches_off_and_auto_brings_them_back(w):
    till, other = w.tills
    _patch_shop(w, payFastCardEnabled=True, payCardEnabled=True, payManualCardEnabled=True,
                payFastCardTips=True, payCardTips=True, payCashTips=False, payFastCashTips=False)
    before = _pulled(w, till)
    assert all(before[k] is True for k in CARD_KEYS)
    assert before["tipsEnabled"] is True

    _patch_machine(w, till, paymentIntegration="none")
    pulled = _pulled(w, till)
    assert pulled["paymentIntegration"] == "none"
    assert {k: pulled[k] for k in CARD_KEYS} == dict.fromkeys(CARD_KEYS, False)
    # No tip asked on a card that is not offered — for an older till's two switches too.
    assert (pulled["payFastCardTips"], pulled["payCardTips"], pulled["payManualCardTips"]) == (False, False, False)
    assert pulled["tipsEnabled"] is False
    # Cash stays as the layers say.
    assert pulled["payCashEnabled"] is True and pulled["payFastCashEnabled"] is True
    # Nothing stored changed: the shop keeps its switches, the till holds only its choice.
    assert all(w.shop.settings[k] is True for k in CARD_KEYS)
    assert till.settings == {"paymentIntegration": "none"}
    # The shop's other till is not touched.
    assert all(_pulled(w, other)[k] is True for k in CARD_KEYS)

    _patch_machine(w, till, paymentIntegration="auto")
    back = _pulled(w, till)
    assert "paymentIntegration" not in back
    assert all(back[k] is True for k in CARD_KEYS) and back["tipsEnabled"] is True


def test_a_shop_set_to_none_reaches_all_its_tills_and_a_till_may_opt_back(w):
    till, other = w.tills
    _patch_shop(w, paymentIntegration="none")
    assert _pulled(w, till)["payCardEnabled"] is False and _pulled(w, other)["payCardEnabled"] is False
    _patch_machine(w, other, paymentIntegration="agamento")
    assert _pulled(w, other)["paymentIntegration"] == "agamento"
    assert _pulled(w, other)["payCardEnabled"] is True


def test_no_secret_reaches_a_till_on_none(w):
    till = w.tills[0]
    _patch_shop(w, zcreditPassword=SHOP_PASS, zcreditTerminalNumber="0012345678")
    _patch_machine(w, till, paymentIntegration="none")
    pulled = _pulled(w, till)
    assert "zcreditPassword" not in pulled and "synqpayApiKey" not in pulled


def test_inherited_terminal_configuration_never_reaches_a_till_on_none(w):
    till, other = w.tills
    w.shop.settings = {"expectedTerminalNumber": "0882612", "forceTerminalNumber": True}
    w.db.commit()
    assert _pulled(w, other)["expectedTerminalNumber"] == "0882612"
    _patch_machine(w, till, paymentIntegration="none")
    pulled = _pulled(w, till)
    assert "expectedTerminalNumber" not in pulled
    assert pulled["forceTerminalNumber"] is False


# ── No terminal warnings ─────────────────────────────────────────────────────


def test_a_tablet_on_none_is_missing_nothing_and_asked_for_no_pinpad(w):
    p18 = w.tills[0]
    p18.device_model = "P18"
    w.db.commit()
    row = _row(w, p18)
    assert (row["pinpadRequired"], row["pinpadAddressMissing"], row["paymentIntegrationMissing"]) == (
        True, True, ["nayaxDeviceHost"],
    )
    _patch_machine(w, p18, paymentIntegration="none")
    row = _row(w, p18)
    assert (row["paymentIntegration"], row["paymentIntegrationSource"], row["paymentIntegrationAutomatic"]) == (
        "none", "machine", False,
    )
    assert row["paymentIntegrationMissing"] == []
    assert (row["pinpadRequired"], row["pinpadAddressMissing"]) == (False, False)


def test_no_terminal_number_mismatch_or_card_lock_on_none(w):
    till = w.tills[0]
    w.shop.settings = {"expectedTerminalNumber": "0882612", "nayaxEnabled": True, "nayaxDeviceHost": "10.0.0.5"}
    till.terminal_number = "1807770"
    till.terminal_reported_at = T0
    w.db.commit()
    row = _row(w, till)
    assert (row["terminalStatus"], row["cardLock"]) == ("mismatch", "not_configured")
    _patch_machine(w, till, paymentIntegration="none")
    row = _row(w, till)
    assert (row["terminalStatus"], row["cardLock"], row["pinpadRequired"]) == ("not_required", None, False)


def test_a_till_on_none_cannot_be_given_a_pinpad_address_by_the_relinker(w):
    from app.services import payment_terminal

    till = w.tills[0]
    _patch_machine(w, till, paymentIntegration="none", nayaxDeviceHost="10.0.0.5")
    with pytest.raises(payment_terminal.PinpadRelinkRefused) as refused:
        payment_terminal.relink_pinpad(w.db, till, host="10.0.0.9", reason="technician")
    assert refused.value.code == "pinpad_not_in_use"


# ── A kiosk on none ──────────────────────────────────────────────────────────

PINPAD = {"kind": "terminal", "key": "terminal", "reason": "unreachable", "detail": {"address": "192.168.0.167"}}
IDENTITY = {"kind": "terminal", "key": "terminal:identity", "reason": "terminal_not_configured", "detail": {}}
CARD = {"kind": "terminal", "key": "terminal:card", "reason": "card_unknown", "detail": {"amountAgorot": 100}}
OFFLINE = {"kind": "terminal", "key": "terminal:offline", "reason": "offline", "detail": {"since": "09:00"}}


def _open(w):
    return {r.key: r for r in w.db.query(KioskAlert).filter(KioskAlert.cleared_at.is_(None)).all()}


def test_a_kiosk_on_none_raises_no_terminal_alert_and_its_open_ones_close(k):
    w = k
    _kiosk_sync(w, {"alerts": [PINPAD, IDENTITY]})
    assert set(_open(w)) == {"terminal", "terminal:identity"}
    _patch_machine(w, w.kiosk, paymentIntegration="none")
    # An older kiosk build still reports its pinpad: dropped; the undecided card and the
    # internet stay staff's business.
    _kiosk_sync(w, {"alerts": [PINPAD, IDENTITY, CARD, OFFLINE]}, now=T0 + timedelta(seconds=15))
    assert set(_open(w)) == {"terminal:card", "terminal:offline"}
    gone = w.db.query(KioskAlert).filter(KioskAlert.key.in_(["terminal", "terminal:identity"])).all()
    assert {r.clear_reason for r in gone} == {OPS.CLEAR_NO_CARD}
    # The tills see only what is still open.
    assert sorted(a["reason"] for a in OPS.alerts_for_till(w.db, w.main, now=T0 + timedelta(seconds=20))) == [
        "card_unknown", "offline",
    ]
    # Their exceptions-log entries close by themselves; another kind of clear leaves "טופל" to people.
    spec = SRC.capture(w.db, SRC.by_name("kiosk_alert"), gone[0])[0]
    assert spec.close_only is True
    assert spec.ack[2] == "נסגר אוטומטית: הקיוסק הוגדר ללא אשראי"
    card = _open(w)["terminal:card"]
    spec = SRC.capture(w.db, SRC.by_name("kiosk_alert"), card)[0]
    assert (spec.close_only, spec.ack) == (False, None)


def test_back_on_auto_the_kiosks_terminal_alerts_are_raised_again(k):
    w = k
    _patch_machine(w, w.kiosk, paymentIntegration="none")
    _kiosk_sync(w, {"alerts": [PINPAD]})
    assert _open(w) == {}
    _patch_machine(w, w.kiosk, paymentIntegration="auto")
    _kiosk_sync(w, {"alerts": [PINPAD]}, now=T0 + timedelta(seconds=15))
    assert set(_open(w)) == {"terminal"}


def test_a_kiosk_on_none_has_no_card_lock_and_its_health_terminal_part_is_off(k):
    w = k
    device = w.db.get(KioskDevice, w.kiosk.id)
    identity = kiosk_control.summaries(w.db, [device], now=T0)[0]["terminalIdentity"]
    assert identity["noCard"] is False and identity["cardLock"] == "not_configured"
    _patch_machine(w, w.kiosk, paymentIntegration="none")
    identity = kiosk_control.summaries(w.db, [device], now=T0)[0]["terminalIdentity"]
    assert identity["noCard"] is True and identity["cardLock"] is None

    health = {"terminal": {"state": "not_configured"}}
    part = kiosk_health.terminal_part({"terminalIdentity": identity, "alerts": []}, health)
    assert (part["level"], part["code"]) == ("off", "no_card")
    # A card left undecided from before still needs someone.
    alerts = [{"kind": "terminal", "key": "terminal:card", "reason": "card_unknown"}]
    part = kiosk_health.terminal_part({"terminalIdentity": identity, "alerts": alerts}, health)
    assert (part["level"], part["code"]) == ("error", "card_unknown")


def test_saving_none_on_a_kiosk_without_pay_at_till_warns_and_saves(k):
    w = k
    out = _patch_machine(w, w.kiosk, paymentIntegration="none")
    assert w.kiosk.settings["paymentIntegration"] == "none"  # saved: a warning, never a refusal
    assert out.warnings == [{
        "code": "kiosk_no_payment_method",
        "message": "לקיוסק לא יישאר אמצעי תשלום",
        "machineIds": [str(w.kiosk.id)],
        "names": ["קיוסק רויאל"],
    }]
    assert out.model_dump(by_alias=True)["warnings"][0]["message"] == "לקיוסק לא יישאר אמצעי תשלום"
    # From the shop too: the kiosk under it is named.
    assert _patch_shop(w, paymentIntegration="none").warnings[0]["machineIds"] == [str(w.kiosk.id)]
    # "תשלום בקופה" on: nothing to warn of.
    assert _put_kiosk(w, {"payment": {"methods": ["card", "cash_at_till"]}})["warnings"] == []
    assert _patch_machine(w, w.kiosk, paymentIntegration="none").warnings == []
    # Turned off again on the kiosk's own page: that save warns.
    put = _put_kiosk(w, {"payment": {"methods": ["card"]}})
    assert [x["code"] for x in put["warnings"]] == ["kiosk_no_payment_method"]
    assert put["overrides"]["payment"]["methods"] == ["card"]


def test_no_warning_for_a_till_or_another_type(k):
    w = k
    assert _patch_machine(w, w.main, paymentIntegration="none").warnings == []
    assert _patch_machine(w, w.kiosk, paymentIntegration="nayax_lan").warnings == []
    # A save that does not touch the type says nothing.
    _patch_machine(w, w.kiosk, paymentIntegration="none")
    assert _patch_machine(w, w.kiosk, payCashEnabled=True).warnings == []


def test_kiosk_pays_at_till_reads_only_a_list_of_methods():
    assert PI.kiosk_pays_at_till({"payment": {"methods": ["voucher", "cash_at_till"]}})
    assert not PI.kiosk_pays_at_till({"payment": {"methods": ["card", "voucher", "split_card"]}})
    assert not PI.kiosk_pays_at_till({"payment": {"methods": "cash_at_till"}})
    assert not PI.kiosk_pays_at_till(None)
