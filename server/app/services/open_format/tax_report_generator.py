"""Israeli Tax Authority OPEN FORMAT (ממשק פתוח) generator — port of pos-desktop taxReportGenerator.ts."""

from __future__ import annotations

import random
import re
import time
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple, TypedDict, Union

from app.services.open_format.defaults import DEFAULT_SOFTWARE_INFO, DEFAULT_TAX_REPORT_CONFIG, SoftwareInfo, TaxReportConfig
from app.services.open_format.israeli_tax_id import normalize_israeli_9_digit


class BusinessInfoDict(TypedDict, total=False):
    vatNumber: str
    companyName: str
    companyAddress: str
    companyAddressNumber: str
    companyCity: str
    companyZip: str
    companyRegNumber: str
    withholdingFileNumber: str
    hasBranches: bool
    branchId: str
    #: "company" | "licensed" | "exempt" (docs/SPEC_BUSINESS_TYPE.md). Informational:
    #: what a document is filed as comes from its own stored type.
    dealerType: str


class RecordCounts(TypedDict):
    A100: int
    B110: int
    C100: int
    D110: int
    D120: int
    M100: int
    Z900: int


B110_RECORD_LEN = 376
M100_RECORD_LEN = 298

#: מספר מסמך — C100 field 1204, D110 field 1254 (and 1257, the base document's number),
#: D120 field 1304: alphanumeric, X(20), left-aligned and space-padded (`pad_right`). A
#: document number is text here, so a till's "קידומת מסמכים" is written into it as
#: `<prefix>-<number>` (`2-57`, docs/SPEC_DOCUMENT_PREFIX.md): at most 3 + 1 + 16
#: characters, and a till's counter is nowhere near 16 digits.
DOCUMENT_NUMBER_WIDTH = 20


def pad_right(value: str, length: int, pad_char: str = " ") -> str:
    s = value or ""
    return s.ljust(length, pad_char)[:length]


def pad_left(value: str, length: int, pad_char: str = "0") -> str:
    s = value or ""
    return s.rjust(length, pad_char)[:length]


def format_amount(value: float, _length: int = 15) -> str:
    n = float(value) if value else 0.0
    sign = "-" if n < 0 else "+"
    agorot = round(abs(n) * 100)
    return sign + pad_left(str(agorot), 14, "0")


def format_amount12(value: float) -> str:
    n = float(value) if value else 0.0
    sign = "-" if n < 0 else "+"
    agorot = round(abs(n) * 100)
    return sign + pad_left(str(agorot), 11, "0")


def format_quantity_signed(value: float) -> str:
    n = float(value or 0)
    sign = "-" if n < 0 else "+"
    scaled = round(abs(n) * 10000)
    scaled = min(scaled, 10**16 - 1)
    return sign + pad_left(str(scaled), 16, "0")


def format_date(dt: Union[datetime, date]) -> str:
    if isinstance(dt, datetime):
        d = dt.date()
    else:
        d = dt
    return f"{d.year:04d}{d.month:02d}{d.day:02d}"


def format_time(dt: datetime) -> str:
    return f"{dt.hour:02d}{dt.minute:02d}"


def generate_unique_file_id() -> str:
    timestamp = str(int(time.time() * 1000))
    rnd = str(random.randint(0, 999))
    combined = (timestamp + rnd)[-15:]
    return pad_left(combined, 15, "0")


def format_open_format_link_id(sequence: int) -> str:
    n = abs(int(sequence)) % 10_000_000
    return pad_left(str(n), 7, "0")


def gross_shekels_to_net(gross: float, tax_rate_percent: float) -> float:
    r = tax_rate_percent / 100.0
    if not (gross == gross) or r <= 0:  # NaN check
        return gross
    return gross / (1 + r)


def build_a000_record(
    business_info: BusinessInfoDict,
    software_info: SoftwareInfo,
    tax_report_config: TaxReportConfig,
    total_records: int,
    unique_id: str,
    date_range: Union[Dict[str, Any], Dict[str, int]],
    output_path: str,
    process_date: datetime,
) -> str:
    year_key = "year" in date_range
    record = "A000"
    record += pad_right("", 5)
    record += pad_left(str(total_records), 15, "0")
    record += pad_left(normalize_israeli_9_digit(business_info.get("vatNumber", "")), 9, "0")
    record += pad_left(unique_id, 15, "0")
    record += pad_right(tax_report_config.system_code, 8)
    record += pad_left(software_info.registration_number, 8, "0")
    record += pad_right(software_info.name, 20)
    record += pad_right(software_info.version, 20)
    record += pad_left(normalize_israeli_9_digit(software_info.manufacturer_id), 9, "0")
    record += pad_right(software_info.manufacturer_name, 20)
    record += "1" if software_info.software_type == "single-year" else "2"
    record += pad_right(output_path, 50)
    record += tax_report_config.accounting_type
    record += "1" if tax_report_config.balancing_required else "0"
    record += pad_left(
        normalize_israeli_9_digit(business_info.get("companyRegNumber") or "00000001"),
        9,
        "0",
    )
    record += pad_left(
        normalize_israeli_9_digit(business_info.get("withholdingFileNumber") or "00000000"),
        9,
        "0",
    )
    record += pad_right("", 10)
    record += pad_right(business_info.get("companyName", ""), 50)
    record += pad_right(business_info.get("companyAddress", ""), 50)
    record += pad_right(business_info.get("companyAddressNumber", ""), 10)
    record += pad_right(business_info.get("companyCity", ""), 30)
    record += pad_right(business_info.get("companyZip", ""), 8)

    if year_key:
        yr = int(date_range["year"])
        record += str(yr)
        record += f"{yr}0101"
        year_end = datetime(yr, 12, 31, tzinfo=process_date.tzinfo)
        end_cap = year_end if year_end <= process_date else process_date
        record += format_date(end_cap)
    else:
        start: datetime = date_range["start"]
        end: datetime = date_range["end"]
        record += str(start.year)
        record += format_date(start)
        end_cap = end if end <= process_date else process_date
        record += format_date(end_cap)

    record += format_date(process_date)
    record += format_time(process_date)
    record += tax_report_config.language_code
    record += tax_report_config.charset
    record += pad_right(tax_report_config.compression_software, 20)
    record += tax_report_config.default_currency
    record += "1" if business_info.get("hasBranches") else "0"
    record += pad_right("", 466 - len(record))
    return record


def build_a100_record(vat_number: str, unique_id: str, record_number: int) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    record = "A100"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_left(unique_id, 15, "0")
    record += "&OF1.31&"
    record += pad_right("", 50)
    return record


def build_b110_record(
    vat_number: str,
    record_number: int,
    business_info: BusinessInfoDict,
    *,
    period_sales_total: float = 0.0,
) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    sales = period_sales_total
    record = "B110"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_right("000000000001500", 15)
    record += pad_right(business_info.get("companyName") or "Account", 50)
    record += pad_right("000000000000150", 15)
    record += pad_right("קופה", 30)
    record += pad_right(business_info.get("companyAddress") or "", 50)
    record += pad_right(business_info.get("companyAddressNumber") or "", 10)
    record += pad_right(business_info.get("companyCity") or "", 30)
    record += pad_right(re.sub(r"\D", "", business_info.get("companyZip") or "")[:8], 8)
    record += pad_right("ישראל", 30)
    record += pad_right("IL", 2)
    record += pad_right("", 15)
    record += format_amount(0)
    record += format_amount(abs(sales))
    record += format_amount(0)
    record += pad_left("0001", 4, "0")
    record += pad_left("0", 9, "0")
    record += pad_right("", 7)
    record += format_amount(0)
    record += pad_right("", 3)
    record += pad_right("", 16)
    record = pad_right(record, B110_RECORD_LEN, " ")
    return record[:B110_RECORD_LEN]


def build_m100_record(vat_number: str, record_number: int, product: Dict[str, str]) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    r = "M100"
    r += pad_left(str(record_number), 9, "0")
    r += pad_left(vat, 9, "0")
    r += pad_right(product.get("sku") or "", 20)
    r += pad_right("", 20)
    r += pad_right(product.get("sku") or "", 20)
    r += pad_right(product.get("name") or "", 50)
    r += pad_right("", 10)
    r += pad_right("", 30)
    r += pad_right("יחידה", 20)
    r += format_amount12(0)
    r += format_amount12(0)
    r += format_amount12(0)
    r += pad_left("0", 10, "0")
    r += pad_left("0", 10, "0")
    r += pad_right("", 50)
    r = pad_right(r, M100_RECORD_LEN, " ")
    return r[:M100_RECORD_LEN]


def collect_unique_products_for_m100(transactions: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    seen: Dict[str, Dict[str, str]] = {}
    for t in transactions:
        if t.get("status") == "cancelled":
            continue
        cart = t.get("cart") or {}
        for item in cart.get("items") or []:
            product = item.get("product") or {}
            key = (
                product.get("id")
                or item.get("productId")
                or f"{product.get('sku', '')}|{product.get('name', '')}"
            )
            if key in seen:
                continue
            seen[str(key)] = {
                "sku": product.get("sku") or "",
                "name": product.get("name") or "",
            }
    return list(seen.values())


def _parse_dt(value: Any, fallback: Any) -> datetime:
    if value is None:
        if isinstance(fallback, datetime):
            return fallback
        return datetime.fromisoformat(str(fallback).replace("Z", "+00:00"))
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


#: Stored document types an exempt dealer (עוסק פטור) issues — a receipt and a receipt
#: refund (docs/SPEC_BUSINESS_TYPE.md; `tenders.RECEIPT_DOCUMENT_TYPES`). Both are filed
#: as 400 (קבלה): there is no מבנה אחיד code for a receipt in the other direction, so the
#: refund is a 400 with negative amounts. A receipt has no item lines (D110) — only its
#: header (C100) and its payments (D120).
RECEIPT_DOCUMENT_TYPE = 400
RECEIPT_REFUND_DOCUMENT_TYPE = -400
RECEIPT_TYPES = (RECEIPT_DOCUMENT_TYPE, RECEIPT_REFUND_DOCUMENT_TYPE)


def is_receipt_document(transaction: Dict[str, Any]) -> bool:
    """An exempt dealer's receipt or receipt refund: filed as 400, without D110 lines."""
    return transaction.get("documentType") in RECEIPT_TYPES


def open_format_document_type(stored: Optional[int], is_refund: bool) -> Tuple[int, int]:
    """
    (C100 field 1203, the sign of the document's amounts) for a stored document.

    320 / 330 as before — a credit note is a 330 by type **or** by its link to an
    original. An exempt dealer's 400 is a 400, and its receipt refund (-400) a 400 whose
    amounts are negative. The one place the internal -400 is translated: if the
    accountant rules another code for the refund, it changes here.
    """
    if stored == RECEIPT_REFUND_DOCUMENT_TYPE:
        return RECEIPT_DOCUMENT_TYPE, -1
    if stored == RECEIPT_DOCUMENT_TYPE:
        return RECEIPT_DOCUMENT_TYPE, 1
    return (330 if is_refund else 320), 1


def build_c100_record(
    transaction: Dict[str, Any],
    vat_number: str,
    record_number: int,
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
    global_tax_rate: Optional[float] = None,
    amount_sign: int = 1,
) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    cart = transaction.get("cart") or {}
    doc_type_val = doc_type if doc_type is not None else transaction.get("documentType")
    tax_rate = (global_tax_rate / 100.0 if global_tax_rate is not None else 0) or 0.18
    doc_production_date = _parse_dt(
        transaction.get("documentProductionDate"),
        transaction.get("createdAt"),
    )
    doc_disc_gross = float(transaction.get("documentDiscount") or 0)
    doc_disc_excl_vat = doc_disc_gross / (1 + tax_rate) if doc_disc_gross > 0 else 0.0
    doc_date_str = format_date(doc_production_date)
    customer = transaction.get("customer") or {}
    addr = customer.get("address") or {}
    f1207 = pad_right((customer.get("name") or "").strip() or "לקוח כללי", 50)
    f1208 = pad_right((addr.get("street") or "").strip(), 50)
    f1209 = pad_right("", 10)
    f1210 = pad_right((addr.get("city") or "").strip(), 30)
    f1211 = pad_right(re.sub(r"\D", "", str(addr.get("zipCode") or ""))[:8], 8)
    country = (addr.get("country") or "").strip()
    f1212 = pad_right(country if len(country) > 2 else "ישראל", 30)
    f1213 = pad_right("IL", 2)
    f1214 = pad_right(re.sub(r"\D", "", str(customer.get("phone") or ""))[:15], 15)
    cust_vat = customer.get("vatNumber")
    f1215 = pad_left(
        normalize_israeli_9_digit(re.sub(r"\D", "", str(cust_vat))) if cust_vat else "000000000",
        9,
        "0",
    )
    f1216 = doc_date_str
    f1217 = format_amount(0)
    f1218 = pad_right("ILS", 3)
    # The document's money, per the מבנה אחיד definitions:
    #   1219 סכום המסמך לפני הנחת מסמך      — before the discount, excluding VAT
    #   1220 הנחת מסמך                       — the discount, negative (הבהרה 5: a
    #                                          discount *reduces* the document amount)
    #   1221 סכום המסמך לאחר הנחות ללא מע"מ  — after the discount, excluding VAT
    #   1222 סכום המע"מ במסמך                — the VAT actually on the document
    #   1223 סכום המסמך כולל מע"מ            — what the customer actually paid
    #
    # 1221, 1222 and 1223 come from the cart block, which now reports the settled
    # figures. 1219 is *derived* from 1221 rather than read separately, so the two
    # identities an inspector can check hold by construction and not by coincidence:
    #
    #   1219 - |1220| == 1221      and      1221 + 1222 == 1223
    #
    # Previously all three were the pre-discount gross, so a discounted document
    # declared VAT and turnover it never took, and 1221 + 1222 did not equal 1223.
    net_after_discount = float(cart.get("subtotal") or 0)
    tax_amount = float(cart.get("taxAmount") or 0)
    total_amount = float(cart.get("totalAmount") or 0)
    # `amount_sign` is -1 only for an exempt dealer's receipt refund, filed as a 400
    # with negative amounts (`open_format_document_type`). The identities above hold in
    # signed arithmetic: 1219 + 1220 == 1221 and 1221 + 1222 == 1223.
    s = -1 if amount_sign < 0 else 1
    f1219 = format_amount(s * (net_after_discount + doc_disc_excl_vat))
    f1220 = format_amount(s * -doc_disc_excl_vat if doc_disc_excl_vat > 0 else 0)
    f1221 = format_amount(s * net_after_discount)
    f1222 = format_amount(s * tax_amount)
    f1223 = format_amount(s * total_amount)
    wht = float(transaction.get("whtDeduction") or 0)
    f1224 = format_amount12(wht)
    seq_key = pad_left(str(record_number % 10_000_000_000_000), 15, "0")[-15:]
    f1225 = pad_right(seq_key, 15)
    f1226 = pad_right("", 10)
    f1228 = "1" if transaction.get("status") == "cancelled" else "0"
    f1230 = doc_date_str
    branch_id = transaction.get("branchId")
    f1231 = pad_right(str(branch_id), 7) if branch_id else pad_right("", 7)
    cashier = transaction.get("cashier") or {}
    f1233 = pad_right(cashier.get("name") or "", 9)
    link = pad_left(re.sub(r"\D", "", link_id7)[-7:] or "0", 7, "0")
    f1235 = pad_right("", 13)

    record = ""
    record += "C100"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_left(str(doc_type_val), 3, "0")
    record += pad_right(transaction.get("transactionNumber") or "", DOCUMENT_NUMBER_WIDTH)
    record += doc_date_str
    record += format_time(doc_production_date)
    record += f1207 + f1208 + f1209 + f1210 + f1211 + f1212 + f1213 + f1214 + f1215
    record += f1216 + f1217 + f1218 + f1219 + f1220 + f1221 + f1222 + f1223 + f1224
    record += f1225 + f1226 + f1228 + f1230 + f1231 + f1233 + link + f1235
    return record[:444]


def build_d110_record(
    transaction: Dict[str, Any],
    item: Dict[str, Any],
    line_number: int,
    vat_number: str,
    record_number: int,
    global_tax_rate: Optional[float],
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
    base_doc_type: Optional[str] = None,
    base_doc_number: Optional[str] = None,
    base_branch_id: Optional[str] = None,
) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    line_discount = item.get("lineDiscount") or item.get("discount") or 0
    doc_type_val = doc_type if doc_type is not None else transaction.get("documentType")
    base_dt = pad_left(re.sub(r"\D", "", str(base_doc_type or ""))[:3], 3, "0")
    base_num = pad_right(base_doc_number or "", DOCUMENT_NUMBER_WIDTH)
    rate_pct = global_tax_rate if global_tax_rate is not None else 18.0
    vat_four = pad_left(str(round(rate_pct * 100)), 4, "0")
    doc_production_date = _parse_dt(
        transaction.get("documentProductionDate"),
        transaction.get("createdAt"),
    )
    tt = str(min(3, max(1, int(item.get("transactionType") or 2))))
    product = item.get("product") or {}
    net_unit = gross_shekels_to_net(float(item.get("unitPrice") or 0), rate_pct)
    net_line = gross_shekels_to_net(float(item.get("totalPrice") or 0), rate_pct)
    net_disc = (
        gross_shekels_to_net(abs(float(line_discount)), rate_pct) if line_discount else 0.0
    )
    link = pad_left(re.sub(r"\D", "", link_id7)[-7:] or "0", 7, "0")
    f1274 = pad_right(base_branch_id, 7) if base_branch_id else pad_right("", 7)

    record = "D110"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_left(str(doc_type_val), 3, "0")
    record += pad_right(transaction.get("transactionNumber") or "", DOCUMENT_NUMBER_WIDTH)
    record += pad_left(str(line_number), 4, "0")
    record += base_dt + base_num + tt
    record += pad_right(product.get("sku") or "", 20)
    record += pad_right(product.get("name") or "", 30)
    record += pad_right("", 50) + pad_right("", 30) + pad_right("", 20)
    record += format_quantity_signed(float(item.get("quantity") or 0))
    record += format_amount(net_unit)
    record += format_amount(-abs(net_disc) if line_discount else 0)
    record += format_amount(net_line)
    record += vat_four
    branch_id = transaction.get("branchId")
    record += pad_right(str(branch_id), 7) if branch_id else pad_right("", 7)
    record += format_date(doc_production_date)
    record += link + f1274 + pad_right("", 21)
    return record[:339]


#: D120 field 1306 (אמצעי תשלום) for the tenders this system files by name.
#: 3 = כרטיס אשראי; 6 = תלוש החלפה — the `exchange` leg that settles the sale half of a
#: mixed basket against its credit half (docs/SHIFTS_API.md §1.2a). Anything else is 1.
PAYMENT_TYPE_CODES = {"card": 3, "exchange": 6}


def payment_type_code(method: Optional[str]) -> int:
    return PAYMENT_TYPE_CODES.get((method or "").strip().lower(), 1)


def build_d120_record(
    transaction: Dict[str, Any],
    line_number: int,
    vat_number: str,
    record_number: int,
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
    payment_method: Optional[str] = None,
    payment_amount_override: Optional[float] = None,
) -> str:
    """
    One payment record (D120) — one *tender leg* of the document.

    `payment_method` / `payment_amount_override` are how a split-tender document
    describes each of its legs. Both default to the document-level values, so a
    single-tender document produces exactly the record it produced before split
    tender existed, to the byte.

    The payment-type code (field 1306) is `payment_type_code`: card → 3, `exchange` →
    6, everything else → 1. The מבנה אחיד field has further codes (cheque, bank
    transfer, vouchers) and this system stores whatever tender string the till sends,
    but mapping new strings onto tax codes is a filing decision, not a refactor, and a
    wrong code is not something the merchant finds out about from us. Unrecognised
    tenders keep landing on 1 exactly as they did before.
    """
    cart = transaction.get("cart") or {}
    payment_amount = (
        float(payment_amount_override)
        if payment_amount_override is not None
        else float(cart.get("totalAmount") or 0)
    )
    method = payment_method if payment_method is not None else transaction.get("paymentMethod")
    payment_type = payment_type_code(method)
    doc_type_val = doc_type if doc_type is not None else transaction.get("documentType")
    doc_production_date = _parse_dt(
        transaction.get("documentProductionDate"),
        transaction.get("createdAt"),
    )
    vat = normalize_israeli_9_digit(vat_number)
    doc_date_str = format_date(doc_production_date)
    link = pad_left(re.sub(r"\D", "", link_id7)[-7:] or "0", 7, "0")

    record = "D120"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_left(str(doc_type_val), 3, "0")
    record += pad_right(transaction.get("transactionNumber") or "", DOCUMENT_NUMBER_WIDTH)
    record += pad_left(str(line_number), 4, "0")
    record += str(payment_type)
    record += pad_left("0", 10, "0")
    record += pad_left("0", 10, "0")
    record += pad_left("0", 15, "0")
    record += pad_left("0", 10, "0")
    record += pad_left("0", 8, "0")
    record += format_amount(payment_amount)
    record += "0"
    record += pad_right("", 20)
    record += "0"
    branch_id = transaction.get("branchId")
    record += pad_right(str(branch_id), 7) if branch_id else pad_right("", 7)
    record += doc_date_str + link + pad_right("", 60)
    return record[:222]


def resolve_payment_legs(
    transaction: Dict[str, Any]
) -> List[Tuple[Optional[str], Optional[float]]]:
    """
    The (method, amount) pairs to write as D120 records for one document.

    A `None` in either slot means "use the document-level value", which is how a
    single-tender document keeps producing byte-identical output.

    **The amounts are apportioned to the document total, and that is on purpose.**
    `cart.totalAmount` is now the money actually settled — C100 field 1223 — so the
    scaling is the identity whenever the tender legs already sum to it, which is the
    normal case. It is kept because it is what guarantees the invariant an inspector
    checks: the D120 records for a document must sum to that document's 1223, exactly.
    Apportioning with the rounding remainder pushed onto the last leg makes that hold
    unconditionally, including when a split-tender document's legs drift by an agora
    from the total after a discount was apportioned across them.

    This used to scale to the *gross* of the line totals, because 1223 was that gross.
    Both were wrong together, so they agreed with each other while overstating what the
    customer paid on every discounted document. 1223 is now the settled figure and the
    legs follow it.
    """
    legs = transaction.get("payments") or []
    if len(legs) <= 1:
        return [(None, None)]

    cart = transaction.get("cart") or {}
    target = float(cart.get("totalAmount") or 0)
    raw = [float(leg.get("amount") or 0) for leg in legs]
    raw_total = sum(raw)
    if raw_total <= 0:
        return [(None, None)]

    out: List[Tuple[Optional[str], Optional[float]]] = []
    running = 0.0
    for index, leg in enumerate(legs):
        if index == len(legs) - 1:
            amount = round(target - running, 2)
        else:
            amount = round(target * (raw[index] / raw_total), 2)
            running += amount
        out.append((leg.get("method"), amount))
    return out


def build_z900_record(
    vat_number: str,
    unique_id: str,
    total_records: int,
    record_number: int,
) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    record = "Z900"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_left(unique_id, 15, "0")
    record += "&OF1.31&"
    record += pad_left(str(total_records), 15, "0")
    record += pad_right("", 50)
    return record


def build_summary_record(record_type: str, count: int) -> str:
    return record_type + pad_left(str(count), 15, "0")


@dataclass
class TaxReportResult:
    ini_content: List[str]
    bkmv_content: List[str]
    record_counts: RecordCounts
    unique_id: str


def generate_tax_report(
    transactions: List[Dict[str, Any]],
    business_info: BusinessInfoDict,
    date_range: Union[Dict[str, Any], Dict[str, int]],
    output_path: str = "",
    global_tax_rate: Optional[float] = None,
    software_info: Optional[SoftwareInfo] = None,
    tax_report_config: Optional[TaxReportConfig] = None,
    process_date: Optional[datetime] = None,
) -> TaxReportResult:
    sw = software_info or DEFAULT_SOFTWARE_INFO
    cfg = tax_report_config or DEFAULT_TAX_REPORT_CONFIG
    proc = process_date or datetime.now(timezone.utc)
    unique_id = generate_unique_file_id()
    record_counts: RecordCounts = {
        "A100": 0,
        "B110": 0,
        "C100": 0,
        "D110": 0,
        "D120": 0,
        "M100": 0,
        "Z900": 0,
    }
    bkmv_lines: List[str] = []
    record_number = 1

    total_sales = sum(
        abs(float((t.get("cart") or {}).get("totalAmount") or 0))
        for t in transactions
        if t.get("status") != "cancelled"
    )

    bkmv_lines.append(build_a100_record(business_info["vatNumber"], unique_id, record_number))
    record_counts["A100"] = 1
    record_number += 1

    bkmv_lines.append(
        build_b110_record(
            business_info["vatNumber"],
            record_number,
            business_info,
            period_sales_total=total_sales,
        )
    )
    record_counts["B110"] = 1
    record_number += 1

    tx_by_id = {str(t["id"]): t for t in transactions}
    document_link_seq = 0

    for transaction in transactions:
        document_link_seq += 1
        link_id7 = format_open_format_link_id(document_link_seq)
        refund_id = transaction.get("refundOfTransactionId")
        # A credit note is type 330 **or** linked to an original. Reading only the link
        # filed a return with no original receipt (picked from the catalogue) as a 320 —
        # a sale — so the period overstated turnover by twice the refund.
        stored_type = transaction.get("documentType")
        is_refund = bool(refund_id) or stored_type in (330, RECEIPT_REFUND_DOCUMENT_TYPE)
        # An exempt dealer's receipt (400) and receipt refund (-400) are filed as 400 —
        # the refund with negative amounts — with no item lines (docs/SPEC_BUSINESS_TYPE.md).
        doc_type, amount_sign = open_format_document_type(stored_type, is_refund)
        receipt = stored_type in RECEIPT_TYPES
        # The document's base document: the original when it is in this export, else
        # what the caller resolved for it (`baseDocument`, which reaches outside the
        # export window). Each line may name its own (`base` on the item).
        original_tx = tx_by_id.get(str(refund_id)) if refund_id else None
        document_base = (
            {
                "documentType": original_tx.get("documentType"),
                "transactionNumber": original_tx.get("transactionNumber"),
                "branchId": original_tx.get("branchId"),
            }
            if original_tx
            else transaction.get("baseDocument")
        ) if is_refund else None

        bkmv_lines.append(
            build_c100_record(
                transaction,
                business_info["vatNumber"],
                record_number,
                link_id7,
                doc_type=doc_type,
                global_tax_rate=global_tax_rate,
                amount_sign=amount_sign,
            )
        )
        record_counts["C100"] += 1
        record_number += 1

        line_number = 1
        # A receipt carries no item lines: its header and its payments only.
        for item in [] if receipt else (transaction.get("cart") or {}).get("items") or []:
            base = (item.get("base") or document_base) if is_refund else None
            bkmv_lines.append(
                build_d110_record(
                    transaction,
                    item,
                    line_number,
                    business_info["vatNumber"],
                    record_number,
                    global_tax_rate,
                    link_id7,
                    doc_type=doc_type,
                    base_doc_type=pad_left(str(base.get("documentType") or 320), 3, "0")
                    if base
                    else None,
                    base_doc_number=base.get("transactionNumber") if base else None,
                    base_branch_id=pad_right(str(base.get("branchId")), 7)[:7]
                    if base and base.get("branchId")
                    else None,
                )
            )
            record_counts["D110"] += 1
            record_number += 1
            line_number += 1

        # One payment record per tender leg. A single-tender document still produces
        # exactly one, with the document-level method and amount, as before.
        for payment_line, (leg_method, leg_amount) in enumerate(
            resolve_payment_legs(transaction), start=1
        ):
            if amount_sign < 0:
                # A receipt refund: the money went back, so each payment is negative.
                whole = float((transaction.get("cart") or {}).get("totalAmount") or 0)
                leg_amount = -abs(leg_amount if leg_amount is not None else whole)
            bkmv_lines.append(
                build_d120_record(
                    transaction,
                    payment_line,
                    business_info["vatNumber"],
                    record_number,
                    link_id7,
                    doc_type=doc_type,
                    payment_method=leg_method,
                    payment_amount_override=leg_amount,
                )
            )
            record_counts["D120"] += 1
            record_number += 1

    # Only the items of documents written with item lines (a receipt has none).
    for product in collect_unique_products_for_m100(
        [t for t in transactions if not is_receipt_document(t)]
    ):
        bkmv_lines.append(build_m100_record(business_info["vatNumber"], record_number, product))
        record_counts["M100"] += 1
        record_number += 1

    total_records = record_number
    bkmv_lines.append(
        build_z900_record(business_info["vatNumber"], unique_id, total_records, record_number)
    )
    record_counts["Z900"] = 1

    ini_lines: List[str] = []
    ini_lines.append(
        build_a000_record(
            business_info,
            sw,
            cfg,
            total_records,
            unique_id,
            date_range,
            output_path,
            proc,
        )
    )
    for record_type, count in record_counts.items():
        if count > 0:
            ini_lines.append(build_summary_record(record_type, count))

    return TaxReportResult(
        ini_content=ini_lines,
        bkmv_content=bkmv_lines,
        record_counts=record_counts,
        unique_id=unique_id,
    )


def encode_open_format_lines(lines: List[str]) -> bytes:
    text = "\r\n".join(lines) + "\r\n"
    return text.encode("iso-8859-8", errors="replace")


def build_open_format_zip(ini_lines: List[str], bkmv_lines: List[str]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("INI.TXT", encode_open_format_lines(ini_lines))
        bkmv_bytes = encode_open_format_lines(bkmv_lines)
        zf.writestr("BKMVDATA.TXT", bkmv_bytes)
    return buf.getvalue()
