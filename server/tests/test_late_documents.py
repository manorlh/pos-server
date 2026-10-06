"""
Late documents of a period support closed — into the next Z, exactly once
(docs/SPEC_OFFLINE_TILL_Z.md §4.6.3). The owner: "כשהקופה תדלק היא תיסגר? מה קורה אם יש
נתונים שלא עלו לענן ויש פער?".

* **Per-till:** documents the till uploads after support's Z go into the till's next Z, in a
  section of their own, and support's record links that Z.
* **Shop Z (cloud run):** the same through the shop's next Z.
* **Never moved back, never asked for** by a re-push or by the old shift's close.
* **The invariant:** over a generated scenario, every document in exactly one Z.
* **A till only offline** (not support-closed) when a shop Z waited: on its heartbeat it
  gets the close, closes, uploads — and the waiting Z completes with every document.
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.services import late_documents as LD
from app.services import z_print
from app.services import z_runs as ZR
from app.services.shifts import check_close_preconditions, note_documents_after_close
from test_support_z import beat_with, dead, open_shift_with_sales, produce, support_exception
from test_till_z import beat, closed_shift, created, w  # noqa: F401


def late_doc(w, till, shift, total):
    """A document the till uploads after support's Z: received by the cloud only now."""
    doc = w.doc(till, shift, total)
    doc.server_received_at = datetime.now(timezone.utc) + timedelta(seconds=30)
    w.db.commit()
    note_documents_after_close(w.db, {shift.id: 1}, machine_id=till.id)
    w.db.commit()
    return doc


def carry_shift(w, till):
    return next(
        s for s in w.db.query(Shift).filter(Shift.machine_id == till.id).all() if LD.is_carry(s)
    )


def all_documents_in_exactly_one_z(w, tills):
    """Every document of these tills: in a shift in a Z, and counted by exactly that Z."""
    docs = w.db.query(Transaction).filter(Transaction.machine_id.in_([t.id for t in tills])).all()
    for doc in docs:
        shift = w.db.get(Shift, doc.shift_id)
        assert shift is not None and shift.z_report_id is not None, f"document {doc.transaction_number} is in no Z"
    zs = w.db.query(ZReport).all()
    counted = sum(int(z.transactions_count or 0) for z in zs)
    assert counted == len(docs), f"{counted} counted by the Zs, {len(docs)} documents"
    total = sum((Decimal(z.total_sales or 0) for z in zs), Decimal("0"))
    assert total == sum((Decimal(d.total_amount) for d in docs), Decimal("0"))


class TestPerTill:
    def test_late_documents_go_into_the_tills_next_z_in_their_own_section(self, w):
        shift = open_shift_with_sales(w, w.till, 1, "20.00")
        dead(w)
        first = produce(w)
        assert first["zNumber"] == 1

        doc = late_doc(w, w.till, w.db.get(Shift, shift.id), "5.00")

        carry = carry_shift(w, w.till)
        assert w.db.get(Transaction, doc.id).shift_id == carry.id
        assert carry.status == ShiftStatus.CLOSED and carry.z_report_id is None and carry.close_accepted_at
        assert carry.transactions_count == 1 and carry.total_sales == Decimal("5.00")
        assert w.db.get(Shift, shift.id).late_documents == 0
        (row,) = support_exception(w)
        assert row.details["lateDocuments"] == 1 and row.details["lateCarriedInto"] == [str(carry.id)]

        # The till is back: its next Z (the next number, nothing renumbered) takes them.
        w.till.last_heartbeat_at = w.now
        w.db.commit()
        out = created(w, through=closed_shift(w, w.till, 2, [dict(total="10.00")]))
        z = w.db.get(ZReport, uuid.UUID(out["zReport"]["id"]))
        assert z.machine_sequence_number == 2
        assert w.db.get(Shift, carry.id).z_report_id == z.id
        assert z.total_sales == Decimal("15.00")
        (late,) = z.header["lateFromEarlier"]
        assert late["documents"] == 1 and late["totalSales"] == "5.00"
        assert late["label"] == "מסמכים מאוחרים מתקופה קודמת (קופה 1, הופקו לפני Z מס׳ 1 שהופק ע״י התמיכה)"
        assert out["zReport"]["lateFromEarlier"][0]["shiftId"] == str(carry.id)
        printed = next(
            s for s in z_print.build_print_document(z, None)["sections"] if s["title"] == "מסמכים מאוחרים מתקופה קודמת"
        )
        rows = {r["label"]: r["value"] for r in printed["rows"]}
        assert rows["קופה"] == "1" and rows["הופקו לפני Z"] == "מס׳ 1" and rows["ה-Z הופק ע״י"] == "התמיכה"
        assert rows["מסמכים"] == "1"
        w.db.refresh(row)
        assert row.details["lateIncludedIn"] == [
            {"zReportId": str(z.id), "zNumber": 2, "shiftId": str(carry.id), "documents": 1}
        ]
        all_documents_in_exactly_one_z(w, [w.till])

    def test_a_carried_document_stays_put_and_the_old_shifts_close_does_not_ask_for_it(self, w):
        shift = open_shift_with_sales(w, w.till, 1, "20.00")
        dead(w)
        produce(w)
        doc = late_doc(w, w.till, w.db.get(Shift, shift.id), "5.00")

        # The till's own close of the shift (rule 3) lists it: not stale — no re-push loop.
        assert check_close_preconditions(w.db, w.till, shift.id, [doc.id]) == ([], [])
        assert LD.is_carry_shift(w.db, w.db.get(Transaction, doc.id).shift_id)

    def test_later_arrivals_join_the_same_carry_until_a_z_takes_it(self, w):
        shift = open_shift_with_sales(w, w.till, 1, "20.00")
        dead(w)
        produce(w)
        s = w.db.get(Shift, shift.id)
        late_doc(w, w.till, s, "5.00")
        late_doc(w, w.till, s, "6.00")
        carries = [x for x in w.db.query(Shift).filter(Shift.machine_id == w.till.id).all() if LD.is_carry(x)]
        assert len(carries) == 1 and carries[0].transactions_count == 2


class TestShopZ:
    def test_late_documents_go_into_the_shops_next_cloud_z(self, w):
        till = w.tills[1]  # in the shop's Z
        shift = open_shift_with_sales(w, till, 1, "20.00")
        dead(w, till=till)
        produce(w, till=till)  # shop mode: the shift is closed, no Z here
        first = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        z1 = w.db.get(ZReport, first.z_report_id)
        assert w.db.get(Shift, shift.id).z_report_id == z1.id

        late_doc(w, till, w.db.get(Shift, shift.id), "7.00")
        carry = carry_shift(w, till)
        assert carry.reconstruction_basis["label"].endswith("הגיעו אחרי Z מס׳ 1; המשמרת נסגרה ע״י התמיכה)")

        second = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        z2 = w.db.get(ZReport, second.z_report_id)
        assert z2.shop_sequence_number == z1.shop_sequence_number + 1
        assert w.db.get(Shift, carry.id).z_report_id == z2.id
        assert z2.header["lateFromEarlier"][0]["documents"] == 1
        all_documents_in_exactly_one_z(w, [till])


class TestTheInvariant:
    def test_every_document_in_exactly_one_z_over_a_generated_scenario(self, w):
        rnd = random.Random(20261006)
        till = w.till
        seq = 0
        # Ordinary days with Zs.
        for _day in range(3):
            seq += 1
            created(w, through=closed_shift(w, till, seq, [dict(total=f"{rnd.randint(1, 90)}.00") for _ in range(rnd.randint(1, 4))]))
        # The till dies mid-shift; support produces its Z.
        seq += 1
        shift = open_shift_with_sales(w, till, seq, *[f"{rnd.randint(1, 90)}.00" for _ in range(3)])
        dead(w)
        produce(w)
        # It comes back with documents of that period, in batches.
        s = w.db.get(Shift, shift.id)
        for _ in range(rnd.randint(2, 5)):
            late_doc(w, till, s, f"{rnd.randint(1, 90)}.00")
        till.last_heartbeat_at = w.now
        w.db.commit()
        # More ordinary days — and documents arriving late after ordinary Zs too.
        for _day in range(4):
            seq += 1
            out = created(w, through=closed_shift(w, till, seq, [dict(total=f"{rnd.randint(1, 90)}.00") for _ in range(rnd.randint(1, 3))]))
            if rnd.random() < 0.75:
                z = w.db.get(ZReport, uuid.UUID(out["zReport"]["id"]))
                taken = [x for x in w.db.query(Shift).filter(Shift.z_report_id == z.id).all() if not LD.is_carry(x)]
                for _ in range(rnd.randint(1, 3)):
                    late_doc(w, till, rnd.choice(taken), f"{rnd.randint(1, 90)}.00")
        # And the last of them taken by a final Z.
        seq += 1
        created(w, through=closed_shift(w, till, seq, [dict(total="1.00")]))
        numbers = sorted(z.machine_sequence_number for z in w.db.query(ZReport).filter(ZReport.machine_id == till.id))
        assert numbers == list(range(1, len(numbers) + 1))  # sequential, nothing renumbered
        all_documents_in_exactly_one_z(w, [till])


class TestATillOnlyOffline:
    def test_it_closes_on_its_heartbeat_and_the_waiting_shop_z_completes(self, w):
        from app.routers import sync as sync_router
        from app.schemas.shift import ShiftCloseIn

        till = w.tills[1]  # in the shop's Z, off — not support-closed
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        before = w.doc(till, shift, "10.00")
        till.last_heartbeat_at = w.now - timedelta(hours=3)
        w.db.commit()

        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        assert run.status == ZRunStatus.WAITING

        # It powers on: the close is on its first heartbeat.
        handed = beat(w, till)["pendingCloseShift"]
        assert handed["shiftId"] == str(shift.id)
        # It finishes what it had (a sale made with no connection), uploads, and closes.
        made_offline = w.doc(till, shift, "7.00")
        w.db.commit()
        body = ShiftCloseIn.model_validate({
            "closedAt": datetime.now(timezone.utc).isoformat(), "unattended": True, "countedCash": None,
            "transactionIds": [str(before.id), str(made_offline.id)], "closeRequestId": handed["requestId"],
        })
        out = sync_router.post_shift_close(
            machine_id=str(till.id), shift_id=shift.id, body=body, machine=till, approval=None, db=w.db,
        )
        assert out["status"] == "accepted" if isinstance(out, dict) else True
        w.db.commit()

        w.db.refresh(run)
        assert run.status == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, run.z_report_id)
        assert z.total_sales == Decimal("17.00") and w.db.get(Shift, shift.id).z_report_id == z.id
        all_documents_in_exactly_one_z(w, [till])


# ── After an ordinary Z (the owner: every document in exactly one Z) ────────


class TestAfterAnOrdinaryZ:
    def test_late_documents_after_a_till_z_go_into_the_next(self, w):
        first = created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        z1 = w.db.get(ZReport, uuid.UUID(first["zReport"]["id"]))
        shift = w.db.query(Shift).filter(Shift.z_report_id == z1.id).one()

        late_doc(w, w.till, shift, "4.00")

        carry = carry_shift(w, w.till)
        assert carry.reconstruction_basis["source"] == "z"
        assert carry.reconstruction_basis["label"] == "מסמכים מאוחרים מתקופה קודמת (קופה 1, הגיעו אחרי Z מס׳ 1)"
        w.db.refresh(z1)
        assert z1.header["lateCarriedOut"] == 1 and (z1.late_documents or 0) == 0
        assert support_exception(w) == []  # nothing of support's

        second = created(w, through=closed_shift(w, w.till, 2, [dict(total="6.00")]))
        z2 = w.db.get(ZReport, uuid.UUID(second["zReport"]["id"]))
        assert z2.machine_sequence_number == 2 and z2.total_sales == Decimal("10.00")
        (late,) = z2.header["lateFromEarlier"]
        assert late["source"] == "z" and late["producedBySupport"] is False and late["documents"] == 1
        printed = next(s for s in z_print.build_print_document(z2, None)["sections"] if s["title"] == "מסמכים מאוחרים מתקופה קודמת")
        rows = {r["label"]: r["value"] for r in printed["rows"]}
        assert rows["הגיעו אחרי Z"] == "מס׳ 1" and "ה-Z הופק ע״י" not in rows and "המשמרת נסגרה ע״י" not in rows
        all_documents_in_exactly_one_z(w, [w.till])

    def test_late_documents_after_a_cloud_shop_z_go_into_the_next_shop_z(self, w):
        till = w.tills[1]
        shift = closed_shift(w, till, 1, [dict(total="10.00")])
        first = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        z1 = w.db.get(ZReport, first.z_report_id)

        late_doc(w, till, w.db.get(Shift, shift.id), "3.00")
        carry = carry_shift(w, till)

        second = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        z2 = w.db.get(ZReport, second.z_report_id)
        assert z2.shop_sequence_number == z1.shop_sequence_number + 1
        assert w.db.get(Shift, carry.id).z_report_id == z2.id and z2.total_sales == Decimal("3.00")
        all_documents_in_exactly_one_z(w, [till])

    def test_a_z_the_till_built_with_no_connection_leaves_them_for_the_next_cloud_built_z(self, w):
        from test_offline_till_z import offline_body, upload

        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        z1 = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        late_doc(w, w.till, w.db.query(Shift).filter(Shift.z_report_id == z1.id).one(), "4.00")
        carry = carry_shift(w, w.till)

        # Z 2 closed with no connection: its paper never had them — they are not in it.
        s2 = closed_shift(w, w.till, 2, [dict(total="5.00")])
        code, _body = upload(w, offline_body(s2, 2))
        assert code == 201
        z2 = w.db.query(ZReport).filter(ZReport.machine_sequence_number == 2).one()
        assert w.db.get(Shift, carry.id).z_report_id is None and "lateFromEarlier" not in (z2.header or {})

        # The next Z the cloud builds takes them.
        out = created(w, through=closed_shift(w, w.till, 3, [dict(total="1.00")]))
        assert w.db.get(Shift, carry.id).z_report_id == uuid.UUID(out["zReport"]["id"])
        all_documents_in_exactly_one_z(w, [w.till])
