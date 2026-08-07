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
        .options(joinedload(Transaction.items))
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
        "cashier": {"name": tx.cashier_id or ""},
        "customer": {"name": "לקוח כללי"},
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
