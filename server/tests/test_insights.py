"""
Insights ("תובנות", app/services/insights) — docs/SPEC_INSIGHTS.md.

What each class pins, and how it could look fine while being wrong:

* **Money and the clock** — agorot are rounded half-up once; a sale at 01:30 belongs to
  the business day before (04:00 cut-off), in Israel's time, summer and winter.
* **ABC** — the item that crosses 80% is still A; the classes add up to 100%.
* **Menu engineering** — the 70% popularity rule, the *weighted* average margin (a plain
  mean puts items in the wrong quadrant), VAT taken out before the margin, price mode
  when costs are missing, each item judged within its own category.
* **Slow movers** — dead from exactly 21 days, never-sold counted, new items and the
  general item left alone, stock that is not on sale still found.
* **Stock** — days of cover, the statuses and the suggested order.
* **Heat map** — closed days are not weak; a dip inside the opening hours is; Friday
  afternoon (closed for Shabbat) is not; consecutive weak hours merge.
* **Forecast** — the 4-3-2-1 weighted same weekday, a holiday dropped, the fallback, the
  backtest; today's pace up to the same minute.
* **Baskets, employees, tables** — lift and confidence, outlier employees only above the
  floors and the minimum, open tables counted once, seated time without a forgotten bill.
* **The endpoints** — on the in-memory SQLite world of tests/shift_world.py: the feed,
  the scope, the business-day bucketing end to end, costs and their permission.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.audit_exception import TillEvent
from app.models.category import Category
from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.shop_product_override import ShopProductOverride
from app.models.stock_level import StockLevel
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import insights as R
from app.services.insights import analytics as A
from app.services.insights import service as S
from shift_world import NOW, accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc
#: NOW is Sunday 2026-09-27 18:00 UTC = 21:00 in Jerusalem: business day 2026-09-27.
TODAY = date(2026, 9, 27)


def at(day: date, hour: int, minute: int = 0) -> datetime:
    """A local Jerusalem wall-clock time, as the UTC instant documents are stamped with."""
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=JLM).astimezone(UTC)


# ═════════════════════════════════════════════════════════════════════════════
# The formulas
# ═════════════════════════════════════════════════════════════════════════════


class TestMoneyAndClock:
    def test_agorot_round_half_up_once(self):
        assert A.to_agorot(Decimal("12.345")) == 1235
        assert A.to_agorot("0.005") == 1
        assert A.to_agorot(19.99) == 1999
        assert A.to_agorot(None) == 0

    def test_a_sale_at_01_30_belongs_to_the_evening_before(self):
        clock = A.BusinessClock("Asia/Jerusalem", 4, NOW)
        moment = at(date(2026, 9, 26), 1, 30)  # Saturday 01:30 local
        assert clock.business_date(moment) == date(2026, 9, 25)  # Friday night
        assert A.weekday_of(clock.business_date(moment)) == 5
        assert clock.hour(moment) == 1
        assert clock.business_date(at(date(2026, 9, 26), 4, 0)) == date(2026, 9, 26)

    def test_the_business_day_starts_at_04_local_in_summer_and_in_winter(self):
        clock = A.BusinessClock("Asia/Jerusalem", 4, NOW)
        assert clock.day_start(date(2026, 9, 27)) == datetime(2026, 9, 27, 1, 0, tzinfo=UTC)  # IDT +3
        assert clock.day_start(date(2026, 12, 1)) == datetime(2026, 12, 1, 2, 0, tzinfo=UTC)  # IST +2
        assert clock.today == TODAY
        before_cutoff = A.BusinessClock("Asia/Jerusalem", 4, datetime(2026, 9, 27, 0, 30, tzinfo=UTC))
        assert before_cutoff.today == date(2026, 9, 26)  # 03:30 local is still Saturday's
        assert clock.slot(4) == 0 and clock.slot(3) == 23


class TestAbc:
    def test_classes_cut_at_80_and_95_and_add_up_to_100(self):
        out = A.abc_classes([("a", 500), ("b", 300), ("c", 100), ("d", 60), ("e", 40), ("f", 0), ("g", -10)])
        cls = {k: v["class"] for k, v in out["items"].items()}
        assert cls == {"a": "A", "b": "A", "c": "B", "d": "B", "e": "C", "f": "C", "g": "C"}
        shares = {c: v["share"] for c, v in out["classes"].items()}
        assert shares == {"A": 80.0, "B": 16.0, "C": 4.0}
        assert sum(shares.values()) == pytest.approx(100.0)
        assert [out["classes"][c]["count"] for c in "ABC"] == [2, 2, 3]
        assert out["items"]["c"]["cumShare"] == pytest.approx(90.0)

    def test_the_item_that_crosses_80_percent_is_still_a(self):
        out = A.abc_classes([("a", 700), ("b", 200), ("c", 100)])
        assert [out["items"][k]["class"] for k in "abc"] == ["A", "A", "B"]
        assert sum(c["share"] for c in out["classes"].values()) == pytest.approx(100.0)

    def test_nothing_sold(self):
        out = A.abc_classes([("a", 0)])
        assert out["total"] == 0 and out["items"]["a"]["class"] == "C"


def drink(key, units, price, cost=None, vat=0.0, cat="drinks"):
    return A.MenuItemIn(key=key, name=key, units=units, net=round(units * price * 100), cost=cost, vat_rate=vat, category_id=cat)


class TestMenuMatrix:
    ITEMS = [drink("A", 50, 10, 200), drink("B", 30, 8, 600), drink("C", 5, 20, 500), drink("D", 15, 6, 500)]

    def test_quadrants_by_the_70_percent_rule_and_the_weighted_margin(self):
        out = A.menu_matrix(self.ITEMS)
        assert out["mode"] == "cost"
        by = {r["key"]: r for r in out["items"]}
        assert {k: r["quadrant"] for k, r in by.items()} == {"A": "star", "B": "plowhorse", "C": "puzzle", "D": "dog"}
        # 0.7 × 1/4 = 17.5%; weighted CM = (800·50 + 200·30 + 1500·5 + 100·15) / 100 = 550.
        assert out["popularityThreshold"] == pytest.approx(17.5)
        assert out["valueThreshold"] == 550
        assert by["A"]["margin"] == 800 and by["A"]["menuMix"] == pytest.approx(50.0)
        assert by["A"]["popIndex"] == pytest.approx(0.5 / 0.175, abs=1e-3)
        assert by["A"]["valueIndex"] == pytest.approx(800 / 550, abs=1e-3)
        assert out["counts"] == {"star": 1, "plowhorse": 1, "puzzle": 1, "dog": 1}

    def test_a_plain_mean_would_misplace_b_the_weighted_one_does_not(self):
        # Plain mean of the margins = (800 + 200 + 1500 + 100) / 4 = 650: C stays a puzzle
        # either way, but the weighted 550 is what Kasavana-Smith prescribe.
        out = A.menu_matrix(self.ITEMS)
        assert out["valueThreshold"] != round((800 + 200 + 1500 + 100) / 4)

    def test_price_mode_without_costs(self):
        items = [drink(i.key, i.units, i.net / i.units / 100) for i in self.ITEMS]
        out = A.menu_matrix(items)
        assert out["mode"] == "price"
        # Weighted average price = all the money / all the units = 93,000 / 100.
        assert out["valueThreshold"] == 930
        assert not out["missingCost"]
        assert all(r["margin"] is None for r in out["items"])

    def test_cost_mode_lists_an_item_without_a_cost_apart(self):
        items = [drink("A", 50, 10, 200), drink("B", 30, 8, 600), drink("C", 5, 20, 500), drink("D", 15, 6, None)]
        out = A.menu_matrix(items)
        assert out["mode"] == "cost"
        assert [r["key"] for r in out["missingCost"]] == ["D"]
        assert {r["key"] for r in out["items"]} == {"A", "B", "C"}
        # Popularity still over the four items sold: D's units count in the mix.
        assert out["popularityThreshold"] == pytest.approx(17.5)
        assert out["valueThreshold"] == round((800 * 50 + 200 * 30 + 1500 * 5) / 85)

    def test_vat_comes_out_before_the_margin(self):
        out = A.menu_matrix([drink("X", 10, 11.80, 400, vat=0.18), drink("Y", 10, 5.90, 100, vat=0.18), drink("Z", 10, 23.6, 900, vat=0.18)])
        x = next(r for r in out["items"] if r["key"] == "X")
        assert x["avgPriceExVat"] == 1000
        assert x["margin"] == 600
        assert x["foodCostPct"] == 40.0

    def test_each_item_is_judged_within_its_category(self):
        items = [
            drink("espresso", 60, 8, 100), drink("latte", 30, 14, 300), drink("tea", 10, 9, 50),
            drink("burger", 40, 60, 2500, cat="food"), drink("salad", 10, 50, 1000, cat="food"),
        ]
        out = A.menu_matrix(items)
        by = {r["key"]: r for r in out["items"]}
        assert by["espresso"]["group"] == "drinks"
        # Food has two items: judged against the whole menu.
        assert by["burger"]["group"] == A.WHOLE_MENU
        drinks_threshold = next(g for g in out["groups"] if g["group"] == "drinks")
        assert drinks_threshold["popularityThreshold"] == pytest.approx(70 / 3)
        assert by["espresso"]["menuMix"] == pytest.approx(60.0)
        whole = A.menu_matrix(items, by_category=False)
        assert {r["group"] for r in whole["items"]} == {A.WHOLE_MENU}
        assert whole["items"][0]["popularityThreshold"] == pytest.approx(14.0)


def product(key, **kw):
    base = dict(key=key, name=key, listed=True, first_seen=TODAY - timedelta(days=200))
    base.update(kw)
    return A.ProductIn(**base)


class TestSlowMovers:
    def run(self, items, **kw):
        return A.slow_movers(items, today=TODAY, period_days=28, lookback_days=120, **kw)

    def test_dead_from_21_days_never_sold_new_and_general_left_alone(self):
        out = self.run([
            product("pita", last_sold=TODAY - timedelta(days=21)),
            product("hummus", last_sold=TODAY - timedelta(days=20)),
            product("old_never", last_sold=None, first_seen=TODAY - timedelta(days=60)),
            product("new_never", last_sold=None, first_seen=TODAY - timedelta(days=10)),
            product("general", last_sold=None, is_general=True),
            product("unlisted", listed=False, last_sold=TODAY - timedelta(days=40)),
            product("stuck", listed=False, on_hand=12, cost=300, last_sold=TODAY - timedelta(days=40)),
        ])
        dead = {r["key"]: r for r in out["dead"]}
        assert set(dead) == {"pita", "old_never", "stuck"}
        assert dead["pita"]["daysSinceSale"] == 21 and dead["pita"]["action"] == "dont_reorder"
        assert dead["old_never"]["never"] is True and dead["old_never"]["daysSinceSale"] is None
        assert dead["stuck"]["action"] == "sell_off_dont_reorder" and dead["stuck"]["stockValue"] == 3600
        # Money stuck on the shelf first.
        assert out["dead"][0]["key"] == "stuck"

    def test_the_threshold_is_a_parameter(self):
        out = self.run([product("pita", last_sold=TODAY - timedelta(days=15))], dead_days=14)
        assert [r["key"] for r in out["dead"]] == ["pita"]

    def test_slow_is_under_a_quarter_of_a_fair_share(self):
        items = [product(f"p{i}", units=100.0, last_sold=TODAY) for i in range(5)]
        items.append(product("tail", units=2.0, last_sold=TODAY, track_stock=True))
        out = self.run(items)
        assert [r["key"] for r in out["slow"]] == ["tail"]
        assert out["slow"][0]["fairShare"] == pytest.approx(100 / 6)
        assert out["slow"][0]["action"] == "order_less"
        assert out["slow"][0]["perWeek"] == 0.5

    def test_too_few_items_for_a_tail(self):
        items = [product("a", units=100.0, last_sold=TODAY), product("b", units=1.0, last_sold=TODAY)]
        assert self.run(items)["slow"] == []

    def test_declining_from_40_percent(self):
        out = self.run([
            product("down", units=11.0, units_prev=20.0, last_sold=TODAY),
            product("dip", units=13.0, units_prev=20.0, last_sold=TODAY),
            product("small", units=1.0, units_prev=5.0, last_sold=TODAY),
        ])
        assert [r["key"] for r in out["declining"]] == ["down"]
        assert out["declining"][0]["changePct"] == -45.0


def stock_row(on_hand, units=56.0, **kw):
    return A.StockIn(key="milk", name="milk", shop_id="s", shop_name="S", on_hand=on_hand, units=units, **kw)


class TestStockRisk:
    def status(self, row):
        (out,) = A.stock_risk([row])
        return out

    def test_days_of_cover_status_and_suggested_order(self):
        out = self.status(stock_row(0))
        assert (out["status"], out["perDay"], out["suggestedOrder"]) == ("out", 2.0, 18)
        out = self.status(stock_row(3))
        assert (out["status"], out["daysOfCover"], out["suggestedOrder"]) == ("critical", 1.5, 15)
        out = self.status(stock_row(10))
        assert (out["status"], out["daysOfCover"], out["suggestedOrder"]) == ("low", 5.0, 8)
        out = self.status(stock_row(20, reorder_min=25, reorder_max=40))
        assert (out["status"], out["suggestedOrder"]) == ("below_min", 20)
        assert self.status(stock_row(5, units=0))["status"] == "dead"
        assert self.status(stock_row(200))["status"] == "overstock"
        ok = self.status(stock_row(30))
        assert (ok["status"], ok["daysOfCover"], ok["suggestedOrder"]) == ("ok", 15.0, None)

    def test_sell_through(self):
        assert self.status(stock_row(20))["sellThroughPct"] == round(56 / 76 * 100, 1)

    def test_the_riskiest_first(self):
        rows = A.stock_risk([stock_row(30), stock_row(0), stock_row(10)])
        assert [r["status"] for r in rows] == ["out", "low", "ok"]


def week_grid(weeks=4, start=date(2026, 8, 30), tuesday_dip=True, thursday_peak=True, closed_tuesday=None):
    """Sun–Thu 08–17, Fri 08–14, Saturday closed; ₪100 an hour; a Tuesday dip and a Thursday rush."""
    cells = {}
    for d in A.days_between(start, start + timedelta(days=7 * weeks - 1)):
        w = A.weekday_of(d)
        if w == 6 or d == closed_tuesday:
            continue
        hours = range(8, 14) if w == 5 else range(8, 17)
        for h in hours:
            net = 10_000
            if tuesday_dip and w == 2 and h in (15, 16):
                net = 4_000
            if thursday_peak and w == 4 and h in (12, 13):
                net = 16_000
            cells[(d, h)] = A.Cell(net=net, docs=5, sales=5)
    return cells


class TestHeatmap:
    START, END = date(2026, 8, 30), date(2026, 9, 26)

    def test_a_dip_inside_the_day_is_weak_and_the_closed_hours_are_not(self):
        out = A.heatmap(week_grid(), self.START, self.END)
        assert out["occurrences"] == [4, 4, 4, 4, 4, 4, 0]
        (weak,) = out["weak"]
        assert (weak["weekday"], weak["fromHour"], weak["toHour"]) == (2, 15, 17)
        # μ at 15:00 and 16:00 = (4 × ₪100 + ₪40) / 5 = ₪88 → the two hours are 54.5% under.
        assert weak["usual"] == 17_600 and weak["typicalNet"] == 8_000
        assert weak["deviationPct"] == pytest.approx(-54.5)
        assert weak["gapPerWeek"] == 9_600
        (peak,) = out["peak"]
        assert (peak["weekday"], peak["fromHour"], peak["toHour"]) == (4, 12, 14)
        # Friday from 14:00 is closed for Shabbat, not weak; Saturday is closed.
        assert all(r["weekday"] != 5 for r in out["weak"])
        spans = {s["weekday"]: (s["from"], s["to"]) for s in out["spans"]}
        assert spans[5] == (8, 14) and spans[6] == (None, None)
        assert out["averageDay"] == 85_000

    def test_a_cell_is_a_median_and_a_closed_day_is_left_out(self):
        cells = week_grid(closed_tuesday=date(2026, 9, 8))
        # One odd Sunday at 09:00 does not move the typical figure.
        cells[(date(2026, 9, 6), 9)] = A.Cell(net=90_000, docs=40, sales=40)
        out = A.heatmap(cells, self.START, self.END)
        assert out["occurrences"][2] == 3 and out["closedDays"] == 5
        sunday_nine = next(c for c in out["cells"] if c["weekday"] == 0 and c["hour"] == 9)
        assert sunday_nine["typicalNet"] == 10_000
        assert sunday_nine["avgNet"] == 30_000

    def test_hours_open_per_weekday(self):
        out = A.heatmap(week_grid(), self.START, self.END)
        assert A.open_hours_by_weekday(out["spans"]) == [9, 9, 9, 9, 9, 6, 0]


def daily_of(values: dict) -> dict:
    return {d: A.Cell(net=v, docs=10 if v else 0, sales=10 if v else 0) for d, v in values.items()}


class TestForecast:
    HISTORY = date(2026, 8, 1)

    def mondays(self, *values):
        # The four Mondays before TODAY (Sunday 2026-09-27), most recent first.
        return {date(2026, 9, 21) - timedelta(days=7 * i): v for i, v in enumerate(values)}

    def test_weighted_4_3_2_1_same_weekday(self):
        daily = daily_of(self.mondays(10_000, 9_000, 8_000, 7_000))
        f = A.forecast_day(daily, date(2026, 9, 28), today=TODAY, history_start=self.HISTORY)
        assert f["net"] == 9_000  # (4·100 + 3·90 + 2·80 + 1·70) / 10
        assert (f["low"], f["high"], f["confidence"]) == (7_000, 10_000, "high")
        assert f["basis"] == ["2026-09-21", "2026-09-14", "2026-09-07", "2026-08-31"]

    def test_a_holiday_is_dropped(self):
        daily = daily_of(self.mondays(10_000, 0, 8_000, 7_000))
        f = A.forecast_day(daily, date(2026, 9, 28), today=TODAY, history_start=self.HISTORY)
        assert f["net"] == round((4 * 10_000 + 3 * 8_000 + 2 * 7_000) / 9)
        assert f["confidence"] == "medium"
        assert "2026-09-14" not in f["basis"]

    def test_without_same_weekday_history_the_last_14_days(self):
        days = {TODAY - timedelta(days=i): 5_000 for i in range(1, 4)}
        f = A.forecast_day(daily_of(days), date(2026, 9, 28), today=TODAY, history_start=TODAY - timedelta(days=3))
        assert (f["net"], f["confidence"]) == (5_000, "low")
        none = A.forecast_day({}, date(2026, 9, 28), today=TODAY, history_start=None)
        assert none["net"] is None and none["confidence"] == "none"

    def test_a_steady_week_backtests_to_full_accuracy(self):
        values = {self.HISTORY + timedelta(days=i): 1_000 * (A.weekday_of(self.HISTORY + timedelta(days=i)) + 1) for i in range(57)}
        daily = daily_of(values)
        bt = A.backtest(daily, today=TODAY, history_start=self.HISTORY)
        assert bt == {"wape": 0.0, "accuracy": 100.0, "days": 14}
        out = A.forecast(daily, {}, today=TODAY, history_start=self.HISTORY, day_start_hour=4)
        assert [d["net"] for d in out["days"]] == [2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 1_000]
        assert out["nextWeekTotal"] == 28_000 and out["lastWeekTotal"] == 28_000

    def test_tomorrow_by_the_hour_adds_up_to_the_day(self):
        hourly, daily_values = {}, {}
        for d in self.mondays(10_000, 9_000, 8_000, 7_000):
            hourly[(d, 8)] = A.Cell(net=2_000, docs=2)
            hourly[(d, 12)] = A.Cell(net=6_000, docs=5)
            hourly[(d, 17)] = A.Cell(net=2_000, docs=2)
            daily_values[d] = 10_000
        daily = daily_of(daily_values)
        out = A.forecast(daily, hourly, today=TODAY, history_start=self.HISTORY, day_start_hour=4)
        hours = {h["hour"]: h for h in out["tomorrowHourly"]}
        assert set(hours) == {8, 12, 17}
        assert hours[12]["share"] == 60.0
        assert sum(h["net"] for h in hours.values()) == out["days"][0]["net"] == 10_000

    def test_today_pace_up_to_the_same_minute(self):
        hourly, daily_values = {}, {}
        for i in range(1, 5):
            sunday = TODAY - timedelta(days=7 * i)
            for h in range(8, 17):
                hourly[(sunday, h)] = A.Cell(net=10_000, docs=4)
            daily_values[sunday] = 90_000
        for h in range(8, 12):
            hourly[(TODAY, h)] = A.Cell(net=5_000, docs=2)
        hourly[(TODAY, 12)] = A.Cell(net=2_500, docs=1)
        pace = A.today_pace(hourly, daily_of(daily_values), today=TODAY, now_slot=8, now_fraction=0.5,
                            history_start=self.HISTORY, day_start_hour=4)
        # Up to 12:30: four full hours and half of the fifth = 45,000 usually; 22,500 today.
        assert (pace["actual"], pace["expectedSoFar"], pace["pacePct"]) == (22_500, 45_000, -50.0)
        assert pace["expectedFull"] == 90_000 and pace["projected"] == 45_000
        assert pace["judgeable"] is True and pace["asOfHour"] == 12


class TestTrends:
    def test_week_over_week(self):
        daily = daily_of({TODAY - timedelta(days=i): (10_000 if i <= 7 else 8_000) for i in range(1, 15)})
        wow = A.week_over_week(daily, TODAY, history_start=TODAY - timedelta(days=30))
        assert (wow["net"], wow["netPrev"], wow["netChangePct"]) == (70_000, 56_000, 25.0)
        assert A.week_over_week(daily, TODAY, history_start=TODAY - timedelta(days=10)) is None

    def test_yesterday_against_the_median_of_its_weekday(self):
        saturday = TODAY - timedelta(days=1)
        values = {saturday - timedelta(days=7 * i): 10_000 for i in range(1, 5)}
        values[saturday] = 7_000
        a = A.day_anomaly(daily_of(values), saturday, history_start=date(2026, 8, 1))
        assert (a["baseline"], a["deviationPct"], a["weeks"]) == (10_000, -30.0, 4)
        values[saturday] = 8_000
        assert A.day_anomaly(daily_of(values), saturday, history_start=date(2026, 8, 1)) is None
        # Two weeks of history are not enough to call a day odd.
        assert A.day_anomaly(daily_of(values), saturday, history_start=saturday - timedelta(days=14)) is None

    def test_products_moving_this_week(self):
        out = A.product_trends([
            A.TrendItemIn("latte", "latte", 212, 180, 21_200, 18_000),
            A.TrendItemIn("tea", "tea", 25, 30, 2_500, 3_000),
            A.TrendItemIn("rare", "rare", 3, 1, 300, 100),
        ])
        assert [r["key"] for r in out["rising"]] == ["latte"]
        assert out["rising"][0]["changePct"] == 17.8
        assert [r["key"] for r in out["falling"]] == ["tea"]


class TestPairs:
    def test_support_confidence_lift_and_the_coffee_everyone_buys(self):
        baskets = {"croissant": 100, "cappuccino": 400, "cake": 50, "water": 500}
        pairs = [("cappuccino", "croissant", 64), ("cappuccino", "water", 210), ("cake", "croissant", 8), ("cake", "water", 30)]
        out = A.pair_metrics(pairs, baskets, 1000, names={k: k for k in baskets})
        assert [(p["a"], p["b"]) for p in out] == [("croissant", "cappuccino"), ("cake", "water")]
        first = out[0]
        assert first["confidence"] == pytest.approx(64.0)
        assert first["lift"] == 1.6
        assert first["support"] == pytest.approx(6.4)
        assert first["excess"] == 24.0
        assert A.pair_min_count(1000) == 10 and A.pair_min_count(4000) == 20

    def test_basket_sizes(self):
        out = A.basket_sizes([(1, 60), (2, 25), (3, 10), (7, 5)])
        assert out["singleItemShare"] == 60.0
        assert [b["baskets"] for b in out["buckets"]] == [60, 25, 10, 0, 5]


class TestCashiers:
    def test_flagged_only_at_twice_the_team_above_the_floor_with_enough_sales(self):
        out = A.cashier_rates([
            A.CashierIn("dana", "דנה", sales=50, gross=100_000, discounts=10_000, voids=3_000, voids_count=4),
            A.CashierIn("yossi", "יוסי", sales=100, gross=200_000, discounts=2_000, voids=500, voids_count=1),
            A.CashierIn("rina", "רינה", sales=10, gross=10_000, discounts=3_000),
        ])
        rows = {r["cashierId"]: r for r in out["rows"]}
        assert out["team"]["discountPct"] == pytest.approx(round(15_000 / 310_000 * 100, 1))
        flags = {f["metric"]: f for f in rows["dana"]["flags"]}
        assert set(flags) == {"discount", "void"}
        assert flags["discount"]["level"] == "elevated" and flags["discount"]["times"] == 2.1
        # Voids over net sales: 3,000 / 90,000.
        assert rows["dana"]["voidPct"] == 3.3
        assert rows["rina"]["flags"] == []  # 30% but only 10 sales
        assert rows["yossi"]["flags"] == []
        assert out["rows"][0]["cashierId"] == "dana"

    def test_below_the_floor_nobody_is_flagged(self):
        out = A.cashier_rates([
            A.CashierIn("a", "a", sales=100, gross=100_000, discounts=2_500),
            A.CashierIn("b", "b", sales=100, gross=100_000, discounts=500),
        ])
        assert all(not r["flags"] for r in out["rows"])  # 2.5% is under the 3% floor


class TestTables:
    def test_open_tables_now(self):
        orders = [
            A.OpenTableIn("t7", 7, None, "אולם", "s", "S", 4, 25_000, NOW - timedelta(minutes=190), "sent", 4),
            A.OpenTableIn("t3", 3, "בר", "בר", "s", "S", 2, 8_000, NOW - timedelta(minutes=30), "awaiting_payment", 2),
        ]
        out = A.tables_live(orders, tables_total=10, seats_total=40, now=NOW, usual_minutes=60)
        assert (out["openTables"], out["guests"], out["openAmount"]) == (2, 6, 33_000)
        assert (out["occupancyPct"], out["seatUsePct"], out["awaitingPayment"]) == (20.0, 15.0, 1)
        assert out["longest"]["number"] == 7 and out["longest"]["minutesOpen"] == 190
        assert out["longAfterMinutes"] == 120 and out["longOpen"] == 1
        assert out["avgMinutesOpen"] == 110

    def test_the_period_without_a_forgotten_bill(self):
        t = NOW - timedelta(days=1)
        orders = [
            A.PaidTableIn("a", t, t + timedelta(minutes=60), 2, 20_000),
            A.PaidTableIn("b", t, t + timedelta(minutes=90), 4, 40_000),
            A.PaidTableIn("c", t, t + timedelta(minutes=800), 2, 10_000),
            A.PaidTableIn("d", t, t + timedelta(minutes=30), None, 5_000),
        ]
        out = A.tables_period(orders, tables_total=10, seats_total=40, days=2, open_hours=20)
        assert (out["orders"], out["revenue"], out["covers"]) == (4, 75_000, 8)
        assert out["spendPerCover"] == 8_750  # 70,000 over the 8 recorded guests
        assert (out["avgSeatedMinutes"], out["medianSeatedMinutes"]) == (60, 60)
        assert out["turnover"] == 0.2
        assert out["revPash"] == round(75_000 / 800)
        assert out["seatOccupancyPct"] == 1.0  # (2·1 h + 4·1.5 h) / (40 seats × 20 h)
        assert out["guestsRecordedPct"] == 75.0
        assert {b["party"] for b in out["byParty"]} == {"1-2", "3-4"}


# ═════════════════════════════════════════════════════════════════════════════
# The endpoints, on the SQLite world
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(S, "_now", lambda: NOW)
    db = world.db

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.north_manager = user(UserRole.SHOP_MANAGER, "north", shop_id=world.other_shop.id)
    world.cashier = user(UserRole.CASHIER, "cashier", shop_id=world.shop.id)
    world.company_manager = user(UserRole.COMPANY_MANAGER, "cm", company_id=world.company.id)

    def category(name):
        c = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name=name)
        db.add(c)
        return c

    world.drinks, world.food = category("שתייה"), category("מאפים")
    db.flush()
    world.p = {}
    for name, cat, price in (
        ("קפה", world.drinks, "12.00"), ("תה", world.drinks, "10.00"), ("מיץ", world.drinks, "15.00"),
        ("קרואסון", world.food, "14.00"), ("פיתה", world.food, "5.00"), ("סלט", world.food, "40.00"),
    ):
        prod = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name=name,
            sku=f"S-{len(world.p)}", price=Decimal(price), category_id=cat.id,
            created_at=NOW - timedelta(days=300),
        )
        db.add(prod)
        world.p[name] = prod
    db.flush()
    for prod in world.p.values():
        db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=prod.id, is_listed=True))
    db.commit()
    return world


def sale(w, when, lines, *, till=None, credit=False, cashier=None):
    """A document of `lines` = [(product name, qty, unit price, line discount)] at `when` (UTC)."""
    till = till or w.tills[0]
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=uuid.uuid4().hex[:12], status=TransactionStatus.COMPLETED,
        document_type=330 if credit else 320, payment_method="cash",
        total_amount=Decimal("0"), document_discount=Decimal("0"), cashier_id=cashier,
        created_at=when, updated_at=when, server_received_at=when,
    )
    w.db.add(tx)
    gross, discount = Decimal("0"), Decimal("0")
    for name, qty, price, *rest in lines:
        prod = w.p[name]
        total = Decimal(str(qty)) * Decimal(str(price))
        line_discount = Decimal(str(rest[0])) if rest else Decimal("0")
        gross += total
        discount += line_discount
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_id=prod.id, product_name=prod.name, sku=prod.sku,
            quantity=Decimal(str(qty)), unit_price=Decimal(str(price)), total_price=total, discount=line_discount,
        ))
    tx.total_amount = gross
    tx.document_discount = discount
    w.db.flush()
    return tx


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def params(**kw):
    return R.InsightParams(**kw)


def trading_month(w):
    """28 days ending yesterday: coffee every day, croissants most days, one pita 25 days ago."""
    for i in range(1, 29):
        day = TODAY - timedelta(days=i)
        sale(w, at(day, 9), [("קפה", 2, "12.00"), ("קרואסון", 1, "14.00")])
        sale(w, at(day, 13), [("קפה", 1, "12.00")])
        sale(w, at(day, 17), [("תה", 1, "10.00"), ("קרואסון", 1, "14.00", "2.00")])
    sale(w, at(TODAY - timedelta(days=25), 11), [("פיתה", 1, "5.00")])
    w.db.commit()


class TestEndpoints:
    def test_the_feed_finds_the_dead_pita_and_the_figures_add_up(self, w):
        trading_month(w)
        out = R.get_insights_feed(p=params(), **ctx(w))
        assert out["period"]["from"] == "2026-08-30" and out["period"]["to"] == "2026-09-26"
        dead = [c for c in out["cards"] if c["type"] == "product_dead"]
        names = {c["params"]["name"]: c["params"] for c in dead}
        # Pita sold 25 days ago; juice and salad never (listed for 300 days).
        assert names["פיתה"]["days"] == 25
        assert {"מיץ", "סלט"} <= set(names) or any(c["type"] == "products_dead_more" for c in out["cards"])
        k = out["kpis"]["current"]
        # Per day: 38 + 12 + (24 − 2) = 72 ₪ net; 28 days; plus the pita on day −25 (in range).
        assert k["net"] == 28 * 7_200 + 500
        assert k["sales"] == 28 * 3 + 1
        assert k["discounts"] == 28 * 200
        assert out["availability"]["hasCost"] is False and out["availability"]["hasTables"] is False
        assert all(c["severity"] in ("critical", "warning", "opportunity", "positive", "info") for c in out["cards"])

    def test_a_sale_at_01_30_lands_on_friday_night_in_the_heatmap(self, w):
        friday = date(2026, 9, 25)
        sale(w, at(friday + timedelta(days=1), 1, 30), [("קפה", 1, "12.00")])  # Saturday 01:30 local
        w.db.commit()
        out = R.get_heatmap(p=params(days=7), **ctx(w))
        cell = next(c for c in out["cells"] if c["hour"] == 1 and c["avgNet"])
        assert cell["weekday"] == 5
        trends = R.get_trends(p=params(days=7), **ctx(w))
        assert next(d for d in trends["daily"] if d["date"] == "2026-09-25")["net"] == 1_200
        assert next(d for d in trends["daily"] if d["date"] == "2026-09-26")["net"] == 0

    def test_a_shop_manager_sees_their_shop_only(self, w):
        trading_month(w)
        sale(w, at(TODAY - timedelta(days=3), 10), [("סלט", 1, "40.00")], till=w.other_till)
        w.db.commit()
        admin = R.get_insights_kpis(p=params(), **ctx(w))["kpis"]["current"]["net"]
        mine = R.get_insights_kpis(p=params(), **ctx(w, w.manager))["kpis"]["current"]["net"]
        north = R.get_insights_kpis(p=params(), **ctx(w, w.north_manager))["kpis"]["current"]["net"]
        assert admin == mine + 4_000 and north == 4_000
        # Asking for the other shop only narrows: the manager does not get it.
        assert R.get_insights_kpis(p=params(shop_id=w.other_shop.id), **ctx(w, w.manager))["kpis"]["current"]["net"] == 0
        assert R.get_insights_kpis(p=params(machine_id=w.other_till.id), **ctx(w))["kpis"]["current"]["net"] == 4_000

    def test_costs_turn_the_menu_into_a_profit_matrix(self, w):
        trading_month(w)
        me = R.get_menu_engineering(category_id=None, by_category=True, p=params(), **ctx(w))
        assert me["mode"] == "price"
        with pytest.raises(HTTPException) as refused:
            R.put_product_cost(w.p["קפה"].id, cost=2.5, **ctx(w, w.cashier))
        assert refused.value.status_code == 403
        for name, cost in (("קפה", 2.5), ("תה", 1.0), ("קרואסון", 6.0)):
            out = R.put_product_cost(w.p[name].id, cost=cost, **ctx(w))
            assert out["cost"] == round(cost * 100)
        me = R.get_menu_engineering(category_id=None, by_category=False, p=params(), **ctx(w))
        assert me["mode"] == "cost"
        coffee = next(r for r in me["items"] if r["name"] == "קפה")
        # 12.00 incl. 18% VAT → 10.17 ex VAT; cost 2.50.
        assert coffee["avgPriceExVat"] == 1017 and coffee["margin"] == 767
        cleared = R.put_product_cost(w.p["תה"].id, cost=None, **ctx(w))
        assert cleared["cost"] is None
        assert w.db.query(ProductCost).count() == 2
        with pytest.raises(HTTPException) as bad:
            R.put_product_cost(w.p["תה"].id, cost=-1, **ctx(w))
        assert bad.value.status_code == 400

    def test_open_tables_now_counted_once_with_the_longest_seated(self, w):
        db = w.db
        zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
        db.add(zone)
        db.flush()
        tables = []
        for n in (1, 2, 3, 4):
            t = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=n, seats=4)
            db.add(t)
            tables.append(t)
        db.flush()

        def order(table, minutes, guests, total, source="synced", status="open", closed=None):
            o = TableOrder(
                id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=zone.id,
                table_number=table.number, status=status, source=source, guests=guests, total=Decimal(total),
                opened_at=NOW - timedelta(minutes=minutes), updated_at=NOW,
                closed_at=closed, paid_total=Decimal(total) if status == "paid" else None,
            )
            db.add(o)
            return o

        order(tables[0], 150, 4, "250.00")
        order(tables[0], 20, 9, "999.00", source="local")  # a stale single-till report of the same table
        order(tables[1], 30, 2, "80.00")
        # Paid yesterday after an hour at the table (the period is the complete days to yesterday).
        order(tables[2], 25 * 60, 2, "40.00", status="paid", closed=NOW - timedelta(hours=24))
        db.commit()
        out = R.get_tables_live(p=params(), **ctx(w))
        assert (out["openTables"], out["guests"], out["openAmount"]) == (2, 6, 33_000)
        assert (out["tablesTotal"], out["seatsTotal"], out["occupancyPct"]) == (4, 16, 50.0)
        assert out["longest"]["number"] == 1 and out["longest"]["minutesOpen"] == 150
        assert out["hasTables"] is True
        # The other shop's manager sees no tables of this shop.
        assert R.get_tables_live(p=params(), **ctx(w, w.north_manager))["openTables"] == 0
        period = R.get_tables_kpis(p=params(days=7), **ctx(w))
        assert period["current"]["orders"] == 1 and period["current"]["avgSeatedMinutes"] == 60

    def test_baskets_and_pairs_from_the_documents(self, w):
        trading_month(w)
        out = R.get_baskets(p=params(), **ctx(w))
        # 85 baskets: coffee+croissant 28, coffee 28, tea+croissant 28, pita 1.
        assert out["sales"] == 85
        assert out["sizes"]["baskets"] == 85
        assert out["itemsPerSale"] == round((28 * 6 + 1) / 85, 2)
        pair_names = {(p["aName"], p["bName"]) for p in out["pairs"]}
        assert ("תה", "קרואסון") in pair_names
        tea = next(p for p in out["pairs"] if p["aName"] == "תה")
        assert tea["confidence"] == 100.0 and tea["together"] == 28

    def test_voids_come_from_the_till_events(self, w):
        for i in range(25):
            sale(w, at(TODAY - timedelta(days=1 + i % 7), 10), [("קפה", 1, "12.00")], cashier="dana")
            sale(w, at(TODAY - timedelta(days=1 + i % 7), 11), [("קפה", 1, "12.00")], cashier="yossi")
        for i in range(6):
            w.db.add(TillEvent(
                id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.tills[0].id, shop_id=w.shop.id,
                event_type="line_void", occurred_at=at(TODAY - timedelta(days=2), 12), pos_user_id="dana",
                amount=Decimal("12.00"),
            ))
        w.db.commit()
        out = R.get_cashier_rates(p=params(days=7), **ctx(w))
        dana = next(r for r in out["rows"] if r["cashierId"] == "dana")
        assert dana["voidsCount"] == 6 and dana["voids"] == 7_200
        assert [f["metric"] for f in dana["flags"]] == ["void"]
        assert dana["voidPct"] == 24.0

    def test_the_forecast_weighs_the_same_weekday(self, w):
        for i, amount in enumerate(("100.00", "90.00", "80.00", "70.00")):
            sale(w, at(date(2026, 9, 21) - timedelta(days=7 * i), 12), [("סלט", 1, amount)])
        w.db.commit()
        out = R.get_forecast(p=params(), **ctx(w))
        monday = out["days"][0]
        assert monday["date"] == "2026-09-28" and monday["net"] == 9_000
        assert out["tomorrowHourly"] == [{"hour": 12, "net": 9_000, "share": 100.0, "docs": 1.0}]

    def test_days_of_cover_for_a_stocked_product(self, w):
        coffee = w.p["קפה"]
        coffee.track_stock = True
        w.db.add(StockLevel(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, product_id=coffee.id, quantity=Decimal("6")))
        for i in range(1, 29):
            sale(w, at(TODAY - timedelta(days=i), 9), [("קפה", 2, "12.00")])
        w.db.commit()
        out = R.get_stock_risk(p=params(), **ctx(w))
        (row,) = out["rows"]
        assert (row["perDay"], row["daysOfCover"], row["status"], row["suggestedOrder"]) == (2.0, 3.0, "low", 12)

    def test_slow_movers_endpoint_and_its_threshold(self, w):
        trading_month(w)
        out = R.get_slow_products(dead_days=30, p=params(), **ctx(w))
        assert "פיתה" not in {r["name"] for r in out["dead"]}  # 25 days < 30
        out = R.get_slow_products(dead_days=21, p=params(), **ctx(w))
        assert "פיתה" in {r["name"] for r in out["dead"]}

    def test_abc_over_the_period(self, w):
        trading_month(w)
        out = R.get_abc(p=params(), **ctx(w))
        assert sum(c["share"] for c in out["classes"].values()) == pytest.approx(100.0)
        assert out["items"][0]["name"] == "קפה" and out["items"][0]["class"] == "A"

    def test_the_period_is_validated(self, w):
        with pytest.raises(HTTPException) as e:
            R.get_insights_kpis(p=params(from_date=date(2026, 9, 20), to_date=date(2026, 9, 10)), **ctx(w))
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            R.get_insights_kpis(p=params(to_date=TODAY + timedelta(days=1)), **ctx(w))
        assert e.value.status_code == 400
        # "שעת סיום יום עסקי" is 0–12 (app/services/business_day.py).
        with pytest.raises(HTTPException) as e:
            R.get_insights_kpis(p=params(day_start_hour=13), **ctx(w))
        assert e.value.status_code == 400
        out = R.get_insights_kpis(p=params(from_date=date(2026, 9, 20), to_date=TODAY), **ctx(w))
        assert out["period"]["days"] == 8 and out["period"]["prevFrom"] == "2026-09-12"


# ═════════════════════════════════════════════════════════════════════════════
# The feed's rules
# ═════════════════════════════════════════════════════════════════════════════


from app.services.insights import feed as F  # noqa: E402


class TestFeedRules:
    def test_severity_order_and_the_cap(self):
        cards = [F.card("x", s, "trends", score) for s, score in (("info", 9), ("critical", 1), ("opportunity", 5), ("warning", 2), ("warning", 7))]
        cards.sort(key=lambda c: (F.SEVERITY_ORDER.index(c["severity"]), -c["score"]))
        assert [c["severity"] for c in cards] == ["critical", "warning", "warning", "opportunity", "info"]
        assert [c["score"] for c in cards][1:3] == [7, 2]

    def test_a_slow_morning_is_critical_from_40_percent_and_judged_only_when_it_can_be(self):
        base = {"weekday": 0, "asOfHour": 12, "actual": 5_000, "expectedSoFar": 10_000, "projected": 40_000,
                "expectedFull": 80_000, "judgeable": True}
        (c,) = F._pace_cards({"pace": {**base, "pacePct": -50.0}})
        assert (c["type"], c["severity"]) == ("today_slow", "critical")
        (c,) = F._pace_cards({"pace": {**base, "pacePct": -30.0}})
        assert c["severity"] == "warning"
        assert F._pace_cards({"pace": {**base, "pacePct": -20.0}}) == []
        assert F._pace_cards({"pace": {**base, "pacePct": -60.0, "judgeable": False}}) == []

    def test_the_menu_says_nothing_on_too_little_data(self):
        items = [{"key": str(i), "name": str(i), "units": 5, "net": 1000, "quadrant": q, "menuMix": 20.0, "margin": None,
                  "foodCostPct": None, "avgPrice": 200, "value": 200, "totalMargin": None}
                 for i, q in enumerate(("star", "plowhorse", "puzzle", "dog"))]
        assert F._menu_cards({"mode": "price", "n": 4, "items": items, "missingCost": []}) == []
        big = [dict(r, units=20) for r in items] + [dict(items[0], key="9", units=20)]
        out = {c["type"] for c in F._menu_cards({"mode": "price", "n": 5, "items": big, "missingCost": []})}
        assert {"menu_plowhorse", "menu_puzzle", "menu_dogs", "menu_stars", "missing_cost"} <= out
        plow = next(c for c in F._menu_cards({"mode": "price", "n": 5, "items": big, "missingCost": []}) if c["type"] == "menu_plowhorse")
        assert plow["params"]["gain"] == 50  # 5% of ₪10

    def test_an_outlier_employee_becomes_a_card_with_the_money_at_stake(self):
        cs = {"rows": [{"cashierId": "dana", "name": "דנה", "discounts": 9_000, "refunds": 0, "voids": 0,
                        "flags": [{"metric": "discount", "rate": 9.0, "team": 3.0, "times": 3.0, "level": "high"}]}]}
        (c,) = F._cashier_cards(cs)
        assert c["type"] == "cashier_discounts" and c["params"]["level"] == "high"
        assert c["score"] == 6_000  # what is above the team's rate

    def test_weak_slots_carry_their_figures(self):
        hm = {"weak": [{"weekday": 2, "fromHour": 15, "toHour": 17, "deviationPct": -40.0, "gapPerWeek": 9_600,
                        "typicalNet": 8_000, "usual": 17_600, "occurrences": 4}], "peak": []}
        (c,) = F._heatmap_cards(hm)
        assert c["params"] == {"weekday": 2, "fromHour": 15, "toHour": 17, "deviationPct": -40.0, "gapPerWeek": 9_600,
                               "typicalNet": 8_000, "usual": 17_600}


class TestTheGeneralItem:
    def test_it_counts_in_the_money_but_never_in_the_menu(self, w):
        general = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="פריט כללי", sku="GEN",
            price=Decimal("0"), category_id=w.drinks.id, is_general=True, is_open_price=True,
            created_at=NOW - timedelta(days=300),
        )
        w.db.add(general)
        w.db.flush()
        w.p["פריט כללי"] = general
        for i in range(1, 8):
            sale(w, at(TODAY - timedelta(days=i), 10), [("פריט כללי", 1, "500.00"), ("קפה", 1, "12.00")])
        w.db.commit()
        kpis = R.get_insights_kpis(p=params(days=7), **ctx(w))["kpis"]["current"]
        assert kpis["net"] == 7 * 51_200
        names = {r["name"] for r in R.get_abc(p=params(days=7), **ctx(w))["items"]}
        assert "פריט כללי" not in names and "קפה" in names
        menu = R.get_menu_engineering(category_id=None, by_category=False, p=params(days=7), **ctx(w))
        assert all(r["name"] != "פריט כללי" for r in menu["items"])
        slow = R.get_slow_products(dead_days=21, p=params(days=7), **ctx(w))
        assert all(r["name"] != "פריט כללי" for r in slow["dead"])


class TestTablesByPointOfSale:
    def test_a_till_sees_its_area_zones_and_the_shop_wide_ones(self, w):
        from app.models.shop_area import ShopArea

        db = w.db
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
        db.add(bar)
        db.flush()
        hall = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
        bar_zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר", area_id=bar.id)
        db.add_all([hall, bar_zone])
        db.flush()
        t1 = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=hall.id, number=1, seats=4)
        t2 = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=bar_zone.id, number=2, seats=2)
        db.add_all([t1, t2])
        db.flush()
        for t, zone in ((t1, hall), (t2, bar_zone)):
            db.add(TableOrder(
                id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=t.id, zone_id=zone.id,
                table_number=t.number, status="open", source="synced", guests=2, total=Decimal("50.00"),
                opened_at=NOW - timedelta(minutes=10), updated_at=NOW,
            ))
        w.tills[0].area_id = bar.id
        db.commit()
        everything = R.get_tables_live(p=params(), **ctx(w))
        assert everything["openTables"] == 2
        bar_till = R.get_tables_live(p=params(machine_id=w.tills[0].id), **ctx(w))
        assert bar_till["openTables"] == 2 and bar_till["tablesTotal"] == 2  # the bar's zone + the shop-wide hall
        no_area_till = R.get_tables_live(p=params(machine_id=w.tills[1].id), **ctx(w))
        assert no_area_till["openTables"] == 1 and no_area_till["tables"][0]["number"] == 1
        only_bar = R.get_tables_live(p=params(shop_id=w.shop.id, area_id=str(bar.id)), **ctx(w))
        assert only_bar["openTables"] == 2
        none_area = R.get_tables_live(p=params(shop_id=w.shop.id, area_id="none"), **ctx(w))
        assert none_area["openTables"] == 1
