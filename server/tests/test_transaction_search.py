"""
The dashboard's transaction search: by document number or amount, by a card's last four
digits (the till's `cardLast4`, else the terminal's masked number — on the document or on
any leg), by a product name on any line, and by tender (a leg's method, split, refunds).

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.routers.transactions import _search_filters
from shift_world import make_world


@pytest.fixture
def w():
    return make_world()


def line(w, tx, name, qty="1", price="10.00"):
    w.db.add(TransactionItem(
        id=uuid.uuid4(), transaction_id=tx.id, product_name=name,
        quantity=Decimal(qty), unit_price=Decimal(price), total_price=Decimal(price) * Decimal(qty),
    ))
    w.db.flush()


def numbers(w, **filters):
    q = _search_filters(w.db.query(Transaction), **filters)
    return sorted(t.transaction_number for t in q.all())


@pytest.fixture
def docs(w):
    till = w.tills[0]
    shift = w.shift(till, 1)
    cash = w.doc(till, shift, "25.00", number="1001")
    line(w, cash, "קפה הפוך", qty="2", price="12.50")

    card = w.doc(till, shift, "60.00", method="card", number="1002")
    card.nayax_meta = {"vuid": "a", "cardLast4": "7407"}
    line(w, card, "המבורגר")

    masked = w.doc(till, shift, "18.00", method="card", number="1003")
    leg = w.db.query(TransactionPayment).filter_by(transaction_id=masked.id).one()
    leg.nayax_meta = {"result": {"cardNumber": "542386***1234"}}

    split = w.doc(till, shift, "40.00", method="mixed", number="1004",
                  legs=[("cash", "10.00"), ("card", "30.00")])
    refund = w.doc(till, shift, "12.50", credit_note=True, number="1005")
    w.db.flush()
    return {"cash": cash, "card": card, "masked": masked, "split": split, "refund": refund}


class TestTransactionSearch:
    def test_by_card_last_four_on_the_document_or_on_a_leg(self, w, docs):
        assert numbers(w, card_last4="7407") == ["1002"]
        assert numbers(w, card_last4="1234") == ["1003"]
        assert numbers(w, card_last4="0000") == []

    def test_by_product_name_on_any_line(self, w, docs):
        assert numbers(w, item="המבורגר") == ["1002"]
        assert numbers(w, item="הפוך") == ["1001"]
        # The user's own % is a character, not a wildcard.
        assert numbers(w, item="%") == []

    def test_by_tender(self, w, docs):
        assert numbers(w, method="card") == ["1002", "1003", "1004"]
        assert numbers(w, method="cash") == ["1001", "1004", "1005"]
        assert numbers(w, method="split") == ["1004"]
        assert numbers(w, method="refunds") == ["1005"]

    def test_by_number_or_amount(self, w, docs):
        assert numbers(w, q="1003") == ["1003"]
        assert numbers(w, q="60") == ["1002"]

    def test_filters_narrow_together(self, w, docs):
        assert numbers(w, method="card", item="המבורגר") == ["1002"]
        assert numbers(w, method="cash", card_last4="7407") == []
