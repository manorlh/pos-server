"""
The control board's comparisons (השוואות) and the home page preference ("דף פתיחה").

* `GET /reports/overview?from=&to=` — the overview over a range, same queries;
* `GET /reports/compare` — a period against another in one request: both periods' figures
  (the overview's definitions), each change as a number and a percent, the curves aligned;
* `GET /reports/side-by-side` — 2–4 shops, points of sale, tills or cashiers;
* `GET/PUT /users/me/preferences` — the opening page, on the user, on the server.

What they must never get wrong:

* the scope: exactly the reports' (a shop manager's shop, a company manager's group), and
  asking for someone else's shop or till lists nothing of it — never its figures;
* an empty period is zeros and a change from zero is "new" (`pct` null): never a 500, never
  a division by zero (an average ticket with no sale is 0);
* a month is one request with a fixed number of queries, not thirty.

Runs on the world of tests/test_shop_areas.py (NOW = 27.09.2026 18:00 UTC = 21:00 local).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event

from app.models.pos_user import PosUser
from app.models.transaction_item import TransactionItem
from app.routers import reports as reports_router
from app.routers import users as users_router
from app.schemas.user import UserPreferencesUpdate
from app.services import period_compare as PC
from app.services import user_preferences as UP
from app.services.reports import resolve_report_window
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, create, members, open_shift, w  # noqa: F401

YESTERDAY = TODAY - timedelta(days=1)
LAST_WEEK = TODAY - timedelta(days=7)
TZ = "Asia/Jerusalem"


def item(w, tx, qty: str, total: str = "10.00"):
    w.db.add(
        TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, quantity=Decimal(qty),
            unit_price=Decimal(total), total_price=Decimal(total), product_name="Coffee",
        )
    )
    w.db.flush()


def at(tx, moment):
    tx.created_at = moment
    return tx


def compare(w, user=None, *, frm=TODAY, to=TODAY, cmp_from=None, cmp_to=None, **extra):
    args = dict(
        from_date=frm, to_date=to, cmp_from=cmp_from, cmp_to=cmp_to, granularity=None, tz=TZ,
        company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, cmp_event_id=None, items=0,
    )
    args.update(extra)
    return reports_router.get_period_compare_report(**args, **_ctx(w, user))


def side(w, kind, ids, user=None, *, frm=TODAY, to=TODAY, **extra):
    args = dict(
        kind=kind, ids=[str(i) for i in ids], from_date=frm, to_date=to, granularity=None, tz=TZ, company_id=None,
        event_id=None, shop_id=None, area_id=None, machine_id=None,
    )
    args.update(extra)
    return reports_router.get_side_by_side_report(**args, **_ctx(w, user))


def overview(w, user=None, **extra):
    args = dict(day=TODAY, tz=TZ, company_id=None, shop_id=None, machine_id=None, from_date=None, to_date=None)
    args.update(extra)
    return reports_router.get_overview_report(**args, **_ctx(w, user))


@pytest.fixture
def trading(w):
    """Today: the center sells 110 + 33.33, the north 50. Yesterday and last week: less."""
    t1, t2 = w.tills
    s1 = open_shift(w, t1, 1)
    a = w.doc(t1, s1, "100.00", discount="10.00", tip="5.00", tip_method="card")
    item(w, a, "2")
    b = w.doc(t1, s1, "40.00", method="card")
    item(w, b, "1")
    r = w.doc(t1, s1, "20.00", credit_note=True)
    item(w, r, "1")
    s2 = open_shift(w, t2, 1)
    c = w.doc(t2, s2, "33.33", legs=[("cash", "13.33"), ("card", "20.00")])
    item(w, c, "3")
    north = open_shift(w, w.other_till, 1)
    w.doc(w.other_till, north, "50.00")
    # Yesterday, 20:00 local: the center's 60 on till 1.
    at(w.doc(t1, s1, "60.00"), NOW - timedelta(days=1, hours=1))
    # Last week, same weekday, 21:00 local: 200 on till 2.
    at(w.doc(t2, s2, "200.00"), NOW - timedelta(days=7))
    w.db.commit()


class TestOverviewRange:
    def test_a_range_adds_the_days_and_a_day_is_still_a_day(self, w, trading):
        one_day = overview(w)
        assert one_day.kpis.sales_today == 193.33
        two_days = overview(w, from_date=YESTERDAY, to_date=TODAY)
        assert two_days.kpis.sales_today == 253.33
        assert (two_days.window.from_date, two_days.window.to_date) == (YESTERDAY, TODAY)
        week = overview(w, from_date=LAST_WEEK, to_date=TODAY)
        assert week.kpis.sales_today == 453.33

    def test_a_range_is_scoped_like_the_day(self, w, trading):
        out = overview(w, user=w.manager, from_date=LAST_WEEK, to_date=TODAY)
        assert out.kpis.sales_today == 403.33  # the center only: 143.33 + 60 + 200
        refused = overview(w, user=w.manager, shop_id=w.other_shop.id, from_date=LAST_WEEK, to_date=TODAY)
        assert refused.companies == [] and refused.kpis.sales_today == 0

    def test_only_from_runs_to_today_and_only_to_is_one_day(self, w, trading):
        assert overview(w, to_date=YESTERDAY).kpis.sales_today == 60.0
        # `from` alone runs to the real today, which is after the world's: every sale.
        assert overview(w, from_date=LAST_WEEK).kpis.sales_today == 453.33


class TestPeriodCompare:
    def test_the_figures_and_each_change_as_a_number_and_a_percent(self, w, trading):
        out = compare(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        cur, prev = out.current, out.previous
        assert (cur.sales, cur.gross, cur.discounts, cur.refunds) == (193.33, 223.33, 10.0, 20.0)
        assert (cur.documents, cur.sales_count, cur.refunds_count) == (5, 4, 1)
        assert (cur.cash, cur.card, cur.tips) == (133.33, 60.0, 5.0)
        assert cur.average_ticket == 53.33
        # 2 + 1 + 3 sold, 1 refunded.
        assert cur.items == 5.0
        assert (prev.sales, prev.documents, prev.items) == (60.0, 1, 0.0)
        d = out.deltas
        assert d["sales"].abs == 133.33 and d["sales"].pct == pytest.approx(222.22, abs=0.01)
        assert d["documents"].abs == 4 and d["documents"].pct == 400.0
        assert out.granularity == "hour"
        assert set(d) == set(PC.FIGURE_KEYS)

    def test_the_figures_equal_the_overviews(self, w, trading):
        out = compare(w, frm=LAST_WEEK, to=TODAY)
        assert out.current.sales == overview(w, from_date=LAST_WEEK, to_date=TODAY).kpis.sales_today

    def test_an_empty_previous_period_is_zeros_and_new_never_a_division_by_zero(self, w, trading):
        before = date(2025, 1, 1)
        out = compare(w, cmp_from=before, cmp_to=before)
        prev = out.previous
        assert (prev.sales, prev.documents, prev.items, prev.average_ticket) == (0.0, 0, 0.0, 0.0)
        assert out.deltas["sales"].pct is None and out.deltas["sales"].abs == 193.33
        assert out.deltas["averageTicket"].pct is None
        assert all(p.previous in (0.0, None) for p in out.series)

    def test_both_empty_is_no_change(self, w):
        out = compare(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert out.current.average_ticket == 0.0
        assert all(d.pct == 0.0 and d.abs == 0 for d in out.deltas.values())

    def test_without_a_comparison_there_is_no_previous(self, w, trading):
        out = compare(w)
        assert out.previous is None and out.deltas is None and out.compare_window is None
        assert all(p.previous is None for p in out.series)

    def test_both_ends_of_the_compared_period_or_neither(self, w):
        with pytest.raises(HTTPException) as e:
            compare(w, cmp_from=YESTERDAY)
        assert e.value.status_code == 400

    def test_days_are_aligned_by_the_hour(self, w, trading):
        out = compare(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert [p.index for p in out.series] == list(range(24))
        at21, at20 = out.series[21], out.series[20]
        assert at21.label == "21:00" and at21.current == 193.33 and at21.previous == 0.0
        assert at20.current == 0.0 and at20.previous == 60.0
        assert (at21.current_documents, at20.previous_documents) == (5, 1)

    def test_longer_periods_are_aligned_by_the_nth_day(self, w, trading):
        week = (TODAY - timedelta(days=6), TODAY)
        before = (week[0] - timedelta(days=7), week[1] - timedelta(days=7))
        out = compare(w, frm=week[0], to=week[1], cmp_from=before[0], cmp_to=before[1])
        assert out.granularity == "day" and len(out.series) == 7
        last = out.series[6]
        assert (last.current_date, last.previous_date) == (TODAY, LAST_WEEK)
        assert last.current == 193.33 and last.previous == 200.0
        assert out.series[5].current == 60.0  # yesterday
        assert out.current.sales == 253.33 and out.previous.sales == 200.0

    def test_a_shorter_compared_period_leaves_the_rest_empty(self, w, trading):
        out = compare(w, frm=TODAY - timedelta(days=2), to=TODAY, cmp_from=LAST_WEEK, cmp_to=LAST_WEEK)
        assert out.granularity == "day" and len(out.series) == 3
        assert out.series[0].previous == 200.0
        assert out.series[1].previous is None and out.series[1].previous_date is None

    def test_a_day_still_running_stops_at_now(self, w, trading):
        window = resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz=TZ)
        prev = resolve_report_window(w.db, w.tenant.id, from_date=YESTERDAY, to_date=YESTERDAY, tz=TZ)
        out = PC.build_period_compare(w.db, w.admin, w.tenant.id, window, prev, now=NOW)
        assert out.series[21].current == 193.33
        assert out.series[22].current is None and out.series[22].previous == 0.0

    def test_the_scope_narrows_and_never_widens(self, w, trading):
        assert compare(w, user=w.manager).current.sales == 143.33
        assert compare(w, user=w.manager, shop_id=w.other_shop.id).current.sales == 0.0
        assert compare(w, user=w.north_manager).current.sales == 50.0
        assert compare(w, user=w.company_manager).current.sales == 193.33
        assert compare(w, machine_id=w.tills[1].id).current.sales == 33.33
        assert compare(w, company_id=w.company.id).current.sales == 193.33
        assert compare(w, shop_id=w.foreign_shop.id).current.sales == 0.0

    def test_a_point_of_sale_is_the_stamped_area(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)
        s1 = open_shift(w, t1, 1)
        w.doc(t1, s1, "12.00")
        s2 = open_shift(w, t2, 1)
        w.doc(t2, s2, "8.00")
        w.db.commit()
        assert compare(w, area_id=str(bar["id"])).current.sales == 12.0
        assert compare(w, area_id="none").current.sales == 8.0

    def test_a_month_costs_the_same_queries_as_a_day(self, w, trading):
        def count(**kw):
            seen = []
            engine = w.db.get_bind()
            listener = lambda *a, **k: seen.append(1)  # noqa: E731
            event.listen(engine, "before_cursor_execute", listener)
            try:
                compare(w, **kw)
            finally:
                event.remove(engine, "before_cursor_execute", listener)
            return len(seen)

        count()  # warm: the first call loads the expired user and tenant rows
        day = count(cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        month = count(frm=TODAY - timedelta(days=29), to=TODAY, cmp_from=TODAY - timedelta(days=59), cmp_to=TODAY - timedelta(days=30))
        assert day == month


class TestPureRules:
    def test_pct_change(self):
        assert PC.pct_change(0, 0) == 0.0
        assert PC.pct_change(5, 0) is None
        assert PC.pct_change(-5, 0) is None
        assert PC.pct_change(150, 100) == 50.0
        assert PC.pct_change(50, 100) == -50.0
        assert PC.pct_change(-50, -100) == 50.0

    def test_granularity(self, w):
        day = resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz=TZ)
        week = resolve_report_window(w.db, w.tenant.id, from_date=LAST_WEEK, to_date=TODAY, tz=TZ)
        assert PC.pick_granularity(None, day, day) == "hour"
        assert PC.pick_granularity(None, day, None) == "hour"
        assert PC.pick_granularity(None, day, week) == "day"
        assert PC.pick_granularity("hour", week) == "hour"


class TestSideBySide:
    def test_tills_side_by_side(self, w, trading):
        t1, t2 = w.tills
        out = side(w, "machine", [t1.id, t2.id])
        a, b = out.entities
        assert (a.id, b.id) == (str(t1.id), str(t2.id))
        assert (a.name, a.number, b.number) == ("Till 1", "1", "2")
        assert (a.figures.sales, a.figures.documents, a.figures.items) == (110.0, 3, 2.0)
        assert (b.figures.sales, b.figures.cash, b.figures.card, b.figures.items) == (33.33, 13.33, 20.0, 3.0)
        assert a.figures.average_ticket == 65.0  # (100 + 40 - 10) / 2
        assert out.granularity == "hour" and len(out.buckets) == 24 == len(a.series)
        assert a.series[21] == 110.0 and b.series[21] == 33.33

    def test_shops_by_the_day_over_a_week(self, w, trading):
        out = side(w, "shop", [w.shop.id, w.other_shop.id], frm=LAST_WEEK, to=TODAY)
        center, north = out.entities
        assert out.granularity == "day" and len(out.buckets) == 8
        assert center.figures.sales == 403.33 and north.figures.sales == 50.0
        assert center.series[0] == 200.0 and center.series[6] == 60.0 and center.series[7] == 143.33

    def test_points_of_sale(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        kitchen = create(w, "Kitchen")
        members(w, bar["id"], t1)
        members(w, kitchen["id"], t2)
        w.doc(t1, open_shift(w, t1, 1), "12.00")
        w.doc(t2, open_shift(w, t2, 1), "8.00")
        w.db.commit()
        out = side(w, "area", [bar["id"], kitchen["id"]])
        assert [(e.name, e.figures.sales) for e in out.entities] == [("Bar", 12.0), ("Kitchen", 8.0)]

    def test_cashiers_named_only_from_what_the_scope_reads(self, w, trading):
        person = PosUser(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana",
            first_name="Dana", last_name="Levi", worker_number="7", pin_hash="x",
        )
        w.db.add(person)
        w.doc(w.tills[0], None, "30.00").cashier_id = str(person.id)
        w.doc(w.other_till, None, "20.00").cashier_id = "north-cashier"
        w.db.commit()
        out = side(w, "cashier", [person.id, "north-cashier", "nobody"])
        dana, north, nobody = out.entities
        assert (dana.name, dana.number, dana.figures.sales) == ("Dana Levi", "7", 30.0)
        assert north.found and north.figures.sales == 20.0
        assert (nobody.found, nobody.name, nobody.figures.sales) == (False, None, 0.0)
        # The center's manager does not read the north's documents: no name, no money.
        mine = side(w, "cashier", [person.id, "north-cashier"], user=w.manager)
        assert mine.entities[0].figures.sales == 30.0
        assert (mine.entities[1].found, mine.entities[1].name, mine.entities[1].figures.sales) == (False, None, 0.0)

    def test_what_the_caller_cannot_see_is_not_listed(self, w, trading):
        out = side(w, "shop", [w.shop.id, w.other_shop.id, w.foreign_shop.id], user=w.manager)
        assert [e.id for e in out.entities] == [str(w.shop.id)]
        tills = side(w, "machine", [w.tills[0].id, w.other_till.id], user=w.manager)
        assert [e.id for e in tills.entities] == [str(w.tills[0].id)]

    def test_at_most_four_and_a_known_kind(self, w):
        with pytest.raises(HTTPException) as e:
            side(w, "shop", [uuid.uuid4() for _ in range(5)])
        assert e.value.status_code == 422
        with pytest.raises(HTTPException) as e:
            side(w, "galaxy", [w.shop.id])
        assert e.value.status_code == 422
        with pytest.raises(HTTPException) as e:
            side(w, "shop", ["not-an-id"])
        assert e.value.status_code == 422

    def test_nothing_sold_is_zeros(self, w):
        out = side(w, "machine", [w.tills[0].id, w.tills[1].id])
        assert all(e.figures.sales == 0 and e.figures.average_ticket == 0 for e in out.entities)
        assert all(v == 0.0 for e in out.entities for v in e.series)


class TestHomePagePreference:
    def test_the_default_is_the_board_and_me_says_so(self, w):
        assert UP.read_preferences(w.admin, w.db) == {"homePage": "board", "simpleMode": False, "simpleModeDefault": False}
        me = users_router.get_current_user_info(current_user=w.manager, db=w.db)
        # The short menu is the manager templates' default, never a role's.
        assert me.model_dump(by_alias=True)["preferences"] == {
            "homePage": "board", "simpleMode": False, "simpleModeDefault": False,
        }

    def test_set_read_back_and_reset(self, w):
        out = users_router.update_my_preferences(
            UserPreferencesUpdate(homePage="compare"), current_user=w.manager, db=w.db
        )
        assert out.home_page == "compare" and out.home_pages[0] == "board"
        w.db.expire_all()
        assert users_router.get_my_preferences(current_user=w.manager, db=w.db).home_page == "compare"
        back = users_router.update_my_preferences(
            UserPreferencesUpdate(homePage=None), current_user=w.manager, db=w.db
        )
        assert back.home_page == "board" and w.manager.preferences is None

    def test_an_unknown_page_is_refused_and_an_unknown_stored_value_reads_as_the_board(self, w):
        with pytest.raises(HTTPException) as e:
            users_router.update_my_preferences(
                UserPreferencesUpdate(homePage="/etc/passwd"), current_user=w.manager, db=w.db
            )
        assert e.value.status_code == 422
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({"homePage": "board", "theme": "dark"})
        w.manager.preferences = {"homePage": "gone", "simpleMode": "yes"}
        assert UP.read_preferences(w.manager)["homePage"] == "board"
        assert UP.read_preferences(w.manager)["simpleMode"] is False  # the default, not the bad value

    def test_the_preference_is_the_callers_own_and_the_comparisons_are_reports(self):
        from app.services.dashboard_sections import rule_for

        assert rule_for("PUT", "/users/me/preferences").kind == "self"
        assert rule_for("GET", "/users/me/preferences").kind == "self"
        for path in ("/reports/compare", "/reports/side-by-side"):
            # A report — and what the cockpit ("הניהול שלי") reads.
            assert rule_for("GET", path).describe("GET") == "reports|cockpit:view"

    def test_the_migration_is_on_the_single_head(self):
        import pathlib

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        # One head, with these migrations on its chain (later branches chain after them at merge).
        heads = script.get_heads()
        assert len(heads) == 1
        assert {"6d818753b5ec", "3d29a3cb3cca"} <= {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("6d818753b5ec").down_revision == "6b1e9d4f2a87"
        # Written on 6d818753b5ec; re-chained after insights' e5b8d2c6a1f9 at the integration merge.
        assert script.get_revision("3d29a3cb3cca").down_revision == "e5b8d2c6a1f9"


# ── Events ("אירוע") ─────────────────────────────────────────────────────────


def make_event(w, name, shop, tills, starts, hours=3, status="draft"):
    from app.models.report_event import ReportEvent, ReportEventMachine

    e = ReportEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=shop.id, name=name,
        starts_at=starts, ends_at=starts + timedelta(hours=hours), timezone=TZ, status=status,
    )
    w.db.add(e)
    w.db.flush()
    for till in tills:
        w.db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=till.id))
    w.db.commit()
    return e


@pytest.fixture
def events(w, trading):
    t1, t2 = w.tills
    # Tonight 20:00–23:00 local on till 1; the same evening last week on till 2.
    tonight = make_event(w, "Jazz night", w.shop, [t1], NOW - timedelta(hours=1))
    last_week = make_event(w, "Jazz night 1", w.shop, [t2], NOW - timedelta(days=7, hours=1))
    north = make_event(w, "North party", w.other_shop, [w.other_till], NOW - timedelta(hours=1))
    return dict(tonight=tonight, last_week=last_week, north=north)


class TestEvents:
    def test_an_event_is_its_window_and_its_tills(self, w, events):
        out = compare(w, event_id=events["tonight"].id)
        # Till 1 tonight: 100 − 10 + 40 − 20; yesterday's 60 and till 2 are outside it.
        assert out.current.sales == 110.0 and out.current.documents == 3
        assert out.event.name == "Jazz night" and out.event.machine_ids == [str(w.tills[0].id)]
        assert (out.event.start_time, out.event.end_time) == ("20:00", "23:00")
        assert out.alignment == "elapsed" and out.granularity == "hour"

    def test_event_against_event_by_the_hours_since_each_began(self, w, events):
        out = compare(w, event_id=events["tonight"].id, cmp_event_id=events["last_week"].id)
        assert out.previous.sales == 200.0 and out.compare_event.name == "Jazz night 1"
        assert [p.label for p in out.series] == ["20:00", "21:00", "22:00"]
        assert out.series[1].current == 110.0 and out.series[1].previous == 200.0
        assert out.series[0].current == 0.0 and out.deltas["sales"].pct == -45.0

    def test_an_event_against_days(self, w, events):
        out = compare(w, event_id=events["tonight"].id, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert out.previous.sales == 60.0 and out.alignment == "elapsed"
        # Yesterday from its midnight: 24 hours, the event's 3 first.
        assert len(out.series) == 24 and out.series[3].current is None

    def test_another_shops_event_is_refused(self, w, events):
        with pytest.raises(HTTPException) as e:
            compare(w, user=w.manager, event_id=events["north"].id)
        assert e.value.status_code in (403, 404)
        with pytest.raises(HTTPException) as e:
            compare(w, event_id=uuid.uuid4())
        assert e.value.status_code == 404

    def test_the_event_list_is_the_callers_shops(self, w, events):
        def options(user=None, **kw):
            args = dict(q=None, shop_id=None, ids=None)
            args.update(kw)
            return [e.name for e in reports_router.get_event_options(**args, **_ctx(w, user)).events]

        assert set(options()) == {"Jazz night", "Jazz night 1", "North party"}
        assert set(options(user=w.manager)) == {"Jazz night", "Jazz night 1"}
        assert options(q="north") == ["North party"]
        assert set(options(shop_id=w.shop.id)) == {"Jazz night", "Jazz night 1"}

    def test_side_by_side_inside_an_event(self, w, events):
        both = make_event(w, "Both tills", w.shop, list(w.tills), NOW - timedelta(hours=1))
        out = side(w, "machine", [t.id for t in w.tills], event_id=both.id)
        assert [e.figures.sales for e in out.entities] == [110.0, 33.33]
        assert out.alignment == "elapsed" and out.buckets == ["20:00", "21:00", "22:00"]
        assert out.entities[0].series == [0.0, 110.0, 0.0]

    def test_the_items_of_both_periods(self, w, trading):
        t1 = w.tills[0]
        sale = w.doc(t1, None, "30.00")
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=sale.id, quantity=Decimal("3"), unit_price=Decimal("10"),
            total_price=Decimal("30"), discount=Decimal("5"), product_name="Tea",
        ))
        old = at(w.doc(t1, None, "10.00"), NOW - timedelta(days=1))
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=old.id, quantity=Decimal("1"), unit_price=Decimal("10"),
            total_price=Decimal("10"), product_name="Tea",
        ))
        w.db.commit()
        out = compare(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY, items=5)
        tea = next(i for i in out.top_items if i.name == "Tea")
        assert (tea.qty, tea.net, tea.previous_qty, tea.previous_net) == (3.0, 25.0, 1.0, 10.0)
        coffee = next(i for i in out.top_items if i.name == "Coffee")
        # 2 + 1 + 3 sold, 1 refunded; 10 a line, the refund's line back.
        assert coffee.qty == 5.0 and coffee.previous_qty == 0.0
        assert compare(w).top_items == []


def test_the_dashboard_offers_the_same_opening_pages():
    """client/src/lib/homePage.ts lists exactly the server's HOME_PAGES, in order."""
    import pathlib
    import re

    source = (pathlib.Path(__file__).parents[2] / "client" / "src" / "lib" / "homePage.ts").read_text(encoding="utf-8")
    block = source[source.index("export const HOME_PAGES"):]
    block = block[: block.index("];")]
    assert tuple(re.findall(r"id: '([a-z_]+)'", block)) == UP.HOME_PAGES
    assert UP.DEFAULT_HOME_PAGE == "board"


# ── Review fixes (09.10.2026) ────────────────────────────────────────────────


class TestLikeForLike:
    """A period still running is weighed against the compared one up to the same point."""

    def _windows(self, w, a, b):
        wa = resolve_report_window(w.db, w.tenant.id, from_date=a[0], to_date=a[1], tz=TZ)
        wb = resolve_report_window(w.db, w.tenant.id, from_date=b[0], to_date=b[1], tz=TZ)
        return wa, wb

    def test_today_at_21_against_yesterday_until_21(self, w, trading):
        # Yesterday 22:30 local: after the point today has reached (21:00) — not in the figures.
        at(w.doc(w.tills[0], None, "500.00"), NOW - timedelta(days=1) + timedelta(hours=1, minutes=30))
        w.db.commit()
        wa, wb = self._windows(w, (TODAY, TODAY), (YESTERDAY, YESTERDAY))
        out = PC.build_period_compare(w.db, w.admin, w.tenant.id, wa, wb, now=NOW)
        assert out.previous.sales == 60.0 and out.deltas["sales"].abs == 133.33
        # Cut at yesterday's start plus today's run: yesterday 21:00 local.
        assert out.compare_cut_at == NOW - timedelta(days=1)
        # The compared curve stays whole: its 22:00 hour is drawn.
        assert out.series[22].previous == 500.0 and out.series[22].current is None

    def test_a_week_still_running_against_the_same_point_of_the_week_before(self, w, trading):
        late = at(w.doc(w.tills[1], None, "70.00"), NOW - timedelta(days=7) + timedelta(hours=2))
        assert late is not None
        w.db.commit()
        wa, wb = self._windows(w, (TODAY - timedelta(days=6), TODAY), (TODAY - timedelta(days=13), TODAY - timedelta(days=7)))
        out = PC.build_period_compare(w.db, w.admin, w.tenant.id, wa, wb, now=NOW)
        # Last week's 21:00 sale is in, its 23:00 one is not: 200, not 270.
        assert out.previous.sales == 200.0

    def test_a_past_period_compares_whole(self, w, trading):
        at(w.doc(w.tills[0], None, "500.00"), NOW - timedelta(days=1) + timedelta(hours=1, minutes=30))
        w.db.commit()
        # The route's "now" is the real clock, long after the world's today.
        out = compare(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert out.previous.sales == 560.0 and out.compare_cut_at is None

    def test_pure_rule(self, w):
        wa, wb = self._windows(w, (TODAY, TODAY), (YESTERDAY, YESTERDAY))
        a, b = PC.Period(wa), PC.Period(wb)
        assert PC.like_for_like(a, None, NOW) is None
        cut = PC.like_for_like(a, b, NOW)
        assert cut.cut == b.start + (NOW - a.start) and cut.end == cut.cut and cut.full_end == wb.end
        # Not begun, or over: whole.
        assert PC.like_for_like(a, b, a.start - timedelta(hours=1)) is b
        assert PC.like_for_like(a, b, wa.end + timedelta(minutes=1)) is b


class TestSideBySideScope:
    def test_cashiers_compared_on_a_shop_count_that_shops_sales_only(self, w):
        w.doc(w.tills[0], None, "30.00").cashier_id = "dana"
        w.doc(w.other_till, None, "20.00").cashier_id = "dana"
        w.doc(w.other_till, None, "5.00").cashier_id = "omer"
        w.db.commit()
        everywhere = side(w, "cashier", ["dana", "omer"])
        assert [e.figures.sales for e in everywhere.entities] == [50.0, 5.0]
        center = side(w, "cashier", ["dana", "omer"], shop_id=w.shop.id)
        assert [e.figures.sales for e in center.entities] == [30.0, 0.0]
        till = side(w, "cashier", ["dana", "omer"], machine_id=w.other_till.id)
        assert [e.figures.sales for e in till.entities] == [20.0, 5.0]

    def test_a_point_of_sale_narrows_the_tills(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)
        w.doc(t1, open_shift(w, t1, 1), "12.00")
        w.doc(t2, open_shift(w, t2, 1), "8.00")
        w.db.commit()
        out = side(w, "machine", [t1.id, t2.id], area_id=str(bar["id"]))
        assert [e.figures.sales for e in out.entities] == [12.0, 0.0]


class TestTheOverviewsTotal:
    def test_a_document_with_no_shop_is_in_neither(self, w, trading):
        stray = w.doc(w.tills[0], None, "999.00")
        stray.shop_id = None
        w.db.commit()
        assert compare(w).current.sales == overview(w).kpis.sales_today == 193.33


class TestPostgresBuckets:
    """The Postgres SQL itself (the tests run on SQLite): local hour, local date, hours since a start."""

    class _PgDb:
        class _Bind:
            class dialect:  # noqa: N801
                name = "postgresql"

        def get_bind(self):
            return self._Bind()

    def _sql(self, expr):
        from sqlalchemy import select
        from sqlalchemy.dialects import postgresql

        return str(select(expr).compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))

    def test_clock_and_elapsed_buckets(self, w):
        wa = resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz=TZ)
        period = PC.Period(wa)
        hour = self._sql(PC._bucket_expr(self._PgDb(), period, "hour", "clock"))
        assert "EXTRACT(hour FROM timezone('Asia/Jerusalem', transactions.created_at))" in hour
        day = self._sql(PC._bucket_expr(self._PgDb(), period, "day", "clock"))
        assert "CAST(timezone('Asia/Jerusalem', transactions.created_at) AS DATE)" in day
        elapsed = self._sql(PC._bucket_expr(self._PgDb(), period, "hour", "elapsed"))
        assert "floor((EXTRACT(epoch FROM transactions.created_at) -" in elapsed and "3600.0" in elapsed
        # Back from the database: an hour, a date, an elapsed count.
        assert PC._bucket_index(self._PgDb(), period, "hour", "clock", 21) == 21
        assert PC._bucket_index(self._PgDb(), period, "day", "clock", TODAY) == 0
        assert PC._bucket_index(self._PgDb(), period, "hour", "elapsed", 3) == 3


class TestEventById:
    def test_an_event_named_by_id_is_listed_even_past_the_newest(self, w, events, monkeypatch):
        monkeypatch.setattr(PC, "EVENT_OPTIONS_MAX", 1)
        names = lambda **kw: [e.name for e in reports_router.get_event_options(  # noqa: E731
            **{"q": None, "shop_id": None, "ids": None, **kw}, **_ctx(w)
        ).events]
        assert len(names()) == 1
        assert names(ids=[events["last_week"].id]) == ["Jazz night 1"]
        # Never another organization's, nor a shop the caller cannot see.
        assert reports_router.get_event_options(
            q=None, shop_id=None, ids=[events["north"].id], **_ctx(w, w.manager)
        ).events == []
