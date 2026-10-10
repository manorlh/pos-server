"""
מבנה אחיד 1.31 — a prepaid / production voucher ("שובר הפקה") paying for goods is D120 field 1306
code 5, "תווי קנייה" (§4.5), not cash.

Every till books a redemption as a `voucher` tender leg (pos-android `PaymentMethod.VOUCHER`); until
this mapping the leg fell through to code 1 and was filed as cash. `production_voucher` is the
contract's tender code for the `payment` accounting mode and files the same way. The document is
still filed exactly as issued: Σ D120 = 1223, and a credit note carries no payment records.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.services.open_format.tax_report_generator import (
    PAYMENT_TYPE_CODES,
    build_d120_record,
    payment_type_code,
    resolve_payment_legs,
)
from test_open_format_131 import _check_document, _doc, _export, d120, records, report, simple, w  # noqa: F401

UTC = timezone.utc
WHEN = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
CASH, CARD, VOUCHERS, EXCHANGE = "1", "3", "5", "6"


@pytest.mark.parametrize(
    "method, code",
    [
        ("voucher", 5),
        (" Voucher ", 5),
        ("vouchers", 5),
        ("production_voucher", 5),
        ("card", 3),
        ("exchange", 6),
        ("cash", 1),
        ("bit", 1),  # unrecognised tenders still land on 1
        (None, 1),
    ],
)
def test_the_payment_type_code(method, code):
    assert payment_type_code(method) == code


def test_the_codes_this_system_files_by_name():
    assert PAYMENT_TYPE_CODES == {"card": 3, "voucher": 5, "vouchers": 5, "production_voucher": 5, "exchange": 6}


def _legs(result):
    return [(d["1306"], d["1312"]) for d in (d120(line) for line in records(result, "D120"))]


class TestTheWorkedExample:
    """₪50 of goods: a ₪40 voucher and ₪10 cash."""

    def test_the_voucher_leg_is_code_5_and_the_cash_leg_code_1(self):
        legs = [{"method": "voucher", "amount": 40.0, "sequence": 1}, {"method": "cash", "amount": 10.0, "sequence": 2}]
        result = report([simple("t", "10000001", WHEN, gross=50.0, method="mixed", payments=legs)])
        assert _legs(result) == [(VOUCHERS, 4000), (CASH, 1000)]
        (head, _rows), = _check_document(result)  # Σ D120 = 1223, exactly
        assert head["1223"] == 5000

    def test_the_contracts_tender_code_files_the_same_way(self):
        legs = [{"method": "production_voucher", "amount": 40.0, "sequence": 1},
                {"method": "card", "amount": 10.0, "sequence": 2, "cardAcquirer": "cal", "cardBrand": "visa",
                 "creditPayments": 1}]
        result = report([simple("t", "10000001", WHEN, gross=50.0, method="mixed", payments=legs)])
        voucher, card = (d120(line) for line in records(result, "D120"))
        assert (voucher["1306"], voucher["1312"], voucher["1313"], voucher["1314"]) == (VOUCHERS, 4000, "0", "")
        assert (card["1306"], card["1312"], card["1313"]) == (CARD, 1000, "2")
        _check_document(result)


class TestAVoucherAlone:
    def test_a_document_the_voucher_settled_whole(self):
        result = report([simple("t", "10000001", WHEN, method="voucher",
                                payments=[{"method": "voucher", "amount": 11.8, "sequence": 1}])])
        assert _legs(result) == [(VOUCHERS, 1180)]
        _check_document(result)

    def test_a_document_with_no_legs_takes_its_summary_tender(self):
        t = simple("t", "10000001", WHEN, method="voucher")
        assert resolve_payment_legs(t) == [(None, None)]
        assert d120(build_d120_record(t, 1, "123456782", 3, "0000001"))["1306"] == VOUCHERS

    def test_the_export_reads_it_off_the_stored_leg(self, w):
        _doc(w, w.tills[0], "1", when=WHEN, payment=("voucher", None, None, None))
        result, _ = _export(w)
        assert _legs(result) == [(VOUCHERS, 1180)]


def test_a_cash_top_up_over_a_cover_voucher():
    """A cover voucher worth ₪30 on ₪41.80 of goods, the ₪11.80 over it in cash."""
    legs = [{"method": "voucher", "amount": 30.0, "sequence": 1}, {"method": "cash", "amount": 11.8, "sequence": 2}]
    result = report([simple("t", "10000001", WHEN, gross=41.8, method="mixed", payments=legs)])
    assert _legs(result) == [(VOUCHERS, 3000), (CASH, 1180)]
    _check_document(result)


def test_a_credit_note_for_a_voucher_sale_has_no_payment_records():
    """A reversed redemption is a 330 against the sale: filed as issued, no D120 under it."""
    legs = [{"method": "voucher", "amount": 11.8, "sequence": 1}]
    sale = simple("s", "10000001", WHEN, method="voucher", payments=legs)
    credit = simple("c", "20000001", WHEN, doc_type=330, refund_of="s", method="voucher", payments=legs)
    result = report([sale, credit])
    assert _legs(result) == [(VOUCHERS, 1180)]
    _check_document(result)


def test_an_exchange_and_a_voucher_on_one_document():
    legs = [{"method": "exchange", "amount": 5.0, "sequence": 1}, {"method": "voucher", "amount": 6.8, "sequence": 2}]
    result = report([simple("t", "10000001", WHEN, method="voucher", payments=legs)])
    assert _legs(result) == [(EXCHANGE, 500), (VOUCHERS, 680)]
    _check_document(result)
