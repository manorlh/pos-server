"""Cloud tax report (OPEN FORMAT) — load transactions and generate export."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional, Tuple, Union
import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.models.company import Company
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.services.open_format.tax_report_generator import (
    BusinessInfoDict,
    TaxReportResult,
    build_open_format_zip,
    generate_tax_report,
)
from app.services.document_prefix import document_number_of
from app.services.settings_merge import build_business_info, merge_all_settings_layers
from app.services.tenders import RECEIPT_DOCUMENT_TYPES, is_refund_document

MAX_TRANSACTIONS_PER_EXPORT = 50_000


@dataclass
class TaxExportContext:
    company: Company
    shop: Optional[Shop]
    business_info: BusinessInfoDict
    global_tax_rate: float
    date_range: Union[Dict[str, Any], Dict[str, int]]
    start: datetime
    end: datetime


def _decimal_to_float(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _resolve_global_tax_rate(company: Company, shop: Optional[Shop]) -> float:
    merged = merge_all_settings_layers(company, shop)
    rate = merged.get("globalTaxRate")
    if rate is None:
        return 18.0
    try:
        return float(rate)
    except (TypeError, ValueError):
        return 18.0


def business_info_to_dict(bi) -> BusinessInfoDict:
    return {
        "vatNumber": bi.vat_number or "",
        "companyName": bi.company_name or "",
        "companyAddress": bi.company_address or "",
        "companyAddressNumber": bi.company_address_number or "1",
        "companyCity": bi.company_city or "",
        "companyZip": bi.company_zip or "",
        "companyRegNumber": bi.company_reg_number or "",
        "withholdingFileNumber": "000000000",
        "hasBranches": bool(bi.has_branches),
        "branchId": bi.branch_id or "",
        # "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md): shown on the export's preview.
        "dealerType": getattr(bi, "dealer_type", None) or "company",
    }


def validate_business_info(business_info: BusinessInfoDict) -> None:
    vat = (business_info.get("vatNumber") or "").strip()
    if not vat or not any(c.isdigit() for c in vat):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="VAT number is required. Configure it in company settings (businessInfo / vatNumber).",
        )
    name = (business_info.get("companyName") or "").strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Company name is required for tax export.",
        )


def parse_date_range(
    mode: Literal["date-range", "year"],
    *,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    year: Optional[int] = None,
) -> Tuple[datetime, datetime, Union[Dict[str, Any], Dict[str, int]]]:
    if mode == "year":
        if year is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="year is required for year mode")
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        return start, end, {"year": year}

    if from_date is None or to_date is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="from and to are required for date-range mode",
        )
    if from_date > to_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="from must be before or equal to to")
    start = datetime.combine(from_date, time.min, tzinfo=timezone.utc)
    end = datetime.combine(to_date, time.max.replace(microsecond=0), tzinfo=timezone.utc)
    return start, end, {"start": start, "end": end}


def load_transactions_for_tax_export(
    db: Session,
    tenant_id: uuid.UUID,
    *,
    company_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
    start: datetime,
    end: datetime,
) -> List[Transaction]:
    query = (
        db.query(Transaction)
        .options(
            joinedload(Transaction.items),
            # Eager, not lazy: a 50k-document export would otherwise fire two extra
            # queries per document while building the payment and customer records.
            joinedload(Transaction.payments),
            joinedload(Transaction.customer),
            # The shop's branch code, for a document the till stamped none on.
            joinedload(Transaction.shop),
        )
        .filter(
            Transaction.tenant_id == tenant_id,
            Transaction.created_at >= start,
            Transaction.created_at <= end,
        )
        .order_by(Transaction.created_at.asc())
    )

    if shop_id is not None:
        query = query.filter(Transaction.shop_id == shop_id)
    elif company_id is not None:
        shop_ids = [
            row[0]
            for row in db.query(Shop.id).filter(
                Shop.company_id == company_id,
                Shop.tenant_id == tenant_id,
            ).all()
        ]
        if not shop_ids:
            return []
        query = query.filter(Transaction.shop_id.in_(shop_ids))
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="companyId or shopId required")

    count = query.count()
    if count > MAX_TRANSACTIONS_PER_EXPORT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many transactions ({count}). Narrow the date range (max {MAX_TRANSACTIONS_PER_EXPORT}).",
        )

    return query.all()


BaseDocument = Dict[str, Any]


@dataclass
class BaseDocuments:
    """
    The originals the export's credit notes name, resolved **outside** the export window.

    D110 fields 1256/1257 (סוג / מספר מסמך בסיס) name the receipt a credit-note line
    returns. The original is very often from an earlier period than its credit note, so
    looking it up among the exported documents only — as the export used to — left the
    fields empty on exactly the returns an inspector follows back. Every lookup is within
    the export's tenant: the links are not foreign keys, and must not reach another
    tenant's documents.
    """

    by_document: Dict[str, BaseDocument]
    #: original line id → its document's base block.
    by_line: Dict[str, BaseDocument]


def document_branch_id(tx: Transaction) -> Optional[str]:
    """
    Field 1231 of a document: the branch code the till stamped on it, else (a document
    from before branch codes were mandatory, or from a till that had not synced its code
    yet) its shop's code — so two shops' `10000057` never file alike in a company's export
    (app/services/branch_code.py).
    """
    stamped = (tx.branch_id or "").strip()
    if stamped:
        return stamped
    shop = getattr(tx, "shop", None)
    code = (getattr(shop, "branch_id", None) or "").strip() if shop is not None else ""
    return code or None


def refuse_shops_without_branch_code(
    db: Session, rows: List[Transaction], shop: Optional[Shop] = None
) -> None:
    """
    400 when a shop the export covers has no branch code. Every shop has one since the
    code became mandatory (migration f3a9c2d7e1b4 filled the rest), so this is defensive:
    a file whose documents cannot be told apart by branch is not written at all.
    """
    from app.services.branch_code import shops_without_code

    shop_ids = {tx.shop_id for tx in rows if tx.shop_id is not None}
    shops = db.query(Shop).filter(Shop.id.in_(shop_ids)).all() if shop_ids else []
    if shop is not None and all(s.id != shop.id for s in shops):
        shops.append(shop)
    missing = shops_without_code(shops)
    if missing:
        names = ", ".join(sorted(s.name for s in missing))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"לא ניתן להפיק קובץ: לסניפים הבאים אין קוד סניף — {names}. יש להגדיר קוד סניף בעמוד הסניף.",
        )


def export_document_number(tx: Transaction) -> str:
    """
    The document number filed in the open format, exactly as the till printed it: the
    prefix and the number padded to 7 digits, no dash (`20000057`; the owner's "ללא מקף",
    docs/SPEC_DOCUMENT_PREFIX.md). C100 field 1204, D110 field 1254 and D120 field 1304
    are alphanumeric X(20) (`DOCUMENT_NUMBER_WIDTH`), so this is written as text; two
    tills' #57 file as `10000057` and `20000057`. A number is unique together with its
    type (field 1203): each type has its own series. Every record of a document — its
    header, its lines, its payments — and every line that names it as a base document
    (D110 field 1257) takes the number from here, so the file stays consistent.
    """
    return document_number_of(tx)


def _base_of(tx: Transaction) -> BaseDocument:
    return {
        "documentType": tx.document_type or 320,
        "transactionNumber": export_document_number(tx),
        "branchId": document_branch_id(tx),
    }


def load_base_documents(
    db: Session, tenant_id: uuid.UUID, rows: List[Transaction]
) -> BaseDocuments:
    doc_ids = {tx.refund_of_transaction_id for tx in rows if tx.refund_of_transaction_id}
    line_ids = {
        it.refund_of_item_id for tx in rows for it in (tx.items or []) if it.refund_of_item_id
    }
    by_line_doc: Dict[str, uuid.UUID] = {}
    if line_ids:
        for item_id, doc_id in (
            db.query(TransactionItem.id, TransactionItem.transaction_id)
            .filter(TransactionItem.id.in_(line_ids))
            .all()
        ):
            by_line_doc[str(item_id)] = doc_id
            doc_ids.add(doc_id)
    by_document: Dict[str, BaseDocument] = {}
    if doc_ids:
        for original in (
            db.query(Transaction)
            .filter(Transaction.id.in_(doc_ids), Transaction.tenant_id == tenant_id)
            .all()
        ):
            by_document[str(original.id)] = _base_of(original)
    return BaseDocuments(
        by_document=by_document,
        by_line={
            line: by_document[str(doc)]
            for line, doc in by_line_doc.items()
            if str(doc) in by_document
        },
    )


def _build_cart_from_items(
    tx: Transaction, global_tax_rate: float, bases: Optional[BaseDocuments] = None
) -> Dict[str, Any]:
    """
    The cart block of a C100/D120 document record.

    The three money figures are the ones the document was actually settled at, **after
    discounts**, because that is what the מבנה אחיד spec asks for:

    * `subtotal`  → C100 field 1221, "סכום המסמך לאחר הנחות ללא מע\"מ"
    * `taxAmount` → field 1222, "סכום המע\"מ במסמך"
    * `totalAmount` → field 1223, "סכום המסמך כולל מע\"מ", and the D120 payment total

    This block used to report the *gross* of the line totals for all three and leave
    `discountAmount` at 0, which broke a discounted document three ways at once: 1222
    declared VAT on money the customer never paid, 1223 overstated the turnover, and
    1221 + 1222 no longer equalled 1223 — an internal contradiction on every discounted
    document, which is exactly the sort of thing an inspector's tooling checks. On a
    ₪12.00 basket sold for ₪10.00 it declared ₪1.83 of VAT instead of ₪1.53 and ₪12.00
    of turnover instead of ₪10.00.

    Taken from the document's own stored split wherever it exists: that pair is what the
    till printed and handed the customer, so a filing built from it agrees with the paper
    by construction and a later VAT-rate change cannot re-state it.

    `discountAmount` is returned gross so the caller can reconstruct field 1219 as
    1221 + the discount, keeping 1219 − 1220 = 1221 exact. Note it carries *all*
    discounts, line and basket together, because that is what the till sends as one
    figure; the per-line breakdown is reported separately in D110 field 1266 against
    line totals that are themselves gross, so the two views stay consistent.

    `items` deliberately keep their gross line totals — D110 reports each line's own
    discount in 1266 and must not have it subtracted twice.
    """
    items = tx.items
    tax_rate = global_tax_rate / 100.0
    cart_items: List[Dict[str, Any]] = []
    gross_total = 0.0
    for it in items:
        total_price = _decimal_to_float(it.total_price)
        unit_price = _decimal_to_float(it.unit_price)
        gross_total += total_price
        cart_items.append(
            {
                "id": str(it.id),
                "productId": str(it.product_id) if it.product_id else None,
                "product": {
                    "id": str(it.product_id) if it.product_id else "",
                    "sku": it.sku or "",
                    "name": it.product_name or "",
                },
                "quantity": _decimal_to_float(it.quantity),
                "unitPrice": unit_price,
                "totalPrice": total_price,
                "discount": _decimal_to_float(it.discount),
                "lineDiscount": _decimal_to_float(it.line_discount),
                "transactionType": it.transaction_type or 2,
                # The receipt this credit-note line returns (D110 1256/1257), when the
                # line names its original and the cloud holds it.
                "base": (
                    bases.by_line.get(str(it.refund_of_item_id))
                    if bases is not None and it.refund_of_item_id
                    else None
                ),
            }
        )

    discount = _decimal_to_float(tx.document_discount) or 0.0
    net, vat = _document_split(tx, gross_total, discount, tax_rate)

    return {
        "items": cart_items,
        "subtotal": net,
        "taxAmount": vat,
        # The sum of the two halves rather than the line total, so the record reconciles
        # exactly. These are the same number on an undiscounted document.
        "totalAmount": round(net + vat, 2),
        "discountAmount": discount,
    }


def _document_split(
    tx: Transaction, gross_total: float, discount: float, tax_rate: float
) -> Tuple[float, float]:
    """
    The document's net and VAT, after discounts.

    Prefers what the till stored at the point of sale. Falls back to deriving it for
    documents issued before those columns existed — but derives it from the money
    actually settled (`gross_total - discount`), not from the gross, which is the whole
    bug this replaces.

    A credit note is the exception: its `total_amount` is already net of the apportioned
    discount (see the conventions note at the top of `app/services/reports.py`), so
    subtracting the discount again would credit back money that was never refunded.
    """
    if tx.net_amount is not None and tx.vat_amount is not None:
        return _decimal_to_float(tx.net_amount), _decimal_to_float(tx.vat_amount)

    settled = gross_total if _is_credit_note(tx) else gross_total - discount
    if tx.document_type in RECEIPT_DOCUMENT_TYPES:
        # An exempt dealer's receipt never carried VAT (docs/SPEC_BUSINESS_TYPE.md).
        return round(settled, 2), 0.0
    net = settled / (1 + tax_rate) if tax_rate > 0 else settled
    return round(net, 2), round(settled - net, 2)


def _is_credit_note(tx: Transaction) -> bool:
    # 330, or an exempt dealer's receipt refund (-400) — `tenders.is_refund_document`.
    return is_refund_document(
        document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id
    )


def _payments_for_open_format(tx: Transaction) -> List[Dict[str, Any]]:
    """
    The document's tender legs, in the order they were taken.

    Sorted here rather than relying on the relationship's `order_by`, because the
    export must number the same document's payment records identically on every run
    and a tie on `sequence` (two legs a client numbered the same) would otherwise be
    resolved by whatever order the rows came back in.
    """
    legs = list(tx.payments or [])
    legs.sort(key=lambda p: (p.sequence or 0, str(p.id)))
    return [
        {
            "id": str(leg.id),
            "sequence": leg.sequence,
            "method": leg.method,
            "amount": _decimal_to_float(leg.amount),
        }
        for leg in legs
    ]


def _customer_for_open_format(tx: Transaction) -> Dict[str, Any]:
    """
    The customer block for the C100 document record.

    Falls back to "לקוח כללי" — the general customer — exactly as before whenever the
    document has no resolved customer, which is every walk-in sale and every document
    written before customers existed. Only `customer_ref_id` is consulted: the raw
    `customer_id` string is unvalidated free text and must never reach a tax filing.
    Without a resolved customer, the buyer details printed on the document
    (`customer_name` / `_phone` / `_address`) are used when it has any.
    """
    customer = tx.customer
    if customer is None:
        # The buyer's details as the till printed them (a return records who returned
        # it). A snapshot, used only when there is no resolved customer.
        if tx.customer_name or tx.customer_phone or tx.customer_address:
            return {
                "name": tx.customer_name or "לקוח כללי",
                "phone": tx.customer_phone or None,
                "address": {"street": tx.customer_address or ""},
            }
        return {"name": "לקוח כללי"}
    return {
        "name": customer.name or "לקוח כללי",
        "vatNumber": customer.vat_number or None,
        "phone": customer.phone or None,
        "address": {
            "street": customer.address or "",
            "houseNumber": customer.address_number or "",
            "city": customer.city or "",
            "zipCode": customer.postal_code or "",
            "country": customer.country or "",
        },
    }


def transform_transaction_for_open_format(
    tx: Transaction, global_tax_rate: float, bases: Optional[BaseDocuments] = None
) -> Dict[str, Any]:
    status_val = tx.status.value if hasattr(tx.status, "value") else str(tx.status)
    doc_date = tx.document_production_date or tx.created_at
    return {
        "id": str(tx.id),
        # `20000057` — the header, the lines and the payments all read it here.
        "transactionNumber": export_document_number(tx),
        "status": status_val,
        "documentType": tx.document_type or 320,
        "documentProductionDate": doc_date.isoformat() if doc_date else None,
        "paymentMethod": tx.payment_method,
        "documentDiscount": _decimal_to_float(tx.document_discount),
        "whtDeduction": _decimal_to_float(tx.wht_deduction),
        "branchId": document_branch_id(tx),
        "refundOfTransactionId": str(tx.refund_of_transaction_id) if tx.refund_of_transaction_id else None,
        # The original named by `refundOfTransactionId`, even when outside the export.
        "baseDocument": (
            bases.by_document.get(str(tx.refund_of_transaction_id))
            if bases is not None and tx.refund_of_transaction_id
            else None
        ),
        "createdAt": tx.created_at.isoformat() if tx.created_at else None,
        # Tender legs. A single-tender document produces the same single D120 payment
        # record it always has; a split-tender one produces one per leg, each with its
        # own payment-type code. See `resolve_payment_legs` for how the amounts are
        # apportioned and why.
        "payments": _payments_for_open_format(tx),
        "cashier": {"name": tx.cashier_id or ""},
        "customer": _customer_for_open_format(tx),
        "cart": _build_cart_from_items(tx, global_tax_rate, bases),
    }


def resolve_export_context(
    db: Session,
    *,
    company: Company,
    shop: Optional[Shop],
    mode: Literal["date-range", "year"],
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    year: Optional[int] = None,
) -> TaxExportContext:
    start, end, date_range = parse_date_range(mode, from_date=from_date, to_date=to_date, year=year)
    merged = merge_all_settings_layers(company, shop)
    bi = build_business_info(company, shop, merged)
    business_info = business_info_to_dict(bi)
    validate_business_info(business_info)
    global_tax_rate = _resolve_global_tax_rate(company, shop)
    return TaxExportContext(
        company=company,
        shop=shop,
        business_info=business_info,
        global_tax_rate=global_tax_rate,
        date_range=date_range,
        start=start,
        end=end,
    )


def build_tax_open_format_export(
    db: Session,
    tenant_id: uuid.UUID,
    ctx: TaxExportContext,
    *,
    company_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
) -> Tuple[TaxReportResult, List[Dict[str, Any]], bytes]:
    rows = load_transactions_for_tax_export(
        db,
        tenant_id,
        company_id=company_id,
        shop_id=shop_id,
        start=ctx.start,
        end=ctx.end,
    )
    refuse_shops_without_branch_code(db, rows, ctx.shop)
    bases = load_base_documents(db, tenant_id, rows)
    tx_dicts = [transform_transaction_for_open_format(tx, ctx.global_tax_rate, bases) for tx in rows]
    result = generate_tax_report(
        tx_dicts,
        ctx.business_info,
        ctx.date_range,
        output_path="",
        global_tax_rate=ctx.global_tax_rate,
    )
    zip_bytes = build_open_format_zip(result.ini_content, result.bkmv_content)
    return result, tx_dicts, zip_bytes
