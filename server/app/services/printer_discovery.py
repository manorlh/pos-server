"""
"חיפוש מדפסות ברשת" — network printer discovery, run by a till on the shop's LAN.

The cloud cannot see a shop's network; its tills can. So:

* **From the till.** The printers screen's scan (hardware/kitchen/PrinterDiscovery.kt):
  the till sweeps its subnet (TCP 9100–9103, 515, 631), listens for mDNS printers, asks
  every raw port the ESC/POS status query, and reports what it found
  (`POST /sync/{m}/printers/discovered`, stored as a `till` scan). Adding one
  (`POST /sync/{m}/printers`) is a manager's write, like the till's other setup writes.
* **From the dashboard.** `POST /shops/{id}/printer-scan` asks one till of the shop to scan:
  the print server ("שרת הדפסות", `print_host_of_shop`) when it is online, else the till
  seen most recently. The till picks the request up with its print-jobs poll
  (`GET /sync/{m}/print-jobs/pending` → `scan`, woken at once by the `print-job` event),
  scans, and answers with the same report naming the request. pending → scanning →
  done | failed; expired when the till never picked it up (`PICKUP_TTL`) or never
  answered (`RUN_TTL`). `GET /shops/{id}/printer-scan` is the dashboard's view: the
  request, the last results and which till would scan.
* **Already configured.** Every result is matched, when read, against the shop's printers
  as they are now (host and port), so one added since shows as such.

The last `KEEP_PER_SHOP` scans of a shop are kept.
"""
from __future__ import annotations

import ipaddress
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, PrinterScan
from app.models.shop import Shop
from app.models.user import User
from app.schemas.kitchen_printers import DEFAULT_PORT, PrinterIn
from app.schemas.printer_discovery import (
    DiscoveredPrinterIn,
    PrinterScanReportIn,
    TillNetworkPrinterIn,
)
from app.services import printers as K
from app.services.areas import as_utc

#: A request the till has not picked up by then is expired ("the till did not answer").
PICKUP_TTL = timedelta(minutes=3)
#: A request picked up and not reported by then is expired.
RUN_TTL = timedelta(minutes=2)
#: A till heard from within this is online: it may be asked to scan.
ONLINE_WINDOW = timedelta(minutes=10)
#: How many scans of a shop are kept.
KEEP_PER_SHOP = 10
#: The raw ESC/POS ports a printer (or a multi-port print server) listens on.
RAW_PORTS = (9100, 9101, 9102, 9103)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment else None


# ── Which till scans ──────────────────────────────────────────────────────────


def last_seen(machine: POSMachine) -> Optional[datetime]:
    stamps = [as_utc(s) for s in (machine.last_heartbeat_at, machine.last_sync_at) if s is not None]
    return max(stamps) if stamps else None


def is_online(machine: POSMachine, now: Optional[datetime] = None) -> bool:
    seen = last_seen(machine)
    return seen is not None and seen >= (now or _now()) - ONLINE_WINDOW


def choose_scanner(db: Session, shop: Shop, now: Optional[datetime] = None) -> Optional[POSMachine]:
    """
    The till to scan with: the shop's print server when it is online (it is on the
    printers' network by definition), else the online till seen most recently. None:
    no till of the shop was heard from lately.
    """
    now = now or _now()
    host = K.print_host_of_shop(db, shop.id)
    if host is not None and is_online(host, now):
        return host
    online = [m for m in K.shop_machines(db, shop.id) if is_online(m, now)]
    if not online:
        return None
    return max(online, key=lambda m: last_seen(m))


def _till_out(machine: Optional[POSMachine], host_id: Optional[str], now: datetime) -> Optional[Dict[str, Any]]:
    if machine is None:
        return None
    return {
        "machineId": str(machine.id),
        "name": K.machine_label(machine),
        "online": is_online(machine, now),
        "isPrintHost": host_id is not None and str(machine.id) == host_id,
        "lastSeenAt": _iso(last_seen(machine)),
    }


# ── Results ───────────────────────────────────────────────────────────────────


def _ip_key(host: str) -> Tuple[int, int]:
    try:
        return (0, int(ipaddress.IPv4Address(host)))
    except ValueError:
        return (1, 0)


def clean_results(printers: Iterable[DiscoveredPrinterIn]) -> List[Dict[str, Any]]:
    """The report's printers as stored: one per host and port (the first kept), by address."""
    seen = set()
    out: List[Dict[str, Any]] = []
    for p in printers:
        key = (p.host, p.port)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "host": p.host,
            "port": p.port,
            "name": p.name,
            "model": p.model,
            "kind": p.kind,
            "responseMs": p.response_ms,
            "paper": p.paper,
            "offline": p.offline,
            "otherPorts": [port for port in p.other_ports if port != p.port],
            "services": list(p.services),
        })
    out.sort(key=lambda r: (_ip_key(r["host"]), r["port"]))
    return out


def network_address(printer: KitchenPrinter) -> Optional[Tuple[str, int]]:
    """Where a configured printer is on the LAN: a network printer, or a cloud one its host reaches by network."""
    reach = printer.host_connection if printer.connection_type in K.HOSTED_TYPES else printer.connection_type
    if reach != "network" or not printer.host:
        return None
    return printer.host.strip().lower(), int(printer.port or DEFAULT_PORT)


def configured_match(result: Dict[str, Any], printers: Iterable[KitchenPrinter]) -> Optional[KitchenPrinter]:
    """
    The shop's printer at this result's address: the same host and port; for a printer
    found only by another protocol (LPD / IPP), the same host.
    """
    host = str(result.get("host") or "").strip().lower()
    port = int(result.get("port") or DEFAULT_PORT)
    by_host = None
    for printer in printers:
        address = network_address(printer)
        if address is None or address[0] != host:
            continue
        if address[1] == port:
            return printer
        by_host = by_host or printer
    return by_host if result.get("kind") == "other" else None


def annotate(results: Optional[List[Dict[str, Any]]], printers: List[KitchenPrinter]) -> Optional[List[Dict[str, Any]]]:
    """The results with `configuredPrinterId` / `configuredPrinterName`, as the shop is now."""
    if results is None:
        return None
    out = []
    for row in results:
        match = configured_match(row, printers)
        out.append({
            **row,
            "configuredPrinterId": str(match.id) if match is not None else None,
            "configuredPrinterName": match.name if match is not None else None,
        })
    return out


# ── Scans ─────────────────────────────────────────────────────────────────────


def expire_scans(rows: Iterable[PrinterScan], now: Optional[datetime] = None) -> None:
    """Unfinished scans past their time become `expired` (in place)."""
    now = now or _now()
    for scan in rows:
        if scan.status in ("pending", "scanning") and as_utc(scan.expires_at) <= now:
            scan.error = scan.error or ("not_picked_up" if scan.status == "pending" else "no_report")
            scan.status = "expired"
            scan.completed_at = now


def _shop_scans(db: Session, shop_id: Any) -> List[PrinterScan]:
    return (
        db.query(PrinterScan)
        .filter(PrinterScan.shop_id == shop_id)
        .order_by(PrinterScan.created_at.desc())
        .all()
    )


def prune(db: Session, shop_id: Any) -> None:
    """Keep the shop's newest `KEEP_PER_SHOP` scans."""
    db.flush()
    for old in _shop_scans(db, shop_id)[KEEP_PER_SHOP:]:
        db.delete(old)
    db.flush()


def request_scan(
    db: Session,
    user: User,
    shop: Shop,
    machine_id: Optional[uuid.UUID] = None,
    now: Optional[datetime] = None,
) -> Tuple[PrinterScan, bool]:
    """
    Ask a till of `shop` to scan. A scan already under way for the shop is returned as it
    is — never two at once. `machine_id` picks the till (an active till of the shop, else
    422 `machine_not_in_shop`); otherwise `choose_scanner`, and 409 `no_till_online`
    when none is. `(scan, created)`.
    """
    now = now or _now()
    rows = _shop_scans(db, shop.id)
    expire_scans(rows, now)
    live = next((s for s in rows if s.status in ("pending", "scanning")), None)
    if live is not None:
        return live, False
    if machine_id is not None:
        machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
        if machine is None or str(machine.shop_id) != str(shop.id) or not machine.is_active:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="machine_not_in_shop")
    else:
        machine = choose_scanner(db, shop, now)
        if machine is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="no_till_online")
    scan = PrinterScan(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        machine_id=machine.id,
        requested_by_user_id=user.id,
        source="dashboard",
        status="pending",
        created_at=now,
        expires_at=now + PICKUP_TTL,
    )
    db.add(scan)
    prune(db, shop.id)
    return scan, True


def take_scan_request(db: Session, machine: POSMachine, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    The pending-jobs poll's `scan`: the oldest request waiting for this till, handed out
    (pending → scanning, `RUN_TTL` to answer). None when there is none.
    """
    now = now or _now()
    rows = (
        db.query(PrinterScan)
        .filter(PrinterScan.machine_id == machine.id, PrinterScan.status.in_(("pending", "scanning")))
        .order_by(PrinterScan.created_at)
        .all()
    )
    if not rows:
        return None
    expire_scans(rows, now)
    scan = next((s for s in rows if s.status == "pending"), None)
    if scan is None:
        db.flush()
        return None
    scan.status = "scanning"
    scan.started_at = now
    scan.expires_at = now + RUN_TTL
    db.flush()
    return {"id": str(scan.id), "requestedAt": _iso(scan.created_at), "expiresAt": _iso(scan.expires_at)}


def report_scan(db: Session, machine: POSMachine, body: PrinterScanReportIn, now: Optional[datetime] = None) -> PrinterScan:
    """
    A till's scan results. With `requestId`: the answer to that request (only the till it
    went to may give it; a late answer still counts). Without: a scan run at the till.
    """
    now = now or _now()
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    if body.request_id is not None:
        scan = db.query(PrinterScan).filter(PrinterScan.id == body.request_id).first()
        if scan is None or str(scan.machine_id) != str(machine.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="scan_not_found")
    else:
        scan = PrinterScan(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            shop_id=machine.shop_id,
            machine_id=machine.id,
            source="till",
            created_at=now,
            expires_at=now,
        )
        db.add(scan)
    scan.status = body.status
    scan.results = clean_results(body.printers)
    scan.subnet = body.subnet
    scan.lan_address = body.lan_address
    scan.duration_ms = body.duration_ms
    scan.error = (body.error or "failed") if body.status == "failed" else None
    scan.started_at = scan.started_at or now
    scan.completed_at = now
    prune(db, scan.shop_id)
    return scan


def scan_out(
    scan: Optional[PrinterScan],
    machines: Dict[str, POSMachine],
    printers: List[KitchenPrinter],
) -> Optional[Dict[str, Any]]:
    if scan is None:
        return None
    till = machines.get(str(scan.machine_id)) if scan.machine_id else None
    return {
        "id": str(scan.id),
        "status": scan.status,
        "source": scan.source,
        "machineId": str(scan.machine_id) if scan.machine_id else None,
        "machineName": K.machine_label(till),
        "subnet": scan.subnet,
        "lanAddress": scan.lan_address,
        "error": scan.error,
        "durationMs": scan.duration_ms,
        "createdAt": _iso(scan.created_at),
        "startedAt": _iso(scan.started_at),
        "completedAt": _iso(scan.completed_at),
        "expiresAt": _iso(scan.expires_at),
        "printers": annotate(scan.results, printers),
    }


def scan_state(db: Session, shop: Shop, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The dashboard's view: `request` — the newest scan, whatever its state (a scan under
    way, or how the last one ended); `last` — the newest finished scan with results;
    `scanner` — the till a new scan would go to (null: none online); `tills`.
    """
    now = now or _now()
    rows = _shop_scans(db, shop.id)
    expire_scans(rows, now)
    db.flush()
    tills = K.shop_machines(db, shop.id)
    machines = {str(m.id): m for m in tills}
    for scan in rows[:2]:
        if scan.machine_id is not None and str(scan.machine_id) not in machines:
            other = db.query(POSMachine).filter(POSMachine.id == scan.machine_id).first()
            if other is not None:
                machines[str(other.id)] = other
    printers = K.shop_printers(db, shop.id)
    host = K.print_host_of_shop(db, shop.id)
    host_id = str(host.id) if host is not None else None
    latest = rows[0] if rows else None
    last = next((s for s in rows if s.status == "done"), None)
    return {
        "shopId": str(shop.id),
        "request": scan_out(latest, machines, printers),
        "last": scan_out(last, machines, printers),
        "scanner": _till_out(choose_scanner(db, shop, now), host_id, now),
        "tills": [_till_out(m, host_id, now) for m in tills],
    }


def till_scan_out(db: Session, scan: PrinterScan) -> Dict[str, Any]:
    """The till's answer to its report: the results, each marked when the shop already has it."""
    printers = K.shop_printers(db, scan.shop_id)
    return {"id": str(scan.id), "status": scan.status, "printers": annotate(scan.results, printers) or []}


# ── Adding a printer found on the LAN, from the till ──────────────────────────


def shop_defaults(printers: List[KitchenPrinter], purpose: str) -> Dict[str, Any]:
    """
    How a new printer of `purpose` prints in this shop: like the shop's first printer of
    that purpose (a network one preferred), else the dashboard's own defaults.
    """
    same = [p for p in printers if (p.purpose or "kitchen") == purpose]
    model = next((p for p in same if p.connection_type == "network"), None) or (same[0] if same else None)
    if model is None:
        return {"paperWidth": 80, "copies": 1, "cutPaper": True, "beep": False, "cashDrawer": purpose == "receipt"}
    return {
        "paperWidth": model.paper_width if model.paper_width in (58, 80) else 80,
        "printWidthDots": model.print_width_dots,
        "copies": model.copies or 1,
        "cutPaper": bool(model.cut_paper),
        "beep": bool(model.beep),
        "cashDrawer": bool(model.cash_drawer) if purpose == "receipt" else False,
    }


def add_from_till(db: Session, machine: POSMachine, body: TillNetworkPrinterIn) -> KitchenPrinter:
    """
    A network printer of the till's shop, for the whole shop, as the dashboard's create
    would make it (the same validation). 409 `printer_already_configured` when the shop
    already has a printer at that address and port.
    """
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    printers = K.shop_printers(db, shop.id)
    if configured_match({"host": body.host, "port": body.port, "kind": "escpos"}, printers) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_already_configured")
    defaults = shop_defaults(printers, body.purpose)
    try:
        printer_in = PrinterIn.model_validate({
            "name": body.name,
            "purpose": body.purpose,
            "connectionType": "network",
            "host": body.host,
            "port": body.port,
            "sortOrder": max((p.sort_order or 0 for p in printers), default=-1) + 1,
            **defaults,
        })
    except ValidationError as exc:  # pragma: no cover - the till's body was validated already
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return K.create_printer(db, shop, printer_in)
