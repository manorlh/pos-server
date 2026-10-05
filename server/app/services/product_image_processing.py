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

Method = Literal["model", "flood"]


@dataclass(frozen=True)
class ProcessedImage:
    png: bytes
    width: int
    height: int
    method: Method


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


def process_product_image(data: bytes, *, max_side: Optional[int] = None) -> Optional[ProcessedImage]:
    """Cut the background out of an uploaded product image.

    Returns None when the image should be stored exactly as uploaded: it could not
    be decoded, it already is a cut-out, or neither the model nor the flood fill
    produced a believable result.
    """
    max_side = max_side or get_settings().product_image_max_side
    try:
        image = Image.open(io.BytesIO(data))
        image.seek(0)  # first frame of an animated GIF/WebP
        image = ImageOps.exif_transpose(image).convert("RGBA")
    except Exception as exc:
        logger.info("Product image not decodable, stored unchanged: %s", exc)
        return None

    if _has_transparent_edge(image):
        return None

    method: Method = "model"
    cut = _remove_with_model(image)
    if cut is None or _visible_share(cut) < MIN_FOREGROUND:
        method = "flood"
        cut = flood_fill_background(image)
    if cut is None or _visible_share(cut) < MIN_FOREGROUND:
        return None

    cut = trim_and_cap(cut, max_side)
    buf = io.BytesIO()
    cut.save(buf, format="PNG", optimize=True)
    return ProcessedImage(png=buf.getvalue(), width=cut.width, height=cut.height, method=method)
