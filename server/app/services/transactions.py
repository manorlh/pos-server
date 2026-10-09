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
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from pydantic import ValidationError
from sqlalchemy import func, or_, select
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
from app.services.approvals import (  # noqa: F401 - the strict check stays importable from here
    ApprovalRejected,
    resolve_document_approver_claim,
    verify_document_approvers,
)
from app.services.transmissions import leg_terminal_uid, mark_legs_on_ingest
from app.services import card_brands
from app.services.shifts import (
    ShiftConflict,
    note_documents_after_close,
    precheck_document_shifts,
    resolve_shift_for_document,
)
from app.services import document_filing as filing
from app.services.stock import apply_movement
from app.services.promotions import replace_document_promotions
from app.services import menu as _menu
from app.services import product_alerts as _product_alerts
from app.services.z_runs import _rollback_savepoint
from app.services.tenders import (
    UNKNOWN_PAYMENT_METHOD,
    derive_payment_method,
    expected_tender_total,
    is_credit_document_type,
    reconciliation_error,
)

logger = logging.getLogger(__name__)

#: Codes of the quiet notes a document may get at ingest (`transactions.ingest_notes`).
TENDERS_DO_NOT_RECONCILE = "tenders_do_not_reconcile"
REFUND_OF_OTHER_TENANT = "refund_of_other_tenant"
ISSUED_BEFORE_PAIRING = "issued_before_pairing"
#: Clock slack before "issued before this till was paired" is noted.
PAIRING_SKEW = timedelta(minutes=10)


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
        self.voucher_discount = getattr(item, "voucher_discount", None)
        self.details = details


def _voucher_discounts(db: Session, issuer, tx, refund_of) -> List[str]:
    """
    Store the document's discount vouchers (replacing a re-push's) and, on a sale, confirm
    each one's reservation. Returns the warnings of what could not be linked.
    """
    from decimal import Decimal as _D

    from app.models.prepaid_voucher import TransactionVoucherDiscount
    from app.services import prepaid_vouchers as _PV
    from app.services.tenders import is_refund_document

    entries = list(getattr(tx, "voucher_discounts", None) or [])
    db.query(TransactionVoucherDiscount).filter(
        TransactionVoucherDiscount.transaction_id == tx.id
    ).delete(synchronize_session=False)
    if not entries:
        # No deduction — the document may still name its goods holds (a payment leg, memo lines).
        return _confirm_document_holds(db, issuer, tx, refund_of, [])
    rows = []
    for e in entries:
        amount = _D(str(e.amount or 0)).copy_abs().quantize(_D("0.01"))
        rows.append(
            TransactionVoucherDiscount(
                id=uuid.uuid4(),
                transaction_id=tx.id,
                reservation_id=_promotion_uuid(e.reservation_id),
                voucher_id=_promotion_uuid(e.voucher_id),
                batch_id=_promotion_uuid(e.batch_id),
                serial=e.serial,
                batch_name=e.batch_name,
                kind=e.kind,
                uses=int(e.uses or 1),
                discount_amount=amount,
                lines=e.lines,
                redemption_id=_promotion_uuid(getattr(e, "redemption_id", None)),
                type_name=getattr(e, "type_name", None),
                units=getattr(e, "units", None),
            )
        )
    db.bulk_save_objects(rows)
    # `...` is "the link as sent" (see the refund-of-another-tenant rule above).
    link = tx.refund_of_transaction_id if refund_of is ... else refund_of
    if is_refund_document(document_type=tx.document_type, refund_of_transaction_id=link):
        # A credit note credits what was paid; a voucher's use is not given back by it.
        return []
    if tx.status in ("pending", "cancelled"):
        # Not a sale (yet): a card still waiting, or declined. Its re-push as completed
        # confirms; a declined one never does — the till releases the voucher.
        return []
    # A production voucher's deduction names the redemption it books: the redemption learns
    # its document (set once, as `…/redemptions/{id}/transaction` does).
    _PV.link_deductions(db, issuer, str(tx.id), rows)
    warnings: List[str] = []
    for n, e in enumerate(entries):
        if e.reservation_id and _promotion_uuid(e.reservation_id) is None:
            warnings.append(f"voucherDiscounts[{n}].reservationId: unreadable, not confirmed")
    from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION

    # A production voucher's deduction books a redemption already made (its reservation, with
    # reserve → confirm for goods, confirms through its own call); the rest are discount vouchers.
    readable = [
        e for e in entries
        if _promotion_uuid(e.reservation_id) is not None and e.kind != PRODUCTION_VOUCHER_DEDUCTION
    ]
    try:
        with db.begin_nested():
            warnings += _PV.confirm_from_document(db, issuer, str(tx.id), readable, tx.items)
    except Exception:  # noqa: BLE001 — the document stands; the next push confirms again
        logger.exception("document %s: its voucher reservations were not confirmed", tx.id)
        warnings.append("voucherDiscounts: not confirmed now (error); confirmed on the next push")
    return warnings + _confirm_document_holds(db, issuer, tx, refund_of, entries)


def _agorot_of(value) -> int:
    from decimal import ROUND_HALF_UP
    from decimal import Decimal as _D

    return int((_D(str(value or 0)).copy_abs() * 100).quantize(_D(1), rounding=ROUND_HALF_UP))


def _confirm_document_holds(db: Session, issuer, tx, refund_of, entries) -> List[str]:
    """
    A production voucher's goods hold (reserve → confirm, the contract's §3) named by the document,
    in every accounting mode (review 09.10): a deduction (`voucherDiscounts[]` kind
    production_voucher, §4.1), a `production_voucher` payment leg (§4.2) or memo lines (§4.3). The
    document confirms it even when the till's own confirm never landed, with what the document
    booked — the deduction's lines when present, else its amount; the leg's amount; 0 for memo
    lines — compared with the hold's coverage (`amount_mismatch` when they differ).
    """
    from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION
    from app.services import prepaid_vouchers as _PV
    from app.services.tenders import is_production_voucher, is_refund_document

    link = tx.refund_of_transaction_id if refund_of is ... else refund_of
    if is_refund_document(document_type=tx.document_type, refund_of_transaction_id=link):
        return []
    if tx.status in ("pending", "cancelled"):
        return []
    holds: List[tuple] = []  # (where, reservation id, agorot)
    for n, e in enumerate(entries):
        if e.kind != PRODUCTION_VOUCHER_DEDUCTION or not e.reservation_id:
            continue
        lines = [ln for ln in (e.lines or []) if isinstance(ln, dict) and ln.get("amount") is not None]
        amount = sum(_agorot_of(ln.get("amount")) for ln in lines) if lines else _agorot_of(e.amount)
        holds.append((f"voucherDiscounts[{n}]", e.reservation_id, amount))
    for n, p in enumerate(getattr(tx, "payments", None) or []):
        if getattr(p, "reservation_id", None) and is_production_voucher(p.method):
            holds.append((f"payments[{n}]", p.reservation_id, _agorot_of(p.amount)))
    memo: Dict[str, int] = {}
    for it in getattr(tx, "items", None) or []:
        rid = getattr(it, "voucher_reservation_id", None)
        if rid and rid not in memo:
            memo[rid] = 0
    holds += [(f"items[voucherReservationId={rid}]", rid, amount) for rid, amount in memo.items()]
    warnings: List[str] = []
    for where, raw, amount in holds:
        rid = _promotion_uuid(raw)
        if rid is None:
            warnings.append(f"{where}.reservationId: unreadable, not confirmed")
            continue
        try:
            with db.begin_nested():
                _PV.confirm(db, issuer, str(rid), str(tx.id), amount, any_till=True, document_amount=amount)
        except Exception as exc:  # noqa: BLE001 — the document stands; the next push confirms again
            detail = getattr(exc, "detail", None) or exc.__class__.__name__
            warnings.append(f"{where}: the hold was not confirmed ({detail})")
    return warnings


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

    Only these links, and an unreadable approver id (informational since 2026-10-07). A
    document whose money, dates or own id cannot be read is still refused, and so is an
    unreadable `shiftId` (it decides which X the money is in) or `refundOfTransactionId`
    (it decides whether the money is a sale or a refund) — each such refusal is recorded
    in `document_refusals` and shown in the dashboard.
    """
    warnings: List[str] = []
    doc = dict(raw)
    # The basket id groups documents for display; it decides no money, so an unreadable
    # one is dropped like a link rather than refusing the document.
    if _unreadable_uuid(doc.get("basketId")):
        warnings.append(f"basketId: unreadable {_raw(doc['basketId'])}, stored without the link")
        doc["basketId"] = None
    # An approver is informational (docs/SHIFTS_API.md §1.2b, 2026-10-07): an unreadable id
    # never refuses the document; the value as sent stays in the warning.
    for field in ("approvedByUserId", "approvedByPosUserId"):
        if _unreadable_uuid(doc.get(field)):
            warnings.append(f"{field}: unreadable {_raw(doc[field])}, stored without the approver")
            doc[field] = None
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
    claimed_approver_user_id: Optional[uuid.UUID] = None,
    claimed_approver_pos_user_id: Optional[uuid.UUID] = None,
    ingest_notes: Optional[List[dict]] = None,
    refund_of_transaction_id: Any = ...,
    filing_fields: Optional[Dict[str, Any]] = None,
) -> Dict:
    """
    Flatten one incoming document into the row the upsert writes.

    `payment_method`, `customer_ref_id` and `approved_by_user_id` are the values the
    *server* decides rather than copies: the first is derived from the tender legs,
    the second is the till's `customer_id` after it has been checked against this
    tenant's customers, and the third is the till's claimed approver linked when they
    are a person of this business (`app.services.approvals.resolve_document_approver_claim`;
    the claim itself is kept as sent in `claimed_approver_*`). All default to the
    pre-existing behaviour — the till's own `payment_method`, no customer link, no
    approver — so a caller that passes none still produces the row this function
    produced before any of them existed. `refund_of_transaction_id` overrides the
    document's own link only when passed (a link to another tenant's document dropped).
    `machine` is the machine that *issued* the document (`document_filing.issuing_machine`);
    `filing_fields` adds where and how it was filed (`claimed_shift_id`, `pushed_by_machine_id`,
    `number_conflict_of`, `duplicate_copy`) when the caller decided them.
    """
    return {
        **(filing_fields or {}),
        "id": tx.id,
        "tenant_id": machine.tenant_id,
        "machine_id": machine.id,
        "shop_id": machine.shop_id,
        "shift_id": shift_id,
        "transaction_number": tx.transaction_number,
        "status": tx.status,
        "document_type": tx.document_type,
        # (`document_series` — 320 / 330 / 400 — is computed by the database from the type.)
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
        # The till's "קידומת מסמכים" as it froze it at issue and printed it (`20000057`).
        # Copied, never derived: a till build that sends none leaves it null, and the
        # document reads as its `pos_number` (docs/SPEC_DOCUMENT_PREFIX.md).
        "document_prefix": getattr(tx, "document_prefix", None),
        "tip_amount": tx.tip_amount or 0,
        "tip_payment_method": tx.tip_payment_method,
        "total_discount": tx.total_discount,
        "document_discount": tx.document_discount,
        # The basket discount on its own and its kind (`club` / `manual`), when sent.
        "basket_discount": getattr(tx, "basket_discount", None),
        "basket_discount_percent": getattr(tx, "basket_discount_percent", None),
        "basket_discount_kind": getattr(tx, "basket_discount_kind", None),
        # Production vouchers' ₪0 memo document (§4.3): out of the counts, as on the till — only
        # when that is safe (no total, no money leg, no tip; review 09.10), else a sale as any.
        "voucher_memo": getattr(tx, "voucher_memo", False) is True and voucher_memo_problem(tx) is None,
        # A staff / managers' table meal: its kind, whose meal, why (app/services/table_policies.py).
        "meal_kind": getattr(tx, "meal_kind", None),
        "meal_employee_id": getattr(tx, "meal_employee_id", None),
        "meal_employee_name": getattr(tx, "meal_employee_name", None),
        "meal_reason": getattr(tx, "meal_reason", None),
        "wht_deduction": tx.wht_deduction,
        "customer_id": tx.customer_id,
        "customer_ref_id": customer_ref_id,
        "cashier_id": tx.cashier_id,
        "branch_id": tx.branch_id,
        "notes": tx.notes,
        "refund_of_transaction_id": (
            tx.refund_of_transaction_id if refund_of_transaction_id is ... else refund_of_transaction_id
        ),
        "nayax_meta": tx.nayax_meta,
        # getattr: a caller may hand in a document built before these fields existed.
        "basket_id": getattr(tx, "basket_id", None),
        "customer_name": getattr(tx, "customer_name", None),
        "customer_phone": getattr(tx, "customer_phone", None),
        "customer_address": getattr(tx, "customer_address", None),
        "approved_by_user_id": approved_by_user_id,
        "approved_by_pos_user_id": approved_by_pos_user_id,
        # The approver exactly as sent, and the quiet notes of ingest (docs/SHIFTS_API.md §1.2b).
        "claimed_approver_user_id": claimed_approver_user_id,
        "claimed_approver_pos_user_id": claimed_approver_pos_user_id,
        "ingest_notes": list(ingest_notes) if ingest_notes else None,
        # "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the request a credit answers, and
        # "no money moved" when any of its legs says so.
        "remote_credit_request_id": getattr(tx, "remote_credit_request_id", None),
        "no_money_movement": any(
            bool(getattr(leg, "no_money_movement", False)) for leg in (getattr(tx, "payments", None) or [])
        ),
        "created_at": tx.created_at,
        "updated_at": tx.updated_at,
    }


def voucher_memo_problem(tx) -> Optional[str]:
    """
    Why a document's `voucherMemo` (production vouchers' ₪0 memo lines only, the contract's §4.3)
    cannot be honoured — it would leave money out of the Z: a total, a money leg or a tip. None: safe.
    """
    from decimal import Decimal as _D
    from decimal import InvalidOperation

    if getattr(tx, "voucher_memo", False) is not True:
        return None
    try:
        if _D(str(getattr(tx, "total_amount", 0) or 0)) != 0:
            return "the document has a total"
        if any(_D(str(getattr(p, "amount", 0) or 0)) != 0 for p in (getattr(tx, "payments", None) or [])):
            return "the document has a money leg"
        if _D(str(getattr(tx, "tip_amount", 0) or 0)) != 0:
            return "the document has a tip"
    except (InvalidOperation, TypeError, ValueError):
        return "the document's amounts are unreadable"
    return None


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

    **Every document the till issued lands** — the owner's rule (2026-10-07): "כל מסמך
    שבוצע במכשירים חייב לעלות לענן ולהיות חלק מהזד והאיקס/משמרת". Nothing about a
    document's *content* refuses it any more: tender legs that do not add up, a refund
    link to another tenant's document and an approver nobody here knows are each stored
    as sent with a quiet note in `ingest_notes` (shown in the document's detail). Only what
    is not a document at all is still refused — a payload the model cannot read (the
    router's `validate_documents`) or a write the database refuses — and every refusal is
    recorded in `document_refusals` ("מסמך שנדחה בענן") by the router.

    For each tx:
      - Note (never reject) a `payments` array that does not reconcile.
      - Keep the claimed approver as sent; link it when it is a person of this business.
      - File it under the till that issued it, in a shift (`app.services.document_filing`,
        docs/SHIFTS_API.md §1.2c-bis): the shift it names; one it names that the cloud
        has not seen, created open when nothing else of the till is open; else the
        till's shift covering its issue time; else the till's "documents waiting for a
        shift", which its next Z takes. Never adopting another open shift, and never a
        409 for the batch: a document that cannot open its shift waits for it.
      - A number the till already used for another document is stored too, flagged
        (`number_conflict_of`; a duplicate copy is counted once — §1.2d).
      - A correction to a document a Z already counted is carried into the till's next
        Z as an adjustment (`app.services.z_adjustments`).
      - INSERT ... ON CONFLICT (id) DO UPDATE SET ... — `status` reports 'accepted' for new rows
        and 'duplicate' for rows that already existed at the same updated_at.
      - Replace items atomically: DELETE existing items by transaction_id, then INSERT the new list.
      - Replace tender legs the same way, synthesising one from `paymentMethod` when the
        till sent no array.

    **History — why an unbalanced `payments` array used to be rejected** (superseded by
    the rule above: the document is now stored with the note `tenders_do_not_reconcile`,
    and the OpenFormat export must read that note). A document whose tenders do not sum
    to its total cannot be audited: it is either
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

    # Shifts the batch names that the cloud has not seen and whose documents cannot open
    # them — another shift of the till is open, or several are unknown at once: those
    # documents wait for their shift (`document_filing`, rule 2). The rest of the batch is
    # never held up by them (it used to be a 409 for the whole batch).
    must_wait, open_shift_id = precheck_document_shifts(db, machine, [tx.shift_id for tx in transactions])

    # Closed shifts a written document lands in (or leaves) → new documents among them.
    touched_closed: Dict[uuid.UUID, int] = {}
    # Known documents moved into a shift, and known documents whose fiscal content this
    # push rewrote in place — both flagged if that shift turns out to be in a Z.
    moved_in: Dict[uuid.UUID, int] = {}
    amended: Dict[uuid.UUID, int] = {}
    # Per closed shift, the documents this push wrote into it new or moved in — those a Z
    # that already took the shift did not count, carried into the next Z (§4.6.3).
    written_into: Dict[uuid.UUID, List[uuid.UUID]] = {}
    # The machines the documents were filed under: this till, and a till this device was
    # before it was re-paired as a new machine (`document_filing`, rule 1).
    issuers: Dict[Any, POSMachine] = {machine.id: machine}
    issuer_of: Dict[Any, POSMachine] = {}
    # Corrections to documents already in a Z: (issuer, document id, Z id, shift id, before).
    corrections: List[tuple] = []

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
        pending_correction = None
        try:
            previous = existing_map.get(tx.id)
            # Rule 1: the machine that issued it — this till, or the till this device was
            # before it was re-paired as a new machine (docs/SHIFTS_API.md §1.2c-bis).
            issuer, _issued_why = filing.issuing_machine(
                db, machine, shift_id=tx.shift_id, created_at=tx.created_at
            )
            moving_machine = False
            if previous is not None and str(previous.machine_id) != str(issuer.id):
                previous_z = None
                if previous.shift_id is not None:
                    found_z = db.query(Shift.z_report_id).filter(Shift.id == previous.shift_id).first()
                    previous_z = found_z[0] if found_z is not None else None
                if str(previous.machine_id) == str(machine.id) and issuer is not machine and previous_z is None:
                    # Stored under this till before the cloud knew which till issued it
                    # (no link yet): re-filed under the issuer now. One a Z of this till
                    # already counted stays where it was counted.
                    moving_machine = True
                else:
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
            issuers.setdefault(issuer.id, issuer)
            issuer_of[tx.id] = issuer

            # Nothing about the document's content refuses it (the owner's rule, see the
            # docstring): each of these is stored as sent with a quiet note.
            ingest_notes: List[dict] = []
            tender_problem = _tender_rejection_reason(tx)
            if tender_problem is not None:
                logger.warning("Storing transaction %s with a tender note: %s", tx.id, tender_problem)
                ingest_notes.append({
                    "code": TENDERS_DO_NOT_RECONCILE,
                    "text": "אמצעי התשלום במסמך אינם מסתכמים לסכום המסמך — נשמר כפי שנשלח מהקופה",
                    "detail": tender_problem,
                })
                link_warnings.append(f"{tender_problem} — stored as sent")
            memo_problem = voucher_memo_problem(tx)
            if memo_problem is not None:
                logger.warning("Transaction %s: voucherMemo ignored (%s)", tx.id, memo_problem)
                link_warnings.append(f"voucherMemo ignored: {memo_problem}")

            # A refund link to another tenant's document: never resolved across tenants
            # (every read is tenant-scoped), so it is dropped — unless the link is what makes
            # the document a credit (no credit type), then kept as sent: dropping it would
            # turn a refund into a sale. Either way the document is stored, with a note.
            refund_of = ...
            if _refund_of_other_tenant(db, tx.refund_of_transaction_id, issuer.tenant_id):
                keep = not is_credit_document_type(tx.document_type)
                logger.warning(
                    "Storing transaction %s: refundOfTransactionId %s is another tenant's (%s)",
                    tx.id, tx.refund_of_transaction_id, "kept" if keep else "dropped",
                )
                if not keep:
                    refund_of = None
                ingest_notes.append({
                    "code": REFUND_OF_OTHER_TENANT,
                    "text": "המסמך מזכה מסמך של עסק אחר — "
                    + ("הקישור נשמר כפי שנשלח (הוא שהופך את המסמך לזיכוי)" if keep else "הקישור לא נשמר")
                    + " והמסמך נקלט",
                })
                link_warnings.append(
                    "refundOfTransactionId: names a document of another tenant, stored "
                    + ("as sent (it is what makes the document a credit)" if keep else "without the link")
                )

            # The approver: kept as sent, linked when they are of the issuing till's
            # business, never a reason to refuse or hold the document.
            claim = resolve_document_approver_claim(db, issuer, tx)
            ingest_notes.extend(claim.notes)
            if issuer is not machine:
                # Issued by the till this device was before it was re-paired (the F20,
                # 2026-10-05): filed under that till, said so.
                ingest_notes.append(filing.filed_under_note(issuer, machine))
            else:
                # Issued before this till was paired, with no till it can be traced to (no
                # re-pair link): kept under the till that sent it, and said so.
                machine_since = getattr(machine, "created_at", None)
                if (
                    isinstance(machine_since, datetime)
                    and isinstance(tx.created_at, datetime)
                    and _as_utc(tx.created_at) < _as_utc(machine_since) - PAIRING_SKEW
                ):
                    ingest_notes.append({
                        "code": ISSUED_BEFORE_PAIRING,
                        "text": "המסמך הונפק לפני שהקופה שויכה לעסק הזה (המכשיר שויך מחדש) — נקלט תחת הקופה ששלחה אותו",
                    })

            legs = _normalized_payment_legs(tx)

            business_date_value: Optional[date] = None
            if tx.business_date:
                try:
                    business_date_value = date.fromisoformat(tx.business_date)
                except ValueError:
                    business_date_value = tx.created_at.date() if tx.created_at else None
            else:
                business_date_value = tx.created_at.date() if tx.created_at else None

            # Rule 2: the shift (docs/SHIFTS_API.md §1.2c-bis, `document_filing`).
            named: Optional[Shift] = None
            wait_reason: Optional[str] = None
            other_till_shift = False
            if tx.shift_id is not None:
                found = db.query(Shift).filter(Shift.id == tx.shift_id).first()
                if found is not None and str(found.machine_id) == str(issuer.id):
                    named = found
                elif found is None and issuer is machine and tx.shift_id not in must_wait:
                    # The sale beat its shift's open event: the shift is created from it.
                    named = resolve_shift_for_document(
                        db, machine, shift_id=tx.shift_id,
                        business_date=business_date_value, opened_at=tx.created_at,
                    )
                elif found is None:
                    # Not openable from here (another shift of the till is open, several
                    # are unknown, or it is the previous till's): the document waits.
                    wait_reason = (
                        "predecessor_unknown_shift" if issuer is not machine
                        else ("unknown_shift_while_open" if open_shift_id is not None else "unknown_shifts")
                    )
                else:
                    other_till_shift = True
                    logger.warning(
                        "machine %s pushed document %s naming shift %s of machine %s; filed by time",
                        machine.id, tx.id, tx.shift_id, found.machine_id,
                    )

            held = None  # (machine_id, z_report_id) of the shift the document is in now
            if previous is not None and previous.shift_id is not None:
                held = (
                    db.query(Shift.machine_id, Shift.z_report_id)
                    .filter(Shift.id == previous.shift_id)
                    .first()
                )
            held_by_other_till = held is not None and str(held[0]) != str(issuer.id)
            filed_how: Optional[str] = None
            if named is not None:
                target_shift_id = named.id
            elif (
                wait_reason is None
                and previous is not None
                and previous.shift_id is not None
                and held is not None
                and not held_by_other_till
            ):
                # A re-push that names no shift (or one it cannot be filed in) never
                # detaches a document from the issuing till's shift it is already in.
                target_shift_id = previous.shift_id
            elif previous is not None and held is not None and held[1] is not None and not moving_machine:
                # In another till's shift a Z already took (possible before that was
                # refused): counted there; moving it would change a filed Z.
                target_shift_id = previous.shift_id
            else:
                # No shift, another till's, or one that cannot be opened from here: the
                # issuing till's shift covering the issue time, else its waiting bucket.
                covering = filing.covering_shift(db, issuer.id, tx.created_at) if wait_reason is None else None
                if covering is not None:
                    target_shift_id = covering.id
                    filed_how = "covering"
                else:
                    bucket = filing.waiting_shift(
                        db, issuer, business_date=business_date_value, issued_at=tx.created_at,
                        reason=wait_reason or "no_covering_shift",
                    )
                    target_shift_id = bucket.id
                    filed_how = "waiting"

            if (
                previous is not None
                and previous.shift_id is not None
                and previous.shift_id != target_shift_id
                and not moving_machine
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
                    filed_how = None
                else:
                    # A late document the cloud carried out of a support Z's shift stays in
                    # its carry shift, bound for the till's next Z (offline till Z §4.6.3).
                    from app.services.late_documents import is_carry_shift

                    if is_carry_shift(db, previous.shift_id):
                        target_shift_id = previous.shift_id
                        filed_how = None

            ingest_notes.extend(_filing_notes(filed_how, wait_reason, other_till_shift, open_shift_id))
            if filed_how == "waiting":
                link_warnings.append(
                    f"shiftId {tx.shift_id or 'absent'}: {wait_reason or 'no_covering_shift'} — stored with the "
                    "till's documents waiting for a shift (counted in its next Z; moved into its shift when it arrives)"
                )

            # Before the row is rewritten: would this push change what the document
            # contributes to its shift's figures? Only asked for a closed shift, where a
            # Z may already hold the old figures (see `note_documents_after_close`).
            rewrites_fiscal = False
            target_z = None
            if previous is not None and target_shift_id is not None and previous.shift_id == target_shift_id:
                closed_row = (
                    db.query(Shift.z_report_id)
                    .filter(Shift.id == target_shift_id, Shift.status == ShiftStatus.CLOSED)
                    .first()
                )
                if closed_row is not None:
                    rewrites_fiscal = _stored_fiscal_key(db, previous) != _incoming_fiscal_key(tx, legs)
                    target_z = closed_row[0]
            if rewrites_fiscal and target_z is not None:
                # A correction to a document a Z already counted: its old contribution,
                # read before the row and its legs are rewritten — the till's next Z
                # carries the difference as an adjustment (docs/SHIFTS_API.md §1.2).
                from app.services.shift_totals import document_totals

                pending_correction = (issuer, tx.id, target_z, target_shift_id, document_totals(db, previous))

            # Rule 3: "same number, different id" — stored too, flagged (§1.2d).
            number_conflict_of, duplicate_copy = _numbering(
                db, issuer, tx, legs, previous, refund_of, moving_machine, ingest_notes, link_warnings,
            )

            row = _serialize_tx_for_upsert(
                tx,
                issuer,
                target_shift_id,
                payment_method=derive_payment_method(
                    [leg.method for leg in legs], fallback=tx.payment_method
                ),
                customer_ref_id=_resolve_customer_ref_id(
                    db, tx.customer_id, issuer.tenant_id
                ),
                approved_by_user_id=claim.user_id,
                approved_by_pos_user_id=claim.pos_user_id,
                claimed_approver_user_id=claim.claimed_user_id,
                claimed_approver_pos_user_id=claim.claimed_pos_user_id,
                ingest_notes=ingest_notes,
                refund_of_transaction_id=refund_of,
                filing_fields={
                    "claimed_shift_id": tx.shift_id,
                    "pushed_by_machine_id": machine.id if issuer is not machine else None,
                    "number_conflict_of": number_conflict_of,
                    "duplicate_copy": duplicate_copy,
                },
            )
            stmt = pg_insert(Transaction).values(**row)
            # Re-filed under the issuing till: its machine and tenant are rewritten too.
            frozen = ("id", "server_received_at") if moving_machine else ("id", "tenant_id", "machine_id", "server_received_at")
            update_cols = {k: stmt.excluded[k] for k in row.keys() if k not in frozen}
            # The prefix is frozen at issue (docs/SPEC_DOCUMENT_PREFIX.md): a re-push never
            # changes one already stored, it can only fill one that is missing.
            update_cols["document_prefix"] = func.coalesce(
                Transaction.document_prefix, stmt.excluded.document_prefix
            )
            # The shift the till named: the latest it named, never wiped by a push naming none.
            update_cols["claimed_shift_id"] = func.coalesce(
                stmt.excluded.claimed_shift_id, Transaction.claimed_shift_id
            )
            stmt = stmt.on_conflict_do_update(index_elements=[Transaction.id], set_=update_cols)
            db.execute(stmt)
            if number_conflict_of is not None and not duplicate_copy:
                # "יומן חריגות": a numbering conflict, logged once the push commits (the
                # upsert bypasses the ORM, app/services/exception_alerts/hooks.py).
                from app.services.exception_alerts import hooks as _exception_log

                _exception_log.note(db, "transaction", tx.id)

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
                            _safe_item_product_id(db, it.product_id, issuer.tenant_id), it.product_id,
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
                            db, it.refund_of_item_id, issuer.tenant_id,
                            f"items[{i}].refundOfItemId", link_warnings,
                        ),
                        promotion_discount=it.promotion_discount,
                        promotion_id=_promotion_uuid(it.promotion_id),
                        # Discount vouchers' share (docs/SPEC_VOUCHER_PRODUCTION.md §7).
                        voucher_discount=getattr(it, "voucher_discount", None),
                        # Production vouchers: the deduction's share, a ₪0 memo line's value.
                        prepaid_deduction=getattr(it, "prepaid_deduction", None),
                        voucher_memo_value=getattr(it, "voucher_memo_value_agorot", None),
                        voucher_redemption_id=getattr(it, "voucher_redemption_id", None),
                        # What the dish was ordered with (docs/SPEC_MENU_MODIFIERS.md).
                        details=_menu.clean_details(it.details),
                        upsell_rule_id=_promotion_uuid(it.upsell_rule_id),
                        # OTH ("על חשבון הבית"): why the line went free, by whom, approved by whom.
                        oth_reason=getattr(it, "oth_reason", None),
                        oth_by=getattr(it, "oth_by", None),
                        oth_approved_by=getattr(it, "oth_approved_by", None),
                        # "הודעות לעובד על פריט": who confirmed the alerts, and when.
                        alerts_ack=_product_alerts.item_ack(it),
                        # "תפריטים": the menu active when the line was added, and its price's source.
                        menu_id=_promotion_uuid(getattr(it, "menu_id", None)),
                        menu_name=getattr(it, "menu_name", None),
                        price_source=getattr(it, "price_source", None),
                    )
                    for i, it in enumerate(tx.items)
                ])
            # The promotions ("מבצעים") the till applied, replaced like the items.
            replace_document_promotions(db, tx.id, tx.promotions)
            # The discount vouchers, replaced like the promotions; a sale confirms their
            # reservations — the outbox path of reserve → confirm, which never fails the
            # document (docs/SPEC_VOUCHER_PRODUCTION.md §7).
            link_warnings.extend(_voucher_discounts(db, issuer, tx, refund_of))
            # The club member the sale was made for (docs/SPEC_NOTIFICATIONS_CLUB.md §26);
            # never a reason to refuse the document.
            if getattr(tx, "club_membership_id", None):
                from app.services.club.sale_link import link_sale

                link_sale(db, issuer, tx.id, tx.club_membership_id)
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
                    # "ללא החזר כספי" (docs/SPEC_REMOTE_CREDIT.md): no money moved on it.
                    no_money_movement=bool(getattr(leg, "no_money_movement", False)),
                )
                for leg in legs
            ])
            # A batch that already carried this sale (the report came first, or this is a
            # re-push that just replaced the legs) marks it again from the kept uids.
            mark_legs_on_ingest(
                db,
                issuer,
                [(leg.id, leg_terminal_uid(leg.method, leg.nayax_meta)) for leg in legs],
            )

            db.query(IssuedVoucher).filter(
                IssuedVoucher.transaction_id == tx.id
            ).delete(synchronize_session=False)
            if tx.issued_vouchers:
                db.bulk_save_objects([
                    IssuedVoucher(
                        id=iv.id,
                        tenant_id=issuer.tenant_id,
                        shop_id=issuer.shop_id,
                        machine_id=issuer.id,
                        transaction_id=tx.id,
                        transaction_item_id=iv.transaction_item_id,
                        voucher_id=_kept_link(
                            _safe_voucher_id(db, iv.voucher_id, issuer.tenant_id), iv.voucher_id,
                            f"issuedVouchers[{i}].voucherId", link_warnings,
                        ),
                        product_id=_kept_link(
                            _safe_issued_product_id(db, iv.product_id, issuer.tenant_id), iv.product_id,
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

            if tx.stock_movements and issuer.shop_id and issuer.tenant_id:
                for i, sm in enumerate(tx.stock_movements):
                    if sm.product_id is None:
                        continue  # nothing named, nothing to move (as before)
                    if _safe_item_product_id(db, sm.product_id, issuer.tenant_id) is None:
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
                        tenant_id=issuer.tenant_id,
                        shop_id=issuer.shop_id,
                        product_id=sm.product_id,
                        delta=sm.delta,
                        reason=reason,
                        occurred_at=sm.occurred_at,
                        transaction_id=tx.id,
                        transaction_item_id=sm.transaction_item_id,
                        machine_id=issuer.id,
                        note=sm.note,
                    )

            is_duplicate = previous is not None and (
                previous.updated_at is not None
                and tx.updated_at is not None
                and _as_utc(previous.updated_at) >= _as_utc(tx.updated_at)
            )
            savepoint.commit()
            if pending_correction is not None:
                corrections.append(pending_correction)
            # The row is written even when the push is a "duplicate" (same updated_at),
            # so a move between shifts happens either way — and the shift it left needs
            # its X recomputed as much as the one it joined.
            moved = previous is not None and previous.shift_id != target_shift_id
            if not is_duplicate or moved or rewrites_fiscal:
                if target_shift_id is not None:
                    touched_closed.setdefault(target_shift_id, 0)
                    if previous is None:
                        touched_closed[target_shift_id] += 1
                        written_into.setdefault(target_shift_id, []).append(tx.id)
                    elif moved:
                        moved_in[target_shift_id] = moved_in.get(target_shift_id, 0) + 1
                        written_into.setdefault(target_shift_id, []).append(tx.id)
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
    # Per issuing till (this one, or the till this device was before a re-pair).
    written_by_issuer: Dict[Any, List[uuid.UUID]] = {}
    for doc_id in written:
        written_by_issuer.setdefault(issuer_of.get(doc_id, machine).id, []).append(doc_id)
    for issuer_id, ids in written_by_issuer.items():
        issuer = issuers.get(issuer_id, machine)
        savepoint = db.begin_nested()
        try:
            settle_credited_originals(db, issuer.tenant_id, ids)
            savepoint.commit()
        except Exception:
            _rollback_savepoint(savepoint)
            logger.exception("Could not settle credited originals for %s", ids)
        # "זיכוי מרחוק": a credit that names its request completes it (docs/SPEC_REMOTE_CREDIT.md).
        savepoint = db.begin_nested()
        try:
            from app.services import remote_credits

            remote_credits.on_documents(db, issuer, ids)
            savepoint.commit()
        except Exception:
            _rollback_savepoint(savepoint)
            logger.exception("Could not link remote credit requests for %s", ids)

    # A document for a shift that is already closed: recompute or flag (see shifts).
    note_documents_after_close(
        db, touched_closed, machine_id=machine.id, moved_in=moved_in, amended=amended, written=written_into,
        machine_ids={m for m in issuers},
    )
    # Corrections to documents a Z already counted: the difference waits for the till's
    # next Z, which carries it as an adjustment (never a silent counter-only bump).
    if corrections:
        from app.services import z_adjustments

        for issuer, doc_id, z_id, shift_id, before in corrections:
            savepoint = db.begin_nested()
            try:
                z_adjustments.record(db, issuer, doc_id, z_id, shift_id, before)
                savepoint.commit()
            except Exception:
                _rollback_savepoint(savepoint)
                logger.exception("Could not record the correction of document %s (in Z %s)", doc_id, z_id)
    return results


def _filing_notes(
    filed_how: Optional[str], wait_reason: Optional[str], other_till_shift: bool, open_shift_id: Any,
) -> List[dict]:
    """The quiet notes saying where rule 2 filed the document (`document_filing`)."""
    if filed_how == "covering":
        return [{
            "code": filing.FILED_BY_TIME,
            "text": ("המסמך נשא משמרת של קופה אחרת" if other_till_shift else "המסמך נשלח בלי משמרת")
            + " — נקלט במשמרת של הקופה שמכסה את מועד הפקתו",
        }]
    if filed_how == "waiting":
        reason = wait_reason or "no_covering_shift"
        note = {
            "code": filing.WAITING_FOR_SHIFT,
            "text": filing.WAIT_REASONS[reason]
            + " — המסמך נשמר ב\"מסמכים שהמתינו למשמרת\" של הקופה ונכלל ב-Z הבא שלה",
            "reason": reason,
        }
        if reason == "unknown_shift_while_open" and open_shift_id is not None:
            note["openShiftId"] = str(open_shift_id)
        return [note]
    return []


#: How far apart two copies of one document may have been stamped (they are the same moment).
SAME_DOCUMENT_SLACK = timedelta(seconds=1)


def _same_document(db: Session, holder: Transaction, tx: TransactionIn, legs: List[TransactionPaymentIn]) -> bool:
    """
    Whether `tx` is the document `holder` already is, under another id: the same issue
    moment and the same fiscal content (number, type, money, tenders, refund link). A
    number reissued for another sale — however alike — has another moment.
    """
    if holder.created_at is None or tx.created_at is None:
        return False
    if abs(_as_utc(holder.created_at) - _as_utc(tx.created_at)) > SAME_DOCUMENT_SLACK:
        return False
    return _stored_fiscal_key(db, holder) == _incoming_fiscal_key(tx, legs)


def _numbering(
    db: Session,
    issuer: POSMachine,
    tx: TransactionIn,
    legs: List[TransactionPaymentIn],
    previous: Optional[Transaction],
    refund_of: Any,
    moving_machine: bool,
    notes: List[dict],
    warnings: List[str],
) -> Tuple[Optional[uuid.UUID], bool]:
    """
    (`number_conflict_of`, `duplicate_copy`) for the document (docs/SHIFTS_API.md §1.2d):
    looked up when it is new, moves, changes its number or series, or is a conflict already;
    else what is stored stays. A conflict adds its note and warning.
    """
    from app.services.document_prefix import document_series_of

    series = document_series_of(
        tx.document_type, tx.refund_of_transaction_id if refund_of is ... else refund_of
    )
    conflict_of = getattr(previous, "number_conflict_of", None) if previous is not None else None
    duplicate = bool(getattr(previous, "duplicate_copy", False)) if previous is not None else False
    stored_series = getattr(previous, "document_series", None) if previous is not None else None
    if not (
        previous is None
        or moving_machine
        or conflict_of is not None
        or (previous.transaction_number or "") != (tx.transaction_number or "")
        or (stored_series is not None and int(stored_series) != int(series))
    ):
        return conflict_of, duplicate
    holder = filing.numbering_holder(db, issuer.id, series, tx.transaction_number, tx.id)
    if holder is None:
        return None, False
    duplicate = _same_document(db, holder, tx, legs)
    notes.append(filing.numbering_note(holder, duplicate))
    warnings.append(
        f"transactionNumber {tx.transaction_number}: already held by document {holder.id} — "
        + ("a duplicate copy, stored and counted once" if duplicate
           else "another document with the same number, stored and counted")
    )
    logger.warning(
        "Document %s of machine %s reuses number %s (series %s) held by %s (duplicate copy: %s)",
        tx.id, issuer.id, tx.transaction_number, series, holder.id, duplicate,
    )
    return holder.id, duplicate


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
                Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False),
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
