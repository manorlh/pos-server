"""
Drawing the menu workbook ("טמפלט קליטת פריטים"): the blank template a dealer sends a
customer, and the same workbook filled with a company's current catalog for editing.

Only drawing. What goes in it - the company's categories, products, printers and routing
- is read from the database by app/services/catalog_import.py (`template_view`), and the
columns are app/services/catalog_sheet.py's, so a downloaded file always reads back.

Every sheet is right-to-left with a styled, frozen header; required headers end with "*";
each header carries a note that explains it; the dropdowns (כן/לא, יחידה, מחלקות, מדפסות,
שובר פריט) and number checks are Excel data validations; the grey rows marked "דוגמה"
are skipped by the import.
"""
from __future__ import annotations

import csv
import io
import math
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from app.services.catalog_sheet import (
    CATEGORY_COLUMNS,
    COST_MAX,
    DIETARY_LABELS_HE,
    DIETARY_NONE,
    ENTRIES_MAX,
    EXAMPLE_MARK,
    NO,
    PRINTER_REFERENCE_HEADERS,
    PRINTERS_INHERIT,
    PRINTERS_NONE,
    PRODUCT_COLUMNS,
    SHEET_CATEGORIES,
    SHEET_INSTRUCTIONS,
    SHEET_LISTS,
    SHEET_PRINTERS,
    SHEET_PRODUCTS,
    SKIP_MARK,
    TICKET_INHERIT,
    TICKET_LABELS,
    UNIT_CHOICES,
    UNIT_KG,
    UNIT_PIECE,
    YES,
    Column,
)

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# iOS system colours, as the dashboard's pages use them.
BLUE = "007AFF"
GREY = "8E8E93"
INK = "1C1C1E"
GROUPED = "F2F2F7"
HAIRLINE = "D1D1D6"
GREEN = "34C759"
ORANGE = "FF9500"

_HEADER_REQUIRED = PatternFill("solid", fgColor=BLUE)
_HEADER_OPTIONAL = PatternFill("solid", fgColor="5E5CE6")
_HEADER_MARKER = PatternFill("solid", fgColor="C7C7CC")
_EXAMPLE_FILL = PatternFill("solid", fgColor=GROUPED)
_EXAMPLE_FONT = Font(color=GREY, italic=True)
_HEADER_FONT = Font(color="FFFFFF", bold=True)
_HEADER_DARK_FONT = Font(color=INK, bold=True)
_THIN = Side(style="thin", color=HAIRLINE)
_BOX = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)
_WRAP_CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True, readingOrder=2)
_RIGHT = Alignment(horizontal="right", vertical="top", wrap_text=True, readingOrder=2)

_NUMBER_FORMATS = {"money": "#,##0.00", "code": "@", "int": "0"}

#: Empty rows below the data that still get the dropdowns and the text format.
SPARE_ROWS = 500
MIN_ROWS = 1000


@dataclass
class PrinterRef:
    name: str
    shop: str
    connection: str
    narrowed: str
    active: bool


@dataclass
class TemplateView:
    company_name: str
    generated_at: datetime
    #: The current catalog (True) or a blank template (False; examples, no products).
    with_data: bool
    #: Rows as {column key: value}; `notes` holds {column key: cell note}.
    categories: List[Dict[str, Any]] = field(default_factory=list)
    products: List[Dict[str, Any]] = field(default_factory=list)
    printers: List[PrinterRef] = field(default_factory=list)
    #: The printer names a "מדפסות" cell may hold, deduplicated.
    printer_choices: List[str] = field(default_factory=list)
    #: The routing of some rows differs between shops and was left blank.
    has_mixed_routing: bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────


def _rtl(ws) -> None:
    ws.sheet_view.rightToLeft = True


def _quoted(sheet: str) -> str:
    return "'" + sheet.replace("'", "''") + "'"


def _list_validation(formula: str, *, strict: bool, prompt: Optional[str] = None,
                     error: Optional[str] = None, free_text: bool = False) -> DataValidation:
    dv = DataValidation(type="list", formula1=formula, allow_blank=True)
    if free_text:
        # The dropdown helps; anything else (several printers, a new name) is still allowed.
        dv.showErrorMessage = False
    else:
        dv.showErrorMessage = True
        dv.errorStyle = "stop" if strict else "warning"
        dv.errorTitle = "ערך לא מהרשימה"
        dv.error = error or "בחרו ערך מהרשימה"
    if prompt:
        dv.showInputMessage = True
        dv.prompt = prompt[:250]
    return dv


def _number_validation(kind: str, low, high, error: str) -> DataValidation:
    dv = DataValidation(type=kind, operator="between", formula1=str(low), formula2=str(high), allow_blank=True)
    dv.showErrorMessage = True
    dv.errorStyle = "stop"
    dv.errorTitle = "מספר לא תקין"
    dv.error = error
    return dv


def _length_validation(maximum: int) -> DataValidation:
    dv = DataValidation(type="textLength", operator="lessThanOrEqual", formula1=str(maximum), allow_blank=True)
    dv.showErrorMessage = True
    dv.errorStyle = "stop"
    dv.errorTitle = "טקסט ארוך מדי"
    dv.error = f"עד {maximum} תווים"
    return dv


def _header(ws, columns: Sequence[Column]) -> None:
    for index, col in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=index, value=col.header)
        if col.kind == "marker":
            cell.fill, cell.font = _HEADER_MARKER, _HEADER_DARK_FONT
        else:
            cell.fill = _HEADER_REQUIRED if col.required else _HEADER_OPTIONAL
            cell.font = _HEADER_FONT
        cell.alignment = _WRAP_CENTER
        cell.border = _BOX
        note = Comment(col.help + (f"\nלדוגמה: {col.example}" if col.example else ""), "POS")
        note.width, note.height = 260, 110
        cell.comment = note
        ws.column_dimensions[get_column_letter(index)].width = col.width
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "C2"


def _write_rows(ws, columns: Sequence[Column], rows: Sequence[Dict[str, Any]], start: int, *, example: bool) -> int:
    """Write `rows` from row `start`; the next free row."""
    row_number = start
    for row in rows:
        notes = row.get("notes") or {}
        for index, col in enumerate(columns, start=1):
            value = row.get(col.key)
            cell = ws.cell(row=row_number, column=index, value=value if value not in ("",) else None)
            if col.kind in _NUMBER_FORMATS:
                cell.number_format = _NUMBER_FORMATS[col.kind]
            if example:
                cell.fill, cell.font = _EXAMPLE_FILL, _EXAMPLE_FONT
            if col.key in notes:
                note = Comment(notes[col.key], "POS")
                note.width, note.height = 240, 90
                cell.comment = note
        row_number += 1
    return row_number


def _column_formats(ws, columns: Sequence[Column]) -> None:
    """
    Each column's format for the cells typed into it later - text for a barcode / SKU, so
    0123 stays 0123 - set on the column itself. Formatting the empty cells instead would
    stretch the sheet's used range, and a row added below it would sit past the rows read.
    """
    for index, col in enumerate(columns, start=1):
        if col.kind in _NUMBER_FORMATS:
            ws.column_dimensions[get_column_letter(index)].number_format = _NUMBER_FORMATS[col.kind]


def _page_setup(ws) -> None:
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


# ── The data sheets ───────────────────────────────────────────────────────────


def _validations(ws, columns: Sequence[Column], last_row: int, lists: Dict[str, str], categories_ref: str) -> None:
    letter = {col.key: get_column_letter(i) for i, col in enumerate(columns, start=1)}

    def apply(dv: DataValidation, key: str) -> None:
        ws.add_data_validation(dv)
        dv.add(f"{letter[key]}2:{letter[key]}{last_row}")

    yes_no = _list_validation(lists["yes_no"], strict=True, error="כתבו כן או לא")
    ws.add_data_validation(yes_no)
    for col in columns:
        key = col.key
        if col.kind == "bool":
            yes_no.add(f"{letter[key]}2:{letter[key]}{last_row}")
        elif col.kind == "marker":
            apply(_list_validation(f'"{EXAMPLE_MARK},{SKIP_MARK}"', strict=True,
                                   error="השאירו ריק, או 'דוגמה' / 'דלג' לשורה שלא תיקלט"), key)
        elif col.kind == "money":
            high = COST_MAX if key == "cost" else 99999999
            apply(_number_validation("decimal", 0, high, "הקלידו מספר (למשל 12.50), בלי טקסט"), key)
        elif col.kind == "unit":
            apply(_list_validation(lists["units"], strict=False,
                                   error="יחידה שלא ברשימה - להמשיך?"), key)
        elif col.kind == "printers":
            apply(_list_validation(lists["printers"], strict=False, free_text=True,
                                   prompt=f"בחרו מהרשימה או כתבו כמה שמות מופרדים בפסיק. "
                                          f"'{PRINTERS_NONE}' = לא להדפיס, ריק = ללא שינוי"), key)
        elif col.kind == "ticket":
            apply(_list_validation(lists["tickets"], strict=True, error="בחרו מהרשימה"), key)
        elif key == "entries":
            apply(_number_validation("whole", 0, ENTRIES_MAX, f"מספר שלם בין 1 ל-{ENTRIES_MAX} (0 = לבטל)"), key)
        elif key == "sort":
            apply(_number_validation("whole", -100000, 100000, "מספר שלם"), key)
        elif key == "category" or key == "parent":
            apply(_list_validation(categories_ref, strict=False,
                                   error="המחלקה לא מופיעה בגיליון מחלקות - היא תיווצר בקליטה. להמשיך?"), key)
        elif key == "name":
            apply(_length_validation(255), key)
        elif key == "description":
            apply(_length_validation(1000), key)
        elif col.kind == "dietary":
            apply(_list_validation(lists["dietary"], strict=False, free_text=True,
                                   prompt="בחרו מהרשימה או כתבו כמה מופרדים בפסיק (למשל: טבעוני, חריף). "
                                          "'ללא' = לנקות, ריק = ללא שינוי"), key)


def _data_sheet(ws, columns: Sequence[Column], examples: Sequence[Dict[str, Any]], rows: Sequence[Dict[str, Any]],
                lists: Dict[str, str], categories_ref: str, tab: str) -> None:
    _rtl(ws)
    ws.sheet_properties.tabColor = tab
    _header(ws, columns)
    next_row = _write_rows(ws, columns, examples, 2, example=True)
    next_row = _write_rows(ws, columns, rows, next_row, example=False)
    last = max(next_row - 1 + SPARE_ROWS, MIN_ROWS)
    _column_formats(ws, columns)
    _validations(ws, columns, last, lists, categories_ref)
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{max(next_row - 1, 2)}"
    _page_setup(ws)


def _examples(view: TemplateView) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Two or three rows that show the shape of a menu, with the company's own printer names."""
    names = list(view.printer_choices)
    food = names[0] if names else "מטבח"
    drinks = names[1] if len(names) > 1 else ("בר" if not names else names[0])
    categories = [
        {"marker": EXAMPLE_MARK, "name": "מנות עיקריות", "printers": food, "sort": 1, "active": YES},
        {"marker": EXAMPLE_MARK, "name": "המבורגרים", "parent": "מנות עיקריות", "sort": 2, "active": YES},
        {"marker": EXAMPLE_MARK, "name": "שתייה", "printers": drinks, "sort": 3, "active": YES},
    ]
    products = [
        {"marker": EXAMPLE_MARK, "name": "המבורגר קלאסי", "category": "המבורגרים", "price": 58,
         "cost": 18.5, "open_price": NO, "weighed": NO, "unit": UNIT_PIECE, "no_discount": NO,
         "active": YES, "description": "200 גרם, חסה, עגבנייה, בצל", "dietary": "בשרי"},
        {"marker": EXAMPLE_MARK, "name": "קולה זכוכית", "category": "שתייה", "price": 12,
         "barcode": "7290001234567", "cost": 4.2, "open_price": NO, "weighed": NO, "unit": UNIT_PIECE,
         "no_discount": YES, "printers": drinks, "active": YES},
        {"marker": EXAMPLE_MARK, "name": "סלט חומוס", "category": "מנות עיקריות", "price": 49.9,
         "open_price": NO, "weighed": YES, "unit": UNIT_KG, "no_discount": NO,
         "ticket": TICKET_LABELS["per_line"], "active": YES, "description": "מחיר לק״ג",
         "dietary": "טבעוני, ללא גלוטן"},
    ]
    return categories, products


def _lists_sheet(wb: Workbook, view: TemplateView) -> Dict[str, str]:
    ws = wb.create_sheet(SHEET_LISTS)
    _rtl(ws)
    ws.sheet_state = "hidden"
    columns = {
        "printers": list(view.printer_choices) + [PRINTERS_NONE, PRINTERS_INHERIT],
        "yes_no": [YES, NO],
        "units": list(UNIT_CHOICES),
        "tickets": [label for mode, label in TICKET_LABELS.items()],
        "dietary": list(DIETARY_LABELS_HE.values()) + [DIETARY_NONE],
    }
    refs: Dict[str, str] = {}
    for index, (key, values) in enumerate(columns.items(), start=1):
        letter = get_column_letter(index)
        ws.cell(row=1, column=index, value=key)
        for r, value in enumerate(values, start=2):
            ws.cell(row=r, column=index, value=value)
        refs[key] = f"{_quoted(SHEET_LISTS)}!${letter}$2:${letter}${len(values) + 1}"
    return refs


def _printers_sheet(ws, view: TemplateView) -> None:
    _rtl(ws)
    ws.sheet_properties.tabColor = GREY
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(PRINTER_REFERENCE_HEADERS))
    intro = ws.cell(
        row=1, column=1,
        value="המדפסות שהוגדרו בחברה בעת הפקת הקובץ - לעיון בלבד. בעמודה 'מדפסות' בגיליונות "
              "'מחלקות' ו'פריטים' רשמו את השם מהעמודה הראשונה. השיוך חל בכל סניף שיש בו מדפסת בשם הזה.",
    )
    intro.alignment = _RIGHT
    intro.font = Font(color=INK)
    ws.row_dimensions[1].height = 48
    for index, title in enumerate(PRINTER_REFERENCE_HEADERS, start=1):
        cell = ws.cell(row=3, column=index, value=title)
        cell.fill, cell.font, cell.alignment, cell.border = _HEADER_OPTIONAL, _HEADER_FONT, _WRAP_CENTER, _BOX
    widths = (24, 22, 22, 24, 9)
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width
    if not view.printers:
        ws.merge_cells(start_row=4, start_column=1, end_row=4, end_column=len(PRINTER_REFERENCE_HEADERS))
        empty = ws.cell(row=4, column=1, value="לא הוגדרו עדיין מדפסות בחברה. אפשר להגדיר אותן במסך 'מדפסות בונים' "
                                               "ולהוריד את הטמפלט מחדש, או לרשום עכשיו את השמות המתוכננים.")
        empty.alignment = _RIGHT
        empty.font = _EXAMPLE_FONT
        ws.row_dimensions[4].height = 32
    for r, printer in enumerate(view.printers, start=4):
        values = (printer.name, printer.shop, printer.connection, printer.narrowed, YES if printer.active else NO)
        for c, value in enumerate(values, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.border = _BOX
            if not printer.active:
                cell.font = _EXAMPLE_FONT
    ws.freeze_panes = "A4"
    # Read-only: locked (no password - it is a reference, not a secret).
    ws.protection.sheet = True


# ── Instructions ──────────────────────────────────────────────────────────────


def _instructions(ws, view: TemplateView) -> None:
    _rtl(ws)
    ws.sheet_properties.tabColor = BLUE
    ws.sheet_view.showGridLines = False
    for letter, width in zip("ABCD", (24, 9, 70, 26)):
        ws.column_dimensions[letter].width = width

    row = 1

    def line(text: str, *, font: Optional[Font] = None, height: Optional[float] = None, gap: int = 0) -> None:
        nonlocal row
        row += gap
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=4)
        cell = ws.cell(row=row, column=1, value=text)
        cell.alignment = _RIGHT
        if font is not None:
            cell.font = font
        lines = max(1, math.ceil(len(text) / 115))
        ws.row_dimensions[row].height = height or (16 * lines + 4)
        row += 1

    def section(title: str) -> None:
        line(title, font=Font(bold=True, size=13, color=BLUE), height=24, gap=1)

    title = f"טמפלט לקליטת פריטים - {view.company_name}"
    line(title, font=Font(bold=True, size=18, color=INK), height=30)
    counts = [f"{len(view.categories)} מחלקות", f"{len(view.printers)} מדפסות"]
    if view.with_data:
        counts.insert(0, f"{len(view.products)} פריטים")
    stamp = view.generated_at.strftime("%d/%m/%Y %H:%M")
    line(f"הופק ב-{stamp} · " + " · ".join(counts), font=Font(color=GREY))

    section("איך ממלאים")
    for text in (
        "1. בגיליון 'מחלקות' רשמו את מחלקות התפריט (למשל 'מנות עיקריות', 'שתייה'). למחלקת משנה רשמו "
        "בעמודה 'מחלקת אב' את המחלקה שמעליה.",
        "2. בגיליון 'פריטים' - שורה לכל פריט. חובה: שם פריט, מחלקה ומחיר (העמודות המסומנות ב-* בכחול). "
        "כל השאר רשות. מחלקה שלא רשמתם בגיליון 'מחלקות' תיווצר אוטומטית.",
        "3. מחירים בשקלים כולל מע״מ: 12.50 (אפשר גם ₪12.50). 'עלות' היא לפני מע״מ ואינה מוצגת בקופה.",
        "4. בעמודות כן/לא, יחידה ושובר פריט בחרו מהרשימה שנפתחת בתא. תא ריק בפריט חדש = ברירת המחדל "
        "('לא', ו'פעיל' = כן).",
        f"5. השורות האפורות שמסומנות '{EXAMPLE_MARK}' לא ייקלטו - אפשר למחוק אותן או להשאיר. "
        f"כדי לדלג על שורה כתבו '{SKIP_MARK}' בעמודה 'סימון'.",
        "6. שמרו את הקובץ כ-xlsx והחזירו אותו, או העלו אותו במסך 'ייבוא פריטים מאקסל' בניהול.",
        "העבירו את העכבר מעל כותרת של עמודה כדי לראות הסבר עליה.",
    ):
        line(text)

    section("מדפסות המטבח והבר")
    for text in (
        "בעמודה 'מדפסות' רשמו את שמות המדפסות בדיוק כפי שהם מופיעים בגיליון 'מדפסות', מופרדים בפסיק "
        "(למשל: מטבח, בר).",
        "מדפסת של מחלקה חלה על כל הפריטים שבה ועל מחלקות המשנה שלה. מדפסת שנרשמה לפריט גוברת על המחלקה.",
        "הניתוב נקבע לפי שם המדפסת בכל סניף של החברה: בסניף שיש בו מדפסת בשם הזה - ההדפסה תהיה בה; "
        "בסניף שאין בו מדפסת בשם הזה - לא משתנה דבר.",
        f"'{PRINTERS_NONE}' = לא להדפיס. '{PRINTERS_INHERIT}' = לבטל הגדרה קודמת (פריט - חוזר להגדרת המחלקה; "
        "מחלקה - חוזרת למחלקת האב). תא ריק = ללא שינוי.",
        "שם מדפסת שלא מוגדרת באף סניף - השיוך שלו יידלג, ותופיע על כך אזהרה בבדיקת הקובץ.",
    ):
        line(text)
    if view.has_mixed_routing:
        line("תא מדפסות ריק שיש עליו הערה: הניתוב שלו שונה בין הסניפים, ולכן לא נכתב. ערכו אותו במסך "
             "'מדפסות בונים'.", font=Font(color=ORANGE))

    section("עדכון פריטים קיימים")
    for text in (
        "פריט קיים מזוהה לפי הברקוד; אם אין ברקוד - לפי המק״ט; ואם אין גם מק״ט - לפי שם זהה באותה מחלקה. "
        "מחלקה קיימת מזוהה לפי השם.",
        "פריט שזוהה יעודכן לפי השורה, ופריט שלא זוהה ייווצר. פריט חדש נמכר בכל הסניפים של החברה.",
        "תא ריק בפריט או במחלקה קיימים = הערך הקיים נשמר. פריטים ומחלקות שלא מופיעים בקובץ לא נמחקים.",
        "לפני הקליטה מוצגת בדיקה של הקובץ: מה ייווצר, מה יתעדכן, אזהרות ושגיאות (עם מספר השורה). "
        "ייבוא חוזר של אותו קובץ לא משנה דבר.",
    ):
        line(text)

    section("העמודות")
    head = row
    for c, text in enumerate(("עמודה", "חובה", "מה לרשום", "דוגמה"), start=1):
        cell = ws.cell(row=head, column=c, value=text)
        cell.fill, cell.font, cell.alignment, cell.border = _HEADER_REQUIRED, _HEADER_FONT, _WRAP_CENTER, _BOX
    row += 1
    for sheet, columns in ((SHEET_PRODUCTS, PRODUCT_COLUMNS), (SHEET_CATEGORIES, CATEGORY_COLUMNS)):
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=4)
        sub = ws.cell(row=row, column=1, value=f"גיליון '{sheet}'")
        sub.font = Font(bold=True, color=INK)
        sub.fill = _EXAMPLE_FILL
        row += 1
        for col in columns:
            values = (col.title, YES if col.required else "", col.help, col.example)
            for c, value in enumerate(values, start=1):
                cell = ws.cell(row=row, column=c, value=value or None)
                cell.alignment = _RIGHT
                cell.border = _BOX
                if c == 1:
                    cell.font = Font(bold=True)
            ws.row_dimensions[row].height = 16 * max(1, math.ceil(len(col.help) / 70)) + 4
            row += 1


# ── The workbook ──────────────────────────────────────────────────────────────


def build_workbook(view: TemplateView) -> bytes:
    wb = Workbook()
    help_ws = wb.active
    help_ws.title = SHEET_INSTRUCTIONS
    categories_ws = wb.create_sheet(SHEET_CATEGORIES)
    products_ws = wb.create_sheet(SHEET_PRODUCTS)
    printers_ws = wb.create_sheet(SHEET_PRINTERS)
    lists = _lists_sheet(wb, view)

    cat_examples, prod_examples = ([], []) if view.with_data else _examples(view)
    category_rows = len(cat_examples) + len(view.categories)
    categories_ref = (
        f"{_quoted(SHEET_CATEGORIES)}!$B$2:$B${max(category_rows + 1 + SPARE_ROWS, MIN_ROWS)}"
    )

    _instructions(help_ws, view)
    _data_sheet(categories_ws, CATEGORY_COLUMNS, cat_examples, view.categories, lists, categories_ref, ORANGE)
    _data_sheet(products_ws, PRODUCT_COLUMNS, prod_examples, view.products, lists, categories_ref, GREEN)
    _printers_sheet(printers_ws, view)

    wb.properties.title = f"טמפלט לקליטת פריטים - {view.company_name}"
    wb.properties.creator = "POS"
    wb.active = 0
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def build_csv(view: TemplateView) -> bytes:
    """The products sheet alone, as UTF-8 CSV (with a BOM, so Excel reads the Hebrew)."""
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([col.header for col in PRODUCT_COLUMNS])
    rows = view.products if view.with_data else _examples(view)[1]
    for row in rows:
        values = []
        for col in PRODUCT_COLUMNS:
            value = row.get(col.key)
            if value is None:
                values.append("")
            elif isinstance(value, Decimal):
                values.append(f"{value:.2f}")
            else:
                values.append(str(value))
        writer.writerow(values)
    return ("﻿" + out.getvalue()).encode("utf-8")


def ticket_label(mode: Optional[str]) -> str:
    """A stored ticket mode as the sheet writes it; the category's (None) is blank."""
    if mode is None or mode == TICKET_INHERIT:
        return ""
    return TICKET_LABELS.get(mode, "")
