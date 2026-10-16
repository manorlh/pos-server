"""
"ביטול שולחן מהדשבורד" by the tables mode (P:/specs/remote-table-cancel.md — the owner chose "אפשרות 2",
13.10.2026).

The dashboard's cancel (`tables.dashboard_cancel`) goes one of three ways (`route_for`):

* **direct** — the cloud cancels it and tells the kitchen itself (app/services/table_void_tickets.py):
  an order of the cloud's tables ("שולחנות בענן"); a single till's report («קופה אחת», no dishes in it);
  and a LAN-mode copy with no host serving it (`hostless`: no tables host, or the shop is no longer in
  the LAN mode) — the next host takes the cloud's copy.
* **via_till** — the LAN mode, a host serving it: the cancel is a `cancel_table` device command for the
  shop's CURRENT tables host (`tables.tables_host_of_shop`), woken through Ably. The host cancels the
  order as a till's own cancel does (the void ticket to every printer that had dishes, the KDS, every
  till on its LAN) and mirrors it to the cloud; the cloud changes nothing itself. Answered within
  `remoteCancelTimeoutSeconds` (default 20) or not at all: the command's own deadline, delivered or not
  (app/services/device_commands.py `DEADLINE_ACTIONS`) — a late pull never gets it, and the dashboard
  says "הקופה המארחת לא זמינה — בטלו בקופה". Never a direct cancel while a host exists, silent or not:
  a host without internet still serves the floor on its LAN.
* **blocked** — `dashboardTableCancel` = `blocked` at the host's levels (company, shop), or a host whose
  build never said `remote_table_cancel_v1` in its heartbeat: no cancel from the dashboard ("בטלו בקופה").

The host's answer (`POST /sync/{m}/device-commands/{id}/ack`): `done` with `{voidedPrinters, kds}`, or
`refused` with the reason (in `detail`, or `result.reason`): `table_not_open`, `payment_in_progress`,
`not_host`, `order_changed`. `not_host` sends it on to the current host once (`on_answer`); the
dashboard follows it by the first id (`GET /device-commands/{id}` → `view`).

`voidJobKey` is the cloud's own void seed for the order (`table_void_tickets.cancel_seed`, the till's
`SendIntents.cancelRequestIdOf`): whatever printed it, one job per printer.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.device_command import OPEN_STATUSES, DeviceCommand
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tables import DiningTable, TableCancelReason, TableOrder
from app.services import device_commands as DC
from app.services.till_parameters import (
    DASHBOARD_TABLE_CANCEL_BLOCKED as BLOCKED_SETTING,
    DASHBOARD_TABLE_CANCEL_KEY as SETTING_KEY,
    DASHBOARD_TABLE_CANCEL_OPTIONS,
    DASHBOARD_TABLE_CANCEL_VIA_TILL as VIA_TILL_SETTING,
    REMOTE_CANCEL_TIMEOUT_DEFAULT,
    REMOTE_CANCEL_TIMEOUT_KEY as TIMEOUT_KEY,
    REMOTE_CANCEL_TIMEOUT_MAX,
    REMOTE_CANCEL_TIMEOUT_MIN,
)

ACTION = "cancel_table"
#: What a host's heartbeat says when its build takes `cancel_table`.
CAPABILITY = "remote_table_cancel_v1"
#: How the dashboard's cancel goes.
DIRECT, VIA_TILL, BLOCKED = "direct", "via_till", "blocked"
#: The host's refusals (the dashboard words each).
REFUSALS = ("table_not_open", "payment_in_progress", "not_host", "order_changed")
#: A command sent on to the new host carries the first one's id here: it is never sent on again.
RETARGET_OF = "retargetOf"
#: How far back a click finds the cancel already on its way for the same order.
_SAME_REQUEST = timedelta(minutes=10)
#: The voided printers an answer may name.
_PRINTERS_MAX = 50


@dataclass(frozen=True)
class Route:
    mode: str
    host: Optional[POSMachine] = None
    #: direct: "cloud" | "single" | "hostless"; blocked: "setting" | "no_capability".
    why: Optional[str] = None
    timeout: int = REMOTE_CANCEL_TIMEOUT_DEFAULT


def capable(machine: Optional[POSMachine]) -> bool:
    """The host's build takes `cancel_table`: its heartbeat said `remote_table_cancel_v1`."""
    if machine is None:
        return False
    words = list(getattr(machine, "capabilities", None) or [])
    reported = getattr(machine, "reported_capabilities", None) or {}
    if isinstance(reported, dict):
        words += list(reported.get("list") or [])
    return CAPABILITY in words


def setting_of(params: Dict[str, Any]) -> str:
    value = params.get(SETTING_KEY)
    return value if value in DASHBOARD_TABLE_CANCEL_OPTIONS else VIA_TILL_SETTING


def timeout_of(params: Dict[str, Any]) -> int:
    value = params.get(TIMEOUT_KEY)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return REMOTE_CANCEL_TIMEOUT_DEFAULT
    return int(min(max(value, REMOTE_CANCEL_TIMEOUT_MIN), REMOTE_CANCEL_TIMEOUT_MAX))


def lan_route(db: Session, shop_id: Any) -> Optional[Route]:
    """
    How a LAN-mode order of the shop is cancelled from the dashboard: through its tables host, or
    blocked. None — no host serves the LAN mode's tables (none, or the shop left the mode): `hostless`.
    """
    from app.services import tables as T

    host = T.tables_host_of_shop(db, shop_id)
    if host is None:
        return None
    params = T.machine_params(db, host)
    if T.mode_of(params.get(T.TABLES_MODE_KEY)) != T.MODE_LAN:
        return None
    timeout = timeout_of(params)
    if setting_of(params) == BLOCKED_SETTING:
        return Route(BLOCKED, host, "setting", timeout)
    if not capable(host):
        return Route(BLOCKED, host, "no_capability", timeout)
    return Route(VIA_TILL, host, None, timeout)


def is_lan_copy(order: TableOrder) -> bool:
    """The cloud's copy of a LAN host's order: reported (`local`) with its dishes — a single till's never has them."""
    return order.source == "local" and order.cart_json is not None


def route_for(db: Session, shop: Shop, order: TableOrder, *, lan: Any = None) -> Route:
    """How the dashboard cancels `order` ([lan]: `lan_route` already read for the shop)."""
    if order.source == "synced":
        return Route(DIRECT, why="cloud")
    if not is_lan_copy(order):
        return Route(DIRECT, why="single")
    route = lan_route(db, shop.id) if lan is None else lan
    return route if isinstance(route, Route) else Route(DIRECT, why="hostless")


def routes_for(db: Session, shop: Shop, orders: Iterable[TableOrder]) -> Dict[Any, Route]:
    """Each order's route, the shop's LAN host read once (the live view)."""
    orders = list(orders)
    lan: Any = False
    if any(is_lan_copy(o) for o in orders):
        lan = lan_route(db, shop.id) or False
    return {o.id: route_for(db, shop, o, lan=lan) for o in orders}


def route_out(route: Route) -> Dict[str, Any]:
    from app.services.printers import machine_label

    return {
        "mode": route.mode,
        "why": route.why,
        "hostName": machine_label(route.host),
        "timeoutSeconds": route.timeout if route.mode == VIA_TILL else None,
    }


# ── The request ───────────────────────────────────────────────────────────────


def _open_for(db: Session, order: TableOrder, now: datetime) -> Optional[DeviceCommand]:
    """The cancel of `order` already on its way (a second click, a retry): the same command."""
    rows = (
        db.query(DeviceCommand)
        .filter(
            DeviceCommand.shop_id == order.shop_id,
            DeviceCommand.action == ACTION,
            DeviceCommand.status.in_(OPEN_STATUSES),
            DeviceCommand.created_at >= now - _SAME_REQUEST,
        )
        .order_by(DeviceCommand.created_at.desc())
        .all()
    )
    for row in rows:
        if (row.params or {}).get("orderId") == str(order.id) and DC.as_of(row, now)["status"] in OPEN_STATUSES:
            return row
    return None


def request(
    db: Session,
    user: Any,
    table: DiningTable,
    order: TableOrder,
    reason: TableCancelReason,
    reason_text: Optional[str],
    route: Route,
    *,
    now: datetime,
) -> DeviceCommand:
    """The `cancel_table` command for the host of `route` (the caller commits, then wakes it)."""
    from app.services import table_void_tickets as VT

    existing = _open_for(db, order, now)
    if existing is not None:
        return existing
    name = getattr(user, "username", None) or getattr(user, "email", None)
    params = {
        "orderId": str(order.id),
        "tableId": str(table.id),
        "tableLabel": VT.table_title(table.number, table.name, getattr(table, "label", None)),
        "orderVersion": order.version,
        "reason": reason.name,
        "reasonId": str(reason.id),
        "reasonText": reason_text,
        "requestedBy": {"userId": str(user.id) if getattr(user, "id", None) else None, "name": name},
        "voidJobKey": VT.cancel_seed(order.id),
    }
    [row] = DC.create(
        db, [route.host], ACTION, user=user, by_name=name, params=params, now=now,
        expires_in=timedelta(seconds=route.timeout),
    )
    return row


def requested_out(row: DeviceCommand, route: Route) -> Dict[str, Any]:
    """The dashboard's 202: the command to follow."""
    from app.services.printers import machine_label

    return {
        "mode": VIA_TILL,
        "commandId": str(row.id),
        "status": row.status,
        "orderId": (row.params or {}).get("orderId"),
        "tableLabel": (row.params or {}).get("tableLabel"),
        "hostMachineId": str(row.machine_id),
        "hostName": machine_label(route.host),
        "timeoutSeconds": route.timeout,
        "expiresAt": DC._iso(row.expires_at),
    }


# ── The host's answer ─────────────────────────────────────────────────────────


def clean_answer(ack_status: str, detail: Optional[str], raw: Any) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    The host's answer as kept: `done` → {voidedPrinters, kds}; `refused` → the reason, in `detail`
    and as {reason} (sent in `detail` as the tills' refusals are, or in `result.reason`).
    """
    raw = raw if isinstance(raw, dict) else {}
    if ack_status == "refused":
        reason = (detail or raw.get("reason") or "")
        reason = str(reason).strip()[:64] or None
        return reason, ({"reason": reason} if reason else None)
    if ack_status == "done":
        printers = raw.get("voidedPrinters")
        printers = [str(p)[:100] for p in printers if p is not None][:_PRINTERS_MAX] if isinstance(printers, list) else []
        kds = raw.get("kds")
        return detail, {"voidedPrinters": printers, "kds": kds if isinstance(kds, bool) else None}
    return detail, None


def on_answer(db: Session, row: DeviceCommand, *, now: Optional[datetime] = None) -> Optional[DeviceCommand]:
    """
    "הקופה כבר אינה המארחת" (`not_host`): the cancel goes on to the shop's current host — once, while
    the order is still open there in the cloud's copy, the host is another device and takes it. The
    new command (the caller commits and wakes its host), or None.
    """
    if row.action != ACTION or row.status != "refused" or row.detail != "not_host":
        return None
    params = dict(row.params or {})
    if params.get(RETARGET_OF) or (row.result or {}).get("retargetedTo"):
        return None
    try:
        order = db.get(TableOrder, uuid.UUID(str(params.get("orderId"))))
    except (TypeError, ValueError):
        return None
    if order is None or order.status != "open":
        return None
    route = lan_route(db, order.shop_id)
    if route is None or route.mode != VIA_TILL or route.host is None or route.host.id == row.machine_id:
        return None
    now = now or DC.utc_now()
    params[RETARGET_OF] = str(row.id)
    [onward] = DC.create(
        db, [route.host], ACTION, by_name=row.created_by_name, source=row.source or "dashboard", params=params,
        now=now, expires_in=timedelta(seconds=route.timeout),
    )
    onward.created_by_user_id = row.created_by_user_id
    row.result = {**(row.result or {}), "retargetedTo": str(onward.id)}
    row.updated_at = now
    db.flush()
    return onward


# ── The dashboard's view ──────────────────────────────────────────────────────

#: The command's status as the dashboard's outcome.
_OUTCOMES = {
    "pending": "waiting",
    "delivered": "waiting",
    "done": "done",
    "refused": "refused",
    "expired": "timeout",
    "failed": "failed",
    "cancelled": "cancelled",
}


def view(db: Session, row: DeviceCommand, now: datetime) -> Dict[str, Any]:
    """
    The cancel as the dashboard follows it, by its first command's id: the command it went on to
    (`not_host`), as it stands now (read only), and its outcome — `waiting`, `done` (with the voided
    printers and the KDS), `refused` (with the reason), `timeout`, `failed`.
    """
    from app.services.printers import machine_label

    current = row
    for _ in range(3):
        onward = (current.result or {}).get("retargetedTo")
        if not onward:
            break
        try:
            follow = db.get(DeviceCommand, uuid.UUID(str(onward)))
        except (TypeError, ValueError):
            follow = None
        if follow is None:
            break
        current = follow
    out = DC.as_of(current, now)
    result = current.result or {}
    host = db.get(POSMachine, current.machine_id)
    out.update({
        "id": str(row.id),
        "currentId": str(current.id),
        "retargeted": current is not row,
        "outcome": _OUTCOMES.get(out["status"], out["status"]),
        "reason": out["detail"] if out["status"] == "refused" else None,
        "voidedPrinters": list(result.get("voidedPrinters") or []),
        "kds": result.get("kds"),
        "hostName": machine_label(host),
        "tableLabel": (current.params or {}).get("tableLabel"),
    })
    return out
