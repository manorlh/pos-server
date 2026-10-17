"""
"מסופון אשראי" in the add-device dialog (app/services/device_terminal.py): the terminal type a till or a kiosk
gets, by platform and role, and its fields — stored on the pairing code and written to the machine's own
settings layer (the till parameters the device already reads) as it pairs.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse
from app.services import device_terminal as DT
from app.services import kiosk_control
from app.services import pairing as P
from app.services import payment_integration as PI
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    world.notified = []
    from app.services import settings_notify

    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda db, m, reason=None: world.notified.append(m.id))
    TP.ensure_builtin_parameters(world.db)
    world.db.commit()
    return world


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _seat(monkeypatch):
    def _assign(db, machine_id, shop_id):
        machine = db.get(POSMachine, machine_id)
        machine.shop_id = shop_id
        machine.pairing_status = PairingStatus.ASSIGNED
        db.flush()
        return machine

    monkeypatch.setattr(P, "assign_machine_to_shop", _assign)


def _code(w, *, role, terminal, platform="android", model=None, kiosk=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"T{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id, tenant_id=w.tenant.id,
        shop_id=w.shop.id, device_model=model, device_role=role, platform=platform,
        kiosk_options=kiosk if kiosk is not None else ({"controllerMachineIds": [], "lockDevice": False} if role == "kiosk" else None),
        terminal_options=terminal, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


class TestTypesPerDevice:
    def test_windows_kiosk_and_till_and_the_browser_kiosk(self):
        expected = ("auto", "nayax_lan", "nayax_usb", "synqpay", "none")
        assert DT.types_for("kiosk", "windows") == expected
        assert DT.types_for("till", "windows") == expected
        assert DT.types_for("kiosk", "web") == expected

    def test_android_kiosk_never_built_in_nor_tap_to_pay(self):
        assert DT.types_for("kiosk", "android", "N55F") == ("auto", "nayax_lan", "nayax_usb", "zcredit", "synqpay", "none")

    def test_android_till_built_in_only_with_a_terminal_of_its_own(self):
        assert DT.types_for("till", "android", "N55F") == (
            "auto", "agamento", "nayax_lan", "nayax_usb", "zcredit", "synqpay", "tap_to_pay", "none",
        )
        assert "agamento" not in DT.types_for("till", "android", "P18")
        assert DT.types_for(None, None)[1] == "agamento"  # an older dashboard: a till on Android

    def test_screens_and_servers_take_none(self):
        for role in ("kds", "order_status_board", "customer_display", "local_server", "cash_host"):
            assert DT.types_for(role, "android") == ()

    def test_every_type_offered_is_a_known_integration(self):
        for types in (DT.WINDOWS_TYPES, DT.ANDROID_KIOSK_TYPES, DT.ANDROID_TILL_TYPES):
            assert set(types) <= set(PI.INTEGRATIONS)
        assert set(DT.TYPE_KEYS) == set(PI.INTEGRATIONS)
        # Never a secret.
        for keys in DT.TYPE_KEYS.values():
            assert not set(keys) & set(PI.TILL_SECRET_KEYS)


class TestGenerate:
    def test_auto_or_absent_stores_nothing(self, w):
        assert _generate(w, deviceRole="till", deviceModel="N55F").terminal_options is None
        code = _generate(w, deviceRole="till", deviceModel="N55F", terminal={"paymentIntegration": "auto"})
        assert code.terminal_options is None

    def test_windows_kiosk_nayax_usb(self, w):
        code = _generate(
            w, shopId=w.shop.id, deviceRole="kiosk", platform="windows",
            terminal={"paymentIntegration": "nayax_usb", "nayaxUsbDevice": "0b00:3070"},
        )
        assert code.terminal_options == {"paymentIntegration": "nayax_usb", "nayaxUsbDevice": "0B00:3070"}
        body = PairingCodeResponse.model_validate(code).model_dump(by_alias=True)
        assert body["terminalOptions"]["paymentIntegration"] == "nayax_usb"

    def test_nayax_lan_with_an_address_is_the_kiosks_old_pinpad_write(self, w):
        code = _generate(
            w, shopId=w.shop.id, deviceRole="kiosk", platform="windows",
            terminal={"paymentIntegration": "nayax_lan", "nayaxDeviceHost": " 192.168.1.20 ", "nayaxDevicePort": "9000"},
            kiosk={"pinpadHost": "10.0.0.9"},
        )
        assert code.terminal_options == {
            "paymentIntegration": "nayax_lan", "nayaxEnabled": True, "nayaxDeviceHost": "192.168.1.20",
            "nayaxDevicePort": "9000", "nayaxSpicyPath": "/SPICy",
        }
        # The kiosk's old pinpad fields give way to the type chosen beside them.
        assert "pinpadHost" not in code.kiosk_options

    def test_synqpay_keeps_only_its_connections_fields(self, w):
        code = _generate(
            w, deviceRole="till", platform="windows",
            terminal={
                "paymentIntegration": "synqpay", "synqpayDeviceModel": "rx5000", "synqpayConnection": "usb",
                "synqpayHost": "10.0.0.5", "synqpayUsbDevice": "com3",
            },
        )
        assert code.terminal_options == {
            "paymentIntegration": "synqpay", "synqpayDeviceModel": "rx5000", "synqpayConnection": "usb",
            "synqpayUsbDevice": "COM3",
        }
        lan = _generate(
            w, deviceRole="till", platform="windows",
            terminal={
                "paymentIntegration": "synqpay", "synqpayDeviceModel": "dx8000", "synqpayConnection": "lan",
                "synqpayHost": "10.0.0.5", "synqpayPort": 9443, "synqpayTls": True, "synqpayUsbDevice": "COM3",
            },
        )
        assert lan.terminal_options == {
            "paymentIntegration": "synqpay", "synqpayDeviceModel": "dx8000", "synqpayConnection": "lan",
            "synqpayHost": "10.0.0.5", "synqpayPort": "9443", "synqpayTls": True,
        }

    def test_zcredit_and_tap_to_pay_take_no_secret(self, w):
        code = _generate(
            w, deviceRole="till", deviceModel="P18",
            terminal={"paymentIntegration": "zcredit", "zcreditTerminalNumber": "0882", "zcreditPinpadId": "PINPAD12", "zcreditMode": "test"},
        )
        assert code.terminal_options == {
            "paymentIntegration": "zcredit", "zcreditTerminalNumber": "0882", "zcreditPinpadId": "12", "zcreditMode": "test",
        }
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(terminal={"paymentIntegration": "zcredit", "zcreditPassword": "x"})
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(terminal={"paymentIntegration": "tap_to_pay", "tapToPayMerchantCode": "123456"})

    def test_none_on_a_kiosk_is_no_terminal(self, w):
        code = _generate(w, shopId=w.shop.id, deviceRole="kiosk", platform="android", terminal={"paymentIntegration": "none"})
        assert code.terminal_options == {"paymentIntegration": "none"}

    @pytest.mark.parametrize(
        "role, platform, model, kind",
        [
            ("kiosk", "windows", None, "zcredit"),
            ("till", "windows", None, "agamento"),
            ("till", "windows", None, "tap_to_pay"),
            ("kiosk", "android", "N55F", "tap_to_pay"),
            ("kiosk", "android", "N55F", "agamento"),
            ("till", "android", "P18", "agamento"),
        ],
    )
    def test_a_type_the_device_cannot_charge_on_is_refused_in_hebrew(self, w, role, platform, model, kind):
        status_code, body = _refusal(_generate(
            w, shopId=w.shop.id, deviceRole=role, platform=platform, deviceModel=model, terminal={"paymentIntegration": kind},
        ))
        assert (status_code, body["detail"], body["field"]) == (422, "device_terminal_unsupported", "paymentIntegration")
        assert any("֐" <= ch <= "׿" for ch in body["message"])

    def test_a_bad_field_is_refused_with_its_label(self, w):
        status_code, body = _refusal(_generate(
            w, deviceRole="till", platform="windows", terminal={"paymentIntegration": "nayax_lan", "nayaxDeviceHost": "http://x"},
        ))
        assert (status_code, body["detail"], body["field"]) == (422, "device_terminal_invalid", "nayaxDeviceHost")
        assert "כתובת IP של המסופון" in body["message"]
        status_code, body = _refusal(_generate(
            w, deviceRole="till", platform="windows", terminal={"paymentIntegration": "nayax_usb", "nayaxUsbDevice": "COM3"},
        ))
        assert (status_code, body["field"]) == (422, "nayaxUsbDevice")

    def test_a_screen_takes_no_terminal(self, w):
        status_code, body = _refusal(_generate(
            w, shopId=w.shop.id, deviceRole="kds", kds={"screenRole": "expo"}, terminal={"paymentIntegration": "nayax_lan"},
        ))
        assert (status_code, body["detail"]) == (422, "device_terminal_not_for_role")


class TestPairing:
    def test_a_windows_kiosk_gets_its_type_on_its_own_layer(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="kiosk", platform="windows", terminal={"paymentIntegration": "synqpay", "synqpayDeviceModel": "rx5000", "synqpayConnection": "usb"})
        machine = P.validate_pairing_code(w.db, code.code, {"platform": "windows"}, "Kiosk")
        assert w.db.get(KioskDevice, machine.id) is not None
        assert machine.settings["paymentIntegration"] == "synqpay"
        assert machine.settings["synqpayConnection"] == "usb"
        assert machine.id in w.notified
        assert PI.resolve_machine(w.db, machine).integration == "synqpay"

    def test_a_till_gets_nayax_lan_with_its_address(self, w, monkeypatch):
        _seat(monkeypatch)
        terminal = {"paymentIntegration": "nayax_lan", "nayaxEnabled": True, "nayaxDeviceHost": "10.0.0.7",
                    "nayaxDevicePort": "8080", "nayaxSpicyPath": "/SPICy"}
        code = _code(w, role="till", terminal=terminal, model="P18")
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert {k: machine.settings[k] for k in terminal} == terminal
        res = PI.resolve_machine(w.db, machine)
        assert (res.integration, res.source, res.missing) == ("nayax_lan", "machine", [])

    def test_no_terminal_on_a_kiosk_falls_back_to_the_till(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="kiosk", terminal={"paymentIntegration": "none"})
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert machine.settings["paymentIntegration"] == "none"
        # "קיוסק — כשאין מסופון אשראי" defaults to pay at the till: no "no payment" warning.
        assert PI.kiosk_warnings(w.db, [machine]) == []

    def test_a_choice_the_device_cannot_take_after_all_is_left_out(self, w, monkeypatch):
        _seat(monkeypatch)
        # Built-in chosen for a 55F code, but the device that redeems it says it is a P18.
        code = _code(w, role="till", terminal={"paymentIntegration": "agamento"}, model="N55F")
        machine = P.validate_pairing_code(w.db, code.code, {"model": "Nebullar P18"}, "Tab")
        assert machine is not None and machine.pairing_status == PairingStatus.ASSIGNED
        assert (machine.device_model, machine.has_builtin_terminal) == ("P18", False)
        assert "paymentIntegration" not in (machine.settings or {})

    def test_no_choice_writes_nothing(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="till", terminal=None)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert "paymentIntegration" not in (machine.settings or {})
        assert DT.apply_on_pairing(w.db, code, machine) is False

    def test_a_replacement_code_keeps_the_settings_it_had(self, w):
        code = _code(w, role="till", terminal={"paymentIntegration": "none"})
        code.target_machine_id = w.tills[0].id
        assert DT.apply_on_pairing(w.db, code, w.tills[0]) is False


class TestMigration:
    def _module(self, monkeypatch):
        import importlib.util
        from pathlib import Path
        from types import SimpleNamespace

        path = next(Path(__file__).absolute().parents[1].glob("alembic/versions/c7d2f9a4e1b8_*.py"))
        spec = importlib.util.spec_from_file_location("terminal_options_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "context", SimpleNamespace(is_offline_mode=lambda: False))
        return module

    def test_on_the_single_head(self):
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "c7d2f9a4e1b8" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("c7d2f9a4e1b8").down_revision == "b87054615214"

    def test_adds_the_column_once_and_drops_it(self, monkeypatch):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module(monkeypatch)
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.exec_driver_sql("CREATE TABLE pairing_codes (id CHAR(32) PRIMARY KEY, code VARCHAR(50))")
            for _ in range(2):  # idempotent: the second run finds it
                with Operations.context(MigrationContext.configure(conn)):
                    module.upgrade()
            columns = {c["name"]: c for c in sa.inspect(conn).get_columns("pairing_codes")}
            assert columns["terminal_options"]["nullable"] is True
            with Operations.context(MigrationContext.configure(conn)):
                module.downgrade()
            assert "terminal_options" not in {c["name"] for c in sa.inspect(conn).get_columns("pairing_codes")}
