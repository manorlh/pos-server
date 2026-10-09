"""
The manifest of a till's part of a local shop Z — one computation, on the till and here.

The owner: "תוודא שלא יהיה מצב של אי התאמה בנתונים — רק במצב שהקופה מתה ואולי חלק מהנתונים
חסרים והמשמרת פתוחה" (docs/SPEC_INDEPENDENT_TILL.md §8.12). The main till's local shop Z
is stored exactly as printed (§8.7); a mismatch between that paper and the cloud must be
impossible by construction. So each participating till, when it closes over the LAN,
describes its part from its own committed documents — which documents, per type how many
and from which number to which, the totals, and a digest over them — and the main till
builds the Z only from those parts. The cloud runs **this same computation** over the same
documents once every one of them has arrived, and the two must agree to the agora.

The till's twin is `domain/ShopZManifest.kt` (pos-android). Both run the shared golden
fixtures (`tests/fixtures/shop_z_manifest_golden.json`, the same bytes in pos-android's
`app/src/test/resources/`), and both tests pin the file's SHA-256 — so the two
implementations are proven to compute the same thing.

A document, as both sides read it (`canonical` form, money as decimal strings):

    {"id", "number", "type", "status", "refundOf", "total", "discount", "vat", "tip",
     "paymentMethod", "payments": [{"method", "amount"}]}

- `total` is the document's `totalAmount` — the sum of its line totals, as the till sends
  it; `discount` its document discount; `vat` its stored VAT (null: none stored).
- Money → agorot: the decimal value, rounded half away from zero to the agora — what the
  cloud's `NUMERIC(12,2)` stores and the till's `Agorot.ofShekels` computes.
- Counted: status `completed`, `refunded` or `partial_refund` (a sale later credited stays
  counted; `pending` and `cancelled` never took money). Only counted documents are named.
- A credit: type 330 or -400, or a document that names the sale it refunds.
- Tender legs: as recorded; a document with none has one for its collectable amount by its
  payment method (`other` when it has none) — exactly the leg the cloud writes on ingest.

Pure: no database, no clock.
"""
from __future__ import annotations

import hashlib
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

VERSION = 1

COUNTED_STATUSES = ("completed", "refunded", "partial_refund")
CREDIT_TYPES = (330, -400)
UNKNOWN_METHOD = "other"

#: The totals' keys, in the order they are printed and compared.
TOTAL_KEYS = ("documents", "gross", "discounts", "refunds", "net", "cash", "card", "exchange", "tips", "vat")

_DIGITS = re.compile(r"^[0-9]+$")


def agorot(value: Any) -> Optional[int]:
    """Money to agorot, half away from zero (null stays null)."""
    if value is None or value == "":
        return None
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def money(value: Optional[int]) -> Optional[str]:
    """Agorot as a decimal string, "12.30", "-0.50"."""
    if value is None:
        return None
    sign = "-" if value < 0 else ""
    whole, cents = divmod(abs(value), 100)
    return f"{sign}{whole}.{cents:02d}"


def _method(method: Optional[str]) -> str:
    return (method or "").strip().lower() or UNKNOWN_METHOD


def _type_key(document_type: Optional[int]) -> str:
    return "none" if document_type is None else str(int(document_type))


def number_order(number: str) -> Tuple[int, int, str]:
    """Document numbers in order: numerically where they are digits, then the rest as text."""
    if _DIGITS.match(number):
        return (0, int(number), number)
    return (1, 0, number)


def is_credit(doc: Dict[str, Any]) -> bool:
    if doc.get("type") is not None and int(doc["type"]) in CREDIT_TYPES:
        return True
    return bool((doc.get("refundOf") or "").strip()) if isinstance(doc.get("refundOf"), str) else doc.get("refundOf") is not None


def is_counted(doc: Dict[str, Any]) -> bool:
    return (doc.get("status") or "").strip().lower() in COUNTED_STATUSES


def legs_of(doc: Dict[str, Any]) -> List[Tuple[str, int]]:
    """The document's tender legs as (method, agorot), sorted — one synthesised if it has none."""
    payments = doc.get("payments") or []
    if payments:
        legs = [(_method(p.get("method")), agorot(p.get("amount")) or 0) for p in payments]
    else:
        total = agorot(doc.get("total")) or 0
        collectable = total if is_credit(doc) else total - (agorot(doc.get("discount")) or 0)
        legs = [(_method(doc.get("paymentMethod")), collectable)]
    return sorted(legs)


def digest_line(doc: Dict[str, Any]) -> str:
    """One document as the digest reads it: what it contributes, in agorot."""
    vat = agorot(doc.get("vat"))
    return "|".join((
        str(doc.get("id") or "").strip().lower(),
        _type_key(doc.get("type")),
        str(doc.get("number") or "").strip(),
        "1" if is_credit(doc) else "0",
        str(agorot(doc.get("total")) or 0),
        str(agorot(doc.get("discount")) or 0),
        "-" if vat is None else str(vat),
        str(agorot(doc.get("tip")) or 0),
        ",".join(f"{m}={a}" for m, a in legs_of(doc)),
    ))


def manifest_of(documents: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """
    The manifest of a set of documents: `{version, documents, documentIds, types, totals,
    digest}` — money as decimal strings. The caller adds whose part it is (`machineId`,
    `shiftIds`).
    """
    counted = sorted(
        (d for d in documents if is_counted(d)),
        key=lambda d: str(d.get("id") or "").strip().lower(),
    )
    gross = discounts = refunds = tips = vat = 0
    vat_known = True
    payments: Dict[str, int] = {}
    types: Dict[str, Dict[str, Any]] = {}
    for doc in counted:
        credit = is_credit(doc)
        total = agorot(doc.get("total")) or 0
        if credit:
            refunds += total
        else:
            gross += total
            discounts += agorot(doc.get("discount")) or 0
        sign = -1 if credit else 1
        doc_vat = agorot(doc.get("vat"))
        if doc_vat is None:
            vat_known = False
        else:
            vat += sign * doc_vat
        tips += agorot(doc.get("tip")) or 0
        for method, amount in legs_of(doc):
            payments[method] = payments.get(method, 0) + sign * amount
        number = str(doc.get("number") or "").strip()
        entry = types.setdefault(_type_key(doc.get("type")), {"count": 0, "first": None, "last": None})
        entry["count"] += 1
        if entry["first"] is None or number_order(number) < number_order(entry["first"]):
            entry["first"] = number
        if entry["last"] is None or number_order(number) > number_order(entry["last"]):
            entry["last"] = number
    totals = {
        "documents": len(counted),
        "gross": money(gross),
        "discounts": money(discounts),
        "refunds": money(refunds),
        "net": money(gross - discounts - refunds),
        "cash": money(payments.get("cash", 0)),
        "card": money(payments.get("card", 0)),
        "exchange": money(payments.get("exchange", 0)),
        "tips": money(tips),
        "vat": money(vat) if vat_known else None,
        "payments": {m: money(payments[m]) for m in sorted(payments)},
    }
    digest = hashlib.sha256("\n".join(digest_line(d) for d in counted).encode("utf-8")).hexdigest()
    return {
        "version": VERSION,
        "documents": len(counted),
        "documentIds": [str(d.get("id") or "").strip().lower() for d in counted],
        "types": {k: types[k] for k in sorted(types)},
        "totals": totals,
        "digest": digest,
    }


def compare(printed: Dict[str, Any], cloud: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Where two manifests of the same documents differ (pure): `[{key, printed, cloud}]` —
    counts, per-type ranges, totals and the digest. Empty: the same documents, to the agora.
    """
    out: List[Dict[str, Any]] = []

    def differ(key: str, a: Any, b: Any) -> None:
        if a != b:
            out.append({"key": key, "printed": a, "cloud": b})

    differ("documents", printed.get("documents"), cloud.get("documents"))
    p_types, c_types = printed.get("types") or {}, cloud.get("types") or {}
    for t in sorted(set(p_types) | set(c_types)):
        a, b = p_types.get(t) or {}, c_types.get(t) or {}
        for field in ("count", "first", "last"):
            differ(f"types.{t}.{field}", a.get(field), b.get(field))
    p_totals, c_totals = printed.get("totals") or {}, cloud.get("totals") or {}
    for key in TOTAL_KEYS:
        differ(f"totals.{key}", p_totals.get(key), c_totals.get(key))
    differ("totals.payments", p_totals.get("payments"), c_totals.get("payments"))
    differ("digest", printed.get("digest"), cloud.get("digest"))
    return out


def sum_totals(manifests: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The shop's totals from its tills' manifests — what the main till prints."""
    out: Dict[str, Any] = {"documents": 0}
    sums: Dict[str, int] = {k: 0 for k in TOTAL_KEYS if k not in ("documents", "vat")}
    vat: Optional[int] = 0
    for m in manifests:
        totals = m.get("totals") or {}
        out["documents"] += int(totals.get("documents") or 0)
        for key in sums:
            sums[key] += agorot(totals.get(key)) or 0
        if vat is not None:
            v = agorot(totals.get("vat"))
            vat = None if v is None else vat + v
    for key, value in sums.items():
        out[key] = money(value)
    out["vat"] = money(vat) if vat is not None else None
    return out


# ── The cloud's documents, in the canonical form ─────────────────────────────


def _str(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def canonical_of_row(tx: Any, legs: Sequence[Any]) -> Dict[str, Any]:
    """A cloud `transactions` row and its `transaction_payments`, as the manifest reads them."""
    status = getattr(tx.status, "value", tx.status)
    return {
        "id": str(tx.id).lower(),
        "number": tx.transaction_number,
        "type": tx.document_type,
        "status": status,
        "refundOf": _str(tx.refund_of_transaction_id),
        "total": _str(tx.total_amount),
        "discount": _str(tx.document_discount),
        "vat": _str(tx.vat_amount),
        "tip": _str(tx.tip_amount),
        "paymentMethod": tx.payment_method,
        "payments": [{"method": p.method, "amount": _str(p.amount)} for p in legs],
    }


def cloud_documents(db, ids: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """The named documents the cloud has, canonical, by id (lower-case)."""
    import uuid

    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment

    wanted = []
    for raw in ids:
        try:
            wanted.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError):
            continue
    out: Dict[str, Dict[str, Any]] = {}
    for start in range(0, len(wanted), 500):
        chunk = wanted[start:start + 500]
        rows = db.query(Transaction).filter(Transaction.id.in_(chunk)).all()
        legs: Dict[Any, List[Any]] = {}
        for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_(chunk)).all():
            legs.setdefault(leg.transaction_id, []).append(leg)
        for tx in rows:
            out[str(tx.id).lower()] = {
                **canonical_of_row(tx, legs.get(tx.id, [])),
                "machineId": str(tx.machine_id),
            }
    return out
