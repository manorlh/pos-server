"""Israeli Tax Authority OPEN FORMAT (ממשק פתוח) generator — port of pos-desktop taxReportGenerator.ts.

The rules this file follows come from the Tax Authority's "הוראות להפקת קבצים במבנה אחיד",
version 1.31 (01/05/2009), cited below as "1.31 §…" (section) or "הבהרה N" (its appendix of
clarifications). The ones that are easy to get wrong:

* **Character set** (1.31 §2.4ח, A000 field 1029 = 1): ISO-8859-8-i, logical Hebrew. A
  character the set does not have is written as its ASCII equivalent (`charset_text`):
  geresh ׳ → ', gershayim ״ → ", maqaf ־ and the dashes → -, niqqud dropped — never `?`.
* **Times** are the business's local time (Asia/Jerusalem), as printed on the document —
  never UTC (`tz` on every builder; `_local`).
* **Signs** (1.31 §2.4יב, הבהרה 1): every C100/D110 amount is positive except the fields
  that reduce the document or the line (the discounts, 1220 and 1266), which are negative.
  A credit note (330) is positive too: its type, not its sign, says it reduces income.
* **Line totals** (D110 field 1267): "הכמות בשורה * מחיר ליח' ללא מע"מ בניכוי הנחת השורה" —
  after the line's own discount, for a sale and a credit note alike. The lines of a
  document add up exactly to its header (`document_amounts`, `allocate_cents`).
* **Branches** (A000 field 1034, הבהרה 3): 1 when the business has branches; every branch
  field (1231, 1270, 1274, 1320, B110 1421) is then filled. D110 1274 ("מספר הסניף/ענף של
  מ. בסיס", "חובה כאשר ערך שדה 1034 = 1") is the base document's branch, and on a line with
  no base document its own document's branch.
* **Payment records** (D120, "פרטי קבלה / הפקדה", 1.31 §4.5) only under a document that
  records a receipt (`PAYMENT_RECORD_DOCUMENT_TYPES`: 320, 400…) — never under a 330.
"""

from __future__ import annotations

import codecs
import random
import re
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone, tzinfo
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple, TypedDict, Union
from zoneinfo import ZoneInfo

from app.services.open_format.defaults import DEFAULT_SOFTWARE_INFO, DEFAULT_TAX_REPORT_CONFIG, SoftwareInfo, TaxReportConfig
from app.services.open_format.israeli_tax_id import customer_vat_field, normalize_israeli_9_digit


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
#: till's "קידומת מסמכים" is written into it the way the till prints it, with no dash: the
#: prefix and the number padded to 7 digits (`20000057`, docs/SPEC_DOCUMENT_PREFIX.md) —
#: at most 3 + 7 = 10 characters. Unique together with the document type (field 1203):
#: each type is numbered on its own series.
DOCUMENT_NUMBER_WIDTH = 20

#: The business's time zone: every date and time in the file is local, as printed.
DEFAULT_TIMEZONE = ZoneInfo("Asia/Jerusalem")


# ── Character set (1.31 §2.4ח: ISO-8859-8-i, A000 field 1029 = "1") ───────────────────

#: The encoding the files are written in. Kept in one place: the A000 charset flag says 1.
CHARSET_ENCODING = "iso-8859-8"

#: Characters ISO-8859-8 does not have, and what each is written as instead. Hebrew
#: punctuation first — the reason this exists: a product called צ׳יפס used to reach the
#: file as צ?יפס.
CHAR_EQUIVALENTS: Dict[str, str] = {
    "׳": "'",   # ׳ geresh
    "״": '"',   # ״ gershayim
    "־": "-",   # ־ maqaf
    "׀": "|",   # ׀ paseq
    "׃": ":",   # ׃ sof pasuq
    "׆": "",    # ׆ nun hafukha
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
    "−": "-", "﹘": "-", "﹣": "-", "－": "-",
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "ʼ": "'",
    "ʻ": "'", "＇": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "＂": '"',
    "…": "...",
    "•": "*", "‧": ".",
    "₪": "NIS", "€": "EUR", "™": "TM", "№": "No.",
    # Zero-width and bidi controls: no width on paper, so none in a fixed-width field.
    "​": "", "‌": "", "‍": "", "⁠": "", "﻿": "",
    "‪": "", "‫": "", "‬": "", "‭": "", "‮": "",
    "⁦": "", "⁧": "", "⁨": "", "⁩": "",
}


def _encodable(text: str) -> bool:
    try:
        text.encode(CHARSET_ENCODING)
        return True
    except UnicodeEncodeError:
        return False


def _equivalent(ch: str) -> str:
    """One character the charset lacks, as text it has (possibly empty). Never '?'."""
    if ch in CHAR_EQUIVALENTS:
        return CHAR_EQUIVALENTS[ch]
    # Accents, ligatures, presentation forms: é → e, ﬁ → fi, שׁ → ש. Combining marks
    # (niqqud included) are dropped.
    decomposed = unicodedata.normalize("NFKD", ch)
    kept = "".join(c for c in decomposed if not unicodedata.combining(c))
    if kept and kept != ch:
        return charset_text(kept)
    category = unicodedata.category(ch)
    if category.startswith("Z"):
        return " "
    if category == "Pd":
        return "-"
    if category in ("Pi", "Pf"):
        return '"'
    # Combining marks, controls, emoji and other symbols with no sensible equivalent.
    return ""


def charset_text(value: Any) -> str:
    """`value` as text the file's character set can hold (see `CHAR_EQUIVALENTS`)."""
    text = "" if value is None else str(value)
    if _encodable(text):
        return text
    out = []
    for ch in text:
        out.append(ch if _encodable(ch) else _equivalent(ch))
    return "".join(out)


def _fixed_width_fallback(error: UnicodeEncodeError):
    """
    Last line of defence in `encode_open_format_lines`: every field is already passed
    through `charset_text`, so this only runs on a character a constant smuggled in. One
    character in, one out, so the record keeps its fixed width.
    """
    bad = error.object[error.start:error.end]
    return "".join((charset_text(c)[:1] or " ") for c in bad), error.end


codecs.register_error("open_format_fixed_width", _fixed_width_fallback)


def pad_right(value: str, length: int, pad_char: str = " ") -> str:
    s = charset_text(value)
    return s.ljust(length, pad_char)[:length]


def pad_left(value: str, length: int, pad_char: str = "0") -> str:
    s = charset_text(value)
    return s.rjust(length, pad_char)[:length]


def format_amount(value: float, _length: int = 15) -> str:
    n = float(value) if value else 0.0
    sign = "-" if n < 0 else "+"
    agorot = round(abs(n) * 100)
    return sign + pad_left(str(agorot), 14, "0")


def format_cents(cents: int, length: int = 15) -> str:
    """A signed amount already in agorot: sign, then `length - 1` digits."""
    sign = "-" if cents < 0 else "+"
    return sign + pad_left(str(abs(int(cents))), length - 1, "0")


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


def _fit_digits(value: Any, width: int, what: str) -> str:
    """A numeric identifier, zero-padded — never cut: a longer one is a configuration error."""
    digits = "".join(c for c in str(value or "") if c.isdigit())
    if len(digits) > width:
        raise ValueError(f"{what}: '{digits}' is longer than {width} digits")
    return digits.rjust(width, "0")


# ── Time (local, as printed) ──────────────────────────────────────────────────────────


def _zone(tz: Optional[tzinfo]) -> tzinfo:
    return tz or DEFAULT_TIMEZONE


def _local(moment: Union[datetime, date], tz: Optional[tzinfo] = None) -> Union[datetime, date]:
    """A stored moment in the business's time zone. A naive datetime is UTC (how it is stored)."""
    if not isinstance(moment, datetime):
        return moment
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_zone(tz))


def _parse_dt(value: Any, fallback: Any) -> datetime:
    if value is None:
        if isinstance(fallback, datetime):
            return fallback
        return datetime.fromisoformat(str(fallback).replace("Z", "+00:00"))
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _document_moment(transaction: Dict[str, Any], tz: Optional[tzinfo]) -> datetime:
    """When the document was produced, in local time (fields 1205/1206, 1230, 1272, 1322)."""
    return _local(_parse_dt(transaction.get("documentProductionDate"), transaction.get("createdAt")), tz)


def build_a000_record(
    business_info: BusinessInfoDict,
    software_info: SoftwareInfo,
    tax_report_config: TaxReportConfig,
    total_records: int,
    unique_id: str,
    date_range: Union[Dict[str, Any], Dict[str, int]],
    output_path: str,
    process_date: datetime,
    *,
    tz: Optional[tzinfo] = None,
) -> str:
    year_key = "year" in date_range
    proc = _local(process_date, tz)
    record = "A000"
    record += pad_right("", 5)
    record += pad_left(str(total_records), 15, "0")
    record += pad_left(normalize_israeli_9_digit(business_info.get("vatNumber", "")), 9, "0")
    record += pad_left(unique_id, 15, "0")
    record += pad_right(tax_report_config.system_code, 8)
    # 1006: "מספר תעודת הרישום של התוכנה במערכת המס", 9(8).
    record += _fit_digits(software_info.registration_number, 8, "A000 1006 software registration number")
    record += pad_right(software_info.name, 20)
    record += pad_right(software_info.version, 20)
    # 1009: "מספר ע"מ של יצרן התוכנה", 9(9).
    record += pad_left(normalize_israeli_9_digit(software_info.manufacturer_id), 9, "0")
    record += pad_right(software_info.manufacturer_name, 20)
    record += "1" if software_info.software_type == "single-year" else "2"
    record += pad_right(output_path, 50)
    record += tax_report_config.accounting_type
    record += "1" if tax_report_config.balancing_required else "0"
    # 1015: "מספר חברה ברשם החברות" — only when the business has one (a company); zeros
    # otherwise, never a made-up number.
    reg = business_info.get("companyRegNumber") or ""
    record += normalize_israeli_9_digit(reg) if any(c.isdigit() and c != "0" for c in reg) else "0" * 9
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
        record += format_date(min(date(yr, 12, 31), proc.date()))
    else:
        start = _local(date_range["start"], tz)
        end = _local(date_range["end"], tz)
        start_day = start.date() if isinstance(start, datetime) else start
        end_day = end.date() if isinstance(end, datetime) else end
        record += str(start_day.year)
        record += format_date(start_day)
        record += format_date(min(end_day, proc.date()))

    record += format_date(proc)
    record += format_time(proc)
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


#: B110 field 1403 (מפתח החשבון, unique) of the cash account ("קופה") the documents go to.
CASH_ACCOUNT_KEY = "000000000001500"


def cash_account_key(branch_id: Optional[str]) -> str:
    """The cash account's key: one account per branch when the business has branches."""
    if not branch_id:
        return CASH_ACCOUNT_KEY
    return ("1500" + str(branch_id).strip().zfill(7)).zfill(15)[-15:]


def build_b110_record(
    vat_number: str,
    record_number: int,
    business_info: BusinessInfoDict,
    *,
    period_sales_total: float = 0.0,
    period_credit_total: float = 0.0,
    branch_id: Optional[str] = None,
) -> str:
    """
    The cash account ("קופה") the documents settle into.

    1415 (סה"כ חובה) — the money the period's sale documents took in; 1416 (סה"כ זכות) —
    the money its credit notes paid back. A credit note reduces the account: it is never
    added to the debit side. With branches (A000 1034 = 1) there is one account per
    branch, its code in 1421 ("חובה כאשר ערכו של שדה 1034 הוא 1").
    """
    vat = normalize_israeli_9_digit(vat_number)
    name = business_info.get("companyName") or "Account"
    if branch_id:
        name = f"{name} - סניף {branch_id}"
    record = "B110"
    record += pad_left(str(record_number), 9, "0")
    record += pad_left(vat, 9, "0")
    record += pad_right(cash_account_key(branch_id), 15)
    record += pad_right(name, 50)
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
    record += format_amount(abs(period_sales_total))
    record += format_amount(abs(period_credit_total))
    record += pad_left("0001", 4, "0")
    record += pad_left("0", 9, "0")
    record += pad_right(str(branch_id or ""), 7)
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


#: Stored document types an exempt dealer (עוסק פטור) issues — a receipt and a receipt
#: refund (docs/SPEC_BUSINESS_TYPE.md; `tenders.RECEIPT_DOCUMENT_TYPES`). Both are filed
#: as 400 (קבלה): there is no מבנה אחיד code for a receipt in the other direction, so the
#: refund is a 400 with negative amounts. A receipt has no item lines (D110) — only its
#: header (C100) and its payments (D120).
RECEIPT_DOCUMENT_TYPE = 400
RECEIPT_REFUND_DOCUMENT_TYPE = -400
RECEIPT_TYPES = (RECEIPT_DOCUMENT_TYPE, RECEIPT_REFUND_DOCUMENT_TYPE)


#: The filed document types (C100 1203) that carry payment records — D120 is "פרטי קבלה /
#: הפקדה" (1.31 §4.5): the details of money received or deposited, under a document that
#: records it. 320 חשבונית מס / קבלה and 400 קבלה (an exempt dealer's receipt refund, the
#: internal -400, is filed as a 400 too), 405 קבלה על תרומות, 420 הפקדת בנק. Never under a
#: 330 חשבונית מס זיכוי — the Tax Authority's simulator rejects that ("לא נמצאה רשומת
#: כותרת מסמך") — nor under any other type.
PAYMENT_RECORD_DOCUMENT_TYPES = (320, 400, 405, 420)


def carries_payment_records(filed_type: Optional[int]) -> bool:
    try:
        return int(filed_type) in PAYMENT_RECORD_DOCUMENT_TYPES
    except (TypeError, ValueError):
        return False


def is_receipt_document(transaction: Dict[str, Any]) -> bool:
    """An exempt dealer's receipt or receipt refund: filed as 400, without D110 lines."""
    return transaction.get("documentType") in RECEIPT_TYPES


def open_format_document_type(stored: Optional[int], is_refund: bool) -> Tuple[int, int]:
    """
    (C100 field 1203, the sign of the document's amounts) for a stored document.

    320 / 330 as before — a credit note is a 330 by type **or** by its link to an
    original, and its amounts stay positive: "חשבונית זיכוי בערך חיובי תגרום להקטנת הכנסה"
    (1.31 §2.4יב, הבהרה 1) — the type, not the sign, makes it a reduction. An exempt
    dealer's 400 is a 400, and its receipt refund (-400) a 400 whose amounts are negative.
    The one place the internal -400 is translated: if the accountant rules another code
    for the refund, it changes here.
    """
    if stored == RECEIPT_REFUND_DOCUMENT_TYPE:
        return RECEIPT_DOCUMENT_TYPE, -1
    if stored == RECEIPT_DOCUMENT_TYPE:
        return RECEIPT_DOCUMENT_TYPE, 1
    return (330 if is_refund else 320), 1


# ── The document's money (C100 1219–1223 and each D110 1265–1267) ─────────────────────

_ONE = Decimal("1")


def _cents(value: Any) -> int:
    """Shekels (float, str or Decimal) as whole agorot, half up."""
    if value is None or value == "":
        return 0
    return int((Decimal(str(value)) * 100).quantize(_ONE, rounding=ROUND_HALF_UP))


def _net_cents(gross_cents: int, rate_percent: float) -> int:
    """The VAT-exclusive part of `gross_cents`, in agorot, half up."""
    if not rate_percent or rate_percent <= 0:
        return int(gross_cents)
    rate = Decimal(str(rate_percent)) / 100
    return int((Decimal(int(gross_cents)) / (1 + rate)).quantize(_ONE, rounding=ROUND_HALF_UP))


def document_rate_percent(transaction: Dict[str, Any], global_tax_rate: Optional[float]) -> float:
    """
    The VAT rate of this document, in percent: the rate it was issued at (`vatRate`, a
    fraction as the till stores it — 0.18), else the configured global rate, else 18.
    """
    raw = transaction.get("vatRate")
    try:
        rate = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        rate = None
    if rate is not None and rate >= 0:
        return rate * 100 if rate <= 1 else rate
    return float(global_tax_rate) if global_tax_rate is not None else 18.0


def _line_discount_cents(item: Dict[str, Any]) -> int:
    """
    The line's own discount, gross: the cashier's (`discount`), the promotions' share and
    the discount vouchers' share (a discount on the document, never a tender).
    """
    own = item.get("discount")
    if own in (None, 0, 0.0, ""):
        own = item.get("lineDiscount")
    return (
        abs(_cents(own))
        + abs(_cents(item.get("promotionDiscount")))
        + abs(_cents(item.get("voucherDiscount")))
    )


def allocate_cents(target: int, weights: List[int]) -> List[int]:
    """
    `target` agorot split over `weights` in proportion, exactly: every share is its exact
    proportion rounded down, and the agorot left over go one each to the largest
    remainders (ties: the earlier line). The shares always sum to `target`, and each is
    within one agora of its exact proportion.
    """
    n = len(weights)
    if n == 0:
        return []
    total = sum(weights)
    if total == 0:
        out = [0] * n
        out[-1] = int(target)
        return out
    exact = [Fraction(int(target)) * Fraction(int(w), int(total)) for w in weights]
    floors = [e.numerator // e.denominator for e in exact]
    left = int(target) - sum(floors)
    order = sorted(range(n), key=lambda i: (-(exact[i] - floors[i]), i))
    for i in order[: max(left, 0)]:
        floors[i] += 1
    return floors


@dataclass
class LineAmounts:
    #: 1265 מחיר ליחידה ללא מע"מ, in agorot.
    unit: int
    #: 1266 הנחת שורה, in agorot (negative or zero).
    discount: int
    #: 1267 סך סכום לשורה, in agorot: quantity × unit − the line's discount, ex VAT.
    total: int


@dataclass
class DocumentAmounts:
    """The C100 money fields and the D110 money of every line, in agorot (signed)."""

    before_discount: int  # 1219 = Σ 1267
    discount: int  # 1220 (≤ 0): the document-level discount only
    net: int  # 1221 = 1219 + 1220
    vat: int  # 1222
    total: int  # 1223 = 1221 + 1222
    lines: List[LineAmounts] = field(default_factory=list)


def is_credit_document(transaction: Dict[str, Any], doc_type: Optional[int] = None) -> bool:
    stored = transaction.get("documentType")
    return bool(transaction.get("refundOfTransactionId")) or stored in (330, RECEIPT_REFUND_DOCUMENT_TYPE) or doc_type == 330


def document_amounts(
    transaction: Dict[str, Any],
    global_tax_rate: Optional[float],
    *,
    amount_sign: int = 1,
    credit: Optional[bool] = None,
) -> DocumentAmounts:
    """
    The document's money as the file states it. The rule, in agorot:

    * 1221 (net after discounts), 1222 (VAT) — what the document was settled at, from the
      cart block; 1223 = 1221 + 1222.
    * 1220 — the **document-level** discount only (the basket discount; a line's own
      discount belongs to its line): −round(basket discount ÷ (1 + VAT rate)). A credit
      note's lines are already net of their share of the original's discounts, so its
      1220 is 0.
    * 1219 = 1221 − 1220 — before the document discount.
    * Each line: 1265 = round(unit price ÷ (1 + rate)); 1266 = −round(line discount ÷
      (1 + rate)); 1267 = the line's value after its own discount, ex VAT, allocated so
      that **Σ 1267 = 1219 exactly** (`allocate_cents`, in proportion to each line's
      value after its own discount). Hence Σ 1267 + 1220 = 1221 exactly, and each 1267 is
      within a rounding agora or two of 1264 × 1265 + 1266.

    `amount_sign` is −1 only for an exempt dealer's receipt refund (a 400 with negative
    amounts), which has no lines.
    """
    cart = transaction.get("cart") or {}
    is_credit = is_credit_document(transaction) if credit is None else credit
    rate = document_rate_percent(transaction, global_tax_rate)
    net = _cents(cart.get("subtotal"))
    vat = _cents(cart.get("taxAmount"))
    items = cart.get("items") or []
    receipt = is_receipt_document(transaction)

    if is_credit:
        basket_gross = 0
    elif cart.get("basketDiscount") is not None:
        basket_gross = abs(_cents(cart.get("basketDiscount")))
    else:
        # A caller that names only the document's total discount: what its lines' own
        # discounts do not account for is the basket's.
        total_discount = abs(_cents(transaction.get("documentDiscount")))
        basket_gross = total_discount if receipt else max(
            total_discount - sum(_line_discount_cents(i) for i in items), 0
        )
    basket_net = _net_cents(basket_gross, rate) if basket_gross else 0
    s = -1 if amount_sign < 0 else 1
    amounts = DocumentAmounts(
        before_discount=s * (net + basket_net),
        discount=s * -basket_net,
        net=s * net,
        vat=s * vat,
        total=s * (net + vat),
    )
    if receipt or not items:
        return amounts

    afters: List[int] = []
    for item in items:
        line = _cents(item.get("totalPrice"))
        own = _line_discount_cents(item)
        # A sale line's totalPrice is gross before its discount; a credit-note line's is
        # already what was credited (RefundMath), its discount the share it carries.
        afters.append(line if is_credit else line - own)
    totals = allocate_cents(amounts.before_discount, afters)
    for item, line_total in zip(items, totals):
        own = _line_discount_cents(item)
        amounts.lines.append(
            LineAmounts(
                unit=_net_cents(_cents(item.get("unitPrice")), rate),
                discount=-_net_cents(own, rate) if own else 0,
                total=line_total,
            )
        )
    return amounts


def build_c100_record(
    transaction: Dict[str, Any],
    vat_number: str,
    record_number: int,
    link_id7: str,
    *,
    doc_type: Optional[int] = None,
    global_tax_rate: Optional[float] = None,
    amount_sign: int = 1,
    tz: Optional[tzinfo] = None,
    amounts: Optional[DocumentAmounts] = None,
) -> str:
    vat = normalize_israeli_9_digit(vat_number)
    doc_type_val = doc_type if doc_type is not None else transaction.get("documentType")
    money = amounts or document_amounts(
        transaction, global_tax_rate, amount_sign=amount_sign,
        credit=is_credit_document(transaction, doc_type),
    )
    doc_production_date = _document_moment(transaction, tz)
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
    # As the document carries it — never a recomputed check digit (customer_vat_field).
    f1215 = customer_vat_field(customer.get("vatNumber"))
    f1216 = doc_date_str
    f1217 = format_amount(0)
    f1218 = pad_right("ILS", 3)
    # 1219 סכום המסמך לפני הנחת מסמך · 1220 הנחת מסמך (negative, הבהרה 7) · 1221 סכום
    # המסמך לאחר הנחות ללא מע"מ · 1222 סכום המע"מ · 1223 סכום המסמך כולל מע"מ.
    # 1219 + 1220 = 1221 and 1221 + 1222 = 1223 hold exactly (`document_amounts`).
    f1219 = format_cents(money.before_discount)
    f1220 = format_cents(money.discount)
    f1221 = format_cents(money.net)
    f1222 = format_cents(money.vat)
    f1223 = format_cents(money.total)
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
    # 1233 מבצע הפעולה: "שם המשתמש של מבצע הפעולה" — the operator's user name.
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
    tz: Optional[tzinfo] = None,
    line_amounts: Optional[LineAmounts] = None,
) -> str:
    """
    One document line. 1267 = "הכמות בשורה * מחיר ליח' ללא מע"מ בניכוי הנחת השורה" —
    after the line's own discount, for a sale and a credit note alike. Built alone (no
    `line_amounts`), the line is rounded on its own; `generate_tax_report` passes the
    document's allocation so the lines add up to the header exactly.
    """
    vat = normalize_israeli_9_digit(vat_number)
    doc_type_val = doc_type if doc_type is not None else transaction.get("documentType")
    base_dt = pad_left(re.sub(r"\D", "", str(base_doc_type or ""))[:3], 3, "0")
    base_num = pad_right(base_doc_number or "", DOCUMENT_NUMBER_WIDTH)
    rate_pct = document_rate_percent(transaction, global_tax_rate)
    vat_four = pad_left(str(round(rate_pct * 100)), 4, "0")
    doc_production_date = _document_moment(transaction, tz)
    tt = str(min(3, max(1, int(item.get("transactionType") or 2))))
    product = item.get("product") or {}
    if line_amounts is None:
        own = _line_discount_cents(item)
        line = _cents(item.get("totalPrice"))
        after = line if is_credit_document(transaction, doc_type) else line - own
        line_amounts = LineAmounts(
            unit=_net_cents(_cents(item.get("unitPrice")), rate_pct),
            discount=-_net_cents(own, rate_pct) if own else 0,
            total=_net_cents(after, rate_pct),
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
    record += format_cents(line_amounts.unit)
    record += format_cents(line_amounts.discount)
    record += format_cents(line_amounts.total)
    record += vat_four
    branch_id = transaction.get("branchId")
    record += pad_right(str(branch_id), 7) if branch_id else pad_right("", 7)
    record += format_date(doc_production_date)
    record += link + f1274 + pad_right("", 21)
    return record[:339]


#: D120 field 1306 (סוג אמצעי התשלום, מבנה אחיד 1.31 §4.5: 1 מזומן, 2 המחאה, 3 כרטיס
#: אשראי, 4 העברה בנקאית, 5 תווי קנייה, 6 תלוש החלפה, 7 שטר, 8 הוראת קבע, 9 אחר) for the
#: tenders this system files by name:
#:
#: * 3 = כרטיס אשראי — `card`.
#: * 5 = תווי קנייה — a prepaid / production voucher ("שובר הפקה") paying for the goods on it:
#:   `voucher`, the leg every till and kiosk order writes for a redemption since the tender
#:   first shipped (pos-android `PaymentMethod.VOUCHER`, `CheckoutViewModel.applyVoucher`;
#:   a kiosk order's voucher reaches the till's document the same way), `vouchers` (the
#:   alias the Z already counts as a voucher, `z_print._VOUCHER`), and `production_voucher`
#:   (the contract's tender code for the `payment` accounting mode). No till or kiosk writes
#:   `voucher` for anything else: a return is a credit note (330) whose legs mirror the
#:   original's, and a mixed basket's offset is `exchange`.
#: * 6 = תלוש החלפה — the `exchange` leg that settles the sale half of a mixed basket
#:   against its credit half (docs/SHIFTS_API.md §1.2a).
#:
#: Anything else is 1 (unchanged: mapping a new tender string is a filing decision).
PAYMENT_TYPE_CODES = {"card": 3, "voucher": 5, "vouchers": 5, "production_voucher": 5, "exchange": 6}

#: D120 field 1313 (קוד החברה הסולקת): "1-ישראכרט, 2-כאל, 3-דיינרס, 4-אמריקן אקספרס,
#: 6-לאומי כארד" — by the acquirer the till read off the terminal (`card_brands.ACQUIRERS`).
#: MAX is the former Leumi Card, code 6. Unknown / other → 0.
ACQUIRER_CODES = {"isracard": 1, "cal": 2, "diners": 3, "amex": 4, "max": 6}

#: D120 field 1315 (סוג עסקת האשראי): 1 רגיל, 2 תשלומים, 3 קרדיט, 4 חיוב נדחה, 5 אחר.
CREDIT_REGULAR = 1
CREDIT_INSTALMENTS = 2


def payment_type_code(method: Optional[str]) -> int:
    return PAYMENT_TYPE_CODES.get((method or "").strip().lower(), 1)


def card_fields(card: Optional[Dict[str, Any]]) -> Tuple[int, str, int]:
    """
    (1313 clearing company, 1314 card name, 1315 credit type) of one card leg, from what
    the terminal answered and the till stored. 0 / blank where it is not known: the
    acquirer was not recognised, the brand unknown, or the instalment count not recorded
    (credit, deferred and "other" deal types are not recorded at all).
    """
    if not card:
        return 0, "", 0
    acquirer = ACQUIRER_CODES.get(str(card.get("cardAcquirer") or "").strip().lower(), 0)
    brand = str(card.get("cardBrand") or "").strip().lower()
    name = ""
    if brand and brand != "other":
        from app.services.card_brands import BRAND_LABELS

        name = BRAND_LABELS.get(brand, "")
    terms = 0
    raw = card.get("creditPayments")
    try:
        count = int(raw) if raw is not None and not isinstance(raw, bool) else None
    except (TypeError, ValueError):
        count = None
    if count is not None and count >= 1:
        terms = CREDIT_INSTALMENTS if count > 1 else CREDIT_REGULAR
    return acquirer, name, terms


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
    tz: Optional[tzinfo] = None,
    card: Optional[Dict[str, Any]] = None,
) -> str:
    """
    One payment record (D120) — one *tender leg* of the document.

    `payment_method` / `payment_amount_override` are how a split-tender document
    describes each of its legs. Both default to the document-level values, so a
    single-tender document produces exactly the record it produced before split
    tender existed, to the byte.

    The payment-type code (field 1306) is `payment_type_code`: card → 3, a prepaid /
    production voucher (`voucher`, `vouchers`, `production_voucher`) → 5 (תווי קנייה),
    `exchange` → 6, everything else → 1. The מבנה אחיד field has further codes (cheque,
    bank transfer) and this system stores whatever tender string the till sends, but
    mapping new strings onto tax codes is a filing decision, not a refactor, and a
    wrong code is not something the merchant finds out about from us. Unrecognised
    tenders keep landing on 1 exactly as they did before.

    `card` (the leg's `cardAcquirer`, `cardBrand`, `creditPayments`) fills 1313–1315 on
    a card leg (`card_fields`).
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
    doc_production_date = _document_moment(transaction, tz)
    vat = normalize_israeli_9_digit(vat_number)
    doc_date_str = format_date(doc_production_date)
    link = pad_left(re.sub(r"\D", "", link_id7)[-7:] or "0", 7, "0")
    clearing, card_name, credit_type = card_fields(card) if payment_type == 3 else (0, "", 0)

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
    record += str(clearing)
    record += pad_right(card_name, 20)
    record += str(credit_type)
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
    original = transaction.get("payments") or []
    legs = _filed_legs(transaction)
    if len(legs) <= 1:
        if len(legs) == 1 and len(original) > 1:
            # A noted document left with one leg of its direction: that leg's tender, for
            # the whole document.
            return [(legs[0].get("method"), None)]
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


def payment_leg_cards(transaction: Dict[str, Any]) -> List[Optional[Dict[str, Any]]]:
    """The card data of each D120 record `resolve_payment_legs` produces, in the same order."""
    legs = _filed_legs(transaction)
    if len(resolve_payment_legs(transaction)) == 1:
        return [legs[0] if legs else None]
    return list(legs)


#: The ingest note of a document whose tender legs, as the till sent them, do not add up to
#: its total (`transactions.ingest_notes`, docs/SHIFTS_API.md §1.2). Such a document is
#: stored as sent — every document lands — and the export reads the note.
TENDERS_DO_NOT_RECONCILE = "tenders_do_not_reconcile"


def _leg_amount(leg: Dict[str, Any]) -> float:
    try:
        return float(leg.get("amount") or 0)
    except (TypeError, ValueError):
        return 0.0


def _filed_legs(transaction: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The tender legs the payment records are written from.

    A document's legs as stored — unless it carries `tenders_do_not_reconcile`: the till's
    legs then do not sum to the document, and apportioning them as they are could write a
    payment record of the opposite sign (a leg of −50 on a sale) or zero ones. Such a
    document's records are written from its legs that carry money in its own direction
    only (amount > 0), apportioned to field 1223 like any split (`resolve_payment_legs`); with
    none left, one record for the whole document. Either way Σ D120 = 1223, every record
    positive, and the document is listed with the export (`tax_reports.flagged_documents`).
    """
    legs = transaction.get("payments") or []
    if TENDERS_DO_NOT_RECONCILE not in (transaction.get("ingestNotes") or ()):
        return legs
    return [leg for leg in legs if _leg_amount(leg) > 0]


def payment_records_flagged(transaction: Dict[str, Any]) -> bool:
    """Whether the payment records of a noted document differ from its legs as stored."""
    legs = transaction.get("payments") or []
    resolved = resolve_payment_legs(transaction)
    if len(resolved) != len(legs):
        return True
    return any(
        amount is not None and abs(amount - _leg_amount(leg)) > 0.004
        for (_m, amount), leg in zip(resolved, legs)
    ) or (len(legs) == 1 and abs(float((transaction.get("cart") or {}).get("totalAmount") or 0) - _leg_amount(legs[0])) > 0.004)


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
    #: When the file was produced (A000 1026/1027), in the business's time zone.
    process_date: Optional[datetime] = None


def _branch_sort_key(code: str):
    return (0, int(code), code) if code.isdigit() else (1, 0, code)


def filed_document_key(transaction: Dict[str, Any]) -> Tuple[int, str]:
    """
    (C100 field 1203, field 1204) of a document as the file writes them: the filed type
    (`open_format_document_type`: a -400 is filed as a 400, a document linked to an
    original as a 330) and the number, as the X(20) field holds it.
    """
    stored_type = transaction.get("documentType")
    is_refund = bool(transaction.get("refundOfTransactionId")) or stored_type in (330, RECEIPT_REFUND_DOCUMENT_TYPE)
    doc_type, _sign = open_format_document_type(stored_type, is_refund)
    number = charset_text(str(transaction.get("transactionNumber") or "")).strip()[:DOCUMENT_NUMBER_WIDTH]
    return doc_type, number


def duplicate_document_numbers(transactions: List[Dict[str, Any]]) -> Dict[Tuple[int, str], List[Dict[str, Any]]]:
    """
    The (type, number) pairs more than one document of the file would carry, each with its
    documents in file order. The file is one per business — every branch — and the Tax
    Authority's simulator refuses two C100 records of one type with one number whatever
    their branch code (field 1231): "נמצאה יותר מרשומה אחת עם אותו מס אסמכתא" (on 1204).
    Empty for a sound file. `tax_reports.refuse_duplicate_document_numbers` refuses the
    export on any; the validator of the test data checks the same rule.
    """
    seen: Dict[Tuple[int, str], List[Dict[str, Any]]] = {}
    for transaction in transactions:
        seen.setdefault(filed_document_key(transaction), []).append(transaction)
    return {key: docs for key, docs in seen.items() if len(docs) > 1}


def generate_tax_report(
    transactions: List[Dict[str, Any]],
    business_info: BusinessInfoDict,
    date_range: Union[Dict[str, Any], Dict[str, int]],
    output_path: str = "",
    global_tax_rate: Optional[float] = None,
    software_info: Optional[SoftwareInfo] = None,
    tax_report_config: Optional[TaxReportConfig] = None,
    process_date: Optional[datetime] = None,
    tz: Optional[tzinfo] = None,
) -> TaxReportResult:
    sw = software_info or DEFAULT_SOFTWARE_INFO
    cfg = tax_report_config or DEFAULT_TAX_REPORT_CONFIG
    zone = _zone(tz)
    proc = _local(process_date or datetime.now(timezone.utc), zone)
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

    tx_by_id = {str(t["id"]): t for t in transactions}

    # First pass: what each document is filed as, and its money — the cash account's
    # totals (B110) come before the documents in the file.
    plans = []
    debit: Dict[str, int] = {}
    credit: Dict[str, int] = {}
    for transaction in transactions:
        refund_id = transaction.get("refundOfTransactionId")
        # A credit note is type 330 **or** linked to an original. Reading only the link
        # filed a return with no original receipt (picked from the catalogue) as a 320 —
        # a sale — so the period overstated turnover by twice the refund.
        stored_type = transaction.get("documentType")
        is_refund = bool(refund_id) or stored_type in (330, RECEIPT_REFUND_DOCUMENT_TYPE)
        # An exempt dealer's receipt (400) and receipt refund (-400) are filed as 400 —
        # the refund with negative amounts — with no item lines (docs/SPEC_BUSINESS_TYPE.md).
        doc_type, amount_sign = open_format_document_type(stored_type, is_refund)
        money = document_amounts(transaction, global_tax_rate, amount_sign=amount_sign, credit=is_refund)
        plans.append((transaction, refund_id, is_refund, doc_type, amount_sign, money))
        if transaction.get("status") == "cancelled":
            continue
        branch = str(transaction.get("branchId") or "").strip()
        side = credit if is_refund else debit
        side[branch] = side.get(branch, 0) + abs(money.total)

    bkmv_lines.append(build_a100_record(business_info["vatNumber"], unique_id, record_number))
    record_counts["A100"] = 1
    record_number += 1

    if business_info.get("hasBranches"):
        branches = sorted({b for b in list(debit) + list(credit) if b}, key=_branch_sort_key) or [""]
    else:
        branches = [""]
    for branch in branches:
        if business_info.get("hasBranches"):
            d = debit.get(branch, 0)
            c = credit.get(branch, 0)
        else:
            d = sum(debit.values())
            c = sum(credit.values())
        bkmv_lines.append(
            build_b110_record(
                business_info["vatNumber"],
                record_number,
                business_info,
                period_sales_total=d / 100.0,
                period_credit_total=c / 100.0,
                branch_id=branch or None,
            )
        )
        record_counts["B110"] += 1
        record_number += 1

    document_link_seq = 0
    for transaction, refund_id, is_refund, doc_type, amount_sign, money in plans:
        document_link_seq += 1
        link_id7 = format_open_format_link_id(document_link_seq)
        receipt = transaction.get("documentType") in RECEIPT_TYPES
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
                tz=zone,
                amounts=money,
            )
        )
        record_counts["C100"] += 1
        record_number += 1

        line_number = 1
        # A receipt carries no item lines: its header and its payments only.
        items = [] if receipt else (transaction.get("cart") or {}).get("items") or []
        own_branch = str(transaction.get("branchId") or "").strip()
        for index, item in enumerate(items):
            base = (item.get("base") or document_base) if is_refund else None
            base_branch = str((base or {}).get("branchId") or "").strip()
            if business_info.get("hasBranches") and not base_branch:
                # 1274 "חובה כאשר ערך שדה 1034 = 1": a line with no base document (or one
                # whose branch is unknown) names its own document's branch.
                base_branch = own_branch
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
                    base_branch_id=pad_right(base_branch, 7)[:7] if base_branch else None,
                    tz=zone,
                    line_amounts=money.lines[index] if index < len(money.lines) else None,
                )
            )
            record_counts["D110"] += 1
            record_number += 1
            line_number += 1

        # One payment record per tender leg. A single-tender document still produces
        # exactly one, with the document-level method and amount, as before. Only under a
        # document that records a receipt (`carries_payment_records`): a credit note (330)
        # has none — its money is the cash account's credit side (B110 1416).
        cards = payment_leg_cards(transaction)
        legs = resolve_payment_legs(transaction) if carries_payment_records(doc_type) else []
        for payment_line, (leg_method, leg_amount) in enumerate(legs, start=1):
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
                    tz=zone,
                    card=cards[payment_line - 1] if payment_line - 1 < len(cards) else None,
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
            tz=zone,
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
        process_date=proc,
    )


def encode_open_format_lines(lines: List[str]) -> bytes:
    """ISO-8859-8 (1.31 §2.4ח), CR LF after every record (§2.4ט(2)). Never a '?'."""
    text = "\r\n".join(lines) + "\r\n"
    return text.encode(CHARSET_ENCODING, errors="open_format_fixed_width")


def build_open_format_zip(ini_lines: List[str], bkmv_lines: List[str]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("INI.TXT", encode_open_format_lines(ini_lines))
        bkmv_bytes = encode_open_format_lines(bkmv_lines)
        zf.writestr("BKMVDATA.TXT", bkmv_bytes)
    return buf.getvalue()
