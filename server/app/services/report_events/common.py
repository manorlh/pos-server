"""
Shared pieces of the event report: one document's money, read the way every report reads
it (docs/SPEC_EVENTS.md §3), and the figures over a set of documents — the same keys a Z's
per-till section stores, so the reconciliation compares like with like.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.services.tenders import EXCHANGE_PAYMENT_METHOD, expected_tender_total, is_refund_document

ZERO = Decimal("0")
CENT = Decimal("0.01")
DEFAULT_VAT_RATE = Decimal("0.18")
#: How many ids go in one IN list.
CHUNK = 900


def dec(value: Any) -> Decimal:
    if value is None:
        return ZERO
    return value if isinstance(value, Decimal) else Decimal(str(value))


def money(value: Any) -> float:
    """A money figure for the JSON: shekels, rounded half-up to the agora."""
    return float(dec(value).quantize(CENT, rounding=ROUND_HALF_UP))


def utc(moment: Optional[datetime]) -> Optional[datetime]:
    """Aware UTC (SQLite hands timestamps back naive)."""
    if moment is None:
        return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def iso(moment: Optional[datetime]) -> Optional[str]:
    moment = utc(moment)
    return moment.isoformat() if moment is not None else None


def chunks(values: Sequence[Any], size: int = CHUNK) -> Iterable[Sequence[Any]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def tender_bucket(method: Optional[str]) -> str:
    """The event report's tender bucket; a production voucher is "other" here (no voucher figure yet)."""
    m = (method or "").strip().lower()
    if m in ("cash", "card"):
        return m
    if m == EXCHANGE_PAYMENT_METHOD:
        return "exchange"
    return "other"


@dataclass
class Doc:
    """One counted document of the event, with its money already signed."""

    tx: Transaction
    id: str
    machine_id: str
    shift_id: Optional[str]
    at: datetime
    refund: bool
    #: Sale: total_amount (before document discounts); credit note: 0.
    gross: Decimal
    #: Sale: document_discount; credit note: 0.
    discount: Decimal
    #: What the document took (sale) or gave back (credit note) — positive either way.
    collected: Decimal
    #: +collected for a sale, −collected for a credit note.
    net: Decimal
    tip: Decimal
    #: Signed VAT; estimated from the rate when the document declared none.
    vat: Decimal
    vat_estimated: bool
    #: (bucket, raw method lower-case, signed amount, leg row or None)
    legs: List[Tuple[str, str, Decimal, Optional[TransactionPayment]]] = field(default_factory=list)


def make_doc(tx: Transaction, legs: Sequence[TransactionPayment], deduction: Decimal = ZERO) -> Doc:
    """[deduction]: the document's production vouchers' deductions — in neither its gross nor its discount."""
    refund = is_refund_document(
        document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id
    )
    collected = expected_tender_total(
        total_amount=tx.total_amount,
        document_discount=tx.document_discount,
        document_type=tx.document_type,
        refund_of_transaction_id=tx.refund_of_transaction_id,
    )
    sign = Decimal("-1") if refund else Decimal("1")
    if tx.vat_amount is not None:
        vat, estimated = sign * dec(tx.vat_amount), False
    else:
        rate = dec(tx.vat_rate) if tx.vat_rate is not None else DEFAULT_VAT_RATE
        vat, estimated = sign * (collected * rate / (1 + rate)), True
    doc = Doc(
        tx=tx,
        id=str(tx.id),
        machine_id=str(tx.machine_id),
        shift_id=str(tx.shift_id) if tx.shift_id else None,
        at=utc(tx.created_at),
        refund=refund,
        gross=ZERO if refund else dec(tx.total_amount) - deduction,
        discount=ZERO if refund else max(dec(tx.document_discount) - deduction, ZERO),
        collected=collected,
        net=sign * collected,
        tip=dec(tx.tip_amount),
        vat=vat,
        vat_estimated=estimated,
    )
    if legs:
        for leg in sorted(legs, key=lambda l: l.sequence or 0):
            raw = (leg.method or "").strip().lower() or "other"
            doc.legs.append((tender_bucket(raw), raw, sign * dec(leg.amount), leg))
    else:
        raw = (tx.payment_method or "").strip().lower() or "other"
        doc.legs.append((tender_bucket(raw), raw, sign * collected, None))
    return doc


FIGURE_KEYS = ("sales", "refunds", "net", "cash", "card", "other", "exchange", "tips", "count")
FIGURE_LABELS = {
    "sales": "מכירות", "refunds": "זיכויים", "net": "נטו", "cash": "מזומן", "card": "אשראי",
    "other": "אחר", "exchange": "החלפה", "tips": "טיפים", "count": "מסמכים",
}


def figures(docs: Iterable[Doc]) -> Dict[str, Decimal]:
    """The Z section's keys over `docs` (sales = collected, net of document discounts)."""
    out = {k: ZERO for k in FIGURE_KEYS}
    for d in docs:
        out["count"] += 1
        if d.refund:
            out["refunds"] += d.collected
        else:
            out["sales"] += d.collected
        out["net"] += d.net
        out["tips"] += d.tip
        for bucket, _raw, amount, _leg in d.legs:
            out[bucket] += amount
    return out


def figures_out(values: Dict[str, Decimal]) -> Dict[str, float]:
    return {k: (int(v) if k == "count" else money(v)) for k, v in values.items()}
