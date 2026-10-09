"""
"סוג מכשיר" — a device's role (till / kiosk) and model when it is added and afterwards
(app/services/device_profile.py, docs/SPEC_DEVICE_ROLE_MODEL.md).

* The model catalog: six models and their capability flags; LANDI / Feitian tablet marked
  "בקרוב" (no driver), never printing; a LANDI named by its maker at pairing.
* Adding a device: the pairing code carries the role and the kiosk's options; a kiosk
  needs a shop and valid controlling tills; redeeming a kiosk code makes the new machine a
  kiosk in its shop at once (controllers, device lock), so `machines/me` already says so.
* The machines list / machine page carry the role, the chosen and reported model, the
  drawer port and "בקרוב".
* Changing the role or the model (`PUT /machines/{id}/device-profile`, and the model on
  `PUT /machines/{id}`): only over a clean break, refused with Hebrew messages otherwise.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import (
    DEVICE_MODELS,
    PairingStatus,
    POSMachine,
    detect_device_model,
    device_capabilities,
    set_kiosk_cache,
)
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.device_profile import DeviceProfileIn, KioskOptionsIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse
from app.schemas.pos_machine import POSMachineResponse, POSMachineUpdate
from app.services import device_profile as DP
from app.services import kiosk_control
from app.services import main_till as MT
from app.services import pairing as P
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    world.locks = []
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: world.locks.append(machine.id))
    TP.ensure_builtin_parameters(world.db)
    world.till, world.other = world.tills
    # Committed: a refusal rolls the session back, which must not take the world with it.
    world.db.commit()
    return world


def _user(w, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
        username=uuid.uuid4().hex[:6], shop_id=shop.id if shop is not None else None,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _profile(w, machine, user=None, **body):
    return machines_router.update_device_profile(
        machine_id=machine.id,
        body=DeviceProfileIn(**body),
        current_user=user or w.admin,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    import json

    return out.status_code, json.loads(out.body)


def _code(w, *, role=None, options=None, shop_id=None, target=None, model=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(),
        code=f"C{uuid.uuid4().hex[:7].upper()}",
        distributor_id=w.admin.id,
        tenant_id=w.tenant.id,
        shop_id=shop_id,
        target_machine_id=target,
        device_model=model,
        device_role=role,
        kiosk_options=options,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def _seat(monkeypatch):
    """The register number's regex is Postgres-only: seat the machine in the shop directly."""

    def _assign(db, machine_id, shop_id):
        machine = db.get(POSMachine, machine_id)
        machine.shop_id = shop_id
        machine.pairing_status = PairingStatus.ASSIGNED
        db.flush()
        return machine

    monkeypatch.setattr(P, "assign_machine_to_shop", _assign)


def _kiosk_lock_on(w, machine) -> bool:
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "kioskMode").one()
    row = (
        w.db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        )
        .first()
    )
    return row is not None and row.value is True


# ── The model catalog ─────────────────────────────────────────────────────────


class TestCatalog:
    @pytest.mark.parametrize(
        "model, printer, terminal, drawer, pending",
        [
            ("N55F", True, True, False, False),
            ("MODO", False, True, False, False),
            ("P18", False, False, False, False),
            ("LANDI", False, False, False, True),
            ("FEITIAN_TABLET", False, False, False, True),
            ("GENERIC_ANDROID", False, False, False, False),
            (None, True, True, False, False),
        ],
    )
    def test_each_model_has_its_capabilities(self, model, printer, terminal, drawer, pending):
        assert device_capabilities(model) == {
            "builtinPrinter": printer,
            "builtinTerminal": terminal,
            "cashDrawerPort": drawer,
            "driverPending": pending,
            # The head's paper (docs/SPEC_SUNMI.md): 58 mm where there is one, none elsewhere.
            "paperWidthMm": 58 if printer else None,
            "builtinScanner": False,
        }
        m = POSMachine(device_model=model)
        assert (m.has_printer, m.has_builtin_terminal, m.has_cash_drawer_port, m.device_driver_pending) == (
            printer, terminal, drawer, pending,
        )

    def test_six_models(self):
        # The six, then the SUNMI family (tests/test_sunmi_models.py), then the SynqPay
        # terminals (tests/test_synqpay_devices.py).
        assert DEVICE_MODELS[:6] == ("N55F", "MODO", "P18", "LANDI", "FEITIAN_TABLET", "GENERIC_ANDROID")
        # And PAX A77 / Urovo i9100 (tests/test_vendor_devices.py).
        assert all(m.startswith(("SUNMI", "SYNQPAY", "PAX_", "UROVO_")) for m in DEVICE_MODELS[6:])

    def test_no_driverless_model_claims_a_printer(self):
        assert not any(
            device_capabilities(m)["builtinPrinter"] or device_capabilities(m)["cashDrawerPort"]
            for m in DEVICE_MODELS
            if device_capabilities(m)["driverPending"]
        )

    @pytest.mark.parametrize(
        "info, expected",
        [
            ({"model": "C20 Pro", "manufacturer": "LANDI"}, "LANDI"),
            ({"model": "x", "manufacturer": " landi "}, "LANDI"),
            ({"model": "Nebullar P18", "manufacturer": "LANDI"}, "P18"),
            ({"model": "F20", "manufacturer": "Feitian"}, None),
            ({"model": "Tab", "manufacturer": None}, None),
        ],
    )
    def test_a_landi_names_itself_by_its_maker(self, info, expected):
        assert detect_device_model(info) == expected

    def test_the_requests_accept_the_new_models_and_four_roles(self):
        body = PairingCodeGenerateRequest(deviceModel="GENERIC_ANDROID", deviceRole="kiosk")
        assert (body.device_model, body.device_role) == ("GENERIC_ANDROID", "kiosk")
        assert POSMachineUpdate(deviceModel="LANDI").device_model == "LANDI"
        # The display devices (tests/test_display_devices.py), with a platform.
        for role in ("kds", "order_status_board"):
            assert PairingCodeGenerateRequest(deviceRole=role, platform="windows").device_role == role
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(deviceRole="printer")
        # "ios" is a platform since the web till (tests/test_web_till_platform.py); "macos" is not.
        assert PairingCodeGenerateRequest(platform="ios").platform == "ios"
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(platform="macos")
        with pytest.raises(ValidationError):
            DeviceProfileIn(deviceModel="X9")


# ── Adding a device ───────────────────────────────────────────────────────────


class TestGenerate:
    def _generate(self, w, **body):
        return pairing_router.generate_pairing_code(
            body=PairingCodeGenerateRequest(**body),
            current_user=w.admin,
            active_tenant_id=w.tenant.id,
            db=w.db,
        )

    def test_a_till_code(self, w):
        code = self._generate(w, deviceModel="N55F", deviceRole="till")
        assert (code.device_role, code.kiosk_options) == ("till", None)
        assert PairingCodeResponse.model_validate(code).model_dump(by_alias=True)["deviceRole"] == "till"

    def test_a_kiosk_code_stores_its_options(self, w):
        code = self._generate(
            w, companyId=w.company.id, shopId=w.shop.id, deviceModel="P18", deviceRole="kiosk",
            kiosk={"name": "  קיוסק   כניסה ", "controllerMachineIds": [str(w.till.id)], "lockDevice": True},
        )
        assert code.device_role == "kiosk"
        assert code.kiosk_options == {
            "name": "קיוסק כניסה", "controllerMachineIds": [str(w.till.id)], "lockDevice": True,
        }

    def test_a_kiosk_needs_a_shop(self, w):
        status_code, body = _refusal(self._generate(w, deviceModel="N55F", deviceRole="kiosk"))
        assert (status_code, body["detail"]) == (400, "kiosk_requires_shop")
        assert "סניף" in body["message"]

    def test_a_controller_of_another_tenant_or_a_kiosk_is_refused(self, w):
        kiosk_control.convert(w.db, w.admin, w.other)
        status_code, body = _refusal(self._generate(
            w, shopId=w.shop.id, deviceModel="N55F", deviceRole="kiosk",
            kiosk={"controllerMachineIds": [str(w.other.id)]},
        ))
        assert (status_code, body["detail"]) == (422, "invalid_controller")
        assert "קופות השולטות" in body["message"]


class TestPairingAKiosk:
    def test_the_device_is_a_kiosk_as_it_pairs(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(
            w, role="kiosk", shop_id=w.shop.id, model="N55F",
            options={"name": "קיוסק", "controllerMachineIds": [str(w.till.id)], "lockDevice": True},
        )
        machine = P.validate_pairing_code(w.db, code.code, {"model": "F20"}, "Kiosk 1")
        device = w.db.get(KioskDevice, machine.id)
        assert device is not None and device.name == "קיוסק" and device.enabled
        assert device.controller_machine_ids == [str(w.till.id)]
        assert _kiosk_lock_on(w, machine) and w.locks == [machine.id]
        # The till's first machines/me opens it as a kiosk.
        me = machines_router.get_my_machine(machine=machine)
        assert me["deviceRole"] == "kiosk"
        assert machine.device_model == "N55F" and machine.device_model_chosen == "N55F"

    def test_a_controller_gone_since_is_dropped_not_fatal(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(
            w, role="kiosk", shop_id=w.shop.id,
            options={"controllerMachineIds": [str(w.till.id), str(w.other.id)], "lockDevice": False},
        )
        w.other.is_active = False  # retired after the code was made
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert w.db.get(KioskDevice, machine.id).controller_machine_ids == [str(w.till.id)]
        assert not _kiosk_lock_on(w, machine) and w.locks == []

    def test_no_shop_leaves_a_till(self, w):
        code = _code(w, role="kiosk", options={})
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert machine is not None and w.db.get(KioskDevice, machine.id) is None

    def test_a_till_code_is_a_till(self, w, monkeypatch):
        _seat(monkeypatch)
        # Kept referenced: a reload from SQLite would read `expires_at` naive.
        code = _code(w, role="till", shop_id=w.shop.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert w.db.get(KioskDevice, machine.id) is None
        assert machine.pairing_status == PairingStatus.ASSIGNED

    def test_the_hardware_still_wins_and_the_choice_is_kept(self, w):
        code = _code(w, model="N55F")
        machine = P.validate_pairing_code(w.db, code.code, {"model": "Nebullar P18"}, "Tablet")
        assert (machine.device_model, machine.device_model_chosen, machine.device_model_reported) == (
            "P18", "N55F", "P18",
        )


# ── What the dashboard and the till read ──────────────────────────────────────


class TestReading:
    def test_the_list_carries_the_role_and_the_models(self, w):
        kiosk_control.convert(w.db, w.admin, w.other)
        w.till.device_model, w.till.device_model_chosen = "P18", "N55F"
        w.till.device_info = {"model": "Nebullar P18"}
        w.other.device_model = "LANDI"
        rows = {r["id"]: r for r in machines_router._enrich_machines_batch([w.till, w.other], w.db)}
        till, kiosk = rows[w.till.id], rows[w.other.id]
        assert (till["deviceRole"], till["kioskEnabled"]) == ("till", None)
        assert (till["deviceModelChosen"], till["deviceModelReported"]) == ("N55F", "P18")
        assert (kiosk["deviceRole"], kiosk["kioskEnabled"], kiosk["deviceDriverPending"]) == ("kiosk", True, True)
        assert kiosk["hasPrinter"] is False and kiosk["hasCashDrawerPort"] is False
        dumped = POSMachineResponse.model_validate(kiosk).model_dump(by_alias=True)
        assert (dumped["deviceRole"], dumped["deviceDriverPending"]) == ("kiosk", True)

    def test_machines_me_says_the_mode_to_open_in(self, w):
        assert machines_router.get_my_machine(machine=w.till)["deviceRole"] == "till"
        device = kiosk_control.convert(w.db, w.admin, w.till)
        assert machines_router.get_my_machine(machine=w.till)["deviceRole"] == "kiosk"
        device.enabled = False  # a disabled kiosk works as a till (its kiosk/sync says so too)
        me = machines_router.get_my_machine(machine=w.till)
        assert me["deviceRole"] == "till" and me["hasCashDrawerPort"] is False


# ── Changing the role or the model ────────────────────────────────────────────


class TestChangingTheModel:
    def test_a_change_is_recorded_as_chosen(self, w):
        out = _profile(w, w.till, deviceModel="GENERIC_ANDROID")
        assert (out["deviceModel"], out["deviceModelChosen"], out["hasPrinter"], out["hasBuiltinTerminal"]) == (
            "GENERIC_ANDROID", "GENERIC_ANDROID", False, False,
        )

    def test_refused_with_an_open_shift(self, w):
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        status_code, body = _refusal(_profile(w, w.till, deviceModel="MODO"))
        assert (status_code, body["detail"]) == (409, "device_profile_open_shift")
        assert body["message"].startswith("לא ניתן לשנות את הדגם של קופה 1")
        assert w.till.device_model is None

    def test_refused_with_unsynced_documents(self, w):
        w.till.pending_documents = 3
        status_code, body = _refusal(_profile(w, w.till, deviceModel="MODO"))
        assert (status_code, body["detail"], body["count"]) == (409, "device_profile_unsynced_documents", 3)
        assert "3 מסמכים" in body["message"]

    def test_refused_with_offline_zs(self, w):
        w.till.z_mode = "till"
        w.till.offline_till_z_pending = 2
        status_code, body = _refusal(_profile(w, w.till, deviceModel="MODO"))
        assert (status_code, body["detail"]) == (409, "device_profile_offline_zs")
        assert "ללא חיבור" in body["message"]

    def test_losing_the_terminal_waits_for_untransmitted_card_sales(self, w):
        w.till.device_model = "N55F"
        w.till.transmission_pending_count = 2
        w.db.commit()
        status_code, body = _refusal(_profile(w, w.till, deviceModel="P18"))
        assert (status_code, body["detail"]) == (409, "device_profile_untransmitted")
        assert w.till.device_model == "N55F" and w.till.transmission_pending_count == 2
        # A Modo keeps Agamento: allowed.
        assert _profile(w, w.till, deviceModel="MODO")["deviceModel"] == "MODO"

    def test_the_plain_machine_edit_obeys_the_same_rules(self, w):
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        out = machines_router.update_machine(
            machine_id=str(w.till.id), machine_data=POSMachineUpdate(deviceModel="MODO"),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _refusal(out)[1]["detail"] == "device_profile_open_shift"

    def test_the_same_model_is_no_change(self, w):
        w.till.device_model = "MODO"
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        assert _profile(w, w.till, deviceModel="MODO")["deviceModel"] == "MODO"


class TestChangingTheRole:
    def test_a_till_becomes_a_kiosk(self, w):
        out = _profile(
            w, w.till, deviceRole="kiosk",
            kiosk={"name": "קיוסק בר", "controllerMachineIds": [str(w.other.id)], "lockDevice": True},
        )
        assert out["deviceRole"] == "kiosk"
        device = w.db.get(KioskDevice, w.till.id)
        assert device.name == "קיוסק בר" and device.controller_machine_ids == [str(w.other.id)]
        assert _kiosk_lock_on(w, w.till) and w.locks == [w.till.id]

    def test_a_kiosk_becomes_a_till_again(self, w):
        kiosk_control.convert(w.db, w.admin, w.till)
        out = _profile(w, w.till, deviceRole="till")
        assert out["deviceRole"] == "till" and w.db.get(KioskDevice, w.till.id) is None

    def test_never_the_main_till(self, w):
        parameter = w.db.query(TillParameter).filter(TillParameter.key == MT.MAIN_TILL_KEY).one()
        w.db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=w.till.id, value=True,
        ))
        w.db.flush()
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kiosk"))
        assert (status_code, body["detail"]) == (409, "device_profile_main_till")
        assert "הקופה הראשית" in body["message"]
        assert w.db.get(KioskDevice, w.till.id) is None

    def test_a_kiosk_needs_a_shop(self, w):
        w.till.shop_id = None
        w.till.pairing_status = PairingStatus.PAIRED
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kiosk"))
        assert (status_code, body["detail"]) == (409, "device_profile_not_assigned")

    def test_refused_with_an_open_shift_either_way(self, w):
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        assert _refusal(_profile(w, w.till, deviceRole="kiosk"))[1]["detail"] == "device_profile_open_shift"
        kiosk_control.convert(w.db, w.admin, w.other)
        w.shift(w.other, 2, status=ShiftStatus.OPEN)
        status_code, body = _refusal(_profile(w, w.other, deviceRole="till"))
        assert body["detail"] == "device_profile_open_shift"
        assert body["message"].startswith("לא ניתן להחזיר את קופה 2 לקופה רגילה")

    def test_a_shift_the_till_claims_counts_too(self, w):
        w.till.reported_open_shift_id = uuid.uuid4()
        w.till.reported_open_shift_opened_at = datetime.now(timezone.utc)
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kiosk"))
        assert body["detail"] == "device_profile_open_shift"

    def test_an_invalid_controller(self, w):
        status_code, body = _refusal(_profile(
            w, w.till, deviceRole="kiosk", kiosk={"controllerMachineIds": [str(w.other_till.id), "nope"]},
        ))
        assert (status_code, body["detail"]) == (422, "invalid_controller")

    def test_out_of_scope_and_wrong_roles(self, w):
        north_manager = _user(w, UserRole.SHOP_MANAGER, shop=w.other_shop)
        with pytest.raises(HTTPException) as exc:
            _profile(w, w.till, user=north_manager, deviceRole="kiosk")
        assert exc.value.status_code == 403
        manager = _user(w, UserRole.SHOP_MANAGER, shop=w.shop)
        assert _profile(w, w.till, user=manager, deviceRole="kiosk")["deviceRole"] == "kiosk"

    def test_role_and_model_at_once(self, w):
        out = _profile(w, w.till, deviceRole="kiosk", deviceModel="P18")
        assert (out["deviceRole"], out["deviceModel"]) == ("kiosk", "P18")

    def test_the_same_role_is_no_change(self, w):
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        assert _profile(w, w.till, deviceRole="till")["deviceRole"] == "till"


class TestDisplayDeviceRoles:
    """
    "KDS ומסך מוכן / לא מוכן אינם מערכות קופה וחשבונאיות" (tests/test_display_devices.py
    for the rest): the machine page never turns a till into a display device, nor back.
    """

    def _display(self, w, machine, kds_role="expo"):
        from app.models.kds import KdsDevice

        machine.is_fiscal = False
        machine.pos_number = None
        w.db.add(KdsDevice(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=machine.id,
            name="מסך", role=kds_role, station_ids=[], is_active=True,
        ))
        w.db.commit()
        return machine

    @pytest.mark.parametrize("role", ["kds", "order_status_board"])
    def test_a_till_never_becomes_a_display_device(self, w, role):
        status_code, body = _refusal(_profile(w, w.till, deviceRole=role))
        assert (status_code, body["detail"]) == (409, "device_role_change_requires_pairing")
        assert "קוד צימוד חדש" in body["message"] and "אינם קופה" in body["message"]
        assert w.till.is_fiscal is True and w.till.pos_number == "1"

    def test_a_kiosk_neither(self, w):
        kiosk_control.convert(w.db, w.admin, w.till)
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kds"))
        assert (status_code, body["detail"], body["currentRole"]) == (409, "device_role_change_requires_pairing", "kiosk")

    @pytest.mark.parametrize("role", ["till", "kiosk"])
    def test_a_display_device_never_becomes_a_till_or_kiosk(self, w, role):
        self._display(w, w.till)
        status_code, body = _refusal(_profile(w, w.till, deviceRole=role))
        assert (status_code, body["detail"]) == (409, "device_role_change_requires_pairing")
        assert (body["currentRole"], body["requestedRole"]) == ("kds", role)
        assert w.till.is_fiscal is False and w.db.get(KioskDevice, w.till.id) is None

    def test_a_kds_and_the_board_trade_places(self, w):
        from app.models.kds import KdsDevice

        self._display(w, w.till)
        out = _profile(w, w.till, deviceRole="order_status_board")
        assert (out["deviceRole"], out["fiscal"]) == ("order_status_board", False)
        assert w.db.query(KdsDevice).filter(KdsDevice.machine_id == w.till.id).one().role == "pickup"
        out = _profile(w, w.till, deviceRole="kds", kds={"screenRole": "manager"})
        assert out["deviceRole"] == "kds"
        assert w.db.query(KdsDevice).filter(KdsDevice.machine_id == w.till.id).one().role == "manager"

    def test_the_kiosks_page_cannot_convert_one_either(self, w):
        self._display(w, w.till)
        with pytest.raises(HTTPException) as exc:
            kiosk_control.convert(w.db, w.admin, w.till)
        assert (exc.value.status_code, exc.value.detail) == (409, "device_not_fiscal")

    def test_machines_me_and_the_list_say_what_it_is(self, w):
        self._display(w, w.till, kds_role="pickup")
        w.other.device_info = {"platform": "windows"}
        me = machines_router.get_my_machine(machine=w.till)
        assert (me["deviceRole"], me["fiscal"], me["platform"], me["posNumber"]) == (
            "order_status_board", False, "android", None,
        )
        other = machines_router.get_my_machine(machine=w.other)
        assert (other["deviceRole"], other["fiscal"], other["platform"]) == ("till", True, "windows")
        rows = {r["id"]: r for r in machines_router._enrich_machines_batch([w.till, w.other], w.db)}
        board = POSMachineResponse.model_validate(rows[w.till.id]).model_dump(by_alias=True)
        assert (board["deviceRole"], board["fiscal"], board["kdsScreen"]["role"]) == ("order_status_board", False, "pickup")
        till = POSMachineResponse.model_validate(rows[w.other.id]).model_dump(by_alias=True)
        assert (till["deviceRole"], till["fiscal"], till["platform"], till["kdsScreen"]) == ("till", True, "windows", None)


class TestKioskChargesOnAnExternalPinpad:
    """"מכשירי הסליקה הם חיצוניים": a kiosk never charges on a built-in terminal."""

    def test_the_built_in_terminal_is_off_whatever_the_model(self, w):
        w.till.device_model = "N55F"
        assert w.till.has_builtin_terminal is True
        # Converted behind the instance's back (the kiosks page): forget the cached answer,
        # and the next read looks it up.
        kiosk_control.convert(w.db, w.admin, w.till)
        set_kiosk_cache(w.till, None)
        assert w.till.is_kiosk is True and w.till.has_builtin_terminal is False
        assert w.till.has_printer is True  # the printer is the model's, kiosk or not
        assert device_capabilities("N55F", kiosk=True)["builtinTerminal"] is False

    def test_machines_me_and_the_list_say_so_and_warn_without_an_address(self, w):
        w.till.device_model = "N55F"
        _profile(w, w.till, deviceRole="kiosk")
        assert machines_router.get_my_machine(machine=w.till)["hasBuiltinTerminal"] is False
        row = machines_router._enrich_machines_batch([w.till, w.other], w.db)
        kiosk = next(r for r in row if r["id"] == w.till.id)
        till = next(r for r in row if r["id"] == w.other.id)
        assert (kiosk["hasBuiltinTerminal"], kiosk["pinpadRequired"], kiosk["pinpadAddressMissing"]) == (
            False, True, True,
        )
        assert kiosk["paymentIntegration"] == "nayax_lan"
        assert (till["hasBuiltinTerminal"], till["pinpadRequired"]) == (True, False)

    def test_back_to_a_till_the_model_decides_again(self, w):
        w.till.device_model = "N55F"
        _profile(w, w.till, deviceRole="kiosk")
        out = _profile(w, w.till, deviceRole="till")
        assert out["hasBuiltinTerminal"] is True and w.till.has_builtin_terminal is True

    def test_the_pinpad_given_with_a_kiosk_code_lands_in_the_tills_settings(self, w, monkeypatch):
        _seat(monkeypatch)
        notified = []
        monkeypatch.setattr(DP, "notify_settings", lambda db, m: notified.append(m.id))
        code = _code(
            w, role="kiosk", shop_id=w.shop.id, model="N55F",
            options={"controllerMachineIds": [], "lockDevice": False, "pinpadHost": "192.168.1.20", "pinpadPort": 8080},
        )
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert machine.settings["nayaxEnabled"] is True
        assert (machine.settings["nayaxDeviceHost"], machine.settings["nayaxDevicePort"]) == ("192.168.1.20", "8080")
        assert notified == [machine.id]
        row = machines_router._enrich_machine_status(machine, w.db)
        assert (row["hasBuiltinTerminal"], row["pinpadAddressMissing"], row["pinpadHost"]) == (False, False, "192.168.1.20")

    def test_the_generate_request_cleans_the_address(self, w):
        code = pairing_router.generate_pairing_code(
            body=PairingCodeGenerateRequest(
                shopId=w.shop.id, deviceModel="P18", deviceRole="kiosk",
                kiosk={"pinpadHost": " 10.0.0.5 ", "pinpadPort": 9000},
            ),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert (code.kiosk_options["pinpadHost"], code.kiosk_options["pinpadPort"]) == ("10.0.0.5", 9000)

    @pytest.mark.parametrize(
        "host, port, code",
        [("http://10.0.0.5", None, "pinpad_host_invalid"), ("10.0.0.300", None, "pinpad_host_invalid"),
         ("10.0.0.5", 70000, "pinpad_port_invalid")],
    )
    def test_a_bad_address_is_refused_in_hebrew(self, w, host, port, code):
        out = pairing_router.generate_pairing_code(
            body=PairingCodeGenerateRequest(
                shopId=w.shop.id, deviceModel="P18", deviceRole="kiosk",
                kiosk={"pinpadHost": host, "pinpadPort": port},
            ),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        status_code, body = _refusal(out)
        assert (status_code, body["detail"]) == (422, code)
        assert "המסופון" in body["message"]

    def test_the_machine_page_can_set_it_when_making_a_kiosk(self, w, monkeypatch):
        notified = []
        monkeypatch.setattr(DP, "notify_settings", lambda db, m: notified.append(m.id))
        out = _profile(w, w.till, deviceRole="kiosk", kiosk={"pinpadHost": "pinpad-1.local"})
        assert out["pinpadHost"] == "pinpad-1.local" and out["pinpadAddressMissing"] is False
        assert w.till.settings["nayaxDevicePort"] == "8080" and notified == [w.till.id]
        # A bad one changes nothing at all.
        status_code, body = _refusal(_profile(w, w.other, deviceRole="kiosk", kiosk={"pinpadHost": "a b"}))
        assert (status_code, body["detail"]) == (422, "pinpad_host_invalid")
        assert w.db.get(KioskDevice, w.other.id) is None


class TestService:
    def test_kiosk_options_for_a_till_code_are_none(self, w):
        assert DP.check_pairing_request(w.db, role="till", shop_id=None, kiosk=KioskOptionsIn()) == ("till", None)
        assert DP.check_pairing_request(w.db, role=None, shop_id=None) == (None, None)

    def test_a_replacement_code_never_converts(self, w):
        code = _code(w, role="kiosk", shop_id=w.shop.id, target=w.till.id, options={})
        assert DP.apply_on_pairing(w.db, code, w.till) is False
        assert w.db.get(KioskDevice, w.till.id) is None
