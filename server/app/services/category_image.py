"""
A category's picture ("תמונת מחלקה", P:/specs/category-color-image.md §1, §4), uploaded from the
dashboard's category dialog through `POST /categories/{id}/image` (app/routers/categories.py).

It goes through the product pipeline (app/routers/images.py `store_upload`): the same type (415) and
5 MB (413) checks, the background cut out like a product's unless `keepBackground` (or
PRODUCT_IMAGE_BG_REMOVAL is off), the cut trimmed to its content, the upload kept beside it
(`<public_id>_orig`, the response's `originalUrl`) — and stored where the product pictures are:
Cloudinary when configured (`pos/<tenant>/categories/…`, `https://res.cloudinary.com/…`), else the
server's media store (`<PUBLIC_BASE_URL>/media/pos/<tenant>/categories/<hex>.<ext>`). Every upload
gets a new public id, so a new picture is always a new URL and a till may cache by URL forever.

`prepare` comes first: the picture turned upright (EXIF), its first frame (an animated GIF), and
shrunk to the product pictures' cap (`PRODUCT_IMAGE_MAX_SIDE`, 1024 px) — the till keeps every
category's picture on its disk, and a 12 MP phone photo is not what a category button needs. A
picture already within the cap is passed on byte for byte. Bytes that do not open as a picture are
refused (400) rather than stored.

The dashboard crops before it uploads (lib/categoryLook.ts `cropSquare`); the server keeps whatever
shape arrives — the till covers its box with it.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings

#: JPEG quality of a shrunk photograph (one with no transparency).
JPEG_QUALITY = 85
#: A picture of more pixels than this is refused before it is decoded: 5 MB of PNG can unpack into
#: gigabytes of memory, and no camera a shop uses takes more than this.
MAX_PIXELS = 50_000_000


class CategoryImageInvalid(ValueError):
    """The bytes are not a picture Pillow can open."""


class CategoryImageTooLarge(CategoryImageInvalid):
    """More pixels than `MAX_PIXELS`."""


@dataclass(frozen=True)
class PreparedImage:
    data: bytes
    width: int
    height: int
    #: Re-encoded (turned, a GIF's first frame, or shrunk); False — the upload as it came.
    changed: bool


def max_side() -> int:
    return int(getattr(get_settings(), "product_image_max_side", 1024) or 1024)


def _has_alpha(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA"):
        return image.getchannel("A").getextrema()[0] < 255
    return image.mode == "P" and "transparency" in image.info


def prepare(contents: bytes, *, limit: Optional[int] = None) -> PreparedImage:
    """The picture to store: upright, one frame, at most `limit` (the product cap) on its longer side."""
    limit = limit or max_side()
    try:
        image = Image.open(io.BytesIO(contents))
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise CategoryImageInvalid("not a readable image") from exc
    # The header's size, before a single pixel is decoded.
    if image.width * image.height > MAX_PIXELS:
        raise CategoryImageTooLarge(f"more than {MAX_PIXELS} pixels")
    try:
        fmt = (image.format or "").upper()
        frames = getattr(image, "n_frames", 1) or 1
        image.seek(0)
        image.load()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError) as exc:
        raise CategoryImageInvalid("not a readable image") from exc

    exif_rotated = False
    try:
        orientation = image.getexif().get(0x0112, 1)
        exif_rotated = orientation not in (None, 1)
    except Exception:  # pragma: no cover - a broken EXIF block is just no rotation
        exif_rotated = False
    too_big = max(image.size) > limit
    if not (exif_rotated or too_big or frames > 1):
        return PreparedImage(contents, image.width, image.height, changed=False)

    if exif_rotated:
        image = ImageOps.exif_transpose(image)
    alpha = _has_alpha(image)
    image = image.convert("RGBA" if alpha else "RGB")
    if too_big:
        image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    if alpha or fmt == "PNG":
        image.save(out, format="PNG", optimize=True)
    else:
        image.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return PreparedImage(out.getvalue(), image.width, image.height, changed=True)
