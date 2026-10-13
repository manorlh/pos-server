"""
A kiosk in another place, still in the shop Z — the owner's case: "קיוסק בזד סניפי" set "מרוחק
(דרך הענן)" (`work_config.KIOSK_SHOP_Z` with its link, `local_shop_z.remote_till_ids`; docs/
SPEC_INDEPENDENT_TILL.md §8.14–8.15). No path of it may have a gap:

* **its bon** reaches the shop's print server through the cloud relay and prints there once —
  never the print server over the LAN, never a shop printer's address where it stands; a job the
  host is off for is handed out again after its lease, or expires for the kiosk to send anew;
* **its shifts and its Z part** are in the shop Z — the cloud's run, and the main till's local Z,
  which closes it through the cloud (never asked to close "with the shop Z" on top);
* **its alerts** reach the shop's tills through the cloud;
* **the reports** name it a kiosk and count its money once.

(Its KDS release and "תשלום בקופה" are in tests/test_kds_kiosk_release.py and
tests/test_kiosk_open_orders.py, each in its own world.)

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.printers import KitchenPrintHost, KitchenPrintJob
from app.models.z_report import ZReport
from app.routers import printers as PR
from app.services import kiosk_ops as OPS
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import printers as K
from app.services import z_runs as ZR
from test_independent_till import closed_shift
from test_kiosk_ops import (  # noqa: F401 - `w` is the fixture
    PAPER, T0, _ack, _bon, _host_side, _kiosk_view, _kitchen_printer, kiosk_sync, put, set_param, till_alerts, w,
)


def remote(w):
    """The kiosk in another place: in the shop Z, "מרוחק (דרך הענן)"; till "main" the shop's main till."""
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    LZ.set_remote_till_ids(w.shop, [w.kiosk.id])
    w.db.commit()
    assert LZ.is_remote_participant(w.kiosk) and w.kiosk.is_kiosk
    assert not LZ.is_remote_participant(w.main)
    return w.kiosk


def _pulled(w, machine):
    return PR.get_own_printers(str(machine.id), etag=None, machine=machine, db=w.db)


# ── Its bon: through the cloud relay, printed once at the shop ─────────────────


class TestItsBon:
    def test_it_is_told_the_print_server_is_away_and_never_its_address(self, w):
        remote(w)
        w.db.add(KitchenPrintHost(machine_id=w.main.id, shop_id=w.shop.id, lan_address="192.168.0.10", port=8399))
        w.db.commit()
        _kitchen_printer(w)
        pulled = _pulled(w, w.kiosk)
        host = pulled["printHost"]
        assert host == {
            "machineId": str(w.main.id), "name": host["name"], "isSelf": False, "lanAddress": None, "port": 8399,
            "offLan": True,
        }
        assert not pulled.get("hostsLan")
        # A till on the LAN still gets the address.
        assert _pulled(w, w.third)["printHost"]["lanAddress"] == "192.168.0.10"

    def test_its_bon_prints_at_the_shop_once(self, w):
        remote(w)
        printer = _kitchen_printer(w)
        jid = str(uuid.uuid4())
        job = _bon(w, printer, jid)
        assert job["targetMachineId"] == str(w.main.id)
        _bon(w, printer, jid)  # sent again after a lost answer: the same job
        assert w.db.query(KitchenPrintJob).count() == 1
        assert _kiosk_view(w, jid)[jid]["status"] in ("pending", "leased")
        assert [j["id"] for j in _host_side(w, w.main)] == [jid]
        assert _host_side(w, w.third) == []  # only the print server
        _ack(w, w.main, jid, "done")
        w.db.commit()
        assert _kiosk_view(w, jid)[jid]["status"] == "done"
        # Printed: never handed out again; a contrary late answer keeps the first.
        assert _host_side(w, w.main) == []
        assert _ack(w, w.main, jid, "failed", "late")["status"] == "done"

    def test_the_host_off_its_lease_and_the_jobs_expiry(self, w):
        remote(w)
        printer = _kitchen_printer(w)
        taken = _bon(w, printer)["id"]
        # Taken, never answered (the host went off): handed out again after the lease — the host
        # knows it by id and prints it once.
        assert [j["id"] for j in _host_side(w, w.main)] == [taken]
        assert _host_side(w, w.main) == []
        row = w.db.get(KitchenPrintJob, uuid.UUID(taken))
        row.delivered_at = datetime.now(timezone.utc) - K.JOB_LEASE - timedelta(seconds=1)
        w.db.commit()
        assert [j["id"] for j in _host_side(w, w.main)] == [taken]
        assert w.db.get(KitchenPrintJob, uuid.UUID(taken)).deliveries == 2
        # Never taken (the host off from the start): it expires — the kiosk reads it so ("בון לא
        # הודפס"), takes it back and sends a new one; the new one prints, the old never does.
        lost = _bon(w, printer)["id"]
        row = w.db.get(KitchenPrintJob, uuid.UUID(lost))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        w.db.commit()
        assert _kiosk_view(w, lost)[lost]["status"] == "expired"
        assert PR.cancel_print_job(str(w.kiosk.id), lost, machine=w.kiosk, db=w.db)["cancelled"] is True
        again = _bon(w, printer)["id"]
        assert [j["id"] for j in _host_side(w, w.main) if j["id"] != taken] == [again]
        _ack(w, w.main, again, "done")
        w.db.commit()
        assert _kiosk_view(w, again)[again]["status"] == "done"

    def test_a_cloud_printer_a_till_hosts_is_named_never_addressed_across_networks(self, w):
        remote(w)
        w.db.add(KitchenPrintHost(machine_id=w.third.id, shop_id=w.shop.id, lan_address="192.168.0.30", port=8399))
        w.db.add(KitchenPrintHost(machine_id=w.kiosk.id, shop_id=w.shop.id, lan_address="10.1.1.5", port=8399))
        w.db.commit()
        bar = _kitchen_printer(w, name="Bar", connection_type="cloud", host=None, host_machine_id=w.third.id,
                               host_connection="network")
        # The kiosk, off the shop's LAN: the host's name only — its jobs go through the cloud.
        assert K.hosted_by_tills(w.db, w.kiosk, [bar])[str(w.third.id)]["lanAddress"] is None
        jid = _bon(w, bar)["id"]
        assert [j["id"] for j in _host_side(w, w.third)] == [jid]
        # A printer the remote kiosk hosts: its own network's address is never handed to the shop's tills.
        own = _kitchen_printer(w, name="Kiosk printer", connection_type="cloud", host=None,
                               host_machine_id=w.kiosk.id, host_connection="usb")
        assert K.hosted_by_tills(w.db, w.third, [own])[str(w.kiosk.id)]["lanAddress"] is None


# ── Its shifts and its Z part: in the shop Z ─────────────────────────────────


class TestInTheShopZ:
    def test_the_clouds_run_takes_its_shifts(self, w, z_activity_unchecked):
        remote(w)
        kiosk_shift = closed_shift(w, w.kiosk, 1, "30.00")
        main_shift = closed_shift(w, w.main, 1, "10.00")
        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop,
                              [ZR.MachineSelection(machine_id=m.id) for m in (w.kiosk, w.main)])
        z = w.db.get(ZReport, run.z_report_id)
        assert {s["machineId"] for s in z.per_machine} == {str(w.kiosk.id), str(w.main.id)}
        assert str(z.total_sales) in ("40.00", "40")
        assert kiosk_shift.z_report_id == z.id and main_shift.z_report_id == z.id

    def test_the_main_tills_local_z_closes_it_through_the_cloud_and_waits(self, w):
        from app.routers import machines as machines_router

        remote(w)
        w.shop.local_network = True
        w.db.commit()
        main = w.main
        assert LZ.local_mode_of_shop(w.db, w.shop)
        hist = LZ.history(w.db, main)
        mine = next(p for p in hist["participants"] if p["machineId"] == str(w.kiosk.id))
        assert mine["remote"] is True and mine["kiosk"] is True
        out = LZ.request_remote_parts(w.db, main, "r1", [{"machineId": str(w.kiosk.id), "requestId": "q1"}])
        assert out["refused"] == []
        beat = machines_router.post_my_heartbeat(None, machine=w.kiosk, db=w.db)
        assert beat["pendingShopZPart"]["requestId"] == "q1"
        # Not answered: the main till has nothing to take — it waits.
        assert [p["state"] for p in LZ.remote_parts(w.db, main, "r1")["parts"]] == ["delivered"]

    def test_never_asked_to_close_with_the_shop_z_on_top_of_it(self, w):
        remote(w)
        put(w, {"operations": {"closeWithShopZ": True}})
        w.shop.local_network = True
        w.db.commit()
        # The local Z closes it itself (its part, through the cloud): no second close request.
        assert OPS.on_local_shop_z(w.db, w.shop.id, None, now=T0) == []


# ── Its alerts reach the shop's tills through the cloud ───────────────────────


class TestItsAlerts:
    def test_an_alert_of_the_remote_kiosk_reaches_the_main_till(self, w):
        remote(w)
        kiosk_sync(w, {"flowState": "attract", "alerts": [PAPER]})
        alerts = till_alerts(w, w.main)
        assert [a["kind"] for a in alerts] == ["printer"]


# ── The reports name it a kiosk, its money once ──────────────────────────────


class TestReports:
    def test_by_till_and_the_z_table(self, w, z_activity_unchecked):
        from app.services import all_in_one as AIO
        from app.services import z_table as ZT
        from app.services.reports import resolve_report_window
        from shift_world import TODAY

        remote(w)
        closed_shift(w, w.kiosk, 1, "30.00")
        closed_shift(w, w.main, 1, "10.00")
        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop,
                              [ZR.MachineSelection(machine_id=m.id) for m in (w.kiosk, w.main)])
        z = w.db.get(ZReport, run.z_report_id)
        w.db.commit()
        window = resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz="Asia/Jerusalem")
        out = AIO.build_all_in_one(w.db, w.admin, w.tenant.id, window, shop_ids=[w.shop.id])
        rows = {r["machineId"]: r for r in out["byTill"]}
        assert rows[str(w.kiosk.id)]["kiosk"] is True and rows[str(w.kiosk.id)]["net"] == 30.0
        assert rows[str(w.main.id)]["kiosk"] is False and rows[str(w.main.id)]["net"] == 10.0
        assert out["summary"]["net"] == 40.0
        table = ZT.build_z_table(w.db, [z], timezone.utc)
        assert sorted((r["machineId"], r["zType"]) for r in table["tills"]) == sorted(
            [(str(w.kiosk.id), "shop"), (str(w.main.id), "shop")],
        )

    def test_the_z_type_filter_agrees_with_the_rule_for_a_till_in_kiosk_mode(self, w):
        """A till in kiosk mode for a while (`home_role` set) is a till: its Z is a till's."""
        from app.models.kiosk import KioskDevice
        from app.services import z_table as ZT

        device = w.db.query(KioskDevice).filter(KioskDevice.machine_id == w.kiosk.id).one()
        device.home_role = "till"
        w.kiosk.z_mode = "till"
        w.db.commit()
        z = ZReport(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.kiosk.id, origin="till",
            business_date=T0.date(), closed_at=T0, per_machine=[{"machineId": str(w.kiosk.id)}],
            machine_sequence_number=1,
        )
        w.db.add(z)
        w.db.commit()
        kiosks = ZT.kiosk_machine_ids(w.db)
        assert ZT.z_type_of(z, kiosks) == "till"
        for t in ("till", "kiosk"):
            got = ZT.filter_z_types(w.db.query(ZReport), [t]).all()
            assert (z in got) is (t == "till"), t


class TestItsPartIsNamedAKiosk:
    def test_on_the_clouds_z_and_its_print(self, w, z_activity_unchecked):
        import json

        from app.services import z_print as ZPR

        remote(w)
        closed_shift(w, w.kiosk, 1, "30.00")
        closed_shift(w, w.main, 1, "10.00")
        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop,
                              [ZR.MachineSelection(machine_id=m.id) for m in (w.kiosk, w.main)])
        z = w.db.get(ZReport, run.z_report_id)
        sections = {s["machineId"]: s for s in z.per_machine}
        assert sections[str(w.kiosk.id)].get("kiosk") is True
        assert "kiosk" not in sections[str(w.main.id)]
        text = json.dumps(ZPR.build_print_document(z, timezone.utc), ensure_ascii=False)
        assert f"קיוסק {w.kiosk.name}" in text and f"קופה {w.main.pos_number}" in text

    def test_on_the_main_tills_local_z_as_printed(self, w):
        from test_independent_till import _manifest_body, _part

        remote(w)
        w.shop.local_network = True
        w.db.commit()
        kiosk_shift = closed_shift(w, w.kiosk, 1, "30.00")
        main_shift = closed_shift(w, w.main, 1, "10.00")
        w.db.commit()
        parts = [_part(w, w.main, [main_shift]), _part(w, w.kiosk, [kiosk_shift])]
        z, outcome = LZ.upload(w.db, w.main, _manifest_body(w, 1, parts))
        assert outcome == "created"
        sections = {s["machineId"]: s for s in z.per_machine}
        assert sections[str(w.kiosk.id)].get("kiosk") is True and "kiosk" not in sections[str(w.main.id)]
