"""
Prepaid vouchers ("שוברי הפקה") as PDF files, drawn on the server.

The dashboard used to rasterise its HTML preview in the browser (html-to-image +
jsPDF). That came out blank whenever the browser could not draw the page into a
canvas — Safari / iPhone, or a logo served from another origin without CORS — so the
file is now drawn here, the same in every browser:

* each page is drawn with Pillow at 300 dpi — the QR by `segno`, the Code 128 line
  barcode by `barcode128`, Hebrew put into visual order by `python-bidi` (Pillow here has
  no libraqm, so it cannot do RTL itself; Hebrew needs no shaping, only ordering);
* the pages are saved as one PDF at their real size in mm.

Barcodes are drawn at a whole number of pixels per module (no resampling), so every bar
and every QR cell is the same width on paper — what a scanner needs.

Layouts match the dashboard's print presets (`voucher-print.tsx`): an 80×50 ticket, a
card either way round, an 80×120 ticket, A6, an A4 sheet of eight to cut, or custom.
Text is part of the image — fine for printing, not for copy-paste.

Production in groups (docs/SPEC_VOUCHER_PRODUCTION.md): [render_groups_zip] makes a PDF
per group, each opening with a cover sheet for the envelope (customer, order, group n of
N, serials, count, goods, validity), plus the run's CSV manifest ([manifest_csv]).
"""
from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.services import barcode128, local_media
from app.services.prepaid_vouchers import format_code, qr_payload

DPI = 300

#: id → (width mm, height mm, cols, rows)
PRESETS = {
    "ticket80x50": (80.0, 50.0, 1, 1),
    "card86x54": (86.0, 54.0, 1, 1),
    "card54x86": (54.0, 86.0, 1, 1),
    "ticket80x120": (80.0, 120.0, 1, 1),
    "a6": (105.0, 148.0, 1, 1),
    "a4grid": (210.0, 297.0, 2, 4),
}

_FONT_CANDIDATES = {
    False: [
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ],
    True: [
        "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ],
}
#: A monospaced face for the code under the barcode: "0" / "O" and "8" / "B" told apart.
_MONO_CANDIDATES = [
    "C:/Windows/Fonts/consolab.ttf",
    "C:/Windows/Fonts/courbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf",
]


@dataclass(frozen=True)
class Geometry:
    page_w: float
    page_h: float
    cols: int
    rows: int

    @property
    def card_w(self) -> float:
        return self.page_w / self.cols

    @property
    def card_h(self) -> float:
        return self.page_h / self.rows

    @property
    def per_page(self) -> int:
        return self.cols * self.rows


def geometry(preset: str, width: Optional[float] = None, height: Optional[float] = None) -> Geometry:
    if preset == "custom":
        w = min(300.0, max(30.0, float(width or 80)))
        h = min(300.0, max(30.0, float(height or 50)))
        return Geometry(w, h, 1, 1)
    w, h, cols, rows = PRESETS.get(preset, PRESETS["ticket80x50"])
    return Geometry(w, h, cols, rows)


def _px(mm: float) -> int:
    return max(1, round(mm / 25.4 * DPI))


@lru_cache(maxsize=64)
def _font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES[bold]:
        if Path(path).is_file():
            return ImageFont.truetype(path, size_px)
    return ImageFont.load_default(size_px)


@lru_cache(maxsize=16)
def _mono(size_px: int) -> ImageFont.FreeTypeFont:
    for path in _MONO_CANDIDATES:
        if Path(path).is_file():
            return ImageFont.truetype(path, size_px)
    return _font(size_px, bold=True)


def _visual(text: str) -> str:
    """Logical → visual order, so Pillow can draw it left to right."""
    from bidi.algorithm import get_display

    return get_display(text or "", base_dir="R")


def _fit(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
    """The text, cut with "…" to fit [max_w] (cut in logical order, then made visual)."""
    if draw.textlength(_visual(text), font=font) <= max_w:
        return _visual(text)
    cut = text
    while cut and draw.textlength(_visual(cut + "…"), font=font) > max_w:
        cut = cut[:-1]
    return _visual(cut + "…")


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int, max_lines: int) -> List[str]:
    """Word-wrapped lines (logical words), each line made visual; at most [max_lines]."""
    lines: List[str] = []
    for para in (text or "").splitlines():
        words = para.split()
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if draw.textlength(_visual(candidate), font=font) <= max_w or not line:
                line = candidate
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)
    out = [_fit(draw, l, font, max_w) for l in lines[:max_lines]]
    if len(lines) > max_lines and out:
        out[-1] = _fit(draw, lines[max_lines - 1] + "…", font, max_w)
    return out


# ── Barcodes ──────────────────────────────────────────────────────────────────


def _qr_image(payload: str, side_px: int) -> Image.Image:
    """
    The QR at the largest whole number of pixels per cell that fits [side_px] (no
    resampling: every cell the same size) — so at most [side_px] square.
    """
    import segno

    qr = segno.make(payload, error="m", micro=False)
    cells = qr.symbol_size(border=2)[0]
    scale = max(1, side_px // cells)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=2)
    buf.seek(0)
    img = Image.open(buf).convert("L")
    if img.width > side_px:  # a side too small for one pixel a cell: shrink, as before
        return img.resize((side_px, side_px), Image.NEAREST)
    return img


def _code128_image(payload: str, max_w: int, height: int) -> Image.Image:
    """
    The Code 128 symbol at the widest whole number of pixels per module that fits
    [max_w] (quiet zones included), [height] tall.
    """
    mods = barcode128.modules(payload)
    unit = max(1, max_w // len(mods))
    img = Image.new("L", (unit * len(mods), max(1, height)), 255)
    d = ImageDraw.Draw(img)
    x = 0
    for bar in mods:
        if bar:
            d.rectangle([x, 0, x + unit - 1, img.height - 1], fill=0)
        x += unit
    return img


# ── Texts ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Labels:
    serial: str = "שובר מס׳ {n}"
    group: str = "קבוצה {g}"
    split_allowed: str = "ניתן לממש בחלקים"
    one_time: str = "מימוש חד-פעמי"
    valid_until: str = "בתוקף עד {until}"
    valid_from: str = "בתוקף מ-{since}"
    valid_between: str = "בתוקף {since}-{until}"
    # Cover sheet ("דף שער") of a group.
    cover_group: str = "קבוצה {g} מתוך {n}"
    cover_serials: str = "שוברים {lo}-{hi}"
    cover_count: str = "{n} שוברים בקבוצה"
    cover_count_partial: str = "{n} שוברים מודפסים (מתוך {issued} בקבוצה)"
    cover_customer: str = "לקוח: {v}"
    cover_order: str = "הזמנה: {v}"
    cover_per_voucher: str = "בכל שובר: {items}"
    cover_total: str = "סה״כ בקבוצה: {items}"
    cover_made: str = "הופק: {date}"
    cover_handover: str = "נמסר ל: ____________   חתימה: ____________"


@dataclass(frozen=True)
class PrintOptions:
    """What the batch asks for on paper, and the texts that depend on the tenant's clock."""

    barcode_type: str = "qr"
    show_code: bool = False
    #: Already formatted for the tenant's zone, e.g. "בתוקף עד 14/08/2026"; None: no line.
    validity: Optional[str] = None


def options_for(batch: PrepaidVoucherBatch, zone=None, labels: Labels = Labels()) -> PrintOptions:
    return PrintOptions(
        barcode_type=(getattr(batch, "barcode_type", None) or "qr"),
        show_code=bool(getattr(batch, "show_code", False)),
        validity=validity_text(batch, zone, labels),
    )


def _local_day(moment: Optional[datetime], zone) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    if zone is not None:
        moment = moment.astimezone(zone)
    return moment.strftime("%d/%m/%Y")


def validity_text(batch: PrepaidVoucherBatch, zone=None, labels: Labels = Labels()) -> Optional[str]:
    """"בתוקף עד 14/08/2026" (or from / between), in the tenant's days; None without dates."""
    since = _local_day(batch.valid_from, zone)
    until = _local_day(batch.valid_until, zone)
    if since and until:
        return labels.valid_between.format(since=since, until=until)
    if until:
        return labels.valid_until.format(until=until)
    if since:
        return labels.valid_from.format(since=since)
    return None


def under_barcode_lines(voucher: PrepaidVoucher, opts: PrintOptions, labels: Labels = Labels()) -> List[str]:
    """
    What is printed under the barcode, top to bottom: the code itself when the batch says
    so ("ABCD-EFGH-2345-6789"), then the serial (and the group, in a grouped run).
    """
    lines: List[str] = []
    if opts.show_code:
        lines.append(format_code(voucher.code))
    serial = labels.serial.format(n=str(voucher.serial).zfill(4))
    group_no = getattr(voucher, "group_no", None)
    if group_no:
        serial += " · " + labels.group.format(g=group_no)
    lines.append(serial)
    return lines


# ── Logo ──────────────────────────────────────────────────────────────────────


def load_logo(url: Optional[str]) -> Optional[Image.Image]:
    """The batch logo: read from local media when it is ours, else downloaded. None on any failure."""
    if not url:
        return None
    try:
        path = urlparse(url).path
        if path.startswith(local_media.MEDIA_PREFIX + "/"):
            parts = [p for p in path[len(local_media.MEDIA_PREFIX) + 1:].split("/") if p]
            if parts and not any(p in (".", "..") or ":" in p for p in parts):
                target = local_media.MEDIA_DIR.joinpath(*parts)
                if target.is_file():
                    return _flatten(Image.open(target))
        import httpx

        resp = httpx.get(url, timeout=10, follow_redirects=True)
        resp.raise_for_status()
        return _flatten(Image.open(io.BytesIO(resp.content)))
    except Exception:  # noqa: BLE001 — a voucher without its logo beats no voucher
        return None


def _flatten(img: Image.Image) -> Image.Image:
    img.load()
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, "white")
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return img.convert("RGB")


# ── A voucher ─────────────────────────────────────────────────────────────────


def _draw_card(
    batch: PrepaidVoucherBatch,
    voucher: PrepaidVoucher,
    w_mm: float,
    h_mm: float,
    logo: Optional[Image.Image],
    labels: Labels,
    cut_lines: bool,
    opts: PrintOptions = PrintOptions(),
) -> Image.Image:
    W, H = _px(w_mm), _px(h_mm)
    card = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(card)
    s = min(w_mm, h_mm) / 50.0  # 1 at a 50 mm short side
    pad = _px(2.6 * s)
    gap = _px(2 * s)
    linear = opts.barcode_type == "code128"
    # A line barcode needs the card's width: it always sits across the bottom.
    landscape = w_mm >= h_mm * 1.15 and not linear

    f_serial = _font(_px(2.4 * s), bold=True)
    f_code = _mono(_px(2.6 * s))
    under = under_barcode_lines(voucher, opts, labels)
    # The code (first, when shown) is Latin and drawn as is; the serial line is Hebrew.
    is_code = [opts.show_code and i == 0 for i in range(len(under))]
    line_fonts = [f_code if code else f_serial for code in is_code]
    under_h = sum(int(f.size * 1.25) for f in line_fonts) + _px(0.6 * s)

    # The barcode block: the barcode, then the lines under it.
    if linear:
        bar_h = int(min(max(_px(8), H * 0.2), _px(16)))
        code_img = _code128_image(qr_payload(voucher.code), W - 2 * pad, bar_h)
        block_w, block_h = code_img.width, bar_h + under_h
    else:
        if landscape:
            side = int(min(H - 2 * pad - under_h, W * 0.42))
        else:
            side = int(min(W - 2 * pad, H * 0.38))
        code_img = _qr_image(qr_payload(voucher.code), side)
        block_w, block_h = code_img.width, code_img.height + under_h

    if landscape:
        # QR on the left, text on the right (RTL: the text column starts at the right edge).
        bx, by = pad, max(pad, (H - block_h) // 2)
        text_left, text_right, text_top, text_bottom = pad + block_w + gap, W - pad, pad, H - pad
    else:
        bx, by = (W - block_w) // 2, H - pad - block_h
        text_left, text_right, text_top, text_bottom = pad, W - pad, pad, by - gap
    card.paste(code_img, (bx, by))
    cx = bx + block_w // 2
    ly = by + code_img.height + _px(0.6 * s)
    for text, font, code in zip(under, line_fonts, is_code):
        d.text((cx, ly), text if code else _visual(text), font=font, fill="black", anchor="mt")
        ly += int(font.size * 1.25)

    # The text column, right-aligned.
    text_w = text_right - text_left
    y = text_top
    if logo is not None:
        max_logo_h = _px((9 if landscape else 12) * s)
        lw, lh = logo.size
        scale = min(max_logo_h / lh, text_w / lw)
        lg = logo.resize((max(1, int(lw * scale)), max(1, int(lh * scale))), Image.LANCZOS)
        lx = text_right - lg.width if landscape else text_left + (text_w - lg.width) // 2
        card.paste(lg, (lx, y))
        y += lg.height + _px(1.1 * s)

    def line(text: str, font, *, center: bool = False) -> None:
        nonlocal y
        if y + font.size > text_bottom:
            return
        if center:
            d.text((text_left + text_w // 2, y), text, font=font, fill="black", anchor="ma")
        else:
            d.text((text_right, y), text, font=font, fill="black", anchor="ra")
        y += int(font.size * 1.22)

    center = not landscape
    title_font = _font(_px(4 * s), bold=True)
    for t in _wrap(d, batch.event_name or batch.name, title_font, text_w, 2):
        line(t, title_font, center=center)
    y += _px(0.6 * s)

    items = list(batch.items)
    n = len(items)
    item_size = 3.1 * s * (max(0.55, (4 / n) ** 0.5) if n > 4 else 1)
    item_font = _font(_px(item_size))
    qty_font = _font(_px(item_size), bold=True)
    for it in items:
        if y + item_font.size > text_bottom:
            break
        qty = f"{int(it.quantity)}×"
        qty_w = int(d.textlength(qty, font=qty_font))
        name = _fit(d, it.product_name, item_font, text_w - qty_w - _px(1.2 * s))
        if center:
            name_w = int(d.textlength(name, font=item_font))
            total = qty_w + _px(1.2 * s) + name_w
            right = text_left + (text_w + total) // 2
        else:
            right = text_right
        d.text((right, y), qty, font=qty_font, fill="black", anchor="ra")
        d.text((right - qty_w - _px(1.2 * s), y), name, font=item_font, fill="black", anchor="ra")
        y += int(item_font.size * 1.25)
    y += _px(0.6 * s)

    if batch.free_text:
        ft = _font(_px(2.5 * s))
        for t in _wrap(d, batch.free_text, ft, text_w, 3):
            line(t, ft, center=center)
    small = _font(_px(2.1 * s))
    if opts.validity:
        line(_visual(opts.validity), _font(_px(2.3 * s), bold=True), center=center)
    line(_visual(labels.split_allowed if batch.split_allowed else labels.one_time), small, center=center)

    if cut_lines:
        _cut_lines(d, W, H)
    return card


def _cut_lines(d: ImageDraw.ImageDraw, W: int, H: int) -> None:
    dash, step, col = _px(1.2), _px(2.4), (153, 153, 153)
    for x in range(0, W, step):
        d.line([(x, 0), (min(x + dash, W - 1), 0)], fill=col, width=2)
        d.line([(x, H - 1), (min(x + dash, W - 1), H - 1)], fill=col, width=2)
    for yy in range(0, H, step):
        d.line([(0, yy), (0, min(yy + dash, H - 1))], fill=col, width=2)
        d.line([(W - 1, yy), (W - 1, min(yy + dash, H - 1))], fill=col, width=2)


# ── A group's cover sheet ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class GroupInfo:
    group: int
    #: How many groups the batch has.
    groups: int
    #: The group's serials as issued.
    low: int
    high: int
    #: Vouchers in this file.
    count: int
    #: Vouchers the group was issued with (more than [count] when some are left out).
    issued: Optional[int] = None


def cover_lines(
    batch: PrepaidVoucherBatch,
    info: GroupInfo,
    opts: PrintOptions,
    labels: Labels = Labels(),
    made: Optional[str] = None,
) -> List[Tuple[str, str]]:
    """The cover sheet, top to bottom, as (style, text): style is title / big / line / small."""
    per = " + ".join(f"{int(i.quantity)}× {i.product_name}" for i in batch.items)
    total = ", ".join(f"{int(i.quantity) * info.count}× {i.product_name}" for i in batch.items)
    out: List[Tuple[str, str]] = [
        ("title", batch.event_name or batch.name),
        ("big", labels.cover_group.format(g=info.group, n=info.groups)),
        ("line", labels.cover_serials.format(lo=str(info.low).zfill(4), hi=str(info.high).zfill(4))),
        ("line", labels.cover_count.format(n=info.count) if not info.issued or info.issued == info.count
         else labels.cover_count_partial.format(n=info.count, issued=info.issued)),
    ]
    if getattr(batch, "customer_name", None):
        out.append(("line", labels.cover_customer.format(v=batch.customer_name)))
    if getattr(batch, "order_ref", None):
        out.append(("line", labels.cover_order.format(v=batch.order_ref)))
    out.append(("small", labels.cover_per_voucher.format(items=per)))
    out.append(("small", labels.cover_total.format(items=total)))
    if opts.validity:
        out.append(("small", opts.validity))
    if batch.event_name and batch.name and batch.name != batch.event_name:
        out.append(("small", batch.name))
    if made:
        out.append(("small", labels.cover_made.format(date=made)))
    out.append(("small", labels.cover_handover))
    return out


def _draw_cover(
    batch: PrepaidVoucherBatch,
    info: GroupInfo,
    g: Geometry,
    logo: Optional[Image.Image],
    labels: Labels,
    opts: PrintOptions,
    made: Optional[str],
) -> Image.Image:
    """A page of the layout's size that goes on top of the group (and on its envelope)."""
    W, H = _px(g.page_w), _px(g.page_h)
    page = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(page)
    s = min(g.page_w, g.page_h) / 50.0
    s = min(s, 2.4)  # an A4 cover reads well without poster-size letters
    pad = _px(3 * s)
    text_w = W - 2 * pad
    y = pad
    if logo is not None:
        lw, lh = logo.size
        scale = min(_px(10 * s) / lh, text_w / lw)
        lg = logo.resize((max(1, int(lw * scale)), max(1, int(lh * scale))), Image.LANCZOS)
        page.paste(lg, ((W - lg.width) // 2, y))
        y += lg.height + _px(1.2 * s)
    fonts = {
        "title": _font(_px(3.6 * s), bold=True),
        "big": _font(_px(5.2 * s), bold=True),
        "line": _font(_px(2.9 * s), bold=True),
        "small": _font(_px(2.3 * s)),
    }
    for style, text in cover_lines(batch, info, opts, labels, made):
        font = fonts[style]
        for t in _wrap(d, text, font, text_w, 3 if style == "small" else 2):
            if y + font.size > H - pad:
                break
            d.text((W // 2, y), t, font=font, fill="black", anchor="ma")
            y += int(font.size * 1.3)
    # A frame: the sheet is clearly not a voucher.
    d.rectangle([_px(1), _px(1), W - _px(1), H - _px(1)], outline=(0, 0, 0), width=max(2, _px(0.4)))
    return page


# ── Files ─────────────────────────────────────────────────────────────────────


def _pages(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    logo: Optional[Image.Image],
    labels: Labels,
    opts: PrintOptions,
) -> Iterable[Image.Image]:
    cut = g.per_page > 1
    for start in range(0, len(vouchers), g.per_page):
        page = Image.new("RGB", (_px(g.page_w), _px(g.page_h)), "white")
        for i, v in enumerate(vouchers[start:start + g.per_page]):
            row, col = divmod(i, g.cols)
            # RTL sheet: the first voucher top right.
            x = _px(g.page_w - (col + 1) * g.card_w)
            y = _px(row * g.card_h)
            page.paste(_draw_card(batch, v, g.card_w, g.card_h, logo, labels, cut, opts), (x, y))
        yield page


def render_pdf(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    *,
    logo: Optional[Image.Image] = None,
    labels: Labels = Labels(),
    opts: PrintOptions = PrintOptions(),
    cover: Optional[GroupInfo] = None,
    made: Optional[str] = None,
) -> bytes:
    pages = list(_pages(batch, vouchers, g, logo, labels, opts))
    if cover is not None:
        pages.insert(0, _draw_cover(batch, cover, g, logo, labels, opts, made))
    if not pages:
        pages = [Image.new("RGB", (_px(g.page_w), _px(g.page_h)), "white")]
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:], resolution=DPI)
    return out.getvalue()


def safe_name(name: str) -> str:
    cleaned = "".join("_" if c in '\\/:*?"<>|' else c for c in (name or "")).strip()
    return cleaned or "vouchers"


def render_zip(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    *,
    logo: Optional[Image.Image] = None,
    labels: Labels = Labels(),
    opts: PrintOptions = PrintOptions(),
) -> bytes:
    """One PDF per voucher, named by its serial, in a ZIP."""
    base = safe_name(batch.event_name or batch.name)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for v in vouchers:
            z.writestr(
                f"{base}-{str(v.serial).zfill(4)}.pdf",
                render_pdf(batch, [v], g, logo=logo, labels=labels, opts=opts),
            )
    return out.getvalue()


def split_by_group(vouchers: Sequence[PrepaidVoucher]) -> List[Tuple[Optional[int], List[PrepaidVoucher]]]:
    """[(group, its vouchers by serial)] in group order; vouchers without a group last, as one."""
    groups: Dict[Optional[int], List[PrepaidVoucher]] = {}
    for v in sorted(vouchers, key=lambda v: v.serial):
        groups.setdefault(getattr(v, "group_no", None), []).append(v)
    keys = sorted(k for k in groups if k is not None)
    if None in groups:
        keys.append(None)
    return [(k, groups[k]) for k in keys]


def group_file_name(base: str, group: Optional[int], groups: int, low: int, high: int) -> str:
    width = max(3, len(str(groups)))
    serials = f"שוברים-{str(low).zfill(4)}-{str(high).zfill(4)}"
    if group is None:
        return f"{base}_ללא-קבוצה_{serials}.pdf"
    return f"{base}_קבוצה-{str(group).zfill(width)}-מתוך-{str(groups).zfill(width)}_{serials}.pdf"


def render_groups_zip(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    *,
    groups_total: Optional[int] = None,
    group_ranges: Optional[Dict[int, Tuple[int, int, int]]] = None,
    logo: Optional[Image.Image] = None,
    labels: Labels = Labels(),
    opts: PrintOptions = PrintOptions(),
    covers: bool = True,
    made: Optional[str] = None,
    manifest: Optional[bytes] = None,
    render: Optional[Callable[..., bytes]] = None,
) -> Tuple[bytes, List[str]]:
    """
    A ZIP with one PDF per group — "1000 in groups of 10" is 100 files of 10 — each opening
    with its cover sheet when [covers], plus the run's CSV manifest when given. Returns the
    ZIP and the names of the files in it, in order.

    [group_ranges] {group: (lowest serial, highest serial, vouchers)} as issued, so a cover
    still says "שוברים 0021–0030" when one of them was cancelled and is not printed.
    """
    render = render or render_pdf
    base = safe_name(batch.event_name or batch.name)
    parts = split_by_group(vouchers)
    total = groups_total or max([k for k, _ in parts if k is not None] or [0])
    names: List[str] = []
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for group, rows in parts:
            low, high, issued = rows[0].serial, rows[-1].serial, len(rows)
            if group is not None and group_ranges and group in group_ranges:
                low, high, issued = group_ranges[group]
            info = GroupInfo(group=group or 0, groups=total, low=low, high=high, count=len(rows), issued=issued)
            name = group_file_name(base, group, total, low, high)
            z.writestr(
                name,
                render(
                    batch, rows, g, logo=logo, labels=labels, opts=opts,
                    cover=info if (covers and group is not None) else None, made=made,
                ),
            )
            names.append(name)
        if manifest is not None:
            name = f"{base}_רשימת-קודים.csv"
            z.writestr(name, manifest)
            names.append(name)
    return out.getvalue(), names


STATUS_HE = {"active": "פעיל", "partially_used": "מומש חלקית", "used": "מומש", "cancelled": "בוטל"}


def manifest_csv(batch: PrepaidVoucherBatch, vouchers: Sequence[PrepaidVoucher]) -> bytes:
    """
    The run's codes, one row per voucher: serial, group, the code (as stored and as
    printed), what the barcode carries, status and what is left. UTF-8 with a BOM, so
    Excel shows the Hebrew. It holds every code of the run: keep it like the vouchers.
    """
    names = {str(i.product_id): i.product_name for i in batch.items}
    order = [str(i.product_id) for i in batch.items]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(["מס׳ שובר", "קבוצה", "קוד", "קוד מודפס", "תוכן הברקוד", "סטטוס", "נותר", "לקוח", "הזמנה", "הערה"])
    for v in sorted(vouchers, key=lambda v: v.serial):
        rem = v.remaining or {}
        left = "; ".join(f"{int(rem.get(pid, 0))}× {names[pid]}" for pid in order)
        w.writerow([
            v.serial,
            v.group_no if getattr(v, "group_no", None) is not None else "",
            v.code,
            format_code(v.code),
            qr_payload(v.code),
            STATUS_HE.get(v.status, v.status),
            left,
            getattr(batch, "customer_name", None) or "",
            getattr(batch, "order_ref", None) or "",
            (getattr(v, "note", None) or "").replace("\n", " "),
        ])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def file_names(batch: PrepaidVoucherBatch) -> Tuple[str, str]:
    base = safe_name(batch.event_name or batch.name)
    return f"{base}.pdf", f"{base}.zip"
