"""
Image storage on the server's own disk — the fallback when Cloudinary is not configured.

A development box (or an on-premise install) has no Cloudinary account, and every image
upload used to fail with "Cloudinary is not configured". Here the bytes are written under
`MEDIA_DIR` and served by the API itself at `/media/...` (mounted in app/main.py). The
answer has the same keys a Cloudinary upload returns (`secure_url`, `public_id`, `width`,
`height`, `bytes`), so the routers do not care which one stored the image.

The URL is built from `PUBLIC_BASE_URL` (default http://localhost:8001): the dashboard
and a till on the USB link (adb reverse) both reach the API there.
"""
from __future__ import annotations

import io
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from app.config import get_settings

#: Where uploads land: server/var/media (server/var is gitignored).
MEDIA_DIR = Path(os.getenv("MEDIA_DIR") or (Path(__file__).parents[2] / "var" / "media"))
#: The URL prefix the API serves MEDIA_DIR under.
MEDIA_PREFIX = "/media"


def _base_url() -> str:
    return (getattr(get_settings(), "public_base_url", None) or os.getenv("PUBLIC_BASE_URL") or "http://localhost:8001").rstrip("/")


def store(
    contents: bytes,
    folder: str,
    *,
    limit: Optional[tuple[int, int]] = None,
) -> Dict[str, Any]:
    """Write [contents] under `folder` and return a Cloudinary-shaped result.

    [limit] (width, height) scales the image down to fit, as Cloudinary's "limit" crop
    does for branding.
    """
    from PIL import Image

    image = Image.open(io.BytesIO(contents))
    image.load()
    if limit and (image.width > limit[0] or image.height > limit[1]):
        image.thumbnail(limit, Image.LANCZOS)
    ext = (image.format or "png").lower()
    if ext == "jpeg":
        ext = "jpg"
    pid = f"{folder}/{uuid.uuid4().hex}"
    path = MEDIA_DIR / f"{pid}.{ext}"
    path.parent.mkdir(parents=True, exist_ok=True)
    out = io.BytesIO()
    save_format = "JPEG" if ext == "jpg" else ext.upper()
    if save_format == "JPEG" and image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.save(out, format=save_format, optimize=True)
    data = out.getvalue()
    path.write_bytes(data)
    return {
        "secure_url": f"{_base_url()}{MEDIA_PREFIX}/{pid}.{ext}",
        "public_id": pid,
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
    }


def store_raw(contents: bytes, folder: str, ext: str) -> str:
    """Write [contents] (a video) as is under `folder`; its public URL."""
    pid = f"{folder}/{uuid.uuid4().hex}"
    path = MEDIA_DIR / f"{pid}.{ext}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return f"{_base_url()}{MEDIA_PREFIX}/{pid}.{ext}"


def media_file_response(path: str):
    """GET /media/{path}: one stored file, never anything outside MEDIA_DIR."""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if not parts or any(p in (".", "..") or ":" in p for p in parts):
        raise HTTPException(status_code=404, detail="Not found")
    target = MEDIA_DIR.joinpath(*parts)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    # Immutable: a new upload always gets a new name.
    return FileResponse(str(target), headers={"Cache-Control": "public, max-age=31536000, immutable"})
