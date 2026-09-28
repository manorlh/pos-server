"""
A shift's X stores gross sales and document discounts beside the net figure.

The till's X prints gross sales (Σ totalAmount) and its discounts; the server's
`totalSales` is net of document discounts. Without the other two stored, the dashboard's
till-vs-cloud view had nothing to put against the till's two lines. What is pinned:

* gross - discounts = net, over sales only (a credit note and a declined tap are not
  sales), on every road an X is written: the till's close, a late document, and an
  administrative close;
* the till's `totalSales` is still compared with the gross figure, so a discounted
  shift is not flagged.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.transaction import TransactionStatus
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionIn
from app.services import ably_notify
from app.services.administrative_close import close_shift_administratively
from app.services.shifts import apply_shift_close, shift_to_out
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _documents(w, till, shift):
    return [
        w.doc(till, shift, "100.00", discount="10.00"),
        w.doc(till, shift, "50.00", discount="2.50", method="card"),
        w.doc(till, shift, "20.00", credit_note=True),
        w.doc(till, shift, "999.00", discount="99.00", status=TransactionStatus.CANCELLED),
    ]


def _close(w, till, shift, docs, till_x):
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "transactionIds": [str(d.id) for d in docs],
        "till": till_x,
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


class TestTheClose:
    def test_gross_and_discounts_are_stored_with_the_x(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        docs = _documents(w, till, shift)

        shift = _close(w, till, shift, docs, {"totalSales": "150.00", "totalDiscounts": "12.50"})

        assert shift.gross_sales == Decimal("150.00")
        assert shift.discounts_total == Decimal("12.50")
        assert shift.total_sales == Decimal("137.50")
        assert shift.gross_sales - shift.discounts_total == shift.total_sales
        # The till's gross and discounts agree with the documents: no mismatch.
        assert shift.totals_mismatch is False

    def test_they_are_on_the_wire(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        shift = _close(w, till, shift, _documents(w, till, shift), None)

        totals = shift_to_out(shift).model_dump(by_alias=True, mode="json")["serverTotals"]

        assert totals["grossSales"] == "150.00"
        assert totals["discountsTotal"] == "12.50"
        assert totals["totalSales"] == "137.50"

    def test_a_till_gross_that_disagrees_is_a_mismatch(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        shift = _close(w, till, shift, _documents(w, till, shift), {"totalSales": "137.50"})

        assert shift.totals_mismatch is True

    def test_a_shift_with_no_sales_stores_zero_not_null(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        shift = _close(w, till, shift, [], None)

        assert (shift.gross_sales, shift.discounts_total) == (Decimal("0"), Decimal("0"))

    def test_an_open_shift_has_none_yet(self, w):
        shift = w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)

        assert shift_to_out(shift).server_totals is None


class TestTheOtherRoads:
    def test_a_late_document_recomputes_them(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        shift = _close(w, till, shift, _documents(w, till, shift), None)

        late = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "77", "status": "completed",
            "totalAmount": "40.00", "documentDiscount": "4.00", "paymentMethod": "cash",
            "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": "36.00"}],
            "reprintCount": 0, "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
            "shiftId": str(shift.id), "businessDate": str(TODAY),
        })
        assert [r.status for r in upsert_transactions(w.db, till, [late])] == ["accepted"]

        stored = w.db.get(Shift, shift.id)
        assert stored.gross_sales == Decimal("190.00")
        assert stored.discounts_total == Decimal("16.50")
        assert stored.total_sales == Decimal("173.50")

    def test_an_administrative_close_fills_them(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=5)
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _documents(w, till, shift)

        shift, created = close_shift_administratively(w.db, till, shift, w.admin, now=NOW)

        assert created
        assert shift.gross_sales == Decimal("150.00")
        assert shift.discounts_total == Decimal("12.50")
