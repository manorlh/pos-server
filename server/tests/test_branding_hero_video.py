"""
The branding hero ("תמונת פתיחה") may be a short video.

The dashboard uploads a video through `POST /images/media` and saves the URL it returns
into `brandHeroUrl`, exactly as it saves an image's. These pin that such a URL passes the
POS settings validation on both storage paths — Cloudinary (https) and a development
server's own media store (plain http, under its own /media/) — and reaches the till as is.
The till decides by the URL (.mp4 / .webm, or Cloudinary's /video/upload/) that it is a
video, and plays it instead of decoding it.
"""
from __future__ import annotations

import asyncio
import io
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import UploadFile
from pydantic import ValidationError
from starlette.datastructures import Headers

from app.models.user import User, UserRole
from app.routers import images as images_router
from app.routers.settings import _build_patch
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import local_media
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers

CLOUDINARY_VIDEO = "https://res.cloudinary.com/demo/video/upload/v1/pos/t/branding/screensaver/c.mp4"

#: The head of an MP4 (its "ftyp" box). The media upload stores a video as uploaded and
#: never decodes it, so this is all it needs.
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64


def _distributor() -> User:
    user = MagicMock(spec=User)
    user.role = UserRole.DISTRIBUTOR
    return user


def _upload_media(contents: bytes, content_type: str, filename: str):
    file = UploadFile(
        file=io.BytesIO(contents), filename=filename, headers=Headers({"content-type": content_type})
    )
    return asyncio.run(
        images_router.upload_media(file=file, current_user=_distributor(), active_tenant_id=uuid.uuid4())
    )


@pytest.mark.parametrize("url", [CLOUDINARY_VIDEO, "https://cdn.example.com/brand/hero.webm"])
def test_a_video_url_is_saved_into_the_hero_like_an_image(url: str) -> None:
    data = PosSettingsV1Patch.model_validate({"brandHeroUrl": url})
    assert data.brand_hero_url == url
    assert _build_patch(data, _distributor()) == {"brandHeroUrl": url}


def test_a_video_uploaded_without_cloudinary_is_a_hero_the_settings_accept(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    with patch.object(images_router, "cloudinary_configured", return_value=False):
        out = _upload_media(MP4, "video/mp4", "hero.mp4")

    assert out.kind == "video"
    assert out.url.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/")
    assert out.url.endswith(".mp4")
    # Stored byte for byte: the till plays exactly what was uploaded.
    stored = list(tmp_path.rglob("*.mp4"))
    assert len(stored) == 1
    assert stored[0].read_bytes() == MP4
    # …and what it returns is a value `brandHeroUrl` takes.
    assert PosSettingsV1Patch.model_validate({"brandHeroUrl": out.url}).brand_hero_url == out.url


def test_the_hero_video_reaches_the_till_unchanged() -> None:
    assert "brandHeroUrl" in MANAGED_SETTING_KEYS
    tenant = MagicMock()
    tenant.settings = {"brandHeroUrl": CLOUDINARY_VIDEO}
    company = MagicMock()
    company.settings = {}
    assert merge_all_settings_layers(company, tenant=tenant)["brandHeroUrl"] == CLOUDINARY_VIDEO


@pytest.mark.parametrize("bad", ["http://cdn.example.com/hero.mp4", "http://evil.example/media/x.mp4"])
def test_plain_http_from_anywhere_else_is_still_refused(bad: str) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"brandHeroUrl": bad})


def test_the_http_exception_is_this_servers_media_store_and_nothing_beside_it() -> None:
    base = local_media._base_url()
    if base.startswith("https://"):
        pytest.skip("the media store is served over https here: no exception to test")
    for bad in (f"{base}/elsewhere/x.mp4", f"{base}.evil.example{local_media.MEDIA_PREFIX}/x.mp4"):
        with pytest.raises(ValidationError):
            PosSettingsV1Patch.model_validate({"brandHeroUrl": bad})
    own = f"{base}{local_media.MEDIA_PREFIX}/pos/t/branding/screensaver/a.mp4"
    assert PosSettingsV1Patch.model_validate({"brandHeroUrl": own}).brand_hero_url == own
