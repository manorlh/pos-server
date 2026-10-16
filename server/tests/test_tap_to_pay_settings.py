"""
Tap to Pay's settings (P:/specs/tap-to-pay.md; app/services/payment_integration.py).

* `tap_to_pay` may be picked on any layer (no longer reserved) and asks for its TPN, merchant
  code and environment; it stays off until a layer picks it.
* The merchant code is a secret like the Z-Credit password: never in a layer's JSON, encrypted
  at rest, a masked echo keeps it, `null` removes it, redacted from the request log, and only a
  till that charges on Tap to Pay gets it in its sync.
* The TPN and the environment are ordinary managed keys, validated and sent to the till.
* Not on a kiosk and not on a device that reported no NFC: a 422 on the till's own layer, and
  the context's option says why.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.payment_secret import PaymentIntegrationSecret
from app.models.pos_machine import set_kiosk_cache
from app.routers import machines as machines_router
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services import settings_notify
from shift_world import accept_str_uuids, make_world

#: Made-up values, never a real merchant's.
CODE = "123456789012"
TPN = "T2PTEST00001"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(settings_router, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_company_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _patch_machine(w, till, **body):
    data = PosSettingsV1Patch(**body)
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=data, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )


def _patch_shop(w, **body):
    data = PosSettingsV1Patch(**body)
    with patch.object(settings_router, "_check_shop_settings_write", lambda *a: None):
        return settings_router.patch_shop_settings(
            shop_id=str(w.shop.id), data=data, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )


def _pulled(w, till):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db).settings


def _context(w, till):
    with patch("app.routers.machines._machine_for_read", return_value=till):
        return pi_router.get_payment_integration_context(
            level="machine", target_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )


def _rows(w):
    return w.db.query(PaymentIntegrationSecret).all()


# ── Values ───────────────────────────────────────────────────────────────────


def test_tap_to_pay_is_selectable_external_and_off_by_default():
    assert PI.RESERVED == ()
    assert PI.validate_integration("Tap-To-Pay") == "tap_to_pay"
    assert "tap_to_pay" in PI.EXTERNAL
    # Nothing chosen: today's behaviour, never Tap to Pay.
    assert PI.resolve([("shop", {})], True).integration == "agamento"
    assert PI.resolve([("shop", {})], False).integration == "nayax_lan"


def test_it_needs_a_tpn_a_merchant_code_and_an_environment():
    assert PI.REQUIRED_FIELDS["tap_to_pay"] == ("tapToPayTpn", "tapToPayMerchantCode", "tapToPayEnvironment")
    full = {"paymentIntegration": "tap_to_pay", "tapToPayTpn": TPN, "tapToPayEnvironment": "sandbox"}
    assert PI.resolve([("shop", full)], False).missing == ["tapToPayMerchantCode"]
    assert PI.resolve([("shop", full)], False, secrets_set=["tapToPayMerchantCode"]).missing == []


@pytest.mark.parametrize("raw, clean", [("sandbox", "sandbox"), (" Production ", "production"), ("test", "sandbox"),
                                        ("UAT", "sandbox"), ("", None)])
def test_the_environment_is_sandbox_or_production(raw, clean):
    assert PosSettingsV1Patch(tapToPayEnvironment=raw).tap_to_pay_environment == clean


@pytest.mark.parametrize("raw, clean", [(" 123456789012 ", "123456789012"), ("Z11TPN12ab", "Z11TPN12ab"), ("", None)])
def test_a_tpn_is_letters_and_digits_kept_as_typed(raw, clean):
    assert PosSettingsV1Patch(tapToPayTpn=raw).tap_to_pay_tpn == clean


@pytest.mark.parametrize("body", [{"tapToPayEnvironment": "live"}, {"tapToPayTpn": "12-34"}, {"tapToPayTpn": "abc"},
                                  {"tapToPayTpn": "1" * 21}])
def test_bad_values_are_refused(body):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch(**body)


@pytest.mark.parametrize("bad", ["12345", "1234 5678 9012", "x" * 33, "abc\n123456"])
def test_a_bad_merchant_code_is_a_422_that_never_echoes_it(w, bad):
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, w.tills[0], tapToPayMerchantCode=bad)
    assert exc.value.status_code == 422 and exc.value.detail["code"] == "secret_invalid"
    assert bad not in str(exc.value.detail)
    assert _rows(w) == []


def test_the_merchant_code_is_redacted_from_the_request_log():
    from app.observability.body_logging import redact_json

    logged = redact_json({"tapToPayMerchantCode": CODE, "tapToPayTpn": TPN})
    assert CODE not in str(logged) and logged["tapToPayTpn"] == TPN


# ── The secret ───────────────────────────────────────────────────────────────


def test_the_merchant_code_never_lands_in_the_settings_json(w):
    till = w.tills[0]
    res = _patch_machine(w, till, paymentIntegration="tap_to_pay", tapToPayTpn=TPN, tapToPayEnvironment="sandbox",
                         tapToPayMerchantCode=CODE)
    assert till.settings == {"paymentIntegration": "tap_to_pay", "tapToPayTpn": TPN, "tapToPayEnvironment": "sandbox"}
    assert CODE not in str(res.model_dump())
    rows = _rows(w)
    assert [(r.level, r.key) for r in rows] == [("machine", "tapToPayMerchantCode")]
    assert CODE not in rows[0].ciphertext and PS.decrypt(rows[0].ciphertext) == CODE
    ctx = _context(w, till)
    assert ctx["secrets"]["tapToPayMerchantCode"]["set"] is True
    assert CODE not in str(ctx)
    assert ctx["resolved"] == {"integration": "tap_to_pay", "source": "machine", "automatic": False, "missing": []}


def test_the_mask_keeps_and_null_removes(w):
    till = w.tills[0]
    _patch_machine(w, till, tapToPayMerchantCode=CODE)
    _patch_machine(w, till, tapToPayMerchantCode="••••")
    assert PS.decrypt(_rows(w)[0].ciphertext) == CODE
    _patch_machine(w, till, tapToPayMerchantCode=None)
    assert _rows(w) == []


def test_a_shops_settings_reach_its_tills_with_the_code_only_on_tap_to_pay(w):
    till, other = w.tills
    _patch_shop(w, paymentIntegration="tap_to_pay", tapToPayTpn=TPN, tapToPayEnvironment="production",
                tapToPayMerchantCode=CODE)
    pulled = _pulled(w, till)
    assert pulled["paymentIntegration"] == "tap_to_pay"
    assert (pulled["tapToPayTpn"], pulled["tapToPayEnvironment"], pulled["tapToPayMerchantCode"]) == (
        TPN, "production", CODE,
    )
    # Another type on the till's own layer: the code stays in the cloud (the TPN is no secret).
    _patch_machine(w, other, paymentIntegration="nayax_lan", nayaxDeviceHost="10.0.0.9")
    pulled = _pulled(w, other)
    assert pulled["paymentIntegration"] == "nayax_lan"
    assert "tapToPayMerchantCode" not in pulled
    assert "zcreditPassword" not in pulled


def test_a_till_not_on_tap_to_pay_never_gets_the_code(w):
    till = w.tills[0]
    _patch_shop(w, tapToPayMerchantCode=CODE, tapToPayTpn=TPN)
    pulled = _pulled(w, till)
    assert "tapToPayMerchantCode" not in pulled
    assert "paymentIntegration" not in pulled


def test_auto_and_null_reset_the_layers_own_values(w):
    till = w.tills[0]
    _patch_machine(w, till, paymentIntegration="tap_to_pay", tapToPayTpn=TPN, tapToPayEnvironment="sandbox")
    _patch_machine(w, till, paymentIntegration="auto", tapToPayTpn=None, tapToPayEnvironment=None)
    assert not any(k in (till.settings or {}) for k in ("paymentIntegration", "tapToPayTpn", "tapToPayEnvironment"))


# ── Where it cannot work: a kiosk, a device without NFC ─────────────────────


def test_on_a_kiosk_it_is_a_422_and_the_option_says_why(w):
    kiosk = w.tills[0]
    set_kiosk_cache(kiosk, True)
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, kiosk, paymentIntegration="tap_to_pay")
    assert exc.value.status_code == 422 and exc.value.detail["code"] == "tap_to_pay_not_on_kiosk"
    assert "paymentIntegration" not in (kiosk.settings or {})
    ctx = _context(w, kiosk)
    options = {o["value"]: o for o in ctx["options"]}
    assert (options["tap_to_pay"]["selectable"], options["tap_to_pay"]["reason"]) == (False, "not_on_kiosk")
    assert ctx["isKiosk"] is True


def test_on_a_device_without_nfc_it_is_a_422_and_the_option_says_why(w):
    till = w.tills[0]
    till.device_info = {"nfc": False}
    w.db.commit()
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, till, paymentIntegration="tap_to_pay")
    assert exc.value.status_code == 422 and exc.value.detail["code"] == "tap_to_pay_needs_nfc"
    options = {o["value"]: o for o in _context(w, till)["options"]}
    assert (options["tap_to_pay"]["selectable"], options["tap_to_pay"]["reason"]) == (False, "needs_nfc")


def test_a_device_with_nfc_or_unknown_may_take_it(w):
    p18, other = w.tills
    p18.device_model = "P18"
    w.db.commit()
    _patch_machine(w, p18, paymentIntegration="tap_to_pay")
    assert p18.settings["paymentIntegration"] == "tap_to_pay"
    # Unknown NFC: allowed (the till itself says so when it has none).
    _patch_machine(w, other, paymentIntegration="tap_to_pay")
    assert other.settings["paymentIntegration"] == "tap_to_pay"
    options = {o["value"]: o for o in _context(w, p18)["options"]}
    assert options["tap_to_pay"]["selectable"] is True


def test_an_inherited_terminal_config_never_reaches_a_till_on_tap_to_pay(w):
    from app.services.terminal_config_guard import charges_on_external_pinpad

    till = w.tills[0]
    assert charges_on_external_pinpad(till, {"paymentIntegration": "tap_to_pay"}) is True
    assert charges_on_external_pinpad(till, {}) is False


def test_the_machines_list_names_tap_to_pay_and_what_is_missing(w):
    till = w.tills[0]
    _patch_shop(w, paymentIntegration="tap_to_pay", tapToPayTpn=TPN)
    rows = {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}
    row = rows[till.id]
    assert (row["paymentIntegration"], row["paymentIntegrationSource"]) == ("tap_to_pay", "shop")
    assert row["paymentIntegrationMissing"] == ["tapToPayMerchantCode", "tapToPayEnvironment"]
