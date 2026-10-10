"""
"שוברי הפקה" — a production voucher paying for goods is a tender of its own on the server, never
"other" and never cash (the production vouchers contract §4.2):

* `normalize_tender` — `voucher` (today's tills), `vouchers` and `production_voucher` (the
  contract's code) are one bucket, `production_voucher`;
* the cashier and area reports carry it (`productionVoucherNet` / `productionVoucher`) and the
  tender split still adds up to the net;
* a tip on a voucher-paid document is "other" (a voucher never pays a tip) — no KeyError;
* the transactions export has its column; the Z document prints "שוברי הפקה"; the journal books
  it as a voucher; a document copy names the leg "שובר הפקה"; the transactions list's "voucher"
  filter finds every code.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.routers import reports as reports_router
from app.services import tenders
from app.services.accounting import journal
from app.services.print_documents import TENDER_LABELS, tender_label
from app.services.z_print import _payment_buckets
from shift_world import TODAY
from test_shop_areas import _ctx, w  # noqa: F401


@pytest.mark.parametrize("method, bucket", [
    ("voucher", "production_voucher"),
    (" Voucher ", "production_voucher"),
    ("vouchers", "production_voucher"),
    ("production_voucher", "production_voucher"),
    ("cash", "cash"),
    ("card", "card"),
    ("exchange", "exchange"),
    ("bit", "other"),
    (None, "other"),
])
def test_the_bucket(method, bucket):
    assert tenders.normalize_tender(method) == bucket
    assert tenders.is_production_voucher(method) is (bucket == "production_voucher")


@pytest.fixture
def sales(w):
    t1, t2 = w.tills
    s1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
    # ₪50 of goods: a ₪40 voucher and ₪10 cash (the owner's worked example).
    w.doc(t1, s1, "50.00", method="mixed", legs=[("voucher", "40.00"), ("cash", "10.00")], number="1")
    # A newer till's code, alone.
    w.doc(t1, s1, "30.00", method="production_voucher", number="2")
    s2 = w.shift(t2, 1, status=ShiftStatus.OPEN)
    w.doc(t2, s2, "20.00", method="card", number="1")
    # A voucher-paid document whose tip names no tender.
    w.doc(t2, s2, "12.00", method="voucher", tip="3.00", number="2")
    w.db.commit()


def report_args(**extra):
    base = dict(from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
                machine_id=None)
    base.update(extra)
    return base


class TestReports:
    def test_the_cashier_report(self, w, sales):
        out = reports_router.get_cashier_sales_report(**report_args(area_id=None), **_ctx(w))
        t = out.totals
        assert (t.cash_net, t.card_net, t.production_voucher_net, t.other_net) == (10.0, 20.0, 82.0, 0.0)
        assert round(t.cash_net + t.card_net + t.production_voucher_net + t.other_net + t.exchange_net, 2) == round(t.net, 2)
        assert out.model_dump(by_alias=True)["totals"]["productionVoucherNet"] == 82.0

    def test_the_area_report(self, w, sales):
        out = reports_router.get_sales_by_area_report(
            shop_id=w.shop.id, date_from=TODAY, date_to=TODAY, from_date=None, to_date=None, from_hour=None,
            to_hour=None, tz="Asia/Jerusalem", **_ctx(w),
        )
        assert (out.totals.production_voucher, out.totals.cash, out.totals.other) == (82.0, 10.0, 0.0)
        assert out.model_dump(by_alias=True)["totals"]["productionVoucher"] == 82.0

    def test_a_tip_on_a_voucher_paid_document_is_other(self, w, sales):
        out = reports_router.get_tips_range_report(**report_args(area_id=None), **_ctx(w))
        assert (out.tips_total, out.tips_other, out.tips_cash, out.tips_card) == (3.0, 3.0, 0.0, 0.0)


def test_the_transactions_export_has_its_column(w, sales):
    from app.models.transaction import Transaction
    from app.services import transactions_export as TE

    rows = TE.export_rows(w.db, w.db.query(Transaction).all())
    mixed = next(r for r in rows if r["paymentMethod"] == "mixed")
    assert (mixed["cash"], mixed["productionVoucher"], mixed["other"]) == ("10.00", "40.00", "0.00")
    alone = next(r for r in rows if r["paymentMethod"] == "production_voucher")
    assert (alone["productionVoucher"], alone["other"]) == ("30.00", "0.00")


def test_the_z_document_prints_it():
    b = _payment_buckets({"cash": "10.00", "voucher": "40.00", "production_voucher": "30.00", "bit": "5.00"})
    assert (b["cash"], b["voucher"], b["other"]) == (Decimal("10.00"), Decimal("70.00"), Decimal("5.00"))


def test_the_journal_books_it_as_a_voucher():
    assert {"voucher", "vouchers", "production_voucher"} <= journal.VOUCHER_METHODS


def test_a_document_copy_names_the_leg():
    assert TENDER_LABELS["production_voucher"] == TENDER_LABELS["voucher"] == "שובר הפקה"
    assert tender_label("production_voucher") == "שובר הפקה"
