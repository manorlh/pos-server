"""
Tips in the sales reports, and the filters the reports framework sends
(specs/reports-upgrade.md §2ה, §4.1–§4.2).

A tip is never a tender leg: it is shown apart — per tip tender in the payment-methods
report, per hour, per cashier and area (cash / card / other), per day, till and shift in
the tips report — and never inside a method's takings or a product's / department's money.
`cashierId`, `areaId` and `companyId` narrow every report the dashboard filters.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.category import Category
from app.models.company import Company
from app.models.product import Product
from app.models.shift import ShiftStatus
from app.models.transaction_item import TransactionItem
from app.routers import reports as reports_router
from app.routers import sales_reports as router
from app.services import reports as R
from shift_world import TODAY
from test_shop_areas import _ctx, create, members, open_shift, w  # noqa: F401

RANGE = dict(from_date=TODAY, to_date=TODAY, tz="Asia/Jerusalem")
HOURS = dict(from_hour=None, to_hour=None)


@pytest.fixture
def tipped(w):
    """Two tills of the shop and one of the other shop, with tips on several tenders."""
    t1, t2 = w.tills
    s1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
    s2 = w.shift(t2, 1, status=ShiftStatus.OPEN)
    a = w.doc(t1, s1, "100.00", tip="10.00", tip_method="card", number="1")
    a.cashier_id = "dana"
    b = w.doc(t1, s1, "50.00", tip="5.00", tip_method="cash", number="2")
    b.cashier_id = "dana"
    c = w.doc(t2, s2, "40.00", method="card", tip="4.00", number="1")  # rides on the card
    c.cashier_id = "yossi"
    d = w.doc(t2, s2, "30.00", legs=[("cash", "10.00"), ("card", "20.00")], tip="3.00", number="2")
    d.payment_method = "mixed"  # split tender, no tip tender: "other"
    d.cashier_id = "yossi"
    e = w.doc(w.other_till, None, "20.00", tip="2.00", tip_method="cash", number="1")  # no shift
    e.cashier_id = "dana"
    w.db.commit()
    return dict(s1=s1, s2=s2)


class TestPaymentMethodsTips:
    def test_tips_are_a_section_of_their_own_never_inside_a_method(self, w, tipped):
        out = router.get_payment_methods_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w)
        )
        # Takings only: 100 + 50 + 20 cash-or-card legs, no tip in them.
        by = {t.method: t.amount for t in out.totals}
        assert by == {"cash": 180.0, "card": 60.0}
        assert out.total == 240.0
        tips = [(t.method, t.amount, t.documents) for t in out.tips]
        assert tips == [("cash", 7.0, 2), ("card", 14.0, 2), ("other", 3.0, 1)]
        assert out.tips_total == 24.0
        body = out.model_dump(by_alias=True)
        assert body["tipsTotal"] == 24.0 and body["tips"][0]["method"] == "cash"

    def test_the_filters_narrow_the_tips_too(self, w, tipped):
        out = router.get_payment_methods_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id="yossi", **_ctx(w)
        )
        assert out.total == 70.0
        assert out.tips_total == 7.0

    def test_no_access_is_an_empty_report_with_three_tip_rows(self, w, tipped):
        from app.models.user import User, UserRole

        nobody = User(id=uuid.uuid4(), role=UserRole.CASHIER, shop_id=None, tenant_id=w.tenant.id)
        out = router.get_payment_methods_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w, nobody)
        )
        assert out.rows == [] and out.tips_total == 0.0
        assert [t.method for t in out.tips] == ["cash", "card", "other"]


class TestHourlyTips:
    def test_tips_per_cell_and_hour_apart_from_the_net(self, w, tipped):
        out = router.get_hourly_report(**RANGE, shop_id=None, machine_id=None, cashier_id=None, **_ctx(w))
        (cell,) = out.cells
        assert cell.net == out.total == 240.0
        assert cell.tips == out.tips_total == 24.0
        (row,) = out.by_hour
        assert row.tips == 24.0
        assert out.model_dump(by_alias=True)["tipsTotal"] == 24.0

    def test_a_cashier_narrows_the_hourly_report(self, w, tipped):
        out = router.get_hourly_report(**RANGE, shop_id=None, machine_id=None, cashier_id="dana", **_ctx(w))
        assert (out.total, out.tips_total) == (170.0, 17.0)


class TestCashierAndAreaTips:
    def test_each_cashiers_tips_are_split_by_tender_and_add_up(self, w, tipped):
        out = reports_router.get_cashier_sales_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, area_id=None, **_ctx(w)
        )
        by = {r.cashier_id: r for r in out.rows}
        assert (by["dana"].tips, by["dana"].tips_cash, by["dana"].tips_card, by["dana"].tips_other) == (17.0, 7.0, 10.0, 0.0)
        assert (by["yossi"].tips, by["yossi"].tips_cash, by["yossi"].tips_card, by["yossi"].tips_other) == (7.0, 0.0, 4.0, 3.0)
        t = out.totals
        assert (t.tips, t.tips_cash, t.tips_card, t.tips_other) == (24.0, 7.0, 14.0, 3.0)
        # Tips are not takings: the tender split still adds up to the net.
        assert t.cash_net + t.card_net + t.other_net + t.exchange_net + t.production_voucher_net == pytest.approx(t.net)
        row = out.model_dump(by_alias=True)["rows"][0]
        assert {"tips", "tipsCash", "tipsCard", "tipsOther"} <= set(row)

    def test_the_cashier_report_takes_a_cashier_and_a_company(self, w, tipped):
        out = reports_router.get_cashier_sales_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, area_id=None, cashier_id="yossi", **_ctx(w)
        )
        assert [r.cashier_id for r in out.rows] == ["yossi"]
        out = reports_router.get_cashier_sales_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, area_id=None, company_id=uuid.uuid4(), **_ctx(w)
        )
        assert out.rows == []

    def test_an_areas_tips_are_split_too(self, w, tipped):
        out = reports_router.get_sales_by_area_report(
            shop_id=w.shop.id, date_from=TODAY, date_to=TODAY, from_date=None, to_date=None,
            **HOURS, tz="Asia/Jerusalem", **_ctx(w),
        )
        t = out.totals
        assert (t.tips, t.tips_cash, t.tips_card, t.tips_other) == (22.0, 5.0, 14.0, 3.0)


class TestTipsReportBreakdowns:
    def tips(self, w, **kw):
        args = dict(shop_id=None, machine_id=None, area_id=None)
        args.update(kw)
        return reports_router.get_tips_range_report(**RANGE, **HOURS, **args, **_ctx(w))

    def test_per_day_till_and_shift_each_add_up_to_the_totals(self, w, tipped):
        out = self.tips(w)
        assert (out.tips_total, out.tips_cash, out.tips_card, out.tips_other) == (24.0, 7.0, 14.0, 3.0)
        assert out.tipped_document_count == 5
        assert out.sales_net == 240.0
        for rows in (out.by_day, out.by_machine, out.by_shift):
            assert sum(r.tips_total for r in rows) == pytest.approx(out.tips_total)
            assert sum(r.tips_cash for r in rows) == pytest.approx(out.tips_cash)
            assert sum(r.tips_card for r in rows) == pytest.approx(out.tips_card)
            assert sum(r.tips_other for r in rows) == pytest.approx(out.tips_other)
            assert sum(r.tipped_document_count for r in rows) == out.tipped_document_count
            assert sum(r.sales_net for r in rows) == pytest.approx(out.sales_net)

        (day,) = out.by_day
        assert day.day == TODAY and day.tips_total == 24.0

        by_till = {r.machine_name: r for r in out.by_machine}
        assert by_till["Till 1"].tips_total == 15.0 and by_till["Till 1"].shop_name == "Center"
        assert by_till["Till 2"].tips_other == 3.0
        assert by_till["North 1"].pos_number == w.other_till.pos_number

        by_shift = {r.shift_id: r for r in out.by_shift}
        assert by_shift[tipped["s1"].id].tips_total == 15.0
        assert by_shift[tipped["s1"].id].machine_name == "Till 1"
        assert by_shift[tipped["s1"].id].business_date == TODAY
        # The document with no shift is a row of its own, listed last.
        assert out.by_shift[-1].shift_id is None and out.by_shift[-1].tips_total == 2.0
        assert out.by_shift_truncated is False

        body = out.model_dump(by_alias=True)
        assert {"byDay", "byMachine", "byShift", "byShiftTruncated", "tippedDocumentCount", "salesNet"} <= set(body)
        assert {"shiftId", "openedAt", "posNumber", "tipsCash"} <= set(body["byShift"][0])

    def test_a_cashier_and_a_company_narrow_the_tips_report(self, w, tipped):
        assert self.tips(w, cashier_id="dana").tips_total == 17.0
        sub = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="North Ltd", vat_number="2",
                      parent_company_id=w.company.id)
        w.db.add(sub)
        w.db.flush()
        w.other_shop.company_id = sub.id
        w.db.commit()
        assert self.tips(w, company_id=sub.id).tips_total == 2.0
        assert self.tips(w, company_id=w.company.id).tips_total == 24.0
        assert self.tips(w, company_id=uuid.uuid4()).tips_total == 0.0


class TestTipBucket:
    def test_the_tip_tender_rule(self):
        assert R.tip_bucket("cash", "card") == "cash"
        assert R.tip_bucket(None, "card") == "card"
        assert R.tip_bucket(None, "mixed") == "other"
        assert R.tip_bucket(None, "exchange") == "other"
        assert R.tip_bucket(None, "voucher") == "other"
        assert R.tip_bucket(None, None) == "other"


class TestDaySummaryContributorTips:
    def test_a_contributor_carries_its_cash_and_card_tips(self):
        from test_day_summary import _Z

        legacy = R._contributors_of(_Z())[0]
        assert (legacy.tips, legacy.cash_tips, legacy.card_tips) == (5.0, 2.0, 3.0)
        cloud = _Z(per_machine=[{
            "machineId": str(uuid.uuid4()), "machineName": "Till 1", "totalSales": "10.00",
            "totalRefunds": "0.00", "totalTips": "6.00", "totalCashTips": "1.50", "totalCardTips": "4.50",
        }])
        section = R._contributors_of(cloud)[0]
        assert (section.tips, section.cash_tips, section.card_tips) == (6.0, 1.5, 4.5)
        assert {"cashTips", "cardTips"} <= set(section.model_dump(by_alias=True))


# ── Filters the framework sends ──────────────────────────────────────────────


@pytest.fixture
def lines(w):
    """Cola sold at the bar (Till 1) by Dana, toast elsewhere (Till 2) by Yossi."""
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
    t1, t2 = w.tills
    bar = create(w, "Bar")
    members(w, bar["id"], t1)

    def sale(till, product, qty, total, cashier):
        tx = w.doc(till, open_shift(w, till, 1), total, tip="1.00")
        tx.cashier_id = cashier
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_id=product.id, product_name=product.name,
            sku=product.sku, quantity=Decimal(qty), unit_price=Decimal(total) / Decimal(qty),
            total_price=Decimal(total), discount=Decimal("0"),
        ))

    sale(t1, cola, "3", "30.00", "dana")
    sale(t2, toast, "1", "30.00", "yossi")
    w.db.commit()
    return dict(bar=bar["id"])


class TestFilters:
    def departments(self, w, **kw):
        args = dict(shop_id=None, machine_id=None, cashier_id=None)
        args.update(kw)
        return router.get_department_report(**RANGE, **HOURS, **args, **_ctx(w))

    def products(self, w, **kw):
        args = dict(shop_id=None, machine_id=None, cashier_id=None, limit=100, area_id=None, meals="components")
        args.update(kw)
        return reports_router.get_product_sales_report(**RANGE, **HOURS, **args, **_ctx(w))

    def test_departments_take_an_area_a_cashier_and_a_company(self, w, lines):
        assert {r.category_name for r in self.departments(w).rows} == {"Drinks", "Food"}
        assert [r.category_name for r in self.departments(w, area_id=str(lines["bar"])).rows] == ["Drinks"]
        assert [r.category_name for r in self.departments(w, area_id="none").rows] == ["Food"]
        assert [r.category_name for r in self.departments(w, cashier_id="yossi").rows] == ["Food"]
        assert self.departments(w, company_id=uuid.uuid4()).rows == []
        assert self.departments(w, company_id=w.company.id).totals.net == 60.0

    def test_departments_and_products_carry_no_tips(self, w, lines):
        assert "tips" not in self.departments(w).model_dump(by_alias=True)["totals"]
        assert "tips" not in self.products(w).model_dump(by_alias=True)["totals"]

    def test_a_bad_area_is_a_422(self, w, lines):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as e:
            self.departments(w, area_id="nope")
        assert e.value.status_code == 422

    def test_products_take_a_cashier_an_area_and_a_company(self, w, lines):
        assert [r.product_name for r in self.products(w, cashier_id="dana").rows] == ["Cola"]
        assert [r.product_name for r in self.products(w, area_id=str(lines["bar"])).rows] == ["Cola"]
        assert self.products(w, company_id=uuid.uuid4()).rows == []
        assert self.products(w, company_id=w.company.id).totals.net == 60.0

    def test_hourly_takes_a_cashier_and_an_area(self, w, lines):
        def hourly(**kw):
            args = dict(shop_id=None, machine_id=None, cashier_id=None)
            args.update(kw)
            return router.get_hourly_report(**RANGE, **args, **_ctx(w))

        assert hourly(cashier_id="dana").total == 30.0
        assert hourly(area_id=str(lines["bar"])).total == 30.0
        assert hourly(area_id="none").tips_total == 1.0

    def test_payment_methods_and_card_brands_take_an_area_and_a_company(self, w, lines):
        out = router.get_payment_methods_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, area_id=str(lines["bar"]), **_ctx(w)
        )
        assert (out.total, out.tips_total) == (30.0, 1.0)
        out = router.get_payment_methods_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, company_id=uuid.uuid4(), **_ctx(w)
        )
        assert out.total == 0
        brands = router.get_card_brands_report(
            **RANGE, **HOURS, shop_id=None, machine_id=None, cashier_id=None, area_id="none", **_ctx(w)
        )
        assert brands.net == 0  # cash only

    def test_the_new_query_parameters_are_declared_on_the_routes(self):
        from app.main import app, settings

        def params(path):
            for route in app.routes:
                if getattr(route, "path", None) == settings.api_v1_prefix + path and "GET" in getattr(route, "methods", ()):
                    return {p.alias for p in route.dependant.query_params}
            raise AssertionError(path)

        assert {"cashierId", "areaId", "companyId"} <= params("/reports/products")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/departments")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/hourly")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/payment-methods")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/card-brands")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/cashiers")
        assert {"cashierId", "areaId", "companyId"} <= params("/reports/tips")


def test_the_transactions_list_row_carries_the_tip_and_its_tender():
    from app.schemas.transaction import TransactionListItem

    fields = {f.alias for f in TransactionListItem.model_fields.values()}
    assert {"tipAmount", "tipPaymentMethod"} <= fields


def test_the_shifts_list_row_carries_the_tips_for_its_export(w):
    """The shifts list export reads `serverTotals.totalTips / totalCashTips / totalCardTips`."""
    from app.routers.shifts import list_shifts

    s = w.shift(w.tills[0], 1)
    s.total_sales, s.total_tips, s.total_cash_tips, s.total_card_tips = (
        Decimal("100.00"), Decimal("9.00"), Decimal("4.00"), Decimal("5.00"),
    )
    w.db.commit()
    out = list_shifts(
        shop_id=None, machine_id=None, status_=None, awaiting_z=None, from_date=None, to_date=None,
        area_id=None, page=1, page_size=50, **_ctx(w),
    )
    totals = out.model_dump(by_alias=True)["items"][0]["serverTotals"]
    assert (totals["totalTips"], totals["totalCashTips"], totals["totalCardTips"]) == (
        Decimal("9.00"), Decimal("4.00"), Decimal("5.00"),
    )
