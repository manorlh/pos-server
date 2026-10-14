"""
"שרת מקומי ייעודי" — an Android device that does not sell (P:/specs/dedicated-local-server.md, §10 the
owner's decisions, §11 the contract; app/services/local_server_device.py, local_server_failover.py).

* The role: pairing a code as "שרת מקומי" (a shop, Android only), a non-fiscal machine flagged
  `is_local_server`, `deviceRole: "local_server"` on `machines/me` and the heartbeat.
* Licensing: never counted as a till license.
* Sales / shifts refused from it (403 `local_server_not_a_till`); a host's endpoints open to it.
* Host election: a valid, preferred host — main till, tables, printing, the local shop Z.
* "העברת שרת מקומי" in every direction; `closeOldShift` with a server as the old host refused.
* The automatic failover: off by default; never without a target, an online target, a target heard
  after the host fell silent; fires once after N minutes; never during a manual switch; audited.
* The heartbeat's `localServer` / `lanIdentity`, the device page's card, `lanDiscovery`.
* Remote commands: restart, logs, a test page, clearing the queue (with a confirmation).
* The work profile's "שרת מקומי: מכשיר ייעודי".
* The migration.

Runs on the in-memory SQLite world of tests/shift_world.py (the six-till owner's shop of
tests/test_independent_till.py), through the services and the router functions.
"""
from __future__ import annotations

import base64
import json
import types
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse

from app.models.audit_exception import AuditException
from app.models.dashboard_access import DashboardAccessProfile
from app.models.device_command import DeviceCommand
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.printers import KitchenPrinter
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import device_commands as DCR
from app.routers import local_server as LR
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.pairing_code import PairingCodeGenerateRequest
from app.schemas.pos_machine import MachineHeartbeatBody
from app.services import dashboard_access as DA
from app.services import display_devices as DD
from app.services import licenses as L
from app.services import local_server_device as LSD
from app.services import local_server_failover as LSF
from app.services import local_server_switch as LSS
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import pairing as P
from app.services import till_parameters as TP
from app.services import work_config as WC
from app.services import work_profile as WP
from app.services import work_profile_templates as T
from app.services.printers import print_host_of_shop
from app.services.tables import lan_host_block, tables_host_of_shop
from test_independent_till import closed_shift, local_body, set_param, upload, w  # noqa: F401

LAN = "רשת מקומית (קופה ראשית)"


def now():
    return datetime.now(timezone.utc)


def heard(machine, ago_seconds):
    machine.last_heartbeat_at = now() - timedelta(seconds=ago_seconds)


def add_server(w, name="שרת מקומי", *, ago=10, shop=None) -> POSMachine:
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, distributor_id=w.admin.id,
        name=name, machine_code=f"S-{uuid.uuid4().hex[:8]}", pos_number=None, is_active=True,
        pairing_status=PairingStatus.ASSIGNED, is_fiscal=False, is_local_server=True, platform="android",
        last_heartbeat_at=now() - timedelta(seconds=ago),
    )
    w.db.add(m)
    w.db.flush()
    return m


def user(w, role=UserRole.SHOP_MANAGER, *, sections=None, name="dana"):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=w.shop.id if role == UserRole.SHOP_MANAGER else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    if sections is not None:
        w.db.add(DashboardAccessProfile(user_id=u.id, full_access=False, sections=sections))
        w.db.flush()
    DA.forget(w.db)
    return u


def switch(w, target, *, by=None, **options):
    w.db.commit()
    body = LR.SwitchIn(targetMachineId=target.id, **options)
    return LR.post_local_server_switch(
        w.shop.id, body, BackgroundTasks(), current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def exceptions_of(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


def held(w, key, machine):
    return MT.is_on(TP.till_parameters_for_machine(w.db, machine).parameters.get(key))


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(TP, "publish_parameters_notify", lambda targets: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    from app.services import tables as T_

    monkeypatch.setattr(T_, "tables_changed", lambda *a, **k: None)
    from app.services import device_commands as DC

    monkeypatch.setattr(DC, "wake", lambda machines: None)
    # Each test sees its own host, never a neighbour's cached one.
    LSD._HOST_CACHE.clear()


# ── The role and pairing ──────────────────────────────────────────────────────


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _pair_server(w, *, name=None, distributor=None):
    code = PairingCode(
        id=uuid.uuid4(), code=f"L{uuid.uuid4().hex[:7].upper()}", distributor_id=(distributor or w.admin).id,
        tenant_id=w.tenant.id, shop_id=w.shop.id, device_role="local_server", platform="android",
        kds_options={"name": name} if name else None,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return P.validate_pairing_code(w.db, code.code, {"platform": "android", "model": "Box"}, None), code


class TestRole:
    def test_a_code_needs_a_shop_and_android(self, w):
        status_code, body = _refusal(_generate(w, deviceRole="local_server"))
        assert (status_code, body["detail"]) == (400, "local_server_requires_shop") and "סניף" in body["message"]
        status_code, body = _refusal(_generate(w, shopId=w.shop.id, deviceRole="local_server", platform="windows"))
        assert (status_code, body["detail"]) == (422, "local_server_android_only") and "Android" in body["message"]
        code = _generate(w, shopId=w.shop.id, deviceRole="local_server", name="שרת המטבח")
        assert (code.device_role, code.platform, code.kds_options) == ("local_server", "android", {"name": "שרת המטבח"})

    def test_pairing_makes_a_non_fiscal_local_server_that_knows_it(self, w):
        server, _code = _pair_server(w)
        assert server.is_local_server is True and server.is_fiscal is False
        assert (server.shop_id, server.pairing_status, server.pos_number, server.document_prefix) == (
            w.shop.id, PairingStatus.ASSIGNED, None, None,
        )
        assert server.name == "שרת מקומי"  # no name typed: the role's
        me = machines_router.get_my_machine(machine=server)
        assert (me["deviceRole"], me["fiscal"], me["platform"]) == ("local_server", False, "android")
        block = me["localServer"]
        assert block["shopId"] == str(w.shop.id) and block["machineId"] == str(server.id)
        assert block["discovery"]["serviceType"] == "_r2mpos._tcp"
        assert block["discovery"]["txt"] == {
            "v": "1", "shop": str(w.shop.id), "mid": str(server.id), "role": "local_server", "kid": "",
        }
        assert block["heartbeatSeconds"] == 30 and block["identity"] == {"registered": False, "keyId": None}
        beat = machines_router.post_my_heartbeat(None, machine=server, db=w.db)
        assert beat["deviceRole"] == "local_server" and beat["localServer"]["machineId"] == str(server.id)
        # A till hears its own role on every beat too, and has no `localServer` block.
        till = machines_router.post_my_heartbeat(None, machine=w.six[1], db=w.db)
        assert till["deviceRole"] == "till" and "localServer" not in till
        assert machines_router.get_my_machine(machine=w.six[1])["localServer"] is None

    def test_a_typed_name_is_kept(self, w):
        server, _ = _pair_server(w, name="שרת המטבח")
        assert server.name == "שרת המטבח"

    def test_the_role_on_the_dashboard_and_never_changed_but_by_pairing(self, w):
        from app.services import device_profile as DP

        server = add_server(w)
        assert DP.current_role(w.db, server) == "local_server"
        assert DP.machine_fields(server, None)["deviceRole"] == "local_server"
        for wanted in ("till", "kds"):
            with pytest.raises(DP.DeviceProfileRefused) as e:
                DP.check_role_switch(w.db, server, wanted)
                DP.change_role(w.db, w.admin, server, wanted)
            assert e.value.body["detail"] == DD.ROLE_CHANGE_REQUIRES_PAIRING

    def test_never_a_shop_z_participant_and_never_excluded(self, w):
        from app.services import lan_server as LS
        from app.services import z_runs as ZR

        server = add_server(w)
        assert server.id not in {m.id for m in LZ.participants(w.db, w.shop.id)}
        assert not ZR.is_seated_in(server, w.shop.id)
        e = refused(LS.set_excluded, w.db, w.admin, server, True)
        assert e.detail["code"] == "local_server_cannot_be_excluded"


class TestLicense:
    def test_not_counted_as_a_till_license(self, w):
        server = add_server(w)
        assert L.effective_license(w.db, server)["countsAsTillLicense"] is False
        assert L.effective_license(w.db, w.six[0])["countsAsTillLicense"] is True
        assert machines_router.get_my_machine(machine=server)["license"]["countsAsTillLicense"] is False
        assert LSD.counts_as_till_license(server) is False and LSD.counts_as_till_license(w.six[0]) is True


# ── Sales refused, a host's endpoints open ────────────────────────────────────


class TestRefused:
    @pytest.fixture(scope="class")
    def client(self):
        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.main import app
        from app.middleware import auth

        server = types.SimpleNamespace(
            id=uuid.uuid4(), tenant_id=None, shop_id=None, is_fiscal=False, is_local_server=True,
        )

        def _db():
            yield MagicMock()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[auth.get_pos_machine_for_sync_path] = lambda: server
        app.dependency_overrides[auth.get_pos_machine_from_sync_machine_token] = lambda: server
        try:
            yield TestClient(app)
        finally:
            for dep in (get_db, auth.get_pos_machine_for_sync_path, auth.get_pos_machine_from_sync_machine_token):
                app.dependency_overrides.pop(dep, None)

    @pytest.mark.parametrize("method, path", [
        ("POST", "/sync/{m}/transactions"),
        ("POST", "/sync/{m}/shifts"),
        ("POST", "/sync/{m}/shifts/{s}/close"),
        ("POST", "/sync/{m}/till-z"),
        ("POST", "/sync/{m}/transmissions"),
        ("POST", "/sync/{m}/failed-payments"),
        ("POST", "/sync/{m}/prepaid-vouchers/redeem"),
        ("POST", "/sync/{m}/tables/{s}/save"),
        ("POST", "/sync/{m}/tables/{s}/pay"),
        ("POST", "/sync/{m}/kiosk/orders"),
    ])
    def test_sales_and_shifts_are_refused_with_its_own_code(self, client, method, path):
        url = "/api/v1" + path.replace("{m}", str(uuid.uuid4())).replace("{s}", str(uuid.uuid4()))
        res = client.request(method, url, json={}, headers={"Authorization": "Bearer x"})
        assert res.status_code == 403, res.text
        body = res.json()
        assert body["detail"] == "local_server_not_a_till" and body["deviceRole"] == "local_server"
        assert body["message"] == LSD.NOT_A_TILL_MESSAGE and "אינו קופה" in body["message"]

    def test_a_hosts_endpoints_admit_it_and_never_a_screen(self, w):
        from app.middleware import auth

        server = add_server(w)
        assert auth.require_host_machine(machine=server) is server
        assert auth.require_host_machine_token(machine=server) is server
        assert auth.require_host_machine(machine=w.six[0]) is w.six[0]
        with pytest.raises(DD.DeviceNotFiscal) as e:
            auth.require_fiscal_machine(machine=server)
        assert (e.value.status_code, e.value.body["detail"]) == (403, "local_server_not_a_till")
        screen = types.SimpleNamespace(id=uuid.uuid4(), is_fiscal=False)
        with pytest.raises(DD.DeviceNotFiscal) as e:
            auth.require_host_machine(machine=screen)
        assert e.value.body["detail"] == "device_not_fiscal"

    def test_which_routes_are_a_hosts(self):
        from fastapi.routing import APIRoute

        from app.main import app
        from app.middleware import auth

        def calls(dependant, out):
            for d in dependant.dependencies:
                out.add(d.call)
                calls(d, out)
            return out

        host = {auth.require_host_machine, auth.require_host_machine_token}
        found = set()
        for route in app.routes:
            if isinstance(route, APIRoute) and calls(route.dependant, set()) & host:
                found |= {(m, route.path.removeprefix("/api/v1")) for m in route.methods}
        assert found == {
            ("POST", "/sync/{machine_id}/tables/report"),
            # The host's copy of the waiters' assignment (P:/specs/table-waiter-assignment.md §9.6).
            ("POST", "/sync/{machine_id}/tables/assignments/report"),
            ("POST", "/sync/{machine_id}/shop-z/local"),
            ("POST", "/sync/{machine_id}/shop-z/local-request/ack"),
            ("POST", "/sync/{machine_id}/shop-z/remote-close"),
            ("POST", "/sync/{machine_id}/shop-z"),
            ("POST", "/sync/{machine_id}/shop-z/runs/{run_id}/proceed"),
            ("POST", "/sync/{machine_id}/device-commands/{command_id}/ack"),
        }


# ── Host election ─────────────────────────────────────────────────────────────


class TestHostElection:
    def test_a_server_marked_beside_a_till_wins_every_election(self, w):
        server = add_server(w)
        for key in ("mainTill", "printHostTill", "tablesHostTill"):
            set_param(w, key, "machine", w.six[0].id, True)
            set_param(w, key, "machine", server.id, True)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id
        assert print_host_of_shop(w.db, w.shop.id).id == server.id
        assert tables_host_of_shop(w.db, w.shop.id).id == server.id
        # The main till pickers list it first, saying what it is.
        first = MT.shop_tills_out(w.db, w.shop.id)[0]
        assert (first["machineId"], first["deviceRole"]) == (str(server.id), "local_server")
        assert "deviceRole" not in MT.shop_tills_out(w.db, w.shop.id)[1]

    def test_nothing_named_a_lone_server_holds_the_tables(self, w):
        server = add_server(w)
        assert tables_host_of_shop(w.db, w.shop.id).id == server.id
        add_server(w, "שרת גיבוי")
        assert tables_host_of_shop(w.db, w.shop.id) is None  # two and nothing named: the cloud never picks

    def test_the_tills_see_it_as_the_host(self, w):
        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        block = lan_host_block(w.db, w.six[2])
        assert (block["machineId"], block["deviceRole"], block["isSelf"]) == (str(server.id), "local_server", False)
        assert lan_host_block(w.db, server)["isSelf"] is True
        held_ = LSD.hosting(w.db, server)
        assert held_ == {"mainTill": True, "tables": True, "print": True, "shopZ": True}

    def test_the_local_shop_z_on_the_server_aggregates_the_tills_parts(self, w, z_activity_unchecked):
        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        assert LZ.local_mode_of_shop(w.db, w.shop) is True
        assert LSD.device_block(w.db, server)["localShopZ"] is True
        five = w.six[:5]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in five}
        code, out = upload(w, server, local_body(w, 1, [(m, [shifts[m.id]], None) for m in five]))
        assert code == 201, out
        z = w.db.query(ZReport).one()
        assert z.shop_sequence_number == 1 and z.machine_id is None and z.machine_count == 5
        assert z.offline_report["producedBy"]["machineId"] == str(server.id)
        # A till cannot file it: the server is the producer.
        code, out = upload(w, w.six[0], local_body(w, 2, [(w.six[1], [closed_shift(w, w.six[1], 2, "5.00")], None)]))
        assert code != 201


# ── Every direction of the switch ─────────────────────────────────────────────


class TestSwitch:
    def test_till_to_server_server_to_server_server_to_till(self, w):
        t1, t2 = w.six[0], w.six[1]
        MT.set_main_till(w.db, w.shop, t1.id)
        s1, s2 = add_server(w, "שרת 1"), add_server(w, "שרת 2")
        state = LSS.state(w.db, w.shop, w.admin)
        roles = {c["machineId"]: c["deviceRole"] for c in state["candidates"]}
        assert roles[str(s1.id)] == "local_server" and roles[str(t2.id)] == "till"
        # till → server
        heard(t1, 3600)
        out = switch(w, s1)
        assert out["mainTill"]["machineId"] == str(s1.id) and out["previous"]["machineId"] == str(t1.id)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == s1.id and held(w, "mainTill", s1)
        # server → server
        heard(s1, 3600)
        out = switch(w, s2)
        assert out["mainTill"]["machineId"] == str(s2.id) and out["previous"]["deviceRole"] == "local_server"
        assert tables_host_of_shop(w.db, w.shop.id).id == s2.id
        # server → till
        heard(s2, 3600)
        out = switch(w, t2)
        assert out["mainTill"]["machineId"] == str(t2.id)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == t2.id and not held(w, "mainTill", s2)
        assert [r["source"] for r in LSS.switches(w.shop)] == ["cloud", "cloud", "cloud"]

    def test_close_old_shift_does_not_apply_to_a_server(self, w):
        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        heard(server, 3600)
        e = refused(switch, w, w.six[1], closeOldShift=True)
        assert (e.status_code, e.detail["code"]) == (409, "old_server_has_no_shift")
        state = LSS.till_state(w.db, server)
        assert (state["deviceRole"], state["hasShifts"], state["openShift"], state["canCloseFromCloud"]) == (
            "local_server", False, None, False,
        )
        e = refused(LSS.close_from_cloud, w.db, w.admin, server)
        assert e.detail["code"] == "device_not_fiscal" and "שרת מקומי" in e.detail["message"]

    def test_a_server_heard_is_refused_unless_forced(self, w):
        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        e = refused(switch, w, w.six[1])
        assert e.detail["code"] == "host_online"
        assert switch(w, w.six[1], force=True)["forced"] is True

    def test_a_manual_switch_waits_for_another_and_then_sees_it(self, w, monkeypatch):
        server = add_server(w)
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        heard(w.six[0], 3600)
        w.db.commit()
        monkeypatch.setattr(LSS, "LOCK_WAIT_SECONDS", 0.05)
        with LSS.switch_lock(w.db, w.shop.id, wait=True):
            e = refused(switch, w, server)
        assert e.detail["code"] == "switch_in_progress"
        assert switch(w, server)["mainTill"]["machineId"] == str(server.id)


# ── The automatic failover ────────────────────────────────────────────────────


def failover(w, *, by=None, **body):
    w.db.commit()
    return LR.put_local_server_failover(
        w.shop.id, LR.FailoverIn(**body), current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


class TestFailover:
    def setup_host(self, w, *, host_silent, target_ago=5):
        server = add_server(w, ago=host_silent)
        set_param(w, "mainTill", "machine", server.id, True)
        target = w.six[1]
        heard(target, target_ago)
        return server, target

    def test_off_by_default_and_never_acts_off(self, w):
        server, target = self.setup_host(w, host_silent=3600)
        out = LR.get_local_server_failover(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (out["enabled"], out["targetMachineId"], out["minutes"]) == (False, None, 3)
        assert (out["defaultMinutes"], out["armed"], out["status"]["code"]) == (3, False, "off")
        w.db.commit()
        assert LSF.run_shop(w.db, w.shop.id)["fired"] is False
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id
        assert LSS.state(w.db, w.shop, w.admin)["failover"]["enabled"] is False

    def test_who_changes_it_and_every_change_is_audited(self, w):
        server, target = self.setup_host(w, host_silent=10)
        manager = user(w, sections={"devices": "edit"})
        e = refused(failover, w, by=manager, enabled=True, targetMachineId=target.id)
        assert e.detail["code"] == "local_server_switch_forbidden"
        support = user(w, sections={"devices": "edit", LSS.SECTION: "edit"}, name="support")
        out = failover(w, by=support, enabled=True, targetMachineId=target.id, minutes=4)
        assert (out["enabled"], out["targetMachineId"], out["minutes"], out["canEdit"]) == (True, str(target.id), 4, True)
        assert out["armed"] is True and out["status"]["code"] == "host_heard"
        rows = exceptions_of(w, "local_server_failover_changed")
        assert len(rows) == 1 and rows[0].details["by"] == "support" and "הודלק" in rows[0].details["summary"]
        assert rows[0].details["before"]["enabled"] is False and rows[0].details["after"]["minutes"] == 4
        failover(w, enabled=False, targetMachineId=target.id, minutes=4)
        assert len(exceptions_of(w, "local_server_failover_changed")) == 2

    def test_never_without_a_target_and_a_target_that_may_serve(self, w):
        self.setup_host(w, host_silent=3600)
        e = refused(failover, w, enabled=True)
        assert (e.status_code, e.detail["code"]) == (422, "failover_target_required")
        e = refused(failover, w, enabled=True, targetMachineId=w.other_till.id)
        assert e.detail["code"] == "target_not_in_shop"
        e = refused(failover, w, enabled=True, targetMachineId=w.six[1].id, minutes=1)
        assert e.detail["code"] == "failover_minutes_invalid"
        w.six[2].lan_server_excluded = True
        e = refused(failover, w, enabled=True, targetMachineId=w.six[2].id)
        assert (e.detail["code"], e.detail["reason"]) == ("target_not_eligible", "lan_excluded")

    def test_never_to_a_target_that_is_offline(self, w):
        server, target = self.setup_host(w, host_silent=3600, target_ago=3600)
        failover(w, enabled=True, targetMachineId=target.id)
        out = LSF.run_shop(w.db, w.shop.id)
        assert (out["fired"], out["reason"]) == (False, "target_offline")
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id

    def test_not_while_the_host_is_heard_and_not_when_the_whole_shop_went_quiet(self, w):
        server, target = self.setup_host(w, host_silent=100)  # under 3 minutes
        failover(w, enabled=True, targetMachineId=target.id)
        assert LSF.run_shop(w.db, w.shop.id)["reason"] == "host_heard"
        # The shop's internet fell: the host 4 minutes silent, the target 3 — never heard since.
        heard(server, 240)
        heard(target, 180)
        w.db.commit()
        out = LSF.run_shop(w.db, w.shop.id)
        assert (out["fired"], out["reason"]) == (False, "target_not_heard_since")
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id

    def test_fires_once_after_n_minutes_the_same_switch_audited_and_never_back(self, w):
        server, target = self.setup_host(w, host_silent=200, target_ago=5)  # 3 min 20 s
        failover(w, enabled=True, targetMachineId=target.id)
        out = LSF.run_shop(w.db, w.shop.id)
        assert out["fired"] is True, out
        assert MT.main_till_of_shop(w.db, w.shop.id).id == target.id
        assert tables_host_of_shop(w.db, w.shop.id).id == target.id
        record = LSS.switches(w.shop)[-1]
        assert (record["source"], record["by"], record["forced"], record["closedShift"]) == (
            "auto_failover", "גיבוי אוטומטי", False, None,
        )
        assert record["from"]["machineId"] == str(server.id) and record["failoverMinutes"] == 3
        alert = exceptions_of(w, "local_server_failover")
        assert len(alert) == 1 and alert[0].severity == "high" and alert[0].machine_id == target.id
        assert "גיבוי אוטומטי" in alert[0].details["summary"]
        switched = exceptions_of(w, "local_server_switched")
        assert len(switched) == 1 and switched[0].severity == "high"
        assert LSF.view(w.db, w.shop, w.admin)["lastFired"]["to"]["machineId"] == str(target.id)
        # Again: the target is the host now — nothing (never twice, never back).
        out = LSF.run_shop(w.db, w.shop.id)
        assert (out["fired"], out["reason"]) == (False, "target_is_host")
        # The old server returns and the new one falls silent: still never moved back by itself.
        heard(server, 5)
        heard(target, 3600)
        w.db.commit()
        assert LSF.run_shop(w.db, w.shop.id)["reason"] == "target_is_host"
        assert len(LSS.switches(w.shop)) == 1 and len(exceptions_of(w, "local_server_failover")) == 1

    def test_the_minutes_set_are_the_minutes_waited(self, w):
        server, target = self.setup_host(w, host_silent=200)
        failover(w, enabled=True, targetMachineId=target.id, minutes=5)
        assert LSF.run_shop(w.db, w.shop.id)["reason"] == "host_heard"
        heard(server, 320)
        w.db.commit()
        assert LSF.run_shop(w.db, w.shop.id)["fired"] is True

    def test_never_while_a_manual_switch_is_in_progress(self, w):
        server, target = self.setup_host(w, host_silent=3600)
        failover(w, enabled=True, targetMachineId=target.id)
        with LSS.switch_lock(w.db, w.shop.id, wait=True):
            out = LSF.run_shop(w.db, w.shop.id)
        assert (out["fired"], out["reason"]) == (False, "switch_in_progress")
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id
        # The lock released, it acts.
        assert LSF.run_shop(w.db, w.shop.id)["fired"] is True

    def test_the_pass_reads_only_the_shops_that_switched_it_on(self, w):
        server, target = self.setup_host(w, host_silent=3600)
        assert LSF.enabled_shop_ids(w.db) == []
        failover(w, enabled=True, targetMachineId=target.id)
        assert LSF.enabled_shop_ids(w.db) == [w.shop.id]
        out = LSF.check_all(w.db)
        assert [o["fired"] for o in out] == [True]

    def test_a_server_as_the_target(self, w):
        t1 = w.six[0]
        set_param(w, "mainTill", "machine", t1.id, True)
        heard(t1, 3600)
        backup = add_server(w, "שרת גיבוי", ago=5)
        failover(w, enabled=True, targetMachineId=backup.id)
        assert LSF.run_shop(w.db, w.shop.id)["fired"] is True
        assert MT.main_till_of_shop(w.db, w.shop.id).id == backup.id


# ── The heartbeat, the card, discovery ────────────────────────────────────────


def _ec_key():
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    private = ec.generate_private_key(ec.SECP256R1())
    der = private.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return private, base64.b64encode(der).decode("ascii"), der


class TestHeartbeat:
    def beat(self, w, machine, body):
        return machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate(body), machine=machine, db=w.db)

    def test_the_servers_report_is_kept_and_a_bad_field_never_fails_the_beat(self, w):
        server = add_server(w)
        printer_id = str(uuid.uuid4())
        _priv, key, der = _ec_key()
        out = self.beat(w, server, {
            "localServer": {
                "connectedTills": 3,
                "tills": [{"machineId": str(w.six[0].id), "ageMs": 1200}, {"machineId": "nope"}],
                "openOrders": 7,
                "printQueue": {"pending": 2, "failed": 1, "oldestPendingAgeMs": 4000},
                "printers": [
                    {"printerId": printer_id, "name": "מטבח", "state": "OK", "lastOkAgeMs": 900},
                    {"printerId": None, "name": "בר", "state": "melting"},
                ],
                "uptimeMs": "x",
            },
            "lanSync": {"pending": 2, "oldestAgeMs": 1500},
            "lanIdentity": {"publicKey": key, "alg": "ES256"},
        })
        assert out["ok"] is True and out["deviceRole"] == "local_server"
        status = server.local_server_status
        assert (status["connectedTills"], status["openOrders"]) == (3, 7)
        assert status["tills"] == [{"machineId": str(w.six[0].id), "ageMs": 1200}]
        assert status["printQueue"] == {"pending": 2, "failed": 1, "oldestPendingAgeMs": 4000}
        assert [p["state"] for p in status["printers"]] == ["ok", "unknown"]
        assert "uptimeMs" not in status
        assert server.lan_identity["keyId"] == LSD.key_id(der) and server.lan_identity["alg"] == "ES256"
        assert out["localServer"]["identity"] == {"registered": True, "keyId": LSD.key_id(der)}

    def test_a_key_that_is_not_p256_is_dropped(self, w):
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        server = add_server(w)
        other = ec.generate_private_key(ec.SECP384R1()).public_key().public_bytes(
            Encoding.DER, PublicFormat.SubjectPublicKeyInfo,
        )
        for bad in ({"publicKey": base64.b64encode(other).decode()}, {"publicKey": "!!"}, {"publicKey": "a", "alg": "RS256"}, "x"):
            self.beat(w, server, {"lanIdentity": bad})
        assert server.lan_identity is None
        # A till's beat carrying a `localServer` block keeps none of it.
        self.beat(w, w.six[0], {"localServer": {"openOrders": 3}})
        assert w.six[0].local_server_status is None

    def test_the_card_shows_all_of_it(self, w):
        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        printer = KitchenPrinter(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="מטבח", connection_type="network",
        )
        w.db.add(printer)
        w.db.flush()
        server.app_version, server.serial_number, server.lan_ip = "2.3.0", "SN1", "192.168.1.5"
        self.beat(w, server, {
            "localServer": {
                "connectedTills": 2, "tills": [{"machineId": str(w.six[0].id), "ageMs": 500}], "openOrders": 4,
                "printQueue": {"pending": 1, "failed": 0},
                "printers": [{"printerId": str(printer.id), "state": "no_paper"}],
            },
            "lanSync": {"pending": 0},
        })
        card = LR.get_machine_local_server(server.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (card["deviceRole"], card["online"], card["isHost"], card["fresh"]) == ("local_server", True, True, True)
        assert (card["connectedTills"], card["openOrders"], card["printQueue"]["pending"]) == (2, 4, 1)
        assert card["tills"][0]["posNumber"] == "1"
        assert card["printers"][0]["name"] == "מטבח" and card["printers"][0]["state"] == "no_paper"
        assert card["mirror"]["state"] == "synced"
        assert (card["appVersion"], card["serialNumber"], card["lanIp"]) == ("2.3.0", "SN1", "192.168.1.5")
        assert card["countsAsTillLicense"] is False and "clear_print_queue" in card["actions"]
        e = refused(LR.get_machine_local_server, w.six[0].id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "not_a_local_server"
        shop_card = LSS.state(w.db, w.shop, w.admin)["servers"]
        assert [(s["machineId"], s["isHost"], s["openOrders"]) for s in shop_card] == [(str(server.id), True, 4)]

    def test_a_till_learns_the_host_and_verifies_a_discovered_one(self, w):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import load_der_public_key

        server = add_server(w)
        set_param(w, "mainTill", "machine", server.id, True)
        private, key, der = _ec_key()
        self.beat(w, server, {"lanIdentity": {"publicKey": key}})
        beat = self.beat(w, w.six[2], {})
        disco = beat["lanDiscovery"]
        assert (disco["protocol"], disco["serviceType"], disco["shopId"]) == ("r2m-lan-v1", "_r2mpos._tcp", str(w.shop.id))
        assert disco["host"] == {
            "machineId": str(server.id), "deviceRole": "local_server", "name": "שרת מקומי",
            "publicKey": key, "keyId": LSD.key_id(der),
        }
        assert machines_router.get_my_machine(machine=w.six[2])["lanDiscovery"]["host"]["machineId"] == str(server.id)
        assert lan_host_block(w.db, w.six[2])["keyId"] == LSD.key_id(der)
        # The challenge (§11.6): the server signs, the till verifies by the key the cloud gave it.
        nonce = base64.urlsafe_b64encode(b"0123456789abcdef").decode().rstrip("=")
        message = LSD.hello_message(w.shop.id, server.id, nonce)
        assert message == f"r2m-lan-hello|v1|{w.shop.id}|{server.id}|{nonce}".encode()
        signature = private.sign(message, ec.ECDSA(hashes.SHA256()))
        load_der_public_key(base64.b64decode(disco["host"]["publicKey"])).verify(signature, message, ec.ECDSA(hashes.SHA256()))
        # An independent till and a screen are told nothing.
        w.six[5].independent_till, w.six[5].z_mode = True, "till"
        assert LSD.discovery_for(w.db, w.six[5]) is None
        assert LSD.discovery_for(w.db, types.SimpleNamespace(shop_id=w.shop.id, is_fiscal=False)) is None


# ── Remote commands ───────────────────────────────────────────────────────────


def command(w, machine, **body):
    w.db.commit()
    return LR.post_machine_local_server_command(
        machine.id, LR.ServerCommandIn(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


class TestCommands:
    def test_restart_logs_test_page_and_a_confirmed_clear(self, w):
        server = add_server(w)
        printer = KitchenPrinter(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר", connection_type="network",
        )
        w.db.add(printer)
        assert command(w, server, action="restart_app")["action"] == "restart_app"
        assert command(w, server, action="upload_logs", params={"minutes": 60})["params"] == {"minutes": 60}
        out = command(w, server, action="print_test_page", params={"printerId": str(printer.id)})
        assert out["params"] == {"printerId": str(printer.id)} and out["status"] == "pending"
        e = refused(command, w, server, action="print_test_page", params={"printerId": str(uuid.uuid4())})
        assert e.detail["code"] == "printer_not_found"
        e = refused(command, w, server, action="clear_print_queue", params={"scope": "all"})
        assert e.detail["code"] == "confirm_required"
        out = command(w, server, action="clear_print_queue", params={"scope": "all"}, confirm=True)
        assert out["params"] == {"printerId": None, "scope": "all"}
        e = refused(command, w, server, action="lock")
        assert e.detail["code"] == "invalid_action"
        e = refused(command, w, w.six[0], action="restart_app")
        assert e.detail["code"] == "not_a_local_server"
        # The server pulls them and answers like any device.
        pulled = DCR.till_pull(str(server.id), machine=server, db=w.db)
        assert [c["action"] for c in pulled["commands"]] == [
            "restart_app", "upload_logs", "print_test_page", "clear_print_queue",
        ]
        cleared = pulled["commands"][-1]["id"]
        acked = DCR.till_ack(
            str(server.id), cleared, DCR.AckIn(status="done", result={"cleared": 3}), machine=server, db=w.db,
        )
        assert acked["status"] == "done"
        assert w.db.query(DeviceCommand).filter(DeviceCommand.machine_id == server.id).count() == 4

    def test_the_remote_control_panel_lists_it(self, w):
        server = add_server(w)
        rows = DCR.list_devices(None, w.shop.id, None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert str(server.id) in {r["machineId"] for r in rows}


# ── The work profile: "שרת מקומי: מכשיר ייעודי" ───────────────────────────────


def _profile(**changes):
    profile = next(t["profile"] for t in T.templates() if t["id"] == "restaurant_tables")
    profile.update(changes)
    return profile


class TestWorkProfile:
    def test_the_option_and_its_rule(self):
        assert T.validate(_profile())[T.LOCAL_SERVER_DEVICE] == "main_till"
        older = _profile()
        older.pop(T.LOCAL_SERVER_DEVICE)
        assert T.validate(older)[T.LOCAL_SERVER_DEVICE] == "main_till"  # an older dashboard's profile
        assert T.validate(_profile(localServerDevice="dedicated"))[T.LOCAL_SERVER_DEVICE] == "dedicated"
        with pytest.raises(T.ProfileInvalid) as e:
            T.validate(_profile(localServerDevice="dedicated", localServer=False, zType="shop_cloud", tablesMode="off"))
        assert e.value.field == T.LOCAL_SERVER_DEVICE
        with pytest.raises(T.ProfileInvalid):
            T.validate(_profile(localServerDevice="box"))
        assert T.value_label(T.LOCAL_SERVER_DEVICE, "dedicated") == "שרת מקומי: מכשיר ייעודי"

    def test_pairing_a_server_into_a_dedicated_shop_makes_it_the_host(self, w):
        w.shop.local_network = False
        w.db.commit()
        WP.apply_profile(w.db, w.admin, w.shop, _profile(localServerDevice="dedicated"))
        w.db.commit()
        view = WP.view(w.db, w.admin, w.shop)
        assert view["profile"][T.LOCAL_SERVER_DEVICE] == "dedicated"
        assert view["status"][T.LOCAL_SERVER_DEVICE]["state"] == "pending"
        assert "שרת מקומי" in view["status"][T.LOCAL_SERVER_DEVICE]["reason"]
        assert MT.main_till_of_shop(w.db, w.shop.id) is None  # a till is never made the host
        # A till added meanwhile waits for the server, in the shop Z from the cloud.
        offer = WP.suggest(w.db, w.shop, WC.context_for_machine(w.db, w.six[0]))
        assert offer["preset"] == WC.SHOP_Z_CLOUD and "שרת מקומי" in offer["reason"]
        server, code = _pair_server(w)
        w.db.refresh(w.shop)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id
        assert w.shop.local_network is True and LZ.local_mode_of_shop(w.db, w.shop)
        assert w.db.get(PairingCode, code.id).work_config_result["applied"] is True, w.db.get(PairingCode, code.id).work_config_result
        view = WP.view(w.db, w.admin, w.shop)
        assert view["status"][T.LOCAL_SERVER_DEVICE]["state"] == "applied"
        assert view["status"]["localServer"]["state"] == "applied"

    def test_the_save_moves_the_server_from_the_main_till_to_the_dedicated_one(self, w):
        t1 = w.six[0]
        MT.set_main_till(w.db, w.shop, t1.id)
        server = add_server(w)
        w.db.commit()
        WP.apply_profile(w.db, w.admin, w.shop, _profile())
        w.db.commit()
        assert WP.view(w.db, w.admin, w.shop)["profile"][T.LOCAL_SERVER_DEVICE] == "main_till"
        applied = WP.apply_profile(w.db, w.admin, w.shop, _profile(localServerDevice="dedicated"))
        w.db.commit()
        assert T.LOCAL_SERVER_DEVICE in applied.changes
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id
        record = LSS.switches(w.shop)[-1]
        assert (record["source"], record["from"]["machineId"], record["to"]["machineId"]) == (
            "work_profile", str(t1.id), str(server.id),
        )
        assert WP.view(w.db, w.admin, w.shop)["status"][T.LOCAL_SERVER_DEVICE]["state"] == "applied"
        # Back to "קופה ראשית": a save never moves the server back — the switch does.
        WP.apply_profile(w.db, w.admin, w.shop, _profile())
        w.db.commit()
        status = WP.view(w.db, w.admin, w.shop)["status"][T.LOCAL_SERVER_DEVICE]
        assert status["state"] == "blocked" and "העברת שרת מקומי" in status["reason"]
        assert MT.main_till_of_shop(w.db, w.shop.id).id == server.id

    def test_anyone_but_the_super_admin_pairing_leaves_it_waiting(self, w):
        w.shop.local_network = False
        w.db.commit()
        WP.apply_profile(w.db, w.admin, w.shop, _profile(localServerDevice="dedicated"))
        w.db.commit()
        distributor = user(w, role=UserRole.DISTRIBUTOR, name="dist")
        w.db.commit()
        server, code = _pair_server(w, distributor=distributor)
        assert MT.main_till_of_shop(w.db, w.shop.id) is None
        status = WP.view(w.db, w.admin, w.shop)["status"][T.LOCAL_SERVER_DEVICE]
        assert status["state"] == "pending" and status["reason"] == WP.WAIT_SUPER_ADMIN
        assert server.is_local_server is True

    def test_the_device_work_config_card_refuses_a_server(self, w):
        server = add_server(w)
        with pytest.raises(WC.WorkConfigRefused) as e:
            WC.apply(w.db, w.admin, server, {"preset": WC.MAIN_TILL})
        assert e.value.body["detail"] == "work_config_local_server"


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).absolute().parents[1] / "alembic" / "versions" / "e4a7c2d9b1f3_local_server_device.py"
        spec = importlib.util.spec_from_file_location("migration_e4a7c2d9b1f3", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_additive_and_offline(self):
        import io

        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == ("e4a7c2d9b1f3", "3bfb94dbebb2")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE pos_machines (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("INSERT INTO pos_machines (id) VALUES ('a')"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            cols = {c["name"] for c in sa.inspect(conn).get_columns("pos_machines")}
            assert {"is_local_server", "local_server_status", "local_server_status_at", "lan_identity"} <= cols
            # No machine changes: every existing row is not a server.
            assert conn.execute(sa.text("SELECT is_local_server FROM pos_machines")).scalar() in (0, False)
            assert "ix_pos_machines_is_local_server" in {i["name"] for i in sa.inspect(conn).get_indexes("pos_machines")}
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "ALTER TABLE pos_machines ADD COLUMN is_local_server BOOLEAN DEFAULT false NOT NULL" in sql
        assert "ADD COLUMN lan_identity JSONB" in sql

    def test_on_the_single_head(self):
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        # The release of 13.10.2026 joins this branch's head with its sibling PRs' in one merge
        # revision (78c88a7afc4f); the release of 14.10.2026 joins the two heads built on that one
        # (8d4f2a6c1e93 the phone-alert types, a7c3e9f1d2b4 remote approvals) in 9f55dd368692, the
        # detectors' push types (396f22daf19c) chain on it, and ba584f6fb704 joins that with
        # table-restore's a7d3e1c9b5f2 (dining_tables.label_only). Release 14.10b joins the three heads
        # built on ba584f6fb704 (e3b9d7a41c62 the tables_layout section on b637e9784d58 courses FIRE
        # v2, 5d1f8b3e7a92 the "הכל" tab, e4b7c2d9a6f1 customer display media) in bb6205ba290c, and
        # 6af69aa646d1 joins the two built on that one (7c4e2a9d1b6f exclusive login v2, d8a3f1c6e2b7
        # kitchen ticket designs). This migration stays on the single head's line; later ones chain on top.
        heads = script.get_heads()
        assert len(heads) == 1
        line = {r.revision for r in script.walk_revisions("base", heads[0])}
        assert {"4ff6c2ab6d7c", "6af69aa646d1", "bb6205ba290c", "ba584f6fb704", "a7d3e1c9b5f2", "396f22daf19c", "9f55dd368692", "78c88a7afc4f"} <= line
        assert set(script.get_revision("6af69aa646d1").down_revision) == {"7c4e2a9d1b6f", "d8a3f1c6e2b7"}
        # 4ff6c2ab6d7c (14.10d) joins that with bill-on-another-till's e7b2d9f4a6c3 (on c4d8e2f6a1b9).
        assert set(script.get_revision("4ff6c2ab6d7c").down_revision) == {"6af69aa646d1", "e7b2d9f4a6c3"}
        assert set(script.get_revision("bb6205ba290c").down_revision) == {"e3b9d7a41c62", "5d1f8b3e7a92", "e4b7c2d9a6f1"}
        assert set(script.get_revision("ba584f6fb704").down_revision) == {"396f22daf19c", "a7d3e1c9b5f2"}
        assert script.get_revision("396f22daf19c").down_revision == "9f55dd368692"
        assert set(script.get_revision("9f55dd368692").down_revision) == {"8d4f2a6c1e93", "a7c3e9f1d2b4"}
        assert "e4a7c2d9b1f3" in script.get_revision("78c88a7afc4f").down_revision
        assert "e4a7c2d9b1f3" in {r.revision for r in script.walk_revisions("base", "78c88a7afc4f")}
