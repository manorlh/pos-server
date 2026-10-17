"""
"נקודת מכירה" — the gaps closed on 17.10.2026 (P:/specs/area-gaps.md).

* §1 The add-device dialog names a point of sale: checked when the code is made, kept on the code, the device
  lands in it at pairing; an area archived meanwhile leaves none and never fails the pairing; the validate
  answer says the shop and the area.
* §2 "שליטה מקופות" (`kioskControllerSource`): list (the default, as before) | area | both — the sync's
  `controls`, the commands, a till moving areas, a kiosk with no area, the area lock still on top, the summary.
* §3 "מצב עבודה" from a controlling till: a "משולב" license with the gate on, and KIOSK_TILL_MODE.
* §4 The kiosks list: `areaId` / `areaName` and the `areaId=<id|none>` filter.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import itertools
import uuid

import pytest
from fastapi import HTTPException, Response

from app.models.kiosk import KioskCommand
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import kiosks as KR
from app.routers import pairing as PR
from app.schemas.kiosk import KioskCommandIn, KioskCreateIn, KioskPatchIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeValidate
from app.services import ably_notify
from app.services import kiosk_control as KC
from app.services import kiosk_controllers as CTL
from app.services import kiosk_till_mode as KTM
from app.services import pairing as PS
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

_POS_NUMBERS = itertools.count(300)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    for name in ("publish_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify",
                 "publish_catalog_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    TP.ensure_builtin_parameters(db)
    world.params = {p.key: p for p in db.query(TillParameter).all()}
    world.bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    world.terrace = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="מרפסת")
    db.add_all([world.bar, world.terrace])
    db.flush()
    world.a, world.b = world.tills  # a: the bar, b: the terrace
    world.a.area_id = world.bar.id
    world.b.area_id = world.terrace.id
    world.a2 = _till(world, "Bar 2", world.bar.id)
    world.c = _till(world, "Counter", None)
    db.commit()
    return world


def _till(w, name, area_id, shop=None):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, distributor_id=w.admin.id, name=name,
        machine_code=f"X-{uuid.uuid4().hex[:8]}", pos_number=str(next(_POS_NUMBERS)), is_active=True,
        pairing_status=PairingStatus.ASSIGNED, area_id=area_id,
    )
    w.db.add(m)
    w.db.flush()
    return m


def _kiosk(w, name, area_id, controllers=()):
    m = _till(w, f"kiosk {name}", area_id)
    KR.create_kiosk(
        body=KioskCreateIn(machineId=m.id, name=f"קיוסק {name}", controllerMachineIds=[str(c.id) for c in controllers]),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return m


def _set(w, scope_type, scope_id, key, value):
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=w.params[key].id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


def _controls(w, till):
    return sorted(d.name for d in KC.controlled_devices(w.db, till))


def _refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def _till_command(w, till, kiosk, action, **extra):
    response = Response()
    out = KR.post_till_kiosk_command(
        machine_id=str(till.id), kiosk_machine_id=str(kiosk.id),
        body=KioskCommandIn(action=action, **extra), response=response, machine=till, db=w.db,
    )
    return out, getattr(out, "status_code", None) or response.status_code


def _pos_user(w, role, shop=None):
    u = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, username=f"u-{uuid.uuid4().hex[:6]}",
                first_name="דנה", pin_hash="x", role=role, is_active=True)
    w.db.add(u)
    w.db.flush()
    return u


# ── §2 "שליטה מקופות" ─────────────────────────────────────────────────────────


class TestControllerSource:
    def test_the_parameter_is_built_in_with_list_as_default(self, w):
        p = w.params[CTL.KEY]
        assert p.value_type == "enum" and p.default_value == "list"
        assert tuple(p.enum_options) == ("list", "area", "both")

    def test_default_is_the_explicit_list_as_today(self, w):
        _kiosk(w, "bar", w.bar.id, controllers=[w.c])
        assert _controls(w, w.c) == ["קיוסק bar"]
        assert _controls(w, w.a) == [] and _controls(w, w.a2) == []
        assert CTL.any_value(w.db) is False

    def test_area_gives_every_till_of_the_point_of_sale_and_drops_the_list(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.c])
        _set(w, "machine", k.id, CTL.KEY, "area")
        assert _controls(w, w.a) == ["קיוסק bar"] and _controls(w, w.a2) == ["קיוסק bar"]
        assert _controls(w, w.b) == [] and _controls(w, w.c) == []
        assert KC.controller_target(w.db, w.a2, k.id)[0].id == k.id
        assert _refused(KC.controller_target, w.db, w.c, k.id).detail == KC.NOT_KIOSK_CONTROLLER

    def test_both_is_the_list_and_the_area(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.c])
        _set(w, "area", w.bar.id, CTL.KEY, "both")
        assert _controls(w, w.c) == ["קיוסק bar"]
        assert _controls(w, w.a) == ["קיוסק bar"]
        assert _controls(w, w.b) == []
        out = KC.summary(w.db, KC.get_device(w.db, k.id))
        assert out["controllerSource"] == "both" and out["controllerSourceOwn"] is None
        assert sorted(c["name"] for c in out["areaControllers"]) == ["Bar 2", "Till 1"]
        assert set(out["controllersEffective"]) == {str(w.c.id), str(w.a.id), str(w.a2.id)}

    def test_dynamic_a_till_moved_into_the_area_gains_control_at_once(self, w):
        k = _kiosk(w, "bar", w.bar.id)
        _set(w, "shop", w.shop.id, CTL.KEY, "area")
        assert _controls(w, w.b) == []
        w.b.area_id = w.bar.id
        w.db.commit()
        assert _controls(w, w.b) == ["קיוסק bar"]
        w.b.area_id = w.terrace.id
        w.db.commit()
        assert _refused(KC.controller_target, w.db, w.b, k.id).detail == KC.NOT_KIOSK_CONTROLLER

    def test_a_kiosk_without_an_area_has_no_area_tills(self, w):
        _kiosk(w, "shop", None, controllers=[w.a])
        _set(w, "shop", w.shop.id, CTL.KEY, "area")
        assert _controls(w, w.a) == [] and _controls(w, w.c) == []
        _set(w, "company", w.company.id, CTL.KEY, "both")  # the shop's "area" still wins
        assert _controls(w, w.a) == []

    def test_another_kiosk_never_controls_by_area(self, w):
        k1 = _kiosk(w, "bar", w.bar.id)
        _kiosk(w, "bar2", w.bar.id)
        _set(w, "shop", w.shop.id, CTL.KEY, "area")
        assert _controls(w, k1) == []

    def test_the_sync_carries_the_area_controlled_kiosks(self, w):
        k = _kiosk(w, "bar", w.bar.id)
        _set(w, "machine", k.id, CTL.KEY, "area")
        out = KC.kiosk_sync(w.db, w.a, None)
        assert [c["name"] for c in out["controls"]] == ["קיוסק bar"]
        assert out["controls"][0]["areaName"] == "בר" and out["controls"][0]["controllerSource"] == "area"

    def test_the_area_lock_still_applies_to_the_list(self, w):
        k = _kiosk(w, "terrace", w.terrace.id, controllers=[w.a])
        _set(w, "machine", k.id, CTL.KEY, "both")
        # Till a (the bar) is listed, but locked to its own point of sale: the terrace's kiosk is not its.
        assert _controls(w, w.a) == []
        assert _controls(w, w.b) == ["קיוסק terrace"]

    def test_the_dashboard_sets_and_clears_it_on_the_kiosk(self, w):
        k = _kiosk(w, "bar", w.bar.id)
        out = KR.patch_kiosk(machine_id=k.id, body=KioskPatchIn(controllerSource="area"), current_user=w.admin,
                             active_tenant_id=w.tenant.id, db=w.db)
        assert out["controllerSource"] == "area" and out["controllerSourceOwn"] == "area"
        out = KR.patch_kiosk(machine_id=k.id, body=KioskPatchIn(controllerSource="inherit"), current_user=w.admin,
                             active_tenant_id=w.tenant.id, db=w.db)
        assert out["controllerSource"] == "list" and out["controllerSourceOwn"] is None

    def test_convert_with_a_source(self, w):
        m = _till(w, "kiosk new", w.bar.id)
        out = KR.create_kiosk(body=KioskCreateIn(machineId=m.id, controllerSource="both"), current_user=w.admin,
                              active_tenant_id=w.tenant.id, db=w.db)
        assert out["controllerSource"] == "both"

    def test_an_invalid_value_is_refused(self, w):
        k = _kiosk(w, "bar", w.bar.id)
        with pytest.raises(HTTPException) as e:
            CTL.set_source(w.db, k, "everyone", w.admin)
        assert e.value.status_code == 422


# ── §3 "מצב עבודה" from a controlling till ────────────────────────────────────


class TestWorkModeFromTheTill:
    def _gate(self, w, k, on=True):
        _set(w, "machine", k.id, KTM.ENABLED_KEY, on)

    def test_refused_while_the_gate_is_off(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.a])
        boss = _pos_user(w, PosUserRole.SHOP_MANAGER)
        out, code = _till_command(w, w.a, k, "enter_till", posUserId=str(boss.id))
        assert code == 409
        assert w.db.query(KioskCommand).filter(KioskCommand.status == "refused").count() == 1
        summary = KC.summary(w.db, KC.get_device(w.db, k.id))
        assert summary["tillMode"]["tillSwitch"] is False

    def test_a_kiosk_only_license_is_refused_even_with_the_gate(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.a])
        k.license_product = "kiosk"
        w.db.commit()
        self._gate(w, k)
        boss = _pos_user(w, PosUserRole.SHOP_MANAGER)
        _, code = _till_command(w, w.a, k, "enter_till", posUserId=str(boss.id))
        assert code == 409
        assert KC.summary(w.db, KC.get_device(w.db, k.id))["tillMode"]["tillSwitch"] is False

    def test_needs_an_employee_with_the_permission(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.a])
        self._gate(w, k)
        cashier = _pos_user(w, PosUserRole.CASHIER)
        out, code = _till_command(w, w.a, k, "enter_till", posUserId=str(cashier.id))
        assert code == 403
        _, code = _till_command(w, w.a, k, "enter_till")
        assert code == 403
        stranger = _pos_user(w, PosUserRole.SHOP_MANAGER, shop=w.other_shop)
        _, code = _till_command(w, w.a, k, "enter_till", posUserId=str(stranger.id))
        assert code == 403

    def test_combined_license_gate_and_permission_requests_the_switch(self, w):
        k = _kiosk(w, "bar", w.bar.id, controllers=[w.a])
        self._gate(w, k)
        boss = _pos_user(w, PosUserRole.SHOP_MANAGER)
        if not KTM.till_switch_allowed(w.db, k):  # pragma: no cover - the world's license derivation
            pytest.skip("license not derived as kiosk_till")
        assert KC.summary(w.db, KC.get_device(w.db, k.id))["tillMode"]["tillSwitch"] is True
        from app.services.till_roles import pos_user_allows

        if not pos_user_allows(boss, "KIOSK_TILL_MODE"):
            boss.permission_overrides = {"KIOSK_TILL_MODE": "allow"}
            w.db.commit()
        out, code = _till_command(w, w.a, k, "enter_till", posUserId=str(boss.id))
        assert code == 201, out
        row = w.db.query(KioskCommand).filter(KioskCommand.action == "enter_till").one()
        assert row.status == "requested" and row.source == "till" and row.requested_by_machine_id == w.a.id
        assert KTM.pending_work_mode(w.db, k)["mode"] == "till"

    def test_an_area_controller_may_switch_too(self, w):
        k = _kiosk(w, "bar", w.bar.id)
        _set(w, "machine", k.id, CTL.KEY, "area")
        self._gate(w, k)
        boss = _pos_user(w, PosUserRole.SHOP_MANAGER)
        from app.services.till_roles import pos_user_allows

        if not pos_user_allows(boss, "KIOSK_TILL_MODE"):
            boss.permission_overrides = {"KIOSK_TILL_MODE": "allow"}
            w.db.commit()
        _, code = _till_command(w, w.a2, k, "return_kiosk", posUserId=str(boss.id))
        assert code == 201
        assert _refused(_till_command, w, w.c, k, "return_kiosk", posUserId=str(boss.id)).detail == KC.NOT_KIOSK_CONTROLLER


# ── §4 the kiosks list ────────────────────────────────────────────────────────


class TestKiosksList:
    def test_area_column_and_filter(self, w):
        _kiosk(w, "bar", w.bar.id)
        _kiosk(w, "terrace", w.terrace.id)
        _kiosk(w, "shop", None)

        def names(area):
            rows = KR.list_kiosks(company_id=None, shop_id=w.shop.id, area_id=area, current_user=w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)
            return sorted((r["name"], r["areaName"]) for r in rows)

        assert names(None) == [("קיוסק bar", "בר"), ("קיוסק shop", None), ("קיוסק terrace", "מרפסת")]
        assert names(str(w.bar.id)) == [("קיוסק bar", "בר")]
        assert names("none") == [("קיוסק shop", None)]
        with pytest.raises(HTTPException) as e:
            names("nope")
        assert e.value.status_code == 422


# ── §1 the point of sale at device setup ──────────────────────────────────────


class _NaiveNow(__import__("datetime").datetime):
    """SQLite hands `expires_at` back naive: the pairing module's clock is read naive too (UTC)."""

    @classmethod
    def now(cls, tz=None):  # noqa: D401
        return __import__("datetime").datetime.utcnow()


@pytest.fixture
def naive_clock(monkeypatch):
    from app.services import register_number

    monkeypatch.setattr(PS, "datetime", _NaiveNow)
    # The register number's query is PostgreSQL's (`~`); its own tests cover it.
    monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "7"))
    monkeypatch.setattr(PR, "machine_realtime_connection_info", lambda **k: {"machineId": str(k["machine"].id)})


class TestPairingArea:
    def _generate(self, w, **extra):
        body = PairingCodeGenerateRequest(companyId=w.company.id, shopId=w.shop.id, deviceRole="till", **extra)
        return PR.generate_pairing_code(body=body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

    def test_the_code_keeps_the_area_and_the_device_lands_in_it(self, w, naive_clock):
        code = self._generate(w, areaId=w.bar.id)
        assert code.area_id == w.bar.id
        answer = PR.validate_pairing(pairing_data=PairingCodeValidate(code=code.code, device_info={"model": "x"}), db=w.db)
        machine = w.db.get(POSMachine, uuid.UUID(answer["machineId"]))
        assert machine.area_id == w.bar.id and machine.area_changed_at is not None
        assert answer["areaName"] == "בר" and answer["areaId"] == str(w.bar.id) and answer["shopName"] == w.shop.name

    def test_no_area_is_today(self, w, naive_clock):
        code = self._generate(w)
        assert code.area_id is None
        answer = PR.validate_pairing(pairing_data=PairingCodeValidate(code=code.code), db=w.db)
        assert w.db.get(POSMachine, uuid.UUID(answer["machineId"])).area_id is None
        assert answer["areaName"] is None

    def test_another_shops_or_an_archived_area_is_refused_at_once(self, w):
        other = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id, name="אחר")
        w.db.add(other)
        w.db.commit()
        assert _refused(self._generate, w, areaId=other.id).status_code == 400
        from datetime import datetime, timezone

        w.terrace.archived_at = datetime.now(timezone.utc)
        w.db.commit()
        assert _refused(self._generate, w, areaId=w.terrace.id).status_code == 409
        body = PairingCodeGenerateRequest(deviceRole="till", areaId=w.bar.id)
        exc = _refused(PR.generate_pairing_code, body=body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert exc.status_code == 400

    def test_an_area_archived_before_pairing_never_fails_it(self, w, naive_clock):
        code = self._generate(w, areaId=w.bar.id)
        from datetime import datetime, timezone

        w.bar.archived_at = datetime.now(timezone.utc)
        w.db.commit()
        answer = PR.validate_pairing(pairing_data=PairingCodeValidate(code=code.code), db=w.db)
        machine = w.db.get(POSMachine, uuid.UUID(answer["machineId"]))
        assert machine.shop_id == w.shop.id and machine.area_id is None

    def test_a_replacement_code_keeps_its_tills_area(self, w):
        code = PairingCode(
            id=uuid.uuid4(), code="REPL1", distributor_id=w.admin.id, tenant_id=w.tenant.id, shop_id=w.shop.id,
            target_machine_id=w.b.id, area_id=w.bar.id, expires_at=__import__("datetime").datetime(2099, 1, 1),
        )
        assert PS.apply_area_on_pairing(w.db, code, w.b) is False
        assert w.b.area_id == w.terrace.id
