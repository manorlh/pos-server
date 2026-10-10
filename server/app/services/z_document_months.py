"""
"מתוך ה-Z: ₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר (לדיווח לפי תאריך המסמך)".

A Z is dated when it was produced; its documents keep their own dates, and VAT and the uniform
file go by the document's date. A Z of the night of 30.9 closed at 03:00 holds documents of
September and of October — so the Z says how much of it belongs to each calendar month, and only
then (a Z of one month shows nothing).

The split is over exactly the documents the Z counts and the amount it counts for each
(`shift_totals`: no duplicate copy, sale statuses only, no ₪0 memo document; a sale's collected
total, a credit note's back out), so the months add up to the Z's net sales. Each document goes
by its document date (`document_production_date`, else `created_at`) in the report timezone —
never by the business day. Presentation only: nothing fiscal changes.

Frozen on the header at build (`documentMonths`, like the other breakdowns); a Z built before it
is read from its documents. The till prints the same line from the Z it gets back (pos-android
domain/BusinessDay.kt, the same golden fixture as app/services/business_day.py).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.shift import Shift
from app.models.transaction import Transaction
from app.services.business_day import cross_month_line, document_months
from app.services.dashboard_stats import SALE_STATUSES
from app.services.tenders import expected_tender_total, is_refund_document

HEADER_KEY = "documentMonths"
SOURCE_STORED = "stored"
SOURCE_DOCUMENTS = "documents"


def _dec(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value or 0))


def counted_amounts(documents: Iterable[Transaction]) -> List[Tuple[datetime, Decimal]]:
    """`(document date, signed amount)` for every document a Z counts, as `shift_totals` counts it."""
    out: List[Tuple[datetime, Decimal]] = []
    for doc in documents:
        if getattr(doc, "duplicate_copy", False) or doc.status not in SALE_STATUSES:
            continue
        if getattr(doc, "voucher_memo", False) and not _dec(doc.total_amount) and not _dec(doc.tip_amount):
            continue
        refund = is_refund_document(document_type=doc.document_type, refund_of_transaction_id=doc.refund_of_transaction_id)
        collected = expected_tender_total(
            total_amount=doc.total_amount,
            document_discount=doc.document_discount,
            document_type=doc.document_type,
            refund_of_transaction_id=doc.refund_of_transaction_id,
        )
        out.append((doc.document_production_date or doc.created_at, -collected if refund else collected))
    return out


def months_for_shifts(db: Session, shift_ids: Iterable[Any], tz_name: str) -> List[Dict[str, str]]:
    """The Z's documents (its shifts' own till's) by calendar month of their document date."""
    ids = list(shift_ids)
    if not ids:
        return []
    documents = (
        db.query(Transaction)
        .join(Shift, Shift.id == Transaction.shift_id)
        .filter(Transaction.shift_id.in_(ids), Transaction.machine_id == Shift.machine_id)
        .all()
    )
    return document_months(counted_amounts(documents), tz_name)


def _tz_of(db: Session, tenant_id: Any) -> str:
    from app.services.reports import resolve_report_timezone

    return resolve_report_timezone(db, tenant_id, None)


def freeze_on_z(db: Session, z: Any, shifts: Iterable[Shift]) -> None:
    """At build: the months on the header — never a condition on the Z (a failure leaves them out)."""
    if z.header is None:
        return
    try:
        months = months_for_shifts(db, [s.id for s in shifts], _tz_of(db, z.tenant_id))
    except Exception:  # pragma: no cover - presentation only, the Z is built regardless
        return
    z.header = {**z.header, HEADER_KEY: months}


def months_of_z(db: Session, z: Any) -> Tuple[List[Dict[str, str]], Optional[str]]:
    """The Z's months: as frozen, else read now from its documents; `(months, source)`."""
    stored = (z.header or {}).get(HEADER_KEY)
    if isinstance(stored, list):
        return stored, SOURCE_STORED
    if z.per_machine is None:
        return [], None
    shift_ids = [row[0] for row in db.query(Shift.id).filter(Shift.z_report_id == z.id).all()]
    if not shift_ids:
        return [], None
    return months_for_shifts(db, shift_ids, _tz_of(db, z.tenant_id)), SOURCE_DOCUMENTS


def stored_line(z: Any) -> Optional[str]:
    """The cross-month line of a Z as frozen on it (the print documents read only what is stored)."""
    stored = (z.header or {}).get(HEADER_KEY) if getattr(z, "header", None) else None
    return cross_month_line(stored) if isinstance(stored, list) else None


def footer_lines(z: Any) -> List[str]:
    """The line for a Z's printed footer, when it has documents of two months; else nothing."""
    line = stored_line(z)
    return [line] if line else []
