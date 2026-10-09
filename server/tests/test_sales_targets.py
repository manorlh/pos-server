"""
"יעדים ותחרות" — sales targets, progress with the pace forecast, "יעד הושג", the till's
leaderboard (app/services/sales_targets.py, app/routers/targets.py).

The ways it could mislead the owner: money that is not the per-cashier report's net, a forecast
that shouts a number at 08:05, a target reached alerted every minute, a dated target losing to the
every-day one, an area or a cashier counted from the wrong documents, another shop's cashiers on
the leaderboard.

Runs on the world of tests/test_shop_areas.py (documents at 21:00 Israel time on 27.09.2026).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.pos_user import PosUser, PosUserRole
from app.models.sales_target import SalesTarget, SalesTargetHit
from app.routers import targets as R
from app.services import sales_targets as svc
from app.services.exception_alerts import sources as SRC
from shift_world import NOW, TODAY
from test_shop_areas import create, open_shift, w  # noqa: F401

D = Decimal


def test_the_pace_spreads_the_net_over_the_hours_elapsed():
    start = datetime(2026, 9, 27, 5, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=15)
    assert svc.pace(D("500"), start, end, start + timedelta(hours=7, minutes=30)).forecast == D("1000.00")
    assert svc.pace(D("50"), start, end, start + timedelta(minutes=20)).forecast is None, "too early to say"
    assert svc.pace(D("700"), start, end, end + timedelta(hours=1)).forecast == D("700")


def test_the_trading_window_is_local_and_dst_safe():
    a, b = svc.day_window(date(2026, 10, 25), "08:00", "23:00", "Asia/Jerusalem")
    assert (a, b) == (datetime(2026, 10, 25, 6, 0, tzinfo=timezone.utc), datetime(2026, 10, 25, 21, 0, tzinfo=timezone.utc))
    a, b = svc.day_window(date(2026, 10, 9), "18:00", "02:00", "Asia/Jerusalem")
    assert b - a == timedelta(hours=8), "a bar's night runs past midnight"


def test_a_targets_day_is_the_business_day_four_to_four_and_a_long_night_counts_once():
    z, day, utc = "Asia/Jerusalem", date(2026, 10, 9), timezone.utc
    # The business day (IDT, UTC+3): 04:00 on the 9th to 04:00 on the 10th — for every window,
    # crossing midnight or not (a sale at 00:30 after an ordinary day is still that day's).
    four_to_four = (datetime(2026, 10, 9, 1, 0, tzinfo=utc), datetime(2026, 10, 10, 1, 0, tzinfo=utc))
    assert svc.trading_range(day, "08:00", "23:00", z) == four_to_four
    assert svc.trading_range(day, "18:00", "02:00", z) == four_to_four
    # A night past 04:00 (20:00–05:00): the money runs to 05:00, and the next day starts there.
    assert svc.trading_range(day, "20:00", "05:00", z) == (datetime(2026, 10, 9, 2, 0, tzinfo=utc), datetime(2026, 10, 10, 2, 0, tzinfo=utc))
    assert svc.still_open_from(day, "20:00", "05:00", z, datetime(2026, 10, 10, 1, 30, tzinfo=utc))  # 04:30 local
    assert not svc.still_open_from(day, "20:00", "05:00", z, datetime(2026, 10, 10, 2, 30, tzinfo=utc))  # 05:30
    assert not svc.still_open_from(day, "18:00", "02:00", z, datetime(2026, 10, 9, 22, 30, tzinfo=utc)), "the business day covers it"


def _target(w, amount, **kw):
    row = SalesTarget(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=kw.pop("shop", w.shop).id,
        scope=kw.pop("scope", "shop"), period=kw.pop("period", "day"), amount=D(str(amount)), **kw,
    )
    w.db.add(row)
    w.db.commit()
    return row


@pytest.fixture
def trading(w):  # noqa: F811
    t1, t2 = w.tills
    s1 = open_shift(w, t1, 1)
    a = w.doc(t1, s1, "100.00", discount="10.00")
    b = w.doc(t1, s1, "40.00")
    c = w.doc(t1, s1, "20.00", credit_note=True)
    dana = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana", first_name="דנה", pin_hash="x", role=PosUserRole.CASHIER)
    w.db.add(dana)
    w.db.flush()
    a.cashier_id = b.cashier_id = str(dana.id)
    s2 = open_shift(w, t2, 1)
    w.doc(t2, s2, "300.00")
    other = open_shift(w, w.other_till, 1)
    w.doc(w.other_till, other, "999.00")
    w.db.commit()
    w.dana, w.s1 = dana, s1
    return w


class TestProgress:
    def test_the_net_is_the_reports_and_the_forecast_says_where_today_ends(self, trading):
        t = _target(trading, 1000)
        p = svc.progress_of(trading.db, t, now=NOW, day=TODAY)
        assert p["actual"] == 410.0, "100 − 10 + 40 − 20 + 300; another shop's 999 is not here"
        assert p["percent"] == 41.0
        # 21:00 local in an 08:00–23:00 day: 13 of 15 hours.
        assert p["forecast"] == pytest.approx(410 / (13 / 15), abs=0.01)
        assert p["forecastReaches"] is False and p["reached"] is False

    def test_reached_once_however_often_it_is_read(self, trading):
        t = _target(trading, 400)
        for _ in range(3):
            assert svc.progress_of(trading.db, t, now=NOW, day=TODAY)["reached"] is True
            trading.db.commit()
        assert trading.db.query(SalesTargetHit).count() == 1
        hit = trading.db.query(SalesTargetHit).one()
        spec = SRC.by_name("sales_target").build(SRC.Ctx(trading.db), hit)[0]
        assert (spec.kind, spec.amount, spec.threshold) == ("target_reached", D("410.00"), D("400.00"))

    def test_a_dated_target_beats_the_every_day_one(self, trading):
        _target(trading, 1000)
        _target(trading, 500, day=TODAY)
        rows = svc.progress(trading.db, [trading.shop.id], day=TODAY, now=NOW)
        assert [r["amount"] for r in rows if r["scope"] == "shop"] == [500.0]
        rows = svc.progress(trading.db, [trading.shop.id], day=TODAY + timedelta(days=1), now=NOW)
        assert [r["amount"] for r in rows if r["scope"] == "shop"] == [1000.0]

    def test_an_area_counts_the_shifts_stamped_with_it(self, trading):
        from app.models.shift import Shift

        bar = create(trading, "Bar")
        bar_id = uuid.UUID(str(bar["id"]))
        # The area a shift was stamped with when it opened, never the till's area now.
        trading.db.query(Shift).filter(Shift.machine_id == trading.tills[1].id).update({Shift.area_id: bar_id})
        trading.db.commit()
        t = _target(trading, 100, scope="area", area_id=bar_id)
        assert svc.progress_of(trading.db, t, now=NOW, day=TODAY)["actual"] == 300.0

    def test_at_one_in_the_morning_a_bar_is_still_on_last_nights_target(self, trading):
        _target(trading, 1000, day_start="18:00", day_end="02:00")
        rows = svc.progress(trading.db, [trading.shop.id], now=NOW + timedelta(hours=4))  # 01:00 local
        shop = next(r for r in rows if r["scope"] == "shop")
        assert shop["periodKey"] == TODAY.isoformat() and shop["actual"] == 410.0
        # 03:00 is still that business day (it starts at 04:00); 05:00 is the next one.
        rows = svc.progress(trading.db, [trading.shop.id], now=NOW + timedelta(hours=6))
        assert next(r for r in rows if r["scope"] == "shop")["periodKey"] == TODAY.isoformat()
        rows = svc.progress(trading.db, [trading.shop.id], now=NOW + timedelta(hours=8))
        assert next(r for r in rows if r["scope"] == "shop")["periodKey"] == (TODAY + timedelta(days=1)).isoformat()

    def test_a_cashier_counts_their_documents(self, trading):
        t = _target(trading, 100, scope="cashier", pos_user_id=trading.dana.id)
        p = svc.progress_of(trading.db, t, now=NOW, day=TODAY)
        assert p["actual"] == 130.0 and p["reached"] is True and "דנה" in p["label"]


class TestLeaderboard:
    def test_the_shops_cashiers_ranked_and_the_shop_target(self, trading):
        _target(trading, 1000)
        out = svc.leaderboard(trading.db, trading.tills[0], now=NOW)
        assert out["cashiers"][0]["name"] == "דנה" and out["cashiers"][0]["value"] == 130.0
        assert out["target"]["amount"] == 1000.0
        assert all(c["value"] != 999.0 for c in out["cashiers"]), "never another shop's"


class TestWriting:
    def test_validation(self, trading):
        with pytest.raises(HTTPException) as refused:
            svc.validate(trading.db, trading.shop, {"amount": 0})
        assert refused.value.detail["code"] == "amount_must_be_positive"
        foreign = create(trading, "Far", shop=trading.other_shop)
        with pytest.raises(HTTPException):
            svc.validate(trading.db, trading.shop, {"amount": 10, "scope": "area", "areaId": foreign["id"]})

    def test_a_shop_manager_sets_targets_for_their_shop_only(self, trading):
        out = R.create_target({"shopId": str(trading.shop.id), "amount": 2500}, current_user=trading.manager,
                              active_tenant_id=trading.tenant.id, db=trading.db)
        assert out["label"].startswith("יעד")
        with pytest.raises(HTTPException) as refused:
            R.create_target({"shopId": str(trading.other_shop.id), "amount": 10}, current_user=trading.manager,
                            active_tenant_id=trading.tenant.id, db=trading.db)
        assert refused.value.status_code == 403


def test_the_targets_migration_chains_after_the_stock_one():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert len(script.get_heads()) == 1
    assert script.get_revision("af7b5d2e4c96").down_revision == "7c4e2a9d1f63"
