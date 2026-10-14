"""
Service on the floor and in the kitchen, watched in the background (P:/specs/push-more.md §C;
push category `slow_order`) — every minute in the exception alerts' pass (worker.py), each kind
off until a level switches it on ("הגדרות חריגות"; read on the till's chain — the till that
opened the table / released the ticket — else the shop's).

* **"שולחן פתוח זמן רב"** (`table_open_long`): a table order (`table_orders`, table management)
  still open `openMinutes` (180) after it was opened. One row per opening
  (`table_open_long:<order>`), the waiter as the employee, the total as the amount. Closed by
  itself when the order is no longer open: paid, cancelled, merged or voided. Every tables mode
  reaches the cloud: synced tables live here; a single till and a LAN host mirror their orders as
  they change (`POST /sync/{id}/tables/report`) — a mirrored order is judged only while the till
  that reports it is heard from (15 minutes), so a till offline with a paid table never raises a
  stale one.
* **"הזמנה במטבח לא מוכנה בזמן"** (`kds_ticket_late`): a KDS ticket — one round released to the
  kitchen (`kds_dispatches`; a quick sale or a kiosk order is one round, a table's every send is
  its own) — with a task still not ready `readyMinutes` (20) after it was released. Only what the
  cloud KDS holds (docs/SPEC_KDS.md; in LAN mode the KDS is cloud-only too): tasks that block
  readiness (required, released, an active quantity, a preparation station) of an order in the
  preparation flow (ORDER_PROCESS). Not judged: DIRECT_SALE (view-only tasks, no readiness), a
  round the till printed on its fallback printer because the KDS was out of reach (prepared off the
  screen), a shop with kitchen printers only (no readiness reaches the cloud at all). One row per
  ticket (`kds_ticket_late:<dispatch>`); closed by itself when every task of it is ready (or the
  order is ready, handed over, cancelled or closed).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.exception_alerts import watch as WT

logger = logging.getLogger(__name__)

TABLE_OPEN = "table_open_long"
KDS_LATE = "kds_ticket_late"
#: A table open longer than its threshold plus this is a forgotten order, not news.
TABLE_LOOKBACK = timedelta(hours=12)
#: A mirrored order is trusted while the till that reports it was heard this recently.
MIRROR_FRESH = timedelta(minutes=15)
#: Tickets released longer ago than this are not judged (a day's leftovers).
KDS_LOOKBACK = timedelta(hours=12)
CLOSED_WORDS = {
    "paid": "השולחן שולם",
    "cancelled": "השולחן בוטל",
    "merged": "השולחן אוחד לשולחן אחר",
    "void": "ההזמנה בוטלה",
}


class _Places:
    """Shops and tills, once per pass."""

    def __init__(self, db: Session):
        self.db = db
        self._shops: Dict[Any, Optional[Shop]] = {}
        self._machines: Dict[Any, Optional[POSMachine]] = {}

    def shop(self, shop_id) -> Optional[Shop]:
        if shop_id not in self._shops:
            self._shops[shop_id] = self.db.get(Shop, shop_id) if shop_id else None
        return self._shops[shop_id]

    def machine(self, machine_id) -> Optional[POSMachine]:
        if machine_id not in self._machines:
            self._machines[machine_id] = self.db.get(POSMachine, machine_id) if machine_id else None
        return self._machines[machine_id]


# ── Tables ───────────────────────────────────────────────────────────────────


def _uuid(value: Any):
    import uuid

    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _mirror_fresh(places: _Places, order, now: datetime) -> bool:
    if order.source != "local":
        return True
    for machine_id in (order.updated_machine_id, order.opened_machine_id):
        m = places.machine(machine_id)
        beat = WT.utc(m.last_heartbeat_at) if m is not None else None
        if beat is not None and now - beat <= MIRROR_FRESH:
            return True
    return False


def scan_tables(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: tables open too long recorded (once per opening), closed ones closed. Caller commits."""
    from app.models.tables import TableOrder, TableZone

    now = WT.utc(now) or datetime.now(timezone.utc)
    changed = 0
    places = _Places(db)
    tenants = WT.enabled_tenants(db, TABLE_OPEN)
    orders = []
    if tenants:
        orders = (
            db.query(TableOrder)
            .filter(
                TableOrder.tenant_id.in_(list(tenants)),
                TableOrder.status == "open",
                TableOrder.opened_at <= now - timedelta(minutes=15),
                TableOrder.opened_at > now - timedelta(hours=24) - TABLE_LOOKBACK,
            )
            .all()
        )
    for order in orders:
        shop = places.shop(order.shop_id)
        if shop is None or not shop.is_active:
            continue
        machine = places.machine(order.opened_machine_id)
        rule = WT.place_rule(db, shop, machine, TABLE_OPEN)
        if rule is None:
            continue
        minutes = int(WT.param(rule, "openMinutes", 180))
        opened = WT.utc(order.opened_at)
        open_for = (now - opened).total_seconds() / 60
        if open_for < minutes or now - opened > timedelta(minutes=minutes) + TABLE_LOOKBACK:
            continue
        if not _mirror_fresh(places, order, now):
            continue
        key = f"{TABLE_OPEN}:{order.id}"
        if WT.find(db, key) is not None:
            continue
        zone = db.get(TableZone, order.zone_id) if order.zone_id else None
        table = f"שולחן {order.table_number}" if order.table_number is not None else "שולחן"
        if order.table_name:
            table += f" {order.table_name}"
        waiter = order.waiter_pos_user_name or order.opened_by_pos_user_name
        parts = [f"{table}{f' ({zone.name})' if zone is not None else ''} פתוח {WT.minutes_text(open_for)} בלי תשלום",
                 WT.money(order.total)]
        if waiter:
            parts.append(f"מלצר: {waiter}")
        row = WT.write(
            db, exception_type=TABLE_OPEN, dedupe_key=key, occurred_at=opened + timedelta(minutes=minutes),
            now=now, severity="low", tenant_id=order.tenant_id, company_id=shop.company_id, shop_id=shop.id,
            area_id=(zone.area_id if zone is not None and zone.area_id else (machine.area_id if machine else None)),
            machine_id=machine.id if machine is not None and machine.shop_id == shop.id else None,
            amount=order.total, value=round(open_for, 2), threshold=minutes,
            pos_user_id=order.waiter_pos_user_id or order.opened_by_pos_user_id, pos_user_name=waiter,
            details={
                "summary": " · ".join(p for p in parts if p),
                "orderId": str(order.id),
                "tableId": str(order.table_id),
                "tableNumber": order.table_number,
                "tableName": order.table_name,
                "zoneName": zone.name if zone is not None else None,
                "guests": order.guests,
                "itemCount": float(order.item_count or 0),
                "total": float(order.total or 0),
                "openedAt": opened.isoformat(),
                "waiter": waiter,
                "source": order.source,
            },
        )
        if row is not None:
            changed += 1
    for row in WT.open_rows(db, TABLE_OPEN, now=now, days=3):
        order_id = _uuid((row.details or {}).get("orderId"))
        order = db.get(TableOrder, order_id) if order_id else None
        if order is not None and order.status == "open":
            continue
        status = order.status if order is not None else None
        why = CLOSED_WORDS.get(status or "", "ההזמנה נסגרה")
        extra: Dict[str, Any] = {"closedStatus": status}
        if order is not None and order.paid_total is not None:
            extra["paidTotal"] = float(order.paid_total)
        if order is not None and order.transaction_id:
            extra["transactionNumber"] = order.transaction_number
        if WT.resolve(row, now=now, at=WT.utc(order.closed_at) if order is not None else None, why=why, extra=extra):
            changed += 1
    db.flush()
    return changed


# ── KDS tickets ──────────────────────────────────────────────────────────────


def _pending(tasks: List[Any]) -> List[Any]:
    """The tasks of a ticket that still block it: required, released, active, not ready, not a fallback print."""
    from app.services.kds import active_qty

    return [
        t for t in tasks
        if t.required and t.release_state == "released" and t.prep_state != "ready"
        and not t.fallback_printed and active_qty(t) > 0
    ]


def scan_kds(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: tickets late recorded (once each), ready ones closed. Caller commits."""
    from app.models.kds import KitchenDispatch, KitchenOrder, KitchenTask

    now = WT.utc(now) or datetime.now(timezone.utc)
    changed = 0
    places = _Places(db)
    tenants = WT.enabled_tenants(db, KDS_LATE)
    rows = []
    if tenants:
        rows = (
            db.query(KitchenTask, KitchenOrder)
            .join(KitchenOrder, KitchenOrder.id == KitchenTask.order_id)
            .filter(
                KitchenTask.tenant_id.in_(list(tenants)),
                KitchenOrder.status == "open",
                KitchenOrder.workflow_mode == "ORDER_PROCESS",
                KitchenTask.required.is_(True),
                KitchenTask.release_state == "released",
                KitchenTask.prep_state != "ready",
                KitchenTask.fallback_printed.is_(False),
                KitchenTask.created_at > now - KDS_LOOKBACK - timedelta(hours=4),
            )
            .all()
        )
    tickets: Dict[str, List[Any]] = defaultdict(list)
    order_of: Dict[str, Any] = {}
    for task, order in rows:
        tickets[task.dispatch_id].append(task)
        order_of[task.dispatch_id] = order
    for dispatch_id, tasks in tickets.items():
        pending = _pending(tasks)
        if not pending:
            continue
        order = order_of[dispatch_id]
        since = min(WT.utc(t.released_at or t.created_at) for t in pending)
        if now - since > KDS_LOOKBACK:
            continue
        shop = places.shop(order.shop_id)
        if shop is None or not shop.is_active:
            continue
        machine = places.machine(order.machine_id)
        rule = WT.place_rule(db, shop, machine, KDS_LATE)
        if rule is None:
            continue
        minutes = int(WT.param(rule, "readyMinutes", 20))
        waited = (now - since).total_seconds() / 60
        if waited < minutes:
            continue
        key = f"{KDS_LATE}:{dispatch_id}"
        if WT.find(db, key) is not None:
            continue
        dispatch = db.get(KitchenDispatch, dispatch_id)
        ref = order.pickup_label or order.display_ref or order.transaction_number
        what = f"הזמנה {ref}" if ref else "הזמנה"
        if order.table_ref:
            what += f" (שולחן {order.table_ref})"
        if dispatch is not None and dispatch.round_no and dispatch.round_no > 1:
            what += f", סבב {dispatch.round_no}"
        stations = sorted({t.station_name or t.station_key for t in pending if (t.station_name or t.station_key)})
        items = [{"name": t.name, "quantity": float(t.ordered_qty or 0) - float(t.cancelled_qty or 0),
                  "station": t.station_name or t.station_key} for t in pending[:20]]
        parts = [f"{what} לא מוכנה {WT.minutes_text(waited)}"]
        if stations:
            parts.append(", ".join(stations[:3]))
        parts.append(f"{len(pending)} פריטים ממתינים" if len(pending) != 1 else f"ממתין: {pending[0].name}")
        row = WT.write(
            db, exception_type=KDS_LATE, dedupe_key=key, occurred_at=since + timedelta(minutes=minutes),
            now=now, severity="medium", tenant_id=order.tenant_id, company_id=shop.company_id, shop_id=shop.id,
            area_id=order.area_id or (machine.area_id if machine is not None else None),
            machine_id=machine.id if machine is not None and machine.shop_id == shop.id else None,
            value=round(waited, 2), threshold=minutes,
            pos_user_name=order.waiter_name or (dispatch.actor_name if dispatch is not None else None),
            details={
                "summary": " · ".join(parts),
                "orderId": str(order.id),
                "dispatchId": dispatch_id,
                "roundNo": dispatch.round_no if dispatch is not None else None,
                "source": order.source,
                "ref": ref,
                "tableRef": order.table_ref,
                "pickupName": order.pickup_name,
                "stations": stations,
                "items": items,
                "releasedAt": since.isoformat(),
            },
        )
        if row is not None:
            changed += 1
    for row in WT.open_rows(db, KDS_LATE, now=now, days=2):
        details = row.details or {}
        order_id = _uuid(details.get("orderId"))
        order = db.get(KitchenOrder, order_id) if order_id else None
        why = None
        at = None
        if order is None:
            why = "ההזמנה נמחקה"
        elif order.status in ("cancelled",):
            why, at = "ההזמנה בוטלה", order.cancelled_at
        elif order.status in ("handed_over", "closed"):
            why, at = "ההזמנה נמסרה", order.handed_over_at
        else:
            tasks = db.query(KitchenTask).filter(KitchenTask.dispatch_id == details.get("dispatchId")).all()
            if not _pending(tasks):
                ready = [WT.utc(t.ready_at) for t in tasks if t.ready_at is not None]
                why, at = "ההזמנה סומנה כמוכנה", max(ready) if ready else order.ready_at
        if why and WT.resolve(row, now=now, at=WT.utc(at), why=why):
            changed += 1
    db.flush()
    return changed
