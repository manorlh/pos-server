"""
"צימוד מסוף SynqPay" from the till (docs/SPEC_SYNQPAY.md §2.2): nobody types an API key.

* **Valid without a key** — a SynqPay integration needs model, connection (and host on the
  network); the key is the till's pairing, not a field the form must have.
* **The pairing endpoint** — a manager's write (a signed-in manager or a grant; a cashier is
  sent to find one), stored encrypted on the MACHINE's layer, never echoed, with when / which
  till / whose authority / the serial; a key typed earlier on the machine is replaced; a till
  not on an external SynqPay terminal is refused; the serial lands on the till's layer when no
  layer names one.
* **The refusal report** — marks the key the till uses, once, without moving its time; a new
  key clears it; a till with no key records nothing.
* **The dashboard's status** — where the key came from and whether it was refused, never the value.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.main import app
from app.middleware.auth import CatalogActor, require_catalog_authority
from app.models.payment_secret import PaymentIntegrationSecret
from app.models.pos_user import PosUser, PosUserRole
from app.routers import machines as machines_router
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.routers import synqpay_pairing as R
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.synqpay_pairing import SynqpayKeyRejectedIn, SynqpayPairingIn
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services import settings_notify
from app.services.permissions import Scope
from shift_world import accept_str_uuids, make_world

KEY = "1234abcd"
SERIAL = "244RKR528387"

LAN = {
    "paymentIntegration": "synqpay",
    "synqpayDeviceModel": "dx8000",
    "synqpayConnection": "lan",
    "synqpayHost": "192.168.1.40",
}


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
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def _on_synqpay(w, till, **extra):
    _patch_machine(w, till, **{**LAN, **extra})


def _pair(w, till, key=KEY, serial=SERIAL, actor=None):
    return R.store_synqpay_pairing(
        str(till.id),
        SynqpayPairingIn.model_validate({"synqpayApiKey": key, "serialNumber": serial}),
        machine=till,
        actor=actor or CatalogActor(pos_user_id=uuid.uuid4()),
        db=w.db,
    )


def _reject(w, till, detail="HTTP 401"):
    return R.report_synqpay_key_rejected(
        str(till.id), SynqpayKeyRejectedIn(detail=detail), machine=till, db=w.db,
    )


def _rows(w):
    return w.db.query(PaymentIntegrationSecret).all()


def _pulled(w, till):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db).settings


def _context(w, till):
    with patch("app.routers.machines._machine_for_read", return_value=till):
        return pi_router.get_payment_integration_context(
            level="machine", target_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )


def _manager(w, role=PosUserRole.SHOP_MANAGER, shop=None):
    user = PosUser(
        id=uuid.uuid4(), shop_id=(shop or w.shop).id, tenant_id=w.tenant.id, username=f"u{uuid.uuid4().hex[:6]}",
        first_name="Dana", last_name="Levi", pin_hash="x", role=role, is_active=True, pin_failed_count=0,
    )
    w.db.add(user)
    w.db.commit()
    return user


# ── A SynqPay integration is valid without a key ──────────────────────────────


class TestNoKeyNeeded:
    def test_a_lan_till_is_complete_without_a_key(self):
        assert PI.REQUIRED_FIELDS["synqpay"] == ("synqpayDeviceModel", "synqpayConnection", "synqpayHost")
        assert PI.resolve([("machine", LAN)], True).missing == []
        usb = {"paymentIntegration": "synqpay", "synqpayDeviceModel": "rx5000", "synqpayConnection": "usb"}
        assert PI.resolve([("machine", usb)], True).missing == []

    def test_the_form_saves_and_the_context_lacks_nothing(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        ctx = _context(w, till)
        assert ctx["resolved"]["integration"] == "synqpay"
        assert ctx["resolved"]["missing"] == []
        assert "synqpayApiKey" not in ctx["requiredFields"]["synqpay"]
        status = ctx["secrets"]["synqpayApiKey"]
        assert status["set"] is False
        assert status["pairing"]["origin"] is None and status["pairing"]["rejectedAt"] is None

    def test_a_till_with_no_key_gets_none_in_its_sync(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        pulled = _pulled(w, till)
        assert pulled["paymentIntegration"] == "synqpay"
        assert "synqpayApiKey" not in pulled


# ── The pairing endpoint ──────────────────────────────────────────────────────


class TestPairing:
    def test_stored_encrypted_on_the_machine_with_who_and_when(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        manager_id = uuid.uuid4()
        out = _pair(w, till, actor=CatalogActor(pos_user_id=manager_id))
        assert KEY not in str(out)
        assert out["origin"] == "till_pairing" and out["serialNumber"] == SERIAL
        [row] = _rows(w)
        assert (row.level, row.entity_id, row.key) == ("machine", till.id, "synqpayApiKey")
        assert KEY not in row.ciphertext and PS.decrypt(row.ciphertext) == KEY
        assert row.origin == "till_pairing"
        assert row.paired_at is not None
        assert row.paired_by_machine_id == till.id
        assert row.paired_by_pos_user_id == manager_id and row.paired_by_user_id is None
        assert row.terminal_serial == SERIAL
        assert row.rejected_at is None
        assert till.settings_updated_at is not None

    def test_a_cloud_accounts_grant_is_recorded_as_the_user(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till, actor=CatalogActor(user_id=w.admin.id))
        [row] = _rows(w)
        assert row.paired_by_user_id == w.admin.id and row.paired_by_pos_user_id is None
        assert row.updated_by == w.admin.id

    def test_the_till_gets_its_own_key_back_with_its_settings(self, w):
        till, other = w.tills
        _on_synqpay(w, till)
        _pair(w, till)
        assert _pulled(w, till)["synqpayApiKey"] == KEY
        # Machine level: the other till of the shop has none.
        _on_synqpay(w, other)
        assert "synqpayApiKey" not in _pulled(w, other)

    def test_a_new_pairing_replaces_a_key_typed_by_hand(self, w):
        till = w.tills[0]
        _on_synqpay(w, till, synqpayApiKey="abcd0000")
        [row] = _rows(w)
        assert row.origin == "dashboard"
        _pair(w, till, key="feed1234")
        [row] = _rows(w)
        assert PS.decrypt(row.ciphertext) == "feed1234"
        assert row.origin == "till_pairing"

    def test_a_key_typed_by_hand_after_a_pairing_forgets_the_pairing(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        _patch_machine(w, till, synqpayApiKey="abcd0000")
        [row] = _rows(w)
        assert row.origin == "dashboard"
        assert row.paired_at is None and row.paired_by_machine_id is None and row.terminal_serial is None

    @pytest.mark.parametrize("bad", ["", "12 34-ab", "x" * 65, "1234abcd!", "12\n34"])
    def test_a_bad_key_is_a_422_that_never_echoes_it(self, w, bad):
        till = w.tills[0]
        _on_synqpay(w, till)
        with pytest.raises(HTTPException) as exc:
            _pair(w, till, key=bad)
        assert exc.value.status_code == 422
        assert exc.value.detail == {"code": "secret_invalid"}
        assert _rows(w) == []

    def test_a_non_text_key_is_no_key(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        body = SynqpayPairingIn.model_validate({"synqpayApiKey": 12345678})
        assert body.key_or_none() is None

    def test_the_key_never_prints(self):
        body = SynqpayPairingIn.model_validate({"synqpayApiKey": KEY, "serialNumber": SERIAL})
        assert KEY not in repr(body) and KEY not in str(body)

    def test_a_bad_serial_is_refused(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            SynqpayPairingIn.model_validate({"synqpayApiKey": KEY, "serialNumber": "ab"})
        assert SynqpayPairingIn.model_validate({"synqpayApiKey": KEY, "serialNumber": " "}).serial_number is None

    def test_a_till_not_on_synqpay_is_refused(self, w):
        till = w.tills[0]
        with pytest.raises(HTTPException) as exc:
            _pair(w, till)
        assert exc.value.status_code == 409 and exc.value.detail == {"code": "not_synqpay"}
        assert _rows(w) == []

    def test_a_till_on_a_synqpay_terminal_itself_needs_no_key(self, w):
        till = w.tills[0]
        till.device_model = "SYNQPAY_DX8000"
        _on_synqpay(w, till)
        with pytest.raises(HTTPException) as exc:
            _pair(w, till)
        assert exc.value.status_code == 409
        assert _rows(w) == []

    def test_the_serial_lands_on_the_tills_layer_when_none_is_set(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        assert till.settings["synqpaySerialNumber"] == SERIAL

    def test_a_serial_set_in_the_dashboard_is_kept(self, w):
        till = w.tills[0]
        _on_synqpay(w, till, synqpaySerialNumber="ABC-1234")
        _pair(w, till)
        assert till.settings["synqpaySerialNumber"] == "ABC-1234"

    def test_a_managers_write(self, w):
        dependency = require_catalog_authority(Scope.CATALOG_WRITE)
        till = w.tills[0]
        with pytest.raises(HTTPException) as exc:
            dependency(machine=till, elevation_token=None, operator_id=None, db=w.db)
        assert exc.value.status_code == 401
        cashier = _manager(w, role=PosUserRole.CASHIER)
        with pytest.raises(HTTPException) as exc:
            dependency(machine=till, elevation_token=None, operator_id=str(cashier.id), db=w.db)
        assert exc.value.status_code == 401 and exc.value.detail == "elevation_required"
        manager = _manager(w)
        actor = dependency(machine=till, elevation_token=None, operator_id=str(manager.id), db=w.db)
        assert actor.pos_user_id == manager.id
        route = next(
            r for r in app.routes
            if getattr(r, "path", "") == "/api/v1/sync/{machine_id}/synqpay/pairing" and "POST" in getattr(r, "methods", ())
        )
        names = {dep.call.__qualname__ for dep in route.dependant.dependencies}
        assert any("require_catalog_authority" in n for n in names), names
        assert any("get_pos_machine_for_sync_path" in n for n in names), names

    def test_the_refusal_report_needs_only_the_machine_token(self):
        route = next(
            r for r in app.routes
            if getattr(r, "path", "") == "/api/v1/sync/{machine_id}/synqpay/key-rejected" and "POST" in getattr(r, "methods", ())
        )
        names = {dep.call.__qualname__ for dep in route.dependant.dependencies}
        assert any("get_pos_machine_for_sync_path" in n for n in names), names
        assert not any("require_catalog_authority" in n for n in names), names

    def test_the_key_is_redacted_from_the_request_log(self):
        from app.observability.body_logging import redact_json

        logged = redact_json({"synqpayApiKey": KEY, "serialNumber": SERIAL})
        assert KEY not in str(logged) and logged["serialNumber"] == SERIAL


# ── The refusal report ────────────────────────────────────────────────────────


class TestRejected:
    def test_marked_once_without_moving_the_keys_time(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        [row] = _rows(w)
        paired_at, updated_at = row.paired_at, row.updated_at
        out = _reject(w, till)
        assert out["recorded"] is True and out["rejectedAt"] is not None
        w.db.refresh(row)
        first = row.rejected_at
        assert row.rejected_by_machine_id == till.id
        assert row.paired_at == paired_at and row.updated_at == updated_at
        _reject(w, till, detail="again")
        w.db.refresh(row)
        assert row.rejected_at == first

    def test_a_new_pairing_clears_it(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        _reject(w, till)
        _pair(w, till, key="feed1234")
        [row] = _rows(w)
        assert row.rejected_at is None and row.rejected_by_machine_id is None

    def test_a_shop_level_key_typed_by_hand_is_the_one_marked(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        with patch.object(settings_router, "_check_shop_settings_write", lambda *a: None):
            settings_router.patch_shop_settings(
                shop_id=str(w.shop.id), data=PosSettingsV1Patch(synqpayApiKey=KEY), current_user=w.admin,
                active_tenant_id=w.tenant.id, db=w.db,
            )
        _reject(w, till)
        [row] = _rows(w)
        assert row.level == "shop" and row.rejected_by_machine_id == till.id

    def test_a_till_with_no_key_records_nothing(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        out = _reject(w, till)
        assert out == {"recorded": False, "rejectedAt": None}
        assert _rows(w) == []


# ── What the dashboard is told ────────────────────────────────────────────────


class TestStatus:
    def test_paired_by_which_till_and_when_never_the_key(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        ctx = _context(w, till)
        status = ctx["secrets"]["synqpayApiKey"]
        assert status["set"] is True and status["own"] is True and status["source"] == "machine"
        p = status["pairing"]
        assert p["origin"] == "till_pairing"
        assert isinstance(p["pairedAt"], datetime)
        assert p["pairedByMachineId"] == str(till.id) and p["pairedByMachineName"] == till.name
        assert p["terminalSerial"] == SERIAL
        assert p["rejectedAt"] is None
        assert KEY not in str(ctx)

    def test_rejected_by_which_till(self, w):
        till = w.tills[0]
        _on_synqpay(w, till)
        _pair(w, till)
        _reject(w, till)
        p = _context(w, till)["secrets"]["synqpayApiKey"]["pairing"]
        assert p["rejectedAt"] is not None and p["rejectedByMachineName"] == till.name

    def test_a_key_typed_by_hand_says_so(self, w):
        till = w.tills[0]
        _on_synqpay(w, till, synqpayApiKey=KEY)
        p = _context(w, till)["secrets"]["synqpayApiKey"]["pairing"]
        assert p["origin"] == "dashboard" and p["pairedAt"] is None

    def test_store_till_pairing_refuses_a_bad_key(self, w):
        with pytest.raises(PS.PaymentSecretError):
            PS.store_till_pairing(w.db, w.tills[0], "12 34", now=datetime(2026, 10, 7, tzinfo=timezone.utc))
