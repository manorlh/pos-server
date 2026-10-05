"""
Transaction sync service.

Idempotency contract:
- Transaction PKs are client-generated UUIDs.
- upsert_transactions does INSERT ... ON CONFLICT (id) DO UPDATE.
- Items are replaced atomically per transaction (delete-then-insert by transaction_id).
- A timed-out POST that retries hits the same id and gets back status='duplicate'.
- A document names its shift by id; see `app.services.shifts` for how that resolves.
"""
from __future__ import annotations

import logging
import uuid
from decimal import Decimal, ROUND_HALF_UP
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.issued_voucher import IssuedVoucher, IssuedVoucherStatus
from app.models.stock_movement import StockMovementReason
from app.schemas.transaction import (
    TransactionIn,
    TransactionPaymentIn,
    TransactionUpsertResult,
    UnidentifiedDocument,
)
from app.services.approvals import ApprovalRejected, verify_document_approvers
from app.services.transmissions import leg_terminal_uid, mark_legs_on_ingest
from app.services import card_brands
from app.services.shifts import (
    ShiftConflict,
    note_documents_after_close,
    precheck_document_shifts,
    resolve_shift_for_document,
)
from app.services.stock import apply_movement
from app.services.promotions import replace_document_promotions
from app.services import menu as _menu
from app.services.z_runs import _rollback_savepoint
from app.services.tenders import (
    UNKNOWN_PAYMENT_METHOD,
    derive_payment_method,
    expected_tender_total,
    reconciliation_error,
)

logger = logging.getLogger(__name__)


def _promotion_uuid(value) -> Optional[uuid.UUID]:
    """A line's promotion id when it reads as one; never a reason to refuse the line."""
    if value is None:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


class _ItemForParts:
    """An incoming line as `menu.parts_for_item` reads it: its money and its cleaned details."""

    def __init__(self, item, details):
        self.id = item.id
        self.product_id = item.product_id
        self.quantity = item.quantity
        self.total_price = item.total_price
        self.discount = item.discount
        self.promotion_discount = item.promotion_discount
        self.details = details


def _safe_item_product_id(
    db: Session, pid: Optional[uuid.UUID], tenant_id: Optional[uuid.UUID]
) -> Optional[uuid.UUID]:
    """
    `pid` if it names a product **of `tenant_id`** (the pushing till's), else None.

    POS SQLite `products.id` can diverge from cloud PK after SKU-based merge; invalid UUIDs
    would break INSERT into transaction_items (FK → products). Snapshot fields preserve lines.
    Another tenant's product is treated as unknown: without the tenant predicate a till
    could link its lines — and its stock movements — to another merchant's catalogue by
    naming a UUID.
    """
    if pid is None or tenant_id is None:
        return None
    row = db.query(Product.id).filter(Product.id == pid, Product.tenant_id == tenant_id).first()
    return pid if row else None


def _safe_voucher_id(
    db: Session, vid: Optional[uuid.UUID], tenant_id: Optional[uuid.UUID]
) -> Optional[uuid.UUID]:
    """`vid` if it names a voucher of `tenant_id`, else None (as `_safe_item_product_id`)."""
    if vid is None or tenant_id is None:
        return None
    from app.models.voucher import Voucher
    row = db.query(Voucher.id).filter(Voucher.id == vid, Voucher.tenant_id == tenant_id).first()
    return vid if row else None


def _safe_issued_product_id(
    db: Session, pid: Optional[uuid.UUID], tenant_id: Optional[uuid.UUID]
) -> Optional[uuid.UUID]:
    return _safe_item_product_id(db, pid, tenant_id)


def _refund_of_other_tenant(
    db: Session, refund_of: Optional[uuid.UUID], tenant_id: Optional[uuid.UUID]
) -> bool:
    """
    Does the document's `refundOfTransactionId` name a document of **another** tenant?

    Not dropped like a product link: it decides whether the money is a sale or a refund,
    so a document naming another tenant's sale is refused. An id the cloud does not hold
    (yet) is fine — the original may arrive after its credit note.
    """
    if refund_of is None:
        return False
    row = db.query(Transaction.tenant_id).filter(Transaction.id == refund_of).first()
    return row is not None and str(row[0]) != str(tenant_id)


def _refund_item_link(
    db: Session,
    item_id: Optional[uuid.UUID],
    tenant_id: Optional[uuid.UUID],
    where: str,
    warnings: List[str],
) -> Optional[uuid.UUID]:
    """
    A credit-note line's `refundOfItemId`, unless it names a line of **another** tenant.

    An id the cloud does not hold (yet) is kept: the original may arrive after its credit
    note, and the link is resolved when read. Another tenant's line is dropped with the
    `unknown` warning, as a product link is — the line keeps its money either way (the
    document type, not this link, says it is a refund).
    """
    if item_id is None:
        return None
    row = (
        db.query(Transaction.tenant_id)
        .join(TransactionItem, TransactionItem.transaction_id == Transaction.id)
        .filter(TransactionItem.id == item_id)
        .first()
    )
    if row is not None and str(row[0]) != str(tenant_id):
        warnings.append(f"{where}: unknown {_raw(str(item_id))}, stored without the link")
        return None
    return item_id


def _kept_link(
    resolved: Optional[uuid.UUID], sent: Optional[uuid.UUID], where: str, warnings: List[str]
) -> Optional[uuid.UUID]:
    """
    `resolved` (a `_safe_*` lookup of `sent`), with a warning when a link was sent and
    names nothing here — the well-formed twin of `drop_unreadable_references`: the
    document is stored without the link either way, and the till is told which one.
    """
    if sent is not None and resolved is None:
        warnings.append(f"{where}: unknown {_raw(str(sent))}, stored without the link")
    return resolved


def _resolve_customer_ref_id(
    db: Session, raw: Optional[str], tenant_id: Optional[uuid.UUID]
) -> Optional[uuid.UUID]:
    """
    Turn the till's free-text `customerId` into a real FK, or into nothing.

    Same shape as `_safe_item_product_id`, and for the same reason: the till's value
    is not trusted to be a key in this database. Three cases resolve to null rather
    than to an error — a non-UUID string (a legacy desktop wrote a name there), a
    UUID naming no customer, and a UUID naming a customer of a *different* tenant.
    The last one is the one that matters: without the tenant predicate a machine
    could staple another merchant's customer, name and ח.פ. included, onto its own
    tax invoice by guessing a UUID.

    Deleted customers deliberately still resolve. A till that has been offline for a
    week can push a sale for a customer removed yesterday, and the document must not
    lose the identity it was issued to — which is why deletion is a tombstone on the
    row rather than a DELETE (see `app/models/customer.py`).
    """
    if not raw or tenant_id is None:
        return None
    try:
        candidate = uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None
    row = (
        db.query(Customer.id)
        .filter(Customer.id == candidate, Customer.tenant_id == tenant_id)
        .first()
    )
    return candidate if row else None


def _normalized_payment_legs(tx: TransactionIn) -> List[TransactionPaymentIn]:
    """
    The tender legs to persist for one document — always at least one.

    A till that sends only `paymentMethod` gets a single synthesised leg for the
    document's whole collectable amount. That is the entire point of doing it here:
    every reporting and export path downstream then has exactly one code path, and
    "does this document have legs?" never becomes a branch in an aggregation.

    The synthesised leg's id is derived deterministically from the document id via
    UUID5, not randomly. Pushes are idempotent by document id and the legs are
    replaced on every push, so a random id would mint a new primary key on each
    retry — harmless today, but it makes the same document look different every time
    it is re-pushed, and that is the sort of thing that turns a duplicate-detection
    question into an afternoon.
    """
    if tx.payments:
        return sorted(tx.payments, key=lambda p: (p.sequence, str(p.id)))
    return [
        TransactionPaymentIn(
            id=uuid.uuid5(uuid.NAMESPACE_URL, f"tender:{tx.id}:1"),
            sequence=1,
            method=(tx.payment_method or UNKNOWN_PAYMENT_METHOD),
            amount=expected_tender_total(
                total_amount=tx.total_amount or 0,
                document_discount=tx.document_discount,
                document_type=tx.document_type,
                refund_of_transaction_id=tx.refund_of_transaction_id,
            ),
            nayax_meta=tx.nayax_meta,
        )
    ]


def _leg_meta(leg: TransactionPaymentIn) -> Optional[dict]:
    """The leg's acquirer reply, with its instalment count kept beside it."""
    credit_payments = getattr(leg, "credit_payments", None)
    if credit_payments is None:
        return leg.nayax_meta
    return {**(leg.nayax_meta or {}), "creditPayments": credit_payments}


def _leg_card_brand(leg: TransactionPaymentIn) -> dict:
    """`card_brand` / `card_acquirer` / `card_issuer` of a card leg; nothing for the rest."""
    if (leg.method or "").strip().lower() != "card":
        return {}
    brand, acquirer, issuer = card_brands.resolve(
        leg.nayax_meta,
        brand=getattr(leg, "card_brand", None),
        acquirer=getattr(leg, "card_acquirer", None),
        issuer=getattr(leg, "card_issuer", None),
    )
    return {"card_brand": brand, "card_acquirer": acquirer, "card_issuer": issuer}


def _tender_rejection_reason(tx: TransactionIn) -> Optional[str]:
    """
    Why this document's `payments` array cannot be accepted, or None.

    Only checked when the till actually sent an array. A synthesised leg cannot
    mismatch by construction, so an older till build is never rejected by a rule it
    has never heard of.
    """
    if not tx.payments:
        return None
    expected = expected_tender_total(
        total_amount=tx.total_amount or 0,
        document_discount=tx.document_discount,
        document_type=tx.document_type,
        refund_of_transaction_id=tx.refund_of_transaction_id,
    )
    return reconciliation_error(expected, [p.amount for p in tx.payments])


def _as_utc(moment: datetime) -> datetime:
    """A naive timestamp is UTC (how a driver without time zones hands one back)."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


# ── Fiscal content, for amendments of a filed document ───────────────────────

_CENT = Decimal("0.01")


def _cents(value) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)
    except (ArithmeticError, ValueError):
        return None


def _status_value(value) -> str:
    return str(getattr(value, "value", value) or "")


def _fiscal_key(
    *, number, document_type, status, total, discount, vat, tip, tip_method, refund_of, legs
) -> tuple:
    """
    What a document contributes to an X or a Z, as one comparable value.

    Only what the figures are made of: a status change between two statuses that both
    count as a sale (a sale later marked `refunded` by its credit note) is not an
    amendment, nor is a note or a cashier id.
    """
    from app.services.dashboard_stats import SALE_STATUSES

    counted = _status_value(status) in {_status_value(s) for s in SALE_STATUSES}
    return (
        (number or "").strip(),
        document_type,
        counted,
        _cents(total) or Decimal("0.00"),
        _cents(discount) or Decimal("0.00"),
        _cents(vat),
        _cents(tip) or Decimal("0.00"),
        (tip_method or "").strip().lower() or None,
        str(refund_of) if refund_of else None,
        tuple(sorted(legs)),
    )


def _stored_fiscal_key(db: Session, doc: Transaction) -> tuple:
    legs = [
        (((m or "").strip().lower() or UNKNOWN_PAYMENT_METHOD), _cents(a))
        for m, a in db.query(TransactionPayment.method, TransactionPayment.amount)
        .filter(TransactionPayment.transaction_id == doc.id)
        .all()
    ]
    return _fiscal_key(
        number=doc.transaction_number, document_type=doc.document_type, status=doc.status,
        total=doc.total_amount, discount=doc.document_discount, vat=doc.vat_amount,
        tip=doc.tip_amount, tip_method=doc.tip_payment_method,
        refund_of=doc.refund_of_transaction_id, legs=legs,
    )


def _incoming_fiscal_key(tx: TransactionIn, legs: List[TransactionPaymentIn]) -> tuple:
    return _fiscal_key(
        number=tx.transaction_number, document_type=tx.document_type, status=tx.status,
        total=tx.total_amount or 0, discount=tx.document_discount,
        vat=_vat_split(tx)["vat_amount"], tip=tx.tip_amount or 0, tip_method=tx.tip_payment_method,
        refund_of=tx.refund_of_transaction_id,
        legs=[
            (((leg.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD)[:50], _cents(leg.amount))
            for leg in legs
        ],
    )


# ── Per-document validation ──────────────────────────────────────────────────

#: The most of a validation reason sent back. The till shows it and keeps it with the
#: parked document; a few errors are enough to fix the build that produced it.
REJECTION_REASON_MAX_CHARS = 500
#: The most of a non-UUID id echoed back.
ECHOED_ID_MAX_CHARS = 100


def _error_location(loc: Sequence[Any]) -> str:
    out = ""
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += ("." if out else "") + str(part)
    return out or "document"


def validation_reason(error: ValidationError) -> str:
    """`items[0].productId: Input should be a valid UUID, …` — every error, `; `-joined."""
    parts = [f"{_error_location(e.get('loc', ()))}: {e.get('msg', 'invalid')}" for e in error.errors()]
    reason = "; ".join(parts) or "invalid document"
    if len(reason) > REJECTION_REASON_MAX_CHARS:
        reason = reason[: REJECTION_REASON_MAX_CHARS - 1] + "…"
    return reason


def _answerable_id(raw: Any):
    """The id to answer a refused document by: a UUID, the string as sent, or None."""
    value = raw.get("id") if isinstance(raw, dict) else None
    if isinstance(value, uuid.UUID):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return value[:ECHOED_ID_MAX_CHARS]


#: Reference fields a document is stored without when they cannot be read — links to
#: other rows, which the upsert already drops when they name nothing (`_safe_item_product_id`,
#: `_safe_voucher_id`). A document is never refused over one of these: the sale happened.
#: `(list key, field)` → the field is set to null.
_DROPPABLE_REFERENCES = (
    ("items", "productId"),
    ("items", "refundOfItemId"),
    ("issuedVouchers", "voucherId"),
    ("issuedVouchers", "productId"),
    ("issuedVouchers", "transactionItemId"),
    ("stockMovements", "transactionItemId"),
)

#: The most of an unreadable reference kept in a warning.
RAW_VALUE_MAX_CHARS = 100


def _unreadable_uuid(value: Any) -> bool:
    if value is None or isinstance(value, uuid.UUID):
        return False
    if not isinstance(value, str):
        return True
    try:
        uuid.UUID(value)
    except ValueError:
        return True
    return False


def _raw(value: Any) -> str:
    return repr(value)[:RAW_VALUE_MAX_CHARS]


def drop_unreadable_references(raw: dict) -> Tuple[dict, List[str]]:
    """
    The document with every unreadable reference link dropped, and a warning for each.

    Never lose a fiscal document over a link: an item whose `productId` is not a UUID
    ("p12") is stored with no product link — the line keeps its name, SKU and money — and
    the value as sent goes into the warning, which is answered to the till and kept in
    `sync_logs.conflict_note` (an item has no field of its own to hold it). A stock
    movement whose `productId` cannot be read is dropped the same way: without a product
    there is nothing to move, and on-hand is not a fiscal record.

    Only these links. A document whose money, dates or own id cannot be read is still
    refused, and so is an unreadable `shiftId` (it decides which X the money is in),
    `refundOfTransactionId` (it decides whether the money is a sale or a refund) or
    `approvedByUserId` (stripping a claim of approval would pass a false one off as an
    ordinary document).
    """
    warnings: List[str] = []
    doc = dict(raw)
    # The basket id groups documents for display; it decides no money, so an unreadable
    # one is dropped like a link rather than refusing the document.
    if _unreadable_uuid(doc.get("basketId")):
        warnings.append(f"basketId: unreadable {_raw(doc['basketId'])}, stored without the link")
        doc["basketId"] = None
    for key, field in _DROPPABLE_REFERENCES:
        entries = doc.get(key)
        if not isinstance(entries, list):
            continue
        rewritten = []
        for i, entry in enumerate(entries):
            if isinstance(entry, dict) and _unreadable_uuid(entry.get(field)):
                warnings.append(f"{key}[{i}].{field}: unreadable {_raw(entry[field])}, stored without the link")
                entry = {**entry, field: None}
            rewritten.append(entry)
        doc[key] = rewritten
    movements = doc.get("stockMovements")
    if isinstance(movements, list):
        kept = []
        for i, movement in enumerate(movements):
            if isinstance(movement, dict) and _unreadable_uuid(movement.get("productId")):
                warnings.append(
                    f"stockMovements[{i}].productId: unreadable {_raw(movement['productId'])}, movement not applied"
                )
                continue
            kept.append(movement)
        doc["stockMovements"] = kept
    return doc, warnings


def validate_documents(
    raw_documents: Sequence[Any],
) -> Tuple[
    List[Tuple[int, TransactionIn, List[str]]],
    List[Tuple[int, TransactionUpsertResult]],
    List[UnidentifiedDocument],
]:
    """
    Validate each document of a batch on its own (docs/SHIFTS_API.md §1.2).

    Returns the valid documents (with the warnings of any reference dropped to store
    them — `drop_unreadable_references`), the refused ones as `rejected` results, and the
    refused ones that carry no string id to answer by — each with its position in the
    batch, so the caller can answer in the order the till sent. A refused document is
    never stored: it is logged, and the till parks it and keeps the rest moving.
    """
    valid: List[Tuple[int, TransactionIn, List[str]]] = []
    rejected: List[Tuple[int, TransactionUpsertResult]] = []
    unidentified: List[UnidentifiedDocument] = []
    for index, raw in enumerate(raw_documents):
        if isinstance(raw, TransactionIn):
            valid.append((index, raw, []))
            continue
        try:
            if not isinstance(raw, dict):
                raise TypeError("a document must be a JSON object")
            doc, warnings = drop_unreadable_references(raw)
            tx = TransactionIn.model_validate(doc)
            if warnings:
                logger.warning("Storing document %s without links: %s", tx.id, "; ".join(warnings))
            valid.append((index, tx, warnings))
            continue
        except ValidationError as error:
            reason = validation_reason(error)
        except TypeError as error:
            reason = f"document: {error}"
        doc_id = _answerable_id(raw)
        logger.warning("Rejecting document %s (batch index %d): %s", doc_id, index, reason)
        if doc_id is None:
            unidentified.append(UnidentifiedDocument(index=index, reason=reason))
        else:
            rejected.append((index, TransactionUpsertResult(id=doc_id, status="rejected", reason=reason)))
    return valid, rejected, unidentified


# ── Transactions upsert ──────────────────────────────────────────────────────

def _serialize_tx_for_upsert(
    tx: TransactionIn,
    machine: POSMachine,
    shift_id: uuid.UUID,
    *,
    payment_method: Optional[str] = None,
    customer_ref_id: Optional[uuid.UUID] = None,
    approved_by_user_id: Optional[uuid.UUID] = None,
    approved_by_pos_user_id: Optional[uuid.UUID] = None,
) -> Dict:
    """
    Flatten one incoming document into the row the upsert writes.

    `payment_method`, `customer_ref_id` and `approved_by_user_id` are the values the
    *server* decides rather than copies: the first is derived from the tender legs,
    the second is the till's `customer_id` after it has been checked against this
    tenant's customers, and the third is the till's claimed approver after
    `app.services.approvals` has verified they could have approved this. All three
    default to the pre-existing behaviour — the till's own `payment_method`, no
    customer link, no approver — so a caller that passes none still produces the row
    this function produced before any of them existed.
    """
    return {
        "id": tx.id,
        "tenant_id": machine.tenant_id,
        "machine_id": machine.id,
        "shop_id": machine.shop_id,
        "shift_id": shift_id,
        "transaction_number": tx.transaction_number,
        "status": tx.status,
        "document_type": tx.document_type,
        "document_production_date": tx.document_production_date,
        # Derived from the tender legs, not copied from the till: a document with two
        # tenders must not keep claiming to be a cash sale. Falls back to whatever the
        # till sent when there are no legs at all.
        "payment_method": payment_method if payment_method is not None else tx.payment_method,
        "amount_tendered": tx.amount_tendered,
        "change_amount": tx.change_amount,
        "total_amount": tx.total_amount or 0,
        # Stored as the till computed them, so a later VAT rate change cannot re-state
        # a document that has already been issued. See `_vat_split` for why an older
        # till that sends none gets nulls rather than a server-side guess.
        **_vat_split(tx),
        # Stamped onto the document rather than left to a join. An audit reads the
        # document, and the register a receipt was issued on is part of what it says.
        # `machine_code` is the fallback because this system generated it for pairing —
        # it identifies the terminal, just not in the numbering the business uses.
        "pos_number": machine.pos_number or machine.machine_code,
        "tip_amount": tx.tip_amount or 0,
        "tip_payment_method": tx.tip_payment_method,
        "total_discount": tx.total_discount,
        "document_discount": tx.document_discount,
        # The basket discount on its own and its kind (`club` / `manual`), when sent.
        "basket_discount": getattr(tx, "basket_discount", None),
        "basket_discount_percent": getattr(tx, "basket_discount_percent", None),
        "basket_discount_kind": getattr(tx, "basket_discount_kind", None),
        "wht_deduction": tx.wht_deduction,
        "customer_id": tx.customer_id,
        "customer_ref_id": customer_ref_id,
        "cashier_id": tx.cashier_id,
        "branch_id": tx.branch_id,
        "notes": tx.notes,
        "refund_of_transaction_id": tx.refund_of_transaction_id,
        "nayax_meta": tx.nayax_meta,
        # getattr: a caller may hand in a document built before these fields existed.
        "basket_id": getattr(tx, "basket_id", None),
        "customer_name": getattr(tx, "customer_name", None),
        "customer_phone": getattr(tx, "customer_phone", None),
        "customer_address": getattr(tx, "customer_address", None),
        "approved_by_user_id": approved_by_user_id,
        "approved_by_pos_user_id": approved_by_pos_user_id,
        "created_at": tx.created_at,
        "updated_at": tx.updated_at,
    }


def _vat_split(tx: TransactionIn) -> dict:
    """
    The net / VAT / rate triple to store against a document.

    Taken from the till and nowhere else. The till is the authority on what it actually
    charged: it printed the receipt, and its VAT line is what the customer holds. The
    server *could* re-derive a rate from the company or shop configuration, but that is
    a different source and it can disagree with the paper — a shop whose rate was
    changed mid-day would have documents re-stated to figures no receipt shows.

    So an older till that sends nothing gets three nulls rather than a guess, and the
    tax export keeps deriving those the way it always has. `vat_rate` is what makes the
    stored pair auditable: without it you cannot tell a correct 17% document from a
    wrong 18% one.

    A tip carries no VAT — it is not consideration for a supply — and `total_amount` is
    already exclusive of it, so nothing needs excluding here.
    """
    if tx.vat_amount is None or tx.net_amount is None:
        return {"net_amount": None, "vat_amount": None, "vat_rate": None}
    return {
        "net_amount": tx.net_amount,
        "vat_amount": tx.vat_amount,
        "vat_rate": tx.vat_rate,
    }


def upsert_transactions(
    db: Session,
    machine: POSMachine,
    transactions: List[TransactionIn],
) -> List[TransactionUpsertResult]:
    """
    Idempotently upsert a batch of transactions and their items.

    For each tx:
      - Reject the document outright if its `payments` array does not reconcile.
      - Reject it outright if it claims an approver who could not have approved it.
      - Resolve its shift by id (never adopting another open shift; see
        `app.services.shifts`). A batch naming a shift the cloud cannot accept yet
        raises `ShiftConflict` before anything is written.
      - INSERT ... ON CONFLICT (id) DO UPDATE SET ... — `status` reports 'accepted' for new rows
        and 'duplicate' for rows that already existed at the same updated_at.
      - Replace items atomically: DELETE existing items by transaction_id, then INSERT the new list.
      - Replace tender legs the same way, synthesising one from `paymentMethod` when the
        till sent no array.

    **Why an unbalanced `payments` array is rejected rather than stored with a flag.**
    A document whose tenders do not sum to its total cannot be audited: it is either
    money the shop took and cannot account for, or an amount it never took. Stored, it
    goes straight into the next OpenFormat filing, where the payment records (D120)
    would no longer add up to the document record (C100) — and a validator that
    rejects the file rejects the whole period, not the one bad row. A boolean flag on
    the row would only help if something queried it, and nothing does.

    Rejecting costs nothing here because of how the two halves of this system already
    behave. The result is per-document, so the rest of the batch still lands. The till
    keeps its own copy: `OutboxSync` marks a rejected row failed and does **not**
    clear it, so the document survives locally with its trace intact, and because the
    upsert is keyed on the client-generated id, a corrected client can re-push the
    same document and have it accepted. The reason string travels back in the batch
    response and into `sync_logs.conflict_note`, so the failure is visible rather than
    sitting in a column nobody reads.

    The legacy path is deliberately exempt: a till that sends only `paymentMethod` has
    its single leg synthesised from the document's own amount, so it cannot fail a
    reconciliation rule it has never heard of.
    """
    results: List[TransactionUpsertResult] = []
    if not transactions:
        return results

    # Before anything is written: a batch that names a shift the cloud cannot accept
    # yet is refused whole, and the till retries it after the close of the open shift.
    precheck_document_shifts(db, machine, [tx.shift_id for tx in transactions])

    # Closed shifts a written document lands in (or leaves) → new documents among them.
    touched_closed: Dict[uuid.UUID, int] = {}
    # Known documents moved into a shift, and known documents whose fiscal content this
    # push rewrote in place — both flagged if that shift turns out to be in a Z.
    moved_in: Dict[uuid.UUID, int] = {}
    amended: Dict[uuid.UUID, int] = {}

    # Pre-load existing rows in one query so we can classify accepted vs duplicate.
    incoming_ids = [tx.id for tx in transactions]
    existing_map: Dict[uuid.UUID, Transaction] = {
        t.id: t for t in db.query(Transaction).filter(Transaction.id.in_(incoming_ids)).all()
    }

    for tx in transactions:
        # Each transaction gets its own SAVEPOINT. Without one, a single failure left
        # the session in a rolled-back state: every later transaction in the batch was
        # then rejected with a PendingRollbackError, and the router's commit raised —
        # turning one bad row into a 500 the till retries forever, which blocks the
        # outbox and therefore the day's close.
        savepoint = db.begin_nested()
        # Links the document sent that name nothing here (answered as `warnings`).
        link_warnings: List[str] = []
        try:
            previous = existing_map.get(tx.id)
            if previous is not None and str(previous.machine_id) != str(machine.id):
                # The cloud already holds this document for another till — the same
                # physical till before it was re-paired as a new machine. It is left
                # exactly as it is: rewriting it would move another till's document, or
                # recompute another till's X. Reported as a duplicate — it *is* on the
                # cloud — so the till clears it rather than retrying forever.
                logger.warning(
                    "Document %s pushed by machine %s is held by machine %s; left untouched",
                    tx.id, machine.id, previous.machine_id,
                )
                savepoint.rollback()
                results.append(TransactionUpsertResult(
                    id=tx.id,
                    status="duplicate",
                    reason="held_by_another_machine",
                    server_received_at=datetime.now(timezone.utc),
                ))
                continue

            # Before anything is written, so a rejected document leaves no trace at
            # all — not even an auto-opened shift.
            tender_problem = _tender_rejection_reason(tx)
            if tender_problem is not None:
                logger.warning("Rejecting transaction %s: %s", tx.id, tender_problem)
                results.append(TransactionUpsertResult(
                    id=tx.id,
                    status="rejected",
                    reason=tender_problem,
                ))
                continue

            # Also before anything is written, and for the same reason the tender
            # check is: a document whose claim of approval is false must leave no
            # trace, least of all a stored copy of itself with the claim quietly
            # stripped out. Stripping would turn a lie into a plausible ordinary
            # document, which is the one outcome worse than rejecting.
            if _refund_of_other_tenant(db, tx.refund_of_transaction_id, machine.tenant_id):
                logger.warning(
                    "Rejecting transaction %s: refundOfTransactionId %s is another tenant's",
                    tx.id, tx.refund_of_transaction_id,
                )
                results.append(TransactionUpsertResult(
                    id=tx.id,
                    status="rejected",
                    reason="refundOfTransactionId: names a document of another tenant",
                ))
                continue

            try:
                approved_by_user_id, approved_by_pos_user_id = verify_document_approvers(
                    db, machine, tx
                )
            except ApprovalRejected as bad_claim:
                logger.warning("Rejecting transaction %s: %s", tx.id, bad_claim)
                results.append(TransactionUpsertResult(
                    id=tx.id,
                    status="rejected",
                    reason=str(bad_claim),
                ))
                continue

            legs = _normalized_payment_legs(tx)

            business_date_value: Optional[date] = None
            if tx.business_date:
                try:
                    business_date_value = date.fromisoformat(tx.business_date)
                except ValueError:
                    business_date_value = tx.created_at.date() if tx.created_at else None
            else:
                business_date_value = tx.created_at.date() if tx.created_at else None

            shift = resolve_shift_for_document(
                db,
                machine,
                shift_id=tx.shift_id,
                business_date=business_date_value,
                opened_at=tx.created_at,
            )

            # `shift` is always this till's own (None for no id, or another till's id).
            target_shift_id = shift.id if shift is not None else None
            held = None  # (machine_id, z_report_id) of the shift the document is in now
            if previous is not None and previous.shift_id is not None:
                held = (
                    db.query(Shift.machine_id, Shift.z_report_id)
                    .filter(Shift.id == previous.shift_id)
                    .first()
                )
            held_by_other_till = held is not None and str(held[0]) != str(machine.id)
            if shift is None and previous is not None:
                # A re-push that names no shift never detaches a document from the one
                # it is already in — unless that is another till's shift (it could land
                # there before that was refused) not yet in a Z: then it becomes the
                # orphan it should have been.
                target_shift_id = previous.shift_id
                if held_by_other_till and held[1] is None:
                    target_shift_id = None
            elif (
                previous is not None
                and previous.shift_id is not None
                and previous.shift_id != target_shift_id
            ):
                # A re-push naming a different shift moves the document — that is how a
                # close's `staleIds` get fixed — except out of a shift already in a Z:
                # that would change a filed Z behind its back.
                if held is not None and held[1] is not None:
                    logger.warning(
                        "Document %s stays in shift %s (already in Z %s); push named shift %s",
                        tx.id, previous.shift_id, held[1], target_shift_id,
                    )
                    target_shift_id = previous.shift_id

            # Before the row is rewritten: would this push change what the document
            # contributes to its shift's figures? Only asked for a closed shift, where a
            # Z may already hold the old figures (see `note_documents_after_close`).
            rewrites_fiscal = False
            if (
                previous is not None
                and target_shift_id is not None
                and previous.shift_id == target_shift_id
                and db.query(Shift.id)
                .filter(Shift.id == target_shift_id, Shift.status == ShiftStatus.CLOSED)
                .first()
                is not None
            ):
                rewrites_fiscal = _stored_fiscal_key(db, previous) != _incoming_fiscal_key(tx, legs)

            row = _serialize_tx_for_upsert(
                tx,
                machine,
                target_shift_id,
                payment_method=derive_payment_method(
                    [leg.method for leg in legs], fallback=tx.payment_method
                ),
                customer_ref_id=_resolve_customer_ref_id(
                    db, tx.customer_id, machine.tenant_id
                ),
                approved_by_user_id=approved_by_user_id,
                approved_by_pos_user_id=approved_by_pos_user_id,
            )
            stmt = pg_insert(Transaction).values(**row)
            update_cols = {
                k: stmt.excluded[k]
                for k in row.keys()
                if k not in ("id", "tenant_id", "machine_id", "server_received_at")
            }
            stmt = stmt.on_conflict_do_update(index_elements=[Transaction.id], set_=update_cols)
            db.execute(stmt)

            # Replace items atomically.
            db.query(TransactionItem).filter(
                TransactionItem.transaction_id == tx.id
            ).delete(synchronize_session=False)
            if tx.items:
                db.bulk_save_objects([
                    TransactionItem(
                        id=it.id,
                        transaction_id=tx.id,
                        product_id=_kept_link(
                            _safe_item_product_id(db, it.product_id, machine.tenant_id), it.product_id,
                            f"items[{i}].productId", link_warnings,
                        ),
                        product_name=it.product_name,
                        sku=it.sku,
                        quantity=it.quantity,
                        unit_price=it.unit_price,
                        total_price=it.total_price,
                        discount=it.discount,
                        discount_type=it.discount_type,
                        transaction_type=it.transaction_type,
                        line_discount=it.line_discount,
                        notes=it.notes,
                        refund_of_item_id=_refund_item_link(
                            db, it.refund_of_item_id, machine.tenant_id,
                            f"items[{i}].refundOfItemId", link_warnings,
                        ),
                        promotion_discount=it.promotion_discount,
                        promotion_id=_promotion_uuid(it.promotion_id),
                        # What the dish was ordered with (docs/SPEC_MENU_MODIFIERS.md).
                        details=_menu.clean_details(it.details),
                        upsell_rule_id=_promotion_uuid(it.upsell_rule_id),
                        # OTH ("על חשבון הבית"): why the line went free, by whom, approved by whom.
                        oth_reason=getattr(it, "oth_reason", None),
                        oth_by=getattr(it, "oth_by", None),
                        oth_approved_by=getattr(it, "oth_approved_by", None),
                    )
                    for i, it in enumerate(tx.items)
                ])
            # The promotions ("מבצעים") the till applied, replaced like the items.
            replace_document_promotions(db, tx.id, tx.promotions)
            # The lines taken apart for the menu reports — modifiers, and a meal's
            # components with its money allocated — rebuilt like the items.
            _menu.replace_item_parts(db, tx.id, [
                _ItemForParts(it, _menu.clean_details(it.details)) for it in tx.items
            ])

            # Tender legs are replaced atomically, exactly like items: a re-push is
            # the whole document, so the legs it carries are the whole truth about
            # how it was paid. Merging would leave a leg from a superseded attempt
            # behind and break the reconciliation the push was just checked against.
            db.query(TransactionPayment).filter(
                TransactionPayment.transaction_id == tx.id
            ).delete(synchronize_session=False)
            db.bulk_save_objects([
                TransactionPayment(
                    id=leg.id,
                    transaction_id=tx.id,
                    sequence=leg.sequence,
                    # Lower-cased and trimmed on the way in, so the stored tender is
                    # canonical. The schema's min_length lets a whitespace-only
                    # string through, and the column is NOT NULL; more usefully,
                    # every consumer that matches a tender by name — the payment-type
                    # code in the OpenFormat export most of all — compares against
                    # lower case, and a till sending "Card" must not quietly file its
                    # card money as cash.
                    method=((leg.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD)[:50],
                    amount=leg.amount,
                    nayax_meta=_leg_meta(leg),
                    # The terminal's id of a card sale, what a transmission batch lists
                    # (docs/SHIFTS_API.md §4). Read here once so matching is an index hit.
                    terminal_uid=leg_terminal_uid(leg.method, leg.nayax_meta),
                    # מותג / חברת סליקה / מנפיק: the till's reading when it sent one,
                    # else the server reads the reply (an older till sends none).
                    **_leg_card_brand(leg),
                )
                for leg in legs
            ])
            # A batch that already carried this sale (the report came first, or this is a
            # re-push that just replaced the legs) marks it again from the kept uids.
            mark_legs_on_ingest(
                db,
                machine,
                [(leg.id, leg_terminal_uid(leg.method, leg.nayax_meta)) for leg in legs],
            )

            db.query(IssuedVoucher).filter(
                IssuedVoucher.transaction_id == tx.id
            ).delete(synchronize_session=False)
            if tx.issued_vouchers:
                db.bulk_save_objects([
                    IssuedVoucher(
                        id=iv.id,
                        tenant_id=machine.tenant_id,
                        shop_id=machine.shop_id,
                        machine_id=machine.id,
                        transaction_id=tx.id,
                        transaction_item_id=iv.transaction_item_id,
                        voucher_id=_kept_link(
                            _safe_voucher_id(db, iv.voucher_id, machine.tenant_id), iv.voucher_id,
                            f"issuedVouchers[{i}].voucherId", link_warnings,
                        ),
                        product_id=_kept_link(
                            _safe_issued_product_id(db, iv.product_id, machine.tenant_id), iv.product_id,
                            f"issuedVouchers[{i}].productId", link_warnings,
                        ),
                        product_name=iv.product_name,
                        quantity=iv.quantity,
                        unit_value=iv.unit_value,
                        face_value=iv.face_value,
                        issued_at=iv.issued_at,
                        expires_at=iv.expires_at,
                        status=IssuedVoucherStatus(iv.status) if iv.status else IssuedVoucherStatus.ISSUED,
                        reprint_count=iv.reprint_count,
                        last_printed_at=iv.last_printed_at,
                    )
                    for i, iv in enumerate(tx.issued_vouchers)
                ])

            if tx.stock_movements and machine.shop_id and machine.tenant_id:
                for i, sm in enumerate(tx.stock_movements):
                    if sm.product_id is None:
                        continue  # nothing named, nothing to move (as before)
                    if _safe_item_product_id(db, sm.product_id, machine.tenant_id) is None:
                        # Unknown here, or another tenant's: nothing of ours to move.
                        link_warnings.append(
                            f"stockMovements[{i}].productId: unknown {_raw(str(sm.product_id))}, "
                            "movement not applied"
                        )
                        continue
                    reason = StockMovementReason(sm.reason)
                    apply_movement(
                        db,
                        movement_id=sm.id,
                        tenant_id=machine.tenant_id,
                        shop_id=machine.shop_id,
                        product_id=sm.product_id,
                        delta=sm.delta,
                        reason=reason,
                        occurred_at=sm.occurred_at,
                        transaction_id=tx.id,
                        transaction_item_id=sm.transaction_item_id,
                        machine_id=machine.id,
                        note=sm.note,
                    )

            is_duplicate = previous is not None and (
                previous.updated_at is not None
                and tx.updated_at is not None
                and _as_utc(previous.updated_at) >= _as_utc(tx.updated_at)
            )
            savepoint.commit()
            # The row is written even when the push is a "duplicate" (same updated_at),
            # so a move between shifts happens either way — and the shift it left needs
            # its X recomputed as much as the one it joined.
            moved = previous is not None and previous.shift_id != target_shift_id
            if not is_duplicate or moved or rewrites_fiscal:
                if target_shift_id is not None:
                    touched_closed.setdefault(target_shift_id, 0)
                    if previous is None:
                        touched_closed[target_shift_id] += 1
                    elif moved:
                        moved_in[target_shift_id] = moved_in.get(target_shift_id, 0) + 1
                    elif rewrites_fiscal:
                        amended[target_shift_id] = amended.get(target_shift_id, 0) + 1
                if moved and previous.shift_id is not None:
                    touched_closed.setdefault(previous.shift_id, 0)
            if link_warnings:
                logger.warning("Storing document %s without links: %s", tx.id, "; ".join(link_warnings))
            results.append(TransactionUpsertResult(
                id=tx.id,
                status="duplicate" if is_duplicate else "accepted",
                warnings=link_warnings or None,
                server_received_at=datetime.now(timezone.utc),
            ))
        except ShiftConflict:
            _rollback_savepoint(savepoint)
            raise
        except Exception as exc:
            # Not guarded by `is_active`: a failed flush deactivates the savepoint without
            # rolling it back, and every later document of the batch then failed with a
            # PendingRollbackError (see `app.services.z_runs._rollback_savepoint`).
            _rollback_savepoint(savepoint)
            logger.exception("Failed to upsert transaction %s: %s", tx.id, exc)
            results.append(TransactionUpsertResult(
                id=tx.id,
                status="rejected",
                reason=str(exc),
            ))

    # A credit note settles its original (and an original pushed after its credit note
    # is settled on arrival). A status change only: no X or Z moves.
    # Never at the cost of the batch: the documents are written, and a failure here is
    # logged and retried with the next push that names them.
    written = [
        r.id for r in results if r.status != "rejected" and r.reason != "held_by_another_machine"
    ]
    if written:
        savepoint = db.begin_nested()
        try:
            settle_credited_originals(db, machine.tenant_id, written)
            savepoint.commit()
        except Exception:
            _rollback_savepoint(savepoint)
            logger.exception("Could not settle credited originals for %s", written)

    # A document for a shift that is already closed: recompute or flag (see shifts).
    note_documents_after_close(
        db, touched_closed, machine_id=machine.id, moved_in=moved_in, amended=amended
    )
    return results


# ── A credit note settles its original ───────────────────────────────────────

#: Rounding slack between what an original collected and what was credited against it.
CREDIT_TOLERANCE = Decimal("0.01")
#: Half the smallest quantity a line stores (Numeric(12, 3)).
QUANTITY_TOLERANCE = Decimal("0.0005")


def settle_credited_originals(
    db: Session, tenant_id: Optional[uuid.UUID], document_ids: Sequence[uuid.UUID]
) -> None:
    """
    Bring each original named by, or among, `document_ids` to the status its credit
    notes give it — the statuses the till gives its own copy (`SaleRepository.settleCredit`).

    The till marks the sale it refunds `refunded` / `partial_refund` locally but pushes
    only the credit note, so the cloud's copy stayed `completed`. From what is credited
    instead, counting every counted credit note (status in `SALE_STATUSES`; a card
    refund still `pending` has not moved money) that refers to the original — by
    `refund_of_transaction_id`, or by a line whose `refund_of_item_id` is one of the
    original's lines.

    **Per line, when the credit notes say which lines.** If every such credit note names
    the original line of each of its lines (`refundOfItemId`, docs/SHIFTS_API.md §1.2a),
    the original is `refunded` when every one of its lines has been credited in full
    quantity, and `partial_refund` when anything was credited. A credit note that takes
    a line's credited quantity past what that line sold is over-crediting it.

    **By amount otherwise** (unchanged): the cumulative credited amount against what the
    original collected (total − document discount) — credited ≥ collected (one agora of
    slack) → `refunded`; 0 < credited < collected → `partial_refund`.

    Either way, a credit note whose arrival takes the running credited amount (oldest
    first) past what the original collected, or a line past what it sold, is flagged
    `over_credited` and logged — stored all the same, because a fiscal document the till
    issued is never lost.

    Only an original in a counted status is touched (a cancelled or pending one is not a
    sale to refund), and only within `tenant_id`: a credit note cannot restate another
    tenant's document by naming its id, or one of its lines.

    Idempotent: recomputed from what is stored, so a re-push, or the original arriving
    after its credit note, lands on the same result. No X or Z moves: both statuses
    count exactly as `completed` does.
    """
    from app.services.dashboard_stats import SALE_STATUSES

    ids = {i for i in document_ids if i is not None}
    if not ids or tenant_id is None:
        return
    # The originals: those the batch's credit notes name (as a document, or through a
    # line), and batch documents that are themselves credited (the original pushed
    # after its credit note).
    named = {
        r[0]
        for r in db.query(Transaction.refund_of_transaction_id)
        .filter(Transaction.id.in_(ids), Transaction.refund_of_transaction_id.isnot(None))
        .all()
    }
    named_lines = {
        r[0]
        for r in db.query(TransactionItem.refund_of_item_id)
        .filter(TransactionItem.transaction_id.in_(ids), TransactionItem.refund_of_item_id.isnot(None))
        .all()
    }
    if named_lines:
        named |= {
            r[0]
            for r in db.query(TransactionItem.transaction_id)
            .filter(TransactionItem.id.in_(named_lines))
            .all()
        }
    originals = (
        db.query(Transaction)
        .filter(Transaction.id.in_(ids | named), Transaction.tenant_id == tenant_id)
        .populate_existing()
        .all()
    )
    for original in originals:
        sold = {
            it.id: abs(Decimal(str(it.quantity or 0)))
            for it in db.query(TransactionItem)
            .filter(TransactionItem.transaction_id == original.id)
            .populate_existing()
            .all()
        }
        by_line = select(TransactionItem.transaction_id).where(
            TransactionItem.refund_of_item_id.in_(list(sold))
        )
        credits = (
            db.query(Transaction)
            .filter(
                or_(
                    Transaction.refund_of_transaction_id == original.id,
                    Transaction.id.in_(by_line),
                ),
                Transaction.id != original.id,
                Transaction.tenant_id == tenant_id,
                Transaction.status.in_(SALE_STATUSES),
            )
            .populate_existing()
            .all()
        )
        if not credits:
            continue
        lines_of: Dict[uuid.UUID, List[TransactionItem]] = {}
        for line in (
            db.query(TransactionItem)
            .filter(TransactionItem.transaction_id.in_([c.id for c in credits]))
            .populate_existing()
            .all()
        ):
            lines_of.setdefault(line.transaction_id, []).append(line)
        # Per line only if every credit note names the original line of every line it
        # has, and the original has lines to measure against.
        per_line = bool(sold) and all(
            lines_of.get(c.id) and all(l.refund_of_item_id in sold for l in lines_of[c.id])
            for c in credits
        )

        collected = expected_tender_total(
            total_amount=original.total_amount,
            document_discount=original.document_discount,
            document_type=original.document_type,
            refund_of_transaction_id=original.refund_of_transaction_id,
        )
        running = Decimal("0")
        credited_qty: Dict[uuid.UUID, Decimal] = {}
        for credit in sorted(credits, key=lambda c: (_as_utc(c.created_at), str(c.id))):
            linked = [l for l in lines_of.get(credit.id, []) if l.refund_of_item_id in sold]
            if credit.refund_of_transaction_id == original.id:
                running += Decimal(str(credit.total_amount or 0))
            else:
                # Credits this original only through some of its lines.
                running += sum((Decimal(str(l.total_price or 0)) for l in linked), Decimal("0"))
            over = running > collected + CREDIT_TOLERANCE
            for line in linked:
                credited_qty[line.refund_of_item_id] = (
                    credited_qty.get(line.refund_of_item_id, Decimal("0"))
                    + abs(Decimal(str(line.quantity or 0)))
                )
                if credited_qty[line.refund_of_item_id] > sold[line.refund_of_item_id] + QUANTITY_TOLERANCE:
                    over = True
            if over and not credit.over_credited:
                logger.warning(
                    "Credit note %s over-credits original %s: credited %s of %s collected",
                    credit.id, original.id, running, collected,
                )
            credit.over_credited = over
        if original.status not in SALE_STATUSES or running <= 0:
            continue
        if per_line:
            fully = all(
                credited_qty.get(item_id, Decimal("0")) >= qty - QUANTITY_TOLERANCE
                for item_id, qty in sold.items()
                if qty > 0
            )
        else:
            fully = running >= collected - CREDIT_TOLERANCE
        settled = TransactionStatus.REFUNDED if fully else TransactionStatus.PARTIAL_REFUND
        if original.status != settled:
            original.status = settled
    db.flush()


# ── MQTT publish helpers (server -> dashboard heads-up) ──────────────────────

def publish_transactions_synced(tenant_id: Optional[uuid.UUID], machine_id: uuid.UUID, count: int) -> None:
    """Lightweight signal for future dashboard live updates."""
    from app.services.ably_notify import publish_transactions_synced as ably_tx_synced

    if not tenant_id:
        return
    ably_tx_synced(str(tenant_id), str(machine_id), count)
