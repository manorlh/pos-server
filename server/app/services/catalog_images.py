"""
Pictures by address in the menu sheet ("קישור לתמונה", app/services/catalog_import.py): a
product's or category's image given as a link is downloaded at commit time and stored
exactly where the dashboard's own upload stores an image - Cloudinary when it is
configured, the server's media store otherwise (app/routers/images.py `store_upload`, the
"keep background" path: an import of a whole menu never spends seconds of CPU per picture
on cutting backgrounds; the product form can still do that per product).

Idempotent: every stored picture's public id carries a short hash of the address it came
from (`catimp-<hash>`), so importing the same file again sees that the product's picture
already came from this link and downloads nothing. A link to a picture already in our own
media store is set as it is.

Safe to point at the internet: http(s) only, the host must resolve to public addresses
(no loopback, private, link-local or reserved ranges - every redirect is checked again),
at most 5MB, a few seconds per picture, and the bytes must open as a JPG / PNG / WEBP /
GIF. A picture that fails is reported on its row and the rest of the import goes on.
"""
from __future__ import annotations

import hashlib
import io
import ipaddress
import logging
import re
import socket
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional
from urllib.parse import parse_qs, urlparse, urlunparse

from app.services import local_media

logger = logging.getLogger(__name__)

MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_SECONDS = 10.0
MAX_REDIRECTS = 3
#: Downloads in one import; the rest are reported and come with the next import of the
#: same file (the ones already stored are then "unchanged").
MAX_PER_IMPORT = 200
WORKERS = 6
MARKER = "catimp-"
FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}


class ImageError(Exception):
    """A picture that could not be taken; the message is the user's (Hebrew)."""


@dataclass(frozen=True)
class Job:
    #: "products" | "categories": the upload folder, as the dashboard's.
    resource: str
    source: str


@dataclass
class Outcome:
    url: Optional[str] = None
    error: Optional[str] = None


# ── Addresses ─────────────────────────────────────────────────────────────────


def source_key(source: str) -> str:
    return hashlib.sha256(source.strip().encode("utf-8")).hexdigest()[:24]


def marker_of(source: str) -> str:
    return f"{MARKER}{source_key(source)}"


def came_from(current_url: Optional[str], source: str) -> bool:
    """Was the stored picture `current_url` taken from the link `source`?"""
    return bool(current_url) and marker_of(source) in str(current_url)


def _cloud_name() -> Optional[str]:
    from app.config import get_settings

    return getattr(get_settings(), "cloudinary_cloud_name", None) or None


def is_own_media(url: str) -> bool:
    """A picture already in our media store (this server's /media, or our Cloudinary)."""
    text = (url or "").strip()
    if text.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/"):
        return True
    cloud = _cloud_name()
    return bool(cloud) and text.startswith(f"https://res.cloudinary.com/{cloud}/")


_DRIVE_FILE = re.compile(r"^/file/d/([A-Za-z0-9_-]{10,})")


def direct_url(url: str) -> str:
    """A share link of Google Drive / Dropbox as the address of the file itself."""
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    if host in ("drive.google.com", "docs.google.com"):
        match = _DRIVE_FILE.match(parsed.path or "")
        ident = match.group(1) if match else (parse_qs(parsed.query).get("id") or [None])[0]
        if ident:
            return f"https://drive.google.com/uc?export=download&id={ident}"
    if host.endswith("dropbox.com"):
        query = "&".join(p for p in (parsed.query or "").split("&") if p and not p.startswith(("dl=", "raw=")))
        return urlunparse(parsed._replace(query=(query + "&" if query else "") + "raw=1"))
    return url.strip()


def _check_host(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ImageError("הקישור לתמונה לא תקין - צריך כתובת שמתחילה ב-https://")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise ImageError(f"השרת '{parsed.hostname}' לא נמצא - בדקו את הקישור")
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global or address.is_multicast:
            raise ImageError("הקישור מפנה לכתובת פנימית - אפשר רק קישור לאתר ציבורי באינטרנט")


# ── Downloading ───────────────────────────────────────────────────────────────


def download(url: str) -> bytes:
    """The bytes at `url`, following at most MAX_REDIRECTS redirects, each host checked."""
    import httpx

    current = direct_url(url)
    with httpx.Client(follow_redirects=False, timeout=TIMEOUT_SECONDS,
                      headers={"User-Agent": "R2M-POS catalog import", "Accept": "image/*"}) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            _check_host(current)
            try:
                with client.stream("GET", current) as response:
                    if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                        current = str(response.url.join(response.headers["location"]))
                        continue
                    if response.status_code != 200:
                        raise ImageError(f"השרת החזיר שגיאה ({response.status_code}) - בדקו שהקישור פתוח לכולם")
                    declared = response.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
                        raise ImageError("התמונה גדולה מ-5MB")
                    chunks: List[bytes] = []
                    size = 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise ImageError("התמונה גדולה מ-5MB")
                        chunks.append(chunk)
                    return b"".join(chunks)
            except httpx.TimeoutException:
                raise ImageError("ההורדה לקחה יותר מדי זמן")
            except httpx.HTTPError:
                raise ImageError("לא הצלחנו להוריד את התמונה מהקישור")
    raise ImageError("יותר מדי הפניות בקישור")


def verify(contents: bytes) -> str:
    """The picture's format ("PNG"); refuses anything that is not a picture we serve."""
    from PIL import Image

    if not contents:
        raise ImageError("הקישור החזיר קובץ ריק")
    try:
        with Image.open(io.BytesIO(contents)) as image:
            fmt = (image.format or "").upper()
            image.verify()
    except Exception:  # noqa: BLE001 - any undecodable body is "not a picture"
        raise ImageError("הקישור אינו מוביל לתמונה (JPG, PNG, WEBP או GIF) - אולי זה דף אינטרנט?")
    if fmt not in FORMATS:
        raise ImageError(f"סוג תמונה שלא נתמך ({fmt or 'לא ידוע'}) - אפשר JPG, PNG, WEBP או GIF")
    return fmt


# ── Storing ───────────────────────────────────────────────────────────────────


def store(contents: bytes, tenant_id, resource: str, source: str) -> str:
    """Store the picture as the dashboard's upload does; its public URL."""
    from app.services.cloudinary_service import cloudinary_configured, configure_cloudinary, upload_folder

    folder = upload_folder(tenant_id, resource)  # type: ignore[arg-type]
    public_id = f"{folder}/{marker_of(source)}"
    if cloudinary_configured():
        import cloudinary.uploader

        configure_cloudinary()
        # The same link twice is the same asset: `overwrite=False` answers with the stored one.
        result = cloudinary.uploader.upload(contents, public_id=public_id, resource_type="image", overwrite=False)
        return result["secure_url"]
    return local_media.store(contents, folder, public_id=public_id)["secure_url"]


def fetch_and_store(job: Job, tenant_id) -> Outcome:
    try:
        contents = download(job.source)
        verify(contents)
        return Outcome(url=store(contents, tenant_id, job.resource, job.source))
    except ImageError as exc:
        return Outcome(error=str(exc))
    except Exception as exc:  # noqa: BLE001 - one bad picture never fails the import
        logger.warning("catalog import picture %s failed: %s", job.source, exc)
        return Outcome(error="שמירת התמונה נכשלה")


def materialize(jobs: Iterable[Job], tenant_id) -> Dict[Job, Outcome]:
    """Every job's outcome, a few in parallel; each job once."""
    unique = list(dict.fromkeys(jobs))
    if not unique:
        return {}
    if len(unique) == 1:
        return {unique[0]: fetch_and_store(unique[0], tenant_id)}
    with ThreadPoolExecutor(max_workers=min(WORKERS, len(unique))) as pool:
        outcomes = list(pool.map(lambda job: fetch_and_store(job, tenant_id), unique))
    return dict(zip(unique, outcomes))


def short(url: Optional[str], length: int = 48) -> str:
    """An address as a preview shows it: no scheme, cut in the middle."""
    text = re.sub(r"^https?://", "", (url or "").strip())
    if len(text) <= length:
        return text
    head = length // 2
    return f"{text[:head]}…{text[-(length - head - 1):]}"
