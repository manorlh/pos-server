"""
What a Z's figures say must stay honest after the Z; a shift's open fields come from the
till (review M1, L4, L5).

* **M1** — a document *moved* into a shift already in a Z, or rewritten in place with
  different fiscal content, was absorbed silently (only brand-new documents were
  counted). A moved-in one now counts in `lateDocuments`, a rewritten one in
  `amendedDocuments`, on the shift and on its Z. A status change that keeps it a sale
  (marked `refunded` by its credit note) is no amendment.
* **L4** — a shift created by a sale gets its missing float, number and the till's
  business date from the close; the open event corrects the business date while open.
* **L5** — a shift number at or below one the till already used is flagged, not refused.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.z_report import ZReport
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionIn
from app.services.shifts import apply_shift_close, report_shift_open, shift_to_out
from app.services.transactions import upsert_transactions
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _doc(shift_id, total="10.00", *, doc_id=None, status="completed", tip="0", number="1", updated=NOW):
    return TransactionIn.model_validate({
        "id": str(doc_id or uuid.uuid4()), "transactionNumber": number, "status": status,
        "documentType": 320, "paymentMethod": "cash", "totalAmount": total, "vatAmount": "1.00",
        "netAmount": str(Decimal(total) - 1), "tipAmount": tip,
        "shiftId": str(shift_id) if shift_id else None,
        "createdAt": NOW.isoformat(), "updatedAt": updated.isoformat(), "items": [],
    })


def _filed(w):
    """A closed shift with one document, taken by a Z."""
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    doc_id = uuid.uuid4()
    upsert_transactions(w.db, till, [_doc(shift.id, doc_id=doc_id)])
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
    z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
    return till, shift, doc_id, z


class TestAFiledDocumentChangingIsFlagged:
    def test_a_rewritten_amount_counts_as_amended(self, w):
        till, shift, doc_id, z = _filed(w)

        upsert_transactions(w.db, till, [_doc(shift.id, "12.00", doc_id=doc_id, updated=NOW + timedelta(minutes=1))])

        assert (shift.amended_documents, z.amended_documents) == (1, 1)
        assert (shift.late_documents, z.late_documents) == (0, 0)
        assert z.total_sales == Decimal("10.00")  # the Z's figures stay as filed

    def test_a_same_updated_at_rewrite_is_still_caught(self, w):
        till, shift, doc_id, z = _filed(w)
        upsert_transactions(w.db, till, [_doc(shift.id, doc_id=doc_id, tip="3.00")])
        assert z.amended_documents == 1

    def test_a_status_change_that_keeps_it_a_sale_is_not_an_amendment(self, w):
        till, shift, doc_id, z = _filed(w)
        upsert_transactions(w.db, till, [_doc(shift.id, doc_id=doc_id, status="refunded", updated=NOW + timedelta(minutes=1))])
        assert z.amended_documents == 0

    def test_a_plain_retry_is_nothing(self, w):
        till, shift, doc_id, z = _filed(w)
        upsert_transactions(w.db, till, [_doc(shift.id, doc_id=doc_id)])
        assert (z.amended_documents, z.late_documents) == (0, 0)

    def test_a_document_moved_in_counts_as_late(self, w):
        till, shift, _doc_id, z = _filed(w)
        orphan_id = uuid.uuid4()
        upsert_transactions(w.db, till, [_doc(None, doc_id=orphan_id, number="2")])  # stored with no shift

        upsert_transactions(w.db, till, [_doc(shift.id, doc_id=orphan_id, number="2", updated=NOW + timedelta(minutes=1))])

        # Moved into a shift a Z took, so not counted by it: carried into the next Z (§4.6.3).
        from app.models.transaction import Transaction
        from app.services.late_documents import is_carry

        assert is_carry(w.db.get(Shift, w.db.get(Transaction, orphan_id).shift_id))
        assert (shift.late_documents, z.late_documents) == (0, 0)
        assert (z.header or {}).get("lateCarriedOut") == 1
        assert z.amended_documents == 0

    def test_the_shift_and_z_out_carry_the_count(self, w):
        till, shift, doc_id, z = _filed(w)
        upsert_transactions(w.db, till, [_doc(shift.id, "11.00", doc_id=doc_id, updated=NOW + timedelta(minutes=1))])
        from app.routers.z_reports import z_to_out

        assert shift_to_out(shift).amended_documents == 1
        assert z_to_out(z).model_dump(by_alias=True)["amendedDocuments"] == 1

    def test_before_a_z_the_x_is_recomputed_and_nothing_is_flagged(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc_id = uuid.uuid4()
        upsert_transactions(w.db, till, [_doc(shift.id, doc_id=doc_id)])
        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))

        upsert_transactions(w.db, till, [_doc(shift.id, "15.00", doc_id=doc_id, updated=NOW + timedelta(minutes=1))])

        assert shift.total_sales == Decimal("15.00")
        assert shift.amended_documents == 0


class TestTheCloseFillsASaleCreatedShift:
    def test_float_number_and_business_date_come_from_the_close(self, w):
        till = w.tills[0]
        sid = uuid.uuid4()
        upsert_transactions(w.db, till, [_doc(sid)])  # the sale beat the open: shift created
        shift = w.db.get(Shift, sid)
        assert shift.opening_cash is None and shift.sequence_number is None

        apply_shift_close(w.db, till, sid, ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "businessDate": "2026-09-26", "sequenceNumber": 4,
            "openingCash": "250.00", "openedAt": (NOW - timedelta(hours=9)).isoformat(),
            "openedByName": "Dana",
        }))

        assert shift.opening_cash == Decimal("250.00")
        assert shift.sequence_number == 4
        assert shift.business_date == date(2026, 9, 26)
        assert shift.opened_by == "Dana"
        assert shift.opened_at.replace(tzinfo=None) == (NOW - timedelta(hours=9)).replace(tzinfo=None)

    def test_values_the_open_event_set_are_kept(self, w):
        till = w.tills[0]
        shift = w.shift(till, 2, status=ShiftStatus.OPEN, opening_cash="100.00")
        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "sequenceNumber": 9, "openingCash": "5.00",
        }))
        assert (shift.sequence_number, shift.opening_cash) == (2, Decimal("100.00"))

    def test_the_open_event_corrects_the_business_date(self, w):
        till = w.tills[0]
        sid = uuid.uuid4()
        upsert_transactions(w.db, till, [_doc(sid)])

        report_shift_open(w.db, till, ShiftOpenIn.model_validate({
            "id": str(sid), "businessDate": "2026-09-25", "openedAt": NOW.isoformat(), "sequenceNumber": 1,
        }))

        assert w.db.get(Shift, sid).business_date == date(2026, 9, 25)


class TestASequenceGoingBackIsFlagged:
    def _open(self, w, till, seq):
        return report_shift_open(w.db, till, ShiftOpenIn.model_validate({
            "id": str(uuid.uuid4()), "businessDate": str(TODAY), "openedAt": NOW.isoformat(), "sequenceNumber": seq,
        }))

    def test_a_reused_number_is_accepted_and_flagged(self, w):
        till = w.tills[0]
        w.shift(till, 5)

        shift = self._open(w, till, 3)

        assert shift.status == ShiftStatus.OPEN
        assert shift.sequence_out_of_order is True
        assert shift_to_out(shift).model_dump(by_alias=True)["sequenceOutOfOrder"] is True

    def test_the_next_number_is_not_flagged(self, w):
        till = w.tills[0]
        w.shift(till, 5)
        assert self._open(w, till, 6).sequence_out_of_order is False

    def test_another_tills_numbers_do_not_count(self, w):
        w.shift(w.tills[1], 9)
        assert self._open(w, w.tills[0], 1).sequence_out_of_order is False

    def test_a_close_creating_the_shift_flags_it_too(self, w):
        till = w.tills[0]
        w.shift(till, 5)
        sid = uuid.uuid4()
        shift, _ = apply_shift_close(w.db, till, sid, ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "businessDate": str(TODAY), "openedAt": NOW.isoformat(), "sequenceNumber": 2,
        }))
        assert shift.sequence_out_of_order is True
