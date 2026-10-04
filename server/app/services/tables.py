"""
Table management ("ניהול שולחנות", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §2).

**Modes** (till parameter `tablesMode`): off; single till ("קופה אחת") — the till keeps its
tables in its own database, fully offline, and uploads them here for the reports only
(`apply_local_report`); synced ("מסונכרן בין הקופות") — the tables live here and every
till of the shop (or of the point of sale) works on the same ones, online only.

**Synced mode is built on two guarantees, both enforced here, never trusted to a till:**

* **A lock per table.** Entering a table locks it for that till and employee
  (`try_lock`: one conditional UPDATE, so two tills racing for the same table cannot both
  win). Another till is refused with who holds it (409 `table_locked`). The lock is
  extended by a heartbeat while the till is inside, released when it leaves, sends or
  pays, and expires on its own after `tablesLockMinutes` without a heartbeat (a till
  that went down). A manager may release it by force (`table:unlock`).
* **A version per order.** Every write names the version it is based on; a write based
  on anything else is refused (409 `table_version_conflict`, with the current order) and
  the till reloads — there is no silent overwrite. Each write carries a request id, so a
  retry of a write that already went through is answered with its result instead.

On top of that, at most one synced open order per table (a partial unique index).

An order's cart is the till's own snapshot, opaque here (`cart_json`); the server keeps
the figures it reports on (`total`, `item_count`) and the lifecycle (opened, sent, bill,
paid with which document, cancelled with which reason and approver, moved). A paid table
becomes an ordinary sale document on the till, which reaches the cloud through the usual
sync, so the X, the Z and every sales report are untouched by this module.

Every change wakes the shop's other tills (Ably `tables`, best effort); the tables
screen also polls every few seconds.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tables import (
    DiningTable,
    TableCancelReason,
    TableEvent,
    TableOrder,
    TableReservation,
    TableZone,
)
from app.models.user import User
from app.services.areas import as_utc

logger = logging.getLogger(__name__)

# ── Parameters ────────────────────────────────────────────────────────────────

TABLES_MODE_KEY = "tablesMode"
TABLES_DEFAULT_KEY = "tablesDefault"
LOCK_MINUTES_KEY = "tablesLockMinutes"
BLOCK_CLOSE_KEY = "blockCloseWithOpenTables"

MODE_OFF = "off"
MODE_SINGLE = "single"
MODE_SYNCED = "synced"
#: "רשת מקומית (קופה ראשית)": one till of the shop holds the tables, the others work with
#: it on the LAN; it reports to the cloud like a single till (spec §2.8ב).
MODE_LAN = "lan"
_MODES = {
    "כבוי": MODE_OFF,
    "קופה אחת": MODE_SINGLE,
    "מסונכרן בין הקופות": MODE_SYNCED,
    "רשת מקומית (קופה ראשית)": MODE_LAN,
    MODE_OFF: MODE_OFF,
    MODE_SINGLE: MODE_SINGLE,
    MODE_SYNCED: MODE_SYNCED,
    MODE_LAN: MODE_LAN,
}
#: The till parameter that makes a till its shop's tables host in the LAN mode.
TABLES_HOST_KEY = "tablesHostTill"

LOCK_MINUTES_DEFAULT = 2
LOCK_MINUTES_MIN = 1
LOCK_MINUTES_MAX = 30

#: The Ably event that tells a till "the tables changed, pull them".
NOTIFY_EVENT = "tables"

#: The exception type a cancelled table is reported under (app/services/exceptions.py).
EXCEPTION_TYPE = "table_cancelled"

#: Seeded for a tenant the first time its reasons are read ("סיבות ביטול", spec §2.7).
DEFAULT_REASONS: Tuple[Tuple[str, bool], ...] = (
    ("טעות הקלדה", False),
    ("לקוח ויתר", False),
    ("לקוח עזב", False),
    ("החזרה למטבח", False),
    ("אחר", True),
)

#: Deterministic till-event ids for cancelled tables, so a re-sent report is one event.
_EVENT_NAMESPACE = uuid.UUID("0b8f7a1e-4f3c-4d5e-9a2b-7c1d2e3f4a5b")


def _now() -> datetime:
    """The clock every lock decision reads. A function so tests can move it."""
    return datetime.now(timezone.utc)


def mode_of(value: Any) -> str:
    """`off` | `single` | `synced` | `lan` from the parameter's value (Hebrew option or code)."""
    if not isinstance(value, str):
        return MODE_OFF
    return _MODES.get(value.strip(), MODE_OFF)


def lock_minutes_of(params: Dict[str, Any]) -> int:
    value = params.get(LOCK_MINUTES_KEY)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return LOCK_MINUTES_DEFAULT
    return int(min(max(int(value), LOCK_MINUTES_MIN), LOCK_MINUTES_MAX))


def blocks_close(params: Dict[str, Any]) -> bool:
    """`blockCloseWithOpenTables`: on unless explicitly switched off."""
    value = params.get(BLOCK_CLOSE_KEY)
    return value is not False


def machine_params(db: Session, machine: POSMachine) -> Dict[str, Any]:
    from app.services import till_parameters as TP

    return TP.till_parameters_for_machine(db, machine).parameters


# ── Small helpers ────────────────────────────────────────────────────────────

_CENT = Decimal("0.01")


def _money(value: Any) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)


def _float(value: Any) -> float:
    return float(_money(value))


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def _conflict(code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, **extra})


def _not_found(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=code)


def _bad(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=code)


@dataclass(frozen=True)
class Actor:
    """Who is acting: the till, and the employee signed in at it."""

    machine: POSMachine
    pos_user_id: Optional[str] = None
    pos_user_name: Optional[str] = None


@dataclass(frozen=True)
class Approval:
    """Who approved a cancel or a forced release: a cloud user or a till user."""

    user_id: Optional[uuid.UUID] = None
    pos_user_id: Optional[str] = None
    name: Optional[str] = None


def approver_name(db: Session, user_id: Any = None, pos_user_id: Any = None) -> Optional[str]:
    if pos_user_id is not None:
        pu = db.get(PosUser, _uuid(pos_user_id)) if _uuid(pos_user_id) else None
        if pu is not None:
            full = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
            return full or pu.username
    if user_id is not None:
        user = db.get(User, _uuid(user_id)) if _uuid(user_id) else None
        if user is not None:
            return user.username or user.email
    return None


# ── Visibility ───────────────────────────────────────────────────────────────


def zones_for(db: Session, shop_id: Any, area_id: Any = None, *, all_areas: bool = False) -> List[TableZone]:
    """
    The live zones of a shop a till sees: the shop-wide ones and its own point of
    sale's. `all_areas` (the dashboard) returns every live zone of the shop.
    """
    q = db.query(TableZone).filter(TableZone.shop_id == shop_id, TableZone.archived_at.is_(None))
    if not all_areas:
        if area_id is None:
            q = q.filter(TableZone.area_id.is_(None))
        else:
            q = q.filter(or_(TableZone.area_id.is_(None), TableZone.area_id == area_id))
    return q.order_by(TableZone.sort_order.asc(), TableZone.name.asc()).all()


def tables_in(db: Session, zone_ids: Sequence[uuid.UUID]) -> List[DiningTable]:
    if not zone_ids:
        return []
    return (
        db.query(DiningTable)
        .filter(DiningTable.zone_id.in_(list(zone_ids)), DiningTable.archived_at.is_(None))
        .order_by(DiningTable.number.asc())
        .all()
    )


def table_for_machine(db: Session, machine: POSMachine, table_id: Any) -> DiningTable:
    """A live table this till may work on; 404 `table_not_found` for anything else."""
    ident = _uuid(table_id)
    table = db.get(DiningTable, ident) if ident else None
    if table is None or machine.shop_id is None or table.shop_id != machine.shop_id or table.archived_at is not None:
        raise _not_found("table_not_found")
    zone = db.get(TableZone, table.zone_id)
    if zone is None or zone.archived_at is not None:
        raise _not_found("table_not_found")
    if zone.area_id is not None and zone.area_id != machine.area_id:
        raise _not_found("table_not_found")
    return table


def open_order(db: Session, table_id: Any) -> Optional[TableOrder]:
    """The table's synced open order, if any (at most one, by the partial unique index)."""
    return (
        db.query(TableOrder)
        .filter(TableOrder.table_id == table_id, TableOrder.status == "open", TableOrder.source == "synced")
        .first()
    )


# ── Locks ────────────────────────────────────────────────────────────────────


def lock_live(table: DiningTable, now: datetime) -> bool:
    expires = as_utc(table.lock_expires_at)
    return table.lock_machine_id is not None and expires is not None and expires > now


def try_lock(db: Session, table: DiningTable, actor: Actor, minutes: int, now: datetime) -> bool:
    """
    Take or extend the lock for `actor`'s till. True when it holds the lock afterwards.

    One conditional UPDATE: it succeeds only while the lock is free, expired, or already
    this till's, and the database applies it to one writer at a time — two tills racing
    for a free table cannot both get it.
    """
    expires = now + timedelta(minutes=minutes)
    result = db.execute(
        update(DiningTable)
        .where(
            DiningTable.id == table.id,
            or_(
                DiningTable.lock_machine_id.is_(None),
                DiningTable.lock_machine_id == actor.machine.id,
                DiningTable.lock_expires_at.is_(None),
                DiningTable.lock_expires_at <= now,
            ),
        )
        .values(
            lock_machine_id=actor.machine.id,
            lock_pos_user_id=(actor.pos_user_id or None),
            lock_pos_user_name=(actor.pos_user_name or None),
            lock_acquired_at=now,
            lock_expires_at=expires,
        )
        .execution_options(synchronize_session=False)
    )
    db.refresh(table)
    return result.rowcount == 1


def release_lock(db: Session, table: DiningTable, machine: POSMachine) -> bool:
    """Let go of this till's own lock. Idempotent; never touches another till's."""
    result = db.execute(
        update(DiningTable)
        .where(DiningTable.id == table.id, DiningTable.lock_machine_id == machine.id)
        .values(
            lock_machine_id=None, lock_pos_user_id=None, lock_pos_user_name=None,
            lock_acquired_at=None, lock_expires_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    db.refresh(table)
    return result.rowcount == 1


def clear_lock(db: Session, table: DiningTable) -> None:
    """Release whoever holds it — a manager's forced release."""
    db.execute(
        update(DiningTable)
        .where(DiningTable.id == table.id)
        .values(
            lock_machine_id=None, lock_pos_user_id=None, lock_pos_user_name=None,
            lock_acquired_at=None, lock_expires_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    db.refresh(table)


def lock_out(db: Session, table: DiningTable, now: datetime, viewer: Optional[POSMachine] = None) -> Optional[dict]:
    if not lock_live(table, now):
        return None
    machine = db.get(POSMachine, table.lock_machine_id)
    return {
        "machineId": str(table.lock_machine_id),
        "machineName": machine.name if machine is not None else None,
        "posNumber": machine.pos_number if machine is not None else None,
        "posUserId": table.lock_pos_user_id,
        "posUserName": table.lock_pos_user_name,
        "acquiredAt": _iso(table.lock_acquired_at),
        "expiresAt": _iso(table.lock_expires_at),
        "mine": viewer is not None and table.lock_machine_id == viewer.id,
    }


def _locked(db: Session, table: DiningTable, now: datetime, code: str = "table_locked") -> HTTPException:
    return _conflict(code, table=table_ref(table), lock=lock_out(db, table, now))


def ensure_lock(db: Session, table: DiningTable, actor: Actor, minutes: int, now: datetime, *, code: str = "table_locked") -> None:
    if not try_lock(db, table, actor, minutes, now):
        raise _locked(db, table, now, code)


# ── Shapes ───────────────────────────────────────────────────────────────────


def table_ref(table: DiningTable) -> dict:
    return {"id": str(table.id), "number": table.number, "name": table.name}


def zone_out(zone: TableZone) -> dict:
    return {
        "id": str(zone.id),
        "shopId": str(zone.shop_id),
        "areaId": str(zone.area_id) if zone.area_id else None,
        "name": zone.name,
        "sortOrder": zone.sort_order,
        "layout": zone.layout,
        "backgroundUrl": zone.background_url,
        "canvasWidth": zone.canvas_width,
        "canvasHeight": zone.canvas_height,
        "sketch": zone.sketch if isinstance(zone.sketch, dict) else None,
        "updatedAt": _iso(zone.updated_at),
    }


def table_out(table: DiningTable) -> dict:
    return {
        "id": str(table.id),
        "zoneId": str(table.zone_id),
        "number": table.number,
        "name": table.name,
        "seats": table.seats,
        "shape": table.shape,
        "x": table.x,
        "y": table.y,
        "width": table.width,
        "height": table.height,
        "rotation": table.rotation,
    }


def order_summary(order: TableOrder) -> dict:
    return {
        "id": str(order.id),
        "tableId": str(order.table_id),
        "status": order.status,
        "source": order.source,
        "version": order.version,
        "guests": order.guests,
        "itemCount": float(order.item_count or 0),
        "total": _float(order.total),
        "openedAt": _iso(order.opened_at),
        "openedByPosUserId": order.opened_by_pos_user_id,
        "openedByName": order.opened_by_pos_user_name,
        # The table's waiter: its own, else whoever opened it (orders from before waiters).
        "waiterPosUserId": order.waiter_pos_user_id or order.opened_by_pos_user_id,
        "waiterName": order.waiter_pos_user_name or order.opened_by_pos_user_name,
        "updatedAt": _iso(order.updated_at),
        "sentAt": _iso(order.sent_at),
        "sendCount": order.send_count or 0,
        "billPrintedAt": _iso(order.bill_printed_at),
        "closedAt": _iso(order.closed_at),
        "transactionId": order.transaction_id,
        "transactionNumber": order.transaction_number,
        "payConflict": bool(order.pay_conflict),
        "mergedIntoId": str(order.merged_into_id) if order.merged_into_id else None,
    }


def order_full(order: Optional[TableOrder]) -> Optional[dict]:
    if order is None:
        return None
    out = order_summary(order)
    out["cartJson"] = order.cart_json
    out["extrasJson"] = order.extras_json
    return out


def table_state(order: Optional[TableOrder], lock: Optional[dict]) -> str:
    """free | occupied | sent | awaiting_payment | locked (another till is inside)."""
    if lock is not None and not lock.get("mine"):
        return "locked"
    if order is None:
        return "free"
    if order.bill_printed_at is not None:
        return "awaiting_payment"
    if (order.send_count or 0) > 0:
        return "sent"
    return "occupied"


# ── Reasons ──────────────────────────────────────────────────────────────────


def reasons_for(db: Session, tenant_id: Any, *, include_inactive: bool = False) -> List[TableCancelReason]:
    """The tenant's reasons; the defaults are created the first time there are none."""
    rows = db.query(TableCancelReason).filter(TableCancelReason.tenant_id == tenant_id).all()
    if not rows and tenant_id is not None:
        for i, (name, note) in enumerate(DEFAULT_REASONS):
            db.add(TableCancelReason(id=uuid.uuid4(), tenant_id=tenant_id, name=name, requires_note=note, sort_order=i))
        db.flush()
        rows = db.query(TableCancelReason).filter(TableCancelReason.tenant_id == tenant_id).all()
    if not include_inactive:
        rows = [r for r in rows if r.is_active]
    return sorted(rows, key=lambda r: (r.sort_order or 0, r.name))


def reason_out(reason: TableCancelReason) -> dict:
    return {
        "id": str(reason.id),
        "name": reason.name,
        "requiresNote": bool(reason.requires_note),
        "sortOrder": reason.sort_order,
        "isActive": bool(reason.is_active),
    }


def active_reason(db: Session, tenant_id: Any, reason_id: Any) -> TableCancelReason:
    ident = _uuid(reason_id)
    reason = db.get(TableCancelReason, ident) if ident else None
    if reason is None or reason.tenant_id != tenant_id or not reason.is_active:
        raise _not_found("reason_not_found")
    return reason


# ── Events and notifications ─────────────────────────────────────────────────


def record_event(
    db: Session,
    kind: str,
    table: Optional[DiningTable],
    order: Optional[TableOrder],
    *,
    actor: Optional[Actor] = None,
    user_id: Any = None,
    details: Optional[dict] = None,
    now: Optional[datetime] = None,
) -> None:
    shop_id = order.shop_id if order is not None else (table.shop_id if table is not None else None)
    tenant_id = order.tenant_id if order is not None else (table.tenant_id if table is not None else None)
    if shop_id is None or tenant_id is None:
        return
    db.add(
        TableEvent(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            shop_id=shop_id,
            table_id=(order.table_id if order is not None else table.id),
            order_id=order.id if order is not None else None,
            kind=kind,
            occurred_at=now or _now(),
            machine_id=actor.machine.id if actor is not None else None,
            pos_user_id=actor.pos_user_id if actor is not None else None,
            pos_user_name=actor.pos_user_name if actor is not None else None,
            user_id=_uuid(user_id),
            version=order.version if order is not None else None,
            details=details or None,
        )
    )


NotifyTarget = Tuple[str, str]


def notify_targets(db: Session, shop_id: Any, *, except_machine_id: Any = None) -> List[NotifyTarget]:
    """The shop's active tills, but the one that made the change."""
    if shop_id is None:
        return []
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True))
        .all()
    )
    return [
        (str(m.tenant_id), str(m.id))
        for m in machines
        if m.tenant_id and (except_machine_id is None or str(m.id) != str(except_machine_id))
    ]


def publish_tables_notify(targets: Iterable[NotifyTarget], table_id: Optional[str] = None) -> None:
    """Best effort: a till that misses it sees the change at its next poll."""
    from app.services.ably_notify import _notify_base, publish_notify

    for tenant_id, machine_id in targets:
        body = _notify_base()
        if table_id:
            body["tableId"] = table_id
        try:
            publish_notify(tenant_id, machine_id, NOTIFY_EVENT, body)
        except Exception:  # noqa: BLE001 - a wake-up is never worth failing anything
            logger.exception("tables notify failed for %s", machine_id)


# ── The till's view ──────────────────────────────────────────────────────────


def till_state(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> dict:
    """
    Everything the tables screen draws: the zones and tables this till sees, each with
    its open order's summary and its lock, the cancellation reasons, the lock time.
    """
    now = now or _now()
    params = machine_params(db, machine)
    out: Dict[str, Any] = {
        "serverTime": now.isoformat(),
        "mode": mode_of(params.get(TABLES_MODE_KEY)),
        "lockMinutes": lock_minutes_of(params),
        "blockCloseWithOpenTables": blocks_close(params),
        "zones": [],
        "tables": [],
        "cancelReasons": [reason_out(r) for r in reasons_for(db, machine.tenant_id)] if machine.tenant_id else [],
    }
    if machine.shop_id is None:
        return out
    zones = zones_for(db, machine.shop_id, machine.area_id)
    tables = tables_in(db, [z.id for z in zones])
    orders = {}
    if tables:
        for order in (
            db.query(TableOrder)
            .filter(
                TableOrder.table_id.in_([t.id for t in tables]),
                TableOrder.status == "open",
                TableOrder.source == "synced",
            )
            .all()
        ):
            orders[order.table_id] = order
    out["zones"] = [zone_out(z) for z in zones]
    for table in tables:
        order = orders.get(table.id)
        lock = lock_out(db, table, now, viewer=machine)
        row = table_out(table)
        row["order"] = order_summary(order) if order is not None else None
        row["lock"] = lock
        row["state"] = table_state(order, lock)
        out["tables"].append(row)
    # "הזמנות": the day's bookings still to come (and those due a while ago, not seated yet).
    out["reservations"] = [
        reservation_out(r) for r in upcoming_reservations(db, machine, now, {t.id for t in tables})
    ]
    if out["mode"] == MODE_LAN:
        # Who holds the shop's tables on the LAN, and the secret the tills present to it.
        from app.services.printers import print_secret

        out["lanHost"] = lan_host_block(db, machine)
        out["lanSecret"] = print_secret(machine.shop_id)
    return out


def tables_host_of_shop(db: Session, shop_id: Any) -> Optional[POSMachine]:
    """
    The LAN mode's tables host ("קופה ראשית לשולחנות"): the active till whose
    `tablesHostTill` resolves on — the lowest register number of several, so every till
    agrees on one — else the shop's print server, else none.
    """
    from app.services.printers import print_host_of_shop, shop_machines
    from app.services.till_parameters import till_parameters_for_machine

    if shop_id is None:
        return None
    hosts = [
        m for m in shop_machines(db, shop_id)
        if till_parameters_for_machine(db, m).parameters.get(TABLES_HOST_KEY) is True
    ]
    if not hosts:
        return print_host_of_shop(db, shop_id)

    def order(m: POSMachine):
        number = (m.pos_number or "").strip()
        return (0, int(number), "") if number.isdigit() else (1, 0, number or str(m.id))

    return sorted(hosts, key=order)[0]


def lan_host_block(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """The tables host as `machine` needs it: who, and where on the LAN it last said it listens."""
    from app.models.printers import DEFAULT_LAN_PORT, KitchenPrintHost
    from app.services.printers import machine_label

    host = tables_host_of_shop(db, machine.shop_id)
    if host is None:
        return None
    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == host.id).first()
    return {
        "machineId": str(host.id),
        "name": machine_label(host),
        "posNumber": host.pos_number,
        "isSelf": str(host.id) == str(machine.id),
        "lanAddress": row.lan_address if row is not None else None,
        "port": (row.port if row is not None and row.port else DEFAULT_LAN_PORT),
    }


def _require_synced(db: Session, machine: POSMachine) -> int:
    """The lock time, for a till in the synced mode; 409 `tables_not_synced` otherwise."""
    params = machine_params(db, machine)
    if mode_of(params.get(TABLES_MODE_KEY)) != MODE_SYNCED:
        raise _conflict("tables_not_synced")
    return lock_minutes_of(params)


# ── Writes from a till (synced mode) ─────────────────────────────────────────


def enter(db: Session, actor: Actor, table_id: Any, *, now: Optional[datetime] = None) -> dict:
    """Lock the table for this till and hand back its order (null for a free table)."""
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    ensure_lock(db, table, actor, minutes, now)
    order = open_order(db, table.id)
    return {
        "table": table_out(table),
        "order": order_full(order),
        "lock": lock_out(db, table, now, viewer=actor.machine),
        "lockMinutes": minutes,
        "serverTime": now.isoformat(),
    }


def heartbeat(db: Session, actor: Actor, table_id: Any, *, now: Optional[datetime] = None) -> dict:
    """Still inside: extend the lock. 409 `table_lock_lost` when another till has it now."""
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    ensure_lock(db, table, actor, minutes, now, code="table_lock_lost")
    order = open_order(db, table.id)
    return {
        "lock": lock_out(db, table, now, viewer=actor.machine),
        "version": order.version if order is not None else None,
        "orderId": str(order.id) if order is not None else None,
    }


def _check_version(current: Optional[TableOrder], order_id: Any, expected: Optional[int]) -> None:
    """Refuse a write based on anything but the order as it stands (409, with it)."""
    if current is None:
        if expected:
            raise _conflict("table_version_conflict", order=None)
        return
    if str(current.id) != str(order_id) or expected != current.version:
        raise _conflict("table_version_conflict", order=order_full(current))


def _replayed(db: Session, order_id: Any, request_id: Optional[str]) -> Optional[TableOrder]:
    """The order a retried request already produced, if this request id made it."""
    if not request_id:
        return None
    order = db.get(TableOrder, _uuid(order_id))
    if order is not None and order.last_request_id == request_id:
        return order
    return None


def _touch(order: TableOrder, actor: Actor, now: datetime, request_id: Optional[str]) -> None:
    order.updated_at = now
    order.updated_machine_id = actor.machine.id
    order.updated_by_pos_user_id = actor.pos_user_id
    order.updated_by_pos_user_name = actor.pos_user_name
    order.last_request_id = request_id


def _close(order: TableOrder, status_: str, actor: Actor, now: datetime) -> None:
    order.status = status_
    order.closed_at = now
    order.closed_machine_id = actor.machine.id
    order.closed_by_pos_user_id = actor.pos_user_id
    order.closed_by_pos_user_name = actor.pos_user_name


def save(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    Keep the till's copy of the order (`body`: `TableSaveIn`), and act on `body.action`:
    `send` marks a kitchen send and releases the lock, `bill` marks the bill printed,
    `leave` releases the lock. A table left empty that never sent anything is voided
    (back to free) rather than kept as an empty open order.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    releases = body.action in ("send", "leave")

    replay = _replayed(db, body.order_id, body.request_id)
    if replay is not None:
        if releases:
            release_lock(db, table, actor.machine)
        return {"order": order_full(replay) if replay.status == "open" else order_summary(replay), "replayed": True}

    ensure_lock(db, table, actor, minutes, now)
    current = open_order(db, table.id)
    _check_version(current, body.order_id, body.expected_version)

    empty = (body.item_count or 0) <= 0
    created = False
    if current is None:
        if db.get(TableOrder, body.order_id) is not None:
            # The id of an order that is closed now (paid or cancelled elsewhere).
            raise _conflict("table_version_conflict", order=None)
        if empty and body.action in ("leave", "save"):
            # Opened by mistake and left: nothing to keep.
            if releases:
                release_lock(db, table, actor.machine)
            return {"order": None, "replayed": False}
        current = TableOrder(
            id=body.order_id,
            tenant_id=actor.machine.tenant_id,
            shop_id=table.shop_id,
            table_id=table.id,
            zone_id=table.zone_id,
            table_number=table.number,
            table_name=table.name,
            status="open",
            source="synced",
            version=1,
            opened_at=now,
            opened_machine_id=actor.machine.id,
            opened_by_pos_user_id=actor.pos_user_id,
            opened_by_pos_user_name=actor.pos_user_name,
            # The table is its opener's unless the till names another waiter.
            waiter_pos_user_id=getattr(body, "waiter_pos_user_id", None) or actor.pos_user_id,
            waiter_pos_user_name=getattr(body, "waiter_pos_user_name", None) or actor.pos_user_name,
            send_count=0,
        )
        try:
            with db.begin_nested():
                db.add(current)
                db.flush()
        except IntegrityError:
            raise _conflict("table_version_conflict", order=order_full(open_order(db, table.id)))
        created = True
    else:
        current.version = (current.version or 0) + 1

    # "החלפת מלצר": the till names another waiter for the table.
    new_waiter = getattr(body, "waiter_pos_user_id", None)
    if new_waiter and new_waiter != current.waiter_pos_user_id:
        current.waiter_pos_user_id = new_waiter
        current.waiter_pos_user_name = getattr(body, "waiter_pos_user_name", None)
    changed = (current.cart_json or "") != body.cart_json
    current.cart_json = body.cart_json
    current.extras_json = body.extras_json
    current.guests = body.guests
    current.item_count = Decimal(str(body.item_count or 0))
    current.total = _money(body.total)
    current.zone_id = table.zone_id
    current.table_number = table.number
    current.table_name = table.name
    if changed and body.action != "bill":
        current.bill_printed_at = None
    if body.action == "send":
        current.sent_at = now
        current.send_count = (current.send_count or 0) + 1
    if body.action == "bill":
        current.bill_printed_at = now
    _touch(current, actor, now, body.request_id)

    kind = "open" if created else body.action
    if body.action == "leave" and empty and (current.send_count or 0) == 0:
        _close(current, "void", actor, now)
        kind = "void"
    db.flush()
    record_event(db, kind, table, current, actor=actor, now=now)
    if releases:
        release_lock(db, table, actor.machine)
    return {"order": order_full(current) if current.status == "open" else order_summary(current), "replayed": False}


def pay(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    The till took the money for the order (`TablePayIn`): the order is paid, the table
    free. Never refused for a version: the money has moved, and refusing would leave a
    paid table open. A payment on a version other than the cloud's — possible only when
    the till lost its lock mid-payment — is recorded with `payConflict` for a manager.
    Idempotent by the sale document.
    """
    now = now or _now()
    # No mode check: the money has moved, whatever the till's mode is now.
    table = table_for_machine(db, actor.machine, table_id)

    order = db.get(TableOrder, body.order_id)
    if order is not None and order.status == "paid":
        if order.transaction_id == body.transaction_id:
            release_lock(db, table, actor.machine)
            return {"order": order_summary(order), "conflict": bool(order.pay_conflict), "replayed": True}
        # A second sale for an order already paid: recorded, never silently merged.
        record_event(
            db, "pay_duplicate", table, order, actor=actor, now=now,
            details={"transactionId": body.transaction_id, "transactionNumber": body.transaction_number,
                     "paidTotal": float(_money(body.paid_total))},
        )
        release_lock(db, table, actor.machine)
        return {"order": order_summary(order), "conflict": True, "replayed": False}

    if order is None:
        # Never reached the cloud (the till saves before paying, so this is a gap
        # somewhere): recorded from what the till sends, so the reports have it.
        order = TableOrder(
            id=body.order_id,
            tenant_id=actor.machine.tenant_id,
            shop_id=table.shop_id,
            table_id=table.id,
            zone_id=table.zone_id,
            table_number=table.number,
            table_name=table.name,
            status="paid",
            source="synced",
            version=0,
            opened_at=now,
            opened_machine_id=actor.machine.id,
            opened_by_pos_user_id=actor.pos_user_id,
            opened_by_pos_user_name=actor.pos_user_name,
            cart_json=body.cart_json,
            extras_json=body.extras_json,
            guests=body.guests,
            item_count=Decimal(str(body.item_count or 0)),
            total=_money(body.paid_total),
            send_count=0,
        )
        db.add(order)
        conflict = body.expected_version is not None
    else:
        conflict = order.status != "open" or order.version != body.expected_version
        if not conflict and body.cart_json is not None:
            order.cart_json = body.cart_json
            if body.extras_json is not None:
                order.extras_json = body.extras_json
            order.item_count = Decimal(str(body.item_count or 0))
            if body.guests is not None:
                order.guests = body.guests

    order.version = (order.version or 0) + 1
    _close(order, "paid", actor, now)
    order.transaction_id = body.transaction_id
    order.transaction_number = body.transaction_number
    order.paid_total = _money(body.paid_total)
    order.pay_conflict = bool(conflict)
    _touch(order, actor, now, body.request_id)
    db.flush()
    record_event(
        db, "pay", table, order, actor=actor, now=now,
        details={"transactionId": body.transaction_id, "transactionNumber": body.transaction_number,
                 "paidTotal": float(_money(body.paid_total)), "conflict": bool(conflict)},
    )
    if conflict:
        logger.warning("table %s paid on a stale version (order %s)", table.id, order.id)
    release_lock(db, table, actor.machine)
    return {"order": order_summary(order), "conflict": bool(conflict), "replayed": False}


def _cancelled_items(items: Sequence[Any]) -> List[dict]:
    return [
        {"name": i.name, "quantity": float(i.quantity), "total": float(_money(i.total))}
        for i in items
    ]


def cancel(
    db: Session, actor: Actor, table_id: Any, body, approval: Approval, *, now: Optional[datetime] = None
) -> dict:
    """
    Cancel the table's order with a reason and a manager's approval (`TableCancelIn`).
    Strict on the version: what is cancelled must be what the approver saw.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    reason = active_reason(db, actor.machine.tenant_id, body.reason_id)
    if reason.requires_note and not body.reason_text:
        raise _bad("reason_note_required")

    replay = _replayed(db, body.order_id, body.request_id)
    if replay is not None and replay.status == "cancelled":
        release_lock(db, table, actor.machine)
        return {"order": order_summary(replay), "replayed": True}

    ensure_lock(db, table, actor, minutes, now)
    current = open_order(db, table.id)
    if current is None:
        raise _conflict("table_version_conflict", order=None)
    _check_version(current, body.order_id, body.expected_version)

    current.version = (current.version or 0) + 1
    _close(current, "cancelled", actor, now)
    current.cancel_reason_id = reason.id
    current.cancel_reason_text = body.reason_text
    current.cancel_approved_by_user_id = approval.user_id
    current.cancel_approved_by_pos_user_id = approval.pos_user_id
    current.cancel_approved_by_name = approval.name
    current.cancelled_items = _cancelled_items(body.items) or None
    if body.total:
        current.total = _money(body.total)
    _touch(current, actor, now, body.request_id)
    db.flush()
    record_event(
        db, "cancel", table, current, actor=actor, now=now,
        details={"reason": reason.name, "reasonText": body.reason_text, "approvedBy": approval.name},
    )
    release_lock(db, table, actor.machine)
    record_cancel_exception(db, actor.machine, current, reason_name=reason.name)
    return {"order": order_summary(current), "replayed": False}


def move(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    Move the open order to another, free table ("העבר שולחן"). Both tables are locked for
    the move, so nobody can open the target meanwhile, and both are free afterwards.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    target = table_for_machine(db, actor.machine, body.target_table_id)
    if target.id == table.id:
        raise _bad("move_same_table")

    replay = _replayed(db, body.order_id, body.request_id)
    if replay is not None and replay.table_id == target.id:
        release_lock(db, table, actor.machine)
        release_lock(db, target, actor.machine)
        return {"order": order_full(replay), "replayed": True}

    ensure_lock(db, table, actor, minutes, now)
    current = open_order(db, table.id)
    if current is None:
        raise _conflict("table_version_conflict", order=None)
    _check_version(current, body.order_id, body.expected_version)

    if not try_lock(db, target, actor, minutes, now):
        raise _locked(db, target, now, code="table_target_locked")
    if open_order(db, target.id) is not None:
        release_lock(db, target, actor.machine)
        raise _conflict("table_target_occupied", table=table_ref(target))

    current.table_id = target.id
    current.zone_id = target.zone_id
    current.table_number = target.number
    current.table_name = target.name
    current.version = (current.version or 0) + 1
    _touch(current, actor, now, body.request_id)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        raise _conflict("table_target_occupied", table=table_ref(target))
    record_event(
        db, "move", target, current, actor=actor, now=now,
        details={"fromTableId": str(table.id), "fromNumber": table.number,
                 "toTableId": str(target.id), "toNumber": target.number},
    )
    release_lock(db, table, actor.machine)
    release_lock(db, target, actor.machine)
    return {"order": order_full(current), "replayed": False}


def _partials_of(order: TableOrder) -> List[dict]:
    extras = parse_json_or_none(order.extras_json)
    parts = extras.get("partials") if isinstance(extras, dict) else None
    return [p for p in parts if isinstance(p, dict)] if isinstance(parts, list) else []


def pay_part(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    "פיצול חשבון": a part of the order was paid. Like a payment, never refused — the money
    has moved. At the version the till read: the table becomes the rest it sends. Moved on
    meanwhile (another till edited it): the part is still recorded with the order (its
    `partials`, so the final payment and the reports count it), the order is flagged
    `pay_conflict` for a manager, and the till is told (`conflict`). Idempotent by the sale.
    """
    now = now or _now()
    table = table_for_machine(db, actor.machine, table_id)
    order = db.get(TableOrder, _uuid(body.order_id))
    if order is not None and any(str(p.get("tx")) == body.transaction_id for p in _partials_of(order)):
        return {"order": order_full(order) if order.status == "open" else order_summary(order), "conflict": False, "replayed": True}
    part = {"tx": body.transaction_id, "no": body.transaction_number, "amount": int((Decimal(body.amount) * 100).to_integral_value())}
    if order is None or order.status != "open":
        record_event(db, "part_pay_closed", table, order, actor=actor, now=now, details=part)
        return {"order": order_summary(order) if order is not None else None, "conflict": True, "replayed": False}
    if order.version == body.expected_version:
        order.cart_json = body.cart_json
        order.extras_json = body.extras_json
        order.item_count = Decimal(str(body.item_count or 0))
        order.total = _money(body.total)
        order.bill_printed_at = None
        conflict = False
    else:
        extras = parse_json_or_none(order.extras_json)
        extras = extras if isinstance(extras, dict) else {}
        extras["partials"] = _partials_of(order) + [part]
        order.extras_json = json.dumps(extras, ensure_ascii=False)
        order.pay_conflict = True
        conflict = True
    order.version = (order.version or 0) + 1
    _touch(order, actor, now, body.request_id)
    db.flush()
    record_event(db, "part_pay", table, order, actor=actor, now=now, details={**part, "conflict": conflict})
    return {"order": order_full(order), "conflict": conflict, "replayed": False}


def transfer(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    "העברת פריטים": lines of this table's open order moved to another table — both written
    in one go, or neither. This table is the till's (its lock, its version); the target is
    locked for the write (the till entered it to read it) and checked at the version the
    till read, then let go. A table emptied by it is closed as merged into the target.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    table = table_for_machine(db, actor.machine, table_id)
    target = table_for_machine(db, actor.machine, body.target_table_id)
    if target.id == table.id:
        raise _bad("transfer_same_table")

    replay = _replayed(db, body.order_id, body.request_id)
    if replay is not None:
        release_lock(db, target, actor.machine)
        moved_to = db.get(TableOrder, body.target_order_id)
        return {"order": order_full(replay) if replay.status == "open" else order_summary(replay),
                "target": order_summary(moved_to) if moved_to else None, "replayed": True}

    ensure_lock(db, table, actor, minutes, now)
    current = open_order(db, table.id)
    if current is None:
        raise _conflict("table_version_conflict", order=None)
    _check_version(current, body.order_id, body.expected_version)
    if not try_lock(db, target, actor, minutes, now):
        raise _locked(db, target, now, code="table_target_locked")
    there = open_order(db, target.id)
    try:
        _check_version(there, body.target_order_id, body.target_expected_version)
    except HTTPException:
        release_lock(db, target, actor.machine)
        raise _conflict("table_target_changed", table=table_ref(target), order=order_full(there))

    if there is None:
        if db.get(TableOrder, body.target_order_id) is not None:
            release_lock(db, target, actor.machine)
            raise _conflict("table_target_changed", table=table_ref(target), order=None)
        there = TableOrder(
            id=body.target_order_id, tenant_id=actor.machine.tenant_id, shop_id=target.shop_id,
            table_id=target.id, zone_id=target.zone_id, table_number=target.number, table_name=target.name,
            status="open", source="synced", version=1, opened_at=now, opened_machine_id=actor.machine.id,
            opened_by_pos_user_id=actor.pos_user_id, opened_by_pos_user_name=actor.pos_user_name,
            waiter_pos_user_id=current.waiter_pos_user_id or actor.pos_user_id,
            waiter_pos_user_name=current.waiter_pos_user_name or actor.pos_user_name,
            guests=body.target_guests, send_count=0,
        )
        db.add(there)
    else:
        there.version = (there.version or 0) + 1
        if body.target_guests is not None:
            there.guests = body.target_guests
    there.cart_json = body.target_cart_json
    there.extras_json = body.target_extras_json
    there.item_count = Decimal(str(body.target_item_count or 0))
    there.total = _money(body.target_total)
    there.bill_printed_at = None
    # What moved had been sent: the target's lines are in the kitchen too.
    if (current.send_count or 0) > 0 and (there.send_count or 0) == 0:
        there.send_count = 1
        there.sent_at = current.sent_at
    _touch(there, actor, now, body.request_id)

    current.version = (current.version or 0) + 1
    current.cart_json = body.cart_json
    current.extras_json = body.extras_json
    current.item_count = Decimal(str(body.item_count or 0))
    current.total = _money(body.total)
    current.bill_printed_at = None
    _touch(current, actor, now, body.request_id)
    if (body.item_count or 0) <= 0:
        # Everything moved: this table's order goes on in the target's.
        _close(current, "merged", actor, now)
        current.merged_into_id = there.id
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        release_lock(db, target, actor.machine)
        raise _conflict("table_target_changed", table=table_ref(target), order=None)
    details = {"fromTableId": str(table.id), "fromNumber": table.number, "toTableId": str(target.id), "toNumber": target.number}
    record_event(db, "transfer", table, current, actor=actor, now=now, details=details)
    record_event(db, "transfer", target, there, actor=actor, now=now, details=details)
    release_lock(db, target, actor.machine)
    if current.status != "open":
        release_lock(db, table, actor.machine)
    return {
        "order": order_full(current) if current.status == "open" else order_summary(current),
        "target": order_summary(there),
        "replayed": False,
    }


def release(
    db: Session, actor: Actor, table_id: Any, *, force: bool = False, approval: Optional[Approval] = None,
    now: Optional[datetime] = None,
) -> dict:
    """
    Leave without saving (own lock), or a manager's forced release of anyone's. No mode
    check: a till switched out of the synced mode must still be able to let go.
    """
    now = now or _now()
    table = table_for_machine(db, actor.machine, table_id)
    if force:
        holder = lock_out(db, table, now)
        clear_lock(db, table)
        record_event(
            db, "force_release", table, open_order(db, table.id), actor=actor, now=now,
            user_id=approval.user_id if approval else None,
            details={"heldBy": holder, "approvedBy": approval.name if approval else None},
        )
        return {"released": True}
    return {"released": release_lock(db, table, actor.machine)}


# ── Merge ("איחוד שולחנות") and rename ──────────────────────────────────────


def _distinct_tables(db: Session, machine: POSMachine, target: DiningTable, ids: Sequence[Any]) -> List[DiningTable]:
    seen = {target.id}
    out = []
    for ident in ids:
        table = table_for_machine(db, machine, ident)
        if table.id in seen:
            raise _bad("merge_duplicate_table")
        seen.add(table.id)
        out.append(table)
    return out


def merge_prepare(db: Session, actor: Actor, table_id: Any, source_ids: Sequence[Any], *, now: Optional[datetime] = None) -> dict:
    """
    Lock the target and every source for a merge — all of them or none — and hand back
    their orders, from which the till builds the merged one. 409 `table_locked` names
    every table another till holds, and who; 409 `table_order_not_open` the sources with
    nothing to merge.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    target = table_for_machine(db, actor.machine, table_id)
    sources = _distinct_tables(db, actor.machine, target, source_ids)

    taken: List[DiningTable] = []
    refused = []
    for table in [target, *sources]:
        was_mine = lock_live(table, now) and table.lock_machine_id == actor.machine.id
        if try_lock(db, table, actor, minutes, now):
            if not was_mine:
                taken.append(table)
        else:
            refused.append({"table": table_ref(table), "lock": lock_out(db, table, now)})

    def undo() -> None:
        for table in taken:
            release_lock(db, table, actor.machine)

    if refused:
        undo()
        raise _conflict("table_locked", tables=refused, table=refused[0]["table"], lock=refused[0]["lock"])
    missing = [table_ref(t) for t in sources if open_order(db, t.id) is None]
    if missing:
        undo()
        raise _conflict("table_order_not_open", tables=missing)
    return {
        "target": {"table": table_out(target), "order": order_full(open_order(db, target.id))},
        "sources": [{"table": table_out(t), "order": order_full(open_order(db, t.id))} for t in sources],
        "lockMinutes": minutes,
        "serverTime": now.isoformat(),
    }


def merge(db: Session, actor: Actor, table_id: Any, body, *, now: Optional[datetime] = None) -> dict:
    """
    Merge the sources' orders into the target's (`TableMergeIn`): the target takes the
    merged cart the till built, the sources' orders are closed as `merged` into it and
    their tables are free. Every table must be this till's (locked by `merge_prepare`)
    and every order at the version the till read; anything else is refused whole (409),
    and nothing changes. What the kitchen was sent stays sent: the till carries it over.
    """
    now = now or _now()
    minutes = _require_synced(db, actor.machine)
    target = table_for_machine(db, actor.machine, table_id)
    pairs = list(zip(_distinct_tables(db, actor.machine, target, [s.table_id for s in body.sources]), body.sources))
    tables = [target, *[t for t, _ in pairs]]

    replay = _replayed(db, body.order_id, body.request_id)
    if replay is not None and replay.status == "open" and replay.table_id == target.id:
        for table in tables:
            release_lock(db, table, actor.machine)
        return {"order": order_full(replay), "replayed": True}

    for table in tables:
        ensure_lock(db, table, actor, minutes, now)
    current = open_order(db, target.id)
    _check_version(current, body.order_id, body.expected_version)
    source_orders: List[Tuple[DiningTable, TableOrder]] = []
    for table, src in pairs:
        order = open_order(db, table.id)
        if order is None or order.id != src.order_id or order.version != src.expected_version:
            raise _conflict("table_version_conflict", table=table_ref(table), order=order_full(order))
        source_orders.append((table, order))

    earliest = min(source_orders, key=lambda p: as_utc(p[1].opened_at) or now)[1]
    if current is None:
        if db.get(TableOrder, body.order_id) is not None:
            raise _conflict("table_version_conflict", table=table_ref(target), order=None)
        current = TableOrder(
            id=body.order_id,
            tenant_id=actor.machine.tenant_id,
            shop_id=target.shop_id,
            table_id=target.id,
            status="open",
            source="synced",
            version=1,
            opened_at=as_utc(earliest.opened_at) or now,
            opened_machine_id=earliest.opened_machine_id,
            opened_by_pos_user_id=earliest.opened_by_pos_user_id,
            opened_by_pos_user_name=earliest.opened_by_pos_user_name,
            send_count=0,
        )
        try:
            with db.begin_nested():
                db.add(current)
                db.flush()
        except IntegrityError:
            raise _conflict("table_version_conflict", table=table_ref(target), order=order_full(open_order(db, target.id)))
    else:
        current.version = (current.version or 0) + 1
        opened = as_utc(earliest.opened_at)
        if opened is not None and (as_utc(current.opened_at) is None or opened < as_utc(current.opened_at)):
            # The guests at the table that sat first have been seated since then.
            current.opened_at = opened

    current.zone_id = target.zone_id
    current.table_number = target.number
    current.table_name = target.name
    current.cart_json = body.cart_json
    current.extras_json = body.extras_json
    current.guests = body.guests
    current.item_count = Decimal(str(body.item_count or 0))
    current.total = _money(body.total)
    every = [current, *[o for _, o in source_orders]]
    current.send_count = max((o.send_count or 0) for o in every)
    sent = [as_utc(o.sent_at) for o in every if o.sent_at is not None]
    current.sent_at = max(sent) if sent else None
    # A bill printed before is not the bill of the merged table.
    current.bill_printed_at = None
    _touch(current, actor, now, body.request_id)

    for table, order in source_orders:
        order.version = (order.version or 0) + 1
        _close(order, "merged", actor, now)
        order.merged_into_id = current.id
        order.updated_at = now
        record_event(
            db, "merged", table, order, actor=actor, now=now,
            details={"intoOrderId": str(current.id), "intoTableId": str(target.id), "intoNumber": target.number},
        )
    db.flush()
    record_event(
        db, "merge", target, current, actor=actor, now=now,
        details={
            "sources": [
                {"tableId": str(t.id), "number": t.number, "orderId": str(o.id),
                 "total": _float(o.total), "guests": o.guests}
                for t, o in source_orders
            ],
        },
    )
    for table in tables:
        release_lock(db, table, actor.machine)
    return {"order": order_full(current), "replayed": False}


def rename(db: Session, actor: Actor, table_id: Any, name: Optional[str], *, now: Optional[datetime] = None) -> dict:
    """A table's name ("VIP 1"), from a till — the layout is the cloud's, so online only."""
    now = now or _now()
    table = table_for_machine(db, actor.machine, table_id)
    previous = table.name
    table.name = name
    table.updated_at = now
    order = open_order(db, table.id)
    if order is not None:
        order.table_name = name
    db.flush()
    record_event(db, "rename", table, order, actor=actor, now=now, details={"from": previous, "to": name})
    return table_out(table)


# ── Exceptions ("חריגות") ────────────────────────────────────────────────────


def record_cancel_exception(db: Session, machine: POSMachine, order: TableOrder, *, reason_name: Optional[str]) -> None:
    """
    Report a cancelled table to the exceptions module, as a till event of type
    `table_cancelled` (idempotent: one event per order). Never fails the cancel.
    """
    try:
        from app.models.audit_exception import TillEvent
        from app.services import exceptions as EX

        if EXCEPTION_TYPE not in getattr(EX, "RULES_BY_TYPE", {}):
            return
        event_id = uuid.uuid5(_EVENT_NAMESPACE, f"{EXCEPTION_TYPE}:{order.id}")
        event = db.get(TillEvent, event_id)
        items = order.cancelled_items or []
        opened, closed = as_utc(order.opened_at), as_utc(order.closed_at)
        open_minutes = (
            int((closed - opened).total_seconds() // 60) if opened is not None and closed is not None and closed >= opened
            else None
        )
        if event is None:
            event = TillEvent(
                id=event_id,
                tenant_id=machine.tenant_id,
                machine_id=machine.id,
                shop_id=machine.shop_id,
                area_id=machine.area_id,
                shift_id=None,
                event_type=EXCEPTION_TYPE,
                occurred_at=as_utc(order.closed_at) or _now(),
                pos_user_id=order.closed_by_pos_user_id,
                amount=_money(order.total),
                transaction_id=None,
                details={
                    "source": "tables",
                    "orderId": str(order.id),
                    "tableNumber": order.table_number,
                    "tableName": order.table_name,
                    "reason": reason_name,
                    "reasonText": order.cancel_reason_text,
                    "approvedBy": order.cancel_approved_by_name,
                    "cancelledBy": order.closed_by_pos_user_name,
                    "items": items,
                    "lineCount": len(items),
                    "guests": order.guests,
                    "total": _float(order.total),
                    "openedAt": _iso(order.opened_at),
                    "closedAt": _iso(order.closed_at),
                    "openMinutes": open_minutes,
                },
                received_at=_now(),
            )
            with db.begin_nested():
                db.add(event)
                db.flush()
        EX.Detector(db).event(event)
    except Exception:  # noqa: BLE001 - an exception missed is found by a rescan
        logger.exception("could not report cancelled table %s to the exceptions", order.id)


# ── Single-till reporting ────────────────────────────────────────────────────


def apply_local_report(db: Session, machine: POSMachine, orders: Sequence[Any]) -> dict:
    """
    Store the orders a single-till ("קופה אחת") till reports, for the dashboard. Upsert
    by id, newest version wins; an order of another shop's table is skipped.
    """
    accepted: List[str] = []
    skipped: List[str] = []
    reasons: Dict[Any, Optional[str]] = {}
    for item in orders:
        table = db.get(DiningTable, item.table_id)
        if table is None or machine.shop_id is None or table.shop_id != machine.shop_id:
            skipped.append(str(item.id))
            continue
        row = db.get(TableOrder, item.id)
        if row is not None and (row.source != "local" or row.shop_id != machine.shop_id):
            skipped.append(str(item.id))
            continue
        if row is not None and (row.version or 0) >= item.version:
            accepted.append(str(item.id))
            continue
        newly_cancelled = item.status == "cancelled" and (row is None or row.status != "cancelled")
        if row is None:
            row = TableOrder(
                id=item.id,
                tenant_id=machine.tenant_id,
                shop_id=table.shop_id,
                source="local",
                opened_machine_id=machine.id,
            )
            db.add(row)
        row.table_id = table.id
        row.zone_id = table.zone_id
        row.table_number = table.number
        row.table_name = table.name
        row.status = item.status
        row.version = item.version
        row.guests = item.guests
        row.item_count = Decimal(str(item.item_count or 0))
        row.total = _money(item.total)
        row.opened_at = as_utc(item.opened_at)
        row.opened_by_pos_user_id = item.opened_by_pos_user_id
        row.opened_by_pos_user_name = item.opened_by_pos_user_name
        row.waiter_pos_user_id = item.waiter_pos_user_id or item.opened_by_pos_user_id
        row.waiter_pos_user_name = item.waiter_pos_user_name or item.opened_by_pos_user_name
        row.updated_at = as_utc(item.updated_at) or _now()
        row.updated_machine_id = machine.id
        row.sent_at = as_utc(item.sent_at)
        row.send_count = item.send_count or 0
        row.bill_printed_at = as_utc(item.bill_printed_at)
        row.closed_at = as_utc(item.closed_at)
        row.closed_machine_id = machine.id if item.closed_at else None
        row.closed_by_pos_user_id = item.closed_by_pos_user_id
        row.closed_by_pos_user_name = item.closed_by_pos_user_name
        row.transaction_id = item.transaction_id
        row.transaction_number = item.transaction_number
        row.paid_total = _money(item.paid_total) if item.paid_total is not None else None
        row.cancel_reason_id = item.cancel_reason_id
        row.cancel_reason_text = item.cancel_reason_text
        row.cancel_approved_by_pos_user_id = item.cancel_approved_by_pos_user_id
        row.cancel_approved_by_name = item.cancel_approved_by_name
        row.cancelled_items = _cancelled_items(item.cancelled_items or []) or None
        row.merged_into_id = item.merged_into_id
        if item.extras_json is not None:
            row.extras_json = item.extras_json
        db.flush()
        if newly_cancelled:
            if item.cancel_reason_id not in reasons:
                reason = db.get(TableCancelReason, item.cancel_reason_id) if item.cancel_reason_id else None
                reasons[item.cancel_reason_id] = reason.name if reason is not None else None
            record_cancel_exception(db, machine, row, reason_name=reasons[item.cancel_reason_id])
        accepted.append(str(item.id))
    return {"accepted": accepted, "skipped": skipped}


# ── The close of the day ─────────────────────────────────────────────────────


def open_tables_blocking(db: Session, shop: Shop, area_id: Any = None) -> List[dict]:
    """
    The synced open tables that hold a Z of `shop` (of one of its points of sale with
    `area_id`: that area's zones and the shop-wide ones) under `blockCloseWithOpenTables`.
    Empty when the parameter is off for the shop or nothing is open.
    """
    from app.services import till_parameters as TP

    if not blocks_close(TP.resolve_for_shop(db, shop)):
        return []
    rows = (
        db.query(TableOrder, DiningTable, TableZone)
        .join(DiningTable, DiningTable.id == TableOrder.table_id)
        .join(TableZone, TableZone.id == DiningTable.zone_id)
        .filter(
            TableOrder.shop_id == shop.id,
            TableOrder.status == "open",
            TableOrder.source == "synced",
        )
        .all()
    )
    out = []
    for order, table, zone in rows:
        if area_id is not None and zone.area_id is not None and str(zone.area_id) != str(area_id):
            continue
        out.append({
            "tableId": str(table.id),
            "number": table.number,
            "name": table.name,
            "zoneName": zone.name,
            "total": _float(order.total),
            "openedAt": _iso(order.opened_at),
        })
    return sorted(out, key=lambda t: t["number"])


def refuse_z_with_open_tables(db: Session, shop: Shop, area_id: Any = None) -> None:
    """409 `{code: open_tables_block_z, tables}` while `open_tables_blocking` lists any."""
    tables = open_tables_blocking(db, shop, area_id)
    if tables:
        raise _conflict("open_tables_block_z", tables=tables)


# ── Dashboard: layout ────────────────────────────────────────────────────────


def _live_zone(db: Session, zone_id: Any, tenant_id: Any) -> TableZone:
    ident = _uuid(zone_id)
    zone = db.get(TableZone, ident) if ident else None
    if zone is None or zone.tenant_id != tenant_id or zone.archived_at is not None:
        raise _not_found("zone_not_found")
    return zone


def _live_table(db: Session, table_id: Any, tenant_id: Any) -> DiningTable:
    ident = _uuid(table_id)
    table = db.get(DiningTable, ident) if ident else None
    if table is None or table.tenant_id != tenant_id or table.archived_at is not None:
        raise _not_found("table_not_found")
    return table


def _check_area(db: Session, shop: Shop, area_id: Any) -> Optional[uuid.UUID]:
    if area_id is None:
        return None
    from app.services.areas import area_in_shop, refuse_archived

    area = area_in_shop(db, area_id, shop.id)
    refuse_archived(area)
    return area.id


def _number_taken(db: Session, shop_id: Any, number: int, *, except_id: Any = None) -> bool:
    q = db.query(DiningTable.id).filter(
        DiningTable.shop_id == shop_id, DiningTable.number == number, DiningTable.archived_at.is_(None)
    )
    if except_id is not None:
        q = q.filter(DiningTable.id != except_id)
    return q.first() is not None


def layout(db: Session, shop: Shop) -> dict:
    zones = zones_for(db, shop.id, all_areas=True)
    tables = tables_in(db, [z.id for z in zones])
    area_names = {
        a.id: a.name for a in db.query(ShopArea).filter(ShopArea.shop_id == shop.id).all()
    }
    zone_rows = []
    for z in zones:
        row = zone_out(z)
        row["areaName"] = area_names.get(z.area_id) if z.area_id else None
        zone_rows.append(row)
    return {"shopId": str(shop.id), "zones": zone_rows, "tables": [table_out(t) for t in tables]}


def create_zone(db: Session, shop: Shop, body) -> TableZone:
    area_id = _check_area(db, shop, body.area_id)
    sort_order = body.sort_order
    if sort_order is None:
        sort_order = len(zones_for(db, shop.id, all_areas=True))
    zone = TableZone(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        area_id=area_id,
        name=body.name,
        layout=body.layout,
        background_url=(body.background_url or None),
        canvas_width=body.canvas_width,
        canvas_height=body.canvas_height,
        sort_order=sort_order,
        sketch=sketch_json(body.sketch),
    )
    db.add(zone)
    db.flush()
    return zone


def sketch_json(sketch: Any) -> Optional[dict]:
    """The stored form of a `SketchIn` (or None): plain JSON, keys as the till reads them."""
    if sketch is None:
        return None
    def element(e) -> dict:
        out = {
            "id": e.id, "kind": e.kind, "x": e.x, "y": e.y, "w": e.w, "h": e.h,
            "rotation": e.rotation, "text": e.text,
        }
        if e.kind == "counter":
            out["variant"] = e.variant or "straight"
            out["stools"] = e.stools
        if e.points:
            out["points"] = e.points
        if e.color:
            out["color"] = e.color.lower()
        if e.stroke is not None:
            out["stroke"] = e.stroke
        if e.filled is not None:
            out["filled"] = e.filled
        return out

    return {
        "template": sketch.template,
        "background": sketch.background,
        "elements": [element(e) for e in sketch.elements],
    }


def update_zone(db: Session, shop: Shop, zone: TableZone, body) -> TableZone:
    fields = body.model_fields_set
    if "area_id" in fields:
        zone.area_id = _check_area(db, shop, body.area_id)
    if body.name is not None:
        zone.name = body.name
    if body.layout is not None:
        zone.layout = body.layout
    if "background_url" in fields:
        zone.background_url = (body.background_url or "").strip() or None
    if body.canvas_width is not None:
        zone.canvas_width = body.canvas_width
    if body.canvas_height is not None:
        zone.canvas_height = body.canvas_height
    if body.sort_order is not None:
        zone.sort_order = body.sort_order
    if "sketch" in fields:
        zone.sketch = sketch_json(body.sketch)
    zone.updated_at = _now()
    db.flush()
    return zone


def _refuse_open(db: Session, tables: Sequence[DiningTable]) -> None:
    """
    Never remove a table someone is eating at: an open order of any mode — synced, or one a
    single till or the LAN host reported. Removed, the table would vanish from the tills'
    layout with its order still open there, unreachable until the table came back.
    """
    for table in tables:
        if open_order(db, table.id) is not None or (
            db.query(TableOrder.id)
            .filter(TableOrder.table_id == table.id, TableOrder.status == "open")
            .first()
            is not None
        ):
            raise _conflict("table_has_open_order", table=table_ref(table))


def archive_zone(db: Session, zone: TableZone) -> None:
    """With its tables. Refused (409) while any of them has an open order."""
    tables = tables_in(db, [zone.id])
    _refuse_open(db, tables)
    now = _now()
    for table in tables:
        table.archived_at = now
        clear_lock(db, table)
    zone.archived_at = now
    db.flush()


def default_table_size(zone: TableZone, shape: str) -> Tuple[float, float]:
    """A new table's size: about 12% of the canvas's shorter side; a rectangle is longer."""
    side = float(max(40, round(min(zone.canvas_width, zone.canvas_height) * 0.12)))
    if shape == "rect":
        return round(side * 1.5), round(side * 0.8)
    return side, side


def _next_slot(zone: TableZone, index: int, width: float, height: float) -> Tuple[float, float]:
    """Where the `index`-th table of a zone goes by default: rows across the canvas."""
    gap = 20.0
    per_row = max(1, int((zone.canvas_width - gap) // (width + gap)))
    row, col = divmod(index, per_row)
    x = gap + col * (width + gap)
    y = gap + row * (height + gap)
    return min(x, max(zone.canvas_width - width, 0)), min(y, max(zone.canvas_height - height, 0))


#: The zone a till's tables opened by number land in when they are on no map.
ADHOC_ZONE_NAME = "שולחנות מזדמנים"


def adhoc_table(db: Session, machine: POSMachine, number: int) -> dict:
    """
    "פתיחת שולחן לפי מספר": a waiter keys a table number. The table of that number the till
    sees, if there is one; otherwise one is made — in the zone "שולחנות מזדמנים" of the till's
    point of sale (made too, the first time; a plain grid) — and from then on it is a table
    like any other: every till sees it, and the dashboard can move, rename or remove it.
    409 `table_number_elsewhere` for a number another point of sale's map holds.
    """
    if machine.shop_id is None:
        raise _not_found("table_not_found")
    zones = zones_for(db, machine.shop_id, machine.area_id)
    existing = (
        db.query(DiningTable)
        .filter(DiningTable.shop_id == machine.shop_id, DiningTable.number == number, DiningTable.archived_at.is_(None))
        .first()
    )
    if existing is not None:
        if existing.zone_id not in {z.id for z in zones}:
            raise _conflict("table_number_elsewhere", number=number)
        return {"table": table_out(existing), "created": False}
    zone = next(
        (z for z in zones if z.name == ADHOC_ZONE_NAME and str(z.area_id or "") == str(machine.area_id or "")),
        None,
    )
    if zone is None:
        zone = TableZone(
            id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, area_id=machine.area_id,
            name=ADHOC_ZONE_NAME, layout="grid", canvas_width=1000, canvas_height=700,
            sort_order=len(zones_for(db, machine.shop_id, all_areas=True)),
        )
        db.add(zone)
        db.flush()
    width, height = default_table_size(zone, "square")
    x, y = _next_slot(zone, len(tables_in(db, [zone.id])), width, height)
    table = DiningTable(
        id=uuid.uuid4(), tenant_id=zone.tenant_id, shop_id=zone.shop_id, zone_id=zone.id, number=number,
        seats=4, shape="square", x=x, y=y, width=width, height=height, rotation=0,
    )
    try:
        with db.begin_nested():
            db.add(table)
            db.flush()
    except IntegrityError:
        raise _conflict("table_number_taken", number=number)
    return {"table": table_out(table), "created": True}


def create_table(db: Session, zone: TableZone, body) -> DiningTable:
    if _number_taken(db, zone.shop_id, body.number):
        raise _conflict("table_number_taken", number=body.number)
    x, y = body.x, body.y
    if x is None or y is None:
        x, y = _next_slot(zone, len(tables_in(db, [zone.id])), body.width, body.height)
    table = DiningTable(
        id=uuid.uuid4(),
        tenant_id=zone.tenant_id,
        shop_id=zone.shop_id,
        zone_id=zone.id,
        number=body.number,
        name=body.name,
        seats=body.seats,
        shape=body.shape,
        x=x,
        y=y,
        width=body.width,
        height=body.height,
        rotation=body.rotation,
    )
    try:
        with db.begin_nested():
            db.add(table)
            db.flush()
    except IntegrityError:
        raise _conflict("table_number_taken", number=body.number)
    return table


def bulk_create(db: Session, zone: TableZone, body) -> dict:
    """Tables `from`..`to` in this zone; numbers already live in the shop are skipped."""
    low, high = sorted((body.from_number, body.to_number))
    if high - low >= 500:
        raise _bad("bulk_too_many")
    taken = {
        n for (n,) in db.query(DiningTable.number).filter(
            DiningTable.shop_id == zone.shop_id, DiningTable.archived_at.is_(None),
            DiningTable.number >= low, DiningTable.number <= high,
        ).all()
    }
    width, height = default_table_size(zone, body.shape)
    index = len(tables_in(db, [zone.id]))
    created, skipped = [], []
    for number in range(low, high + 1):
        if number in taken:
            skipped.append(number)
            continue
        x, y = _next_slot(zone, index, width, height)
        index += 1
        table = DiningTable(
            id=uuid.uuid4(), tenant_id=zone.tenant_id, shop_id=zone.shop_id, zone_id=zone.id,
            number=number, seats=body.seats, shape=body.shape, x=x, y=y, width=width, height=height,
        )
        db.add(table)
        created.append(number)
    db.flush()
    return {"created": created, "skipped": skipped}


def update_table(db: Session, table: DiningTable, body, tenant_id: Any) -> DiningTable:
    fields = body.model_fields_set
    if body.zone_id is not None and body.zone_id != table.zone_id:
        zone = _live_zone(db, body.zone_id, tenant_id)
        if zone.shop_id != table.shop_id:
            raise _bad("zone_not_in_shop")
        table.zone_id = zone.id
    if body.number is not None and body.number != table.number:
        if _number_taken(db, table.shop_id, body.number, except_id=table.id):
            raise _conflict("table_number_taken", number=body.number)
        table.number = body.number
    if "name" in fields:
        table.name = body.name
    for attr in ("seats", "shape", "x", "y", "width", "height", "rotation"):
        value = getattr(body, attr)
        if value is not None:
            setattr(table, attr, value)
    table.updated_at = _now()
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        raise _conflict("table_number_taken", number=table.number)
    # Keep the open order's snapshot in step, so the till and the live view agree.
    order = open_order(db, table.id)
    if order is not None:
        order.table_number = table.number
        order.table_name = table.name
        order.zone_id = table.zone_id
        db.flush()
    return table


def set_positions(db: Session, zone: TableZone, items: Sequence[Any]) -> int:
    """The map editor's save: every table's place in one write. Others' tables: 400."""
    by_id = {t.id: t for t in tables_in(db, [zone.id])}
    for item in items:
        table = by_id.get(item.id)
        if table is None:
            raise _bad(f"table_not_in_zone:{item.id}")
    for item in items:
        table = by_id[item.id]
        table.x = min(item.x, float(zone.canvas_width))
        table.y = min(item.y, float(zone.canvas_height))
        if item.width is not None:
            table.width = item.width
        if item.height is not None:
            table.height = item.height
        if item.rotation is not None:
            table.rotation = item.rotation
        table.updated_at = _now()
    db.flush()
    return len(items)


def archive_table(db: Session, table: DiningTable) -> None:
    _refuse_open(db, [table])
    table.archived_at = _now()
    clear_lock(db, table)
    db.flush()


# ── The till's edit mode ─────────────────────────────────────────────────────

#: A table "moved" by less than this (canvas units) has not moved: rounding on the till.
_MOVE_EPSILON = 0.5


def table_in_use(db: Session, table: DiningTable, now: datetime) -> bool:
    """
    Someone is at the table: an open synced order, a till inside it (a live lock), or an
    open order a single till reported for it.
    """
    if lock_live(table, now) or open_order(db, table.id) is not None:
        return True
    return (
        db.query(TableOrder.id)
        .filter(TableOrder.table_id == table.id, TableOrder.status == "open", TableOrder.source == "local")
        .first()
        is not None
    )


def _merged_sketch(zone: TableZone, background: str) -> dict:
    """The zone's sketch with another floor: its drawn shapes (and anything else in it) kept."""
    sketch = dict(zone.sketch) if isinstance(zone.sketch, dict) else {"template": None, "elements": []}
    sketch.setdefault("elements", [])
    sketch["background"] = background
    return sketch


def apply_till_layout(db: Session, machine: POSMachine, body, *, now: Optional[datetime] = None) -> dict:
    """
    "שמור" in a till's edit mode: zones and tables added, changed and removed — all of it,
    or (on any refusal) none of it. Only the zones and tables this till sees. Refused:
    a table someone is at that would move, change its number or go (409 `table_in_use`);
    a number another live table of the shop has once the batch is applied (409
    `table_number_taken`); a zone removed with tables still in it (409 `zone_not_empty`).
    A new zone belongs to the till's point of sale. Answers the till's new state.
    """
    if machine.shop_id is None:
        raise _not_found("zone_not_found")
    now = now or _now()
    shop = db.get(Shop, machine.shop_id)
    visible = {z.id: z for z in zones_for(db, shop.id, machine.area_id)}

    # 1. Zones created or edited. Removing one waits for its tables (step 3).
    created: Dict[str, TableZone] = {}
    for item in body.zones:
        fields = item.model_fields_set
        if item.id is None:
            if item.archive:
                continue
            if not item.name:
                raise _bad("zone_name_required")
            if not item.client_id or item.client_id in created:
                raise _bad("zone_client_id_required")
            zone = TableZone(
                id=uuid.uuid4(),
                tenant_id=shop.tenant_id,
                shop_id=shop.id,
                area_id=machine.area_id,
                name=item.name,
                layout=item.layout or "map",
                canvas_width=item.canvas_width or 1000,
                canvas_height=item.canvas_height or 700,
                sort_order=len(visible) + len(created),
                sketch={"template": None, "background": item.background, "elements": []} if item.background else None,
            )
            db.add(zone)
            created[item.client_id] = zone
            continue
        zone = visible.get(item.id)
        if zone is None:
            raise _not_found("zone_not_found")
        if "name" in fields:
            if not item.name:
                raise _bad("zone_name_required")
            zone.name = item.name
        if item.layout is not None:
            zone.layout = item.layout
        if item.background is not None:
            zone.sketch = _merged_sketch(zone, item.background)
        if item.canvas_width is not None:
            zone.canvas_width = item.canvas_width
        if item.canvas_height is not None:
            zone.canvas_height = item.canvas_height
        zone.updated_at = now
    db.flush()

    def zone_for(item) -> TableZone:
        if item.zone_client_id is not None:
            zone = created.get(item.zone_client_id)
        elif item.zone_id is not None:
            zone = visible.get(item.zone_id)
        else:
            raise _bad("table_zone_required")
        if zone is None:
            raise _not_found("zone_not_found")
        return zone

    # 2. Tables. Numbers are checked over the whole shop once everything is in place, and
    # written in two steps, so two tables may swap their numbers in one batch.
    renumbered: List[Tuple[DiningTable, int]] = []
    new_tables: List[Tuple[DiningTable, int]] = []
    for item in body.tables:
        fields = item.model_fields_set
        if item.id is None:
            if item.archive:
                continue
            if item.number is None:
                raise _bad("table_number_required")
            zone = zone_for(item)
            shape = item.shape or "round"
            width, height = default_table_size(zone, shape)
            width = item.width if item.width is not None else width
            height = item.height if item.height is not None else height
            x, y = item.x, item.y
            if x is None or y is None:
                x, y = _next_slot(zone, len(tables_in(db, [zone.id])) + len(new_tables), width, height)
            table = DiningTable(
                id=uuid.uuid4(), tenant_id=zone.tenant_id, shop_id=zone.shop_id, zone_id=zone.id,
                number=0, name=item.name, seats=item.seats if item.seats is not None else 4, shape=shape,
                x=min(x, float(zone.canvas_width)), y=min(y, float(zone.canvas_height)),
                width=width, height=height, rotation=item.rotation or 0,
            )
            new_tables.append((table, item.number))
            continue
        table = table_for_machine(db, machine, item.id)
        target_zone = zone_for(item) if (item.zone_id is not None or item.zone_client_id is not None) else None
        moving = (
            (target_zone is not None and target_zone.id != table.zone_id)
            or (item.x is not None and abs(item.x - table.x) > _MOVE_EPSILON)
            or (item.y is not None and abs(item.y - table.y) > _MOVE_EPSILON)
        )
        renumbering = item.number is not None and item.number != table.number
        if (item.archive or moving or renumbering) and table_in_use(db, table, now):
            raise _conflict("table_in_use", table=table_ref(table))
        if item.archive:
            table.archived_at = now
            clear_lock(db, table)
            continue
        if target_zone is not None:
            table.zone_id = target_zone.id
        zone = target_zone or visible.get(table.zone_id) or db.get(TableZone, table.zone_id)
        if renumbering:
            renumbered.append((table, item.number))
        if "name" in fields:
            table.name = item.name
        for attr in ("seats", "shape", "width", "height", "rotation"):
            value = getattr(item, attr)
            if value is not None:
                setattr(table, attr, value)
        if item.x is not None:
            table.x = min(item.x, float(zone.canvas_width))
        if item.y is not None:
            table.y = min(item.y, float(zone.canvas_height))
        table.updated_at = now
    db.flush()

    # Every live number of the shop once the batch is applied: no two the same.
    final: Dict[uuid.UUID, int] = {
        tid: number
        for tid, number in db.query(DiningTable.id, DiningTable.number).filter(
            DiningTable.shop_id == shop.id, DiningTable.archived_at.is_(None)
        ).all()
    }
    for table, number in renumbered:
        final[table.id] = number
    seen: Dict[int, uuid.UUID] = {}
    for tid, number in final.items():
        if number in seen:
            raise _conflict("table_number_taken", number=number)
        seen[number] = tid
    for table, number in new_tables:
        if number in seen:
            raise _conflict("table_number_taken", number=number)
        seen[number] = table.id
    for k, (table, _) in enumerate(renumbered):
        table.number = -(k + 1)
    db.flush()
    for table, number in renumbered:
        table.number = number
    for table, number in new_tables:
        table.number = number
        db.add(table)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        raise _conflict("table_number_taken")

    # 3. Zones removed: only once nothing is left in them.
    for item in body.zones:
        if item.id is None or not item.archive:
            continue
        zone = visible[item.id]
        left = tables_in(db, [zone.id])
        if left:
            raise _conflict("zone_not_empty", zone={"id": str(zone.id), "name": zone.name}, tables=[t.number for t in left])
        zone.archived_at = now
    db.flush()
    return till_state(db, machine, now=now)


# ── Dashboard: live and reports ──────────────────────────────────────────────


def live(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> dict:
    """
    Open tables now: every live table of the shop with its open order (synced, or the
    last a single till reported) and its lock.
    """
    now = now or _now()
    zones = zones_for(db, shop.id, all_areas=True)
    tables = tables_in(db, [z.id for z in zones])
    zone_names = {z.id: z.name for z in zones}
    orders: Dict[uuid.UUID, TableOrder] = {}
    if tables:
        for order in (
            db.query(TableOrder)
            .filter(TableOrder.table_id.in_([t.id for t in tables]), TableOrder.status == "open")
            .order_by(TableOrder.source.desc())
            .all()
        ):
            # A synced order wins over a local report for the same table.
            existing = orders.get(order.table_id)
            if existing is None or (existing.source == "local" and order.source == "synced"):
                orders[order.table_id] = order
    rows = []
    open_count, open_total, guests = 0, Decimal("0"), 0
    for table in tables:
        order = orders.get(table.id)
        lock = lock_out(db, table, now)
        row = table_out(table)
        row["zoneName"] = zone_names.get(table.zone_id)
        row["order"] = order_summary(order) if order is not None else None
        row["lock"] = lock
        # From the dashboard every live lock is "another till's": red, with its name.
        row["state"] = table_state(order, lock)
        if order is not None:
            open_count += 1
            open_total += _money(order.total)
            guests += order.guests or 0
            opened = as_utc(order.opened_at)
            row["minutesOpen"] = int((now - opened).total_seconds() // 60) if opened else None
        rows.append(row)
    return {
        "serverTime": now.isoformat(),
        "zones": [zone_out(z) for z in zones],
        "tables": rows,
        "summary": {"openTables": open_count, "openTotal": float(open_total), "guests": guests},
    }


def dashboard_cancel(db: Session, user: User, shop: Shop, table: DiningTable, body, *, now: Optional[datetime] = None) -> dict:
    """
    A manager cancels a stuck open order from the dashboard (a till gone, a mode
    switched off with tables open). Recorded like a till's cancel, the user as approver.
    """
    now = now or _now()
    reason = active_reason(db, shop.tenant_id, body.reason_id)
    if reason.requires_note and not body.reason_text:
        raise _bad("reason_note_required")
    order = open_order(db, table.id)
    if order is None:
        order = (
            db.query(TableOrder)
            .filter(TableOrder.table_id == table.id, TableOrder.status == "open")
            .first()
        )
    if order is None:
        raise _conflict("table_order_not_open")
    if lock_live(table, now):
        raise _locked(db, table, now)
    name = user.username or user.email
    order.version = (order.version or 0) + 1
    order.status = "cancelled"
    order.closed_at = now
    order.closed_by_pos_user_name = name
    order.cancel_reason_id = reason.id
    order.cancel_reason_text = body.reason_text
    order.cancel_approved_by_user_id = user.id
    order.cancel_approved_by_name = name
    order.updated_at = now
    order.last_request_id = None
    db.flush()
    record_event(
        db, "cancel", table, order, user_id=user.id, now=now,
        details={"reason": reason.name, "reasonText": body.reason_text, "approvedBy": name, "from": "dashboard"},
    )
    machine = db.get(POSMachine, order.opened_machine_id) if order.opened_machine_id else None
    if machine is not None:
        record_cancel_exception(db, machine, order, reason_name=reason.name)
    return order_summary(order)


def dashboard_force_release(db: Session, user: User, table: DiningTable, *, now: Optional[datetime] = None) -> dict:
    now = now or _now()
    holder = lock_out(db, table, now)
    clear_lock(db, table)
    record_event(
        db, "force_release", table, open_order(db, table.id), user_id=user.id, now=now,
        details={"heldBy": holder, "approvedBy": user.username or user.email, "from": "dashboard"},
    )
    return {"released": holder is not None}


def _day_bounds(db: Session, tenant_id: Any, start: date, end: date) -> Tuple[datetime, datetime]:
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    zone = _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
    lo = datetime(start.year, start.month, start.day, tzinfo=zone).astimezone(timezone.utc)
    hi_day = end + timedelta(days=1)
    hi = datetime(hi_day.year, hi_day.month, hi_day.day, tzinfo=zone).astimezone(timezone.utc)
    return lo, hi


def report(db: Session, shop: Shop, start: date, end: date) -> dict:
    """
    The tables report for the local days `start`..`end`: revenue and seating time per
    table and per zone (paid orders, by when they were paid), and cancellations by
    reason and by employee.

    And the waiters' ("דוח מלצרים"): per waiter — tables served, guests, takings, the average
    check and per guest, seating time, tips (the paid sale's) and cancellations — and every
    table each one served ("שולחנות למלצר"). A table is its waiter's (`waiter_pos_user_*`),
    else its opener's.
    """
    if end < start:
        raise _bad("bad_range")
    if (end - start).days > 366:
        raise _bad("range_too_long")
    lo, hi = _day_bounds(db, shop.tenant_id, start, end)
    orders = (
        db.query(TableOrder)
        .filter(
            TableOrder.shop_id == shop.id,
            TableOrder.status.in_(("paid", "cancelled")),
            TableOrder.closed_at >= lo,
            TableOrder.closed_at < hi,
        )
        .all()
    )
    zone_names = {z.id: z.name for z in db.query(TableZone).filter(TableZone.shop_id == shop.id).all()}
    reason_names = {
        r.id: r.name for r in db.query(TableCancelReason).filter(TableCancelReason.tenant_id == shop.tenant_id).all()
    }

    def minutes(order: TableOrder) -> Optional[float]:
        opened, closed = as_utc(order.opened_at), as_utc(order.closed_at)
        if opened is None or closed is None or closed < opened:
            return None
        return (closed - opened).total_seconds() / 60

    by_table: Dict[Any, dict] = {}
    by_zone: Dict[Any, dict] = {}
    paid_count, revenue, seat_minutes, seat_n, guests = 0, Decimal("0"), 0.0, 0, 0
    conflicts = 0
    by_reason: Dict[Any, dict] = {}
    by_employee: Dict[str, dict] = {}
    cancel_rows = []
    cancelled_total = Decimal("0")
    for order in orders:
        if order.status == "paid":
            amount = _money(order.paid_total if order.paid_total is not None else order.total)
            paid_count += 1
            revenue += amount
            guests += order.guests or 0
            conflicts += 1 if order.pay_conflict else 0
            m = minutes(order)
            if m is not None:
                seat_minutes += m
                seat_n += 1
            key = (order.table_id)
            t = by_table.setdefault(key, {
                "tableId": str(order.table_id), "number": order.table_number, "name": order.table_name,
                "zoneName": zone_names.get(order.zone_id), "orders": 0, "revenue": Decimal("0"),
                "guests": 0, "_minutes": 0.0, "_n": 0,
            })
            t["orders"] += 1
            t["revenue"] += amount
            t["guests"] += order.guests or 0
            if m is not None:
                t["_minutes"] += m
                t["_n"] += 1
            z = by_zone.setdefault(order.zone_id, {
                "zoneId": str(order.zone_id) if order.zone_id else None, "zoneName": zone_names.get(order.zone_id),
                "orders": 0, "revenue": Decimal("0"), "guests": 0, "_minutes": 0.0, "_n": 0,
            })
            z["orders"] += 1
            z["revenue"] += amount
            z["guests"] += order.guests or 0
            if m is not None:
                z["_minutes"] += m
                z["_n"] += 1
        else:
            amount = _money(order.total)
            cancelled_total += amount
            reason = reason_names.get(order.cancel_reason_id) or order.cancel_reason_text or "—"
            r = by_reason.setdefault(order.cancel_reason_id, {"reason": reason, "count": 0, "total": Decimal("0")})
            r["count"] += 1
            r["total"] += amount
            who = order.closed_by_pos_user_name or "—"
            e = by_employee.setdefault(who, {"employee": who, "count": 0, "total": Decimal("0")})
            e["count"] += 1
            e["total"] += amount
            cancel_rows.append({
                "orderId": str(order.id),
                "closedAt": _iso(order.closed_at),
                "tableNumber": order.table_number,
                "tableName": order.table_name,
                "zoneName": zone_names.get(order.zone_id),
                "reason": reason,
                "reasonText": order.cancel_reason_text,
                "cancelledBy": order.closed_by_pos_user_name,
                "approvedBy": order.cancel_approved_by_name,
                "total": float(amount),
                "items": order.cancelled_items or [],
                "source": order.source,
            })

    # ── Waiters ──
    paid = [o for o in orders if o.status == "paid"]

    def order_tx_ids(o: TableOrder) -> List[str]:
        """The order's sale, and the sales of its parts paid on their own ("פיצול חשבון")."""
        ids = [str(o.transaction_id)] if o.transaction_id else []
        extras = parse_json_or_none(o.extras_json)
        for part in (extras or {}).get("partials") or [] if isinstance(extras, dict) else []:
            if isinstance(part, dict) and part.get("tx"):
                ids.append(str(part["tx"]))
        return ids

    tx_ids = []
    for o in paid:
        for raw in order_tx_ids(o):
            try:
                tx_ids.append(uuid.UUID(raw))
            except (TypeError, ValueError):
                pass
    tips: Dict[str, Decimal] = {}
    if tx_ids:
        from app.models.transaction import Transaction

        for tid, tip in db.query(Transaction.id, Transaction.tip_amount).filter(Transaction.id.in_(tx_ids)).all():
            tips[str(tid)] = _money(tip or 0)

    def waiter_of(o: TableOrder):
        wid = o.waiter_pos_user_id or o.opened_by_pos_user_id
        name = o.waiter_pos_user_name or o.opened_by_pos_user_name or "—"
        return (wid or name), name

    by_waiter: Dict[Any, dict] = {}
    waiter_rows = []
    for o in orders:
        key, name = waiter_of(o)
        wr = by_waiter.setdefault(key, {
            "waiterId": o.waiter_pos_user_id or o.opened_by_pos_user_id, "waiter": name,
            "tables": 0, "guests": 0, "revenue": Decimal("0"), "tips": Decimal("0"),
            "cancelled": 0, "cancelledTotal": Decimal("0"), "_minutes": 0.0, "_n": 0,
        })
        if o.status == "paid":
            amount = _money(o.paid_total if o.paid_total is not None else o.total)
            tip = sum((tips.get(tid, Decimal("0")) for tid in order_tx_ids(o)), Decimal("0"))
            m = minutes(o)
            wr["tables"] += 1
            wr["guests"] += o.guests or 0
            wr["revenue"] += amount
            wr["tips"] += tip
            if m is not None:
                wr["_minutes"] += m
                wr["_n"] += 1
            waiter_rows.append({
                "orderId": str(o.id), "waiter": name, "waiterId": wr["waiterId"],
                "tableNumber": o.table_number, "tableName": o.table_name, "zoneName": zone_names.get(o.zone_id),
                "openedAt": _iso(o.opened_at), "closedAt": _iso(o.closed_at),
                "minutes": round(m, 1) if m is not None else None, "guests": o.guests,
                "total": float(amount), "tip": float(tip), "transactionNumber": o.transaction_number,
                "status": "paid",
            })
        else:
            wr["cancelled"] += 1
            wr["cancelledTotal"] += _money(o.total)
            waiter_rows.append({
                "orderId": str(o.id), "waiter": name, "waiterId": wr["waiterId"],
                "tableNumber": o.table_number, "tableName": o.table_name, "zoneName": zone_names.get(o.zone_id),
                "openedAt": _iso(o.opened_at), "closedAt": _iso(o.closed_at), "minutes": None,
                "guests": o.guests, "total": float(_money(o.total)), "tip": 0.0,
                "transactionNumber": None, "status": "cancelled",
            })

    def finish_waiter(row: dict) -> dict:
        n = row.pop("_n")
        total_minutes = row.pop("_minutes")
        revenue = row["revenue"]
        row["avgMinutes"] = round(total_minutes / n, 1) if n else None
        row["avgCheck"] = float(_money(revenue / row["tables"])) if row["tables"] else None
        row["avgPerGuest"] = float(_money(revenue / row["guests"])) if row["guests"] else None
        row["revenue"] = float(revenue)
        row["tips"] = float(row["tips"])
        row["cancelledTotal"] = float(row["cancelledTotal"])
        return row

    def finish(row: dict) -> dict:
        n = row.pop("_n")
        total_minutes = row.pop("_minutes")
        row["revenue"] = float(row["revenue"])
        row["avgMinutes"] = round(total_minutes / n, 1) if n else None
        return row

    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "summary": {
            "paidOrders": paid_count,
            "revenue": float(revenue),
            "guests": guests,
            "avgSeatingMinutes": round(seat_minutes / seat_n, 1) if seat_n else None,
            "cancelledOrders": len(cancel_rows),
            "cancelledTotal": float(cancelled_total),
            "payConflicts": conflicts,
        },
        "byTable": sorted((finish(r) for r in by_table.values()), key=lambda r: (r["number"] is None, r["number"] or 0)),
        "byZone": sorted((finish(r) for r in by_zone.values()), key=lambda r: -r["revenue"]),
        "byWaiter": sorted((finish_waiter(r) for r in by_waiter.values()), key=lambda r: -r["revenue"]),
        "waiterTables": sorted(waiter_rows, key=lambda r: (r["waiter"] or "", r["closedAt"] or "")),
        "cancellations": {
            "byReason": sorted(
                ({**r, "total": float(r["total"])} for r in by_reason.values()), key=lambda r: -r["count"]
            ),
            "byEmployee": sorted(
                ({**e, "total": float(e["total"])} for e in by_employee.values()), key=lambda e: -e["count"]
            ),
            "rows": sorted(cancel_rows, key=lambda r: r["closedAt"] or "", reverse=True),
        },
    }


def parse_json_or_none(raw: Optional[str]) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


# ── Reservations ("הזמנות שולחנות") ─────────────────────────────────────────

RESERVATION_STATUSES = ("booked", "seated", "cancelled", "no_show")
#: A booking still shows this long after its time while nobody seated it ("late").
RESERVATION_GRACE = timedelta(hours=2)


def reservation_out(r: TableReservation, table: Optional[DiningTable] = None) -> dict:
    return {
        "id": str(r.id),
        "tableId": str(r.table_id) if r.table_id else None,
        "tableNumber": table.number if table is not None else None,
        "reservedAt": _iso(r.reserved_at),
        "durationMinutes": r.duration_minutes,
        "guests": r.guests,
        "customerName": r.customer_name,
        "phone": r.phone,
        "notes": r.notes,
        "status": r.status,
        "createdByName": r.created_by_name,
    }


def _check_reservation_table(db: Session, shop_id: Any, table_id: Any) -> Optional[DiningTable]:
    if table_id is None:
        return None
    table = db.get(DiningTable, _uuid(table_id))
    if table is None or table.shop_id != shop_id or table.archived_at is not None:
        raise _not_found("table_not_found")
    return table


def _refuse_overlap(db: Session, r: TableReservation) -> None:
    """One table, one party at a time: a booking of the same table over the same time is refused."""
    if r.table_id is None or r.status != "booked":
        return
    start = as_utc(r.reserved_at)
    end = start + timedelta(minutes=r.duration_minutes or 90)
    for other in (
        db.query(TableReservation)
        .filter(
            TableReservation.table_id == r.table_id,
            TableReservation.status == "booked",
            TableReservation.id != r.id,
            TableReservation.reserved_at < end,
            TableReservation.reserved_at > start - timedelta(hours=12),
        )
        .all()
    ):
        o_start = as_utc(other.reserved_at)
        if o_start + timedelta(minutes=other.duration_minutes or 90) > start:
            raise _conflict("reservation_overlap", reservation=reservation_out(other))


def create_reservation(db: Session, shop: Shop, body, *, by_name: Optional[str] = None) -> TableReservation:
    table = _check_reservation_table(db, shop.id, body.table_id)
    r = TableReservation(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, table_id=table.id if table else None,
        reserved_at=as_utc(body.reserved_at), duration_minutes=body.duration_minutes, guests=body.guests,
        customer_name=body.customer_name, phone=body.phone, notes=body.notes, status="booked",
        created_by_name=by_name,
    )
    # Checked before it is added: a refused booking leaves nothing behind.
    _refuse_overlap(db, r)
    db.add(r)
    db.flush()
    return r


def update_reservation(db: Session, r: TableReservation, body) -> TableReservation:
    fields = body.model_fields_set
    if "table_id" in fields:
        table = _check_reservation_table(db, r.shop_id, body.table_id)
        r.table_id = table.id if table else None
    for name in ("duration_minutes", "guests", "customer_name", "phone", "notes", "status"):
        if name in fields and (getattr(body, name) is not None or name in ("guests", "phone", "notes")):
            setattr(r, name, getattr(body, name))
    if "reserved_at" in fields and body.reserved_at is not None:
        r.reserved_at = as_utc(body.reserved_at)
    r.updated_at = _now()
    db.flush()
    _refuse_overlap(db, r)
    return r


def get_reservation(db: Session, reservation_id: Any, shop_id: Any) -> TableReservation:
    r = db.get(TableReservation, _uuid(reservation_id))
    if r is None or r.shop_id != shop_id:
        raise _not_found("reservation_not_found")
    return r


def reservations_of_day(db: Session, shop: Shop, day: date) -> List[dict]:
    lo, hi = _day_bounds(db, shop.tenant_id, day, day)
    rows = (
        db.query(TableReservation)
        .filter(TableReservation.shop_id == shop.id, TableReservation.reserved_at >= lo, TableReservation.reserved_at < hi)
        .order_by(TableReservation.reserved_at.asc())
        .all()
    )
    tables = {t.id: t for t in db.query(DiningTable).filter(DiningTable.id.in_([r.table_id for r in rows if r.table_id])).all()} if rows else {}
    return [reservation_out(r, tables.get(r.table_id)) for r in rows]


def upcoming_reservations(db: Session, machine: POSMachine, now: datetime, table_ids) -> List[TableReservation]:
    """The bookings a till shows: still booked, from a while ago (late) to the end of tomorrow."""
    if machine.shop_id is None:
        return []
    rows = (
        db.query(TableReservation)
        .filter(
            TableReservation.shop_id == machine.shop_id,
            TableReservation.status == "booked",
            TableReservation.reserved_at >= now - RESERVATION_GRACE,
            TableReservation.reserved_at < now + timedelta(hours=36),
        )
        .order_by(TableReservation.reserved_at.asc())
        .limit(200)
        .all()
    )
    # Its own tables', and those with no table yet.
    return [r for r in rows if r.table_id is None or r.table_id in table_ids]
