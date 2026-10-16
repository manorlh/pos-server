"""
The designed report PDF (P:/specs/reports-designed-pdf.md §1, §5, §9): one design language for
every report the dashboard exports, drawn with vector shapes only — no new package. Light and
clean (§9, the owner 16.10: "הדוחות המעוצבים ... שחורים ונראים לא טוב"): a white page, and the
look's tokens in app/services/report_theme.py.

A `Document` is a header (title, period, scope, key facts, filters, logos) and a list of blocks,
laid out top to bottom over A4 pages (`render_document`). The building blocks, shared by every
report (`POST /reports/pdf`, "סיכום יום", "מכירות מוצרים לפי ימים"):

* **Header band** — the first page's top, full width, navy → bright blue with rounded bottom
  corners: the title and a sub-title, a row of key facts (`Document.facts`), the business logo
  on a white plate at the right and the R2M pixel logo white at the left. Continuation pages
  carry a thin strip, the title and the R2M mark.
* **Section bar** (`Section`) — a rounded navy bar with a small icon and the section's name;
  **sub-heading** (`Heading`) — bold, over a thin light rule.
* **KPI cards** (`KpiBlock`) — white, a thin grey border, a coloured strip at the start (right)
  edge by the figure, a big bold number, a small grey line under it (the change chip ▲/▼ and
  what it is against, or the card's own `sub`), a sparkline.
* **Callouts** (`InsightBlock`, `Note`) — soft pastel boxes by tone: yellow for what to check,
  green for what works, blue for advice; numbers bold inline; a short "איך לקרוא" line.
* **Reconciliation** (`ReconBlock`) — equal cards of the same money in different layers, and a
  pill per check: ✓ תואם (green), פער (red), ממתין (yellow).
* **Charts** (`ChartBlock`) — bars, horizontal bars, a donut or a line, in white cards.
* **Tables** (`Table`) — a navy header row, white / very light zebra rows, bold subtotal and
  total rows, numbers at the start (right) with ₪, a share column's cyan → blue bar, trend
  arrows; a table breaks across pages only between rows, its header repeated, never its header
  alone at a page's foot nor its totals alone at the next page's top.
* **Footer** on every page — "הופק ממערכת R2M · when · by whom", "עמוד X מתוך Y", the business.
* **Cover page** when the body runs past three pages: the band, the title, the facts and the
  four main KPIs.

Nothing is cut in half: a card row, a callout, a chart or a reconciliation moves whole to the
next page. Everything that tells good from bad has a shape as well as a colour (▲/▼, ✓, icons),
so the report still reads printed in black and white. Hebrew is laid out right to left
(`report_pdf.visual`).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services import report_pdf as P
from app.services import report_theme as T
from app.services.report_theme import RGB, hex_rgb, mix  # noqa: F401 — re-exported

WHITE = T.WHITE
INK, TEXT2, MUTED, FAINT = T.INK, T.TEXT2, T.MUTED, T.FAINT
DEFAULT_ACCENT = T.DEFAULT_ACCENT
INSIGHT_TYPES = ("leader", "up", "down", "alert", "tip")

#: The R2M logo (client/public/icons/icon-512.png): 17 × 7 pixels of 18 px each.
R2M_PIXELS = (
    "####...###..#...#",
    "#...#.#...#.##.##",
    "#...#.....#.#.#.#",
    "####.....#..#.#.#",
    "#.#.....#...#...#",
    "#..#...#....#...#",
    "#...#.#####.#...#",
)
R2M_W, R2M_H = 17, 7

MARGIN = T.MARGIN
FOOTER_ZONE = T.FOOTER_ZONE
GAP = T.GAP
HEADING_H = T.HEADING_H
#: The largest box a business logo is drawn in (the cover's); embedded at 3 px per point.
LOGO_BOX = (150.0, 70.0)
HEADER_LOGO_MAX = (96.0, 46.0)
#: The table body pages above which a cover page is added (`cover: auto`).
COVER_AFTER_PAGES = 3
#: A share column's bar: the room it adds to the column.
BAR_ROOM = 64.0
#: A table's header never stands with fewer rows than this (at a page's foot, or at the next
#: page's top before the totals); a table of up to `SHORT_TABLE` rows is never broken.
KEEP_ROWS = 3
SHORT_TABLE = 12

#: The page resources' axial shadings (left → right): the band, the section bars, the data bars.
SH_BAND, SH_SECTION, SH_DATA = "GBand", "GSection", "GData"

ICONS = (
    "sales", "receipt", "basket", "items", "users", "user", "refund", "void", "discount", "gift", "tip", "clock",
    "card", "cash", "table", "alert", "star", "box", "chart", "percent", "kiosk", "voucher", "target", "calendar",
)
#: A KPI key's words → its icon, first match wins.
ICON_BY_KEY = (
    ("refund", "refund"), ("credit", "refund"), ("void", "void"), ("cancel", "void"), ("discount", "discount"),
    ("oth", "gift"), ("tip", "tip"), ("cover", "users"), ("guest", "users"), ("staff", "users"),
    ("percover", "users"), ("item", "items"), ("unit", "items"), ("qty", "items"), ("quantit", "items"),
    ("document", "receipt"), ("transaction", "receipt"), ("receipt", "receipt"), ("order", "receipt"),
    ("count", "receipt"), ("average", "basket"), ("avg", "basket"), ("ticket", "basket"), ("basket", "basket"),
    ("cash", "cash"), ("card", "card"), ("table", "table"), ("hour", "clock"), ("time", "clock"),
    ("minute", "clock"), ("kiosk", "kiosk"), ("voucher", "voucher"), ("target", "target"), ("goal", "target"),
    ("percent", "percent"), ("share", "percent"), ("rate", "percent"), ("employee", "user"), ("cashier", "user"),
    ("waiter", "user"), ("day", "calendar"), ("exception", "alert"), ("alert", "alert"), ("risk", "alert"),
    ("product", "box"), ("stock", "box"), ("net", "sales"), ("gross", "sales"), ("sales", "sales"),
    ("amount", "sales"), ("total", "sales"), ("revenue", "sales"),
)
#: A KPI or column key with one of these is better when it goes down.
DOWN_WORDS = (
    "refund", "void", "discount", "oth", "cancel", "variance", "failed", "untransmitted", "declined", "shortage",
    "abandon", "gap", "exception", "drawer", "loss", "waste", "difference", "late",
)


def better_of(key: str, given: Optional[str] = None) -> str:
    if given in ("up", "down"):
        return given
    k = (key or "").lower()
    return "down" if any(w in k for w in DOWN_WORDS) else "up"


#: "מול" at the start of a comparison's label ("מול 01.10–07.10", "מול-שבוע שעבר").
_AGAINST = re.compile(r"^\s*מול(?:[\s\-־]+|$)")


def compared_with(label: Optional[str], default: str = "התקופה הקודמת") -> str:
    """
    What a figure is compared with, for a sentence that already says "מול": the label without a
    "מול" of its own — the dashboard's label is "מול 01.10–07.10", and "מול מול …" is wrong.
    """
    text = _AGAINST.sub("", P.clean(label or "")).strip()
    return text or default


def icon_of(key: str, given: Optional[str] = None) -> str:
    if given in ICONS:
        return given  # type: ignore[return-value]
    k = (key or "").lower().replace("_", "").replace("-", "")
    for word, icon in ICON_BY_KEY:
        if word in k:
            return icon
    return "chart"


# ── Numbers as words on the page ─────────────────────────────────────────────


def _float(value: Any) -> Optional[float]:
    d = P._num(value)
    return float(d) if d is not None else None


def format_value(value: Any, kind: str, *, short: bool = False) -> str:
    """A figure for a card or a sentence: money whole above ₪10,000 (and ₪100 when `short`)."""
    if kind == "text":
        return P.clean(value) if value not in (None, "") else P.DASH
    v = _float(value)
    if v is None:
        return P.DASH if value in (None, "") else P.clean(value)
    if kind == "money":
        if abs(v) >= (100 if short else 10_000) or (short and v == int(v)):
            whole = int(round(v))
            return f"₪ {whole:,}"
        return P.format_money(v)
    if kind == "percent":
        return P.format_percent(round(v, 1))
    if kind == "duration":
        total = int(round(v))
        sign = "-" if total < 0 else ""
        total = abs(total)
        h, rest = divmod(total, 3600)
        m, s = divmod(rest, 60)
        return f"{sign}{h}:{m:02d}:{s:02d}" if h else f"{sign}{m}:{s:02d}"
    return P.format_number(round(v, 2))


def compact(value: float, kind: str = "number") -> str:
    """An axis label: 950, 1.2K, 15K, 1.3M (₪ in front of money)."""
    v = float(value)
    a = abs(v)
    if a >= 1_000_000:
        text = f"{v / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    elif a >= 10_000:
        text = f"{v / 1000:.0f}K"
    elif a >= 1000:
        text = f"{v / 1000:.1f}".rstrip("0").rstrip(".") + "K"
    elif a >= 10 or v == int(v):
        text = f"{v:.0f}"
    else:
        text = f"{v:.1f}"
    if kind == "percent":
        return text + "%"
    if kind == "money":
        return "₪" + text
    return text


def nice_ceiling(value: float) -> float:
    """The round number at or above `value` an axis ends on (1, 2, 2.5, 5 × 10ⁿ)."""
    if value <= 0:
        return 1.0
    exp = math.floor(math.log10(value))
    base = 10 ** exp
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * base >= value * 0.999:
            return m * base
    return 10 * base


# ── What a document is made of ───────────────────────────────────────────────


@dataclass
class Kpi:
    key: str
    label: str
    value: Any
    kind: str = "number"
    compare: Optional[float] = None
    compare_label: str = ""
    spark: List[float] = field(default_factory=list)
    better: str = "up"
    icon: str = "chart"
    #: A small grey line under the number ("70.9%", "4 זיכויים", "ממוצע ₪ 39.26").
    sub: str = ""

    @property
    def number(self) -> Optional[float]:
        return _float(self.value)

    @property
    def change_pct(self) -> Optional[float]:
        n, c = self.number, self.compare
        if n is None or c is None or c == 0:
            return None
        return (n - c) / abs(c) * 100.0

    @property
    def direction(self) -> Optional[str]:
        n, c = self.number, self.compare
        if n is None or c is None:
            return None
        if abs(n - c) < 1e-9:
            return "flat"
        pct = self.change_pct
        if pct is not None and abs(pct) < 0.5:
            return "flat"
        return "up" if n > c else "down"

    @property
    def good(self) -> Optional[bool]:
        d = self.direction
        if d in (None, "flat"):
            return None
        return (d == "up") == (self.better != "down")

    def display(self, short: bool = False) -> str:
        return format_value(self.value, self.kind, short=short)

    def compare_display(self) -> Optional[str]:
        return format_value(self.compare, self.kind) if self.compare is not None else None

    def chip_text(self) -> Optional[str]:
        d = self.direction
        if d is None:
            return None
        if self.compare == 0:
            return "חדש" if (self.number or 0) != 0 else "0%"
        pct = abs(self.change_pct or 0.0)
        return f"{pct:.0f}%" if pct >= 100 else f"{pct:.1f}%"

    def as_json(self) -> Dict[str, Any]:
        pct = self.change_pct
        return {
            "key": self.key, "label": self.label, "kind": self.kind, "value": self.value,
            "display": self.display(), "compare": self.compare, "compareDisplay": self.compare_display(),
            "compareLabel": self.compare_label or None,
            "changePct": round(pct, 2) if pct is not None else None,
            "direction": self.direction, "good": self.good,
        }


def kpi_of(raw: Dict[str, Any]) -> Kpi:
    """A KPI from the request's JSON (§7.1)."""
    key = P.clean(raw.get("key") or "")[:64]
    compare = raw.get("compare")
    compare_label = P.clean(raw.get("compareLabel") or "")
    if isinstance(compare, dict):
        compare_label = compare_label or P.clean(compare.get("label") or "")
        compare = compare.get("value")
    kind = raw.get("kind") if raw.get("kind") in ("money", "number", "percent", "text", "duration") else "number"
    spark = [v for v in (_float(x) for x in (raw.get("spark") or [])[:31]) if v is not None]
    return Kpi(
        key=key,
        label=P.clean(raw.get("label") or key)[:80],
        value=raw.get("value"),
        kind=kind,
        compare=_float(compare),
        compare_label=compare_label[:60],
        spark=spark,
        better=better_of(key, raw.get("better")),
        icon=icon_of(key, raw.get("icon")),
        sub=P.clean(raw.get("sub") or "")[:80],
    )


@dataclass
class Insight:
    type: str
    text: str

    def as_json(self) -> Dict[str, str]:
        return {"type": self.type, "text": self.text}


@dataclass
class Series:
    name: str
    values: List[float]


@dataclass
class Chart:
    type: str
    labels: List[str]
    series: List[Series]
    title: str = ""
    kind: str = "number"

    def as_json(self) -> Dict[str, Any]:
        return {
            "type": self.type, "title": self.title, "labels": list(self.labels), "kind": self.kind,
            "series": [{"name": s.name, "values": list(s.values)} for s in self.series],
        }


CHART_TYPES = ("bar", "hbar", "donut", "line")
MAX_CHART_LABELS = 48


def chart_of(raw: Dict[str, Any]) -> Optional[Chart]:
    """A chart from the request's JSON (§7.1), or None when it has nothing to draw."""
    if not isinstance(raw, dict) or raw.get("type") not in CHART_TYPES:
        return None
    labels = [P.clean(x)[:40] for x in (raw.get("labels") or [])[:MAX_CHART_LABELS]]
    series = []
    for s in (raw.get("series") or [])[:3]:
        if not isinstance(s, dict):
            continue
        values = [(_float(v) or 0.0) for v in (s.get("values") or [])[:MAX_CHART_LABELS]]
        values += [0.0] * (len(labels) - len(values))
        series.append(Series(name=P.clean(s.get("name") or "")[:40], values=values[:len(labels)]))
    if not labels or not series:
        return None
    kind = raw.get("kind") if raw.get("kind") in ("money", "number", "percent") else "number"
    return Chart(type=raw["type"], labels=labels, series=series, title=P.clean(raw.get("title") or "")[:80], kind=kind)


@dataclass
class KpiBlock:
    kpis: List[Kpi]
    title: str = ""


@dataclass
class InsightBlock:
    insights: List[Insight]
    #: A sub-heading over the callouts ("" when a section bar already names them).
    title: str = ""
    #: The "איך לקרוא" line under them; None: made from the tones shown; "": none.
    how_to_read: Optional[str] = None


@dataclass
class ChartBlock:
    charts: List[Chart]
    height: Optional[float] = None


@dataclass
class Section:
    """A section bar: the report's chapters ("תמונת מצב", "מה חשוב לדעת", "הפירוט המלא")."""
    text: str
    icon: str = "chart"
    new_page: bool = False


@dataclass
class Heading:
    text: str
    sub: str = ""
    new_page: bool = False


@dataclass
class Note:
    text: str
    tone: str = "muted"  # muted | info | alert


@dataclass
class ReconCard:
    label: str
    value: Any
    kind: str = "money"
    sub: str = ""
    icon: str = "sales"


@dataclass
class ReconCheck:
    label: str
    #: match | mismatch | pending | none
    status: str
    #: What the pill says after the label (default by the status: "תואם", "פער", "ממתין", "אין נתונים").
    text: str = ""


RECON_STATUS_TEXT = {"match": "תואם", "mismatch": "פער", "pending": "ממתין", "none": "אין נתונים"}


@dataclass
class ReconBlock:
    """The same money in two to four layers, side by side, and whether they agree."""
    cards: List[ReconCard]
    checks: List[ReconCheck] = field(default_factory=list)
    title: str = "התאמה"
    note: str = ""


def recon_of(raw: Dict[str, Any]) -> Optional[ReconBlock]:
    """A reconciliation from the request's JSON (§9.2), or None when it has no cards."""
    if not isinstance(raw, dict):
        return None
    cards = []
    for c in (raw.get("cards") or [])[:4]:
        if not isinstance(c, dict) or not P.clean(c.get("label") or ""):
            continue
        kind = c.get("kind") if c.get("kind") in ("money", "number", "percent", "text") else "money"
        cards.append(ReconCard(label=P.clean(c["label"])[:60], value=c.get("value"), kind=kind,
                               sub=P.clean(c.get("sub") or "")[:80], icon=icon_of("", c.get("icon")) if c.get("icon") else "sales"))
    if not cards:
        return None
    checks = []
    for k in (raw.get("checks") or [])[:4]:
        if not isinstance(k, dict) or not P.clean(k.get("label") or ""):
            continue
        status = k.get("status") if k.get("status") in RECON_STATUS_TEXT else "none"
        checks.append(ReconCheck(label=P.clean(k["label"])[:60], status=status, text=P.clean(k.get("text") or "")[:60]))
    return ReconBlock(cards=cards, checks=checks, title=P.clean(raw.get("title") or "")[:80] or "התאמה",
                      note=P.clean(raw.get("note") or "")[:300])


@dataclass
class PageBreak:
    pass


@dataclass
class Table:
    columns: List[P.Column]
    rows: List[List[str]]
    #: Per row: "row" or "sub" (a group's subtotal). None: all rows.
    styles: Optional[List[str]] = None
    totals: Optional[List[str]] = None
    title: str = ""
    subtitle: str = ""
    empty_text: str = P.NO_ROWS
    #: Per row, which way its trend cells are good ("up" / "down"); None: the column's.
    row_better: Optional[List[str]] = None


@dataclass
class Document:
    title: str
    period: str = ""
    scope: str = ""
    #: The band's line under the title; "": the business's name when there are `facts` (they
    #: carry the period and the scope), else the period and the scope.
    subtitle: str = ""
    #: The band's key facts, right to left: (label, value) — "תאריך", "שעות", "קופות"…
    facts: List[Tuple[str, str]] = field(default_factory=list)
    #: More lines under the band (a report's further sub-titles), before the filters.
    extra_lines: List[str] = field(default_factory=list)
    filter_lines: List[str] = field(default_factory=list)
    generated_at: str = ""
    generated_by: str = ""
    business_name: str = ""
    logo: Any = None
    accent: RGB = DEFAULT_ACCENT
    orientation: str = "auto"
    cover: str = "auto"
    cover_kpis: Optional[List[Kpi]] = None
    blocks: List[Any] = field(default_factory=list)


def now_label(tz_name: str = "Asia/Jerusalem", now: Optional[datetime] = None) -> str:
    from zoneinfo import ZoneInfo

    try:
        zone = ZoneInfo(tz_name)
    except Exception:  # noqa: BLE001
        zone = timezone.utc
    return (now or datetime.now(timezone.utc)).astimezone(zone).strftime("%d.%m.%Y %H:%M")


def document_from_report(report: P.Report) -> Document:
    """The plain table report (`report_pdf.build_report`) as a designed document: its table only."""
    subs = list(report.subtitle_lines)
    return Document(
        title=report.title,
        period=subs[0] if subs else "",
        scope=subs[1] if len(subs) > 1 else "",
        extra_lines=subs[2:],
        filter_lines=list(report.filter_lines),
        generated_at=report.generated.replace("הופק:", "").strip(),
        logo=report.logo,
        orientation=report.orientation,
        blocks=[Table(columns=report.columns, rows=report.rows, totals=report.totals)],
    )


# ── Groups and subtotals ─────────────────────────────────────────────────────


def grouped_rows(columns: Sequence[P.Column], rows: Sequence[Sequence[str]], group_by: Sequence[str]
                 ) -> Tuple[List[List[str]], List[str]]:
    """
    The rows grouped by `group_by` (column keys, outer first) in the order each group first
    appears, the group's value shown on its first row only, and a subtotal row ("סה״כ <value>")
    after each group summing its `sums` columns. Returns (rows, styles).
    """
    index = {c.key: i for i, c in enumerate(columns)}
    levels = [index[k] for k in group_by if k in index][:3]
    if not levels:
        return [list(r) for r in rows], ["row"] * len(rows)
    sums = [c.sums for c in columns]

    def total_of(members: Sequence[Sequence[str]]) -> List[str]:
        out = [""] * len(columns)
        for i, c in enumerate(columns):
            if not sums[i]:
                continue
            acc = 0.0
            seen = False
            for r in members:
                v = _float(r[i]) if i < len(r) else None
                if v is not None:
                    acc += v
                    seen = True
            if seen:
                out[i] = P.format_cell(round(acc, 3), c.kind)
        return out

    out_rows: List[List[str]] = []
    styles: List[str] = []

    def walk(members: List[Sequence[str]], depth: int) -> None:
        col = levels[depth]
        order: List[str] = []
        groups: Dict[str, List[Sequence[str]]] = {}
        for r in members:
            key = r[col] if col < len(r) else ""
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(r)
        for key in order:
            group = groups[key]
            if depth + 1 < len(levels):
                start = len(out_rows)
                walk(group, depth + 1)
                # The outer value on the group's first row only.
                for j in range(start, len(out_rows)):
                    if styles[j] == "row":
                        out_rows[j][col] = key if j == start else ""
            else:
                for j, r in enumerate(group):
                    row = list(r) + [""] * (len(columns) - len(r))
                    for d in levels[:depth + 1]:
                        if j:
                            row[d] = ""
                    out_rows.append(row)
                    styles.append("row")
            sub = total_of(group)
            sub[col] = f"{P.TOTAL_LABEL} {key}".strip()
            out_rows.append(sub)
            styles.append("sub")

    walk([list(r) for r in rows], 0)
    return out_rows, styles


# ── Icons ────────────────────────────────────────────────────────────────────


def draw_icon(c: P._Canvas, name: str, cx: float, cy: float, s: float, color: RGB, bg: RGB,
              regular: P._Font, bold: P._Font) -> None:
    """A small vector glyph `s` points wide centred on (cx, cy), in `color` over `bg`."""
    h = s / 2.0
    lw = max(0.7, s * 0.11)

    def glyph(text: str, scale: float = 1.0) -> None:
        size = s * scale
        w = bold.width(text, size)
        c.text(bold, size, cx - w / 2, cy + size * 0.36, text, color)

    if name in ("sales", "tip"):
        if name == "tip":
            c.circle(cx, cy, h * 0.95, stroke=color, width=lw)
            glyph("₪", 0.62)
        else:
            glyph("₪", 1.0)
    elif name in ("discount", "percent"):
        glyph("%", 0.95)
    elif name in ("receipt", "list"):
        c.round_rect(cx - h * 0.62, cy - h * 0.85, h * 1.24, h * 1.7, h * 0.15, stroke=color, width=lw)
        for k in (-0.4, 0.0, 0.4):
            c.line(cx - h * 0.35, cy + h * k, cx + h * 0.35, cy + h * k, color, lw * 0.8)
    elif name == "basket":
        c.polygon([(cx - h * 0.95, cy - h * 0.15), (cx + h * 0.95, cy - h * 0.15), (cx + h * 0.65, cy + h * 0.8),
                   (cx - h * 0.65, cy + h * 0.8)], fill=color)
        c.polyline([(cx - h * 0.55, cy - h * 0.15), (cx - h * 0.2, cy - h * 0.85)], color, lw)
        c.polyline([(cx + h * 0.55, cy - h * 0.15), (cx + h * 0.2, cy - h * 0.85)], color, lw)
    elif name in ("items", "box"):
        if name == "box":
            c.round_rect(cx - h * 0.8, cy - h * 0.7, h * 1.6, h * 1.5, h * 0.12, stroke=color, width=lw)
            c.line(cx - h * 0.8, cy - h * 0.2, cx + h * 0.8, cy - h * 0.2, color, lw)
            c.line(cx, cy - h * 0.7, cx, cy - h * 0.2, color, lw)
        else:
            q = h * 0.78
            c.round_rect(cx - q - 0.4, cy + 0.4, q, q, q * 0.15, fill=color)
            c.round_rect(cx + 0.4, cy + 0.4, q, q, q * 0.15, fill=color)
            c.round_rect(cx - q / 2, cy - q - 0.4, q, q, q * 0.15, fill=color)
    elif name in ("users", "user"):
        if name == "users":
            c.circle(cx + h * 0.42, cy - h * 0.38, h * 0.3, fill=color)
            c.round_rect(cx - h * 0.05, cy + h * 0.05, h * 0.95, h * 0.7, h * 0.32, fill=color)
            c.circle(cx - h * 0.42, cy - h * 0.38, h * 0.3, fill=color)
            c.round_rect(cx - h * 0.9, cy + h * 0.05, h * 0.95, h * 0.7, h * 0.32, fill=color)
        else:
            c.circle(cx, cy - h * 0.4, h * 0.38, fill=color)
            c.round_rect(cx - h * 0.7, cy + h * 0.08, h * 1.4, h * 0.75, h * 0.35, fill=color)
    elif name == "refund":
        c.ring_segment(cx, cy, h * 0.8, h * 0.8 - lw, math.radians(200), math.radians(-60), color)
        tip_a = math.radians(200)
        tx, ty = cx + h * 0.8 * math.cos(tip_a), cy - h * 0.8 * math.sin(tip_a)
        c.polygon([(tx - h * 0.35, ty - h * 0.05), (tx + h * 0.35, ty - h * 0.05), (tx, ty + h * 0.4)], fill=color)
    elif name == "void":
        c.line(cx - h * 0.6, cy - h * 0.6, cx + h * 0.6, cy + h * 0.6, color, lw * 1.4)
        c.line(cx - h * 0.6, cy + h * 0.6, cx + h * 0.6, cy - h * 0.6, color, lw * 1.4)
    elif name == "gift":
        c.round_rect(cx - h * 0.8, cy - h * 0.3, h * 1.6, h * 1.1, h * 0.1, fill=color)
        c.rect(cx - h * 0.12, cy - h * 0.3, h * 0.24, h * 1.1, bg)
        c.polygon([(cx, cy - h * 0.35), (cx - h * 0.6, cy - h * 0.85), (cx - h * 0.6, cy - h * 0.35)], fill=color)
        c.polygon([(cx, cy - h * 0.35), (cx + h * 0.6, cy - h * 0.85), (cx + h * 0.6, cy - h * 0.35)], fill=color)
    elif name == "clock":
        c.circle(cx, cy, h * 0.85, stroke=color, width=lw)
        c.line(cx, cy, cx, cy - h * 0.5, color, lw)
        c.line(cx, cy, cx + h * 0.4, cy + h * 0.15, color, lw)
    elif name == "card":
        c.round_rect(cx - h * 0.9, cy - h * 0.6, h * 1.8, h * 1.2, h * 0.18, stroke=color, width=lw)
        c.rect(cx - h * 0.9, cy - h * 0.3, h * 1.8, h * 0.28, color)
    elif name == "cash":
        c.round_rect(cx - h * 0.95, cy - h * 0.55, h * 1.9, h * 1.1, h * 0.1, stroke=color, width=lw)
        c.circle(cx, cy, h * 0.28, fill=color)
    elif name == "table":
        c.round_rect(cx - h * 0.9, cy - h * 0.5, h * 1.8, h * 0.3, h * 0.1, fill=color)
        c.line(cx - h * 0.6, cy - h * 0.2, cx - h * 0.6, cy + h * 0.75, color, lw)
        c.line(cx + h * 0.6, cy - h * 0.2, cx + h * 0.6, cy + h * 0.75, color, lw)
    elif name == "alert":
        c.polygon([(cx, cy - h * 0.9), (cx + h * 0.95, cy + h * 0.75), (cx - h * 0.95, cy + h * 0.75)], fill=color)
        c.rect(cx - h * 0.08, cy - h * 0.35, h * 0.16, h * 0.62, bg)
        c.rect(cx - h * 0.08, cy + h * 0.4, h * 0.16, h * 0.16, bg)
    elif name == "star":
        pts = []
        for i in range(10):
            a = -math.pi / 2 + i * math.pi / 5
            r = h * 0.95 if i % 2 == 0 else h * 0.42
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        c.polygon(pts, fill=color)
    elif name == "kiosk":
        c.round_rect(cx - h * 0.5, cy - h * 0.9, h * 1.0, h * 1.6, h * 0.12, stroke=color, width=lw)
        c.rect(cx - h * 0.3, cy - h * 0.68, h * 0.6, h * 0.65, color)
        c.line(cx - h * 0.6, cy + h * 0.85, cx + h * 0.6, cy + h * 0.85, color, lw)
    elif name == "voucher":
        c.round_rect(cx - h * 0.95, cy - h * 0.55, h * 1.9, h * 1.1, h * 0.16, stroke=color, width=lw)
        for k in (-0.35, 0.0, 0.35):
            c.line(cx + h * 0.35, cy + h * k - 0.6, cx + h * 0.35, cy + h * k + 0.6, color, lw)
    elif name == "target":
        c.circle(cx, cy, h * 0.9, stroke=color, width=lw)
        c.circle(cx, cy, h * 0.5, stroke=color, width=lw)
        c.circle(cx, cy, h * 0.15, fill=color)
    elif name == "calendar":
        c.round_rect(cx - h * 0.85, cy - h * 0.65, h * 1.7, h * 1.5, h * 0.15, stroke=color, width=lw)
        c.rect(cx - h * 0.85, cy - h * 0.65, h * 1.7, h * 0.42, color)
        c.line(cx - h * 0.4, cy - h * 0.9, cx - h * 0.4, cy - h * 0.5, color, lw)
        c.line(cx + h * 0.4, cy - h * 0.9, cx + h * 0.4, cy - h * 0.5, color, lw)
    elif name == "leader":
        # A trophy: the cup, its handles, the stem and the base.
        c.polygon([(cx - h * 0.62, cy - h * 0.8), (cx + h * 0.62, cy - h * 0.8), (cx + h * 0.45, cy - h * 0.05),
                   (cx, cy + h * 0.2), (cx - h * 0.45, cy - h * 0.05)], fill=color)
        c.polyline([(cx - h * 0.6, cy - h * 0.6), (cx - h * 0.92, cy - h * 0.6), (cx - h * 0.85, cy - h * 0.25),
                    (cx - h * 0.45, cy - h * 0.12)], color, lw * 0.9)
        c.polyline([(cx + h * 0.6, cy - h * 0.6), (cx + h * 0.92, cy - h * 0.6), (cx + h * 0.85, cy - h * 0.25),
                    (cx + h * 0.45, cy - h * 0.12)], color, lw * 0.9)
        c.rect(cx - h * 0.1, cy + h * 0.15, h * 0.2, h * 0.4, color)
        c.round_rect(cx - h * 0.5, cy + h * 0.52, h * 1.0, h * 0.3, h * 0.08, fill=color)
    elif name in ("up", "down"):
        sign = -1 if name == "up" else 1  # y grows down
        pts = [(cx - h * 0.85, cy - sign * h * 0.55), (cx - h * 0.25, cy + sign * h * 0.05),
               (cx + h * 0.1, cy - sign * h * 0.25), (cx + h * 0.7, cy + sign * h * 0.45)]
        c.polyline(pts, color, lw * 1.25)
        tx, ty = pts[-1]
        c.polygon([(tx + h * 0.2, ty + sign * h * 0.2), (tx - h * 0.42, ty + sign * h * 0.05),
                   (tx + h * 0.08, ty - sign * h * 0.42)], fill=color)
    elif name in ("tip_bulb", "bulb"):
        c.circle(cx, cy - h * 0.25, h * 0.58, fill=color)
        c.rect(cx - h * 0.28, cy + h * 0.25, h * 0.56, h * 0.28, color)
        c.rect(cx - h * 0.2, cy + h * 0.6, h * 0.4, h * 0.18, color)
        c.line(cx - h * 0.1, cy - h * 0.25, cx + h * 0.1, cy - h * 0.25, bg, lw * 0.7)
    elif name == "check":
        c.polyline([(cx - h * 0.7, cy + h * 0.02), (cx - h * 0.2, cy + h * 0.5), (cx + h * 0.75, cy - h * 0.55)],
                   color, lw * 1.5)
    elif name == "cross":
        c.line(cx - h * 0.5, cy - h * 0.5, cx + h * 0.5, cy + h * 0.5, color, lw * 1.4)
        c.line(cx - h * 0.5, cy + h * 0.5, cx + h * 0.5, cy - h * 0.5, color, lw * 1.4)
    elif name == "dots":
        for k in (-0.55, 0.0, 0.55):
            c.circle(cx + h * k, cy, h * 0.16, fill=color)
    elif name == "shield":
        c.polygon([(cx, cy - h * 0.92), (cx + h * 0.78, cy - h * 0.6), (cx + h * 0.7, cy + h * 0.2),
                   (cx, cy + h * 0.92), (cx - h * 0.7, cy + h * 0.2), (cx - h * 0.78, cy - h * 0.6)], fill=color)
        c.polyline([(cx - h * 0.35, cy + h * 0.02), (cx - h * 0.08, cy + h * 0.3), (cx + h * 0.38, cy - h * 0.28)],
                   bg, lw * 1.2)
    elif name == "scale":
        c.line(cx, cy - h * 0.85, cx, cy + h * 0.7, color, lw)
        c.line(cx - h * 0.8, cy - h * 0.55, cx + h * 0.8, cy - h * 0.55, color, lw)
        c.round_rect(cx - h * 0.45, cy + h * 0.65, h * 0.9, h * 0.22, h * 0.08, fill=color)
        for sx in (-1, 1):
            px = cx + sx * h * 0.62
            c.polygon([(px - h * 0.32, cy + h * 0.05), (px + h * 0.32, cy + h * 0.05), (px, cy - h * 0.5)],
                      stroke=color, width=lw * 0.8)
            c.ring_segment(px, cy + h * 0.05, h * 0.32, 0, math.pi, 2 * math.pi, color)
    else:  # chart
        bw = h * 0.42
        for k, frac in enumerate((0.55, 1.0, 0.75)):
            bx = cx - h * 0.85 + k * (bw + h * 0.2)
            c.rect(bx, cy + h * 0.8 - h * 1.6 * frac, bw, h * 1.6 * frac, color)


INSIGHT_ICON = {"leader": "leader", "up": "up", "down": "down", "alert": "alert", "tip": "tip_bulb"}
#: A callout's title and its icon, by tone.
TONE_TITLES = {"check": ("כדאי לבדוק", "alert"), "good": ("מה עובד טוב", "up"), "tip": ("המלצות", "tip_bulb")}
TONE_WORDS = {"check": "צהוב — כדאי לבדוק", "good": "ירוק — מה שעובד טוב", "tip": "כחול — המלצה"}


# ── Rich text: numbers bold inline ───────────────────────────────────────────

#: A figure in a sentence: ₪, a sign, digits with their separators, a % — drawn bold.
_FIGURE = re.compile(r"(?:₪\s?)?[-+]?\d[\d,.:/]*%?(?:\s?₪)?")


def figure_runs(text: str) -> List[Tuple[str, bool]]:
    """`text` cut into (piece, is a figure) — the figures are drawn bold."""
    out: List[Tuple[str, bool]] = []
    pos = 0
    for m in _FIGURE.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], False))
        out.append((m.group(0), True))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], False))
    return out


# ── Layout ───────────────────────────────────────────────────────────────────


def _r2m_form(w: P._Writer) -> int:
    """The R2M pixel logo as a form XObject (17 × 7 units), in whatever fill is current."""
    ops = []
    for r, line in enumerate(R2M_PIXELS):
        c = 0
        while c < len(line):
            if line[c] != "#":
                c += 1
                continue
            start = c
            while c < len(line) and line[c] == "#":
                c += 1
            # A hair over a unit, so neighbouring pixels never show a seam.
            ops.append(f"{start} {R2M_H - 1 - r - 0.01:.2f} {c - start + 0.01:.2f} 1.02 re")
    ops.append("f")
    return w.stream(f"/Type /XObject /Subtype /Form /BBox [0 0 {R2M_W} {R2M_H}]", " ".join(ops).encode("latin-1"))


def _shading(w: P._Writer, c0: RGB, c1: RGB) -> int:
    """A left-to-right axial shading from `c0` to `c1` over 0 → 1 (`_Canvas.gradient` stretches it)."""
    a = " ".join(f"{v:.3f}" for v in c0)
    b = " ".join(f"{v:.3f}" for v in c1)
    return w.add(
        (
            "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] "
            f"/Function << /FunctionType 2 /Domain [0 1] /C0 [{a}] /C1 [{b}] /N 1 >> /Extend [true true] >>"
        ).encode("latin-1")
    )


def data_gradient(accent: RGB) -> Tuple[RGB, RGB]:
    """A data bar's two ends (tip at the left, base at the right): cyan → blue, or the brand's."""
    if tuple(round(v, 3) for v in accent) == tuple(round(v, 3) for v in DEFAULT_ACCENT):
        return T.DATA_TIP, accent
    return mix(accent, WHITE, 0.45), accent


def _vis(text: str) -> str:
    """Logical → visual: right to left when there is Hebrew in it, a Latin-only text as typed."""
    return P.visual(text)


class _Layout:
    """Lays the blocks over pages; footers and the cover are added once the count is known."""

    def __init__(self, doc: Document):
        self.doc = doc
        self.regular = P._Font(P._truetype(False), "F1")
        self.bold = P._Font(P._truetype(True), "F2")
        self.accent: RGB = tuple(doc.accent) if doc.accent else DEFAULT_ACCENT  # type: ignore[assignment]
        self.tint = mix(self.accent, WHITE, 0.9)
        self.page_w, self.page_h = self._size()
        self.landscape = self.page_w > self.page_h
        self.left = MARGIN
        self.right = self.page_w - MARGIN
        self.width = self.right - self.left
        self.bottom = self.page_h - FOOTER_ZONE
        self.pages: List[P._Canvas] = []
        self.y = 0.0
        self.top = 0.0
        self.logo_box: Optional[Tuple[float, float]] = None
        if doc.logo is not None:
            w, h = doc.logo.size
            scale = min(HEADER_LOGO_MAX[0] / w, HEADER_LOGO_MAX[1] / h)
            self.logo_box = (w * scale, h * scale)

    def _size(self) -> Tuple[float, float]:
        o = self.doc.orientation
        if o == "landscape":
            return (P.A4[1], P.A4[0])
        if o == "portrait":
            return P.A4
        widest = max((len(b.columns) for b in self.doc.blocks if isinstance(b, Table)), default=0)
        return (P.A4[1], P.A4[0]) if widest > P.AUTO_LANDSCAPE_COLUMNS else P.A4

    # ── Pages ──

    @property
    def c(self) -> P._Canvas:
        return self.pages[-1]

    def new_page(self) -> None:
        canvas = P._Canvas(self.page_h)
        first = not self.pages
        self.pages.append(canvas)
        self.y = self._first_header(canvas) if first else self._cont_header(canvas)
        self.top = self.y

    def at_top(self) -> bool:
        return self.y <= self.top + 0.5

    def need(self, h: float) -> None:
        if self.y + h > self.bottom and not self.at_top():
            self.new_page()

    @property
    def page_room(self) -> float:
        """The height a continuation page has for blocks."""
        return self.bottom - self._cont_top()

    # ── Text helpers ──

    def rich_width(self, text: str, size: float) -> float:
        return sum((self.bold if b else self.regular).width(t, size) for t, b in figure_runs(text))

    def wrap_rich(self, text: str, size: float, width: float, max_lines: int = 8) -> List[str]:
        """Word-wrapped logical lines of a sentence whose figures are bold."""
        lines: List[str] = []
        line = ""
        for word in P.clean(text).split():
            cand = f"{line} {word}".strip()
            if not line or self.rich_width(cand, size) <= width - 1.5:
                line = cand
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = lines[-1] + "…"
        return lines

    def pieces(self, c: P._Canvas, font: P._Font, size: float, right: float, baseline: float,
               parts: Sequence[str], color: RGB, sep: str = "·") -> float:
        """Texts laid right to left from `right`, a `sep` between them; returns where they end."""
        x = right
        for k, part in enumerate(parts):
            if k:
                w = font.width(sep, size)
                c.text(font, size, x - 4 - w, baseline, sep, FAINT)
                x -= w + 8
            vis = _vis(part)
            w = font.width(vis, size)
            c.text(font, size, x - w, baseline, vis, color)
            x -= w
        return x

    def rich_text(self, c: P._Canvas, size: float, left: float, right: float, baseline: float, text: str,
                  color: RGB, figure_color: RGB, anchor: str = "right") -> None:
        """One logical line, its figures bold (and in `figure_color`), placed by `anchor`."""
        runs = figure_runs(_vis(text))
        total = sum((self.bold if b else self.regular).width(t, size) for t, b in runs)
        x = left if anchor == "left" else ((left + right - total) / 2 if anchor == "center" else right - total)
        for piece, bold in runs:
            font = self.bold if bold else self.regular
            c.text(font, size, x, baseline, piece, figure_color if bold else color)
            x += font.width(piece, size)

    # ── The header band, the continuation header, the footer ──

    def _subtitle(self) -> str:
        doc = self.doc
        if doc.subtitle:
            return doc.subtitle
        if doc.facts:  # the facts carry the period and the scope
            return doc.business_name
        return "  ·  ".join(x for x in (doc.period, doc.scope) if x) or doc.business_name

    def _facts_row(self, c: P._Canvas, right: float, left: float, top: float, *, center: bool = False,
                   label_size: float = T.FACT_LABEL, value_size: float = T.FACT_VALUE) -> None:
        """The key facts right to left, a label over each value, a hairline between them."""
        regular, bold = self.regular, self.bold
        gap = 24.0
        items = []
        for label, value in self.doc.facts[:6]:
            lab, val = P.clean(label), P.clean(value)
            if not lab and not val:
                continue
            val = P._fit(bold, val, value_size, (right - left) * 0.5)
            w = max(regular.width(lab, label_size), bold.width(val, value_size))
            items.append((lab, val, w))
        total = 0.0
        fitted = []
        for it in items:
            add = it[2] + (gap if fitted else 0.0)
            if total + add > right - left:
                break
            fitted.append(it)
            total += add
        x = (left + right + total) / 2 if center else right
        for k, (lab, val, w) in enumerate(fitted):
            if k:
                c.line(x + gap / 2, top + 1, x + gap / 2, top + label_size + value_size + 6, T.ON_DARK_3, 0.5)
            anchor = "center" if center else "right"
            c.text_in(regular, label_size, x - w, x, top + label_size, _vis(lab), anchor, T.ON_DARK_2)
            c.text_in(bold, value_size, x - w, x, top + label_size + value_size + 4, _vis(val), anchor, WHITE)
            x -= w + gap

    def _first_header(self, c: P._Canvas) -> float:
        doc, regular, bold = self.doc, self.regular, self.bold
        pad_top = 22.0
        size = T.TITLE
        # The title's room: between the R2M logo (left) and the business logo (right).
        lh = 15.0
        lw = lh * R2M_W / R2M_H
        plate_w = (self.logo_box[0] + 12) if self.logo_box is not None else 0.0
        tr = self.right - (plate_w + 14 if plate_w else 0)
        tl = self.left + lw + 20
        lines = P._wrap(bold, doc.title, size, tr - tl, 2)
        if len(lines) > 1:
            size = T.TITLE_LONG
            lines = P._wrap(bold, doc.title, size, tr - tl, 2)
        sub = self._subtitle()
        h = pad_top + len(lines) * size * 1.2 + (T.BAND_SUB * 1.7 if sub else 0) + 4
        facts_top = h + 6
        if doc.facts:
            h = facts_top + T.FACT_LABEL + T.FACT_VALUE + 6
        h += 18
        if self.logo_box is not None:
            h = max(h, self.logo_box[1] + 12 + 2 * 16)
        c.gradient(SH_BAND, 0, -T.BAND_RADIUS, self.page_w, h + T.BAND_RADIUS, T.BAND_RADIUS)

        y = pad_top
        for line in lines:
            y += size * 1.2
            c.text_in(bold, size, tl, tr, y - size * 0.25, _vis(line), "right", WHITE)
        if sub:
            y += T.BAND_SUB * 1.7
            c.text_in(regular, T.BAND_SUB, tl, tr, y - T.BAND_SUB * 0.45,
                      _vis(P._fit(regular, sub, T.BAND_SUB, tr - tl)), "right", T.ON_DARK_2)
        if doc.facts:
            self._facts_row(c, tr, self.left + lw + 20, facts_top)
        c.form("R2M", self.left, pad_top + 3, lw, lh, R2M_W, R2M_H, WHITE)
        if self.logo_box is not None:
            bw, bh = self.logo_box
            pw, ph = bw + 12, bh + 12
            px, py = self.right - pw, pad_top - 4
            c.round_rect(px, py, pw, ph, 7, fill=WHITE)
            c.image("Logo", px + 6, py + 6, bw, bh)

        # Under the band: the further lines and the filters, muted.
        y = h + 10
        meta = [x for x in list(doc.extra_lines) + list(doc.filter_lines) if x]
        if meta:
            lines = P._wrap(regular, "  ·  ".join(meta), T.META, self.width, 4)
            for i, line in enumerate(lines):
                c.text_in(regular, T.META, self.left, self.right, y + 9 + i * 11, _vis(line), "right", MUTED)
            y += len(lines) * 11 + 6
        return y + 8

    def _cont_top(self) -> float:
        return 46.0

    def _cont_header(self, c: P._Canvas) -> float:
        doc, regular, bold = self.doc, self.regular, self.bold
        c.gradient(SH_BAND, 0, 0, self.page_w, 4.5)
        base = 25.0
        lh = 8.0
        lw = lh * R2M_W / R2M_H
        c.form("R2M", self.left, base - lh + 0.5, lw, lh, R2M_W, R2M_H, T.NAVY)
        room = self.width - lw - 20
        title = P._fit(bold, doc.title, 10.5, room * 0.62)
        tw = bold.width(title, 10.5)
        c.text_in(bold, 10.5, self.left, self.right, base, _vis(title), "right", INK, width=tw)
        if doc.period:
            period = P._fit(regular, doc.period, 8, room - tw - 14)
            c.text_in(regular, 8, self.left, self.right - tw - 12, base, _vis(period), "right", MUTED)
        c.line(self.left, 34, self.right, 34, T.BORDER, 0.8)
        return self._cont_top()

    def footers(self) -> None:
        total = len(self.pages)
        regular, bold = self.regular, self.bold
        line_y = self.page_h - 26
        fy = self.page_h - 14
        doc = self.doc
        # "הופק ממערכת R2M · when · by whom", piece by piece from the right (a date beside a
        # Latin word would otherwise run left to right as one).
        made = [x for x in ("הופק ממערכת R2M", doc.generated_at, P._fit(regular, doc.generated_by, T.FOOTER, 120)) if x]
        business = P._fit(bold, doc.business_name, T.FOOTER, self.width * 0.3) if doc.business_name else ""
        for n, c in enumerate(self.pages, start=1):
            c.line(self.left, line_y, self.right, line_y, T.BORDER, 0.6)
            self.pieces(c, regular, T.FOOTER, self.right, fy, made, MUTED)
            c.text_in(regular, T.FOOTER, self.left, self.right, fy, _vis(f"עמוד {n} מתוך {total}"), "center", MUTED)
            if business:
                c.text_in(bold, T.FOOTER, self.left, self.right, fy, _vis(business), "left", T.TEXT2)

    # ── Blocks ──

    def run(self) -> None:
        self.new_page()
        blocks = self.doc.blocks
        for k, block in enumerate(blocks):
            nxt = blocks[k + 1] if k + 1 < len(blocks) else None
            if isinstance(block, Table):
                self.table(block)
            elif isinstance(block, KpiBlock):
                self.kpi_block(block)
            elif isinstance(block, InsightBlock):
                self.insight_block(block)
            elif isinstance(block, ChartBlock):
                self.chart_block(block)
            elif isinstance(block, ReconBlock):
                self.recon_block(block)
            elif isinstance(block, Section):
                if block.new_page and not self.at_top():
                    self.new_page()
                self.need(T.SECTION_H + 12 + self.lead(nxt))
                self.section(block)
            elif isinstance(block, Heading):
                if block.new_page and not self.at_top():
                    self.new_page()
                self.need(HEADING_H + self.lead(nxt))
                self.heading(block.text, block.sub)
            elif isinstance(block, Note):
                self.note(block)
            elif isinstance(block, PageBreak):
                if not self.at_top():
                    self.new_page()
        if self._wants_cover():
            self.pages.insert(0, self.cover())
        self.footers()

    def lead(self, block: Any) -> float:
        """The height of a block's first piece — what a heading over it keeps it with."""
        if block is None:
            return 0.0
        if isinstance(block, KpiBlock):
            return self._kpi_card_h(block.kpis) + (HEADING_H if block.title else 0)
        if isinstance(block, InsightBlock):
            return 70.0
        if isinstance(block, ChartBlock):
            charts = [ch for ch in block.charts if ch is not None]
            return block.height or (max(self.chart_height(ch) for ch in charts) if charts else 0.0)
        if isinstance(block, ReconBlock):
            return self._recon_h(block)
        if isinstance(block, Table):
            # A short table moves whole (`table`), so what heads it waits for all of it.
            n = len(block.rows)
            rows = (max(n, 1) + (1 if block.totals else 0)) if n <= SHORT_TABLE else KEEP_ROWS
            return (HEADING_H if block.title else 0) + 22 + rows * 18.0
        if isinstance(block, Note):
            return 30.0
        if isinstance(block, (Heading, Section)):
            return HEADING_H + 60
        return 0.0

    def _wants_cover(self) -> bool:
        mode = self.doc.cover
        if mode == "never":
            return False
        return mode == "always" or len(self.pages) > COVER_AFTER_PAGES

    def section(self, block: Section) -> None:
        c, y = self.c, self.y
        h = T.SECTION_H
        c.gradient(SH_SECTION, self.left, y, self.width, h, T.SECTION_RADIUS)
        icx, icy = self.right - 15, y + h / 2
        draw_icon(c, block.icon if block.icon else "chart", icx, icy, 10.0, WHITE, T.NAVY, self.regular, self.bold)
        text = P._fit(self.bold, block.text, T.SECTION, self.width - 50)
        c.text_in(self.bold, T.SECTION, self.left + 12, icx - 11, y + h / 2 + T.SECTION * 0.36, _vis(text), "right",
                  WHITE)
        self.y += h + 12

    def heading(self, text: str, sub: str = "", icon: Optional[str] = None) -> None:
        c, y = self.c, self.y
        right = self.right
        if icon:
            draw_icon(c, icon, right - 6, y + 9.5, 10.0, self.accent, WHITE, self.regular, self.bold)
            right -= 17
        title = P._fit(self.bold, text, T.HEADING, right - self.left - 8)
        tw = self.bold.width(title, T.HEADING)
        c.text_in(self.bold, T.HEADING, self.left, right, y + 13, _vis(title), "right", INK)
        h = 19.0
        if sub:
            room = right - self.left - tw - 24
            if room > 120 and self.regular.width(sub, T.HEADING_SUB) <= room:
                c.text_in(self.regular, T.HEADING_SUB, self.left, self.right, y + 13, _vis(sub), "left", MUTED)
            else:
                sub = P._fit(self.regular, sub, T.HEADING_SUB, self.width - 8)
                c.text_in(self.regular, T.HEADING_SUB, self.left, right, y + 26, _vis(sub), "right", MUTED)
                h += 12
        c.line(self.left, y + h, self.right, y + h, T.RULE, 1.3)
        self.y += h + 8

    def note(self, block: Note) -> None:
        size, line_h = T.CALLOUT, T.CALLOUT_LINE
        if block.tone in ("info", "alert"):
            tone = "check" if block.tone == "alert" else "tip"
            strong, text_c, bg, line_c = T.TONES[tone]
            lines = self.wrap_rich(block.text, size, self.width - 44, 8)
            h = len(lines) * line_h + 16
            self.need(h + 6)
            c, y = self.c, self.y
            c.round_rect(self.left, y, self.width, h, T.CALLOUT_RADIUS, fill=bg, stroke=line_c, width=0.8)
            icx = self.right - 16
            c.circle(icx, y + 8 + line_h / 2 - 1, 7, fill=strong)
            draw_icon(c, "alert" if tone == "check" else "tip_bulb", icx, y + 8 + line_h / 2 - 1, 7.5, WHITE, strong,
                      self.regular, self.bold)
            for i, line in enumerate(lines):
                self.rich_text(c, size, self.left + 12, icx - 13, y + 8 + (i + 1) * line_h - 3.6, line, text_c, INK)
            self.y += h + 8
        else:
            lines = P._wrap(self.regular, block.text, 8, self.width - 4, 6)
            h = len(lines) * 11 + 4
            self.need(h)
            for i, line in enumerate(lines):
                self.c.text_in(self.regular, 8, self.left, self.right, self.y + 9 + i * 11, _vis(line), "right", MUTED)
            self.y += h + 6

    # KPI cards

    def _kpi_card_h(self, kpis: Sequence[Kpi]) -> float:
        rich = any(x.spark or x.compare is not None or x.sub for x in kpis)
        return 72.0 if rich else 58.0

    def kpi_block(self, block: KpiBlock) -> None:
        kpis = [k for k in block.kpis if k.label][:12]
        if not kpis:
            return
        per_row = 6 if self.landscape else 4
        rows = math.ceil(len(kpis) / per_row)
        k = math.ceil(len(kpis) / rows)
        card_h = self._kpi_card_h(kpis)
        gap = T.CARD_GAP
        if block.title:
            self.need(HEADING_H + card_h)
            self.heading(block.title)
        for r in range(rows):
            chunk = kpis[r * k:(r + 1) * k]
            self.need(card_h + 4)
            cw = (self.width - gap * (k - 1)) / k
            for i, kpi in enumerate(chunk):
                x = self.right - (i + 1) * cw - i * gap
                self.kpi_card(self.c, kpi, x, self.y, cw, card_h)
            self.y += card_h + gap
        self.y += GAP - gap + 4

    def kpi_card(self, c: P._Canvas, kpi: Kpi, x: float, y: float, w: float, h: float, big: bool = False) -> None:
        regular, bold = self.regular, self.bold
        color = T.KPI_COLORS.get(kpi.icon, self.accent)
        r = T.CARD_RADIUS
        c.round_rect(x, y, w, h, r, fill=WHITE, stroke=T.BORDER, width=0.8)
        c.save()
        c.clip_round_rect(x, y, w, h, r)
        c.rect(x + w - T.STRIP_W, y, T.STRIP_W, h, color)
        c.restore()
        pad = 12.0 if big else 9.5
        right = x + w - T.STRIP_W - pad + 1
        left = x + pad
        # The icon, small, at the top left; the label at the top right.
        isz = 9.5 if big else 7.5
        icx, icy = left + isz, y + pad + isz - 1
        c.round_rect(icx - isz, icy - isz, 2 * isz, 2 * isz, isz * 0.5, fill=mix(color, WHITE, 0.88))
        draw_icon(c, kpi.icon, icx, icy, isz * 1.1, color, mix(color, WHITE, 0.88), regular, bold)
        ls = 9.5 if big else T.KPI_LABEL
        label = P._fit(regular, kpi.label, ls, max(10.0, right - (icx + isz + 4)))
        c.text_in(regular, ls, icx + isz + 4, right, y + pad + ls * 0.95, _vis(label), "right", MUTED)
        value = kpi.display(short=not big)
        vis_value = _vis(value) if kpi.kind == "text" else value
        size = 26.0 if big else T.KPI_VALUE
        room = right - left
        while size > 8 and bold.width(vis_value, size) > room:
            size -= 0.5
        if bold.width(vis_value, size) > room:
            vis_value = P._fit(bold, vis_value, size, room)
        vy = y + pad + ls + 6 + size * 0.95 + (6 if big else 2)
        c.text_in(bold, size, left, right, vy, vis_value, "right", INK)

        # The sparkline beside the number when there is room, else at the bottom left; the small
        # line under the number: the change chip and what it is against (or the card's own `sub`).
        by = y + h - pad + 1
        spark_right = left
        if len(kpi.spark) >= 2:
            beside = right - bold.width(vis_value, size) - 10 - left
            if beside >= 34:
                sw = min(beside, w * 0.42, 84.0 if big else 58.0)
                sh = min(18.0 if big else 15.0, size * 0.85)
                self.sparkline(c, kpi.spark, left, vy - sh - 1, sw, sh, color)
            else:
                sw = min(w * 0.34, 78.0 if big else 50.0)
                sh = 16.0 if big else 12.0
                self.sparkline(c, kpi.spark, left, by - sh, sw, sh, color)
                spark_right = left + sw + 5
        sub_size = 8.0 if big else T.KPI_SUB
        text_right = right
        chip = kpi.chip_text()
        if chip is not None:
            good = kpi.good
            fg, bg = (T.GOOD, hex_rgb("#DCFCE7")) if good is True else (
                (T.BAD, hex_rgb("#FEE2E2")) if good is False else (MUTED, T.FLAT_BG))
            cs = 7.8 if big else 6.9
            text = _vis(chip) if chip == "חדש" else chip
            tw = bold.width(text, cs)
            cw_, ch_ = tw + 15, cs + 5.0
            cx0 = right - cw_
            cy0 = by - ch_ + 1
            c.round_rect(cx0, cy0, cw_, ch_, ch_ / 2, fill=bg)
            tx, ty = cx0 + cw_ - 6.8, cy0 + ch_ / 2
            d = kpi.direction
            if d == "up":
                c.polygon([(tx - 2.6, ty + 1.9), (tx + 2.6, ty + 1.9), (tx, ty - 2.3)], fill=fg)
            elif d == "down":
                c.polygon([(tx - 2.6, ty - 1.9), (tx + 2.6, ty - 1.9), (tx, ty + 2.3)], fill=fg)
            else:
                c.rect(tx - 2.5, ty - 0.55, 5.0, 1.1, fg)
            c.text(bold, cs, cx0 + 4.5, ty + cs * 0.36, text, fg)
            text_right = cx0 - 4
        note = kpi.sub or (f"מול {compared_with(kpi.compare_label)}" if chip is not None and kpi.compare_label else "")
        room = text_right - spark_right
        if note and room > 22:
            fitted = P._fit(regular, note, sub_size, room)
            c.text_in(regular, sub_size, spark_right, text_right, by - 1.5, _vis(fitted), "right", FAINT if not kpi.sub else MUTED)

    def sparkline(self, c: P._Canvas, values: Sequence[float], x: float, y: float, w: float, h: float,
                  color: Optional[RGB] = None) -> None:
        color = color or self.accent
        lo, hi = min(values), max(values)
        span = hi - lo or 1.0
        n = len(values)
        pts = [(x + w * i / (n - 1), y + h - (v - lo) / span * h) for i, v in enumerate(values)]
        c.polygon(pts + [(x + w, y + h), (x, y + h)], fill=mix(color, WHITE, 0.88))
        c.polyline(pts, color, 1.0)
        c.circle(pts[-1][0], pts[-1][1], 1.6, fill=color)

    # Callouts (insights)

    def insight_block(self, block: InsightBlock) -> None:
        items = [i for i in block.insights if i.text][:10]
        if not items:
            return
        # One box per tone, in the order the tones first come (the generator's: best first).
        order: List[str] = []
        groups: Dict[str, List[Insight]] = {}
        for it in items:
            tone = T.INSIGHT_TONE.get(it.type, "tip")
            if tone not in groups:
                groups[tone] = []
                order.append(tone)
            groups[tone].append(it)
        size, line_h = T.CALLOUT, T.CALLOUT_LINE
        text_w = self.width - 2 * 12 - 16
        wrapped = {t: [self.wrap_rich(i.text, size, text_w, 6) for i in groups[t]] for t in order}
        title_h = 21.0

        def box_h(lines_per_item: Sequence[List[str]]) -> float:
            return 10 + title_h + sum(len(ls) * line_h + 3 for ls in lines_per_item) + 6

        first_h = box_h(wrapped[order[0]])
        if block.title:
            self.need(HEADING_H + min(first_h, 120))
            self.heading(block.title)
        for tone in order:
            per_item = wrapped[tone]
            start = 0
            cont = False
            while start < len(per_item):
                whole = box_h(per_item[start:])
                if self.y + whole > self.bottom and not self.at_top() and whole <= self.page_room:
                    self.new_page()
                # How many items fit here (a box taller than a page is split between items).
                end = len(per_item)
                while end > start + 1 and self.y + box_h(per_item[start:end]) > self.bottom:
                    end -= 1
                self.callout(tone, groups[tone][start:end], per_item[start:end], cont)
                start, cont = end, True
                if start < len(per_item):
                    self.new_page()
        how = block.how_to_read
        if how is None:
            how = "איך לקרוא: " + " · ".join(TONE_WORDS[t] for t in order if t in TONE_WORDS) + \
                ". כל משפט מחושב מהנתונים שבדוח הזה."
        if how:
            lines = P._wrap(self.regular, how, T.HOW_TO_READ, self.width - 4, 3)
            self.need(len(lines) * 10 + 4)
            for i, line in enumerate(lines):
                self.c.text_in(self.regular, T.HOW_TO_READ, self.left, self.right, self.y + 8 + i * 10, _vis(line),
                               "right", MUTED)
            self.y += len(lines) * 10 + 4
        self.y += GAP - 4

    def callout(self, tone: str, items: Sequence[Insight], lines_per_item: Sequence[List[str]], cont: bool) -> None:
        strong, text_c, bg, line_c = T.TONES[tone]
        size, line_h = T.CALLOUT, T.CALLOUT_LINE
        title_h = 21.0
        h = 10 + title_h + sum(len(ls) * line_h + 3 for ls in lines_per_item) + 6
        c, y = self.c, self.y
        c.round_rect(self.left, y, self.width, h, T.CALLOUT_RADIUS, fill=bg, stroke=line_c, width=0.8)
        title, icon = TONE_TITLES[tone]
        icx, icy = self.right - 18, y + 10 + 7
        c.circle(icx, icy, 7.5, fill=strong)
        draw_icon(c, icon, icx, icy, 8.0, WHITE, strong, self.regular, self.bold)
        head = f"{title} ({len(items)})" if len(items) > 1 and not cont else (f"{title} (המשך)" if cont else title)
        c.text_in(self.bold, T.CALLOUT_TITLE, self.left, icx - 12, icy + T.CALLOUT_TITLE * 0.36, _vis(head), "right",
                  strong)
        yy = y + 10 + title_h
        text_right = self.right - 30
        for it, lines in zip(items, lines_per_item):
            # The sentence's own kind as a small mark at its start.
            mark_y = yy + line_h / 2 - 1.5
            draw_icon(c, INSIGHT_ICON.get(it.type, "tip_bulb"), self.right - 19, mark_y, 7.2, strong, bg,
                      self.regular, self.bold)
            for k, line in enumerate(lines):
                self.rich_text(c, size, self.left + 12, text_right, yy + (k + 1) * line_h - 3.4, line, text_c, INK)
            yy += len(lines) * line_h + 3
        self.y += h + 7

    # Reconciliation

    def _recon_h(self, block: ReconBlock) -> float:
        h = HEADING_H + 78.0
        if block.note:
            h += 12 * len(P._wrap(self.regular, block.note, 8, self.width, 3))
        if block.checks:
            h += 30
        return h + 6

    def recon_block(self, block: ReconBlock) -> None:
        cards = block.cards[:4]
        if not cards:
            return
        self.need(self._recon_h(block))
        self.heading(block.title or "התאמה", icon="scale")
        c = self.c
        if block.note:
            for line in P._wrap(self.regular, block.note, 8, self.width, 3):
                c.text_in(self.regular, 8, self.left, self.right, self.y + 4, _vis(line), "right", TEXT2)
                self.y += 12
            self.y += 4
        gap = 10.0
        k = len(cards)
        cw = (self.width - gap * (k - 1)) / k
        ch = 78.0
        for i, card in enumerate(cards):
            x = self.right - (i + 1) * cw - i * gap
            self.recon_card(c, card, x, self.y, cw, ch)
        self.y += ch + 10
        checks = block.checks[:4]
        if checks:
            pills = [self._pill_parts(k_) for k_ in checks]
            gap_p = 8.0
            total = sum(p[0] for p in pills) + gap_p * (len(pills) - 1)
            if total > self.width:  # one per line
                for check, p in zip(checks, pills):
                    self.pill(c, check, (self.left + self.right + p[0]) / 2, self.y)
                    self.y += 24
            else:
                x = (self.left + self.right + total) / 2
                for check, p in zip(checks, pills):
                    self.pill(c, check, x, self.y)
                    x -= p[0] + gap_p
                self.y += 24
        self.y += GAP - 4

    def recon_card(self, c: P._Canvas, card: ReconCard, x: float, y: float, w: float, h: float) -> None:
        regular, bold = self.regular, self.bold
        c.round_rect(x, y, w, h, T.CARD_RADIUS, fill=T.ZEBRA, stroke=T.BORDER, width=0.8)
        cx = x + w / 2
        color = T.KPI_COLORS.get(card.icon, self.accent)
        c.round_rect(cx - 9, y + 8, 18, 18, 6, fill=mix(color, WHITE, 0.86))
        draw_icon(c, card.icon, cx, y + 17, 10.0, color, mix(color, WHITE, 0.86), regular, bold)
        label = P._fit(bold, card.label, 8.4, w - 16)
        c.text_in(bold, 8.4, x, x + w, y + 38, _vis(label), "center", TEXT2)
        value = format_value(card.value, card.kind)
        vis_value = _vis(value) if card.kind == "text" else value
        size = 17.0
        while size > 9 and bold.width(vis_value, size) > w - 16:
            size -= 0.5
        c.text_in(bold, size, x, x + w, y + 38 + 4 + size * 0.95, vis_value, "center", INK)
        if card.sub:
            c.text_in(regular, 7.2, x, x + w, y + h - 7, _vis(P._fit(regular, card.sub, 7.2, w - 16)), "center", MUTED)

    def _pill_parts(self, check: ReconCheck) -> Tuple[float, str, str]:
        label = P.clean(check.label) + ":"
        word = check.text or RECON_STATUS_TEXT.get(check.status, "")
        w = self.bold.width(label, 7.8) + 4 + 9 + 4 + self.regular.width(word, 7.8) + 22
        return w, label, word

    def pill(self, c: P._Canvas, check: ReconCheck, right: float, y: float) -> None:
        """A check's pill, its right edge at `right`: "<label>: ✓ תואם" (or ✗ פער, … ממתין)."""
        w, label, word = self._pill_parts(check)
        strong, _text, bg, line_c = T.TONES[T.CHECK_TONE.get(check.status, "flat")]
        h = 19.0
        x = right - w
        c.round_rect(x, y, w, h, h / 2, fill=bg, stroke=line_c, width=0.8)
        base = y + h / 2 + 7.8 * 0.36
        xr = right - 11
        lw = self.bold.width(label, 7.8)
        c.text_in(self.bold, 7.8, xr - lw, xr, base, _vis(label), "right", strong)
        xr -= lw + 4
        icon = {"match": "check", "mismatch": "cross", "pending": "clock"}.get(check.status, "dots")
        draw_icon(c, icon, xr - 4.5, y + h / 2, 8.0, strong, bg, self.regular, self.bold)
        xr -= 9 + 4
        c.text_in(self.regular, 7.8, xr - self.regular.width(word, 7.8), xr, base, _vis(word), "right", strong)

    # Charts

    def chart_height(self, ch: Chart) -> float:
        if ch.type == "hbar":
            return 36.0 + 15.0 * min(len(ch.labels), 12) + 8
        if ch.type == "donut":
            return 150.0
        return 160.0

    def chart_block(self, block: ChartBlock) -> None:
        charts = [ch for ch in block.charts if ch is not None][:3]
        if not charts:
            return
        per_row = 3 if self.landscape else 2
        gap = 10.0
        for r in range(0, len(charts), per_row):
            row = charts[r:r + per_row]
            h = block.height or max(self.chart_height(ch) for ch in row)
            self.need(h + 4)
            cw = (self.width - gap * (len(row) - 1)) / len(row)
            for i, ch in enumerate(row):
                x = self.right - (i + 1) * cw - i * gap
                self.chart(self.c, ch, x, self.y, cw, h)
            self.y += h + gap
        self.y += GAP - gap + 4

    def colors(self, n: int) -> List[RGB]:
        pal = [self.accent] + T.PALETTE
        return [pal[i % len(pal)] for i in range(n)]

    def series_colors(self, n: int) -> List[RGB]:
        if n == 1:
            return [self.accent]
        if n == 2:
            return [self.accent, T.PREVIOUS]
        return [self.accent, mix(self.accent, WHITE, 0.45), T.PREVIOUS][:n]

    def chart(self, c: P._Canvas, ch: Chart, x: float, y: float, w: float, h: float) -> None:
        regular, bold = self.regular, self.bold
        c.round_rect(x, y, w, h, T.CARD_RADIUS, fill=WHITE, stroke=T.BORDER, width=0.8)
        if ch.title:
            c.text_in(bold, 9, x + 10, x + w - 12, y + 16, _vis(P._fit(bold, ch.title, 9, w - 22)), "right", INK)
        if len(ch.series) > 1 and ch.type in ("bar", "line", "hbar"):
            colors = self.series_colors(len(ch.series))
            lx = x + 10
            for s, color in zip(ch.series, colors):
                if not s.name:
                    continue
                c.round_rect(lx, y + 10, 7, 7, 2, fill=color)
                name = _vis(s.name)
                c.text(regular, 7, lx + 10, y + 16, name, MUTED)
                lx += 10 + regular.width(name, 7) + 10
        if ch.type == "donut":
            self.donut(c, ch, x, y, w, h)
        elif ch.type == "hbar":
            self.hbar(c, ch, x, y, w, h)
        else:
            self.bars(c, ch, x, y, w, h, line=ch.type == "line")

    def _empty_chart(self, c: P._Canvas, x: float, y: float, w: float, h: float) -> None:
        c.text_in(self.regular, 8, x, x + w, y + h / 2 + 3, _vis(P.NO_ROWS), "center", FAINT)

    def bars(self, c: P._Canvas, ch: Chart, x: float, y: float, w: float, h: float, line: bool) -> None:
        regular = self.regular
        n = len(ch.labels)
        values = [v for s in ch.series for v in s.values]
        if not n or not values or all(v == 0 for v in values):
            self._empty_chart(c, x, y, w, h)
            return
        vmax, vmin = max(values + [0.0]), min(values + [0.0])
        top = nice_ceiling(vmax) if vmax > 0 else 0.0
        bot = -nice_ceiling(-vmin) if vmin < 0 else 0.0
        if top == bot:
            top = 1.0
        ticks = [bot + (top - bot) * i / 4 for i in range(5)]
        tick_labels = [compact(t, ch.kind) for t in ticks]
        axis_w = max(regular.width(t, 6.3) for t in tick_labels) + 6
        px0, px1 = x + 10 + axis_w, x + w - 12
        py0, py1 = y + 30, y + h - 18

        def ymap(v: float) -> float:
            return py1 - (v - bot) / (top - bot) * (py1 - py0)

        for t, label in zip(ticks, tick_labels):
            yy = ymap(t)
            c.line(px0, yy, px1, yy, T.ROW_LINE if t != 0 else T.FAINT, 0.6 if t != 0 else 0.7)
            c.text_in(regular, 6.3, x, px0 - 4, yy + 2.2, label, "right", FAINT)
        group = (px1 - px0) / n
        colors = self.series_colors(len(ch.series))
        if line:
            for s, color in reversed(list(zip(ch.series, colors))):
                pts = [(px0 + group * (i + 0.5), ymap(v)) for i, v in enumerate(s.values)]
                if s is ch.series[0] and len(pts) > 1:
                    c.polygon(pts + [(pts[-1][0], ymap(max(bot, 0))), (pts[0][0], ymap(max(bot, 0)))], fill=self.tint)
                c.polyline(pts, color, 1.6 if s is ch.series[0] else 1.1)
                if n <= 31:
                    for px, py in pts:
                        c.circle(px, py, 1.6 if s is ch.series[0] else 1.2, fill=color)
        else:
            inner = group * 0.72
            bw = inner / len(ch.series)
            zero = ymap(0.0)
            peak = max(range(n), key=lambda i: ch.series[0].values[i])
            for i in range(n):
                gx = px0 + i * group + (group - inner) / 2
                for k, (s, color) in enumerate(zip(ch.series, colors)):
                    v = s.values[i]
                    if v == 0:
                        continue
                    yy = ymap(v)
                    top_y, bh = (yy, zero - yy) if v > 0 else (zero, yy - zero)
                    fill = color
                    if k == 0 and len(ch.series) == 1 and i != peak:
                        fill = mix(self.accent, WHITE, 0.3)
                    rr = min(2.2, bw / 3.5)
                    c.round_rect(gx + k * bw + 0.4, top_y, max(0.6, bw - 0.8), bh, rr, fill=fill,
                                 corners=(True, True, False, False) if v > 0 else (False, False, True, True))
            if len(ch.series) == 1 and n <= 14:
                for i in range(n):
                    v = ch.series[0].values[i]
                    if v:
                        label = compact(v, ch.kind)
                        c.text_in(regular, 6, px0 + i * group, px0 + (i + 1) * group, ymap(max(v, 0)) - 2.5, label,
                                  "center", TEXT2)
        widest = max(regular.width(_vis(lbl), 6.3) for lbl in ch.labels)
        step = max(1, math.ceil((widest + 4) / group))
        for i, lbl in enumerate(ch.labels):
            if i % step:
                continue
            c.text_in(regular, 6.3, px0 + i * group - 10, px0 + (i + 1) * group + 10, py1 + 10, _vis(lbl), "center", MUTED)

    def hbar(self, c: P._Canvas, ch: Chart, x: float, y: float, w: float, h: float) -> None:
        regular, bold = self.regular, self.bold
        main = ch.series[0].values
        prev = ch.series[1].values if len(ch.series) > 1 else None
        items = list(range(min(len(ch.labels), 12)))
        if not items or all(main[i] <= 0 for i in items):
            self._empty_chart(c, x, y, w, h)
            return
        vmax = max(max(main[i] for i in items), max((prev[i] for i in items), default=0) if prev else 0) or 1.0
        label_w = min(w * 0.34, max(regular.width(_vis(ch.labels[i]), 7.4) for i in items) + 4)
        values = [format_value(main[i], ch.kind, short=True) for i in items]
        val_w = max(bold.width(v, 7) for v in values) + 6
        plot_r = x + w - 12 - label_w - 6
        plot_l = x + 10 + val_w
        pitch = min(18.0, max(12.0, (h - 36) / len(items)))
        bh = min(7.0, pitch * 0.5)
        for k, i in enumerate(items):
            ry = y + 30 + k * pitch
            label = P._fit(regular, ch.labels[i], 7.4, label_w)
            c.text_in(regular, 7.4, x + 10, x + w - 12, ry + bh / 2 + 2.6, _vis(label), "right", TEXT2)
            c.round_rect(plot_l, ry, plot_r - plot_l, bh, bh / 2, fill=T.TRACK)
            length = max(0.0, (plot_r - plot_l) * max(main[i], 0) / vmax)
            if length > 0.5:
                c.gradient(SH_DATA, plot_r - length, ry, length, bh, bh / 2)
            if prev is not None and prev[i] > 0:
                lp = (plot_r - plot_l) * prev[i] / vmax
                c.rect(plot_r - lp, ry + bh + 0.9, lp, 1.5, T.PREVIOUS)
            c.text_in(bold, 7, x, plot_r - length - 4, ry + bh / 2 + 2.5, values[k], "right", INK)

    def donut(self, c: P._Canvas, ch: Chart, x: float, y: float, w: float, h: float) -> None:
        regular, bold = self.regular, self.bold
        pairs = [(lbl, max(0.0, v)) for lbl, v in zip(ch.labels, ch.series[0].values)]
        pairs = [p for p in pairs if p[1] > 0]
        pairs.sort(key=lambda p: -p[1])
        if len(pairs) > 8:
            rest = sum(v for _l, v in pairs[7:])
            pairs = pairs[:7] + [("אחר", rest)]
        total = sum(v for _l, v in pairs)
        if total <= 0:
            self._empty_chart(c, x, y, w, h)
            return
        radius = max(20.0, min((h - 40) / 2, w * 0.2))
        cx, cy = x + 18 + radius, y + 24 + (h - 24) / 2
        colors = self.colors(len(pairs))
        a = math.pi / 2
        bounds = []
        for (label, v), color in zip(pairs, colors):
            sweep = 2 * math.pi * v / total
            c.ring_segment(cx, cy, radius, radius * 0.62, a, a - sweep, color)
            bounds.append(a)
            a -= sweep
        if len(pairs) > 1:
            for b in bounds:
                c.line(cx + radius * 0.6 * math.cos(b), cy - radius * 0.6 * math.sin(b),
                       cx + radius * 1.02 * math.cos(b), cy - radius * 1.02 * math.sin(b), WHITE, 1.4)
        total_text = format_value(total, ch.kind, short=True)
        ts = 10.0
        while ts > 6 and bold.width(total_text, ts) > radius * 1.1:
            ts -= 0.5
        c.text_in(bold, ts, cx - radius, cx + radius, cy + 1.5, total_text, "center", INK)
        c.text_in(regular, 6.5, cx - radius, cx + radius, cy + 10, _vis(P.TOTAL_LABEL), "center", MUTED)
        lx_r = x + w - 12
        lx_l = cx + radius + 14
        pitch = min(14.0, (h - 30) / max(1, len(pairs)))
        ly = y + 32 + max(0.0, (h - 38 - pitch * len(pairs)) / 2)
        for k, ((label, v), color) in enumerate(zip(pairs, colors)):
            yy = ly + k * pitch
            c.round_rect(lx_r - 7, yy - 6.5, 7, 7, 2, fill=color)
            pct = v / total * 100
            figure = f"{pct:.0f}%  {format_value(v, ch.kind, short=True)}"
            fw = regular.width(figure, 7)
            c.text(regular, 7, lx_l, yy, figure, MUTED)
            room = lx_r - 11 - (lx_l + fw + 8)
            c.text_in(regular, 7.4, lx_l, lx_r - 11, yy, _vis(P._fit(regular, label, 7.4, max(10.0, room))), "right", INK)

    # Tables

    def table(self, t: Table) -> None:
        regular, bold = self.regular, self.bold
        cols = t.columns
        if not cols:
            return
        bar_cols = [col.kind == "percent" and col.bar for col in cols]
        if any(bar_cols):
            size, widths = P.column_widths(cols, t.rows, t.totals, regular, bold, self.width,
                                           [BAR_ROOM if b else 0.0 for b in bar_cols])
            bars = list(bar_cols)
            if size < P.BODY_SIZE:
                plain = P.column_widths(cols, t.rows, t.totals, regular, bold, self.width)
                if plain[0] > size:
                    (size, widths), bars = plain, [False] * len(cols)
        else:
            size, widths = P.column_widths(cols, t.rows, t.totals, regular, bold, self.width)
            bars = bar_cols
        edges = [self.right]
        for wd in widths:
            edges.append(edges[-1] - wd)
        x0 = edges[-1]
        tw = self.right - x0
        labels = [P._wrap(bold, col.label, size, max(1.0, widths[i] - 2 * P.PAD), 2) or [""] for i, col in enumerate(cols)]
        head_h = max(len(x) for x in labels) * size * 1.25 + 10
        row_h = round(size * 2.1, 2)
        styles = t.styles or ["row"] * len(t.rows)
        anchors = [col.anchor for col in cols]
        numeric = [col.numeric for col in cols]
        kinds = [col.kind for col in cols]
        # A share column's figure keeps one width down the column, so its bars line up; the bars
        # are scaled to the column's largest share, so the leader's bar is full.
        figure_w = [
            max([regular.width(r[i], size) for r in t.rows if i < len(r)] + [bold.width(t.totals[i], size)
                                                                            if t.totals and i < len(t.totals) else 0.0])
            if bars[i] else 0.0
            for i in range(len(cols))
        ]
        bar_max = [
            max([v for v in (_float(r[i]) for r in t.rows if i < len(r)) if v is not None] + [0.0])
            if bars[i] else 0.0
            for i in range(len(cols))
        ]
        n = len(t.rows)
        has_totals = bool(t.totals)
        title_h = (HEADING_H + (12 if t.subtitle and self.regular.width(t.subtitle, T.HEADING_SUB) > self.width / 2
                                else 0)) if t.title else 0
        tot = 1 if has_totals else 0
        whole = title_h + head_h + row_h * (max(n, 1) + tot) + 2
        if n <= SHORT_TABLE and self.y + whole > self.bottom and whole <= self.page_room and not self.at_top():
            self.new_page()  # a short table stays whole
        else:
            self.need(title_h + head_h + row_h * (min(KEEP_ROWS, max(1, n)) + (tot if n <= KEEP_ROWS else 0)) + 2)

        i = 0
        cont = False
        zebra = 0
        while True:
            if t.title:
                self.heading(t.title + (" (המשך)" if cont else ""), "" if cont else t.subtitle)
            top = self.y
            fit = max(1, int((self.bottom - top - head_h + 0.01) // row_h))
            remaining = n - i
            if remaining + tot <= fit or n == 0:
                take, last = remaining, True
            else:
                take, last = min(fit, remaining), False
                # The next page's header always comes with rows (KEEP_ROWS, or all that are left),
                # so the totals never stand alone there.
                carried = remaining - take
                least = min(KEEP_ROWS, remaining)
                if carried < least:
                    take = max(1, remaining - least)
            h = head_h + max(take, 1 if n == 0 else 0) * row_h + (row_h if last and has_totals else 0)
            c = self.c
            c.save()
            c.clip_round_rect(x0, top, tw, h, T.TABLE_RADIUS)
            c.rect(x0, top, tw, head_h, T.NAVY)
            for k, col in enumerate(cols):
                block = len(labels[k]) * size * 1.25
                ly = top + (head_h - block) / 2
                for label in labels[k]:
                    ly += size * 1.25
                    c.text_in(bold, size, edges[k + 1] + P.PAD, edges[k] - P.PAD, ly - size * 0.3, P.visual(label),
                              anchors[k], WHITE)
            y = top + head_h
            if n == 0:
                c.text_in(regular, size, self.left, self.right, y + row_h / 2 + size * 0.35, _vis(t.empty_text),
                          "center", FAINT)
                y += row_h
            for idx in range(i, i + take):
                row, style = t.rows[idx], styles[idx] if idx < len(styles) else "row"
                better = t.row_better[idx] if t.row_better and idx < len(t.row_better) else None
                if style == "sub":
                    c.rect(x0, y, tw, row_h, T.SUBTOTAL_BG)
                    font = bold
                    zebra = 0
                else:
                    if zebra % 2 == 1:
                        c.rect(x0, y, tw, row_h, T.ZEBRA)
                    font = regular
                    zebra += 1
                if idx < i + take - 1 or (last and has_totals):
                    c.line(x0, y + row_h, self.right, y + row_h, T.ROW_LINE, 0.6)
                self._row(c, y, row, edges, size, row_h, anchors, numeric, kinds, bars, figure_w, bar_max, font, cols,
                          better=better)
                y += row_h
            if last and has_totals:
                c.rect(x0, y, tw, row_h, T.TOTAL_BG)
                c.line(x0, y, self.right, y, T.NAVY, 1.2)
                self._row(c, y, t.totals, edges, size, row_h, anchors, numeric, kinds, bars, figure_w, bar_max, bold, cols,
                          totals=True)
                y += row_h
            c.restore()
            c.round_rect(x0, top, tw, h, T.TABLE_RADIUS, stroke=T.BORDER, width=0.8)
            self.y = top + h
            i += take
            if last:
                break
            self.new_page()
            cont = True
        self.y += GAP + 2

    def _row(self, c: P._Canvas, y: float, row: Sequence[str], edges: List[float], size: float, row_h: float,
             anchors, numeric, kinds, bars, figure_w, bar_max, font: P._Font, cols, totals: bool = False,
             better: Optional[str] = None) -> None:
        baseline = y + row_h / 2 + size * 0.35
        for i in range(len(cols)):
            text = row[i] if i < len(row) else ""
            if not text:
                continue
            left, right = edges[i + 1] + P.PAD, edges[i] - P.PAD
            room = right - left
            kind = kinds[i]
            if kind == "trend" and not totals:
                v = _float(text)
                if v is None:
                    c.text_in(font, size, left, right, baseline, P.visual(text), anchors[i], FAINT)
                    continue
                good = (v > 0) == ((better or cols[i].better) != "down")
                color = MUTED if abs(v) < 0.05 else (T.GOOD if good else T.BAD)
                shown = P.format_percent(abs(round(v, 1)))
                tw = font.width(shown, size)
                total_w = tw + size * 1.1
                if anchors[i] == "left":
                    ax = left
                elif anchors[i] == "center":
                    ax = (left + right - total_w) / 2
                else:
                    ax = right - total_w
                tx, ty = ax + size * 0.4, baseline - size * 0.33
                s = size * 0.36
                if abs(v) < 0.05:
                    c.rect(tx - s, ty - 0.5, 2 * s, 1.0, color)
                elif v > 0:
                    c.polygon([(tx - s, ty + s * 0.8), (tx + s, ty + s * 0.8), (tx, ty - s)], fill=color)
                else:
                    c.polygon([(tx - s, ty - s * 0.8), (tx + s, ty - s * 0.8), (tx, ty + s)], fill=color)
                c.text(font, size, ax + size * 1.1, baseline, shown, color)
                continue
            if bars[i] and not totals:
                # The share: its figure at the start, a bar filling from the right in the room left.
                width = font.width(text, size)
                c.text_in(font, size, left, right, baseline, text, "right", INK, width=width)
                v = _float(text)
                track_r = right - figure_w[i] - 7
                track_l = left + 1
                if v is not None and track_r - track_l > 12:
                    frac = max(0.0, min(1.0, v / bar_max[i])) if bar_max[i] > 0 else 0.0
                    bh = min(5.0, row_h * 0.3)
                    by = y + (row_h - bh) / 2
                    c.round_rect(track_l, by, track_r - track_l, bh, bh / 2, fill=T.TRACK)
                    length = (track_r - track_l) * frac
                    if length > 0.4:
                        c.gradient(SH_DATA, track_r - max(length, bh), by, max(length, bh), bh, bh / 2)
                continue
            width = font.width(text, size)
            if width > room:
                text = P._fit(font, text, size, room)
                width = font.width(text, size)
            c.text_in(font, size, left, right, baseline, text if numeric[i] else P.visual(text), anchors[i],
                      INK, width=width)

    # The cover

    def cover(self) -> P._Canvas:
        doc, regular, bold = self.doc, self.regular, self.bold
        c = P._Canvas(self.page_h)
        band = self.page_h * (0.46 if self.landscape else 0.37)
        c.gradient(SH_BAND, 0, -24, self.page_w, band + 24, 24)
        # The R2M pixels, large and faint, as a watermark in the band's corner.
        wm_h = band * 0.3
        c.save()
        c.clip_round_rect(0, -24, self.page_w, band + 24, 24)
        c.form("R2M", -wm_h * 0.6, band - wm_h * 0.62, wm_h * R2M_W / R2M_H, wm_h, R2M_W, R2M_H, T.WATERMARK)
        c.restore()
        lh = 22.0
        c.form("R2M", self.left, 34, lh * R2M_W / R2M_H, lh, R2M_W, R2M_H, WHITE)
        c.text(regular, 8, self.left, 34 + lh + 13, "POS", T.ON_DARK_3)
        if doc.logo is not None:
            iw, ih = doc.logo.size
            scale = min(LOGO_BOX[0] / iw, LOGO_BOX[1] / ih)
            bw, bh = iw * scale, ih * scale
            c.round_rect(self.right - bw - 14, 28, bw + 14, bh + 14, 8, fill=WHITE)
            c.image("Logo", self.right - bw - 7, 35, bw, bh)
        tl, tr = self.left + 30, self.right - 30
        size = 30.0
        lines = P._wrap(bold, doc.title, size, tr - tl, 3)
        while len(lines) > 2 and size > 20:
            size -= 2
            lines = P._wrap(bold, doc.title, size, tr - tl, 3)
        sub = self._subtitle()
        facts_h = (T.FACT_LABEL + T.FACT_VALUE + 22) if doc.facts else 0
        block = len(lines) * size * 1.2 + (13 * 1.7 if sub else 0) + facts_h
        y = band * 0.6 - block / 2
        for line in lines:
            y += size * 1.2
            c.text_in(bold, size, tl, tr, y - size * 0.2, _vis(line), "center", WHITE)
        if sub:
            y += 13 * 1.7
            c.text_in(regular, 13, tl, tr, y - 4, _vis(P._fit(regular, sub, 13, tr - tl)), "center", T.ON_DARK_2)
        if doc.facts:
            self._facts_row(c, tr, tl, y + 14, center=True)

        kpis = doc.cover_kpis
        if kpis is None:
            kpis = next((b.kpis for b in doc.blocks if isinstance(b, KpiBlock) and b.kpis), [])
        kpis = kpis[:4]
        y = band + 30
        if kpis:
            saved = (self.pages, self.y)
            self.pages, self.y = [c], y
            self.heading("עיקרי הדוח")
            y = self.y + 2
            self.pages, self.y = saved
            cols = 4 if self.landscape else 2
            gap = 12.0
            k = min(cols, len(kpis))
            cw = (self.width - gap * (k - 1)) / k
            ch_ = 104.0
            for i, kpi in enumerate(kpis):
                r, col = divmod(i, k)
                x = self.right - (col + 1) * cw - col * gap
                self.kpi_card(c, kpi, x, y + r * (ch_ + gap), cw, ch_, big=True)
            y += math.ceil(len(kpis) / k) * (ch_ + gap)
        meta_y = max(y + 30, self.page_h - FOOTER_ZONE - 52)
        if doc.business_name:
            c.text_in(bold, 12, self.left, self.right, meta_y, _vis(doc.business_name), "center", INK)
            meta_y += 16
        made = f"הופק {doc.generated_at}" if doc.generated_at else ""
        if doc.generated_by:
            made = f"{made} ע״י {doc.generated_by}".strip()
        if made:
            c.text_in(regular, 9, self.left, self.right, meta_y, _vis(made), "center", MUTED)
        return c


def render_document(doc: Document) -> bytes:
    """The document as PDF bytes."""
    lay = _Layout(doc)
    lay.run()
    w = P._Writer()
    catalog = w.reserve()
    pages_num = w.reserve()
    logo_num = None
    if doc.logo is not None:
        iw, ih = doc.logo.size
        scale = min(LOGO_BOX[0] / iw, LOGO_BOX[1] / ih)
        logo_num = P._logo_object(w, doc.logo, (iw * scale, ih * scale))
    r2m_num = _r2m_form(w)
    tip, base = data_gradient(lay.accent)
    shadings = {
        SH_BAND: _shading(w, T.NAVY, T.BAND_END),
        SH_SECTION: _shading(w, T.NAVY, T.SECTION_END),
        SH_DATA: _shading(w, tip, base),
    }
    font_nums = (w.reserve(), w.reserve())
    xobjects = f"/XObject << /R2M {r2m_num} 0 R" + (f" /Logo {logo_num} 0 R" if logo_num else "") + " >> "
    shading_res = "/Shading << " + " ".join(f"/{k} {v} 0 R" for k, v in shadings.items()) + " >> "
    page_nums: List[int] = []
    for canvas in lay.pages:
        stream_num = w.stream("", canvas.stream())
        page_nums.append(
            w.add(
                (
                    f"<< /Type /Page /Parent {pages_num} 0 R /MediaBox [0 0 {lay.page_w:.2f} {lay.page_h:.2f}] "
                    f"/Resources << /Font << /F1 {font_nums[0]} 0 R /F2 {font_nums[1]} 0 R >> {xobjects}{shading_res}"
                    f"/ProcSet [/PDF /Text /ImageC] >> /Contents {stream_num} 0 R >>"
                ).encode("latin-1")
            )
        )
    # The fonts last: only now is it known which glyphs the pages drew.
    for num, font in zip(font_nums, (lay.regular, lay.bold)):
        P._font_objects(w, font, num)
    kids = " ".join(f"{n} 0 R" for n in page_nums)
    w.put(pages_num, f"<< /Type /Pages /Kids [{kids}] /Count {len(page_nums)} >>".encode("latin-1"))
    w.put(catalog, f"<< /Type /Catalog /Pages {pages_num} 0 R /ViewerPreferences << /Direction /R2L >> >>".encode("latin-1"))
    author = f" /Author {P._pdf_text(doc.generated_by)}" if doc.generated_by else ""
    info = w.add(
        (
            f"<< /Title {P._pdf_text(doc.title)}{author} /Producer (R2M POS) /Creator (R2M POS) "
            f"/CreationDate (D:{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%SZ')}) >>"
        ).encode("latin-1")
    )
    return w.output(catalog, info)
