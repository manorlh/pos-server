"""
The demo company's stand-in pictures (P:/specs/demo-company.md: "לוגו זמני R2M Demo עד שהבעלים
מעלה לוגו") — drawn here, as PNG bytes, and uploaded through the dashboard's own upload routes, so
they reach the receipt, the kiosk and the customer display exactly as an uploaded picture does.

Latin text only: the server's fonts (Pillow's built-in) have no Hebrew. The Hebrew the screens show
(titles, the kiosk's texts) is the devices' own text, not a picture.
"""
from __future__ import annotations

import io
from typing import Tuple

#: The logo's colours: the R2M orange on a dark plate.
INK = (17, 24, 39)
ORANGE = (234, 88, 12)
WHITE = (255, 255, 255)

LOGO_TEXT = "R2M"
LOGO_SUBTEXT = "Demo"


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover - a Pillow without sized default fonts
        return ImageFont.load_default()


def _png(image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _hex(color: str) -> Tuple[int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def _centred(draw, box: Tuple[int, int, int, int], text: str, font, fill) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x0, y0, x1, y1 = box
    x = x0 + (x1 - x0 - (right - left)) / 2 - left
    y = y0 + (y1 - y0 - (bottom - top)) / 2 - top
    draw.text((x, y), text, font=font, fill=fill)


def logo_png(size: int = 512) -> bytes:
    """"R2M Demo" on a dark rounded plate with an orange bar — the screens' logo."""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 6, fill=INK)
    bar = size // 14
    draw.rounded_rectangle((size // 5, int(size * 0.66), size - size // 5, int(size * 0.66) + bar),
                           radius=bar // 2, fill=ORANGE)
    _centred(draw, (0, int(size * 0.12), size, int(size * 0.58)), LOGO_TEXT, _font(int(size * 0.34)), WHITE)
    _centred(draw, (0, int(size * 0.74), size, int(size * 0.94)), LOGO_SUBTEXT, _font(int(size * 0.13)), ORANGE)
    return _png(image)


def receipt_logo_png(width: int = 384, height: int = 160) -> bytes:
    """The printed one: black on white, as wide as a 58 mm head, short (paper on every sale)."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(image)
    _centred(draw, (0, 0, width, int(height * 0.72)), f"{LOGO_TEXT} {LOGO_SUBTEXT}", _font(int(height * 0.42)), (0, 0, 0))
    draw.rectangle((width // 4, int(height * 0.8), width - width // 4, int(height * 0.8) + 6), fill=(0, 0, 0))
    return _png(image)


def banner_png(title: str, subtitle: str, color: str, size: Tuple[int, int]) -> bytes:
    """A full-screen slide (the kiosk's attract screen, the customer display's ad): a colour fade and two lines."""
    from PIL import Image, ImageDraw

    width, height = size
    base = _hex(color)
    image = Image.new("RGB", size, base)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        k = y / max(1, height - 1)
        row = tuple(int(c * (1 - 0.55 * k) + INK[i] * 0.55 * k) for i, c in enumerate(base))
        draw.line((0, y, width, y), fill=row)
    short = min(width, height)
    plate = short // 3
    px0, py0 = (width - plate) // 2, int(height * 0.16)
    draw.rounded_rectangle((px0, py0, px0 + plate, py0 + plate), radius=plate // 6, fill=INK)
    _centred(draw, (px0, py0, px0 + plate, py0 + int(plate * 0.8)), LOGO_TEXT, _font(int(plate * 0.34)), WHITE)
    _centred(draw, (px0, py0 + int(plate * 0.62), px0 + plate, py0 + plate), LOGO_SUBTEXT, _font(int(plate * 0.13)), ORANGE)
    top = py0 + plate + short // 12
    _centred(draw, (0, top, width, top + short // 8), title, _font(short // 11), WHITE)
    _centred(draw, (0, top + short // 8, width, top + short // 8 + short // 12), subtitle, _font(short // 22), WHITE)
    return _png(image)


def tile_png(color: str, size: Tuple[int, int] = (800, 600)) -> bytes:
    """A category's stand-in picture: its colour, a soft light and the R2M mark in the corner."""
    from PIL import Image, ImageDraw

    width, height = size
    base = _hex(color)
    image = Image.new("RGB", size, base)
    draw = ImageDraw.Draw(image)
    for r in range(max(width, height), 0, -8):
        k = r / max(width, height)
        shade = tuple(min(255, int(c + (255 - c) * 0.35 * (1 - k))) for c in base)
        draw.ellipse((width * 0.3 - r / 2, height * 0.3 - r / 2, width * 0.3 + r / 2, height * 0.3 + r / 2), fill=shade)
    mark = height // 5
    draw.rounded_rectangle((width - mark - 24, height - mark - 24, width - 24, height - 24), radius=mark // 5, fill=INK)
    _centred(draw, (width - mark - 24, height - mark - 24, width - 24, height - 24), LOGO_TEXT, _font(mark // 3), WHITE)
    return _png(image)
