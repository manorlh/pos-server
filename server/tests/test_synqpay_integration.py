"""
"סוג אינטגרציית אשראי" = SynqPay (docs/SPEC_SYNQPAY.md): the device model, the connection
(USB / LAN) and its parameters as managed settings, the API key write-only and encrypted.

* Validation of every field, as the dashboard and the till read them.
* What a till on an external SynqPay terminal still lacks: model, connection, and the
  host only on the network (lan) — USB finds its device itself. No API key: the till pairs with
  the terminal itself (test_synqpay_pairing.py). A till running ON a SynqPay
  terminal charges on it as its built-in terminal: no settings.
* The API key: never in a layer's JSON, encrypted, only to a till on SynqPay, redacted from logs.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.payment_secret import PaymentIntegrationSecret
from app.routers import machines as machines_router
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services import settings_notify
from app.services import terminal_config_guard
from app.services.settings_merge import MANAGED_SETTING_KEYS
from shift_world import accept_str_uuids, make_world

API_KEY = "1234abcd"


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


def _rows(w):
    return w.db.query(PaymentIntegrationSecret).all()


# ── The type ─────────────────────────────────────────────────────────────────


def test_synqpay_is_a_selectable_external_type():
    assert "synqpay" in PI.INTEGRATIONS and "synqpay" in PI.EXTERNAL
    assert "synqpay" not in PI.RESERVED
    assert PI.validate_integration(" SynqPay ") == "synqpay"
    assert PI.LABELS_HE["synqpay"] == "SynqPay — מסוף חיצוני"
    # A tablet (no terminal of its own) may choose it.
    res = PI.resolve([("machine", {"paymentIntegration": "synqpay"})], has_builtin_terminal=False)
    assert (res.integration, res.source, res.explicit) == ("synqpay", "machine", "synqpay")


def test_every_synqpay_key_is_managed_and_resettable():
    for key in (
        "synqpayDeviceModel", "synqpayConnection", "synqpayHost", "synqpayProtocol",
        "synqpayPort", "synqpayTls", "synqpayUsbDevice", "synqpaySerialNumber",
    ):
        assert key in MANAGED_SETTING_KEYS, key
        assert key in PI.RESETTABLE_KEYS, key
    # The API key is a secret: never a managed (JSON) setting.
    assert "synqpayApiKey" not in MANAGED_SETTING_KEYS
    assert "synqpayApiKey" in PS.SECRET_KEYS


# ── What a till on SynqPay still lacks ───────────────────────────────────────


def test_lan_needs_model_connection_and_host_never_a_key():
    res = PI.resolve([("machine", {"paymentIntegration": "synqpay"})], True)
    # No connection chosen: the host cannot be asked for yet.
    assert res.missing == ["synqpayDeviceModel", "synqpayConnection"]
    lan = {"paymentIntegration": "synqpay", "synqpayDeviceModel": "dx8000", "synqpayConnection": "lan"}
    res = PI.resolve([("machine", lan)], True)
    assert res.missing == ["synqpayHost"]
    res = PI.resolve([("machine", {**lan, "synqpayHost": "192.168.1.40"})], True)
    assert res.missing == []


def test_usb_needs_no_host():
    usb = {"paymentIntegration": "synqpay", "synqpayDeviceModel": "rx5000", "synqpayConnection": "usb"}
    assert PI.resolve([("machine", usb)], True).missing == []
    assert PI.SYNQPAY_CONNECTIONS == ("lan", "usb")


def test_on_a_synqpay_terminal_synqpay_is_its_own_built_in_terminal():
    # The owner: LAN / USB are for a till with an external terminal; on the terminal itself it is built-in.
    layers = [("machine", {"paymentIntegration": "synqpay"})]
    res = PI.resolve(layers, True, synqpay_device=True)
    assert (res.integration, res.source, res.missing) == ("agamento", "machine", [])
    assert PI.resolve(layers, True).integration == "synqpay"


# ── Field validation ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body, key, clean",
    [
        ({"synqpayDeviceModel": "DX8000"}, "synqpay_device_model", "dx8000"),
        ({"synqpayDeviceModel": "s1u2-m4"}, "synqpay_device_model", "s1u2_m4"),
        ({"synqpayConnection": "USB"}, "synqpay_connection", "usb"),
        ({"synqpayConnection": "usb_serial"}, "synqpay_connection", "usb"),
        ({"synqpayProtocol": "HTTP"}, "synqpay_protocol", "http"),
        ({"synqpayHost": " 192.168.1.40 "}, "synqpay_host", "192.168.1.40"),
        ({"synqpayHost": "Terminal-1.Local"}, "synqpay_host", "terminal-1.local"),
        ({"synqpayPort": 9000}, "synqpay_port", "9000"),
        ({"synqpayPort": " 8443 "}, "synqpay_port", "8443"),
        ({"synqpayPort": ""}, "synqpay_port", None),
        ({"synqpayUsbDevice": "0b00:0080"}, "synqpay_usb_device", "0B00:0080"),
        ({"synqpayUsbDevice": "com3"}, "synqpay_usb_device", "COM3"),
        ({"synqpayUsbDevice": " "}, "synqpay_usb_device", None),
        ({"synqpaySerialNumber": "244RKR528387"}, "synqpay_serial_number", "244RKR528387"),
        ({"synqpayTls": True}, "synqpay_tls", True),
    ],
)
def test_values_are_cleaned(body, key, clean):
    assert getattr(PosSettingsV1Patch(**body), key) == clean


@pytest.mark.parametrize(
    "body",
    [
        {"synqpayDeviceModel": "a920"},
        {"synqpayConnection": "bluetooth"},
        {"synqpayConnection": "usb_ip"},
        {"synqpayConnection": "builtin"},
        {"synqpayProtocol": "websocket"},
        {"synqpayHost": "http://192.168.1.40"},
        {"synqpayHost": "192.168.1.40:9000"},
        {"synqpayHost": "192.168.1.300"},
        {"synqpayPort": 0},
        {"synqpayPort": 70000},
        {"synqpayPort": "90a"},
        {"synqpayPort": True},
        {"synqpayUsbDevice": "0b00"},
        {"synqpayUsbDevice": "/dev/ttyS1"},
        {"synqpaySerialNumber": "ab"},
        {"synqpaySerialNumber": "244 RKR"},
    ],
)
def test_bad_values_are_refused(body):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch(**body)


def test_documented_ports():
    assert PI.synqpay_default_port(None, False) == 9000
    assert PI.synqpay_default_port("tcp", True) == 9443
    assert PI.synqpay_default_port("http", False) == 8000
    assert PI.synqpay_default_port("http", True) == 8443


# ── The API key: write-only, encrypted, only to a till on SynqPay ─────────────


def test_the_api_key_never_lands_in_the_settings_json(w):
    till = w.tills[0]
    res = _patch_machine(
        w, till, paymentIntegration="synqpay", synqpayDeviceModel="dx8000", synqpayConnection="lan",
        synqpayHost="192.168.1.40", synqpayApiKey=API_KEY,
    )
    assert "synqpayApiKey" not in till.settings and "synqpayApiKey" not in res.settings
    assert API_KEY not in str(till.settings)
    rows = _rows(w)
    assert [(r.level, r.key) for r in rows] == [("machine", "synqpayApiKey")]
    assert API_KEY not in rows[0].ciphertext
    assert PS.decrypt(rows[0].ciphertext) == API_KEY


def test_a_bad_api_key_is_a_422_that_never_echoes_it(w):
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, w.tills[0], synqpayApiKey="12 34-ab")
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "secret_invalid"
    assert "12 34" not in str(exc.value.detail)
    assert _rows(w) == []


def test_the_mask_keeps_and_null_removes_the_key(w):
    till = w.tills[0]
    _patch_machine(w, till, synqpayApiKey=API_KEY)
    _patch_machine(w, till, synqpayApiKey="••••")
    assert PS.decrypt(_rows(w)[0].ciphertext) == API_KEY
    _patch_machine(w, till, synqpayApiKey=None)
    assert _rows(w) == []


def test_only_a_till_on_synqpay_gets_the_key_with_its_settings(w):
    till, other = w.tills
    _patch_shop(w, synqpayApiKey=API_KEY, zcreditPassword="zc-pass")
    # Neither is on SynqPay yet: no key goes out.
    assert "synqpayApiKey" not in _pulled(w, till)
    _patch_machine(
        w, till, paymentIntegration="synqpay", synqpayDeviceModel="rx5000", synqpayConnection="usb",
        synqpayUsbDevice="0b00:0080", synqpayTls=False,
    )
    pulled = _pulled(w, till)
    assert pulled["paymentIntegration"] == "synqpay"
    assert pulled["synqpayApiKey"] == API_KEY
    # The Z-Credit password never goes to a till on SynqPay.
    assert "zcreditPassword" not in pulled
    assert (pulled["synqpayDeviceModel"], pulled["synqpayConnection"], pulled["synqpayUsbDevice"]) == (
        "rx5000", "usb", "0B00:0080",
    )
    assert pulled["synqpayTls"] is False
    assert "synqpayApiKey" not in _pulled(w, other)


def test_the_api_key_is_redacted_from_the_request_log():
    from app.observability.body_logging import redact_json

    logged = redact_json({"synqpayApiKey": API_KEY, "synqpayHost": "10.0.0.1"})
    assert API_KEY not in str(logged) and logged["synqpayHost"] == "10.0.0.1"


def test_the_context_lists_synqpay_and_its_key_status(w):
    till = w.tills[0]
    _patch_machine(w, till, paymentIntegration="synqpay", synqpayConnection="lan", synqpayApiKey=API_KEY)
    with patch("app.routers.machines._machine_for_read", return_value=till):
        ctx = pi_router.get_payment_integration_context(
            level="machine", target_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
    options = {o["value"]: o for o in ctx["options"]}
    assert options["synqpay"]["selectable"] is True
    assert ctx["secrets"]["synqpayApiKey"]["set"] is True and ctx["secrets"]["synqpayApiKey"]["own"] is True
    assert ctx["resolved"]["integration"] == "synqpay"
    assert ctx["resolved"]["missing"] == ["synqpayDeviceModel", "synqpayHost"]
    assert ctx["requiredFields"]["synqpay"] == ["synqpayDeviceModel", "synqpayConnection", "synqpayHost"]
    assert API_KEY not in str(ctx)


def test_a_synqpay_till_never_inherits_terminal_configuration():
    class Till:
        is_kiosk = False
        has_builtin_terminal = True

    assert terminal_config_guard.charges_on_external_pinpad(Till(), {"paymentIntegration": "synqpay"})
