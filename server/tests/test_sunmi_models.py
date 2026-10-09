"""
SUNMI hardware in the device-model list (app/models/sunmi.py, docs/SPEC_SUNMI.md).

* The table: every SUNMI model with its head (58 / 80 mm, cutter), drawer port and scan
  head; no SUNMI charges on a terminal of its own (the P-series' EMV reader is SUNMI's own
  PayHardware, which the till does not drive).
* Detection: a device whose maker or brand is SUNMI names its model by `Build.MODEL`
  ("V2_PRO", "T2s_LITE", "T1-G"…), longest prefix first; a SUNMI the table does not know is
  the generic "SUNMI".
* Pairing: a SUNMI T2s pairs as SUNMI_T2S — printer, drawer port, no built-in terminal —
  whatever the code said.

The golden fixture is shared with pos-android (`app/src/test/resources/`, the same bytes):
the till's SunmiModels.kt is pinned by the same table and the same detection cases.
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
    device_has_builtin_scanner,
    device_has_cash_drawer_port,
    device_paper_width_mm,
)
from app.models.sunmi import (
    SUNMI_GENERIC,
    SUNMI_MODEL_IDS,
    SUNMI_MODELS,
    detect_sunmi,
    is_sunmi,
    normalize_sunmi_model,
    sunmi_model,
    sunmi_model_of,
)
from app.routers import machines as machines_router
from app.schemas.pairing_code import PairingCodeGenerateRequest
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.transmission import ReplacementCodeBody
from app.services import pairing as P
from shift_world import accept_str_uuids, make_world

GOLDEN = Path(__file__).parent / "fixtures" / "sunmi_models_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: SunmiModelsTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "faef4922469e63bbca18e775e612168c424bbcf23d90aad5a85f56af286855e8"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _golden() -> dict:
    return json.loads(_text(GOLDEN))


class TestFixture:
    def test_the_fixture_is_the_pinned_one(self):
        assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256

    def test_the_till_has_the_same_fixture(self):
        if not SIBLING.exists():
            pytest.skip("pos-android is not checked out beside pos-server")
        assert _text(SIBLING) == _text(GOLDEN)

    def test_the_table_is_the_fixtures_table(self):
        rows = [
            {"id": m.id, "printer": m.printer, "paperMm": m.paper_mm, "cutter": m.cutter,
             "drawerPort": m.drawer_port, "scanner": m.scanner, "paymentHw": m.payment_hw}
            for m in SUNMI_MODELS
        ]
        assert rows == _golden()["models"]

    @pytest.mark.parametrize("case", _golden()["detect"], ids=lambda c: f"{c['manufacturer']}/{c['model']}")
    def test_detection_matches_the_fixture(self, case):
        info = {"manufacturer": case["manufacturer"], "brand": case["brand"], "model": case["model"]}
        assert detect_sunmi(info) == case["expected"]


class TestTable:
    def test_every_sunmi_is_a_device_model_that_fits_the_column(self):
        assert set(SUNMI_MODEL_IDS) <= set(DEVICE_MODELS)
        assert len(set(SUNMI_MODEL_IDS)) == len(SUNMI_MODEL_IDS)
        assert all(len(m) <= 16 for m in DEVICE_MODELS)  # pos_machines.device_model String(16)

    @pytest.mark.parametrize("model", SUNMI_MODEL_IDS)
    def test_no_sunmi_has_a_builtin_terminal(self, model):
        caps = device_capabilities(model)
        assert caps["builtinTerminal"] is False
        assert caps["driverPending"] is False
        assert POSMachine(device_model=model).has_builtin_terminal is False

    @pytest.mark.parametrize(
        "model, printer, paper, drawer, scanner",
        [
            ("SUNMI_V2", True, 58, False, False),
            ("SUNMI_V2_PRO", True, 58, False, True),
            ("SUNMI_V2S_PLUS", True, 80, False, True),
            ("SUNMI_P2", True, 58, False, False),
            ("SUNMI_L2", False, None, False, True),
            ("SUNMI_M2", False, None, False, False),
            ("SUNMI_T2", True, 80, True, False),
            ("SUNMI_T2S", True, 80, True, False),
            ("SUNMI_T3", True, 80, True, False),
            ("SUNMI_D2_MINI", True, 58, True, False),
            ("SUNMI_D3", True, 80, True, False),
            ("SUNMI_K2", True, 80, False, True),
            ("SUNMI", True, None, False, False),
        ],
    )
    def test_capabilities(self, model, printer, paper, drawer, scanner):
        caps = device_capabilities(model)
        assert (caps["builtinPrinter"], caps["paperWidthMm"], caps["cashDrawerPort"], caps["builtinScanner"]) == (
            printer, paper, drawer, scanner,
        )
        m = POSMachine(device_model=model)
        assert (m.has_printer, m.has_cash_drawer_port) == (printer, drawer)

    def test_only_desktops_have_a_drawer_port(self):
        with_port = {m for m in SUNMI_MODEL_IDS if device_has_cash_drawer_port(m)}
        assert with_port == {
            "SUNMI_T1", "SUNMI_T2", "SUNMI_T2_MINI", "SUNMI_T2S", "SUNMI_T3",
            "SUNMI_D2_MINI", "SUNMI_D2S", "SUNMI_D2S_PLUS", "SUNMI_D3", "SUNMI_D3_MINI",
        }

    def test_the_other_models_are_as_before(self):
        assert device_paper_width_mm("N55F") == 58 and device_paper_width_mm(None) == 58
        assert device_paper_width_mm("MODO") is None
        assert not any(device_has_builtin_scanner(m) for m in ("N55F", "MODO", "P18", None))
        assert not any(device_has_cash_drawer_port(m) for m in ("N55F", "MODO", "P18", None))

    def test_payment_hardware_is_marked_but_not_used(self):
        assert {m.id for m in SUNMI_MODELS if m.payment_hw} == {"SUNMI_P1", "SUNMI_P2", "SUNMI_P3"}


class TestDetection:
    @pytest.mark.parametrize(
        "raw, normal",
        [("V2_PRO", "V2PRO"), ("V2 Pro", "V2PRO"), ("T1-G", "T1"), ("V1-B18", "V1"),
         ("T2s_LITE", "T2SLITE"), ("SUNMI T2s", "T2S"), ("", ""), (None, "")],
    )
    def test_normalize(self, raw, normal):
        assert normalize_sunmi_model(raw) == normal

    def test_longest_prefix_wins(self):
        assert sunmi_model_of("V2s_PLUS").id == "SUNMI_V2S_PLUS"
        assert sunmi_model_of("V2s").id == "SUNMI_V2S"
        assert sunmi_model_of("V2").id == "SUNMI_V2"
        assert sunmi_model_of("D3 MINI").id == "SUNMI_D3_MINI"
        assert sunmi_model_of("nothing-known").id == SUNMI_GENERIC

    def test_maker_or_brand(self):
        assert is_sunmi("SUNMI") and is_sunmi(" sunmi ") and is_sunmi(None, "SUNMI")
        assert not is_sunmi("Feitian", "Feitian") and not is_sunmi(None)

    def test_the_till_names_a_sunmi(self):
        assert detect_device_model({"manufacturer": "SUNMI", "model": "T2s"}) == "SUNMI_T2S"
        assert detect_device_model({"manufacturer": "SUNMI", "brand": "SUNMI", "model": "V2_PRO"}) == "SUNMI_V2_PRO"
        assert detect_device_model({"manufacturer": "SUNMI", "model": "Z99"}) == "SUNMI"

    def test_the_others_are_as_before(self):
        assert detect_device_model({"model": "Nebullar P18"}) == "P18"
        assert detect_device_model({"model": "C20 Pro", "manufacturer": "LANDI"}) == "LANDI"
        assert detect_device_model({"model": "F20", "manufacturer": "Feitian"}) is None
        # A Kozen "P1…" is not a SUNMI P1: the maker decides.
        assert detect_device_model({"model": "P1", "manufacturer": "Kozen"}) is None

    def test_sunmi_model_lookup(self):
        assert sunmi_model("SUNMI_T3").drawer_port is True
        assert sunmi_model("N55F") is None and sunmi_model(None) is None


class TestRequests:
    @pytest.mark.parametrize("model", SUNMI_MODEL_IDS)
    def test_the_requests_accept_every_sunmi(self, model):
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
    def test_a_sunmi_desktop_pairs_as_itself(self, w):
        code = _code(w, device_model="N55F")
        machine = P.validate_pairing_code(
            w.db, code.code, {"manufacturer": "SUNMI", "brand": "SUNMI", "model": "T2s"}, "Counter",
        )
        assert machine.device_model == "SUNMI_T2S"
        assert machine.has_printer is True
        assert machine.has_cash_drawer_port is True
        assert machine.has_builtin_terminal is False

    def test_a_sunmi_handheld_has_no_drawer(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(w.db, code.code, {"manufacturer": "SUNMI", "model": "V2_PRO"}, "Floor")
        assert machine.device_model == "SUNMI_V2_PRO"
        assert (machine.has_printer, machine.has_cash_drawer_port, machine.has_builtin_terminal) == (True, False, False)

    def test_a_sunmi_pda_does_not_print(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(w.db, code.code, {"manufacturer": "SUNMI", "model": "L2s"}, "Stock")
        assert machine.device_model == "SUNMI_L2" and machine.has_printer is False
