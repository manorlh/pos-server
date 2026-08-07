"""Israeli Tax Authority OPEN FORMAT (ממשק פתוח) generator — port of pos-desktop taxReportGenerator.ts."""

from __future__ import annotations

import random
import re
import time
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional, TypedDict, Union

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


def build_c100_record(
    transaction: Dict[str, Any],
    vat_number: str,
    record_number: int,
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
    global_tax_rate: Optional[float] = None,
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
    subtotal = float(cart.get("subtotal") or 0)
    tax_amount = float(cart.get("taxAmount") or 0)
    total_amount = float(cart.get("totalAmount") or 0)
    f1219 = format_amount(subtotal)
    f1220 = format_amount(-doc_disc_excl_vat if doc_disc_excl_vat > 0 else 0)
    f1221 = format_amount(subtotal - doc_disc_excl_vat)
    f1222 = format_amount(tax_amount)
    f1223 = format_amount(total_amount)
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
    record += pad_right(transaction.get("transactionNumber") or "", 20)
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
    base_num = pad_right(base_doc_number or "", 20)
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
    record += pad_right(transaction.get("transactionNumber") or "", 20)
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


def build_d120_record(
    transaction: Dict[str, Any],
    line_number: int,
    vat_number: str,
    record_number: int,
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
) -> str:
    cart = transaction.get("cart") or {}
    payment_amount = float(cart.get("totalAmount") or 0)
    payment_type = 3 if transaction.get("paymentMethod") == "card" else 1
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
    record += pad_right(transaction.get("transactionNumber") or "", 20)
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
        is_refund = bool(refund_id)
        original_tx = tx_by_id.get(str(refund_id)) if is_refund else None
        doc_type = 330 if is_refund else 320

        bkmv_lines.append(
            build_c100_record(
                transaction,
                business_info["vatNumber"],
                record_number,
                link_id7,
                doc_type=doc_type,
                global_tax_rate=global_tax_rate,
            )
        )
        record_counts["C100"] += 1
        record_number += 1

        line_number = 1
        for item in (transaction.get("cart") or {}).get("items") or []:
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
                    base_doc_type=pad_left(str(original_tx.get("documentType")), 3, "0")
                    if original_tx
                    else None,
                    base_doc_number=original_tx.get("transactionNumber") if original_tx else None,
                    base_branch_id=pad_right(str(original_tx.get("branchId")), 7)[:7]
                    if original_tx and original_tx.get("branchId")
                    else None,
                )
            )
            record_counts["D110"] += 1
            record_number += 1
            line_number += 1

        bkmv_lines.append(
            build_d120_record(
                transaction,
                1,
                business_info["vatNumber"],
                record_number,
                link_id7,
                doc_type=doc_type,
            )
        )
        record_counts["D120"] += 1
        record_number += 1

    for product in collect_unique_products_for_m100(transactions):
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
