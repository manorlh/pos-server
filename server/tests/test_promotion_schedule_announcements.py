"""
"Happy hour מתוזמן", "מבצע מזדמן" and "שלח הודעה לעובדים" — app/services/promotion_schedule.py,
app/services/promotion_announcements.py and the happy-hour / ad-hoc parts of
app/services/insights/quick_actions.py.

What each class pins, and how it could look fine while being wrong:

* **The schedule** — a weekday × hour window as instants in Israel's time: 16:00 is 13:00 UTC
  in summer and 14:00 in winter, across both changes of the clocks; a window that crosses
  midnight belongs to the day it started; two schedules overlap only when they run at the
  same moment (touching windows do not; a Friday-night window reaches Saturday's early hours).
* **The announcement** — a banner at the start (now, or scheduled for the first occurrence,
  sent lazily when it comes due) and, optionally, "המבצע הסתיים" at the very end; re-planned
  on every edit, taken down on pause and delete, never repeated once out; only who may send
  till messages (and holds the section) can switch it on.
* **Ad-hoc and happy hour** — a category or the whole basket, never below cost for any of
  its costed products; a happy hour's weekdays, hours and weeks, and what it overlaps.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.category import Category
from app.models.dashboard_access import DashboardAccessProfile
from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.promotion import Promotion
from app.models.till_message import TillMessage
from app.models.user import User, UserRole
from app.routers import insights as R
from app.routers import promotions as PR
from app.schemas.promotion import PromotionIn
from app.services import dashboard_access
from app.services import promotion_announcements as PA
from app.services import promotion_schedule as PS
from app.services import promotions as P
from app.services import till_messages as TM
from app.services.insights import quick_actions as Q
from app.services.insights import service as S
from shift_world import NOW, accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc


def utc(y, mo, d, h, mi=0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


# ═════════════════════════════════════════════════════════════════════════════
# The schedule
# ═════════════════════════════════════════════════════════════════════════════


class TestSchedule:
    def test_a_weekly_window_in_summer_and_in_winter(self):
        # Fridays 16:00–18:00 from 20.3 to 3.4.2026: Israel's clocks go forward on Friday 27.3 at 02:00.
        s = PS.Schedule(valid_from=date(2026, 3, 20), valid_to=date(2026, 4, 3), weekdays=(5,), start_time="16:00", end_time="18:00")
        occ = PS.occurrences(s, JLM, utc(2026, 3, 19, 0), utc(2026, 4, 5, 0))
        assert occ == [
            (utc(2026, 3, 20, 14), utc(2026, 3, 20, 16)),  # winter, +2
            (utc(2026, 3, 27, 13), utc(2026, 3, 27, 15)),  # the day the clocks moved: summer, +3
            (utc(2026, 4, 3, 13), utc(2026, 4, 3, 15)),
        ]
        # Mondays to the end of October: the clocks go back on Sunday 25.10.
        m = PS.Schedule(valid_from=date(2026, 10, 19), valid_to=date(2026, 10, 31), weekdays=(1,), start_time="16:00", end_time="18:00")
        assert PS.final_end(m, JLM) == utc(2026, 10, 26, 16)  # 18:00 winter time
        assert PS.current_or_next(m, JLM, utc(2026, 10, 20, 0)) == (utc(2026, 10, 26, 14), utc(2026, 10, 26, 16))

    def test_a_window_on_the_night_the_clocks_go_back(self):
        # Saturday 24.10 23:00 → 02:00: the clocks go from 02:00 back to 01:00 on the way —
        # the window lasts four real hours, and belongs to Saturday.
        s = PS.Schedule(weekdays=(6,), start_time="23:00", end_time="02:00")
        begins, ends = s.occurrence(date(2026, 10, 24), JLM)
        assert (begins, ends) == (utc(2026, 10, 24, 20), utc(2026, 10, 25, 0))
        assert (ends - begins) == timedelta(hours=4)
        # 01:30 on Sunday is still Saturday's occurrence.
        assert PS.current_or_next(s, JLM, utc(2026, 10, 24, 22, 30)) == (begins, ends)

    def test_the_occurrence_under_way_and_an_ended_schedule(self):
        s = PS.Schedule(valid_from=date(2026, 9, 1), valid_to=date(2026, 9, 30), start_time="20:00", end_time="22:00")
        assert PS.current_or_next(s, JLM, NOW) == (utc(2026, 9, 27, 17), utc(2026, 9, 27, 19))  # 21:00: under way
        assert PS.current_or_next(s, JLM, utc(2026, 10, 2, 0)) is None
        assert PS.final_end(PS.Schedule(valid_from=date(2026, 9, 1)), JLM) is None
        whole = PS.Schedule(valid_from=date(2026, 9, 27), valid_to=date(2026, 9, 30))
        assert PS.final_end(whole, JLM) == utc(2026, 9, 30, 21)  # midnight local

    def test_overlapping_windows(self):
        a = PS.Schedule(valid_from=date(2026, 10, 1), weekdays=(2,), start_time="16:00", end_time="18:00")
        later = PS.Schedule(valid_from=date(2026, 10, 1), weekdays=(2,), start_time="17:00", end_time="19:00")
        touching = PS.Schedule(valid_from=date(2026, 10, 1), weekdays=(2,), start_time="18:00", end_time="20:00")
        other_day = PS.Schedule(valid_from=date(2026, 10, 1), weekdays=(3,), start_time="16:00", end_time="18:00")
        hit = PS.overlaps(a, later, JLM, now=NOW)
        assert hit == (utc(2026, 10, 6, 14), utc(2026, 10, 6, 15))  # Tuesday 6.10, 17:00–18:00
        assert PS.overlaps(a, touching, JLM, now=NOW) is None
        assert PS.overlaps(a, other_day, JLM, now=NOW) is None
        # Friday 23:00–02:00 reaches into Saturday 01:00–03:00.
        friday_night = PS.Schedule(weekdays=(5,), start_time="23:00", end_time="02:00")
        saturday_small_hours = PS.Schedule(weekdays=(6,), start_time="01:00", end_time="03:00")
        assert PS.overlaps(friday_night, saturday_small_hours, JLM, now=NOW) is not None
        # Dates that never meet.
        september = PS.Schedule(valid_from=date(2026, 9, 1), valid_to=date(2026, 9, 30), weekdays=(2,), start_time="16:00", end_time="18:00")
        assert PS.overlaps(september, a, JLM, now=NOW) is None

    def test_weak_spans_merge(self):
        assert PS.merge_spans([(2, 15, 16), (2, 16, 18), (2, 20, 21), (4, 15, 16)]) == [(2, 15, 18), (2, 20, 21), (4, 15, 16)]


# ═════════════════════════════════════════════════════════════════════════════
# The world
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for module in (S, Q, TM, PA):
        monkeypatch.setattr(module, "_now", lambda: NOW)
    monkeypatch.setattr(P, "tenant_today", lambda db, tenant_id: date(2026, 9, 27))
    db = world.db

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.restricted = user(UserRole.SHOP_MANAGER, "restricted", shop_id=world.shop.id)
    db.flush()
    db.add(DashboardAccessProfile(user_id=world.manager.id, full_access=True, sections={}))
    db.add(DashboardAccessProfile(user_id=world.restricted.id, full_access=False, sections={"promotions": "edit", "reports": "view"}))
    world.drinks = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="שתייה")
    db.add(world.drinks)
    db.flush()

    def product(name, price, cost=None):
        p = Product(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name=name,
                    sku=f"S-{name}", price=Decimal(price), category_id=world.drinks.id, created_at=NOW - timedelta(days=300))
        db.add(p)
        db.flush()
        if cost is not None:
            db.add(ProductCost(id=uuid.uuid4(), tenant_id=world.tenant.id, product_id=p.id, cost=Decimal(cost)))
        return p

    world.beer = product("בירה", "30.00", "8.00")      # floor ₪9.44
    world.wine = product("יין", "40.00", "25.00")      # floor ₪29.50: 25% → ₪30 still above; 30% would not be
    world.water = product("מים", "8.00")               # no cost
    db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def promotion_in(w, **kw):
    body = {
        "name": "שעה שמחה", "type": "discount",
        "config": {"target": {"categoryIds": [str(w.drinks.id)]}, "discountKind": "percent", "discountValue": 20},
        "scopes": [{"type": "shop", "id": str(w.shop.id)}],
        "validFrom": "2026-09-27", "validTo": "2026-10-31", "weekdays": [1], "startTime": "16:00", "endTime": "18:00",
        "announcement": {"enabled": True, "text": None, "endEnabled": True, "endText": None},
    }
    body.update(kw)
    return PromotionIn.model_validate(body)


def messages(w, ids):
    return w.db.query(TillMessage).filter(TillMessage.id.in_([uuid.UUID(i) for i in ids or []])).all()


# ═════════════════════════════════════════════════════════════════════════════
# "שלח הודעה לעובדים"
# ═════════════════════════════════════════════════════════════════════════════


class TestAnnouncement:
    def test_scheduled_for_the_first_occurrence_and_the_very_end(self, w, monkeypatch):
        out = PR.create_promotion(promotion_in(w), BackgroundTasks(), **ctx(w, w.manager))
        promo = w.db.get(Promotion, uuid.UUID(out["id"]))
        state = promo.announcement
        (start,) = messages(w, state["startMessageIds"])
        # Monday 28.9 16:00 summer time; shown to the end of that window.
        assert start.schedule_kind == "scheduled" and TM._utc(start.send_at) == utc(2026, 9, 28, 13)
        assert TM._utc(start.expires_at) == utc(2026, 9, 28, 15)
        assert start.display == "banner" and start.color == "green" and start.target_level == "shop"
        assert start.body.startswith("מבצע: שעה שמחה — 20% הנחה") and "16:00–18:00" in start.body
        (end,) = messages(w, state["endMessageIds"])
        # The last Monday is 26.10, after the clocks went back: 18:00 is 16:00 UTC.
        assert TM._utc(end.send_at) == utc(2026, 10, 26, 16) and end.body == "המבצע הסתיים: שעה שמחה"
        assert out["announcement"]["enabled"] is True and out["announcement"]["startAt"] == utc(2026, 9, 28, 13).isoformat()
        # Nothing on the tills before it is due; once it is, the till's fetch sends it.
        assert TM.banners_for_machine(w.db, w.tills[0]) == []
        w.db.commit()
        monkeypatch.setattr(TM, "_now", lambda: utc(2026, 9, 28, 13, 30))
        banners = TM.banners_for_machine(w.db, w.tills[0])
        assert [b["id"] for b in banners] and banners[0]["body"] == start.body

    def test_running_now_goes_out_now_and_an_edit_replans_only_what_is_pending(self, w):
        body = promotion_in(w, weekdays=None, startTime=None, endTime=None, validTo="2026-09-30",
                            announcement={"enabled": True, "text": "מבצע על השתייה!", "endEnabled": False})
        out = PR.create_promotion(body, BackgroundTasks(), **ctx(w, w.manager))
        promo = w.db.get(Promotion, uuid.UUID(out["id"]))
        (start,) = messages(w, promo.announcement["startMessageIds"])
        assert start.schedule_kind == "now" and start.sent_at is not None and start.body == "מבצע על השתייה!"
        assert TM._utc(start.expires_at) == utc(2026, 9, 30, 21)  # to the end of its last day
        assert promo.announcement["endMessageIds"] == []
        # Edited: the start went out already — not repeated; the end is now asked for.
        PR.update_promotion(out["id"], promotion_in(w, weekdays=None, startTime=None, endTime=None, validTo="2026-09-29",
                                                    announcement={"enabled": True, "text": "מבצע על השתייה!", "endEnabled": True}),
                            BackgroundTasks(), **ctx(w, w.manager))
        w.db.refresh(promo)
        assert promo.announcement["startMessageIds"] == [str(start.id)]
        (end,) = messages(w, promo.announcement["endMessageIds"])
        assert TM._utc(end.send_at) == utc(2026, 9, 29, 21)
        assert w.db.query(TillMessage).count() == 2

    def test_pause_takes_it_down_resume_announces_again_delete_withdraws(self, w):
        out = PR.create_promotion(promotion_in(w), BackgroundTasks(), **ctx(w, w.manager))
        promo = w.db.get(Promotion, uuid.UUID(out["id"]))
        first = messages(w, promo.announcement["startMessageIds"] + promo.announcement["endMessageIds"])
        PR.pause_promotion(out["id"], _pause(True), BackgroundTasks(), **ctx(w, w.manager))
        assert all(m.cancelled_at is not None for m in first)
        w.db.refresh(promo)
        assert promo.announcement["startMessageIds"] == [] and promo.announcement["enabled"] is True
        PR.pause_promotion(out["id"], _pause(False), BackgroundTasks(), **ctx(w, w.manager))
        w.db.refresh(promo)
        again = messages(w, promo.announcement["startMessageIds"] + promo.announcement["endMessageIds"])
        assert len(again) == 2 and all(m.cancelled_at is None for m in again)
        PR.delete_promotion(out["id"], BackgroundTasks(), **ctx(w, w.manager))
        assert all(m.cancelled_at is not None for m in again)

    def test_switched_off_and_who_may_switch_it_on(self, w):
        body = promotion_in(w)
        with pytest.raises(HTTPException) as refused:
            PR.create_promotion(body, BackgroundTasks(), **ctx(w, w.restricted))
        assert refused.value.status_code == 403
        # Without the announcement the same user creates the promotion.
        out = PR.create_promotion(promotion_in(w, announcement=None), BackgroundTasks(), **ctx(w, w.restricted))
        assert out["announcement"]["enabled"] is False and w.db.query(TillMessage).count() == 0
        # The section opened: allowed.
        w.db.get(DashboardAccessProfile, w.restricted.id).sections = {"promotions": "edit", "till_messages": "edit"}
        w.db.commit()
        dashboard_access.forget(w.db)
        out = PR.update_promotion(out["id"], promotion_in(w), BackgroundTasks(), **ctx(w, w.restricted))
        assert out["announcement"]["enabled"] is True and w.db.query(TillMessage).count() == 2
        # Switched off: what is pending comes down.
        out = PR.update_promotion(out["id"], promotion_in(w, announcement={"enabled": False}), BackgroundTasks(), **ctx(w, w.restricted))
        assert out["announcement"]["enabled"] is False
        assert all(m.cancelled_at is not None for m in w.db.query(TillMessage).all())

    def test_the_whole_organization_is_announced_per_company(self, w):
        out = PR.create_promotion(promotion_in(w, scopes=[]), BackgroundTasks(), **ctx(w))
        promo = w.db.get(Promotion, uuid.UUID(out["id"]))
        starts = messages(w, promo.announcement["startMessageIds"])
        assert [(m.target_level, m.target_id) for m in starts] == [("company", w.company.id)]


def _pause(paused: bool):
    from app.schemas.promotion import PromotionPauseIn

    return PromotionPauseIn(paused=paused)


# ═════════════════════════════════════════════════════════════════════════════
# "מבצע מזדמן" and "Happy hour מתוזמן"
# ═════════════════════════════════════════════════════════════════════════════


def adhoc(w, **kw):
    body = {"categoryId": str(w.drinks.id), "targetLevel": "shop", "targetId": str(w.shop.id),
            "offer": {"kind": "percent", "value": 20}, "duration": {"kind": "end_of_day"}, "source": "adhoc"}
    body.update(kw)
    return body


class TestAdHoc:
    def test_a_category_checked_product_by_product(self, w):
        # 30% would put the wine (₪40, floor ₪29.50) at ₪28.
        with pytest.raises(HTTPException) as below:
            R.post_quick_promotion(BackgroundTasks(), body=adhoc(w, offer={"kind": "percent", "value": 30}), **ctx(w, w.manager))
        assert below.value.detail["code"] == Q.BELOW_COST
        assert [o["name"] for o in below.value.detail["offenders"]] == ["יין"]
        out = R.post_quick_promotion(BackgroundTasks(), body=adhoc(w), **ctx(w, w.manager))
        assert out["categoryId"] == str(w.drinks.id) and out["productId"] is None
        promo = w.db.query(Promotion).one()
        assert promo.config["target"]["categoryIds"] == [str(w.drinks.id)] and promo.name.startswith("מבצע מזדמן · שתייה")
        with pytest.raises(HTTPException) as fixed:
            R.post_quick_promotion(BackgroundTasks(), body=adhoc(w, offer={"kind": "fixed_price", "value": 500}), **ctx(w))
        assert fixed.value.detail == Q.BAD_OFFER

    def test_the_suggestion_for_a_group_and_the_whole_basket(self, w):
        s = R.get_promotion_suggestion(product_id=None, category_id=w.drinks.id, all_products=False, target_level=None, target_id=None, **ctx(w))
        # Wine keeps 26% margin: half of it is 13% → 10%.
        assert s["subject"] == {"kind": "category", "id": str(w.drinks.id), "name": "שתייה"}
        assert s["suggested"]["value"] == 10.0 and s["costedProducts"] == 2
        assert [o["belowCost"] for o in s["options"]] == [False, False, False, True]  # 10/15/20%, second at half
        everything = R.get_promotion_suggestion(product_id=None, category_id=None, all_products=True, target_level=None, target_id=None, **ctx(w))
        assert everything["subject"]["kind"] == "all"

    def test_an_announced_ad_hoc_promotion(self, w):
        out = R.post_quick_promotion(BackgroundTasks(), body=adhoc(w, announce={"enabled": True, "text": "20% על כל השתייה עד סוף היום"}),
                                     **ctx(w, w.manager))
        assert out["params"]["announce"]["enabled"] is True
        (message,) = w.db.query(TillMessage).all()
        assert message.schedule_kind == "now" and message.body == "20% על כל השתייה עד סוף היום"
        # "בטל מבצע" takes the banner down with it.
        R.cancel_quick_promotion(out["id"], BackgroundTasks(), **ctx(w, w.manager))
        w.db.refresh(message)
        assert message.cancelled_at is not None


def happy(w, **kw):
    body = {"weekdays": [2, 3], "startTime": "15:00", "endTime": "17:00", "weeks": 4, "all": True,
            "offer": {"kind": "percent", "value": 15}, "targetLevel": "shop", "targetId": str(w.shop.id)}
    body.update(kw)
    return body


class TestHappyHour:
    def test_weekdays_hours_and_weeks(self, w):
        out = R.post_happy_hour(BackgroundTasks(), body=happy(w), **ctx(w, w.manager))
        promo = w.db.query(Promotion).one()
        assert (promo.weekdays, promo.start_time, promo.end_time) == ([2, 3], "15:00", "17:00")
        assert (promo.valid_from, promo.valid_to) == (date(2026, 9, 27), date(2026, 10, 24))
        assert promo.config["target"] == {"all": True, "productIds": [], "categoryIds": [], "excludeProductIds": [], "excludeCategoryIds": []}
        assert out["params"]["nextStart"] == utc(2026, 9, 29, 12).isoformat()  # Tuesday 15:00 summer time
        assert out["endsAt"] == utc(2026, 10, 21, 14).isoformat()  # last Wednesday 17:00 (+3)
        assert out["params"]["overlaps"] == [] and promo.name.startswith("Happy hour · ג׳, ד׳ 15:00–17:00")

    def test_an_overlapping_happy_hour_is_flagged_not_refused(self, w):
        R.post_happy_hour(BackgroundTasks(), body=happy(w), **ctx(w, w.manager))
        out = R.post_happy_hour(BackgroundTasks(), body=happy(w, weekdays=[3], startTime="16:00", endTime="18:00"), **ctx(w, w.manager))
        (hit,) = out["params"]["overlaps"]
        assert hit["startTime"] == "15:00" and hit["at"] == utc(2026, 9, 30, 13).isoformat()  # Wednesday 16:00

    @pytest.mark.parametrize("change", [{"weekdays": []}, {"weekdays": [7]}, {"startTime": "15:00", "endTime": "15:00"},
                                        {"startTime": "25:00"}, {"weeks": 0}, {"weeks": 13}])
    def test_refused_schedules(self, w, change):
        with pytest.raises(HTTPException) as bad:
            R.post_happy_hour(BackgroundTasks(), body=happy(w, **change), **ctx(w, w.manager))
        assert bad.value.detail == Q.BAD_SCHEDULE

    def test_who_may(self, w):
        cashier = User(id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=w.tenant.id, email="c@x", username="c", shop_id=w.shop.id)
        w.db.add(cashier)
        w.db.commit()
        with pytest.raises(HTTPException) as refused:
            R.post_happy_hour(BackgroundTasks(), body=happy(w), **ctx(w, cashier))
        assert refused.value.status_code == 403

    def test_suggestions_from_the_weak_slots(self, w):
        fake = SimpleNamespace(
            clock=SimpleNamespace(tz_name="Asia/Jerusalem", now=NOW, day_start_hour=4),
            db=w.db, scope=SimpleNamespace(tenant_id=w.tenant.id),
        )
        heatmap = {"weak": [
            {"weekday": 2, "fromHour": 15, "toHour": 16, "deviationPct": -45, "gapPerWeek": 4_000, "typicalNet": 2_000, "usual": 6_000},
            {"weekday": 2, "fromHour": 16, "toHour": 18, "deviationPct": -50, "gapPerWeek": 9_000, "typicalNet": 3_000, "usual": 12_000},
            {"weekday": 5, "fromHour": 1, "toHour": 3, "deviationPct": -60, "gapPerWeek": 1_000, "typicalNet": 500, "usual": 1_500},
        ]}
        out = Q.happy_hour_suggestions(fake, heatmap)
        first, second = out["suggestions"]
        assert (first["weekdays"], first["startTime"], first["endTime"]) == ([2], "15:00", "18:00")
        assert first["gapPerWeek"] == 13_000 and first["deviationPct"] == -50
        # Friday's business day at 01:00 is Saturday on the calendar.
        assert (second["weekday"], second["weekdays"], second["startTime"]) == (5, [6], "01:00")
        R.post_happy_hour(BackgroundTasks(), body=happy(w, weekdays=[2], startTime="17:00", endTime="19:00"), **ctx(w, w.manager))
        again = Q.happy_hour_suggestions(fake, heatmap)["suggestions"][0]
        assert [o["startTime"] for o in again["overlaps"]] == ["17:00"]
