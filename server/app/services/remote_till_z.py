"""
"סגירת משמרת / הפקת Z מרחוק" from remote control ("שליטה מרחוק") — behind `REMOTE_TILL_Z_ENABLED`
(env, default off).

The safeguards (the owner's):

* **Never automatic.** Only a dashboard user who holds remote control and the Z section asks it,
  for one till, after confirming that till's current totals: the preview's `totalsKey` must still
  match when the request is made (a sale since then → 409 `totals_changed` with the new figures).
* **Only when no sale or card payment is open.** The request is the existing till-Z / shift-close
  request (app/services/till_z.py, app/services/shift_close_requests.py) with `wait_for_rest`: the
  till holds it while a basket, a payment screen or a card is open (a `deferred` ack) and runs it at
  rest. Never `force` — never closes mid-sale.
* **The till's existing Z flow.** A till in `zMode = till` closes its shift, transmits its card
  deals and asks the cloud for its Z number — strictly sequential in its run (z_sequence) — and
  prints; a till in the shop's Z (`zMode = cloud`) is offered a shift close only, its shift then
  waits for the shop's Z as any closed shift does. Kiosks keep their own path (kiosk_z).
"""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

KIND_TILL_Z = "till_z"
KIND_CLOSE_SHIFT = "close_shift"
KIND_LABELS = {KIND_TILL_Z: "הפקת Z", KIND_CLOSE_SHIFT: "סגירת משמרת"}


def enabled() -> bool:
    return os.environ.get("REMOTE_TILL_Z_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")


def require_enabled() -> None:
    if not enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "remote_till_z_off", "message": "סגירת משמרת / Z מרחוק עדיין לא פעילה"},
        )


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return (value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)).isoformat()


def _money(value: Any) -> float:
    return float(value or 0)


def kind_of(machine: POSMachine) -> str:
    from app.services.till_z import Z_MODE_TILL, z_mode_of

    return KIND_TILL_Z if z_mode_of(machine) == Z_MODE_TILL else KIND_CLOSE_SHIFT


def _refuse_device(db: Session, machine: POSMachine) -> None:
    """A kiosk has its own Z path; a display device makes no Z; an unassigned till nothing."""
    from app.models.kiosk import KioskDevice

    if getattr(machine, "is_fiscal", True) is False:
        raise HTTPException(status_code=422, detail={"code": "not_fiscal", "message": "מכשיר תצוגה אינו מפיק Z"})
    if db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id == machine.id).first() is not None:
        raise HTTPException(status_code=422, detail={"code": "kiosk_use_kiosks", "message": "קיוסק נסגר מלשונית הקיוסקים"})


def _shifts(db: Session, machine: POSMachine, kind: str) -> List[Any]:
    """What the request will take: a till Z — every shift of the till no Z took yet (in its shop);
    a shift close — the open shift."""
    from app.services.shifts import find_open_shift
    from app.services.z_builder import unreported_shifts

    if kind == KIND_TILL_Z:
        return list(unreported_shifts(db, machine.id, shop_id=machine.shop_id))
    open_shift = find_open_shift(db, machine.id)
    return [open_shift] if open_shift is not None else []


def _totals_out(totals: Any) -> Dict[str, Any]:
    net = _money(totals.total_sales) - _money(totals.total_refunds)
    return {
        "transactions": int(totals.transactions_count or 0),
        "sales": int(totals.sales_count or 0),
        "creditNotes": int(totals.credit_notes_count or 0),
        "totalSales": _money(totals.total_sales),
        "totalRefunds": _money(totals.total_refunds),
        "net": round(net, 2),
        "discounts": _money(totals.discounts_total),
        "tips": _money(totals.total_tips),
        "byTender": {k: _money(v) for k, v in sorted((totals.payment_breakdown or {}).items())},
        "firstDocument": totals.first_transaction_number,
        "lastDocument": totals.last_transaction_number,
    }


def _key(kind: str, shift_ids: List[Any], t: Dict[str, Any]) -> str:
    raw = "|".join([
        kind, ",".join(sorted(str(s) for s in shift_ids)), str(t["transactions"]),
        f'{t["totalSales"]:.2f}', f'{t["totalRefunds"]:.2f}', str(t["lastDocument"] or ""),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def _pending(db: Session, machine: POSMachine, kind: str) -> Optional[Dict[str, Any]]:
    from app.services import shift_close_requests as close_requests
    from app.services import till_z

    if kind == KIND_TILL_Z:
        rid = till_z.pending_by_machine(db, [machine.id]).get(machine.id)
        if rid is None:
            return None
        from app.models.till_z_request import TillZRequest

        req = db.get(TillZRequest, rid)
        return {"kind": kind, "id": str(req.id), "status": req.status, "errorCode": req.error_code,
                "waitForRest": bool(req.wait_for_rest), "createdAt": _iso(req.created_at)}
    req = close_requests.oldest_pending(db, machine)
    if req is None:
        return None
    return {"kind": kind, "id": str(req.id), "status": req.status, "errorCode": req.error_code,
            "waitForRest": bool(req.wait_for_rest), "createdAt": _iso(req.created_at)}


def preview(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """What the manager confirms: the till, what it will do, the figures it will close on."""
    from app.services.machine_status import is_online
    from app.services.shift_totals import compute_totals
    from app.services.z_sequence import last_machine_z_number

    _refuse_device(db, machine)
    kind = kind_of(machine)
    shifts = _shifts(db, machine, kind)
    open_shift = next((s for s in shifts if getattr(s, "closed_at", None) is None), None)
    totals = _totals_out(compute_totals(db, [s.id for s in shifts]))
    last = last_machine_z_number(db, machine.id) if kind == KIND_TILL_Z else None
    why = None
    if kind == KIND_CLOSE_SHIFT and open_shift is None:
        why = "אין משמרת פתוחה בקופה"
    elif kind == KIND_TILL_Z and not shifts:
        why = "אין משמרות שעוד לא נכללו ב-Z"
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "online": is_online(machine.last_heartbeat_at, now=now),
        "kind": kind,
        "kindLabel": KIND_LABELS[kind],
        "openShift": {
            "id": str(open_shift.id),
            "openedAt": _iso(getattr(open_shift, "opened_at", None)),
            "openedBy": getattr(open_shift, "opened_by", None),
        } if open_shift is not None else None,
        "shiftsCount": len(shifts),
        "totals": totals,
        "lastZNumber": last,
        "nextZNumber": (last + 1) if last is not None else None,
        "pending": _pending(db, machine, kind),
        "totalsKey": _key(kind, [s.id for s in shifts], totals),
        "canRequest": why is None,
        "whyNot": why,
    }


def request(db: Session, user: Any, machine: POSMachine, *, totals_key: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The confirmed request: the figures still as confirmed, then the existing request with
    `wait_for_rest` (never `force`). The caller commits.
    """
    from app.services import shift_close_requests as close_requests
    from app.services import till_z

    current = preview(db, machine, now=now)
    if not current["canRequest"]:
        raise HTTPException(status_code=409, detail={"code": "nothing_to_close", "message": current["whyNot"], "preview": current})
    if not totals_key or totals_key != current["totalsKey"]:
        raise HTTPException(status_code=409, detail={
            "code": "totals_changed",
            "message": "הסכומים בקופה השתנו מאז שאושרו — בדקו שוב ואשרו",
            "preview": current,
        })
    if current["kind"] == KIND_TILL_Z:
        try:
            req, created = till_z.request_for_machine(db, user, machine, force=False, wait_for_rest=True, now=now)
        except till_z.TillZRefused as refused:
            raise HTTPException(status_code=refused.status_code, detail=refused.body)
        out = till_z.request_to_out(db, req, now=now)
    else:
        req, created = close_requests.request_close(db, user, machine, wait_for_rest=True, now=now)
        out = close_requests.request_to_out(db, req, now=now)
    return {"kind": current["kind"], "created": created, "request": out, "confirmed": current}
