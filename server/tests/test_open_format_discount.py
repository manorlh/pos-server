"""
The C100 money fields on a discounted document.

These pin the two identities the מבנה אחיד spec implies and that an inspector's tooling
can check without knowing anything about the business:

    1219 - |1220| == 1221          (before discount, less the discount, is after)
    1221 + 1222   == 1223          (net plus VAT is the total paid)

Both used to fail on every discounted document. All three of 1221/1222/1223 were written
as the *pre-discount* gross, so a ₪12.00 basket sold for ₪10.00 declared ₪1.83 of VAT
instead of ₪1.53 and ₪12.00 of turnover instead of ₪10.00 — the business over-reporting
its own output VAT — while the record contradicted itself.

Field positions come from the spec's C100 table (section 4.3): the record is fixed-width,
so each field is sliced out of the built string by its documented columns.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.services.open_format.tax_report_generator import (
    build_c100_record,
    build_d120_record,
    resolve_payment_legs,
)
from app.services.tax_reports import _build_cart_from_items

NOW = datetime(2026, 9, 7, 20, 0, 0, tzinfo=timezone.utc)

# C100 columns (1-based, inclusive) straight from the spec's table.
_FIELDS = {
    1219: (288, 302),
    1220: (303, 317),
    1221: (318, 332),
    1222: (333, 347),
    1223: (348, 362),
}


def _amount(record: str, field: int) -> float:
    """One signed 15-char amount field, as shekels."""
    start, end = _FIELDS[field]
    raw = record[start - 1 : end]
    sign = -1 if raw[0] == "-" else 1
    return sign * int(raw[1:]) / 100.0


class _Item:
    def __init__(self, total_price, unit_price=None, discount=None):
        self.id = "i1"
        self.product_id = None
        self.sku = "s"
        self.product_name = "p"
        self.quantity = 1
        self.unit_price = unit_price if unit_price is not None else total_price
        self.total_price = total_price
        self.discount = discount
        self.line_discount = None
        self.transaction_type = 2


class _Tx:
    """Only the attributes the cart builder reads."""

    def __init__(self, items, document_discount=None, net=None, vat=None, document_type=320):
        self.items = items
        self.document_discount = document_discount
        self.net_amount = net
        self.vat_amount = vat
        self.document_type = document_type
        self.refund_of_transaction_id = None


def _record(tx, *, payments=None, rate=18.0):
    cart = _build_cart_from_items(tx, rate)
    transaction = {
        "id": "t1",
        "transactionNumber": "2",
        "documentType": tx.document_type,
        "documentProductionDate": NOW.isoformat(),
        "createdAt": NOW.isoformat(),
        "documentDiscount": float(tx.document_discount or 0),
        "whtDeduction": 0,
        "paymentMethod": "cash",
        "cashier": {"name": "A"},
        "customer": {"name": "לקוח כללי"},
        "payments": payments or [],
        "cart": cart,
    }
    record = build_c100_record(transaction, "514398984", 1, "0000001", global_tax_rate=rate)
    # The spec fixes C100 at 444 characters; a shifted record would make every field
    # slice below read the wrong columns and quietly pass.
    assert len(record) == 444
    return transaction, record


# ── The real sale that exposed this ──────────────────────────────────────────

class TestDiscountedDocument:
    """₪12.00 basket, ₪2.00 basket discount, ₪10.00 paid, receipt showed 8.47 + 1.53."""

    def _sale(self):
        return _Tx([_Item("12.00")], document_discount="2.00", net="8.47", vat="1.53")

    def test_vat_is_what_was_collected_not_what_the_gross_implies(self):
        _tx, rec = self._record_for_sale()

        assert _amount(rec, 1222) == 1.53
        # What the old code wrote: VAT extracted from the undiscounted 12.00.
        assert _amount(rec, 1222) != 1.83

    def test_the_total_is_what_the_customer_paid(self):
        _tx, rec = self._record_for_sale()

        assert _amount(rec, 1223) == 10.00
        assert _amount(rec, 1223) != 12.00

    def test_net_plus_vat_equals_the_total(self):
        _tx, rec = self._record_for_sale()

        assert round(_amount(rec, 1221) + _amount(rec, 1222), 2) == _amount(rec, 1223)

    def test_before_discount_less_the_discount_equals_after(self):
        _tx, rec = self._record_for_sale()

        assert round(_amount(rec, 1219) + _amount(rec, 1220), 2) == _amount(rec, 1221)

    def test_the_discount_is_negative(self):
        """הבהרה 5: a discount reduces the document amount, so it is written with a minus."""
        _tx, rec = self._record_for_sale()

        assert _amount(rec, 1220) < 0

    def _record_for_sale(self):
        return _record(self._sale())


# ── The undiscounted case must not move ──────────────────────────────────────

class TestUndiscountedDocumentIsUnchanged:
    def test_all_three_identities_hold_with_no_discount(self):
        tx = _Tx([_Item("118.00")], net="100.00", vat="18.00")
        _t, rec = _record(tx)

        assert _amount(rec, 1219) == 100.00
        assert _amount(rec, 1220) == 0.0
        assert _amount(rec, 1221) == 100.00
        assert _amount(rec, 1222) == 18.00
        assert _amount(rec, 1223) == 118.00

    def test_a_legacy_document_without_a_stored_split_still_reconciles(self):
        """Derived, but from the settled amount rather than from the gross."""
        tx = _Tx([_Item("12.00")], document_discount="2.00")
        _t, rec = _record(tx)

        assert _amount(rec, 1223) == 10.00
        assert round(_amount(rec, 1221) + _amount(rec, 1222), 2) == 10.00
        assert _amount(rec, 1222) == 1.53


# ── Credit notes ─────────────────────────────────────────────────────────────

class TestCreditNote:
    def test_a_credit_note_is_not_discounted_twice(self):
        """
        A credit note's line totals are already net of the apportioned discount, so
        subtracting the document discount again would credit back money never refunded.
        """
        tx = _Tx([_Item("10.00")], document_discount="2.00", document_type=330)
        _t, rec = _record(tx)

        assert _amount(rec, 1223) == 10.00
        assert round(_amount(rec, 1221) + _amount(rec, 1222), 2) == 10.00


# ── D120 must sum to C100's 1223 ─────────────────────────────────────────────

class TestPaymentRecordsSumToTheDocument:
    def test_a_split_tender_document_pays_out_to_the_settled_total(self):
        tx = _Tx([_Item("12.00")], document_discount="2.00", net="8.47", vat="1.53")
        payments = [
            {"method": "cash", "amount": 4.00, "sequence": 1},
            {"method": "card", "amount": 6.00, "sequence": 2},
        ]
        transaction, rec = _record(tx, payments=payments)

        legs = resolve_payment_legs(transaction)
        total = sum(amount for _method, amount in legs)

        assert round(total, 2) == _amount(rec, 1223) == 10.00

    def test_a_single_tender_document_carries_the_settled_total(self):
        tx = _Tx([_Item("12.00")], document_discount="2.00", net="8.47", vat="1.53")
        transaction, rec = _record(tx)

        d120 = build_d120_record(transaction, 1, "514398984", 1, "0000001")
        # D120 field 1312 (סכום השורה): columns 104-118, sign then 14 digits.
        raw = d120[103:118]
        paid = (-1 if raw[0] == "-" else 1) * int(raw[1:]) / 100.0

        assert paid == _amount(rec, 1223) == 10.00


class TestWhereTheRoundingLands:
    """
    Both identities cannot always hold *and* every field independently match a direct
    division — the agora has to go somewhere.

    On the real ₪12.00/₪2.00 sale, dividing the gross gives 10.17 while 1221 + the
    discount gives 10.16. If 1219 were written as 10.17, then 1219 - |1220| would be
    8.48 against a 1221 of 8.47 and the record would contradict itself by an agora.

    So the remainder is absorbed by 1219, deliberately. It is the only one of the five
    that describes no money that moved: 1221, 1222 and 1223 are the net, the VAT and the
    amount the customer paid, all of which appear on the receipt and in the return.
    """

    def test_the_remainder_lands_on_1219_and_not_on_vat_or_the_total(self):
        tx = _Tx([_Item("12.00")], document_discount="2.00", net="8.47", vat="1.53")
        _t, rec = _record(tx)

        # Dividing the gross directly would say 10.17; the chain requires 10.16.
        assert _amount(rec, 1219) == 10.16
        assert round(_amount(rec, 1219) + _amount(rec, 1220), 2) == _amount(rec, 1221)

        # The figures that matter are untouched by that choice.
        assert _amount(rec, 1221) == 8.47
        assert _amount(rec, 1222) == 1.53
        assert _amount(rec, 1223) == 10.00
