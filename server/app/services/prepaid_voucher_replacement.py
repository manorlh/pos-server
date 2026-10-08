"""
Production vouchers — a replacement voucher linked to its original (the spec's §16).

A voucher lost, damaged or cancelled may be replaced by a manager, with a reason:

* the original is cancelled at once (refused at every till from now on, "השובר בוטל"), and stays
  linked to its replacement for ever (`prepaid_voucher_replacements`, one replacement per original);
* the replacement is a new voucher **of the same batch** (the next serial, a new unguessable code) —
  so it inherits every condition of the original: type and version, prices, validity, shops,
  stacking, accounting; and what the original had **left**: its remaining goods / uses, or an explicit
  part of them the manager names (a package partly taken is never made whole again by itself);
* a fixed-value voucher already redeemed in part is not replaced (`…_partly_valued`): its value left is
  counted from its own redemptions, so a new voucher would get the whole value again;
* nothing is replaced while the original is held by an open sale (a reservation not yet confirmed or
  released) — that sale is cleared first (§16: "אין … להנפיק חלופה לפני בירור תוצאת הפעולות");
* a voucher already used up has nothing to replace; a replacement can itself be replaced (the chain);
* the settlement counts an original and its replacement as one voucher unless the agreement says
  otherwise (`replacementPolicy`, app/services/prepaid_voucher_settlement.py).

Both the batch's audit trail (`replace_voucher`) and the helper's (`replace`) record who, when, why,
and the before / after. Needs the `prepaid_voucher_controls` section (edit).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import status
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.models.prepaid_voucher_extras import REPLACEMENT_REASONS, PrepaidVoucherReplacement
from app.models.user import User
from app.services import prepaid_voucher_extras_access as ACC

ALREADY_REPLACED = "prepaid_voucher_already_replaced"
NOTHING_TO_REPLACE = "prepaid_voucher_nothing_to_replace"
BAD_REASON = "prepaid_voucher_replacement_bad_reason"
BAD_ITEMS = "prepaid_voucher_replacement_bad_items"
IN_USE = "prepaid_voucher_in_use"
BATCH_CANCELLED = "prepaid_voucher_batch_cancelled"
#: A fixed-value voucher already redeemed in part: what is left of its value is counted from its own
#: redemptions (the core's `value_left`), so a new voucher would start from the whole value again.
PARTLY_VALUED = "prepaid_voucher_replacement_partly_valued"

REASON_TEXT = {"lost": "אבד", "damaged": "ניזוק", "cancelled": "בוטל", "other": "אחר"}


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _what_left(voucher: PrepaidVoucher, batch: PrepaidVoucherBatch) -> bool:
    PV = _pv()
    if PV.is_discount(batch):
        return int(voucher.uses_left or 0) > 0
    return any(PV.qty(q) > 0 for q in (voucher.remaining or {}).values())


def replace_voucher(db: Session, user: User, tenant_id, voucher_id, body) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    if body.reason_kind not in REPLACEMENT_REASONS:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_REASON)
    reason = (body.reason or "").strip()
    if len(reason) < 2:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_REASON)
    original = PV.get_voucher(db, user, tenant_id, voucher_id)
    # The batch first, then the voucher — the order the core's issue takes.
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == original.batch_id).with_for_update().first()
    original = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == original.id).with_for_update().first()
    if batch.status == "cancelled":
        raise ACC.http(status.HTTP_409_CONFLICT, BATCH_CANCELLED)
    if db.query(PrepaidVoucherReplacement.id).filter(PrepaidVoucherReplacement.original_voucher_id == original.id).first():
        raise ACC.http(status.HTTP_409_CONFLICT, ALREADY_REPLACED)
    if not _what_left(original, batch):
        raise ACC.http(status.HTTP_409_CONFLICT, NOTHING_TO_REPLACE)
    if (getattr(batch, "pricing", None) or "cover") == "fixed" and getattr(batch, "till_value", None) and db.query(
        PrepaidVoucherRedemption.id
    ).filter(PrepaidVoucherRedemption.voucher_id == original.id, PrepaidVoucherRedemption.reversed_at.is_(None)).first():
        raise ACC.http(status.HTTP_409_CONFLICT, PARTLY_VALUED)
    now = _now()
    held = [
        r for r in db.query(PrepaidVoucherReservation).filter(
            PrepaidVoucherReservation.voucher_id == original.id, PrepaidVoucherReservation.status == "held"
        )
        if PV._reservation_live(r, now)
    ]
    if held:
        raise ACC.http(status.HTTP_409_CONFLICT, IN_USE)

    discount = PV.is_discount(batch)
    left = {k: PV.qty(v) for k, v in (original.remaining or {}).items()}
    if discount:
        remaining: Dict[str, Any] = {}
        uses = int(original.uses_left or 0)
        if body.uses is not None:
            if int(body.uses) > uses:
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_ITEMS)
            uses = int(body.uses)
    else:
        uses = None
        if body.items is not None:
            given: Dict[str, Decimal] = {}
            for item in body.items:
                pid = str(item.product_id)
                if pid not in left or PV.qty(item.quantity) > left[pid]:
                    raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_ITEMS)
                given[pid] = given.get(pid, Decimal(0)) + PV.qty(item.quantity)
            if any(given.get(pid, Decimal(0)) > q for pid, q in left.items()) or not any(q > 0 for q in given.values()):
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_ITEMS)
            remaining = {pid: PV.qty_out(given.get(pid, Decimal(0))) for pid in left}
        else:
            remaining = {pid: PV.qty_out(q) for pid, q in left.items()}

    serial = int(batch.next_serial or 1)
    batch.next_serial = serial + 1
    code = PV._unique_codes(db, 1)[0]
    replacement = PrepaidVoucher(
        id=uuid.uuid4(), tenant_id=original.tenant_id, batch_id=batch.id, serial=serial, group_no=None,
        code=code, remaining=remaining, uses_left=uses, status="active",
        note=f"שובר חלופי לשובר #{int(original.serial)}",
    )
    before = {"status": original.status, "remaining": original.remaining, "usesLeft": original.uses_left}
    if original.status != "cancelled":
        original.status = "cancelled"
        original.cancelled_at = now
    original.updated_at = now
    db.add(replacement)
    db.flush()
    link = PrepaidVoucherReplacement(
        id=uuid.uuid4(), tenant_id=original.tenant_id, batch_id=batch.id, original_voucher_id=original.id,
        replacement_voucher_id=replacement.id, reason_kind=body.reason_kind, reason=reason,
        original_status=before["status"],
        details={"originalSerial": int(original.serial), "replacementSerial": serial, "before": before,
                 "given": {"remaining": remaining, "usesLeft": uses}},
        user_id=user.id, user_name=ACC.user_name(user), created_at=now,
    )
    db.add(link)
    PV._event(
        db, batch, user, "replace_voucher", group_no=original.group_no, voucher_id=original.id, count=1,
        reason=f"{REASON_TEXT.get(body.reason_kind, body.reason_kind)}: {reason}",
        details={"originalSerial": int(original.serial), "replacementSerial": serial,
                 "replacementId": str(replacement.id), "reasonKind": body.reason_kind},
    )
    ACC.audit(db, tenant_id, "replace", user, ref_id=original.id, batch_id=batch.id, reason=reason,
              details={"reasonKind": body.reason_kind, "originalSerial": int(original.serial),
                       "replacementSerial": serial, "replacementId": str(replacement.id), "before": before})
    db.flush()
    return {
        "replacement": replacement_out(link, original, replacement),
        "original": PV.voucher_out(db, original),
        "voucher": PV.voucher_out(db, replacement),
    }


def replacement_out(link: PrepaidVoucherReplacement, original=None, replacement=None) -> Dict[str, Any]:
    PV = _pv()
    return {
        "id": str(link.id),
        "batchId": str(link.batch_id),
        "originalId": str(link.original_voucher_id),
        "originalSerial": int(original.serial) if original is not None else (link.details or {}).get("originalSerial"),
        "replacementId": str(link.replacement_voucher_id),
        "replacementSerial": int(replacement.serial) if replacement is not None else (link.details or {}).get("replacementSerial"),
        "replacementStatus": replacement.status if replacement is not None else None,
        "reasonKind": link.reason_kind,
        "reasonText": REASON_TEXT.get(link.reason_kind, link.reason_kind),
        "reason": link.reason,
        "originalStatus": link.original_status,
        "userName": link.user_name,
        "createdAt": PV._iso(link.created_at),
    }


def voucher_chain(db: Session, user: User, tenant_id, voucher_id) -> Dict[str, Any]:
    """The voucher's replacement links both ways: what it replaced, what replaced it, the whole chain."""
    PV = _pv()
    voucher = PV.get_voucher(db, user, tenant_id, voucher_id)
    R = PrepaidVoucherReplacement
    links = {str(r.original_voucher_id): r for r in db.query(R).filter(R.batch_id == voucher.batch_id)}
    back = {str(r.replacement_voucher_id): str(r.original_voucher_id) for r in links.values()}
    root = str(voucher.id)
    seen = set()
    while root in back and root not in seen:
        seen.add(root)
        root = back[root]
    chain: List[str] = []
    cur: Optional[str] = root
    while cur is not None and cur not in chain:
        chain.append(cur)
        cur = str(links[cur].replacement_voucher_id) if cur in links else None
    vs = {str(v.id): v for v in db.query(PrepaidVoucher).filter(PrepaidVoucher.id.in_([uuid.UUID(c) for c in chain]))}
    return {
        "voucherId": str(voucher.id),
        "chain": [
            {"voucherId": c, "serial": int(vs[c].serial) if c in vs else None, "status": vs[c].status if c in vs else None,
             "replacedBy": replacement_out(links[c], vs.get(c), vs.get(str(links[c].replacement_voucher_id)))
             if c in links else None}
            for c in chain
        ],
        "replacedBy": replacement_out(links[str(voucher.id)]) if str(voucher.id) in links else None,
        "replaces": back.get(str(voucher.id)),
    }


def list_replacements(db: Session, user: User, tenant_id, *, batch_ids=None, limit: int = 500) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
    R = PrepaidVoucherReplacement
    q = db.query(R).filter(R.tenant_id == tenant_id)
    if batch_ids is not None:
        q = q.filter(R.batch_id.in_(list(batch_ids) or [uuid.uuid4()]))
    rows = q.order_by(R.created_at.desc()).limit(max(1, min(int(limit), 5000))).all()
    batches = {str(b.id): b for b in db.query(PrepaidVoucherBatch).filter(
        PrepaidVoucherBatch.id.in_({r.batch_id for r in rows} or {uuid.uuid4()}))}
    ids = {r.original_voucher_id for r in rows} | {r.replacement_voucher_id for r in rows}
    vs = {str(v.id): v for v in db.query(PrepaidVoucher).filter(PrepaidVoucher.id.in_(ids or {uuid.uuid4()}))}
    out = []
    for r in rows:
        b = batches.get(str(r.batch_id))
        if b is None or not PV.may_manage(db, user, tenant_id, b):
            continue
        item = replacement_out(r, vs.get(str(r.original_voucher_id)), vs.get(str(r.replacement_voucher_id)))
        item["batchName"] = b.name
        out.append(item)
    return {"items": out, "editable": ACC.allows(db, user, ACC.CONTROLS_SECTION, "edit")}
