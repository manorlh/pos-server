"""
"מצב אירוע חי" — the event's live screen (app/services/report_events/live.py,
app/routers/event_live.py, app/services/report_events/targets.py).

* the arithmetic: clock-aligned buckets, the pace forecast (warm-up, blend, band), the time to
  the target, progress;
* the live view over a small event: totals, the chart adds up to the net, documents per hour,
  the target (typed, and a targets module's provider over it), the tills online / offline,
  the top items, the vouchers (a reversed one and another till's left out), the KDS block
  (null without KDS data);
* the routes: reading follows the event's shop, the target takes a managing role and a
  positive amount, "current" lists live / soon / just-over events only;
* live push: no Ably → `enabled: false`, and a till's sync tells nobody.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import event_live as R
from app.services.report_events import live as L
from app.services.report_events import live_push as P
from app.services.report_events import targets as T
from event_live_world import END, START, at, batch, kds_order, make_event, redeem, sale, voucher
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def freeze(monkeypatch, moment):
    monkeypatch.setattr(R, "_now", lambda: moment)


def call_live(w, event, user=None, bucket=5):
    return R.get_event_live(event.id, bucket=bucket, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


# ── The arithmetic ───────────────────────────────────────────────────────────


def test_buckets_are_clock_aligned_zero_filled_and_cut_to_the_span():
    start = datetime(2026, 9, 27, 15, 2, tzinfo=timezone.utc)
    end = datetime(2026, 9, 27, 15, 23, tzinfo=timezone.utc)
    points = [(start, Decimal("10")), (start + timedelta(minutes=4), Decimal("5")),
              (datetime(2026, 9, 27, 15, 22, 59, tzinfo=timezone.utc), Decimal("-3")),
              (end, Decimal("99"))]  # at the end: outside [start, end)
    series = L.bucket_series(points, start=start, end=end, minutes=5)
    assert [p["at"][11:16] for p in series] == ["15:00", "15:05", "15:10", "15:15", "15:20"]
    assert [p["net"] for p in series] == [10.0, 5.0, 0.0, 0.0, -3.0]
    assert [p["docs"] for p in series] == [1, 1, 0, 0, 1]
    short = L.bucket_series(points, start=start, end=end, minutes=1, span_minutes=5)
    assert len(short) == 5 and short[0]["at"][11:16] == "15:18" and short[-1]["net"] == -3.0
    assert L.bucket_series(points, start=end, end=start, minutes=5) == []


def test_the_pace_blends_the_last_half_hour_with_the_whole_event():
    # 2 h in, ₪6,000 so far (₪50/min average), ₪3,000 in the last 30 min (₪100/min), 3 h to go.
    pace = L.pace_forecast(net=6000, elapsed_minutes=120, remaining_minutes=180, recent_net=3000, recent_minutes=30)
    rate = 0.6 * 100 + 0.4 * 50  # ₪80/min
    assert pace["projected"] == pytest.approx(6000 + rate * 180)
    assert pace["low"] == pytest.approx(6000 + 50 * 180)
    assert pace["high"] == pytest.approx(6000 + 100 * 180)
    assert pace["ratePerHour"] == pytest.approx(rate * 60)
    assert pace["averageRatePerHour"] == pytest.approx(3000)


def test_the_first_minutes_use_the_events_average_only_and_nothing_before_it_starts():
    warm = L.pace_forecast(net=500, elapsed_minutes=10, remaining_minutes=50, recent_net=500, recent_minutes=30)
    assert warm["ratePerHour"] == pytest.approx(3000)  # 50/min, not blended with a 10-min "recent"
    assert warm["projected"] == pytest.approx(500 + 50 * 50)
    none = L.pace_forecast(net=0, elapsed_minutes=0, remaining_minutes=60, recent_net=0, recent_minutes=30)
    assert none["projected"] is None and none["ratePerHour"] is None
    over = L.pace_forecast(net=900, elapsed_minutes=60, remaining_minutes=0, recent_net=100, recent_minutes=30)
    assert over["projected"] == 900  # ended: what is in


def test_a_slump_never_forecasts_less_than_what_is_in():
    pace = L.pace_forecast(net=1000, elapsed_minutes=60, remaining_minutes=60, recent_net=-200, recent_minutes=30)
    assert pace["projected"] >= 1000 and pace["low"] == 1000


def test_eta_and_progress():
    assert L.eta_minutes(500, 1000, 600) == 50.0
    assert L.eta_minutes(1000, 1000, 600) == 0.0
    assert L.eta_minutes(500, 1000, 0) is None
    assert L.progress_pct(250, 1000) == 25.0
    assert L.progress_pct(250, None) is None
    assert L.per_hour(30, 90) == 20.0 and L.per_hour(3, 0) is None


def test_units_of_a_redemption():
    assert L.redemption_units([{"quantity": 2}, {"quantity": "1.5"}], None) == 3.5
    assert L.redemption_units([], 3) == 3.0
    assert L.redemption_units(None, None) == 1.0


def test_a_typed_target_is_validated():
    assert T.clean_target("1500") == Decimal("1500.00")
    assert T.clean_target(None) is None and T.clean_target("") is None
    for bad in (0, -5, "abc", True, "1e12", float("nan")):
        with pytest.raises(ValueError):
            T.clean_target(bad)


# ── The live view ────────────────────────────────────────────────────────────


def _item(w, tx, name, qty, price):
    """A line by name only (no catalog product): keyed by its name."""
    w.db.add(TransactionItem(
        id=uuid.uuid4(), transaction_id=tx.id, product_id=None, product_name=name, quantity=Decimal(qty),
        unit_price=Decimal(price), total_price=Decimal(price) * Decimal(qty),
    ))
    w.db.flush()


def test_the_live_view_of_a_running_event(w, monkeypatch):
    t1, t2 = w.tills
    event = make_event(w, target=2000)
    s1 = sale(w, t1, 10, "100")
    sale(w, t1, 70, "300", discount="20")          # collected 280
    sale(w, t2, 100, "500", tip="50")
    sale(w, t2, 110, "40", credit_note=True)        # −40
    sale(w, w.other_till, 100, "999")               # not an event till
    sale(w, t1, -5, "777")                          # before the window
    _item(w, s1, "בירה", "2", "50")
    t2.last_heartbeat_at = at(100)                  # silent for 20 min at "now"
    t1.last_heartbeat_at = at(119)
    w.db.flush()
    now = at(120)
    freeze(monkeypatch, now)

    out = call_live(w, event)
    tot = out["totals"]
    assert out["phase"] == "live" and out["elapsedMinutes"] == 120 and out["remainingMinutes"] == 180
    assert tot["net"] == 100 + 280 + 500 - 40
    assert (tot["sales"], tot["docs"], tot["refunds"]) == (3, 4, 1)
    assert tot["avgTicket"] == pytest.approx(round((100 + 280 + 500) / 3, 2))
    assert tot["docsPerHour"] == 2.0 and tot["docsLastHour"] == 3 and tot["tips"] == 50
    assert sum(p["net"] for p in out["series"]) == pytest.approx(tot["net"])
    assert out["bucketMinutes"] == 5 and out["series"][0]["at"].startswith("2026-09-27T15:00")

    target = out["target"]
    assert target["amount"] == 2000 and target["source"] == "event"
    assert target["progressPct"] == pytest.approx(round(840 / 2000 * 100, 1))
    assert target["reached"] is False and target["remaining"] == 1160
    assert target["etaMinutes"] is not None and target["etaAt"] is not None

    tills = {t["machineId"]: t for t in out["tills"]}
    assert tills[str(t1.id)]["online"] is True and tills[str(t2.id)]["online"] is False
    assert tills[str(t1.id)]["net"] == 380 and tills[str(t2.id)]["net"] == 460
    assert str(w.other_till.id) not in tills
    assert out["items"]["event"][0]["name"] == "בירה" and out["items"]["event"][0]["quantity"] == 2
    assert out["items"]["lastHour"] == []  # the beer sold at minute 10
    assert out["kds"] is None  # no KDS orders in the shop
    assert out["vouchers"]["redemptions"] == 0
    assert out["canSetTarget"] is True


def test_a_targets_module_wins_over_the_typed_target(w, monkeypatch):
    event = make_event(w, target=2000)
    freeze(monkeypatch, at(60))

    def provider(db, ev):
        return Decimal("5000") if ev.id == event.id else None

    T.register_target_provider(provider)
    try:
        out = call_live(w, event)
        assert out["target"]["amount"] == 5000 and out["target"]["source"] == "targets"
    finally:
        T.unregister_target_provider(provider)

    def broken(db, ev):
        raise RuntimeError("boom")

    T.register_target_provider(broken)
    try:
        assert call_live(w, event)["target"]["source"] == "event"  # a failing provider is skipped
    finally:
        T.unregister_target_provider(broken)


def test_vouchers_redeemed_on_the_event_tills_skip_reversed_ones(w, monkeypatch):
    t1, t2 = w.tills
    event = make_event(w)
    b = batch(w, "שובר צוות")
    v1, v2, v3 = voucher(w, b), voucher(w, b), voucher(w, b)
    redeem(w, v1, t1, 30, qty=2)
    redeem(w, v1, t2, 100, qty=1)
    redeem(w, v2, t1, 110, reversed_=True)          # undone: counts nowhere
    redeem(w, v3, w.other_till, 50)                  # another shop's till
    redeem(w, v3, t1, -30)                           # before the window
    freeze(monkeypatch, at(120))
    vouchers = call_live(w, event)["vouchers"]
    assert (vouchers["redemptions"], vouchers["vouchers"], vouchers["units"], vouchers["lastHour"]) == (2, 1, 3.0, 1)
    assert vouchers["byBatch"] == [{"batchId": str(b.id), "name": "שובר צוות", "redemptions": 2, "vouchers": 1, "units": 3.0}]


def test_the_kitchen_block_when_the_shop_has_kds(w, monkeypatch):
    event = make_event(w)
    kds_order(w, released_min=100)                           # waiting 20 min at "now" (late)
    kds_order(w, released_min=115)                           # waiting 5 min
    kds_order(w, released_min=80, ready_min=92, status="ready")    # 12 min, ready within the hour
    kds_order(w, released_min=20, ready_min=30, status="ready")    # ready long ago
    kds_order(w, released_min=110, shop=w.other_shop)       # another shop
    freeze(monkeypatch, at(120))
    kds = call_live(w, event)["kds"]
    assert kds["openOrders"] == 2 and kds["lateOrders"] == 1 and kds["lateMinutes"] == 20
    assert kds["avgWaitMinutes"] == 12.5 and kds["oldestWaitMinutes"] == 20
    assert kds["readyLastHour"] == 1 and kds["avgPrepMinutesLastHour"] == 12


def test_before_and_after_the_event(w, monkeypatch):
    event = make_event(w, target=100)
    sale(w, w.tills[0], 30, "150")
    freeze(monkeypatch, START - timedelta(minutes=45))
    early = call_live(w, event)
    assert early["phase"] == "upcoming" and early["startsInMinutes"] == 45
    assert early["totals"]["net"] == 0 and early["series"] == [] and early["kds"] is None
    freeze(monkeypatch, END + timedelta(hours=1))
    late = call_live(w, event, bucket=1)
    assert late["phase"] == "ended" and late["remainingMinutes"] == 0
    assert late["totals"]["net"] == 150 and late["pace"]["projected"] == 150
    assert late["target"]["reached"] is True and late["target"]["etaAt"] is None
    assert len(late["series"]) == 120  # the last two hours, minute by minute


# ── The routes ───────────────────────────────────────────────────────────────


def _user(w, role, shop=None):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
             shop_id=shop.id if shop else None, email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:10])
    w.db.add(u)
    w.db.flush()
    return u


def test_reading_follows_the_events_shop(w, monkeypatch):
    event = make_event(w)
    freeze(monkeypatch, at(10))
    north_manager = _user(w, UserRole.SHOP_MANAGER, w.other_shop)
    with pytest.raises(HTTPException) as e:
        call_live(w, event, user=north_manager)
    assert e.value.status_code == 403
    own_cashier = _user(w, UserRole.CASHIER, w.shop)
    out = call_live(w, event, user=own_cashier)
    assert out["canSetTarget"] is False
    with pytest.raises(HTTPException) as e:
        R.get_event_live(uuid.uuid4(), bucket=5, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        call_live(w, event, bucket=15)
    assert e.value.status_code == 400


def test_setting_the_target_takes_a_managing_role_and_a_positive_amount(w):
    event = make_event(w)
    out = R.put_event_live_target(event.id, {"target": "1234.5"}, current_user=w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)
    # Written as the event's target in "יעדים ותחרות" — the one source.
    assert out["targetId"] and out["target"] == {"amount": 1234.5, "source": "targets"}
    with pytest.raises(HTTPException) as e:
        R.put_event_live_target(event.id, {"target": -3}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 422 and e.value.detail["code"] == "target_invalid"
    cashier = _user(w, UserRole.CASHIER, w.shop)
    with pytest.raises(HTTPException) as e:
        R.put_event_live_target(event.id, {"target": 10}, current_user=cashier, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 403
    cleared = R.put_event_live_target(event.id, {"target": None}, current_user=w.admin,
                                      active_tenant_id=w.tenant.id, db=w.db)
    assert cleared == {"targetId": None, "target": None}


def test_current_events_are_live_soon_or_just_over(w, monkeypatch):
    now = at(60)
    freeze(monkeypatch, now)
    live = make_event(w, name="live", tills=[])
    soon = make_event(w, name="soon", tills=[], start=now + timedelta(hours=3), end=now + timedelta(hours=5))
    make_event(w, name="far", tills=[], start=now + timedelta(days=2), end=now + timedelta(days=2, hours=2))
    over = make_event(w, name="over", tills=[], start=now - timedelta(hours=5), end=now - timedelta(hours=1))
    make_event(w, name="old", tills=[], start=now - timedelta(days=1), end=now - timedelta(hours=10))
    north = make_event(w, name="north", tills=[], shop=w.other_shop)
    out = R.get_current_live_events(shop_id=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    names = [(e["name"], e["phase"]) for e in out["events"]]
    assert names[0] == ("live", "live") and ("north", "live") in names
    assert ("soon", "upcoming") in names and ("over", "ended") in names
    assert {"far", "old"}.isdisjoint({n for n, _ in names})
    manager = _user(w, UserRole.SHOP_MANAGER, w.shop)
    mine = R.get_current_live_events(shop_id=None, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert "north" not in {e["name"] for e in mine["events"]}
    assert {e["id"] for e in mine["events"]} == {str(live.id), str(soon.id), str(over.id)}
    assert north  # (listed for the super admin above)


def test_live_push_without_ably_is_off_and_tells_nobody(w, monkeypatch):
    from app.services import ably_notify

    monkeypatch.setattr(ably_notify, "is_enabled", lambda: False)
    event = make_event(w)
    out = R.get_event_live_push(event.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out == {"enabled": False, "channel": f"dash:{w.tenant.id}:event:{event.id}"}
    assert P.notify_machine_synced(w.tenant.id, w.tills[0].id, 3) == 0


def test_live_push_finds_the_live_events_of_a_till(w):
    event = make_event(w)
    make_event(w, name="tomorrow", start=START + timedelta(days=1), end=END + timedelta(days=1))
    assert P.live_event_ids(w.db, w.tenant.id, w.tills[0].id, now=at(30)) == [event.id]
    assert P.live_event_ids(w.db, w.tenant.id, w.tills[0].id, now=END + timedelta(minutes=10)) == [event.id]
    assert P.live_event_ids(w.db, w.tenant.id, w.tills[0].id, now=END + timedelta(hours=1)) == []
    assert P.live_event_ids(w.db, w.tenant.id, w.other_till.id, now=at(30)) == []


def test_live_push_hands_a_subscribe_only_token(w, monkeypatch):
    from types import SimpleNamespace

    from app.services import ably_notify

    seen = {}

    class FakeAuth:
        def request_token(self, params):
            seen.update(params)
            return SimpleNamespace(token="tok", expires=1_900_000_000_000)

    monkeypatch.setattr(ably_notify, "is_enabled", lambda: True)
    monkeypatch.setattr(ably_notify, "_rest", lambda: SimpleNamespace(auth=FakeAuth()))
    event = make_event(w)
    out = P.token_for(event)
    channel = f"dash:{w.tenant.id}:event:{event.id}"
    assert out["enabled"] is True and out["token"] == "tok" and out["channel"] == channel
    assert seen["capability"] == {channel: ["subscribe"]}


# ── One source: "יעדים ותחרות" (feat/event-followups) ────────────────────────


def _sales_target(w, event, amount, *, scope="shop", archived=False, when=None):
    from app.models.sales_target import SalesTarget

    t = SalesTarget(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id, scope=scope,
        period="event", event_id=event.id, amount=Decimal(str(amount)),
        area_id=None, pos_user_id=None,
        archived_at=at(0) if archived else None,
    )
    if when is not None:
        t.created_at = t.updated_at = when
    w.db.add(t)
    w.db.flush()
    return t


def test_the_events_sales_target_wins_over_the_typed_one(w, monkeypatch):
    event = make_event(w, target=999)                    # typed on the screen before targets
    t1 = w.tills[0]
    sale(w, t1, 10, "300")
    sale(w, t1, 20, "50", credit_note=True)
    freeze(monkeypatch, at(60))
    assert call_live(w, event)["target"]["source"] == "event"          # no sales target: the typed one
    _sales_target(w, event, 777, archived=True)                         # archived: not the event's
    assert call_live(w, event)["target"]["amount"] == 999
    target = _sales_target(w, event, 500)
    out = call_live(w, event)["target"]
    assert out["source"] == "targets" and out["amount"] == 500 and out["targetId"] == str(target.id)
    assert out["actual"] == 250 and out["progressPct"] == 50.0 and out["reached"] is False


def test_partial_targets_are_not_the_events_and_the_latest_wins(w, monkeypatch):
    from app.services import sales_targets

    event = make_event(w)
    freeze(monkeypatch, at(30))
    old = _sales_target(w, event, 400, when=at(-120))
    new = _sales_target(w, event, 600, when=at(-60))
    assert sales_targets.event_target(w.db, event).id == new.id and old.id != new.id
    w.db.delete(new)
    w.db.delete(old)
    w.db.flush()
    from app.models.shop_area import ShopArea

    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
    w.db.add(area)
    w.db.flush()
    t = _sales_target(w, event, 300, scope="area")
    t.area_id = area.id
    w.db.flush()
    assert sales_targets.event_target(w.db, event) is None and call_live(w, event)["target"] is None


def test_setting_the_target_on_the_screen_writes_the_events_target(w, monkeypatch):
    from app.models.sales_target import SalesTarget
    from app.services import sales_targets

    event = make_event(w, target=999)
    freeze(monkeypatch, at(30))
    first = R.put_event_live_target(event.id, {"target": "1500"}, current_user=w.admin,
                                    active_tenant_id=w.tenant.id, db=w.db)
    row = w.db.get(SalesTarget, uuid.UUID(first["targetId"]))
    assert (row.scope, row.period, row.event_id, float(row.amount)) == ("shop", "event", event.id, 1500.0)
    assert w.db.get(type(event), event.id).live_target is None          # never two targets
    again = R.put_event_live_target(event.id, {"target": 1800}, current_user=w.admin,
                                    active_tenant_id=w.tenant.id, db=w.db)
    assert again["targetId"] == first["targetId"] and float(sales_targets.event_target(w.db, event).amount) == 1800
    assert w.db.query(SalesTarget).filter(SalesTarget.event_id == event.id).count() == 1
    R.put_event_live_target(event.id, {"target": None}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert sales_targets.event_target(w.db, event) is None and w.db.get(SalesTarget, row.id).archived_at is not None
    north = _user(w, UserRole.SHOP_MANAGER, w.other_shop)
    with pytest.raises(HTTPException) as e:
        R.put_event_live_target(event.id, {"target": 10}, current_user=north, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 403


def test_target_reached_has_one_source(w, monkeypatch):
    """"יעד הושג" for an event comes from "יעדים ותחרות" only: one log entry, whoever looks."""
    from app.models.exception_alerts import ExceptionLogEntry
    from app.services import sales_targets
    from app.services.exception_alerts import hooks, worker

    event = make_event(w)
    sale(w, w.tills[0], 10, "300")
    R.put_event_live_target(event.id, {"target": 250}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    freeze(monkeypatch, at(30))
    assert call_live(w, event)["target"]["reached"] is True             # the screen does not record it
    assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "target_reached").count() == 0
    recorded = []
    monkeypatch.setattr(hooks, "process", lambda bind, keys, provider=None: recorded.extend(keys) or [])
    assert sales_targets.evaluate_due(w.db, now=at(30)) == 1
    assert sales_targets.evaluate_due(w.db, now=at(31)) == 1            # reached, already recorded
    assert [name for name, _id in recorded] == ["sales_target"]          # one hit, one log source
    entry_ids = hooks.record_rows(w.db, recorded)
    entry = w.db.get(ExceptionLogEntry, entry_ids[0])
    assert entry.kind == "target_reached" and entry.details["eventId"] == str(event.id)
    # The alerts' minute pass no longer checks event targets (no second source).
    worker.run_watches(lambda: w.db)
    assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "target_reached").count() == 1


def test_the_migration_moves_typed_targets_into_sales_targets(w):
    import importlib.util
    import pathlib

    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    from app.models.sales_target import SalesTarget

    typed = make_event(w, name="typed", target=1200)
    both = make_event(w, name="both", tills=[], target=900)
    _sales_target(w, both, 2000)
    w.db.commit()
    path = next(pathlib.Path(__file__).parents[1].glob("alembic/versions/7f2e55223360_*.py"))
    spec = importlib.util.spec_from_file_location("event_targets_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    conn = w.db.connection()
    with Operations.context(MigrationContext.configure(conn)):
        module.upgrade()
        module.upgrade()  # idempotent
    w.db.expire_all()
    moved = w.db.query(SalesTarget).filter(SalesTarget.event_id == typed.id).all()
    assert [(t.scope, t.period, float(t.amount)) for t in moved] == [("shop", "event", 1200.0)]
    assert [float(t.amount) for t in w.db.query(SalesTarget).filter(SalesTarget.event_id == both.id)] == [2000.0]
    assert typed.live_target is None and both.live_target is None
