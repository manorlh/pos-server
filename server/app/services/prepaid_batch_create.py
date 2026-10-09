"""
"הנפקת אצווה" exactly once — POST /prepaid-vouchers/batches.

The owner's report: "הנפקנו 50 שוברים וזה הראה שגיאה, ניסינו שוב והסתדר". The first request had
made the batch; its answer never reached the dashboard (a dropped connection, a proxy reset, a
machine that was starting), so the second click made a second batch with other codes.

* **One transaction.** The batch, its type (a one-off), its vouchers, groups and serials, its
  audit line, the idempotency key and the answer itself are written and read in one transaction,
  committed once, at the end. The answer is built BEFORE the commit: nothing after the commit
  can fail the request and leave a batch the dashboard was told failed. Any failure on the way
  rolls everything back — no batch, no vouchers, no key.
* **Idempotent.** The dashboard sends an `Idempotency-Key` per form submission
  (app/services/command_idempotency.py, kind `prepaid_batch_create`; the key is the tenant's,
  checked against the user and the request's fingerprint). A retry with the same key — after a
  timeout, a network error, "נסה שוב" — gets the SAME batch back (200, `Idempotent-Replayed`),
  never a second one; the same key with another body → 422 `idempotency_key_reused`. The key row
  is claimed before the vouchers are made, so a retry that arrives while the first request still
  runs waits for it and answers with its batch.
* **A safety net** for what the key cannot catch (an old dashboard without keys, a page reloaded
  between the two clicks): a new batch identical to one the same user made in the last
  [DUPLICATE_WINDOW] — same company, name, customer, event, count, goods, terms and prices, not
  cancelled — answers with `possibleDuplicate` (that earlier batch), and the dashboard offers to
  cancel it ("נראה שאצווה זהה נוצרה לפני רגע — לבטל את הכפולה?"). Never blocks.
* **"הוסף שוברים"** (POST /prepaid-vouchers/batches/{id}/vouchers, `add`) the same way: one
  transaction with the answer built before the commit, and an `Idempotency-Key` of kind
  `prepaid_batch_add` (the batch id is part of the fingerprint) — a retry adds once.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, Optional, Tuple

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.user import User
from app.services import command_idempotency as idem
from app.services import prepaid_vouchers as PV

KIND = "prepaid_batch_create"
#: How far back an identical batch of the same user counts as "made a moment ago".
DUPLICATE_WINDOW = timedelta(minutes=2)
#: The reason the dashboard's "בטל את הכפולה" sends with the existing cancel (POST …/cancel).
DUPLICATE_CANCEL_REASON = "אצווה כפולה — נוצרה פעמיים בטעות"


def request_of(body) -> Dict[str, Any]:
    """What the key's fingerprint is taken of: the body as parsed (camelCase, JSON types)."""
    return body.model_dump(mode="json", by_alias=True)


def _signature(batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    """What makes two batches "the same": who and what for, how many, the goods, terms and prices."""
    return {
        "companyId": str(batch.company_id),
        "name": (batch.name or "").strip(),
        "customerName": (batch.customer_name or "").strip(),
        "eventName": (batch.event_name or "").strip(),
        "orderRef": (batch.order_ref or "").strip(),
        "shopIds": sorted(str(s) for s in (batch.shop_ids or [])),
        "count": int(batch.next_serial or 1) - 1,
        "groupSize": batch.group_size,
        "validFrom": PV._iso(batch.valid_from),
        "validUntil": PV._iso(batch.valid_until),
        "items": [(str(i.product_id), PV.qty_out(i.quantity)) for i in batch.items],
        "terms": PV.terms_out(batch),
        "tillValue": batch.till_value,
        "productionPrice": batch.production_price,
        "pricing": batch.pricing,
        "splitAllowed": bool(batch.split_allowed),
        "includeExtras": bool(batch.include_extras),
        "productionId": str(batch.production_id) if batch.production_id else None,
        "reportEventId": str(batch.report_event_id) if batch.report_event_id else None,
    }


def duplicate_of(db: Session, user: User, batch: PrepaidVoucherBatch) -> Optional[PrepaidVoucherBatch]:
    """The newest batch the same user made in the last DUPLICATE_WINDOW that this one repeats."""
    if getattr(user, "id", None) is None:
        return None
    now = PV._now()
    cutoff = now - DUPLICATE_WINDOW
    candidates = (
        db.query(PrepaidVoucherBatch)
        .filter(
            PrepaidVoucherBatch.tenant_id == batch.tenant_id,
            PrepaidVoucherBatch.created_by == user.id,
            PrepaidVoucherBatch.company_id == batch.company_id,
            PrepaidVoucherBatch.name == batch.name,
            PrepaidVoucherBatch.status != "cancelled",
            PrepaidVoucherBatch.id != batch.id,
            PrepaidVoucherBatch.created_at >= cutoff,
        )
        .order_by(PrepaidVoucherBatch.created_at.desc())
        .limit(5)
        .all()
    )
    mine = _signature(batch)
    for other in candidates:
        made = PV._utc(other.created_at)
        if made is not None and made >= cutoff and _signature(other) == mine:
            return other
    return None


def duplicate_ref(other: PrepaidVoucherBatch) -> Dict[str, Any]:
    return {
        "id": str(other.id),
        "name": other.name,
        "customerName": other.customer_name,
        "count": int(other.next_serial or 1) - 1,
        "createdAt": PV._iso(other.created_at),
        "cancelReason": DUPLICATE_CANCEL_REASON,
    }


def create(db: Session, user: User, tenant_id, body, key: Optional[str] = None) -> Tuple[Dict[str, Any], bool]:
    """
    The batch and its answer, committed once — or nothing. Returns (answer, replayed): replayed is
    True when [key] already made a batch, and the answer is that batch as it is now.
    """

    def run() -> Dict[str, Any]:
        batch = PV.create_batch(db, user, tenant_id, body)
        out = PV.batch_out(db, batch, user=user)
        twin = duplicate_of(db, user, batch)
        out["possibleDuplicate"] = duplicate_ref(twin) if twin is not None else None
        return jsonable_encoder(out)

    def reread(first: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not first or not first.get("id"):
            return first
        fresh = PV.batch_out(db, PV.get_batch(db, user, tenant_id, first["id"]), user=user)
        # The first answer's warning still stands: the retry may be the first answer the
        # dashboard ever sees.
        fresh["possibleDuplicate"] = first.get("possibleDuplicate")
        return jsonable_encoder(fresh)

    try:
        return idem.once(
            db, tenant_id=tenant_id, kind=KIND, key=key, user=user, request=request_of(body),
            run=run, refresh=reread, status_code=201, claim_first=True,
        )
    except BaseException:
        # Nothing of a failed creation survives in this session: no batch, no vouchers, no key.
        db.rollback()
        raise


# ── "הוסף שוברים" — more vouchers for an existing batch, exactly once ─────────────────────────

ADD_KIND = "prepaid_batch_add"


def add_request_of(batch_id, body) -> Dict[str, Any]:
    """The fingerprint of an add: the batch it is for, and the body (a key is never another batch's)."""
    return {"batchId": str(PV._as_uuid(batch_id) or batch_id), **body.model_dump(mode="json", by_alias=True)}


def add(db: Session, user: User, tenant_id, batch_id, body, key: Optional[str] = None) -> Tuple[Dict[str, Any], bool]:
    """
    POST /prepaid-vouchers/batches/{id}/vouchers: the vouchers, their serials and groups, the audit
    line, the key and the answer in one transaction, committed once — or nothing. A retry with the
    same key (a lost answer) gets the batch back without adding again (replayed True); the same key
    with another count, group size or batch → 422.
    """

    def run() -> Dict[str, Any]:
        batch = PV.add_vouchers(db, user, tenant_id, batch_id, body.count, body.group_size)
        return jsonable_encoder(PV.batch_out(db, batch, user=user))

    def reread(first: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not first or not first.get("id"):
            return first
        return jsonable_encoder(PV.batch_out(db, PV.get_batch(db, user, tenant_id, first["id"]), user=user))

    try:
        return idem.once(
            db, tenant_id=tenant_id, kind=ADD_KIND, key=key, user=user, request=add_request_of(batch_id, body),
            run=run, refresh=reread, status_code=201, claim_first=True,
        )
    except BaseException:
        # Nothing of a failed add survives in this session: no vouchers, no serials, no key.
        db.rollback()
        raise
