"""
The §4.3 reports (docs/ACCOUNTING_EXPORT_AND_REPORTS.md): payment methods, hour of day,
department, document sequence, cash variance.

What each must not get wrong: the money is the per-cashier report's (a credit note
subtracts, a cancelled document counts nowhere — except in the document sequence, where a
cancelled document still used its number); local time is Israel's, not UTC; and the
scope is the caller's.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.category import Category
from app.models.product import Product
from app.models.shift import ShiftStatus
from app.models.transaction import TransactionStatus
from app.models.transaction_item import TransactionItem
from app.routers import reports as reports_router
from app.routers import sales_reports as router
from app.services.extra_reports import find_gaps
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, w  # noqa: F401

RANGE = dict(from_date=TODAY, to_date=TODAY, tz="Asia/Jerusalem")


@pytest.fixture
def trading(w):
    t1, t2 = w.tills
    s1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
    w.doc(t1, s1, "100.00", discount="10.00", number="1")
    w.doc(t1, s1, "40.00", method="card", number="2")
    w.doc(t1, s1, "20.00", credit_note=True, number="5")
    w.doc(t1, s1, "999.00", status=TransactionStatus.CANCELLED, number="6")
    s2 = w.shift(t2, 1, status=ShiftStatus.OPEN)
    w.doc(t2, s2, "33.33", legs=[("cash", "13.33"), ("voucher", "20.00")], number="1")
    w.doc(w.other_till, w.shift(w.other_till, 1, status=ShiftStatus.OPEN), "50.00", number="1")
    w.db.commit()


def cashier_net(w, user=None, shop=None):
    return reports_router.get_cashier_sales_report(
        from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
        shop_id=shop.id if shop else None, machine_id=None, area_id=None, **_ctx(w, user),
    ).totals.net


class TestPaymentMethods:
    def test_net_per_method_adds_up_to_the_cashier_report(self, w, trading):
        out = router.get_payment_methods_report(
            **RANGE, from_hour=None, to_hour=None, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w)
        )
        by = {t.method: t.amount for t in out.totals}
        # cash: 90 − 20 (credit note) + 13.33 + 50; card 40; voucher 20.
        assert by == {"cash": 133.33, "card": 40.0, "voucher": 20.0}
        assert out.total == round(cashier_net(w), 2) == 193.33
        assert {t.bucket for t in out.totals if t.method == "voucher"} == {"other"}
        assert all(r.day == TODAY for r in out.rows)
        assert sum(t.share for t in out.totals) == pytest.approx(100, abs=0.05)

    def test_a_shop_manager_sees_their_shop_only(self, w, trading):
        out = router.get_payment_methods_report(
            **RANGE, from_hour=None, to_hour=None, shop_id=None, machine_id=None, cashier_id=None,
            **_ctx(w, w.manager),
        )
        assert out.total == 143.33
        assert {r.shop_id for r in out.rows} == {w.shop.id}


class TestHourly:
    def test_documents_land_on_the_israeli_hour_and_weekday(self, w, trading):
        out = router.get_hourly_report(**RANGE, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w))
        # NOW is 2026-09-27 18:00 UTC = 21:00 in Jerusalem (IDT), a Sunday.
        (cell,) = out.cells
        assert (cell.weekday, cell.hour) == (0, 21)
        assert cell.net == out.total == 193.33
        assert cell.documents == 5
        (row,) = out.by_hour
        # 4 sales, the credit note is not a basket.
        assert row.average_basket == round(193.33 / 4, 2)


class TestDepartments:
    def test_lines_roll_up_to_their_category_with_a_share(self, w):
        drinks = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Drinks")
        food = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Food")
        w.db.add_all([drinks, food])
        w.db.flush()
        cola = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Cola",
                       sku="C1", price=Decimal("10"), category_id=drinks.id)
        toast = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Toast",
                        sku="T1", price=Decimal("30"), category_id=food.id)
        w.db.add_all([cola, toast])
        w.db.flush()
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        def line(tx, product, qty, total, discount="0"):
            w.db.add(TransactionItem(
                id=uuid.uuid4(), transaction_id=tx.id, product_id=product.id, product_name=product.name,
                sku=product.sku, quantity=Decimal(qty), unit_price=Decimal(total) / Decimal(qty),
                total_price=Decimal(total), discount=Decimal(discount),
            ))

        sale = w.doc(till, shift, "90.00", discount="10.00")
        line(sale, cola, "3", "30.00")
        line(sale, toast, "2", "60.00", discount="10.00")
        refund = w.doc(till, shift, "10.00", credit_note=True)
        line(refund, cola, "1", "10.00")
        w.db.commit()

        out = router.get_department_report(
            **RANGE, from_hour=None, to_hour=None, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w)
        )
        by = {r.category_name: r for r in out.rows}
        assert (by["Food"].net, by["Food"].units) == (50.0, 2.0)
        assert (by["Drinks"].net, by["Drinks"].units, by["Drinks"].refunds) == (20.0, 2.0, 10.0)
        assert out.totals.net == 70.0
        assert by["Food"].share == round(50 / 70 * 100, 2)
        assert [r.category_name for r in out.rows] == ["Food", "Drinks"]


class TestDocumentSequence:
    def test_find_gaps(self):
        gaps, dups, non_numeric = find_gaps(["1", "2", "5", "5", "9", "A-3"])
        assert gaps == [(3, 4), (6, 8)]
        assert dups == ["5"]
        assert non_numeric == 1

    def test_a_cancelled_number_is_issued_and_the_gap_is_3_to_4(self, w, trading):
        out = router.get_document_sequence_report(**RANGE, shop_id=w.shop.id, machine_id=None, **_ctx(w))
        till1 = {r.document_type: r for r in out.rows if r.machine_id == w.tills[0].id}
        # Sales 320: 1, 2, 6 (the cancelled one) → 3–5 missing; 5 is the credit note's (330).
        assert [(g.from_number, g.to_number) for g in till1[320].gaps] == [(3, 5)]
        assert till1[320].missing == 3
        assert till1[330].missing == 0
        assert out.total_missing == 3


class TestCashVariance:
    def test_per_shift_and_per_cashier_with_uncounted_left_out(self, w):
        t1, t2 = w.tills
        a = w.shift(t1, 1, counted_cash="95.00")
        a.expected_cash, a.discrepancy, a.closed_by = Decimal("100.00"), Decimal("-5.00"), "Dana"
        b = w.shift(t1, 2, counted_cash="112.00")
        b.expected_cash, b.discrepancy, b.closed_by = Decimal("110.00"), Decimal("2.00"), "Dana"
        c = w.shift(t2, 1)
        c.expected_cash, c.closed_by = Decimal("50.00"), "Avi"
        w.shift(t1, 3, status=ShiftStatus.OPEN)  # open: not in it
        old = w.shift(t2, 2, counted_cash="1.00", business_date=TODAY - timedelta(days=40))
        old.discrepancy = Decimal("-99")
        w.db.commit()

        out = router.get_cash_variance_report(**RANGE, shop_id=None, machine_id=None, **_ctx(w))
        assert sorted(s.variance for s in out.shifts if s.variance is not None) == [-5.0, 2.0]
        assert len(out.shifts) == 3
        assert out.total_variance == -3.0 and out.uncounted == 1
        dana = next(r for r in out.by_cashier if r.cashier == "Dana")
        assert (dana.shifts, dana.over, dana.short, dana.net) == (2, 2.0, -5.0, -3.0)

        mine = router.get_cash_variance_report(**RANGE, shop_id=None, machine_id=None, **_ctx(w, w.north_manager))
        assert mine.shifts == []
