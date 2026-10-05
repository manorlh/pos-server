"""Product image uploads: stored as uploaded — in Cloudinary, or the server's own media
store when Cloudinary is not configured."""
from __future__ import annotations

import asyncio
import io
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import UploadFile
from PIL import Image
from starlette.datastructures import Headers

from app.models.user import User, UserRole
from app.routers import images as R


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _user() -> User:
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)


def _file(data: bytes, content_type: str = "image/png") -> UploadFile:
    return UploadFile(
        file=io.BytesIO(data), filename="p.png", headers=Headers({"content-type": content_type})
    )


def _fake_upload(contents, **kwargs):
    public_id = f"{kwargs['folder']}/abc"
    return {"secure_url": f"https://res.cloudinary.com/demo/{public_id}.png", "public_id": public_id, "bytes": len(contents)}


@pytest.fixture()
def cloud():
    with patch.object(R, "configure_cloudinary"), patch.object(R, "cloudinary_configured", return_value=True), patch.object(
        R.cloudinary.uploader, "upload", side_effect=_fake_upload
    ) as upload:
        yield upload


def _upload(**kwargs):
    kwargs.setdefault("resource", "products")
    return asyncio.run(
        R.upload_image(current_user=_user(), active_tenant_id=uuid.uuid4(), **kwargs)
    )


def test_product_upload_is_stored_as_uploaded(cloud) -> None:
    data = _png(Image.new("RGB", (200, 160), (255, 255, 255)))
    out = _upload(file=_file(data))
    assert out.url.endswith("abc.png")
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data
    assert "/products" in cloud.call_args.kwargs["folder"]


def test_category_upload_is_stored_as_uploaded(cloud) -> None:
    data = _png(Image.new("RGB", (40, 40), (10, 10, 10)))
    _upload(file=_file(data), resource="categories")
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data
    assert "/categories" in cloud.call_args.kwargs["folder"]


def test_branding_uploads_are_untouched(cloud) -> None:
    data = _png(Image.new("RGB", (256, 256), (255, 255, 255)))
    asyncio.run(
        R.upload_branding_image(
            kind="logo", file=_file(data), current_user=_user(), active_tenant_id=uuid.uuid4()
        )
    )
    assert cloud.call_count == 1 and cloud.call_args.args[0] == data


def test_without_cloudinary_the_image_is_stored_on_the_server(tmp_path, monkeypatch):
    """No Cloudinary keys: the bytes land in the local media store and come back as a /media URL."""
    from app.services import local_media

    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    result = local_media.store(_png(Image.new("RGB", (40, 20), (200, 30, 30))), "pos/t/products")
    assert result["secure_url"].startswith("http://localhost:8001/media/pos/t/products/")
    assert (tmp_path / f"{result['public_id']}.png").exists()
    assert (result["width"], result["height"]) == (40, 20)
