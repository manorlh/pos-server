"""
Network printer discovery ("חיפוש מדפסות ברשת", app/services/printer_discovery.py).

What each class pins:

* **The report** — a till's scan is stored (deduplicated, by address), and every result is
  marked when the shop already has a printer there (host and port; by host for a printer
  found only over LPD / IPP), as the shop is when it is read.
* **The dashboard's request** — goes to the print server when it is online, else to the
  till seen last; 409 with no till online; never two at once; handed to the till by its
  print-jobs poll (pending → scanning) exactly once; answered by that till only;
  expired when not picked up / not answered in time; the till is woken.
* **Adding from the till** — a network printer of the shop with the shop's defaults, the
  dashboard's validation, never twice at one address; a manager's write; the tills told.
* **Scope** — only the shop's managers ask or read.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.main import app
from app.middleware.auth import CatalogActor, require_catalog_authority
from app.models.printers import KitchenPrinter, PrinterScan
from app.routers import printer_discovery as D
from app.routers import printers as R
from app.schemas.kitchen_printers import PrintHostIn, PrinterIn
from app.schemas.printer_discovery import (
    DiscoveredPrinterIn,
    PrinterScanReportIn,
    PrinterScanRequestIn,
    TillNetworkPrinterIn,
)
from app.services import ably_notify
from app.services import printer_discovery as PD
from app.services.permissions import Scope
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def d(w, monkeypatch):
    """The world with both tills of the shop online, and a print-job notify recorder."""
    w.woken = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant_id, machine_id, event, body: w.woken.append((machine_id, event)),
    )
    for i, till in enumerate(w.tills):
        till.last_heartbeat_at = _now() - timedelta(seconds=30 + 30 * i)
    w.other_till.last_heartbeat_at = _now()
    w.db.commit()
    return w


def add_printer(w, **over):
    base = {"name": "Kitchen", "connectionType": "network", "host": "192.168.1.50"}
    base.update(over)
    tasks = BackgroundTasks()
    out = R.create_printer(w.shop.id, PrinterIn.model_validate(base), tasks, **_ctx(w))
    return out


def found(host, port=9100, **over):
    base = {"host": host, "port": port, "kind": "escpos", "responseMs": 12}
    base.update(over)
    return base


def report(w, till, printers, request_id=None, **over):
    body = {"printers": printers, "subnet": "192.168.1.0/24", "lanAddress": "192.168.1.20", "durationMs": 9000}
    if request_id:
        body["requestId"] = str(request_id)
    body.update(over)
    return D.report_discovered_printers(str(till.id), PrinterScanReportIn.model_validate(body), machine=till, db=w.db)


def ask(w, user=None, machine_id=None):
    tasks = BackgroundTasks()
    body = PrinterScanRequestIn(machineId=machine_id) if machine_id else None
    out = D.request_printer_scan(w.shop.id, tasks, body, **_ctx(w, user))
    _run(tasks)
    return out


def state(w, user=None):
    return D.get_printer_scan(w.shop.id, **_ctx(w, user))


def poll(w, till):
    return R.get_pending_print_jobs(str(till.id), machine=till, db=w.db)


def till_add(w, till, **body):
    base = {"name": "Bar", "host": "192.168.1.60"}
    base.update(body)
    tasks = BackgroundTasks()
    out = D.add_network_printer_from_till(
        str(till.id), TillNetworkPrinterIn.model_validate(base), tasks,
        machine=till, actor=CatalogActor(pos_user_id=uuid.uuid4()), db=w.db,
    )
    _run(tasks)
    return out


# ── The report ────────────────────────────────────────────────────────────────


class TestReport:
    def test_a_till_scan_is_stored_by_address_once_each(self, d):
        out = report(d, d.tills[0], [
            found("192.168.1.100"), found("192.168.1.9", name="EPSON TM-T20III"),
            found("192.168.1.100", name="dup"), found("192.168.1.9", 9101, kind="unknown"),
        ])
        assert [(p["host"], p["port"]) for p in out["printers"]] == [
            ("192.168.1.9", 9100), ("192.168.1.9", 9101), ("192.168.1.100", 9100),
        ]
        assert out["status"] == "done"
        row = d.db.query(PrinterScan).one()
        assert (row.source, row.status, row.subnet, row.lan_address) == ("till", "done", "192.168.1.0/24", "192.168.1.20")
        assert row.results[2]["name"] is None  # the first report of an address is kept

    def test_results_are_marked_when_the_shop_has_the_printer(self, d):
        kitchen = add_printer(d, name="מטבח", host="192.168.1.9")
        add_printer(d, name="בר", host="192.168.1.10", port=9101)
        out = report(d, d.tills[0], [
            found("192.168.1.9"), found("192.168.1.10"), found("192.168.1.10", 9101), found("192.168.1.11"),
        ])
        marks = {(p["host"], p["port"]): p["configuredPrinterName"] for p in out["printers"]}
        assert marks == {
            ("192.168.1.9", 9100): "מטבח",
            ("192.168.1.10", 9100): None,  # another port of that host is another printer
            ("192.168.1.10", 9101): "בר",
            ("192.168.1.11", 9100): None,
        }
        assert out["printers"][0]["configuredPrinterId"] == kitchen["id"]

    def test_marked_as_the_shop_is_when_read(self, d):
        report(d, d.tills[0], [found("192.168.1.30")])
        assert state(d)["last"]["printers"][0]["configuredPrinterName"] is None
        add_printer(d, name="חדש", host="192.168.1.30")
        assert state(d)["last"]["printers"][0]["configuredPrinterName"] == "חדש"

    def test_a_cloud_printer_reached_by_network_counts_and_an_lpd_printer_matches_by_host(self, d):
        add_printer(
            d, name="גן", connectionType="cloud", hostMachineId=str(d.tills[1].id),
            hostConnection="network", host="192.168.1.40",
        )
        add_printer(d, name="משרד", host="192.168.1.41")
        out = report(d, d.tills[0], [found("192.168.1.40"), found("192.168.1.41", 631, kind="other")])
        assert [p["configuredPrinterName"] for p in out["printers"]] == ["גן", "משרד"]

    def test_the_report_is_validated(self):
        with pytest.raises(ValidationError):
            DiscoveredPrinterIn.model_validate(found("printer.local"))
        with pytest.raises(ValidationError):
            DiscoveredPrinterIn.model_validate(found("192.168.1.5", 70000))
        with pytest.raises(ValidationError):
            DiscoveredPrinterIn.model_validate(found("192.168.1.5", kind="laser"))
        p = DiscoveredPrinterIn.model_validate(
            found(" 192.168.1.5 ", name="  EPSON   TM ", otherPorts=[631, 515, 631, 0], services=["_ipp._tcp", " "])
        )
        assert (p.host, p.name, p.other_ports, p.services) == ("192.168.1.5", "EPSON TM", [515, 631], ["_ipp._tcp"])

    def test_only_the_last_scans_of_a_shop_are_kept(self, d):
        for i in range(PD.KEEP_PER_SHOP + 3):
            report(d, d.tills[0], [found(f"192.168.1.{i + 1}")])
        assert d.db.query(PrinterScan).count() == PD.KEEP_PER_SHOP


# ── The dashboard's request ───────────────────────────────────────────────────


class TestRequest:
    def test_it_goes_to_the_print_server_when_online(self, d):
        tasks = BackgroundTasks()
        R.put_print_host(d.shop.id, PrintHostIn(machineId=d.tills[1].id), tasks, **_ctx(d))
        out = ask(d)
        assert out["request"]["status"] == "pending"
        assert out["request"]["machineId"] == str(d.tills[1].id)
        assert out["scanner"]["isPrintHost"] is True
        assert d.woken == [(str(d.tills[1].id), "print-job")]

    def test_else_to_the_till_seen_last(self, d):
        assert ask(d)["request"]["machineId"] == str(d.tills[0].id)

    def test_an_offline_print_server_is_passed_over(self, d):
        tasks = BackgroundTasks()
        R.put_print_host(d.shop.id, PrintHostIn(machineId=d.tills[1].id), tasks, **_ctx(d))
        d.tills[1].last_heartbeat_at = _now() - timedelta(hours=2)
        d.db.commit()
        assert ask(d)["request"]["machineId"] == str(d.tills[0].id)

    def test_no_till_online_is_409(self, d):
        for till in d.tills:
            till.last_heartbeat_at = _now() - timedelta(hours=1)
        d.db.commit()
        assert refused(ask, d).detail == "no_till_online"
        assert state(d)["scanner"] is None

    def test_a_till_may_be_named_but_only_one_of_the_shop(self, d):
        assert ask(d, machine_id=d.tills[1].id)["request"]["machineId"] == str(d.tills[1].id)
        d.db.query(PrinterScan).delete()
        d.db.commit()
        assert refused(ask, d, machine_id=d.other_till.id).detail == "machine_not_in_shop"

    def test_never_two_at_once(self, d):
        first = ask(d)["request"]["id"]
        assert ask(d)["request"]["id"] == first
        assert d.db.query(PrinterScan).count() == 1
        assert len(d.woken) == 1

    def test_the_poll_hands_it_out_once_and_the_answer_ends_it(self, d):
        rid = ask(d)["request"]["id"]
        till = d.tills[0]
        assert poll(d, d.tills[1])["scan"] is None
        handed = poll(d, till)
        assert handed["jobs"] == [] and handed["scan"]["id"] == rid
        assert poll(d, till)["scan"] is None
        assert state(d)["request"]["status"] == "scanning"

        add_printer(d, name="מטבח", host="192.168.1.9")
        report(d, till, [found("192.168.1.9"), found("192.168.1.77", paper="near_end")], request_id=rid)
        s = state(d)
        assert s["request"]["id"] == rid and s["request"]["status"] == "done"
        assert s["last"]["id"] == rid
        assert [(p["host"], p["configuredPrinterName"], p["paper"]) for p in s["last"]["printers"]] == [
            ("192.168.1.9", "מטבח", None), ("192.168.1.77", None, "near_end"),
        ]
        assert s["last"]["machineName"] == "1 · Till 1"
        # Done: the next ask is a new scan.
        assert ask(d)["request"]["id"] != rid

    def test_only_the_till_it_went_to_answers(self, d):
        rid = ask(d)["request"]["id"]
        e = refused(report, d, d.tills[1], [found("192.168.1.9")], request_id=rid)
        assert (e.status_code, e.detail) == (404, "scan_not_found")
        e = refused(report, d, d.tills[0], [], request_id=uuid.uuid4())
        assert e.status_code == 404

    def test_a_failed_scan_keeps_the_last_results(self, d):
        report(d, d.tills[0], [found("192.168.1.9")])
        rid = ask(d)["request"]["id"]
        poll(d, d.tills[0])
        report(d, d.tills[0], [], request_id=rid, status="failed", error="not_on_lan")
        s = state(d)
        assert (s["request"]["status"], s["request"]["error"]) == ("failed", "not_on_lan")
        assert s["last"]["printers"][0]["host"] == "192.168.1.9"

    def test_not_picked_up_or_not_answered_in_time_expires(self, d):
        now = _now()
        scan, _ = PD.request_scan(d.db, d.admin, d.shop, now=now)
        PD.expire_scans([scan], now + PD.PICKUP_TTL + timedelta(seconds=1))
        assert (scan.status, scan.error) == ("expired", "not_picked_up")

        scan2, created = PD.request_scan(d.db, d.admin, d.shop, now=now + PD.PICKUP_TTL + timedelta(seconds=2))
        assert created
        handed = PD.take_scan_request(d.db, d.tills[0], now=now + PD.PICKUP_TTL + timedelta(seconds=3))
        assert handed["id"] == str(scan2.id)
        PD.expire_scans([scan2], now + PD.PICKUP_TTL + PD.RUN_TTL + timedelta(seconds=4))
        assert (scan2.status, scan2.error) == ("expired", "no_report")
        # A late answer still counts.
        d.db.commit()
        report(d, d.tills[0], [found("192.168.1.9")], request_id=scan2.id)
        assert state(d)["request"]["status"] == "done"

    def test_an_expired_request_does_not_block_a_new_one(self, d):
        old = PrinterScan(
            id=uuid.uuid4(), tenant_id=d.tenant.id, shop_id=d.shop.id, machine_id=d.tills[0].id,
            status="pending", source="dashboard", created_at=_now() - timedelta(minutes=10),
            expires_at=_now() - timedelta(minutes=7),
        )
        d.db.add(old)
        d.db.commit()
        out = ask(d)
        assert out["request"]["id"] != str(old.id)
        assert d.db.get(PrinterScan, old.id).status == "expired"
        # An expired request is never handed out.
        assert poll(d, d.tills[0])["scan"]["id"] == out["request"]["id"]


# ── Adding from the till ──────────────────────────────────────────────────────


class TestTillAdd:
    def test_a_network_printer_for_the_whole_shop(self, d):
        out = till_add(d, d.tills[0], name="  בר  גן ", host="192.168.1.60")
        assert (out["name"], out["connectionType"], out["host"], out["port"], out["purpose"]) == (
            "בר גן", "network", "192.168.1.60", 9100, "kitchen",
        )
        assert (out["areaId"], out["machineId"], out["paperWidth"], out["copies"], out["cutPaper"]) == (
            None, None, 80, 1, True,
        )
        # Every till of the shop is told.
        assert {m for m, reason in d.notified if reason == "printers_updated"} == {str(t.id) for t in d.tills}
        # And it reaches the till's pull.
        pulled = R.get_own_printers(str(d.tills[1].id), etag=None, machine=d.tills[1], db=d.db)
        assert [p["host"] for p in pulled["printers"]] == ["192.168.1.60"]

    def test_with_the_shops_defaults_for_its_purpose(self, d):
        add_printer(d, name="מטבח", paperWidth=58, copies=2, beep=True, cutPaper=False, sortOrder=4)
        add_printer(d, name="קופה", purpose="receipt", host="192.168.1.51", cashDrawer=False)
        kitchen = till_add(d, d.tills[0], host="192.168.1.61")
        assert (kitchen["paperWidth"], kitchen["copies"], kitchen["beep"], kitchen["cutPaper"]) == (58, 2, True, False)
        assert kitchen["sortOrder"] == 5
        receipt = till_add(d, d.tills[0], name="חשבוניות", host="192.168.1.62", purpose="receipt")
        assert (receipt["purpose"], receipt["cashDrawer"], receipt["paperWidth"]) == ("receipt", False, 80)

    def test_a_first_receipt_printer_takes_the_drawer_like_the_dashboard(self, d):
        out = till_add(d, d.tills[0], name="חשבוניות", purpose="receipt", port=9101)
        assert (out["cashDrawer"], out["port"]) == (True, 9101)

    def test_never_twice_at_one_address(self, d):
        till_add(d, d.tills[0])
        e = refused(till_add, d, d.tills[1], name="again")
        assert (e.status_code, e.detail) == (409, "printer_already_configured")
        till_add(d, d.tills[0], port=9101)  # another port: another printer
        assert d.db.query(KitchenPrinter).count() == 2

    def test_validated_like_the_dashboard(self):
        with pytest.raises(ValidationError):
            TillNetworkPrinterIn.model_validate({"name": " ", "host": "192.168.1.5"})
        with pytest.raises(ValidationError):
            TillNetworkPrinterIn.model_validate({"name": "x", "host": "evil.example.com"})
        with pytest.raises(ValidationError):
            TillNetworkPrinterIn.model_validate({"name": "x" * 101, "host": "192.168.1.5"})
        with pytest.raises(ValidationError):
            TillNetworkPrinterIn.model_validate({"name": "x", "host": "192.168.1.5", "purpose": "label"})

    def test_a_managers_write(self, d):
        dependency = require_catalog_authority(Scope.CATALOG_WRITE)
        with pytest.raises(HTTPException) as e:
            dependency(machine=d.tills[0], elevation_token=None, operator_id=None, db=d.db)
        assert e.value.status_code == 401
        route = next(
            r for r in app.routes
            if getattr(r, "path", "") == "/api/v1/sync/{machine_id}/printers" and "POST" in getattr(r, "methods", ())
        )
        names = {dep.call.__qualname__ for dep in route.dependant.dependencies}
        assert any("require_catalog_authority" in n for n in names), names


# ── Scope ─────────────────────────────────────────────────────────────────────


class TestScope:
    def test_only_the_shops_managers_ask_or_read(self, d):
        assert refused(ask, d, d.cashier).status_code == 403
        assert refused(state, d, d.cashier).status_code == 403
        assert refused(ask, d, d.north_manager).status_code == 403
        assert ask(d, d.manager)["request"]["status"] == "pending"
        assert state(d, d.company_manager)["request"]["status"] == "pending"

    def test_a_shop_of_another_tenant_is_not_found(self, d):
        e = refused(D.get_printer_scan, d.foreign_shop.id, **_ctx(d))
        assert e.status_code in (403, 404)

    def test_the_state_lists_the_tills(self, d):
        s = state(d)
        assert [t["machineId"] for t in s["tills"]] == [str(t.id) for t in d.tills]
        assert all(t["online"] for t in s["tills"])
        assert s["request"] is None and s["last"] is None
