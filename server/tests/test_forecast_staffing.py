"""
"תחזית ואיוש" — the forecast per shop and the tills to open (app/services/insights/staffing.py,
GET /insights/staffing).

* the arithmetic: the observed capacity per till (75th percentile of busy hours, a default
  without history), tills to open (≥ 1 when anything is expected, capped at what the shop has
  — and said so), the trend (recent days against their own forecasts, clamped), today's pace
  as a factor, the next hours (the current hour's remaining part only), the holiday hook;
* the endpoint on the SQLite world: five weeks of a shop's history give tomorrow by the hour
  with the tills, the next hours of today, the capacity; another shop's manager sees only
  their shop.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from app.models.transaction import Transaction, TransactionStatus
from app.models.user import User, UserRole
from app.routers import forecast_staffing as R
from app.routers.insights import InsightParams
from app.services.insights import analytics as A
from app.services.insights import service as S
from app.services.insights import staffing as ST
from shift_world import NOW, accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
#: NOW is Sunday 2026-09-27 18:00 UTC = 21:00 local; tomorrow is Monday 2026-09-28.
TODAY = date(2026, 9, 27)


def local(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=JLM).astimezone(timezone.utc)


# ── The arithmetic ───────────────────────────────────────────────────────────


def test_percentile_and_capacity():
    assert ST.percentile([1, 2, 3, 4], 0.75) == pytest.approx(3.25)
    assert ST.percentile([], 0.5) is None
    few = {(TODAY, h): {"a": 10} for h in range(5)}
    assert ST.capacity_per_till(few) == (ST.DEFAULT_CAPACITY, "default")
    busy = {(TODAY - timedelta(days=d), 10): {"a": 12, "b": 8} for d in range(10)}   # 10 a till
    busy.update({(TODAY - timedelta(days=d), 12): {"a": 2} for d in range(10)})      # quiet: not counted
    assert ST.capacity_per_till(busy) == (10.0, "history")


def test_tills_to_open():
    assert ST.tills_needed(0, 20, 3) == (0, False)
    assert ST.tills_needed(3, 20, 3) == (1, False)
    assert ST.tills_needed(33, 20, 3) == (3, False)       # 33 / 16 → 3
    assert ST.tills_needed(80, 20, 3) == (3, True)        # would need 5: short
    assert ST.tills_needed(80, 20, 0) == (5, False)       # no tills known: the need itself


def test_pace_and_trend_factors():
    assert ST.pace_factor({"judgeable": True, "actual": 1500, "expectedSoFar": 1000}) == 1.5
    assert ST.pace_factor({"judgeable": True, "actual": 5000, "expectedSoFar": 1000}) == ST.PACE_CLAMP[1]
    assert ST.pace_factor({"judgeable": False, "actual": 1, "expectedSoFar": 1}) is None
    assert ST.pace_factor(None) is None
    steady = {TODAY - timedelta(days=i): A.Cell(net=100_00, docs=10) for i in range(1, 64)}
    assert ST.trend_factor(steady, today=TODAY, history_start=TODAY - timedelta(days=63)) == 1.0
    rising = dict(steady)
    for i in range(1, 15):
        rising[TODAY - timedelta(days=i)] = A.Cell(net=150_00, docs=15)
    assert ST.trend_factor(rising, today=TODAY, history_start=TODAY - timedelta(days=63)) == ST.TREND_CLAMP[1]
    assert ST.trend_factor({}, today=TODAY, history_start=None) is None


def test_the_next_hours_count_only_what_is_left():
    days = [TODAY - timedelta(days=7 * k) for k in range(1, 5)]
    hourly = {}
    for d in days:
        hourly[(d, 21)] = A.Cell(net=400_00, docs=40)
        hourly[(d, 22)] = A.Cell(net=200_00, docs=20)
    rows = ST.next_hours(hourly, sample_days=days, now_slot=17, now_fraction=0.5, day_start_hour=4, factor=1.0)
    assert [(r["hour"], r["net"], r["docs"], r["partial"]) for r in rows] == [(21, 200_00, 20.0, True), (22, 200_00, 20.0, False)]
    doubled = ST.next_hours(hourly, sample_days=days, now_slot=18, now_fraction=0.0, day_start_hour=4, factor=2.0)
    assert doubled == [{"hour": 22, "net": 400_00, "docs": 40.0, "partial": True}]


def test_the_holiday_hook():
    def calendar(day, shop_id):
        return {"name": "ראש השנה", "factor": 0.2} if day == date(2026, 9, 28) else None

    ST.register_holiday_provider(calendar)
    try:
        assert ST.holiday_for(date(2026, 9, 28)) == {"name": "ראש השנה", "factor": 0.2}
        assert ST.holiday_for(date(2026, 9, 29)) is None
    finally:
        ST.unregister_holiday_provider(calendar)
    assert ST.holiday_for(date(2026, 9, 28)) is None


# ── The endpoint ─────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(S, "_now", lambda: NOW)
    return world


def _doc(w, till, when, total="10.00"):
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=uuid.uuid4().hex[:12], status=TransactionStatus.COMPLETED, document_type=320,
        payment_method="cash", total_amount=Decimal(total), document_discount=Decimal("0"),
        created_at=when, updated_at=when, server_received_at=when,
    )
    w.db.add(tx)


def five_weeks(w):
    """Every day for 35 days: 10:00 — till 1 six documents, till 2 four; 13:00 — till 1 three."""
    t1, t2 = w.tills
    for i in range(1, 36):
        day = TODAY - timedelta(days=i)
        for n in range(6):
            _doc(w, t1, local(day, 10, n * 5))
        for n in range(4):
            _doc(w, t2, local(day, 10, n * 5 + 1))
        for n in range(3):
            _doc(w, t1, local(day, 13, n * 5))
    w.db.commit()


def call(w, user=None, **kw):
    return R.get_forecast_staffing(p=InsightParams(**kw), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def test_tomorrow_by_the_hour_with_the_tills(w):
    five_weeks(w)
    out = call(w, shop_id=w.shop.id)
    assert [s["shopName"] for s in out["shops"]] == ["Center"]
    shop = out["shops"][0]
    assert shop["availableTills"] == 2 and shop["capacityPerTill"] == 5.0 and shop["capacitySource"] == "history"
    assert shop["trendFactor"] == 1.0
    tomorrow = shop["tomorrow"]
    assert tomorrow["date"] == "2026-09-28" and tomorrow["net"] == 130_00 and tomorrow["confidence"] == "high"
    hours = {h["hour"]: h for h in tomorrow["hourly"]}
    assert set(hours) == {10, 13}
    assert hours[10]["net"] == 100_00 and hours[10]["docs"] == 10
    assert (hours[10]["tills"], hours[10]["short"]) == (2, True)   # 10 ÷ (5 × 80%) → 3, the shop has 2
    assert (hours[13]["tills"], hours[13]["short"]) == (1, False)
    assert tomorrow["peakTills"] == 2 and tomorrow["short"] is True
    assert out["totals"]["tomorrowNet"] == 130_00
    # 21:00 local: nothing usual left today.
    assert shop["today"]["nextHours"] == [] and shop["today"]["actual"] == 0


def test_each_manager_sees_their_own_shops(w):
    five_weeks(w)
    north = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="n@x", username="north",
                 shop_id=w.other_shop.id)
    w.db.add(north)
    w.db.commit()
    out = call(w, user=north)
    assert [s["shopName"] for s in out["shops"]] == ["North"]
    shop = out["shops"][0]
    assert shop["tomorrow"]["net"] is None and shop["tomorrow"]["hourly"] == []
    assert shop["capacitySource"] == "default"
    everyone = call(w)
    assert {s["shopName"] for s in everyone["shops"]} == {"Center", "North"}
