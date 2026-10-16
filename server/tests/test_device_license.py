"""
"סוג רישיון למכשיר" — till / kiosk / kiosk_till (P:/specs/device-license-type.md, app/services/device_license.py).

* The rules: the shared golden fixture (the devices' `workModeAllowed`, the labels, which products fit each
  role, the migration's derivation) — the same bytes as kiosk-desktop's and the Android app's.
* Pairing: the code's product (the role's default, a choice that fits, refusals in Hebrew), the machine made
  with it and its history entry, the device told in the answer.
* The machine page: who may change it, the history, the role it must fit, role + license in one request.
* Enforcement on the kiosks page: no conversion of a "קופה בלבד" till, no way back or switch-off for a
  "קיוסק בלבד" kiosk, the gate switch refused for a licensed device, the dashboard's work-mode commands.
* The gate `kioskTillModeEnabled` the device gets is its license's; a "קופה בלבד" till never gets a
  kiosk-mode row; the parameters' watermark moves with a change.
* What the device hears (machines/me, the heartbeat, kiosk/sync) and the count for billing.
* The migration: one head on main's, add-only columns, and its backfill SQL derives what `derive` says.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Response
from fastapi.responses import JSONResponse

from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import kiosks as KR
from app.routers import machines as MR
from app.routers import pairing as PR
from app.schemas.device_profile import DeviceProfileIn, LicenseProductIn
from app.schemas.kiosk import KioskCommandIn, KioskCreateIn, KioskPatchIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse, PairingCodeValidate
from app.schemas.pos_machine import POSMachineResponse
from app.services import device_license as DL
from app.services import kiosk_control
from app.services import kiosk_till_mode as KTM
from app.services import pairing as P
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GOLDEN = FIXTURES / "device_license_golden.json"
#: LF SHA-256 of device_license_golden.json — the same in kiosk-desktop and pos-android (change all three together).
GOLDEN_SHA256 = "04756d90565b492c08b6410a279e3f10565c7f26cfe072eedc40e5da92e24c9a"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(MR, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    world.notified = []
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: world.notified.append(machine.id))
    TP.ensure_builtin_parameters(world.db)
    world.till, world.other = world.tills
    world.distributor = _user(world, UserRole.DISTRIBUTOR)
    world.manager = _user(world, UserRole.SHOP_MANAGER, shop=world.shop)
    world.company_manager = _user(world, UserRole.COMPANY_MANAGER)
    world.db.commit()
    return world


def _user(w, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:6], shop_id=shop.id if shop is not None else None,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _seat(monkeypatch):
    """The register number's regex is Postgres-only: seat the machine in the shop directly."""

    def _assign(db, machine_id, shop_id):
        machine = db.get(POSMachine, machine_id)
        machine.shop_id = shop_id
        machine.pairing_status = PairingStatus.ASSIGNED
        db.flush()
        return machine

    monkeypatch.setattr(P, "assign_machine_to_shop", _assign)


def _generate(w, user=None, **body):
    return PR.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _code(w, *, role=None, product=None, shop_id=None, options=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"L{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id, tenant_id=w.tenant.id,
        shop_id=shop_id, device_role=role, kiosk_options=options, license_product=product,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def _set_license(w, machine, product, user=None):
    return MR.update_license_product(
        machine_id=machine.id, body=LicenseProductIn(licenseProduct=product), current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def _profile(w, machine, user=None, **body):
    return MR.update_device_profile(
        machine_id=machine.id, body=DeviceProfileIn(**body), current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def _convert(w, machine, user=None):
    return KR.create_kiosk(
        body=KioskCreateIn(machineId=machine.id, controllerMachineIds=[]), current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def _store(w, machine, product):
    DL.record(machine, product, user=w.admin, source=DL.SOURCE_DASHBOARD)
    w.db.commit()


def _gate_value(w, machine, value):
    p = w.db.query(TillParameter).filter(TillParameter.key == KTM.ENABLED_KEY).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type="machine", scope_id=machine.id, value=value))
    w.db.commit()


# ── The shared rules ─────────────────────────────────────────────────────────


def _golden():
    raw = GOLDEN.read_bytes()
    return raw, json.loads(raw.decode("utf-8"))


def test_the_golden_fixture_is_pinned():
    raw, _ = _golden()
    assert hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest() == GOLDEN_SHA256


def test_the_rules_are_the_golden_ones():
    _, g = _golden()
    assert tuple(g["products"]) == DL.PRODUCTS
    assert g["labels"] == DL.LABELS and g["shortLabels"] == DL.SHORT_LABELS and g["roleLabels"] == DL.ROLE_LABELS
    assert g["defaults"] == DL.DEFAULTS
    assert {role: list(products) for role, products in DL.FITS.items()} == g["fits"]
    for case in g["parse"]:
        assert DL.parse(case["raw"]) == case["product"], case
    for case in g["workMode"]:
        assert DL.work_mode_allowed(case["product"], case["gate"]) is case["allowed"], case
    for case in g["mismatch"]:
        assert DL.mismatch(case["product"], case["role"]) is case["mismatch"], case
    for case in g["derive"]:
        assert DL.derive(case["home"], case["kioskEnabled"], case["gate"]) == case["product"], case
    assert g["texts"]["refusalWire"] == DL.BLOCKED_WIRE
    assert g["texts"]["blocked"] == DL.BLOCKED_TEXT == KTM.BLOCKED_TEXTS["license"]


def test_fits_and_the_disabled_kiosk():
    assert DL.fits(DL.TILL, "till") and not DL.fits(DL.TILL, "kiosk")
    assert DL.fits(DL.KIOSK, "kiosk") and not DL.fits(DL.KIOSK, "kiosk", kiosk_enabled=False)
    assert DL.fits(DL.KIOSK_TILL, "kiosk", kiosk_enabled=False) and DL.fits(DL.KIOSK_TILL, "till")
    assert not DL.fits(DL.TILL, "kds")
    assert DL.fits(None, "kds")  # no product: nothing to refuse


# ── Pairing ──────────────────────────────────────────────────────────────────


class TestPairing:
    def test_a_code_gets_the_roles_default(self, w):
        code = _generate(w, deviceModel="N55F", deviceRole="till")
        assert code.license_product == DL.TILL
        assert PairingCodeResponse.model_validate(code).model_dump(by_alias=True)["licenseProduct"] == "till"
        kiosk = _generate(w, shopId=w.shop.id, deviceModel="N55F", deviceRole="kiosk")
        assert kiosk.license_product == DL.KIOSK
        # No role at all (an older dashboard): a till.
        assert _generate(w, deviceModel="N55F").license_product == DL.TILL

    def test_a_choice_that_fits(self, w):
        assert _generate(w, deviceRole="till", licenseProduct="kiosk_till").license_product == DL.KIOSK_TILL
        code = _generate(w, shopId=w.shop.id, deviceRole="kiosk", licenseProduct=" Kiosk_Till ")
        assert code.license_product == DL.KIOSK_TILL

    def test_a_choice_that_does_not_fit_is_refused_in_hebrew(self, w):
        status_code, body = _refusal(_generate(w, deviceRole="till", licenseProduct="kiosk"))
        assert (status_code, body["detail"], body["licenseProduct"]) == (422, DL.ROLE_MISMATCH, "kiosk")
        assert "קיוסק בלבד" in body["message"] and "לא מתאים לקופה" in body["message"]
        status_code, body = _refusal(_generate(w, shopId=w.shop.id, deviceRole="kiosk", licenseProduct="till"))
        assert (status_code, body["detail"]) == (422, DL.ROLE_MISMATCH)
        assert "קופה בלבד" in body["message"] and "לא מתאים לקיוסק" in body["message"]
        assert w.db.query(PairingCode).count() == 0

    def test_not_for_a_device_that_is_not_a_till(self, w):
        status_code, body = _refusal(_generate(w, shopId=w.shop.id, deviceRole="kds", licenseProduct="till", kds={"screenRole": "expo"}))
        assert (status_code, body["detail"]) == (422, DL.NOT_APPLICABLE)
        assert "מסך מטבח" in body["message"]
        # Without one, a screen's code has none.
        code = _generate(w, shopId=w.shop.id, deviceRole="kds", kds={"screenRole": "expo"})
        assert code.license_product is None

    def test_an_unknown_product_is_refused(self, w):
        status_code, body = _refusal(_generate(w, deviceRole="till", licenseProduct="kiosk_web"))
        assert (status_code, body["detail"]) == (422, DL.INVALID)

    def test_the_machine_is_made_with_it_and_the_history_says_so(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="till", product=DL.KIOSK_TILL, shop_id=w.shop.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert machine.license_product == DL.KIOSK_TILL
        (entry,) = machine.license_product_history
        assert entry["to"] == DL.KIOSK_TILL and entry["from"] is None and entry["source"] == DL.SOURCE_PAIRING
        assert entry["by"] == str(w.admin.id) and entry["byName"] == "admin" and entry["byRole"] == "super_admin"

    def test_an_older_dashboards_code_gets_the_default(self, w, monkeypatch):
        _seat(monkeypatch)
        # Kept referenced: a reload from SQLite would read `expires_at` naive.
        code = _code(w, role=None, shop_id=w.shop.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert machine.license_product == DL.TILL
        kiosk_code = _code(w, role="kiosk", shop_id=w.shop.id, options={"controllerMachineIds": []})
        kiosk = P.validate_pairing_code(w.db, kiosk_code.code, {}, "K")
        assert kiosk.license_product == DL.KIOSK and w.db.get(KioskDevice, kiosk.id) is not None

    def test_a_kiosk_code_paired_as_a_kiosk_fits(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="kiosk", product=DL.KIOSK, shop_id=w.shop.id, options={"controllerMachineIds": []})
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert w.db.get(KioskDevice, machine.id) is not None
        fields = DL.machine_fields(w.db, machine)
        assert fields["licenseProduct"] == DL.KIOSK and fields["licenseMismatch"] is False

    def test_a_kiosk_code_left_a_till_is_flagged(self, w):
        # No shop: the conversion cannot run, the device stays a till with its kiosk license.
        code = _code(w, role="kiosk", product=DL.KIOSK)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Kiosk")
        assert w.db.get(KioskDevice, machine.id) is None
        assert DL.machine_fields(w.db, machine)["licenseMismatch"] is True

    def test_a_screen_gets_none(self, w):
        code = _code(w, role="order_status_board", shop_id=None)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Board")
        assert machine.is_fiscal is False and machine.license_product is None
        assert DL.product_of(w.db, machine) is None

    def test_the_device_hears_it_in_the_answer(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, role="till", product=DL.KIOSK_TILL, shop_id=w.shop.id)
        out = PR.validate_pairing(pairing_data=PairingCodeValidate(code=code.code, device_info={}), db=w.db)
        assert out["licenseProduct"] == DL.KIOSK_TILL and out["licenseProductLabel"] == "קיוסק + קופה (משולב)"
        assert out["deviceRole"] == "till"

    def test_a_replacement_keeps_the_rows_own(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        code = PairingCode(
            id=uuid.uuid4(), code=f"R{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id, tenant_id=w.tenant.id,
            target_machine_id=w.till.id, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
        )
        w.db.add(code)
        w.db.flush()
        machine = P.validate_pairing_code(w.db, code.code, {"serial": "NEW-1"}, None)
        assert machine.id == w.till.id and machine.license_product == DL.KIOSK_TILL


# ── The machine page ─────────────────────────────────────────────────────────


class TestMachinePage:
    def test_a_super_admin_changes_it_and_it_is_recorded(self, w):
        _store(w, w.till, DL.TILL)
        out = _set_license(w, w.till, "kiosk_till")
        page = POSMachineResponse.model_validate(out).model_dump(by_alias=True)
        assert page["licenseProduct"] == "kiosk_till" and page["licenseProductStored"] == "kiosk_till"
        assert page["licenseProductLabel"] == "קיוסק + קופה (משולב)" and page["licenseMismatch"] is False
        last = page["licenseProductHistory"][-1]
        assert (last["from"], last["to"], last["source"]) == ("till", "kiosk_till", "dashboard")
        assert w.notified == [w.till.id]
        # The same again: no change, nothing recorded, nobody told.
        _set_license(w, w.till, "kiosk_till")
        assert len(w.till.license_product_history) == 2 and w.notified == [w.till.id]

    def test_a_distributor_for_their_own_devices_only(self, w):
        _store(w, w.till, DL.TILL)
        status_code, body = _refusal(_set_license(w, w.till, "kiosk_till", user=w.distributor))
        assert (status_code, body["detail"]) == (403, DL.ADMIN_ONLY)
        w.till.distributor_id = w.distributor.id
        w.db.commit()
        out = _set_license(w, w.till, "kiosk_till", user=w.distributor)
        assert out["licenseProduct"] == "kiosk_till"
        assert w.till.license_product_history[-1]["byRole"] == "distributor"

    @pytest.mark.parametrize("role", [UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER])
    def test_never_the_business_itself(self, w, role):
        user = {UserRole.COMPANY_MANAGER: w.company_manager, UserRole.SHOP_MANAGER: w.manager}[role]
        status_code, body = _refusal(_set_license(w, w.till, "kiosk_till", user=user))
        assert (status_code, body["detail"]) == (403, DL.ADMIN_ONLY)
        assert body["message"] == "רק מנהל-על או מפיץ קובעים את סוג הרישיון של מכשיר."

    def test_the_role_must_fit(self, w):
        _store(w, w.till, DL.TILL)
        status_code, body = _refusal(_set_license(w, w.till, "kiosk"))
        assert (status_code, body["detail"]) == (409, DL.ROLE_MISMATCH)
        assert w.till.license_product == DL.TILL
        kiosk_control.convert(w.db, w.admin, w.other)
        w.db.commit()
        _store(w, w.other, DL.KIOSK_TILL)
        status_code, body = _refusal(_set_license(w, w.other, "till"))
        assert (status_code, body["detail"]) == (409, DL.ROLE_MISMATCH)
        assert _set_license(w, w.other, "kiosk")["licenseProduct"] == "kiosk"

    def test_a_disabled_kiosk_is_no_kiosk_only(self, w):
        kiosk_control.convert(w.db, w.admin, w.other)
        w.db.get(KioskDevice, w.other.id).enabled = False
        w.db.commit()
        status_code, body = _refusal(_set_license(w, w.other, "kiosk"))
        assert (status_code, body["detail"]) == (409, DL.ROLE_MISMATCH) and "קיוסק כבוי" in body["message"]

    def test_bad_values_and_non_fiscal_devices(self, w):
        status_code, body = _refusal(_set_license(w, w.till, "kiosk_web"))
        assert (status_code, body["detail"]) == (422, DL.INVALID)
        w.till.is_fiscal = False
        w.db.commit()
        status_code, body = _refusal(_set_license(w, w.till, "till"))
        assert (status_code, body["detail"]) == (409, DL.NOT_APPLICABLE)

    def test_role_and_license_in_one_request(self, w):
        _store(w, w.till, DL.TILL)
        # Without the license: a "קופה בלבד" till never becomes a kiosk.
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kiosk"))
        assert (status_code, body["detail"]) == (409, DL.TILL_ONLY) and "קופה בלבד" in body["message"]
        assert w.db.get(KioskDevice, w.till.id) is None
        # With one that does not fit the new role.
        status_code, body = _refusal(_profile(w, w.till, deviceRole="kiosk", licenseProduct="till"))
        assert (status_code, body["detail"]) == (409, DL.ROLE_MISMATCH)
        # Both at once.
        out = _profile(w, w.till, deviceRole="kiosk", licenseProduct="kiosk")
        assert out["deviceRole"] == "kiosk" and out["licenseProduct"] == "kiosk"
        assert w.db.get(KioskDevice, w.till.id) is not None and w.till.id in w.notified
        # And back: a "קיוסק בלבד" kiosk never becomes a till on its own…
        status_code, body = _refusal(_profile(w, w.till, deviceRole="till"))
        assert (status_code, body["detail"]) == (409, DL.KIOSK_ONLY)
        # …but with a license that fits, it does.
        out = _profile(w, w.till, deviceRole="till", licenseProduct="till")
        assert out["deviceRole"] == "till" and out["licenseProduct"] == "till"

    def test_the_license_alone_on_the_profile_dialog(self, w):
        _store(w, w.till, DL.TILL)
        assert _profile(w, w.till, licenseProduct="kiosk_till")["licenseProduct"] == "kiosk_till"
        status_code, body = _refusal(_profile(w, w.till, user=w.manager, licenseProduct="till"))
        assert (status_code, body["detail"]) == (403, DL.ADMIN_ONLY)

    def test_a_derived_machine_is_never_refused(self, w):
        # No stored product (a row the migration did not reach): as before, whatever it derives to.
        assert w.till.license_product is None and DL.product_of(w.db, w.till) == DL.TILL
        assert _profile(w, w.till, deviceRole="kiosk")["deviceRole"] == "kiosk"
        assert DL.product_of(w.db, w.till) == DL.KIOSK
        fields = DL.machine_fields(w.db, w.till)
        assert fields["licenseProductStored"] is None and fields["licenseMismatch"] is False


# ── The kiosks page ──────────────────────────────────────────────────────────


class TestKiosksPage:
    def test_a_till_only_till_is_not_converted(self, w):
        _store(w, w.till, DL.TILL)
        status_code, body = _refusal(_convert(w, w.till, user=w.manager))
        assert (status_code, body["detail"]) == (409, DL.TILL_ONLY)
        assert "מנהל-על או מפיץ" in body["message"] and w.db.get(KioskDevice, w.till.id) is None

    def test_a_kiosk_only_kiosk_is_never_a_till(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        _convert(w, w.till)
        _store(w, w.till, DL.KIOSK)
        status_code, body = _refusal(
            KR.delete_kiosk(machine_id=w.till.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        )
        assert (status_code, body["detail"]) == (409, DL.KIOSK_ONLY)
        status_code, body = _refusal(KR.patch_kiosk(
            machine_id=w.till.id, body=KioskPatchIn(enabled=False), current_user=w.manager,
            active_tenant_id=w.tenant.id, db=w.db,
        ))
        assert (status_code, body["detail"]) == (409, DL.KIOSK_ONLY_DISABLE) and "נעילה למכירה" in body["message"]
        assert w.db.get(KioskDevice, w.till.id).enabled is True
        # A rename still goes through.
        out = KR.patch_kiosk(
            machine_id=w.till.id, body=KioskPatchIn(name="כניסה"), current_user=w.manager,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["name"] == "כניסה"

    def test_kiosk_till_does_both(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        _convert(w, w.till, user=w.manager)
        out = KR.patch_kiosk(
            machine_id=w.till.id, body=KioskPatchIn(enabled=False), current_user=w.manager,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["enabled"] is False
        result = KR.delete_kiosk(machine_id=w.till.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert result.status_code == 204

    def test_the_gate_switch_is_the_licenses(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        _convert(w, w.till)
        _store(w, w.till, DL.KIOSK)
        status_code, body = _refusal(KR.put_kiosk_till_mode_gate(
            machine_id=w.till.id, body=KR.TillModeGateIn(enabled=True), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        ))
        assert (status_code, body["detail"]) == (409, DL.TILL_MODE_BY_LICENSE) and "קיוסק + קופה" in body["message"]
        assert w.db.query(TillParameterValue).filter(TillParameterValue.scope_id == w.till.id).count() == 0

    def test_the_summary_shows_the_license(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        _convert(w, w.till)
        till_mode = kiosk_control.summary(w.db, w.db.get(KioskDevice, w.till.id))["tillMode"]
        assert till_mode["enabled"] is True and till_mode["byLicense"] is True
        assert till_mode["licenseProduct"] == "kiosk_till" and till_mode["licenseProductLabel"] == "קיוסק + קופה (משולב)"

    def test_the_dashboards_work_mode_commands(self, w):
        _store(w, w.till, DL.KIOSK_TILL)
        _convert(w, w.till)
        _store(w, w.till, DL.KIOSK)
        out = KR.post_kiosk_command(
            machine_id=w.till.id, body=KioskCommandIn(action="enter_till"), response=Response(),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        status_code, body = _refusal(out)
        assert (status_code, body["detail"]) == (409, "till_mode_disabled") and "קיוסק בלבד" in body["message"]
        # A "קופה בלבד" till: no kiosk-mode row from the dashboard either.
        _store(w, w.other, DL.TILL)
        _gate_value(w, w.other, True)
        out = KR.post_kiosk_command(
            machine_id=w.other.id, body=KioskCommandIn(action="return_kiosk"), response=Response(),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        status_code, body = _refusal(out)
        assert (status_code, body["detail"]) == (409, "till_mode_disabled") and "קופה בלבד" in body["message"]
        assert w.db.get(KioskDevice, w.other.id) is None


# ── The gate the device gets ─────────────────────────────────────────────────


class TestGate:
    def test_the_license_overrides_the_levels(self, w):
        _gate_value(w, w.till, True)
        assert KTM.effective(w.db, w.till)["enabled"] is True  # no license: the parameter, as before
        _store(w, w.till, DL.TILL)
        assert TP.till_parameters_for_machine(w.db, w.till).parameters[KTM.ENABLED_KEY] is False
        assert KTM.effective(w.db, w.till)["enabled"] is False
        _store(w, w.other, DL.KIOSK_TILL)
        assert TP.till_parameters_for_machine(w.db, w.other).parameters[KTM.ENABLED_KEY] is True

    def test_the_device_pulls_it(self, w):
        from app.routers.sync import get_till_parameters_sync

        _store(w, w.till, DL.KIOSK_TILL)
        resp = get_till_parameters_sync(machine_id=str(w.till.id), machine=w.till, db=w.db)
        assert resp.model_dump(mode="json", by_alias=True)["parameters"][KTM.ENABLED_KEY] is True

    def test_a_change_moves_the_watermark(self, w):
        before = TP.till_parameters_for_machine(w.db, w.till).updated_at
        DL.record(w.till, DL.KIOSK_TILL, user=w.admin, source=DL.SOURCE_DASHBOARD, now=datetime.now(timezone.utc) + timedelta(minutes=1))
        w.db.commit()
        after = TP.till_parameters_for_machine(w.db, w.till).updated_at
        assert after is not None and (before is None or after > before)

    def test_a_till_only_till_never_gets_a_kiosk_mode_row(self, w):
        _gate_value(w, w.till, True)
        _store(w, w.till, DL.TILL)
        assert KTM.ensure_home_till_row(w.db, w.till) is None
        out = KR.kiosk_sync(machine_id=str(w.till.id), body=_sync_in({"requestKioskMode": True}), machine=w.till, db=w.db)
        assert out["kiosk"] is False and out["licenseProduct"] == "till"
        _store(w, w.till, DL.KIOSK_TILL)
        out = KR.kiosk_sync(machine_id=str(w.till.id), body=_sync_in({"requestKioskMode": True}), machine=w.till, db=w.db)
        assert out["kiosk"] is True and out["homeRole"] == "till" and out["licenseProduct"] == "kiosk_till"


def _sync_in(status):
    from app.schemas.kiosk import KioskSyncIn

    return KioskSyncIn(status=status)


# ── What the device hears ────────────────────────────────────────────────────


class TestDevice:
    def test_machines_me_and_the_heartbeat(self, w):
        from app.schemas.pos_machine import MachineHeartbeatBody

        _store(w, w.till, DL.KIOSK_TILL)
        me = MR.get_my_machine(machine=w.till, db=w.db)
        assert me["licenseProduct"] == "kiosk_till" and me["license"]["product"] == "kiosk_till"
        beat = MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate({}), machine=w.till, db=w.db, request=None)
        assert beat["licenseProduct"] == "kiosk_till" and beat["license"]["product"] == "kiosk_till"
        assert beat["license"]["type"] == "permanent"  # the time license is untouched

    def test_kiosk_sync_both_answers(self, w):
        _store(w, w.till, DL.TILL)
        assert KR.kiosk_sync(machine_id=str(w.till.id), body=None, machine=w.till, db=w.db)["licenseProduct"] == "till"
        _store(w, w.other, DL.KIOSK)
        kiosk_control.convert(w.db, w.admin, w.other)
        w.db.commit()
        out = KR.kiosk_sync(machine_id=str(w.other.id), body=None, machine=w.other, db=w.db)
        assert out["kiosk"] is True and out["licenseProduct"] == "kiosk"

    def test_a_display_device_has_none(self, w):
        w.till.is_fiscal = False
        w.db.commit()
        assert MR.get_my_machine(machine=w.till, db=w.db)["licenseProduct"] is None


# ── The count, for billing ───────────────────────────────────────────────────


class TestCounts:
    def _counts(self, w, user=None, **kw):
        return MR.license_product_counts(
            all_tenants=kw.get("all_tenants", False), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def test_per_tenant_company_and_shop(self, w):
        _store(w, w.till, DL.TILL)
        _store(w, w.other, DL.KIOSK_TILL)
        _store(w, w.other_till, DL.KIOSK)
        loose = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, distributor_id=w.admin.id, name="Loose", machine_code="LOOSE-1",
            is_active=True, pairing_status=PairingStatus.PAIRED,
        )
        retired = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="Old",
            machine_code="OLD-1", is_active=False, pairing_status=PairingStatus.ASSIGNED,
        )
        screen = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="KDS",
            machine_code="KDS-1", is_active=True, is_fiscal=False, pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add_all([loose, retired, screen])
        w.db.commit()
        _store(w, loose, DL.TILL)
        out = self._counts(w)
        (tenant,) = out["tenants"]
        assert tenant["counts"] == {"till": 2, "kiosk": 1, "kiosk_till": 1, "total": 4}
        (company,) = out["companies"]
        assert company["counts"] == {"till": 1, "kiosk": 1, "kiosk_till": 1, "total": 3}
        shops = {s["name"]: s["counts"] for s in out["shops"]}
        assert shops["Center"] == {"till": 1, "kiosk": 0, "kiosk_till": 1, "total": 2}
        assert shops["North"] == {"till": 0, "kiosk": 1, "kiosk_till": 0, "total": 1}
        assert out["unassigned"] == [{"tenantId": str(w.tenant.id), "counts": {"till": 1, "kiosk": 0, "kiosk_till": 0, "total": 1}}]
        assert out["labels"]["kiosk_till"] == "קיוסק + קופה (משולב)"

    def test_a_derived_machine_counts_by_its_derivation(self, w):
        kiosk_control.convert(w.db, w.admin, w.other)
        w.db.commit()
        counts = self._counts(w)["tenants"][0]["counts"]
        assert counts["kiosk"] == 1 and counts["till"] >= 1

    def test_a_distributor_sees_their_own_and_the_business_nothing(self, w):
        w.till.distributor_id = w.distributor.id
        w.db.commit()
        _store(w, w.till, DL.KIOSK_TILL)
        out = self._counts(w, user=w.distributor)
        assert out["tenants"][0]["counts"] == {"till": 0, "kiosk": 0, "kiosk_till": 1, "total": 1}
        status_code, body = _refusal(self._counts(w, user=w.manager))
        assert (status_code, body["detail"]) == (403, DL.ADMIN_ONLY)


# ── The migration ────────────────────────────────────────────────────────────


def _script():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    return ScriptDirectory.from_config(config)


def test_the_migration_is_one_head_on_mains():
    script = _script()
    heads = script.get_heads()
    assert len(heads) == 1
    assert "c5e1a8d3f7b9" in {r.revision for r in script.walk_revisions("base", heads[0])}
    # On main's head of 16.10 (the 17.10 release merge revision).
    assert script.get_revision("c5e1a8d3f7b9").down_revision == "6b3b29c7bc5b"


_NO_PROXY = object()


def _render(*args, downgrade=False) -> str:
    """`alembic upgrade --sql` in PostgreSQL's dialect, alembic's proxies and the loggers put back afterwards."""
    import io
    import logging

    import alembic.context
    import alembic.op
    from alembic import command
    from alembic.config import Config

    from app.config import get_settings

    here = pathlib.Path(__file__).absolute().parents[1]
    buf = io.StringIO()
    cfg = Config(str(here / "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", str(here / "alembic"))
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    settings = get_settings()
    url = settings.database_url
    proxies = {m: vars(m).get("_proxy", _NO_PROXY) for m in (alembic.context, alembic.op)}
    try:
        settings.database_url = "postgresql://render-only/offline"
        (command.downgrade if downgrade else command.upgrade)(cfg, *args, sql=True)
    finally:
        settings.database_url = url
        for module, proxy in proxies.items():
            if proxy is _NO_PROXY:
                vars(module).pop("_proxy", None)
            else:
                vars(module)["_proxy"] = proxy
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


def test_the_migration_adds_three_nullable_columns_and_backfills_fiscal_rows_only():
    sql = _render("6b3b29c7bc5b:c5e1a8d3f7b9")
    body = sql.split("6b3b29c7bc5b", 1)[-1]
    assert "ALTER TABLE pos_machines ADD COLUMN license_product VARCHAR(16)" in body
    assert "ALTER TABLE pos_machines ADD COLUMN license_product_history JSONB" in body
    assert "ALTER TABLE pairing_codes ADD COLUMN license_product VARCHAR(16)" in body
    assert "NOT NULL" not in body.replace("version_num VARCHAR(32) NOT NULL", "")
    assert "DROP" not in body and "CREATE TABLE" not in body
    assert "UPDATE pos_machines SET license_product = CASE" in body
    assert "WHERE is_fiscal = TRUE AND license_product IS NULL" in body
    assert "p.key = 'kioskTillModeEnabled'" in body


def test_the_migration_downgrade_drops_them():
    sql = _render("c5e1a8d3f7b9:6b3b29c7bc5b", downgrade=True)
    assert "ALTER TABLE pos_machines DROP COLUMN license_product" in sql
    assert "ALTER TABLE pairing_codes DROP COLUMN license_product" in sql


def _backfill_module():
    import importlib.util

    path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / "c5e1a8d3f7b9_device_license_product.py"
    spec = importlib.util.spec_from_file_location("devlic_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_backfill_sql_derives_what_the_rule_says(w):
    """The migration's one statement, run on the world, gives every machine `derive`'s product."""
    from sqlalchemy import text

    from app.models.shop_area import ShopArea

    migration = _backfill_module()
    kiosk, disabled, home_till, gated_till, plain, machine_off, area_till = (
        _extra(w, f"M{i}") for i in range(7)
    )
    w.db.add(KioskDevice(machine_id=kiosk.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="K", enabled=True, controller_machine_ids=[]))
    w.db.add(KioskDevice(machine_id=disabled.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="D", enabled=False, controller_machine_ids=[]))
    w.db.add(KioskDevice(machine_id=home_till.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="H", enabled=True, controller_machine_ids=[], home_role="till"))
    w.db.commit()
    _gate_value(w, gated_till, True)
    _gate_value(w, plain, "yes")  # not a boolean: passed over
    # The other shop's company-level gate is the company's: put area/company values on a third shop's chain.
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    area_till.area_id = area.id
    p = w.db.query(TillParameter).filter(TillParameter.key == KTM.ENABLED_KEY).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type="area", scope_id=area.id, value=True))
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type="machine", scope_id=machine_off.id, value=False))
    w.db.commit()
    screen = _extra(w, "S")
    screen.is_fiscal = False
    w.db.commit()

    expected = {}
    for m in (kiosk, disabled, home_till, gated_till, plain, machine_off, area_till, w.till, w.other):
        expected[m.id] = DL.product_of(w.db, m)
    w.db.execute(text(migration.BACKFILL_SQL))
    w.db.commit()
    for m in (kiosk, disabled, home_till, gated_till, plain, machine_off, area_till, w.till, w.other, screen):
        w.db.refresh(m)
    got = {m.id: m.license_product for m in (kiosk, disabled, home_till, gated_till, plain, machine_off, area_till, w.till, w.other)}
    assert got == expected
    assert (got[kiosk.id], got[disabled.id], got[home_till.id], got[gated_till.id], got[plain.id], got[area_till.id]) == (
        "kiosk", "kiosk_till", "till", "kiosk_till", "till", "kiosk_till",
    )
    assert screen.license_product is None
    # A stored product is never overwritten.
    _store(w, w.till, DL.KIOSK_TILL)
    w.db.execute(text(migration.BACKFILL_SQL))
    w.db.commit()
    w.db.refresh(w.till)
    assert w.till.license_product == DL.KIOSK_TILL


def test_the_backfill_reads_the_company_level(w):
    from sqlalchemy import text

    migration = _backfill_module()
    m = _extra(w, "C")
    p = w.db.query(TillParameter).filter(TillParameter.key == KTM.ENABLED_KEY).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type="company", scope_id=w.company.id, value=True))
    w.db.commit()
    assert DL.product_of(w.db, m) == DL.KIOSK_TILL
    w.db.execute(text(migration.BACKFILL_SQL))
    w.db.commit()
    w.db.refresh(m)
    assert m.license_product == DL.KIOSK_TILL


def _extra(w, name):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name=name,
        machine_code=f"X-{uuid.uuid4().hex[:8]}", is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(m)
    w.db.commit()
    return m
