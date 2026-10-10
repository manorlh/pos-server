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

4. **`exchange` is not money.** A till basket that mixes sold and returned lines is
   committed as several documents (a 320 and one or more 330s, sharing a `basketId`);
   the part of the sale the returns pay for is an `exchange` leg on the 320, matched by
   `exchange` legs on the 330s, and only the net goes through a real tender. So an
   `exchange` leg is its own bucket — never cash, never card, never `other` — and it
   nets to zero over a complete basket. See docs/SHIFTS_API.md §1.2a.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Iterable, Optional, Sequence

from sqlalchemy import and_, case, func, or_

from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment

# Israeli Tax Authority document type for a credit note (refund); 320 is the
# invoice/receipt. Mirrors `domain/Documents.kt` on the till and the constant of the
# same name in `app/services/reports.py`.
CREDIT_NOTE_DOCUMENT_TYPE = 330

# "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md): an exempt dealer (עוסק פטור) sells on a
# receipt (קבלה, 400) and pays back on a receipt in the other direction. There is no
# מבנה אחיד code for the latter, so it is stored as the internal -400 — never printed,
# filed as a 400 with negative amounts (`open_format_document_type`). Mirrors
# `DocumentType.RECEIPT` / `RECEIPT_REFUND` on the till.
RECEIPT_DOCUMENT_TYPE = 400
RECEIPT_REFUND_DOCUMENT_TYPE = -400

#: Every document type that moves money back to the customer: the credit note of a
#: VAT-registered business and the receipt refund of an exempt one.
CREDIT_DOCUMENT_TYPES = (CREDIT_NOTE_DOCUMENT_TYPE, RECEIPT_REFUND_DOCUMENT_TYPE)

#: The documents an exempt dealer issues: no VAT on either.
RECEIPT_DOCUMENT_TYPES = (RECEIPT_DOCUMENT_TYPE, RECEIPT_REFUND_DOCUMENT_TYPE)


def is_credit_document_type(document_type: Optional[int]) -> bool:
    """A credit note (330) or an exempt dealer's receipt refund (-400)."""
    return document_type in CREDIT_DOCUMENT_TYPES

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

# The tender that settles the sale half of a mixed basket against its credit half
# (rule 4 above). OpenFormat payment type 6, "תלוש החלפה".
EXCHANGE_PAYMENT_METHOD = "exchange"

# "ללא החזר כספי — עסקה שלא בוצעה" (docs/SPEC_REMOTE_CREDIT.md): the tender split's own
# bucket for a credit leg that moved no money (`TransactionPayment.no_money_movement`) and
# does not cancel a sale of its own shift — never cash, card or the drawer. The legs keep
# their real method; only the X/Z split (`shift_totals.compute_totals`) files them here.
NO_MONEY_BUCKET = "no_money"

# Rounding slack allowed when checking that the legs sum to the document.
#
# Per leg, not flat: amounts are Numeric(12,2) here and integer agorot on the till,
# so the only legitimate gap is the half-agora each leg can be rounded by when a
# cashier splits a bill "in half". One agora per leg permits that and nothing that
# could hide a real mis-tender.
TENDER_TOLERANCE_PER_LEG = Decimal("0.01")


#: A prepaid production voucher ("שובר הפקה") paying for the goods on it: a tender bucket of its
#: own ("שוברי הפקה"), never cash and never "other" (the production vouchers contract, §4.2).
#: `voucher` is what every till writes today, `production_voucher` the contract's code for the
#: `payment` accounting mode, `vouchers` the alias the Z already read. Uniform file: D120 code 5.
PRODUCTION_VOUCHER_BUCKET = "production_voucher"
PRODUCTION_VOUCHER_METHODS = frozenset({"voucher", "vouchers", PRODUCTION_VOUCHER_BUCKET})


def is_production_voucher(method: Optional[str]) -> bool:
    return (method or "").strip().lower() in PRODUCTION_VOUCHER_METHODS


def normalize_tender(method: Optional[str]) -> str:
    """
    Collapse a payment method to cash / card / exchange / production_voucher / other for the
    tender splits.

    `exchange` is a bucket of its own rather than `other`: it is the offset between the
    two halves of a mixed basket, not money anyone took, and folding it into `other`
    would show a basket's sale half as unclassified takings. A production voucher is its
    own too: "שוברי הפקה" — the voucher paid, not an unknown tender.
    """
    m = (method or "").strip().lower()
    if m == "cash":
        return "cash"
    if m == "card":
        return "card"
    if m == EXCHANGE_PAYMENT_METHOD:
        return EXCHANGE_PAYMENT_METHOD
    if m in PRODUCTION_VOUCHER_METHODS:
        return PRODUCTION_VOUCHER_BUCKET
    return "other"


def is_exchange(method: Optional[str]) -> bool:
    return (method or "").strip().lower() == EXCHANGE_PAYMENT_METHOD


def is_refund_document(
    *, document_type: Optional[int], refund_of_transaction_id: Optional[object]
) -> bool:
    """
    Python-side twin of `reports._is_refund_condition`.

    Both signals are checked because either alone has a gap: a legacy row may have a
    null `document_type`, and a credit note raised outside the refund flow may not
    carry the back-link.
    """
    return is_credit_document_type(document_type) or refund_of_transaction_id is not None


def no_money_original_of(doc) -> Optional[object]:
    """
    The original a no-money leg of [doc] is weighed against in the X / Z: a credit's refund
    link, or the re-issued sale of a re-issue's new invoice ("הפק חשבונית על שם לקוח",
    docs/SPEC_CUSTOMER_INVOICE.md). None otherwise — a no-money leg on any other sale counts
    in its own tender, as it always did. The one rule for `shift_totals` and `z_sections`: a
    credit and the invoice that replaces it must land in the same bucket, or the pair would
    not net to nothing.
    """
    if is_refund_document(
        document_type=doc.document_type,
        refund_of_transaction_id=doc.refund_of_transaction_id,
    ):
        return doc.refund_of_transaction_id
    return getattr(doc, "reissue_of_transaction_id", None)


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

    `exchange` legs are left out whenever the document has a real tender too: a basket's
    sale paid ₪60 cash + ₪40 `exchange` took its money in cash, and the reader of this
    one value that matters — a tip with no method of its own takes the sale's tender —
    must read cash, not "mixed". Every tender split reads the legs, not this column, so
    no split learns to put the ₪40 in cash. A document settled by `exchange` alone says
    `exchange`.
    """
    distinct = {(m or "").strip().lower() for m in methods if (m or "").strip()}
    if len(distinct) > 1:
        distinct.discard(EXCHANGE_PAYMENT_METHOD)
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
        Transaction.document_type.in_(CREDIT_DOCUMENT_TYPES),
        Transaction.refund_of_transaction_id.isnot(None),
    )


def sale_condition():
    """
    Not a credit note, as a SQL predicate — the null-safe negation of `refund_condition`.

    `NOT refund_condition()` is not it: for a legacy row with a null `document_type` and
    no back-link the OR is NULL, its negation is NULL, and the sale would be filtered out.
    """
    return and_(
        or_(
            Transaction.document_type.is_(None),
            Transaction.document_type.notin_(CREDIT_DOCUMENT_TYPES),
        ),
        Transaction.refund_of_transaction_id.is_(None),
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
