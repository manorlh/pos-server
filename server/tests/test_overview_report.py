"""
The manager overview (`GET /reports/overview`): today's takings as company › shop › till.

What it must never get wrong:

* the money is the per-cashier report's, and the levels add up — till → shop → company
  → KPIs — or the overview and the reports tell a manager two different days;
* it is scoped like every other report: a shop manager sees their shop, a company
  manager their group, nobody another tenant's anything;
* it costs the same number of queries for one till as for fifty (a phone polls it).

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import event

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.transaction import TransactionStatus
from app.routers import reports as reports_router
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, open_shift, w  # noqa: F401


def overview(w, user=None, **extra):
    args = dict(day=TODAY, tz="Asia/Jerusalem", company_id=None, shop_id=None, machine_id=None)
    args.update(extra)
    return reports_router.get_overview_report(**args, **_ctx(w, user))


def cashier_totals(w, shop):
    return reports_router.get_cashier_sales_report(
        from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
        shop_id=shop.id, machine_id=None, **_ctx(w),
    ).totals


def shop_node(out, shop):
    return next(s for c in out.companies for s in c.shops if s.id == shop.id)


def till_node(out, till):
    return next(m for c in out.companies for s in c.shops for m in s.machines if m.id == till.id)


@pytest.fixture
def trading(w):
    t1, t2 = w.tills
    s1 = open_shift(w, t1, 1)
    w.doc(t1, s1, "100.00", discount="10.00", tip="5.00", tip_method="card")
    w.doc(t1, s1, "40.00", method="card")
    w.doc(t1, s1, "20.00", credit_note=True)
    s2 = open_shift(w, t2, 1)
    w.doc(t2, s2, "33.33", legs=[("cash", "13.33"), ("card", "20.00")])
    # Counts nowhere.
    w.doc(t2, s2, "999.00", status=TransactionStatus.CANCELLED)
    north = open_shift(w, w.other_till, 1)
    w.doc(w.other_till, north, "50.00")
    # Yesterday is not today.
    old = w.doc(t1, s1, "777.00")
    old.created_at = NOW - timedelta(days=1)
    w.db.commit()


class TestFigures:
    def test_each_till_shop_and_the_kpis_carry_the_days_money(self, w, trading):
        out = overview(w)
        t1, t2 = w.tills

        a = till_node(out, t1)
        assert (a.sales_today, a.gross, a.discounts, a.refunds) == (110.0, 140.0, 10.0, 20.0)
        assert (a.documents_today, a.sales_count, a.refunds_count) == (3, 2, 1)
        assert (a.cash, a.card, a.tips) == (70.0, 40.0, 5.0)
        b = till_node(out, t2)
        assert (b.sales_today, b.cash, b.card, b.documents_today) == (33.33, 13.33, 20.0, 1)

        center = shop_node(out, w.shop)
        assert center.sales_today == 143.33 and center.documents_today == 4
        assert shop_node(out, w.other_shop).sales_today == 50.0

        k = out.kpis
        assert k.sales_today == 193.33 and k.documents_today == 5 and k.sales_count == 4
        assert (k.cash, k.card) == (133.33, 60.0)
        # (gross - discounts) / sales: (140 + 33.33 + 50 - 10) / 4
        assert k.average_ticket == 53.33
        assert out.window.from_date == TODAY and out.window.to_date == TODAY

    def test_an_open_shift_carries_what_it_took_since_it_opened_not_since_midnight(self, w, trading):
        out = overview(w)
        a = till_node(out, w.tills[0])
        # Today's 110 plus yesterday's 777 rung on the same, still open, shift.
        assert a.open_shift_id is not None
        assert (a.open_shift_sales, a.open_shift_documents) == (887.0, 4)
        assert till_node(out, w.tills[1]).open_shift_sales == 33.33

    def test_a_till_with_no_open_shift_has_no_shift_figures(self, w):
        a = till_node(overview(w), w.tills[0])
        assert (a.open_shift_id, a.open_shift_sales, a.open_shift_documents) == (None, None, None)

    def test_the_levels_add_up_and_match_the_cashier_report(self, w, trading):
        out = overview(w)
        for shop in (w.shop, w.other_shop):
            node = shop_node(out, shop)
            assert round(sum(m.sales_today for m in node.machines), 2) == node.sales_today
            assert node.sales_today == round(cashier_totals(w, shop).net, 2)
        (company,) = out.companies
        assert company.sales_today == round(sum(s.sales_today for s in company.shops), 2)
        assert out.kpis.sales_today == company.sales_today

    def test_a_till_that_sold_nothing_is_listed_with_zeros_in_register_order(self, w):
        out = overview(w)
        center = shop_node(out, w.shop)
        assert [m.name for m in center.machines] == ["Till 1", "Till 2"]
        assert [m.pos_number for m in center.machines] == ["1", "2"]
        assert all(m.sales_today == 0 and m.documents_today == 0 for m in center.machines)
        assert out.kpis.average_ticket == 0.0

    def test_a_decommissioned_till_is_not_listed(self, w):
        w.tills[1].is_active = False
        w.db.commit()
        assert [m.name for m in shop_node(overview(w), w.shop).machines] == ["Till 1"]


class TestScope:
    def test_a_shop_manager_sees_only_their_shop(self, w, trading):
        out = overview(w, user=w.manager)
        (company,) = out.companies
        assert [s.id for s in company.shops] == [w.shop.id]
        assert out.kpis.sales_today == 143.33

    def test_a_shop_manager_cannot_widen_it_by_asking_for_another_shop(self, w, trading):
        out = overview(w, user=w.manager, shop_id=w.other_shop.id)
        assert out.companies == [] and out.kpis.sales_today == 0

    def test_a_company_manager_sees_their_company(self, w, trading):
        out = overview(w, user=w.company_manager)
        assert {s.id for s in out.companies[0].shops} == {w.shop.id, w.other_shop.id}
        assert out.kpis.sales_today == 193.33

    def test_the_scope_bar_narrows(self, w, trading):
        by_shop = overview(w, shop_id=w.other_shop.id)
        assert [s.id for c in by_shop.companies for s in c.shops] == [w.other_shop.id]
        assert by_shop.kpis.sales_today == 50.0

        by_till = overview(w, machine_id=w.tills[1].id)
        (shop,) = by_till.companies[0].shops
        assert [m.id for m in shop.machines] == [w.tills[1].id]
        assert by_till.kpis.sales_today == 33.33

        by_company = overview(w, company_id=w.company.id)
        assert by_company.kpis.sales_today == 193.33

    def test_another_tenants_shop_never_appears(self, w, trading):
        out = overview(w, shop_id=w.foreign_shop.id)
        assert out.companies == [] and out.kpis.sales_today == 0
        everything = overview(w)
        assert w.foreign_shop.id not in {s.id for c in everything.companies for s in c.shops}


class TestCost:
    def test_the_query_count_does_not_grow_with_the_tree(self, w, trading):
        def count_queries():
            seen = []
            engine = w.db.get_bind()
            listener = lambda *a, **k: seen.append(1)  # noqa: E731
            event.listen(engine, "before_cursor_execute", listener)
            try:
                overview(w)
            finally:
                event.remove(engine, "before_cursor_execute", listener)
            return len(seen)

        before = count_queries()
        for i in range(5):
            shop = Shop(
                id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id,
                name=f"Extra {i}", settings={},
            )
            w.db.add(shop)
            w.db.flush()
            for j in range(3):
                till = POSMachine(
                    id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id,
                    distributor_id=w.admin.id, name=f"X{i}-{j}", machine_code=f"X-{i}-{j}",
                    pos_number=str(j + 1), is_active=True,
                    pairing_status=PairingStatus.ASSIGNED,
                )
                w.db.add(till)
                w.db.flush()
                w.doc(till, None, "10.00")
        w.db.commit()

        assert count_queries() == before
