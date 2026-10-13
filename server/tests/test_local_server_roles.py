"""
"תפקידי השרת המקומי" — which host roles a shop's dedicated server holds (P:/specs/dedicated-local-server.md
§11.9; app/services/local_server_roles.py), the owner: "אני יכול להגדיר שהשרת המקומי (שאינו קופה) הוא רק
להזמנות, אבל לא גם הדפסות?".

* Default: every role on the server. Each combination of tables / printing (or "none") / shop Z gives
  the elections, the server's `hosting` and the shop Z producer exactly that.
* Who, the lock, the audit and the notice — as a switch.
* The failover moves only the roles the silent device held.
* Remote kiosks and tills reach the holder through the cloud: the print relay (pending / lease / ack /
  expiry) follows the print role — retargeted when it moves — and their shop Z parts reach the server
  when it produces the local shop Z.

Runs on the six-till owner's shop of tests/test_independent_till.py ("רשת מקומית" on).
"""
from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.printers import KitchenPrinter, KitchenPrintJob
from app.models.till_message import TillMessage
from app.models.user import UserRole
from app.routers import local_server as LR
from app.routers import printers as printers_router
from app.schemas.kitchen_printers import PrintJobAckIn, PrintJobIn
from app.services import local_server_device as LSD
from app.services import local_server_failover as LSF
from app.services import local_server_roles as LSR
from app.services import local_server_switch as LSS
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import printers as K
from app.services.printers import print_host_of_shop
from app.services.tables import tables_host_of_shop
from app.services.till_messages import SERVER_SWITCH_TITLE
from test_dedicated_local_server import _quiet, add_server, exceptions_of, failover, heard, user  # noqa: F401
from test_independent_till import closed_shift, local_body, set_param, upload, w  # noqa: F401


def put_roles(w, *, by=None, **body):
    w.db.commit()
    return LR.put_local_server_roles(
        w.shop.id, LR.RolesIn.model_validate(body), current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


@pytest.fixture
def s(w):
    """The owner's shop with a dedicated server holding everything (the default), tills 1–6 online."""
    server = add_server(w)
    set_param(w, "mainTill", "machine", server.id, True)
    w.server = server
    w.db.commit()
    return w


def producer_of(w):
    return LZ.effective_producer(w.db, w.shop).machine_id


class TestDefaultAndCombinations:
    def test_the_default_is_every_role_on_the_server(self, s):
        out = LR.get_local_server_roles(s.shop.id, current_user=s.admin, active_tenant_id=s.tenant.id, db=s.db)
        assert out["applies"] is True and out["localMode"] is True and out["canEdit"] is True
        assert {r: v["onServer"] for r, v in out["roles"].items()} == {"tables": True, "print": True, "shopZ": True}
        assert out["roles"]["print"]["none"] is False and out["noPrintHostAllowed"] is True
        assert out["choices"][0]["deviceRole"] == "local_server"
        assert LSD.hosting(s.db, s.server) == {"mainTill": True, "tables": True, "print": True, "shopZ": True}

    @pytest.mark.parametrize("tables, printing, shop_z", list(itertools.product(
        ("server", "t2"), ("server", "t3", "none"), ("server", "t4"),
    )))
    def test_each_combination(self, s, tables, printing, shop_z):
        pick = {"server": s.server, "t2": s.six[1], "t3": s.six[2], "t4": s.six[3]}
        body = {
            "tables": str(pick[tables].id),
            "print": "none" if printing == "none" else str(pick[printing].id),
            "shopZ": str(pick[shop_z].id),
        }
        out = put_roles(s, **body)
        assert tables_host_of_shop(s.db, s.shop.id).id == pick[tables].id
        printer = print_host_of_shop(s.db, s.shop.id)
        assert (printer is None) if printing == "none" else (printer.id == pick[printing].id)
        assert MT.main_till_of_shop(s.db, s.shop.id).id == pick[shop_z].id
        assert producer_of(s) == str(pick[shop_z].id)
        expected = {"tables": tables == "server", "print": printing == "server", "shopZ": shop_z == "server"}
        assert {r: out["roles"][r]["onServer"] for r in LSR.ROLES} == expected
        assert out["roles"]["print"]["none"] is (printing == "none")
        held = LSD.hosting(s.db, s.server)
        assert {"tables": held["tables"], "print": held["print"], "shopZ": held["shopZ"]} == expected
        assert held["mainTill"] is (shop_z == "server")
        # The server's own block says the same (the Android server follows `hosting`).
        assert LSD.device_block(s.db, s.server)["hosting"] == held
        changed = [r for r in LSR.ROLES if not expected[r]]
        assert out["changed"] == changed
        if changed:
            record = LSS.switches(s.shop)[-1]
            assert record["source"] == "roles" and record["moved"] == changed
            assert record["roles"]["before"]["tables"]["machineId"] == str(s.server.id)
            assert exceptions_of(s, "local_server_switched")[-1].details["roles"]["after"] == record["roles"]["after"]
            notice = s.db.query(TillMessage).filter(TillMessage.title == SERVER_SWITCH_TITLE).one()
            assert "תפקידי השרת המקומי שונו" in notice.body
        else:
            assert LSS.switches(s.shop) == []

    def test_no_print_server_lets_every_till_print_its_network_printers(self, s):
        printer = KitchenPrinter(
            id=uuid.uuid4(), tenant_id=s.tenant.id, shop_id=s.shop.id, name="מטבח", connection_type="network",
            host="10.0.0.5", port=9100,
        )
        s.db.add(printer)
        put_roles(s, tables=str(s.server.id), print="none", shopZ=str(s.server.id))
        for till in (s.six[0], s.six[1], s.server):
            payload = K.sync_payload(s.db, till)
            assert payload["printHost"] is None and payload["hostsLan"] is False
            row = next(p for p in payload["printers"] if p["id"] == str(printer.id))
            # No print server: the till prints it itself (pos-android KitchenRouting → DIRECT).
            assert row["isHost"] is False and row["type"] == "network" and row["host"] == "10.0.0.5"
        # A print server named elsewhere (the printers page) ends "none".
        K.set_print_host(s.db, s.shop, s.six[2].id)
        assert print_host_of_shop(s.db, s.shop.id).id == s.six[2].id and LSR.print_none(s.shop) is False

    def test_out_of_local_mode_the_main_till_follows_the_tables_and_there_is_no_z_role(self, s):
        s.shop.local_network = False
        s.db.commit()
        e = refused(put_roles, s, tables=str(s.six[1].id), print=str(s.server.id), shopZ=str(s.server.id))
        assert (e.status_code, e.detail["code"]) == (422, "shop_z_role_not_local")
        out = put_roles(s, tables=str(s.six[1].id), print=str(s.server.id))
        assert MT.main_till_of_shop(s.db, s.shop.id).id == s.six[1].id
        assert out["roles"]["shopZ"]["applies"] is False
        assert print_host_of_shop(s.db, s.shop.id).id == s.server.id


class TestRules:
    def test_who_the_lock_and_the_holders(self, s):
        manager = user(s, sections={"devices": "edit"})
        e = refused(put_roles, s, by=manager, tables=str(s.server.id), print="none")
        assert e.detail["code"] == "local_server_switch_forbidden"
        support = user(s, sections={"devices": "edit", LSS.SECTION: "edit"}, name="support")
        assert put_roles(s, by=support, tables=str(s.server.id), print=str(s.six[1].id))["changed"] == ["print"]
        heard(s.six[2], 3600)
        e = refused(put_roles, s, tables=str(s.six[2].id), print=str(s.server.id))
        assert (e.detail["code"], e.detail["role"], e.detail["reason"]) == ("target_not_eligible", "tables", "offline")
        e = refused(put_roles, s, tables=str(s.other_till.id), print=str(s.server.id))
        assert e.detail["code"] == "target_not_in_shop"
        with LSS.switch_lock(s.db, s.shop.id, wait=True):
            import app.services.local_server_switch as mod

            old, mod.LOCK_WAIT_SECONDS = mod.LOCK_WAIT_SECONDS, 0.05
            try:
                e = refused(put_roles, s, tables=str(s.server.id), print=str(s.server.id))
            finally:
                mod.LOCK_WAIT_SECONDS = old
        assert e.detail["code"] == "switch_in_progress"

    def test_no_dedicated_server_no_roles(self, w):
        e = refused(put_roles, w, tables=str(w.six[0].id), print="none")
        assert e.detail["code"] == "no_local_server"

    def test_no_print_server_is_refused_while_remote_devices_print_through_the_cloud(self, s):
        LZ.set_remote_till_ids(s.shop, [s.six[4].id])
        e = refused(put_roles, s, tables=str(s.server.id), print="none")
        assert e.detail["code"] == "print_none_remote_devices" and e.detail["machineIds"] == [str(s.six[4].id)]
        view = LR.get_local_server_roles(s.shop.id, current_user=s.admin, active_tenant_id=s.tenant.id, db=s.db)
        assert view["noPrintHostAllowed"] is False and view["remoteDevices"][0]["machineId"] == str(s.six[4].id)

    def test_the_server_is_preferred_only_for_the_roles_it_was_given(self, s):
        put_roles(s, tables=str(s.six[1].id), print=str(s.server.id), shopZ=str(s.server.id))
        # The server is the main till (the shop Z) — yet the tables are the till's, as chosen.
        assert MT.main_till_of_shop(s.db, s.shop.id).id == s.server.id
        assert tables_host_of_shop(s.db, s.shop.id).id == s.six[1].id
        assert LSS.current_server(s.db, s.shop).id == s.six[1].id


# ── The failover: only what the silent device held ───────────────────────────


class TestFailoverPerRole:
    def test_a_print_only_server_gives_up_only_the_printing(self, s):
        put_roles(s, tables=str(s.six[1].id), print=str(s.server.id), shopZ=str(s.six[1].id))
        failover(s, enabled=True, targetMachineId=s.six[2].id)
        heard(s.server, 3600)
        s.db.commit()
        out = LSF.run_shop(s.db, s.shop.id)
        assert out["fired"] is True and len(out["switches"]) == 1
        assert print_host_of_shop(s.db, s.shop.id).id == s.six[2].id
        assert tables_host_of_shop(s.db, s.shop.id).id == s.six[1].id
        assert MT.main_till_of_shop(s.db, s.shop.id).id == s.six[1].id
        assert LSS.switches(s.shop)[-1]["roles"] == ["print"]

    def test_a_server_with_tables_and_z_keeps_the_printing_where_it_is(self, s):
        put_roles(s, tables=str(s.server.id), print=str(s.six[1].id), shopZ=str(s.server.id))
        failover(s, enabled=True, targetMachineId=s.six[2].id)
        heard(s.server, 3600)
        s.db.commit()
        assert LSF.run_shop(s.db, s.shop.id)["fired"] is True
        assert tables_host_of_shop(s.db, s.shop.id).id == s.six[2].id
        assert MT.main_till_of_shop(s.db, s.shop.id).id == s.six[2].id
        assert print_host_of_shop(s.db, s.shop.id).id == s.six[1].id
        assert sorted(LSS.switches(s.shop)[-1]["roles"]) == ["shopZ", "tables"]
        assert LSD.hosting(s.db, s.server) == {"mainTill": False, "tables": False, "print": False, "shopZ": False}

    def test_a_silent_print_till_moves_its_printing_the_server_keeps_the_rest(self, s):
        put_roles(s, tables=str(s.server.id), print=str(s.six[1].id), shopZ=str(s.server.id))
        failover(s, enabled=True, targetMachineId=s.six[2].id)
        heard(s.six[1], 3600)
        s.db.commit()
        out = LSF.run_shop(s.db, s.shop.id)
        assert out["fired"] is True
        assert print_host_of_shop(s.db, s.shop.id).id == s.six[2].id
        assert tables_host_of_shop(s.db, s.shop.id).id == s.server.id
        assert MT.main_till_of_shop(s.db, s.shop.id).id == s.server.id
        # Fires once: the printing is the target's now.
        assert LSF.run_shop(s.db, s.shop.id)["fired"] is False


# ── Remote kiosks and tills reach the holder through the cloud ────────────────


def make_remote_kiosk(s, till):
    s.db.add(KioskDevice(machine_id=till.id, tenant_id=s.tenant.id, shop_id=s.shop.id, name="קיוסק מרוחק"))
    LZ.set_remote_till_ids(s.shop, [till.id] + [uuid.UUID(i) for i in LZ.remote_till_ids(s.shop)])
    s.db.commit()
    return till


def network_printer(s):
    printer = KitchenPrinter(
        id=uuid.uuid4(), tenant_id=s.tenant.id, shop_id=s.shop.id, name="מטבח", connection_type="network",
        host="10.0.0.5", port=9100,
    )
    s.db.add(printer)
    s.db.commit()
    return printer


def send(s, sender, printer):
    body = PrintJobIn.model_validate({
        "id": str(uuid.uuid4()), "printerId": str(printer.id),
        "ticket": {"source": "sale", "createdAt": datetime.now(timezone.utc).isoformat(), "lines": []},
    })
    job, created = K.create_job(s.db, sender, body)
    s.db.commit()
    assert created
    return job


class TestRelay:
    def test_remote_kiosks_and_tills_relay_to_the_server_holding_the_print_role(self, s):
        kiosk = make_remote_kiosk(s, s.six[4])
        remote_till = s.six[5]
        LZ.set_remote_till_ids(s.shop, [kiosk.id, remote_till.id])
        printer = network_printer(s)
        assert print_host_of_shop(s.db, s.shop.id).id == s.server.id
        from_kiosk, from_till = send(s, kiosk, printer), send(s, remote_till, printer)
        assert from_kiosk.target_machine_id == s.server.id and from_till.target_machine_id == s.server.id
        # The server pulls them (handed out), not again within the lease, again after it.
        now = datetime.now(timezone.utc)
        pulled = K.pending_jobs(s.db, s.server, now)
        assert {j["id"] for j in pulled} == {str(from_kiosk.id), str(from_till.id)}
        assert K.pending_jobs(s.db, s.server, now + timedelta(seconds=30)) == []
        again = K.pending_jobs(s.db, s.server, now + K.JOB_LEASE + timedelta(seconds=1))
        assert {j["id"] for j in again} == {str(from_kiosk.id), str(from_till.id)}
        # Its ack is taken; the sender sees it done.
        acked = printers_router.ack_print_job(
            str(s.server.id), str(from_kiosk.id), PrintJobAckIn(status="done"), machine=s.server, db=s.db,
        )
        assert acked["status"] == "done"
        # No till can ack it but its target.
        with pytest.raises(HTTPException):
            K.ack_job(s.db, s.six[0], from_till.id, PrintJobAckIn(status="done"))
        # A job nobody took expires at its end.
        stale = send(s, kiosk, printer)
        K.expire_jobs(s.db, [stale], datetime.now(timezone.utc) + K.JOB_TTL + timedelta(seconds=1))
        assert stale.status == "expired"

    def test_the_print_role_given_to_a_till_takes_the_relay_with_it(self, s):
        kiosk = make_remote_kiosk(s, s.six[4])
        printer = network_printer(s)
        taken = send(s, kiosk, printer)
        K.pending_jobs(s.db, s.server)  # the server took it: in its own queue now
        waiting = send(s, kiosk, printer)
        put_roles(s, tables=str(s.server.id), print=str(s.six[1].id), shopZ=str(s.server.id))
        s.db.refresh(taken)
        s.db.refresh(waiting)
        # Not taken yet: it follows the print server. Taken: stays where it is (no second ticket).
        assert waiting.target_machine_id == s.six[1].id
        assert taken.target_machine_id == s.server.id
        assert send(s, kiosk, printer).target_machine_id == s.six[1].id
        assert {j["id"] for j in K.pending_jobs(s.db, s.six[1])} >= {str(waiting.id)}

    def test_the_failover_takes_the_relay_too(self, s):
        kiosk = make_remote_kiosk(s, s.six[4])
        printer = network_printer(s)
        waiting = send(s, kiosk, printer)
        failover(s, enabled=True, targetMachineId=s.six[2].id)
        heard(s.server, 3600)
        s.db.commit()
        assert LSF.run_shop(s.db, s.shop.id)["fired"] is True
        s.db.refresh(waiting)
        assert waiting.target_machine_id == s.six[2].id


class TestRemoteShopZParts:
    def test_remote_parts_reach_the_server_producing_the_local_shop_z(self, s, z_activity_unchecked):
        kiosk = make_remote_kiosk(s, s.six[4])
        assert LZ.local_mode_of_shop(s.db, s.shop) and producer_of(s) == str(s.server.id)
        out = LZ.request_remote_parts(s.db, s.server, "R1", [{"machineId": str(kiosk.id), "requestId": "q1"}])
        assert out["refused"] == [] and out["parts"][0]["state"] == "requested"
        assert LZ.take_pending_remote_part(s.db, kiosk)["requestId"] == "q1"
        shift = closed_shift(s, kiosk, 1, "12.00")
        LZ.report_remote_part(s.db, kiosk, {
            "requestId": "q1", "roundId": "R1", "outcome": "closed", "shiftId": str(shift.id),
            "section": {"shiftIds": [str(shift.id)]},
        })
        assert LZ.remote_parts(s.db, s.server, "R1")["parts"][0]["state"] == "reported"
        lan = {m.id: closed_shift(s, m, 1, "10.00") for m in s.six[:4]}
        tills = [(m, [lan[m.id]], None) for m in s.six[:4]] + [(kiosk, [shift], None)]
        code, body = upload(s, s.server, local_body(s, 1, tills))
        assert code == 201, body
        from app.models.shop_z_remote_part import ShopZRemotePart

        row = s.db.query(ShopZRemotePart).filter(ShopZRemotePart.request_id == "q1").one()
        assert row.state == "taken" and row.z_report_id is not None

    def test_the_z_role_given_to_a_till_moves_the_remote_close_with_it(self, s):
        kiosk = make_remote_kiosk(s, s.six[4])
        put_roles(s, tables=str(s.server.id), print=str(s.server.id), shopZ=str(s.six[0].id))
        with pytest.raises(LZ.RemotePartRefused) as e:
            LZ.request_remote_parts(s.db, s.server, "R2", [{"machineId": str(kiosk.id), "requestId": "q2"}])
        assert e.value.body["detail"] == "not_main_till"
        out = LZ.request_remote_parts(s.db, s.six[0], "R2", [{"machineId": str(kiosk.id), "requestId": "q3"}])
        assert out["parts"][0]["machineId"] == str(kiosk.id)
