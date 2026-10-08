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
* `exchange` legs (the offset inside a mixed basket, §1.2a) are a bucket of their own:
  in neither cash nor card, so never in the drawer. Signed like every leg, they net to
  zero over a complete basket; `total_exchange` is that net, shown on its own.
* Tips are not takings and are outside the legs. Cash tips go in the drawer. A tip with
  no method of its own takes the sale's tender (`tip_goes_to_cash`).
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
from app.services.document_prefix import document_number_of, document_series_of
from app.services.tenders import (
    EXCHANGE_PAYMENT_METHOD,
    NO_MONEY_BUCKET,
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
    #: Σ the sale lines' own discounts (a discount on one item). Already inside the
    #: lines' net totals, so it is reported beside `discounts_total` (the basket
    #: discounts), never subtracted again.
    line_discounts_total: Decimal = ZERO
    #: Σ what promotions ("מבצעים") took off the sale lines. Like the item discounts,
    #: already inside `discounts_total` (the till puts it in `document_discount`), so
    #: reported beside it, never subtracted again.
    promotion_discounts_total: Decimal = ZERO
    #: Σ what discount vouchers ("שוברי הנחה", docs/SPEC_VOUCHER_PRODUCTION.md §7) took
    #: off the sale lines: a discount like the promotions, inside `discounts_total`,
    #: reported beside it — never a tender.
    voucher_discounts_total: Decimal = ZERO
    #: Σ what production vouchers booked as a document deduction took off the sales ("קיזוז
    #: שוברי הפקה", `transaction_voucher_discounts.kind` production_voucher). As on the till's
    #: X: in neither the gross nor `discounts_total` (the net is the same) — its own section.
    #: The uniform file still files the documents' whole discount, as issued.
    production_voucher_deductions_total: Decimal = ZERO
    #: Documents made only of production vouchers' ₪0 memo lines (`zero` mode): out of the counts.
    voucher_memo_documents: int = 0
    payment_breakdown: Dict[str, Decimal] = field(default_factory=dict)
    total_tips: Decimal = ZERO
    total_cash_tips: Decimal = ZERO
    total_card_tips: Decimal = ZERO
    vat_declared: Decimal = ZERO
    vat_missing_count: int = 0
    #: The document range of the main series — 320, else 400 (an exempt dealer), else 330
    #: — as printed. Each type is numbered on its own counter now (docs/SPEC_DOCUMENT_PREFIX.md),
    #: so a range over every document would mix series; `document_ranges` has them all.
    first_transaction_number: Optional[str] = None
    last_transaction_number: Optional[str] = None
    #: Per series, in the order 320, 330, 400: {"documentType", "first", "last", "count"},
    #: the numbers as printed (`20000057`). A -400 is in the 400 series.
    document_ranges: List[dict] = field(default_factory=list)
    #: Card legs per (brand, acquirer): [sales count, sales amount, refunds count,
    #: refunds amount] — refunds positive. Tips are not legs, so not in here.
    card_brands: Dict[tuple, list] = field(default_factory=dict)

    def add_card_leg(self, brand: Optional[str], acquirer: Optional[str], amount: Decimal, refund: bool) -> None:
        key = (brand or "other", acquirer or "unknown")
        bucket = self.card_brands.setdefault(key, [0, ZERO, 0, ZERO])
        if refund:
            bucket[2] += 1
            bucket[3] += amount
        else:
            bucket[0] += 1
            bucket[1] += amount

    def card_brands_json(self) -> List[Dict[str, object]]:
        """The card split as a Z section stores it, largest net first."""
        out = []
        for (brand, acquirer), (sc, sa, rc, ra) in self.card_brands.items():
            out.append({
                "brand": brand,
                "acquirer": acquirer,
                "salesCount": sc,
                "salesAmount": str(sa.quantize(CENT)),
                "refundsCount": rc,
                "refundsAmount": str(ra.quantize(CENT)),
                "net": str((sa - ra).quantize(CENT)),
            })
        out.sort(key=lambda r: (-Decimal(r["net"]), r["brand"], r["acquirer"]))
        return out

    @property
    def total_cash(self) -> Decimal:
        return self.payment_breakdown.get("cash", ZERO)

    @property
    def total_card(self) -> Decimal:
        return self.payment_breakdown.get("card", ZERO)

    @property
    def total_exchange(self) -> Decimal:
        """Net of the `exchange` legs: zero when every mixed basket is complete."""
        return self.payment_breakdown.get(EXCHANGE_PAYMENT_METHOD, ZERO)

    @property
    def vat_total(self) -> Optional[Decimal]:
        if self.transactions_count and self.vat_missing_count:
            return None
        return self.vat_declared

    @property
    def gross_sales(self) -> Decimal:
        """
        Σ totalAmount of the sales before their discounts, less production vouchers' deductions
        (the till's X figure: a voucher-covered line is no sale of this till's).
        """
        return self.total_sales + self.discounts_total

    @property
    def net_sales(self) -> Decimal:
        return self.total_sales - self.total_refunds

    def breakdown_json(self) -> Dict[str, str]:
        return {k: str(v.quantize(CENT)) for k, v in sorted(self.payment_breakdown.items())}

    # ── Deltas: a correction to a document already in a Z (docs/SHIFTS_API.md §1.2) ──

    #: The additive fields a delta carries (document ranges are not additive).
    _COUNTS = ("transactions_count", "sales_count", "credit_notes_count", "non_sale_count", "vat_missing_count")
    _MONEY = (
        "total_sales", "total_refunds", "discounts_total", "line_discounts_total",
        "promotion_discounts_total", "voucher_discounts_total", "production_voucher_deductions_total",
        "total_tips", "total_cash_tips",
        "total_card_tips", "vat_declared",
    )

    def delta_json(self) -> Dict[str, object]:
        """The additive figures as JSON (money as decimal strings) — what an adjustment stores."""
        out: Dict[str, object] = {k: int(getattr(self, k)) for k in self._COUNTS}
        out.update({k: str(_dec(getattr(self, k))) for k in self._MONEY})
        out["payment_breakdown"] = {k: str(v) for k, v in sorted(self.payment_breakdown.items())}
        out["card_brands"] = [[b, a, sc, str(sa), rc, str(ra)] for (b, a), (sc, sa, rc, ra) in self.card_brands.items()]
        return out

    @classmethod
    def from_delta_json(cls, raw: Optional[dict]) -> "DocumentTotals":
        out = cls()
        if not isinstance(raw, dict):
            return out
        for k in cls._COUNTS:
            try:
                setattr(out, k, int(raw.get(k) or 0))
            except (TypeError, ValueError):
                pass
        for k in cls._MONEY:
            try:
                setattr(out, k, Decimal(str(raw.get(k) or "0")))
            except (ArithmeticError, ValueError):
                pass
        for method, amount in (raw.get("payment_breakdown") or {}).items():
            try:
                out.payment_breakdown[str(method)] = Decimal(str(amount))
            except (ArithmeticError, ValueError):
                continue
        for row in raw.get("card_brands") or []:
            try:
                b, a, sc, sa, rc, ra = row
                out.card_brands[(b, a)] = [int(sc), Decimal(str(sa)), int(rc), Decimal(str(ra))]
            except (TypeError, ValueError, ArithmeticError):
                continue
        return out

    def add(self, other: "DocumentTotals", sign: int = 1) -> "DocumentTotals":
        """Add (`sign` 1) or subtract (−1) another set of figures, field by field, in place."""
        s = Decimal(sign)
        for k in self._COUNTS:
            setattr(self, k, getattr(self, k) + sign * getattr(other, k))
        for k in self._MONEY:
            setattr(self, k, _dec(getattr(self, k)) + s * _dec(getattr(other, k)))
        for method, amount in other.payment_breakdown.items():
            self.payment_breakdown[method] = self.payment_breakdown.get(method, ZERO) + s * amount
            if self.payment_breakdown[method] == ZERO:
                del self.payment_breakdown[method]
        for key, (sc, sa, rc, ra) in other.card_brands.items():
            bucket = self.card_brands.setdefault(key, [0, ZERO, 0, ZERO])
            bucket[0] += sign * sc
            bucket[1] += s * sa
            bucket[2] += sign * rc
            bucket[3] += s * ra
            if bucket == [0, ZERO, 0, ZERO]:
                del self.card_brands[key]
        return self

    def is_zero(self) -> bool:
        return (
            all(getattr(self, k) == 0 for k in self._COUNTS)
            and all(_dec(getattr(self, k)) == ZERO for k in self._MONEY)
            and not any(v != ZERO for v in self.payment_breakdown.values())
        )

    def as_x(self) -> Dict[str, object]:
        """The §3.2 keys, as the model columns name them (gross and discounts included)."""
        return {
            "total_sales": self.total_sales,
            "gross_sales": self.gross_sales,
            "discounts_total": self.discounts_total,
            "total_refunds": self.total_refunds,
            "total_cash": self.total_cash,
            "total_card": self.total_card,
            "total_exchange": self.total_exchange,
            "total_tips": self.total_tips,
            "total_cash_tips": self.total_cash_tips,
            "total_card_tips": self.total_card_tips,
            "vat_total": self.vat_total,
            "transactions_count": self.transactions_count,
            "first_transaction_number": self.first_transaction_number,
            "last_transaction_number": self.last_transaction_number,
        }


def tip_goes_to_cash(tip_method: Optional[str], sale_method: Optional[str]) -> bool:
    """
    Whether a tip is cash (in the drawer) or card — every tip is one or the other.

    The tip's own method when the till sent one; otherwise the sale's own tender, as the
    tips report reads it (`app.services.tips`): a cash sale's tip is cash, anything else
    card. A tip in neither bucket was counted in the total but in no split, and a cash one
    was missing from the drawer the Z expected.
    """
    method = (tip_method or sale_method or "").strip().lower()
    if method in ("cash", "card"):
        return method == "cash"
    return (sale_method or "").strip().lower() == "cash"


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
    return _totals_of(db, documents)


def document_totals(db: Session, doc: Transaction) -> DocumentTotals:
    """
    What one document contributes to an X or a Z, exactly as `compute_totals` counts it —
    used to carry a correction of a document already in a Z into the next Z as the
    difference between its two versions (docs/SHIFTS_API.md §1.2).
    """
    return _totals_of(db, [doc])


def _totals_of(db: Session, documents: List[Transaction]) -> DocumentTotals:
    totals = DocumentTotals()
    # "Same number, different id" (docs/SHIFTS_API.md §1.2d): a duplicate copy of a document
    # that holds its number is the same sale stored twice — counted once, by its holder.
    documents = [d for d in documents if not getattr(d, "duplicate_copy", False)]
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

    # "ללא החזר כספי" (docs/SPEC_REMOTE_CREDIT.md): a credit for a sale that never really
    # happened moved no money. Against an original of the same shift it cancels that sale's
    # own leg (which moved none either), so it counts in its tender as usual; otherwise it is
    # a bucket of its own — never cash, card or the drawer. The till's X does the same.
    no_money_originals = {
        d.refund_of_transaction_id
        for d in counted
        if d.refund_of_transaction_id is not None
        and any(getattr(l, "no_money_movement", False) for l in legs_by_doc.get(d.id, ()))
    }
    original_shift_of: Dict[uuid.UUID, Optional[uuid.UUID]] = {}
    if no_money_originals:
        original_shift_of = {
            row[0]: row[1]
            for row in db.query(Transaction.id, Transaction.shift_id)
            .filter(Transaction.id.in_(list(no_money_originals)))
            .all()
        }

    # Every document number the register issued in these shifts, a cancelled one too:
    # "the last document number" on a Z is about the register's numbering, not takings.
    # Ordered by the number, shown as printed — `20000057`
    # (docs/SPEC_DOCUMENT_PREFIX.md), so a range is never ambiguous between tills.
    numbered = [d for d in documents if d.transaction_number]
    # Item discounts: on sale documents only (a credit note's lines carry its share of
    # the original's discounts, which is not a discount given now).
    sale_ids = [
        d.id for d in counted
        if not is_refund_document(
            document_type=d.document_type, refund_of_transaction_id=d.refund_of_transaction_id
        )
    ]
    if sale_ids:
        from sqlalchemy import func as _func

        from app.models.transaction_item import TransactionItem

        line_sum = (
            db.query(_func.coalesce(_func.sum(_func.abs(TransactionItem.discount)), 0))
            .filter(TransactionItem.transaction_id.in_(sale_ids))
            .scalar()
        )
        totals.line_discounts_total = _dec(line_sum)
        promotion_sum = (
            db.query(_func.coalesce(_func.sum(_func.abs(TransactionItem.promotion_discount)), 0))
            .filter(TransactionItem.transaction_id.in_(sale_ids))
            .scalar()
        )
        totals.promotion_discounts_total = _dec(promotion_sum)
        voucher_sum = (
            db.query(_func.coalesce(_func.sum(_func.abs(TransactionItem.voucher_discount)), 0))
            .filter(TransactionItem.transaction_id.in_(sale_ids))
            .scalar()
        )
        totals.voucher_discounts_total = _dec(voucher_sum)
        from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION, TransactionVoucherDiscount

        deduction_sum = (
            db.query(_func.coalesce(_func.sum(_func.abs(TransactionVoucherDiscount.discount_amount)), 0))
            .filter(
                TransactionVoucherDiscount.transaction_id.in_(sale_ids),
                TransactionVoucherDiscount.kind == PRODUCTION_VOUCHER_DEDUCTION,
            )
            .scalar()
        )
        totals.production_voucher_deductions_total = _dec(deduction_sum)
        deduction_of = {
            tid: _dec(amount)
            for tid, amount in db.query(
                TransactionVoucherDiscount.transaction_id,
                _func.coalesce(_func.sum(_func.abs(TransactionVoucherDiscount.discount_amount)), 0),
            )
            .filter(
                TransactionVoucherDiscount.transaction_id.in_(sale_ids),
                TransactionVoucherDiscount.kind == PRODUCTION_VOUCHER_DEDUCTION,
            )
            .group_by(TransactionVoucherDiscount.transaction_id)
        }
    else:
        deduction_of = {}
    for doc in counted:
        if getattr(doc, "voucher_memo", False):
            # ₪0 memo lines only (`zero` mode): the till counts no document, no sale (§4.3).
            totals.voucher_memo_documents += 1
            continue
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
            # Without a production voucher's deduction — as the till's X ("שוברי הפקה", apart).
            totals.discounts_total += _dec(doc.document_discount) - deduction_of.get(doc.id, ZERO)

        legs = legs_by_doc.get(doc.id)
        if legs:
            for leg in legs:
                method = (leg.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD
                if (
                    refund
                    and getattr(leg, "no_money_movement", False)
                    and (
                        doc.refund_of_transaction_id not in original_shift_of
                        or original_shift_of[doc.refund_of_transaction_id] != doc.shift_id
                    )
                ):
                    method = NO_MONEY_BUCKET
                totals.payment_breakdown[method] = (
                    totals.payment_breakdown.get(method, ZERO) + sign * _dec(leg.amount)
                )
                if method == "card":
                    totals.add_card_leg(
                        getattr(leg, "card_brand", None), getattr(leg, "card_acquirer", None),
                        _dec(leg.amount), refund,
                    )
        else:
            method = (doc.payment_method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD
            totals.payment_breakdown[method] = (
                totals.payment_breakdown.get(method, ZERO) + sign * collected
            )

        tip = _dec(doc.tip_amount)
        if tip:
            totals.total_tips += tip
            if tip_goes_to_cash(doc.tip_payment_method, doc.payment_method):
                totals.total_cash_tips += tip
            else:
                totals.total_card_tips += tip

        if doc.vat_amount is None:
            totals.vat_missing_count += 1
        else:
            totals.vat_declared += sign * _dec(doc.vat_amount)

    totals.document_ranges = document_ranges(numbered)
    main = main_range(totals.document_ranges)
    if main is not None:
        totals.first_transaction_number = main["first"]
        totals.last_transaction_number = main["last"]
    return totals


#: Which series' range is the Z's one "document range": the tax invoices, else an exempt
#: dealer's receipts, else the credit notes. The till computes the same (OfflineTillZ.kt).
MAIN_SERIES_ORDER = (320, 400, 330)


def document_ranges(documents: Iterable[Transaction]) -> List[dict]:
    """
    Per number series (320, 330, 400 — -400 in 400), the first and last document number
    as printed and how many documents: each type is numbered on its own counter
    (docs/SPEC_DOCUMENT_PREFIX.md), so a range is only meaningful within one series.
    Ordered by the counter, not by the printed form, so a prefix changed mid-Z does not
    reorder them.
    """
    by_series: Dict[int, List[Transaction]] = {}
    for d in documents:
        if not d.transaction_number:
            continue
        series = getattr(d, "document_series", None) or document_series_of(
            d.document_type, d.refund_of_transaction_id
        )
        by_series.setdefault(int(series), []).append(d)
    out: List[dict] = []
    for series in sorted(by_series):
        ordered = sorted(by_series[series], key=lambda d: _number_key(d.transaction_number))
        out.append({
            "documentType": series,
            "first": document_number_of(ordered[0]),
            "last": document_number_of(ordered[-1]),
            "count": len(ordered),
        })
    return out


def main_range(ranges: List[dict]) -> Optional[dict]:
    by_type = {r["documentType"]: r for r in ranges}
    for series in MAIN_SERIES_ORDER:
        if series in by_type:
            return by_type[series]
    return ranges[0] if ranges else None


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
    "totalExchange": lambda t: t.total_exchange,
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
        if not theirs.is_finite():
            # "NaN" / "Infinity": a figure the server cannot read is a mismatch (and a
            # comparison with it would raise).
            return True
        if ours is None:
            # The server cannot state VAT (a document declared none); the till can.
            return True
        if abs(_dec(ours) - theirs) > CENT:
            return True
    return False
