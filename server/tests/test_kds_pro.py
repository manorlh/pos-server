"""
What the kitchen learned from a reference KDS (docs/SPEC_KDS.md §16, P:\\specs\\kds-pro.md) — the
cloud's part, all additive:

* **The screen's behaviour keys** in `kds_devices.display` v2 (tapping an item, FIFO / LIFO, tickets
  per row, the most height of a ticket, keep a finished ticket, filter by item, a station's rush,
  urgency levels, overflow, the order types, external orders, the service tints, more on a ticket):
  saved, cleaned and sent with the screen; a bad value is refused; **a missing key is today's
  behaviour, and every key of before resolves exactly as before**.
* **`requeue`** — an item back to "ממתין" (the ticket menu's "הכול ממתין", a tap cycling it): a
  station only on its own items; held / cancelled refused; a group ready for pickup goes back to
  waiting (and its event is suppressed, as an undo).
* **A station's "דחוף"** — refused as always, unless its screen is set to `stationRush`.
* **`serviceType: "delivery"`** on a release.

Runs on the world of tests/test_kds.py (SQLite).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.kds import KdsDevice
from app.routers import kds as R
from app.schemas.kds import KdsDeviceIn, KdsDisplayDefaultsIn
from app.services import kds_display as D
from test_kds import _task, act, board, configure, events, item, kd, refused, release  # noqa: F401
from test_kds_screen_design import TODAY_BOARD, TODAY_KDS
from test_kitchen_printers import k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401

#: Today's behaviour: what a screen without these keys does.
TODAY_BEHAVIOUR = {
    "toolbar": True, "allDay": False, "itemTap": "button", "ticketOrder": "fifo", "perRow": None, "maxTicketHeight": None,
    "keepReadyOpen": True, "filterFullTicket": False, "stationRush": False, "urgencyLevels": False, "overflowAt": None,
    "orderTypes": {"eatIn": True, "takeAway": True, "delivery": True}, "externalOrders": "all",
    "serviceTint": {"takeAway": False, "delivery": False},
    "ticketInfo": {"source": True, "orderTime": False, "orderNumber": False, "readyBy": False},
}

FULL = {
    "toolbar": False, "allDay": True, "itemTap": "cycle", "ticketOrder": "lifo", "perRow": 6, "maxTicketHeight": 500,
    "keepReadyOpen": False, "filterFullTicket": True, "stationRush": True, "urgencyLevels": True, "overflowAt": 25,
    "orderTypes": {"eatIn": True, "takeAway": False, "delivery": True}, "externalOrders": "only",
    "serviceTint": {"takeAway": True, "delivery": True},
    "ticketInfo": {"source": False, "orderTime": True, "orderNumber": True, "readyBy": True},
}


def _save(w, screen, role, display=None, **extra):
    body = {"role": role, "name": f"{role} screen", **extra}
    if display is not None:
        body["display"] = display
    if role == "station":
        body.setdefault("stationIds", [w.grill])
    return R.put_kds_device(w.shop.id, screen.id, KdsDeviceIn.model_validate(body), **_ctx(w))


# ── The behaviour keys ────────────────────────────────────────────────────────


class TestBehaviourKeys:
    def test_missing_keys_are_todays_behaviour_and_the_old_keys_resolve_as_before(self):
        out = D.display_out({})
        assert {k: out[k] for k in TODAY_BEHAVIOUR} == TODAY_BEHAVIOUR
        assert {k: out[k] for k in TODAY_KDS} == TODAY_KDS
        assert {k: out[k] for k in TODAY_BOARD} == TODAY_BOARD
        # A look saved before (every old key set) draws exactly what it drew, with today's behaviour.
        before = {
            "v": 2, "theme": "light", "accent": "#123456", "layout": "rail", "columnsBy": "course", "density": "compact",
            "fontScale": 1.2, "ageColors": False, "warnMinutes": 5, "lateMinutes": 9, "clock": False, "counts": False,
            "fields": {"table": False, "waiter": False}, "sounds": {"new": "bell"},
        }
        old = D.display_out(before)
        assert (old["theme"], old["accent"], old["layout"], old["columnsBy"], old["density"]) == ("light", "#123456", "rail", "course", "compact")
        assert (old["fontScale"], old["ageColors"], old["warnMinutes"], old["lateMinutes"], old["clock"], old["counts"]) == (1.2, False, 5, 9, False, False)
        assert old["fields"]["table"] is False and old["fields"]["waiter"] is False and old["sounds"]["new"] == "bell"
        # The source chip used to be the "table" switch: a screen that hid it keeps it hidden.
        assert old["ticketInfo"]["source"] is False
        assert {k: old[k] for k in TODAY_BEHAVIOUR if k != "ticketInfo"} == {k: v for k, v in TODAY_BEHAVIOUR.items() if k != "ticketInfo"}

    def test_a_full_behaviour_is_saved_cleaned_and_sent_with_the_screen(self, kd):
        out = _save(kd, kd.expo_screen, "expo", {"layout": "tickets", **FULL})
        d = out["display"]
        assert {k: d[k] for k in FULL} == FULL
        assert board(kd, kd.expo_screen)["device"]["display"] == d
        assert R.get_kds_device(str(kd.expo_screen.id), machine=kd.expo_screen, db=kd.db)["device"]["display"] == d

    def test_an_older_dashboard_saving_without_the_keys_gets_todays_behaviour(self, kd):
        d = _save(kd, kd.expo_screen, "expo", {"layout": "list"})["display"]
        assert {k: d[k] for k in TODAY_BEHAVIOUR} == TODAY_BEHAVIOUR

    def test_the_shops_default_carries_them_too(self, kd):
        out = R.put_kds_display_defaults(kd.shop.id, KdsDisplayDefaultsIn.model_validate({"kds": {"itemTap": "ready", "perRow": 7}}), **_ctx(kd))
        assert out["displayDefaults"]["kds"]["itemTap"] == "ready"
        e = board(kd, kd.grill_screen)["device"]["display"]
        assert (e["itemTap"], e["perRow"]) == ("ready", 7)

    @pytest.mark.parametrize("bad", [
        {"itemTap": "double"}, {"ticketOrder": "random"}, {"perRow": 1}, {"perRow": 11}, {"maxTicketHeight": 100},
        {"maxTicketHeight": 5000}, {"overflowAt": 2}, {"overflowAt": 500}, {"externalOrders": "some"},
        {"orderTypes": {"eatIn": "maybe"}}, {"serviceTint": {"delivery": "sometimes"}}, {"ticketInfo": {"readyBy": "x"}},
    ])
    def test_a_bad_value_is_refused(self, bad):
        with pytest.raises(ValidationError):
            KdsDeviceIn(role="expo", display=bad)

    def test_a_stored_bad_value_is_cleaned_on_the_way_out(self):
        out = D.display_out({
            "itemTap": "x", "ticketOrder": 3, "perRow": 99, "maxTicketHeight": "500", "overflowAt": 1.5,
            "orderTypes": {"eatIn": "no", "delivery": False}, "externalOrders": None, "serviceTint": "both",
            "ticketInfo": {"orderTime": True, "readyBy": 1}, "toolbar": "off", "stationRush": 1,
        })
        assert (out["itemTap"], out["ticketOrder"], out["perRow"], out["maxTicketHeight"], out["overflowAt"]) == ("button", "fifo", None, None, None)
        assert out["orderTypes"] == {"eatIn": True, "takeAway": True, "delivery": False}
        assert out["externalOrders"] == "all" and out["serviceTint"] == {"takeAway": False, "delivery": False}
        assert out["ticketInfo"] == {"source": True, "orderTime": True, "orderNumber": False, "readyBy": False}
        assert out["toolbar"] is True and out["stationRush"] is False

    def test_a_v1_board_look_on_a_kitchen_screen_still_falls_through(self, kd):
        screen = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == kd.expo_screen.id).one()
        screen.display = {"theme": "light", "stationRush": True}
        kd.db.flush()
        assert board(kd, kd.expo_screen)["device"]["display"] is None


# ── requeue ───────────────────────────────────────────────────────────────────


class TestRequeue:
    def test_a_ready_item_goes_back_to_waiting(self, kd):
        release(kd, ref="q1", items=[item("l1:0", kd.steak, qty=2)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        out = act(kd, kd.grill_screen, "requeue", taskId=t["id"])
        assert out["outcome"] == "applied"
        back = _task(board(kd, kd.grill_screen), "steak")
        assert (back["state"], back["preparedQty"], back["startedAt"], back["readyAt"]) == ("queued", 0.0, None, None)
        # Again: nothing to do.
        assert act(kd, kd.grill_screen, "requeue", taskId=t["id"])["outcome"] == "noop"

    def test_a_started_item_goes_back_to_waiting(self, kd):
        release(kd, ref="q2", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "start", taskId=t["id"])
        act(kd, kd.grill_screen, "requeue", taskId=t["id"])
        assert _task(board(kd, kd.grill_screen), "steak")["state"] == "queued"

    def test_only_a_stations_own_items_and_never_from_the_pickup_screen(self, kd):
        release(kd, ref="q3", items=[item("l2:0", kd.cola)])
        t = _task(board(kd, kd.bar_screen), "cola")
        assert refused(act, kd, kd.grill_screen, "requeue", taskId=t["id"]).status_code == 403
        assert refused(act, kd, kd.pickup_screen, "requeue", taskId=t["id"]).status_code == 403
        assert refused(act, kd, kd.grill_screen, "requeue").status_code == 422

    def test_a_held_or_cancelled_item_is_not_queued(self, kd):
        release(kd, ref="q4", items=[item("l1:0", kd.steak)], held=[item("l9:0", kd.steak)])
        held = [t for o in board(kd, kd.expo_screen)["orders"] for t in o["tasks"] if t["release"] == "hold"][0]
        assert act(kd, kd.expo_screen, "requeue", taskId=held["id"])["reason"] == "task_held"
        release(kd, ref="q4", trigger="cancel")
        live = [t for o in board(kd, kd.expo_screen)["orders"] for t in o["tasks"] if t["release"] == "released"][0]
        assert act(kd, kd.expo_screen, "requeue", taskId=live["id"])["reason"] == "task_cancelled"

    def test_an_order_ready_for_pickup_goes_back_to_waiting_and_its_event_is_suppressed(self, kd):
        release(kd, source="quick", ref="q5", paid=True, trigger="payment", contactPhone="+972501234567", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "ready_for_pickup"
        act(kd, kd.expo_screen, "requeue", taskId=t["id"])
        order = board(kd, kd.expo_screen)["orders"][0]
        assert (order["groupState"], order["status"], order["allReady"]) == ("waiting", "open", False)
        [event] = events(kd)
        assert event.result == "suppressed:undo"
        # Ready again: the same event, pending again (no second ReadyForPickup).
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        [event] = events(kd)
        assert event.state == "pending"

    def test_a_retry_is_one_action(self, kd):
        release(kd, ref="q6", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        first = act(kd, kd.grill_screen, "requeue", aid="requeue-retry-1", taskId=t["id"])
        again = act(kd, kd.grill_screen, "requeue", aid="requeue-retry-1", taskId=t["id"])
        assert first["outcome"] == "applied" and again["replayed"] is True


# ── A station's rush ──────────────────────────────────────────────────────────


class TestStationRush:
    def _order(self, kd, ref):
        out = release(kd, ref=ref, items=[item("l1:0", kd.steak)])
        return out["orderId"]

    def test_refused_by_default_as_always(self, kd):
        oid = self._order(kd, "r1")
        assert refused(act, kd, kd.grill_screen, "priority", orderId=oid, priority=1, reason="לקוח ממתין").status_code == 403
        # The Expo, as always.
        assert act(kd, kd.expo_screen, "priority", orderId=oid, priority=1, reason="לקוח ממתין")["outcome"] == "applied"

    def test_allowed_when_the_screen_is_set_so_with_a_reason_and_levels(self, kd):
        _save(kd, kd.grill_screen, "station", {"stationRush": True, "urgencyLevels": True})
        oid = self._order(kd, "r2")
        assert refused(act, kd, kd.grill_screen, "priority", orderId=oid, priority=2).status_code == 422
        assert act(kd, kd.grill_screen, "priority", orderId=oid, priority=2, reason="תלונת לקוח")["outcome"] == "applied"
        o = board(kd, kd.grill_screen)["orders"][0]
        assert (o["priority"], o["priorityReason"]) == (2, "תלונת לקוח")

    def test_from_the_shops_default_too_and_off_again(self, kd):
        R.put_kds_display_defaults(kd.shop.id, KdsDisplayDefaultsIn.model_validate({"kds": {"stationRush": True}}), **_ctx(kd))
        oid = self._order(kd, "r3")
        assert act(kd, kd.grill_screen, "priority", orderId=oid, priority=1, reason="x")["outcome"] == "applied"
        _save(kd, kd.grill_screen, "station", {"stationRush": False})
        assert refused(act, kd, kd.grill_screen, "priority", orderId=oid, priority=0, reason="x").status_code == 403


# ── Delivery ──────────────────────────────────────────────────────────────────


class TestDelivery:
    def test_a_release_may_say_delivery(self, kd):
        configure(kd, enabled=True, defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"],
                  targets=["printer", "kds", "expo", "pickup_screen"], readyNotification=False)
        release(kd, source="external", ref="wolt-1", serviceType="delivery", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        o = board(kd, kd.expo_screen)["orders"][0]
        assert (o["source"], o["serviceType"]) == ("external", "delivery")
        # Routed as any order (the overrides by service type are eat_in / take_away).
        assert _task(board(kd, kd.grill_screen), "steak")["stationId"] == kd.grill
