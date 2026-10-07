"""
The transactions search as flat rows for the Excel export (docs/SPEC_REPORTS.md §2).

`GET /transactions/export` runs the list's own filters (`routers/transactions._filtered_query`)
and hands every matching document here — never a page of them. One row per document with
what a bookkeeper reconciles on: the number as printed (`20000057`), its type and status,
shop, till and employee, the money (total, discount, what was collected, VAT, net of VAT,
tip), the tender split from the legs, card brands and the card's last four digits, the shift
and the Z it went into, and the original of a credit note.

Bulk lookups only — one query per kind of thing, chunked — so 50,000 documents is a handful
of queries, not 50,000.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZReport
from app.services.document_prefix import document_number_from, document_number_of
from app.services.tenders import expected_tender_total, is_refund_document, normalize_tender
from app.services.transmissions import approval_number_of, card_last4_of

CHUNK = 1000
CENT = Decimal("0.01")


def _chunks(ids: Sequence[Any]) -> Iterable[List[Any]]:
    ids = list(ids)
    for start in range(0, len(ids), CHUNK):
        yield ids[start:start + CHUNK]


def _money(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(Decimal(str(value)).quantize(CENT))


def _iso(moment) -> Optional[str]:
    return moment.isoformat() if moment is not None else None


def _legs(db: Session, tx_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, List[TransactionPayment]]:
    out: Dict[uuid.UUID, List[TransactionPayment]] = {}
    for chunk in _chunks(tx_ids):
        for leg in (
            db.query(TransactionPayment)
            .filter(TransactionPayment.transaction_id.in_(chunk))
            .order_by(TransactionPayment.transaction_id, TransactionPayment.sequence)
            .all()
        ):
            out.setdefault(leg.transaction_id, []).append(leg)
    return out


def _by_id(db: Session, model, ids: Iterable[Any]) -> Dict[Any, Any]:
    wanted = list({i for i in ids if i is not None})
    out: Dict[Any, Any] = {}
    for chunk in _chunks(wanted):
        for row in db.query(model).filter(model.id.in_(chunk)).all():
            out[row.id] = row
    return out


def _originals(db: Session, ids: Iterable[Any]) -> Dict[Any, Optional[str]]:
    wanted = list({i for i in ids if i is not None})
    out: Dict[Any, Optional[str]] = {}
    for chunk in _chunks(wanted):
        for tid, number, prefix, pos in (
            db.query(
                Transaction.id, Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number
            )
            .filter(Transaction.id.in_(chunk))
            .all()
        ):
            out[tid] = document_number_from(number, prefix, pos)
    return out


def cashier_names(db: Session, cashier_ids: Iterable[Optional[str]]) -> Dict[str, str]:
    """The till users' display names, keyed by the id the documents carry."""
    from app.services.reports import _display_name, _load_cashier_names

    ids = sorted({c for c in cashier_ids if c})
    if not ids:
        return {}
    return {k: _display_name(v) or k for k, v in _load_cashier_names(db, ids).items()}


def export_rows(db: Session, rows: Sequence[Transaction]) -> List[Dict[str, Any]]:
    """Every document in `rows`, flattened for the Excel sheet, in the order given."""
    tx_ids = [r.id for r in rows]
    legs = _legs(db, tx_ids)
    machines = _by_id(db, POSMachine, (r.machine_id for r in rows))
    shops = _by_id(db, Shop, (r.shop_id for r in rows))
    shifts = _by_id(db, Shift, (r.shift_id for r in rows))
    zs = _by_id(db, ZReport, (s.z_report_id for s in shifts.values()))
    originals = _originals(db, (r.refund_of_transaction_id for r in rows))
    names = cashier_names(db, (r.cashier_id for r in rows))

    out: List[Dict[str, Any]] = []
    for tx in rows:
        refund = is_refund_document(document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id)
        collected = expected_tender_total(
            total_amount=tx.total_amount,
            document_discount=tx.document_discount,
            document_type=tx.document_type,
            refund_of_transaction_id=tx.refund_of_transaction_id,
        )
        split = {"cash": Decimal("0"), "card": Decimal("0"), "other": Decimal("0"), "exchange": Decimal("0")}
        brands: List[str] = []
        last4: List[str] = []
        approvals: List[str] = []
        doc_legs = legs.get(tx.id) or []
        for leg in doc_legs:
            bucket = normalize_tender(leg.method)
            split[bucket] = split.get(bucket, Decimal("0")) + Decimal(str(leg.amount or 0))
            if bucket == "card":
                if leg.card_brand and leg.card_brand not in brands:
                    brands.append(leg.card_brand)
                tail = card_last4_of(leg.nayax_meta)
                if tail and tail not in last4:
                    last4.append(tail)
                approval = approval_number_of(leg.nayax_meta)
                if approval and approval not in approvals:
                    approvals.append(approval)
        if not doc_legs:
            # A document with no leg rows: its own tender, as every report reads it.
            split[normalize_tender(tx.payment_method)] += collected
        machine = machines.get(tx.machine_id)
        shop = shops.get(tx.shop_id)
        shift = shifts.get(tx.shift_id)
        z = zs.get(shift.z_report_id) if shift is not None and shift.z_report_id else None
        vat = tx.vat_amount
        out.append({
            "id": str(tx.id),
            "createdAt": _iso(tx.created_at),
            "serverReceivedAt": _iso(tx.server_received_at),
            "documentNumber": document_number_of(tx),
            "documentType": tx.document_type,
            "status": tx.status,
            "shopId": str(tx.shop_id) if tx.shop_id else None,
            "shopName": shop.name if shop else None,
            "machineId": str(tx.machine_id),
            "machineName": machine.name if machine else None,
            "posNumber": tx.pos_number or (machine.pos_number if machine else None),
            "cashierId": tx.cashier_id,
            "cashierName": names.get(tx.cashier_id) if tx.cashier_id else None,
            "paymentMethod": tx.payment_method,
            "totalAmount": _money(tx.total_amount),
            "documentDiscount": _money(tx.document_discount or 0),
            # What the tender legs add up to (a sale less its discount; a credit note as paid back).
            "collected": _money(collected),
            # Signed for summing: a credit note takes money back out.
            "signedAmount": _money(-collected if refund else collected),
            "vatAmount": _money(vat),
            "netOfVat": _money(collected - Decimal(str(vat))) if vat is not None else None,
            "vatRate": _money(tx.vat_rate) if tx.vat_rate is not None else None,
            "tipAmount": _money(tx.tip_amount or 0),
            "tipPaymentMethod": tx.tip_payment_method,
            "cash": _money(split["cash"]),
            "card": _money(split["card"]),
            "other": _money(split["other"]),
            "exchange": _money(split["exchange"]),
            "legs": len(doc_legs),
            "cardBrands": brands,
            "cardLast4": last4,
            "approvalNumbers": approvals,
            "refundOf": originals.get(tx.refund_of_transaction_id) if tx.refund_of_transaction_id else None,
            "basketId": str(tx.basket_id) if tx.basket_id else None,
            "shiftId": str(tx.shift_id) if tx.shift_id else None,
            "shiftNumber": shift.sequence_number if shift else None,
            "zReportId": str(z.id) if z else None,
            "zNumber": z.z_number if z else None,
            "customerName": tx.customer_name,
            "mealKind": tx.meal_kind,
        })
    return out
