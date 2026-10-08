"""
Quick actions from the insights (app/services/insights/quick_actions.py) — docs/SPEC_INSIGHTS.md §10.2.

What each class pins, and how it could look fine while being wrong:

* **When it ends** — "until the end of the day" is the business day's end (04:00), in
  Israel's time, summer and winter; "N hours" are real hours across the night the clocks
  go back; a promotion's hour window that crosses midnight stays on the day it started.
* **Never below cost** — every offer is checked at the lowest price among the target's
  shops (a shop's own price), the cheapest unit of "the second at half price" included;
  the suggestion keeps half the margin, and is 10% without a cost.
* **The quick message** — a banner (not full-screen) with the product, to the target's
  tills only, ending by itself; the till messages' rule decides who may; an event means
  its tills; cancelling takes it down.
* **The quick promotion** — a promotion the tills pull (scope, dates, hours, config), the
  promotions' rule decides who may, "בטל מבצע" pauses it.
* **The result** — the product's sales on the tills it reached since it started, against
  the same hours before; only what the viewer may see.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.category import Category
from app.models.insight_quick_action import InsightQuickAction
from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.promotion import Promotion
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shop_product_override import ShopProductOverride
from app.models.till_message import TillMessage, TillMessageReceipt
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import insights as R
from app.services import dashboard_sections as DS
from app.services import promotions as P
from app.services import till_messages as TM
from app.services.insights import quick_actions as Q
from app.services.insights import service as S
from shift_world import NOW, accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc


def local(y, mo, d, h, mi=0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=JLM)


# ═════════════════════════════════════════════════════════════════════════════
# When it ends
# ═════════════════════════════════════════════════════════════════════════════


class TestWindow:
    def test_until_the_end_of_the_business_day(self):
        # NOW: Sunday 27.9.2026 21:00 in Jerusalem (summer time, +3).
        w = Q.resolve_window(NOW, JLM, {"kind": "end_of_day"})
        assert w.ends_at == local(2026, 9, 28, 4).astimezone(UTC) == datetime(2026, 9, 28, 1, 0, tzinfo=UTC)
        assert (w.valid_from, w.valid_to, w.start_time, w.end_time) == (date(2026, 9, 27), date(2026, 9, 27), "21:00", "04:00")

    def test_after_midnight_the_day_is_still_the_evening_before(self):
        now = local(2026, 9, 28, 2, 30).astimezone(UTC)
        w = Q.resolve_window(now, JLM, {"kind": "end_of_day"})
        assert w.ends_at == local(2026, 9, 28, 4).astimezone(UTC)
        # The promotion's window is on the calendar day it starts on, and does not cross midnight.
        assert (w.valid_from, w.start_time, w.end_time) == (date(2026, 9, 28), "02:30", "04:00")

    def test_hours_and_a_window_that_crosses_midnight(self):
        w = Q.resolve_window(NOW, JLM, {"kind": "hours", "hours": 2})
        assert w.ends_at == NOW + timedelta(hours=2) and (w.start_time, w.end_time) == ("21:00", "23:00")
        w = Q.resolve_window(NOW, JLM, {"kind": "hours", "hours": 5})
        assert (w.valid_from, w.valid_to, w.start_time, w.end_time) == (date(2026, 9, 27), date(2026, 9, 27), "21:00", "02:00")

    def test_real_hours_across_the_night_the_clocks_go_back(self):
        # 24.10.2026 23:30 summer time; at 02:00 on the 25th the clocks go back to 01:00.
        now = local(2026, 10, 24, 23, 30).astimezone(UTC)
        w = Q.resolve_window(now, JLM, {"kind": "hours", "hours": 4})
        assert w.ends_at == now + timedelta(hours=4)
        assert w.end_time == "02:30"  # wall clock: 23:30 + 4 real hours, one of them repeated
        eod = Q.resolve_window(now, JLM, {"kind": "end_of_day"})
        assert eod.ends_at == datetime(2026, 10, 25, 2, 0, tzinfo=UTC)  # 04:00 winter time (+2)

    def test_until_a_date_in_whole_days(self):
        w = Q.resolve_window(NOW, JLM, {"kind": "until", "date": "2026-09-30"})
        assert w.ends_at == local(2026, 10, 1, 4).astimezone(UTC)
        assert (w.valid_from, w.valid_to, w.start_time, w.end_time) == (date(2026, 9, 27), date(2026, 9, 30), None, None)

    @pytest.mark.parametrize("duration", [
        {"kind": "hours", "hours": 0}, {"kind": "hours", "hours": 13}, {"kind": "hours"}, {"kind": "week"},
        {"kind": "until", "date": "2026-09-26"}, {"kind": "until", "date": "2026-10-28"}, {"kind": "until"},
    ])
    def test_refused_durations(self, duration):
        with pytest.raises(HTTPException) as bad:
            Q.resolve_window(NOW, JLM, duration)
        assert bad.value.detail == Q.BAD_DURATION


# ═════════════════════════════════════════════════════════════════════════════
# Never below cost
# ═════════════════════════════════════════════════════════════════════════════


class TestOffers:
    def test_the_suggestion_keeps_half_the_margin(self):
        # ₪12 incl. VAT, cost ₪4 excl. → the floor is ₪4.72; 60.7% margin → 20% off.
        p = Q.Pricing(price=1200, min_price=1200, cost=400)
        assert p.floor == 472 and round(p.margin_pct, 1) == 60.7
        s = Q.suggest_offer(p)
        assert (s["kind"], s["value"], s["newPrice"]) == ("percent", 20.0, 960)
        # Cost ₪8: 21% margin → 10% (keeps over half of it).
        assert Q.suggest_offer(Q.Pricing(price=1200, min_price=1200, cost=800))["value"] == 10.0
        # Cost ₪9.50: the floor is ₪11.21 — 5% (₪11.40) still clears it.
        assert Q.suggest_offer(Q.Pricing(price=1200, min_price=1200, cost=950))["value"] == 5.0
        # Cost ₪10: nothing is above cost.
        assert Q.suggest_offer(Q.Pricing(price=1200, min_price=1200, cost=1000)) is None

    def test_without_a_cost_ten_percent(self):
        s = Q.suggest_offer(Q.Pricing(price=1200, min_price=1200, cost=None))
        assert (s["kind"], s["value"], s["belowCost"], s["floor"]) == ("percent", 10.0, False, None)

    def test_the_cheapest_unit_of_the_second_at_half_price(self):
        p = Q.Pricing(price=1200, min_price=1200, cost=700)  # floor ₪8.26
        half = Q.check_offer("second_half", None, p)
        assert half["lowestUnitPrice"] == 600 and half["belowCost"] is True and half["effectivePct"] == 25.0
        assert Q.check_offer("percent", 20, p)["belowCost"] is False  # ₪9.60

    def test_a_fixed_price_at_the_cheapest_shop(self):
        # ₪12 here, ₪10 in another shop of the target: "₪9" takes ₪3 off — ₪7 there.
        p = Q.Pricing(price=1200, min_price=1000, cost=700)
        fixed = Q.check_offer("fixed_price", 900, p)
        assert fixed["lowestUnitPrice"] == 700 and fixed["belowCost"] is True
        assert Q.check_offer("fixed_price", 1100, p)["belowCost"] is False
        options = Q.offer_options(p)
        assert [o["kind"] for o in options] == ["percent", "percent", "percent", "second_half", "fixed_price"]
        assert all(o["floor"] == 826 for o in options)

    @pytest.mark.parametrize("kind,value", [("percent", 0), ("percent", 95), ("fixed_price", 1200), ("fixed_price", 0), ("bogus", 1)])
    def test_refused_offers(self, kind, value):
        with pytest.raises(HTTPException) as bad:
            Q.check_offer(kind, value, Q.Pricing(price=1200, min_price=1200, cost=None))
        assert bad.value.detail == Q.BAD_OFFER

    def test_the_promotion_config_of_each_offer(self):
        pid = uuid.uuid4()
        p = Q.Pricing(price=1200, min_price=1200, cost=None)
        assert Q.promotion_config(pid, Q.check_offer("percent", 15, p), p) == (
            "discount", {"target": {"productIds": [str(pid)]}, "discountKind": "percent", "discountValue": 15.0})
        assert Q.promotion_config(pid, Q.check_offer("second_half", None, p), p)[1]["getDiscountPercent"] == 50
        kind, config = Q.promotion_config(pid, Q.check_offer("fixed_price", 900, p), p)
        assert (kind, config["discountKind"], config["discountValue"]) == ("discount", "amount", 3.0)


# ═════════════════════════════════════════════════════════════════════════════
# The endpoints, on the SQLite world
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for module in (S, Q, TM):
        monkeypatch.setattr(module, "_now", lambda: NOW)
    monkeypatch.setattr(P, "tenant_today", lambda db, tenant_id: date(2026, 9, 27))
    db = world.db

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.north_manager = user(UserRole.SHOP_MANAGER, "north", shop_id=world.other_shop.id)
    world.cashier = user(UserRole.CASHIER, "cashier", shop_id=world.shop.id)
    world.category = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="כללי")
    db.add(world.category)
    db.flush()
    world.coffee = Product(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="קפה",
                           sku="S-1", price=Decimal("12.00"), category_id=world.category.id, created_at=NOW - timedelta(days=300))
    world.cake = Product(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="עוגה",
                         sku="S-2", price=Decimal("20.00"), category_id=world.category.id, created_at=NOW - timedelta(days=300))
    db.add_all([world.coffee, world.cake])
    db.flush()
    db.add(ProductCost(id=uuid.uuid4(), tenant_id=world.tenant.id, product_id=world.coffee.id, cost=Decimal("4.00")))
    db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def message_body(w, **kw):
    body = {"text": "הציעו ללקוחות: קפה — רק היום", "targetLevel": "shop", "targetId": str(w.shop.id),
            "duration": {"kind": "end_of_day"}, "productId": str(w.coffee.id), "source": "slow"}
    body.update(kw)
    return body


def promo_body(w, **kw):
    body = {"productId": str(w.coffee.id), "targetLevel": "shop", "targetId": str(w.shop.id),
            "offer": {"kind": "percent", "value": 15}, "duration": {"kind": "hours", "hours": 2}, "source": "slow"}
    body.update(kw)
    return body


def event(w, tills):
    e = ReportEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                    name="ערב פתיחה", starts_at=NOW - timedelta(hours=3), ends_at=NOW + timedelta(hours=3), status="draft")
    w.db.add(e)
    w.db.flush()
    for t in tills:
        w.db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=t.id))
    w.db.commit()
    return e


class TestQuickMessage:
    def test_a_banner_to_the_shop_tills_that_ends_by_itself(self, w):
        out = R.post_quick_message(BackgroundTasks(), body=message_body(w), **ctx(w, w.manager))
        assert out["kind"] == "message" and out["status"] == "active" and out["tills"] == 2
        (message,) = w.db.query(TillMessage).all()
        assert message.display == "banner" and message.product_id == w.coffee.id and message.color == "amber"
        assert (message.target_level, message.target_id) == ("shop", w.shop.id)
        assert TM._utc(message.expires_at) == datetime(2026, 9, 28, 1, 0, tzinfo=UTC)
        receipts = w.db.query(TillMessageReceipt).filter(TillMessageReceipt.message_id == message.id).all()
        assert {r.machine_id for r in receipts} == {t.id for t in w.tills}
        # The till lists it as a banner, never in its full-screen items.
        till_view = TM.banners_for_machine(w.db, w.tills[0], materialize=False)
        assert [b["productId"] for b in till_view] == [str(w.coffee.id)]
        assert TM.pending_for_machine(w.db, w.tills[0]) == []
        action = w.db.get(InsightQuickAction, uuid.UUID(out["id"]))
        assert action.till_message_ids == [str(message.id)] and action.created_by_name == "manager"
        assert action.params["text"].startswith("הציעו ללקוחות")

    def test_who_may_send_and_where(self, w):
        with pytest.raises(HTTPException) as refused:
            Q.send_quick_message(w.db, w.cashier, w.tenant.id, message_body(w))
        assert refused.value.status_code == 403
        with pytest.raises(HTTPException) as other:
            R.post_quick_message(BackgroundTasks(), body=message_body(w), **ctx(w, w.north_manager))
        assert other.value.status_code == 403
        with pytest.raises(HTTPException) as empty:
            R.post_quick_message(BackgroundTasks(), body=message_body(w, text="  "), **ctx(w, w.manager))
        assert empty.value.detail == Q.BAD_TEXT
        assert w.db.query(TillMessage).count() == 0 and w.db.query(InsightQuickAction).count() == 0

    def test_a_till_and_an_event(self, w):
        one = R.post_quick_message(BackgroundTasks(), body=message_body(w, targetLevel="machine", targetId=str(w.tills[1].id), productId=None,
                                                                          display="fullscreen", source="anomaly"), **ctx(w))
        assert one["tills"] == 1 and one["machineIds"] == [str(w.tills[1].id)]
        msg = w.db.query(TillMessage).one()
        assert msg.display == "fullscreen" and msg.color is None and msg.product_id is None
        e = event(w, w.tills)
        out = R.post_quick_message(BackgroundTasks(), body=message_body(w, targetLevel="event", targetId=str(e.id)), **ctx(w, w.manager))
        assert out["target"] == {"level": "event", "id": str(e.id), "name": "ערב פתיחה"}
        sent = w.db.query(TillMessage).filter(TillMessage.id.in_([uuid.UUID(i) for i in out["tillMessageIds"]])).all()
        assert sorted((m.target_level, m.target_id) for m in sent) == sorted(("machine", t.id) for t in w.tills)

    def test_cancelling_takes_it_down(self, w):
        out = R.post_quick_message(BackgroundTasks(), body=message_body(w), **ctx(w, w.manager))
        done = R.cancel_quick_message(out["id"], BackgroundTasks(), **ctx(w, w.manager))
        assert done["status"] == "cancelled"
        message = w.db.query(TillMessage).one()
        assert message.cancelled_at is not None and TM._utc(message.expires_at) == NOW
        again = R.cancel_quick_message(out["id"], BackgroundTasks(), **ctx(w, w.manager))
        assert again["cancelledAt"] == done["cancelledAt"]
        with pytest.raises(HTTPException) as foreign:
            R.cancel_quick_message(out["id"], BackgroundTasks(), **ctx(w, w.north_manager))
        assert foreign.value.status_code == 403


class TestQuickPromotion:
    def test_a_promotion_the_tills_pull_ending_by_itself(self, w):
        out = R.post_quick_promotion(BackgroundTasks(), body=promo_body(w), **ctx(w, w.manager))
        promo = w.db.query(Promotion).one()
        assert str(promo.id) == out["promotionId"] and promo.is_paused is False
        assert promo.promo_type == "discount"
        assert promo.config["target"]["productIds"] == [str(w.coffee.id)] and promo.config["discountValue"] == 15.0
        assert promo.scopes == [{"type": "shop", "id": str(w.shop.id)}]
        assert (promo.valid_from, promo.valid_to, promo.start_time, promo.end_time) == (date(2026, 9, 27), date(2026, 9, 27), "21:00", "23:00")
        assert out["endsAt"] == (NOW + timedelta(hours=2)).isoformat()
        assert out["params"]["cost"] == 400 and out["params"]["offer"]["newPrice"] == 1020
        # The shop's till receives it on its pull.
        assert [p["id"] for p in P.promotions_for_machine(w.db, w.tills[0])] == [str(promo.id)]
        assert P.promotions_for_machine(w.db, w.other_till) == []

    def test_never_below_cost(self, w):
        w.db.add(ProductCost(id=uuid.uuid4(), tenant_id=w.tenant.id, product_id=w.cake.id, cost=Decimal("15.00")))
        w.db.commit()  # cake: ₪20, cost ₪15 → floor ₪17.70
        with pytest.raises(HTTPException) as below:
            R.post_quick_promotion(BackgroundTasks(), body=promo_body(w, productId=str(w.cake.id), offer={"kind": "percent", "value": 20}), **ctx(w))
        assert below.value.detail["code"] == Q.BELOW_COST and below.value.detail["floor"] == 1770
        # A shop's own lower price is the one checked: ₪18.50 there, 5% → ₪17.58 < ₪17.70.
        w.db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=w.shop.id, global_product_id=w.cake.id, price=Decimal("18.50")))
        w.db.commit()
        with pytest.raises(HTTPException):
            R.post_quick_promotion(BackgroundTasks(), body=promo_body(w, productId=str(w.cake.id), offer={"kind": "percent", "value": 5}), **ctx(w))
        assert w.db.query(Promotion).count() == 0 and w.db.query(InsightQuickAction).count() == 0
        suggestion = R.get_promotion_suggestion(product_id=w.cake.id, category_id=None, all_products=False, target_level="shop", target_id=w.shop.id, **ctx(w))
        assert suggestion["price"] == 1850 and suggestion["floor"] == 1770 and suggestion["suggested"] is None
        # Coffee: ₪12, cost ₪4 — 20% keeps over half the margin.
        plain = R.get_promotion_suggestion(product_id=w.coffee.id, category_id=None, all_products=False, target_level=None, target_id=None, **ctx(w))
        assert plain["suggested"]["value"] == 20.0 and plain["canCreate"] is True

    def test_who_may_promote(self, w):
        with pytest.raises(HTTPException) as cashier:
            R.post_quick_promotion(BackgroundTasks(), body=promo_body(w), **ctx(w, w.cashier))
        assert cashier.value.status_code == 403
        with pytest.raises(HTTPException) as north:
            R.post_quick_promotion(BackgroundTasks(), body=promo_body(w), **ctx(w, w.north_manager))
        assert north.value.status_code == 403
        assert w.db.query(Promotion).count() == 0

    def test_an_event_names_its_tills_and_cancel_pauses(self, w):
        e = event(w, w.tills[:1])
        out = R.post_quick_promotion(BackgroundTasks(), body=promo_body(w, targetLevel="event", targetId=str(e.id),
                                                                          offer={"kind": "second_half"}, duration={"kind": "end_of_day"}), **ctx(w, w.manager))
        promo = w.db.query(Promotion).one()
        assert promo.scopes == [{"type": "machine", "id": str(w.tills[0].id)}]
        assert promo.promo_type == "buy_x_get_y" and promo.end_time == "04:00"
        done = R.cancel_quick_promotion(out["id"], BackgroundTasks(), **ctx(w, w.manager))
        assert done["status"] == "cancelled"
        w.db.refresh(promo)
        assert promo.is_paused is True
        with pytest.raises(HTTPException) as cashier:
            R.cancel_quick_promotion(out["id"], BackgroundTasks(), **ctx(w, w.cashier))
        assert cashier.value.status_code == 403


def sell(w, till, when, qty):
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=uuid.uuid4().hex[:12], status=TransactionStatus.COMPLETED, document_type=320,
        payment_method="cash", total_amount=Decimal("12.00") * qty, document_discount=Decimal("0"),
        created_at=when, updated_at=when, server_received_at=when,
    )
    w.db.add(tx)
    w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=tx.id, product_id=w.coffee.id, product_name="קפה", sku="S-1",
                             quantity=Decimal(qty), unit_price=Decimal("12.00"), total_price=Decimal("12.00") * qty))
    w.db.flush()


class TestResult:
    def test_since_it_started_against_the_same_hours_before(self, w, monkeypatch):
        started = NOW - timedelta(hours=2)
        monkeypatch.setattr(Q, "_now", lambda: started)
        monkeypatch.setattr(TM, "_now", lambda: started)
        out = R.post_quick_message(BackgroundTasks(), body=message_body(w, duration={"kind": "hours", "hours": 4}), **ctx(w, w.manager))
        monkeypatch.setattr(Q, "_now", lambda: NOW)
        listed = R.list_quick_actions(product_id=None, limit=30, **ctx(w, w.manager))
        assert listed["items"][0]["result"]["dataArrived"] is False
        sell(w, w.tills[0], started - timedelta(minutes=30), 3)   # before
        sell(w, w.tills[1], started + timedelta(minutes=10), 4)   # since
        sell(w, w.tills[0], started + timedelta(minutes=90), 3)   # since
        sell(w, w.other_till, started + timedelta(minutes=20), 9)  # another shop: not reached
        w.db.commit()
        item = R.list_quick_actions(product_id=w.coffee.id, limit=30, **ctx(w, w.manager))["items"][0]
        assert item["id"] == out["id"] and item["status"] == "active"
        r = item["result"]
        assert r["dataArrived"] is True and r["hours"] == 2.0
        assert r["since"] == {"units": 7.0, "net": 8_400} and r["before"] == {"units": 3.0, "net": 3_600}
        assert r["changePct"] == 133.3 and r["lastWeek"]["units"] == 0.0 and r["changePctLastWeek"] is None
        # Another shop's manager does not see it.
        assert R.list_quick_actions(product_id=None, limit=30, **ctx(w, w.north_manager))["items"] == []


class TestSections:
    def test_each_quick_action_needs_its_own_section(self):
        assert DS.rule_for("POST", "/insights/quick-actions/messages").sections == ("till_messages",)
        assert DS.rule_for("POST", "/insights/quick-actions/messages/{action_id}/cancel").sections == ("till_messages",)
        assert DS.rule_for("POST", "/insights/quick-actions/promotions").sections == ("promotions",)
        assert DS.rule_for("POST", "/insights/quick-actions/promotions/{action_id}/cancel").sections == ("promotions",)
        assert DS.rule_for("GET", "/insights/anomalies").sections == ("reports",)
        assert DS.rule_for("PUT", "/insights/anomaly-settings").describe("PUT") == "reports:edit"
