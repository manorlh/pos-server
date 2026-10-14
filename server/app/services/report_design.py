"""
The designed report PDF (P:/specs/reports-designed-pdf.md §1, §5): one design language for every
report the dashboard exports, drawn with vector shapes only — no new package.

A `Document` is a header (title, period, scope, filters, logos) and a list of blocks, laid out top
to bottom over A4 pages (`render_document`):

* **Header band** — full width, in the R2M logo's own dark: the business logo on a white plate
  at the right, the R2M pixel logo (drawn as vector pixels from client/public/icons/icon-512.png)
  white at the left, the title large in the middle with the period and the scope under it, and
  a thin stripe of the brand's accent colour. Continuation pages carry a slim band.
* **KPI cards** (`KpiBlock`) — rounded, a narrow accent bar at the start (right), an icon, a big
  number, a sparkline and a ▲/▼ change chip (green when the move is good, red when bad).
* **Insight cards** (`InsightBlock`) — one per sentence, tinted by kind (leader, up, down, alert,
  tip) with a vector icon: a trophy, a rising or a falling line, a warning sign, a light bulb.
* **Charts** (`ChartBlock`) — bars, horizontal bars, a donut or a line, in the brand palette.
* **Tables** (`Table`) — zebra rows, bold subtotal and total rows, trend arrows, small % bars;
  long tables break across pages with the column headers repeated.
* **Footer** on every page — the R2M mark, "עמוד X מתוך Y", the business and when it was made.
* **Cover page** when the body runs past three pages: the logos, the title, the period and the
  four main KPIs.

Everything that tells good from bad has a shape as well as a colour (▲/▼, icons), so the report
still reads printed in black and white. Hebrew is laid out right to left (`report_pdf.visual`).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services import report_pdf as P

RGB = Tuple[float, float, float]


def hex_rgb(value: str) -> RGB:
    v = value.lstrip("#")
    return (int(v[0:2], 16) / 255.0, int(v[2:4], 16) / 255.0, int(v[4:6], 16) / 255.0)


def mix(a: RGB, b: RGB, t: float) -> RGB:
    """`a` moved `t` of the way to `b`."""
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


WHITE: RGB = (1.0, 1.0, 1.0)
#: The R2M logo's own dark (icon-512.png's background).
BAND = hex_rgb("#171717")
BAND_TEXT_2 = hex_rgb("#D4D4D8")
BAND_TEXT_3 = hex_rgb("#A1A1AA")
WATERMARK = hex_rgb("#222222")
INK = hex_rgb("#111827")
TEXT2 = hex_rgb("#374151")
MUTED = hex_rgb("#6B7280")
FAINT = hex_rgb("#9CA3AF")
LINE = hex_rgb("#E5E7EB")
ZEBRA = hex_rgb("#F7F8FA")
SUBTOTAL_BG = hex_rgb("#EEF1F5")
TOTAL_BG = hex_rgb("#E3E8EF")
GOOD = hex_rgb("#15803D")
GOOD_BG = hex_rgb("#DCFCE7")
BAD = hex_rgb("#B91C1C")
BAD_BG = hex_rgb("#FEE2E2")
FLAT_BG = hex_rgb("#F3F4F6")
PREVIOUS = hex_rgb("#C3CAD5")
#: The accent when the branding page sets none: blue.
DEFAULT_ACCENT = hex_rgb("#2563EB")
EXTRA_COLORS = [hex_rgb(h) for h in (
    "#F59E0B", "#10B981", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#64748B", "#84CC16", "#06B6D4", "#EF4444",
)]

#: Insight kind → (strong colour, tinted background).
INSIGHT_STYLES: Dict[str, Tuple[RGB, RGB]] = {
    "leader": (hex_rgb("#B45309"), hex_rgb("#FEF6E0")),
    "up": (hex_rgb("#15803D"), hex_rgb("#EAF8EF")),
    "down": (hex_rgb("#B91C1C"), hex_rgb("#FDEDED")),
    "alert": (hex_rgb("#C2410C"), hex_rgb("#FFF2E8")),
    "tip": (hex_rgb("#6D28D9"), hex_rgb("#F3EEFE")),
}
INSIGHT_TYPES = tuple(INSIGHT_STYLES)

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

MARGIN = P.MARGIN
BAND_H = 86.0
CONT_BAND_H = 30.0
#: The footer's zone at the bottom of every page.
FOOTER_ZONE = 34.0
GAP = 12.0
HEADING_H = 22.0
#: The largest box a business logo is drawn in (the cover's); embedded at 3 px per point.
LOGO_BOX = (150.0, 70.0)
HEADER_LOGO_MAX = (104.0, 50.0)
#: The table body pages above which a cover page is added (`cover: auto`).
COVER_AFTER_PAGES = 3

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
    title: str = "תובנות"


@dataclass
class ChartBlock:
    charts: List[Chart]
    height: Optional[float] = None


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
    lw = max(0.8, s * 0.11)

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
    elif name == "receipt":
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
    elif name == "tip_bulb":
        c.circle(cx, cy - h * 0.25, h * 0.58, fill=color)
        c.rect(cx - h * 0.28, cy + h * 0.25, h * 0.56, h * 0.28, color)
        c.rect(cx - h * 0.2, cy + h * 0.6, h * 0.4, h * 0.18, color)
        c.line(cx - h * 0.1, cy - h * 0.25, cx + h * 0.1, cy - h * 0.25, bg, lw * 0.7)
    else:  # chart
        bw = h * 0.42
        for k, frac in enumerate((0.55, 1.0, 0.75)):
            bx = cx - h * 0.85 + k * (bw + h * 0.2)
            c.rect(bx, cy + h * 0.8 - h * 1.6 * frac, bw, h * 1.6 * frac, color)


INSIGHT_ICON = {"leader": "leader", "up": "up", "down": "down", "alert": "alert", "tip": "tip_bulb"}


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
        self.tint = mix(self.accent, WHITE, 0.88)
        self.tint2 = mix(self.accent, WHITE, 0.8)
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

    def _first_header(self, c: P._Canvas) -> float:
        doc, regular, bold = self.doc, self.regular, self.bold
        c.rect(0, 0, self.page_w, BAND_H, BAND)
        c.rect(0, BAND_H - 2.5, self.page_w, 2.5, self.accent)
        lh = 17.0
        lw = lh * R2M_W / R2M_H
        c.form("R2M", self.left, (BAND_H - 2.5 - lh) / 2, lw, lh, R2M_W, R2M_H, WHITE)
        plate_w = 0.0
        if self.logo_box is not None:
            bw, bh = self.logo_box
            plate_w, plate_h = bw + 10, bh + 10
            px, py = self.right - plate_w, (BAND_H - 2.5 - plate_h) / 2
            c.round_rect(px, py, plate_w, plate_h, 5, fill=WHITE)
            c.image("Logo", px + 5, py + 5, bw, bh)
        inset = max(lw + 18, plate_w + 14)
        tl, tr = self.left + inset, self.right - inset
        size = 18.0
        lines = P._wrap(bold, doc.title, size, tr - tl, 2)
        if len(lines) > 1:
            size = 14.5
            lines = P._wrap(bold, doc.title, size, tr - tl, 2)
        subs = []
        if doc.period:
            subs.append((doc.period, 10.0, BAND_TEXT_2))
        if doc.scope:
            subs.append((doc.scope, 8.5, BAND_TEXT_3))
        block = len(lines) * size * 1.18 + sum(s * 1.45 for _t, s, _c in subs)
        y = (BAND_H - 2.5 - block) / 2
        for line in lines:
            y += size * 1.18
            c.text_in(bold, size, tl, tr, y - size * 0.22, _vis(line), "center", WHITE)
        for text, s, color in subs:
            y += s * 1.45
            c.text_in(regular, s, tl, tr, y - s * 0.3, _vis(P._fit(regular, text, s, tr - tl)), "center", color)

        # Under the band: when and by whom (left), the further lines and the filters (right).
        y = BAND_H + 6
        made = f"הופק {doc.generated_at}" if doc.generated_at else ""
        if doc.generated_by:
            made = f"{made} ע״י {doc.generated_by}".strip()
        made_w = regular.width(made, 7.6) if made else 0.0
        meta = [x for x in list(doc.extra_lines) + list(doc.filter_lines) if x]
        text = "  ·  ".join(meta)
        room = self.width - made_w - 18
        lines = P._wrap(regular, text, 7.8, room, 4) if text else []
        rows = max(1, len(lines)) if (lines or made) else 0
        for i in range(rows):
            base = y + 9 + i * 10.5
            if i < len(lines):
                c.text_in(regular, 7.8, self.left, self.right, base, _vis(lines[i]), "right", MUTED)
            if i == 0 and made:
                c.text_in(regular, 7.6, self.left, self.right, base, _vis(made), "left", FAINT)
        return y + rows * 10.5 + (8 if rows else 2)

    def _cont_header(self, c: P._Canvas) -> float:
        doc, regular, bold = self.doc, self.regular, self.bold
        c.rect(0, 0, self.page_w, CONT_BAND_H, BAND)
        c.rect(0, CONT_BAND_H - 1.5, self.page_w, 1.5, self.accent)
        lh = 9.0
        lw = lh * R2M_W / R2M_H
        c.form("R2M", self.left, (CONT_BAND_H - 1.5 - lh) / 2, lw, lh, R2M_W, R2M_H, WHITE)
        base = (CONT_BAND_H - 1.5) / 2 + 3.8
        room = self.width - lw - 20
        title = P._fit(bold, doc.title, 10.5, room * 0.62)
        tw = bold.width(title, 10.5)
        c.text_in(bold, 10.5, self.left, self.right, base, _vis(title), "right", WHITE, width=tw)
        if doc.period:
            period = P._fit(regular, doc.period, 8, room - tw - 14)
            c.text_in(regular, 8, self.left, self.right - tw - 12, base, _vis(period), "right", BAND_TEXT_3)
        return CONT_BAND_H + 14

    def footers(self) -> None:
        total = len(self.pages)
        regular, bold = self.regular, self.bold
        line_y = self.page_h - 25
        fy = self.page_h - 13
        doc = self.doc
        right_text = "  ·  ".join(
            x for x in (doc.business_name, f"נתונים נכונים ל-{doc.generated_at}" if doc.generated_at else "") if x
        )
        right_text = P._fit(regular, right_text, 7, self.width * 0.38) if right_text else ""
        mh = 6.5
        mw = mh * R2M_W / R2M_H
        for n, c in enumerate(self.pages, start=1):
            c.line(self.left, line_y, self.right, line_y, LINE, 0.6)
            c.form("R2M", self.left, fy - mh + 0.6, mw, mh, R2M_W, R2M_H, INK)
            c.text(bold, 7, self.left + mw + 3.5, fy, "POS", MUTED)
            c.text_in(regular, P.FOOTER_SIZE, self.left, self.right, fy, _vis(f"עמוד {n} מתוך {total}"), "center", MUTED)
            if right_text:
                c.text_in(regular, 7, self.left, self.right, fy, _vis(right_text), "right", MUTED)

    # ── Blocks ──

    def run(self) -> None:
        self.new_page()
        for block in self.doc.blocks:
            if isinstance(block, Table):
                self.table(block)
            elif isinstance(block, KpiBlock):
                self.kpi_block(block)
            elif isinstance(block, InsightBlock):
                self.insight_block(block)
            elif isinstance(block, ChartBlock):
                self.chart_block(block)
            elif isinstance(block, Heading):
                if block.new_page and not self.at_top():
                    self.new_page()
                self.need(HEADING_H + 70)
                self.heading(block.text, block.sub)
            elif isinstance(block, Note):
                self.note(block)
            elif isinstance(block, PageBreak):
                if not self.at_top():
                    self.new_page()
        if self._wants_cover():
            self.pages.insert(0, self.cover())
        self.footers()

    def _wants_cover(self) -> bool:
        mode = self.doc.cover
        if mode == "never":
            return False
        return mode == "always" or len(self.pages) > COVER_AFTER_PAGES

    def heading(self, text: str, sub: str = "") -> None:
        c, y = self.c, self.y
        c.round_rect(self.right - 3.5, y + 3, 3.5, 13, 1.75, fill=self.accent)
        tw = self.bold.width(text, 11.5)
        title = P._fit(self.bold, text, 11.5, self.width - 12)
        c.text_in(self.bold, 11.5, self.left, self.right - 9, y + 14, _vis(title), "right", INK)
        h = HEADING_H
        if sub:
            room = self.width - min(tw, self.width) - 30
            if room > 120 and self.regular.width(sub, 8) <= room:
                c.text_in(self.regular, 8, self.left, self.right, y + 14, _vis(sub), "left", MUTED)
            else:
                sub = P._fit(self.regular, sub, 8, self.width - 12)
                c.text_in(self.regular, 8, self.left, self.right - 9, y + 26, _vis(sub), "right", MUTED)
                h += 11
        self.y += h

    def note(self, block: Note) -> None:
        lines = P._wrap(self.regular, block.text, 8, self.width - 20, 6)
        h = len(lines) * 11 + 10
        self.need(h + 4)
        c, y = self.c, self.y
        if block.tone in ("info", "alert"):
            fg, bg = (INSIGHT_STYLES["alert"] if block.tone == "alert" else (self.accent, self.tint))
            c.round_rect(self.left, y, self.width, h, 5, fill=bg)
        else:
            fg = MUTED
        for i, line in enumerate(lines):
            c.text_in(self.regular, 8, self.left + 8, self.right - 10, y + 13 + i * 11, _vis(line), "right",
                      TEXT2 if block.tone != "muted" else MUTED)
        self.y += h + 6

    # KPI cards

    def kpi_block(self, block: KpiBlock) -> None:
        kpis = [k for k in block.kpis if k.label][:12]
        if not kpis:
            return
        per_row = 6 if self.landscape else 4
        rows = math.ceil(len(kpis) / per_row)
        k = math.ceil(len(kpis) / rows)
        rich = any(x.spark or x.compare is not None for x in kpis)
        card_h = 74.0 if rich else 56.0
        gap = 9.0
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
        self.y += GAP - gap + 2

    def kpi_card(self, c: P._Canvas, kpi: Kpi, x: float, y: float, w: float, h: float, big: bool = False) -> None:
        regular, bold = self.regular, self.bold
        r = 7.0
        c.round_rect(x, y, w, h, r, fill=WHITE, stroke=LINE, width=0.8)
        c.save()
        c.clip_round_rect(x, y, w, h, r)
        c.rect(x + w - 3.4, y, 3.4, h, self.accent)
        c.restore()
        pad = 10.0 if big else 8.5
        ir = 11.0 if big else 8.5
        icx, icy = x + w - pad - 3 - ir, y + pad + ir
        c.circle(icx, icy, ir, fill=self.tint)
        draw_icon(c, kpi.icon, icx, icy, ir * 1.15, self.accent, self.tint, regular, bold)
        ls = 9.5 if big else 7.8
        label = P._fit(regular, kpi.label, ls, max(10.0, icx - ir - 5 - (x + pad)))
        c.text_in(regular, ls, x + pad, icx - ir - 5, icy + ls * 0.36, _vis(label), "right", MUTED)
        value = kpi.display(short=not big)
        vis_value = _vis(value) if kpi.kind == "text" else value
        size = 24.0 if big else 16.5
        room = w - 2 * pad - 4
        while size > 8 and bold.width(vis_value, size) > room:
            size -= 0.5
        if bold.width(vis_value, size) > room:
            vis_value = P._fit(bold, vis_value, size, room)
        vy = y + pad + 2 * ir + size * 0.95 + (6 if big else 3)
        c.text_in(bold, size, x + pad, x + w - pad - 3, vy, vis_value, "right", INK)

        # Bottom row: the change chip (right), what it is against, the sparkline (left).
        by = y + h - pad
        spark_right = x + pad
        if len(kpi.spark) >= 2:
            sw = min(w * 0.4, 84.0 if big else 66.0)
            sh = 18.0 if big else 14.0
            self.sparkline(c, kpi.spark, x + pad, by - sh, sw, sh)
            spark_right = x + pad + sw + 4
        chip = kpi.chip_text()
        if chip is not None:
            good = kpi.good
            fg, bg = (GOOD, GOOD_BG) if good is True else ((BAD, BAD_BG) if good is False else (MUTED, FLAT_BG))
            cs = 8.0 if big else 7.2
            text = _vis(chip) if chip == "חדש" else chip
            tw = bold.width(text, cs)
            cw_, ch_ = tw + 17, cs + 5.5
            cx0 = x + w - pad - 3 - cw_
            cy0 = by - ch_
            c.round_rect(cx0, cy0, cw_, ch_, ch_ / 2, fill=bg)
            tx, ty = cx0 + cw_ - 7.5, cy0 + ch_ / 2
            d = kpi.direction
            if d == "up":
                c.polygon([(tx - 3, ty + 2.2), (tx + 3, ty + 2.2), (tx, ty - 2.6)], fill=fg)
            elif d == "down":
                c.polygon([(tx - 3, ty - 2.2), (tx + 3, ty - 2.2), (tx, ty + 2.6)], fill=fg)
            else:
                c.rect(tx - 2.8, ty - 0.6, 5.6, 1.2, fg)
            c.text(bold, cs, cx0 + 5, ty + cs * 0.36, text, fg)
            label = f"מול {kpi.compare_label}" if kpi.compare_label else ""
            room = cx0 - 4 - spark_right
            if label and room > 24:
                fitted = P._fit(regular, label, 6.6 if not big else 7.5, room)
                c.text_in(regular, 6.6 if not big else 7.5, spark_right, cx0 - 4, ty + 2.4, _vis(fitted), "right", FAINT)

    def sparkline(self, c: P._Canvas, values: Sequence[float], x: float, y: float, w: float, h: float) -> None:
        lo, hi = min(values), max(values)
        span = hi - lo or 1.0
        n = len(values)
        pts = [(x + w * i / (n - 1), y + h - (v - lo) / span * h) for i, v in enumerate(values)]
        c.polygon(pts + [(x + w, y + h), (x, y + h)], fill=self.tint)
        c.polyline(pts, self.accent, 1.1)
        c.circle(pts[-1][0], pts[-1][1], 1.7, fill=self.accent)

    # Insight cards

    def insight_block(self, block: InsightBlock) -> None:
        items = [i for i in block.insights if i.text][:10]
        if not items:
            return
        cols = min(3 if self.landscape else 2, len(items))
        gap = 8.0
        cw = (self.width - gap * (cols - 1)) / cols
        size, line_h, pad, ir = 8.4, 11.4, 7.0, 8.0
        text_w = cw - 2 * pad - 2 * ir - 7
        wrapped = [P._wrap(self.regular, i.text, size, text_w, 5) for i in items]
        heights = [max(2 * ir + 2 * pad, len(lines) * line_h + 2 * pad + 1) for lines in wrapped]
        rows = [list(range(r, min(r + cols, len(items)))) for r in range(0, len(items), cols)]
        first = max(heights[j] for j in rows[0])
        self.need(HEADING_H + first + 4)
        if block.title:
            self.heading(block.title)
        for row in rows:
            rh = max(heights[j] for j in row)
            self.need(rh + 4)
            for k, j in enumerate(row):
                x = self.right - (k + 1) * cw - k * gap
                self.insight_card(self.c, items[j], wrapped[j], x, self.y, cw, rh, size, line_h, pad, ir)
            self.y += rh + gap * 0.75
        self.y += GAP - gap * 0.75 + 2

    def insight_card(self, c: P._Canvas, item: Insight, lines: List[str], x: float, y: float, w: float, h: float,
                     size: float, line_h: float, pad: float, ir: float) -> None:
        fg, bg = INSIGHT_STYLES.get(item.type, INSIGHT_STYLES["tip"])
        c.round_rect(x, y, w, h, 6, fill=bg)
        c.save()
        c.clip_round_rect(x, y, w, h, 6)
        c.rect(x + w - 2.6, y, 2.6, h, fg)
        c.restore()
        icx, icy = x + w - pad - 2 - ir, y + pad + ir
        c.circle(icx, icy, ir, fill=fg)
        draw_icon(c, INSIGHT_ICON.get(item.type, "tip_bulb"), icx, icy, ir * 1.1, WHITE, fg, self.regular, self.bold)
        right = icx - ir - 6
        block_h = len(lines) * line_h
        top = y + max(pad, (h - block_h) / 2)
        for i, line in enumerate(lines):
            c.text_in(self.regular, size, x + pad, right, top + i * line_h + size * 0.95, _vis(line), "right", TEXT2)

    # Charts

    def chart_height(self, ch: Chart) -> float:
        if ch.type == "hbar":
            return 34.0 + 15.0 * min(len(ch.labels), 12) + 6
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
        self.y += GAP - gap + 2

    def colors(self, n: int) -> List[RGB]:
        return [self.accent] + EXTRA_COLORS[: max(0, n - 1)] if n <= len(EXTRA_COLORS) + 1 else (
            [self.accent] + EXTRA_COLORS * (n // len(EXTRA_COLORS) + 1))[:n]

    def series_colors(self, n: int) -> List[RGB]:
        if n == 1:
            return [self.accent]
        if n == 2:
            return [self.accent, PREVIOUS]
        return [self.accent, mix(self.accent, WHITE, 0.45), PREVIOUS][:n]

    def chart(self, c: P._Canvas, ch: Chart, x: float, y: float, w: float, h: float) -> None:
        regular, bold = self.regular, self.bold
        c.round_rect(x, y, w, h, 7, fill=WHITE, stroke=LINE, width=0.8)
        if ch.title:
            c.text_in(bold, 9, x + 10, x + w - 10, y + 15, _vis(P._fit(bold, ch.title, 9, w - 20)), "right", INK)
        if len(ch.series) > 1 and ch.type in ("bar", "line", "hbar"):
            colors = self.series_colors(len(ch.series))
            lx = x + 10
            for s, color in zip(ch.series, colors):
                if not s.name:
                    continue
                c.round_rect(lx, y + 9, 7, 7, 1.5, fill=color)
                name = _vis(s.name)
                c.text(regular, 7, lx + 10, y + 15, name, MUTED)
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
        px0, px1 = x + 10 + axis_w, x + w - 10
        py0, py1 = y + 28, y + h - 18

        def ymap(v: float) -> float:
            return py1 - (v - bot) / (top - bot) * (py1 - py0)

        for t, label in zip(ticks, tick_labels):
            yy = ymap(t)
            c.line(px0, yy, px1, yy, LINE if t != 0 else FAINT, 0.5 if t != 0 else 0.7)
            c.text_in(regular, 6.3, x, px0 - 4, yy + 2.2, label, "right", FAINT)
        group = (px1 - px0) / n
        colors = self.series_colors(len(ch.series))
        if line:
            first = True
            for s, color in reversed(list(zip(ch.series, colors))):
                pts = [(px0 + group * (i + 0.5), ymap(v)) for i, v in enumerate(s.values)]
                if s is ch.series[0] and len(pts) > 1:
                    c.polygon(pts + [(pts[-1][0], ymap(max(bot, 0))), (pts[0][0], ymap(max(bot, 0)))], fill=self.tint)
                c.polyline(pts, color, 1.6 if s is ch.series[0] else 1.1)
                if n <= 31:
                    for px, py in pts:
                        c.circle(px, py, 1.6 if s is ch.series[0] else 1.2, fill=color)
                first = False
        else:
            inner = group * 0.74
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
                        fill = mix(self.accent, WHITE, 0.28)
                    c.round_rect(gx + k * bw + 0.4, top_y, max(0.6, bw - 0.8), bh, min(1.6, bw / 4), fill=fill)
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
        plot_r = x + w - 10 - label_w - 6
        plot_l = x + 10 + val_w
        pitch = min(18.0, max(12.0, (h - 34) / len(items)))
        bh = pitch * 0.56
        for k, i in enumerate(items):
            ry = y + 28 + k * pitch
            label = P._fit(regular, ch.labels[i], 7.4, label_w)
            c.text_in(regular, 7.4, x + 10, x + w - 10, ry + bh / 2 + 2.6, _vis(label), "right", TEXT2)
            c.round_rect(plot_l, ry, plot_r - plot_l, bh, bh / 2.4, fill=ZEBRA)
            length = max(0.0, (plot_r - plot_l) * max(main[i], 0) / vmax)
            color = self.accent if k == 0 else mix(self.accent, WHITE, min(0.55, 0.18 + 0.04 * k))
            if length > 0.5:
                c.round_rect(plot_r - length, ry, length, bh, bh / 2.4, fill=color)
            if prev is not None and prev[i] > 0:
                lp = (plot_r - plot_l) * prev[i] / vmax
                c.rect(plot_r - lp, ry + bh + 0.8, lp, 1.6, PREVIOUS)
            c.text_in(bold, 7, x, plot_r - length - 3, ry + bh / 2 + 2.5, values[k], "right", INK)

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
        radius = max(20.0, min((h - 36) / 2, w * 0.2))
        cx, cy = x + 16 + radius, y + 22 + (h - 22) / 2
        colors = self.colors(len(pairs))
        a = math.pi / 2
        bounds = []
        for (label, v), color in zip(pairs, colors):
            sweep = 2 * math.pi * v / total
            c.ring_segment(cx, cy, radius, radius * 0.6, a, a - sweep, color)
            bounds.append(a)
            a -= sweep
        if len(pairs) > 1:
            for b in bounds:
                c.line(cx + radius * 0.58 * math.cos(b), cy - radius * 0.58 * math.sin(b),
                       cx + radius * 1.02 * math.cos(b), cy - radius * 1.02 * math.sin(b), WHITE, 1.2)
        total_text = format_value(total, ch.kind, short=True)
        ts = 10.0
        while ts > 6 and bold.width(total_text, ts) > radius * 1.1:
            ts -= 0.5
        c.text_in(bold, ts, cx - radius, cx + radius, cy + 1.5, total_text, "center", INK)
        c.text_in(regular, 6.5, cx - radius, cx + radius, cy + 10, _vis(P.TOTAL_LABEL), "center", MUTED)
        lx_r = x + w - 12
        lx_l = cx + radius + 14
        pitch = min(14.0, (h - 30) / max(1, len(pairs)))
        ly = y + 30 + max(0.0, (h - 36 - pitch * len(pairs)) / 2)
        for k, ((label, v), color) in enumerate(zip(pairs, colors)):
            yy = ly + k * pitch
            c.round_rect(lx_r - 7, yy - 6.5, 7, 7, 1.6, fill=color)
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
        size, widths = P.column_widths(cols, t.rows, t.totals, regular, bold, self.width)
        edges = [self.right]
        for wd in widths:
            edges.append(edges[-1] - wd)
        labels = [P._wrap(bold, col.label, size, max(1.0, widths[i] - 2 * P.PAD), 2) or [""] for i, col in enumerate(cols)]
        head_h = max(len(x) for x in labels) * size * 1.25 + 8
        row_h = round(size * 1.95, 2)
        styles = t.styles or ["row"] * len(t.rows)
        anchors = [col.anchor for col in cols]
        numeric = [col.numeric for col in cols]
        kinds = [col.kind for col in cols]
        bars = [col.kind == "percent" and col.bar for col in cols]
        title_h = HEADING_H + (11 if t.subtitle and self.regular.width(t.subtitle, 8) > self.width / 2 else 0) if t.title else 0
        self.need(title_h + head_h + row_h * min(3, len(t.rows) + 1))

        def head(cont: bool) -> None:
            if t.title:
                self.heading(t.title + (" (המשך)" if cont else ""), "" if cont else t.subtitle)
            c, y = self.c, self.y
            c.rect(edges[-1], y, self.right - edges[-1], head_h, self.tint)
            c.line(edges[-1], y + head_h, self.right, y + head_h, self.accent, 1.0)
            for i, col in enumerate(cols):
                block = len(labels[i]) * size * 1.25
                ly = y + (head_h - block) / 2
                for label in labels[i]:
                    ly += size * 1.25
                    c.text_in(bold, size, edges[i + 1] + P.PAD, edges[i] - P.PAD, ly - size * 0.3, P.visual(label),
                              anchors[i], INK)
            self.y += head_h

        head(False)
        zebra = 0
        last = None
        for idx, (row, style) in enumerate(zip(t.rows, styles)):
            better = t.row_better[idx] if t.row_better and idx < len(t.row_better) else None
            if self.y + row_h > self.bottom:
                self.c.line(edges[-1], self.y, self.right, self.y, LINE, 0.6)
                self.new_page()
                head(True)
            if style == "sub":
                self.c.rect(edges[-1], self.y, self.right - edges[-1], row_h, SUBTOTAL_BG)
                self._row(row, edges, size, row_h, anchors, numeric, kinds, bars, bold, cols, better=better)
                zebra = 0
            else:
                if zebra % 2 == 1:
                    self.c.rect(edges[-1], self.y, self.right - edges[-1], row_h, ZEBRA)
                self._row(row, edges, size, row_h, anchors, numeric, kinds, bars, regular, cols, better=better)
                zebra += 1
            self.y += row_h
            last = style
        if not t.rows:
            self.c.text_in(regular, size, self.left, self.right, self.y + row_h / 2 + size * 0.35, _vis(t.empty_text),
                           "center", FAINT)
            self.y += row_h
        if t.totals:
            if self.y + row_h > self.bottom:
                self.new_page()
                head(True)
            c = self.c
            c.rect(edges[-1], self.y, self.right - edges[-1], row_h, TOTAL_BG)
            c.line(edges[-1], self.y, self.right, self.y, INK, 0.9)
            self._row(t.totals, edges, size, row_h, anchors, numeric, kinds, bars, bold, cols, totals=True)
            self.y += row_h
        self.c.line(edges[-1], self.y, self.right, self.y, FAINT if last != "sub" else LINE, 0.6)
        self.y += GAP

    def _row(self, row: Sequence[str], edges: List[float], size: float, row_h: float, anchors, numeric, kinds,
             bars, font: P._Font, cols, totals: bool = False, better: Optional[str] = None) -> None:
        c = self.c
        y = self.y
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
                color = MUTED if abs(v) < 0.05 else (GOOD if good else BAD)
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
            width = font.width(text, size)
            if width > room:
                text = P._fit(font, text, size, room)
                width = font.width(text, size)
            c.text_in(font, size, left, right, baseline, text if numeric[i] else P.visual(text), anchors[i],
                      INK, width=width)
            if bars[i] and not totals:
                v = _float(text)
                if v is not None and v > 0:
                    frac = min(1.0, v / 100.0)
                    by = y + row_h - 3.2
                    c.rect(left, by, room, 1.8, LINE)
                    c.rect(right - room * frac, by, room * frac, 1.8, self.accent)

    # The cover

    def cover(self) -> P._Canvas:
        doc, regular, bold = self.doc, self.regular, self.bold
        c = P._Canvas(self.page_h)
        band = self.page_h * (0.5 if self.landscape else 0.44)
        c.rect(0, 0, self.page_w, band, BAND)
        # The R2M pixels, large and faint, as a watermark in the band's corner.
        wm_h = band * 0.42
        c.save()
        c.clip_round_rect(0, 0, self.page_w, band, 0)
        c.form("R2M", -wm_h * 0.55, band - wm_h * 0.72, wm_h * R2M_W / R2M_H, wm_h, R2M_W, R2M_H, WATERMARK)
        c.restore()
        c.rect(0, band - 4, self.page_w, 4, self.accent)
        lh = 24.0
        c.form("R2M", self.left, 34, lh * R2M_W / R2M_H, lh, R2M_W, R2M_H, WHITE)
        c.text(regular, 8, self.left, 34 + lh + 14, "POS", BAND_TEXT_3)
        if doc.logo is not None:
            iw, ih = doc.logo.size
            scale = min(LOGO_BOX[0] / iw, LOGO_BOX[1] / ih)
            bw, bh = iw * scale, ih * scale
            c.round_rect(self.right - bw - 14, 28, bw + 14, bh + 14, 7, fill=WHITE)
            c.image("Logo", self.right - bw - 7, 35, bw, bh)
        tl, tr = self.left + 30, self.right - 30
        size = 30.0
        lines = P._wrap(bold, doc.title, size, tr - tl, 3)
        while len(lines) > 2 and size > 20:
            size -= 2
            lines = P._wrap(bold, doc.title, size, tr - tl, 3)
        block = len(lines) * size * 1.2 + (14 * 1.6 if doc.period else 0) + (11 * 1.6 if doc.scope else 0)
        y = band * 0.58 - block / 2
        for line in lines:
            y += size * 1.2
            c.text_in(bold, size, tl, tr, y - size * 0.2, _vis(line), "center", WHITE)
        if doc.period:
            y += 14 * 1.6
            c.text_in(regular, 14, tl, tr, y - 4, _vis(P._fit(regular, doc.period, 14, tr - tl)), "center", BAND_TEXT_2)
        if doc.scope:
            y += 11 * 1.6
            c.text_in(regular, 11, tl, tr, y - 3, _vis(P._fit(regular, doc.scope, 11, tr - tl)), "center", BAND_TEXT_3)

        kpis = doc.cover_kpis
        if kpis is None:
            kpis = next((b.kpis for b in doc.blocks if isinstance(b, KpiBlock) and b.kpis), [])
        kpis = kpis[:4]
        y = band + 28
        if kpis:
            saved = (self.pages, self.y)
            self.pages, self.y = [c], y
            self.heading("עיקרי הדוח")
            y = self.y + 4
            self.pages, self.y = saved
            cols = 4 if self.landscape else 2
            gap = 12.0
            k = min(cols, len(kpis))
            cw = (self.width - gap * (k - 1)) / k
            ch_ = 100.0
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
    font_nums = (w.reserve(), w.reserve())
    xobjects = f"/XObject << /R2M {r2m_num} 0 R" + (f" /Logo {logo_num} 0 R" if logo_num else "") + " >> "
    page_nums: List[int] = []
    for canvas in lay.pages:
        stream_num = w.stream("", canvas.stream())
        page_nums.append(
            w.add(
                (
                    f"<< /Type /Page /Parent {pages_num} 0 R /MediaBox [0 0 {lay.page_w:.2f} {lay.page_h:.2f}] "
                    f"/Resources << /Font << /F1 {font_nums[0]} 0 R /F2 {font_nums[1]} 0 R >> {xobjects}"
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
