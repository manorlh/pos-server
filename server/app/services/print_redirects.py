"""
"מדפסת חלופית" — the employee's choice of another printer when one is not available
(till parameter `printerFailoverPrompt`, docs/SPEC_PRINT_BY_ZONE.md §3).

The choice is the till's (it knows the printers' state; the cloud does not), and it acts
on it at once — offline too. Afterwards it logs it here: `POST /sync/{m}/print-redirects`,
idempotent by the id the till chose, so a resent log is one row. The printers page lists
the last ones (`GET /shops/{id}/print-redirects`): which till, from which printer to which,
what was sent, why, by whom, and whether it was "the next ones too" for a quarter of an hour.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenPrintRedirect
from app.models.shop import Shop
from app.schemas.printer_discovery import PrintRedirectIn
from app.services import printers as K
from app.services.areas import as_utc

#: How far back the printers page looks, and how many it shows at most.
DEFAULT_DAYS = 7
MAX_ROWS = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment else None


def _shop_printer(db: Session, machine: POSMachine, printer_id) -> Optional[KitchenPrinter]:
    """The printer if it is one of the till's shop; else none (a name is kept anyway)."""
    if printer_id is None:
        return None
    printer = db.query(KitchenPrinter).filter(KitchenPrinter.id == printer_id).first()
    if printer is None or str(printer.shop_id) != str(machine.shop_id):
        return None
    return printer


def log_redirect(db: Session, machine: POSMachine, body: PrintRedirectIn) -> KitchenPrintRedirect:
    """The till's log of one redirect. Idempotent by `body.id`; another till's id is 409."""
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    existing = db.query(KitchenPrintRedirect).filter(KitchenPrintRedirect.id == body.id).first()
    if existing is not None:
        if str(existing.machine_id) != str(machine.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="print_redirect_id_taken")
        return existing
    source = _shop_printer(db, machine, body.from_printer_id)
    target = _shop_printer(db, machine, body.to_printer_id)
    row = KitchenPrintRedirect(
        id=body.id,
        tenant_id=machine.tenant_id,
        shop_id=machine.shop_id,
        machine_id=machine.id,
        kind=body.kind,
        from_printer_id=source.id if source else None,
        from_name=body.from_name or (source.name if source else None),
        to_printer_id=target.id if target else None,
        to_name=body.to_name or (target.name if target else None),
        ticket=body.ticket,
        error=body.error,
        temporary_until=body.temporary_until,
        pos_user_id=body.pos_user_id,
        pos_user_name=body.pos_user_name,
        occurred_at=body.occurred_at or _now(),
        created_at=_now(),
    )
    db.add(row)
    db.flush()
    return row


def redirect_out(row: KitchenPrintRedirect, machines: Dict[str, POSMachine]) -> Dict[str, Any]:
    till = machines.get(str(row.machine_id)) if row.machine_id else None
    return {
        "id": str(row.id),
        "kind": row.kind,
        "machineId": str(row.machine_id) if row.machine_id else None,
        "machineName": K.machine_label(till),
        "fromPrinterId": str(row.from_printer_id) if row.from_printer_id else None,
        "fromName": row.from_name,
        "toPrinterId": str(row.to_printer_id) if row.to_printer_id else None,
        "toName": row.to_name,
        "ticket": row.ticket,
        "error": row.error,
        "temporaryUntil": _iso(row.temporary_until),
        "posUserName": row.pos_user_name,
        "occurredAt": _iso(row.occurred_at or row.created_at),
    }


def shop_redirects(db: Session, shop: Shop, days: int = DEFAULT_DAYS, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The shop's redirects of the last `days` days, newest first, at most `MAX_ROWS`."""
    since = (now or _now()) - timedelta(days=max(1, min(days, 90)))
    rows = (
        db.query(KitchenPrintRedirect)
        .filter(KitchenPrintRedirect.shop_id == shop.id, KitchenPrintRedirect.created_at >= since)
        .order_by(KitchenPrintRedirect.created_at.desc())
        .limit(MAX_ROWS)
        .all()
    )
    ids = {r.machine_id for r in rows if r.machine_id is not None}
    machines = {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all()} if ids else {}
    return [redirect_out(r, machines) for r in rows]
