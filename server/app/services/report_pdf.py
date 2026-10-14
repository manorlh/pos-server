"""
A report as a real PDF file, drawn on the server (P:/specs/reports-upgrade.md §2ד, §4.5).

The dashboard sends what it shows — title, sub-titles, the filters chosen, the columns picked
for the export, the rows and the totals — and gets a file back. Nothing is read from the
database here but the business's logo.

How it is drawn, with only what the server already has (no new package):

* **Text is real PDF text**, in Heebo (app/assets/fonts, SIL OFL — the vouchers' and the till's
  font), embedded whole as a TrueType CID font (Type0 / Identity-H). Its `cmap` and `hmtx`
  tables are read here (`_TrueType`) for the glyph of each character and its width, so columns
  are measured exactly. A ToUnicode map keeps the text searchable.
* **Hebrew is put into visual order by `python-bidi`**, as the vouchers' PDF does (Hebrew needs
  ordering, not shaping): text with Hebrew in it is laid out right to left, as in the dashboard's
  RTL table, so a Hebrew name with a number or a Latin word in it reads right; a Latin-only name
  stays exactly as typed.
* **The logo** is read with Pillow (`prepaid_voucher_pdf.load_logo`: our own media, or https) and
  embedded as a JPEG.

Why not pages drawn as pictures with Pillow, as the vouchers are: a report can be 20,000 rows —
hundreds of pages — and as images that is hundreds of megabytes and minutes, where as text it is
a few megabytes and a few seconds, crisp at every zoom and printable on any printer.

This module is the writer's ground floor — the font, the text, the formats, the canvas (text,
rectangles, lines and the vector shapes: rounded rectangles, polygons, ring segments, clipping,
form XObjects) and the file. What a page looks like — the header band with both logos, KPI
cards, insights, charts, tables, the cover and the footer (P:/specs/reports-designed-pdf.md §5)
— is app/services/report_design.py. Columns run right to left; `auto` orientation is landscape
above `AUTO_LANDSCAPE_COLUMNS` columns.
"""
from __future__ import annotations

import io
import math
import re
import struct
import zlib
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: Rows one PDF may hold; more is a 413 (the export says so in Hebrew).
MAX_ROWS = 20_000
MAX_COLUMNS = 40
#: `auto`: landscape when there are more columns than this.
AUTO_LANDSCAPE_COLUMNS = 7

FONT_DIR = Path(__file__).absolute().parent.parent / "assets" / "fonts"
FONT_FILES = {False: FONT_DIR / "Heebo-Regular.ttf", True: FONT_DIR / "Heebo-Bold.ttf"}

A4 = (595.28, 841.89)
MARGIN = 28.0
TOP = 24.0
BOTTOM = 22.0
FOOTER_H = 16.0
PAD = 3.5
LOGO_MAX = (110.0, 42.0)

BODY_SIZE = 8.5
MIN_BODY_SIZE = 6.0
TITLE_SIZE = 15.0
SUBTITLE_SIZE = 9.5
FILTER_SIZE = 8.0
FOOTER_SIZE = 7.5
#: Text columns never grow past this (in points at the body size) before wrapping is cut.
TEXT_COLUMN_CAP = 260.0

NUMERIC_KINDS = ("money", "number", "percent", "trend")
#: The kinds a column may be (`POST /reports/pdf`).
COLUMN_KINDS = ("text", "money", "number", "percent", "date", "datetime", "trend")
DASH = "—"
TOTAL_LABEL = "סה״כ"
NO_ROWS = "אין נתונים להצגה"


# ── The font ─────────────────────────────────────────────────────────────────


class _TrueType:
    """The few tables of a TrueType file a PDF needs: glyph per character, widths, metrics."""

    def __init__(self, path: Path):
        self.data = data = path.read_bytes()
        self.name = path.stem.replace(" ", "")
        num_tables = struct.unpack(">H", data[4:6])[0]
        tables: Dict[str, Tuple[int, int]] = {}
        for i in range(num_tables):
            tag, _sum, off, length = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
            tables[tag.decode("latin-1")] = (off, length)
        head = tables["head"][0]
        self.units = struct.unpack(">H", data[head + 18: head + 20])[0]
        self.bbox = struct.unpack(">hhhh", data[head + 36: head + 44])
        hhea = tables["hhea"][0]
        self.ascent, self.descent = struct.unpack(">hh", data[hhea + 4: hhea + 8])
        n_metrics = struct.unpack(">H", data[hhea + 34: hhea + 36])[0]
        maxp = tables["maxp"][0]
        self.num_glyphs = struct.unpack(">H", data[maxp + 4: maxp + 6])[0]
        hmtx = tables["hmtx"][0]
        advances = [struct.unpack(">H", data[hmtx + 4 * i: hmtx + 4 * i + 2])[0] for i in range(n_metrics)]
        last = advances[-1] if advances else 0
        self.advances = advances + [last] * max(0, self.num_glyphs - n_metrics)
        self.cap_height = self.ascent
        if "OS/2" in tables:
            os2, length = tables["OS/2"]
            version = struct.unpack(">H", data[os2: os2 + 2])[0]
            if version >= 2 and length >= 90:
                self.cap_height = struct.unpack(">h", data[os2 + 88: os2 + 90])[0]
        self.italic = 0.0
        if "post" in tables:
            post = tables["post"][0]
            self.italic = struct.unpack(">i", data[post + 4: post + 8])[0] / 65536.0
        self.cmap = self._cmap(tables["cmap"][0])

    def _cmap(self, base: int) -> Dict[int, int]:
        data = self.data
        count = struct.unpack(">H", data[base + 2: base + 4])[0]
        chosen = None
        for i in range(count):
            platform, encoding, offset = struct.unpack(">HHI", data[base + 4 + 8 * i: base + 12 + 8 * i])
            if struct.unpack(">H", data[base + offset: base + offset + 2])[0] != 4:
                continue
            if (platform, encoding) == (3, 1) or chosen is None:
                chosen = base + offset
        if chosen is None:
            raise ValueError("font has no format-4 cmap")
        seg_x2 = struct.unpack(">H", data[chosen + 6: chosen + 8])[0]
        segs = seg_x2 // 2
        ends_at = chosen + 14
        starts_at = ends_at + seg_x2 + 2
        deltas_at = starts_at + seg_x2
        ranges_at = deltas_at + seg_x2
        out: Dict[int, int] = {}
        for s in range(segs):
            end = struct.unpack(">H", data[ends_at + 2 * s: ends_at + 2 * s + 2])[0]
            start = struct.unpack(">H", data[starts_at + 2 * s: starts_at + 2 * s + 2])[0]
            delta = struct.unpack(">h", data[deltas_at + 2 * s: deltas_at + 2 * s + 2])[0]
            range_pos = ranges_at + 2 * s
            range_off = struct.unpack(">H", data[range_pos: range_pos + 2])[0]
            for code in range(start, end + 1):
                if code == 0xFFFF:
                    continue
                if range_off == 0:
                    gid = (code + delta) & 0xFFFF
                else:
                    at = range_pos + range_off + 2 * (code - start)
                    gid = struct.unpack(">H", data[at: at + 2])[0]
                    if gid:
                        gid = (gid + delta) & 0xFFFF
                if gid:
                    out[code] = gid
        return out


@lru_cache(maxsize=2)
def _truetype(bold: bool) -> _TrueType:
    return _TrueType(FONT_FILES[bold])


class _Font:
    """A face as this document uses it: widths per character, the glyphs it drew."""

    def __init__(self, ttf: _TrueType, resource: str):
        self.ttf = ttf
        self.resource = resource
        self.used: Dict[int, int] = {}  # gid -> code point
        scale = 1000.0 / ttf.units
        self._scale = scale
        fallback = ttf.cmap.get(ord("?"), 0)
        self._fallback = fallback
        self._w: Dict[str, float] = {}

    def glyph(self, ch: str) -> int:
        return self.ttf.cmap.get(ord(ch), self._fallback)

    def char_width(self, ch: str) -> float:
        w = self._w.get(ch)
        if w is None:
            gid = self.glyph(ch)
            w = self.ttf.advances[gid] * self._scale if gid < len(self.ttf.advances) else 500.0
            self._w[ch] = w
        return w

    def width(self, text: str, size: float) -> float:
        return sum(self.char_width(ch) for ch in text) * size / 1000.0

    def encode(self, text: str) -> str:
        out = []
        for ch in text:
            gid = self.glyph(ch)
            if gid not in self.used:
                self.used[gid] = ord(ch) if self.ttf.cmap.get(ord(ch)) == gid else ord("?")
            out.append(f"{gid:04X}")
        return "".join(out)


# ── Text ─────────────────────────────────────────────────────────────────────

_RTL = re.compile(r"[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]")
_CONTROL = re.compile(r"[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]")


def base_direction(text: str) -> str:
    """
    'R' for text with any right-to-left letter (Hebrew, Arabic) — the dashboard's table is RTL,
    so "Croissant חמאה" reads as it does there — else 'L': a Latin-only name ("Cola (1L)")
    stays exactly as typed.
    """
    return "R" if _RTL.search(text or "") else "L"


def visual(text: str, base_dir: Optional[str] = None) -> str:
    """
    Logical → visual order for drawing left to right (python-bidi; Hebrew needs no shaping).
    `base_dir`: 'R', 'L', or None for the text's own (`base_direction`).
    """
    text = clean(text)
    if not text:
        return ""
    direction = base_dir or base_direction(text)
    if direction == "L" and not _RTL.search(text):
        return text  # nothing to reorder
    from bidi.algorithm import get_display

    return get_display(text, base_dir=direction)


#: Characters Heebo has no glyph for, as ones it has. An arrow in a Hebrew line ("חברה ← סניף")
#: becomes the angle quote that the bidi algorithm mirrors to point the same way.
_SUBSTITUTES = str.maketrans({"←": "›", "→": "‹", "⇐": "›", "⇒": "‹", "▲": "+", "▼": "-", "✓": "V", "✔": "V"})


def clean(text: Any) -> str:
    """One line of printable text: no control characters or explicit bidi marks, no newlines."""
    s = "" if text is None else str(text)
    s = s.replace("\r\n", " ").replace("\n", " ").replace("\t", " ")
    return _CONTROL.sub("", s).translate(_SUBSTITUTES)


def _num(value: Any) -> Optional[Decimal]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            d = Decimal(str(value))
        except InvalidOperation:
            return None
        return d if d.is_finite() else None
    if isinstance(value, str):
        raw = value.strip().replace(",", "").replace("₪", "").replace("%", "").strip()
        if not raw:
            return None
        try:
            d = Decimal(raw)
        except InvalidOperation:
            return None
        return d if d.is_finite() else None
    return None


def format_money(value: Any) -> str:
    """₪ with 2 decimals, as the dashboard shows it in a right-to-left cell: `₪ -1,234.50`."""
    d = _num(value)
    if d is None:
        return DASH if value in (None, "") else clean(value)
    q = d.quantize(Decimal("0.01"))
    if q == 0:
        q = abs(q)
    return f"₪ {q:,.2f}"


def format_number(value: Any) -> str:
    d = _num(value)
    if d is None:
        return DASH if value in (None, "") else clean(value)
    if d == d.to_integral_value():
        return f"{int(d):,}"
    text = f"{d.quantize(Decimal('0.001')):,.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def format_percent(value: Any) -> str:
    d = _num(value)
    if d is None:
        return DASH if value in (None, "") else clean(value)
    text = f"{d.quantize(Decimal('0.01')):,.2f}".rstrip("0").rstrip(".")
    return f"{text}%"


def format_date(value: Any, tz_name: str = "Asia/Jerusalem") -> str:
    if value in (None, ""):
        return DASH
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    else:
        raw = str(value).strip()
        try:
            if len(raw) <= 10:
                return date.fromisoformat(raw).strftime("%d.%m.%Y")
            moment = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return clean(raw)
    if moment.tzinfo is not None:
        try:
            from zoneinfo import ZoneInfo

            moment = moment.astimezone(ZoneInfo(tz_name))
        except Exception:  # noqa: BLE001 — an unknown zone: as sent
            pass
    return moment.strftime("%d.%m.%Y %H:%M")


def format_cell(value: Any, kind: str, tz_name: str = "Asia/Jerusalem") -> str:
    if kind == "money":
        return format_money(value)
    if kind == "number":
        return format_number(value)
    if kind in ("percent", "trend"):
        return format_percent(value)
    if kind in ("date", "datetime"):
        return format_date(value, tz_name)
    if value is None or value == "":
        return DASH
    if isinstance(value, bool):
        return "כן" if value else "לא"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (list, tuple)):
        return ", ".join(clean(v) for v in value if v is not None)
    return clean(value)


# ── Layout ───────────────────────────────────────────────────────────────────


@dataclass
class Column:
    key: str
    label: str
    kind: str = "text"
    align: Optional[str] = None
    #: A percent column: a small bar under the value (0–100).
    bar: bool = True
    #: What a group's subtotal row does with it: "sum" or "none" (None: by the kind).
    agg: Optional[str] = None
    #: A trend column: which way is good ("up" / "down").
    better: str = "up"

    @property
    def sums(self) -> bool:
        return self.agg == "sum" if self.agg in ("sum", "none") else self.kind in ("money", "number")

    @property
    def numeric(self) -> bool:
        return self.kind in NUMERIC_KINDS

    @property
    def anchor(self) -> str:
        """'right', 'left' or 'center' on the page (start = right: the report is RTL)."""
        a = (self.align or "").lower()
        if a in ("right", "start"):
            return "right"
        if a in ("left", "end"):
            return "left"
        if a == "center":
            return "center"
        return "left" if self.numeric else "right"


@dataclass
class Report:
    title: str
    columns: List[Column]
    rows: List[List[str]]
    totals: Optional[List[str]] = None
    subtitle_lines: List[str] = field(default_factory=list)
    filter_lines: List[str] = field(default_factory=list)
    orientation: str = "auto"
    generated: str = ""
    logo: Any = None  # a PIL image, or None


def column_of(c: Dict[str, Any]) -> Column:
    """A column from its JSON (`key`, `label`, `kind`, `align`, `bar`, `agg`, `better`)."""
    kind = c.get("kind") or "text"
    return Column(
        key=str(c["key"]),
        label=clean(c.get("label") or c["key"]),
        kind=kind if kind in COLUMN_KINDS else "text",
        align=c.get("align"),
        bar=c.get("bar") is not False,
        agg=c.get("agg") if c.get("agg") in ("sum", "none") else None,
        better="down" if c.get("better") == "down" else "up",
    )


def build_report(
    *,
    title: str,
    columns: Sequence[Dict[str, Any]],
    rows: Sequence[Any],
    totals: Any = None,
    subtitle_lines: Sequence[str] = (),
    filter_lines: Sequence[str] = (),
    orientation: str = "auto",
    tz_name: str = "Asia/Jerusalem",
    logo: Any = None,
    now: Optional[datetime] = None,
) -> Report:
    """The rows as the strings they print as (by each column's kind)."""
    cols = [column_of(c) for c in columns]

    def cells(row: Any) -> List[str]:
        if isinstance(row, dict):
            return [format_cell(row.get(c.key), c.kind, tz_name) for c in cols]
        values = list(row) if isinstance(row, (list, tuple)) else []
        return [format_cell(values[i] if i < len(values) else None, c.kind, tz_name) for i, c in enumerate(cols)]

    total_cells = None
    if totals:
        raw = totals if isinstance(totals, (dict, list, tuple)) else {}
        total_cells = cells(raw)
        first_given = (raw.get(cols[0].key) not in (None, "")) if isinstance(raw, dict) else bool(raw and raw[0] not in (None, ""))
        if not first_given:
            total_cells[0] = TOTAL_LABEL
        for i, c in enumerate(cols):
            given = raw.get(c.key) if isinstance(raw, dict) else (raw[i] if i < len(raw) else None)
            if i and given in (None, ""):
                total_cells[i] = ""
    from zoneinfo import ZoneInfo

    try:
        zone = ZoneInfo(tz_name)
    except Exception:  # noqa: BLE001
        zone = timezone.utc
    moment = (now or datetime.now(timezone.utc)).astimezone(zone)
    return Report(
        title=clean(title),
        columns=cols,
        rows=[cells(r) for r in rows],
        totals=total_cells,
        subtitle_lines=[clean(s) for s in subtitle_lines if clean(s)],
        filter_lines=[clean(s) for s in filter_lines if clean(s)],
        orientation=orientation,
        generated=f"הופק: {moment.strftime('%d.%m.%Y %H:%M')}",
        logo=logo,
    )


def page_size(report: Report) -> Tuple[float, float]:
    landscape = report.orientation == "landscape" or (
        report.orientation not in ("portrait", "landscape") and len(report.columns) > AUTO_LANDSCAPE_COLUMNS
    )
    return (A4[1], A4[0]) if landscape else A4


def _wrap(font: _Font, text: str, size: float, width: float, max_lines: int) -> List[str]:
    """Word-wrapped logical lines that fit `width`; the last one cut with "…" if it overflows."""
    words = text.split()
    lines: List[str] = []
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if not line or font.width(candidate, size) <= width:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1] + "…"
    return [_fit(font, line_, size, width) for line_ in lines]


def _fit(font: _Font, text: str, size: float, width: float) -> str:
    """`text` (logical), cut with "…" to fit `width`."""
    if font.width(text, size) <= width:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if font.width(text[:mid].rstrip() + "…", size) <= width:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + "…" if lo else "…"


def column_widths(columns: Sequence[Column], rows: Sequence[Sequence[str]], totals: Optional[Sequence[str]],
                  regular: _Font, bold: _Font, available: float) -> Tuple[float, List[float]]:
    """
    (body size, widths in points), first column first, for a table of `rows` (each its cells as
    they print) in `available` points. Numbers are never cut; text columns share what is left.
    A trend column (▲/▼) gets the arrow's room too.
    """
    n = len(columns)
    # Natural widths at 1pt, then scaled with the size.
    content = [0.0] * n
    for row in rows:
        for i, text in enumerate(row[:n]):
            w = regular.width(text, 1.0)
            if w > content[i]:
                content[i] = w
    if totals:
        for i, text in enumerate(totals[:n]):
            content[i] = max(content[i], bold.width(text, 1.0))
    for i, col in enumerate(columns):
        if col.kind == "trend" and content[i]:
            content[i] += 1.2
    label_word = [max((bold.width(wd, 1.0) for wd in c.label.split()), default=0.0) for c in columns]
    label_full = [bold.width(c.label, 1.0) for c in columns]

    for size in [s / 2 for s in range(int(BODY_SIZE * 2), int(MIN_BODY_SIZE * 2) - 1, -1)]:
        natural, minimum = [], []
        for i, col in enumerate(columns):
            head = max(label_word[i], label_full[i] / 2)
            body = content[i]
            if not col.numeric:
                body = min(body, TEXT_COLUMN_CAP / size)
            w = max(body, head) * size + 2 * PAD
            natural.append(w)
            minimum.append(w if col.numeric else max(min(w, 42.0), label_word[i] * size + 2 * PAD))
        if sum(natural) <= available:
            extra = available - sum(natural)
            total = sum(natural) or 1.0
            return size, [w + extra * w / total for w in natural]
        if sum(minimum) <= available:
            fixed = sum(natural[i] for i, c in enumerate(columns) if c.numeric)
            text_idx = [i for i, c in enumerate(columns) if not c.numeric]
            widths = list(natural)
            room = available - fixed
            free = list(text_idx)
            # Share the room among the text columns by their natural width, never below a minimum.
            for _ in range(len(text_idx) + 1):
                share_total = sum(natural[i] for i in free) or 1.0
                pinned = sum(widths[i] for i in text_idx if i not in free)
                left = room - pinned
                changed = False
                for i in list(free):
                    w = left * natural[i] / share_total
                    if w < minimum[i]:
                        widths[i] = minimum[i]
                        free.remove(i)
                        changed = True
                if not changed:
                    for i in free:
                        widths[i] = left * natural[i] / share_total
                    break
            return size, widths
    # Even the smallest size does not fit: everything shares the width (numbers may be cut).
    size = MIN_BODY_SIZE
    natural = [
        max(min(content[i], TEXT_COLUMN_CAP / size) if not c.numeric else content[i], label_word[i]) * size + 2 * PAD
        for i, c in enumerate(columns)
    ]
    total = sum(natural) or 1.0
    return size, [available * w / total for w in natural]


# ── Drawing ──────────────────────────────────────────────────────────────────

#: A colour: a gray level (0 black … 1 white) or an (r, g, b) triple of 0…1.
Color = Any
#: Bezier factor of a quarter circle.
_KAPPA = 0.5523


def _color(c: Color) -> str:
    if isinstance(c, (int, float)):
        return f"{float(c):.3f} {float(c):.3f} {float(c):.3f}"
    r, g, b = c
    return f"{r:.3f} {g:.3f} {b:.3f}"


class _Canvas:
    """
    One page's content stream, in a top-left coordinate system (y grows down).

    Text, rectangles and lines as before, and the vector shapes the designed report draws
    (app/services/report_design.py): rounded rectangles, polygons, polylines, circles, ring
    segments, clipping, and form XObjects (the R2M pixel logo).
    """

    def __init__(self, page_h: float):
        self.page_h = page_h
        self.ops: List[str] = []

    # ── Points and paths ──

    def _p(self, x: float, y: float) -> str:
        return f"{x:.2f} {self.page_h - y:.2f}"

    def _paint(self, path: str, fill: Optional[Color], stroke: Optional[Color], width: float) -> None:
        if fill is None and stroke is None:
            return
        parts = ["q"]
        if fill is not None:
            parts.append(f"{_color(fill)} rg")
        if stroke is not None:
            parts.append(f"{_color(stroke)} RG {width:.2f} w 1 j 1 J")
        parts.append(path)
        parts.append("B" if fill is not None and stroke is not None else ("f" if fill is not None else "S"))
        parts.append("Q")
        self.ops.append(" ".join(parts))

    def round_rect_path(self, x: float, y: float, w: float, h: float, r: float) -> str:
        r = max(0.0, min(r, w / 2, h / 2))
        if r <= 0.01:
            return f"{x:.2f} {self.page_h - y - h:.2f} {w:.2f} {h:.2f} re"
        k = _KAPPA * r
        p = self._p
        return " ".join([
            f"{p(x + r, y)} m",
            f"{p(x + w - r, y)} l",
            f"{p(x + w - r + k, y)} {p(x + w, y + r - k)} {p(x + w, y + r)} c",
            f"{p(x + w, y + h - r)} l",
            f"{p(x + w, y + h - r + k)} {p(x + w - r + k, y + h)} {p(x + w - r, y + h)} c",
            f"{p(x + r, y + h)} l",
            f"{p(x + r - k, y + h)} {p(x, y + h - r + k)} {p(x, y + h - r)} c",
            f"{p(x, y + r)} l",
            f"{p(x, y + r - k)} {p(x + r - k, y)} {p(x + r, y)} c h",
        ])

    # ── Shapes ──

    def rect(self, x: float, y: float, w: float, h: float, gray: Color) -> None:
        op = "g" if isinstance(gray, (int, float)) else "rg"
        value = f"{float(gray):.3f}" if op == "g" else _color(gray)
        self.ops.append(f"{value} {op} {x:.2f} {self.page_h - y - h:.2f} {w:.2f} {h:.2f} re f")

    def line(self, x1: float, y1: float, x2: float, y2: float, gray: Color = 0.75, width: float = 0.5) -> None:
        op = "G" if isinstance(gray, (int, float)) else "RG"
        value = f"{float(gray):.3f}" if op == "G" else _color(gray)
        self.ops.append(
            f"{value} {op} {width:.2f} w {x1:.2f} {self.page_h - y1:.2f} m {x2:.2f} {self.page_h - y2:.2f} l S"
        )

    def round_rect(self, x: float, y: float, w: float, h: float, r: float, *, fill: Optional[Color] = None,
                   stroke: Optional[Color] = None, width: float = 0.6) -> None:
        self._paint(self.round_rect_path(x, y, w, h, r), fill, stroke, width)

    def polygon(self, points: Sequence[Tuple[float, float]], *, fill: Optional[Color] = None,
                stroke: Optional[Color] = None, width: float = 0.6) -> None:
        if len(points) < 2:
            return
        path = " ".join([f"{self._p(*points[0])} m"] + [f"{self._p(*pt)} l" for pt in points[1:]]) + " h"
        self._paint(path, fill, stroke, width)

    def polyline(self, points: Sequence[Tuple[float, float]], color: Color, width: float = 1.0) -> None:
        if len(points) < 2:
            return
        path = " ".join([f"{self._p(*points[0])} m"] + [f"{self._p(*pt)} l" for pt in points[1:]])
        self._paint(path, None, color, width)

    def circle(self, cx: float, cy: float, r: float, *, fill: Optional[Color] = None,
               stroke: Optional[Color] = None, width: float = 0.6) -> None:
        self._paint(self.round_rect_path(cx - r, cy - r, 2 * r, 2 * r, r), fill, stroke, width)

    def _arc(self, cx: float, cy: float, r: float, a0: float, a1: float, move: bool) -> List[str]:
        """An arc from angle a0 to a1 (radians, counter-clockwise on the page, 0 = east)."""
        out: List[str] = []
        steps = max(1, int(math.ceil(abs(a1 - a0) / (math.pi / 2) - 1e-9)))
        delta = (a1 - a0) / steps
        k = 4.0 / 3.0 * math.tan(delta / 4.0)
        base = self.page_h - cy  # the centre in PDF coordinates (y up)

        def pt(a: float) -> Tuple[float, float]:
            return cx + r * math.cos(a), base + r * math.sin(a)

        start = pt(a0)
        if move:
            out.append(f"{start[0]:.2f} {start[1]:.2f} m")
        else:
            out.append(f"{start[0]:.2f} {start[1]:.2f} l")
        a = a0
        for _ in range(steps):
            b = a + delta
            p0, p3 = pt(a), pt(b)
            c1 = (p0[0] - k * r * math.sin(a), p0[1] + k * r * math.cos(a))
            c2 = (p3[0] + k * r * math.sin(b), p3[1] - k * r * math.cos(b))
            out.append(f"{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p3[0]:.2f} {p3[1]:.2f} c")
            a = b
        return out

    def ring_segment(self, cx: float, cy: float, r_out: float, r_in: float, a0: float, a1: float,
                     fill: Color) -> None:
        """A donut slice from a0 to a1 (radians, counter-clockwise; a clockwise slice has a1 < a0)."""
        parts = self._arc(cx, cy, r_out, a0, a1, True)
        if r_in > 0:
            parts += self._arc(cx, cy, r_in, a1, a0, False)
        else:
            parts.append(f"{cx:.2f} {self.page_h - cy:.2f} l")
        self._paint(" ".join(parts) + " h", fill, None, 0)

    # ── State ──

    def save(self) -> None:
        self.ops.append("q")

    def restore(self) -> None:
        self.ops.append("Q")

    def clip_round_rect(self, x: float, y: float, w: float, h: float, r: float) -> None:
        """Clip what follows (until `restore`) to a rounded rectangle; call `save` first."""
        self.ops.append(f"{self.round_rect_path(x, y, w, h, r)} W n")

    # ── Text and pictures ──

    def text(self, font: _Font, size: float, x: float, baseline: float, visual_text: str, gray: Color = 0.1) -> None:
        if not visual_text:
            return
        op = "g" if isinstance(gray, (int, float)) else "rg"
        value = f"{float(gray):.3f}" if op == "g" else _color(gray)
        self.ops.append(
            f"BT /{font.resource} {size:.2f} Tf {value} {op} 1 0 0 1 {x:.2f} {self.page_h - baseline:.2f} Tm "
            f"<{font.encode(visual_text)}> Tj ET"
        )

    def text_in(self, font: _Font, size: float, left: float, right: float, baseline: float, visual_text: str,
                anchor: str, gray: Color = 0.1, width: Optional[float] = None) -> None:
        w = font.width(visual_text, size) if width is None else width
        if anchor == "left":
            x = left
        elif anchor == "center":
            x = (left + right - w) / 2
        else:
            x = right - w
        self.text(font, size, x, baseline, visual_text, gray)

    def image(self, name: str, x: float, y: float, w: float, h: float) -> None:
        self.ops.append(f"q {w:.2f} 0 0 {h:.2f} {x:.2f} {self.page_h - y - h:.2f} cm /{name} Do Q")

    def form(self, name: str, x: float, y: float, w: float, h: float, unit_w: float, unit_h: float,
             fill: Optional[Color] = None) -> None:
        """A form XObject whose box is unit_w × unit_h, drawn into (x, y, w, h), in `fill`."""
        color = f"{_color(fill)} rg " if fill is not None else ""
        self.ops.append(
            f"q {color}{w / unit_w:.4f} 0 0 {h / unit_h:.4f} {x:.2f} {self.page_h - y - h:.2f} cm /{name} Do Q"
        )

    def stream(self) -> bytes:
        return "\n".join(self.ops).encode("latin-1")


# ── The file ─────────────────────────────────────────────────────────────────


class _Writer:
    def __init__(self) -> None:
        self.objects: List[Optional[bytes]] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def put(self, num: int, body: bytes) -> None:
        self.objects[num - 1] = body

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def stream(self, dictionary: str, data: bytes, *, compress: bool = True) -> int:
        if compress:
            data = zlib.compress(data, 6)
            dictionary = f"{dictionary} /Filter /FlateDecode"
        return self.add(f"<< {dictionary} /Length {len(data)} >>\nstream\n".encode("latin-1") + data + b"\nendstream")

    def output(self, root: int, info: int) -> bytes:
        out = io.BytesIO()
        out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objects, start=1):
            offsets.append(out.tell())
            out.write(f"{i} 0 obj\n".encode("latin-1"))
            out.write(body or b"null")
            out.write(b"\nendobj\n")
        xref = out.tell()
        out.write(f"xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n".encode("latin-1"))
        for off in offsets:
            out.write(f"{off:010d} 00000 n \n".encode("latin-1"))
        out.write(
            f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n".encode("latin-1")
        )
        return out.getvalue()


def _pdf_text(text: str) -> str:
    """A PDF text string (UTF-16BE with BOM, hex)."""
    return "<FEFF" + clean(text).encode("utf-16-be").hex().upper() + ">"


def _font_objects(w: _Writer, font: _Font, type0: int) -> None:
    ttf = font.ttf
    s = 1000.0 / ttf.units
    file_num = w.stream(f"/Length1 {len(ttf.data)}", ttf.data)
    bbox = " ".join(str(round(v * s)) for v in ttf.bbox)
    descriptor = w.add(
        (
            f"<< /Type /FontDescriptor /FontName /{ttf.name} /Flags 32 /FontBBox [{bbox}] "
            f"/ItalicAngle {ttf.italic:.1f} /Ascent {round(ttf.ascent * s)} /Descent {round(ttf.descent * s)} "
            f"/CapHeight {round(ttf.cap_height * s)} /StemV 80 /FontFile2 {file_num} 0 R >>"
        ).encode("latin-1")
    )
    gids = sorted(font.used)
    widths = " ".join(f"{g} [{round(ttf.advances[g] * s) if g < len(ttf.advances) else 500}]" for g in gids)
    cid = w.add(
        (
            f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{ttf.name} "
            f"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            f"/FontDescriptor {descriptor} 0 R /DW 500 /W [{widths}] /CIDToGIDMap /Identity >>"
        ).encode("latin-1")
    )
    entries = [(g, font.used[g]) for g in gids]
    chunks = []
    for start in range(0, len(entries), 100):
        part = entries[start:start + 100]
        body = "\n".join(f"<{g:04X}> <{(chr(u).encode('utf-16-be')).hex().upper()}>" for g, u in part)
        chunks.append(f"{len(part)} beginbfchar\n{body}\nendbfchar")
    cmap = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        + "\n".join(chunks)
        + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
    )
    to_unicode = w.stream("", cmap.encode("latin-1"))
    w.put(
        type0,
        (
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{ttf.name} /Encoding /Identity-H "
            f"/DescendantFonts [{cid} 0 R] /ToUnicode {to_unicode} 0 R >>"
        ).encode("latin-1"),
    )


def _logo_object(w: _Writer, image: Any, box: Tuple[float, float]) -> int:
    img = image.convert("RGB")
    # Three pixels per point: sharp on paper, small in the file.
    target = (max(1, int(box[0] * 3)), max(1, int(box[1] * 3)))
    if img.size[0] > target[0] or img.size[1] > target[1]:
        img = img.resize(target)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    data = buf.getvalue()
    return w.stream(
        f"/Type /XObject /Subtype /Image /Width {img.size[0]} /Height {img.size[1]} "
        "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        data,
        compress=False,
    )


def render(report: Report) -> bytes:
    """The report as PDF bytes: the designed layout (app/services/report_design.py), its table only."""
    from app.services import report_design

    return report_design.render_document(report_design.document_from_report(report))


def page_count(pdf: bytes) -> int:
    """The `/Count` of the page tree (tests, and a sanity check)."""
    m = re.search(rb"/Type /Pages /Kids \[[^\]]*\] /Count (\d+)", pdf)
    return int(m.group(1)) if m else 0


# ── The logo ─────────────────────────────────────────────────────────────────


def company_logo(db, company) -> Any:
    """The business's logo (`brandLogoUrl`, else the receipt's), as a PIL image; None if none."""
    from app.models.tenant import Tenant
    from app.services.settings_merge import merge_all_settings_layers

    try:
        tenant = db.get(Tenant, company.tenant_id) if getattr(company, "tenant_id", None) else None
        merged = merge_all_settings_layers(company, None, tenant)
    except Exception:  # noqa: BLE001 — a report without its logo beats no report
        return None
    for key in ("brandLogoUrl", "brandReceiptLogoUrl"):
        url = merged.get(key)
        if isinstance(url, str) and url.strip():
            image = load_logo(url.strip())
            if image is not None:
                return image
    return None


_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def accent_color(value: Any) -> Optional[Tuple[float, float, float]]:
    """`#RRGGBB` (the branding page's `brandPrimaryColor`) as an RGB triple; None if not one."""
    m = _HEX.match(value.strip()) if isinstance(value, str) else None
    if not m:
        return None
    raw = m.group(1)
    return tuple(int(raw[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def company_branding(db, company) -> Dict[str, Any]:
    """
    What the designed report takes from the business: `logo` (a PIL image or None), `accent`
    (the branding page's colour, or None for the default blue) and `name`.
    """
    from app.models.tenant import Tenant
    from app.services.settings_merge import merge_all_settings_layers

    out: Dict[str, Any] = {"logo": None, "accent": None, "name": getattr(company, "name", None) or ""}
    try:
        tenant = db.get(Tenant, company.tenant_id) if getattr(company, "tenant_id", None) else None
        merged = merge_all_settings_layers(company, None, tenant)
    except Exception:  # noqa: BLE001 — a report without its branding beats no report
        return out
    out["accent"] = accent_color(merged.get("brandPrimaryColor"))
    for key in ("brandLogoUrl", "brandReceiptLogoUrl"):
        url = merged.get(key)
        if isinstance(url, str) and url.strip():
            image = load_logo(url.strip())
            if image is not None:
                out["logo"] = image
                break
    return out


def load_logo(url: str) -> Any:
    """Our own media or an https image (as the branding settings allow); None on any failure."""
    from app.services.business_card_resolve import is_safe_media_url

    if not is_safe_media_url(url):
        return None
    from app.services.prepaid_voucher_pdf import load_logo as _load

    return _load(url)


def file_name(name: str) -> str:
    cleaned = "".join("_" if ch in '\\/:*?"<>|' else ch for ch in clean(name)).strip(" .")
    cleaned = cleaned[:150] or "report"
    return cleaned if cleaned.lower().endswith(".pdf") else f"{cleaned}.pdf"
