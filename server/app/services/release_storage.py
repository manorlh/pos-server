"""
Where app release files live ("עדכוני גרסה": APKs, Windows installers, kiosk web bundles).

The API runs on several Fly machines, each with its own disk that every deploy wipes. A file kept
on the disk of the machine that took the upload exists there only, until the next deploy. So in
production the files go to an S3-compatible bucket every machine reads (Fly Tigris, Cloudflare
R2, AWS S3, MinIO …), configured by environment variables:

    RELEASE_STORAGE_BUCKET              (or Fly Tigris' BUCKET_NAME)
    RELEASE_STORAGE_ACCESS_KEY_ID       (or AWS_ACCESS_KEY_ID)
    RELEASE_STORAGE_SECRET_ACCESS_KEY   (or AWS_SECRET_ACCESS_KEY)
    RELEASE_STORAGE_ENDPOINT            (or AWS_ENDPOINT_URL_S3; empty → AWS S3)
    RELEASE_STORAGE_REGION              (or AWS_REGION; default "auto" with an endpoint, else us-east-1)
    RELEASE_STORAGE_PREFIX              (default "app-releases/")

`fly storage create` on the app sets exactly the Tigris names, so nothing else is needed there.
Without a bucket the files stay on local disk under `settings.app_releases_dir` (a development
box, an on-premise install) — `storage_status()` tells the dashboard when that is unsafe.

`AppRelease.file_path` says where a release's file is: `s3://<bucket>/<key>` in the bucket, else
a local path (every release from before this module). The devices' URLs do not change: the API
streams the file (Range requests included, for resumed downloads of big installers) — it never
redirects, so no client has to follow a redirect to a signed URL.

A release whose file is in neither place (`available()` false — e.g. a local file a deploy
wiped) is never offered to a device (app/services/app_updates.py); the dashboard shows "הקובץ לא
זמין — יש להעלות מחדש" and lets the super admin attach the same build again
(`POST /app-releases/{id}/file`).

The S3 client is a small Signature V4 implementation over httpx (no boto3 in the image).
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import quote, unquote as _unquote, urlsplit
from xml.etree import ElementTree

import httpx
from fastapi import HTTPException, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from app.config import get_settings

logger = logging.getLogger(__name__)

S3_SCHEME = "s3://"
BACKEND_S3 = "s3"
BACKEND_LOCAL = "local"

_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_CHUNK = 1024 * 1024
#: How long an existence answer is trusted (per API process): a present file for long, a missing
#: one briefly, an S3 error (assumed present: a blip must not hide every release) very briefly.
_TTL_PRESENT = 300.0
_TTL_MISSING = 30.0
_TTL_ERROR = 15.0


class StorageError(Exception):
    """The bucket could not be reached or refused the request."""


# ── Configuration ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class S3Config:
    bucket: str
    access_key_id: str
    secret_access_key: str
    endpoint: str
    region: str
    prefix: str

    @property
    def path_style(self) -> bool:
        # An explicit endpoint (Tigris, R2, MinIO) is addressed path-style; AWS virtual-hosted.
        return bool(self.endpoint)


def _first(*values: Optional[str]) -> str:
    for v in values:
        if v and str(v).strip():
            return str(v).strip()
    return ""


def s3_config() -> Optional[S3Config]:
    """The bucket's settings, or None when release files are kept on local disk."""
    s = get_settings()
    env = os.environ.get
    bucket = _first(getattr(s, "release_storage_bucket", ""), env("BUCKET_NAME"))
    key_id = _first(getattr(s, "release_storage_access_key_id", ""), env("AWS_ACCESS_KEY_ID"))
    secret = _first(getattr(s, "release_storage_secret_access_key", ""), env("AWS_SECRET_ACCESS_KEY"))
    if not (bucket and key_id and secret):
        return None
    endpoint = _first(getattr(s, "release_storage_endpoint", ""), env("AWS_ENDPOINT_URL_S3")).rstrip("/")
    region = _first(getattr(s, "release_storage_region", ""), env("AWS_REGION")) or ("auto" if endpoint else "us-east-1")
    prefix = getattr(s, "release_storage_prefix", None)
    prefix = "app-releases/" if prefix is None else str(prefix).strip().lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return S3Config(bucket, key_id, secret, endpoint, region, prefix)


def backend() -> str:
    return BACKEND_S3 if s3_config() is not None else BACKEND_LOCAL


def storage_status() -> Dict[str, object]:
    """
    For the dashboard: `backend` "s3" | "local", `shared` (every API machine sees the files) and
    `ephemeral` — local disk on Fly, where another machine 404s the file and the next deploy
    deletes it.
    """
    kind = backend()
    on_fly = bool(os.environ.get("FLY_APP_NAME"))
    return {"backend": kind, "shared": kind == BACKEND_S3, "ephemeral": kind == BACKEND_LOCAL and on_fly}


# ── Signature V4 ─────────────────────────────────────────────────────────────


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _uri_encode(value: str, safe: str = "-_.~") -> str:
    return quote(value, safe=safe)


def sign_v4(
    method: str,
    url: str,
    headers: Dict[str, str],
    *,
    access_key_id: str,
    secret_access_key: str,
    region: str,
    payload_sha256: str,
    now: Optional[datetime] = None,
    service: str = "s3",
) -> Dict[str, str]:
    """
    `headers` plus `x-amz-date`, `x-amz-content-sha256` and `Authorization` (AWS Signature V4,
    header form). Every header given is signed; `host` is added from the URL when missing.
    """
    when = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date = when.strftime("%Y%m%dT%H%M%SZ")
    day = when.strftime("%Y%m%d")
    parts = urlsplit(url)
    out = dict(headers)
    lower = {k.lower(): k for k in out}
    if "host" not in lower:
        out["host"] = parts.netloc
    out["x-amz-date"] = amz_date
    out["x-amz-content-sha256"] = payload_sha256
    canon = sorted(((k.lower(), " ".join(str(v).strip().split())) for k, v in out.items()), key=lambda kv: kv[0])
    signed_headers = ";".join(k for k, _ in canon)
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in canon)
    query_pairs: List[Tuple[str, str]] = []
    if parts.query:
        for item in parts.query.split("&"):
            k, _, v = item.partition("=")
            query_pairs.append((_uri_encode(_unquote(k)), _uri_encode(_unquote(v))))
    canonical_query = "&".join(f"{k}={v}" for k, v in sorted(query_pairs))
    canonical_uri = _uri_encode(_unquote(parts.path or "/"), safe="-_.~/")
    canonical_request = "\n".join(
        [method.upper(), canonical_uri, canonical_query, canonical_headers, signed_headers, payload_sha256]
    )
    scope = f"{day}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()]
    )
    key = _hmac(("AWS4" + secret_access_key).encode("utf-8"), day)
    key = _hmac(key, region)
    key = _hmac(key, service)
    key = _hmac(key, "aws4_request")
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    out["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
    return out


# ── S3 client ────────────────────────────────────────────────────────────────

#: Tests replace this with an httpx.Client on a MockTransport.
_client: Optional[httpx.Client] = None
_client_lock = threading.Lock()


def http_client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(timeout=httpx.Timeout(30.0, read=120.0, write=600.0), follow_redirects=False)
        return _client


def set_http_client(client: Optional[httpx.Client]) -> None:
    """Tests: route the S3 calls through `client` (None → the default one again)."""
    global _client
    with _client_lock:
        _client = client
    clear_cache()


def _object_url(cfg: S3Config, bucket: str, key: str, query: str = "") -> str:
    path_key = _uri_encode(key, safe="-_.~/")
    if cfg.path_style:
        url = f"{cfg.endpoint}/{bucket}/{path_key}"
    elif cfg.endpoint:
        url = f"{cfg.endpoint}/{path_key}"
    else:
        host = f"{bucket}.s3.amazonaws.com" if cfg.region == "us-east-1" else f"{bucket}.s3.{cfg.region}.amazonaws.com"
        url = f"https://{host}/{path_key}"
    return f"{url}?{query}" if query else url


def _bucket_url(cfg: S3Config, bucket: str, query: str) -> str:
    return _object_url(cfg, bucket, "", query)


def _signed(cfg: S3Config, method: str, url: str, headers: Optional[Dict[str, str]] = None,
            payload_sha256: str = _EMPTY_SHA256) -> Dict[str, str]:
    return sign_v4(
        method, url, headers or {},
        access_key_id=cfg.access_key_id, secret_access_key=cfg.secret_access_key,
        region=cfg.region, payload_sha256=payload_sha256,
    )


def _require_cfg() -> S3Config:
    cfg = s3_config()
    if cfg is None:
        raise StorageError("release storage bucket is not configured")
    return cfg


def s3_put_file(bucket: str, key: str, path: Path, sha256: str, size: int,
                content_type: str = "application/octet-stream") -> None:
    """Upload `path` as `key`. The payload hash is the file's SHA-256, so the bucket refuses a
    body that does not match it; the stored size is checked after."""
    cfg = _require_cfg()
    url = _object_url(cfg, bucket, key)
    headers = _signed(
        cfg, "PUT", url,
        {"content-length": str(size), "content-type": content_type, "x-amz-meta-sha256": sha256},
        payload_sha256=sha256,
    )
    try:
        with open(path, "rb") as body:
            resp = http_client().put(url, headers=headers, content=_file_chunks(body))
    except httpx.HTTPError as exc:
        raise StorageError(f"PUT {key}: {exc}") from exc
    if resp.status_code not in (200, 201):
        raise StorageError(f"PUT {key}: HTTP {resp.status_code} {resp.text[:300]}")
    stored = s3_head(bucket, key)
    if stored is None or int(stored.get("content-length", -1)) != size:
        raise StorageError(f"PUT {key}: stored size differs from {size}")


def _file_chunks(f) -> Iterator[bytes]:
    while True:
        chunk = f.read(_CHUNK)
        if not chunk:
            return
        yield chunk


def s3_head(bucket: str, key: str) -> Optional[httpx.Headers]:
    """The object's headers, None when it does not exist; `StorageError` otherwise."""
    cfg = _require_cfg()
    url = _object_url(cfg, bucket, key)
    try:
        resp = http_client().head(url, headers=_signed(cfg, "HEAD", url))
    except httpx.HTTPError as exc:
        raise StorageError(f"HEAD {key}: {exc}") from exc
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise StorageError(f"HEAD {key}: HTTP {resp.status_code}")
    return resp.headers


def s3_delete(bucket: str, key: str) -> None:
    cfg = _require_cfg()
    url = _object_url(cfg, bucket, key)
    try:
        resp = http_client().delete(url, headers=_signed(cfg, "DELETE", url))
    except httpx.HTTPError as exc:
        raise StorageError(f"DELETE {key}: {exc}") from exc
    if resp.status_code not in (200, 204, 404):
        raise StorageError(f"DELETE {key}: HTTP {resp.status_code}")


def s3_list_keys(bucket: str, prefix: str) -> set:
    """Every key under `prefix` (ListObjectsV2, paginated)."""
    cfg = _require_cfg()
    keys: set = set()
    token: Optional[str] = None
    ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
    for _ in range(100):
        query = "list-type=2&prefix=" + _uri_encode(prefix)
        if token:
            query += "&continuation-token=" + _uri_encode(token)
        url = _bucket_url(cfg, bucket, query)
        try:
            resp = http_client().get(url, headers=_signed(cfg, "GET", url))
        except httpx.HTTPError as exc:
            raise StorageError(f"LIST {prefix}: {exc}") from exc
        if resp.status_code != 200:
            raise StorageError(f"LIST {prefix}: HTTP {resp.status_code}")
        root = ElementTree.fromstring(resp.content)
        for el in root.iter():
            if el.tag in (f"{ns}Key", "Key") and el.text:
                keys.add(el.text)
        truncated = next((el.text for el in root.iter() if el.tag in (f"{ns}IsTruncated", "IsTruncated")), "false")
        token = next(
            (el.text for el in root.iter() if el.tag in (f"{ns}NextContinuationToken", "NextContinuationToken")), None
        )
        if (truncated or "").lower() != "true" or not token:
            break
    return keys


def s3_open(bucket: str, key: str, method: str = "GET", extra: Optional[Dict[str, str]] = None) -> httpx.Response:
    """A streamed response for the object (the caller closes it); `extra` = Range / If-Range."""
    cfg = _require_cfg()
    url = _object_url(cfg, bucket, key)
    headers = _signed(cfg, method, url, dict(extra or {}))
    client = http_client()
    try:
        return client.send(client.build_request(method, url, headers=headers), stream=True)
    except httpx.HTTPError as exc:
        raise StorageError(f"{method} {key}: {exc}") from exc


# ── Locations ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Location:
    kind: str  # BACKEND_S3 | BACKEND_LOCAL
    bucket: str = ""
    key: str = ""
    path: Optional[Path] = None

    @property
    def name(self) -> str:
        return (self.key.rsplit("/", 1)[-1]) if self.kind == BACKEND_S3 else (self.path.name if self.path else "")


def parse(file_path: Optional[str]) -> Optional[Location]:
    value = str(file_path or "").strip()
    if not value:
        return None
    if value.startswith(S3_SCHEME):
        bucket, _, key = value[len(S3_SCHEME):].partition("/")
        if not bucket or not key:
            return None
        return Location(BACKEND_S3, bucket=bucket, key=key)
    return Location(BACKEND_LOCAL, path=Path(value))


def s3_uri(bucket: str, key: str) -> str:
    return f"{S3_SCHEME}{bucket}/{key}"


def location_of(release) -> Optional[Location]:
    return parse(getattr(release, "file_path", None))


# ── Existence (cached) ───────────────────────────────────────────────────────

_cache: Dict[str, Tuple[bool, float]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _remember(uri: str, present: bool, ttl: float) -> None:
    with _cache_lock:
        _cache[uri] = (present, time.monotonic() + ttl)


def forget(file_path: Optional[str]) -> None:
    with _cache_lock:
        _cache.pop(str(file_path or ""), None)


def _cached(uri: str) -> Optional[bool]:
    with _cache_lock:
        hit = _cache.get(uri)
    if hit is None or hit[1] < time.monotonic():
        return None
    return hit[0]


def exists(file_path: Optional[str]) -> bool:
    """Whether the file is in storage now (an S3 answer is cached a little while)."""
    loc = parse(file_path)
    if loc is None:
        return False
    if loc.kind == BACKEND_LOCAL:
        return loc.path.is_file()
    if s3_config() is None:
        return False
    uri = str(file_path)
    hit = _cached(uri)
    if hit is not None:
        return hit
    try:
        present = s3_head(loc.bucket, loc.key) is not None
    except StorageError as exc:
        logger.warning("release storage: %s — assuming present", exc)
        _remember(uri, True, _TTL_ERROR)
        return True
    _remember(uri, present, _TTL_PRESENT if present else _TTL_MISSING)
    return present


def available(release) -> bool:
    """The release's file can be served: not deleted ("מחיקת קובץ") and in storage."""
    if getattr(release, "file_deleted_at", None) is not None:
        return False
    return exists(getattr(release, "file_path", None))


def availability(releases: Iterable) -> Dict[object, bool]:
    """`available` for many releases, with one bucket listing instead of one HEAD each."""
    releases = list(releases)
    wanted = {}
    for r in releases:
        loc = location_of(r)
        if loc is not None and loc.kind == BACKEND_S3 and getattr(r, "file_deleted_at", None) is None:
            if _cached(str(r.file_path)) is None:
                wanted.setdefault(loc.bucket, []).append(loc.key)
    if wanted and s3_config() is not None:
        cfg = s3_config()
        for bucket, keys in wanted.items():
            try:
                listed = s3_list_keys(bucket, cfg.prefix if all(k.startswith(cfg.prefix) for k in keys) else "")
            except StorageError as exc:
                logger.warning("release storage: %s", exc)
                continue
            for key in keys:
                present = key in listed
                _remember(s3_uri(bucket, key), present, _TTL_PRESENT if present else _TTL_MISSING)
    return {r.id: available(r) for r in releases}


# ── Store / delete ───────────────────────────────────────────────────────────


def releases_dir() -> Path:
    path = Path(get_settings().app_releases_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def store(local: Path, name: str, sha256: str, size: int, content_type: str = "application/octet-stream") -> str:
    """
    Keep the uploaded file `local` (already checked) as `name` (`{release id}.{ext}`) and return
    what goes in `AppRelease.file_path`. The bucket when configured (`local` is left for the
    caller to remove), else moved into `app_releases_dir`.
    """
    cfg = s3_config()
    if cfg is None:
        final = releases_dir() / name
        os.replace(local, final)
        return str(final)
    key = f"{cfg.prefix}{name}"
    s3_put_file(cfg.bucket, key, local, sha256, size, content_type)
    uri = s3_uri(cfg.bucket, key)
    _remember(uri, True, _TTL_PRESENT)
    return uri


def remove_stored(file_path: str) -> bool:
    """Delete a stored file. True when it was there, False when already gone; `StorageError` /
    `OSError` when it could not be deleted."""
    loc = parse(file_path)
    if loc is None:
        return False
    forget(file_path)
    if loc.kind == BACKEND_LOCAL:
        try:
            os.remove(loc.path)
        except FileNotFoundError:
            return False
        return True
    if s3_head(loc.bucket, loc.key) is None:
        return False
    s3_delete(loc.bucket, loc.key)
    _remember(file_path, False, _TTL_MISSING)
    return True


@contextlib.contextmanager
def local_copy(release) -> Iterator[Path]:
    """A local path to read the release's file from (a temporary download for the bucket)."""
    loc = location_of(release)
    if loc is None:
        raise FileNotFoundError("no file")
    if loc.kind == BACKEND_LOCAL:
        if not loc.path.is_file():
            raise FileNotFoundError(str(loc.path))
        yield loc.path
        return
    resp = s3_open(loc.bucket, loc.key)
    fd, tmp = tempfile.mkstemp(suffix="-" + loc.name)
    try:
        try:
            if resp.status_code == 404:
                raise FileNotFoundError(loc.key)
            if resp.status_code != 200:
                raise StorageError(f"GET {loc.key}: HTTP {resp.status_code}")
            with os.fdopen(fd, "wb") as out:
                for chunk in resp.iter_bytes(_CHUNK):
                    out.write(chunk)
        finally:
            resp.close()
        yield Path(tmp)
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)


# ── Serving ──────────────────────────────────────────────────────────────────

_PASS_HEADERS = ("content-length", "content-range", "etag", "last-modified")


def serve(release, request, media_type: str, filename: str) -> Response:
    """
    The release's file as the download response: a local file through FileResponse, an object in
    the bucket streamed through the API — Range / If-Range passed on (206 / 416 as the bucket
    answers), HEAD answered without a body. `404 app_release_file_missing` when it is not there,
    `503 app_release_storage_unavailable` when the bucket cannot be reached.
    """
    loc = location_of(release)
    missing = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release file missing")
    if loc is None:
        raise missing
    if loc.kind == BACKEND_LOCAL:
        if not loc.path.is_file():
            logger.error("app release %s: file missing at %s", getattr(release, "id", "?"), loc.path)
            raise missing
        return FileResponse(str(loc.path), media_type=media_type, filename=filename)
    if s3_config() is None:
        logger.error("app release %s is in the bucket but no bucket is configured", getattr(release, "id", "?"))
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="app_release_storage_unavailable")
    method = "HEAD" if request is not None and request.method == "HEAD" else "GET"
    extra = {}
    if request is not None:
        for name in ("range", "if-range"):
            value = request.headers.get(name)
            if value:
                extra[name] = value
    try:
        resp = s3_open(loc.bucket, loc.key, method=method, extra=extra)
    except StorageError as exc:
        logger.error("app release %s: %s", getattr(release, "id", "?"), exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="app_release_storage_unavailable")
    if resp.status_code == 404:
        resp.close()
        _remember(str(release.file_path), False, _TTL_MISSING)
        logger.error("app release %s: object %s missing", getattr(release, "id", "?"), loc.key)
        raise missing
    if resp.status_code == 416:
        resp.close()
        return Response(status_code=416, headers={"content-range": resp.headers.get("content-range", "")})
    if resp.status_code not in (200, 206):
        resp.close()
        logger.error("app release %s: bucket answered %s", getattr(release, "id", "?"), resp.status_code)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="app_release_storage_unavailable")
    headers = {k: resp.headers[k] for k in _PASS_HEADERS if k in resp.headers}
    headers["accept-ranges"] = "bytes"
    headers["content-disposition"] = f'attachment; filename="{filename}"'
    if method == "HEAD":
        resp.close()
        return Response(status_code=resp.status_code, headers=headers, media_type=media_type)

    def body() -> Iterator[bytes]:
        try:
            for chunk in resp.iter_bytes(_CHUNK):
                yield chunk
        finally:
            resp.close()

    return StreamingResponse(
        body(), status_code=resp.status_code, headers=headers, media_type=media_type,
        background=BackgroundTask(resp.close),
    )

