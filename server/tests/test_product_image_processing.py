"""Product image background removal: the flood-fill fallback, the model path, and
which uploads go through it at all (products yes, keepBackground / branding no)."""
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

_REAL_GET_SESSION = P._get_session


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _outlined_product() -> Image.Image:
    """White background, a black ring, white inside the ring, a red dot outside it."""
    image = Image.new("RGB", (200, 160), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((50, 30, 150, 130), outline=(0, 0, 0), width=6)
    draw.rectangle((160, 70, 170, 80), fill=(200, 20, 20))
    return image


@pytest.fixture(autouse=True)
def _no_model():
    """Unless a test says otherwise, behave as if rembg cannot run here."""
    with patch.object(P, "_get_session", return_value=None):
        yield


# ── Flood fill ────────────────────────────────────────────────────────────────


def test_flood_fill_clears_a_uniform_background_and_keeps_enclosed_white() -> None:
    out = P.flood_fill_background(_outlined_product())
    assert out is not None and out.mode == "RGBA"
    alpha = np.asarray(out.getchannel("A"))
    assert alpha[0, 0] == 0 and alpha[150, 10] == 0  # background
    assert alpha[80, 100] == 255  # white enclosed by the outline stays
    assert alpha[80, 53] == 255  # the outline itself
    assert alpha[75, 165] == 255  # an object outside the outline


def test_flood_fill_tolerates_jpeg_like_noise_and_ramps_soft_edges() -> None:
    rng = np.random.default_rng(0)
    arr = np.full((100, 100, 3), 240, dtype=np.int16) + rng.integers(-5, 6, (100, 100, 3))
    arr[40:60, 40:60] = (30, 30, 30)
    arr[40:60, 39] = (240 - 20, 240 - 20, 240 - 20)  # a smeared edge pixel column
    out = P.flood_fill_background(Image.fromarray(arr.clip(0, 255).astype("uint8")))
    alpha = np.asarray(out.getchannel("A"))
    assert (alpha[:30, :] == 0).all()
    assert (alpha[40:60, 40:60] == 255).all()
    assert 0 < alpha[50, 39] < 255


def test_flood_fill_leaves_a_busy_background_alone() -> None:
    rng = np.random.default_rng(1)
    noisy = Image.fromarray(rng.integers(0, 256, (120, 120, 3), dtype=np.uint8))
    assert P.flood_fill_background(noisy) is None
    assert P.process_product_image(_png(noisy)) is None


def test_flood_fill_without_scipy_matches(monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def no_scipy(name, *args, **kwargs):
        if name.startswith("scipy"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    with_scipy = np.asarray(P.flood_fill_background(_outlined_product()))
    monkeypatch.setattr(builtins, "__import__", no_scipy)
    without = np.asarray(P.flood_fill_background(_outlined_product()))
    assert np.array_equal(with_scipy, without)


# ── Pipeline ──────────────────────────────────────────────────────────────────


def test_pipeline_trims_to_content_caps_size_and_returns_png() -> None:
    big = _outlined_product().resize((2000, 1600), Image.Resampling.NEAREST)
    result = P.process_product_image(_png(big), max_side=500)
    assert result is not None and result.method == "flood"
    out = Image.open(io.BytesIO(result.png))
    assert out.format == "PNG" and out.mode == "RGBA"
    assert max(out.size) == 500
    # Content is 1200x1000 of the 2000x1600 canvas (ring + dot); trimmed with 2%
    # padding that is 1248x1048, then capped to 500 on the long side.
    assert out.width == 500 and abs(out.height - 420) <= 1
    assert np.asarray(out.getchannel("A"))[0, 0] == 0


def test_pipeline_uses_the_model_when_available() -> None:
    def fake_remove(image):
        cut = image.convert("RGBA")
        alpha = Image.new("L", cut.size, 0)
        ImageDraw.Draw(alpha).rectangle((20, 20, 60, 60), fill=255)
        cut.putalpha(alpha)
        return cut

    with patch.object(P, "_remove_with_model", side_effect=fake_remove) as model:
        result = P.process_product_image(_png(Image.new("RGB", (100, 100), (10, 200, 30))))
    model.assert_called_once()
    assert result is not None and result.method == "model"
    # 41 px of content + 2 px padding each side.
    assert (result.width, result.height) == (45, 45)


def test_pipeline_falls_back_when_the_model_removes_everything() -> None:
    empty = lambda image: Image.new("RGBA", image.size, (0, 0, 0, 0))  # noqa: E731
    with patch.object(P, "_remove_with_model", side_effect=empty):
        result = P.process_product_image(_png(_outlined_product()))
    assert result is not None and result.method == "flood"


def test_model_failure_is_remembered_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(P, "_session", None)
    monkeypatch.setattr(P, "_session_failed", False)
    settings = MagicMock(product_image_bg_model_dir=str(tmp_path), product_image_bg_model="u2netp")
    monkeypatch.setattr(P, "get_settings", lambda: settings)
    monkeypatch.setenv("REMBG_HOME", str(tmp_path))  # restored after the test
    with patch("rembg.new_session", side_effect=RuntimeError("no network")) as new_session:
        assert _REAL_GET_SESSION() is None
        assert _REAL_GET_SESSION() is None
    assert new_session.call_count == 1

    with patch.object(P, "_get_session", _REAL_GET_SESSION):
        result = P.process_product_image(_png(_outlined_product()), max_side=1024)
    assert result is not None and result.method == "flood"


def test_an_existing_cut_out_is_stored_unchanged() -> None:
    cut = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    ImageDraw.Draw(cut).ellipse((10, 10, 70, 70), fill=(200, 0, 0, 255))
    assert P.process_product_image(_png(cut)) is None


def test_garbage_bytes_are_stored_unchanged() -> None:
    assert P.process_product_image(b"not an image") is None


# ── Router ────────────────────────────────────────────────────────────────────


def _user() -> User:
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)


def _file(data: bytes, content_type: str = "image/png") -> UploadFile:
    return UploadFile(
        file=io.BytesIO(data), filename="p.png", headers=Headers({"content-type": content_type})
    )


def _fake_upload(contents, **kwargs):
    public_id = kwargs.get("public_id") or f"{kwargs['folder']}/abc"
    return {"secure_url": f"https://res.cloudinary.com/demo/{public_id}.png", "public_id": public_id, "bytes": len(contents)}


@pytest.fixture()
def cloud():
    with patch.object(R, "configure_cloudinary"), patch.object(R, "cloudinary_configured", return_value=True), patch.object(
        R.cloudinary.uploader, "upload", side_effect=_fake_upload
    ) as upload:
        yield upload


def _upload(**kwargs):
    kwargs.setdefault("resource", "products")
    kwargs.setdefault("keep_background", False)
    return asyncio.run(
        R.upload_image(current_user=_user(), active_tenant_id=uuid.uuid4(), **kwargs)
    )


def test_product_upload_stores_the_cut_out_and_keeps_the_original(cloud) -> None:
    data = _png(_outlined_product())
    out = _upload(file=_file(data))
    assert out.background_removed is True
    assert out.original_url and out.original_url.endswith("abc_orig.png")
    assert cloud.call_count == 2
    stored, kwargs = cloud.call_args_list[0].args[0], cloud.call_args_list[0].kwargs
    assert kwargs["format"] == "png"
    assert Image.open(io.BytesIO(stored)).mode == "RGBA"
    orig, orig_kwargs = cloud.call_args_list[1].args[0], cloud.call_args_list[1].kwargs
    assert orig == data and orig_kwargs["public_id"] == f"{out.public_id}_orig"


def test_keep_background_skips_processing(cloud) -> None:
    data = _png(_outlined_product())
    with patch.object(R, "process_product_image") as process:
        out = _upload(file=_file(data), keep_background=True)
    process.assert_not_called()
    assert out.background_removed is False and out.original_url is None
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data


def test_server_wide_switch_skips_processing(cloud) -> None:
    settings = MagicMock(product_image_bg_removal=False)
    with patch.object(R, "get_settings", return_value=settings), patch.object(
        R, "process_product_image"
    ) as process:
        _upload(file=_file(_png(_outlined_product())))
    process.assert_not_called()


def test_category_uploads_are_not_processed(cloud) -> None:
    with patch.object(R, "process_product_image") as process:
        _upload(file=_file(_png(_outlined_product())), resource="categories")
    process.assert_not_called()


def test_unprocessable_product_image_is_stored_as_uploaded(cloud) -> None:
    rng = np.random.default_rng(2)
    data = _png(Image.fromarray(rng.integers(0, 256, (64, 64, 3), dtype=np.uint8)))
    out = _upload(file=_file(data))
    assert out.background_removed is False
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data


def test_branding_uploads_are_untouched(cloud) -> None:
    data = _png(_outlined_product().resize((256, 256)))
    with patch.object(R, "process_product_image") as process:
        asyncio.run(
            R.upload_branding_image(
                kind="logo", file=_file(data), current_user=_user(), active_tenant_id=uuid.uuid4()
            )
        )
    process.assert_not_called()
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data


def test_model_output_bytes_or_image_both_become_rgba() -> None:
    cut = Image.new("RGBA", (10, 10), (1, 2, 3, 255))
    with patch.object(P, "_get_session", return_value=object()), patch(
        "rembg.remove", side_effect=[cut, _png(cut)]
    ):
        image = Image.new("RGB", (10, 10))
        assert P._remove_with_model(image).mode == "RGBA"
        assert P._remove_with_model(image).mode == "RGBA"
    with patch.object(P, "_get_session", return_value=object()), patch(
        "rembg.remove", side_effect=RuntimeError("onnx")
    ):
        assert P._remove_with_model(image) is None


def test_without_cloudinary_the_image_is_stored_on_the_server(tmp_path, monkeypatch):
    """No Cloudinary keys: the bytes land in the local media store and come back as a /media URL."""
    import io as _io

    from PIL import Image as _Image

    from app.services import local_media

    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    buf = _io.BytesIO()
    _Image.new("RGB", (40, 20), (200, 30, 30)).save(buf, "PNG")
    result = local_media.store(buf.getvalue(), "pos/t/products")
    assert result["secure_url"].startswith("http://localhost:8001/media/pos/t/products/")
    assert (tmp_path / f"{result['public_id']}.png").exists()
    assert (result["width"], result["height"]) == (40, 20)
