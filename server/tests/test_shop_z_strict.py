"""
Shop Z from the master till: the cloud verifies every till before the Z is built.

The user's rule: "Don't close the Z until you verify against the CLOUD that all the
tills/shifts are closed." A run started from the master till is strict
(`ZRun.strict_cloud_check`): the Z is built only when, for every till, each shift it
takes is closed on the cloud, its close accepted, and the till's own count/totals at the
close agree with the documents the cloud holds. The server refuses otherwise — the run
waits — and the only way past a till is the operator's typed "סגור" (proceed), which
defers it to the next Z and records who decided, on the run and on the Z.

Also here: the fast heartbeat while the master's shop Z screen is open or a run waits,
and the shop Z printed in parts (a summary, then each till on its own).

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.shift import Shift, ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunItemStatus, ZRunStatus
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.routers import till_shop_z as R
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import remote_close
from app.services import till_parameters as TP
from app.services import z_print
from app.services import z_runs as ZR
from app.services.shifts import apply_shift_close, note_documents_after_close
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a))
    TP.ensure_builtin_parameters(world.db)
    master = world.db.query(TillParameter).filter(TillParameter.key == R.MASTER_PARAM).one()
    world.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=master.id, scope_type="machine", scope_id=world.tills[0].id, value=True,
    ))
    world.db.flush()
    return world


# ── Helpers ──────────────────────────────────────────────────────────────────


def open_shift_with_sales(w, till, seq, *amounts):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    docs = [w.doc(till, shift, amount) for amount in amounts]
    return shift, docs


def figures(*amounts, count=None):
    """What a till files with its close: its own count and gross, as its X shows them."""
    total = sum((Decimal(a) for a in amounts), Decimal("0"))
    return {
        "transactionsCount": len(amounts) if count is None else count,
        "totalSales": str(total),
        "totalCash": str(total),
    }


def close(w, till, shift, docs, *, till_figures=None, request_id=None):
    """The till's close reaching the cloud, as `POST /sync/{id}/shifts/{sid}/close` does."""
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(),
        "unattended": True,
        "countedCash": None,
        "transactionIds": [str(d.id) for d in docs],
        "till": till_figures,
        "closeRequestId": str(request_id) if request_id else None,
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    remote_close.on_shift_close_accepted(w.db, till, shift)
    w.db.flush()
    return shift


def start(w, who="דנה"):
    master = w.tills[0]
    return R.till_shop_z_start(
        str(master.id), R.ShopZStartIn(confirmOpenTills=False, posUserName=who), machine=master, db=w.db
    )


def poll(w, run_out):
    master = w.tills[0]
    return R.till_shop_z_run(str(master.id), uuid.UUID(run_out["id"]), machine=master, db=w.db)


def proceed(w, run_out, who="דנה"):
    master = w.tills[0]
    return R.till_shop_z_proceed(
        str(master.id), uuid.UUID(run_out["id"]), R.ShopZProceedIn(posUserName=who), machine=master, db=w.db
    )


def item_of(run_out, till):
    return next(i for i in run_out["items"] if i["machineId"] == str(till.id))


def zs(w):
    return w.db.query(ZReport).all()


# ── The rule ─────────────────────────────────────────────────────────────────


class TestAllTillsClosedOnTheCloud:
    def test_the_z_is_produced_once_every_till_is_closed_accepted_and_complete(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00", "5.00")
        s2, d2 = open_shift_with_sales(w, t2, 1, "20.00")
        run = start(w)
        assert run["strictCloudCheck"] is True
        assert {item_of(run, t)["status"] for t in (t1, t2)} == {ZRunItemStatus.WAITING_CLOSE}

        # The master closes its own shift at once, with its item as the close request.
        close(w, t1, s1, d1, till_figures=figures("10.00", "5.00"), request_id=item_of(run, t1)["id"])
        mid = poll(w, run)
        assert mid["status"] == ZRunStatus.WAITING
        assert item_of(mid, t1)["status"] == ZRunItemStatus.READY
        assert item_of(mid, t1)["cloudVerified"] is True
        assert (item_of(mid, t1)["tillDocuments"], item_of(mid, t1)["cloudDocuments"]) == (2, 2)
        assert zs(w) == []

        # The other till's close is the last word: the Z is built there and then.
        close(w, t2, s2, d2, till_figures=figures("20.00"), request_id=item_of(run, t2)["id"])
        done = poll(w, run)
        assert done["status"] == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, uuid.UUID(done["zReportId"]))
        assert z.total_sales == Decimal("35.00") and z.machine_count == 2
        assert all(item_of(done, t)["cloudVerified"] is True for t in (t1, t2))

    def test_a_close_without_figures_claims_nothing_and_is_taken_as_the_cloud_holds_it(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=None)
        assert poll(w, run)["status"] == ZRunStatus.COMPLETED


class TestAPendingCloseHoldsTheZ:
    def test_the_server_refuses_to_build_while_a_till_has_not_closed(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        open_shift_with_sales(w, t2, 1, "20.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("10.00"))

        out = poll(w, run)
        assert out["status"] == ZRunStatus.WAITING
        assert item_of(out, t2)["status"] == ZRunItemStatus.WAITING_CLOSE
        # Asking the server to build anyway changes nothing.
        stored = w.db.get(ZRun, uuid.UUID(run["id"]))
        assert ZR.finalise_if_ready(w.db, stored) is False
        assert zs(w) == []
        # Nor can the dashboard's proceed build it without naming the till.
        with pytest.raises(HTTPException) as e:
            ZR.proceed_without(w.db, stored, [])
        assert e.value.status_code == 409
        assert e.value.detail["code"] == "items_not_ready"

    def test_a_strict_run_that_runs_out_of_time_expires_whole_without_a_z(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        open_shift_with_sales(w, t2, 1, "20.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("10.00"))

        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=ZR.Z_RUN_TTL_HOURS + 1))

        stored = w.db.get(ZRun, uuid.UUID(run["id"]))
        assert stored.status == ZRunStatus.EXPIRED
        assert zs(w) == []
        # Nothing was taken: the closed shift still waits for a Z.
        assert w.db.get(Shift, s1.id).z_report_id is None


class TestDeferredWithSagor:
    def test_a_till_deferred_with_sagor_is_left_out_and_who_decided_is_recorded(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        s2, _ = open_shift_with_sales(w, t2, 1, "20.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("10.00"))

        out = proceed(w, run, who="דנה")

        assert out["status"] == ZRunStatus.COMPLETED
        left = item_of(out, t2)
        assert left["status"] == ZRunItemStatus.EXCLUDED
        assert left["errorCode"] == ZR.DEFERRED_BY_OPERATOR
        assert "דנה" in left["deferredBy"] and "דנה" in left["errorMessage"]
        # On the Z itself: which till it went without, and who decided.
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        recorded = z.header["openTillsLeftOut"]
        assert [t["id"] for t in recorded["tills"]] == [str(t2.id)]
        assert "דנה" in recorded["confirmedByName"]
        assert recorded["tills"][0]["openShiftId"] == str(s2.id)
        assert recorded["tills"][0]["deferred"] is True
        # The Z is the master's alone; the deferred till's shift is still open, for the next Z.
        assert z.total_sales == Decimal("10.00") and z.machine_count == 1
        assert w.db.get(Shift, s2.id).status == ShiftStatus.OPEN
        # And the footer of the printed Z says so.
        doc = z_print.build_print_document(z, timezone.utc)
        assert any("הופק ללא קופות" in line and "דנה" in line for line in doc["footer"])


class TestTotalsMismatch:
    def test_a_till_whose_count_the_cloud_does_not_hold_keeps_the_z_waiting(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        run = start(w)
        # The till counted two sales (₪25) but listed, and the cloud holds, one (₪10).
        close(w, t1, s1, d1, till_figures=figures("10.00", "15.00"))

        out = poll(w, run)
        assert out["status"] == ZRunStatus.WAITING
        item = item_of(out, t1)
        assert item["status"] == ZRunItemStatus.READY
        assert item["cloudVerified"] is False
        assert item["errorCode"] == ZR.WAITING_TRANSACTIONS
        assert (item["tillDocuments"], item["cloudDocuments"]) == (2, 1)
        assert ZR.finalise_if_ready(w.db, w.db.get(ZRun, uuid.UUID(run["id"]))) is False
        assert zs(w) == []

        # The missing sale arrives in the closed shift: the Z is built with it.
        w.doc(t1, w.db.get(Shift, s1.id), "15.00")
        note_documents_after_close(w.db, {s1.id: 1}, machine_id=t1.id)

        stored = w.db.get(ZRun, uuid.UUID(run["id"]))
        assert stored.status == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, stored.z_report_id)
        assert z.total_sales == Decimal("25.00") and z.transactions_count == 2

    def test_the_masters_poll_verifies_again(self, w):
        t1, _ = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("10.00", "15.00"))
        assert poll(w, run)["status"] == ZRunStatus.WAITING

        w.doc(t1, w.db.get(Shift, s1.id), "15.00")  # landed; nothing else told the run
        assert poll(w, run)["status"] == ZRunStatus.COMPLETED

    def test_a_till_waiting_for_transactions_can_be_deferred_with_sagor(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        s2, d2 = open_shift_with_sales(w, t2, 1, "20.00")
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("10.00"))
        close(w, t2, s2, d2, till_figures=figures("20.00", "7.00"))
        assert poll(w, run)["status"] == ZRunStatus.WAITING

        out = proceed(w, run, who="יוסי")

        assert out["status"] == ZRunStatus.COMPLETED
        assert item_of(out, t2)["status"] == ZRunItemStatus.EXCLUDED
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("10.00")
        assert [t["id"] for t in z.header["openTillsLeftOut"]["tills"]] == [str(t2.id)]
        # Its closed shift waits for the next Z.
        assert w.db.get(Shift, s2.id).z_report_id is None

    def test_a_dashboard_run_is_not_held_by_the_tills_own_figures(self, w):
        t1, _ = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        close(w, t1, s1, d1, till_figures=figures("10.00", "15.00"))
        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=t1.id)])
        assert run.strict_cloud_check is False
        assert run.status == ZRunStatus.COMPLETED


# ── The fast heartbeat ───────────────────────────────────────────────────────


def beat(w, till):
    return machines_router.post_my_heartbeat(
        body=MachineHeartbeatBody.model_validate({}), machine=till, db=w.db
    )


class TestFastBeat:
    def test_the_master_screen_puts_the_shops_tills_on_the_fast_beat(self, w):
        t1, t2 = w.tills
        assert "fastBeat" not in beat(w, t2)

        R.till_shop_z_status(str(t1.id), machine=t1, db=w.db)  # the screen opens

        assert beat(w, t2)["fastBeat"] is True
        assert "fastBeat" not in beat(w, w.other_till)  # another shop is not affected

    def test_the_screen_closing_lets_it_lapse(self, w):
        t1, t2 = w.tills
        ZR.note_shop_z_screen(t1, now=NOW - ZR.SHOP_Z_SCREEN_TTL - timedelta(seconds=1))
        w.db.flush()
        assert ZR.shop_z_fast_beat(w.db, t2, now=NOW) is False

    def test_a_waiting_run_keeps_the_shop_on_the_fast_beat(self, w, monkeypatch):
        import app.services.remote_close as remote_close_module

        class _WorldClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW if tz is not None else NOW.replace(tzinfo=None)

        # The heartbeat's hand-over reads the clock there too (the world lives at NOW).
        monkeypatch.setattr(remote_close_module, "datetime", _WorldClock)
        t1, t2 = w.tills
        open_shift_with_sales(w, t2, 1, "20.00")
        start(w)
        t1.shop_z_screen_until = None
        w.db.flush()
        assert beat(w, t2)["fastBeat"] is True
        assert beat(w, t2)["pendingCloseShift"]["requestId"]


# ── Printing in parts ────────────────────────────────────────────────────────


def _section(till, net, docs, seq):
    return {
        "machineId": str(till.id),
        "machineName": till.name,
        "posNumber": till.pos_number,
        "shiftCount": 1,
        "firstShiftSequence": seq,
        "lastShiftSequence": seq,
        "firstDocumentNumber": "1",
        "lastDocumentNumber": str(docs),
        "transactionsCount": docs,
        "totalSales": net,
        "netSales": net,
        "totalRefunds": "0.00",
        "discountsTotal": "0.00",
        "vatTotal": "1.00",
        "totalCash": net,
        "totalCard": "0.00",
        "paymentBreakdown": {"cash": net},
        "totalTips": "0.00",
        "totalCashTips": "0.00",
        "totalCardTips": "0.00",
        "openingCash": "100.00",
        "expectedCash": "150.00",
        "countedCash": None,
        "overShort": None,
        "uncountedShiftCount": 1,
        "betweenShiftAdjustments": "0.00",
        "unattendedShiftCount": 1,
    }


def _shop_z(w):
    t1, t2 = w.tills
    z = ZReport(
        id=uuid.uuid4(),
        tenant_id=w.tenant.id,
        shop_id=w.shop.id,
        shop_sequence_number=7,
        business_date=date(2026, 9, 27),
        closed_at=datetime(2026, 9, 27, 19, 20, tzinfo=timezone.utc),
        period_start=datetime(2026, 9, 27, 5, 0, tzinfo=timezone.utc),
        period_end=datetime(2026, 9, 27, 19, 0, tzinfo=timezone.utc),
        shift_count=2,
        machine_count=2,
        total_sales=Decimal("80.00"),
        total_refunds=Decimal("0.00"),
        discounts_total=Decimal("0.00"),
        vat_total=Decimal("2.00"),
        total_cash_sales=Decimal("80.00"),
        total_card_sales=Decimal("0.00"),
        total_tips=Decimal("0.00"),
        total_cash_tips=Decimal("0.00"),
        total_card_tips=Decimal("0.00"),
        transactions_count=5,
        payment_breakdown={"cash": "80.00"},
        opening_cash=Decimal("200.00"),
        expected_cash=Decimal("280.00"),
        header={"businessName": "Acme Ltd", "companyRegNumber": "515151515", "shopName": "Center"},
        # Built in whatever order: printed in till-number order.
        per_machine=[_section(t2, "50.00", 3, 9), _section(t1, "30.00", 2, 4)],
    )
    w.db.add(z)
    w.db.flush()
    return z


def _titles(doc):
    return [s["title"] for s in doc["sections"]]


class TestPrintingInParts:
    def test_the_summary_has_one_line_per_till_and_no_till_detail(self, w):
        t1, t2 = w.tills
        z = _shop_z(w)
        doc = z_print.build_summary_document(z, timezone.utc)

        assert doc["subtitle"][0] == "סיכום סניף"
        titles = _titles(doc)
        assert "קופות" in titles
        # No per-till sections: the full document's are titled "קופה N · name".
        assert not any(t.startswith("קופה ") for t in titles)
        lines = next(s for s in doc["sections"] if s["title"] == "קופות")["rows"]
        assert [r["label"] for r in lines] == ["קופה 1 · מש׳ #4", "קופה 2 · מש׳ #9"]
        assert lines[0]["value"] == "₪30.00 · 2 מס׳"
        assert [t["machineId"] for t in doc["tills"]] == [str(t1.id), str(t2.id)]

    def test_each_till_prints_as_a_document_of_its_own(self, w):
        t1, t2 = w.tills
        z = _shop_z(w)
        doc = z_print.build_till_document(z, t2.id, timezone.utc)

        assert doc["number"] == 7
        assert doc["subtitle"][0] == "פירוט קופה 2 · Till 2"
        sales = {r["label"]: r["value"] for r in next(s for s in doc["sections"] if s["title"] == "מכירות")["rows"]}
        assert sales["סה״כ נטו"] == "₪50.00" and sales["מסמכים"] == "3"
        assert any(line.startswith("סוף פירוט קופה 2") for line in doc["footer"])
        assert z_print.build_till_document(z, uuid.uuid4(), timezone.utc) is None

    def test_the_till_endpoint_serves_the_parts_and_the_list_names_the_tills(self, w):
        t1, t2 = w.tills
        z = _shop_z(w)

        summary = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part="summary", till=None, machine=t1, db=w.db)
        assert "tills" in summary
        detail = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t2.id, machine=t1, db=w.db)
        assert detail["subtitle"][0].startswith("פירוט קופה 2")
        full = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=None, machine=t1, db=w.db)
        assert "קופה 1 · Till 1" in _titles(full)  # the dashboard's whole Z is unchanged
        with pytest.raises(HTTPException) as e:
            sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=uuid.uuid4(), machine=t1, db=w.db)
        assert e.value.status_code == 404

        listed = sync_router.list_own_shop_z_reports(str(t1.id), limit=20, offset=0, machine=t1, db=w.db)
        assert [t["posNumber"] for t in listed["items"][0]["tills"]] == ["1", "2"]
