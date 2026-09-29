"""
Area reports (docs/AREAS_API.md §2.3): sales by area, and `areaId` on the sales reports.

Every figure is read through the area each document's **shift was stamped with**, never
the till's area now — so moving a till moves no past total — and the per-area rows must
add up exactly to the shop's own total, or an area table quietly loses money.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.routers import areas as areas_router
from app.routers import reports as reports_router
from shift_world import TODAY
from test_shop_areas import _ctx, create, members, open_shift, refused, w  # noqa: F401


# ── Reports ───────────────────────────────────────────────────────────────────


def _report_args(**extra):
    base = dict(
        from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
        shop_id=None, machine_id=None,
    )
    base.update(extra)
    return base


def by_area(w, shop=None, user=None):
    return reports_router.get_sales_by_area_report(
        shop_id=(shop or w.shop).id, date_from=TODAY, date_to=TODAY, from_date=None, to_date=None,
        from_hour=None, to_hour=None, tz="Asia/Jerusalem", **_ctx(w, user),
    )


def cashier_totals(w, **extra):
    return reports_router.get_cashier_sales_report(
        **_report_args(shop_id=w.shop.id, **extra), **_ctx(w)
    ).totals


class TestSalesByArea:
    @pytest.fixture
    def trading(self, w):
        """The bar and the kitchen take money; a till moves; some takings have no area."""
        t1, t2 = w.tills
        bar = create(w, "Bar", sort_order=1)
        kitchen = create(w, "Kitchen", sort_order=2)
        members(w, bar["id"], t1)
        members(w, kitchen["id"], t2)
        s1 = open_shift(w, t1, 1)
        w.doc(t1, s1, "100.00", discount="10.00", tip="5.00", tip_method="card")
        w.doc(t1, s1, "40.00", method="card")
        w.doc(t1, s1, "20.00", credit_note=True)
        s2 = open_shift(w, t2, 1)
        w.doc(t2, s2, "33.33", legs=[("cash", "13.33"), ("card", "20.00")])
        # A document with no shift, and t1 leaving the bar with its shift still open:
        # neither moves the bar's takings.
        w.doc(t2, None, "7.77")
        members(w, bar["id"])
        # A sale on the shift the bar opened, rung after the till left the bar: the bar's.
        w.doc(t1, s1, "5.00")
        # A cancelled document counts nowhere.
        from app.models.transaction import TransactionStatus

        w.doc(t1, s1, "999.00", status=TransactionStatus.CANCELLED)
        # Takings of another shop are not this shop's.
        other_shift = open_shift(w, w.other_till, 1)
        w.doc(w.other_till, other_shift, "50.00")
        w.db.commit()
        return SimpleNamespace(bar=bar, kitchen=kitchen, s1=s1, s2=s2)

    def test_one_row_per_area_that_took_something_plus_unassigned(self, w, trading):
        out = by_area(w).model_dump(by_alias=True)

        rows = out["rows"]
        assert [r["areaName"] for r in rows] == ["Bar", "Kitchen", None]
        bar, kitchen, rest = rows
        assert bar["areaId"] == trading.bar["id"] and bar["archived"] is False
        assert (bar["transactionsCount"], bar["gross"], bar["discounts"], bar["refunds"], bar["net"]) == (
            4, 145.0, 10.0, 20.0, 115.0,
        )
        assert (bar["cash"], bar["card"], bar["tips"]) == (75.0, 40.0, 5.0)
        assert (kitchen["cash"], kitchen["card"], kitchen["net"]) == (13.33, 20.0, 33.33)
        assert rest["areaId"] is None and rest["net"] == 7.77
        assert out["shopId"] == w.shop.id and out["dateFrom"] == TODAY and out["dateTo"] == TODAY

    def test_the_rows_add_up_exactly_to_the_shops_total(self, w, trading):
        out = by_area(w)
        shop = cashier_totals(w)

        fields = ("gross", "discounts", "refunds", "net", "cash", "card", "other", "tips")
        for field in fields:
            assert round(sum(getattr(r, field) for r in out.rows), 2) == round(getattr(out.totals, field), 2)
        assert round(out.totals.net, 2) == round(shop.net, 2)
        assert round(out.totals.gross, 2) == round(shop.gross, 2)
        assert round(out.totals.discounts, 2) == round(shop.discounts, 2)
        assert round(out.totals.refunds, 2) == round(shop.refunds, 2)
        assert round(out.totals.cash, 2) == round(shop.cash_net, 2)
        assert round(out.totals.card, 2) == round(shop.card_net, 2)
        assert round(out.totals.other, 2) == round(shop.other_net, 2)
        assert round(out.totals.tips, 2) == round(shop.tips, 2)
        assert out.totals.transactions_count == shop.document_count

    def test_an_archived_area_keeps_its_row_flagged(self, w, trading):
        areas_router.archive_shop_area(trading.bar["id"], **_ctx(w))

        bar = next(r for r in by_area(w).rows if str(r.area_id) == str(trading.bar["id"]))

        assert bar.archived is True and bar.area_name == "Bar"

    def test_no_unassigned_row_when_everything_had_an_area(self, w):
        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[0])
        w.doc(w.tills[0], open_shift(w, w.tills[0]), "10.00")
        w.db.commit()

        assert [r.area_name for r in by_area(w).rows] == ["Bar"]

    def test_the_existing_reports_filter_on_the_stamped_area(self, w, trading):
        bar_id = str(trading.bar["id"])

        assert round(cashier_totals(w, area_id=bar_id).net, 2) == 115.0
        assert round(cashier_totals(w, area_id="none").net, 2) == 7.77
        tips = reports_router.get_tips_range_report(**_report_args(shop_id=w.shop.id, area_id=bar_id), **_ctx(w))
        assert tips.tips_total == 5.0
        products = reports_router.get_product_sales_report(
            **_report_args(shop_id=w.shop.id, area_id="none"), cashier_id=None, limit=200, **_ctx(w)
        )
        assert products.totals.product_count == 0  # the world's documents have no lines

    def test_another_tenants_shop_is_forbidden(self, w):
        assert refused(by_area, w, shop=w.foreign_shop).status_code == 403
