"""
"כרטיס שולחן" actions from the dashboard (P:/specs/live-tables-cloud.md §2–§4; the contract — names,
params, ids, refusals — in §6, written before this code and kept the one source for the till's side).

**Who does it** (`route_for`, §6.1), by the order's tables mode:

* `cloud` — an order of the cloud's tables (`source = synced`): done here, on the order, with a version
  check, under the rows' locks (the table's, then the order's — never waited for: a row a till's write
  holds right now is "busy", try again). Kitchen tickets go through the print relay, routed as the till
  routes them, under the till's id derivations (app/services/course_auto_fire.py `queue_table_tickets`,
  the void of #85): a retry or a second click is the same job, printed once. The tills learn of it with
  the tables signal.
* `lan` — the cloud's copy of the LAN host's order: a command for the shop's CURRENT tables host, which
  does it as at a till and mirrors it back; `not_host` goes on to the new host once.
* `single` — a single till's report («קופה אחת», no dishes in the cloud): a command for that till.
* `blocked` — nobody to do it: a till whose build never said `remote_table_actions_v1` (`no_capability`),
  a LAN copy no host serves (`hostless`), a single till gone (`no_till`).

The commands are the remote cancel's (#85, app/services/remote_table_cancel.py): `DeviceCommand`, the
till woken through Ably, answered within `remoteCancelTimeoutSeconds` (20 by default) or never — their
own deadline (app/services/device_commands.py `DEADLINE_ACTIONS`): a late pull never gets one.

"הדפס חשבון" is always a command (§6.1): the bill — promotions, the table's discount, parts paid, payments
given back, the suggested tip — is the till's own reckoning. In the cloud mode it goes to the till that
prints on the printer chosen (`bill_printers`, §6.4). "בקופה אחרת" (P:/specs/bill-print-other-till.md §7):
the command goes to the till that holds the table (`bill_owner`) with `printOn` — the till whose printer
prints it; the owner renders the bill and relays it there, LAN first, else the cloud relay (a `document`
job, app/services/remote_print.py). The tills offered: `remote_print.dashboard_targets`.

**A till inside the table** (§4): the actions that change it are refused (409 `table_in_use`, with the
till's name); printing the bill, a kitchen reprint and releasing the lock stay. In the LAN mode the host
knows who is inside, and refuses the same way.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.device_command import DeviceCommand
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tables import DiningTable, TableOrder
from app.services import course_auto_fire as F
from app.services import device_commands as DC
from app.services import table_card as TC

logger = logging.getLogger(__name__)

# ── The contract (P:/specs/live-tables-cloud.md §6) ───────────────────────────

#: The dashboard's action (its URL word) → the till's command.
ACTION_COMMANDS: Dict[str, str] = {
    "print-bill": "table_print_bill",
    "reprint": "table_reprint",
    "fire": "table_fire",
    "hold": "table_hold",
    "rush": "table_rush",
    "set-waiter": "table_set_waiter",
    "move": "table_move",
    "merge": "table_merge",
    "note": "table_note",
}
COMMANDS: Tuple[str, ...] = tuple(ACTION_COMMANDS.values())
ACTION_OF_COMMAND: Dict[str, str] = {v: k for k, v in ACTION_COMMANDS.items()}
#: What a till's heartbeat says when its build takes the nine commands.
CAPABILITY = "remote_table_actions_v1"
#: Refused while a till is inside the table (§4); the cancel is the other one.
MUTATING = frozenset({"fire", "hold", "rush", "set-waiter", "move", "merge", "note"})
#: Checked against the version the dashboard showed.
VERSIONED = frozenset({"fire", "hold", "set-waiter", "move", "merge", "note"})
#: Need the dashboard section "tables_manage" (edit) as well — and the cancel (app/routers/tables.py).
MANAGE_ACTIONS = frozenset({"set-waiter"})
MANAGE_SECTION = "tables_manage"

CLOUD, LAN, SINGLE, BLOCKED = "cloud", "lan", "single", "blocked"
#: The refusals of §6.7 (the till's and the cloud's own).
REFUSALS = (
    "table_in_use", "table_not_open", "order_changed", "not_host", "payment_in_progress",
    "course_not_held", "course_already_out", "nothing_sent", "waiter_not_found", "target_not_free",
    "target_not_found", "source_not_open", "merge_basket_discount", "printer_not_found",
    # "הדפס חשבון" on another till (bill-print-other-till §7): it did not print there, and nothing printed it.
    "print_target_unavailable",
)
#: A command sent on to the new host carries the first one's id here: it is never sent on again.
RETARGET_OF = "retargetOf"
NOTE_MAX = 120
#: Printed small at the foot of the dashboard's tickets ("קופה: דשבורד"), as the void of #85.
SOURCE_NAME = "דשבורד"
REPRINT_NOTICE = "הדפסה חוזרת"
RUSH_NOTICE = "זרז!"
#: How far back a click finds the same request already on its way.
_SAME_REQUEST = timedelta(minutes=10)
_TEXT_MAX = 200
_LIST_MAX = 50


def _now() -> datetime:
    """The tables' own clock (`tables._now`, which the tests move): a lock's life is read by it."""
    from app.services import tables as T

    return T._now()


def _conflict(code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, **extra})


def _bad(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": code})


def _name(user: Any) -> Optional[str]:
    return getattr(user, "username", None) or getattr(user, "email", None)


# ── Who does it ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Route:
    mode: str
    #: The till the command goes to (lan / single); blocked: the one that cannot.
    target: Optional[POSMachine] = None
    #: blocked: "no_capability" | "hostless" | "no_till".
    why: Optional[str] = None
    timeout: int = 20


def capable(machine: Optional[POSMachine]) -> bool:
    """The till's build takes the table commands: its heartbeat said `remote_table_actions_v1`."""
    if machine is None:
        return False
    words = list(getattr(machine, "capabilities", None) or [])
    reported = getattr(machine, "reported_capabilities", None) or {}
    if isinstance(reported, dict):
        words += list(reported.get("list") or [])
    return CAPABILITY in words


def timeout_for(db: Session, machine: POSMachine) -> int:
    """The till's `remoteCancelTimeoutSeconds` (company, shop, point of sale, till; 20 by default)."""
    from app.services import remote_table_cancel as RTC
    from app.services import tables as T

    return RTC.timeout_of(T.machine_params(db, machine))


def lan_host(db: Session, shop_id: Any) -> Optional[POSMachine]:
    """The shop's tables host while the shop is in the LAN mode; None — no host serves a LAN copy."""
    from app.services import tables as T

    host = T.tables_host_of_shop(db, shop_id)
    if host is None:
        return None
    if T.mode_of(T.machine_params(db, host).get(T.TABLES_MODE_KEY)) != T.MODE_LAN:
        return None
    return host


def single_till(db: Session, order: TableOrder) -> Optional[POSMachine]:
    """The till a single till's report came from: the one that last reported it, else the one that opened it."""
    for ident in (order.updated_machine_id, order.opened_machine_id):
        machine = db.get(POSMachine, ident) if ident is not None else None
        if machine is not None and machine.is_active and str(machine.shop_id) == str(order.shop_id):
            return machine
    return None


def route_for(
    db: Session, shop: Shop, order: TableOrder, *, lan: Any = None, timeouts: Optional[Dict[Any, int]] = None,
) -> Route:
    """
    How the dashboard acts on `order` ([lan]: `lan_host` already read for the shop, False for none;
    [timeouts]: each till's timeout as read already — the live view reads every till once).
    """
    from app.services import remote_table_cancel as RTC

    def timeout(machine: POSMachine) -> int:
        if timeouts is None:
            return timeout_for(db, machine)
        if machine.id not in timeouts:
            timeouts[machine.id] = timeout_for(db, machine)
        return timeouts[machine.id]

    if order.source == "synced":
        return Route(CLOUD)
    if not RTC.is_lan_copy(order):
        till = single_till(db, order)
        if till is None:
            return Route(BLOCKED, why="no_till")
        if not capable(till):
            return Route(BLOCKED, till, "no_capability", timeout(till))
        return Route(SINGLE, till, None, timeout(till))
    host = lan_host(db, shop.id) if lan is None else (lan or None)
    if host is None:
        return Route(BLOCKED, why="hostless")
    if not capable(host):
        return Route(BLOCKED, host, "no_capability", timeout(host))
    return Route(LAN, host, None, timeout(host))


def routes_for(db: Session, shop: Shop, orders: Iterable[TableOrder]) -> Dict[Any, Route]:
    """Each order's route, the shop's LAN host and each till's timeout read once (the live view)."""
    from app.services import remote_table_cancel as RTC

    orders = list(orders)
    lan: Any = False
    if any(RTC.is_lan_copy(o) for o in orders):
        lan = lan_host(db, shop.id) or False
    timeouts: Dict[Any, int] = {}
    return {o.id: route_for(db, shop, o, lan=lan, timeouts=timeouts) for o in orders}


def route_out(route: Route) -> Dict[str, Any]:
    from app.services.printers import machine_label

    return {
        "mode": route.mode,
        "why": route.why,
        "hostName": machine_label(route.target),
        "timeoutSeconds": route.timeout if route.mode in (LAN, SINGLE) else None,
    }


# ── A till inside the table (§4) ──────────────────────────────────────────────


def holder_text(lock: Optional[Dict[str, Any]]) -> Optional[str]:
    """"קופה 2 (דנה)" — who is inside, as the card's banner says it."""
    if not lock:
        return None
    till = lock.get("posNumber") or lock.get("machineName") or "?"
    user = (lock.get("posUserName") or "").strip()
    return f"{till} ({user})" if user else str(till)


def in_use(db: Session, table: DiningTable, now: datetime) -> HTTPException:
    """409 `table_in_use`: who holds it (`till`, `lock`), for the dashboard's words."""
    from app.services import tables as T

    lock = T.lock_out(db, table, now)
    return _conflict("table_in_use", table=T.table_ref(table), lock=lock, till=holder_text(lock))


# ── The order the dashboard acts on ───────────────────────────────────────────


def open_order_of(db: Session, table: DiningTable) -> Optional[TableOrder]:
    """The table's open order: the cloud's (synced) first, else the copy a till reported."""
    from app.services import tables as T

    order = T.open_order(db, table.id)
    if order is not None:
        return order
    return (
        db.query(TableOrder)
        .filter(TableOrder.table_id == table.id, TableOrder.status == "open")
        .order_by(TableOrder.updated_at.desc())
        .first()
    )


def _lock_rows(db: Session, table: DiningTable, order: TableOrder) -> Tuple[DiningTable, TableOrder]:
    """
    The table's row, then the order's, held to the end of the request and read again — never waited for:
    one a till's write holds right now is 409 `table_busy` ("try again"), so a dashboard click can neither
    hold up a till's save or payment nor deadlock with it (a save locks the table, then the order; a
    payment the order, then the table).
    """
    row = (
        db.query(DiningTable).filter(DiningTable.id == table.id)
        .with_for_update(skip_locked=True).populate_existing().one_or_none()
    )
    if row is None:
        raise _conflict("table_busy")
    locked = (
        db.query(TableOrder).filter(TableOrder.id == order.id)
        .with_for_update(skip_locked=True).populate_existing().one_or_none()
    )
    if locked is None:
        raise _conflict("table_busy")
    return row, locked


def _lock_other(db: Session, table_id: Any) -> Optional[DiningTable]:
    return (
        db.query(DiningTable).filter(DiningTable.id == table_id)
        .with_for_update(skip_locked=True).populate_existing().one_or_none()
    )


def _check_shown(order: TableOrder, body: Any, *, versioned: bool) -> None:
    """The order the dashboard showed (and, for a change, its version): else 409 `order_changed`."""
    from app.services import tables as T

    shown_id = getattr(body, "order_id", None)
    if shown_id is not None and str(shown_id) != str(order.id):
        raise _conflict("order_changed", order=T.order_summary(order))
    shown_version = getattr(body, "expected_version", None)
    if versioned and shown_version is not None and shown_version != (order.version or 0):
        raise _conflict("order_changed", order=T.order_summary(order))


def _touch(order: TableOrder, now: datetime) -> None:
    """A write of the dashboard's: a new version, never a till's request id."""
    order.version = (order.version or 0) + 1
    order.updated_at = now
    order.cloud_updated_at = now
    order.last_request_id = None


# ── The dashboard's request ───────────────────────────────────────────────────


def perform(
    db: Session, user: Any, shop: Shop, table: DiningTable, action: str, body: Any, *, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    One action of the table card, by the order's route. `{mode: "direct", …}` (done here, the caller
    commits and wakes the tills — `_printing`: the tills that print its tickets), or `{mode: "via_till",
    commandId, …}` (the route answers 202 — the caller commits and wakes `hostMachineId`).
    """
    from app.services import tables as T

    now = now or _now()
    if action not in ACTION_COMMANDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "action_not_found"})
    order = open_order_of(db, table)
    if order is None:
        raise _conflict("table_not_open")
    _check_shown(order, body, versioned=action in VERSIONED)
    route = route_for(db, shop, order)
    if action == "print-bill":
        return _print_bill(db, user, shop, table, order, route, body, now)
    if route.mode == BLOCKED:
        from app.services.printers import machine_label

        raise _conflict("remote_action_blocked", why=route.why, host=machine_label(route.target))
    if route.mode in (LAN, SINGLE):
        return _request(db, user, table, order, route, action, _command_params(db, shop, order, action, body), body, now)
    # The cloud's tables: here, on the rows held.
    table, order = _lock_rows(db, table, order)
    if order.status != "open":
        raise _conflict("table_not_open")
    _check_shown(order, body, versioned=action in VERSIONED)
    if action in MUTATING and T.lock_live(table, now):
        raise in_use(db, table, now)
    out = _DIRECT[action](db, user, shop, table, order, body, now)
    out.setdefault("mode", "direct")
    out.setdefault("action", action)
    out.setdefault("version", order.version)
    out.setdefault("orderId", str(order.id))
    return out


# ── The cloud's tables: done here (§6.6) ──────────────────────────────────────


def _record(db: Session, kind: str, table: DiningTable, order: TableOrder, user: Any, now: datetime, **details: Any) -> None:
    from app.services import tables as T

    T.record_event(
        db, kind, table, order, user_id=getattr(user, "id", None), now=now,
        details={**details, "from": "dashboard", "by": _name(user)},
    )


def _routing(db: Session, order: TableOrder, table: DiningTable) -> POSMachine:
    """The till whose view of the printers the tickets follow (the one that worked the table)."""
    from app.services import table_void_tickets as VT

    routing = VT.routing_machine(db, order, table, order.updated_machine_id)
    if routing is None:
        raise _conflict("remote_action_blocked", why="no_till", host=None)
    return routing


def _tickets(db: Session, jobs: Sequence[Any], now: datetime) -> Dict[str, Any]:
    """The jobs as the dashboard says them, and the tills to wake for them (after the commit)."""
    from app.services import table_void_tickets as VT

    tickets = VT.tickets_out(db, jobs, now)
    names: List[str] = []
    for t in tickets:
        if t.get("printerName") and t["printerName"] not in names:
            names.append(t["printerName"])
    return {
        "printers": names,
        "jobIds": [t["id"] for t in tickets],
        "tickets": tickets,
        "_printing": VT.notify_targets(db, tickets),
    }


def _course(lines: Sequence[F.Line], course_id: Optional[str]) -> Optional[F.Course]:
    for line in lines:
        if line.live and line.course is not None and line.course.id == course_id:
            return line.course
    return None


def _fire(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"הוצא <שלב>": the course's lines, as the till's fire, under its seed (courses-fire-v2 §5)."""
    course_id = (getattr(body, "course_id", None) or "").strip()
    if not course_id:
        raise _bad("course_required")
    lines = F.cart_lines(order.cart_json)
    extras = F.extras_of(order.extras_json)
    seed = F.fire_seed(order.id, course_id)
    course = next((c for c in F.held_courses(lines, extras) if c.id == course_id), None)
    if course is None:
        if any(isinstance(r, dict) and r.get("i") == seed for r in extras.get("log") or []):
            # A second click of a fire that went through: its result, nothing new.
            return {"replayed": True, "fireId": seed, "printers": [], "jobIds": [], "lines": 0, "kds": False}
        raise _conflict("course_not_held")
    routing = _routing(db, order, table)
    name = _name(user)
    out = F.fire_course(
        db, order, table, routing, course, now, auto=False, band=course.name, source_name=SOURCE_NAME,
        actor_name=name or SOURCE_NAME,
    )
    if out is None:
        raise _conflict("course_not_held")
    jobs = out.pop("_jobs")
    _record(
        db, "send", table, order, user, now, fire=True, courseId=course.id, courseName=course.name,
        fireId=out["fireId"], lines=len(out["printedLines"]) + len(out["silentLines"]),
    )
    return {
        **_tickets(db, jobs, now),
        "fireId": out["fireId"],
        "courseName": course.name,
        "lines": len(out["printedLines"]) + len(out["silentLines"]),
        "kds": out["kds"] is not None,
        "kdsError": out["kdsError"],
        "note": out.get("note"),
    }


def _hold(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"השהה שלב" (TableExtras.withHeld): only a course nothing of which went to the kitchen on paper."""
    course_id = (getattr(body, "course_id", None) or "").strip()
    if not course_id:
        raise _bad("course_required")
    on = getattr(body, "hold", True) is not False
    lines = F.cart_lines(order.cart_json)
    extras = F.extras_of(order.extras_json)
    course = _course(lines, course_id)
    if course is None:
        raise _conflict("course_not_held")
    hold = TC._strings(extras.get("hold"))
    fired = TC._strings(extras.get("fired"))
    if on:
        paper = TC.paper_sent(extras)
        if any(line.id in paper for line in F.course_lines(lines, course_id)):
            raise _conflict("course_already_out")
        if course_id in hold and course_id not in fired:
            return {"replayed": True}
        hold = hold + [course_id] if course_id not in hold else hold
        fired = [c for c in fired if c != course_id]
    else:
        if course_id not in hold:
            return {"replayed": True}
        hold = [c for c in hold if c != course_id]
    for key, value in (("hold", hold), ("fired", fired)):
        if value:
            extras[key] = value
        else:
            extras.pop(key, None)
    order.extras_json = F.encode_extras(extras)
    _touch(order, now)
    db.flush()
    _record(db, "hold", table, order, user, now, courseId=course.id, courseName=course.name, hold=on)
    return {"courseName": course.name, "hold": on}


def _picks(rounds: Sequence[TC.Round], body: Any) -> set:
    scope = getattr(body, "scope", None) or "all"
    if scope == "round":
        return TC.round_picks(rounds, getattr(body, "round_id", None) or "")
    if scope == "lines":
        offered = TC.every_pick(rounds)
        return {(p.round_id, p.line_id) for p in getattr(body, "picks", None) or []} & offered
    return TC.every_pick(rounds)


def _kitchen_again(db, user, table, order, now, *, picks, seed: str, notice: str) -> Optional[Dict[str, Any]]:
    """What the kitchen has of `picks` again, under a band (TablesRepository.kitchenAgain). None: nothing."""
    from app.services import kds_workflow as WF
    from app.services import table_void_tickets as VT

    lines = F.cart_lines(order.cart_json)
    extras = F.extras_of(order.extras_json)
    rounds = TC.reprint_rounds(lines, extras)
    wanted = TC.quantities(rounds, picks(rounds))
    items = TC.reprint_items(lines, extras, wanted)
    if not items:
        return None
    routing = _routing(db, order, table)
    jobs: List[Any] = []
    if VT.prints_tickets(WF.config_for_machine(db, routing)):
        jobs = F.queue_table_tickets(
            db, order, table, items, routing=routing, seed=seed, is_addition=False, now=now, notice=notice,
            source_name=SOURCE_NAME,
        )
    return {
        **_tickets(db, jobs, now),
        "seed": seed,
        "lines": len(wanted),
        "rounds": sorted({r.id for r in rounds for rl in r.lines if rl.line_id in wanted}),
    }


def _reprint(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"הדפסה חוזרת — בונים למטבח" (#65): everything, a round, or lines of rounds."""
    seed = TC.reprint_seed(order.id, getattr(body, "request_id", None))
    out = _kitchen_again(db, user, table, order, now, picks=lambda rounds: _picks(rounds, body), seed=seed, notice=REPRINT_NOTICE)
    if out is None:
        raise _conflict("nothing_sent")
    _record(
        db, "reprint", table, order, user, now, scope=getattr(body, "scope", None) or "all",
        rounds=out["rounds"], lines=out["lines"], printers=out["printers"],
    )
    return out


def _rush(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"זרז למטבח": what the kitchen has of the table, by its rounds, under "זרז!"."""
    seed = TC.rush_seed(order.id, getattr(body, "request_id", None))
    out = _kitchen_again(db, user, table, order, now, picks=TC.every_pick, seed=seed, notice=RUSH_NOTICE)
    if out is None:
        raise _conflict("nothing_sent")
    _record(db, "rush", table, order, user, now, lines=out["lines"], printers=out["printers"])
    return out


def waiter_of(db: Session, shop: Shop, pos_user_id: Any):
    """An active till user of the shop."""
    from app.models.pos_user import PosUser

    try:
        ident = pos_user_id if isinstance(pos_user_id, uuid.UUID) else uuid.UUID(str(pos_user_id))
    except (TypeError, ValueError):
        return None
    pu = db.get(PosUser, ident)
    if pu is None or not pu.is_active or str(pu.shop_id) != str(shop.id):
        return None
    return pu


def _set_waiter(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"החלף מלצר" (TableExtras.withWaiter): the order's waiter, and the bookkeeping's."""
    from app.services.attendance import pos_user_name

    pu = waiter_of(db, shop, getattr(body, "waiter_pos_user_id", None))
    if pu is None:
        raise _conflict("waiter_not_found")
    name = pos_user_name(pu)
    before = order.waiter_pos_user_name or order.opened_by_pos_user_name
    if str(order.waiter_pos_user_id or order.opened_by_pos_user_id or "") == str(pu.id):
        return {"replayed": True, "waiterName": name}
    extras = F.extras_of(order.extras_json)
    extras["waiter"] = {"id": str(pu.id), "name": name}
    order.extras_json = F.encode_extras(extras)
    order.waiter_pos_user_id = str(pu.id)
    order.waiter_pos_user_name = name
    _touch(order, now)
    db.flush()
    _record(db, "waiter", table, order, user, now, fromName=before, toName=name, toPosUserId=str(pu.id))
    out: Dict[str, Any] = {"waiterName": name}
    if getattr(body, "also_assignment", False):
        # "גם שיוך" (P:/specs/table-waiter-assignment.md §4): the table's own assignment moves with it.
        from app.services import table_assignments as TAS

        ctx = TAS._Ctx.of(db, shop, now)
        TAS.sweep(ctx)
        who = TAS.Who(name=_name(user), user_id=getattr(user, "id", None), source="dashboard")
        others = [r for r in TAS.live_rows(ctx) if r.table_id == table.id and r.pos_user_id != pu.id]
        TAS._release(others, "replaced", now, who.name)
        TAS.assign(ctx, table, None, pu, who)
        db.flush()
        out["assignment"] = True
    return out


def _other_table(db: Session, shop: Shop, table_id: Any) -> DiningTable:
    from app.services import tables as T

    ident = T._uuid(table_id)
    other = db.get(DiningTable, ident) if ident is not None else None
    if other is None or other.archived_at is not None or str(other.shop_id) != str(shop.id):
        raise _conflict("target_not_found")
    return other


def _move(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"העבר לשולחן אחר": to a free table — none open on it, no till inside it."""
    from app.services import tables as T

    target = _other_table(db, shop, getattr(body, "target_table_id", None))
    if target.id == table.id:
        raise _bad("move_same_table")
    if str(order.table_id) == str(target.id):
        return {"replayed": True}
    held = _lock_other(db, target.id)
    if held is None:
        raise _conflict("table_busy")
    target = held
    if T.lock_live(target, now):
        raise in_use(db, target, now)
    if db.query(TableOrder.id).filter(TableOrder.table_id == target.id, TableOrder.status == "open").first() is not None:
        raise _conflict("target_not_free", table=T.table_ref(target))
    order.table_id = target.id
    order.zone_id = target.zone_id
    order.table_number = target.number
    order.table_label = getattr(target, "label", None)
    order.table_name = target.name
    _touch(order, now)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        raise _conflict("target_not_free", table=T.table_ref(target))
    _record(
        db, "move", target, order, user, now, fromTableId=str(table.id), fromNumber=table.number,
        toTableId=str(target.id), toNumber=target.number,
    )
    from app.services.table_void_tickets import table_title

    return {"toTableId": str(target.id), "toLabel": table_title(target.number, target.name, getattr(target, "label", None)), "_tables": [str(target.id)]}


def _merge(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"אחד שולחנות": the sources' orders into this table's, every version checked, all or nothing."""
    from app.services import tables as T
    from app.services.areas import as_utc

    sources = list(getattr(body, "sources", None) or [])
    if not sources:
        raise _bad("sources_required")
    pairs: List[Tuple[DiningTable, TableOrder]] = []
    seen = {table.id}
    for src in sources:
        other = _other_table(db, shop, src.table_id)
        if other.id in seen:
            raise _bad("merge_duplicate_table")
        seen.add(other.id)
        held = _lock_other(db, other.id)
        if held is None:
            raise _conflict("table_busy")
        if T.lock_live(held, now):
            raise in_use(db, held, now)
        theirs = T.open_order(db, held.id)
        if theirs is not None:
            theirs = (
                db.query(TableOrder).filter(TableOrder.id == theirs.id)
                .with_for_update(skip_locked=True).populate_existing().one_or_none()
            )
        if (
            theirs is None or theirs.status != "open"
            or (src.order_id is not None and str(src.order_id) != str(theirs.id))
            or (src.expected_version is not None and src.expected_version != (theirs.version or 0))
        ):
            raise _conflict("source_not_open", table=T.table_ref(held))
        if TC.has_basket_discount(TC.cart_of(theirs.cart_json)):
            raise _conflict("merge_basket_discount", table=T.table_ref(held))
        pairs.append((held, theirs))
    cart, extras = TC.merged(
        TC.cart_of(order.cart_json), F.extras_of(order.extras_json),
        [(TC.cart_of(o.cart_json), F.extras_of(o.extras_json)) for _t, o in pairs],
    )
    every = [order, *[o for _t, o in pairs]]
    order.cart_json = TC.encode(cart)
    order.extras_json = F.encode_extras(extras)
    order.item_count = sum((Decimal(str(o.item_count or 0)) for o in every), Decimal("0"))
    order.total = sum((T._money(o.total) for o in every), Decimal("0"))
    guests = [o.guests for o in every if o.guests is not None]
    order.guests = sum(guests) if guests else None
    opened = [as_utc(o.opened_at) for o in every if o.opened_at is not None]
    if opened:
        order.opened_at = min(opened)
    order.send_count = max((o.send_count or 0) for o in every)
    sent = [as_utc(o.sent_at) for o in every if o.sent_at is not None]
    order.sent_at = max(sent) if sent else None
    # A bill printed before is not the bill of the merged table.
    order.bill_printed_at = None
    _touch(order, now)
    name = _name(user)
    for other, theirs in pairs:
        theirs.version = (theirs.version or 0) + 1
        theirs.status = "merged"
        theirs.closed_at = now
        theirs.closed_by_pos_user_name = name
        theirs.merged_into_id = order.id
        theirs.updated_at = now
        theirs.cloud_updated_at = now
        theirs.last_request_id = None
        _record(db, "merged", other, theirs, user, now, intoOrderId=str(order.id), intoTableId=str(table.id), intoNumber=table.number)
    db.flush()
    _record(
        db, "merge", table, order, user, now,
        sources=[
            {"tableId": str(t.id), "number": t.number, "orderId": str(o.id), "total": T._float(o.total), "guests": o.guests}
            for t, o in pairs
        ],
    )
    return {"mergedOrderIds": [str(o.id) for _t, o in pairs], "_tables": [str(t.id) for t, _o in pairs]}


def clean_note(text: Any) -> Optional[str]:
    if text is None:
        return None
    clean = " ".join(str(text).split())[:NOTE_MAX]
    return clean or None


def _note(db, user, shop, table, order, body, now) -> Dict[str, Any]:
    """"הערה לשולחן" (§6.5): kept with the order; the next round to the kitchen prints it."""
    text = clean_note(getattr(body, "text", None))
    extras = F.extras_of(order.extras_json)
    before = extras.get(F.TABLE_NOTE_KEY) if isinstance(extras.get(F.TABLE_NOTE_KEY), dict) else None
    if (before or {}).get("t") == text and not (before or {}).get("p"):
        return {"replayed": True, "text": text}
    if text is None and before is None:
        return {"replayed": True, "text": None}
    if text is None:
        extras.pop(F.TABLE_NOTE_KEY, None)
    else:
        extras[F.TABLE_NOTE_KEY] = {"t": text, "by": _name(user), "a": F.till_time(now)}
    order.extras_json = F.encode_extras(extras)
    _touch(order, now)
    db.flush()
    _record(db, "note", table, order, user, now, text=text)
    return {"text": text}


_DIRECT = {
    "fire": _fire,
    "hold": _hold,
    "rush": _rush,
    "reprint": _reprint,
    "set-waiter": _set_waiter,
    "move": _move,
    "merge": _merge,
    "note": _note,
}


# ── "הדפס חשבון" (§6.4) ───────────────────────────────────────────────────────


def _receipt_printers(db: Session, shop_id: Any) -> List[Any]:
    from app.models.printers import KitchenPrinter

    return (
        db.query(KitchenPrinter)
        .filter(KitchenPrinter.shop_id == shop_id, KitchenPrinter.purpose == "receipt", KitchenPrinter.is_active.is_(True))
        .order_by(KitchenPrinter.sort_order, KitchenPrinter.name)
        .all()
    )


def printing_till(db: Session, printer: Any, order: TableOrder, table: DiningTable) -> Optional[POSMachine]:
    """
    The till that prints on a receipt printer in the cloud mode: the one it belongs to (USB, set for a
    till), a cloud printer's host, else the shop's print server, else the till that worked the table.
    """
    from app.services import printers as K
    from app.services import table_void_tickets as VT

    for ident in (printer.machine_id, printer.host_machine_id if printer.connection_type in K.HOSTED_TYPES else None):
        machine = db.get(POSMachine, ident) if ident is not None else None
        if machine is not None and machine.is_active:
            return machine
    host = K.print_host_of_shop(db, order.shop_id)
    if host is not None:
        return host
    return VT.routing_machine(db, order, table, order.updated_machine_id)


def bill_printers(db: Session, shop: Shop, table: DiningTable, order: TableOrder, route: Optional[Route] = None) -> List[Dict[str, Any]]:
    """The bill's choices: `{key, machineId, printerId, name, tillName}` (§6.4)."""
    from app.services.printers import machine_label

    route = route or route_for(db, shop, order)
    printers = _receipt_printers(db, shop.id)
    out: List[Dict[str, Any]] = []

    def option(machine: POSMachine, printer: Any = None) -> Dict[str, Any]:
        return {
            "key": f"{machine.id}:{printer.id if printer is not None else 'own'}",
            "machineId": str(machine.id),
            "printerId": str(printer.id) if printer is not None else None,
            "name": printer.name if printer is not None else None,
            "tillName": machine_label(machine),
        }

    if route.mode in (LAN, SINGLE):
        out.append(option(route.target))
        out.extend(option(route.target, p) for p in printers)
        return out
    if route.mode != CLOUD:
        return []
    from app.services import printers as K

    for m in K.shop_machines(db, shop.id):
        if getattr(m, "is_fiscal", True) is not False and capable(m):
            out.append(option(m))
    for p in printers:
        till = printing_till(db, p, order, table)
        if till is not None and capable(till):
            out.append(option(till, p))
    return out


def bill_owner(db: Session, order: TableOrder, table: DiningTable, route: Route) -> Optional[POSMachine]:
    """
    The till that holds the table — it reckons the bill and, for "בקופה אחרת" (§7 of bill-print-other-till),
    relays it: the LAN host or the single till; in the cloud mode the till that worked the table, when its
    build takes the table commands. None: nobody (blocked).
    """
    from app.services import table_void_tickets as VT

    if route.mode in (LAN, SINGLE):
        return route.target
    if route.mode != CLOUD:
        return None
    till = VT.routing_machine(db, order, table, order.updated_machine_id)
    return till if till is not None and till.is_active and capable(till) else None


def bill_targets(db: Session, shop: Shop, table: DiningTable, order: TableOrder, route: Optional[Route] = None) -> Dict[str, Any]:
    """"הדפס חשבון" in another till (`remote_print.dashboard_targets`, for the till that holds the table)."""
    from app.services import remote_print as RP

    route = route or route_for(db, shop, order)
    return RP.dashboard_targets(db, shop, bill_owner(db, order, table, route))


def _print_on_params(db: Session, owner: POSMachine, target: POSMachine, paper: Optional[int]) -> Dict[str, Any]:
    """`printOn` and how the owner reaches that till: its name, its paper, its LAN address (else the cloud)."""
    from app.services import remote_print as RP
    from app.services.exception_alerts.watch import till_label

    return {
        "printOn": str(target.id),
        "printOnName": till_label(target),
        "printOnPaperWidth": paper,
        "printOnLan": RP.lan_of(db, target, owner),
    }


def _print_bill(db, user, shop, table, order, route, body, now) -> Dict[str, Any]:
    from app.services import remote_print as RP
    from app.services.printers import machine_label

    if route.mode == BLOCKED:
        raise _conflict("remote_action_blocked", why=route.why, host=machine_label(route.target))
    if getattr(body, "print_on", None) is not None:
        return _print_bill_on(db, user, shop, table, order, route, body, now)
    printer_id = getattr(body, "printer_id", None)
    machine_id = getattr(body, "machine_id", None)
    choices = bill_printers(db, shop, table, order, route)
    chosen = next(
        (
            c for c in choices
            if (c["printerId"] or None) == (str(printer_id) if printer_id else None)
            and (machine_id is None or c["machineId"] == str(machine_id))
        ),
        None,
    )
    if chosen is None:
        if printer_id is not None:
            raise _conflict("printer_not_found")
        raise _conflict("remote_action_blocked", why="no_capability", host=None)
    target = db.get(POSMachine, uuid.UUID(chosen["machineId"]))
    if route.mode == CLOUD:
        route = Route(CLOUD, target, None, timeout_for(db, target))
    params: Dict[str, Any] = {"printerId": chosen["printerId"], "printerName": chosen["name"]}
    if chosen["printerId"] is not None:
        from app.models.printers import KitchenPrinter

        printer = db.get(KitchenPrinter, uuid.UUID(chosen["printerId"]))
        host = db.get(POSMachine, printer.host_machine_id) if printer is not None and printer.host_machine_id else None
        if printer is not None and RP.is_document_printer(printer) and host is not None and host.id != target.id:
            # "המדפסת של <קופה>": the till that holds the table relays it to that printer's host.
            params.update(_print_on_params(db, target, host, printer.paper_width))
    return _request(db, user, table, order, route, "print-bill", params, body, now)


def _print_bill_on(db, user, shop, table, order, route, body, now) -> Dict[str, Any]:
    """
    "הדפס חשבון" in another till (bill-print-other-till §7): a command for the till that holds the table,
    with `printOn`. 409 `remote_action_blocked` (nobody holds it that takes the command), `remote_print_off`
    (its `remotePrintEnabled` / `remotePrintFromDashboard`, or its build: `why`), `print_target_not_found`
    (not one of the tills offered), `print_target_needs_update` (that till's build cannot print it).
    """
    from app.services import remote_print as RP

    owner = bill_owner(db, order, table, route)
    if owner is None:
        raise _conflict("remote_action_blocked", why="no_capability", host=None)
    info = RP.dashboard_targets(db, shop, owner)
    if not info["available"]:
        raise _conflict("remote_print_off", why=info["why"])
    wanted = str(getattr(body, "print_on", None))
    chosen = next((t for t in info["targets"] if t["machineId"] == wanted), None)
    if chosen is None:
        raise _conflict("print_target_not_found")
    if not chosen["available"]:
        raise _conflict("print_target_needs_update", till=chosen["label"])
    target = db.get(POSMachine, uuid.UUID(chosen["machineId"]))
    if route.mode == CLOUD:
        route = Route(CLOUD, owner, None, timeout_for(db, owner))
    params = {"printerId": None, "printerName": None, **_print_on_params(db, owner, target, chosen["paperWidth"])}
    return _request(db, user, table, order, route, "print-bill", params, body, now)


# ── A command for the till (§6.2) ─────────────────────────────────────────────


def _command_params(db: Session, shop: Shop, order: TableOrder, action: str, body: Any) -> Dict[str, Any]:
    """The action's own params of §6.2 (the shared ones are added by `_request`)."""
    from app.services.table_void_tickets import table_title

    if action == "fire":
        course_id = (getattr(body, "course_id", None) or "").strip()
        if not course_id:
            raise _bad("course_required")
        course = _course(F.cart_lines(order.cart_json), course_id)
        return {"courseId": course_id, "courseName": course.name if course else None, "seed": F.fire_seed(order.id, course_id)}
    if action == "hold":
        course_id = (getattr(body, "course_id", None) or "").strip()
        if not course_id:
            raise _bad("course_required")
        course = _course(F.cart_lines(order.cart_json), course_id)
        return {"courseId": course_id, "courseName": course.name if course else None, "hold": getattr(body, "hold", True) is not False}
    if action == "rush":
        return {"seed": TC.rush_seed(order.id, getattr(body, "request_id", None))}
    if action == "reprint":
        scope = getattr(body, "scope", None) or "all"
        return {
            "scope": scope,
            "roundId": getattr(body, "round_id", None) if scope == "round" else None,
            "picks": [{"roundId": p.round_id, "lineId": p.line_id} for p in getattr(body, "picks", None) or []] if scope == "lines" else [],
            "seed": TC.reprint_seed(order.id, getattr(body, "request_id", None)),
        }
    if action == "set-waiter":
        from app.services.attendance import pos_user_name

        pu = waiter_of(db, shop, getattr(body, "waiter_pos_user_id", None))
        if pu is None:
            raise _conflict("waiter_not_found")
        out = {"waiter": {"posUserId": str(pu.id), "name": pos_user_name(pu)}}
        if getattr(body, "also_assignment", False):
            # "גם שיוך" (P:/specs/table-waiter-assignment.md §4): the host moves its copy's assignment too.
            out["alsoAssignment"] = True
        return out
    if action == "move":
        target = _other_table(db, shop, getattr(body, "target_table_id", None))
        return {"targetTableId": str(target.id), "targetLabel": table_title(target.number, target.name, getattr(target, "label", None))}
    if action == "merge":
        out = []
        for src in getattr(body, "sources", None) or []:
            other = _other_table(db, shop, src.table_id)
            out.append({
                "tableId": str(other.id),
                "orderId": str(src.order_id) if src.order_id else None,
                "orderVersion": src.expected_version,
                "tableLabel": table_title(other.number, other.name, getattr(other, "label", None)),
            })
        if not out:
            raise _bad("sources_required")
        return {"sources": out}
    if action == "note":
        return {"text": clean_note(getattr(body, "text", None))}
    return {}


def _open_for(
    db: Session, order: TableOrder, command: str, request_id: Optional[str], params: Dict[str, Any], now: datetime,
) -> Optional[DeviceCommand]:
    """The same request (its id, and what it asks) already on its way: the same command."""
    if not request_id:
        return None
    rows = (
        db.query(DeviceCommand)
        .filter(
            DeviceCommand.shop_id == order.shop_id,
            DeviceCommand.action == command,
            DeviceCommand.created_at >= now - _SAME_REQUEST,
        )
        .order_by(DeviceCommand.created_at.desc())
        .all()
    )
    for row in rows:
        p = row.params or {}
        if (
            p.get("orderId") == str(order.id) and p.get("requestId") == request_id
            and all(p.get(k) == v for k, v in params.items())
        ):
            return row
    return None


def _request(db, user, table, order, route: Route, action: str, params: Dict[str, Any], body, now) -> Dict[str, Any]:
    """The command for the route's till (the caller commits, then wakes it)."""
    from app.services.table_void_tickets import table_title

    command = ACTION_COMMANDS[action]
    request_id = str(getattr(body, "request_id", None) or "") or None
    existing = _open_for(db, order, command, request_id, params, now)
    if existing is not None:
        return requested_out(db, existing, route)
    name = _name(user)
    full = {
        "orderId": str(order.id),
        "tableId": str(table.id),
        "tableLabel": table_title(table.number, table.name, getattr(table, "label", None)),
        "orderVersion": order.version,
        "requestId": request_id or str(uuid.uuid4()),
        "requestedBy": {"userId": str(user.id) if getattr(user, "id", None) else None, "name": name},
        "mode": route.mode,
        **params,
    }
    [row] = DC.create(
        db, [route.target], command, user=user, by_name=name, params=full, now=now,
        expires_in=timedelta(seconds=route.timeout),
    )
    return requested_out(db, row, route)


def requested_out(db: Session, row: DeviceCommand, route: Optional[Route] = None) -> Dict[str, Any]:
    """The dashboard's 202: the command to follow (`GET /device-commands/{id}`)."""
    from app.services.printers import machine_label

    host = route.target if route is not None and route.target is not None else db.get(POSMachine, row.machine_id)
    params = row.params or {}
    expires, created = DC._aware(row.expires_at), DC._aware(row.created_at)
    return {
        "mode": "via_till",
        "action": ACTION_OF_COMMAND.get(row.action, row.action),
        "commandId": str(row.id),
        "status": row.status,
        "orderId": params.get("orderId"),
        "tableLabel": params.get("tableLabel"),
        "hostMachineId": str(row.machine_id),
        "hostName": machine_label(host),
        "timeoutSeconds": int((expires - created).total_seconds()) if expires and created else (route.timeout if route else 20),
        "expiresAt": DC._iso(row.expires_at),
        # "הדפס חשבון" in another till: where it is to print ("נשלח להדפסה ב<קופה>").
        "printOnName": params.get("printOnName"),
    }


# ── The till's answer ─────────────────────────────────────────────────────────


def _text(value: Any, limit: int = _TEXT_MAX) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _texts(value: Any) -> List[str]:
    return [t for t in (_text(v) for v in value) if t][:_LIST_MAX] if isinstance(value, list) else []


def clean_answer(command: str, ack_status: str, detail: Optional[str], raw: Any) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    The till's answer as kept (§6.7): `refused` → the reason (in `detail`, and {reason, heldBy});
    `done` → the action's own result, only its known fields, clipped.
    """
    raw = raw if isinstance(raw, dict) else {}
    if ack_status == "refused":
        reason = _text(detail or raw.get("reason"), 64)
        out: Dict[str, Any] = {"reason": reason} if reason else {}
        held = _text(raw.get("heldBy"))
        if held:
            out["heldBy"] = held
        return reason, (out or None)
    if ack_status != "done":
        return detail, None
    out = {}
    # `printOn`, `via` (lan | cloud), `jobId`, `fallback` (local), `printed`: "הדפס חשבון" in another till.
    for key in ("printerName", "toTableId", "toLabel", "printOn", "via", "jobId", "fallback"):
        if _text(raw.get(key)):
            out[key] = _text(raw.get(key))
    for key in ("printers", "jobIds", "mergedOrderIds"):
        if key in raw:
            out[key] = _texts(raw.get(key))
    for key in ("marked", "kds", "printed"):
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    for key in ("lines", "version"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = int(value)
    return detail, (out or None)


def on_answer(db: Session, row: DeviceCommand, *, now: Optional[datetime] = None) -> Optional[DeviceCommand]:
    """
    "הקופה כבר אינה המארחת" (`not_host`): the command goes on to the shop's current host — once, the LAN
    mode only, while the order is still open in the cloud's copy and another device is the host now.
    """
    if row.action not in COMMANDS or row.status != "refused" or row.detail != "not_host":
        return None
    params = dict(row.params or {})
    if params.get("mode") != LAN or params.get(RETARGET_OF) or (row.result or {}).get("retargetedTo"):
        return None
    try:
        order = db.get(TableOrder, uuid.UUID(str(params.get("orderId"))))
    except (TypeError, ValueError):
        return None
    if order is None or order.status != "open":
        return None
    host = lan_host(db, order.shop_id)
    if host is None or host.id == row.machine_id or not capable(host):
        return None
    now = now or DC.utc_now()
    params[RETARGET_OF] = str(row.id)
    [onward] = DC.create(
        db, [host], row.action, by_name=row.created_by_name, source=row.source or "dashboard", params=params,
        now=now, expires_in=timedelta(seconds=timeout_for(db, host)),
    )
    onward.created_by_user_id = row.created_by_user_id
    row.result = {**(row.result or {}), "retargetedTo": str(onward.id)}
    row.updated_at = now
    db.flush()
    return onward


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
    """The action as the dashboard follows it by its first command's id: where it went on to, and its outcome."""
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
    result = dict(current.result or {})
    result.pop("retargetedTo", None)
    out.update({
        "id": str(row.id),
        "currentId": str(current.id),
        "action": ACTION_OF_COMMAND.get(current.action, current.action),
        "retargeted": current is not row,
        "outcome": _OUTCOMES.get(out["status"], out["status"]),
        "reason": out["detail"] if out["status"] == "refused" else None,
        "heldBy": result.get("heldBy"),
        "result": result,
        "hostName": machine_label(db.get(POSMachine, current.machine_id)),
        "tableLabel": (current.params or {}).get("tableLabel"),
        "printOnName": (current.params or {}).get("printOnName"),
    })
    return out


# ── "החלף מלצר": who is on shift ──────────────────────────────────────────────


def waiters(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    The staff to hand a table to: those on shift now (an open attendance shift at the shop, or signed in
    at one of its tills) first; when nobody is, every active till user of the shop (`onShift` false).
    """
    from app.models.attendance import AttendanceShift
    from app.models.pos_user import PosUser
    from app.services.attendance import pos_user_name

    now = now or _now()
    on_shift: Dict[str, str] = {}
    try:
        for (pid,) in (
            db.query(AttendanceShift.pos_user_id)
            .filter(AttendanceShift.shop_id == shop.id, AttendanceShift.clock_out_at.is_(None))
            .all()
        ):
            on_shift[str(pid)] = "attendance"
    except Exception:  # noqa: BLE001 - no attendance here: the signed-in ones
        db.rollback()
    try:
        from app.services import user_sessions as US

        for s in US.active_sessions_for_shop(db, shop.id, now=now):
            pid = s.get("posUserId") or s.get("pos_user_id")
            if pid:
                on_shift.setdefault(str(pid), "signed_in")
    except Exception:  # noqa: BLE001
        logger.debug("signed-in sessions of shop %s not read", shop.id)
    users = db.query(PosUser).filter(PosUser.shop_id == shop.id, PosUser.is_active.is_(True)).all()
    rows = [
        {"posUserId": str(u.id), "name": pos_user_name(u), "onShift": str(u.id) in on_shift, "via": on_shift.get(str(u.id))}
        for u in users
    ]
    if any(r["onShift"] for r in rows):
        rows = [r for r in rows if r["onShift"]]
    return sorted(rows, key=lambda r: (r["name"] or ""))
