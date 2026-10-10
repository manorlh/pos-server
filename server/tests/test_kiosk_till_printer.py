"""
"תוודא שקיוסק תומך בבון מהמדפסת המקומית בקופה" (docs/SPEC_KIOSK.md §16.9): a kiosk's bon on
the printer physically attached to a till — its built-in head, or a USB / Bluetooth printer on it.

* **Picked by name.** The kiosk's printing settings list each till's local printer
  ("המדפסת המובנית — 2 · Till 2"), from the till's device profile and its printer settings;
  picking one makes (or reuses) the hosted printer entry behind it. Kiosks are not listed.
* **The cloud path.** The kiosk relays the bon; the host till is handed it and prints it on
  its own printer (`hostConnection` till / usb); its ack reaches the kiosk.
* **The LAN path.** Every sender learns where the host till takes jobs on the LAN (its own
  report), so a kiosk on the LAN hands the bon there first; the host never sees its own.
* **Once.** A sender takes back a job no till took yet (the host is off) before a person's
  "הדפס עכשיו" queues it again; a job a till already has stays (it may still print there).
* **The staff alert** names the till that did not answer.

Runs on the world of tests/test_kiosk_ops.py (a kiosk, the main till, a third till).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks

from app.models.printers import KitchenPrinter, KitchenPrintJob
from app.routers import printers as PR
from app.schemas.kitchen_printers import PrinterIn, PrintHostReportIn, TillLocalPrinterIn
from app.services import kiosk_ops as OPS
from app.services import printers as K
from test_kiosk_ops import _ack, _bon, _host_side, _kiosk_view, put, refused, set_param, w  # noqa: F401


def _ctx(w):
    return dict(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def local_printers(w):
    return PR.list_till_local_printers(w.shop.id, **_ctx(w))["printers"]


def pick(w, machine, connection="till"):
    tasks = BackgroundTasks()
    out = PR.ensure_till_local_printer(
        w.shop.id, TillLocalPrinterIn(machineId=machine.id, connection=connection), tasks, **_ctx(w),
    )
    return out


def pull(w, machine):
    return PR.get_own_printers(str(machine.id), etag=None, machine=machine, db=w.db)


def listed(payload, printer_id):
    return next((p for p in payload["printers"] if p["id"] == printer_id), None)


def single_bon_printer(w, printer_id):
    put(w, {"printing": {"bonMode": "single", "bonPrinterId": printer_id}})


# ── Picked by name ────────────────────────────────────────────────────────────


def test_each_tills_local_printer_is_offered_by_name_and_kiosks_are_not(w):
    # The main till: no model recorded (reads as an F20 / 55F — a head of its own).
    # The third: a P18 tablet (no head) printing on a USB printer.
    w.third.device_model = "P18"
    set_param(w, "receiptPrinter", "machine", w.third.id, "USB")
    set_param(w, "receiptPrinterModel", "machine", w.third.id, "ESC/POS 58 מ״מ")
    w.db.commit()
    offered = {(p["machineId"], p["connection"]): p for p in local_printers(w)}
    assert set(offered) == {(str(w.main.id), "till"), (str(w.third.id), "usb")}
    builtin = offered[(str(w.main.id), "till")]
    assert builtin["machineName"] == "2 · Till 2" and builtin["printerId"] is None
    assert builtin["paperWidth"] == 58
    usb = offered[(str(w.third.id), "usb")]
    assert usb["deviceName"] == "ESC/POS 58 מ״מ" and usb["paperWidth"] == 58
    # The kiosk itself is not offered: it prints its own.
    assert all(p["machineId"] != str(w.kiosk.id) for p in offered.values())


def test_picking_one_makes_the_hosted_printer_once_and_reuses_it(w):
    made = pick(w, w.main)
    assert made["name"] == "המדפסת המובנית — 2 · Till 2"
    assert (made["connectionType"], made["hostMachineId"], made["hostConnection"]) == ("cloud", str(w.main.id), "till")
    # Narrowed to its own till: no other till or kiosk routes there by itself.
    assert made["purpose"] == "kitchen" and made["machineId"] == str(w.main.id) and made["areaId"] is None
    assert made["paperWidth"] == 58 and made["cutPaper"] is False
    # Picked again (another kiosk, a second click): the same entry, never a duplicate.
    assert pick(w, w.main)["id"] == made["id"]
    assert w.db.query(KitchenPrinter).count() == 1
    (offer,) = [p for p in local_printers(w) if p["machineId"] == str(w.main.id)]
    assert offer["printerId"] == made["id"] and offer["printerActive"] is True
    # Switched off on the printers page: picking it switches it on again.
    row = w.db.get(KitchenPrinter, uuid.UUID(made["id"]))
    row.is_active = False
    w.db.commit()
    assert pick(w, w.main)["isActive"] is True


def test_a_till_without_such_a_printer_is_refused(w):
    w.third.device_model = "P18"
    w.db.commit()
    assert refused(pick, w, w.third, "till").detail == "no_local_printer"
    assert refused(pick, w, w.main, "usb").detail == "no_local_printer"
    assert refused(pick, w, w.kiosk, "till").detail == "no_local_printer"


def test_a_usb_printer_on_the_host_till_is_a_host_connection(w):
    w.third.device_model = "P18"
    set_param(w, "receiptPrinter", "machine", w.third.id, "USB")
    w.db.commit()
    made = pick(w, w.third, "usb")
    assert made["hostConnection"] == "usb" and made["name"] == "מדפסת USB — 9 · Till 3"
    assert made["host"] is None and made["btAddress"] is None and made["cutPaper"] is True
    # The printers page keeps it as it is.
    body = PrinterIn.model_validate({
        "name": "x", "connectionType": "cloud", "hostMachineId": str(w.third.id), "hostConnection": "usb",
        "host": "10.0.0.1", "btAddress": "AA:BB:CC:DD:EE:FF",
    })
    assert (body.host_connection, body.host, body.bt_address) == ("usb", None, None)
    # The host prints it on its own USB port; the kiosk that picked it relays it.
    single_bon_printer(w, made["id"])
    host_view = listed(pull(w, w.third), made["id"])
    assert host_view["isHost"] is True and host_view["hostConnection"] == "usb"
    kiosk_view = listed(pull(w, w.kiosk), made["id"])
    assert kiosk_view["isHost"] is False and kiosk_view["hostMachineName"] == "9 · Till 3"


def test_a_bluetooth_printer_on_a_till_carries_its_address(w):
    set_param(w, "receiptPrinter", "machine", w.third.id, "Bluetooth")
    set_param(w, "receiptPrinterAddress", "machine", w.third.id, "aa-bb-cc-dd-ee-01")
    w.db.commit()
    made = pick(w, w.third, "bluetooth")
    assert (made["hostConnection"], made["btAddress"]) == ("bluetooth", "AA:BB:CC:DD:EE:01")


# ── The cloud path, end to end ────────────────────────────────────────────────


def test_the_kiosk_bon_reaches_the_tills_own_head_through_the_cloud(w):
    made = pick(w, w.main)
    single_bon_printer(w, made["id"])
    # The kiosk sees a printer it relays, named by its host; the host prints it itself.
    seen = listed(pull(w, w.kiosk), made["id"])
    assert seen["type"] == "cloud" and seen["isHost"] is False and seen["hostConnection"] == "till"
    assert seen["hostMachineName"] == "2 · Till 2"
    own = listed(pull(w, w.main), made["id"])
    assert own["isHost"] is True and own["hostMachineName"] is None
    printer = w.db.get(KitchenPrinter, uuid.UUID(made["id"]))
    jid = _bon(w, printer)["id"]
    # Only the host is handed it, with how it reaches the printer: its own head.
    assert _host_side(w, w.third) == []
    (handed,) = _host_side(w, w.main)
    assert handed["id"] == jid and handed["printer"]["connection"] == "till"
    assert handed["ticket"]["orderRef"] == "A-1"
    assert _kiosk_view(w, jid)[jid]["status"] == "printing"
    # Printed: the kiosk reads "done" ("הודפס"); a failure comes back with its reason.
    _ack(w, w.main, jid, "done")
    w.db.commit()
    assert _kiosk_view(w, jid)[jid]["status"] == "done"
    jid2 = _bon(w, printer)["id"]
    _host_side(w, w.main)
    _ack(w, w.main, jid2, "failed", "no paper")
    w.db.commit()
    assert (_kiosk_view(w, jid2)[jid2]["status"], _kiosk_view(w, jid2)[jid2]["error"]) == ("failed", "no paper")


def test_the_one_bon_printer_reaches_the_kiosk_even_when_narrowed_to_its_till(w):
    made = pick(w, w.main)  # narrowed to its own till
    # By the routing, the kiosk has no business with it (a kiosk on its own USB printer stays so)…
    assert listed(pull(w, w.kiosk), made["id"]) is None
    # …but chosen as the kiosk's one bon printer, it is listed (not routed to: inScope false).
    single_bon_printer(w, made["id"])
    seen = listed(pull(w, w.kiosk), made["id"])
    assert seen is not None and seen["inScope"] is False and seen["isHost"] is False
    # A till that is no kiosk never gets it.
    assert listed(pull(w, w.third), made["id"]) is None


# ── The LAN path ──────────────────────────────────────────────────────────────


def report(w, machine, address, port=8399):
    return PR.report_print_host(str(machine.id), PrintHostReportIn(lanAddress=address, port=port), machine=machine, db=w.db)


def test_the_host_tills_lan_address_reaches_the_senders(w):
    made = pick(w, w.main)
    # Opened to every till on the printers page (the kiosk gets it either way once picked).
    w.db.get(KitchenPrinter, uuid.UUID(made["id"])).machine_id = None
    w.db.commit()
    # The main till hosts a printer (it is not the shop's print server): it reports where it listens.
    report(w, w.main, "192.168.0.21")
    w.db.commit()
    seen = listed(pull(w, w.kiosk), made["id"])
    assert (seen["hostLanAddress"], seen["hostLanPort"]) == ("192.168.0.21", 8399)
    assert listed(pull(w, w.third), made["id"])["hostLanAddress"] == "192.168.0.21"
    # The host itself prints it: no address of its own to send to.
    assert listed(pull(w, w.main), made["id"])["hostLanAddress"] is None
    # An independent kiosk may stand on the LAN or away: it gets it, and falls back to the cloud.
    w.kiosk.z_mode = "till"
    w.kiosk.independent_till = True
    # An independent till that is no kiosk is outside the shop's LAN group: the cloud only.
    w.third.z_mode = "till"
    w.third.independent_till = True
    w.db.commit()
    assert listed(pull(w, w.kiosk), made["id"])["hostLanAddress"] == "192.168.0.21"
    third = listed(pull(w, w.third), made["id"])
    assert third["hostLanAddress"] is None and third["hostMachineName"] == "2 · Till 2"


def test_a_new_address_changes_the_senders_etag(w):
    single_bon_printer(w, pick(w, w.main)["id"])
    first = pull(w, w.kiosk)
    report(w, w.main, "192.168.0.21")
    w.db.commit()
    assert PR.get_own_printers(str(w.kiosk.id), etag=first["etag"], machine=w.kiosk, db=w.db)["syncType"] == "full"


# ── Once ──────────────────────────────────────────────────────────────────────


def cancel(w, machine, job_id):
    return PR.cancel_print_job(str(machine.id), job_id, machine=machine, db=w.db)


def test_a_job_no_till_took_is_taken_back_by_its_sender_only(w):
    made = pick(w, w.main)
    printer = w.db.get(KitchenPrinter, uuid.UUID(made["id"]))
    jid = _bon(w, printer)["id"]
    # The host till is off: nobody took it. Only the kiosk may take it back.
    assert refused(cancel, w, w.main, jid).status_code == 404
    out = cancel(w, w.kiosk, jid)
    assert out["cancelled"] is True and (out["status"], out["error"]) == ("failed", "cancelled")
    # The host, back on, is never handed it: one bon, the one queued again.
    assert _host_side(w, w.main) == []
    assert cancel(w, w.kiosk, jid)["cancelled"] is True


def test_a_job_a_till_already_has_is_not_taken_back(w):
    made = pick(w, w.main)
    printer = w.db.get(KitchenPrinter, uuid.UUID(made["id"]))
    jid = _bon(w, printer)["id"]
    _host_side(w, w.main)  # handed out: it may print there any moment
    out = cancel(w, w.kiosk, jid)
    assert out["cancelled"] is False and out["status"] == "printing"
    # Its ack still counts.
    _ack(w, w.main, jid, "done")
    w.db.commit()
    assert _kiosk_view(w, jid)[jid]["status"] == "done"


def test_a_job_that_expired_untaken_counts_as_taken_back(w):
    made = pick(w, w.main)
    printer = w.db.get(KitchenPrinter, uuid.UUID(made["id"]))
    jid = _bon(w, printer)["id"]
    row = w.db.get(KitchenPrintJob, uuid.UUID(jid))
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    w.db.commit()
    assert cancel(w, w.kiosk, jid)["cancelled"] is True


# ── The staff alert names the till ────────────────────────────────────────────


def test_the_alert_says_which_till_did_not_answer():
    host = {"hostTill": "2 · Till 2"}
    assert OPS.alert_text("קיוסק רויאל", "printer", "bon_unprinted", {"orders": "A-1", "count": 1, **host}) == \
        "קיוסק רויאל — בון של הזמנה A-1 לא הודפס — 2 · Till 2 לא עונה (כבויה או לא מחוברת)"
    assert OPS.alert_text("קיוסק רויאל", "printer", "offline", {"target": "bon", "failed": 1, **host}) == \
        "קיוסק רויאל — מדפסת בונים: לא מחוברת — 2 · Till 2 לא עונה (כבויה או לא מחוברת)"
    # Without a host till nothing changes.
    assert OPS.alert_text("קיוסק רויאל", "printer", "bon_unprinted", {"orders": "A-1", "count": 1}) == \
        "קיוסק רויאל — בון של הזמנה A-1 לא הודפס"


def test_the_alert_reaches_the_tills_with_the_host_till(w):
    from test_kiosk_ops import kiosk_sync, till_alerts

    status = {"flowState": "attract", "alerts": [{
        "kind": "printer", "key": "bon:unprinted", "reason": "bon_unprinted",
        "detail": {"orders": "A-1", "count": 1, "hostTill": "2 · Till 2"},
    }]}
    kiosk_sync(w, status)
    w.db.commit()
    texts = [a["text"] for a in till_alerts(w, w.main)]
    assert any("2 · Till 2 לא עונה" in t for t in texts)
