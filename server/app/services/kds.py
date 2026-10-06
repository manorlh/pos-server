"""
The KDS engine (docs/SPEC_KDS.md; owner's spec "חלק א — KDS" §4–12).

The rules, in one place:

* **Release (§5).** A table is released by the waiter's send; a quick sale before or
  after its payment by `workflowPaymentPolicy`; a kiosk order after its payment. A draft
  is never a task. Payment, kitchen receipt and readiness are separate facts: `paid` on
  the order says nothing about the kitchen.
* **The order's configuration is locked** at its first release (`workflow_mode`,
  `config_version`, the whole normalized configuration): a later change of the till's
  configuration applies to new orders only (§6 of the decision).
* **DIRECT_SALE never manages preparation (§2, §7).** With the printer only, a release
  records the snapshot and creates no task; with a KDS it creates view-only tasks that
  never block anything and never raise the ready event.
* **Idempotency.** A release and every action carry the till's / screen's key: a retry
  returns the first result and changes nothing (no duplicate task, no second event).
* **Tasks (§8).** One per item, per station, per round: ordered, cancelled and prepared
  quantities, active = ordered − cancelled; prepared never above active unless the
  excess is recorded (prepared before a cancellation). More of a line in a later round
  is a new task — the ready units stay ready, the earlier ones keep their time.
* **Changes (§9).** A cancellation takes the quantity off what is left to prepare first,
  then off what was prepared (recorded); it stays on the station until acknowledged. A
  note change on a started task needs a "ראיתי". Acknowledging is not re-preparing.
* **Hold / Fire (§10).** The lines held at a table (a course not fired) are hold tasks,
  shown apart; a later send of the same line releases them rather than adding tasks.
* **Readiness (§11).** A group is ready when every required task (released, active,
  at a preparation station) is ready — a view-only station never counts, a held course
  never blocks. With `requireExpo` the Expo confirms it (a manager may override, with a
  reason); otherwise the shared service sets it. ReadyForPickup writes one outbox event
  per group (unique key): undo + ready again never makes a second one; an undo, a
  handover or a cancellation before the consumer ran suppresses the pending one.
* **Fallback (§12).** A round the till printed on a fallback printer because the KDS was
  out of reach arrives flagged: its tasks are shown for reconciliation ("כבר הוכן" /
  "להכין"), never as a fresh order to prepare twice.
* **Offline actions (§12).** A queued action that arrives late never revives a
  cancellation: it can only act on the active quantity.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kds import (
    FulfillmentGroup,
    KdsDevice,
    KdsShopState,
    KdsStationSetting,
    KitchenAction,
    KitchenChange,
    KitchenDispatch,
    KitchenOrder,
    KitchenTask,
)
from app.models.outbox import OutboxEvent
from app.models.pos_machine import POSMachine
from app.models.printers import KitchenStation
from app.models.shop import Shop
from app.schemas.kds import KdsActionIn, KdsItemIn, KdsReleaseIn
from app.services import kds_workflow as WF
from app.services.areas import as_utc
from app.services.kds_routing import load_context, route

ZERO = Decimal("0")
QTY = Decimal("0.001")
#: The outbox event types this module writes (app/models/outbox.py, docs/SPEC_KDS.md §7).
READY_EVENT = "ReadyForPickup"
REVOKED_EVENT = "ReadyRevoked"
HANDED_OVER_EVENT = "HandedOver"
CANCELLED_EVENT = "OrderCancelled"
#: `result` of a ReadyForPickup row suppressed before any consumer took it.
SUPPRESSED = "suppressed:"
#: A view-only (DIRECT_SALE) order leaves the screens after this, bumped or not.
VIEW_TTL = timedelta(minutes=30)
#: Orders older than this are no longer on any screen (left open by mistake).
BOARD_WINDOW = timedelta(hours=24)
#: A ready task stays on its station this long, for an undo.
RECENT_READY = timedelta(minutes=3)
#: Without handover tracking, a ready number leaves the pickup screen after this.
PICKUP_READY_TTL = timedelta(minutes=15)
#: Handed over: still on the Expo this long, for "החזר".
RECENT_HANDOVER = timedelta(minutes=5)
SEEN_EVERY = timedelta(seconds=30)
PICKUP_MAX = 999


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment else None


def _q(value: Any) -> Decimal:
    if value is None:
        return ZERO
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(QTY)


def _num(value: Any) -> float:
    return float(_q(value))


def active_qty(task: KitchenTask) -> Decimal:
    return _q(task.ordered_qty) - _q(task.cancelled_qty)


def remaining_qty(task: KitchenTask) -> Decimal:
    return max(active_qty(task) - _q(task.prepared_qty), ZERO)


def _refuse(code: str, http: int = status.HTTP_409_CONFLICT, **extra: Any) -> HTTPException:
    return HTTPException(status_code=http, detail={"code": code, **extra})


# ── Shop state: the change counter, pickup numbers, the public token ─────────────


def shop_state(db: Session, shop_id: Any, tenant_id: Any) -> KdsShopState:
    state = db.query(KdsShopState).filter(KdsShopState.shop_id == shop_id).first()
    if state is None:
        state = KdsShopState(shop_id=shop_id, tenant_id=tenant_id, version=0, pickup_next=1)
        db.add(state)
        db.flush()
    return state


def bump(db: Session, shop_id: Any, tenant_id: Any) -> int:
    state = shop_state(db, shop_id, tenant_id)
    state.version = (state.version or 0) + 1
    state.updated_at = _now()
    return state.version


def _shop_today(db: Session, shop: Shop) -> date:
    from zoneinfo import ZoneInfo

    from app.models.tenant import Tenant

    tz_name = None
    row = db.query(Tenant.timezone).filter(Tenant.id == shop.tenant_id).first()
    if row is not None:
        tz_name = row[0]
    try:
        tz = ZoneInfo(tz_name or "Asia/Jerusalem")
    except Exception:  # noqa: BLE001 - an unknown zone falls back to Israel
        tz = ZoneInfo("Asia/Jerusalem")
    return _now().astimezone(tz).date()


def next_pickup_number(db: Session, shop: Shop) -> int:
    """1, 2, 3… per shop, restarting every business day and after 999."""
    state = shop_state(db, shop.id, shop.tenant_id)
    today = _shop_today(db, shop)
    if state.pickup_day != today:
        state.pickup_day = today
        state.pickup_next = 1
    number = state.pickup_next or 1
    state.pickup_next = 1 if number >= PICKUP_MAX else number + 1
    return number


def rotate_pickup_token(db: Session, shop: Shop) -> str:
    state = shop_state(db, shop.id, shop.tenant_id)
    state.pickup_token = secrets.token_urlsafe(24)
    db.flush()
    return state.pickup_token


# ── Devices ─────────────────────────────────────────────────────────────────────


def device_for_machine(db: Session, machine: POSMachine) -> Optional[KdsDevice]:
    device = db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).first()
    if device is None or not device.is_active or device.tenant_id != machine.tenant_id:
        return None
    if machine.shop_id is None or device.shop_id != machine.shop_id:
        return None
    return device


def _station_names(db: Session, tenant_id: Any) -> Dict[str, str]:
    rows = db.query(KitchenStation.id, KitchenStation.name).filter(KitchenStation.tenant_id == tenant_id).all()
    return {str(i): n for i, n in rows}


def device_out(db: Session, device: KdsDevice, names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    names = names if names is not None else _station_names(db, device.tenant_id)
    return {
        "id": str(device.id),
        "machineId": str(device.machine_id) if device.machine_id else None,
        "shopId": str(device.shop_id),
        "name": device.name,
        "role": device.role,
        "stations": [{"id": s, "name": names.get(s, "?")} for s in (device.station_ids or []) if s in names],
        "isActive": bool(device.is_active),
        "lastSeenAt": _iso(device.last_seen_at),
    }


def device_view(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """`GET /sync/{m}/kds/device`: what this till is as a KDS screen, if anything."""
    device = device_for_machine(db, machine)
    config = WF.describe(WF.config_for_machine(db, machine))
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    out: Dict[str, Any] = {"device": None, "workflow": config, "shopName": shop.name if shop else None}
    if device is not None:
        out["device"] = device_out(db, device)
        settings = {
            str(s.station_id): s
            for s in db.query(KdsStationSetting).filter(KdsStationSetting.shop_id == device.shop_id).all()
        }
        out["stationSettings"] = {
            sid: {"targetKind": s.target_kind, "warnMinutes": s.warn_minutes, "lateMinutes": s.late_minutes}
            for sid, s in settings.items()
        }
    return out


# ── Release ─────────────────────────────────────────────────────────────────────


def _check_policy(body: KdsReleaseIn, config: Dict[str, Any], order: Optional[KitchenOrder]) -> None:
    """§5: when a source may release. Raises 409 with the reason."""
    paid = body.paid or body.trigger == "payment" or (order is not None and order.paid)
    adds = any(i.quantity > 0 for i in body.items)
    if not adds:
        return
    if body.source == "kiosk" and not paid:
        raise _refuse("release_requires_payment")
    if body.source == "quick" and not paid and config.get("paymentPolicy") != WF.BEFORE_PAYMENT:
        raise _refuse("release_requires_payment")


def _header(order: KitchenOrder, body: KdsReleaseIn) -> None:
    for attr, value in (
        ("display_ref", body.display_ref),
        ("table_ref", body.table_ref),
        ("zone_name", body.zone_name),
        ("service_type", body.service_type),
        ("guests", body.guests),
        ("waiter_name", body.waiter_name),
        ("pickup_name", body.pickup_name),
        ("contact_phone", body.contact_phone),
        ("order_note", body.order_note),
        ("transaction_number", body.transaction_number),
    ):
        if value is not None:
            setattr(order, attr, value)


def _group(db: Session, order: KitchenOrder) -> FulfillmentGroup:
    group = (
        db.query(FulfillmentGroup)
        .filter(FulfillmentGroup.order_id == order.id, FulfillmentGroup.key == "order")
        .first()
    )
    if group is None:
        group = FulfillmentGroup(
            id=uuid.uuid4(), tenant_id=order.tenant_id, shop_id=order.shop_id, order_id=order.id, key="order",
            state="waiting", version=1,
        )
        db.add(group)
        db.flush()
    return group


def _tasks(db: Session, order_id: Any) -> List[KitchenTask]:
    return db.query(KitchenTask).filter(KitchenTask.order_id == order_id).all()


def _snapshot_fields(item: KdsItemIn) -> Dict[str, Any]:
    return {
        "product_id": item.product_id,
        "category_id": item.category_id,
        "name": item.name,
        "mods": list(item.mods or []) or None,
        "removals": list(item.removals or []) or None,
        "notes": (item.notes or "").strip() or None,
        "allergies": list(item.allergies or []) or None,
        "important": bool(item.important),
        "seat": item.seat,
        "course": item.course,
        "meal_name": item.meal_name,
    }


def release(db: Session, machine: POSMachine, body: KdsReleaseIn) -> Dict[str, Any]:
    """
    Release a round to the kitchen. Returns `{accepted, dispatchId, orderId, roundNo,
    tasksCreated, …}`; the same body again returns the same result (`replayed`).
    """
    if machine.shop_id is None:
        raise _refuse("machine_has_no_shop", status.HTTP_400_BAD_REQUEST)
    existing = db.query(KitchenDispatch).filter(KitchenDispatch.id == body.id).first()
    if existing is not None:
        if existing.tenant_id != machine.tenant_id or existing.shop_id != machine.shop_id:
            raise _refuse("dispatch_id_taken")
        if body.fallback_printed and not existing.fallback_printed:
            # The answer was lost, the till printed it on the fallback printer, then the
            # retry got through: the round is now reconciled like a fallback one.
            existing.fallback_printed = True
            for task in db.query(KitchenTask).filter(KitchenTask.dispatch_id == existing.id).all():
                if task.prep_state == "queued" and not task.fallback_printed:
                    task.fallback_printed = True
                    task.version += 1
            bump(db, existing.shop_id, existing.tenant_id)
        return {**(existing.result or {}), "replayed": True}

    now = _now()
    # "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): the card shows the number as the
    # till prints it, `2-57`, so two tills' #57 are never the same card. A till build from
    # before the prefix sends the bare number; it gets its till's prefix here.
    raw_number = (body.transaction_number or "").strip()
    if raw_number.isdigit():
        from app.services.document_prefix import effective_prefix, format_document_number

        body.transaction_number = format_document_number(effective_prefix(machine), raw_number)[:50]
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    order = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.tenant_id == machine.tenant_id,
            KitchenOrder.source == body.source,
            KitchenOrder.source_ref == body.source_ref,
        )
        .first()
    )
    if order is not None and order.shop_id != machine.shop_id:
        raise _refuse("order_of_another_shop")

    switched = False
    if order is None and body.trigger == "cancel":
        # A cancellation of an order the kitchen never had: nothing to do, nothing recorded.
        return {"accepted": True, "noop": True, "reason": "order_unknown"}
    if order is None:
        config = WF.config_for_machine(db, machine)
        if not config.get("enabled"):
            # The feature is off for this till: nothing is recorded, nothing changes.
            return {"accepted": False, "reason": "kds_disabled"}
        mode, switched = WF.resolve_mode(config, body.workflow_mode)
        _check_policy(body, config, None)
        order = KitchenOrder(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            shop_id=machine.shop_id,
            area_id=machine.area_id,
            machine_id=machine.id,
            source=body.source,
            source_ref=body.source_ref,
            workflow_mode=mode,
            config_version=WF.config_version(config),
            config_snapshot=config,
            status="open",
            version=1,
            round_count=0,
            created_at=now,
        )
        _header(order, body)
        if order.display_ref is None and body.source != "table":
            order.display_ref = body.transaction_number
        db.add(order)
        db.flush()
        if body.source != "table" and mode == WF.ORDER_PROCESS:
            order.pickup_number = body.pickup_number or next_pickup_number(db, shop)
            if order.display_ref is None:
                order.display_ref = str(order.pickup_number)
    else:
        config = order.config_snapshot or WF.normalize({})
        mode = order.workflow_mode
        _check_policy(body, config, order)
        _header(order, body)

    rules = WF.mode_rules(config, mode)
    if body.paid or body.trigger == "payment":
        order.paid = True
    round_no = (order.round_count or 0) + 1
    dispatch = KitchenDispatch(
        id=body.id,
        tenant_id=order.tenant_id,
        shop_id=order.shop_id,
        order_id=order.id,
        round_no=round_no,
        trigger=body.trigger,
        is_addition=round_no > 1,
        fallback_printed=body.fallback_printed,
        no_tasks=not rules["createsTasks"],
        machine_id=machine.id,
        actor_name=body.actor_name or body.waiter_name,
        occurred_at=body.occurred_at,
        item_count=len(body.items),
        payload=body.model_dump(mode="json", by_alias=True, exclude={"contact_phone"}),
        created_at=now,
    )
    db.add(dispatch)
    order.round_count = round_no
    if switched:
        db.add(KitchenAction(
            id=f"switch-{body.id}"[:64], tenant_id=order.tenant_id, shop_id=order.shop_id, machine_id=machine.id,
            type="mode_switch", target_id=str(order.id), actor_name=body.actor_name, reason=mode,
            occurred_at=body.occurred_at or now, outcome="applied", result={"mode": mode},
        ))
    db.flush()

    result: Dict[str, Any] = {
        "accepted": True,
        "dispatchId": dispatch.id,
        "orderId": str(order.id),
        "roundNo": round_no,
        "workflowMode": mode,
        "configVersion": order.config_version,
        "pickupNumber": order.pickup_number,
        "tasksCreated": 0,
        "tasksReleased": 0,
        "cancelled": 0,
        "unrouted": [],
        "noTasks": not rules["createsTasks"],
    }
    if not rules["createsTasks"]:
        # DIRECT_SALE with the printer only: the snapshot, and nothing for the kitchen screens.
        order.status = "closed"
        dispatch.result = result
        db.flush()
        return result

    group = _group(db, order)
    ctx = load_context(db, order.tenant_id, order.shop_id, order.area_id, order.service_type)
    view_only = rules["viewOnly"]
    tasks = _tasks(db, order.id)
    new_tasks: Dict[Tuple[str, str], KitchenTask] = {}

    def make_task(item: KdsItemIn, qty: Decimal, release_state: str) -> KitchenTask:
        r = route(db, ctx, item.product_id, item.category_id)
        key = (item.line_key, str(r.station_id) if r.station_id else "-")
        if key in new_tasks:
            task = new_tasks[key]
            task.ordered_qty = _q(task.ordered_qty) + qty
            return task
        kind = "view" if view_only else r.target_kind
        task = KitchenTask(
            id=uuid.uuid4(),
            tenant_id=order.tenant_id,
            shop_id=order.shop_id,
            order_id=order.id,
            dispatch_id=dispatch.id,
            round_no=round_no,
            group_id=group.id,
            station_id=r.station_id,
            station_key=key[1],
            station_name=r.station_name,
            target_kind=kind,
            required=kind == "prep",
            line_key=item.line_key,
            ordered_qty=qty,
            cancelled_qty=ZERO,
            prepared_qty=ZERO,
            release_state=release_state,
            prep_state="queued",
            fallback_printed=body.fallback_printed and release_state == "released",
            version=1,
            created_at=now,
            released_at=now if release_state == "released" else None,
            **_snapshot_fields(item),
        )
        db.add(task)
        new_tasks[key] = task
        tasks.append(task)
        if r.station_id is None and item.line_key not in result["unrouted"]:
            result["unrouted"].append(item.line_key)
        return task

    # More of a line: its held units first (a course fired), then new tasks.
    for item in body.items:
        qty = _q(item.quantity)
        if qty <= ZERO:
            continue
        holds = sorted(
            [t for t in tasks if t.line_key == item.line_key and t.release_state == "hold" and active_qty(t) > ZERO],
            key=lambda t: as_utc(t.created_at) or now,
        )
        for hold in holds:
            if qty <= ZERO:
                break
            take = min(qty, active_qty(hold))
            if take == active_qty(hold):
                hold.release_state = "released"
                hold.released_at = now
                hold.fallback_printed = hold.fallback_printed or body.fallback_printed
                hold.version += 1
            else:
                hold.ordered_qty = _q(hold.ordered_qty) - take
                hold.version += 1
                make_task(item, take, "released")
            qty -= take
            result["tasksReleased"] += 1
        if qty > ZERO:
            make_task(item, qty, "released")

    # Taken off: a cancellation of what the kitchen has.
    for item in body.items:
        qty = _q(item.quantity)
        if qty < ZERO:
            result["cancelled"] += _cancel_line(db, order, tasks, item.line_key, -qty, dispatch.id, now)

    # The complete set of held lines (hold tasks follow it).
    if body.held is not None:
        _sync_held(db, order, tasks, body.held, make_task, now)

    for note in body.note_updates:
        _note_line(db, order, tasks, note.line_key, note.notes, dispatch.id, now)

    if body.trigger == "cancel":
        for task in list(tasks):
            if active_qty(task) > ZERO:
                result["cancelled"] += _cancel_line(
                    db, order, [task], task.line_key, active_qty(task), dispatch.id, now, only=task
                )

    db.flush()
    result["tasksCreated"] = len(new_tasks)
    if new_tasks and group.state in ("ready_for_pickup", "handed_over") and any(
        t.release_state == "released" and t.required for t in new_tasks.values()
    ):
        # A new round after it was ready / served: the group waits again.
        group.state = "waiting"
        group.override_reason = None
        group.version += 1
    if order.first_released_at is None and any(t.release_state == "released" for t in tasks):
        order.first_released_at = now
    _recompute(db, order, group, tasks, rules, now, actor=body.actor_name)
    order.version += 1
    bump(db, order.shop_id, order.tenant_id)
    dispatch.result = result
    db.flush()
    return result


def _cancel_line(
    db: Session,
    order: KitchenOrder,
    tasks: List[KitchenTask],
    line_key: str,
    qty: Decimal,
    dispatch_id: Optional[str],
    now: datetime,
    only: Optional[KitchenTask] = None,
) -> int:
    """
    Cancel `qty` of a line at every station it went to: held units first, then what is
    left to prepare (newest round first), then prepared units (recorded as prepared
    before the cancellation). Returns how many tasks changed.
    """
    mine = [only] if only is not None else [t for t in tasks if t.line_key == line_key and active_qty(t) > ZERO]
    by_station: Dict[str, List[KitchenTask]] = {}
    for t in mine:
        by_station.setdefault(t.station_key, []).append(t)
    changed = 0
    for station_tasks in by_station.values():
        left = qty
        holds = [t for t in station_tasks if t.release_state == "hold"]
        released = sorted(
            [t for t in station_tasks if t.release_state == "released"],
            key=lambda t: (t.round_no, as_utc(t.created_at) or now),
            reverse=True,
        )
        order_of_cut = holds + [t for t in released if remaining_qty(t) > ZERO] + [
            t for t in released if remaining_qty(t) <= ZERO
        ]
        for task in order_of_cut:
            if left <= ZERO:
                break
            take = min(left, active_qty(task))
            if take <= ZERO:
                continue
            was_prepared = _q(task.prepared_qty) > active_qty(task) - take
            task.cancelled_qty = _q(task.cancelled_qty) + take
            if _q(task.prepared_qty) > active_qty(task):
                task.over_prepared = True
            if active_qty(task) > ZERO and _q(task.prepared_qty) >= active_qty(task):
                task.prep_state = "ready"
                task.ready_at = task.ready_at or now
            task.version += 1
            left -= take
            changed += 1
            if task.release_state == "released":
                db.add(KitchenChange(
                    id=uuid.uuid4(), tenant_id=order.tenant_id, shop_id=order.shop_id, order_id=order.id,
                    task_id=task.id, dispatch_id=dispatch_id, station_id=task.station_id, kind="cancel",
                    qty=take, text=task.name,
                    before={"active": _num(active_qty(task) + take), "prepared": _num(task.prepared_qty)},
                    after={"active": _num(active_qty(task)), "preparedBeforeCancel": was_prepared},
                    requires_ack=True, created_at=now,
                ))
    return changed


def _sync_held(db, order, tasks, held: Sequence[KdsItemIn], make_task, now) -> None:
    wanted: Dict[str, Tuple[KdsItemIn, Decimal]] = {}
    for item in held:
        if _q(item.quantity) > ZERO:
            prev = wanted.get(item.line_key)
            wanted[item.line_key] = (item, (prev[1] if prev else ZERO) + _q(item.quantity))
    by_line: Dict[str, List[KitchenTask]] = {}
    for t in tasks:
        if t.release_state == "hold" and active_qty(t) > ZERO:
            by_line.setdefault(t.line_key, []).append(t)
    for line_key, holds in by_line.items():
        want = wanted.get(line_key, (None, ZERO))[1]
        have = sum((active_qty(t) for t in holds), ZERO)
        if have > want:
            # Fewer held now (taken off before the course was fired): never released, no ack.
            cut = have - want
            for t in sorted(holds, key=lambda x: as_utc(x.created_at) or now, reverse=True):
                take = min(cut, active_qty(t))
                t.cancelled_qty = _q(t.cancelled_qty) + take
                t.version += 1
                cut -= take
                if cut <= ZERO:
                    break
    for line_key, (item, want) in wanted.items():
        have = sum((active_qty(t) for t in by_line.get(line_key, [])), ZERO)
        if want > have:
            make_task(item, want - have, "hold")


def _note_line(db, order, tasks, line_key: str, notes: Optional[str], dispatch_id: str, now: datetime) -> None:
    clean = (notes or "").strip() or None
    for task in tasks:
        if task.line_key != line_key or active_qty(task) <= ZERO or task.notes == clean:
            continue
        before = task.notes
        task.notes = clean
        task.version += 1
        if task.release_state != "released":
            continue
        db.add(KitchenChange(
            id=uuid.uuid4(), tenant_id=order.tenant_id, shop_id=order.shop_id, order_id=order.id, task_id=task.id,
            dispatch_id=dispatch_id, station_id=task.station_id, kind="note", text=clean,
            before={"notes": before}, after={"notes": clean},
            # Not started yet: the card simply shows the new note, highlighted.
            requires_ack=task.prep_state != "queued", created_at=now,
        ))


# ── Readiness, the ready event ──────────────────────────────────────────────────


def required_tasks(tasks: Iterable[KitchenTask]) -> List[KitchenTask]:
    return [t for t in tasks if t.required and t.release_state == "released" and active_qty(t) > ZERO]


def all_ready(tasks: Iterable[KitchenTask]) -> bool:
    req = required_tasks(tasks)
    return bool(req) and all(t.prep_state == "ready" for t in req)


def _event_for(db: Session, order: KitchenOrder, group: FulfillmentGroup) -> Optional[OutboxEvent]:
    return (
        db.query(OutboxEvent)
        .filter(OutboxEvent.tenant_id == order.tenant_id, OutboxEvent.dedupe_key == _dedupe_key(group))
        .first()
    )


def _dedupe_key(group: FulfillmentGroup) -> str:
    """One ReadyForPickup per fulfillment group, ever: a retry, a double tap, undo + ready."""
    return f"{READY_EVENT}:{group.id}"


def is_suppressed(event: OutboxEvent) -> bool:
    return event.state == "processed" and (event.result or "").startswith(SUPPRESSED)


def _company_of(db: Session, shop_id: Any) -> Optional[uuid.UUID]:
    row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
    return row[0] if row else None


def _emit(
    db: Session, order: KitchenOrder, aggregate_type: str, aggregate_id: Any, version: int, event_type: str,
    payload: Dict[str, Any], now: datetime,
) -> None:
    key = f"{event_type}:{aggregate_id}:{version}"
    exists = (
        db.query(OutboxEvent.id)
        .filter(OutboxEvent.tenant_id == order.tenant_id, OutboxEvent.dedupe_key == key)
        .first()
    )
    if exists is not None:
        return
    db.add(OutboxEvent(
        id=uuid.uuid4(), tenant_id=order.tenant_id, company_id=_company_of(db, order.shop_id), shop_id=order.shop_id,
        aggregate_type=aggregate_type, aggregate_id=str(aggregate_id), aggregate_version=version,
        event_type=event_type, dedupe_key=key, occurred_at=now, payload=payload, state="pending",
        available_at=now, attempts=0, created_at=now,
    ))


def _suppress(db: Session, order: KitchenOrder, group: FulfillmentGroup, reason: str) -> None:
    """
    The group is no longer ready (undo), was handed over or cancelled. A ReadyForPickup no
    consumer has taken yet is suppressed in place (never seen); one already taken gets a
    follow-up event (ReadyRevoked / HandedOver / OrderCancelled), so the consumer can
    cancel a message it queued and has not sent.
    """
    event = _event_for(db, order, group)
    if event is None or is_suppressed(event):
        return
    now = _now()
    if event.state == "pending":
        event.state = "processed"
        event.result = f"{SUPPRESSED}{reason}"
        event.processed_at = now
        return
    follow = {"undo": REVOKED_EVENT, "handed_over": HANDED_OVER_EVENT, "cancelled": CANCELLED_EVENT}[reason]
    _emit(
        db, order, "fulfillment_group", group.id, group.version, follow,
        {"orderId": str(order.id), "groupId": str(group.id), "shopId": str(order.shop_id), "reason": reason,
         "readyEventId": str(event.id)},
        now,
    )


def _set_ready(
    db: Session,
    order: KitchenOrder,
    group: FulfillmentGroup,
    now: datetime,
    actor: Optional[str],
    override_reason: Optional[str] = None,
) -> None:
    """The one place ReadyForPickup happens (§11) — and its outbox event, same transaction."""
    group.state = "ready_for_pickup"
    group.ready_at = now
    group.ready_by = actor
    group.override_reason = override_reason
    group.version += 1
    order.ready_at = now
    order.status = "ready"
    config = order.config_snapshot or {}
    payload = {
        "orderId": str(order.id),
        "groupId": str(group.id),
        "shopId": str(order.shop_id),
        "source": order.source,
        "displayRef": order.display_ref,
        "pickupNumber": order.pickup_number,
        "workflowMode": order.workflow_mode,
        "configVersion": order.config_version,
        "readyAt": _iso(now),
        "override": override_reason is not None,
        "hasContact": bool(order.contact_phone),
        # Whether the shop wants the ready message (the consumer still checks its own rules).
        "notify": bool(config.get("readyNotification")) and bool(order.contact_phone),
    }
    if payload["notify"]:
        # Rides only when a message is wanted; the consumer masks it once taken
        # (`payload_redacted_at`, app/models/outbox.py).
        payload["contactPhone"] = order.contact_phone
    event = _event_for(db, order, group)
    if event is None:
        db.add(OutboxEvent(
            id=uuid.uuid4(), tenant_id=order.tenant_id, company_id=_company_of(db, order.shop_id),
            shop_id=order.shop_id, aggregate_type="fulfillment_group", aggregate_id=str(group.id),
            aggregate_version=group.version, event_type=READY_EVENT, dedupe_key=_dedupe_key(group),
            payload=payload, occurred_at=now, state="pending", attempts=0, available_at=now, created_at=now,
        ))
    elif is_suppressed(event) and event.result == f"{SUPPRESSED}undo":
        # Undone before any consumer took it, then ready again: the same event, pending again.
        event.state = "pending"
        event.result = None
        event.processed_at = None
        event.aggregate_version = group.version
        event.payload = payload
        event.occurred_at = now
        event.available_at = now
    # Otherwise (taken, sent or being sent): never a second ReadyForPickup.


def _recompute(
    db: Session,
    order: KitchenOrder,
    group: FulfillmentGroup,
    tasks: List[KitchenTask],
    rules: Dict[str, Any],
    now: datetime,
    actor: Optional[str] = None,
) -> None:
    anything = [t for t in tasks if active_qty(t) > ZERO]
    if rules["viewOnly"]:
        # View only (DIRECT_SALE): no lifecycle — bumped from the screen, or gone after VIEW_TTL.
        done = all(t.prep_state == "ready" or active_qty(t) <= ZERO for t in tasks)
        order.status = "closed" if tasks and done else "open"
        return
    if tasks and not anything:
        if group.state not in ("handed_over", "cancelled"):
            group.state = "cancelled"
            group.version += 1
            _suppress(db, order, group, "cancelled")
        order.status = "cancelled"
        order.cancelled_at = order.cancelled_at or now
        return
    if order.status == "cancelled" and anything:
        order.status = "open"
        order.cancelled_at = None
        if group.state == "cancelled":
            group.state = "waiting"
            group.version += 1
    ready = all_ready(tasks)
    if group.state == "ready_for_pickup" and not ready and not group.override_reason:
        group.state = "waiting"
        group.ready_at = None
        group.version += 1
        _suppress(db, order, group, "undo")
    if group.state == "waiting" and ready and rules["readyEvent"] and not rules["requireExpo"]:
        _set_ready(db, order, group, now, actor or "auto")
    if group.state == "ready_for_pickup":
        order.status = "ready"
    elif group.state == "handed_over":
        order.status = "handed_over"
    elif group.state == "waiting":
        order.status = "open"


# ── Actions ─────────────────────────────────────────────────────────────────────


def _order_rules(order: KitchenOrder) -> Dict[str, Any]:
    return WF.mode_rules(order.config_snapshot or WF.normalize({}), order.workflow_mode)


def _load_task(db: Session, device: KdsDevice, task_id: Any) -> KitchenTask:
    task = db.query(KitchenTask).filter(KitchenTask.id == task_id).first()
    if task is None or task.shop_id != device.shop_id or task.tenant_id != device.tenant_id:
        raise _refuse("task_not_found", status.HTTP_404_NOT_FOUND)
    if device.role == "station" and str(task.station_id) not in set(device.station_ids or []):
        raise _refuse("task_of_another_station", status.HTTP_403_FORBIDDEN)
    return task


def _load_order(db: Session, device: KdsDevice, order_id: Any) -> KitchenOrder:
    order = db.query(KitchenOrder).filter(KitchenOrder.id == order_id).first()
    if order is None or order.shop_id != device.shop_id or order.tenant_id != device.tenant_id:
        raise _refuse("order_not_found", status.HTTP_404_NOT_FOUND)
    return order


def apply_action(db: Session, machine: POSMachine, body: KdsActionIn) -> Dict[str, Any]:
    device = device_for_machine(db, machine)
    if device is None:
        raise _refuse("not_a_kds_device", status.HTTP_403_FORBIDDEN)
    if device.role == "pickup":
        raise _refuse("pickup_screen_is_read_only", status.HTTP_403_FORBIDDEN)
    stored = db.query(KitchenAction).filter(KitchenAction.id == body.id).first()
    if stored is not None:
        if stored.tenant_id != device.tenant_id:
            raise _refuse("action_id_taken")
        return {**(stored.result or {}), "replayed": True}

    now = _now()
    outcome, result = _apply(db, device, body, now)
    db.add(KitchenAction(
        id=body.id, tenant_id=device.tenant_id, shop_id=device.shop_id, machine_id=machine.id, device_id=device.id,
        type=body.type, target_id=str(body.task_id or body.order_id or body.change_id or "")[:64] or None,
        actor_name=body.actor_name, reason=body.reason, occurred_at=body.occurred_at or now, outcome=outcome,
        result=result, created_at=now,
    ))
    if outcome == "applied":
        bump(db, device.shop_id, device.tenant_id)
    db.flush()
    return result


def _out(outcome: str, **extra: Any) -> Tuple[str, Dict[str, Any]]:
    return outcome, {"outcome": outcome, **extra}


def _apply(db: Session, device: KdsDevice, body: KdsActionIn, now: datetime) -> Tuple[str, Dict[str, Any]]:
    kind = body.type
    actor = body.actor_name or device.name

    if kind in ("start", "item_ready", "undo_ready", "resolve_fallback", "remake"):
        if body.task_id is None:
            raise _refuse("task_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
        task = _load_task(db, device, body.task_id)
        if body.expected_version is not None and body.expected_version != task.version:
            raise _refuse("version_conflict", task=task_out(task))
        order = db.query(KitchenOrder).filter(KitchenOrder.id == task.order_id).first()
        rules = _order_rules(order)
        changed = _task_action(db, order, task, body, rules, now, actor)
        if changed is None:
            return _out("noop", task=task_out(task))
        if isinstance(changed, str):
            return _out("rejected", reason=changed, task=task_out(task))
        task.version += 1
        tasks = _tasks(db, order.id)
        _recompute(db, order, _group(db, order), tasks, rules, now, actor)
        order.version += 1
        return _out("applied", task=task_out(task), order=_order_brief(db, order))

    if kind == "station_ready":
        if body.order_id is None:
            raise _refuse("order_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
        order = _load_order(db, device, body.order_id)
        rules = _order_rules(order)
        stations = (
            {str(body.station_id)} if body.station_id is not None else set(device.station_ids or [])
        )
        if device.role == "station" and not stations <= set(device.station_ids or []):
            raise _refuse("task_of_another_station", status.HTTP_403_FORBIDDEN)
        tasks = _tasks(db, order.id)
        done, skipped = 0, 0
        for task in tasks:
            if device.role == "station" or body.station_id is not None:
                if str(task.station_id) not in stations:
                    continue
            if task.release_state != "released" or remaining_qty(task) <= ZERO:
                continue
            if rules["requireStart"] and task.prep_state == "queued":
                skipped += 1
                continue
            task.prepared_qty = active_qty(task)
            task.prep_state = "ready"
            task.started_at = task.started_at or now
            task.ready_at = now
            task.version += 1
            done += 1
        if done == 0:
            return _out("noop" if skipped == 0 else "rejected", reason="start_required" if skipped else None)
        _recompute(db, order, _group(db, order), tasks, rules, now, actor)
        order.version += 1
        return _out("applied", tasksReady=done, skipped=skipped, order=_order_brief(db, order))

    if kind == "ack_change":
        changes: List[KitchenChange] = []
        if body.change_id is not None:
            change = db.query(KitchenChange).filter(KitchenChange.id == body.change_id).first()
            if change is None or change.shop_id != device.shop_id:
                raise _refuse("change_not_found", status.HTTP_404_NOT_FOUND)
            changes = [change]
        elif body.task_id is not None:
            task = _load_task(db, device, body.task_id)
            changes = db.query(KitchenChange).filter(KitchenChange.task_id == task.id).all()
        else:
            raise _refuse("change_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
        mine = set(device.station_ids or [])
        acked = 0
        for change in changes:
            if change.acked_at is not None:
                continue
            if device.role == "station" and change.station_id is not None and str(change.station_id) not in mine:
                continue
            change.acked_at = now
            change.acked_by = actor
            acked += 1
        return _out("applied" if acked else "noop", acked=acked)

    if kind in ("ready_for_pickup", "undo_pickup", "handover", "priority"):
        if body.order_id is None:
            raise _refuse("order_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
        order = _load_order(db, device, body.order_id)
        rules = _order_rules(order)
        group = _group(db, order)
        tasks = _tasks(db, order.id)
        if kind == "priority":
            if device.role not in ("expo", "manager"):
                raise _refuse("expo_or_manager_only", status.HTTP_403_FORBIDDEN)
            if not (body.reason or "").strip():
                raise _refuse("reason_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
            order.priority = body.priority or 0
            order.priority_reason = body.reason.strip()
            order.version += 1
            return _out("applied", order=_order_brief(db, order))
        if not rules["readyEvent"]:
            return _out("rejected", reason="not_order_process")
        if kind == "ready_for_pickup":
            if device.role not in ("expo", "manager"):
                raise _refuse("expo_or_manager_only", status.HTTP_403_FORBIDDEN)
            if group.state == "ready_for_pickup":
                return _out("noop", order=_order_brief(db, order))
            if group.state in ("handed_over", "cancelled"):
                return _out("rejected", reason=f"group_{group.state}")
            if not all_ready(tasks):
                if not body.override:
                    missing = [task_out(t) for t in required_tasks(tasks) if t.prep_state != "ready"]
                    return _out("rejected", reason="not_all_ready", missing=missing)
                if not (body.reason or "").strip():
                    raise _refuse("reason_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
                _set_ready(db, order, group, now, actor, override_reason=body.reason.strip())
                db.add(KitchenChange(
                    id=uuid.uuid4(), tenant_id=order.tenant_id, shop_id=order.shop_id, order_id=order.id,
                    kind="override", text=body.reason.strip(), requires_ack=False, created_at=now,
                ))
            else:
                _set_ready(db, order, group, now, actor)
            order.version += 1
            return _out("applied", order=_order_brief(db, order))
        if kind == "undo_pickup":
            if group.state == "handed_over":
                # "החזר": back from handed over to ready (the pickup screen shows it again).
                group.state = "ready_for_pickup"
                group.handed_over_at = None
                group.version += 1
                order.status = "ready"
                order.handed_over_at = None
                order.version += 1
                return _out("applied", order=_order_brief(db, order))
            if group.state != "ready_for_pickup":
                return _out("noop", order=_order_brief(db, order))
            group.state = "waiting"
            group.ready_at = None
            group.override_reason = None
            group.version += 1
            _suppress(db, order, group, "undo")
            order.status = "open"
            order.version += 1
            return _out("applied", order=_order_brief(db, order))
        # handover
        if group.state == "handed_over":
            return _out("noop", order=_order_brief(db, order))
        if group.state == "cancelled":
            return _out("rejected", reason="group_cancelled")
        group.state = "handed_over"
        group.handed_over_at = now
        group.handed_over_by = actor
        group.version += 1
        _suppress(db, order, group, "handed_over")
        order.status = "handed_over"
        order.handed_over_at = now
        order.version += 1
        return _out("applied", order=_order_brief(db, order))

    raise _refuse("unknown_action", status.HTTP_422_UNPROCESSABLE_ENTITY)


def _last_cancel_at(db: Session, task: KitchenTask) -> Optional[datetime]:
    rows = (
        db.query(KitchenChange.created_at)
        .filter(KitchenChange.task_id == task.id, KitchenChange.kind == "cancel")
        .all()
    )
    times = [as_utc(r[0]) for r in rows if r[0] is not None]
    return max(times) if times else None


def _task_action(db, order, task, body: KdsActionIn, rules, now, actor):
    """None: nothing to do; a string: why it was refused; True: changed."""
    kind = body.type
    if kind == "start":
        if task.release_state != "released":
            return "task_held"
        if active_qty(task) <= ZERO:
            return "task_cancelled"
        if task.prep_state != "queued":
            return None
        task.prep_state = "preparing"
        task.started_at = now
        return True
    if kind == "item_ready":
        if task.release_state != "released":
            return "task_held"
        if rules["requireStart"] and task.prep_state == "queued":
            return "start_required"
        wanted = _q(body.qty) if body.qty is not None else remaining_qty(task)
        allowed = remaining_qty(task)
        occurred = as_utc(body.occurred_at)
        cancelled_at = _last_cancel_at(db, task)
        if wanted > allowed and occurred is not None and cancelled_at is not None and occurred < cancelled_at:
            # Prepared before the cancellation reached the station: recorded, not lost —
            # and never more than was ever ordered, never reviving the cancelled units.
            room = _q(task.ordered_qty) - _q(task.prepared_qty)
            take = min(wanted, max(room, ZERO))
            if take <= ZERO:
                return None
            task.prepared_qty = _q(task.prepared_qty) + take
            task.over_prepared = _q(task.prepared_qty) > active_qty(task)
            db.add(KitchenChange(
                id=uuid.uuid4(), tenant_id=task.tenant_id, shop_id=task.shop_id, order_id=task.order_id,
                task_id=task.id, station_id=task.station_id, kind="override", qty=take,
                text="prepared_before_cancel", requires_ack=False, created_at=now,
            ))
        else:
            take = min(wanted, allowed)
            if take <= ZERO:
                return "task_cancelled" if active_qty(task) <= ZERO else None
            task.prepared_qty = _q(task.prepared_qty) + take
        task.started_at = task.started_at or now
        if _q(task.prepared_qty) >= active_qty(task):
            task.prep_state = "ready"
            task.ready_at = now
        else:
            task.prep_state = "preparing"
        return True
    if kind == "undo_ready":
        prepared = _q(task.prepared_qty)
        if prepared <= ZERO:
            return None
        take = min(_q(body.qty) if body.qty is not None else prepared, prepared)
        task.prepared_qty = prepared - take
        task.over_prepared = _q(task.prepared_qty) > active_qty(task)
        if _q(task.prepared_qty) < active_qty(task):
            task.prep_state = "preparing"
            task.ready_at = None
        return True
    if kind == "resolve_fallback":
        if not task.fallback_printed or task.fallback_resolved_at is not None:
            return None
        task.fallback_resolved_at = now
        if body.resolution == "prepared" and active_qty(task) > ZERO:
            task.prepared_qty = active_qty(task)
            task.prep_state = "ready"
            task.started_at = task.started_at or now
            task.ready_at = now
        return True
    if kind == "remake":
        if not (body.reason or "").strip():
            return "reason_required"
        qty = _q(body.qty) if body.qty is not None else active_qty(task)
        if qty <= ZERO or task.prep_state != "ready":
            return "remake_needs_ready_task"
        count = db.query(KitchenTask).filter(KitchenTask.linked_task_id == task.id).count()
        remade = KitchenTask(
            id=uuid.uuid4(), tenant_id=task.tenant_id, shop_id=task.shop_id, order_id=task.order_id,
            dispatch_id=task.dispatch_id, round_no=task.round_no, group_id=task.group_id, station_id=task.station_id,
            station_key=task.station_key, station_name=task.station_name, target_kind=task.target_kind,
            required=task.required, line_key=f"{task.line_key}~r{count + 1}"[:120], product_id=task.product_id,
            category_id=task.category_id, name=task.name, mods=task.mods, removals=task.removals, notes=task.notes,
            allergies=task.allergies, important=task.important, seat=task.seat, course=task.course,
            meal_name=task.meal_name, ordered_qty=qty, cancelled_qty=ZERO, prepared_qty=ZERO,
            release_state="released", prep_state="queued", linked_task_id=task.id,
            remake_reason=body.reason.strip(), version=1, created_at=now, released_at=now,
        )
        db.add(remade)
        db.add(KitchenChange(
            id=uuid.uuid4(), tenant_id=task.tenant_id, shop_id=task.shop_id, order_id=task.order_id,
            task_id=remade.id, station_id=task.station_id, kind="remake", qty=qty, text=body.reason.strip(),
            requires_ack=False, created_at=now,
        ))
        db.flush()
        return True
    return None


# ── Read models: the board, the pickup screen, the till's badges ────────────────


def task_out(task: KitchenTask) -> Dict[str, Any]:
    return {
        "id": str(task.id),
        "orderId": str(task.order_id),
        "dispatchId": task.dispatch_id,
        "roundNo": task.round_no,
        "stationId": str(task.station_id) if task.station_id else None,
        "stationName": task.station_name,
        "targetKind": task.target_kind,
        "required": bool(task.required),
        "lineKey": task.line_key,
        "productId": task.product_id,
        "name": task.name,
        "mods": task.mods or [],
        "removals": task.removals or [],
        "notes": task.notes,
        "allergies": task.allergies or [],
        "important": bool(task.important),
        "seat": task.seat,
        "course": task.course,
        "mealName": task.meal_name,
        "orderedQty": _num(task.ordered_qty),
        "cancelledQty": _num(task.cancelled_qty),
        "preparedQty": _num(task.prepared_qty),
        "activeQty": _num(active_qty(task)),
        "release": task.release_state,
        "state": task.prep_state,
        "fallbackPrinted": bool(task.fallback_printed),
        "fallbackResolved": task.fallback_resolved_at is not None,
        "overPrepared": bool(task.over_prepared),
        "linkedTaskId": str(task.linked_task_id) if task.linked_task_id else None,
        "remakeReason": task.remake_reason,
        "version": task.version,
        "releasedAt": _iso(task.released_at),
        "startedAt": _iso(task.started_at),
        "readyAt": _iso(task.ready_at),
    }


def change_out(change: KitchenChange) -> Dict[str, Any]:
    return {
        "id": str(change.id),
        "taskId": str(change.task_id) if change.task_id else None,
        "stationId": str(change.station_id) if change.station_id else None,
        "kind": change.kind,
        "qty": _num(change.qty) if change.qty is not None else None,
        "text": change.text,
        "before": change.before,
        "after": change.after,
        "requiresAck": bool(change.requires_ack),
        "acked": change.acked_at is not None,
        "createdAt": _iso(change.created_at),
    }


def _order_brief(db: Session, order: KitchenOrder) -> Dict[str, Any]:
    group = _group(db, order)
    return {
        "id": str(order.id),
        "status": order.status,
        "groupState": group.state,
        "version": order.version,
        "pickupNumber": order.pickup_number,
    }


def order_out(
    order: KitchenOrder,
    group: Optional[FulfillmentGroup],
    tasks: List[KitchenTask],
    changes: List[KitchenChange],
    dispatches: Dict[str, KitchenDispatch],
) -> Dict[str, Any]:
    rules = _order_rules(order)
    rounds = sorted({t.round_no for t in tasks})
    return {
        "id": str(order.id),
        "source": order.source,
        "sourceRef": order.source_ref,
        "displayRef": order.display_ref,
        "tableRef": order.table_ref,
        "zoneName": order.zone_name,
        "serviceType": order.service_type,
        "guests": order.guests,
        "waiterName": order.waiter_name,
        "pickupName": order.pickup_name,
        "orderNote": order.order_note,
        "pickupNumber": order.pickup_number,
        "workflowMode": order.workflow_mode,
        "configVersion": order.config_version,
        "paid": bool(order.paid),
        "status": order.status,
        "priority": order.priority,
        "priorityReason": order.priority_reason,
        "groupState": group.state if group else None,
        "groupOverride": group.override_reason if group else None,
        "readyAt": _iso(group.ready_at) if group else None,
        "allReady": all_ready(tasks),
        "requireExpo": rules["requireExpo"],
        "requireStart": rules["requireStart"],
        "trackHandover": rules["trackHandover"],
        "viewOnly": rules["viewOnly"],
        "firstReleasedAt": _iso(order.first_released_at),
        "createdAt": _iso(order.created_at),
        "version": order.version,
        "rounds": [
            {
                "roundNo": n,
                "releasedAt": _iso(min((t.released_at or t.created_at) for t in tasks if t.round_no == n)),
                "isAddition": n > 1,
            }
            for n in rounds
        ],
        "tasks": [task_out(t) for t in sorted(tasks, key=lambda t: (t.round_no, t.station_key, t.line_key))],
        "changes": [change_out(c) for c in sorted(changes, key=lambda c: as_utc(c.created_at) or _now())],
    }


def _open_orders(db: Session, shop_id: Any, now: datetime) -> List[KitchenOrder]:
    since = now - BOARD_WINDOW
    orders = (
        db.query(KitchenOrder)
        .filter(KitchenOrder.shop_id == shop_id, KitchenOrder.status.in_(("open", "ready")))
        .all()
    )
    pending_ack = {
        row[0]
        for row in db.query(KitchenChange.order_id)
        .filter(KitchenChange.shop_id == shop_id, KitchenChange.acked_at.is_(None), KitchenChange.requires_ack.is_(True))
        .all()
    }
    recent = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.shop_id == shop_id,
            KitchenOrder.status.in_(("handed_over", "cancelled", "closed")),
            KitchenOrder.updated_at >= now - RECENT_HANDOVER,
        )
        .all()
    )
    seen = {o.id for o in orders}
    extra_ids = [i for i in pending_ack if i not in seen]
    if extra_ids:
        orders += db.query(KitchenOrder).filter(KitchenOrder.id.in_(extra_ids)).all()
        seen |= set(extra_ids)
    orders += [o for o in recent if o.id not in seen]
    return [o for o in orders if (as_utc(o.created_at) or now) >= since]


def _bundle(db: Session, orders: List[KitchenOrder]):
    ids = [o.id for o in orders]
    if not ids:
        return {}, {}, {}, {}
    tasks: Dict[Any, List[KitchenTask]] = {}
    for t in db.query(KitchenTask).filter(KitchenTask.order_id.in_(ids)).all():
        tasks.setdefault(t.order_id, []).append(t)
    changes: Dict[Any, List[KitchenChange]] = {}
    for c in db.query(KitchenChange).filter(KitchenChange.order_id.in_(ids)).all():
        changes.setdefault(c.order_id, []).append(c)
    groups = {
        g.order_id: g
        for g in db.query(FulfillmentGroup).filter(FulfillmentGroup.order_id.in_(ids), FulfillmentGroup.key == "order").all()
    }
    dispatches: Dict[str, KitchenDispatch] = {}
    return tasks, changes, groups, dispatches


def _station_visible(task: KitchenTask, changes: List[KitchenChange], now: datetime) -> bool:
    if task.release_state == "hold":
        return active_qty(task) > ZERO
    if any(c.task_id == task.id and c.requires_ack and c.acked_at is None for c in changes):
        return True
    if task.fallback_printed and task.fallback_resolved_at is None and active_qty(task) > ZERO:
        return True
    if active_qty(task) <= ZERO:
        return False
    if task.prep_state != "ready":
        return True
    ready_at = as_utc(task.ready_at)
    return ready_at is not None and now - ready_at <= RECENT_READY


def board(db: Session, machine: POSMachine, since: Optional[int] = None) -> Dict[str, Any]:
    """
    `GET /sync/{m}/kds/board`: what this screen shows. `since` = the version the screen
    has: unchanged → `{"syncType": "unchanged"}`.
    """
    device = device_for_machine(db, machine)
    if device is None:
        raise _refuse("not_a_kds_device", status.HTTP_403_FORBIDDEN)
    now = _now()
    seen = as_utc(device.last_seen_at)
    if seen is None or now - seen >= SEEN_EVERY:
        device.last_seen_at = now
    state = shop_state(db, device.shop_id, device.tenant_id)
    shop = db.query(Shop).filter(Shop.id == device.shop_id).first()
    base = {
        "serverTime": _iso(now),
        "version": state.version,
        "device": device_out(db, device),
        "shopName": shop.name if shop else None,
    }
    if since is not None and since == state.version:
        return {"syncType": "unchanged", **base}
    if device.role == "pickup":
        return {"syncType": "full", **base, "pickup": pickup_board(db, device.shop_id)}

    orders = _open_orders(db, device.shop_id, now)
    tasks, changes, groups, dispatches = _bundle(db, orders)
    mine = set(device.station_ids or [])
    out_orders = []
    for order in orders:
        order_tasks = tasks.get(order.id, [])
        order_changes = changes.get(order.id, [])
        if order.workflow_mode == WF.DIRECT_SALE:
            released = as_utc(order.first_released_at) or as_utc(order.created_at) or now
            if now - released > VIEW_TTL:
                continue
        if device.role == "station":
            visible = [
                t for t in order_tasks if str(t.station_id) in mine and _station_visible(t, order_changes, now)
            ]
            if not visible:
                continue
            station_changes = [c for c in order_changes if c.station_id is None or str(c.station_id) in mine]
            payload = order_out(order, groups.get(order.id), visible, station_changes, dispatches)
            # The rest of the order, for context ("גם: 2 צ׳יפס בטיגון").
            payload["otherStations"] = sorted({
                t.station_name or "—" for t in order_tasks
                if str(t.station_id) not in mine and active_qty(t) > ZERO and t.release_state == "released"
            })
            out_orders.append(payload)
        else:
            if not order_tasks:
                continue
            out_orders.append(order_out(order, groups.get(order.id), order_tasks, order_changes, dispatches))
    out_orders.sort(key=lambda o: (-(o["priority"] or 0), o["firstReleasedAt"] or o["createdAt"] or ""))
    settings = {
        str(s.station_id): {"targetKind": s.target_kind, "warnMinutes": s.warn_minutes, "lateMinutes": s.late_minutes}
        for s in db.query(KdsStationSetting).filter(KdsStationSetting.shop_id == device.shop_id).all()
    }
    return {"syncType": "full", **base, "orders": out_orders, "stationSettings": settings}


def pickup_board(db: Session, shop_id: Any) -> Dict[str, Any]:
    """
    The pickup screen (§4, §11): numbers in preparation and ready — nothing else. No
    name, no phone, no note. Tables are served, not picked up: not listed.
    """
    now = _now()
    orders = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.shop_id == shop_id,
            KitchenOrder.workflow_mode == WF.ORDER_PROCESS,
            KitchenOrder.source != "table",
            KitchenOrder.status.in_(("open", "ready")),
        )
        .all()
    )
    preparing, ready = [], []
    for order in orders:
        if (as_utc(order.created_at) or now) < now - BOARD_WINDOW:
            continue
        number = order.pickup_number if order.pickup_number is not None else order.display_ref
        if number is None:
            continue
        group = _group(db, order)
        config = order.config_snapshot or {}
        if group.state == "ready_for_pickup":
            ready_at = as_utc(group.ready_at) or now
            if not config.get("trackHandover", True) and now - ready_at > PICKUP_READY_TTL:
                continue
            ready.append({"number": str(number), "since": _iso(ready_at)})
        elif group.state == "waiting":
            preparing.append({"number": str(number), "since": _iso(order.first_released_at or order.created_at)})
    preparing.sort(key=lambda x: x["since"] or "")
    ready.sort(key=lambda x: x["since"] or "", reverse=True)
    return {"preparing": preparing, "ready": ready, "serverTime": _iso(now)}


def public_pickup(db: Session, token: str) -> Dict[str, Any]:
    state = db.query(KdsShopState).filter(KdsShopState.pickup_token == token).first() if token else None
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    shop = db.query(Shop).filter(Shop.id == state.shop_id).first()
    return {"shopName": shop.name if shop else None, "version": state.version, **pickup_board(db, state.shop_id)}


def order_states(db: Session, machine: POSMachine, source: str, refs: Sequence[str]) -> Dict[str, Any]:
    """The till's badges: per source ref, where the kitchen is with it."""
    refs = [r for r in refs if r][:200]
    if not refs or machine.shop_id is None:
        return {"orders": {}}
    orders = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.tenant_id == machine.tenant_id,
            KitchenOrder.shop_id == machine.shop_id,
            KitchenOrder.source == source,
            KitchenOrder.source_ref.in_(refs),
        )
        .all()
    )
    tasks, _, groups, _ = _bundle(db, orders)
    out: Dict[str, Any] = {}
    for order in orders:
        req = [t for t in tasks.get(order.id, []) if t.release_state == "released" and active_qty(t) > ZERO]
        group = groups.get(order.id)
        out[order.source_ref] = {
            "orderId": str(order.id),
            "status": order.status,
            "groupState": group.state if group else None,
            "workflowMode": order.workflow_mode,
            "pickupNumber": order.pickup_number,
            "tasks": len(req),
            "ready": len([t for t in req if t.prep_state == "ready"]),
            "preparing": len([t for t in req if t.prep_state == "preparing"]),
            "held": len([t for t in tasks.get(order.id, []) if t.release_state == "hold" and active_qty(t) > ZERO]),
        }
    return {"orders": out}


# ── Dashboard: devices, stations, overview ──────────────────────────────────────


def shop_overview(db: Session, shop: Shop) -> Dict[str, Any]:
    from app.models.kds import KdsRouteOverride
    from app.services.printers import shop_machines, station_printers_in_shop, stations_of

    names = {str(s.id): s.name for s in stations_of(db, shop.tenant_id)}
    devices = db.query(KdsDevice).filter(KdsDevice.shop_id == shop.id).all()
    settings = {str(s.station_id): s for s in db.query(KdsStationSetting).filter(KdsStationSetting.shop_id == shop.id).all()}
    printers = station_printers_in_shop(db, shop.tenant_id, shop.id)
    covered = {sid for d in devices if d.is_active and d.role == "station" for sid in (d.station_ids or [])}
    state = shop_state(db, shop.id, shop.tenant_id)
    now = _now()
    open_orders = _open_orders(db, shop.id, now)
    tasks, _, _, _ = _bundle(db, open_orders)
    unrouted = sum(
        1 for ts in tasks.values() for t in ts if t.station_id is None and active_qty(t) > ZERO and t.prep_state != "ready"
    )
    return {
        "shopId": str(shop.id),
        "stations": [
            {
                "id": sid,
                "name": name,
                "targetKind": settings[sid].target_kind if sid in settings else "prep",
                "warnMinutes": settings[sid].warn_minutes if sid in settings else 10,
                "lateMinutes": settings[sid].late_minutes if sid in settings else 20,
                "hasDevice": sid in covered,
                "printerIds": printers.get(sid, []),
            }
            for sid, name in names.items()
        ],
        "devices": [device_out(db, d, names) for d in devices],
        "machines": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number}
            for m in shop_machines(db, shop.id)
        ],
        "overrides": [
            {
                "id": str(o.id), "targetType": o.target_type, "targetId": str(o.target_id),
                "stationId": str(o.station_id) if o.station_id else None,
                "areaId": str(o.area_id) if o.area_id else None, "serviceType": o.service_type,
            }
            for o in db.query(KdsRouteOverride).filter(KdsRouteOverride.shop_id == shop.id).all()
        ],
        "pickupToken": state.pickup_token,
        "openOrders": len([o for o in open_orders if o.status in ("open", "ready")]),
        "unroutedTasks": unrouted,
        "version": state.version,
    }


def _set_screen_flag(db: Session, machine_id: Any, on: bool) -> None:
    """
    `kdsScreen` on the till itself: only a till flagged so asks the cloud whether it is a
    KDS screen — an ordinary till makes no extra call at all.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == WF.KDS_SCREEN_KEY).first()
    if parameter is None:
        return
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine_id,
        )
        .first()
    )
    if on and row is None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine_id, value=True,
        ))
    elif on and row is not None:
        row.value = True
        row.updated_at = _now()
    elif row is not None:
        db.delete(row)
        parameter.updated_at = _now()


def save_device(db: Session, shop: Shop, machine_id: Any, body) -> KdsDevice:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None or machine.shop_id != shop.id:
        raise _refuse("machine_not_in_shop", status.HTTP_422_UNPROCESSABLE_ENTITY)
    names = _station_names(db, shop.tenant_id)
    station_ids = [str(s) for s in body.station_ids]
    for sid in station_ids:
        if sid not in names:
            raise _refuse("station_not_found", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if body.role == "station" and not station_ids:
        raise _refuse("station_device_needs_a_station", status.HTTP_422_UNPROCESSABLE_ENTITY)
    device = db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).first()
    if device is None:
        device = KdsDevice(id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, machine_id=machine.id)
        db.add(device)
    device.shop_id = shop.id
    device.name = (body.name or "").strip() or machine.name or "KDS"
    device.role = body.role
    device.station_ids = station_ids if body.role == "station" else []
    device.is_active = body.is_active
    _set_screen_flag(db, machine.id, bool(body.is_active))
    bump(db, shop.id, shop.tenant_id)
    db.flush()
    return device


def delete_device(db: Session, shop: Shop, machine_id: Any) -> None:
    device = db.query(KdsDevice).filter(KdsDevice.machine_id == machine_id, KdsDevice.shop_id == shop.id).first()
    if device is None:
        raise _refuse("device_not_found", status.HTTP_404_NOT_FOUND)
    db.delete(device)
    _set_screen_flag(db, machine_id, False)
    bump(db, shop.id, shop.tenant_id)
    db.flush()


def save_station_setting(db: Session, shop: Shop, station_id: Any, body) -> KdsStationSetting:
    from app.services.printers import get_station

    station = get_station(db, shop.tenant_id, station_id)
    if body.late_minutes < body.warn_minutes:
        raise _refuse("late_before_warn", status.HTTP_422_UNPROCESSABLE_ENTITY)
    row = (
        db.query(KdsStationSetting)
        .filter(KdsStationSetting.shop_id == shop.id, KdsStationSetting.station_id == station.id)
        .first()
    )
    if row is None:
        row = KdsStationSetting(shop_id=shop.id, station_id=station.id, tenant_id=shop.tenant_id)
        db.add(row)
    row.target_kind = body.target_kind
    row.warn_minutes = body.warn_minutes
    row.late_minutes = body.late_minutes
    bump(db, shop.id, shop.tenant_id)
    db.flush()
    return row


def add_override(db: Session, shop: Shop, body) -> Dict[str, Any]:
    from app.models.category import Category
    from app.models.kds import KdsRouteOverride
    from app.models.product import Product
    from app.models.shop_area import ShopArea
    from app.services.printers import get_station

    model = Category if body.target_type == "category" else Product
    if db.query(model.id).filter(model.id == body.target_id, model.tenant_id == shop.tenant_id).first() is None:
        raise _refuse(f"{body.target_type}_not_found", status.HTTP_404_NOT_FOUND)
    if body.station_id is not None:
        get_station(db, shop.tenant_id, body.station_id)
    if body.area_id is not None:
        area = db.query(ShopArea).filter(ShopArea.id == body.area_id).first()
        if area is None or area.shop_id != shop.id:
            raise _refuse("area_not_in_shop", status.HTTP_422_UNPROCESSABLE_ENTITY)
    db.query(KdsRouteOverride).filter(
        KdsRouteOverride.shop_id == shop.id,
        KdsRouteOverride.target_type == body.target_type,
        KdsRouteOverride.target_id == body.target_id,
        (KdsRouteOverride.area_id == body.area_id) if body.area_id else KdsRouteOverride.area_id.is_(None),
        (KdsRouteOverride.service_type == body.service_type)
        if body.service_type
        else KdsRouteOverride.service_type.is_(None),
    ).delete(synchronize_session=False)
    row = KdsRouteOverride(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, area_id=body.area_id,
        service_type=body.service_type, target_type=body.target_type, target_id=body.target_id,
        station_id=body.station_id,
    )
    db.add(row)
    db.flush()
    return {"id": str(row.id)}


def delete_override(db: Session, shop: Shop, override_id: Any) -> None:
    from app.models.kds import KdsRouteOverride

    db.query(KdsRouteOverride).filter(
        KdsRouteOverride.id == override_id, KdsRouteOverride.shop_id == shop.id
    ).delete(synchronize_session=False)
    db.flush()


def shop_board(db: Session, shop: Shop) -> Dict[str, Any]:
    """The dashboard's live view of a shop's kitchen (the Expo's view, read only)."""
    now = _now()
    orders = [o for o in _open_orders(db, shop.id, now) if o.status in ("open", "ready")]
    tasks, changes, groups, dispatches = _bundle(db, orders)
    out = [
        order_out(o, groups.get(o.id), tasks.get(o.id, []), changes.get(o.id, []), dispatches)
        for o in orders
        if tasks.get(o.id)
    ]
    out.sort(key=lambda o: (-(o["priority"] or 0), o["firstReleasedAt"] or o["createdAt"] or ""))
    return {"serverTime": _iso(now), "orders": out, "pickup": pickup_board(db, shop.id)}
