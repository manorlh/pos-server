"""
The figures of a set of shifts, computed from the documents the cloud holds.

One function for the X of one shift, the reconstructed X of a dead till's shift, and
every Z (a set of shifts over several tills). It generalises what used to be
`administrative_close._totals` from one trading day to any set of shift ids, so an X
and the Z built over it can never disagree about what a document contributes.

The rules (docs/SHIFTS_API.md §3.2):

* Only documents with a status in `SALE_STATUSES` count — a declined card tap is a
  `cancelled` row in the same table. Everything else is counted as a non-sale document.
* A sale contributes `total_amount - document_discount`; a credit note contributes its
  `total_amount`, which is already the money handed back (see `app.services.tenders`).
  Credit notes are summed separately and are positive.
* Takings per tender come from the tender legs, so a split document is part cash and
  part card. A credit note's legs are subtracted.
* Tips are not takings and are outside the legs. Cash tips go in the drawer.
* VAT is what each document declared. If any counted document declared none, the VAT
  total is unknown (None) rather than a partial sum that understates it.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.shift import Shift
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.services.dashboard_stats import SALE_STATUSES
from app.services.tenders import (
    UNKNOWN_PAYMENT_METHOD,
    expected_tender_total,
    is_refund_document,
)

ZERO = Decimal("0")
CENT = Decimal("0.01")


def _dec(value) -> Decimal:
    if value is None:
        return ZERO
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _number_key(number: str):
    """Document numbers are text; order them numerically when they are numbers."""
    stripped = (number or "").strip()
    return (0, int(stripped), "") if stripped.isdigit() else (1, 0, stripped)


@dataclass
class DocumentTotals:
    transactions_count: int = 0
    sales_count: int = 0
    credit_notes_count: int = 0
    non_sale_count: int = 0
    total_sales: Decimal = ZERO
    total_refunds: Decimal = ZERO
    discounts_total: Decimal = ZERO
    payment_breakdown: Dict[str, Decimal] = field(default_factory=dict)
    total_tips: Decimal = ZERO
    total_cash_tips: Decimal = ZERO
    total_card_tips: Decimal = ZERO
    vat_declared: Decimal = ZERO
    vat_missing_count: int = 0
    first_transaction_number: Optional[str] = None
    last_transaction_number: Optional[str] = None

    @property
    def total_cash(self) -> Decimal:
        return self.payment_breakdown.get("cash", ZERO)

    @property
    def total_card(self) -> Decimal:
        return self.payment_breakdown.get("card", ZERO)

    @property
    def vat_total(self) -> Optional[Decimal]:
        if self.transactions_count and self.vat_missing_count:
            return None
        return self.vat_declared

    @property
    def gross_sales(self) -> Decimal:
        """Σ totalAmount of the sales, before document discounts (the till's X figure)."""
        return self.total_sales + self.discounts_total

    @property
    def net_sales(self) -> Decimal:
        return self.total_sales - self.total_refunds

    def breakdown_json(self) -> Dict[str, str]:
        return {k: str(v.quantize(CENT)) for k, v in sorted(self.payment_breakdown.items())}

    def as_x(self) -> Dict[str, object]:
        """The §3.2 keys, as the model columns name them (gross and discounts included)."""
        return {
            "total_sales": self.total_sales,
            "gross_sales": self.gross_sales,
            "discounts_total": self.discounts_total,
            "total_refunds": self.total_refunds,
            "total_cash": self.total_cash,
            "total_card": self.total_card,
            "total_tips": self.total_tips,
            "total_cash_tips": self.total_cash_tips,
            "total_card_tips": self.total_card_tips,
            "vat_total": self.vat_total,
            "transactions_count": self.transactions_count,
            "first_transaction_number": self.first_transaction_number,
            "last_transaction_number": self.last_transaction_number,
        }


def compute_totals(db: Session, shift_ids: Iterable[uuid.UUID]) -> DocumentTotals:
    """The figures over every document of `shift_ids`."""
    ids = list(shift_ids)
    totals = DocumentTotals()
    if not ids:
        return totals

    # populate_existing: the upsert writes documents with a Core statement, so rows
    # already in this session would otherwise be read back with their old values.
    # Only the shift's own till's documents: one held under another till's shift (it
    # could land there before that was refused, after a till was re-paired as a new
    # machine) belongs in neither till's X or Z, and is shown as an orphan instead.
    documents: List[Transaction] = (
        db.query(Transaction)
        .join(Shift, Shift.id == Transaction.shift_id)
        .filter(Transaction.shift_id.in_(ids), Transaction.machine_id == Shift.machine_id)
        .populate_existing()
        .all()
    )
    counted = [d for d in documents if d.status in SALE_STATUSES]
    totals.non_sale_count = len(documents) - len(counted)

    legs_by_doc: Dict[uuid.UUID, List[TransactionPayment]] = {}
    if counted:
        for leg in (
            db.query(TransactionPayment)
            .filter(TransactionPayment.transaction_id.in_([d.id for d in counted]))
            .populate_existing()
            .all()
        ):
            legs_by_doc.setdefault(leg.transaction_id, []).append(leg)

    # Every document number the register issued in these shifts, a cancelled one too:
    # "the last document number" on a Z is about the register's numbering, not takings.
    numbers: List[str] = [d.transaction_number for d in documents if d.transaction_number]
    for doc in counted:
        totals.transactions_count += 1
        refund = is_refund_document(
            document_type=doc.document_type,
            refund_of_transaction_id=doc.refund_of_transaction_id,
        )
        collected = expected_tender_total(
            total_amount=doc.total_amount,
            document_discount=doc.document_discount,
            document_type=doc.document_type,
            refund_of_transaction_id=doc.refund_of_transaction_id,
        )
        sign = Decimal("-1") if refund else Decimal("1")
        if refund:
            totals.credit_notes_count += 1
            totals.total_refunds += collected
        else:
            totals.sales_count += 1
            totals.total_sales += collected
            totals.discounts_total += _dec(doc.document_discount)

        legs = legs_by_doc.get(doc.id)
        if legs:
            for leg in legs:
                method = (leg.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD
                totals.payment_breakdown[method] = (
                    totals.payment_breakdown.get(method, ZERO) + sign * _dec(leg.amount)
                )
        else:
            method = (doc.payment_method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD
            totals.payment_breakdown[method] = (
                totals.payment_breakdown.get(method, ZERO) + sign * collected
            )

        tip = _dec(doc.tip_amount)
        if tip:
            totals.total_tips += tip
            if doc.tip_payment_method == "cash":
                totals.total_cash_tips += tip
            elif doc.tip_payment_method == "card":
                totals.total_card_tips += tip

        if doc.vat_amount is None:
            totals.vat_missing_count += 1
        else:
            totals.vat_declared += sign * _dec(doc.vat_amount)

    if numbers:
        ordered = sorted(numbers, key=_number_key)
        totals.first_transaction_number = ordered[0]
        totals.last_transaction_number = ordered[-1]
    return totals


#: The keys of a till's X compared against the server's, and how to read ours.
#:
#: `totalSales` is compared **gross** — Σ `totalAmount` of the sales, before document
#: discounts — because that is the figure the till's X prints (its line totals). The
#: server's own `total_sales` is net of discounts (what was collected, and what a Z
#: declares); comparing the till's gross with it would flag every discounted shift.
#: `totalDiscounts` / `discountsTotal`, when the till sends one, is compared with the
#: discounts. Everything else is the same quantity on both sides (docs/SHIFTS_API.md §3.2).
COMPARED_TILL_KEYS = {
    "totalSales": lambda t: t.gross_sales,
    "totalDiscounts": lambda t: t.discounts_total,
    "discountsTotal": lambda t: t.discounts_total,
    "totalRefunds": lambda t: t.total_refunds,
    "totalCash": lambda t: t.total_cash,
    "totalCard": lambda t: t.total_card,
    "totalTips": lambda t: t.total_tips,
    "vatTotal": lambda t: t.vat_total,
    "transactionsCount": lambda t: t.transactions_count,
}


def till_totals_mismatch(till: Optional[dict], server: DocumentTotals) -> bool:
    """
    True if the till's X disagrees with the server's on any figure it sent.

    Only keys the till actually sent are compared (an absent key is not a claim), and a
    value that is not a number is a mismatch rather than skipped — the till claimed a
    figure the server cannot read.
    """
    if not till:
        return False
    for key, ours_of in COMPARED_TILL_KEYS.items():
        if key not in till or till[key] is None:
            continue
        ours = ours_of(server)
        try:
            theirs = Decimal(str(till[key]))
        except (ArithmeticError, ValueError):
            return True
        if ours is None:
            # The server cannot state VAT (a document declared none); the till can.
            return True
        if abs(_dec(ours) - theirs) > CENT:
            return True
    return False
