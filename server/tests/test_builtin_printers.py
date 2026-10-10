"""
iMin, LANDI and Feitian printer docks in the device-model list (app/models/builtin_printers.py):
"מדפסת מובנית" with no vendor SDK.

* Detection: maker or brand, then the model (longest prefix); a model of iMin no prefix names
  is the generic "IMIN". A LANDI the table does not name stays the generic "LANDI"; the F20
  stays a 55F; SUNMI / PAX / Urovo / SynqPay are asked first.
* Capabilities: a model the till prints on by itself (auto / partial) has a printer at its
  width and — where the till opens the drawer through the head — a drawer port; a model only
  its vendor's SDK reaches (LANDI's handhelds) has neither and reads "בקרוב". None has a card
  terminal of its own.
* The dashboard's choice wins at pairing only where it names the unit more closely (a Falcon 2
  on its 58 mm dock): no "the device says otherwise" warning then.

The golden fixture is shared with pos-android (`app/src/test/resources/`, the same bytes): the
till's BuiltinPrinterModels.kt is pinned by the same table and the same detection cases.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.models.builtin_printers import (
    BUILTIN_PRINTER_MODEL_IDS,
    BUILTIN_PRINTER_MODELS,
    builtin_printer_model,
    choice_refines,
    detect_builtin_printer_model,
    normalize_builtin_model,
)
from app.models.pairing_code import PairingCode
from app.models.pos_machine import (
    DEVICE_MODELS,
    POSMachine,
    detect_device_model,
    device_capabilities,
    paired_device_model,
    reported_device_model,
)
from app.routers import machines as machines_router
from app.schemas.pairing_code import PairingCodeGenerateRequest
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.transmission import ReplacementCodeBody
from app.services import pairing as P
from app.services.device_profile import machine_fields
from shift_world import accept_str_uuids, make_world

GOLDEN = Path(__file__).parent / "fixtures" / "builtin_printers_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: BuiltinPrinterModelsTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "0854e577cf99e8ccef2592dc69ed2e5b97f4e36db96120c9bd6dbda9da9c2f35"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _golden() -> dict:
    return json.loads(_text(GOLDEN))


def _info(case: dict) -> dict:
    return {"manufacturer": case["manufacturer"], "brand": case["brand"], "model": case["model"], "platform": "android"}


class TestFixture:
    def test_the_fixture_is_the_pinned_one(self):
        assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256

    def test_the_till_has_the_same_fixture(self):
        if not SIBLING.exists():
            pytest.skip("pos-android is not checked out beside pos-server")
        assert _text(SIBLING) == _text(GOLDEN)

    def test_the_table_is_the_fixtures_table(self):
        rows = [
            {"id": m.id, "label": m.label, "makers": list(m.makers), "prefixes": list(m.prefixes), "generic": m.generic,
             "paperMm": m.paper_mm, "cutter": m.cutter, "drawerPort": m.drawer_port,
             "customerDisplay": m.customer_display, "dock": m.dock, "support": m.support, "routes": list(m.routes),
             "fallback": m.fallback, "sdk": m.sdk}
            for m in BUILTIN_PRINTER_MODELS
        ]
        assert rows == _golden()["models"]

    @pytest.mark.parametrize("case", _golden()["detect"], ids=lambda c: f"{c['manufacturer']}/{c['brand']}/{c['model']}")
    def test_detection_matches_the_fixture(self, case):
        assert detect_builtin_printer_model(_info(case)) == case["expected"]
        if case["expected"] is not None:
            assert detect_device_model(_info(case)) == case["expected"]

    @pytest.mark.parametrize("case", _golden()["choiceRefines"], ids=lambda c: f"{c['detected']}<-{c['chosen']}")
    def test_the_choice_refines_as_the_fixture_says(self, case):
        assert choice_refines(case["detected"], case["chosen"]) is case["refines"]


class TestTable:
    def test_every_model_is_a_device_model_that_fits_the_column(self):
        assert set(BUILTIN_PRINTER_MODEL_IDS) <= set(DEVICE_MODELS)
        assert all(len(m) <= 16 for m in BUILTIN_PRINTER_MODEL_IDS)
        assert len(set(BUILTIN_PRINTER_MODEL_IDS)) == len(BUILTIN_PRINTER_MODEL_IDS)

    def test_routes_are_well_formed(self):
        for m in BUILTIN_PRINTER_MODELS:
            assert m.support in ("auto", "partial", "sdk"), m.id
            assert m.paper_mm in (58, 80), m.id
            assert bool(m.routes) is m.prints, m.id
            for r in m.routes:
                kind, _, rest = r.partition(":")
                assert kind in ("usb", "bt", "aidl") and rest, (m.id, r)

    @pytest.mark.parametrize(
        "model, printer, paper, drawer, pending",
        [
            ("IMIN_FALCON2", True, 80, True, False),
            ("IMIN_FALCON2_58", True, 58, True, False),
            ("IMIN_FALCON2MAX", True, 80, True, False),
            # Falcon 1 prints; its drawer is the board's (IminLibs), not the head's.
            ("IMIN_FALCON1", True, 80, False, False),
            ("IMIN_M2", True, 58, False, False),
            ("LANDI_C20_PRO", True, 80, True, False),
            # Only LANDI's USDK reaches the handhelds' head: no printer for the till, "בקרוב".
            ("LANDI_M20", False, None, False, True),
            ("LANDI_APOS_A8", False, None, False, True),
            ("FEITIAN_M60", True, 80, True, False),
            ("FEITIAN_F360", True, 58, True, False),
        ],
    )
    def test_capabilities(self, model, printer, paper, drawer, pending):
        caps = device_capabilities(model)
        assert caps == {
            "builtinPrinter": printer,
            "builtinTerminal": False,
            "cashDrawerPort": drawer,
            "driverPending": pending,
            "paperWidthMm": paper,
            "builtinScanner": False,
        }
        m = POSMachine(device_model=model)
        assert (m.has_printer, m.has_builtin_terminal, m.has_cash_drawer_port) == (printer, False, drawer)

    def test_the_generic_rows_stay_as_they_were(self):
        assert device_capabilities("LANDI")["driverPending"] is True
        assert device_capabilities("LANDI")["builtinPrinter"] is False
        assert device_capabilities("FEITIAN_TABLET")["builtinPrinter"] is False
        assert builtin_printer_model("LANDI") is None and builtin_printer_model(None) is None


class TestDetection:
    @pytest.mark.parametrize(
        "raw, makers, normal",
        [("iMin Falcon 2", ("IMIN",), "FALCON2"), ("FALCON-2", ("IMIN",), "FALCON2"), ("LANDI C20 Pro", ("LANDI",), "C20PRO"),
         ("D4-503 Pro", ("IMIN",), "D4503PRO"), ("", (), ""), (None, (), ""), ("IMIN", ("IMIN",), "IMIN")],
    )
    def test_normalize(self, raw, makers, normal):
        assert normalize_builtin_model(raw, makers) == normal

    def test_the_tables_before_win_first(self):
        # SynqPay says so itself; a SUNMI / PAX keep their own tables.
        assert detect_device_model({"manufacturer": "PAX", "model": "A77", "synqpay": "true"}) == "SYNQPAY"
        assert detect_device_model({"manufacturer": "SUNMI", "model": "T2"}) == "SUNMI_T2"
        assert detect_device_model({"manufacturer": "PAX", "model": "A77"}) == "PAX_A77"
        # The F20 / 55F is not claimed; a Feitian tablet with a printer dock is.
        assert detect_device_model({"manufacturer": "Feitian", "model": "F20", "agamento": "true"}) is None
        assert detect_device_model({"manufacturer": "Feitian", "model": "M60"}) == "FEITIAN_M60"

    def test_a_landi_the_table_does_not_name_is_the_generic_landi(self):
        assert detect_device_model({"manufacturer": "LANDI", "model": "C20 SE"}) == "LANDI"
        assert detect_device_model({"manufacturer": "LANDI", "model": "C20 Pro"}) == "LANDI_C20_PRO"

    def test_the_choice_refines_only_within_the_maker(self):
        assert paired_device_model({"manufacturer": "iMin", "model": "Falcon 2"}, "IMIN_FALCON2_58") == "IMIN_FALCON2_58"
        assert paired_device_model({"manufacturer": "iMin", "model": "Falcon 2"}, "N55F") == "IMIN_FALCON2"
        assert paired_device_model({"manufacturer": "iMin", "model": "Falcon 2"}, "LANDI_C20_PRO") == "IMIN_FALCON2"
        assert paired_device_model({"manufacturer": "Kozen", "model": "Tab"}, "IMIN_FALCON2") == "IMIN_FALCON2"
        assert paired_device_model(None, None) is None
        assert reported_device_model({"manufacturer": "iMin", "model": "Falcon 2"}, "IMIN_FALCON2_58") == "IMIN_FALCON2_58"
        assert reported_device_model({"manufacturer": "iMin", "model": "Falcon 2"}, "N55F") == "IMIN_FALCON2"


class TestRequests:
    @pytest.mark.parametrize("model", BUILTIN_PRINTER_MODEL_IDS)
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
    def test_an_imin_falcon_2_pairs_as_itself_with_a_printer_and_a_drawer(self, w):
        code = _code(w, device_model="N55F")
        machine = P.validate_pairing_code(
            w.db, code.code, {"manufacturer": "iMin", "brand": "iMin", "model": "Falcon 2", "platform": "android"}, "Counter",
        )
        assert machine.device_model == "IMIN_FALCON2"
        assert machine.device_model_chosen == "N55F"
        assert (machine.has_printer, machine.has_builtin_terminal, machine.has_cash_drawer_port) == (True, False, True)

    def test_the_58_mm_dock_chosen_on_the_dashboard_is_kept_without_a_warning(self, w):
        code = _code(w, device_model="IMIN_FALCON2_58")
        machine = P.validate_pairing_code(
            w.db, code.code, {"manufacturer": "iMin", "model": "Falcon 2", "platform": "android"}, "Bar",
        )
        assert machine.device_model == "IMIN_FALCON2_58"
        assert machine.device_model_reported == "IMIN_FALCON2_58"
        assert machine_fields(machine, None)["deviceModelReported"] == "IMIN_FALCON2_58"

    def test_a_landi_handheld_prints_elsewhere_until_its_sdk_is_approved(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(
            w.db, code.code, {"manufacturer": "LANDI", "model": "M20", "platform": "android"}, "Floor",
        )
        assert machine.device_model == "LANDI_M20"
        assert (machine.has_printer, machine.device_driver_pending) == (False, True)
