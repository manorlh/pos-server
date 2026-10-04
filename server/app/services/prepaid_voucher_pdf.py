"""
Prepaid vouchers ("שוברי הפקה") as PDF files, drawn on the server.

The dashboard used to rasterise its HTML preview in the browser (html-to-image +
jsPDF). That came out blank whenever the browser could not draw the page into a
canvas — Safari / iPhone, or a logo served from another origin without CORS — so the
file is now drawn here, the same in every browser:

* each page is drawn with Pillow at 300 dpi — the QR by `segno`, Hebrew put into
  visual order by `python-bidi` (Pillow here has no libraqm, so it cannot do RTL
  itself; Hebrew needs no shaping, only ordering);
* the pages are saved as one PDF at their real size in mm.

Layouts match the dashboard's print presets (`voucher-print.tsx`): an 80×50 ticket, a
card either way round, an 80×120 ticket, A6, an A4 sheet of eight to cut, or custom.
Text is part of the image — fine for printing, not for copy-paste.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.services import local_media
from app.services.prepaid_vouchers import qr_payload

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


def _qr_image(payload: str, side_px: int) -> Image.Image:
    import segno

    qr = segno.make(payload, error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=10, border=2)
    buf.seek(0)
    img = Image.open(buf).convert("L")
    return img.resize((side_px, side_px), Image.NEAREST)


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


@dataclass(frozen=True)
class Labels:
    serial: str = "שובר מס׳ {n}"
    split_allowed: str = "ניתן לממש בחלקים"
    one_time: str = "מימוש חד-פעמי"


def _draw_card(
    batch: PrepaidVoucherBatch,
    voucher: PrepaidVoucher,
    w_mm: float,
    h_mm: float,
    logo: Optional[Image.Image],
    labels: Labels,
    cut_lines: bool,
) -> Image.Image:
    W, H = _px(w_mm), _px(h_mm)
    card = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(card)
    s = min(w_mm, h_mm) / 50.0  # 1 at a 50 mm short side
    pad = _px(2.6 * s)
    gap = _px(2 * s)
    landscape = w_mm >= h_mm * 1.15

    serial_text = labels.serial.format(n=str(voucher.serial).zfill(4))
    f_serial = _font(_px(2.4 * s), bold=True)

    # The QR block: the QR, then the serial under it.
    if landscape:
        qr_side = int(min(H - 2 * pad - _px(6 * s), W * 0.42))
    else:
        qr_side = int(min(W - 2 * pad, H * 0.38))
    qr = _qr_image(qr_payload(voucher.code), qr_side)
    # Only the serial under the QR: the code itself is never printed — the QR is redeemed
    # by camera, so a code to copy by hand would only be a way to copy the voucher.
    under_h = _px(3.2 * s)
    block_h = qr_side + under_h

    if landscape:
        # QR on the left, text on the right (RTL: the text column starts at the right edge).
        qx, qy = pad, max(pad, (H - block_h) // 2)
        text_left, text_right, text_top, text_bottom = pad + qr_side + gap, W - pad, pad, H - pad
    else:
        qx, qy = (W - qr_side) // 2, H - pad - block_h
        text_left, text_right, text_top, text_bottom = pad, W - pad, pad, qy - gap
    card.paste(qr, (qx, qy))
    cx = qx + qr_side // 2
    d.text((cx, qy + qr_side + _px(0.6 * s)), _visual(serial_text), font=f_serial, fill="black", anchor="mt")

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
    line(_visual(labels.split_allowed if batch.split_allowed else labels.one_time), small, center=center)

    if cut_lines:
        dash, step, col = _px(1.2), _px(2.4), (153, 153, 153)
        for x in range(0, W, step):
            d.line([(x, 0), (min(x + dash, W - 1), 0)], fill=col, width=2)
            d.line([(x, H - 1), (min(x + dash, W - 1), H - 1)], fill=col, width=2)
        for yy in range(0, H, step):
            d.line([(0, yy), (0, min(yy + dash, H - 1))], fill=col, width=2)
            d.line([(W - 1, yy), (W - 1, min(yy + dash, H - 1))], fill=col, width=2)
    return card


def _pages(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    logo: Optional[Image.Image],
    labels: Labels,
) -> Iterable[Image.Image]:
    cut = g.per_page > 1
    for start in range(0, len(vouchers), g.per_page):
        page = Image.new("RGB", (_px(g.page_w), _px(g.page_h)), "white")
        for i, v in enumerate(vouchers[start:start + g.per_page]):
            row, col = divmod(i, g.cols)
            # RTL sheet: the first voucher top right.
            x = _px(g.page_w - (col + 1) * g.card_w)
            y = _px(row * g.card_h)
            page.paste(_draw_card(batch, v, g.card_w, g.card_h, logo, labels, cut), (x, y))
        yield page


def render_pdf(
    batch: PrepaidVoucherBatch,
    vouchers: Sequence[PrepaidVoucher],
    g: Geometry,
    *,
    logo: Optional[Image.Image] = None,
    labels: Labels = Labels(),
) -> bytes:
    pages = list(_pages(batch, vouchers, g, logo, labels))
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
) -> bytes:
    """One PDF per voucher, named by its serial, in a ZIP."""
    base = safe_name(batch.event_name or batch.name)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for v in vouchers:
            z.writestr(f"{base}-{str(v.serial).zfill(4)}.pdf", render_pdf(batch, [v], g, logo=logo, labels=labels))
    return out.getvalue()


def file_names(batch: PrepaidVoucherBatch) -> Tuple[str, str]:
    base = safe_name(batch.event_name or batch.name)
    return f"{base}.pdf", f"{base}.zip"
