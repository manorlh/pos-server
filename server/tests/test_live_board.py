"""
The live control board (לוח בקרה): the overview's area level, and live sales by item.

* **Areas on the overview** — a shop's live areas (points of sale) with their tills and
  the day's money by the area each document's shift was stamped with, so an area adds
  up to the area report; tills in no area stay directly under the shop.
* **Live items** (`GET /reports/live-items`) — the product sales report's figures per
  product over the same documents, with qty, gross, net and share; narrowed by company,
  shop, area or till and never widened; "this shift" = the shifts open now.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.models.shift import Shift, ShiftStatus
from app.models.shop_area import ShopArea
from app.models.transaction_item import TransactionItem
from app.routers import reports as reports_router
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, open_shift, w  # noqa: F401


def overview(w, user=None, **extra):
    args = dict(day=TODAY, tz="Asia/Jerusalem", company_id=None, shop_id=None, machine_id=None)
    args.update(extra)
    return reports_router.get_overview_report(**args, **_ctx(w, user))


def live(w, user=None, **extra):
    args = dict(
        day=TODAY, from_date=None, to_date=None, shift=None, tz="Asia/Jerusalem",
        company_id=None, shop_id=None, area_id=None, machine_id=None, limit=500,
    )
    args.update(extra)
    return reports_router.get_live_items_report(**args, **_ctx(w, user))


def products(w, user=None, **extra):
    args = dict(
        from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
        shop_id=None, machine_id=None, cashier_id=None, limit=1000, area_id=None,
    )
    args.update(extra)
    return reports_router.get_product_sales_report(**args, **_ctx(w, user))


def area(w, name, shop=None, sort_order=0):
    a = ShopArea(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id,
        name=name, sort_order=sort_order,
    )
    w.db.add(a)
    w.db.flush()
    return a


def line(w, doc, name, qty, total, *, discount="0", product_id=None, sku=None):
    w.db.add(
        TransactionItem(
            id=uuid.uuid4(), transaction_id=doc.id, product_id=product_id,
            product_name=name, sku=sku or name.lower(), quantity=Decimal(qty),
            unit_price=Decimal(total) / Decimal(qty), total_price=Decimal(total),
            discount=Decimal(discount),
        )
    )
    w.db.flush()


def shop_node(out, shop):
    return next(s for c in out.companies for s in c.shops if s.id == shop.id)


@pytest.fixture
def bar_world(w):
    """Till 1 in "Bar" (its shift stamped so), Till 2 in no area, North 1 elsewhere."""
    t1, t2 = w.tills
    w.bar = area(w, "Bar", sort_order=1)
    w.terrace = area(w, "Terrace", sort_order=2)
    t1.area_id = w.bar.id
    w.db.flush()
    s1 = open_shift(w, t1, 1)
    w.s1 = s1
    d1 = w.doc(t1, s1, "100.00", discount="10.00")
    line(w, d1, "Beer", "4", "80.00", discount="10.00")
    line(w, d1, "Chips", "2", "20.00")
    cn = w.doc(t1, s1, "20.00", credit_note=True)
    line(w, cn, "Beer", "1", "20.00")
    s2 = open_shift(w, t2, 1)
    d2 = w.doc(t2, s2, "30.00")
    line(w, d2, "Chips", "3", "30.00")
    north = open_shift(w, w.other_till, 1)
    d3 = w.doc(w.other_till, north, "50.00")
    line(w, d3, "Wine", "1", "50.00")
    w.db.commit()
    return w


class TestOverviewAreas:
    def test_a_shop_lists_its_live_areas_in_order_with_their_tills(self, bar_world):
        w = bar_world
        center = shop_node(overview(w), w.shop)
        assert [a.name for a in center.areas] == ["Bar", "Terrace"]
        bar, terrace = center.areas
        assert bar.machine_ids == [w.tills[0].id] and terrace.machine_ids == []
        by_id = {m.id: m for m in center.machines}
        assert by_id[w.tills[0].id].area_id == w.bar.id
        assert by_id[w.tills[1].id].area_id is None

    def test_an_area_carries_its_stamped_shifts_money_and_the_levels_add_up(self, bar_world):
        w = bar_world
        center = shop_node(overview(w), w.shop)
        bar, terrace = center.areas
        assert (bar.sales_today, bar.documents_today) == (70.0, 2)
        assert terrace.sales_today == 0
        unassigned = sum(m.sales_today for m in center.machines if m.area_id is None)
        assert round(bar.sales_today + terrace.sales_today + unassigned, 2) == center.sales_today

    def test_moving_a_till_moves_its_tile_not_what_the_area_took_today(self, bar_world):
        w = bar_world
        w.tills[0].area_id = w.terrace.id
        w.db.commit()
        bar, terrace = shop_node(overview(w), w.shop).areas
        assert bar.sales_today == 70.0 and bar.machine_ids == []
        assert terrace.machine_ids == [w.tills[0].id] and terrace.sales_today == 0

    def test_an_archived_area_is_not_listed(self, bar_world):
        w = bar_world
        w.terrace.archived_at = datetime.now(timezone.utc)
        w.db.commit()
        assert [a.name for a in shop_node(overview(w), w.shop).areas] == ["Bar"]

    def test_a_shop_without_areas_has_none(self, bar_world):
        assert shop_node(overview(bar_world), bar_world.other_shop).areas == []

    def test_the_query_count_does_not_grow_with_areas(self, bar_world):
        w = bar_world

        def count():
            seen = []
            engine = w.db.get_bind()
            listener = lambda *a, **k: seen.append(1)  # noqa: E731
            event.listen(engine, "before_cursor_execute", listener)
            try:
                overview(w)
            finally:
                event.remove(engine, "before_cursor_execute", listener)
            return len(seen)

        before = count()
        for i in range(4):
            area(w, f"Extra {i}", shop=w.other_shop)
        w.db.commit()
        assert count() == before


class TestLiveItems:
    def test_per_product_qty_gross_net_and_share(self, bar_world):
        out = live(bar_world)
        rows = {r.name: r for r in out.rows}
        beer, chips, wine = rows["Beer"], rows["Chips"], rows["Wine"]
        assert (beer.qty, beer.gross, beer.discounts, beer.refunds, beer.net) == (3.0, 80.0, 10.0, 20.0, 50.0)
        assert (chips.qty, chips.gross, chips.net) == (5.0, 50.0, 50.0)
        assert (wine.qty, wine.net) == (1.0, 50.0)
        assert out.totals.net == 150.0 and out.totals.product_count == 3
        assert abs(sum(r.share for r in out.rows) - 100.0) < 0.05
        assert chips.share == 33.33
        assert out.period == "day"

    def test_matches_the_product_sales_report(self, bar_world):
        out = live(bar_world)
        report = products(bar_world)
        assert out.totals.net == round(report.totals.net, 2)
        assert {r.name: r.net for r in out.rows} == {
            r.product_name: round(r.net, 2) for r in report.rows
        }

    def test_scope_narrows_by_shop_area_till_and_company(self, bar_world):
        w = bar_world
        assert {r.name for r in live(w, shop_id=w.other_shop.id).rows} == {"Wine"}
        bar = live(w, area_id=str(w.bar.id))
        assert {r.name: r.qty for r in bar.rows} == {"Beer": 3.0, "Chips": 2.0}
        assert {r.name for r in live(w, area_id="none").rows} == {"Chips", "Wine"}
        till2 = live(w, machine_id=w.tills[1].id)
        assert [(r.name, r.qty, r.share) for r in till2.rows] == [("Chips", 3.0, 100.0)]
        assert live(w, company_id=w.company.id).totals.net == 150.0

    def test_a_shop_manager_never_sees_another_shop(self, bar_world):
        w = bar_world
        assert "Wine" not in {r.name for r in live(w, user=w.manager).rows}
        assert live(w, user=w.manager, shop_id=w.other_shop.id).rows == []

    def test_another_tenants_company_narrows_to_nothing(self, bar_world):
        w = bar_world
        assert live(w, company_id=uuid.uuid4()).rows == []

    def test_yesterday_and_a_custom_range(self, bar_world):
        w = bar_world
        yesterday = TODAY - timedelta(days=1)
        assert live(w, day=yesterday).rows == []
        ranged = live(w, from_date=yesterday, to_date=TODAY)
        assert ranged.period == "range" and ranged.totals.net == 150.0

    def test_this_shift_is_the_open_shifts_since_they_began(self, bar_world):
        w = bar_world
        # A sale on Till 1's open shift from before midnight still counts for the shift…
        old = w.doc(w.tills[0], w.s1, "40.00")
        line(w, old, "Chips", "4", "40.00")
        old.created_at = NOW - timedelta(days=1)
        w.db.commit()
        shift = live(w, shift="open", machine_id=w.tills[0].id)
        assert shift.period == "shift" and shift.open_shift_count == 1
        assert {r.name: r.qty for r in shift.rows} == {"Beer": 3.0, "Chips": 6.0}
        # …and not for today.
        assert {r.name: r.qty for r in live(w, machine_id=w.tills[0].id).rows} == {
            "Beer": 3.0, "Chips": 2.0,
        }

    def test_a_closed_shift_is_not_this_shift(self, bar_world):
        w = bar_world
        north = w.db.query(Shift).filter(Shift.machine_id == w.other_till.id).one()
        north.status = ShiftStatus.CLOSED
        north.closed_at = NOW
        w.db.commit()
        out = live(w, shift="open", shop_id=w.other_shop.id)
        assert out.rows == [] and out.open_shift_count == 0

    def test_the_row_cap_keeps_the_totals_whole(self, bar_world):
        out = live(bar_world, limit=1)
        assert len(out.rows) == 1 and out.truncated and out.totals.product_count == 3
