"""
The designed reports' one look — light and clean (P:/specs/reports-designed-pdf.md §9): the
tokens every designed PDF is drawn with (app/services/report_design.py). Nothing here draws.

* **Page:** white. The only large dark fills are the header band (navy → bright blue) and the
  section bars (navy → steel blue); everything else is white cards with a thin light-grey
  border, light zebra rows and soft pastel callouts — it prints well, in colour or not.
* **Type:** Heebo (app/assets/fonts, SIL OFL; regular and bold), embedded whole — Hebrew, ₪ and
  the digits from one face. Sizes in points below.
* **Brand:** the R2M pixel logo in the band; the business's accent (the branding page's
  `brandPrimaryColor`) colours the data — chart bars, the share bars in tables, the first
  series — and the header band stays R2M's navy → blue.
"""
from __future__ import annotations

from typing import Dict, Tuple

RGB = Tuple[float, float, float]


def hex_rgb(value: str) -> RGB:
    v = value.lstrip("#")
    return (int(v[0:2], 16) / 255.0, int(v[2:4], 16) / 255.0, int(v[4:6], 16) / 255.0)


def mix(a: RGB, b: RGB, t: float) -> RGB:
    """`a` moved `t` of the way to `b`."""
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


# ── Colours ──────────────────────────────────────────────────────────────────

WHITE: RGB = (1.0, 1.0, 1.0)
#: The band's and the section bars' dark end, and the tables' header row.
NAVY = hex_rgb("#0B1D3F")
#: The header band's bright end.
BAND_END = hex_rgb("#0B6DB3")
#: The section bars' light end.
SECTION_END = hex_rgb("#1F5F92")
#: Text on the band: the facts' labels and the sub-title.
ON_DARK_2 = hex_rgb("#D3E4F7")
ON_DARK_3 = hex_rgb("#9CC0E6")
#: The cover's R2M watermark: a hair lighter than the band under it.
WATERMARK = hex_rgb("#10284F")

INK = hex_rgb("#0F172A")
TEXT2 = hex_rgb("#334155")
MUTED = hex_rgb("#64748B")
FAINT = hex_rgb("#94A3B8")
#: Card and table borders, heading rules.
BORDER = hex_rgb("#E2E8F0")
RULE = hex_rgb("#E7ECF2")
ROW_LINE = hex_rgb("#EEF2F6")
ZEBRA = hex_rgb("#F8FAFC")
SUBTOTAL_BG = hex_rgb("#F1F5F9")
TOTAL_BG = hex_rgb("#EEF2F7")
#: A share bar's empty track.
TRACK = hex_rgb("#EAEFF5")
#: A chart's compared series (last week, the previous period).
PREVIOUS = hex_rgb("#CBD5E1")

GOOD = hex_rgb("#15803D")
GOOD_BG = hex_rgb("#F0FDF4")
GOOD_LINE = hex_rgb("#BBF7D0")
BAD = hex_rgb("#B91C1C")
BAD_BG = hex_rgb("#FEF2F2")
BAD_LINE = hex_rgb("#FECACA")
WARN = hex_rgb("#B45309")
WARN_TEXT = hex_rgb("#78350F")
WARN_BG = hex_rgb("#FFFBEB")
WARN_LINE = hex_rgb("#FDE68A")
INFO = hex_rgb("#1D4ED8")
INFO_TEXT = hex_rgb("#1E3A8A")
INFO_BG = hex_rgb("#EFF6FF")
INFO_LINE = hex_rgb("#BFDBFE")
FLAT = hex_rgb("#475569")
FLAT_BG = hex_rgb("#F1F5F9")
FLAT_LINE = hex_rgb("#E2E8F0")

#: The accent when the branding page sets none: R2M's blue.
DEFAULT_ACCENT = hex_rgb("#0B6DB3")
#: A share bar's light end (the tip, at the left), for the default accent.
DATA_TIP = hex_rgb("#22B8E6")

#: Charts with several categories (a donut): the accent first, then these.
PALETTE = [hex_rgb(h) for h in (
    "#22B8E6", "#14B8A6", "#6366F1", "#F59E0B", "#EC4899", "#64748B", "#84CC16", "#F97316", "#8B5CF6", "#EF4444",
)]

#: A KPI card's strip (the coloured edge at the start) by its icon.
KPI_COLORS: Dict[str, RGB] = {k: hex_rgb(v) for k, v in {
    "sales": "#059669", "receipt": "#7C3AED", "basket": "#0284C7", "items": "#4F46E5", "box": "#4F46E5",
    "users": "#0D9488", "user": "#0D9488", "table": "#0D9488", "refund": "#DC2626", "void": "#DC2626",
    "alert": "#DC2626", "discount": "#D97706", "percent": "#D97706", "gift": "#D97706", "tip": "#DB2777",
    "clock": "#475569", "calendar": "#475569", "card": "#0891B2", "cash": "#EA580C", "star": "#CA8A04",
    "target": "#CA8A04", "kiosk": "#2563EB", "voucher": "#C026D3",
}.items()}

#: An insight's tone: "check" (yellow — worth a look), "good" (green), "tip" (blue).
INSIGHT_TONE = {"alert": "check", "down": "check", "leader": "good", "up": "good", "tip": "tip"}
#: Tone → (strong colour for the title and icons, text colour, background, border).
TONES: Dict[str, Tuple[RGB, RGB, RGB, RGB]] = {
    "check": (WARN, WARN_TEXT, WARN_BG, WARN_LINE),
    "good": (GOOD, hex_rgb("#14532D"), GOOD_BG, GOOD_LINE),
    "tip": (INFO, INFO_TEXT, INFO_BG, INFO_LINE),
    "bad": (BAD, hex_rgb("#7F1D1D"), BAD_BG, BAD_LINE),
    "flat": (FLAT, TEXT2, FLAT_BG, FLAT_LINE),
}
#: A reconciliation check's status → tone.
CHECK_TONE = {"match": "good", "mismatch": "bad", "pending": "check", "none": "flat"}

# ── Shapes and spacing (points) ──────────────────────────────────────────────

MARGIN = 28.0
#: The first page's header band: its bottom corners' radius.
BAND_RADIUS = 16.0
CARD_RADIUS = 7.0
SECTION_RADIUS = 7.0
TABLE_RADIUS = 6.0
CALLOUT_RADIUS = 8.0
#: Between blocks; between cards in a row.
GAP = 12.0
CARD_GAP = 9.0
SECTION_H = 24.0
#: A sub-heading (title, its rule) — the height it takes.
HEADING_H = 25.0
#: The footer's zone at the bottom of every page.
FOOTER_ZONE = 34.0
#: A KPI card's coloured strip.
STRIP_W = 3.4

# ── Type (points) ────────────────────────────────────────────────────────────

TITLE = 20.0
TITLE_LONG = 15.5
BAND_SUB = 9.5
FACT_LABEL = 7.2
FACT_VALUE = 10.5
SECTION = 10.8
HEADING = 10.5
HEADING_SUB = 7.8
KPI_LABEL = 8.0
KPI_VALUE = 17.0
KPI_SUB = 7.0
CALLOUT_TITLE = 9.0
CALLOUT = 8.6
CALLOUT_LINE = 12.6
HOW_TO_READ = 7.4
META = 7.8
FOOTER = 7.0
