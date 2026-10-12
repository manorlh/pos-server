"""
"שכפול סדרה" — POST /prepaid-vouchers/batches/{id}/duplicate (P:/specs/voucher-batch-duplicate.md).

The owner: "בענן, בשוברי הפקה, תאפשר לשכפל סדרה לעוד שוברים ולערוך את השם". A new batch with every
term of the source and [count] new vouchers, new codes, serials from 1.

* **The same create path.** The source's stored terms become a `PrepaidVoucherBatchCreate`, and
  that body goes through `create_batch` exactly as a new batch from the form does: every check
  (products still usable, groups against today's catalog, prices, shops), the numbering, the
  groups frozen again by TODAY's catalog ("תוכן הקבוצות לפי הקטלוג הנוכחי"), and the permissions —
  the source must be the user's to manage, and the new batch the user's to make (a shop manager:
  their shops only; a production price or an override policy: their sections).
* **The voucher type.** A batch issued from a type ("סוג שובר") whose terms are still that type's
  current terms is issued from the same type again (its name printed above the title, its
  version). One whose terms moved on — edited after issue, or the type has a newer version — is
  issued with its own terms, as a batch made without a type (a type of its own).
* **What is copied:** the kind, the goods or the groups and their total, the discount and its
  targets, stacking and the maximum per sale, uses per voucher / per sale / per day, one sale or
  in parts, "כולל תוספות", the shops, the catalog mode, the pricing, the till value and the
  production price, how a redemption is booked, the discount-block policy, offline, the print
  settings (texts, logo, barcode, what is shown), the group size, the order ref, and the
  distribution's message texts and layout. The dialog may set the validity, the production
  ("עבור מי"), the event and its printed name.
* **What never is:** the vouchers, codes, redemptions, reservations, the test log, settlement and
  invoices, deliveries, the distribution's recipients and history, the controls (pauses, quotas),
  the cancelled status, and test mode (unless `startInTestMode`).
* **The link** is kept on both audit trails, no migration: `duplicated_from` on the new batch,
  `duplicated_to` on the source, each with the other's id and name.
* **Exactly once.** As batch create: one transaction, the answer built before the one commit, and an
  `Idempotency-Key` (or the body's `clientRequestId`) of kind `prepaid_batch_duplicate` — a retry
  gets the same new batch back, never a second one; the same key with another body or source → 422.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch, PrepaidVoucherType
from app.models.user import User
from app.schemas.prepaid_voucher import PrepaidBatchDuplicateIn, PrepaidVoucherBatchCreate
from app.services import command_idempotency as idem
from app.services import prepaid_batch_create as PBC
from app.services import prepaid_voucher_rules as RULES
from app.services import prepaid_vouchers as PV

KIND = "prepaid_batch_duplicate"
#: The audit lines that keep the link (no migration): on the new batch, and on the source.
FROM_ACTION = "duplicated_from"
TO_ACTION = "duplicated_to"


def _shekels(stored: Optional[int]) -> Optional[Decimal]:
    """Agorot (or basis points) as stored → ₪ (or %) as a create body says them."""
    return None if stored is None else Decimal(int(stored)) / 100


def _ids(values) -> List[str]:
    return [str(v) for v in (values or [])]


# ── The source's terms ────────────────────────────────────────────────────────


def _effective_terms(h, items) -> Dict[str, Any]:
    """
    What a batch issued from [h] (a type, or a batch as it is now) redeems by — normalised as
    `create_batch` writes a batch, so a type and a batch issued from it compare equal.
    """
    kind = getattr(h, "kind", None) or "items"
    discount = kind in RULES.DISCOUNT_KINDS
    stacking = getattr(h, "stacking", None) or "unlimited"
    groups_mode = not discount and (getattr(h, "selection", None) or "items") == "groups"
    targets = getattr(h, "targets", None) or None
    return {
        "kind": kind,
        "till_value": h.till_value,
        "production_price": h.production_price,
        "pricing": h.pricing or "cover",
        "allow_top_up": h.allow_top_up is not False,
        "redemption_accounting": "discount" if discount else (h.redemption_accounting or "discount"),
        "split_allowed": bool(h.split_allowed) and not discount,
        "include_extras": bool(h.include_extras) and not discount,
        "print_till_value": bool(h.print_till_value),
        "offline_allowed": bool(h.offline_allowed),
        "discount_type": h.discount_type if discount else None,
        "discount_value": h.discount_value if discount else None,
        "min_purchase": h.min_purchase if discount else None,
        "max_discount": h.max_discount if discount else None,
        "max_units": h.max_units if kind == "item_discount" else None,
        "targets": (
            {"productIds": sorted(_ids(targets.get("productIds"))), "categoryIds": sorted(_ids(targets.get("categoryIds")))}
            if kind == "item_discount" and targets else None
        ),
        "stacking": stacking,
        "max_vouchers_per_sale": h.max_vouchers_per_sale if stacking != "single" else None,
        "selection": "groups" if groups_mode else "items",
        # A batch's groups carry the catalog frozen at its issue; a type's do not.
        "groups": [{k: v for k, v in g.items() if k != "frozenProductIds"} for g in (h.groups or [])] if groups_mode else None,
        "total_qty": h.total_qty if not discount else None,
        "catalog_mode": h.catalog_mode or "frozen",
        "promotion_policy": h.promotion_policy or "exclude",
        "uses_per_voucher": int(h.uses_per_voucher or 1) if discount else 1,
        "max_uses_per_sale": int(h.max_uses_per_sale or 1) if discount else 1,
        "max_uses_per_day": h.max_uses_per_day if discount else None,
        "discount_block_policy": h.discount_block_policy or "honour",
        "override_max_amount": h.override_max_amount,
        "override_max_percent": h.override_max_percent,
        "override_max_total": h.override_max_total,
        "override_scope": h.override_scope or None,
        "items": (
            sorted((str(i.product_id), str(PV.qty(i.quantity))) for i in items)
            if not discount and not groups_mode else []
        ),
    }


def source_type(db: Session, source: PrepaidVoucherBatch) -> Optional[PrepaidVoucherType]:
    """
    The source's own voucher type when the new batch may be issued from it: a type made by hand,
    still active, whose current terms are the source's terms as they are now. None otherwise.
    """
    if source.type_id is None:
        return None
    t = db.get(PrepaidVoucherType, source.type_id)
    if t is None or t.origin != "manual" or not t.active:
        return None
    if _effective_terms(t, t.items) != _effective_terms(source, source.items):
        return None
    return t


def _policy_in(source: PrepaidVoucherBatch) -> Optional[Dict[str, Any]]:
    mode = source.discount_block_policy or "honour"
    if mode == "honour":
        return None
    scope = source.override_scope or None
    return {
        "mode": mode,
        "maxAmount": _shekels(source.override_max_amount),
        "maxPercent": _shekels(source.override_max_percent),  # basis points → %
        "maxTotal": _shekels(source.override_max_total),
        "scope": (
            {"productIds": _ids(scope.get("productIds")), "categoryIds": _ids(scope.get("categoryIds"))}
            if scope else None
        ),
    }


def _groups_in(groups) -> Optional[List[Dict[str, Any]]]:
    """The stored groups as the create body takes them (₪; the frozen expansion is dropped — re-frozen today)."""
    if not groups:
        return None
    return [
        {
            "key": g.get("key"),
            "name": g.get("name"),
            "minQty": int(g.get("minQty") or 0),
            "maxQty": int(g.get("maxQty") or 1),
            "value": _shekels(g.get("valueAgorot")),
            "allowRepeat": g.get("allowRepeat", True) is not False,
            "allItems": bool(g.get("allItems")),
            "productIds": _ids(g.get("productIds")),
            "categoryIds": _ids(g.get("categoryIds")),
            "includeSubcategories": g.get("includeSubcategories", True) is not False,
            "excludeProductIds": _ids(g.get("excludeProductIds")),
            "excludeCategoryIds": _ids(g.get("excludeCategoryIds")),
            "sortOrder": int(g.get("sortOrder") or n),
        }
        for n, g in enumerate(groups)
    ]


def create_data(db: Session, source: PrepaidVoucherBatch, body: PrepaidBatchDuplicateIn) -> Dict[str, Any]:
    """The create body's fields (camelCase) for the duplicate of [source] that [body] asks for."""
    given = body.model_fields_set
    kind = source.kind or "items"
    discount = kind in RULES.DISCOUNT_KINDS
    groups_mode = not discount and (source.selection or "items") == "groups"
    uses = int(source.uses_per_voucher or 1)
    targets = source.targets or None

    def pick(field: str, own):
        return getattr(body, field) if field in given else own

    the_type = source_type(db, source)
    data: Dict[str, Any] = {
        "name": body.name,
        "count": body.count,
        "companyId": source.company_id,
        "typeId": the_type.id if the_type is not None else None,
        "shopIds": list(source.shop_ids) if source.shop_ids else None,
        # For whom and for what (the dialog may change them).
        "productionId": pick("production_id", source.production_id),
        "customerName": pick("customer_name", source.customer_name),
        "reportEventId": pick("report_event_id", source.report_event_id),
        "eventName": pick("event_name", source.event_name),
        "orderRef": source.order_ref,
        "validFrom": pick("valid_from", PV._utc(source.valid_from)),
        "validUntil": pick("valid_until", PV._utc(source.valid_until)),
        # The paper.
        "logoUrl": source.logo_url,
        "freeText": source.free_text,
        "showCode": bool(source.show_code),
        "showItems": source.show_items is not False,
        "showCredit": source.show_credit is not False,
        "showValidity": source.show_validity is not False,
        "barcodeType": source.barcode_type or "qr",
        "groupSize": source.group_size or None,
        "printTillValue": bool(source.print_till_value),
        # What it gives and its rules.
        "kind": kind,
        "items": (
            [{"productId": i.product_id, "quantity": PV.qty_out(i.quantity)} for i in source.items]
            if not discount and not groups_mode else []
        ),
        "selection": "groups" if groups_mode else "items",
        "groups": _groups_in(source.groups) if groups_mode else None,
        "totalQty": source.total_qty if groups_mode else None,
        "catalogMode": source.catalog_mode or "frozen",
        "splitAllowed": bool(source.split_allowed),
        "includeExtras": bool(source.include_extras),
        "discountType": source.discount_type if discount else None,
        "discountValue": _shekels(source.discount_value) if discount else None,
        "minPurchase": _shekels(source.min_purchase) if kind == "order_discount" else None,
        "maxDiscount": _shekels(source.max_discount) if kind == "order_discount" else None,
        "maxUnits": source.max_units if kind == "item_discount" else None,
        "targets": (
            {"productIds": _ids(targets.get("productIds")), "categoryIds": _ids(targets.get("categoryIds"))}
            if kind == "item_discount" and targets else None
        ),
        "stacking": source.stacking or "unlimited",
        "maxVouchersPerSale": source.max_vouchers_per_sale if (source.stacking or "unlimited") != "single" else None,
        "promotionPolicy": source.promotion_policy or "exclude",
        "usesPerVoucher": uses,
        # Stored before the rule, the most per sale may exceed the uses: it redeems as the uses.
        "maxUsesPerSale": min(int(source.max_uses_per_sale or 1), uses),
        "maxUsesPerDay": source.max_uses_per_day if discount else None,
        # Prices and how a redemption is priced and booked.
        "tillValue": _shekels(source.till_value),
        "productionPrice": _shekels(source.production_price),
        "pricing": source.pricing or None,
        "allowTopUp": source.allow_top_up is not False,
        "redemptionAccounting": source.redemption_accounting or None,
        "discountBlockPolicy": _policy_in(source),
        "offlineAllowed": bool(source.offline_allowed),
        # "להתחיל במצב בדיקה": the dialog's own choice — the source's test mode is never copied.
        "startInTestMode": bool(body.start_in_test_mode),
    }
    return data


def create_body(db: Session, source: PrepaidVoucherBatch, body: PrepaidBatchDuplicateIn) -> PrepaidVoucherBatchCreate:
    """The batch-create body of the duplicate — refused (422) as the create form would be."""
    try:
        return PrepaidVoucherBatchCreate(**create_data(db, source, body))
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=jsonable_encoder(exc.errors(include_url=False, include_context=False, include_input=False)),
        )


# ── The distribution's texts ─────────────────────────────────────────────────


def copy_distribution_texts(db: Session, source: PrepaidVoucherBatch, batch: PrepaidVoucherBatch, user: User) -> bool:
    """
    "נוסח ההפצה": the source's message texts and the PDF's layout — never its recipients, links,
    sends or their history (nor its links' expiry: the new batch's follows its own validity).
    """
    from app.services import voucher_distribution as VD

    src = VD.get_distribution(db, source)
    if src is None:
        return False
    layout = src.layout or VD.DEFAULT_LAYOUT
    if not (src.message_template or src.group_message_template or layout != VD.DEFAULT_LAYOUT):
        return False
    dist = VD.ensure_distribution(db, batch, user)
    dist.message_template = src.message_template
    dist.group_message_template = src.group_message_template
    dist.layout = layout
    db.flush()
    return True


# ── The request ───────────────────────────────────────────────────────────────


def request_of(batch_id, body: PrepaidBatchDuplicateIn) -> Dict[str, Any]:
    """
    The key's fingerprint: the source and the body as sent (an absent field — "as the source" — is
    not a null — "none"). `clientRequestId` is the key itself, not a part of it.
    """
    out = {"sourceBatchId": str(PV._as_uuid(batch_id) or batch_id),
           **body.model_dump(mode="json", by_alias=True, exclude_unset=True)}
    out.pop("clientRequestId", None)
    return out


def key_of(header_key: Optional[str], body: PrepaidBatchDuplicateIn) -> Optional[str]:
    """The operation id: the `Idempotency-Key` header, else the body's `clientRequestId`."""
    if header_key is not None and str(header_key).strip():
        return header_key
    return body.client_request_id


def duplicate(
    db: Session, user: User, tenant_id, batch_id, body: PrepaidBatchDuplicateIn, key: Optional[str] = None,
) -> Tuple[Dict[str, Any], bool]:
    """
    The new batch, its vouchers, both audit lines, the key and the answer in one transaction,
    committed once — or nothing. Returns (answer, replayed): replayed is True when [key] already
    made the duplicate, and the answer is that batch as it is now.
    """

    def run() -> Dict[str, Any]:
        source = PV.get_batch(db, user, tenant_id, batch_id)
        create_in = create_body(db, source, body)
        batch = PV.create_batch(db, user, tenant_id, create_in)
        texts = copy_distribution_texts(db, source, batch, user)
        PV._event(db, batch, user, FROM_ACTION, count=create_in.count, details={
            "batchId": str(source.id), "batchName": source.name,
            "sameType": create_in.type_id is not None, "distributionTexts": texts,
        })
        PV._event(db, source, user, TO_ACTION, count=create_in.count, details={
            "batchId": str(batch.id), "batchName": batch.name,
        })
        db.flush()
        out = PV.batch_out(db, batch, user=user)
        twin = PBC.duplicate_of(db, user, batch)
        out["possibleDuplicate"] = PBC.duplicate_ref(twin) if twin is not None else None
        out["duplicatedFrom"] = {"id": str(source.id), "name": source.name}
        return jsonable_encoder(out)

    def reread(first: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not first or not first.get("id"):
            return first
        fresh = PV.batch_out(db, PV.get_batch(db, user, tenant_id, first["id"]), user=user)
        fresh["possibleDuplicate"] = first.get("possibleDuplicate")
        fresh["duplicatedFrom"] = first.get("duplicatedFrom")
        return jsonable_encoder(fresh)

    try:
        return idem.once(
            db, tenant_id=tenant_id, kind=KIND, key=key, user=user, request=request_of(batch_id, body),
            run=run, refresh=reread, status_code=201, claim_first=True,
        )
    except BaseException:
        # Nothing of a failed duplicate survives in this session: no batch, no vouchers, no lines, no key.
        db.rollback()
        raise
