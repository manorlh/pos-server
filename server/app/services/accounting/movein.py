"""
Hashavshevet `MOVEIN.DAT` + `MOVEIN.PRM` (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.4).

**Flexible method** ("השיטה הגמישה"): the PRM describes where each field sits in the
DAT, so the two are always written together and always agree.

* `MOVEIN.PRM` — line 1 is the record length; then one line per Hashavshevet field
  number, 1 … the highest used, each `start end` (1-based, inclusive); a field number
  this export does not use is `0 0`.
* `MOVEIN.DAT` — an opening record holding the record length, then one fixed-length
  record per journal line (one account per record: the debit account and amount, *or*
  the credit account and amount). Every record, the opening one included, is exactly
  `RECORD_LENGTH` bytes followed by CR+LF.
* Amounts are `9.2` — right-aligned, 12 characters, two decimals, never negative (a
  negative line is already on the other side). An unused amount is `0.00`.
* Dates are `dd/mm/yyyy`. Text is left-aligned, space-padded, cut to the field width.
  Numbers (references) are right-aligned, space-padded.

**Detailed method** ("השיטה המפורטת"): no PRM is needed by Hashavshevet; a fixed 180-byte
record with `ddmmyy` dates and 8-character accounts. The PRM is still written, describing
the same positions, so the file explains itself.

Encoding is single-byte, so a character is a byte and widths are exact: Windows-1255
(logical Hebrew) by default, CP862 for old DOS-era installations. Characters the code
page lacks are replaced (`·` → `-`, anything else → `?`), never dropped, so positions
never shift.

!! The field numbers and widths below are this system's layout. They must be validated by
!! importing a trial file into the bookkeeper's own Hashavshevet / Priority before real use
!! (spec §7). They are constants for exactly that reason.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, List, Sequence, Tuple

from app.services.accounting.journal import JournalEntry, JournalLine

CRLF = b"\r\n"


@dataclass(frozen=True)
class Field:
    key: str
    #: Hashavshevet's own number for the field in the flexible method (PRM order).
    number: int
    width: int
    #: text | number | date | amount
    kind: str


#: Flexible layout, in DAT order. VERIFY the numbers against the client's version.
FLEXIBLE_FIELDS: Tuple[Field, ...] = (
    Field("movementType", 1, 3, "text"),      # סוג תנועה
    Field("reference1", 2, 9, "number"),      # אסמכתא 1 = Z number
    Field("reference2", 3, 9, "number"),      # אסמכתא 2 = branch code
    Field("entryDate", 4, 10, "date"),        # תאריך אסמכתא
    Field("valueDate", 5, 10, "date"),        # תאריך ערך
    Field("details", 6, 30, "text"),          # פרטים
    Field("debitAccount", 7, 15, "text"),     # חשבון חובה 1
    Field("creditAccount", 8, 15, "text"),    # חשבון זכות 1
    Field("debitAmount", 9, 12, "amount"),    # סכום חובה ₪
    Field("creditAmount", 10, 12, "amount"),  # סכום זכות ₪
    Field("branch", 11, 5, "text"),           # סניף
)

#: Detailed layout: 180 bytes, ddmmyy, 8-character accounts; the rest is filler.
DETAILED_FIELDS: Tuple[Field, ...] = (
    Field("movementType", 1, 3, "text"),
    Field("reference1", 2, 5, "number"),
    Field("entryDate", 3, 6, "date6"),
    Field("reference2", 4, 5, "number"),
    Field("valueDate", 5, 6, "date6"),
    Field("details", 6, 22, "text"),
    Field("debitAccount", 7, 8, "text"),
    Field("creditAccount", 8, 8, "text"),
    Field("debitAmount", 9, 12, "amount"),
    Field("creditAmount", 10, 12, "amount"),
    Field("branch", 11, 3, "text"),
)
DETAILED_RECORD_LENGTH = 180

#: Replacements for characters a code page lacks, before falling back to "?".
_SUBSTITUTES = {
    "·": "-",
    "–": "-",
    "—": "-",
    "״": '"',
    "׳": "'",
    "₪": "",
    "‏": "",
    "‎": "",
}

ENCODINGS = {"cp1255": "cp1255", "cp862": "cp862"}


def layout(method: str) -> Tuple[Tuple[Field, ...], int]:
    if method == "detailed":
        return DETAILED_FIELDS, DETAILED_RECORD_LENGTH
    if method != "flexible":
        raise ValueError(f"unknown method {method!r}")
    return FLEXIBLE_FIELDS, sum(f.width for f in FLEXIBLE_FIELDS)


def positions(fields: Sequence[Field]) -> Dict[str, Tuple[int, int]]:
    """Field key → (start, end), 1-based and inclusive."""
    out: Dict[str, Tuple[int, int]] = {}
    pos = 1
    for f in fields:
        out[f.key] = (pos, pos + f.width - 1)
        pos += f.width
    return out


def encode_text(text: str, width: int, encoding: str) -> bytes:
    """Cut, encode (one byte per character) and space-pad to exactly `width` bytes."""
    clean = "".join(_SUBSTITUTES.get(ch, ch) for ch in (text or ""))
    clean = " ".join(clean.split())  # no CR/LF/tab inside a record
    out = bytearray()
    for ch in clean:
        try:
            b = ch.encode(encoding)
        except UnicodeEncodeError:
            b = b"?"
        if len(b) != 1:  # never true for these code pages, but a width is a width
            b = b"?"
        if len(out) + 1 > width:
            break
        out += b
    return bytes(out).ljust(width, b" ")


def format_amount(amount: Decimal, width: int = 12) -> str:
    """`9.2`: right-aligned, two decimals. Refuses what does not fit rather than cut it."""
    text = f"{Decimal(amount).quantize(Decimal('0.01')):.2f}"
    if len(text) > width or Decimal(amount) < 0:
        raise ValueError(f"amount {amount} does not fit {width}.2 unsigned")
    return text.rjust(width)


def _value(field: Field, entry: JournalEntry, line: JournalLine) -> str:
    debit = line.side == "D"
    if field.key == "movementType":
        return entry.movement_type
    if field.key == "reference1":
        return str(entry.reference1)
    if field.key == "reference2":
        return entry.reference2
    if field.key in ("entryDate", "valueDate"):
        d = entry.entry_date if field.key == "entryDate" else entry.value_date
        return d.strftime("%d%m%y") if field.kind == "date6" else d.strftime("%d/%m/%Y")
    if field.key == "details":
        return f"{entry.details} {line.label}".strip()
    if field.key == "debitAccount":
        return (line.account or "") if debit else ""
    if field.key == "creditAccount":
        return "" if debit else (line.account or "")
    if field.key == "debitAmount":
        return format_amount(line.amount if debit else Decimal("0"), field.width)
    if field.key == "creditAmount":
        return format_amount(Decimal("0") if debit else line.amount, field.width)
    if field.key == "branch":
        # A consolidated company entry keeps each line's shop (cost centre) here.
        return line.branch if line.branch is not None else entry.branch
    raise KeyError(field.key)


def _field_bytes(field: Field, value: str, encoding: str) -> bytes:
    if field.kind in ("number", "amount"):
        text = value.strip()
        if len(text) > field.width:
            raise ValueError(f"{field.key} {value!r} is wider than {field.width}")
        return text.rjust(field.width).encode("ascii", "replace")
    if field.kind in ("date", "date6"):
        return value.encode("ascii").ljust(field.width, b" ")[: field.width]
    return encode_text(value, field.width, encoding)


def record(entry: JournalEntry, line: JournalLine, *, method: str, encoding: str) -> bytes:
    fields, length = layout(method)
    out = b"".join(_field_bytes(f, _value(f, entry, line), encoding) for f in fields)
    return out.ljust(length, b" ")


def write_dat(entries: Sequence[JournalEntry], *, method: str = "flexible", encoding: str = "cp1255") -> bytes:
    if encoding not in ENCODINGS:
        raise ValueError(f"unknown encoding {encoding!r}")
    _fields, length = layout(method)
    out = [str(length).encode("ascii").ljust(length, b" ")]
    for entry in entries:
        for line in entry.lines:
            out.append(record(entry, line, method=method, encoding=encoding))
    return CRLF.join(out) + CRLF


def write_prm(method: str = "flexible") -> bytes:
    fields, length = layout(method)
    pos = positions(fields)
    by_number = {f.number: f for f in fields}
    lines = [str(length)]
    for number in range(1, max(by_number) + 1):
        f = by_number.get(number)
        lines.append("0 0" if f is None else f"{pos[f.key][0]} {pos[f.key][1]}")
    return CRLF.join(l.encode("ascii") for l in lines) + CRLF


def validate_accounts(entries: Sequence[JournalEntry], method: str) -> List[str]:
    """Account keys longer than the layout's account field (they would be cut)."""
    fields, _ = layout(method)
    width = next(f.width for f in fields if f.key == "debitAccount")
    bad = sorted({l.account for e in entries for l in e.lines if l.account and len(l.account) > width})
    return bad

