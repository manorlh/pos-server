"""
A credit note's tip in the cloud's tips (P:/specs/table-restore-payments.md §3): a table's payment
reversed with its tip gives the tip back — the tips report, the tips range report, the cashier
report and the X / Z figures take it negative, as the till's X and the Z's sections do.

The table's story: a card payment of ₪180 with a ₪10 card tip, credited in full (its tip with it),
then paid again in cash with a ₪10 cash tip. The tips are ₪10 — cash, none on the card.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from unittest.mock import patch

import pytest

from app.models.shift import ShiftStatus
from app.routers import reports as reports_router
from app.routers import sales_reports as router
from app.services.shift_totals import compute_totals
from app.services.tips import build_tips_report
from shift_world import TODAY
from test_shop_areas import _ctx, w  # noqa: F401

RANGE = dict(from_date=TODAY, to_date=TODAY, tz="Asia/Jerusalem")
HOURS = dict(from_hour=None, to_hour=None)


@pytest.fixture
def reversed_table(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    sale = w.doc(till, shift, "180.00", method="card", tip="10.00", tip_method="card", number="1")
    credit = w.doc(till, shift, "180.00", method="card", tip="10.00", tip_method="card", number="2", credit_note=True)
    credit.refund_of_transaction_id = sale.id
    again = w.doc(till, shift, "180.00", method="cash", tip="10.00", tip_method="cash", number="3")
    dana = str(uuid.uuid4())
    for doc in (sale, credit, again):
        doc.cashier_id = dana
    w.db.commit()
    return dict(shift=shift, sale=sale, credit=credit, again=again)


def test_the_x_and_z_figures_take_the_credits_tip_back(w, reversed_table):
    totals = compute_totals(w.db, [reversed_table["shift"].id])
    assert (totals.total_tips, totals.total_cash_tips, totals.total_card_tips) == (
        Decimal("10.00"), Decimal("10.00"), Decimal("0.00"),
    )
    # The takings net per tender as before.
    assert totals.total_card == Decimal("0") and totals.total_cash == Decimal("180")


@patch("app.services.tips.merge_all_settings_layers", return_value={"tipDistribution": "direct"})
def test_the_tips_report_subtracts_the_credit_notes_tip_and_sale(_merge, w, reversed_table):
    report = build_tips_report(w.db, w.shop, shift_id=reversed_table["shift"].id)
    assert (report.total_tips, report.total_cash_tips, report.total_card_tips) == (
        Decimal("10.00"), Decimal("10.00"), Decimal("0.00"),
    )
    assert report.total_sales == Decimal("180.00")
    (dana,) = report.cashiers
    assert dana.tips_collected == Decimal("10.00") and dana.amount_owed == Decimal("10.00")
    assert (dana.cash_tips, dana.card_tips) == (Decimal("10.00"), Decimal("0.00"))


def test_the_tips_range_report_subtracts_it_in_every_breakdown(w, reversed_table):
    out = reports_router.get_tips_range_report(
        **RANGE, **HOURS, shop_id=None, machine_id=None, area_id=None, **_ctx(w),
    )
    assert (out.tips_total, out.tips_cash, out.tips_card, out.tips_other) == (10.0, 10.0, 0.0, 0.0)
    # Documents with a tip: the two sales (the credit gave one back).
    assert out.tipped_document_count == 2
    for rows in (out.by_day, out.by_machine, out.by_shift):
        assert sum(r.tips_total for r in rows) == pytest.approx(10.0)
        assert sum(r.tips_card for r in rows) == pytest.approx(0.0)
    (cashier,) = out.by_cashier
    assert cashier.tips_total == 10.0 and cashier.tips_card == 0.0


def test_the_payment_methods_and_cashier_reports_too(w, reversed_table):
    methods = router.get_payment_methods_report(
        **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w),
    )
    tips = {t.method: (t.amount, t.documents) for t in methods.tips}
    assert tips["card"] == (0.0, 1) and tips["cash"] == (10.0, 1)
    assert methods.tips_total == 10.0
    cashiers = reports_router.get_cashier_sales_report(
        **RANGE, **HOURS, shop_id=None, machine_id=None, area_id=None, **_ctx(w),
    )
    (row,) = cashiers.rows
    assert (row.tips, row.tips_cash, row.tips_card) == (10.0, 10.0, 0.0)
