"""
The printed prepaid voucher ("שובר הפקה"), laid out once for both renderers.

The server draws it with Pillow (app/services/prepaid_voucher_pdf.py) and the dashboard as
an SVG (client/src/lib/voucherLayout.ts + voucher-print.tsx). Both run this very algorithm —
the TypeScript is a line-by-line port — and only measure text with their own engine (both
in Heebo / Geist Mono, which ship with each). The shared golden fixture
tests/fixtures/prepaid_voucher_layout.json pins that the two produce the same operations
for the same voucher (with a fixed, fake measure), so they cannot drift apart.

The design (the owner, 08.10.2026: "שיהיה מקצועי"):

* the logo (optional) on top, the voucher type's name small above the title ("שובר ארוחה",
  the spec's §9), then the title (the event's name) large;
* what the voucher gives in a framed box — the goods with their quantities, or the discount
  in words — unless the batch hides it ("הצגת הפריטים על השובר" off); a long list shrinks,
  then ends with "ועוד N פריטים" rather than overflow;
* the till value when the type prints it ("שווי השובר: ₪80"; never the production price);
* the free text, then the validity in a strong line, then the terms in small print;
* the QR (or the Code 128 line) large, with a quiet zone, the code in monospace under it,
  and the short service number prominent ("מס׳ 0008");
* "נוצר על ידי Runner Systems" small at the very bottom (`show_credit`, on by default).

RTL throughout; a card wider than 1.15× its height puts the QR on the left and the text on
the right, any other card (and every Code 128 card) puts the barcode across the bottom.
Everything is pure black — no greys — so it prints clearly on a thermal head.

All measures are in millimetres from the card's top left. A text op's `y` is its baseline.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

#: measure(text, size_mm, bold, mono) → width in mm.
Measure = Callable[[str, float, bool, bool], float]

# Every size is × s, the card's scale (1 at a 50 mm short side), unless noted — text and the
# spaces between it at most × TEXT_SCALE_MAX, so an A6 card gets a bigger QR, not poster letters.
TEXT_SCALE_MAX = 1.6
MARGIN = 2.8
GAP = 1.5
#: Extra white between the QR and the text column (with the QR's own 2-module border it
#: keeps a quiet zone of 4 modules and more).
QUIET = 1.0
TITLE_PORTRAIT = 4.4
TITLE_LANDSCAPE = 4.0
TITLE_LH = 1.15
TITLE_LINES = 2
#: The voucher type's name above the title.
KICKER = 2.4
VALUE = 3.0
LOGO_PORTRAIT = 10.0
LOGO_LANDSCAPE = 8.0
LOGO_GAP = 1.2
BOX_PAD = 1.4
#: The box's line, mm × s, never thinner than BOX_STROKE_MIN mm (a thermal head loses hairlines).
BOX_STROKE = 0.35
BOX_STROKE_MIN = 0.3
BOX_RADIUS = 1.2
ITEM = 3.1
ITEM_LH = 1.3
#: A long list shrinks its rows down to this share of ITEM, then summarises the rest.
ITEM_MIN = 0.62
QTY_GAP = 1.2
BENEFIT = 3.3
BENEFIT_LH = 1.2
BENEFIT_LINES = 3
FREE = 2.5
FREE_LH = 1.25
FREE_MAX_LINES = 12
#: Free-text lines kept for it however long the list of goods.
FREE_RESERVE = 2
VALID = 2.6
TERMS = 2.1
SMALL_LH = 1.25
#: A portrait card's QR: what the text leaves, at least / at most this share of the height.
QR_PORTRAIT_MIN = 0.26
QR_PORTRAIT_MAX = 0.5
QR_LANDSCAPE = 0.40  # of the card's width
CODE = 2.5
SERIAL = 3.2
UNDER_GAP = 0.8
UNDER_LH = 1.25
CREDIT = 1.7
CREDIT_LH = 1.25
CREDIT_GAP = 0.8
#: A line's baseline below its top, × its size.
BASE = 0.8


@dataclass
class CardContent:
    """What one voucher says — texts already in their final words."""

    title: str
    #: The terms in small print ("מימוש חד-פעמי"); None: no line (with the validity hidden).
    terms: Optional[str]
    serial: str
    #: "code128" draws a line barcode across the bottom; anything else a QR.
    barcode: str = "qr"
    logo: bool = False
    #: A discount voucher's benefit ("₪30 הנחה על כל ההזמנה"); None for goods.
    benefit: Optional[str] = None
    #: Goods as (quantity label, name, quantity is RTL text) — "2×", or "0.5 ק״ג" (RTL).
    items: Sequence[Tuple[str, str, bool]] = ()
    free_text: Optional[str] = None
    validity: Optional[str] = None
    #: The code under the barcode (shown only when the batch asks), as printed.
    code: Optional[str] = None
    credit: Optional[str] = None
    #: "ועוד {n} פריטים" — the last row of a list too long for the card.
    more_items: str = "ועוד {n} פריטים"
    #: The voucher type's name, small above the title ("שובר ארוחה"); None: no line.
    kicker: Optional[str] = None
    #: "שווי השובר: ₪80" — when the type prints its till value; None: no line.
    value_line: Optional[str] = None


def _r(v: float) -> float:
    return round(v, 3)


def _text(text, x, y, size, *, bold=False, mono=False, align="right", rtl=True) -> Dict[str, Any]:
    return {
        "op": "text", "text": text, "x": x, "y": y, "size": size,
        "bold": bold, "mono": mono, "align": align, "rtl": rtl,
    }


def fit(measure: Measure, text: str, size: float, bold: bool, max_w: float, mono: bool = False) -> str:
    """[text], cut with "…" (in logical order) to fit [max_w]."""
    if measure(text, size, bold, mono) <= max_w:
        return text
    cut = text
    while cut and measure(cut + "…", size, bold, mono) > max_w:
        cut = cut[:-1]
    return cut + "…"


def wrap(measure: Measure, text: str, size: float, bold: bool, max_w: float, max_lines: int) -> List[str]:
    """Word-wrapped lines (its own line breaks kept), at most [max_lines], the last cut with "…"."""
    if max_lines <= 0:
        return []
    lines: List[str] = []
    for para in (text or "").splitlines():
        line = ""
        for word in para.split():
            candidate = f"{line} {word}" if line else word
            if not line or measure(candidate, size, bold, False) <= max_w:
                line = candidate
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)
    out = [fit(measure, l, size, bold, max_w) for l in lines[:max_lines]]
    if len(lines) > max_lines and out:
        out[-1] = fit(measure, lines[max_lines - 1] + "…", size, bold, max_w)
    return out


def _text_block(
    c: CardContent, measure: Measure, *, left: float, right: float, area: float, landscape: bool, t: float,
) -> Tuple[List[Dict[str, Any]], float]:
    """
    The text column — logo, title, the box, free text, validity, terms — laid out from y = 0
    in [area] mm of height: (its ops, the height it takes).
    """
    col = right - left
    gap = GAP * t
    align = "right" if landscape else "center"
    ax = right if landscape else (left + right) / 2
    ops: List[Dict[str, Any]] = []

    logo_h = ((LOGO_LANDSCAPE if landscape else LOGO_PORTRAIT) * t) if c.logo else 0.0
    logo_part = logo_h + LOGO_GAP * t if c.logo else 0.0
    kicker_size = KICKER * t
    kicker = fit(measure, c.kicker, kicker_size, True, col) if c.kicker else None
    kicker_h = kicker_size * SMALL_LH if kicker else 0.0
    title_size = (TITLE_LANDSCAPE if landscape else TITLE_PORTRAIT) * t
    title = wrap(measure, c.title, title_size, True, col, TITLE_LINES)
    title_h = len(title) * title_size * TITLE_LH
    value_size = VALUE * t
    value = fit(measure, c.value_line, value_size, True, col) if c.value_line else None
    value_h = (gap + value_size * SMALL_LH) if value else 0.0
    valid_size, terms_size = VALID * t, TERMS * t
    footer_h = (valid_size * SMALL_LH if c.validity else 0.0) + (terms_size * SMALL_LH if c.terms else 0.0)
    free_size = FREE * t
    free_lh = free_size * FREE_LH
    free_all = wrap(measure, c.free_text, free_size, False, col, FREE_MAX_LINES) if c.free_text else []
    # What the logo, the title and the footer leave for the box and the free text.
    # The gap above the footer only when there is a footer: no empty band (`show_validity` off).
    footer_gap = gap if footer_h else 0.0
    avail = area - logo_part - kicker_h - title_h - value_h - footer_gap - footer_h
    pad = BOX_PAD * t
    inner = col - 2 * pad

    box_rows: List[Dict[str, Any]] = []
    box_h = 0.0
    qty_w = 0.0
    if c.benefit:
        b_size = BENEFIT * t
        b_lines = wrap(measure, c.benefit, b_size, True, inner, BENEFIT_LINES)
        box_rows = [{"text": x, "size": b_size, "lh": b_size * BENEFIT_LH, "kind": "benefit"} for x in b_lines]
        box_h = sum(r["lh"] for r in box_rows) + 2 * pad
    elif c.items:
        reserve = (min(len(free_all), FREE_RESERVE) * free_lh + gap) if free_all else 0.0
        room = avail - gap - reserve - 2 * pad
        n = len(c.items)
        full = n * ITEM * t * ITEM_LH
        factor = 1.0 if full <= room else (max(ITEM_MIN, room / full) if room > 0 else ITEM_MIN)
        row_size = ITEM * t * factor
        row_lh = row_size * ITEM_LH
        fits = max(1, math.floor(room / row_lh)) if room > 0 else 1
        shown = n if fits >= n else max(1, fits - 1)
        qty_w = max(measure(q, row_size, True, False) for q, _, _ in c.items[:shown])
        for q, name, q_rtl in c.items[:shown]:
            box_rows.append({"qty": q, "qty_rtl": q_rtl, "text": name, "size": row_size, "lh": row_lh, "kind": "item"})
        if shown < n:
            box_rows.append({"text": c.more_items.format(n=n - shown), "size": row_size, "lh": row_lh, "kind": "more"})
        box_h = sum(r["lh"] for r in box_rows) + 2 * pad

    rem = avail - ((gap + box_h) if box_h else 0.0)
    free_n = min(len(free_all), max(0, math.floor((rem - gap) / free_lh))) if free_all else 0
    free = free_all if free_n >= len(free_all) else wrap(measure, c.free_text or "", free_size, False, col, free_n)

    y = 0.0
    if c.logo:
        ops.append({
            "op": "logo", "x": left, "y": y, "w": col, "h": logo_h, "align": "right" if landscape else "center",
        })
        y += logo_part
    if kicker:
        ops.append(_text(kicker, ax, y + kicker_size * BASE, kicker_size, bold=True, align=align))
        y += kicker_h
    for line in title:
        ops.append(_text(line, ax, y + title_size * BASE, title_size, bold=True, align=align))
        y += title_size * TITLE_LH
    if box_h:
        y += gap
        ops.append({
            "op": "box", "x": left, "y": y, "w": col, "h": box_h,
            "stroke": max(BOX_STROKE_MIN, BOX_STROKE * t), "radius": BOX_RADIUS * t,
        })
        ry = y + pad
        box_right = right - pad
        box_ax = box_right if landscape else (left + right) / 2
        for row in box_rows:
            base = ry + row["size"] * BASE
            if row["kind"] == "benefit":
                ops.append(_text(row["text"], box_ax, base, row["size"], bold=True, align=align))
            elif row["kind"] == "more":
                ops.append(_text(row["text"], box_right, base, row["size"]))
            else:
                ops.append(_text(row["qty"], box_right, base, row["size"], bold=True, rtl=row["qty_rtl"]))
                name_right = box_right - qty_w - QTY_GAP * t
                name = fit(measure, row["text"], row["size"], False, name_right - (left + pad))
                ops.append(_text(name, name_right, base, row["size"]))
            ry += row["lh"]
        y += box_h
    if value:
        y += gap
        ops.append(_text(value, ax, y + value_size * BASE, value_size, bold=True, align=align))
        y += value_size * SMALL_LH
    if free:
        y += gap
        for line in free:
            ops.append(_text(line, ax, y + free_size * BASE, free_size, align=align))
            y += free_lh
    y += footer_gap
    if c.validity:
        ops.append(_text(c.validity, ax, y + valid_size * BASE, valid_size, bold=True, align=align))
        y += valid_size * SMALL_LH
    if c.terms:
        ops.append(_text(c.terms, ax, y + terms_size * BASE, terms_size, align=align))
        y += terms_size * SMALL_LH
    return ops, y


def _shift(op: Dict[str, Any], dy: float) -> Dict[str, Any]:
    out = dict(op)
    out["y"] = op["y"] + dy
    return out


def _rounded(op: Dict[str, Any]) -> Dict[str, Any]:
    return {k: (_r(v) if isinstance(v, float) else v) for k, v in op.items()}


def layout(w: float, h: float, c: CardContent, measure: Measure) -> List[Dict[str, Any]]:
    """The card's drawing operations, in mm. See the module docstring for the design."""
    s = min(w, h) / 50.0
    t = min(s, TEXT_SCALE_MAX)
    linear = c.barcode == "code128"
    landscape = w >= h * 1.15 and not linear
    m = MARGIN * s
    gap = GAP * t
    ops: List[Dict[str, Any]] = []

    # ── Footer: the credit line ──────────────────────────────────────────────
    bottom = h - m
    if c.credit:
        size = CREDIT * t
        top = h - m - size * CREDIT_LH
        width = measure(c.credit, size, False, False)
        line_size = size * min(1.0, (w - 2 * m) / width) if width > 0 else size
        ops.append(_text(c.credit, w / 2, top + size * BASE, line_size, align="center"))
        bottom = top - CREDIT_GAP * t

    # ── The barcode block ────────────────────────────────────────────────────
    under: List[Tuple[str, float, bool, bool]] = []  # (text, size, mono, rtl)
    if c.code:
        under.append((c.code, CODE * t, True, False))
    under.append((c.serial, SERIAL * t, False, True))
    under_h = UNDER_GAP * t + sum(size * UNDER_LH for _, size, _, _ in under)
    if linear:
        bar_w = w - 2 * m
        bar_h = min(max(8.0, h * 0.2), 16.0)
        bx, by = m, bottom - bar_h - under_h
        ops.append({"op": "code128", "x": bx, "y": by, "w": bar_w, "h": bar_h})
        col_w, cx, code_h = bar_w, w / 2, bar_h
        left, right, top, text_bottom = m, w - m, m, by - gap
    elif landscape:
        side = min(bottom - m - under_h, w * QR_LANDSCAPE)
        bx, by = m, m + max(0.0, (bottom - m - side - under_h) / 2)
        ops.append({"op": "qr", "x": bx, "y": by, "side": side})
        col_w, cx, code_h = side, bx + side / 2, side
        left, right, top, text_bottom = m + side + gap + QUIET * t, w - m, m, bottom
    else:
        # The QR takes what the text leaves, between a floor and a ceiling: big on a tall card,
        # never so big that the text runs into it.
        left, right, top = m, w - m, m
        _, natural = _text_block(c, measure, left=left, right=right, area=1e6, landscape=False, t=t)
        most = min(w - 2 * m, h * QR_PORTRAIT_MAX)
        least = min(most, h * QR_PORTRAIT_MIN)
        side = max(least, min(most, bottom - top - under_h - gap - natural))
        bx, by = (w - side) / 2, bottom - side - under_h
        ops.append({"op": "qr", "x": bx, "y": by, "side": side})
        col_w, cx, code_h = w - 2 * m, w / 2, side
        text_bottom = by - gap
    y = by + code_h + UNDER_GAP * t
    for text, size, mono, rtl in under:
        width = measure(text, size, True, mono)
        line_size = size * min(1.0, col_w / width) if width > 0 else size
        ops.append(_text(text, cx, y + size * BASE, line_size, bold=True, mono=mono, align="center", rtl=rtl))
        y += size * UNDER_LH

    # ── The text column, centred in the height it has ───────────────────────
    area = text_bottom - top
    block, height = _text_block(c, measure, left=left, right=right, area=area, landscape=landscape, t=t)
    dy = top + max(0.0, (area - height) / 2)
    ops.extend(_shift(op, dy) for op in block)
    return [_rounded(op) for op in ops]


def fake_measure(text: str, size: float, bold: bool, mono: bool) -> float:
    """A fixed width per character — what the golden fixture is computed with, in both languages."""
    return size * len(text) * (0.6 if mono else 0.55 if bold else 0.5)
