"""
"מצב בדיקה" for a production voucher batch (P:/specs/voucher-test-mode.md, the owner 12.10.2026: "יהיה
ניתן לבדוק שהשוברים תקינים מבלי באמת לשרוף אותם, לממש או להיספר").

While a batch's `test_mode` is on, its **real** vouchers go through the whole redemption at any till,
kiosk or voucher station — and nothing happens to them:

* **Every check as for real.** Lookup, `/redeem` and `/reserve` run the core's own checks in their own
  order (`prepaid_vouchers.redeem_checks`, `reserve_discount_checks`, `production_voucher_reserve.
  goods_answer`): status, validity, shops, pauses, quotas, features, stacking, what is left, the units'
  values, the override — on the voucher's real balance. A voucher that is cancelled or expired is refused
  with the same reason; that is the point of the test.
* **Nothing consumed or counted.** No change to `remaining` / `uses_left` / `status`, no
  `prepaid_voucher_redemptions` row (what the reports, the board, the settlement, the Z and "כמה מתוך כמה"
  read), no `prepaid_voucher_reservations` row (what quotas and "in use" read), no stock. Instead one
  `prepaid_voucher_test_redemptions` row ("יומן בדיקות"): who, when, where, which voucher, what it would
  have covered and left. The answer is the normal one plus `testMode: true`, with a stable fake id
  "test-<row id>" in place of the redemption / reservation id; the same `clientRequestId` from the same
  till answers the same row (a hold's renewal re-runs the checks on it).
* **Never mixed with a real sale.** A test-mode voucher in a sale that holds a real voucher, or a real
  voucher in a sale that holds a test-mode one, is refused: 409 `prepaid_voucher_test_mixed` with
  [MIXED_MESSAGE]. (The till refuses paid lines too; the cloud cannot see those.)
* **When it applies.** A hold made before the flag went on is confirmed for real (its id is a real one);
  a scan after the flag went off is real. A test hold's confirm / release, and a reverse or an attach of a
  test redemption, are answered from the log ("test-…" ids). A sale document naming a "test-…" id is
  ignored for voucher accounting (app/services/transactions.py).
* **No test offline.** Test mode is refused while the batch is assigned to a device, and a batch in test
  mode is never assigned (`prepaid_voucher_test_mode_offline`).

Unrelated to the staff test batches ("שוברי בדיקה", `prepaid_voucher_test_batches`,
app/services/prepaid_voucher_controls.py): those are separate vouchers for tills in training mode.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherTestRedemption as T,
)
from app.models.shop import Shop
from app.models.user import User

#: The fake id a till gets for a test scan: "test-" + the log row's id.
FAKE_PREFIX = "test-"
OP_REDEEM, OP_RESERVE = "redeem", "reserve"
#: A test-mode voucher and a real one in one sale (either way round) — 409.
MIXED = "prepaid_voucher_test_mixed"
MIXED_MESSAGE = "לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו"
#: Test mode while the batch is assigned to a device offline, or an assignment while in test mode — 409.
TEST_MODE_OFFLINE = "prepaid_voucher_test_mode_offline"
#: A sale document (the outbox) naming a test hold: never confirmed — 409, the sync's warning.
TEST_DOCUMENT = "prepaid_voucher_test_mode_document"
#: A test scan in a sale: a redeem done, a hold held (until it expires) or confirmed.
_IN_SALE = ("done", "held", "confirmed")


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def in_test_mode(batch: Optional[PrepaidVoucherBatch]) -> bool:
    return bool(getattr(batch, "test_mode", False))


def is_fake(value) -> bool:
    """A test scan's id as the till holds it ("test-…")."""
    return isinstance(value, str) and value.strip().lower().startswith(FAKE_PREFIX)


def fake_id(row: T) -> str:
    return f"{FAKE_PREFIX}{row.id}"


def mixed() -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": MIXED, "message": MIXED_MESSAGE})


def prior(db: Session, machine: POSMachine, operation: str, request_id: str) -> Optional[T]:
    """This till's test scan of [operation] under [request_id] (a retry, a hold's renewal), or None."""
    return (
        db.query(T)
        .filter(T.machine_id == machine.id, T.operation == operation, T.client_request_id == request_id)
        .first()
    )


def _row_of(db: Session, machine: POSMachine, fake, *, lock: bool = False) -> Optional[T]:
    """The log row a "test-…" id names — this till's only."""
    PV = _pv()
    rid = PV._as_uuid(str(fake).strip()[len(FAKE_PREFIX):])
    if rid is None:
        return None
    q = db.query(T).filter(T.id == rid)
    if lock:
        q = q.populate_existing().with_for_update()
    row = q.first()
    if row is None or str(row.tenant_id) != str(machine.tenant_id) or row.machine_id != machine.id:
        return None
    return row


# ── The sale: never mixed, stacking among the test scans ──────────────────────


def _rows_in_sale(db: Session, machine: POSMachine, sale_ref: Optional[str], exclude_id=None) -> List[T]:
    """This till's test scans in the sale [sale_ref] that are still in it (a hold until it expires)."""
    sale = (sale_ref or "").strip()
    if not sale:
        return []
    PV = _pv()
    now = PV._now()
    rows = db.query(T).filter(T.machine_id == machine.id, T.sale_ref == sale, T.status.in_(_IN_SALE)).all()
    return [
        r for r in rows
        if r.id != exclude_id and not (r.status == "held" and r.expires_at is not None and PV._utc(r.expires_at) <= now)
    ]


def _reported_modes(db: Session, voucher: PrepaidVoucher, reported: Iterable) -> List[bool]:
    """Test mode of each other voucher the till says the sale holds (its batch), [voucher] left out."""
    PV = _pv()
    ids = set()
    for other in reported or ():
        if str(getattr(other, "voucher_id", "") or "") == str(voucher.id):
            continue
        bid = PV._as_uuid(getattr(other, "batch_id", None))
        if bid is not None:
            ids.add(bid)
    if not ids:
        return []
    return [bool(m) for (m,) in db.query(PrepaidVoucherBatch.test_mode).filter(PrepaidVoucherBatch.id.in_(ids))]


def check_mixed(
    db: Session, machine: POSMachine, voucher: PrepaidVoucher, sale_ref: Optional[str], reported: Iterable = (), *,
    test: bool = False, exclude_test=None, exclude_reservation=None,
) -> None:
    """
    Refuses (409 `prepaid_voucher_test_mixed`) a test scan ([test]) joining a sale that holds a real voucher
    (held, confirmed or redeemed towards it, or reported by the till), and a real redemption joining a sale
    that holds a test-mode voucher (this till's test scans in it, or reported). [test] is the path taken,
    not the batch's flag now: a hold made before the flag went on stays real.
    """
    PV = _pv()
    modes = _reported_modes(db, voucher, reported)
    if test:
        if any(m is False for m in modes):
            raise mixed()
        if sale_ref:
            real = [v for v in PV._vouchers_in_sale(db, machine, sale_ref, exclude_reservation=exclude_reservation)
                    if v.voucher_id != str(voucher.id)]
            if real:
                raise mixed()
        return
    if any(modes):
        raise mixed()
    if _rows_in_sale(db, machine, sale_ref, exclude_id=exclude_test):
        raise mixed()


def with_test_vouchers(db: Session, machine: POSMachine, sale_ref: Optional[str], others: List, *, exclude_id=None) -> List:
    """[others] (the sale's vouchers as the stacking rules see them) with this till's test scans in it — as
    real ones would be there; each voucher once."""
    PV = _pv()
    rows = _rows_in_sale(db, machine, sale_ref, exclude_id=exclude_id)
    seen = {o.voucher_id for o in others}
    out = list(others)
    ids = {r.voucher_id for r in rows if str(r.voucher_id) not in seen}
    if ids:
        for v in db.query(PrepaidVoucher).filter(PrepaidVoucher.id.in_(ids)):
            out.append(PV._in_sale(v))
    return out


# ── Till: redeem ──────────────────────────────────────────────────────────────


def _flush(db: Session) -> None:
    PV = _pv()
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        # Only (till, operation, request id) can collide: two copies of one request at once.
        raise PV._http(status.HTTP_409_CONFLICT, PV.REQUEST_CONFLICT)


def _base(machine: POSMachine, voucher: PrepaidVoucher, body, operation: str, sale_ref: Optional[str], now: datetime) -> T:
    pos_user_id = getattr(body, "pos_user_id", None)
    return T(
        id=uuid.uuid4(), tenant_id=voucher.tenant_id, batch_id=voucher.batch_id, voucher_id=voucher.id,
        serial=int(voucher.serial), machine_id=machine.id, shop_id=machine.shop_id,
        pos_user_id=(str(pos_user_id) if pos_user_id not in (None, "") else None),
        pos_user_name=(getattr(body, "pos_user_name", None) or None), operation=operation,
        client_request_id=body.client_request_id.strip(), sale_ref=sale_ref, created_at=now, updated_at=now,
    )


def redeem(db: Session, machine: POSMachine, body, voucher: PrepaidVoucher, prior_row: Optional[T]) -> Dict[str, Any]:
    """
    `/redeem` of a test-mode voucher: the core's checks (`redeem_checks`), then one log row — the voucher
    untouched. The reply is `/redeem`'s with `redemptionId` "test-…" and `testMode: true`. The caller has
    locked the sale and the voucher, and commits.
    """
    PV = _pv()
    if prior_row is not None:
        if prior_row.voucher_id != voucher.id:
            raise PV._http(status.HTTP_409_CONFLICT, PV.REQUEST_CONFLICT)
        return _redeem_out(db, machine, voucher, prior_row, replayed=True)
    plan = PV.redeem_checks(db, machine, body, voucher, test=True)
    now = PV._now()
    snap = PV.record_snapshot(db, machine, plan["batch"], voucher, plan["wanted"], features=getattr(body, "features", None))
    row = _base(machine, voucher, body, OP_REDEEM, plan["sale_ref"], now)
    row.status = "done"
    row.transaction_id = (getattr(body, "transaction_id", None) or None)
    row.items = plan["items"]
    row.forfeited = plan["forfeited"] or None
    row.units = snap["units"]
    row.covered_agorot = snap["covered_agorot"]
    row.value_agorot = snap["value_agorot"]
    row.top_up_agorot = snap["top_up_agorot"]
    row.list_value_agorot = snap["list_value_agorot"]
    row.redemption_accounting = snap["redemption_accounting"]
    row.remaining_after = {pid: PV.qty_out(q) for pid, q in plan["left"].items()}
    db.add(row)
    _flush(db)
    return _redeem_out(db, machine, voucher, row, replayed=False)


def _redeem_out(db: Session, machine: POSMachine, voucher: PrepaidVoucher, row: T, *, replayed: bool) -> Dict[str, Any]:
    PV = _pv()
    shaped = SimpleNamespace(id=fake_id(row), redeemed_at=row.created_at, items=row.items or [], forfeited=row.forfeited)
    out = PV._redeem_out(db, machine, voucher, shaped, replayed=replayed)
    out["testMode"] = True
    return out


# ── Till: reserve → confirm / release ─────────────────────────────────────────


def _as_hold(row: T) -> SimpleNamespace:
    """[row] as the core's reservation answers read a hold."""
    answer = row.answer or {}
    return SimpleNamespace(
        id=fake_id(row), status=row.status, expires_at=row.expires_at, uses=row.uses or 1,
        amount=row.discount_agorot if row.discount_agorot is not None else row.covered_agorot,
        transaction_id=row.transaction_id, goods=answer.get("goods"),
    )


def _reserve_out(db: Session, machine: POSMachine, voucher: PrepaidVoucher, row: T, *, replayed: bool) -> Dict[str, Any]:
    PV = _pv()
    hold = _as_hold(row)
    if hold.goods is not None:
        from app.services import production_voucher_reserve as PVRG

        out = PVRG.reservation_out(db, machine, voucher, hold, replayed=replayed)
    else:
        out = PV._reservation_out(db, machine, voucher, hold, replayed=replayed)
        answer = row.answer or {}
        for key in ("shares", "dropPromotion", "skipped"):
            if key in answer:
                out[key] = answer[key]
    out["testMode"] = True
    return out


def reserve(db: Session, machine: POSMachine, body, voucher: PrepaidVoucher, prior_row: Optional[T], now: datetime,
            sale_ref: str) -> Dict[str, Any]:
    """
    `/reserve` of a test-mode voucher: the core's checks for its kind, then one log row (a renewal with the
    same request id re-runs them on the same row) — nothing held, nothing counted. The reply is the hold's
    with `reservationId` "test-…" and `testMode: true`. The caller has locked the sale and the voucher.
    """
    PV = _pv()
    if prior_row is not None:
        if prior_row.voucher_id != voucher.id or (prior_row.sale_ref or "") != sale_ref:
            raise PV._http(status.HTTP_409_CONFLICT, PV.REQUEST_CONFLICT)
        if prior_row.status == "confirmed":
            return _reserve_out(db, machine, voucher, prior_row, replayed=True)
        if prior_row.status == "released":
            raise PV._http(status.HTTP_409_CONFLICT, PV.RESERVATION_RELEASED)
    exclude = prior_row.id if prior_row is not None else None
    row = prior_row if prior_row is not None else _base(machine, voucher, body, OP_RESERVE, sale_ref, now)
    batch = voucher.batch
    if PV.is_discount(batch):
        granted, result = PV.reserve_discount_checks(
            db, machine, body, voucher, now, sale_ref, test=True, exclude_test=exclude,
        )
        row.uses = granted
        row.discount_agorot = int(result.amount)
        row.items, row.units, row.forfeited = [], None, None
        row.covered_agorot = row.value_agorot = row.top_up_agorot = row.list_value_agorot = None
        row.redemption_accounting = "discount"
        row.remaining_after = {"uses": max(0, int(voucher.uses_left or 0) - granted)}
        row.answer = {
            "shares": dict(result.shares), "dropPromotion": list(result.drop_promotion),
            "skipped": [{"lineId": lid, "reason": why} for lid, why in result.skipped],
        }
    else:
        from app.services import production_voucher_reserve as PVRG

        answer = PVRG.goods_answer(db, machine, body, voucher, None, now, sale_ref, test=True, exclude_test=exclude)
        units = [dict(u) for u in answer.get("units") or []]
        row.items = [{"productId": u.get("productId"), "name": u.get("productName"), "quantity": u.get("quantity")} for u in units]
        row.forfeited = answer.get("forfeited") or None
        row.units = units
        row.covered_agorot = int(answer.get("coveredAgorot") or 0)
        row.value_agorot = int(answer.get("valueAgorot") or 0)
        row.top_up_agorot = int(answer.get("topUpAgorot") or 0)
        row.list_value_agorot = int(answer.get("listValueAgorot") or 0)
        row.redemption_accounting = answer.get("redemptionAccounting")
        row.uses, row.discount_agorot = 1, None
        row.remaining_after = _goods_left(voucher, units, answer.get("forfeited") or [])
        row.answer = {"goods": answer}
    row.status = "held"
    row.expires_at = now + PV.RESERVATION_TTL
    row.updated_at = now
    if prior_row is None:
        db.add(row)
    _flush(db)
    return _reserve_out(db, machine, voucher, row, replayed=prior_row is not None)


def _goods_left(voucher: PrepaidVoucher, units: List[Dict[str, Any]], forfeited: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What a goods voucher would keep after [units] (and what would be given up with them)."""
    PV = _pv()
    from app.services import production_voucher_reserve as PVRG

    remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
    grouped = (getattr(voucher.batch, "selection", None) or "items") == "groups"
    PVRG.take_units(remaining, [dict(u) for u in units], grouped)
    if not grouped:
        for f in forfeited:
            remaining[str(f.get("productId"))] = Decimal(0)
    return {k: PV.qty_out(max(Decimal(0), q)) for k, q in remaining.items()}


def confirm(db: Session, machine: POSMachine, reservation_id, transaction_id, amount_agorot: int,
            uses: Optional[int] = None, *, any_till: bool = False) -> Dict[str, Any]:
    """
    A test hold's "sale was written": its log line is marked confirmed — nothing taken, nothing recorded.
    Idempotent; another document id for a confirmed one is refused as for real. A sale document (the
    outbox, [any_till]) never confirms one.
    """
    PV = _pv()
    if any_till:
        raise PV._http(status.HTTP_409_CONFLICT, TEST_DOCUMENT)
    row = _row_of(db, machine, reservation_id, lock=True)
    if row is None or row.operation != OP_RESERVE:
        raise PV._http(status.HTTP_404_NOT_FOUND, PV.RESERVATION_NOT_FOUND)
    tx = str(transaction_id or "").strip()[:100] or None
    now = PV._now()
    if row.status == "confirmed":
        if row.transaction_id and tx and row.transaction_id != tx:
            raise PV._http(status.HTTP_409_CONFLICT, PV.RESERVATION_CONFLICT)
        return _confirm_out(row, replayed=True)
    late = row.status != "held" or (row.expires_at is not None and PV._utc(row.expires_at) <= now)
    row.status = "confirmed"
    row.transaction_id = tx
    row.confirmed_at = now
    row.updated_at = now
    row.answer = {**(row.answer or {}), "flags": ["late"] if late else []}
    db.flush()
    return _confirm_out(row, replayed=False)


def _confirm_out(row: T, *, replayed: bool) -> Dict[str, Any]:
    out = {
        "ok": True,
        "replayed": replayed,
        "reservationId": fake_id(row),
        "status": row.status,
        "transactionId": row.transaction_id,
        "redemptionId": fake_id(row),
        "flags": list((row.answer or {}).get("flags") or []),
        "testMode": True,
    }
    if row.discount_agorot is not None:
        out.update({"uses": int(row.uses or 1), "amountAgorot": int(row.discount_agorot)})
    else:
        out["coveredAgorot"] = int(row.covered_agorot or 0)
    return out


def release(db: Session, machine: POSMachine, reservation_id) -> Dict[str, Any]:
    """A test hold given back (removed, the test abandoned). Idempotent; a confirmed one stays confirmed."""
    PV = _pv()
    row = _row_of(db, machine, reservation_id, lock=True)
    if row is None or row.operation != OP_RESERVE:
        raise PV._http(status.HTTP_404_NOT_FOUND, PV.RESERVATION_NOT_FOUND)
    if row.status == "held":
        now = PV._now()
        row.status, row.released_at, row.updated_at = "released", now, now
        db.flush()
    return {"ok": True, "reservationId": fake_id(row), "status": row.status, "releasedAt": PV._iso(row.released_at),
            "testMode": True}


def reverse(db: Session, machine: POSMachine, redemption_id) -> Dict[str, Any]:
    """A test scan undone by the till (a kiosk order not paid …): marked on its log line. Idempotent."""
    PV = _pv()
    row = _row_of(db, machine, redemption_id, lock=True)
    if row is None:
        raise PV._http(status.HTTP_404_NOT_FOUND, "prepaid_redemption_not_found")
    if row.reversed_at is None:
        now = PV._now()
        row.status, row.reversed_at, row.updated_at = "reversed", now, now
        db.flush()
    return {"ok": True, "redemptionId": fake_id(row), "reversedAt": PV._iso(row.reversed_at), "testMode": True}


def attach(db: Session, machine: POSMachine, redemption_id, transaction_id: str) -> None:
    """The simulated sale's id on a test scan's log line (set once). Nothing else."""
    PV = _pv()
    row = _row_of(db, machine, redemption_id)
    if row is None:
        raise PV._http(status.HTTP_404_NOT_FOUND, "prepaid_redemption_not_found")
    if not row.transaction_id:
        row.transaction_id = str(transaction_id)[:100]
        db.flush()


# ── Dashboard: "יומן בדיקות" ──────────────────────────────────────────────────


def _left_out(batch: PrepaidVoucherBatch, left: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """What the voucher would have kept, named: a product's name, a group's, "total" / "uses" as such."""
    if not left:
        return []
    names = {str(i.product_id): i.product_name for i in batch.items}
    groups = {f"g:{g.get('key')}": g.get("name") for g in (batch.groups or []) if isinstance(g, dict)}
    out = []
    for key, q in left.items():
        out.append({"key": key, "name": names.get(key) or groups.get(key), "quantity": q})
    return out


def _shekels(v: Optional[int]) -> Optional[float]:
    return None if v is None else round(int(v) / 100, 2)


def row_out(r: T, batch: PrepaidVoucherBatch, machines: Dict[str, str], shops: Dict[str, str]) -> Dict[str, Any]:
    PV = _pv()
    return {
        "id": fake_id(r),
        "operation": r.operation,
        "status": r.status,
        "at": PV._iso(r.created_at),
        "confirmedAt": PV._iso(r.confirmed_at),
        "releasedAt": PV._iso(r.released_at),
        "reversedAt": PV._iso(r.reversed_at),
        "machineId": str(r.machine_id) if r.machine_id else None,
        "machineName": machines.get(str(r.machine_id)) if r.machine_id else None,
        "shopId": str(r.shop_id) if r.shop_id else None,
        "shopName": shops.get(str(r.shop_id)) if r.shop_id else None,
        "posUserId": r.pos_user_id,
        "posUserName": r.pos_user_name,
        "voucherId": str(r.voucher_id),
        "serial": r.serial,
        "saleRef": r.sale_ref,
        "items": list(r.items or []),
        "forfeited": list(r.forfeited or []),
        "units": list(r.units or []),
        "accounting": r.redemption_accounting,
        # ₪: what the voucher would have covered, its value, the customer's top-up; a discount's ₪ and uses.
        "covered": _shekels(r.covered_agorot),
        "value": _shekels(r.value_agorot),
        "topUp": _shekels(r.top_up_agorot),
        "listValue": _shekels(r.list_value_agorot),
        "discount": _shekels(r.discount_agorot),
        "uses": r.uses,
        "remainingAfter": _left_out(batch, r.remaining_after),
    }


def batch_log(db: Session, user: User, tenant_id, batch_id, *, limit: int = 500) -> Dict[str, Any]:
    """The batch's test scans, newest first, for whoever manages the batch (its view)."""
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    q = db.query(T).filter(T.batch_id == batch.id)
    total = q.count()
    rows = q.order_by(T.created_at.desc()).limit(max(1, min(int(limit), 2000))).all()
    machine_ids = {r.machine_id for r in rows if r.machine_id}
    shop_ids = {r.shop_id for r in rows if r.shop_id}
    machines = (
        {str(i): n for i, n in db.query(POSMachine.id, POSMachine.name).filter(POSMachine.id.in_(machine_ids))}
        if machine_ids else {}
    )
    shops = {str(i): n for i, n in db.query(Shop.id, Shop.name).filter(Shop.id.in_(shop_ids))} if shop_ids else {}
    return {
        "batchId": str(batch.id),
        "testMode": bool(batch.test_mode),
        "testModeSince": PV._iso(batch.test_mode_since),
        "testModeBy": batch.test_mode_by,
        "total": total,
        "items": [row_out(r, batch, machines, shops) for r in rows],
    }
