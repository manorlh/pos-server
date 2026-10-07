"""
PAX A77 and Urovo i9100 in the device-model list (app/models/vendor_devices.py).

* Both charge on Nayax's Agamento with its TweezerComm (TC) service, like the F20: a terminal
  of their own — as long as the till found Agamento on the unit when it paired.
* Both print on a 58 mm head of their own through the vendor's API (the till: Urovo's
  PrinterManager, PAX's NeptuneLite); the Urovo has a scan head.
* Detection: maker or brand (PAX; UROVO / UBX), then the model; nothing else is claimed.

The golden fixture is shared with pos-android (`app/src/test/resources/`, the same bytes):
the till's VendorDevices.kt is pinned by the same table and the same detection cases.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.models.pairing_code import PairingCode
from app.models.pos_machine import (
    DEVICE_MODELS,
    POSMachine,
    detect_device_model,
    device_capabilities,
)
from app.models.vendor_devices import (
    VENDOR_DEVICE_MODEL_IDS,
    VENDOR_DEVICE_MODELS,
    detect_vendor_device,
    machine_has_builtin_terminal,
    normalize_vendor_model,
    reports_agamento,
    vendor_device_model,
)
from app.routers import machines as machines_router
from app.schemas.pairing_code import PairingCodeGenerateRequest
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.transmission import ReplacementCodeBody
from app.services import pairing as P
from shift_world import accept_str_uuids, make_world

GOLDEN = Path(__file__).parent / "fixtures" / "vendor_devices_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: VendorDevicesTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "958b271a20c0cbac75aa215fdd91cb9c84c36bfad0bf20827c43c435be1fb0a7"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _golden() -> dict:
    return json.loads(_text(GOLDEN))


def _info(case: dict) -> dict:
    info = {"manufacturer": case["manufacturer"], "brand": case["brand"], "model": case["model"], "platform": "android"}
    if case["agamento"] is not None:
        info["agamento"] = case["agamento"]
    return info


class TestFixture:
    def test_the_fixture_is_the_pinned_one(self):
        assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256

    def test_the_till_has_the_same_fixture(self):
        if not SIBLING.exists():
            pytest.skip("pos-android is not checked out beside pos-server")
        assert _text(SIBLING) == _text(GOLDEN)

    def test_the_table_is_the_fixtures_table(self):
        rows = [
            {"id": m.id, "makers": list(m.makers), "prefixes": list(m.prefixes), "printer": m.printer,
             "paperMm": m.paper_mm, "cutter": m.cutter, "drawerPort": m.drawer_port, "scanner": m.scanner,
             "builtinTerminal": m.builtin_terminal, "printSdk": m.print_sdk}
            for m in VENDOR_DEVICE_MODELS
        ]
        assert rows == _golden()["models"]

    @pytest.mark.parametrize("case", _golden()["detect"], ids=lambda c: f"{c['manufacturer']}/{c['model']}/{c['agamento']}")
    def test_detection_matches_the_fixture(self, case):
        info = _info(case)
        assert detect_vendor_device(info) == case["expected"]
        if case["expected"] is None:
            assert detect_device_model(info) not in VENDOR_DEVICE_MODEL_IDS
        else:
            assert detect_device_model(info) == case["expected"]
            machine = POSMachine(device_model=case["expected"], device_info=info)
            assert machine.has_builtin_terminal is case["builtinTerminal"]


class TestTable:
    def test_every_model_is_a_device_model_that_fits_the_column(self):
        assert set(VENDOR_DEVICE_MODEL_IDS) <= set(DEVICE_MODELS)
        assert all(len(m) <= 16 for m in VENDOR_DEVICE_MODEL_IDS)

    @pytest.mark.parametrize(
        "model, scanner",
        [("PAX_A77", False), ("UROVO_I9100", True)],
    )
    def test_capabilities(self, model, scanner):
        caps = device_capabilities(model)
        assert caps == {
            "builtinPrinter": True,
            "builtinTerminal": True,
            "cashDrawerPort": False,
            "driverPending": False,
            "paperWidthMm": 58,
            "builtinScanner": scanner,
        }
        # A kiosk charges on an external pinpad whatever the model.
        assert device_capabilities(model, kiosk=True)["builtinTerminal"] is False

    def test_a_machine_not_paired_yet_has_its_models_terminal(self):
        # Chosen on the dashboard, nothing reported: the model's own word (Agamento, like an F20).
        assert POSMachine(device_model="PAX_A77").has_builtin_terminal is True
        assert POSMachine(device_model="UROVO_I9100", device_info={}).has_builtin_terminal is True

    def test_no_agamento_on_the_unit_means_no_builtin_terminal(self):
        info = {"manufacturer": "UROVO", "model": "i9100", "platform": "android"}
        assert reports_agamento(info) is False
        assert machine_has_builtin_terminal("UROVO_I9100", info) is False
        assert POSMachine(device_model="UROVO_I9100", device_info=info).has_builtin_terminal is False
        assert reports_agamento({**info, "agamento": "true"}) is True
        assert reports_agamento({**info, "agamento": True}) is True
        assert reports_agamento(None) is None

    def test_other_models_keep_their_rules(self):
        assert machine_has_builtin_terminal("N55F", {"agamento": "true"}) is None
        # The F20 / 55F is not claimed, with or without Agamento: it stays a 55F (NULL).
        assert detect_device_model({"manufacturer": "Feitian", "model": "F20", "agamento": "true"}) is None
        assert POSMachine(device_model="N55F", device_info={"model": "F20"}).has_builtin_terminal is True
        assert vendor_device_model("SUNMI_T2") is None and vendor_device_model(None) is None

    def test_sunmi_t2_is_still_a_sunmi_desktop(self):
        # The owner's three Android 7/8 devices: the SUNMI T2 was already there.
        caps = device_capabilities("SUNMI_T2")
        assert (caps["builtinPrinter"], caps["paperWidthMm"], caps["cashDrawerPort"], caps["builtinTerminal"]) == (
            True, 80, True, False,
        )
        assert detect_device_model({"manufacturer": "SUNMI", "brand": "SUNMI", "model": "T2"}) == "SUNMI_T2"


class TestDetection:
    @pytest.mark.parametrize(
        "raw, makers, normal",
        [("PAX A77", ("PAX",), "A77"), ("a77", ("PAX",), "A77"), ("UROVO i9100", ("UROVO", "UBX"), "I9100"),
         ("i-9100", ("UROVO",), "I9100"), ("", (), ""), (None, (), ""), ("PAX", ("PAX",), "PAX")],
    )
    def test_normalize(self, raw, makers, normal):
        assert normalize_vendor_model(raw, makers) == normal

    def test_the_maker_decides(self):
        assert detect_vendor_device({"manufacturer": "PAX", "model": "A77"}) == "PAX_A77"
        assert detect_vendor_device({"brand": "UBX", "model": "i9100"}) == "UROVO_I9100"
        assert detect_vendor_device({"manufacturer": "Kozen", "model": "A77"}) is None
        assert detect_vendor_device({"manufacturer": "PAX", "model": "i9100"}) is None
        assert detect_vendor_device("PAX A77") is None and detect_vendor_device(None) is None

    def test_synqpay_and_sunmi_win_first(self):
        # A SynqPay terminal says so itself; the order in detect_device_model is unchanged.
        assert detect_device_model({"manufacturer": "PAX", "model": "A77", "synqpay": "true"}) == "SYNQPAY"


class TestRequests:
    @pytest.mark.parametrize("model", VENDOR_DEVICE_MODEL_IDS)
    def test_the_requests_accept_them(self, model):
        assert PairingCodeGenerateRequest(deviceModel=model).device_model == model
        assert POSMachineUpdate(deviceModel=model).device_model == model
        assert ReplacementCodeBody(deviceModel=model).device_model == model


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
    return world


def _code(w, *, device_model=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(),
        code=f"C{uuid.uuid4().hex[:7].upper()}",
        distributor_id=w.admin.id,
        tenant_id=w.tenant.id,
        device_model=device_model,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


class TestPairing:
    def test_a_pax_a77_with_agamento_pairs_like_an_f20_that_prints(self, w):
        code = _code(w, device_model="N55F")
        machine = P.validate_pairing_code(
            w.db, code.code,
            {"manufacturer": "PAX", "brand": "PAX", "model": "A77", "agamento": "true", "platform": "android"},
            "Counter",
        )
        assert machine.device_model == "PAX_A77"
        assert (machine.has_printer, machine.has_builtin_terminal, machine.has_cash_drawer_port) == (True, True, False)

    def test_a_urovo_without_agamento_charges_elsewhere(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(
            w.db, code.code, {"manufacturer": "UROVO", "model": "i9100", "platform": "android"}, "Floor",
        )
        assert machine.device_model == "UROVO_I9100"
        assert machine.has_printer is True
        assert machine.has_builtin_terminal is False
