"""
"שפר תמונה" — the enhancement the till applies to the picture it shows at once and the cloud applies
to the picture it refines (the owner, 09.10.2026: "גם וגם"), and which uploads get it: the till's,
unless it says `enhance=false`; the dashboard's never.

`REFERENCE` is shared with the till's ProductPhotoProcessingTest (pos-android): the same 3 x 3
picture enhanced on both sides must agree (the till's float32 within one level).
"""
from __future__ import annotations

import asyncio
import io
import uuid
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi import UploadFile
from PIL import Image, ImageDraw
from starlette.datastructures import Headers

import app.services.product_image_processing as P
from app.models.user import User, UserRole
from app.routers import images as R

#: The shared vector: input RGB (alpha 255) → the enhanced RGBA.
REFERENCE_IN = [
    (200, 120, 80), (30, 60, 90), (250, 250, 250),
    (10, 10, 10), (128, 64, 32), (90, 200, 140),
    (60, 60, 200), (180, 180, 40), (120, 130, 125),
]
REFERENCE_OUT = [
    (255, 131, 79, 255), (0, 15, 89, 255), (255, 255, 255, 255),
    (0, 0, 0, 255), (136, 22, 0, 255), (47, 232, 163, 255),
    (30, 34, 255, 255), (222, 217, 0, 255), (111, 116, 153, 255),
]


def _rgba(pixels, w: int, h: int, alpha: int = 255) -> Image.Image:
    arr = np.array([[list(p) + [alpha] for p in pixels[y * w:(y + 1) * w]] for y in range(h)], dtype=np.uint8)
    return Image.fromarray(arr, "RGBA")


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _no_model():
    with patch.object(P, "_get_session", return_value=None):
        yield


# ── The enhancement itself ────────────────────────────────────────────────────


def test_the_shared_reference_vector() -> None:
    out = np.asarray(P.enhance_image(_rgba(REFERENCE_IN, 3, 3)))
    assert [tuple(int(v) for v in out[y, x]) for y in range(3) for x in range(3)] == REFERENCE_OUT


def test_the_parameters_are_the_tills() -> None:
    assert (P.WB_MIN_GAIN, P.WB_MAX_GAIN) == (0.85, 1.15)
    assert (P.LEVELS_LOW_PERCENTILE, P.LEVELS_HIGH_PERCENTILE, P.LEVELS_MAX_GAIN) == (0.01, 0.99, 1.6)
    assert (P.CONTRAST, P.SATURATION, P.SHARPEN_AMOUNT, P.STATS_ALPHA) == (1.10, 1.10, 0.4, 16)


def test_gray_world_takes_a_colour_cast_away_within_its_clamp() -> None:
    rng = np.random.default_rng(3)
    base = rng.integers(60, 180, (24, 24, 3)).astype(np.float64)
    cast = np.clip(base * np.array([0.9, 1.0, 1.12]), 0, 255).astype(np.uint8)
    image = Image.fromarray(np.dstack([cast, np.full((24, 24), 255, np.uint8)]), "RGBA")
    out = np.asarray(P.enhance_image(image)).astype(np.float64)
    before = cast.reshape(-1, 3).mean(axis=0)
    after = out[..., :3].reshape(-1, 3).mean(axis=0)
    assert np.ptp(after) < np.ptp(before)
    # A wild cast is only partly corrected: the gains stop at 0.85 / 1.15.
    assert P._wb_gain(100.0, 300.0) == 0.85 and P._wb_gain(100.0, 10.0) == 1.15 and P._wb_gain(100.0, 0.5) == 1.0


def test_auto_levels_stretch_a_flat_picture_but_no_more_than_the_cap() -> None:
    flat = np.tile(np.linspace(110, 150, 32), (32, 1))
    rgb = np.dstack([flat, flat, flat]).astype(np.uint8)
    image = Image.fromarray(np.dstack([rgb, np.full((32, 32), 255, np.uint8)]), "RGBA")
    out = np.asarray(P.enhance_image(image)).astype(np.float64)[..., 0]
    assert np.ptp(out) > np.ptp(flat) * 1.5
    assert np.ptp(out) < np.ptp(flat) * 1.6 * 1.10 + 12  # the levels' cap, the contrast and the sharpening
    lo, hi = P._levels(np.arange(100, dtype=np.float64))
    assert (lo, hi) == (0.0, 98.0)


def test_alpha_is_kept_and_the_empty_canvas_does_not_move_the_subject() -> None:
    subject = Image.new("RGBA", (20, 20), (150, 110, 90, 255))
    ImageDraw.Draw(subject).rectangle((5, 5, 14, 14), fill=(60, 140, 200, 255))
    canvas_a = Image.new("RGBA", (40, 40), (0, 255, 0, 0))
    canvas_b = Image.new("RGBA", (40, 40), (255, 0, 255, 0))
    canvas_a.paste(subject, (10, 10))
    canvas_b.paste(subject, (10, 10))
    out_a = np.asarray(P.enhance_image(canvas_a))
    out_b = np.asarray(P.enhance_image(canvas_b))
    assert np.array_equal(out_a[..., 3], np.asarray(canvas_a)[..., 3])
    # Inside the subject (away from the sharpening's reach into the canvas) the two agree.
    assert np.array_equal(out_a[12:28, 12:28], out_b[12:28, 12:28])


def test_a_picture_with_nothing_visible_is_left_alone() -> None:
    clear = Image.new("RGBA", (8, 8), (10, 20, 30, 0))
    assert np.array_equal(np.asarray(P.enhance_image(clear)), np.asarray(clear))


# ── The pipeline ──────────────────────────────────────────────────────────────


def test_enhance_with_the_background_kept_is_the_whole_picture_enhanced() -> None:
    photo = _rgba(REFERENCE_IN, 3, 3).convert("RGB").resize((90, 90), Image.Resampling.NEAREST)
    result = P.process_product_image(_png(photo), remove_background=False, enhance=True)
    assert result is not None
    assert (result.method, result.background_removed, result.enhanced) == ("none", False, True)
    out = Image.open(io.BytesIO(result.png))
    assert out.size == (90, 90) and np.asarray(out.getchannel("A")).min() == 255
    assert not np.array_equal(np.asarray(out.convert("RGB")), np.asarray(photo))


def test_nothing_asked_is_stored_as_uploaded() -> None:
    photo = Image.new("RGB", (40, 40), (120, 130, 140))
    assert P.process_product_image(_png(photo), remove_background=False, enhance=False) is None


def test_cut_out_and_enhanced() -> None:
    def fake_remove(image):
        cut = image.convert("RGBA")
        alpha = Image.new("L", cut.size, 0)
        ImageDraw.Draw(alpha).rectangle((20, 20, 60, 60), fill=255)
        cut.putalpha(alpha)
        return cut

    with patch.object(P, "_remove_with_model", side_effect=fake_remove):
        result = P.process_product_image(_png(Image.new("RGB", (100, 100), (10, 200, 30))), enhance=True)
    assert result is not None
    assert (result.method, result.background_removed, result.enhanced) == ("model", True, True)
    assert (result.width, result.height) == (45, 45)


def test_an_existing_cut_out_is_enhanced_but_not_cut_again() -> None:
    cut = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    ImageDraw.Draw(cut).ellipse((10, 10, 70, 70), fill=(200, 60, 40, 255))
    with patch.object(P, "_remove_with_model") as model:
        result = P.process_product_image(_png(cut), enhance=True)
    model.assert_not_called()
    assert result is not None and result.background_removed is False and result.enhanced is True
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(result.png)).getchannel("A")), np.asarray(cut.getchannel("A")))


# ── Which uploads ─────────────────────────────────────────────────────────────


def _fake_upload(contents, **kwargs):
    public_id = kwargs.get("public_id") or f"{kwargs['folder']}/abc"
    return {"secure_url": f"https://res.cloudinary.com/demo/{public_id}.png", "public_id": public_id}


@pytest.fixture()
def cloud():
    with patch.object(R, "configure_cloudinary"), patch.object(R, "cloudinary_configured", return_value=True), patch.object(
        R.cloudinary.uploader, "upload", side_effect=_fake_upload
    ) as upload:
        yield upload


def test_the_tills_upload_with_its_background_kept_is_enhanced_and_its_original_kept(cloud) -> None:
    data = _png(Image.new("RGB", (60, 60), (120, 100, 140)))
    out = asyncio.run(R.store_upload(data, uuid.uuid4(), "products", True, enhance=True))
    assert (out.processed, out.background_removed, out.enhanced) == (True, False, True)
    assert out.original_url and out.original_url.endswith("abc_orig.png")
    assert cloud.call_count == 2 and cloud.call_args_list[1].args[0] == data


def test_without_enhance_a_kept_background_is_the_upload_itself(cloud) -> None:
    data = _png(Image.new("RGB", (60, 60), (120, 100, 140)))
    with patch.object(R, "process_product_image") as process:
        out = asyncio.run(R.store_upload(data, uuid.uuid4(), "products", True))
    process.assert_not_called()
    assert (out.processed, out.background_removed, out.original_url) == (False, False, None)


def test_the_dashboards_upload_is_not_enhanced(cloud) -> None:
    user = MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)
    data = _png(Image.new("RGB", (60, 60), (120, 100, 140)))
    upload = UploadFile(file=io.BytesIO(data), filename="p.png", headers=Headers({"content-type": "image/png"}))
    with patch.object(R, "process_product_image") as process:
        asyncio.run(R.upload_image(file=upload, resource="products", keep_background=True, current_user=user,
                                   active_tenant_id=uuid.uuid4()))
    process.assert_not_called()


def test_categories_are_never_enhanced(cloud) -> None:
    data = _png(Image.new("RGB", (60, 60), (120, 100, 140)))
    with patch.object(R, "process_product_image") as process:
        out = asyncio.run(R.store_upload(data, uuid.uuid4(), "categories", True, enhance=True))
    process.assert_not_called()
    assert out.processed is False
