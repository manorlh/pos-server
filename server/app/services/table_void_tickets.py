"""
"בון ביטול" for a table cancelled from the dashboard (the reliability audit of tables and kitchen
tickets, PR #80 — its open item: "ביטול מהדשבורד לא מדפיס בון ביטול, וצריך להודיע למטבח").

The till's own "ביטול שולחן" prints one void ticket of everything the kitchen had of the table, once
(pos-android TablesRepository.cancelVoids, domain/TablesReliability.kt `cancelVoidPlan`). A manager's
cancel from the dashboard ("ביטול השולחן", `tables.dashboard_cancel`) now does the same from here:

* **What.** Every line the order's kitchen bookkeeping says was sent (`extras_json` → `sent`, the
  till's TableExtras), for as much of it as was sent — nothing at all when nothing was. Worded as the
  till words a void (KitchenMenu.ticketItems): "ביטול: <dish>", note "בוטל", a dish made through the
  menu by what the kitchen got for it (its kept snapshot, KitchenMenu.fromSnapshot). The head is the
  till's table ticket: the table, its zone, the guests, who cancelled, the "תוספת" band once the table
  had a send (the till's `isAddition = sendCount > 0`), the order's reference.
* **Where.** The till's routing (KitchenRouting.split, without the till's own copy) over what
  `GET /sync/{m}/printers` gives the till that worked the table (`printers.sync_payload`): the
  product's own printers, else its current category's; "ללא בון" stays without; the zone's printer
  redirect after. One ticket per printer, with only its lines.
* **How.** The cloud relay, as any relayed ticket: a `kitchen_print_jobs` row for the till that prints
  that printer now — a cloud printer's host, the shop's print server (`printers.relay_target`); with
  no print server, the till the printer is set for, else the till that worked the table (it printed
  the table's tickets itself). It waits there as every job does: leased, handed out again, moved when
  the print server moves (`retarget_relay_jobs`, `print_relay_handover`), expired after `JOB_TTL` if
  no till took it. Until it is printed the live tables view says "בון ביטול ממתין למדפסת"
  (`shop_void_tickets`).
* **Once.** The job ids are the till's own for the same cancel (SendIntents.cancelRequestIdOf →
  jobIdOf, per printer): a retry makes nothing new, and a host handed the same cancel's void by a till
  as well holds one job by that id and prints it once (its queue keeps the first, from the LAN and
  from the relay alike); the relay takes a till's upload of it as the same job (`printers.create_job`).
* **KDS.** Kitchen screens drop what they still have of the order, as after the till's cancel
  (KdsBridge.cancelOrder → `kds.release`, trigger `cancel`; idempotent by a derived id). A KDS-only
  configuration (no printer among its targets) prints no ticket, as on the till.

How the tills learn of a dashboard cancel, and why none prints a second void: in the cloud mode
("שולחנות בענן") the cancel wakes the shop's tills (the tables signal); they pull the floor and the
table is free — no till runs its own cancel for it (one that tries is refused: the order is not open
any more), and nothing on a till prints a void for an order closed elsewhere. In the LAN mode the host
holds the floor and the cloud a copy: the host learns of a dashboard cancel only when it next takes the
cloud's copy (`tables.host_seed`, after a restart or a move), and taking it prints nothing. An order
the LAN host serves while it is online is never cancelled from here (`tables.dashboard_cancel`, 409
`table_on_live_host`): the cancel would not reach its floor while the kitchen stopped cooking.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenPrintJob
from app.models.product import Product
from app.models.tables import DiningTable, TableOrder, TableZone
from app.schemas.kitchen_printers import TICKET_LINES_MAX, TICKET_TEXT_MAX, TicketIn
from app.services import printers as K
from app.services.areas import as_utc

logger = logging.getLogger(__name__)

#: The till's words for a void (pos-android TablesRepository.VOID_PREFIX / VOID_NOTE).
VOID_PREFIX = "ביטול: "
VOID_NOTE = "בוטל"
#: Where the ticket came from, printed small at its foot ("קופה: דשבורד").
SOURCE_NAME = "דשבורד"
#: The till's quantity epsilon (KitchenDiff.EPS).
EPS = 1e-9
#: How long the dashboard shows a void ticket that is not printed (a taken job lives as long).
SHOWN_FOR = K.TAKEN_JOB_TTL
#: The lists of a line as the relay takes them (TicketLineIn).
_MODS_MAX = 40


# ── The till's ids ────────────────────────────────────────────────────────────


def java_name_uuid(text: str) -> uuid.UUID:
    """Java's `UUID.nameUUIDFromBytes` of `text` in UTF-8 (an MD5 name UUID, version 3): the till's ids."""
    return uuid.UUID(bytes=hashlib.md5(text.encode("utf-8"), usedforsecurity=False).digest(), version=3)


def cancel_seed(order_id: Any) -> str:
    """The till's "ביטול שולחן" request id for the order (SendIntents.cancelRequestIdOf)."""
    return str(java_name_uuid(f"cancel|{order_id}"))


def job_id_of(seed: str, printer_id: Any, kind: str = "ticket") -> uuid.UUID:
    """A void ticket's job id for one printer (SendIntents.jobIdOf): the same on every try."""
    return java_name_uuid(f"bon|{seed}|{printer_id}|{kind}")


def kds_cancel_id(order_id: Any) -> str:
    """The KDS cancel's dispatch id: the same on every try, so a retry is the KDS's replay."""
    return str(java_name_uuid(f"kds-cancel|dashboard|{order_id}"))


# ── What the kitchen had (pure) ───────────────────────────────────────────────


def _str_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if text and text != "null" else None


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _strings(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


@dataclass(frozen=True)
class SentLine:
    """A line as it went to the kitchen (the till's SentLine): how much, and what it was."""

    line_id: str
    product_id: str
    category_id: Optional[str]
    name: str
    quantity: float
    #: What the kitchen got for one unit of a dish made through the menu (SentLine.kitchen).
    snapshot: Optional[str] = None


def sent_lines(extras_json: Optional[str]) -> List[SentLine]:
    """
    Every line the kitchen got, as it got it (the till's `cancelVoidPlan`): the order's `sent` map, a
    line with a quantity. Unreadable bookkeeping is none (TableExtras.decode).
    """
    if not extras_json:
        return []
    try:
        root = json.loads(extras_json)
    except (TypeError, ValueError):
        return []
    sent = root.get("sent") if isinstance(root, dict) else None
    if not isinstance(sent, dict):
        return []
    out: List[SentLine] = []
    for line_id, s in sent.items():
        if not isinstance(s, dict):
            continue
        quantity = _float(s.get("q"))
        if quantity <= EPS:
            continue
        out.append(SentLine(
            line_id=str(line_id),
            product_id=str(s.get("p") or ""),
            category_id=_str_or_none(s.get("c")),
            name=str(s.get("n") or ""),
            quantity=quantity,
            snapshot=_str_or_none(s.get("k")),
        ))
    return out


@dataclass(frozen=True)
class VoidItem:
    """One line of a void ticket, routed by its product (then its category)."""

    product_id: str
    category_id: Optional[str]
    name: str
    quantity: float
    mods: Tuple[str, ...] = field(default_factory=tuple)
    removals: Tuple[str, ...] = field(default_factory=tuple)
    seat: Optional[str] = None
    course: Optional[str] = None
    meal_name: Optional[str] = None


def _from_snapshot(snapshot: Optional[str], quantity: float) -> Optional[List[VoidItem]]:
    """`quantity` units of a line from its snapshot (KitchenMenu.fromSnapshot); None when there is none to read."""
    if not snapshot or not snapshot.strip():
        return None
    try:
        rows = json.loads(snapshot)
        if not isinstance(rows, list):
            return None
        items = []
        for o in rows:
            if not isinstance(o, dict):
                continue
            if "p" not in o:
                return None  # the till's getString("p") throws: the snapshot is not read at all
            items.append(VoidItem(
                product_id="null" if o["p"] is None else str(o["p"]),
                category_id=_str_or_none(o.get("c")),
                name=str(o.get("n") or ""),
                quantity=_float(o.get("q"), 1.0) * quantity,
                mods=tuple(_strings(o.get("m"))),
                removals=tuple(_strings(o.get("r"))),
                seat=_str_or_none(o.get("s")),
                course=_str_or_none(o.get("o")),
                meal_name=_str_or_none(o.get("ml")),
            ))
    except (TypeError, ValueError):
        return None
    return items or None


def items_of(line: SentLine) -> List[VoidItem]:
    """A voided line's ticket items: by what was kept when it was sent, else as it is (KitchenMenu.itemsOf)."""
    return _from_snapshot(line.snapshot, line.quantity) or [
        VoidItem(line.product_id, line.category_id, line.name, line.quantity)
    ]


def _clip(text: Optional[str], limit: int = TICKET_TEXT_MAX) -> Optional[str]:
    if text is None:
        return None
    text = str(text).strip()
    return text[:limit] if text else None


def ticket_line(item: VoidItem) -> Dict[str, Any]:
    """The item as the void's ticket line (KitchenMenu.ticketItems, voided; KitchenTicketLine.toDto)."""
    return {
        "productId": _clip(item.product_id, 100),
        "categoryId": _clip(item.category_id, 100),
        "name": _clip(f"{VOID_PREFIX}{item.name}") or VOID_PREFIX.strip(),
        "quantity": item.quantity,
        "notes": VOID_NOTE,
        "mods": list(item.mods[:_MODS_MAX]) or None,
        "removals": list(item.removals[:_MODS_MAX]) or None,
        "seat": _clip(item.seat),
        "course": _clip(item.course),
        "mealName": _clip(item.meal_name),
    }


# ── Where it prints (the till's rule) ─────────────────────────────────────────


def redirected(printer_ids: Sequence[str], redirect: Dict[str, str], known: Iterable[str]) -> List[str]:
    """Each printer to its zone redirect when that target is known, deduplicated, in order (KitchenRouting.redirected)."""
    known_ids = set(known)
    out: List[str] = []
    for pid in printer_ids:
        target = redirect.get(pid)
        target = target if target is not None and target in known_ids else pid
        if target not in out:
            out.append(target)
    return out


def route(items: Sequence[VoidItem], config: Dict[str, Any], zone_id: Optional[str]) -> List[Tuple[str, List[VoidItem]]]:
    """
    KitchenRouting.split over a till's pull (`config`), without the till's own share: each printer
    with the lines routed to it, in the ticket's order. A line routed nowhere is left out — it was
    never printed either ("ללא בון", no printer in scope).
    """
    printers = config.get("printers") or []
    in_scope = {p["id"] for p in printers if p.get("inScope")}
    known = [p["id"] for p in printers]
    redirect = ((config.get("zoneRedirects") or {}).get(zone_id) or {}) if zone_id else {}
    product_routes = config.get("productRoutes") or {}
    category_routes = config.get("categoryRoutes") or {}
    by_printer: Dict[str, List[VoidItem]] = {}
    for item in items:
        if item.quantity <= 0:
            continue
        ids = [
            p for p in K.printers_for_line(item.product_id or None, item.category_id, product_routes, category_routes)
            if p in in_scope
        ]
        for pid in redirected(ids, redirect, known):
            by_printer.setdefault(pid, []).append(item)
    return list(by_printer.items())


def prints_tickets(kds_config: Dict[str, Any]) -> bool:
    """The till's KdsWorkflowConfig.printsTickets: the KDS is off, the printer is a target, or no screen is."""
    if not kds_config.get("enabled"):
        return True
    targets = list(kds_config.get("targets") or ["printer"])
    return "printer" in targets or not any(t in ("kds", "kds_view") for t in targets)


def table_title(number: Optional[int], name: Optional[str]) -> str:
    """The till's tableTitle: "12", or "12 · VIP 1" for a named table."""
    clean = (name or "").strip()
    head = str(number) if number is not None else ""
    return f"{head} · {clean}" if clean and head else (clean or head)


# ── The cancel ────────────────────────────────────────────────────────────────


def _works_tables(machine: Optional[POSMachine]) -> bool:
    """A till that may have sent the table: never a kiosk, a display device or a local server."""
    return (
        machine is not None
        and bool(machine.is_active)
        and getattr(machine, "is_fiscal", True) is not False
        and not getattr(machine, "is_kiosk", False)
    )


def routing_machine(
    db: Session, order: TableOrder, table: DiningTable, worked_by: Any = None,
) -> Optional[POSMachine]:
    """
    The till whose view of the printers the void follows: the one that last worked the order, else
    the one that opened it, else a till of the table's point of sale (its zone's), else any till of
    the shop — one that sees the table's zone first.
    """
    zone = db.get(TableZone, table.zone_id) if table.zone_id is not None else None
    area = zone.area_id if zone is not None else None
    named: List[POSMachine] = []
    for ident in (worked_by, order.opened_machine_id):
        machine = db.get(POSMachine, ident) if ident is not None else None
        if machine is not None and str(machine.shop_id) == str(order.shop_id):
            named.append(machine)
    candidates = [m for m in named + K.shop_machines(db, order.shop_id) if _works_tables(m)]
    for machine in candidates:
        if area is None or str(machine.area_id) == str(area):
            return machine
    return candidates[0] if candidates else None


def _current_categories(db: Session, items: List[VoidItem]) -> List[VoidItem]:
    """Lines routed by the category each product is in NOW (as the till's queue does)."""
    ids = set()
    for item in items:
        try:
            ids.add(uuid.UUID(item.product_id))
        except (TypeError, ValueError, AttributeError):
            continue
    if not ids:
        return items
    now_in = {
        str(pid): str(cid)
        for pid, cid in db.query(Product.id, Product.category_id).filter(Product.id.in_(list(ids))).all()
        if cid is not None
    }
    return [replace(i, category_id=now_in.get(i.product_id) or i.category_id) for i in items]


def void_target(printer: KitchenPrinter, print_host: Optional[POSMachine], routing: Optional[POSMachine]) -> Optional[uuid.UUID]:
    """
    The till that prints `printer`'s void: a cloud printer's host; a network / Bluetooth kitchen
    printer's, the shop's print server (`printers.relay_target`) — with none, the till the printer is
    set for, else the till that worked the table (it printed the table's tickets on it itself).
    """
    if printer.connection_type in K.HOSTED_TYPES:
        return printer.host_machine_id
    if K.is_served(printer) and print_host is not None:
        return print_host.id
    if printer.machine_id is not None:
        return printer.machine_id
    return routing.id if routing is not None else None


def queue_cancel_voids(
    db: Session,
    order: TableOrder,
    table: DiningTable,
    *,
    routing: Optional[POSMachine],
    user_id: Any,
    by_name: Optional[str],
    now: datetime,
) -> List[KitchenPrintJob]:
    """
    The void tickets of `order`, cancelled from the dashboard: one relayed job per printer that gets
    any of its sent lines (see the module's doc), as `routing` (`routing_machine`) routes them. The
    jobs already made for it are answered as they stand (a retry). Empty when the kitchen had nothing
    of it, or nothing of it prints on paper.
    """
    lines = sent_lines(order.extras_json)
    if not lines:
        return []
    if routing is None:
        logger.warning("void ticket of table order %s: no till in shop %s", order.id, order.shop_id)
        return []
    from app.services import kds_workflow as WF

    if not prints_tickets(WF.config_for_machine(db, routing)):
        return []  # KDS only: its screens are told (`cancel_on_kds`), nothing is printed
    config = K.sync_payload(db, routing)
    items = _current_categories(db, [i for line in lines for i in items_of(line)])
    routed = route(items, config, str(table.zone_id) if table.zone_id is not None else None)
    if not routed:
        return []
    printers = {
        str(p.id): p
        for p in db.query(KitchenPrinter).filter(KitchenPrinter.id.in_([uuid.UUID(pid) for pid, _ in routed])).all()
    }
    zone = db.get(TableZone, table.zone_id) if table.zone_id is not None else None
    guests = order.guests if order.guests is not None and 0 <= order.guests <= 10_000 else None
    head = {
        "source": "table",
        "tableName": _clip(table_title(table.number, table.name)),
        "zoneName": _clip(zone.name) if zone is not None else None,
        "guests": guests,
        "waiterName": _clip(by_name),
        "createdAt": now.isoformat(),
        "isAddition": (order.send_count or 0) > 0,
        "orderRef": str(order.id)[:8],
        "sourceName": SOURCE_NAME,
    }
    seed = cancel_seed(order.id)
    print_host = K.print_host_of_shop(db, order.shop_id)
    jobs: List[KitchenPrintJob] = []
    for pid, its in routed:
        printer = printers.get(pid)
        if printer is None:
            continue
        job_id = job_id_of(seed, pid)
        existing = db.get(KitchenPrintJob, job_id)
        if existing is not None:
            jobs.append(existing)
            continue
        target = void_target(printer, print_host, routing)
        if target is None:
            logger.warning("void ticket of table order %s: printer %s has no till to print it", order.id, pid)
            continue
        if len(its) > TICKET_LINES_MAX:
            logger.warning("void ticket of table order %s: %d lines on %s, the first %d sent",
                           order.id, len(its), pid, TICKET_LINES_MAX)
        ticket = TicketIn.model_validate({**head, "lines": [ticket_line(i) for i in its[:TICKET_LINES_MAX]]})
        job = KitchenPrintJob(
            id=job_id,
            tenant_id=printer.tenant_id,
            shop_id=printer.shop_id,
            printer_id=printer.id,
            printer_name=printer.name,
            kind="ticket",
            target_machine_id=target,
            source_machine_id=None,
            created_by_user_id=user_id,
            status="pending",
            payload=ticket.model_dump(by_alias=True),
            created_at=now,
            expires_at=now + K.JOB_TTL,
        )
        db.add(job)
        jobs.append(job)
    db.flush()
    return jobs


def cancel_on_kds(db: Session, order: TableOrder, machine: Optional[POSMachine], actor_name: Optional[str], now: datetime) -> Optional[int]:
    """
    The kitchen screens drop what they still have of `order` (the till's KdsBridge.cancelOrder).
    None when the KDS never had it; else how many of its tasks were cancelled.
    """
    from app.models.kds import KitchenOrder
    from app.schemas.kds import TEXT_MAX, KdsReleaseIn
    from app.services import kds as KDS

    kitchen = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.tenant_id == order.tenant_id,
            KitchenOrder.source == "table",
            KitchenOrder.source_ref == str(order.id),
        )
        .first()
    )
    if kitchen is None:
        return None
    owner = db.get(POSMachine, kitchen.machine_id) if kitchen.machine_id is not None else None
    if owner is None or str(owner.shop_id) != str(kitchen.shop_id):
        owner = machine
    if owner is None or str(owner.shop_id) != str(kitchen.shop_id):
        return None
    body = KdsReleaseIn.model_validate({
        "id": kds_cancel_id(order.id),
        "source": "table",
        "sourceRef": str(order.id),
        "trigger": "cancel",
        "occurredAt": now,
        "actorName": _clip(actor_name, TEXT_MAX),
        "items": [],
    })
    out = KDS.release(db, owner, body)
    return int(out.get("cancelled") or 0)


def on_dashboard_cancel(
    db: Session,
    order: TableOrder,
    table: DiningTable,
    *,
    user_id: Any,
    by_name: Optional[str],
    worked_by: Any,
    now: datetime,
) -> Dict[str, Any]:
    """
    The kitchen told of a table cancelled from the dashboard: its void tickets queued, its kitchen
    screens' tasks cancelled. Never fails the cancel — what could not be done is said
    (`voidTicketsError` / `kdsError`) for the dashboard to show.
    """
    out: Dict[str, Any] = {"voidTickets": [], "kdsCancelled": None}
    try:
        routing = routing_machine(db, order, table, worked_by)
    except Exception:  # noqa: BLE001 - routed by no till: the KDS's own till is still told
        logger.exception("no till to route the void of table order %s", order.id)
        routing = None
    try:
        with db.begin_nested():
            jobs = queue_cancel_voids(db, order, table, routing=routing, user_id=user_id, by_name=by_name, now=now)
        out["voidTickets"] = tickets_out(db, jobs, now)
    except Exception:  # noqa: BLE001 - the cancel stands; the dashboard says the kitchen was not told
        logger.exception("void tickets of table order %s not queued", order.id)
        out["voidTicketsError"] = True
    try:
        with db.begin_nested():
            out["kdsCancelled"] = cancel_on_kds(db, order, routing, by_name, now)
    except Exception:  # noqa: BLE001 - as above
        logger.exception("KDS cancel of table order %s failed", order.id)
        out["kdsError"] = True
    return out


# ── The dashboard's view ──────────────────────────────────────────────────────


def state_of(job: KitchenPrintJob, now: datetime) -> str:
    """
    printed | waiting | failed — by the relay's own clock (`printers.expire_jobs`), read without
    writing: one no till took is failed at `expires_at`; one its host took, after `TAKEN_JOB_TTL`.
    """
    if job.status == "done":
        return "printed"
    if job.status in ("failed", "expired"):
        return "failed"
    if K.was_taken(job):
        return "failed" if as_utc(job.created_at) + K.TAKEN_JOB_TTL <= now else "waiting"
    return "failed" if as_utc(job.expires_at) <= now else "waiting"


def tickets_out(db: Session, jobs: Sequence[KitchenPrintJob], now: datetime) -> List[Dict[str, Any]]:
    ids = {j.target_machine_id for j in jobs if j.target_machine_id is not None}
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all()} if ids else {}
    out = []
    for job in jobs:
        payload = job.payload or {}
        out.append({
            "id": str(job.id),
            "tableName": payload.get("tableName"),
            "orderRef": payload.get("orderRef"),
            "printerId": str(job.printer_id) if job.printer_id else None,
            "printerName": job.printer_name,
            "targetMachineId": str(job.target_machine_id) if job.target_machine_id else None,
            "targetMachineName": K.machine_label(machines.get(job.target_machine_id)),
            "state": state_of(job, now),
            "taken": K.was_taken(job),
            "error": job.error,
            "createdAt": as_utc(job.created_at).isoformat() if job.created_at is not None else None,
        })
    return out


def shop_void_tickets(db: Session, shop_id: Any, now: datetime) -> List[Dict[str, Any]]:
    """
    The shop's void tickets from the dashboard that are not printed (yet): "בון ביטול ממתין
    למדפסת" while one waits, "לא הודפס" once the relay gave it up — for `SHOWN_FOR`.
    """
    rows = (
        db.query(KitchenPrintJob)
        .filter(
            KitchenPrintJob.source_machine_id.is_(None),
            KitchenPrintJob.created_at >= now - SHOWN_FOR,
            KitchenPrintJob.shop_id == shop_id,
            KitchenPrintJob.kind == "ticket",
            KitchenPrintJob.created_by_user_id.isnot(None),
        )
        .order_by(KitchenPrintJob.created_at)
        .all()
    )
    return [t for t in tickets_out(db, rows, now) if t["state"] != "printed"]


def notify_targets(db: Session, tickets: Iterable[Dict[str, Any]]) -> List[Tuple[str, str]]:
    """After the commit: the tills that print the waiting ones are woken (`printers.publish_job_notify`)."""
    ids = set()
    for t in tickets:
        if t.get("state") == "waiting" and t.get("targetMachineId"):
            try:
                ids.add(uuid.UUID(t["targetMachineId"]))
            except (TypeError, ValueError):
                continue
    if not ids:
        return []
    return [
        (str(m.tenant_id), str(m.id))
        for m in db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all()
        if m.tenant_id and m.is_active
    ]
