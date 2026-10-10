"""
"תשלום בקופה" — kiosk orders paid at the till (docs/SPEC_KIOSK.md §23;
app/services/kiosk_open_orders.py). Machine token; the path machine is the token's.

Kiosk:
POST /sync/{machine_id}/kiosk/open-orders                   orders to pay at the till (upsert by localId)
                                                            → {accepted, rejected, states}

Till (any of the shop's tills, never a kiosk):
GET  /sync/{machine_id}/kiosk/open-orders                   the shop's open orders (expired ones go first)
POST /sync/{machine_id}/kiosk/open-orders/{ref}/lock        open it to pay: 409 kiosk_order_locked {lockedBy}
                                                            / kiosk_order_closed {state}
POST /sync/{machine_id}/kiosk/open-orders/{ref}/release     put it back (the lock goes)
POST /sync/{machine_id}/kiosk/open-orders/{ref}/paid        the till's document took the money
POST /sync/{machine_id}/kiosk/open-orders/{ref}/cancel      {reason}: cancelled, its vouchers given back

`ref` is the order's cloud id or the kiosk's local id — the slip's barcode carries "KO:" + it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.schemas.kiosk_open_orders import KioskOpenOrdersIn, OpenOrderCancelIn, OpenOrderPaidIn, TillActorIn
from app.services import kiosk_control
from app.services import kiosk_open_orders as svc

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_SYNC_PATH

till_router = APIRouter(prefix="/sync", tags=["kiosks"])


def _refused(db: Session, refused: svc.OpenOrderRefused) -> JSONResponse:
    # A refusal changes nothing but an expiry found on the way, which stands.
    db.commit()
    return JSONResponse(status_code=refused.status_code, content=refused.body)


def _server_time() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@till_router.post("/{machine_id}/kiosk/open-orders", dependencies=FISCAL_SYNC_PATH)
def post_open_orders(
    machine_id: str,
    body: KioskOpenOrdersIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The kiosk's orders to pay at the till. No tax document is written for them. 403 `not_a_kiosk`."""
    kiosk_control.require_kiosk_device(db, machine)
    try:
        out = svc.upsert_from_kiosk(db, machine, body.orders)
        db.commit()
    except IntegrityError:
        # The same order posted twice at once: the other request inserted it; again as an update.
        db.rollback()
        out = svc.upsert_from_kiosk(db, machine, body.orders)
        db.commit()
    return out


@till_router.get("/{machine_id}/kiosk/open-orders")
def get_open_orders(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    try:
        orders = svc.list_for_till(db, machine)
    except svc.OpenOrderRefused as refused:
        return _refused(db, refused)
    db.commit()
    return {"orders": orders, "serverTime": _server_time()}


@till_router.post("/{machine_id}/kiosk/open-orders/{ref}/lock", dependencies=FISCAL_SYNC_PATH)
def lock_open_order(
    machine_id: str,
    ref: str,
    body: Optional[TillActorIn] = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    try:
        out = svc.lock(db, machine, ref, pos_user_name=body.pos_user_name if body else None)
    except svc.OpenOrderRefused as refused:
        return _refused(db, refused)
    db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/open-orders/{ref}/release", dependencies=FISCAL_SYNC_PATH)
def release_open_order(
    machine_id: str,
    ref: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    try:
        out = svc.release(db, machine, ref)
    except svc.OpenOrderRefused as refused:
        return _refused(db, refused)
    db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/open-orders/{ref}/paid", dependencies=FISCAL_SYNC_PATH)
def paid_open_order(
    machine_id: str,
    ref: str,
    body: OpenOrderPaidIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    try:
        out = svc.mark_paid(
            db, machine, ref,
            transaction_id=body.transaction_id, transaction_number=body.transaction_number,
            pos_user_name=body.pos_user_name, bon_status=body.bon_status, paid_at=body.paid_at,
        )
    except svc.OpenOrderRefused as refused:
        return _refused(db, refused)
    db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/open-orders/{ref}/cancel", dependencies=FISCAL_SYNC_PATH)
def cancel_open_order(
    machine_id: str,
    ref: str,
    body: OpenOrderCancelIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    try:
        out = svc.cancel(db, machine, ref, reason=body.reason, pos_user_name=body.pos_user_name)
    except svc.OpenOrderRefused as refused:
        return _refused(db, refused)
    db.commit()
    return out
