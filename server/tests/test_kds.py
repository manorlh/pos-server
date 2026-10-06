"""
KDS engine (docs/SPEC_KDS.md; owner's spec "חלק א — KDS" §4–12, acceptance §36).

What each class pins:

* **Idempotency & isolation (§36.1)** — a retried release creates no second task; another
  shop's till cannot see or touch the order.
* **Readiness (§36.2)** — one station ready is not the order ready; the Expo gate; a
  manager's override needs a reason.
* **The ready event (§36.3, §36.4)** — one ReadyForPickup per group: undo + ready again
  re-arms the same row; an undo / handover / cancellation before a consumer took it
  suppresses it; after it was taken, a follow-up event is written instead.
* **Offline actions (§36.8)** — a late action never revives a cancellation; prepared
  before the cancellation is recorded, not lost.
* **Fallback printer (§36.21)** — a round printed on the fallback printer is reconciled,
  never prepared twice by default.
* **Rounds, changes, hold / fire, routing, the pickup screen, permissions.**

Runs on the world of tests/test_kitchen_printers.py (SQLite).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.kds import KitchenTask
from app.models.outbox import OutboxEvent
from app.models.pos_machine import PairingStatus, POSMachine
from app.routers import kds as R
from app.routers import printers as PR
from app.schemas.kds import KdsActionIn, KdsDeviceIn, KdsReleaseIn, KdsRouteOverrideIn, WorkflowValuesIn
from app.services import kds_outbox
from test_kitchen_printers import _run, k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401


# ── World ─────────────────────────────────────────────────────────────────────


def _till(w, name, shop=None):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, distributor_id=w.admin.id, name=name,
        machine_code=f"K-{uuid.uuid4().hex[:6]}", pos_number=str(90 + len(w.db.query(POSMachine).all())),
        is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(m)
    w.db.flush()
    return m


def _station(w, name):
    tasks = BackgroundTasks()
    out = PR.create_station(PR.StationIn(name=name), tasks, **_ctx(w))
    _run(tasks)
    return out["id"]


def _assign(w, target_type, target, sid):
    tasks = BackgroundTasks()
    PR.put_station_target(
        PR.StationTargetIn(targetType=target_type, targetId=target.id, stationId=uuid.UUID(sid) if sid else None),
        tasks, **_ctx(w),
    )
    _run(tasks)


def device(w, machine, role, *stations, shop=None):
    return R.put_kds_device(
        (shop or w.shop).id, machine.id,
        KdsDeviceIn(role=role, stationIds=[uuid.UUID(s) for s in stations], name=f"{role} screen"),
        **_ctx(w),
    )


def configure(w, scope_type="shop", scope_id=None, **values):
    tasks = BackgroundTasks()
    out = R.put_workflow_config(
        WorkflowValuesIn(scopeType=scope_type, scopeId=scope_id or w.shop.id, values=values), tasks, **_ctx(w)
    )
    _run(tasks)
    return out


@pytest.fixture
def kd(k):
    """Grill (Mains) and bar (Drinks) stations with a screen each, an Expo, a pickup screen."""
    k.grill = _station(k, "גריל")
    k.bar = _station(k, "בר")
    _assign(k, "category", k.mains, k.grill)
    _assign(k, "category", k.drinks, k.bar)
    k.waiter = k.tills[0]
    k.grill_screen = _till(k, "KDS grill")
    k.bar_screen = _till(k, "KDS bar")
    k.expo_screen = _till(k, "Expo")
    k.pickup_screen = _till(k, "Pickup TV")
    device(k, k.grill_screen, "station", k.grill)
    device(k, k.bar_screen, "station", k.bar)
    device(k, k.expo_screen, "expo")
    device(k, k.pickup_screen, "pickup")
    k.db.commit()
    configure(
        k, enabled=True, defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"],
        targets=["printer", "kds", "expo", "pickup_screen"], readyNotification=True,
    )
    return k


def item(line, product, qty=1.0, **over):
    base = {
        "lineKey": line, "productId": str(product.id), "categoryId": str(product.category_id),
        "name": product.name, "quantity": qty,
    }
    base.update(over)
    return base


def release(w, till=None, rid=None, source="table", ref="order-1", items=(), **over):
    body = {
        "id": rid or str(uuid.uuid4()), "source": source, "sourceRef": ref, "trigger": "send",
        "displayRef": "שולחן 12", "items": list(items),
    }
    body.update(over)
    return R.post_kds_release(str((till or w.waiter).id), KdsReleaseIn.model_validate(body), machine=till or w.waiter, db=w.db)


def act(w, screen, type_, aid=None, **fields):
    body = {"id": aid or str(uuid.uuid4()), "type": type_}
    body.update({k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in fields.items()})
    return R.post_kds_action(str(screen.id), KdsActionIn.model_validate(body), machine=screen, db=w.db)


def board(w, screen, since=None):
    return R.get_kds_board(str(screen.id), since=since, machine=screen, db=w.db)


def tasks_of(w, order_id=None):
    q = w.db.query(KitchenTask)
    if order_id:
        q = q.filter(KitchenTask.order_id == uuid.UUID(order_id))
    return q.all()


def events(w, type_="ReadyForPickup"):
    return w.db.query(OutboxEvent).filter(OutboxEvent.event_type == type_).all()


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def _task(board_out, name):
    for order in board_out["orders"]:
        for t in order["tasks"]:
            if t["name"] == name:
                return t
    raise AssertionError(f"no task {name}")


# ── §36.1 Idempotency and isolation ───────────────────────────────────────────


class TestIdempotency:
    def test_a_retried_release_creates_no_second_task(self, kd):
        rid = str(uuid.uuid4())
        first = release(kd, rid=rid, items=[item("l1:0", kd.steak, 2), item("l2:0", kd.cola)])
        again = release(kd, rid=rid, items=[item("l1:0", kd.steak, 2), item("l2:0", kd.cola)])
        assert first["tasksCreated"] == 2
        assert again["replayed"] is True and again["dispatchId"] == first["dispatchId"]
        assert len(tasks_of(kd)) == 2

    def test_a_retried_action_is_applied_once(self, kd):
        release(kd, items=[item("l1:0", kd.steak, 3)])
        t = _task(board(kd, kd.grill_screen), "steak")
        aid = str(uuid.uuid4())
        act(kd, kd.grill_screen, "item_ready", aid=aid, taskId=t["id"], qty=1)
        again = act(kd, kd.grill_screen, "item_ready", aid=aid, taskId=t["id"], qty=1)
        assert again["replayed"] is True
        assert _task(board(kd, kd.grill_screen), "steak")["preparedQty"] == 1.0

    def test_two_screens_marking_the_same_unit_prepare_it_once(self, kd):
        release(kd, items=[item("l1:0", kd.steak, 1)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        second = act(kd, kd.expo_screen, "item_ready", taskId=t["id"])
        assert second["outcome"] == "noop"
        assert _task(board(kd, kd.expo_screen), "steak")["preparedQty"] == 1.0

    def test_another_shops_till_neither_sees_nor_touches_it(self, kd):
        release(kd, items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        north_kds = _till(kd, "North KDS", shop=kd.other_shop)
        device(kd, north_kds, "expo", shop=kd.other_shop)
        assert board(kd, north_kds)["orders"] == []
        assert refused(act, kd, north_kds, "start", taskId=t["id"]).status_code == 404
        # A till of another shop cannot add to this shop's order by guessing its ref.
        e = refused(release, kd, till=kd.other_till, items=[item("x:0", kd.steak)])
        assert e.status_code == 409 and e.detail["code"] == "order_of_another_shop"

    def test_a_till_that_is_not_a_kds_screen_gets_no_board(self, kd):
        assert refused(board, kd, kd.waiter).status_code == 403

    def test_a_station_screen_acts_only_on_its_station(self, kd):
        release(kd, items=[item("l2:0", kd.cola)])
        t = _task(board(kd, kd.bar_screen), "cola")
        assert refused(act, kd, kd.grill_screen, "start", taskId=t["id"]).status_code == 403
        assert refused(act, kd, kd.pickup_screen, "start", taskId=t["id"]).status_code == 403


# ── §36.2 Readiness ───────────────────────────────────────────────────────────


class TestReadiness:
    def test_one_station_ready_is_not_the_order_ready(self, kd):
        out = release(kd, items=[item("l1:0", kd.steak), item("l2:0", kd.cola)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "waiting"
        assert events(kd) == []
        act(kd, kd.bar_screen, "station_ready", orderId=out["orderId"])
        expo = board(kd, kd.expo_screen)["orders"][0]
        assert expo["groupState"] == "ready_for_pickup" and expo["status"] == "ready"
        assert len(events(kd)) == 1

    def test_a_view_only_station_never_blocks(self, kd):
        R.put_kds_station(
            kd.shop.id, uuid.UUID(kd.bar), R.KdsStationSettingIn(targetKind="view"), **_ctx(kd)
        )
        out = release(kd, items=[item("l1:0", kd.steak), item("l2:0", kd.cola)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "ready_for_pickup"

    def test_with_expo_required_only_the_expo_sets_it_ready(self, kd):
        configure(kd, requireExpo=True)
        out = release(kd, ref="order-x", items=[item("l1:0", kd.steak), item("l2:0", kd.cola)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        early = act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"])
        assert early["outcome"] == "rejected" and early["reason"] == "not_all_ready"
        assert [m["name"] for m in early["missing"]] == ["cola"]
        act(kd, kd.bar_screen, "station_ready", orderId=out["orderId"])
        # Every station is done, but nobody but the Expo makes it ready.
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "waiting"
        assert events(kd) == []
        assert act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"])["outcome"] == "applied"
        assert len(events(kd)) == 1
        # A station screen may not.
        assert refused(act, kd, kd.grill_screen, "ready_for_pickup", orderId=out["orderId"]).status_code == 403

    def test_an_override_needs_a_reason_and_is_recorded(self, kd):
        configure(kd, requireExpo=True)
        out = release(kd, items=[item("l1:0", kd.steak), item("l2:0", kd.cola)])
        assert refused(act, kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"], override=True).status_code == 422
        done = act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"], override=True, reason="לקוח ממהר")
        assert done["outcome"] == "applied"
        expo = board(kd, kd.expo_screen)["orders"][0]
        assert expo["groupOverride"] == "לקוח ממהר"
        assert any(c["kind"] == "override" for c in expo["changes"])
        assert events(kd)[0].payload["override"] is True

    def test_require_start_refuses_ready_before_start(self, kd):
        configure(kd, requireStartPreparation=True)
        release(kd, ref="o-s", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        assert act(kd, kd.grill_screen, "item_ready", taskId=t["id"])["reason"] == "start_required"
        act(kd, kd.grill_screen, "start", taskId=t["id"])
        assert act(kd, kd.grill_screen, "item_ready", taskId=t["id"])["outcome"] == "applied"


# ── §36.3 / §36.4 The ready event ─────────────────────────────────────────────


class TestReadyEvent:
    def _ready(self, kd, ref="o-1"):
        out = release(kd, source="quick", ref=ref, paid=True, trigger="payment",
                      contactPhone="+972501234567", pickupName="דנה", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        return out, t

    def test_one_event_with_a_minimal_payload(self, kd):
        out, _ = self._ready(kd)
        [event] = events(kd)
        assert event.state == "pending" and event.aggregate_type == "fulfillment_group"
        assert event.payload["orderId"] == out["orderId"] and event.payload["notify"] is True
        assert event.payload["pickupNumber"] == out["pickupNumber"]
        assert "pickupName" not in event.payload
        assert kds_outbox.still_valid(kd.db, event)["valid"] is True
        assert kds_outbox.order_contact(kd.db, event)["phone"] == "+972501234567"

    def test_undo_then_ready_again_re_arms_the_same_event(self, kd):
        _, t = self._ready(kd)
        act(kd, kd.grill_screen, "undo_ready", taskId=t["id"])
        [event] = events(kd)
        assert event.state == "processed" and event.result == "suppressed:undo"
        assert kds_outbox.still_valid(kd.db, event)["valid"] is False
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        [event] = events(kd)
        assert event.state == "pending" and event.result is None

    def test_after_a_consumer_took_it_undo_and_ready_make_no_second_ready_event(self, kd):
        _, t = self._ready(kd)
        [event] = events(kd)
        event.state = "processing"  # a consumer took it
        kd.db.flush()
        act(kd, kd.grill_screen, "undo_ready", taskId=t["id"])
        assert len(events(kd, "ReadyRevoked")) == 1
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        assert len(events(kd)) == 1

    def test_handover_before_the_consumer_suppresses_it(self, kd):
        out, _ = self._ready(kd)
        act(kd, kd.expo_screen, "handover", orderId=out["orderId"])
        [event] = events(kd)
        assert event.result == "suppressed:handed_over"
        assert events(kd, "HandedOver") == []  # nothing was taken, nothing to follow up

    def test_handover_after_the_consumer_took_it_writes_a_follow_up(self, kd):
        out, _ = self._ready(kd)
        events(kd)[0].state = "processed"
        kd.db.flush()
        act(kd, kd.expo_screen, "handover", orderId=out["orderId"])
        assert len(events(kd, "HandedOver")) == 1

    def test_a_cancellation_before_the_consumer_suppresses_it(self, kd):
        self._ready(kd, ref="o-c")
        release(kd, source="quick", ref="o-c", trigger="cancel", paid=True, items=[])
        [event] = events(kd)
        assert event.result == "suppressed:cancelled"

    def test_a_double_tap_on_ready_for_pickup_is_one_event(self, kd):
        configure(kd, requireExpo=True)
        out = release(kd, ref="dbl", items=[item("l1:0", kd.steak)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"])
        assert act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"])["outcome"] == "noop"
        assert len(events(kd)) == 1


# ── §36.8 Offline actions never revive a cancellation ─────────────────────────


class TestOfflineActions:
    def test_a_late_ready_acts_on_the_active_quantity_only(self, kd):
        release(kd, ref="o-2", items=[item("l1:0", kd.steak, 2)])
        release(kd, ref="o-2", items=[item("l1:0", kd.steak, -1)])
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["activeQty"] == 1.0 and t["cancelledQty"] == 1.0
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"], qty=2,
            occurredAt=(datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat())
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["preparedQty"] == 1.0 and t["activeQty"] == 1.0 and t["state"] == "ready"

    def test_a_fully_cancelled_task_stays_cancelled(self, kd):
        release(kd, ref="o-3", items=[item("l1:0", kd.steak, 1)])
        release(kd, ref="o-3", items=[item("l1:0", kd.steak, -1)])
        t = _task(board(kd, kd.grill_screen), "steak")  # still shown: the cancel waits for "ראיתי"
        out = act(kd, kd.grill_screen, "item_ready", taskId=t["id"])
        assert out["outcome"] == "rejected" and out["reason"] == "task_cancelled"
        row = kd.db.query(KitchenTask).filter(KitchenTask.id == uuid.UUID(t["id"])).one()
        assert float(row.ordered_qty) - float(row.cancelled_qty) == 0.0

    def test_prepared_before_the_cancellation_is_recorded_not_revived(self, kd):
        release(kd, ref="o-4", items=[item("l1:0", kd.steak, 1)])
        before_cancel = datetime.now(timezone.utc) - timedelta(minutes=1)
        release(kd, ref="o-4", items=[item("l1:0", kd.steak, -1)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "item_ready", taskId=t["id"], qty=1, occurredAt=before_cancel.isoformat())
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["overPrepared"] is True and t["preparedQty"] == 1.0 and t["activeQty"] == 0.0
        # Not a live dish: the order is cancelled, no ready event.
        assert events(kd) == []


# ── §36.21 Fallback printer reconciliation ────────────────────────────────────


class TestFallback:
    def test_a_fallback_round_is_reconciled_not_prepared_twice(self, kd):
        out = release(kd, ref="fb", fallbackPrinted=True, items=[item("l1:0", kd.steak, 2)])
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["fallbackPrinted"] is True and t["fallbackResolved"] is False
        act(kd, kd.grill_screen, "resolve_fallback", taskId=t["id"], resolution="prepared")
        t = _task(board(kd, kd.expo_screen), "steak")
        assert t["state"] == "ready" and t["fallbackResolved"] is True
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "ready_for_pickup"
        # Resolving again changes nothing.
        assert act(kd, kd.grill_screen, "resolve_fallback", taskId=t["id"], resolution="prepared")["outcome"] == "noop"
        assert out["tasksCreated"] == 1

    def test_to_prepare_keeps_it_in_the_queue(self, kd):
        release(kd, ref="fb2", fallbackPrinted=True, items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "resolve_fallback", taskId=t["id"], resolution="prepare")
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["state"] == "queued" and t["fallbackResolved"] is True

    def test_a_retry_after_a_lost_answer_and_a_fallback_print_flags_the_round(self, kd):
        rid = str(uuid.uuid4())
        release(kd, rid=rid, ref="fb3", items=[item("l1:0", kd.steak)])
        again = release(kd, rid=rid, ref="fb3", fallbackPrinted=True, items=[item("l1:0", kd.steak)])
        assert again["replayed"] is True
        assert len(tasks_of(kd)) == 1
        assert _task(board(kd, kd.grill_screen), "steak")["fallbackPrinted"] is True


# ── Rounds, changes, hold / fire ──────────────────────────────────────────────


class TestRoundsAndChanges:
    def test_more_of_a_ready_line_is_one_new_unit(self, kd):
        out = release(kd, ref="r", items=[item("l1:0", kd.steak, 2)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        second = release(kd, ref="r", items=[item("l1:0", kd.steak, 1)])
        assert second["roundNo"] == 2 and second["tasksCreated"] == 1
        rows = sorted(tasks_of(kd, out["orderId"]), key=lambda t: t.round_no)
        assert [(t.round_no, float(t.ordered_qty), t.prep_state) for t in rows] == [(1, 2.0, "ready"), (2, 1.0, "queued")]
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "waiting"

    def test_a_cancel_waits_for_the_station_to_see_it(self, kd):
        out = release(kd, ref="c", items=[item("l1:0", kd.steak, 2)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "start", taskId=t["id"])
        release(kd, ref="c", items=[item("l1:0", kd.steak, -2)])
        b = board(kd, kd.grill_screen)
        [change] = [c for c in b["orders"][0]["changes"] if c["kind"] == "cancel"]
        assert change["requiresAck"] and not change["acked"] and change["qty"] == 2.0
        act(kd, kd.grill_screen, "ack_change", changeId=change["id"])
        assert board(kd, kd.grill_screen)["orders"] == []
        assert kd.db.query(KitchenTask).filter(KitchenTask.order_id == uuid.UUID(out["orderId"])).one().prep_state == "preparing"

    def test_a_note_change_on_a_started_dish_needs_a_seen(self, kd):
        release(kd, ref="n", items=[item("l1:0", kd.steak)])
        t = _task(board(kd, kd.grill_screen), "steak")
        act(kd, kd.grill_screen, "start", taskId=t["id"])
        release(kd, ref="n", noteUpdates=[{"lineKey": "l1:0", "notes": "בלי מלח"}])
        o = board(kd, kd.grill_screen)["orders"][0]
        assert o["tasks"][0]["notes"] == "בלי מלח"
        assert [c["kind"] for c in o["changes"] if c["requiresAck"]] == ["note"]

    def test_held_course_shows_apart_and_is_released_without_duplicates(self, kd):
        out = release(kd, ref="h", items=[item("l1:0", kd.salad)], held=[item("l2:0", kd.steak, 2, course="עיקריות")])
        o = board(kd, kd.grill_screen)["orders"][0]
        assert [(t["name"], t["release"]) for t in o["tasks"]] == [("steak", "hold")]
        fired = release(kd, ref="h", items=[item("l2:0", kd.steak, 2, course="עיקריות")], held=[])
        assert fired["tasksCreated"] == 0 and fired["tasksReleased"] == 1
        steak = [t for t in tasks_of(kd, out["orderId"]) if t.name == "steak"]
        assert len(steak) == 1 and steak[0].release_state == "released" and float(steak[0].ordered_qty) == 2.0

    def test_a_held_line_does_not_block_the_order(self, kd):
        out = release(kd, ref="h2", items=[item("l1:0", kd.cola)], held=[item("l2:0", kd.steak)])
        act(kd, kd.bar_screen, "station_ready", orderId=out["orderId"])
        assert board(kd, kd.expo_screen)["orders"][0]["groupState"] == "ready_for_pickup"

    def test_remake_is_a_linked_task_with_a_reason(self, kd):
        out = release(kd, ref="rm", items=[item("l1:0", kd.steak)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        t = [x for x in tasks_of(kd, out["orderId"])][0]
        assert act(kd, kd.grill_screen, "remake", taskId=t.id)["reason"] == "reason_required"
        act(kd, kd.grill_screen, "remake", taskId=t.id, reason="נשרף")
        remade = [x for x in tasks_of(kd, out["orderId"]) if x.linked_task_id == t.id]
        assert len(remade) == 1 and remade[0].remake_reason == "נשרף" and remade[0].prep_state == "queued"


# ── Routing ───────────────────────────────────────────────────────────────────


class TestRouting:
    def test_product_beats_category_and_unrouted_is_kept(self, kd):
        _assign(kd, "product", kd.steak, kd.bar)
        out = release(kd, ref="rt", items=[item("l1:0", kd.steak), item("l3:0", kd.salad)])
        rows = {t.name: t for t in tasks_of(kd, out["orderId"])}
        assert str(rows["steak"].station_id) == kd.bar
        assert rows["salad"].station_id is None and out["unrouted"] == ["l3:0"]
        expo = board(kd, kd.expo_screen)["orders"][0]
        assert any(t["stationId"] is None for t in expo["tasks"])

    def test_an_override_by_service_type(self, kd):
        R.post_kds_override(
            kd.shop.id,
            KdsRouteOverrideIn(targetType="category", targetId=kd.mains.id, stationId=uuid.UUID(kd.bar), serviceType="take_away"),
            **_ctx(kd),
        )
        eat = release(kd, ref="e", serviceType="eat_in", items=[item("l1:0", kd.steak)])
        away = release(kd, ref="a", serviceType="take_away", items=[item("l1:0", kd.steak)])
        assert str(tasks_of(kd, eat["orderId"])[0].station_id) == kd.grill
        assert str(tasks_of(kd, away["orderId"])[0].station_id) == kd.bar

    def test_names_and_modifiers_are_a_snapshot(self, kd):
        out = release(kd, ref="snap", items=[item("l1:0", kd.steak, mods=["מדיום"], removals=["בלי בצל"], allergies=["בוטנים"])])
        kd.steak.name = "renamed"
        kd.db.flush()
        t = _task(board(kd, kd.grill_screen), "steak")
        assert t["mods"] == ["מדיום"] and t["removals"] == ["בלי בצל"] and t["allergies"] == ["בוטנים"]
        assert out["tasksCreated"] == 1


# ── Release rules (§5) ────────────────────────────────────────────────────────


class TestReleaseRules:
    def test_a_quick_sale_waits_for_its_payment_by_default(self, kd):
        e = refused(release, kd, source="quick", ref="q1", items=[item("l1:0", kd.steak)])
        assert e.status_code == 409 and e.detail["code"] == "release_requires_payment"
        assert release(kd, source="quick", ref="q1", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])["accepted"]

    def test_before_payment_when_the_policy_says_so(self, kd):
        configure(kd, paymentPolicy="BEFORE_PAYMENT")
        out = release(kd, source="quick", ref="q2", items=[item("l1:0", kd.steak)])
        assert out["tasksCreated"] == 1
        paid = release(kd, source="quick", ref="q2", trigger="payment", paid=True, items=[])
        assert paid["tasksCreated"] == 0 and len(tasks_of(kd, out["orderId"])) == 1

    def test_a_kiosk_order_only_after_payment_and_without_acceptance(self, kd):
        assert refused(release, kd, source="kiosk", ref="k1", items=[item("l1:0", kd.steak)]).status_code == 409
        out = release(kd, source="kiosk", ref="k1", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        # Straight to the station: no "accept the order" step.
        assert _task(board(kd, kd.grill_screen), "steak")["state"] == "queued"
        assert out["pickupNumber"] == 1

    def test_cancelling_an_order_the_kitchen_never_had_records_nothing(self, kd):
        from app.models.kds import KitchenOrder

        out = release(kd, ref="never", trigger="cancel", items=[])
        assert out["noop"] is True and kd.db.query(KitchenOrder).count() == 0

    def test_the_card_shows_the_number_as_the_till_printed_it(self, kd):
        """"קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): `2-57` as sent, and an older
        till's bare number gets its till's prefix."""
        from app.models.kds import KitchenOrder

        kd.waiter.document_prefix = "4"
        kd.db.flush()
        for ref, number in (("d1", "57"), ("d2", "4-58")):
            release(kd, source="quick", ref=ref, paid=True, trigger="payment", displayRef=None,
                    transactionNumber=number, items=[item("l1:0", kd.steak)])
        orders = {o.source_ref: o for o in kd.db.query(KitchenOrder).all()}
        assert [orders[r].transaction_number for r in ("d1", "d2")] == ["4-57", "4-58"]
        assert [orders[r].display_ref for r in ("d1", "d2")] == ["4-57", "4-58"]

    def test_pickup_numbers_count_per_shop(self, kd):
        a = release(kd, source="kiosk", ref="k1", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        b = release(kd, source="kiosk", ref="k2", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        assert (a["pickupNumber"], b["pickupNumber"]) == (1, 2)


# ── The pickup screen ─────────────────────────────────────────────────────────


class TestPickupScreen:
    def test_numbers_only(self, kd):
        a = release(kd, source="kiosk", ref="p1", paid=True, trigger="payment", pickupName="דנה",
                    contactPhone="+972501111111", orderNote="אלרגיה", items=[item("l1:0", kd.steak)])
        release(kd, source="table", ref="t1", items=[item("l1:0", kd.steak)])
        out = board(kd, kd.pickup_screen)["pickup"]
        assert out["preparing"] == [{"number": str(a["pickupNumber"]), "since": out["preparing"][0]["since"]}]
        raw = repr(out)
        assert "דנה" not in raw and "+972" not in raw and "אלרגיה" not in raw
        act(kd, kd.grill_screen, "station_ready", orderId=a["orderId"])
        assert [r["number"] for r in board(kd, kd.pickup_screen)["pickup"]["ready"]] == [str(a["pickupNumber"])]
        act(kd, kd.expo_screen, "handover", orderId=a["orderId"])
        assert board(kd, kd.pickup_screen)["pickup"]["ready"] == []
        # "החזר": back on the screen.
        act(kd, kd.expo_screen, "undo_pickup", orderId=a["orderId"])
        assert len(board(kd, kd.pickup_screen)["pickup"]["ready"]) == 1

    def test_the_public_screen_by_its_opaque_token(self, kd):
        token = R.post_pickup_token(kd.shop.id, **_ctx(kd))["pickupToken"]
        assert len(token) >= 20
        assert R.get_public_pickup(token, db=kd.db)["preparing"] == []
        assert refused(R.get_public_pickup, "x" * 30, db=kd.db).status_code == 404
        assert R.get_public_pickup_screen(token, db=kd.db).status_code == 200

    def test_unchanged_since_the_screens_version(self, kd):
        first = board(kd, kd.grill_screen)
        assert board(kd, kd.grill_screen, since=first["version"])["syncType"] == "unchanged"
        release(kd, ref="v", items=[item("l1:0", kd.steak)])
        assert board(kd, kd.grill_screen, since=first["version"])["syncType"] == "full"


class TestTillBadges:
    def test_order_states_by_source_ref(self, kd):
        out = release(kd, ref="tb", items=[item("l1:0", kd.steak), item("l2:0", kd.cola)])
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        states = R.get_kds_order_states(str(kd.waiter.id), source="table", refs="tb,nope", machine=kd.waiter, db=kd.db)
        assert states["orders"]["tb"]["ready"] == 1 and states["orders"]["tb"]["tasks"] == 2
        assert "nope" not in states["orders"]


class TestDashboard:
    def test_the_shop_overview_lists_stations_devices_and_alerts(self, kd):
        release(kd, ref="ov", items=[item("l3:0", kd.salad)])
        out = R.get_kds_shop(kd.shop.id, **_ctx(kd))
        names = {s["name"]: s for s in out["stations"]}
        assert names["גריל"]["hasDevice"] and names["בר"]["hasDevice"]
        assert {d["role"] for d in out["devices"]} == {"station", "expo", "pickup"}
        assert out["unroutedTasks"] == 1 and out["openOrders"] == 1

    def test_only_a_paired_screen_is_flagged_to_ask(self, kd):
        from app.services.till_parameters import till_parameters_for_machine

        assert till_parameters_for_machine(kd.db, kd.grill_screen).parameters["kdsScreen"] is True
        assert till_parameters_for_machine(kd.db, kd.waiter).parameters["kdsScreen"] is False
        R.delete_kds_device(kd.shop.id, kd.grill_screen.id, **_ctx(kd))
        assert till_parameters_for_machine(kd.db, kd.grill_screen).parameters["kdsScreen"] is False
        assert R.get_kds_device(str(kd.grill_screen.id), machine=kd.grill_screen, db=kd.db)["device"] is None

    def test_a_station_screen_needs_a_station(self, kd):
        extra = _till(kd, "spare")
        assert refused(device, kd, extra, "station").status_code == 422

    def test_a_cashier_cannot_manage_screens(self, kd):
        with pytest.raises(HTTPException) as e:
            R.put_kds_device(kd.shop.id, kd.tills[1].id, KdsDeviceIn(role="expo"), **_ctx(kd, kd.cashier))
        assert e.value.status_code == 403
