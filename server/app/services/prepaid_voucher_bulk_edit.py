"""
"שינוי הגדרות לסדרות שנבחרו" — the same change for many production-voucher batches at once.

The owner: "בחירה של מספר סדרות ושינוי של ההגדרות על כל הסדרות". Nothing here decides anything
about a batch: each one goes through "ערוך סדרה" (app/services/prepaid_voucher_edit.py) exactly as
`PATCH /prepaid-vouchers/batches/{id}` does — its permission (`get_batch`: the tenant, the company or
the shops the user manages), its checks, the rules for the vouchers already issued, its log line.

* **Only what was sent changes** — `changes` is the single edit's body; the fields allowed here are
  `BULK_EDIT_FIELDS` (app/schemas/prepaid_voucher.py): the rules, validity, where, the accounting and
  the print settings — never a batch's identity, goods, discount, count or production price.
* **Each batch on its own** — a batch the edit refuses (another tenant's, one the user may not edit,
  a cancelled one, a rule of the single edit) is reported with the single edit's reason and never
  stops the others. A field that is not the batch's kind (`splitAllowed` on a discount, a discount's
  uses on goods, `totalQty` on a batch without groups) refuses the batch
  (`prepaid_voucher_bulk_not_applicable`), never silently does nothing.
* **The preview is the apply** — both run the single edit's plan on each batch; the preview writes
  nothing, the apply writes each batch in a savepoint of its own (a batch is written whole or not at
  all) and commits once with its `clientRequestId` (app/services/command_idempotency.py, kind
  `prepaid_batch_bulk_edit`): a retry answers the first result and never applies anything again.
* **Audit** — each batch's "update" line is the single edit's, with `details.bulk`
  (`{requestId, batches}`) saying it was part of a bulk edit.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.user import User
from app.schemas.prepaid_voucher import PrepaidBatchBulkEditIn, PrepaidVoucherBatchUpdate
from app.services import command_idempotency as idem
from app.services import prepaid_vouchers as PV

logger = logging.getLogger(__name__)

KIND = "prepaid_batch_bulk_edit"
NOT_APPLICABLE = "prepaid_voucher_bulk_not_applicable"
REQUEST_ID_REQUIRED = "prepaid_voucher_bulk_request_id_required"
FAILED = "prepaid_voucher_bulk_failed"

OK, UNCHANGED, REFUSED, APPLIED = "ok", "unchanged", "refused", "applied"

#: Settings that are only some batches': a goods batch's pricing and accounting (a discount is a
#: discount on the document), a discount's uses, a package's groups.
_GOODS_ONLY = (
    "split_allowed", "include_extras", "pricing", "till_value", "allow_top_up", "print_till_value",
    "redemption_accounting", "discount_block_policy",
)
_DISCOUNT_ONLY = ("promotion_policy", "max_uses_per_sale", "max_uses_per_day")
_GROUPS_ONLY = ("total_qty", "groups")


def _wire(attr: str) -> str:
    return PrepaidVoucherBatchUpdate.model_fields[attr].alias or attr


def requested(changes: PrepaidVoucherBatchUpdate) -> List[str]:
    """The settings [changes] sends, by their wire names."""
    return sorted(_wire(f) for f in set(changes.model_fields_set) - {"apply_to_partial"})


def not_applicable(batch: PrepaidVoucherBatch, changes: PrepaidVoucherBatchUpdate) -> List[str]:
    """The settings of [changes] that [batch]'s kind does not have (wire names); empty: all apply."""
    given = set(changes.model_fields_set)
    discount = PV.is_discount(batch)
    groups = not discount and (batch.selection or "items") == "groups"
    out = set()
    if discount:
        out |= given & set(_GOODS_ONLY)
    else:
        out |= given & set(_DISCOUNT_ONLY)
    if not groups:
        out |= given & set(_GROUPS_ONLY)
    return sorted(_wire(f) for f in out)


def _ident(batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    return {
        "name": batch.name,
        "customerName": batch.customer_name,
        "eventName": batch.event_name,
        "kind": batch.kind or "items",
    }


def _reason(exc: HTTPException) -> Tuple[str, Optional[str]]:
    """The single edit's refusal as (code, message): its detail is a code, a sentence or {code, message}."""
    detail = exc.detail
    if isinstance(detail, dict):
        return str(detail.get("code") or exc.status_code), detail.get("message")
    return str(detail), None


def _refused(batch_id: str, ident: Optional[Dict[str, Any]], code: str, message: Optional[str] = None,
             status_code: Optional[int] = None, fields: Optional[List[str]] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"batchId": batch_id, **(ident or {"name": None}), "status": REFUSED, "reason": code}
    if message:
        out["message"] = message
    if status_code:
        out["statusCode"] = status_code
    if fields:
        out["fields"] = fields
    return out


def _outcome(batch_id: str, ident: Dict[str, Any], plan: Dict[str, Any], asked: List[str], done: str) -> Dict[str, Any]:
    changed = [c["field"] for c in plan.get("changes") or []]
    return {
        "batchId": batch_id,
        **ident,
        "status": done if changed else UNCHANGED,
        "changes": plan.get("changes") or [],
        "effects": plan.get("effects") or {},
        "confirm": bool(plan.get("confirm")),
        # Sent, yet the same after (already so, or the single edit's own rule — "שובר אחד בעסקה" has no maximum).
        "unchangedFields": [f for f in asked if f not in changed],
    }


def _each(
    db: Session, user: User, tenant_id, batch_id: str, changes: PrepaidVoucherBatchUpdate,
    step: Callable[[PrepaidVoucherBatchUpdate], Dict[str, Any]], *, keep: bool, done: str,
) -> Dict[str, Any]:
    """One batch in a savepoint of its own: kept ([keep]) when the edit went through, else rolled back."""
    asked = requested(changes)
    ident: Optional[Dict[str, Any]] = None
    savepoint = db.begin_nested()
    try:
        batch = PV.get_batch(db, user, tenant_id, batch_id)  # the tenant, then may_manage: else 404 / 403
        ident = _ident(batch)
        other = not_applicable(batch, changes)
        if other:
            savepoint.rollback()
            return _refused(batch_id, ident, NOT_APPLICABLE, status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, fields=other)
        plan = step(changes.model_copy(deep=True))
        out = _outcome(batch_id, ident, plan, asked, done)
    except HTTPException as exc:
        savepoint.rollback()
        code, message = _reason(exc)
        return _refused(batch_id, ident, code, message, exc.status_code)
    except Exception:  # noqa: BLE001 - one batch's failure is that batch's, reported, never the others'
        savepoint.rollback()
        logger.exception("bulk batch edit: batch %s failed", batch_id)
        return _refused(batch_id, ident, FAILED, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)
    if keep:
        savepoint.commit()
    else:
        savepoint.rollback()
    return out


def _summary(items: List[Dict[str, Any]], done: str) -> Dict[str, int]:
    out = {"total": len(items), done: 0, UNCHANGED: 0, REFUSED: 0}
    for it in items:
        out[it["status"]] = out.get(it["status"], 0) + 1
    return out


def preview(db: Session, user: User, tenant_id, body: PrepaidBatchBulkEditIn) -> Dict[str, Any]:
    """Per batch: ok (its changes and effects, as the single preview's) / unchanged / refused (the reason). Nothing written."""
    PV._require_role(user)
    changes = body.changes
    items = [
        _each(db, user, tenant_id, bid, changes,
              lambda c, bid=bid: PV.preview_batch_edit(db, user, tenant_id, bid, c), keep=False, done=OK)
        for bid in body.batch_ids
    ]
    db.rollback()
    return jsonable_encoder({"items": items, "summary": _summary(items, OK), "fields": requested(changes)})


def _request(body: PrepaidBatchBulkEditIn) -> Dict[str, Any]:
    return {
        "batchIds": list(body.batch_ids),
        "changes": body.changes.model_dump(mode="json", by_alias=True, exclude_unset=True),
    }


def apply(db: Session, user: User, tenant_id, body: PrepaidBatchBulkEditIn) -> Tuple[Dict[str, Any], bool]:
    """
    Each batch through the single edit (`PV.edit_batch`), in its own savepoint; one commit with the
    request's key. Returns (result, replayed): a retry with the same `clientRequestId` gets the first
    result and `replayed` True — nothing is applied again.
    """
    PV._require_role(user)
    key = idem.normalize(body.client_request_id)
    if key is None:
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, REQUEST_ID_REQUIRED)
    changes = body.changes
    marker = {"requestId": key, "batches": len(body.batch_ids)}

    def run() -> Dict[str, Any]:
        items = [
            _each(db, user, tenant_id, bid, changes,
                  lambda c, bid=bid: PV.edit_batch(db, user, tenant_id, bid, c, bulk=marker)[1], keep=True, done=APPLIED)
            for bid in body.batch_ids
        ]
        return jsonable_encoder({
            "items": items, "summary": _summary(items, APPLIED), "fields": requested(changes), "clientRequestId": key,
        })

    return idem.once(
        db, tenant_id=tenant_id, kind=KIND, key=key, user=user, request=_request(body), run=run,
        status_code=200, claim_first=True,
    )
