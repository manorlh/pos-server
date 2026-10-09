"""Background removal for product images, so a till tile shows the product, not the photo.

A product photo is usually a phone shot on a counter or a supplier image on white.
On a till tile either one reads as a box around the product; a cut-out on
transparency reads as the product. Every product upload therefore goes through
`process_product_image`:

1. The rembg model (`isnet-general-use` by default — U^2-Net family, onnxruntime
   on CPU). One session per process, created lazily on the first upload; the model
   file is downloaded on that first use into `product_image_bg_model_dir`.
2. If the model is unavailable or fails, a flood fill from the image edge for the
   common "product on a plain background" case. It only acts when the border is
   clearly one colour; anything else is left exactly as uploaded, because a bad
   cut on a till tile is worse than a background.
3. The cut-out is trimmed to its content (plus a little padding), capped in size
   and saved as an optimized PNG.
4. "שפר תמונה" (`enhance`, the till's uploads by default — the owner, 09.10.2026: "גם וגם"):
   gray-world white balance, auto-levels on the luma's 1st–99th percentiles, contrast and
   saturation +10%, a light unsharp mask — `enhance_image`, step for step and number for number
   the till's own (pos-android domain/ProductPhotoProcessing.kt `PhotoProcessing.enhance`), so the
   cloud's refined picture looks like the one the till showed first. With the background kept it
   applies to the whole picture.

Everything here is CPU-bound and synchronous; callers run it off the event loop.
Branding images (logo, hero, receipt) never come through here.
"""
from __future__ import annotations

import io
import logging
import os
import threading
from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np
from PIL import Image, ImageOps

from app.config import get_settings

logger = logging.getLogger(__name__)

#: Colour distance (max over R, G, B) at or under which a pixel *is* background.
HARD_TOLERANCE = 12
#: Up to this distance a background-connected pixel fades out rather than vanishing,
#: which keeps anti-aliased and JPEG-smeared edges from looking cut with scissors.
SOFT_TOLERANCE = 30
#: Share of border pixels that must match the border colour before the flood fill
#: trusts that the background is one plain colour.
MIN_UNIFORM_BORDER = 0.60
#: A "cut-out" with less than this share of visible pixels removed the product too.
MIN_FOREGROUND = 0.01
#: Alpha above which a pixel counts as content when trimming the margins.
TRIM_ALPHA = 8
#: Padding kept around the content after trimming, as a share of its longest side.
PADDING_RATIO = 0.02

#: "none": the background kept (only enhanced).
Method = Literal["model", "flood", "none"]


#: "שפר תמונה" — the till's numbers (domain/ProductPhotoProcessing.kt), kept identical.
WB_MIN_GAIN = 0.85
WB_MAX_GAIN = 1.15
LEVELS_LOW_PERCENTILE = 0.01
LEVELS_HIGH_PERCENTILE = 0.99
LEVELS_MAX_GAIN = 1.6
CONTRAST = 1.10
SATURATION = 1.10
SHARPEN_AMOUNT = 0.4
#: Pixels the statistics read: the subject's, not a cut-out's empty canvas.
STATS_ALPHA = 16


@dataclass(frozen=True)
class ProcessedImage:
    png: bytes
    width: int
    height: int
    method: Method
    #: The background was cut out (False: only enhanced, its background kept).
    background_removed: bool = True
    enhanced: bool = False


# ── Model session (one per process) ───────────────────────────────────────────

_session = None
_session_failed = False
_session_lock = threading.Lock()


def _get_session():
    """The rembg session, created on first use; None when rembg cannot run here.

    A failure is remembered so every later upload goes straight to the fallback
    instead of retrying a 170 MB download or a broken onnxruntime import each time.
    """
    global _session, _session_failed
    if _session is not None or _session_failed:
        return _session
    with _session_lock:
        if _session is not None or _session_failed:
            return _session
        settings = get_settings()
        try:
            model_dir = settings.product_image_bg_model_dir
            os.makedirs(model_dir, exist_ok=True)
            # rembg reads its model directory from the environment at download time.
            # An explicit U2NET_HOME (an operator's pre-seeded directory) still wins.
            os.environ.setdefault("REMBG_HOME", model_dir)
            from rembg import new_session

            _session = new_session(settings.product_image_bg_model)
            logger.info("Product background removal model %s loaded", settings.product_image_bg_model)
        except Exception as exc:  # ImportError, download failure, onnxruntime error…
            _session_failed = True
            logger.warning("Background removal model unavailable, using flood fill only: %s", exc)
        return _session


def _remove_with_model(image: Image.Image) -> Optional[Image.Image]:
    session = _get_session()
    if session is None:
        return None
    try:
        from rembg import remove

        out = remove(image, session=session)
    except Exception as exc:
        logger.warning("Background removal model failed on an upload: %s", exc)
        return None
    if not isinstance(out, Image.Image):
        out = Image.open(io.BytesIO(out))
    return out.convert("RGBA")


# ── Fallback: flood fill from the edge ────────────────────────────────────────


def _border(arr: np.ndarray) -> np.ndarray:
    return np.concatenate([arr[0, :], arr[-1, :], arr[1:-1, 0], arr[1:-1, -1]])


def _edge_connected(mask: np.ndarray) -> np.ndarray:
    """Pixels of `mask` 4-connected to the image edge through `mask` itself."""
    try:
        from scipy import ndimage

        labels, _ = ndimage.label(mask)
        edge_labels = np.unique(_border(labels))
        edge_labels = edge_labels[edge_labels != 0]
        return np.isin(labels, edge_labels)
    except ImportError:
        pass
    reached = np.zeros_like(mask)
    reached[0, :], reached[-1, :] = mask[0, :], mask[-1, :]
    reached[:, 0], reached[:, -1] = mask[:, 0], mask[:, -1]
    while True:
        grown = reached.copy()
        grown[1:, :] |= reached[:-1, :]
        grown[:-1, :] |= reached[1:, :]
        grown[:, 1:] |= reached[:, :-1]
        grown[:, :-1] |= reached[:, 1:]
        grown &= mask
        if np.array_equal(grown, reached):
            return reached
        reached = grown


def flood_fill_background(image: Image.Image) -> Optional[Image.Image]:
    """Make an edge-connected near-uniform background transparent.

    Returns None — leave the image alone — unless at least `MIN_UNIFORM_BORDER`
    of the border is within `HARD_TOLERANCE` of the median border colour. Areas
    the background cannot reach (white inside an outlined product) are kept.
    """
    rgba = np.asarray(image.convert("RGBA"))
    rgb = rgba[..., :3].astype(np.int16)
    if rgb.shape[0] < 3 or rgb.shape[1] < 3:
        return None

    border = _border(rgb)
    bg_colour = np.median(border, axis=0)
    border_dist = np.abs(border - bg_colour).max(axis=1)
    if (border_dist <= HARD_TOLERANCE).mean() < MIN_UNIFORM_BORDER:
        return None

    dist = np.abs(rgb - bg_colour).max(axis=2)
    background = _edge_connected(dist <= SOFT_TOLERANCE)

    ramp = (dist - HARD_TOLERANCE) * 255.0 / (SOFT_TOLERANCE - HARD_TOLERANCE)
    alpha = np.where(background, np.clip(ramp, 0, 255), 255.0)
    alpha = np.minimum(alpha, rgba[..., 3]).astype(np.uint8)

    out = rgba.copy()
    out[..., 3] = alpha
    return Image.fromarray(out, "RGBA")


# ── Pipeline ──────────────────────────────────────────────────────────────────


def _has_transparent_edge(image: Image.Image) -> bool:
    """An upload that is already a cut-out (transparent border) needs no removal."""
    if "A" not in image.getbands():
        return False
    alpha = np.asarray(image.getchannel("A"))
    return bool((_border(alpha) < 255 - HARD_TOLERANCE).mean() >= MIN_UNIFORM_BORDER)


def _visible_share(image: Image.Image) -> float:
    return float((np.asarray(image.getchannel("A")) > TRIM_ALPHA).mean())


def trim_and_cap(image: Image.Image, max_side: int) -> Image.Image:
    """Crop to the visible content plus a small padding, then cap the longest side."""
    alpha = image.getchannel("A").point(lambda a: 255 if a > TRIM_ALPHA else 0)
    bbox = alpha.getbbox()
    if bbox:
        left, top, right, bottom = bbox
        pad = max(2, round(max(right - left, bottom - top) * PADDING_RATIO))
        image = image.crop(
            (
                max(0, left - pad),
                max(0, top - pad),
                min(image.width, right + pad),
                min(image.height, bottom + pad),
            )
        )
    if max(image.size) > max_side:
        image = image.copy()
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return image


def _round(values: np.ndarray) -> np.ndarray:
    """Half up, as the till's `roundToInt` (Math.round) does — not numpy's half to even."""
    return np.floor(values + 0.5)


def _wb_gain(gray: float, channel_mean: float) -> float:
    return 1.0 if channel_mean < 1.0 else float(np.clip(gray / channel_mean, WB_MIN_GAIN, WB_MAX_GAIN))


def _luma(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    return 0.299 * r + 0.587 * g + 0.114 * b


def _levels(luma_counted: np.ndarray) -> "tuple[float, float]":
    """The luma's 1st and 99th percentiles: the first value at which the running count reaches each."""
    n = luma_counted.size
    hist = np.bincount(np.clip(_round(luma_counted), 0, 255).astype(np.int64), minlength=256)
    cum = np.cumsum(hist)
    lo = int(np.argmax(cum >= LEVELS_LOW_PERCENTILE * n))
    hi = int(np.argmax(cum >= LEVELS_HIGH_PERCENTILE * n))
    return float(lo), float(hi)


def _levels_map(lo: float, hi: float) -> "tuple[float, float]":
    """
    (gain, offset) of c' = (c - lo) * gain + offset: lo..hi onto 0..255 — or, with the gain
    capped, onto a band of its stretched width placed where lo..hi sat (the room left shared in
    proportion to the margins below and above), so a capped stretch never darkens or brightens
    the whole picture.
    """
    if hi <= lo:
        return 1.0, lo
    gain = min(LEVELS_MAX_GAIN, 255.0 / (hi - lo))
    room = 255.0 - (hi - lo) * gain
    margins = lo + (255.0 - hi)
    return gain, (room * lo / margins if margins > 0 else 0.0)


def _sharpen(rgb: np.ndarray, amount: float) -> np.ndarray:
    """c + amount * (c - box3x3(c)), the edges clamped; on uint8-valued floats."""
    h, w = rgb.shape[:2]
    padded = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode="edge")
    box = sum(padded[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) / 9.0
    return np.clip(_round(rgb + amount * (rgb - box)), 0, 255)


def enhance_image(image: Image.Image) -> Image.Image:
    """
    "שפר תמונה", as the till does it: gray-world white balance (gains clamped), auto-levels on
    the luma's 1st–99th percentiles (gain capped), contrast and saturation +10%, then a light
    unsharp mask. The statistics read the subject only (alpha over STATS_ALPHA); alpha is kept.
    """
    rgba = np.asarray(image.convert("RGBA")).astype(np.float64)
    alpha = rgba[..., 3]
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    counted = alpha > STATS_ALPHA
    n = int(counted.sum())
    if n == 0:
        return image.convert("RGBA")

    mr, mg, mb = float(r[counted].mean()), float(g[counted].mean()), float(b[counted].mean())
    gray = (mr + mg + mb) / 3.0
    r = np.clip(r * _wb_gain(gray, mr), 0, 255)
    g = np.clip(g * _wb_gain(gray, mg), 0, 255)
    b = np.clip(b * _wb_gain(gray, mb), 0, 255)

    lo, hi = _levels(_luma(r, g, b)[counted])
    gain, offset = _levels_map(lo, hi)
    r, g, b = (r - lo) * gain + offset, (g - lo) * gain + offset, (b - lo) * gain + offset
    r, g, b = (r - 128.0) * CONTRAST + 128.0, (g - 128.0) * CONTRAST + 128.0, (b - 128.0) * CONTRAST + 128.0
    y = _luma(r, g, b)
    r, g, b = y + (r - y) * SATURATION, y + (g - y) * SATURATION, y + (b - y) * SATURATION
    rgb = np.clip(_round(np.stack([r, g, b], axis=-1)), 0, 255)

    rgb = _sharpen(rgb, SHARPEN_AMOUNT)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _cap(image: Image.Image, max_side: int) -> Image.Image:
    if max(image.size) > max_side:
        image = image.copy()
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return image


def process_product_image(
    data: bytes, *, max_side: Optional[int] = None, remove_background: bool = True, enhance: bool = False,
) -> Optional[ProcessedImage]:
    """Cut the background out of an uploaded product image, and/or enhance it.

    Returns None when the image should be stored exactly as uploaded: it could not
    be decoded, or nothing was asked that changes it — the background is to stay (or it
    already is a cut-out, or neither the model nor the flood fill produced a believable
    result) and no enhancement was asked.
    """
    max_side = max_side or get_settings().product_image_max_side
    try:
        image = Image.open(io.BytesIO(data))
        image.seek(0)  # first frame of an animated GIF/WebP
        image = ImageOps.exif_transpose(image).convert("RGBA")
    except Exception as exc:
        logger.info("Product image not decodable, stored unchanged: %s", exc)
        return None

    cut = None
    method: Method = "none"
    if remove_background and not _has_transparent_edge(image):
        method = "model"
        cut = _remove_with_model(image)
        if cut is None or _visible_share(cut) < MIN_FOREGROUND:
            method = "flood"
            cut = flood_fill_background(image)
        if cut is None or _visible_share(cut) < MIN_FOREGROUND:
            cut, method = None, "none"

    if cut is None and not enhance:
        return None
    result = trim_and_cap(cut, max_side) if cut is not None else _cap(image, max_side)
    if enhance:
        result = enhance_image(result)
    buf = io.BytesIO()
    result.save(buf, format="PNG", optimize=True)
    return ProcessedImage(
        png=buf.getvalue(), width=result.width, height=result.height, method=method,
        background_removed=cut is not None, enhanced=enhance,
    )
