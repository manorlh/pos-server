"""
"מכשיר תצוגה" — a KDS kitchen screen and the "מוכן / לא מוכן" board are NOT tills and not
accounting systems (app/services/display_devices.py, docs/SPEC_DEVICE_ROLE_MODEL.md §2.2).

* Adding one: the code carries the role, the platform and the screen; redeeming it makes a
  non-fiscal machine — no register number, no document prefix — with its `kds_devices` row
  and `kdsScreen`; `machines/me` says `kds` / `order_status_board`. A code for one platform
  refuses a device of the other, before anything is created.
* Every fiscal till endpoint refuses a display device (403 `device_not_fiscal`) — each route
  through the app, and a walk of `app.routes` so a new till write cannot forget it.
* Display devices are left out of the shop Z, the main till and host elections, "Z לכל
  הקופות", register numbers, the overview, report events and kiosk controllers.
* The KDS page making an existing till a screen: over a clean break only; it then is a
  display device (its number spent, its documents kept).

Runs on the in-memory SQLite world of tests/shift_world.py, through the router / service
functions; the route checks go through the real app with the machine dependencies stubbed.
"""
from __future__ import annotations

import json
import re
import types
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.models.kds import KdsDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.printers import KitchenStation
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import kds as kds_router
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.kds import KdsDeviceIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse, PairingCodeValidate
from app.schemas.pos_machine import POSMachineUpdate
from app.services import display_devices as DD
from app.services import kiosk_control
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import overview
from app.services import pairing as P
from app.services import register_number
from app.services import till_parameters as TP
from app.services import till_z
from app.services import z_runs as ZR
from app.services.independent_till import lan_members
from app.services.report_events import crud as report_events
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    TP.ensure_builtin_parameters(world.db)
    world.till, world.other = world.tills
    world.grill = KitchenStation(id=uuid.uuid4(), tenant_id=world.tenant.id, name="גריל")
    world.db.add(world.grill)
    # Committed: a refusal rolls the session back, which must not take the world with it.
    world.db.commit()
    return world


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _code(w, *, role, platform=None, options=None, shop=True) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"D{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=w.shop.id if shop else None, device_role=role, platform=platform,
        kds_options=options, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def _kds_flag(w, machine) -> bool:
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "kdsScreen").one()
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


def _screen(w, machine) -> KdsDevice:
    return w.db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).one()


def _pair(w, *, role, platform=None, options=None, info=None, name="מסך"):
    code = _code(w, role=role, platform=platform, options=options)
    return P.validate_pairing_code(w.db, code.code, info or {}, name)


def _display(w, role="kds", **kw):
    options = kw.pop("options", {"name": "Expo", "screenRole": "expo", "stationIds": []})
    return _pair(w, role=role, options=options, **kw)


# ── Adding a display device ───────────────────────────────────────────────────


class TestGenerate:
    def test_a_kds_code_stores_its_screen_and_platform(self, w):
        code = _generate(
            w, shopId=w.shop.id, deviceModel="GENERIC_ANDROID", deviceRole="kds", platform="windows",
            kds={"name": "  מסך   גריל ", "screenRole": "station", "stationIds": [str(w.grill.id)]},
        )
        assert (code.device_role, code.platform, code.kiosk_options) == ("kds", "windows", None)
        assert code.kds_options == {"name": "מסך גריל", "screenRole": "station", "stationIds": [str(w.grill.id)]}
        out = PairingCodeResponse.model_validate(code).model_dump(by_alias=True)
        assert (out["deviceRole"], out["platform"]) == ("kds", "windows")

    def test_a_board_code_is_a_pickup_screen(self, w):
        code = _generate(w, shopId=w.shop.id, deviceRole="order_status_board", kds={"screenRole": "station"})
        assert code.kds_options == {"name": None, "screenRole": "pickup", "stationIds": []}

    def test_the_platform_is_android_unless_said(self, w):
        assert _generate(w, deviceRole="till").platform == "android"
        assert _generate(w, shopId=w.shop.id, deviceRole="kds").kds_options["screenRole"] == "expo"

    @pytest.mark.parametrize("role", ["kds", "order_status_board"])
    def test_a_display_device_needs_a_shop(self, w, role):
        status_code, body = _refusal(_generate(w, deviceRole=role))
        assert (status_code, body["detail"]) == (400, f"{role}_requires_shop")
        assert "סניף" in body["message"]

    def test_a_station_screen_needs_a_station_of_the_tenant(self, w):
        status_code, body = _refusal(_generate(w, shopId=w.shop.id, deviceRole="kds", kds={"screenRole": "station"}))
        assert (status_code, body["detail"]) == (422, "station_device_needs_a_station")
        status_code, body = _refusal(_generate(
            w, shopId=w.shop.id, deviceRole="kds", kds={"screenRole": "station", "stationIds": [str(uuid.uuid4())]},
        ))
        assert (status_code, body["detail"]) == (422, "station_not_found")
        assert "עמדות" in body["message"]


class TestPairing:
    def test_a_kds_is_not_a_till(self, w):
        machine = _pair(
            w, role="kds", platform="android", info={"model": "Tab", "platform": "android"},
            options={"name": "גריל", "screenRole": "station", "stationIds": [str(w.grill.id)]},
        )
        assert machine.is_fiscal is False
        assert (machine.shop_id, machine.pairing_status) == (w.shop.id, PairingStatus.ASSIGNED)
        # No register number, no document prefix: nothing to number, nothing issued.
        assert (machine.pos_number, machine.document_prefix, machine.effective_document_prefix) == (None, None, None)
        screen = _screen(w, machine)
        assert (screen.role, screen.station_ids, screen.name, screen.is_active) == (
            "station", [str(w.grill.id)], "גריל", True,
        )
        assert _kds_flag(w, machine)  # an Android device opens its kitchen screen
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["fiscal"], me["platform"], me["posNumber"]) == ("kds", False, "android", None)

    def test_a_board_on_windows(self, w):
        machine = _pair(w, role="order_status_board", platform="windows", options={}, info={"platform": "windows"})
        assert machine.is_fiscal is False and machine.platform == "windows"
        assert _screen(w, machine).role == "pickup" and _kds_flag(w, machine)
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["fiscal"], me["platform"]) == ("order_status_board", False, "windows")

    def test_a_station_gone_since_leaves_an_expo_never_a_till(self, w):
        options = {"screenRole": "station", "stationIds": [str(uuid.uuid4())]}
        machine = _pair(w, role="kds", options=options)
        assert machine.is_fiscal is False and _screen(w, machine).role == "expo"

    def test_a_screen_that_cannot_be_written_never_leaves_it_fiscal(self, w, monkeypatch):
        from app.services import kds as KDS

        def _broken(*a, **k):
            raise RuntimeError("down")

        monkeypatch.setattr(KDS, "save_device", _broken)
        machine = _display(w)
        assert machine is not None and machine.is_fiscal is False and machine.pos_number is None
        assert w.db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).first() is None
        assert machines_router.get_my_machine(machine=machine)["deviceRole"] == "kds"

    @pytest.mark.parametrize(
        "platform, info, device",
        [("windows", {"model": "F20"}, "android"), ("android", {"platform": "windows"}, "windows"),
         ("windows", None, "android")],
    )
    def test_the_other_platform_is_refused_before_anything_is_created(self, w, platform, info, device):
        code = _code(w, role="kds", platform=platform, options={})
        # Committed (the refusal rolls back), not expired (SQLite reads `expires_at` naive).
        w.db.expire_on_commit = False
        w.db.commit()
        before = w.db.query(POSMachine).count()
        out = pairing_router.validate_pairing(PairingCodeValidate(code=code.code, device_info=info), db=w.db)
        status_code, body = _refusal(out)
        assert (status_code, body["detail"], body["codePlatform"], body["devicePlatform"]) == (
            422, "platform_mismatch", platform, device,
        )
        assert "Windows" in body["message"] and "Android" in body["message"]
        assert w.db.query(POSMachine).count() == before
        assert w.db.get(PairingCode, code.id).is_used is False

    def test_a_code_without_a_platform_checks_none(self, w):
        assert _pair(w, role="kds", options={}, info={"platform": "windows"}).platform == "windows"

    def test_a_till_code_still_makes_a_fiscal_till(self, w, monkeypatch):
        monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "3"))
        machine = _pair(w, role="till", platform="android")
        assert machine.is_fiscal is True and machine.pos_number == "3" and machine.platform == "android"
        assert w.db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).first() is None


# ── Every fiscal till endpoint refuses it ─────────────────────────────────────


def _app():
    from app.main import app

    return app


def _machine_routes():
    from fastapi.routing import APIRoute

    from app.middleware import auth

    machine_deps = {
        auth.get_pos_machine_for_sync_path, auth.get_pos_machine_from_sync_machine_token,
        auth.get_pos_machine_from_machine_token,
    }
    fiscal_deps = {auth.require_fiscal_machine, auth.require_fiscal_machine_token}

    def calls(dependant, out):
        for d in dependant.dependencies:
            out.add(d.call)
            calls(d, out)
        return out

    for route in _app().routes:
        if not isinstance(route, APIRoute):
            continue
        found = calls(route.dependant, set())
        if not found & machine_deps:
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            yield method, route.path.removeprefix("/api/v1"), bool(found & fiscal_deps)


#: The fiscal till writes: documents, shifts, Z (till, shop, local shop), transmissions,
#: offline card authorizations, payments (failed, pinpad, SynqPay), vouchers, tables (a
#: sale in progress), kiosk orders / pickup numbers / commands / open orders, training sales.
FISCAL_ROUTES = {
    ("POST", "/sync/{machine_id}/transactions"),
    ("POST", "/sync/{machine_id}/shifts"),
    ("POST", "/sync/{machine_id}/shifts/{shift_id}/close"),
    ("POST", "/sync/{machine_id}/shift-close/ack"),
    ("POST", "/sync/{machine_id}/transmissions"),
    ("POST", "/sync/{machine_id}/transmit/ack"),
    ("POST", "/sync/{machine_id}/till-z"),
    ("POST", "/sync/{machine_id}/till-z/ack"),
    ("POST", "/sync/{machine_id}/offline-authorizations"),
    ("PUT", "/sync/{machine_id}/payment-terminal"),
    ("PUT", "/sync/{machine_id}/pinpad-host"),
    ("POST", "/sync/{machine_id}/failed-payments"),
    ("POST", "/sync/{machine_id}/synqpay/pairing"),
    ("POST", "/sync/{machine_id}/synqpay/key-rejected"),
    ("POST", "/sync/{machine_id}/prepaid-vouchers/lookup"),
    ("POST", "/sync/{machine_id}/prepaid-vouchers/redeem"),
    ("POST", "/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/reverse"),
    ("POST", "/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/transaction"),
    ("POST", "/sync/{machine_id}/shop-z"),
    ("POST", "/sync/{machine_id}/shop-z/runs/{run_id}/proceed"),
    ("POST", "/sync/{machine_id}/shop-z/local-request/ack"),
    ("POST", "/sync/{machine_id}/shop-z/local"),
    ("POST", "/sync/{machine_id}/shop-z/remote-close"),
    ("POST", "/sync/{machine_id}/shop-z/remote-part"),
    ("POST", "/sync/{machine_id}/kiosk/orders"),
    ("POST", "/sync/{machine_id}/kiosk/pickup-number"),
    ("POST", "/sync/{machine_id}/kiosks/{kiosk_machine_id}/commands"),
    ("POST", "/sync/{machine_id}/kiosk/open-orders"),
    ("POST", "/sync/{machine_id}/kiosk/open-orders/{ref}/lock"),
    ("POST", "/sync/{machine_id}/kiosk/open-orders/{ref}/release"),
    ("POST", "/sync/{machine_id}/kiosk/open-orders/{ref}/paid"),
    ("POST", "/sync/{machine_id}/kiosk/open-orders/{ref}/cancel"),
    ("POST", "/sync/{machine_id}/training-documents"),
    ("POST", "/sync/{machine_id}/tables/report"),
    ("POST", "/sync/{machine_id}/tables/{table_id}/pay"),
    ("POST", "/sync/{machine_id}/tables/{table_id}/pay-part"),
    ("POST", "/sync/{machine_id}/tables/{table_id}/save"),
    ("POST", "/sync/{machine_id}/tables/take-over"),
}

#: Till writes a display device may make — none of them fiscal: its heartbeat, the KDS
#: itself, printing, the catalog / availability (a kitchen may 86 a dish), staff sessions
#: and attendance, messages, events, app updates, support's reset report, kiosk analytics /
#: config, and the removed (410) endpoints. A new till write must be added to one list.
OPEN_WRITES = {
    ("POST", "/machines/me/heartbeat"),
    ("POST", "/elevation/sessions"),
    ("DELETE", "/elevation/sessions/current"),
    ("POST", "/sync/{machine_id}/kds/release"),
    ("POST", "/sync/{machine_id}/kds/actions"),
    ("POST", "/sync/{machine_id}/app-update/status"),
    # "הפעל מחדש" (app/routers/device_management.py): any device-owner device, a screen too.
    ("POST", "/sync/{machine_id}/reboot/ack"),
    ("POST", "/sync/{machine_id}/till-reset/result"),
    ("POST", "/sync/{machine_id}/messages/{message_id}/ack"),
    ("POST", "/sync/{machine_id}/events"),
    ("POST", "/sync/{machine_id}/attendance/actions"),
    ("POST", "/sync/{machine_id}/user-session/claim"),
    ("POST", "/sync/{machine_id}/user-session/heartbeat"),
    ("POST", "/sync/{machine_id}/user-session/release"),
    ("POST", "/sync/{machine_id}/print-host"),
    ("POST", "/sync/{machine_id}/print-jobs"),
    ("POST", "/sync/{machine_id}/print-jobs/{job_id}/ack"),
    ("POST", "/sync/{machine_id}/print-jobs/{job_id}/cancel"),
    ("POST", "/sync/{machine_id}/print-redirects"),
    # "בון לא הודפס" (app/services/bon_alerts.py): the device's own print queue, reported — no fiscal effect.
    ("POST", "/sync/{machine_id}/kitchen/bon-alerts"),
    ("POST", "/sync/{machine_id}/printers"),
    ("POST", "/sync/{machine_id}/printers/discovered"),
    ("POST", "/sync/{machine_id}/upsell-stats"),
    ("POST", "/sync/{machine_id}/products"),
    ("PUT", "/sync/{machine_id}/products/{product_id}"),
    ("DELETE", "/sync/{machine_id}/products/{product_id}"),
    ("POST", "/sync/{machine_id}/products/{product_id}/image"),
    ("DELETE", "/sync/{machine_id}/products/{product_id}/image"),
    ("PUT", "/sync/{machine_id}/products/{product_id}/availability"),
    ("POST", "/sync/{machine_id}/categories"),
    ("PUT", "/sync/{machine_id}/categories/{category_id}"),
    ("DELETE", "/sync/{machine_id}/categories/{category_id}"),
    ("PUT", "/sync/{machine_id}/categories/{category_id}/availability"),
    ("PUT", "/sync/{machine_id}/machine-catalog"),
    ("PUT", "/sync/{machine_id}/product-order"),
    ("POST", "/sync/{machine_id}/kiosk/sync"),
    ("POST", "/sync/{machine_id}/kiosk/menu"),
    ("POST", "/sync/{machine_id}/kiosk/events"),
    ("POST", "/sync/{machine_id}/kiosk/basket-check"),
    ("POST", "/sync/{machine_id}/kiosk/alerts/{alert_id}/ack"),
    # The kiosk's web-renderer status (app/routers/kiosk_web.py): a report, no fiscal effect.
    ("POST", "/sync/{machine_id}/kiosk-web/status"),
    # Removed (410), kept answering old builds.
    ("POST", "/sync/{machine_id}/catalog"),
    ("POST", "/sync/{machine_id}/z-report"),
    ("POST", "/sync/{machine_id}/trading-day"),
    ("POST", "/sync/{machine_id}/close-day/ack"),
}


class TestFiscalEndpoints:
    def test_every_till_write_is_classified_and_every_fiscal_one_guarded(self):
        routes = list(_machine_routes())
        writes = {(m, p): guarded for m, p, guarded in routes if m != "GET"}
        unclassified = sorted(k for k, guarded in writes.items() if not guarded and k not in OPEN_WRITES)
        assert unclassified == [], (
            "A till write that is neither guarded (`dependencies=FISCAL_SYNC_PATH` / "
            "`FISCAL_MACHINE_TOKEN`) nor listed in OPEN_WRITES: a display device could call it."
        )
        assert sorted(k for k in FISCAL_ROUTES if not writes.get(k)) == []
        # Every table write is a sale in progress: guarded, all of them.
        assert all(g for (m, p), g in writes.items() if p.startswith("/sync/{machine_id}/tables/"))
        # Reading stays open: settings, catalog, parameters, the KDS board, app updates.
        reads = {(m, p): g for m, p, g in routes if m == "GET"}
        for path in ("/machines/me", "/sync/{machine_id}/kds/board", "/sync/{machine_id}/kds/device",
                     "/sync/{machine_id}/parameters", "/sync/{machine_id}/settings", "/sync/{machine_id}/app-update"):
            assert reads.get(("GET", path)) is False, path

    @pytest.fixture(scope="class")
    def client(self):
        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.middleware import auth

        app = _app()
        screen = types.SimpleNamespace(id=uuid.uuid4(), tenant_id=None, shop_id=None, is_fiscal=False)

        def _db():
            yield MagicMock()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[auth.get_pos_machine_for_sync_path] = lambda: screen
        app.dependency_overrides[auth.get_pos_machine_from_sync_machine_token] = lambda: screen
        try:
            yield TestClient(app)
        finally:
            for dep in (get_db, auth.get_pos_machine_for_sync_path, auth.get_pos_machine_from_sync_machine_token):
                app.dependency_overrides.pop(dep, None)

    @pytest.mark.parametrize("method, path", sorted(FISCAL_ROUTES))
    def test_each_refuses_a_display_device(self, client, method, path):
        url = "/api/v1" + re.sub(r"\{[^}]+\}", lambda _m: str(uuid.uuid4()), path)
        res = client.request(method, url, json={}, headers={"Authorization": "Bearer x"})
        assert res.status_code == 403, res.text
        body = res.json()
        assert body["detail"] == "device_not_fiscal"
        assert body["message"] == DD.NOT_FISCAL_MESSAGE and "אינו קופה" in body["message"]

    def test_a_till_passes(self, w):
        from app.middleware import auth

        assert auth.require_fiscal_machine(machine=w.till) is w.till
        assert auth.require_fiscal_machine_token(machine=w.till) is w.till
        w.till.is_fiscal = False
        with pytest.raises(DD.DeviceNotFiscal) as exc:
            auth.require_fiscal_machine_token(machine=w.till)
        assert (exc.value.status_code, exc.value.body["detail"]) == (403, "device_not_fiscal")


# ── Left out of every list of tills that counts for money ────────────────────


class TestExcluded:
    def test_never_a_shop_z_participant(self, w):
        screen = _display(w)
        assert not ZR.is_seated_in(screen, w.shop.id)
        assert screen.id not in {m.id for m in ZR.shop_tills(w.db, w.shop.id)}
        assert {m.id for m in LZ.participants(w.db, w.shop.id)} == {w.till.id, w.other.id}

    def test_a_till_made_a_screen_still_brings_its_shifts_to_the_z(self, w):
        # Its closed shifts are the shop's fiscal data: they reach the Z as a retired till's do.
        w.shift(w.till, 1)
        w.till.is_fiscal = False
        w.db.flush()
        tills = ZR.shop_tills(w.db, w.shop.id)
        assert w.till.id in {m.id for m in tills} and not ZR.is_seated_in(w.till, w.shop.id)

    def test_never_the_main_till_or_a_host(self, w):
        screen = _display(w)
        parameter = w.db.query(TillParameter).filter(TillParameter.key == MT.MAIN_TILL_KEY).one()
        w.db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=screen.id, value=True,
        ))
        w.db.flush()
        assert MT.main_till_of_shop(w.db, w.shop.id) is None
        assert screen.id not in {m.id for m in lan_members([w.till, w.other, screen])}
        assert str(screen.id) not in {t["machineId"] for t in MT.shop_tills_out(w.db, w.shop.id)}

    def test_no_till_z_no_register_number_no_prefix(self, w):
        screen = _display(w)
        screen.z_mode = "till"
        w.db.flush()
        assert screen not in till_z.shop_till_z_machines(w.db, w.shop)
        assert register_number.assign_register_number(w.db, screen) is None and screen.pos_number is None
        register_number.set_machine_shop(w.db, screen, w.other_shop.id)
        assert (screen.shop_id, screen.pos_number, screen.document_prefix) == (w.other_shop.id, None, None)

    def test_not_in_the_overview_or_report_events(self, w):
        screen = _display(w)
        tills = overview._visible_machines_query(w.db, w.admin, w.tenant.id, [w.shop.id]).all()
        assert screen.id not in {m.id for m in tills} and w.till.id in {m.id for m in tills}
        assert screen.id not in {m.id for m in report_events.shop_tills(w.db, w.shop)}

    def test_never_a_kiosk_controller(self, w):
        screen = _display(w)
        with pytest.raises(HTTPException) as exc:
            kiosk_control.validate_controllers(w.db, w.other, [str(screen.id)])
        assert exc.value.status_code == 422

    def test_it_files_no_document_so_no_export_has_one(self, w):
        # The Tax Authority export (app/services/open_format) is built from documents; the
        # endpoints that file them refuse a display device (TestFiscalEndpoints).
        from app.models.transaction import Transaction

        screen = _display(w)
        assert w.db.query(Transaction).filter(Transaction.machine_id == screen.id).count() == 0
        assert ("POST", "/sync/{machine_id}/transactions") in FISCAL_ROUTES

    def test_the_dashboard_asks_it_nothing_fiscal(self, w):
        screen = _display(w)
        out = machines_router.request_till_z(
            machine_id=screen.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _refusal(out)[:1] == (409,) and _refusal(out)[1]["detail"] == "device_not_fiscal"
        out = machines_router.update_machine(
            machine_id=str(screen.id), machine_data=POSMachineUpdate(documentPrefix="7"),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _refusal(out)[1]["detail"] == "device_not_fiscal"
        assert w.db.get(POSMachine, screen.id).document_prefix is None


# ── The KDS page making an existing till a screen ────────────────────────────


def _put_screen(w, machine, role="expo", stations=()):
    return kds_router.put_kds_device(
        w.shop.id, machine.id,
        KdsDeviceIn(role=role, stationIds=[uuid.UUID(str(s)) for s in stations], name="מסך"),
        background_tasks=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


class TestKdsPage:
    def test_a_till_made_a_screen_is_no_till_any_more(self, w):
        out = _put_screen(w, w.till)
        assert out["role"] == "expo"
        till = w.db.get(POSMachine, w.till.id)
        assert (till.is_fiscal, till.pos_number, till.document_prefix) == (False, None, None)
        assert machines_router.get_my_machine(machine=till)["deviceRole"] == "kds"
        # Its number stays spent: the shop's next till never gets "1" again (the counter).

    def test_only_over_a_clean_break(self, w):
        w.shift(w.till, 1, status=ShiftStatus.OPEN)
        with pytest.raises(HTTPException) as exc:
            _put_screen(w, w.till)
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "device_profile_open_shift"
        assert exc.value.detail["message"].startswith("לא ניתן להפוך את קופה 1 למסך מטבח")
        w.db.rollback()
        assert w.db.get(POSMachine, w.till.id).is_fiscal is True

    def test_not_while_a_shift_waits_for_its_z(self, w):
        w.shift(w.other, 1)
        with pytest.raises(HTTPException) as exc:
            _put_screen(w, w.other)
        assert (exc.value.status_code, exc.value.detail["code"]) == (409, "kds_screen_shifts_awaiting_z")
        assert "Z" in exc.value.detail["message"]

    def test_not_a_kiosk(self, w):
        kiosk_control.convert(w.db, w.admin, w.till)
        w.db.commit()
        with pytest.raises(HTTPException) as exc:
            _put_screen(w, w.till)
        assert exc.value.detail["code"] == "kds_screen_is_kiosk"

    def test_a_screen_from_before_the_rule_stays_a_till_and_is_flagged(self, w):
        w.db.add(KdsDevice(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.till.id,
            name="ישן", role="expo", station_ids=[], is_active=True,
        ))
        w.db.commit()
        _put_screen(w, w.till, role="station", stations=[w.grill.id])
        till = w.db.get(POSMachine, w.till.id)
        assert till.is_fiscal is True and till.pos_number == "1"
        row = machines_router._enrich_machines_batch([till], w.db)[0]
        assert (row["fiscal"], row["deviceRole"], row["kdsScreen"]["role"]) == (True, "till", "station")

    def test_removing_the_screen_leaves_a_display_device(self, w):
        screen = _display(w)
        kds_router.delete_kds_device(
            w.shop.id, screen.id, background_tasks=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        DD.forget(screen)
        assert screen.is_fiscal is False
        assert machines_router.get_my_machine(machine=screen)["deviceRole"] == "kds"
        assert DD.kds_screen_fields(DD.kds_device_of(w.db, screen)) is None

    def test_the_overview_says_which_machines_are_tills(self, w):
        screen = _display(w)
        out = kds_router.get_kds_shop(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        fiscal = {m["id"]: m["fiscal"] for m in out["machines"]}
        assert fiscal[str(screen.id)] is False and fiscal[str(w.till.id)] is True
