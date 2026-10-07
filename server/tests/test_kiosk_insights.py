"""
"ביצועי קיוסקים" and "תקינות מכשירים" — docs/SPEC_KIOSK_INSIGHTS.md.

* **The funnel's events** (app/services/kiosk_funnel.py): a batch sent twice changes nothing;
  batches out of order fold into the same session; a bad event is dropped alone; nothing
  personal survives (`data` keeps only its type's keys); a till that is not a kiosk is refused.
* **The report** (app/services/kiosk_insights.py, `GET /insights/kiosks`): the funnel by the
  furthest step, where unpaid sessions were left and why, the median time to order, the basket
  from the paid kiosk orders (an order still open at the till is no sale), upsell by rule,
  payment failures by reason, orders by hour, top items from the kiosk's own documents, per
  kiosk, the period before; a shop manager sees their shop only.
* **Device health** (app/services/kiosk_health.py, `GET /kiosks/health`): the kiosk's own
  `status.health` cleaned; each part's level (offline, card lock, no paper, unprinted bons,
  the till link, KDS screens, media, stuck uploads); the drawer's last events; "KDS לא מחובר"
  routed to the tills like the other kiosk alerts, gone once a screen is back.
* **Step modes** (kiosk_config `payment.stepModes`): defaults, validation with paths, the
  effective mode (each step's own switch first), per shop and per kiosk layers.
* **The pre-payment check** (app/services/kiosk_basket_check.py): unavailable, price changed,
  category off, not on the kiosk, the promotions' ETag.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.category import Category
from app.models.kiosk import KioskDevice, KioskOrder
from app.models.kiosk_insights import KioskEvent, KioskSession
from app.models.kiosk_ops import KioskAlert
from app.models.menu import UpsellRule
from app.models.product import Product
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import insights as IR
from app.routers import kiosk_insights as R
from app.routers import kiosks as KR
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.services import ably_notify
from app.services import kiosk_config as C
from app.services import kiosk_control as KC
from app.services import kiosk_funnel as F
from app.services import kiosk_health as H
from app.services import kiosk_ops as OPS
from app.services.insights import service as S
from shift_world import NOW, accept_str_uuids, make_world

UTC = timezone.utc
#: NOW is Sunday 2026-09-27 18:00 UTC (21:00 in Jerusalem): business day 2026-09-27.
TODAY = date(2026, 9, 27)
DAY = date(2026, 9, 24)


def at(day: date, hour: int, minute: int = 0, second: int = 0) -> datetime:
    """`hour:minute` local (Jerusalem, UTC+3 in September) on `day`, in UTC."""
    return datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=UTC) - timedelta(hours=3)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(S, "_now", lambda: NOW)
    world.woken = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant, machine, event, body: world.woken.append((machine, body.get("reason"))),
    )
    for name in ("publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    # The pinpad set for the kiosk is the one connected (no card lock), unless a test says otherwise.
    from app.services import terminal_status

    monkeypatch.setattr(terminal_status, "card_lock_status", lambda machine, settings: None)
    db = world.db
    world.kiosk, world.main = world.tills
    KR.create_kiosk(
        body=KioskCreateIn(machineId=world.kiosk.id, name="קיוסק רויאל", controllerMachineIds=[str(world.main.id)]),
        current_user=world.admin, active_tenant_id=world.tenant.id, db=db,
    )
    world.north_kiosk = world.other_till
    KR.create_kiosk(
        body=KioskCreateIn(machineId=world.north_kiosk.id, name="קיוסק צפון"),
        current_user=world.admin, active_tenant_id=world.tenant.id, db=db,
    )
    world.manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id, email="m@x", username="m", shop_id=world.shop.id)
    world.cashier = User(id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=world.tenant.id, email="c@x", username="c", shop_id=world.shop.id)
    db.add_all([world.manager, world.cashier])
    world.drinks = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="שתייה")
    world.food = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="אוכל")
    db.add_all([world.drinks, world.food])
    db.flush()
    world.p = {}
    for name, cat, price in (("קפה", world.drinks, "12.00"), ("קולה", world.drinks, "9.00"), ("בורגר", world.food, "52.00"), ("צ'יפס", world.food, "18.00")):
        prod = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name=name,
            sku=f"S-{len(world.p)}", price=Decimal(price), category_id=cat.id, created_at=NOW - timedelta(days=100),
        )
        db.add(prod)
        world.p[name] = prod
    db.flush()
    world.ovr = {}
    for name, prod in world.p.items():
        o = ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=prod.id, is_listed=True)
        db.add(o)
        world.ovr[name] = o
    world.rule = UpsellRule(
        id=uuid.uuid4(), tenant_id=world.tenant.id, name="צ'יפס לבורגר", trigger_type="product",
        trigger_ids=[str(world.p["בורגר"].id)], product_id=world.p["צ'יפס"].id, place="quick,tables,kiosk",
    )
    db.add(world.rule)
    db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def ev(sid, seq, kind, when, step=None, elapsed=None, **data):
    e = {"sessionId": sid, "seq": seq, "type": kind, "at": iso(when)}
    if step:
        e["step"] = step
    if elapsed is not None:
        e["elapsedMs"] = elapsed
    if data:
        e["data"] = data
    return e


def paid_session(sid, start, *, order_sec=95, basket=6400, upsell=None, declines=0):
    """A customer who ordered a burger, maybe took the chips, and paid (after `declines` declined cards)."""
    out = [
        ev(sid, 0, "session_start", start, "attract", 0, platform="android"),
        ev(sid, 1, "screen", start + timedelta(seconds=4), "service", 4000),
        ev(sid, 2, "screen", start + timedelta(seconds=8), "catalog", 8000, service="take_away"),
        ev(sid, 3, "item_open", start + timedelta(seconds=20), "catalog", 20000, productId="burger"),
        ev(sid, 4, "item_add", start + timedelta(seconds=30), "catalog", 30000, productId="burger", qty=1),
    ]
    seq = 5
    if upsell is not None:
        out.append(ev(sid, seq, "upsell", start + timedelta(seconds=31), "catalog", 31000, ruleId=upsell[0], action="shown", moment="item"))
        out.append(ev(sid, seq + 1, "upsell", start + timedelta(seconds=33), "catalog", 33000, ruleId=upsell[0], action=upsell[1], moment="item", productId=upsell[2]))
        seq += 2
    out += [
        ev(sid, seq, "screen", start + timedelta(seconds=40), "cart", 40000),
        ev(sid, seq + 1, "screen", start + timedelta(seconds=50), "tip", 50000),
        ev(sid, seq + 2, "screen", start + timedelta(seconds=60), "pay", 60000),
    ]
    seq += 3
    for i in range(declines):
        out.append(ev(sid, seq, "pay", start + timedelta(seconds=61 + i), "pay", 61000 + i, result="started", method="card", amountAgorot=basket))
        out.append(ev(sid, seq + 1, "pay", start + timedelta(seconds=62 + i), "pay", 62000 + i, result="declined", reason="insufficient_funds"))
        seq += 2
    out += [
        ev(sid, seq, "pay", start + timedelta(seconds=70), "pay", 70000, result="started", method="card", amountAgorot=basket),
        ev(sid, seq + 1, "pay", start + timedelta(seconds=order_sec), "pay", order_sec * 1000, result="approved", amountAgorot=basket),
        ev(sid, seq + 2, "session_end", start + timedelta(seconds=order_sec + 12), "success", order_sec * 1000 + 12000,
           reason="paid", basketAgorot=basket, items=2, durationMs=order_sec * 1000 + 12000),
    ]
    return out


def left_session(sid, start, last_step, reason="timeout"):
    steps = ["service", "catalog", "cart", "details", "pay"]
    out = [ev(sid, 0, "session_start", start, "attract", 0)]
    seq = 1
    for i, s in enumerate(steps[: steps.index(last_step) + 1]):
        out.append(ev(sid, seq, "screen", start + timedelta(seconds=5 * (i + 1)), s, 5000 * (i + 1)))
        seq += 1
    out.append(ev(sid, seq, "session_end", start + timedelta(seconds=90), last_step, 90000, reason=reason))
    return out


def order(w, local_id, paid_at, total, *, items=2, tip=0, machine=None, open_state=None, pay_at_till=False):
    machine = machine or w.kiosk
    row = KioskOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=machine.id, shop_id=machine.shop_id, local_id=local_id,
        pickup_number=1, pickup_label="A-1", business_date=paid_at.date(), service_type="take_away",
        fulfillment_mode="BON", item_count=items, total_agorot=total, tip_agorot=tip,
        paid_at=None if open_state == "open" else paid_at, bon_status="printed", receipt_status="printed",
        status="paid", pay_at_till=pay_at_till, open_state=open_state,
    )
    w.db.add(row)
    w.db.flush()
    return row


def kiosk_sale(w, when, lines, machine=None):
    machine = machine or w.kiosk
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=machine.id, shop_id=machine.shop_id,
        transaction_number=uuid.uuid4().hex[:12], status=TransactionStatus.COMPLETED, document_type=320,
        payment_method="card", total_amount=Decimal("0"), document_discount=Decimal("0"),
        created_at=when, updated_at=when, server_received_at=when,
    )
    w.db.add(tx)
    gross = Decimal("0")
    for name, qty, price in lines:
        prod = w.p[name]
        total = Decimal(str(qty)) * Decimal(str(price))
        gross += total
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_id=prod.id, product_name=prod.name, sku=prod.sku,
            quantity=Decimal(str(qty)), unit_price=Decimal(str(price)), total_price=total, discount=Decimal("0"),
        ))
    tx.total_amount = gross
    w.db.flush()
    return tx


def ingest(w, events, machine=None, now=NOW):
    out = F.ingest(w.db, machine or w.kiosk, events, now=now)
    w.db.commit()
    return out


# ═════════════════════════════════════════════════════════════════════════════
# The funnel's events
# ═════════════════════════════════════════════════════════════════════════════


class TestEvents:
    def test_a_batch_sent_twice_changes_nothing(self, w):
        batch = paid_session("s1", at(DAY, 12), upsell=(str(w.rule.id), "accepted", str(w.p["צ'יפס"].id)))
        first = ingest(w, batch)
        assert first == {"accepted": len(batch), "duplicates": 0, "rejected": 0}
        again = ingest(w, batch)
        assert again == {"accepted": 0, "duplicates": len(batch), "rejected": 0}
        assert w.db.query(KioskEvent).count() == len(batch)
        row = w.db.query(KioskSession).one()
        assert row.paid and row.end_reason == "paid" and row.max_rank == F.RANK_PAID
        assert row.order_ms == 95_000 and row.basket_agorot == 6400 and row.items == 2
        assert row.upsell_shown == 1 and row.upsell_accepted == 1 and row.pay_attempts == 1 and row.pay_failures == 0
        assert row.platform == "android" and row.service == "take_away"
        assert row.steps.split(",")[:3] == ["attract", "service", "catalog"]

    def test_batches_out_of_order_fold_into_one_session(self, w):
        events = left_session("s2", at(DAY, 13), "cart")
        ingest(w, events[3:])  # the end first, without the start
        row = w.db.query(KioskSession).one()
        assert row.end_reason == "timeout" and row.last_step == "cart"
        # Started 15 s before its first event here (elapsedMs), until the start arrives.
        ingest(w, events[:3])
        row = w.db.query(KioskSession).one()
        assert row.started_at.replace(tzinfo=UTC) == at(DAY, 13)
        assert row.last_step == "cart" and row.max_rank == F.STEP_RANK["cart"] and not row.paid

    def test_bad_events_are_dropped_alone_and_nothing_personal_is_kept(self, w):
        good = ev("s3", 0, "session_start", at(DAY, 9), "attract", 0)
        personal = ev("s3", 1, "session_end", at(DAY, 9, 2), "details", 120000, reason="abandoned")
        personal["data"].update({"customerName": "דנה", "phone": "0501234567", "cardNumber": "4580..."})
        bad = [
            {"sessionId": "s3", "seq": 2, "type": "hack", "at": iso(at(DAY, 9))},
            {"sessionId": "s3", "seq": -1, "type": "screen", "step": "cart", "at": iso(at(DAY, 9))},
            {"sessionId": "s3", "seq": 3, "type": "screen", "at": iso(at(DAY, 9))},  # a screen with no step
            {"sessionId": "s3", "seq": 4, "type": "screen", "step": "cart", "at": "yesterday"},
            "nonsense",
            ev("s3", 5, "screen", NOW - timedelta(days=60), "cart"),  # too old
        ]
        out = ingest(w, [good, personal, *bad])
        assert out == {"accepted": 2, "duplicates": 0, "rejected": 6}
        stored = w.db.query(KioskEvent).filter(KioskEvent.type == "session_end").one()
        assert stored.data == {"reason": "abandoned"}

    def test_a_clock_far_ahead_is_taken_as_now(self, w):
        ingest(w, [ev("s4", 0, "session_start", NOW + timedelta(days=3), "attract", 0)])
        assert w.db.query(KioskEvent).one().at.replace(tzinfo=UTC) == NOW

    def test_a_till_that_is_not_a_kiosk_is_refused(self, w):
        till = w.tills[1]
        with pytest.raises(HTTPException) as refused:
            R.post_kiosk_events(machine_id=str(till.id), body=R.KioskEventsIn(events=[]), machine=till, db=w.db)
        assert refused.value.status_code == 403 and refused.value.detail == KC.NOT_A_KIOSK

    def test_the_routes_are_mounted(self):
        from app.main import app

        mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
        for route in (
            ("POST", "/api/v1/sync/{machine_id}/kiosk/events"),
            ("POST", "/api/v1/sync/{machine_id}/kiosk/basket-check"),
            ("GET", "/api/v1/insights/kiosks"),
            ("GET", "/api/v1/kiosks/health"),
            ("GET", "/api/v1/kiosks/{machine_id}/health"),
        ):
            assert route in mounted
        # "/kiosks/health" is ours, not a kiosk's id: mounted before the kiosks' own routes.
        paths = [r.path for r in app.routes]
        assert paths.index("/api/v1/kiosks/health") < paths.index("/api/v1/kiosks/{machine_id}/effective")


# ═════════════════════════════════════════════════════════════════════════════
# The report
# ═════════════════════════════════════════════════════════════════════════════


def trading_week(w):
    """Four paid sessions (one after two declined cards, two upsells), three left; orders and documents."""
    rule, chips = str(w.rule.id), str(w.p["צ'יפס"].id)
    batch = []
    batch += paid_session("p1", at(DAY, 12), order_sec=60, basket=6400, upsell=(rule, "accepted", chips))
    batch += paid_session("p2", at(DAY, 12, 30), order_sec=120, basket=5200, upsell=(rule, "declined", None))
    batch += paid_session("p3", at(DAY, 19), order_sec=180, basket=7000, declines=2)
    batch += paid_session("p4", at(DAY + timedelta(days=1), 9), order_sec=90, basket=1200)
    batch += left_session("l1", at(DAY, 13), "cart", "timeout")
    batch += left_session("l2", at(DAY, 14), "cart", "cancelled")
    batch += left_session("l3", at(DAY, 15), "details", "abandoned")
    ingest(w, batch)
    order(w, "o1", at(DAY, 12, 1), 6400)
    order(w, "o2", at(DAY, 12, 32), 5200, tip=500)
    order(w, "o3", at(DAY, 19, 3), 7000, items=3)
    order(w, "o4", at(DAY + timedelta(days=1), 9, 2), 1200, items=1)
    # "תשלום בקופה" still open at the till: no sale.
    order(w, "o5", at(DAY, 20), 9900, open_state="open", pay_at_till=True)
    kiosk_sale(w, at(DAY, 12, 1), [("בורגר", 1, "52.00"), ("צ'יפס", 1, "12.00")])
    kiosk_sale(w, at(DAY, 12, 32), [("בורגר", 1, "52.00")])
    kiosk_sale(w, at(DAY, 19, 3), [("בורגר", 1, "52.00"), ("קולה", 2, "9.00")])
    # A regular till's sale is not the kiosk's.
    kiosk_sale(w, at(DAY, 11), [("קפה", 5, "12.00")], machine=w.main)
    w.db.commit()


def report(w, user=None, **kw):
    kiosk_id = kw.pop("kiosk_id", None)
    return R.get_kiosk_insights(kiosk_id=kiosk_id, p=IR.InsightParams(**{"days": 7, **kw}), **ctx(w, user))


class TestReport:
    def test_the_funnel_counts_each_session_at_the_furthest_step(self, w):
        trading_week(w)
        out = report(w)
        assert out["period"]["from"] == "2026-09-20" and out["period"]["to"] == "2026-09-26"
        stages = {s["key"]: s["sessions"] for s in out["funnel"]}
        # Counted at the furthest step: the two left in the basket passed the menu and the add;
        # the checkout holds the four paid and the one left on its details.
        assert stages == {"start": 7, "catalog": 7, "item": 7, "added": 7, "cart": 7, "checkout": 5, "pay": 4, "paid": 4}
        counts = [s["sessions"] for s in out["funnel"]]
        assert counts == sorted(counts, reverse=True)
        cart = next(s for s in out["funnel"] if s["key"] == "cart")
        assert cart["dropToNext"] == 2 and cart["dropPct"] == pytest.approx(28.6)
        assert out["headline"]["current"]["conversion"] == pytest.approx(57.1)

    def test_where_they_leave_and_why(self, w):
        trading_week(w)
        ab = report(w)["abandonment"]
        assert ab["left"] == 3 and ab["worstStep"] == "cart"
        rows = {r["step"]: r for r in ab["byStep"]}
        assert rows["cart"]["count"] == 2 and rows["cart"]["reasons"] == {"timeout": 1, "cancelled": 1}
        assert rows["details"]["reasons"] == {"abandoned": 1}
        assert ab["endReasons"]["paid"] == 4

    def test_time_to_order_basket_and_hours(self, w):
        trading_week(w)
        out = report(w)
        t = out["orderTime"]
        assert t["count"] == 4 and t["medianSec"] == 105 and t["avgSec"] == 112
        assert sum(b["count"] for b in t["buckets"]) == 4
        cur = out["headline"]["current"]
        # Four kiosk orders (the open one at the till is no sale): 6400 + 5200 + 7000 + 1200.
        assert cur["orders"] == 4 and cur["revenue"] == 19_800 and cur["avgBasket"] == 4950
        assert cur["itemsPerOrder"] == 2.0 and cur["tips"] == 500
        by_hour = {h["hour"]: h for h in out["byHour"]}
        assert by_hour[12]["orders"] == 2 and by_hour[19]["orders"] == 1 and by_hour[9]["orders"] == 1
        assert by_hour[13]["sessions"] == 1
        day = next(d for d in out["daily"] if d["date"] == DAY.isoformat())
        assert day["orders"] == 3 and day["sessions"] == 6 and day["paid"] == 3

    def test_upsell_payments_and_top_items(self, w):
        trading_week(w)
        out = report(w)
        up = out["upsell"]
        assert up["source"] == "events" and up["shown"] == 2 and up["accepted"] == 1 and up["rate"] == 50.0
        assert up["byRule"][0]["name"] == "צ'יפס לבורגר"
        assert up["byProduct"] == [{"productId": str(w.p["צ'יפס"].id), "name": "צ'יפס", "accepted": 1}]
        assert up["byMoment"][0]["moment"] == "item"
        pay = out["payments"]
        assert pay["attempts"] == 6 and pay["approved"] == 4 and pay["failures"] == 2
        assert pay["failureRate"] == pytest.approx(33.3)
        assert pay["byReason"] == [{"result": "declined", "reason": "insufficient_funds", "count": 2}]
        assert pay["byMethod"] == [{"method": "card", "count": 6}]
        top = out["topItems"]
        assert top[0]["name"] == "בורגר" and top[0]["units"] == 3 and top[0]["net"] == 15_600
        assert all(i["name"] != "קפה" for i in top)  # the regular till's sale

    def test_per_kiosk_the_period_before_and_one_kiosk(self, w):
        trading_week(w)
        ingest(w, paid_session("n1", at(DAY, 10), order_sec=200, basket=900), machine=w.north_kiosk)
        order(w, "n-o1", at(DAY, 10, 4), 900, machine=w.north_kiosk)
        # The week before: one paid order.
        ingest(w, paid_session("old", at(DAY - timedelta(days=7), 12), order_sec=80))
        order(w, "old", at(DAY - timedelta(days=7), 12, 2), 4000)
        w.db.commit()
        out = report(w)
        rows = {r["name"]: r for r in out["perKiosk"]}
        assert rows["קיוסק רויאל"]["sessions"] == 7 and rows["קיוסק רויאל"]["orders"] == 4
        assert rows["קיוסק צפון"]["orders"] == 1 and rows["קיוסק צפון"]["medianOrderSec"] == 200
        assert out["headline"]["previous"]["orders"] == 1 and out["headline"]["previous"]["revenue"] == 4000
        one = report(w, kiosk_id=w.north_kiosk.id)
        assert [k["name"] for k in one["kiosks"]] == ["קיוסק צפון"] and one["headline"]["current"]["orders"] == 1

    def test_a_shop_manager_sees_their_shop_only(self, w):
        trading_week(w)
        ingest(w, paid_session("n1", at(DAY, 10)), machine=w.north_kiosk)
        w.db.commit()
        mine = report(w, w.manager)
        assert [k["name"] for k in mine["kiosks"]] == ["קיוסק רויאל"]
        assert mine["headline"]["current"]["sessions"] == 7
        # Asking for the other shop's kiosk only narrows: nothing.
        other = report(w, w.manager, kiosk_id=w.north_kiosk.id)
        assert other["hasKiosks"] is False and other["headline"]["current"] is None

    def test_upsell_falls_back_to_the_tills_counts(self, w):
        from app.models.menu import UpsellStat

        w.db.add(UpsellStat(
            id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.kiosk.id, shop_id=w.shop.id, rule_id=w.rule.id,
            day=DAY, shown=10, accepted=3, dismissed=5, declined=2, accepted_options={str(w.p["צ'יפס"].id): 3},
        ))
        w.db.commit()
        up = report(w)["upsell"]
        assert up["source"] == "till_stats" and up["shown"] == 10 and up["accepted"] == 3 and up["declined"] == 7

    def test_no_kiosks_no_data(self, w):
        w.db.query(KioskDevice).delete()
        w.db.commit()
        out = report(w)
        assert out["hasKiosks"] is False and out["funnel"] == [] and out["perKiosk"] == []


# ═════════════════════════════════════════════════════════════════════════════
# Device health
# ═════════════════════════════════════════════════════════════════════════════


def kiosk_sync(w, status, now=NOW, machine=None):
    machine = machine or w.kiosk
    if "appliedConfigVersion" not in status:
        status = {**status, "appliedConfigVersion": C.config_version(C.effective_config(w.db, machine))}
    out = KC.kiosk_sync(w.db, machine, status, now=now)
    w.db.commit()
    return out


GOOD = {
    "flowState": "attract", "shiftOpen": True, "mediaReady": True, "mediaMissing": 0, "pendingOrders": 0,
    "appVersion": "1.0.300", "bonPrinter": "ok", "alerts": [],
    "health": {
        "screen": "attract", "platform": "android",
        "terminal": {"state": "ready", "checkedAt": iso(NOW - timedelta(seconds=20)), "address": "192.168.0.167"},
        "printer": {"state": "ok", "name": "SNBC"},
        "tillLink": {"mode": "lan", "host": "קופה 2", "ok": True, "at": iso(NOW)},
        "network": {"online": True, "route": "wifi"},
        "pending": {"orders": 0, "documents": 0, "events": 3},
    },
}


def health(w, user=None, now=NOW):
    out = H.health_view(w.db, user or w.admin, w.tenant.id, now=now)
    w.db.commit()
    return {r["name"]: r for r in out["kiosks"]}, out


def part(row, key):
    return next(p for p in row["parts"] if p["key"] == key)


class TestHealth:
    def test_the_kiosks_report_is_cleaned(self):
        raw = {
            "screen": "catalog", "platform": "ios", "evil": {"x": 1},
            "terminal": {"state": "melting", "checkedAt": "not a time", "address": "x" * 200, "pan": "4580"},
            "pending": {"orders": -1, "documents": 2, "oldestAt": iso(NOW)},
            "tillLink": {"mode": "lan", "ok": "yes"},
        }
        out = H.clean_health(raw)
        assert out == {
            "screen": "catalog",
            "terminal": {"state": "unknown", "address": "x" * 60},
            "pending": {"documents": 2, "oldestAt": iso(NOW)},
            "tillLink": {"mode": "lan"},
        }
        assert KC.clean_status({"flowState": "attract", "health": raw})["health"]["screen"] == "catalog"

    def test_a_healthy_kiosk_and_an_offline_one(self, w):
        kiosk_sync(w, GOOD)
        kiosk_sync(w, {**GOOD, "health": {**GOOD["health"], "platform": "windows"}}, now=NOW - timedelta(minutes=10), machine=w.north_kiosk)
        rows, out = health(w)
        royal = rows["קיוסק רויאל"]
        assert royal["overall"] == "ok" and royal["online"] and royal["platform"] == "android"
        assert {p["key"]: p["level"] for p in royal["parts"]} == {
            "app": "ok", "terminal": "ok", "printer": "ok", "tillLink": "ok", "kds": "off", "media": "ok", "uploads": "info",
            "battery": "off",
        }
        assert part(royal, "tillLink")["detail"]["host"] == "קופה 2"
        north = rows["קיוסק צפון"]
        assert north["overall"] == "offline" and part(north, "app")["code"] == "offline"
        assert out["counts"]["ok"] == 1 and out["counts"]["offline"] == 1

    def test_the_parts_that_need_someone(self, w):
        bad = {
            **GOOD, "unprintedBons": 2, "mediaMissing": 3,
            "health": {
                **GOOD["health"],
                "terminal": {"state": "unreachable"},
                "printer": {"state": "no_paper"},
                "tillLink": {"mode": "lan", "host": "קופה 2", "ok": False},
                "pending": {"orders": 1, "documents": 2, "oldestAt": iso(NOW - timedelta(minutes=40))},
            },
            "alerts": [{"kind": "printer", "key": "printer:receipt", "reason": "no_paper", "detail": {"target": "receipt"}}],
        }
        kiosk_sync(w, bad)
        rows, _ = health(w)
        royal = rows["קיוסק רויאל"]
        codes = {p["key"]: (p["level"], p["code"]) for p in royal["parts"]}
        assert codes["terminal"] == ("error", "unreachable")
        assert codes["printer"] == ("error", "no_paper")
        assert codes["tillLink"] == ("error", "down")
        assert codes["media"] == ("warn", "missing")
        assert codes["uploads"] == ("warn", "stuck")
        assert royal["overall"] == "error" and royal["alerts"][0]["reason"] == "no_paper"

    def test_paused_and_the_card_lock(self, w, monkeypatch):
        kiosk_sync(w, GOOD)
        device = w.db.get(KioskDevice, w.kiosk.id)
        device.paused = True
        w.db.commit()
        from app.services import terminal_status

        monkeypatch.setattr(terminal_status, "card_lock_status", lambda machine, settings: "terminal_mismatch")
        rows, _ = health(w)
        royal = rows["קיוסק רויאל"]
        assert part(royal, "app")["code"] == "paused" and part(royal, "app")["level"] == "warn"
        assert part(royal, "terminal")["code"] == "card_lock" and royal["overall"] == "error"

    def test_kds_screens_and_the_alert_to_the_tills(self, w, monkeypatch):
        from app.models.kds import KdsDevice

        monkeypatch.setattr(C, "kds_available", lambda: True)
        KR.put_settings(
            body=KioskSettingsIn(overrides={"general": {"fulfillmentMode": "KDS"}}), level="machine",
            scope_id=w.kiosk.id, **ctx(w),
        )
        screen = KdsDevice(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="מטבח", role="station",
                           station_ids=[], is_active=True, last_seen_at=NOW - timedelta(minutes=20))
        w.db.add(screen)
        w.db.commit()
        kiosk_sync(w, GOOD)
        rows, _ = health(w)
        royal = rows["קיוסק רויאל"]
        assert part(royal, "kds")["code"] == "screens_offline" and royal["overall"] == "error"
        assert any(a["key"] == "kiosk:kds" and a.get("cloud") for a in royal["alerts"])
        # The tills: on the printer route (the main till, else all the shop's tills).
        alerts = OPS.alerts_for_till(w.db, w.main, now=NOW)
        kds = [a for a in alerts if a["key"] == "kiosk:kds"]
        assert len(kds) == 1 and kds[0]["kind"] == "printer" and "KDS" in kds[0]["text"]
        assert OPS.alerts_for_till(w.db, w.north_kiosk, now=NOW) == [] or all(
            a["key"] != "kiosk:kds" for a in OPS.alerts_for_till(w.db, w.north_kiosk, now=NOW)
        )
        # A screen back: gone.
        screen.last_seen_at = NOW - timedelta(seconds=30)
        w.db.commit()
        assert not [a for a in OPS.alerts_for_till(w.db, w.main, now=NOW) if a["key"] == "kiosk:kds"]
        rows, _ = health(w)
        assert part(rows["קיוסק רויאל"], "kds")["code"] == "ok"

    def test_the_drawer_lists_the_last_events(self, w):
        kiosk_sync(w, {**GOOD, "alerts": [{"kind": "printer", "key": "printer:receipt", "reason": "no_paper", "detail": {}}]},
                   now=NOW - timedelta(minutes=5))
        kiosk_sync(w, GOOD)  # the paper is back: cleared
        ingest(w, left_session("d1", NOW - timedelta(minutes=30), "cart"))
        out = R.get_kiosk_health(machine_id=str(w.kiosk.id), **ctx(w))
        kinds = [e["type"] for e in out["events"]]
        assert "alert_raised" in kinds and "alert_cleared" in kinds
        assert out["sessions"][0]["lastStep"] == "cart" and out["sessions"][0]["endReason"] == "timeout"
        with pytest.raises(HTTPException) as refused:
            R.get_kiosk_health(machine_id=str(w.kiosk.id), **ctx(w, w.cashier))
        assert refused.value.status_code == 403

    def test_a_shop_manager_sees_their_shops_kiosks(self, w):
        kiosk_sync(w, GOOD)
        kiosk_sync(w, GOOD, machine=w.north_kiosk)
        rows, _ = health(w, w.manager)
        assert list(rows) == ["קיוסק רויאל"]


# ═════════════════════════════════════════════════════════════════════════════
# Step modes
# ═════════════════════════════════════════════════════════════════════════════


def put(w, overrides, level="machine", entity=None):
    return KR.put_settings(
        body=KioskSettingsIn(overrides=overrides), level=level, scope_id=(entity or w.kiosk).id, **ctx(w),
    )


class TestStepModes:
    def test_defaults_and_limits(self):
        cfg = C.default_config()
        assert cfg["payment"]["stepModes"] == {
            "service": "required", "tip": "optional", "payMethod": "required",
            "upsellItem": "optional", "upsellSteps": "optional", "upsellCheckout": "optional",
        }
        assert C.limits()["enums"]["stepModes"] == list(C.STEP_MODE_KEYS)
        assert C.validate_config(cfg) == []

    def test_validated_with_paths(self, w):
        with pytest.raises(HTTPException) as refused:
            put(w, {"payment": {"stepModes": {"tip": "sometimes", "service": "off", "upsellSoon": "off"}}})
        codes = {e["path"]: e["code"] for e in refused.value.detail["errors"]}
        assert codes["payment.stepModes.tip"] == "invalid_value"
        assert "payment.stepModes.upsellSoon" in codes and "payment.stepModes.service" not in codes

    def test_per_shop_and_per_kiosk(self, w):
        put(w, {"payment": {"stepModes": {"service": "optional", "tip": "required"}, "tipEnabled": True}}, level="shop", entity=w.shop)
        put(w, {"payment": {"stepModes": {"tip": "off"}, "customerPhone": "required", "checkoutSteps": ["details", "tip"]}})
        cfg = C.effective_config(w.db, w.kiosk)
        modes = cfg["payment"]["stepModes"]
        assert modes["service"] == "optional" and modes["tip"] == "off" and modes["payMethod"] == "required"
        assert cfg["payment"]["checkoutSteps"] == ["details", "tip", "payMethod"]
        assert C.step_mode(cfg, "customerPhone") == "required" and C.step_mode(cfg, "tip") == "off"
        # The other shop's kiosk keeps the defaults.
        north = C.effective_config(w.db, w.north_kiosk)["payment"]["stepModes"]
        assert north["service"] == "required" and north["tip"] == "optional"

    def test_each_steps_own_switch_comes_first(self):
        cfg = C.default_config()
        assert C.step_mode(cfg, "service") == "required"  # take away and eat in
        assert C.step_mode(cfg, "tip") == "off"  # tips are off by default
        assert C.step_mode(cfg, "payMethod") == "off"  # the card alone: nothing to choose
        cfg["payment"]["tipEnabled"] = True
        cfg["payment"]["methods"] = ["card", "cash_at_till"]
        cfg["general"]["serviceTypes"] = ["take_away"]
        assert C.step_mode(cfg, "tip") == "optional" and C.step_mode(cfg, "payMethod") == "required"
        assert C.step_mode(cfg, "service") == "off"
        cfg["general"]["upsellEnabled"] = False
        assert C.step_mode(cfg, "upsellItem") == "off" and C.step_mode(cfg, "upsellCheckout") == "off"


# ═════════════════════════════════════════════════════════════════════════════
# The pre-payment check
# ═════════════════════════════════════════════════════════════════════════════


def check(w, lines, etag=None):
    body = R.BasketCheckIn(lines=[R.BasketLineIn(**l) for l in lines], promotionsEtag=etag)
    return R.post_basket_check(machine_id=str(w.kiosk.id), body=body, machine=w.kiosk, db=w.db)


class TestBasketCheck:
    def test_nothing_changed(self, w):
        burger, coffee = w.p["בורגר"], w.p["קפה"]
        out = check(w, [{"productId": str(burger.id), "unitPriceAgorot": 5200}, {"productId": str(coffee.id), "unitPriceAgorot": 1200}])
        assert out["ok"] is True and all(l["available"] and not l["priceChanged"] for l in out["lines"])
        again = check(w, [{"productId": str(burger.id), "unitPriceAgorot": 5200}], etag=out["promotions"]["etag"])
        assert again["ok"] is True and again["promotions"]["changed"] is False

    def test_price_availability_category_and_channel(self, w):
        w.ovr["בורגר"].price = Decimal("55.00")  # the shop's price went up
        w.ovr["קולה"].is_available = False  # locked for the shop
        w.p["צ'יפס"].sales_channel = "pos_only"  # "קופות בלבד"
        w.db.commit()
        out = check(w, [
            {"productId": str(w.p["בורגר"].id), "unitPriceAgorot": 5200},
            {"productId": str(w.p["קולה"].id), "unitPriceAgorot": 900},
            {"productId": str(w.p["צ'יפס"].id), "unitPriceAgorot": 1800},
            {"productId": str(uuid.uuid4()), "unitPriceAgorot": 100},
        ])
        lines = {l["productId"]: l for l in out["lines"]}
        burger = lines[str(w.p["בורגר"].id)]
        assert burger["available"] and burger["priceChanged"] and burger["priceAgorot"] == 5500
        assert lines[str(w.p["קולה"].id)]["reason"] == "unavailable"
        assert lines[str(w.p["צ'יפס"].id)]["reason"] == "not_on_kiosk"
        unknown = [l for l in out["lines"] if l["reason"] == "not_in_catalog"]
        assert len(unknown) == 1 and out["ok"] is False

    def test_a_category_switched_off_here(self, w):
        w.drinks.is_active = False
        w.db.commit()
        out = check(w, [{"productId": str(w.p["קפה"].id), "unitPriceAgorot": 1200}])
        assert out["lines"][0]["reason"] == "category_off" and out["ok"] is False

    def test_promotions_changed(self, w):
        out = check(w, [{"productId": str(w.p["קפה"].id), "unitPriceAgorot": 1200}], etag="stale-etag")
        assert out["promotions"]["changed"] is True and out["ok"] is False

    def test_only_a_kiosk_asks(self, w):
        till = w.tills[1]
        body = R.BasketCheckIn(lines=[])
        with pytest.raises(HTTPException) as refused:
            R.post_basket_check(machine_id=str(till.id), body=body, machine=till, db=w.db)
        assert refused.value.status_code == 403
