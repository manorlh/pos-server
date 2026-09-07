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
from app.services.open_format.tax_report_generator import (
    BusinessInfoDict,
    TaxReportResult,
    build_open_format_zip,
    generate_tax_report,
)
from app.services.settings_merge import build_business_info, merge_all_settings_layers

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


def _build_cart_from_items(items, global_tax_rate: float) -> Dict[str, Any]:
    """
    The cart block of a C100/D120 document record.

    **Deliberately does not use the document's stored `net_amount` / `vat_amount`**,
    even though those now exist and are more truthful about what the customer paid.

    This block's fields are defined in *gross* terms with the discount carried
    separately: `totalAmount` is the gross of the line totals and becomes C100 field
    1223, `subtotal` becomes 1219 with 1220/1221 subtracting the discount from it, and
    `resolve_payment_legs` scales D120 amounts to this same `totalAmount` so the payment
    records sum to the document record. Substituting the post-discount split here would
    feed 1221 a subtotal the discount had already been taken out of and subtract it a
    second time — a corrupted filing, not an improvement.

    There is a real defect underneath: on a discounted document field 1222 declares VAT
    extracted from the gross, so the business reports more output VAT than it collected.
    Correcting it means changing 1223 to be net of the discount and D120 to carry raw
    leg amounts — i.e. changing what the business declares it billed. That is the
    accountant's call, and `resolve_payment_legs` already says so in as many words.

    The stored split is used everywhere it is safe to: it is on the document for audit,
    and reporting reads it. It stops here, at the filing boundary, on purpose.
    """
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
            }
        )

    subtotal = gross_total / (1 + tax_rate) if tax_rate > 0 else gross_total
    tax_amount = gross_total - subtotal
    return {
        "items": cart_items,
        "subtotal": subtotal,
        "taxAmount": tax_amount,
        "totalAmount": gross_total,
        "discountAmount": 0,
    }


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
    """
    customer = tx.customer
    if customer is None:
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


def transform_transaction_for_open_format(tx: Transaction, global_tax_rate: float) -> Dict[str, Any]:
    status_val = tx.status.value if hasattr(tx.status, "value") else str(tx.status)
    doc_date = tx.document_production_date or tx.created_at
    return {
        "id": str(tx.id),
        "transactionNumber": tx.transaction_number,
        "status": status_val,
        "documentType": tx.document_type or 320,
        "documentProductionDate": doc_date.isoformat() if doc_date else None,
        "paymentMethod": tx.payment_method,
        "documentDiscount": _decimal_to_float(tx.document_discount),
        "whtDeduction": _decimal_to_float(tx.wht_deduction),
        "branchId": tx.branch_id,
        "refundOfTransactionId": str(tx.refund_of_transaction_id) if tx.refund_of_transaction_id else None,
        "createdAt": tx.created_at.isoformat() if tx.created_at else None,
        # Tender legs. A single-tender document produces the same single D120 payment
        # record it always has; a split-tender one produces one per leg, each with its
        # own payment-type code. See `resolve_payment_legs` for how the amounts are
        # apportioned and why.
        "payments": _payments_for_open_format(tx),
        "cashier": {"name": tx.cashier_id or ""},
        "customer": _customer_for_open_format(tx),
        "cart": _build_cart_from_items(tx.items, global_tax_rate),
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
    tx_dicts = [transform_transaction_for_open_format(tx, ctx.global_tax_rate) for tx in rows]
    result = generate_tax_report(
        tx_dicts,
        ctx.business_info,
        ctx.date_range,
        output_path="",
        global_tax_rate=ctx.global_tax_rate,
    )
    zip_bytes = build_open_format_zip(result.ini_content, result.bkmv_content)
    return result, tx_dicts, zip_bytes
