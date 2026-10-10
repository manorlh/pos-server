"""
"תשלום בקופה" — a kiosk order the customer pays at the till (docs/SPEC_KIOSK.md §23).

The kiosk's customer chose "מזומן בקופה": the kiosk issues NO tax document. It posts the order
here OPEN (`kiosk_orders.pay_at_till`, `open_state = "open"`): its lines, its basket (for the
till to rebuild), any prepaid voucher already redeemed towards it on the kiosk (pending), and
what is left to pay. The shop's tills list it ("הזמנות קיוסק ממתינות לתשלום"); the till that
opens it LOCKS it (others see "בטיפול בקופה X"), takes the money with its own document — the
only fiscal document of the order — and marks it PAID; the kitchen gets the bon then. A till
may CANCEL it with a reason; nobody paying it within the kiosk's
`payment.cashAtTillExpiryMin` EXPIRES it (lazily, when anyone looks). A cancelled or expired
order gives its vouchers back (`prepaid_vouchers.reverse_redemption`, as the kiosk itself
would); a paid one names its document on them (`attach_transaction`). Never twice: a
redemption may belong to one order only, and every transition is idempotent.

Rules:
* a lock goes stale after `LOCK_STALE_MIN` without the till coming back to it — then another
  till may take it, and the order may expire again;
* a locked order never expires under the till that holds it;
* "paid" always wins: a till that took the money (even one that was offline and never got the
  lock) is believed, and the conflict is logged;
* the cloud prices the basket again (`kiosk_basket_check.price_lines`: base prices, choices,
  meals — the till runs its own promotions when it takes the money). A new order that differs
  is refused (`price_changed`, with the lines and the cloud's prices) while its customer is
  still at the kiosk — the kiosk says so (`customerWaiting`) and it reached the cloud within
  `PRICE_FRESH_MIN` — so the kiosk shows the change and asks again. Any other (a retry, a kiosk
  that was offline, one that does not say: the slip may be in the customer's hand) is taken as
  it is, the cloud's verdict kept on it (`cart.priceCheck`) and logged.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice, KioskOrder
from app.models.pos_machine import POSMachine
from app.schemas.kiosk_open_orders import KioskOpenOrderIn

logger = logging.getLogger(__name__)

OPEN, PAID, CANCELLED, EXPIRED = "open", "paid", "cancelled", "expired"
CLOSED_STATES = (PAID, CANCELLED, EXPIRED)
#: `kiosk_orders.status` of an order to pay at the till, by its state.
STATUS_OF = {OPEN: "open", PAID: "paid_at_till", CANCELLED: "cancelled", EXPIRED: "expired"}

#: A till's hold on an order lapses after this long without it coming back.
LOCK_STALE_MIN = 10
#: A closed order stays in the tills' list this long, so a till sees it go.
CLOSED_SHOWN_MIN = 2
DEFAULT_EXPIRY_MIN = 30
#: The realtime event that tells the shop's tills to fetch the list now.
WAKE_EVENT = "kiosk-order"

NOT_FOUND = "kiosk_order_not_found"
PRICE_CHANGED = "price_changed"
#: A new order the cloud prices differently is refused at most this long after it was placed,
#: and only while the kiosk says its customer waits; later it is taken as it is, with the verdict.
PRICE_FRESH_MIN = 5
LOCKED = "kiosk_order_locked"
CLOSED = "kiosk_order_closed"
NOT_A_TILL = "kiosk_cannot_pay_orders"


class OpenOrderRefused(Exception):
    def __init__(self, status_code: int, code: str, **extra: Any):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.body = {"detail": code, **extra}


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    """A stored time with no zone is UTC (SQLite drops it)."""
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _iso(value: Optional[datetime]) -> Optional[str]:
    v = _aware(value)
    return v.isoformat().replace("+00:00", "Z") if v is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _reason(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "invalid"
    loc = ".".join(str(p) for p in errors[0].get("loc", ()) if p != "__root__")
    return f"invalid:{loc}" if loc else "invalid"


def _expiry_min(db: Session, kiosk: POSMachine) -> int:
    try:
        from app.services import kiosk_config as cfgsvc

        value = cfgsvc.effective_config(db, kiosk)["payment"].get("cashAtTillExpiryMin")
        return int(value) if isinstance(value, int) and value > 0 else DEFAULT_EXPIRY_MIN
    except Exception:  # noqa: BLE001 - a config that cannot be read: the default
        return DEFAULT_EXPIRY_MIN


def _kiosk_names(db: Session, machine_ids: Iterable[Any]) -> Dict[Any, str]:
    ids = list({m for m in machine_ids if m is not None})
    if not ids:
        return {}
    return {d.machine_id: d.name for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all()}


def till_label(till: POSMachine, pos_user_name: Optional[str]) -> str:
    """"קופה 2 · דנה": the till, and who is on it when the till said."""
    name = (till.name or "").strip() or "קופה"
    user = (pos_user_name or "").strip()
    return f"{name} · {user}"[:200] if user else name[:200]


def lock_active(row: KioskOrder, now: datetime) -> bool:
    at = _aware(row.locked_at)
    return row.locked_by_machine_id is not None and at is not None and now - at < timedelta(minutes=LOCK_STALE_MIN)


def _wake_tills(db: Session, kiosk_or_shop_machine: POSMachine, reason: str, *, skip: Optional[Any] = None) -> None:
    """`kiosk-order` on each shop till's channel: fetch the list now (they poll anyway)."""
    try:
        from app.services import ably_notify
        from app.services.kiosk_ops import _shop_tills

        for till in _shop_tills(db, kiosk_or_shop_machine.shop_id, kiosk_or_shop_machine.tenant_id):
            if skip is not None and till.id == skip:
                continue
            ably_notify.publish_notify(
                str(till.tenant_id), str(till.id), WAKE_EVENT,
                {"reason": reason, "serverTime": _iso(_now())},
            )
    except Exception:  # noqa: BLE001 - the tills fetch on their beat anyway
        logger.exception("kiosk order wake-up failed")


# ── Vouchers: pending on the order, then attached or given back ──────────────


def _redemption_ids(row: KioskOrder) -> List[str]:
    return [str(v.get("redemptionId")) for v in (row.vouchers or []) if isinstance(v, dict) and v.get("redemptionId")]


def _check_vouchers(db: Session, kiosk: POSMachine, order: KioskOpenOrderIn) -> Optional[str]:
    """None when every voucher is one this kiosk redeemed, still standing, and on no other order."""
    if not order.vouchers:
        return None
    from app.models.prepaid_voucher import PrepaidVoucherRedemption

    for v in order.vouchers:
        rid = _uuid(v.redemption_id)
        red = (
            db.query(PrepaidVoucherRedemption)
            .filter(PrepaidVoucherRedemption.id == rid, PrepaidVoucherRedemption.machine_id == kiosk.id)
            .first()
            if rid is not None
            else None
        )
        if red is None:
            return "invalid:vouchers.unknown_redemption"
        if red.reversed_at is not None:
            return "invalid:vouchers.reversed"
    wanted = {v.redemption_id for v in order.vouchers}
    others = (
        db.query(KioskOrder)
        .filter(KioskOrder.machine_id == kiosk.id, KioskOrder.pay_at_till.is_(True), KioskOrder.local_id != order.local_id)
        .order_by(KioskOrder.created_at.desc())
        .limit(500)
        .all()
    )
    for other in others:
        if wanted & set(_redemption_ids(other)):
            return "invalid:vouchers.on_another_order"
    return None


def _give_back_vouchers(db: Session, row: KioskOrder) -> None:
    """The order will not be paid: its vouchers' goods go back on them (idempotent)."""
    ids = _redemption_ids(row)
    if not ids:
        return
    from app.services import prepaid_vouchers as PV

    kiosk = db.get(POSMachine, row.machine_id)
    if kiosk is None:
        return
    for rid in ids:
        try:
            PV.reverse_redemption(db, kiosk, rid)
        except Exception:  # noqa: BLE001 - logged; one voucher never blocks closing the order
            logger.exception("kiosk order %s: voucher redemption %s not given back", row.local_id, rid)


def _attach_vouchers(db: Session, row: KioskOrder, transaction_id: str) -> None:
    ids = _redemption_ids(row)
    if not ids:
        return
    from app.services import prepaid_vouchers as PV

    kiosk = db.get(POSMachine, row.machine_id)
    if kiosk is None:
        return
    for rid in ids:
        try:
            PV.attach_transaction(db, kiosk, rid, transaction_id)
        except Exception:  # noqa: BLE001 - the link is information; the redemption stands
            logger.exception("kiosk order %s: voucher redemption %s not linked", row.local_id, rid)


# ── Transitions ──────────────────────────────────────────────────────────────


def _close(row: KioskOrder, state: str, now: datetime, *, reason: Optional[str], by: Optional[str]) -> None:
    row.open_state = state
    row.status = STATUS_OF[state]
    row.closed_at = now
    row.close_reason = (reason or None) and reason[:300]
    row.closed_by_name = (by or None) and by[:200]
    row.locked_by_machine_id = None
    row.locked_by_name = None
    row.locked_at = None
    row.updated_at = now


def _expire(db: Session, row: KioskOrder, now: datetime) -> None:
    _close(row, EXPIRED, now, reason="expired", by=None)
    _give_back_vouchers(db, row)
    # "logged": the order's row keeps when and why; the log says it too.
    logger.info(
        "kiosk order %s (%s, kiosk %s) expired unpaid at the till: due %s agorot",
        row.local_id, row.pickup_label, row.machine_id, row.due_agorot,
    )


def expire_due(db: Session, shop_id: Any, *, now: Optional[datetime] = None) -> List[KioskOrder]:
    """Open orders of the shop past their time, not held by a till: expired. The caller commits."""
    now = _now(now)
    if shop_id is None:
        return []
    rows = db.query(KioskOrder).filter(KioskOrder.shop_id == shop_id, KioskOrder.open_state == OPEN).all()
    out = []
    for row in rows:
        expires = _aware(row.expires_at)
        if expires is not None and now >= expires and not lock_active(row, now):
            _expire(db, row, now)
            out.append(row)
    if out:
        db.flush()
    return out


def price_check(db: Session, kiosk: POSMachine, cart: Any) -> Optional[Dict[str, Any]]:
    """The cloud's price of the order's basket (its held sale); None when it carries none."""
    from app.services import kiosk_basket_check as BC

    lines = BC.codec_lines(cart)
    if lines is None:
        return None
    return BC.price_lines(db, kiosk, lines)


def upsert_from_kiosk(db: Session, kiosk: POSMachine, items: Iterable[Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`POST /sync/{kiosk}/kiosk/open-orders`: upsert by (kiosk, localId). The caller commits."""
    now = _now(now)
    accepted: List[str] = []
    rejected: List[Dict[str, Any]] = []
    states: Dict[str, Dict[str, Any]] = {}
    fresh = False
    for raw in items:
        local_id = raw.get("localId") if isinstance(raw, dict) else None
        try:
            order = KioskOpenOrderIn.model_validate(raw)
        except ValidationError as exc:
            rejected.append({"localId": local_id if isinstance(local_id, str) else None, "reason": _reason(exc)})
            continue
        row = (
            db.query(KioskOrder)
            .filter(KioskOrder.machine_id == kiosk.id, KioskOrder.local_id == order.local_id)
            .first()
        )
        if row is not None and not row.pay_at_till:
            rejected.append({"localId": order.local_id, "reason": "paid_on_kiosk"})
            continue
        if row is None:
            problem = _check_vouchers(db, kiosk, order)
            if problem is not None:
                rejected.append({"localId": order.local_id, "reason": problem})
                continue
            created = min(_aware(order.created_at) or now, now)
            cart = order.cart
            # The cloud's price, for an order still to be paid (one a LAN till took is history).
            priced = price_check(db, kiosk, cart) if order.state == OPEN else None
            if priced is not None and not priced["ok"]:
                if order.customer_waiting and now - created <= timedelta(minutes=PRICE_FRESH_MIN):
                    rejected.append({"localId": order.local_id, "reason": PRICE_CHANGED, "lines": priced["lines"]})
                    continue
                logger.warning(
                    "kiosk order %s (kiosk %s) taken with prices the cloud does not hold: %s",
                    order.local_id, kiosk.id, priced["lines"],
                )
                cart = {**cart, "priceCheck": {**priced, "checkedAt": _iso(now)}}
            row = KioskOrder(
                id=uuid.uuid4(),
                tenant_id=kiosk.tenant_id,
                machine_id=kiosk.id,
                shop_id=kiosk.shop_id,
                local_id=order.local_id,
                pickup_number=order.pickup_number,
                pickup_label=order.pickup_label or str(order.pickup_number),
                business_date=order.business_date,
                service_type=order.service_type,
                table_ref=order.table_ref,
                fulfillment_mode=order.fulfillment_mode,
                config_version=order.config_version,
                customer_name=order.customer_name,
                customer_phone=order.customer_phone,
                item_count=order.item_count,
                total_agorot=order.total_agorot,
                tip_agorot=order.tip_agorot,
                paid_at=None,
                bon_status="sent" if order.kitchen_sent else "none",
                receipt_status="skipped",
                status=STATUS_OF[OPEN],
                pay_at_till=True,
                open_state=OPEN,
                due_agorot=order.due_agorot,
                voucher_agorot=order.voucher_agorot,
                lines=[line.model_dump(by_alias=True) for line in order.lines],
                cart=cart,
                vouchers=[v.model_dump(by_alias=True) for v in order.vouchers] or None,
                expires_at=created + timedelta(minutes=_expiry_min(db, kiosk)),
                kitchen_sent=order.kitchen_sent,
                created_at=created,
                updated_at=now,
            )
            db.add(row)
            db.flush()
            fresh = True
            if order.state == OPEN and now >= _aware(row.expires_at):
                # Uploaded after its time (the kiosk was offline all along): expired at once.
                _expire(db, row, now)
        # A till on the shop's LAN took it while the cloud was away: the kiosk says so now.
        if row.open_state == OPEN and order.state == PAID:
            _mark_paid_row(
                db, row, now,
                paid_by_machine_id=None, paid_by_name=order.paid_by_name,
                transaction_id=order.paid_transaction_id, transaction_number=order.paid_transaction_number,
                paid_at=_aware(order.paid_at) or now, bon_status=None,
            )
        elif row.open_state == OPEN and order.state == CANCELLED:
            _close(row, CANCELLED, now, reason=order.close_reason or "cancelled on the LAN", by=order.paid_by_name)
            _give_back_vouchers(db, row)
        db.flush()
        accepted.append(order.local_id)
        states[order.local_id] = state_brief(row)
    if fresh:
        _wake_tills(db, kiosk, "kiosk_order")
    return {"accepted": accepted, "rejected": rejected, "states": states}


def state_brief(row: KioskOrder) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "state": row.open_state,
        "paidBy": row.paid_by_name,
        "transactionNumber": row.transaction_number,
        "closedAt": _iso(row.closed_at),
        "expiresAt": _iso(row.expires_at),
    }


def _mark_paid_row(
    db: Session,
    row: KioskOrder,
    now: datetime,
    *,
    paid_by_machine_id: Any,
    paid_by_name: Optional[str],
    transaction_id: Optional[str],
    transaction_number: Optional[str],
    paid_at: datetime,
    bon_status: Optional[str],
) -> None:
    before = row.open_state
    _close(row, PAID, now, reason=None if before == OPEN else f"paid_after_{before}", by=paid_by_name)
    row.paid_at = paid_at
    row.paid_by_machine_id = paid_by_machine_id
    row.paid_by_name = (paid_by_name or None) and paid_by_name[:200]
    if transaction_id:
        row.transaction_id = transaction_id[:64]
    if transaction_number:
        row.transaction_number = transaction_number[:64]
    if bon_status:
        row.bon_status = bon_status
    if before != OPEN:
        logger.warning("kiosk order %s paid at a till after it was %s", row.local_id, before)
    if transaction_id and before == OPEN:
        _attach_vouchers(db, row, transaction_id)


# ── The tills ────────────────────────────────────────────────────────────────


def _require_till(db: Session, till: POSMachine) -> None:
    if db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id == till.id).first() is not None:
        raise OpenOrderRefused(403, NOT_A_TILL)


def _find(db: Session, till: POSMachine, ref: str, *, area_check: bool = True) -> KioskOrder:
    """
    By the cloud's id or the kiosk's local id (the slip's code), in the till's own shop.
    `area_check` False for "paid": the money already moved, so it is recorded whatever the lock.
    """
    text = (ref or "").strip()
    if text.upper().startswith("KO:"):
        text = text[3:].strip()
    row = None
    rid = _uuid(text)
    if rid is not None:
        row = db.query(KioskOrder).filter(KioskOrder.id == rid).first()
    if row is None and text:
        row = (
            db.query(KioskOrder)
            .filter(KioskOrder.local_id == text, KioskOrder.shop_id == till.shop_id)
            .order_by(KioskOrder.created_at.desc())
            .first()
        )
    if (
        row is None or not row.pay_at_till or till.shop_id is None or row.shop_id != till.shop_id
        or (row.tenant_id is not None and row.tenant_id != till.tenant_id)
    ):
        raise OpenOrderRefused(404, NOT_FOUND)
    # "נעילת הקופה לנקודת המכירה שלה" (app/services/area_lock.py): another point of sale's kiosk's
    # order is refused (403 `area_locked`); an area-less kiosk serves the whole shop. One this till
    # already holds stays its own to finish (pay / release), whatever changed since it took it.
    from app.services import area_lock

    if area_check and row.locked_by_machine_id != till.id:
        area_lock.require_shared_device(db, till, db.get(POSMachine, row.machine_id), "order")
    return row


def order_out(row: KioskOrder, till: Optional[POSMachine], now: datetime, kiosk_name: Optional[str] = None) -> Dict[str, Any]:
    locked = lock_active(row, now) and row.open_state == OPEN
    mine = locked and till is not None and row.locked_by_machine_id == till.id
    created = _aware(row.created_at)
    return {
        "id": str(row.id),
        "localId": row.local_id,
        "kioskMachineId": str(row.machine_id),
        "kioskName": kiosk_name,
        "state": row.open_state,
        "pickupNumber": row.pickup_number,
        "pickupLabel": row.pickup_label,
        "businessDate": row.business_date.isoformat() if row.business_date else None,
        "serviceType": row.service_type,
        "tableRef": row.table_ref,
        "fulfillmentMode": row.fulfillment_mode,
        "customerName": row.customer_name,
        "itemCount": row.item_count,
        "totalAgorot": row.total_agorot,
        "tipAgorot": row.tip_agorot,
        "voucherAgorot": row.voucher_agorot or 0,
        "dueAgorot": row.due_agorot if row.due_agorot is not None else row.total_agorot + row.tip_agorot,
        "lines": row.lines or [],
        "cart": row.cart,
        "vouchers": row.vouchers or [],
        "kitchenSent": bool(row.kitchen_sent),
        "createdAt": _iso(created),
        "ageSec": int((now - created).total_seconds()) if created is not None else None,
        "expiresAt": _iso(row.expires_at),
        "lockedBy": row.locked_by_name if locked else None,
        "lockedByMachineId": str(row.locked_by_machine_id) if locked else None,
        "lockedByMe": mine,
        "paidBy": row.paid_by_name,
        "transactionNumber": row.transaction_number,
        "closedAt": _iso(row.closed_at),
        "closeReason": row.close_reason,
    }


def list_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The shop's open orders (and those closed a moment ago, so a till sees them go). Expires first."""
    now = _now(now)
    _require_till(db, till)
    if till.shop_id is None:
        return []
    expire_due(db, till.shop_id, now=now)
    since = now - timedelta(minutes=CLOSED_SHOWN_MIN)
    rows = (
        db.query(KioskOrder)
        .filter(KioskOrder.shop_id == till.shop_id, KioskOrder.pay_at_till.is_(True))
        .filter((KioskOrder.open_state == OPEN) | (KioskOrder.closed_at >= since))
        .order_by(KioskOrder.created_at.asc(), KioskOrder.local_id.asc())
        .all()
    )
    rows = [r for r in rows if r.tenant_id is None or r.tenant_id == till.tenant_id]
    # Locked to its point of sale: that area's kiosks' orders and the area-less kiosks' (area_lock.py).
    from app.services import area_lock

    areas = area_lock.areas_of_machines(db, [r.machine_id for r in rows])
    rows = area_lock.keep_shared_devices(db, till, rows, lambda r: areas.get(r.machine_id))
    names = _kiosk_names(db, [r.machine_id for r in rows])
    return [order_out(r, till, now, names.get(r.machine_id)) for r in rows]


def lock(db: Session, till: POSMachine, ref: str, *, pos_user_name: Optional[str] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The till opens the order to pay it: 409 `kiosk_order_locked` {lockedBy} / `kiosk_order_closed` {state}."""
    now = _now(now)
    _require_till(db, till)
    row = _find(db, till, ref)
    if row.open_state == OPEN:
        expire_due(db, row.shop_id, now=now)
    if row.open_state != OPEN:
        raise OpenOrderRefused(409, CLOSED, state=row.open_state, paidBy=row.paid_by_name)
    if lock_active(row, now) and row.locked_by_machine_id != till.id:
        raise OpenOrderRefused(409, LOCKED, lockedBy=row.locked_by_name)
    row.locked_by_machine_id = till.id
    row.locked_by_name = till_label(till, pos_user_name)
    row.locked_at = now
    row.updated_at = now
    db.flush()
    _wake_tills(db, till, "kiosk_order_locked", skip=till.id)
    return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))


def release(db: Session, till: POSMachine, ref: str, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The cashier put it back: the lock goes (only this till's own). Idempotent."""
    now = _now(now)
    _require_till(db, till)
    row = _find(db, till, ref)
    if row.locked_by_machine_id == till.id:
        row.locked_by_machine_id = None
        row.locked_by_name = None
        row.locked_at = None
        row.updated_at = now
        db.flush()
        _wake_tills(db, till, "kiosk_order_released", skip=till.id)
    return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))


def mark_paid(
    db: Session,
    till: POSMachine,
    ref: str,
    *,
    transaction_id: str,
    transaction_number: Optional[str] = None,
    pos_user_name: Optional[str] = None,
    bon_status: Optional[str] = None,
    paid_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The till took the money with its own document: paid. Idempotent for the same document;
    `kiosk_order_closed` when another document of another till paid it first.
    """
    now = _now(now)
    _require_till(db, till)
    row = _find(db, till, ref, area_check=False)
    if row.open_state == PAID:
        if row.transaction_id == transaction_id:
            return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))
        logger.warning(
            "kiosk order %s paid twice: %s by %s, now %s by till %s",
            row.local_id, row.transaction_id, row.paid_by_name, transaction_id, till.id,
        )
        raise OpenOrderRefused(409, CLOSED, state=row.open_state, paidBy=row.paid_by_name)
    if lock_active(row, now) and row.locked_by_machine_id not in (None, till.id):
        logger.warning("kiosk order %s paid by till %s while held by %s", row.local_id, till.id, row.locked_by_name)
    _mark_paid_row(
        db, row, now,
        paid_by_machine_id=till.id, paid_by_name=till_label(till, pos_user_name),
        transaction_id=transaction_id, transaction_number=transaction_number,
        paid_at=_aware(paid_at) or now, bon_status=bon_status,
    )
    db.flush()
    _wake_tills(db, till, "kiosk_order_paid", skip=till.id)
    return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))


def cancel(
    db: Session, till: POSMachine, ref: str, *, reason: str, pos_user_name: Optional[str] = None, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """The cashier cancels it, with a reason: its vouchers go back. Idempotent once cancelled."""
    now = _now(now)
    _require_till(db, till)
    row = _find(db, till, ref)
    if row.open_state == CANCELLED:
        return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))
    if row.open_state != OPEN:
        raise OpenOrderRefused(409, CLOSED, state=row.open_state, paidBy=row.paid_by_name)
    if lock_active(row, now) and row.locked_by_machine_id != till.id:
        raise OpenOrderRefused(409, LOCKED, lockedBy=row.locked_by_name)
    _close(row, CANCELLED, now, reason=reason.strip(), by=till_label(till, pos_user_name))
    _give_back_vouchers(db, row)
    db.flush()
    logger.info("kiosk order %s cancelled at till %s: %s", row.local_id, till.id, reason.strip())
    _wake_tills(db, till, "kiosk_order_cancelled", skip=till.id)
    return order_out(row, till, now, _kiosk_names(db, [row.machine_id]).get(row.machine_id))


def counts_by_shop(db: Session, shop_ids: Iterable[Any], *, now: Optional[datetime] = None) -> Dict[Any, int]:
    """How many orders wait at each shop's tills (the dashboard, the kiosk card)."""
    now = _now(now)
    ids = [s for s in shop_ids if s is not None]
    if not ids:
        return {}
    out: Dict[Any, int] = {}
    for row in db.query(KioskOrder).filter(KioskOrder.shop_id.in_(ids), KioskOrder.open_state == OPEN).all():
        expires = _aware(row.expires_at)
        if expires is None or now < expires or lock_active(row, now):
            out[row.shop_id] = out.get(row.shop_id, 0) + 1
    return out
