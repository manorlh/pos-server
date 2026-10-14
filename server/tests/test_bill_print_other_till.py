"""
"הדפסת חשבון וקבלה על המדפסת המובנית של קופה אחרת" (P:/specs/bill-print-other-till.md;
app/services/remote_print.py, app/services/printers.py).

What each test pins, and how it could look fine while doing damage:

* **The printer** — a receipt printer of type cloud saves with its host of the shop, its drawer on the
  host's printer if it has one (§9: it opens only by a `drawer` job); its host must be a build that
  prints documents (`document_relay_v1`), the others "נדרש עדכון גרסה".
* **The drawer** (§9) — "בתשלום מזומן — לשאול" and its two parameters; `remotePrintDrawer` (never by
  default) holds a payment's opening, the menu's needs a till with a drawer; offered tills
  (`drawerHosts`); the opening on the sender's drawer log with who asked and who approved — one without a
  sale "מגירה נפתחה ללא מכירה", as today; CASH_DRAWER.OPEN_REMOTE and its phone approval.
* **Who gets it** — the tills it applies to (a receipt destination, never a ticket's), and its host,
  which so takes documents (`acceptsDocuments`); narrowed to a till, only that till and the host.
* **The job** — `document` goes the relay's way: created once per id, handed only to its host and only
  to a build that prints it, acknowledged, the sender's status says where; its image is gone once it is
  over; a ticket for that printer is refused. 413 past the image's ceiling, 422 an image that is not
  what it says.
* **The parameters** (§7א) — each one per level, the most specific wins; the cloud holds a job to them
  (off, which documents, which tills, how long it waits).
* **"לא הודפס"** — failed, expired or taken back: an entry for the host on "בעיות" (devices), switched
  off by the host's rule, closed by itself when it prints after all.

Runs on the world of tests/test_shop_areas.py (SQLite).
"""
from __future__ import annotations

import base64
import gzip
import struct
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.printers import PRINT_JOB_KINDS, KitchenPrintJob
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import printers as R
from app.schemas.kitchen_printers import KitchenOptionsIn, PrintJobAckIn, PrintJobIn
from app.services import exceptions as EX
from app.services import printers as K
from app.services import problems as P
from app.services import remote_print as RP
from app.services import till_parameters as TP
from app.services.exception_alerts import catalog as CAT
from app.services.exception_alerts import push as PUSH
from test_kitchen_printers import _run, ack, create, k, pending, printer_in, pull, send_job, statuses  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401


# ── Images ───────────────────────────────────────────────────────────────────


def png(width: int, height: int) -> bytes:
    """A real one-bit PNG, white."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + b"\xff" * ((width + 7) // 8)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def raster(width: int, height: int, extra: int = 0) -> bytes:
    return gzip.compress(b"\x00" * (((width + 7) // 8) * height + extra))


def document(**over):
    image = over.pop("raw", None) or png(576, 40)
    base = {
        "category": "bill", "type": "bill", "number": "1043", "copy": False, "title": "חשבון — שולחן 12",
        "paperWidth": 80, "widthDots": 576, "heightDots": 40, "encoding": "png",
        "image": base64.b64encode(image).decode(),
    }
    base.update(over)
    return base


def send_document(w, sender, *, printer_id=None, target=None, job_id=None, **doc):
    tasks = BackgroundTasks()
    body = PrintJobIn.model_validate({
        "id": str(job_id or uuid.uuid4()), "kind": "document", "printerId": printer_id,
        "targetMachineId": str(target.id) if target is not None else None, "document": document(**doc),
    })
    out = R.post_print_job(str(sender.id), body, tasks, machine=sender, db=w.db)
    _run(tasks)
    return out


def capable(*tills):
    for till in tills:
        till.capabilities = [RP.CAPABILITY]


def put_options(w, scope_type, scope_id, values):
    body = KitchenOptionsIn.model_validate({"scopeType": scope_type, "scopeId": str(scope_id), "values": values})
    tasks = BackgroundTasks()
    out = R.put_options(w.shop.id, body, tasks, **_ctx(w))
    _run(tasks)
    return out


def set_value(w, key, scope_type, scope_id, value):
    TP.ensure_builtin_parameters(w.db)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type,
                                scope_id=scope_id, value=value))
    w.db.commit()


def unprinted(w, job_id):
    w.db.expire_all()
    return w.db.query(AuditException).filter(AuditException.dedupe_key == f"{RP.EXCEPTION_TYPE}:{job_id}").all()


@pytest.fixture
def d(k):
    """Till 2 hosts "המדפסת של קופה 2" (its own head); both builds print documents."""
    t1, t2 = k.tills
    capable(t1, t2)
    k.db.commit()
    k.receipt = create(k, name="המדפסת של קופה 2", purpose="receipt", connectionType="cloud", host=None,
                       hostMachineId=str(t2.id), hostConnection="till", paperWidth=58)
    return k


# ── The printer ──────────────────────────────────────────────────────────────


class TestThePrinter:
    def test_a_receipt_printer_of_another_till(self):
        p = printer_in(purpose="receipt", connectionType="cloud", hostMachineId=str(uuid.uuid4()), host=None)
        assert (p.host_connection, p.cash_drawer, p.host) == ("till", False, None)
        net = printer_in(purpose="receipt", connectionType="cloud", hostMachineId=str(uuid.uuid4()),
                         hostConnection="network", host="10.0.0.7")
        assert (net.host_connection, net.host, net.port) == ("network", "10.0.0.7", 9100)
        usb = printer_in(purpose="receipt", connectionType="cloud", hostMachineId=str(uuid.uuid4()),
                         hostConnection="usb", host=None)
        assert usb.host_connection == "usb"
        with pytest.raises(ValidationError):  # a host is required
            printer_in(purpose="receipt", connectionType="cloud", host=None)
        with pytest.raises(ValidationError):  # "this till's printer" is the till's own setting
            printer_in(purpose="receipt", connectionType="till", host=None)

    def test_the_drawer_on_the_hosts_printer(self):
        # §9 (the owner, 14.10 — "דינמי"): the host's printer may have the drawer; it opens only by a
        # `drawer` job. A kitchen printer never has one.
        remote = printer_in(purpose="receipt", connectionType="cloud", hostMachineId=str(uuid.uuid4()), host=None,
                            cashDrawer=True)
        assert remote.cash_drawer is True
        assert printer_in(purpose="receipt", connectionType="network", cashDrawer=True).cash_drawer is True
        assert printer_in(connectionType="cloud", hostMachineId=str(uuid.uuid4()), host=None,
                          cashDrawer=True).cash_drawer is False

    def test_the_host_is_a_till_of_the_shop_whose_build_prints_documents(self, k):
        t1, t2 = k.tills
        body = dict(name="קבלות", purpose="receipt", connectionType="cloud", host=None)
        assert refused(create, k, hostMachineId=str(k.other_till.id), **body).detail == "host_machine_not_in_shop"
        e = refused(create, k, hostMachineId=str(t2.id), **body)
        assert (e.status_code, e.detail) == (422, "host_needs_update")
        page = R.list_printers(k.shop.id, **_ctx(k))
        assert {m["id"]: m["documentRelay"] for m in page["machines"]} == {str(t1.id): False, str(t2.id): False}
        capable(t2)
        k.db.commit()
        out = create(k, hostMachineId=str(t2.id), **body)
        assert (out["purpose"], out["connectionType"], out["hostConnection"], out["cashDrawer"]) == (
            "receipt", "cloud", "till", False,
        )
        assert R.list_printers(k.shop.id, **_ctx(k))["machines"][1]["documentRelay"] is True
        # Saved again with the same host, a moment its build did not say it: not locked.
        t2.capabilities = []
        k.db.commit()
        tasks = BackgroundTasks()
        again = R.update_printer(
            uuid.UUID(out["id"]), printer_in(paperWidth=58, hostMachineId=str(t2.id), **body), tasks, **_ctx(k),
        )
        assert again["paperWidth"] == 58
        # Moved to another host: that one must say it.
        e = refused(R.update_printer, uuid.UUID(out["id"]), printer_in(hostMachineId=str(t1.id), **body),
                    BackgroundTasks(), **_ctx(k))
        assert e.detail == "host_needs_update"


# ── Who gets it ──────────────────────────────────────────────────────────────


class TestWhoGetsIt:
    def test_the_tills_it_applies_to_and_its_host(self, d):
        t1, t2 = d.tills
        mine = pull(d, t1)
        [p] = [p for p in mine["printers"] if p["id"] == d.receipt["id"]]
        assert (p["purpose"], p["type"], p["isHost"], p["inScope"], p["cashDrawer"]) == (
            "receipt", "cloud", False, False, False,
        )
        assert (p["hostMachineId"], p["hostConnection"], p["hostDocumentRelay"]) == (str(t2.id), "till", True)
        assert p["hostMachineName"].endswith("Till 2") and p["paperWidth"] == 58
        assert mine["acceptsDocuments"] is False
        # No ticket routes to a receipt printer.
        assert d.receipt["id"] not in {pid for pids in mine["categoryRoutes"].values() for pid in pids}
        host = pull(d, t2)
        [h] = [p for p in host["printers"] if p["id"] == d.receipt["id"]]
        assert h["isHost"] is True and h["hostDocumentRelay"] is None
        assert host["acceptsDocuments"] is True and host["hostsRelay"] is True

    def test_narrowed_to_a_till_its_host_still_gets_it(self, d):
        t1, t2 = d.tills
        tasks = BackgroundTasks()
        R.update_printer(
            uuid.UUID(d.receipt["id"]),
            printer_in(name="ל-1 בלבד", purpose="receipt", connectionType="cloud", host=None,
                       hostMachineId=str(t2.id), machineId=str(t1.id)),
            tasks, **_ctx(d),
        )
        assert d.receipt["id"] in {p["id"] for p in pull(d, t1)["printers"]}
        host = pull(d, t2)
        assert [p["isHost"] for p in host["printers"] if p["id"] == d.receipt["id"]] == [True]
        # Inactive: nobody.
        R.update_printer(
            uuid.UUID(d.receipt["id"]),
            printer_in(name="x", purpose="receipt", connectionType="cloud", host=None, hostMachineId=str(t2.id),
                       isActive=False),
            BackgroundTasks(), **_ctx(d),
        )
        assert all(p["id"] != d.receipt["id"] for t in d.tills for p in pull(d, t)["printers"])
        assert pull(d, t2)["acceptsDocuments"] is False

    def test_an_older_host_is_shown_not_offered(self, d):
        t1, t2 = d.tills
        t2.capabilities = ["remote_close_v2"]
        d.db.commit()
        [p] = [p for p in pull(d, t1)["printers"] if p["id"] == d.receipt["id"]]
        assert p["hostDocumentRelay"] is False

    def test_an_older_sender_never_gets_it(self, d):
        t1, _ = d.tills
        t1.capabilities = ["remote_close_v2"]
        d.db.commit()
        # It could pick it as its receipt destination and print nothing.
        assert all(p["id"] != d.receipt["id"] for p in pull(d, t1)["printers"])
        assert pull(d, t1)["drawerHosts"] == []


# ── The job ──────────────────────────────────────────────────────────────────


class TestTheJob:
    def test_the_lifecycle(self, d):
        t1, t2 = d.tills
        assert "document" in PRINT_JOB_KINDS
        job_id = str(uuid.uuid4())
        before = datetime.now(timezone.utc)
        out = send_document(d, t1, printer_id=d.receipt["id"], job_id=job_id)
        assert (out["kind"], out["status"], out["targetMachineId"]) == ("document", "pending", str(t2.id))
        assert out["targetMachineName"].endswith("Till 2") and out["printerName"] == "המדפסת של קופה 2"
        assert out["document"] == {
            "category": "bill", "type": "bill", "number": "1043", "copy": False, "title": "חשבון — שולחן 12",
            "paperWidth": 80, "sourceName": "קופה 1",
        }
        assert "image" not in str(out)
        # It waits the sender's remotePrintTimeoutSec (20 by default).
        expires = datetime.fromisoformat(out["expiresAt"])
        assert timedelta(seconds=19) <= expires - before <= timedelta(seconds=21)
        # Its host is woken (`print-job`); the same upload again is the same job.
        assert (str(t2.id), K.PRINT_JOB_EVENT) in d.jobs_notified
        assert send_document(d, t1, printer_id=d.receipt["id"], job_id=job_id)["id"] == job_id
        assert d.db.query(KitchenPrintJob).count() == 1
        # The sender's own till never gets it; the host does, the image to print as it is.
        assert pending(d, t1) == []
        [job] = pending(d, t2)
        assert (job["kind"], job["ticket"]) == ("document", None)
        assert job["printer"]["connection"] == "till" and job["printer"]["paperWidth"] == 58
        assert base64.b64decode(job["document"]["image"]).startswith(b"\x89PNG")
        assert (job["document"]["sourceMachineId"], job["document"]["bytes"]) == (str(t1.id), len(png(576, 40)))
        # Printed: the sender hears it at once, and the image is gone.
        d.jobs_notified.clear()
        tasks = BackgroundTasks()
        done = R.ack_print_job(str(t2.id), job_id, PrintJobAckIn(status="done"), machine=t2, db=d.db,
                               background_tasks=tasks)
        _run(tasks)
        assert done["status"] == "done" and (str(t1.id), K.PRINT_JOB_EVENT) in d.jobs_notified
        row = d.db.get(KitchenPrintJob, uuid.UUID(job_id))
        assert "image" not in row.payload and row.payload["imageDropped"] is True
        seen = statuses(d, t1, job_id)[job_id]
        assert seen["status"] == "done" and seen["targetMachineName"].endswith("Till 2")
        assert seen["document"]["number"] == "1043"
        assert unprinted(d, job_id) == []

    def test_a_till_named_by_itself(self, d):
        t1, t2 = d.tills
        out = send_document(d, t1, target=t2)
        assert (out["targetMachineId"], out["printerId"]) == (str(t2.id), None)
        assert out["printerName"].endswith("Till 2")
        [job] = pending(d, t2)
        assert job["printer"] is None  # its own receipt printer
        assert refused(send_document, d, t1, target=t1).detail["code"] == "host_is_sender"
        assert refused(send_document, d, t1, target=d.other_till).detail["code"] == "host_not_found"
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], target=t1)
        assert e.detail["code"] == "target_not_printer_host"

    def test_only_a_receipt_printer_of_another_till_takes_documents_and_never_a_ticket(self, d):
        t1, t2 = d.tills
        kitchen = create(d, name="Bar", connectionType="cloud", hostMachineId=str(t2.id), host=None)
        assert refused(send_document, d, t1, printer_id=kitchen["id"]).detail["code"] == "printer_not_document"
        assert refused(send_job, d, t1, d.receipt["id"]).detail == "printer_not_relayed"
        with pytest.raises(ValidationError):
            PrintJobIn.model_validate({"id": str(uuid.uuid4()), "kind": "document", "document": document()})

    def test_handed_only_to_a_build_that_prints_it(self, d):
        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        t2.capabilities = []
        d.db.commit()
        assert pending(d, t2) == []
        assert d.db.get(KitchenPrintJob, uuid.UUID(job_id)).status == "pending"
        # Nor made for it.
        assert refused(send_document, d, t1, printer_id=d.receipt["id"]).detail["code"] == "host_needs_update"

    def test_the_image_ceiling_and_what_it_says(self, d):
        t1, _ = d.tills
        big = base64.b64encode(b"\x89PNG" + b"\x00" * (RP.IMAGE_MAX_BYTES + 1)).decode()
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], image=big)
        assert (e.status_code, e.detail["code"], e.detail["maxBytes"]) == (413, "document_too_large", 512 * 1024)
        assert refused(send_document, d, t1, printer_id=d.receipt["id"], image="not base64!").status_code == 422
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], raw=png(384, 40))
        assert (e.status_code, e.detail["code"]) == (422, "document_image_invalid")
        out = send_document(d, t1, printer_id=d.receipt["id"], encoding="raster_gzip", raw=raster(576, 40))
        assert out["status"] == "pending"
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], encoding="raster_gzip", raw=raster(576, 40, 8))
        assert e.status_code == 422
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], encoding="raster_gzip", raw=png(576, 40))
        assert e.status_code == 422
        assert d.db.query(KitchenPrintJob).count() == 1  # nothing kept of a refused one

    def test_a_taken_document_is_given_up_in_minutes_not_hours(self, d):
        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        pending(d, t2)
        row = d.db.get(KitchenPrintJob, uuid.UUID(job_id))
        later = datetime.now(timezone.utc) + RP.TAKEN_TTL + timedelta(minutes=1)
        K.expire_jobs(d.db, [row], later)
        assert row.status == "expired" and "image" not in row.payload


# ── The parameters (§7א) ─────────────────────────────────────────────────────


class TestTheParameters:
    def test_the_builtins_and_their_defaults(self, k):
        TP.ensure_builtin_parameters(k.db)
        k.db.commit()
        defs = {p.key: p for p in k.db.query(TillParameter).filter(TillParameter.key.in_(RP.KEYS)).all()}
        assert set(defs) == set(RP.KEYS)
        assert {key: defs[key].default_value for key in RP.KEYS} == {
            "remotePrintEnabled": True, "remotePrintDocuments": "bill", "remotePrintFallback": "ask",
            "remotePrintTimeoutSec": 20, "remotePrintNotice": True, "remotePrintHosts": "",
            "remotePrintFromDashboard": True, "remotePrintDrawer": "never",
        }
        assert defs["remotePrintDrawer"].enum_options == ["never", "ask", "auto"]
        assert defs["remotePrintDocuments"].enum_options == ["bill", "bill_receipts", "all"]
        assert defs["remotePrintFallback"].enum_options == ["ask", "local", "none"]
        assert all(defs[key].label and "לפי חברה, סניף, נקודת מכירה או קופה" in defs[key].description for key in RP.KEYS)
        assert TP.enum_labels("remotePrintDocuments")["bill_receipts"] == "גם קבלות וחשבוניות"
        # Nothing set: what a till gets changes nothing (the defaults).
        assert RP.settings_for(k.db, k.tills[0]) == RP.Settings()

    def test_each_level_and_the_most_specific_wins(self, k):
        t1, t2 = k.tills
        area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name="Bar")
        k.db.add(area)
        t2.area_id = area.id
        k.db.commit()
        set_value(k, "remotePrintDocuments", "company", k.company.id, "bill_receipts")
        set_value(k, "remotePrintTimeoutSec", "company", k.company.id, 45)
        assert RP.settings_for(k.db, t1).documents == "bill_receipts"
        put_options(k, "shop", k.shop.id, {"remotePrintDocuments": "all", "remotePrintFallback": "local"})
        put_options(k, "area", area.id, {"remotePrintDocuments": "bill"})
        put_options(k, "machine", t2.id, {"remotePrintTimeoutSec": 60, "remotePrintNotice": False})
        one, two = RP.settings_for(k.db, t1), RP.settings_for(k.db, t2)
        assert (one.documents, one.fallback, one.timeout, one.notice) == ("all", "local", 45, True)
        assert (two.documents, two.fallback, two.timeout, two.notice) == ("bill", "local", 60, False)
        # The till reads them as parameters, with the rest.
        params = TP.till_parameters_for_machine(k.db, t2).parameters
        assert (params["remotePrintDocuments"], params["remotePrintTimeoutSec"]) == ("bill", 60)
        # The printers page shows each level's own and the company's as inherited.
        options = R.list_printers(k.shop.id, **_ctx(k))["options"]
        assert options["inherited"]["remotePrintTimeoutSec"] == 45 and "remotePrintTimeoutSec" in options["fromCompany"]
        assert options["areas"][str(area.id)] == {"remotePrintDocuments": "bill"}
        assert options["effective"][str(t2.id)]["remotePrintDocuments"] == {"value": "bill", "effectiveSource": "area"}
        [labels] = [p["enumLabels"] for p in options["parameters"] if p["key"] == "remotePrintFallback"]
        assert labels["none"] == "רק התראה"

    def test_what_a_level_may_set(self, k):
        t1, t2 = k.tills
        assert refused(put_options, k, "shop", k.shop.id, {"remotePrintTimeoutSec": 3}).detail.startswith(
            "invalid_value:remotePrintTimeoutSec"
        )
        assert refused(put_options, k, "shop", k.shop.id, {"remotePrintDocuments": "receipts"}).status_code == 422
        assert refused(put_options, k, "shop", k.shop.id, {"remotePrintHosts": "not-a-till"}).status_code == 422
        e = refused(put_options, k, "shop", k.shop.id, {"remotePrintHosts": str(k.other_till.id)})
        assert "not a till of this shop" in e.detail
        out = put_options(k, "shop", k.shop.id, {"remotePrintHosts": f" {str(t2.id).upper()} ,{t2.id}"})
        assert out["shop"]["remotePrintHosts"] == str(t2.id)
        assert RP.settings_for(k.db, t1).hosts == (str(t2.id),)
        # The parameters page's own check: the same rule.
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value("remotePrintTimeoutSec", 121)
        assert TP.validate_keyed_value("remotePrintHosts", "") == ""

    def test_the_cloud_holds_a_document_to_them(self, d):
        t1, t2 = d.tills
        # Receipts: only with bill_receipts (or all).
        e = refused(send_document, d, t1, printer_id=d.receipt["id"], category="receipt", type="320")
        assert (e.detail["code"], e.detail["documents"]) == ("document_not_remote", "bill")
        put_options(d, "shop", d.shop.id, {"remotePrintDocuments": "bill_receipts"})
        assert send_document(d, t1, printer_id=d.receipt["id"], category="receipt", type="320")["status"] == "pending"
        assert refused(send_document, d, t1, printer_id=d.receipt["id"], category="other", type="z").detail["code"] == (
            "document_not_remote"
        )
        # Off at the till's own level.
        put_options(d, "machine", t1.id, {"remotePrintEnabled": False})
        assert refused(send_document, d, t1, printer_id=d.receipt["id"]).detail["code"] == "remote_print_off"
        put_options(d, "machine", t1.id, {"remotePrintEnabled": None, "remotePrintHosts": str(t1.id)})
        e = refused(send_document, d, t1, printer_id=d.receipt["id"])
        assert (e.detail["code"], e.detail["host"]) == ("host_not_allowed", "קופה 2")
        put_options(d, "machine", t1.id, {"remotePrintHosts": None, "remotePrintTimeoutSec": 90})
        out = send_document(d, t1, printer_id=d.receipt["id"])
        created, expires = datetime.fromisoformat(out["createdAt"]), datetime.fromisoformat(out["expiresAt"])
        assert expires - created == timedelta(seconds=90)


# ── "לא הודפס" on "בעיות" ─────────────────────────────────────────────────────


class TestNotPrinted:
    def test_the_kind_its_group_and_its_rule(self):
        assert CAT.kind_spec(RP.EXCEPTION_TYPE).label == "חשבון לא הודפס בקופה אחרת"
        assert P.KIND_GROUP[RP.EXCEPTION_TYPE] == "devices"
        rule = EX.RULES_BY_TYPE[RP.EXCEPTION_TYPE]
        assert rule.default_enabled and not rule.push_only and not rule.push_default
        assert RP.EXCEPTION_TYPE in CAT.OPT_IN_KINDS
        assert PUSH.category_of(SimpleNamespace(kind=RP.EXCEPTION_TYPE, details={})) == "bon_unprinted"

    def test_failed_at_its_host_then_printed_after_all(self, d):
        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        pending(d, t2)
        ack(d, t2, job_id, "failed", "אין נייר")
        d.db.commit()
        [row] = unprinted(d, job_id)
        assert (row.exception_type, row.machine_id, row.severity) == (RP.EXCEPTION_TYPE, t2.id, "medium")
        assert row.details["summary"] == "חשבון 1043 לא הודפס בקופה 2 (נשלח מקופה 1)"
        assert (row.details["error"], row.details["source"], row.details["document"]["number"]) == (
            "אין נייר", "קופה 1", "1043",
        )
        # The sender sees it, the image is gone.
        assert statuses(d, t1, job_id)[job_id]["status"] == "failed"
        assert "image" not in d.db.get(KitchenPrintJob, uuid.UUID(job_id)).payload

    def test_expired_with_nobody_taking_it_and_a_late_print(self, d):
        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        row = d.db.get(KitchenPrintJob, uuid.UUID(job_id))
        K.expire_jobs(d.db, [row], datetime.now(timezone.utc) + timedelta(seconds=30))
        d.db.commit()
        [entry] = unprinted(d, job_id)
        assert entry.details["resolvedAt"] is None and entry.details["status"] == "expired"
        # Taken back by its sender instead (it prints it itself): the same entry, once.
        other = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        R.cancel_print_job(str(t1.id), other, machine=t1, db=d.db)
        assert len(unprinted(d, other)) == 1

    def test_switched_off_by_the_hosts_rule(self, d):
        t1, t2 = d.tills
        d.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=d.tenant.id, scope_type="machine", scope_id=t2.id,
                                    exception_type=RP.EXCEPTION_TYPE, enabled=False))
        d.db.commit()
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        pending(d, t2)
        ack(d, t2, job_id, "failed", "שגיאת מדפסת")
        d.db.commit()
        assert unprinted(d, job_id) == []

    def test_printed_after_all_closes_it(self, d):
        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        pending(d, t2)
        row = d.db.get(KitchenPrintJob, uuid.UUID(job_id))
        # Taken, then silent past its time: given up …
        K.expire_jobs(d.db, [row], datetime.now(timezone.utc) + RP.TAKEN_TTL + timedelta(minutes=1))
        d.db.commit()
        assert unprinted(d, job_id)[0].details["resolvedAt"] is None
        # … and its host says it printed: printed late is printed.
        ack(d, t2, job_id, "done")
        d.db.commit()
        [entry] = unprinted(d, job_id)
        assert entry.details["resolvedAt"] and entry.status == "reviewed"

    def test_it_reaches_the_exceptions_log(self, d):
        from app.models.exception_alerts import ExceptionLogEntry

        t1, t2 = d.tills
        job_id = send_document(d, t1, printer_id=d.receipt["id"])["id"]
        pending(d, t2)
        ack(d, t2, job_id, "failed", "אין נייר")
        d.db.commit()
        d.db.expire_all()
        [entry] = d.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == RP.EXCEPTION_TYPE).all()
        assert entry.summary == "חשבון 1043 לא הודפס בקופה 2 (נשלח מקופה 1)" and entry.machine_id == t2.id


# ── The drawer (§9) ──────────────────────────────────────────────────────────


def send_drawer(w, sender, *, printer_id=None, target=None, job_id=None, **over):
    drawer = {
        "reason": "manual", "reasonCode": "CHANGE", "reasonNote": "פריטה",
        "requestedBy": {"id": "pu-1", "name": "דנה"},
        "approvedBy": {"id": "pu-9", "name": "רון", "method": "pin"},
    }
    drawer.update(over)
    tasks = BackgroundTasks()
    body = PrintJobIn.model_validate({
        "id": str(job_id or uuid.uuid4()), "kind": "drawer", "printerId": printer_id,
        "targetMachineId": str(target.id) if target is not None else None, "drawer": drawer,
    })
    out = R.post_print_job(str(sender.id), body, tasks, machine=sender, db=w.db)
    _run(tasks)
    return out


@pytest.fixture
def dd(d):
    """"המדפסת של קופה 2" has the drawer on its port."""
    tasks = BackgroundTasks()
    R.update_printer(
        uuid.UUID(d.receipt["id"]),
        printer_in(name="המדפסת של קופה 2", purpose="receipt", connectionType="cloud", host=None,
                   hostMachineId=str(d.tills[1].id), hostConnection="till", paperWidth=58, cashDrawer=True),
        tasks, **_ctx(d),
    )
    return d


class TestTheDrawer:
    def test_asking_before_opening_the_drawer(self, k):
        TP.ensure_builtin_parameters(k.db)
        k.db.commit()
        defs = {p.key: p for p in k.db.query(TillParameter).filter(
            TillParameter.key.in_(["cashDrawer", "cashDrawerAskTimeoutSec", "cashDrawerAskDefault"])).all()}
        assert defs["cashDrawer"].enum_options == ["כבוי", "בתשלום מזומן", "בתשלום מזומן — לשאול", "בתשלום מזומן + כפתור פתיחה"]
        assert defs["cashDrawer"].default_value == "כבוי"  # unchanged
        assert (defs["cashDrawerAskTimeoutSec"].default_value, defs["cashDrawerAskDefault"].default_value) == (8, "open")
        assert defs["cashDrawerAskDefault"].enum_options == ["open", "skip"]
        # On the printers page, with the drawer ("מגירה ותשלום").
        assert {"cashDrawerAskTimeoutSec", "cashDrawerAskDefault"} < set(K.SETTING_KEYS)
        out = put_options(k, "shop", k.shop.id, {"cashDrawer": "בתשלום מזומן — לשאול", "cashDrawerAskTimeoutSec": 12,
                                                "cashDrawerAskDefault": "skip"})
        assert out["shop"]["cashDrawerAskDefault"] == "skip"
        params = TP.till_parameters_for_machine(k.db, k.tills[0]).parameters
        assert (params["cashDrawer"], params["cashDrawerAskTimeoutSec"], params["cashDrawerAskDefault"]) == (
            "בתשלום מזומן — לשאול", 12, "skip",
        )
        assert refused(put_options, k, "shop", k.shop.id, {"cashDrawerAskTimeoutSec": 2}).status_code == 422
        assert refused(put_options, k, "shop", k.shop.id, {"cashDrawerAskDefault": "maybe"}).status_code == 422

    def test_a_payments_opening_waits_for_remote_print_drawer(self, dd):
        t1, t2 = dd.tills
        e = refused(send_drawer, dd, t1, printer_id=dd.receipt["id"], reason="payment", documentType="320",
                    documentNumber="1043", amount=120.0)
        assert (e.status_code, e.detail["code"]) == (409, "drawer_remote_off")
        put_options(dd, "shop", dd.shop.id, {"remotePrintDrawer": "ask"})
        out = send_drawer(dd, t1, printer_id=dd.receipt["id"], reason="payment", documentType="320",
                          documentNumber="1043", amount=120.0)
        assert (out["kind"], out["status"], out["targetMachineId"]) == ("drawer", "pending", str(t2.id))
        assert out["drawer"] == {"reason": "payment", "documentNumber": "1043", "requestedBy": "דנה",
                                 "approvedBy": "רון", "sourceName": "קופה 1"}
        # Off altogether: nothing remote.
        put_options(dd, "machine", t1.id, {"remotePrintEnabled": False})
        assert refused(send_drawer, dd, t1, printer_id=dd.receipt["id"]).detail["code"] == "remote_print_off"

    def test_the_menus_opening_needs_a_till_with_a_drawer(self, d):
        t1, t2 = d.tills
        # The printer of till 2 has no drawer, nor has till 2 one of its own ("פתיחת מגירה" off).
        assert refused(send_drawer, d, t1, printer_id=d.receipt["id"]).detail["code"] == "printer_has_no_drawer"
        e = refused(send_drawer, d, t1, target=t2)
        assert (e.detail["code"], e.detail["host"]) == ("host_has_no_drawer", "קופה 2")
        assert pull(d, t1)["drawerHosts"] == []
        # Till 2 drives a drawer itself: offered, and taken — whatever remotePrintDrawer says (never).
        put_options(d, "machine", t2.id, {"cashDrawer": "בתשלום מזומן + כפתור פתיחה"})
        [host] = pull(d, t1)["drawerHosts"]
        assert (host["machineId"], host["label"], host["printerId"], host["lanAddress"]) == (str(t2.id), "קופה 2", None, None)
        assert send_drawer(d, t1, target=t2)["status"] == "pending"
        # Not to a till outside remotePrintHosts, nor an older build; nor from one.
        put_options(d, "machine", t1.id, {"remotePrintHosts": str(t1.id)})
        assert pull(d, t1)["drawerHosts"] == []
        assert refused(send_drawer, d, t1, target=t2).detail["code"] == "host_not_allowed"
        put_options(d, "machine", t1.id, {"remotePrintHosts": None})
        t2.capabilities = []
        d.db.commit()
        assert pull(d, t1)["drawerHosts"] == []
        t2.capabilities = [RP.CAPABILITY]
        t1.capabilities = []
        d.db.commit()
        assert pull(d, t1)["drawerHosts"] == []

    def test_offered_with_the_printer_that_has_the_drawer(self, dd):
        t1, t2 = dd.tills
        dd.db.add(K.KitchenPrintHost(machine_id=t2.id, shop_id=dd.shop.id, lan_address="192.168.1.22", port=8399))
        dd.db.commit()
        [host] = pull(dd, t1)["drawerHosts"]
        assert (host["printerId"], host["lanAddress"], host["lanPort"]) == (dd.receipt["id"], "192.168.1.22", 8399)
        [p] = [p for p in pull(dd, t1)["printers"] if p["id"] == dd.receipt["id"]]
        assert p["cashDrawer"] is True
        # The host itself is not offered its own drawer.
        assert pull(dd, t2)["drawerHosts"] == []

    def test_opened_on_another_till_is_on_the_senders_drawer_log(self, dd):
        from app.models.cash_drawer import CashDrawerEvent

        t1, t2 = dd.tills
        job_id = send_drawer(dd, t1, printer_id=dd.receipt["id"], shiftId=str(uuid.uuid4()))["id"]
        [job] = pending(dd, t2)
        assert (job["kind"], job["ticket"], job["drawer"]["reason"]) == ("drawer", None, "manual")
        assert job["drawer"]["requestedBy"] == {"id": "pu-1", "name": "דנה", "method": None}
        assert job["drawer"]["approvedBy"] == {"id": "pu-9", "name": "רון", "method": "pin"}
        assert job["printer"]["connection"] == "till"
        dd.jobs_notified.clear()
        tasks = BackgroundTasks()
        R.ack_print_job(str(t2.id), job_id, PrintJobAckIn(status="done"), machine=t2, db=dd.db, background_tasks=tasks)
        _run(tasks)
        assert (str(t1.id), K.PRINT_JOB_EVENT) in dd.jobs_notified
        dd.db.expire_all()
        event = dd.db.get(CashDrawerEvent, uuid.UUID(job_id))
        assert (event.machine_id, event.event_type, event.result, event.permission) == (
            t1.id, "REMOTE_MANUAL", "approved", "CASH_DRAWER.OPEN_REMOTE",
        )
        assert (event.employee_name, event.approver_name, event.approver_method, event.decision) == ("דנה", "רון", "pin", "approval")
        assert (event.reason, event.details["hostName"], event.details["remote"]) == ("CHANGE", "קופה 2", True)
        # Without a sale: "מגירה נפתחה ללא מכירה", as today — on the sending till.
        [exc] = dd.db.query(AuditException).filter(AuditException.exception_type == "drawer_open").all()
        assert exc.machine_id == t1.id
        # The sender's own upload of it is the same row.
        from app.routers import cash_drawer as CR
        from app.schemas.cash_drawer import DrawerEventIn
        from fastapi import Response

        upload = DrawerEventIn.model_validate({"id": job_id, "eventType": "REMOTE_MANUAL", "result": "approved",
                                               "occurredAt": datetime.now(timezone.utc).isoformat()})
        assert CR.post_drawer_event(str(t1.id), upload, Response(), machine=t1, db=dd.db).status == "duplicate"
        assert unprinted(dd, job_id) == []  # a drawer is no document on "בעיות"

    def test_a_payments_opening_is_no_exception_and_a_failed_one_is_logged(self, dd):
        from app.models.cash_drawer import CashDrawerEvent

        t1, t2 = dd.tills
        put_options(dd, "shop", dd.shop.id, {"remotePrintDrawer": "auto"})
        paid = send_drawer(dd, t1, printer_id=dd.receipt["id"], reason="payment", approvedBy=None, amount=50.0)["id"]
        busy = send_drawer(dd, t1, printer_id=dd.receipt["id"], reason="payment", approvedBy=None)["id"]
        pending(dd, t2)
        ack(dd, t2, paid, "done")
        ack(dd, t2, busy, "failed", "busy_payment")
        dd.db.commit()
        dd.db.expire_all()
        ok, failed = dd.db.get(CashDrawerEvent, uuid.UUID(paid)), dd.db.get(CashDrawerEvent, uuid.UUID(busy))
        assert (ok.event_type, ok.result, ok.decision, float(ok.amount)) == ("REMOTE_SALE", "approved", "allow", 50.0)
        assert (failed.result, failed.result_reason) == ("failed", "busy_payment")
        assert dd.db.query(AuditException).filter(AuditException.exception_type == "drawer_open").count() == 0

    def test_a_drawer_opening_is_given_up_in_two_minutes(self, dd):
        t1, t2 = dd.tills
        job_id = send_drawer(dd, t1, printer_id=dd.receipt["id"])["id"]
        pending(dd, t2)
        row = dd.db.get(KitchenPrintJob, uuid.UUID(job_id))
        K.expire_jobs(dd.db, [row], datetime.now(timezone.utc) + timedelta(minutes=3))
        assert row.status == "expired"
        # Never to an older build.
        other = send_drawer(dd, t1, printer_id=dd.receipt["id"])["id"]
        t2.capabilities = []
        dd.db.commit()
        assert all(j["id"] != other for j in pending(dd, t2))

    def test_the_permission_and_its_phone_approval(self):
        from app.services import till_permissions as TPerm
        from app.services.remote_approvals import catalog as AC

        spec = TPerm.PERMISSIONS_BY_CODE["CASH_DRAWER.OPEN_REMOTE"]
        assert (spec.label, spec.group) == ("פתיחת מגירה בקופה אחרת", "drawer")
        states = [TPerm.DEFAULTS[r]["CASH_DRAWER.OPEN_REMOTE"] for r in ("waiter", "cashier", "supervisor", "manager")]
        assert states == ["approval", "approval", "allow", "allow"]
        assert TPerm.DEFAULTS["legacy_cashier"]["CASH_DRAWER.OPEN_REMOTE"] == "approval"
        assert TPerm.DEFAULTS["legacy_manager"]["CASH_DRAWER.OPEN_REMOTE"] == "allow"
        t = AC.TYPES_BY_KEY["drawer_open_remote"]
        assert (t.label, t.phase, t.base_code) == ("פתיחת מגירה בקופה אחרת", 1, "CASH_DRAWER.OPEN_REMOTE")
        assert TPerm.DEFAULTS["manager"]["APPROVE_REMOTE.drawer_open_remote"] == "allow"


# ── The migration ────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_the_release():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    line = {r.revision for r in script.walk_revisions("base", heads[0])}
    assert {"c4d8e2f6a1b9", "e7b2d9f4a6c3", "bb6205ba290c"} <= line
    # On release 14.10b's merge (bb6205ba290c), nothing else; the drawer's on top (§9).
    assert script.get_revision("c4d8e2f6a1b9").down_revision == "bb6205ba290c"
    assert script.get_revision("e7b2d9f4a6c3").down_revision == "c4d8e2f6a1b9"


def _migration(revision: str):
    import importlib.util
    from pathlib import Path

    root = Path(__file__).absolute().parents[1]
    path = next(root.glob(f"alembic/versions/{revision}_*.py"))
    spec = importlib.util.spec_from_file_location(f"migration_{revision}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_drawer_migration(monkeypatch):
    import json

    module = _migration("e7b2d9f4a6c3")
    ask = "בתשלום מזומן — לשאול"
    assert module.with_option(["כבוי", "בתשלום מזומן", "בתשלום מזומן + כפתור פתיחה"]) == [
        "כבוי", "בתשלום מזומן", ask, "בתשלום מזומן + כפתור פתיחה",
    ]
    assert module.with_option(["כבוי"]) == ["כבוי", ask]
    assert module.with_option(["כבוי", ask]) == ["כבוי", ask]
    calls, written = [], []

    class Conn:
        def execute(self, statement, params=None):
            if str(statement).startswith("SELECT"):
                return SimpleNamespace(first=lambda: ("p-1", json.dumps(["כבוי", "בתשלום מזומן", "בתשלום מזומן + כפתור פתיחה"])))
            written.append(params)

    monkeypatch.setattr(module, "op", SimpleNamespace(
        execute=lambda sql: calls.append(("execute", sql)),
        create_check_constraint=lambda name, table, condition: calls.append(("check", name, table, condition)),
        get_bind=lambda: Conn(),
    ))
    module.upgrade()
    assert calls[1] == ("check", "ck_kitchen_print_jobs_kind", "kitchen_print_jobs",
                        "kind IN ('ticket', 'test', 'document', 'drawer')")
    [params] = written
    assert params["id"] == "p-1" and json.loads(params["options"])[2] == ask
    # The model says the same.
    from app.models.printers import KitchenPrintJob as Job

    checks = {c.name: str(c.sqltext) for c in Job.__table__.constraints if hasattr(c, "sqltext")}
    assert checks["ck_kitchen_print_jobs_kind"] == "kind IN ('ticket', 'test', 'document', 'drawer')"


def test_the_migration_takes_the_new_kind(monkeypatch):
    module = _migration("c4d8e2f6a1b9")
    calls = []
    monkeypatch.setattr(module, "op", SimpleNamespace(
        execute=lambda sql: calls.append(("execute", sql)),
        create_check_constraint=lambda name, table, condition: calls.append(("check", name, table, condition)),
    ))
    module.upgrade()
    assert calls == [
        ("execute", "ALTER TABLE kitchen_print_jobs DROP CONSTRAINT IF EXISTS ck_kitchen_print_jobs_kind"),
        ("check", "ck_kitchen_print_jobs_kind", "kitchen_print_jobs", "kind IN ('ticket', 'test', 'document')"),
    ]
