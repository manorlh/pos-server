"""
"איך המסך מדפיס" (app/services/kds_print.py): a kitchen screen in a browser prints through a till of the
shop — the cloud relay (`kitchen_print_jobs`), nothing installed.

* **The path** — `kdsPrintPath` (device / none / relay / bridge / app): a browser's `device` is the bridge,
  an app's its own printer; set for one screen from the dashboard's card.
* **Where** — automatic: a till of the screen's point of sale first, the shop's otherwise; a till chosen by
  itself (its own printer), or a kitchen printer; `remotePrintHosts` / `remotePrintEnabled` of the screen;
  a printer of another point of sale is never the screen's.
* **The job** — an ordinary relayed ticket the host prints as it prints any (`origin: "kds"`, the cloud's
  `_kds` never handed out); idempotent; expires after `remotePrintTimeoutSec` untaken; "בון לא הודפס" when
  it failed or expired, over when it printed after all; a test from the dashboard.
* **The hosts' contract** — the pending job a host gets for a screen's bon is the shared fixture
  `kds_relay_pending_ticket.json` (kiosk-desktop test/fixtures has the same bytes; the Windows
  host prints it in test/kdsRelayHost.test.ts).

Runs on the world of tests/test_kitchen_printers.py (SQLite).
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.kds import KdsDevice
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.printers import KitchenPrinter, KitchenPrintJob
from app.models.shop_area import ShopArea
from app.routers import kds_print as R
from app.services import bon_alerts as BA
from app.services import kds_print as KP
from app.services import printers as K
from app.services import remote_print as RP
from app.services import till_parameters as TP
from app.services.exception_alerts import log as L
from test_bill_print_other_till import set_value
from test_kitchen_printers import _run, ack, create, k, pending  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401

FIXTURE = Path(__file__).parent / "fixtures" / "kds_relay_pending_ticket.json"


def screen(k, *, os_name="iPadOS", platform="web", area=None, role="expo", name="מסך מטבח"):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, distributor_id=k.admin.id, name=name,
        machine_code=f"S-{uuid.uuid4().hex[:6]}", pos_number=None, is_active=True, is_fiscal=False,
        pairing_status=PairingStatus.ASSIGNED, platform=platform,
        device_info={"platform": platform, "os": os_name}, area_id=area.id if area is not None else None,
        last_heartbeat_at=k.tills[0].last_heartbeat_at,
    )
    k.db.add(m)
    k.db.flush()
    k.db.add(KdsDevice(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, machine_id=m.id, name=name,
                       role=role, station_ids=[], is_active=True))
    k.db.commit()
    return m


def area(k, name):
    a = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name=name)
    k.db.add(a)
    k.db.commit()
    return a


def put(k, scr, path="relay", host=None, printer=None):
    from app.routers.kds_print import KdsPrintSettingsIn

    body = KdsPrintSettingsIn.model_validate({"path": path, "hostMachineId": host, "printerId": printer})
    tasks = BackgroundTasks()
    out = R.put_screen_print(k.shop.id, scr.id, body, tasks, **_ctx(k))
    _run(tasks)
    return out


def card(k, scr):
    return R.get_screen_print_card(k.shop.id, scr.id, **_ctx(k))


def status_of(k, scr):
    return R.get_screen_print(str(scr.id), machine=scr, db=k.db)


def bon(**over):
    base = {
        "source": "table", "tableName": "12", "zoneName": "בר", "guests": 2, "waiterName": "דנה",
        "createdAt": "2026-10-17T10:00:00Z", "orderRef": "T-12", "notice": "גריל",
        "lines": [{"name": "המבורגר", "quantity": 2, "mods": ["צ'דר"], "removals": ["בלי בצל"],
                   "notes": "מידיום", "allergies": ["גלוטן"], "important": True}],
    }
    base.update(over)
    return base


def send(k, scr, job_id=None, ticket=None, test=False):
    body = R.KdsPrintJobIn.model_validate({"id": str(job_id or uuid.uuid4()), "ticket": ticket or (None if test else bon()),
                                          "test": test})
    tasks = BackgroundTasks()
    out = R.post_screen_print_job(str(scr.id), body, tasks, machine=scr, db=k.db)
    _run(tasks)
    return out


def job_statuses(k, scr, *ids):
    return {j["id"]: j for j in R.get_screen_print_jobs(str(scr.id), ids=",".join(ids), machine=scr, db=k.db)["jobs"]}


def code(e: HTTPException):
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


# ── The path ─────────────────────────────────────────────────────────────────


class TestThePath:
    def test_by_the_device_until_set_a_browser_the_bridge_an_app_its_own_printer(self, k):
        ipad = screen(k)
        s = status_of(k, ipad)
        assert (s["path"], s["effectivePath"], s["deviceKind"], s["relay"]) == ("device", "bridge", "ipad", None)
        tablet = screen(k, platform="android", os_name="Android", name="KDS אנדרואיד")
        assert status_of(k, tablet)["effectivePath"] == "app"
        assert status_of(k, tablet)["deviceKind"] == "android_app"
        assert status_of(k, screen(k, os_name="Android", name="טאבלט"))["deviceKind"] == "android_browser"
        assert status_of(k, screen(k, os_name="Windows", name="מחשב"))["deviceKind"] == "windows_browser"

    def test_set_for_one_screen_from_the_dashboard(self, k):
        scr = screen(k)
        out = put(k, scr)
        assert out["own"] == {"path": "relay", "hostMachineId": None, "printerId": None}
        assert out["status"]["effectivePath"] == "relay"
        assert out["status"]["relay"]["ready"] is True and out["status"]["relay"]["automatic"] is True
        # Null again: as the shop says (the default).
        assert put(k, scr, path=None)["own"]["path"] is None
        assert status_of(k, scr)["effectivePath"] == "bridge"

    def test_a_host_or_printer_of_another_shop_is_refused(self, k):
        scr = screen(k)
        assert refused(put, k, scr, host=str(k.other_till.id)).detail == "host_not_in_shop"
        assert refused(put, k, scr, host=str(scr.id)).detail == "host_not_in_shop"
        assert refused(put, k, scr, printer=str(uuid.uuid4())).detail == "printer_not_in_shop"

    def test_the_parameters_are_built_in_and_their_ids_checked(self, k):
        TP.ensure_builtin_parameters(k.db)
        keys = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        assert keys[KP.PATH_KEY].enum_options == KP.PATH_OPTIONS and keys[KP.PATH_KEY].default_value == "device"
        assert TP.enum_labels(KP.PATH_KEY)["relay"] == "דרך קופה בסניף (ללא התקנה)"
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value(KP.HOST_KEY, "קופה 1")
        some = uuid.uuid4()
        assert TP.validate_keyed_value(KP.PRINTER_KEY, str(some).upper()) == str(some)
        assert TP.validate_keyed_value(KP.HOST_KEY, "  ") == ""

    def test_only_a_screen(self, k):
        till = k.tills[0]
        e = refused(R.post_screen_print_job, str(till.id), R.KdsPrintJobIn.model_validate({"id": str(uuid.uuid4()), "ticket": bon()}),
                    BackgroundTasks(), machine=till, db=k.db)
        assert code(e) == "not_a_screen"
        assert refused(card, k, till).detail == "not_a_screen"

    def test_another_path_sends_nothing(self, k):
        scr = screen(k)
        e = refused(send, k, scr)
        assert (e.status_code, code(e), e.detail["path"]) == (409, "kds_print_not_relay", "bridge")
        put(k, scr, path="none")
        assert refused(send, k, scr).detail["path"] == "none"
        assert k.db.query(KitchenPrintJob).count() == 0


# ── Where ────────────────────────────────────────────────────────────────────


class TestWhere:
    def test_automatic_a_till_of_the_screens_point_of_sale_first(self, k):
        t1, t2 = k.tills
        bar = area(k, "בר")
        t2.area_id = bar.id
        k.db.commit()
        scr = screen(k, area=bar)
        put(k, scr)
        assert status_of(k, scr)["relay"]["hostMachineId"] == str(t2.id)
        # A screen with no point of sale: the shop's — the lowest number.
        other = screen(k, name="מסך 2")
        put(k, other)
        assert status_of(k, other)["relay"]["hostMachineId"] == str(t1.id)

    def test_the_shops_print_server_first(self, k, monkeypatch):
        t1, t2 = k.tills
        monkeypatch.setattr(K, "print_host_of_shop", lambda db, shop_id: t2)
        scr = screen(k)
        put(k, scr)
        assert status_of(k, scr)["relay"]["hostMachineId"] == str(t2.id)

    def test_a_browser_is_never_a_host(self, k):
        scr = screen(k)
        screen(k, name="לוח", role="pickup")
        hosts = {t["hostMachineId"] for t in card(k, scr)["targets"]}
        assert hosts == {str(t.id) for t in k.tills}

    def test_a_till_chosen_by_itself_prints_on_its_own_printer(self, k):
        t1, t2 = k.tills
        scr = screen(k)
        put(k, scr, host=str(t2.id))
        s = status_of(k, scr)["relay"]
        assert (s["hostMachineId"], s["automatic"], s["connection"], s["printerId"]) == (str(t2.id), False, "till", None)
        out = send(k, scr)
        assert out["targetMachineId"] == str(t2.id) and out["targetMachineName"] == K.machine_label(t2)
        made = k.db.get(KitchenPrinter, uuid.UUID(out["printerId"]))
        assert (made.connection_type, made.host_connection, str(made.host_machine_id), str(made.machine_id)) == (
            "cloud", "till", str(t2.id), str(t2.id),
        )
        # The tills pulled their printers again (t2 now hosts it) and t2 was woken for the job.
        assert (str(t2.id), "print-job") in k.jobs_notified
        # The next one reuses the entry.
        assert send(k, scr)["printerId"] == out["printerId"]
        assert k.db.query(KitchenPrinter).filter(KitchenPrinter.host_machine_id == t2.id).count() == 1

    def test_a_kitchen_printer_chosen(self, k):
        t1, t2 = k.tills
        grill = create(k, name="גריל", connectionType="cloud", host="10.0.0.9", hostMachineId=str(t1.id),
                       hostConnection="network")
        scr = screen(k)
        put(k, scr, printer=grill["id"])
        out = send(k, scr)
        assert (out["printerId"], out["targetMachineId"], out["printerName"]) == (grill["id"], str(t1.id), "גריל")

    def test_a_printer_of_another_point_of_sale_is_not_the_screens(self, k):
        t1, _ = k.tills
        bar, terrace = area(k, "בר"), area(k, "מרפסת")
        p = create(k, name="מרפסת", connectionType="cloud", host="10.0.0.9", hostMachineId=str(t1.id),
                   hostConnection="network", areaId=str(terrace.id))
        scr = screen(k, area=bar)
        assert p["id"] not in {t["printerId"] for t in card(k, scr)["targets"]}
        put(k, scr, printer=p["id"])
        assert status_of(k, scr)["relay"]["why"] == "printer_out_of_scope"
        assert code(refused(send, k, scr)) == "printer_out_of_scope"
        # The terrace's own screen may.
        mine = screen(k, area=terrace, name="מסך מרפסת")
        put(k, mine, printer=p["id"])
        assert send(k, mine)["printerId"] == p["id"]

    def test_the_screens_remote_print_rules(self, k):
        t1, t2 = k.tills
        scr = screen(k)
        put(k, scr)
        set_value(k, RP.HOSTS_KEY, "machine", scr.id, str(t2.id))
        assert status_of(k, scr)["relay"]["hostMachineId"] == str(t2.id)
        put(k, scr, host=str(t1.id))
        e = refused(send, k, scr)
        assert (code(e), e.detail["host"]) == ("host_not_allowed", K.machine_label(t1))
        set_value(k, RP.ENABLED_KEY, "machine", scr.id, False)
        assert status_of(k, scr)["relay"]["why"] == "remote_print_off"
        assert code(refused(send, k, scr)) == "remote_print_off"

    def test_no_till_in_the_shop(self, k):
        for t in k.tills:
            t.is_active = False
        k.db.commit()
        scr = screen(k)
        put(k, scr)
        assert status_of(k, scr)["relay"] == {
            "ready": False, "why": "no_host", "automatic": True, "hostMachineId": None, "hostName": None,
            "hostOnline": None, "printerId": None, "printerName": None, "connection": None,
        }
        assert code(refused(send, k, scr)) == "no_host"


# ── The job ──────────────────────────────────────────────────────────────────


class TestTheJob:
    def test_the_host_gets_an_ordinary_ticket_and_the_screen_hears_done(self, k):
        t1, _ = k.tills
        scr = screen(k)
        put(k, scr, host=str(t1.id))
        jid = uuid.uuid4()
        out = send(k, scr, jid)
        assert (out["status"], out["kind"], out["test"]) == ("pending", "ticket", False)
        # Sent again (the answer lost): the same job.
        assert send(k, scr, jid)["id"] == str(jid)
        assert k.db.query(KitchenPrintJob).count() == 1
        jobs = pending(k, t1)
        assert len(jobs) == 1
        job = jobs[0]
        assert job["origin"] == "kds" and job["kind"] == "ticket"
        assert KP.META_KEY not in job["ticket"]
        assert job["ticket"]["sourceName"] == K.machine_label(scr)
        assert job["ticket"]["lines"][0]["mods"] == ["צ'דר"]
        assert job["printer"]["connection"] == "till"
        assert job_statuses(k, scr, str(jid))[str(jid)]["status"] == "printing"
        ack(k, t1, str(jid))
        done = job_statuses(k, scr, str(jid), "not-an-id")[str(jid)]
        assert (done["status"], done["targetMachineName"]) == ("done", K.machine_label(t1))

    def test_another_screens_id_is_not_its(self, k):
        a, b = screen(k), screen(k, name="ב")
        put(k, a)
        put(k, b)
        jid = uuid.uuid4()
        send(k, a, jid)
        assert refused(send, k, b, jid).detail == "print_job_id_taken"
        assert job_statuses(k, b, str(jid)) == {}

    def test_untaken_it_expires_after_the_screens_wait_and_says_so_on_problems(self, k):
        scr = screen(k)
        put(k, scr)
        set_value(k, RP.TIMEOUT_KEY, "machine", scr.id, 30)
        jid = send(k, scr)["id"]
        row = k.db.get(KitchenPrintJob, uuid.UUID(jid))
        assert round((row.expires_at - row.created_at).total_seconds()) == 30
        row.expires_at = row.created_at - timedelta(seconds=1)
        k.db.commit()
        assert job_statuses(k, scr, jid)[jid]["status"] == "expired"
        k.db.commit()
        entry = L.find(k.db, BA.kds_alert_key(jid))
        assert entry is not None and entry.kind == "bon_unprinted" and entry.acknowledged_at is None
        assert str(entry.machine_id) == str(scr.id)
        assert "בון לא הודפס" in entry.summary and "אף קופה לא לקחה את הבון" in entry.summary
        assert "נשלח ממסך" in entry.summary
        # Printed after all (the till was back): over by itself.
        host = k.db.get(POSMachine, row.target_machine_id)
        ack(k, host, jid)
        k.db.commit()
        assert L.find(k.db, BA.kds_alert_key(jid)).acknowledged_at is not None

    def test_failed_at_the_host(self, k):
        t1, _ = k.tills
        scr = screen(k)
        put(k, scr, host=str(t1.id))
        jid = send(k, scr)["id"]
        pending(k, t1)
        ack(k, t1, jid, status="failed", error="אין נייר")
        k.db.commit()
        assert job_statuses(k, scr, jid)[jid]["error"] == "אין נייר"
        assert "תקלה" in L.find(k.db, BA.kds_alert_key(jid)).summary

    def test_taken_and_never_answered_is_given_up_after_ten_minutes(self, k):
        t1, _ = k.tills
        scr = screen(k)
        put(k, scr, host=str(t1.id))
        jid = send(k, scr)["id"]
        pending(k, t1)
        row = k.db.get(KitchenPrintJob, uuid.UUID(jid))
        row.created_at = row.created_at - KP.TAKEN_TTL - timedelta(seconds=1)
        k.db.commit()
        assert job_statuses(k, scr, jid)[jid]["status"] == "expired"
        assert "קופת ההדפסה לא עונה" in L.find(k.db, BA.kds_alert_key(jid)).summary

    def test_a_test_from_the_dashboard(self, k):
        t1, _ = k.tills
        scr = screen(k)
        put(k, scr, host=str(t1.id))
        tasks = BackgroundTasks()
        out = R.post_screen_print_test(k.shop.id, scr.id, tasks, **_ctx(k))
        _run(tasks)
        assert (out["kind"], out["test"], out["targetMachineId"]) == ("test", True, str(t1.id))
        job = pending(k, t1)[0]
        assert job["ticket"]["source"] == "test" and job["ticket"]["notice"] == KP.TEST_NOTICE
        assert job["origin"] == "kds"
        # Never an alert for a test.
        row = k.db.get(KitchenPrintJob, uuid.UUID(out["id"]))
        ack(k, t1, out["id"], status="failed", error="x")
        k.db.commit()
        assert L.find(k.db, BA.kds_alert_key(row.id)) is None
        assert card(k, scr)["recentJobs"][0]["id"] == out["id"]

    def test_the_screens_own_test(self, k):
        scr = screen(k)
        put(k, scr)
        out = send(k, scr, test=True)
        assert out["kind"] == "test"

    def test_a_tills_ticket_is_as_before(self, k):
        # A till's own relayed ticket: no origin, the ticket as it sent it.
        t1, t2 = k.tills
        p = create(k, name="מטבח", connectionType="cloud", host="10.0.0.9", hostMachineId=str(t2.id), hostConnection="network")
        from test_kitchen_printers import send_job

        send_job(k, t1, p["id"])
        job = pending(k, t2)[0]
        assert "origin" not in job and KP.META_KEY not in job["ticket"]


# ── The hosts' contract ──────────────────────────────────────────────────────


def _normalised(job, scr, host, printer_id):
    text = json.dumps(job, ensure_ascii=False, sort_keys=True)
    for value, name in ((job["id"], "<job>"), (str(scr.id), "<screen>"), (str(host.id), "<host>"), (printer_id, "<printer>")):
        text = text.replace(value, name)
    out = json.loads(text)
    out["createdAt"] = "<createdAt>"
    # The look is the host's own ("עיצוב בון", pinned elsewhere): not this contract's.
    out["printer"]["ticketStyle"] = None
    out["expiresAt"] = "<expiresAt>"
    return out


class TestTheHostsContract:
    def test_the_pending_job_is_the_shared_fixture(self, k):
        t1, _ = k.tills
        t1.name = "ראשית"
        t1.pos_number = "1"
        scr = screen(k, name="מסך גריל")
        put(k, scr, host=str(t1.id))
        out = send(k, scr, ticket=bon())
        job = pending(k, t1)[0]
        got = _normalised(job, scr, t1, out["printerId"])
        if os.environ.get("UPDATE_KDS_RELAY_FIXTURE") == "1":
            FIXTURE.write_text(json.dumps(got, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        want = json.loads(FIXTURE.read_text(encoding="utf-8"))
        assert got == want

    def test_the_windows_host_has_the_same_bytes(self):
        windows = Path(__file__).resolve().parents[2] / "kiosk-desktop" / "test" / "fixtures" / FIXTURE.name
        if not windows.exists():  # pragma: no cover - a server-only checkout
            pytest.skip("no kiosk-desktop beside the server")

        def lf(b: bytes) -> bytes:
            return b.replace(b"\r\n", b"\n")

        assert lf(windows.read_bytes()) == lf(FIXTURE.read_bytes())
