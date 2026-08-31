"""
Split tender: the one place that decides what a document's tenders add up to.

A document can now carry several tender legs (`transaction_payments`) — ₪50 cash
and the rest by card is two rows. Three rules live here because getting any of them
wrong in one caller and right in another is how a report starts disagreeing with the
till and nobody can say which is lying.

1. **What the legs must sum to.** For a sale, the money collected is
   `total_amount - document_discount`: `total_amount` is the *gross* of the line
   totals and `document_discount` carries the sum of the line discounts (see the
   docstring of `app/services/reports.py`, and `SaleRepository.buildTransaction` on
   the till). For a credit note, `total_amount` is *already* the money handed back
   and `document_discount` must not be subtracted again.

2. **Tips are not tenders.** `tip_amount` sits on the document with its own
   `tip_payment_method` and is deliberately outside the reconciliation target. Two
   reasons: every existing report treats tips as money that is not sale takings, and
   the OpenFormat payment records (D120) belong to the document total, so folding a
   tip into a leg would put money in the tax file that the document does not claim.

3. **What `transactions.payment_method` says.** It stays populated for every
   document — an older till build, every report written before this change, and the
   tax export all read it. One leg means that leg's method; more than one means the
   literal `"mixed"`. See `derive_payment_method`.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Iterable, Optional, Sequence

from sqlalchemy import case, func, or_

from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment

# Israeli Tax Authority document type for a credit note (refund); 320 is the
# invoice/receipt. Mirrors `domain/Documents.kt` on the till and the constant of the
# same name in `app/services/reports.py`.
CREDIT_NOTE_DOCUMENT_TYPE = 330

# The value `transactions.payment_method` carries for a document with more than one
# tender leg.
#
# Why a new sentinel rather than the largest leg's method: picking one of the legs
# would make every reader that has not been taught about split tender attribute the
# *whole* document to that tender — which is exactly the bug this change exists to
# fix, except silent and undetectable after the fact. "mixed" is wrong for nobody:
# `normalize_tender` maps it to the existing `other` bucket, so a legacy report shows
# the money as unclassified instead of inflating cash or card, and the shipped
# Android till's tender label already has an `else` branch for methods it does not
# know.
MIXED_PAYMENT_METHOD = "mixed"

# Fallback method for a leg whose tender the client did not name. Chosen to match
# what `normalize_tender` already does with an unrecognised value, so a null method
# never teaches a downstream bucket a new case.
UNKNOWN_PAYMENT_METHOD = "other"

# Rounding slack allowed when checking that the legs sum to the document.
#
# Per leg, not flat: amounts are Numeric(12,2) here and integer agorot on the till,
# so the only legitimate gap is the half-agora each leg can be rounded by when a
# cashier splits a bill "in half". One agora per leg permits that and nothing that
# could hide a real mis-tender.
TENDER_TOLERANCE_PER_LEG = Decimal("0.01")


def normalize_tender(method: Optional[str]) -> str:
    """Collapse a payment method to cash / card / other for the tender splits."""
    m = (method or "").strip().lower()
    if m == "cash":
        return "cash"
    if m == "card":
        return "card"
    return "other"


def is_refund_document(
    *, document_type: Optional[int], refund_of_transaction_id: Optional[object]
) -> bool:
    """
    Python-side twin of `reports._is_refund_condition`.

    Both signals are checked because either alone has a gap: a legacy row may have a
    null `document_type`, and a credit note raised outside the refund flow may not
    carry the back-link.
    """
    return document_type == CREDIT_NOTE_DOCUMENT_TYPE or refund_of_transaction_id is not None


def _dec(value) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def expected_tender_total(
    *,
    total_amount,
    document_discount,
    document_type: Optional[int],
    refund_of_transaction_id: Optional[object],
) -> Decimal:
    """
    The amount the tender legs of one document must add up to. Excludes tips.

    Asymmetric between a sale and a credit note because the stored amounts are
    asymmetric — see rule 1 in the module docstring.
    """
    total = _dec(total_amount)
    if is_refund_document(
        document_type=document_type, refund_of_transaction_id=refund_of_transaction_id
    ):
        return total
    return total - _dec(document_discount)


def reconciliation_error(
    expected: Decimal, amounts: Sequence[Decimal]
) -> Optional[str]:
    """
    Return a human-readable reason if the legs do not reconcile, else None.

    Rejecting rather than accepting-and-flagging is a deliberate call; the reasoning
    is in `upsert_transactions`.
    """
    if not amounts:
        return None
    actual = sum((_dec(a) for a in amounts), Decimal("0"))
    tolerance = TENDER_TOLERANCE_PER_LEG * max(1, len(amounts))
    if abs(actual - expected) <= tolerance:
        return None
    return (
        f"payments do not reconcile: legs sum to {actual} but the document's "
        f"collectable amount is {expected} (tolerance {tolerance}). Tips are not "
        f"tender legs and must stay in tipAmount."
    )


def derive_payment_method(
    methods: Iterable[str], fallback: Optional[str] = None
) -> Optional[str]:
    """
    The single-value summary written to `transactions.payment_method`.

    * no legs           → whatever the till sent, unchanged (legacy path)
    * one leg           → that leg's method, so nothing changes for a single tender
    * one *distinct*    → that method: two ₪25 cash legs are still a cash document
    * two or more       → `MIXED_PAYMENT_METHOD`

    Collapsing repeated identical tenders matters: a cashier who takes two notes on
    two swipes of the cash key has not created a mixed document, and calling it mixed
    would push an ordinary cash sale out of the cash bucket of every legacy report.
    """
    distinct = {(m or "").strip().lower() for m in methods if (m or "").strip()}
    if not distinct:
        return fallback
    if len(distinct) == 1:
        return next(iter(distinct))
    return MIXED_PAYMENT_METHOD


# ── SQL expressions shared by the reports ─────────────────────────────────────
#
# Every tender split is now a LEFT OUTER JOIN from `transactions` to
# `transaction_payments`, never an inner one. The outer join is load-bearing rather
# than defensive: a document that has no leg rows — anything written before this
# feature, or anything a backfill missed — must still contribute its money to the
# split, or `cashNet + cardNet + otherNet` silently stops summing to `net` for every
# historical day. With the outer join, such a document produces exactly one row that
# falls back to its own document-level tender and amount, which is precisely how the
# report behaved before split tender existed.


def tender_method_expr():
    """Leg method if the document has legs, else the document's own tender."""
    return func.coalesce(TransactionPayment.method, Transaction.payment_method)


def refund_condition():
    """
    A credit note, as a SQL predicate — the same rule as `reports._is_refund_condition`.

    It lives here as well because the tender expressions below must not import from
    `reports` (which imports the other way), and because both signals matter: a legacy
    row may have a null `document_type`, and a credit note raised outside the refund
    flow may not carry the back-link.
    """
    return or_(
        Transaction.document_type == CREDIT_NOTE_DOCUMENT_TYPE,
        Transaction.refund_of_transaction_id.isnot(None),
    )


def document_collectable_expr():
    """`expected_tender_total` as SQL: the fallback amount for a document with no legs."""
    return case(
        (refund_condition(), Transaction.total_amount),
        else_=Transaction.total_amount - func.coalesce(Transaction.document_discount, 0),
    )


def tender_amount_expr(fallback=None):
    """
    Leg amount if the document has legs, else `fallback` (default: collectable).

    `fallback` exists because the two callers legitimately want different
    document-level amounts for a leg-less document: the cashier report wants the net
    collectable so the three tender columns keep summing to `net`, while
    `/dashboard/stats` has always split the *gross* `total_amount` and must keep
    reporting the same numbers for existing documents.
    """
    return func.coalesce(
        TransactionPayment.amount,
        document_collectable_expr() if fallback is None else fallback,
    )


def signed_tender_amount_expr(fallback=None):
    """Tender amount signed by direction: a credit note takes money back out."""
    amount = tender_amount_expr(fallback)
    return case((refund_condition(), -amount), else_=amount)
