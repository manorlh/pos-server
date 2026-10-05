"""
The menu sheet ("טמפלט קליטת פריטים") as data: its sheets and columns, the words a cell
may hold, and reading a filled-in file - XLSX or CSV - back into raw rows.

No database here. The rows are matched against a company's catalog in
app/services/catalog_import.py and the workbook is drawn in app/services/catalog_template.py,
both from the column lists below, so the three can never disagree about a header.

Reading is lenient about the things people do to a spreadsheet: columns in another order
or under a near name ("קטגוריה" for "מחלקה", 'מק"ט' for "מק״ט"), a header that is not on
row 1, a CSV saved by Hebrew Excel (Windows-1255, ";" separated), a price typed as
"₪1,234.50". Each such reading of a cell is reported back as a warning, never silently.
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ── Sheets ────────────────────────────────────────────────────────────────────

SHEET_INSTRUCTIONS = "הוראות"
SHEET_CATEGORIES = "מחלקות"
SHEET_PRODUCTS = "פריטים"
SHEET_PRINTERS = "מדפסות"
#: Hidden: the sources of the dropdowns that are not a sheet of their own.
SHEET_LISTS = "רשימות"

# ── Words ─────────────────────────────────────────────────────────────────────

YES = "כן"
NO = "לא"
#: In the "סימון" column: a row the import skips.
EXAMPLE_MARK = "דוגמה"
SKIP_MARK = "דלג"
#: In a "מדפסות" cell: print nothing ("no ticket"), or drop the row's own setting.
PRINTERS_NONE = "ללא"
PRINTERS_INHERIT = "ירושה"
#: In "מחלקת אב": move an existing category to the top level.
PARENT_NONE = "ללא"
#: Separates a parent from its child where a category name alone is ambiguous.
PATH_SEPARATOR = " > "

UNIT_PIECE = "יח׳"
UNIT_KG = "ק״ג"
UNIT_CHOICES = (UNIT_PIECE, UNIT_KG, "ליטר")

#: Item-ticket ("שובר פריט") modes as the sheet writes them; "" is the category's.
TICKET_INHERIT = "inherit"
TICKET_LABELS: Dict[str, str] = {
    TICKET_INHERIT: "לפי המחלקה",
    "off": "ללא שובר",
    "per_unit": "לכל יחידה",
    "per_line": "לכל פריט",
    "per_sale": "אחד לעסקה",
}

#: Limits of the columns they land in (app/models/product.py, category.py).
NAME_MAX = 255
DESCRIPTION_MAX = 1000
CODE_MAX = 100
UNIT_MAX = 16
PRICE_MAX = Decimal("99999999.99")
#: As the insights' own cost endpoint allows (app/services/insights/service.py).
COST_MAX = Decimal("100000")
ENTRIES_MAX = 50

#: Bounds on what one upload may make us read.
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_DATA_ROWS = 5000
MAX_COLUMNS = 60
#: A sheet formatted to its last row reports a million rows; physical rows past this are
#: not read (and the preview says so). Empty rows in between cost nothing.
MAX_SHEET_ROWS = 20000
HEADER_SEARCH_ROWS = 10

CENT = Decimal("0.01")


# ── Columns ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Column:
    key: str
    #: As written in the template; a required column ends with "*".
    header: str
    width: float
    #: text | code | money | bool | int | printers | ticket | unit | marker
    kind: str
    help: str
    example: str = ""
    #: Other headers read as this column (normalized like `normalize_header`).
    aliases: Tuple[str, ...] = ()

    @property
    def required(self) -> bool:
        return self.header.endswith("*")

    @property
    def title(self) -> str:
        """The header without its "*"."""
        return self.header.rstrip("*").strip()


MARKER = Column(
    "marker", "סימון", 9, "marker",
    "שורות שמסומנות 'דוגמה' (או 'דלג') לא ייקלטו. בשורות שלכם השאירו ריק.",
    EXAMPLE_MARK, ("דוגמה", "דוגמא", "marker"),
)

PRODUCT_COLUMNS: Tuple[Column, ...] = (
    MARKER,
    Column("name", "שם פריט*", 30, "text",
           "השם שיופיע בקופה ובקבלה (עד 255 תווים).", "המבורגר קלאסי",
           ("שם פריט", "שם", "שם מוצר", "מוצר", "פריט", "name", "product", "item")),
    Column("category", "מחלקה*", 22, "text",
           "שם המחלקה מגיליון 'מחלקות'. מחלקה שלא קיימת תיווצר אוטומטית.", "המבורגרים",
           ("מחלקה", "קטגוריה", "מחלקה ראשית", "category", "department")),
    Column("price", "מחיר*", 11, "money",
           "מחיר מכירה בשקלים כולל מע״מ: 58 או 12.50 (אפשר גם ₪12.50).", "58",
           ("מחיר", "מחיר מכירה", "מחיר לצרכן", "price")),
    Column("barcode", "ברקוד", 17, "code",
           "הברקוד שעל המוצר. משמש גם לזיהוי פריט קיים.", "7290001234567",
           ("ברקוד", "barcode", "ean", "upc")),
    Column("sku", "מק״ט", 13, "code",
           "קוד פנימי. ריק בפריט חדש = יוקצה אוטומטית. משמש לזיהוי פריט קיים.", "1001",
           ("מקט", "קוד פריט", "קוד", "sku", "code")),
    Column("cost", "עלות (ללא מע״מ)", 13, "money",
           "כמה עולה לכם יחידה, לפני מע״מ - לניתוח רווחיות. לא מוצג בקופה.", "18.50",
           ("עלות", "עלות ללא מעמ", "מחיר עלות", "מחיר קנייה", "cost")),
    Column("open_price", "מחיר פתוח", 11, "bool",
           "כן = הקופאי מקליד את הסכום בכל מכירה; המחיר בעמודה 'מחיר' הוא הצעה בלבד.", NO,
           ("מחיר פתוח", "open price")),
    Column("weighed", "נמכר במשקל", 12, "bool",
           "כן = הכמות נשקלת (למשל 0.75) והמחיר הוא ליחידה שבעמודה 'יחידה'.", NO,
           ("נמכר במשקל", "שקיל", "במשקל", "משקל", "weighed")),
    Column("unit", "יחידה", 9, "unit",
           "יח׳ או ק״ג (או ליטר). למוצר שנמכר במשקל - בדרך כלל ק״ג.", UNIT_PIECE,
           ("יחידה", "יחידת מידה", "יחידת מכירה", "unit")),
    Column("no_discount", "ללא הנחה", 10, "bool",
           "כן = הקופה לא תיתן על הפריט שום הנחה, ומבצעים לא יחולו עליו.", NO,
           ("ללא הנחה", "לא מקבל הנחות", "בלי הנחה", "no discount")),
    Column("printers", "מדפסות", 22, "printers",
           "לאן יודפס הפריט במטבח/בבר: שמות מגיליון 'מדפסות' מופרדים בפסיק. ריק = לפי "
           "המחלקה. 'ללא' = לא להדפיס. 'ירושה' = לבטל הגדרה קודמת ולחזור למחלקה.", "בר",
           ("מדפסות", "מדפסת", "מדפסות בונים", "תחנה", "תחנות", "printers", "printer")),
    Column("ticket", "שובר פריט", 15, "ticket",
           "שובר להחלפה בפריט (למשל בדוכן): ריק = לפי המחלקה, 'ללא שובר', 'לכל יחידה', "
           "'לכל פריט' או 'אחד לעסקה'.", "",
           ("שובר פריט", "שובר", "הדפסת שובר פריט", "ticket")),
    Column("entries", "כרטיס כניסה", 12, "int",
           "לכרטיס כניסה: כמה כניסות יחידה אחת מקנה (1-50). ריק = פריט רגיל; 0 = לבטל.", "",
           ("כרטיס כניסה", "כניסות", "מספר כניסות", "entries")),
    Column("active", "פעיל", 8, "bool",
           "לא = הפריט מוצג בקופה אבל חסום למכירה. ריק בפריט חדש = כן.", YES,
           ("פעיל", "זמין", "active")),
    Column("description", "תיאור", 40, "text",
           "טקסט חופשי (לא חובה).", "200 גרם, חסה, עגבנייה",
           ("תיאור", "הערות", "description")),
)

CATEGORY_COLUMNS: Tuple[Column, ...] = (
    MARKER,
    Column("name", "שם מחלקה*", 26, "text",
           "שם המחלקה כפי שיופיע בקופה.", "מנות עיקריות",
           ("שם מחלקה", "מחלקה", "שם", "קטגוריה", "name", "category")),
    Column("parent", "מחלקת אב", 22, "text",
           "למחלקת משנה - שם המחלקה שמעליה. ריק = מחלקה ראשית (במחלקה קיימת: ללא שינוי; "
           "'ללא' = להעביר לראשית).", "",
           ("מחלקת אב", "אב", "מחלקה ראשית", "parent")),
    Column("printers", "מדפסות", 24, "printers",
           "לאן יודפסו כל פריטי המחלקה ומחלקות המשנה שלה: שמות מגיליון 'מדפסות' מופרדים "
           "בפסיק. 'ללא' = לא להדפיס; 'ירושה' = לפי מחלקת האב.", "מטבח",
           ("מדפסות", "מדפסת", "מדפסות בונים", "תחנה", "תחנות", "printers", "printer")),
    Column("sort", "סדר", 8, "int",
           "סדר ההצגה בקופה (מספר קטן קודם).", "1",
           ("סדר", "מיון", "סדר הצגה", "sort", "order")),
    Column("active", "פעיל", 8, "bool",
           "לא = המחלקה מוסתרת בקופה. ריק במחלקה חדשה = כן.", YES,
           ("פעיל", "זמין", "active")),
)

PRINTER_REFERENCE_HEADERS = ("שם מדפסת", "סניף", "חיבור", "נקודת מכירה / קופה", "פעילה")


def column(columns: Sequence[Column], key: str) -> Column:
    return next(c for c in columns if c.key == key)


# ── Normalizing ───────────────────────────────────────────────────────────────

_BIDI_MARKS = re.compile("[‎‏‪-‮⁦-⁩﻿]")
_SPACES = re.compile(r"\s+")
#: Hebrew points and cantillation.
_NIQQUD = re.compile("[֑-ׇ]")
_QUOTES = "\"'`׳״‘’“”"
_QUOTES_RE = re.compile("[" + re.escape(_QUOTES) + "]")


def clean_text(value: Any) -> str:
    """A cell as one line of text: no bidi marks, single spaces, trimmed."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return YES if value else NO
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, datetime):
        value = value.strftime("%d/%m/%Y %H:%M") if (value.hour or value.minute) else value.strftime("%d/%m/%Y")
    elif isinstance(value, date):
        value = value.strftime("%d/%m/%Y")
    text = _BIDI_MARKS.sub("", str(value)).replace(" ", " ")
    return _SPACES.sub(" ", text).strip()


def normalize_name(text: Any) -> str:
    """How two names are compared: case, spacing and the kind of quote mark do not count."""
    out = unicodedata.normalize("NFKC", clean_text(text))
    out = out.replace("״", '"').replace("“", '"').replace("”", '"')
    out = out.replace("׳", "'").replace("‘", "'").replace("’", "'").replace("`", "'")
    return out.casefold()


def normalize_header(text: Any) -> str:
    """A header as it is matched: no "*", no quote marks, no "(₪)", single spaces."""
    out = unicodedata.normalize("NFKC", clean_text(text))
    out = _NIQQUD.sub("", out)
    out = out.replace("*", " ").replace("₪", " ").replace("(", " ").replace(")", " ")
    out = _QUOTES_RE.sub("", out)
    return _SPACES.sub(" ", out).strip().casefold()


def _header_keys(columns: Sequence[Column]) -> Dict[str, str]:
    keys: Dict[str, str] = {}
    for col in columns:
        for name in (col.header, col.title) + col.aliases:
            keys.setdefault(normalize_header(name), col.key)
    return keys


# ── Cells ─────────────────────────────────────────────────────────────────────


@dataclass
class Parsed:
    """One cell read: its value (None = empty), and what reading it had to say."""

    value: Any = None
    warning: Optional[str] = None
    error: Optional[str] = None


_YES_WORDS = {"כן", "v", "✓", "✔", "true", "yes", "y", "1", "פעיל", "on"}
_NO_WORDS = {"לא", "false", "no", "n", "0", "-", "לא פעיל", "off"}


def parse_bool(value: Any, title: str) -> Parsed:
    if value is None:
        return Parsed()
    if isinstance(value, bool):
        return Parsed(value)
    if isinstance(value, (int, float)) and value in (0, 1):
        return Parsed(bool(value))
    text = normalize_name(value)
    if not text:
        return Parsed()
    if text in _YES_WORDS:
        return Parsed(True)
    if text in _NO_WORDS:
        return Parsed(False)
    return Parsed(error=f"בעמודה '{title}' צריך לכתוב כן או לא (נכתב '{clean_text(value)}')")


_CURRENCY = re.compile(r"(₪|ש\"ח|ש״ח|שח|nis|ils)", re.IGNORECASE)
_THOUSANDS = re.compile(r"^\d{1,3}(,\d{3})+(\.\d+)?$")
_DECIMAL_COMMA = re.compile(r"^\d+,\d{1,2}$")
_PLAIN_NUMBER = re.compile(r"^\d+(\.\d+)?$")


def parse_money(value: Any, title: str, maximum: Decimal = PRICE_MAX) -> Parsed:
    """
    A sum of shekels. A number cell is taken as it is; text may carry "₪", thousands
    commas ("1,234.50") or a decimal comma ("12,50") - read, and reported as read.
    """
    if value is None or (isinstance(value, str) and not clean_text(value)):
        return Parsed()
    note = None
    if isinstance(value, bool):
        return Parsed(error=f"{title} לא תקין ('{clean_text(value)}')")
    if isinstance(value, (int, float, Decimal)):
        try:
            amount = Decimal(str(value))
        except InvalidOperation:
            return Parsed(error=f"{title} לא תקין ('{value}')")
    else:
        raw = clean_text(value)
        text = _CURRENCY.sub("", raw).replace(" ", "")
        negative = text.startswith("-") or (text.startswith("(") and text.endswith(")"))
        text = text.strip("-()")
        if _THOUSANDS.match(text):
            text = text.replace(",", "")
        elif _DECIMAL_COMMA.match(text):
            text = text.replace(",", ".")
        if not _PLAIN_NUMBER.match(text):
            return Parsed(error=f"{title} לא תקין ('{raw}')")
        amount = Decimal(text)
        if negative:
            amount = -amount
        if text != raw.replace(" ", ""):
            note = f"{title} '{raw}' נקרא כ-{_money_text(amount)}"
    if amount.is_nan() or amount.is_infinite():
        return Parsed(error=f"{title} לא תקין ('{clean_text(value)}')")
    if amount < 0:
        return Parsed(error=f"{title} לא יכול להיות שלילי ({_money_text(amount)})")
    rounded = amount.quantize(CENT, rounding=ROUND_HALF_UP)
    if rounded != amount:
        note = f"{title} {amount} עוגל ל-{_money_text(rounded)}"
    if rounded > maximum:
        return Parsed(error=f"{title} גבוה מדי ({_money_text(rounded)})")
    return Parsed(rounded, warning=note)


def _money_text(amount: Decimal) -> str:
    return f"{amount:.2f}"


_SCIENTIFIC = re.compile(r"^\d+(\.\d+)?e\+?\d+$", re.IGNORECASE)


def parse_code(value: Any, title: str, *, strip_spaces: bool = False) -> Parsed:
    """A barcode or SKU: text, never a number Excel has rounded or shortened."""
    if value is None:
        return Parsed()
    if isinstance(value, bool):
        return Parsed(error=f"{title} לא תקין ('{clean_text(value)}')")
    if isinstance(value, float):
        if not value.is_integer():
            return Parsed(error=f"{title} לא תקין ('{value}')")
        if abs(value) >= 1e15:
            # Past 15 digits Excel has already dropped the end of the number.
            return Parsed(error=f"{title} ארוך מדי לשדה מספרי - עצבו את העמודה כטקסט והקלידו שוב")
        value = int(value)
    text = clean_text(value)
    if not text:
        return Parsed()
    if _SCIENTIFIC.match(text):
        return Parsed(error=f"{title} בפורמט מדעי ({text}) - עצבו את העמודה כטקסט והקלידו שוב")
    if len(text) > CODE_MAX:
        return Parsed(error=f"{title} ארוך מדי (מעל {CODE_MAX} תווים)")
    if strip_spaces:
        text = text.replace(" ", "")
    return Parsed(text)


def parse_int(value: Any, title: str, low: int, high: int, *, allow_clear: bool = False) -> Parsed:
    """A whole number in [low, high]; with `allow_clear`, "ללא" / 0 is an explicit clear ("")."""
    if value is None:
        return Parsed()
    if isinstance(value, bool):
        return Parsed(error=f"{title}: צריך מספר שלם")
    text = clean_text(value)
    if not text:
        return Parsed()
    if allow_clear and normalize_name(text) in (normalize_name(PRINTERS_NONE), "0"):
        return Parsed("")
    try:
        number = Decimal(text.replace(",", ""))
    except InvalidOperation:
        return Parsed(error=f"{title}: צריך מספר שלם (נכתב '{text}')")
    if number != number.to_integral_value():
        return Parsed(error=f"{title}: צריך מספר שלם (נכתב '{text}')")
    number = int(number)
    if number < low or number > high:
        return Parsed(error=f"{title}: מספר בין {low} ל-{high} (נכתב {number})")
    return Parsed(number)


def parse_ticket(value: Any, title: str) -> Parsed:
    """An item-ticket mode, or `TICKET_INHERIT`; empty is "no change"."""
    text = normalize_name(value)
    if not text:
        return Parsed()
    for mode, label in TICKET_LABELS.items():
        if text in (normalize_name(label), mode, normalize_name("שובר " + label)):
            return Parsed(mode)
    words = {
        "ללא": "off", "לא": "off", "off": "off", "inherit": TICKET_INHERIT,
        "ירושה": TICKET_INHERIT, "לפי הקטגוריה": TICKET_INHERIT,
        "שובר לכל יחידה": "per_unit", "שובר לכל פריט": "per_line",
        "שובר אחד לעסקה": "per_sale", "לכל שורה": "per_line", "לכל מכירה": "per_sale",
    }
    if text in words:
        return Parsed(words[text])
    choices = ", ".join(TICKET_LABELS.values())
    return Parsed(error=f"{title} לא מוכר ('{clean_text(value)}') - אפשר: {choices}")


@dataclass(frozen=True)
class RoutingSpec:
    """A "מדפסות" cell: keep as is, no ticket, back to inherited, or these printer names."""

    mode: str  # "none" | "inherit" | "names"
    names: Tuple[str, ...] = ()

    def text(self) -> str:
        if self.mode == "none":
            return PRINTERS_NONE
        if self.mode == "inherit":
            return PRINTERS_INHERIT
        return ", ".join(self.names)


_LIST_SPLIT = re.compile(r"[,;\n،|]+")


def parse_printers(value: Any) -> Parsed:
    text = clean_text(value) if not isinstance(value, str) else value.strip()
    if not text:
        return Parsed()
    parts = [clean_text(p) for p in _LIST_SPLIT.split(text)]
    names: List[str] = []
    seen = set()
    for part in parts:
        key = normalize_name(part)
        if key and key not in seen:
            seen.add(key)
            names.append(part)
    if not names:
        return Parsed()
    keys = [normalize_name(n) for n in names]
    special = {normalize_name(PRINTERS_NONE): "none", normalize_name(PRINTERS_INHERIT): "inherit"}
    modes = [special[k] for k in keys if k in special]
    if modes:
        if len(names) > 1:
            return Parsed(error=f"'{PRINTERS_NONE}' או '{PRINTERS_INHERIT}' נכתבים לבד, בלי שמות מדפסות")
        return Parsed(RoutingSpec(modes[0]))
    return Parsed(RoutingSpec("names", tuple(names)))


def parse_text(value: Any, title: str, maximum: int) -> Parsed:
    text = clean_text(value)
    if not text:
        return Parsed()
    if len(text) > maximum:
        return Parsed(error=f"{title} ארוך מדי (מעל {maximum} תווים)")
    return Parsed(text)


def is_marked(value: Any) -> bool:
    """Is this "סימון" a row the import skips?"""
    text = normalize_name(value)
    return bool(text) and (text.startswith(normalize_name(EXAMPLE_MARK)) or text.startswith("דוגמא")
                           or text == normalize_name(SKIP_MARK))


_WEIGHT_UNITS = {normalize_name(u) for u in ("ק״ג", "קג", "קילו", "קילוגרם", "גרם", "100 גרם",
                                               "ליטר", "ל׳", "מ״ל", "kg", "g", "l", "lb")}


def is_weight_unit(unit: Optional[str]) -> bool:
    return bool(unit) and normalize_name(unit) in _WEIGHT_UNITS


# ── Reading a file ────────────────────────────────────────────────────────────


class SheetError(Exception):
    """The file as a whole cannot be read; the message is the user's (Hebrew)."""


@dataclass
class RawRow:
    #: The row number the user sees: Excel's row, or the CSV line.
    number: int
    cells: Dict[str, Any]


@dataclass
class RawSheet:
    title: str
    #: column key → its header as written in the file.
    headers: Dict[str, str]
    rows: List[RawRow]
    unknown_headers: List[str] = field(default_factory=list)


@dataclass
class RawFile:
    kind: str  # "xlsx" | "csv"
    products: Optional[RawSheet]
    categories: Optional[RawSheet]
    notes: List[str] = field(default_factory=list)


def read_file(data: bytes, filename: str = "") -> RawFile:
    """XLSX by its zip signature, anything else as CSV text. Raises `SheetError`."""
    if not data:
        raise SheetError("הקובץ ריק")
    if len(data) > MAX_FILE_BYTES:
        raise SheetError("הקובץ גדול מדי (עד 5MB)")
    name = (filename or "").lower()
    if data[:4] == b"PK\x03\x04":
        return _read_xlsx(data)
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" or name.endswith(".xls"):
        raise SheetError("זה קובץ Excel ישן (xls). פתחו אותו ושמרו בשם כ-'חוברת עבודה של Excel (xlsx)'")
    return _read_csv(data)


def _find_header(rows: List[Sequence[Any]], columns: Sequence[Column]) -> Optional[Tuple[int, Dict[int, str], List[str]]]:
    """(row index, {column index: key}, unknown headers) of the first row that names the sheet's columns."""
    keys = _header_keys(columns)
    name_key = "name"
    for index, row in enumerate(rows[:HEADER_SEARCH_ROWS]):
        mapping: Dict[int, str] = {}
        unknown: List[str] = []
        for position, cell in enumerate(list(row)[:MAX_COLUMNS]):
            header = normalize_header(cell)
            if not header:
                continue
            key = keys.get(header)
            if key and key not in mapping.values():
                mapping[position] = key
            else:
                unknown.append(clean_text(cell))
        if name_key in mapping.values() and len(mapping) >= 2:
            return index, mapping, unknown
    return None


def _sheet_from_rows(title: str, rows: List[Sequence[Any]], columns: Sequence[Column], first_number: int = 1) -> Optional[RawSheet]:
    found = _find_header(rows, columns)
    if found is None:
        return None
    header_index, mapping, unknown = found
    header_row = list(rows[header_index])
    out: List[RawRow] = []
    for offset, row in enumerate(rows[header_index + 1:], start=header_index + 1):
        values = list(row)
        cells = {key: (values[pos] if pos < len(values) else None) for pos, key in mapping.items()}
        if all(clean_text(v) == "" for v in cells.values()):
            continue
        out.append(RawRow(number=offset + first_number, cells=cells))
        if len(out) > MAX_DATA_ROWS:
            raise SheetError(f"בגיליון '{title}' יותר מ-{MAX_DATA_ROWS} שורות - פצלו לכמה קבצים")
    return RawSheet(
        title=title,
        headers={key: clean_text(header_row[pos]) for pos, key in mapping.items()},
        rows=out,
        unknown_headers=[u for u in unknown if u],
    )


def _xlsx_rows(ws, notes: List[str]) -> List[Tuple[Any, ...]]:
    """The sheet's rows (an empty one as `()`, so numbering holds), at most MAX_SHEET_ROWS."""
    rows: List[Tuple[Any, ...]] = []
    filled = 0
    for row in ws.iter_rows(values_only=True, max_col=MAX_COLUMNS, max_row=MAX_SHEET_ROWS):
        if row is None or all(v is None or (isinstance(v, str) and not v.strip()) for v in row):
            rows.append(())
            continue
        rows.append(tuple(row))
        filled += 1
        if filled > MAX_DATA_ROWS + HEADER_SEARCH_ROWS:
            raise SheetError(f"בגיליון '{ws.title}' יותר מ-{MAX_DATA_ROWS} שורות - פצלו לכמה קבצים")
    while rows and rows[-1] == ():
        rows.pop()
    if (ws.max_row or 0) > MAX_SHEET_ROWS:
        notes.append(f"בגיליון '{ws.title}' נקראו רק {MAX_SHEET_ROWS:,} השורות הראשונות")
    return rows


def _read_xlsx(data: bytes) -> RawFile:
    import openpyxl

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            # A zip bomb is refused before openpyxl inflates it.
            if sum(info.file_size for info in archive.infolist()) > 100 * 1024 * 1024:
                raise SheetError("הקובץ גדול מדי")
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except SheetError:
        raise
    except Exception:  # noqa: BLE001 - a broken upload is the user's file, not our bug
        raise SheetError("לא הצלחנו לפתוח את הקובץ - ודאו שזה קובץ Excel (xlsx) תקין")
    try:
        sheets = {normalize_header(ws.title): ws for ws in workbook.worksheets}
        products_ws = sheets.get(normalize_header(SHEET_PRODUCTS))
        categories_ws = sheets.get(normalize_header(SHEET_CATEGORIES))
        notes: List[str] = []

        products = (
            _sheet_from_rows(SHEET_PRODUCTS, _xlsx_rows(products_ws, notes), PRODUCT_COLUMNS) if products_ws else None
        )
        categories = (
            _sheet_from_rows(SHEET_CATEGORIES, _xlsx_rows(categories_ws, notes), CATEGORY_COLUMNS)
            if categories_ws
            else None
        )
        if products is None:
            # No "פריטים" sheet (or no header in it): any sheet whose header is a product's.
            skip = {normalize_header(n) for n in (SHEET_CATEGORIES, SHEET_INSTRUCTIONS, SHEET_PRINTERS, SHEET_LISTS)}
            for title, ws in sheets.items():
                if title in skip or ws is products_ws:
                    continue
                candidate = _sheet_from_rows(ws.title, _xlsx_rows(ws, notes), PRODUCT_COLUMNS)
                if candidate is not None and "price" in candidate.headers:
                    products = candidate
                    break
        if products is None and categories is None:
            raise SheetError(
                f"לא נמצא גיליון '{SHEET_PRODUCTS}' עם שורת כותרות (שם פריט, מחלקה, מחיר) - "
                "השתמשו בטמפלט שהורדתם"
            )
        return RawFile(kind="xlsx", products=products, categories=categories, notes=notes)
    finally:
        workbook.close()


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1255"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise SheetError("לא הצלחנו לקרוא את הקובץ - שמרו אותו כ-CSV UTF-8 או כ-xlsx")


def _read_csv(data: bytes) -> RawFile:
    text = _decode(data)
    if "\x00" in text:
        raise SheetError("הקובץ אינו קובץ CSV או Excel")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows: List[List[str]] = []
    for row in reader:
        rows.append(row[:MAX_COLUMNS])
        if len(rows) > MAX_DATA_ROWS + HEADER_SEARCH_ROWS:
            raise SheetError(f"בקובץ יותר מ-{MAX_DATA_ROWS} שורות - פצלו לכמה קבצים")
    # CSV cells are text; an empty one is None, as an empty Excel cell is.
    cleaned = [[cell if cell.strip() else None for cell in row] for row in rows]
    products = _sheet_from_rows(SHEET_PRODUCTS, cleaned, PRODUCT_COLUMNS)
    if products is not None and "price" in products.headers:
        return RawFile(kind="csv", products=products, categories=None)
    categories = _sheet_from_rows(SHEET_CATEGORIES, cleaned, CATEGORY_COLUMNS)
    if categories is not None and "price" not in categories.headers:
        return RawFile(kind="csv", products=None, categories=categories)
    raise SheetError("לא נמצאה שורת כותרות (שם פריט, מחלקה, מחיר) - השתמשו בכותרות של הטמפלט")
