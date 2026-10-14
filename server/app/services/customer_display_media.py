"""
"מסך לקוח" — the slideshow's files (P:/specs/customer-display-transitions.md §3א, §5).

**Upload, then compress in the background.** `POST /customer-display/media` keeps the original in
its row (`customer_display_media.source`) and answers at once with `status: "processing"`; the
dashboard shows "בעיבוד…". The worker here (a thread per API process, lease-safe across
processes) compresses it:

* an image: at most `IMAGE_MAX_EDGE` px on its long side, WebP at quality 80 (JPEG 80 where this
  Pillow has no WebP);
* a video: H.264 MP4 (yuv420p, `+faststart`), no sound, its short side at most 720 or 1080
  (`videoQuality` of the uploading level). No ffmpeg on this server: stored as uploaded, with the
  warning `ffmpeg_missing` (the dashboard says so); ffmpeg failing on it: `compress_failed`.

then stores it (Cloudinary, else the server's own media store), drops the original (never kept),
and writes its URL and sha256 into every playlist that names its `mediaId` — the devices of
those layers are told to pull their configuration.

**Presence** (§5.4): every till and customer display reports in its heartbeat the sha256s of the
slideshow files it holds (`customerDisplayMedia: {screen, held}`); a till with no customer screen
says `screen: false` and is not counted. The dashboard shows per file "קיים ב-X מתוך Y מכשירים".

**Retention** (`mediaRetention`, §5.6), hourly: a ready file is deleted from the server only when
the policy of every layer whose playlist holds it allows — `keep` never; `days:N` N days after it
was ready; `until_downloaded` once every device using it has reported it (at least one). A file
no playlist holds is left alone. Deleted, its URL and hash stay in the playlists (`onServer:
false` to the devices: copy it from a till in the shop, never from the cloud); a device that
reported and lacks it is "חסר בקופה N" on the dashboard (with "העלה מחדש") and a low problem on
"בעיות".
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import String, cast, or_, text
from sqlalchemy.orm import Session

from app.services import customer_display as CD

logger = logging.getLogger(__name__)

STATUS_PROCESSING, STATUS_READY, STATUS_FAILED, STATUS_DELETED = "processing", "ready", "failed", "deleted"
WARN_FFMPEG_MISSING, WARN_COMPRESS_FAILED = "ffmpeg_missing", "compress_failed"

IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp")
VIDEO_TYPES = {"video/mp4": "mp4", "video/webm": "webm"}
IMAGE_MAX_EDGE = 1920
IMAGE_QUALITY = 80
#: The short side of a compressed video, at most.
VIDEO_SHORT_SIDE = {"720p": 720, "1080p": 1080}
VIDEO_CRF = 23
FFMPEG_TIMEOUT_SEC = 15 * 60
#: A job's lease: a worker that died mid-way leaves it to another after this.
LEASE = timedelta(minutes=20)
MAX_ATTEMPTS = 3
#: A device's report: at most this many hashes kept.
HELD_MAX = 100
#: A report the same as the last one is written again only this often (not on every beat).
REPORT_REFRESH = timedelta(minutes=10)

NOTIFY_REASON = "customer_display_updated"


class MediaRefused(Exception):
    """An upload that does not fit: `code` for the client, `message` in Hebrew, the HTTP status."""

    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def body(self) -> Dict[str, Any]:
        return {"code": self.code, "message": self.message}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _model():
    from app.models.customer_display import CustomerDisplayMedia

    return CustomerDisplayMedia


def _presence_model():
    from app.models.customer_display import CustomerDisplayMediaPresence

    return CustomerDisplayMediaPresence


# ── The upload ───────────────────────────────────────────────────────────────


def kind_of_upload(contents: bytes, content_type: Optional[str]) -> str:
    """'image' / 'video' for an upload that fits (`POST /images/media`'s rules); raises MediaRefused."""
    from app.services.image_validation import read_image_dimensions

    ctype = (content_type or "").lower()
    if ctype not in IMAGE_TYPES and ctype not in VIDEO_TYPES:
        raise MediaRefused("customer_display_media_type", "רק תמונה (PNG / JPEG / WebP) או סרטון MP4 / WebM.", 415)
    if not contents:
        raise MediaRefused("customer_display_media_empty", "הקובץ ריק.", 400)
    if len(contents) > CD.MEDIA_MAX_BYTES:
        raise MediaRefused("customer_display_media_too_large", "הקובץ גדול מ-25MB.", 413)
    if ctype in VIDEO_TYPES:
        return "video"
    if read_image_dimensions(contents) is None:
        raise MediaRefused("customer_display_media_unreadable", "התמונה לא קריאה.", 400)
    return "image"


def create(
    db: Session, *, tenant_id: Any, user_id: Any, contents: bytes, content_type: Optional[str], video_quality: str
) -> Any:
    """A new file, waiting for the worker (the caller commits, then `wake()`s it)."""
    kind = kind_of_upload(contents, content_type)
    M = _model()
    row = M(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        kind=kind,
        status=STATUS_PROCESSING,
        source=contents,
        source_type=(content_type or "").lower(),
        source_bytes=len(contents),
        video_quality=video_quality if video_quality in CD.VIDEO_QUALITIES else CD.DEFAULTS["videoQuality"],
        attempts=0,
        created_by=user_id,
        created_at=_now(),
    )
    db.add(row)
    db.flush()
    return row


def restart(db: Session, row: Any, *, contents: bytes, content_type: Optional[str], video_quality: str) -> Any:
    """
    "העלה מחדש": a file deleted from the server (or whose processing failed) gets the file again;
    processed like a new one, its new URL replaces the old in every playlist holding it.
    """
    if row.status not in (STATUS_DELETED, STATUS_FAILED):
        raise MediaRefused("customer_display_media_not_missing", "הקובץ עדיין שמור בשרת; אין צורך להעלות מחדש.", 409)
    row.kind = kind_of_upload(contents, content_type)
    row.status = STATUS_PROCESSING
    row.source = contents
    row.source_type = (content_type or "").lower()
    row.source_bytes = len(contents)
    row.video_quality = video_quality if video_quality in CD.VIDEO_QUALITIES else CD.DEFAULTS["videoQuality"]
    row.attempts = 0
    row.error = None
    row.warning = None
    row.lease_until = None
    db.flush()
    return row


def view(row: Any) -> Dict[str, Any]:
    """A file as the dashboard sees it."""
    return {
        "id": str(row.id),
        "kind": row.kind,
        "status": row.status,
        "url": row.url if row.status in (STATUS_READY, STATUS_DELETED) else None,
        "sha256": row.sha256,
        "bytes": row.bytes,
        "sourceBytes": row.source_bytes,
        "width": row.width,
        "height": row.height,
        "warning": row.warning,
        "onServer": row.status != STATUS_DELETED,
        "videoQuality": row.video_quality if row.kind == "video" else None,
        "createdAt": _aware(row.created_at).isoformat() if row.created_at else None,
        "readyAt": _aware(row.ready_at).isoformat() if row.ready_at else None,
        "deletedAt": _aware(row.deleted_at).isoformat() if row.deleted_at else None,
    }


# ── Compression ──────────────────────────────────────────────────────────────


@dataclass
class Compressed:
    data: bytes
    ext: str
    content_type: str
    width: Optional[int] = None
    height: Optional[int] = None


def _webp_supported() -> bool:
    try:
        from PIL import features

        return bool(features.check("webp"))
    except Exception:  # noqa: BLE001
        return False


def compress_image(contents: bytes, *, webp: Optional[bool] = None) -> Compressed:
    """At most IMAGE_MAX_EDGE on the long side, upright (EXIF), WebP 80 — JPEG 80 without WebP."""
    from PIL import Image, ImageOps

    image = Image.open(io.BytesIO(contents))
    image = ImageOps.exif_transpose(image)
    image.load()
    if max(image.size) > IMAGE_MAX_EDGE:
        image.thumbnail((IMAGE_MAX_EDGE, IMAGE_MAX_EDGE), Image.LANCZOS)
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    out = io.BytesIO()
    if _webp_supported() if webp is None else webp:
        image = image.convert("RGBA" if has_alpha else "RGB")
        image.save(out, format="WEBP", quality=IMAGE_QUALITY, method=4)
        return Compressed(out.getvalue(), "webp", "image/webp", image.width, image.height)
    if has_alpha:
        flat = Image.new("RGB", image.size, (255, 255, 255))
        flat.paste(image.convert("RGBA"), mask=image.convert("RGBA").split()[-1])
        image = flat
    else:
        image = image.convert("RGB")
    image.save(out, format="JPEG", quality=IMAGE_QUALITY, optimize=True, progressive=True)
    return Compressed(out.getvalue(), "jpg", "image/jpeg", image.width, image.height)


def ffmpeg_args(src: str, dst: str, quality: str, exe: str = "ffmpeg") -> List[str]:
    """
    H.264 MP4 for every device's decoder: main profile, yuv420p, the short side at most 720 /
    1080 (never enlarged; even sizes), no sound, no subtitles or metadata, `+faststart` so it
    starts playing before it is all read.
    """
    short = VIDEO_SHORT_SIDE.get(quality, VIDEO_SHORT_SIDE["720p"])
    # Landscape: the height is the short side; portrait: the width. -2: the other one by the
    # aspect, even. Quoted, so the commas stay inside the expressions.
    scale = (
        f"scale='if(gte(iw,ih),-2,trunc(min({short},iw)/2)*2)'"
        f":'if(gte(iw,ih),trunc(min({short},ih)/2)*2,-2)'"
    )
    return [
        exe, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
        "-vf", scale,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(VIDEO_CRF),
        "-profile:v", "main", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-threads", "2",
        dst,
    ]


def compress_video(
    contents: bytes,
    source_type: str,
    quality: str,
    *,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Callable[..., Any] = subprocess.run,
) -> Tuple[Compressed, Optional[str]]:
    """The video compressed, and a warning when it is stored as uploaded instead."""
    ext = VIDEO_TYPES.get(source_type, "mp4")
    original = Compressed(contents, ext, source_type or "video/mp4")
    exe = which("ffmpeg")
    if not exe:
        logger.warning("customer display media: no ffmpeg on this server; a video is stored uncompressed")
        return original, WARN_FFMPEG_MISSING
    with tempfile.TemporaryDirectory(prefix="cdmedia-") as tmp:
        src = os.path.join(tmp, f"in.{ext}")
        dst = os.path.join(tmp, "out.mp4")
        with open(src, "wb") as f:
            f.write(contents)
        try:
            done = run(ffmpeg_args(src, dst, quality, exe), capture_output=True, timeout=FFMPEG_TIMEOUT_SEC)
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.warning("customer display media: ffmpeg did not finish (%s); stored uncompressed", exc)
            return original, WARN_COMPRESS_FAILED
        if getattr(done, "returncode", 1) != 0 or not os.path.isfile(dst) or os.path.getsize(dst) == 0:
            tail = (getattr(done, "stderr", b"") or b"")[-400:]
            logger.warning("customer display media: ffmpeg failed (%s); stored uncompressed", tail.decode("utf-8", "replace"))
            return original, WARN_COMPRESS_FAILED
        with open(dst, "rb") as f:
            return Compressed(f.read(), "mp4", "video/mp4"), None


# ── Storage ──────────────────────────────────────────────────────────────────


def store_file(data: bytes, *, tenant_id: Any, kind: str, ext: str) -> Tuple[str, str, str]:
    """(url, storage, public id): Cloudinary when it is set up, else the server's own media store."""
    from app.services import local_media
    from app.services.cloudinary_service import cloudinary_configured, configure_cloudinary, upload_folder

    folder = f"{upload_folder(tenant_id, 'branding')}/customer-display"
    if cloudinary_configured():
        import cloudinary.uploader

        configure_cloudinary()
        result = cloudinary.uploader.upload(
            data, folder=folder, resource_type="video" if kind == "video" else "image",
            overwrite=False, unique_filename=True, use_filename=False,
        )
        return result["secure_url"], "cloudinary", result["public_id"]
    url = local_media.store_raw(data, folder, ext)
    return url, "local", url.split(f"{local_media.MEDIA_PREFIX}/", 1)[1]


def delete_file(row: Any) -> None:
    """The stored file itself, gone (a file already gone is fine)."""
    if row.storage == "cloudinary" and row.public_id:
        import cloudinary.uploader

        from app.services.cloudinary_service import configure_cloudinary

        configure_cloudinary()
        cloudinary.uploader.destroy(row.public_id, resource_type="video" if row.kind == "video" else "image", invalidate=True)
    elif row.storage == "local" and row.public_id:
        from app.services import local_media

        parts = [p for p in str(row.public_id).replace("\\", "/").split("/") if p and p not in (".", "..")]
        if parts:
            local_media.MEDIA_DIR.joinpath(*parts).unlink(missing_ok=True)


# ── The worker's job ─────────────────────────────────────────────────────────


def claim(db: Session, now: Optional[datetime] = None, *, only_id: Any = None) -> Optional[uuid.UUID]:
    """Lease the oldest file waiting (or [only_id]); None when there is none (or another has it)."""
    M = _model()
    now = now or _now()
    q = db.query(M.id).filter(
        M.status == STATUS_PROCESSING,
        M.attempts < MAX_ATTEMPTS,
        or_(M.lease_until.is_(None), M.lease_until < now),
    )
    if only_id is not None:
        q = q.filter(M.id == only_id)
    found = q.order_by(M.created_at.asc()).limit(1).with_for_update(skip_locked=True).first()
    if found is None:
        db.rollback()
        return None
    db.query(M).filter(M.id == found[0]).update(
        {M.lease_until: now + LEASE, M.attempts: M.attempts + 1}, synchronize_session=False
    )
    db.commit()
    return found[0]


def process(
    db: Session,
    media_id: Any,
    *,
    now: Optional[datetime] = None,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Callable[..., Any] = subprocess.run,
    store: Callable[..., Tuple[str, str, str]] = store_file,
    notify: bool = True,
) -> Any:
    """Compress one leased file, store it, write it into the playlists naming it. Commits."""
    M = _model()
    row = db.get(M, media_id)
    if row is None or row.status != STATUS_PROCESSING or row.source is None:
        return row
    now = now or _now()
    try:
        warning = None
        if row.kind == "image":
            out = compress_image(bytes(row.source))
        else:
            out, warning = compress_video(bytes(row.source), row.source_type or "video/mp4", row.video_quality or "720p",
                                          which=which, run=run)
        url, storage, public_id = store(out.data, tenant_id=row.tenant_id, kind=row.kind, ext=out.ext)
    except Exception as exc:  # noqa: BLE001 - recorded on the row; retried up to MAX_ATTEMPTS
        logger.exception("customer display media %s: processing failed", row.id)
        row.error = str(exc)[:200]
        row.lease_until = None
        if (row.attempts or 0) >= MAX_ATTEMPTS:
            row.status = STATUS_FAILED
            row.source = None
        db.commit()
        return row
    row.url = url
    row.storage = storage
    row.public_id = public_id
    row.sha256 = hashlib.sha256(out.data).hexdigest()
    row.bytes = len(out.data)
    row.width, row.height = out.width, out.height
    row.warning = warning
    row.error = None
    row.status = STATUS_READY
    row.source = None
    row.lease_until = None
    row.ready_at = now
    row.deleted_at = None
    touched = patch_layers(db, row)
    db.commit()
    if notify:
        notify_layers(db, touched)
    return row


def fail_stuck(db: Session, now: Optional[datetime] = None) -> int:
    """Files whose every attempt ran out with no answer (a worker that died each time): failed."""
    M = _model()
    now = now or _now()
    rows = (
        db.query(M)
        .filter(M.status == STATUS_PROCESSING, M.attempts >= MAX_ATTEMPTS, or_(M.lease_until.is_(None), M.lease_until < now))
        .all()
    )
    for row in rows:
        row.status = STATUS_FAILED
        row.source = None
        row.lease_until = None
        row.error = row.error or "attempts_exhausted"
    db.commit()
    return len(rows)


def run_jobs(session_factory: Callable[[], Session], *, limit: int = 5, **kw) -> int:
    """Up to [limit] waiting files processed, one at a time. How many."""
    done = 0
    db = session_factory()
    try:
        fail_stuck(db)
    finally:
        db.close()
    for _ in range(limit):
        db = session_factory()
        try:
            media_id = claim(db)
            if media_id is None:
                return done
            process(db, media_id, **kw)
            done += 1
        finally:
            db.close()
    return done


# ── The playlists that name a file ───────────────────────────────────────────


def _entity_models():
    from app.models.company import Company
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea

    return (("company", Company), ("shop", Shop), ("area", ShopArea), ("machine", POSMachine))


def layers_naming(db: Session, tenant_id: Any, needle: str) -> List[Tuple[str, Any]]:
    """Every entity of the tenant whose settings mention [needle] (a media id / URL), as (level, entity)."""
    out: List[Tuple[str, Any]] = []
    for level, Model in _entity_models():
        rows = (
            db.query(Model)
            .filter(Model.tenant_id == tenant_id, cast(Model.settings, String).like(f"%{needle}%"))
            .all()
        )
        out.extend((level, e) for e in rows if needle in str(CD.layer_of(e.settings).get("playlist") or ""))
    return out


def _item_from(row: Any, item: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(item)
    out["url"] = row.url
    out["kind"] = row.kind
    if row.sha256:
        out["sha256"] = row.sha256
    if row.bytes and row.bytes <= CD.MEDIA_MAX_BYTES:
        out["bytes"] = row.bytes
    else:
        out.pop("bytes", None)
    return out


def patch_layers(db: Session, row: Any) -> List[Tuple[str, Any]]:
    """The file's URL, kind, hash and size written into every playlist slide with its `mediaId`."""
    from app.services.settings_merge import utc_now

    needle = str(row.id)
    touched: List[Tuple[str, Any]] = []
    for level, entity in layers_naming(db, row.tenant_id, needle):
        settings = dict(entity.settings) if isinstance(entity.settings, dict) else {}
        layer = CD.layer_of(settings)
        playlist = layer.get("playlist")
        if not isinstance(playlist, list):
            continue
        changed = False
        out = []
        for item in playlist:
            if isinstance(item, dict) and item.get("mediaId") == needle:
                new = _item_from(row, item)
                changed = changed or new != item
                out.append(new)
            else:
                out.append(item)
        if changed:
            settings[CD.SETTINGS_KEY] = {**layer, "playlist": out}
            entity.settings = settings
            entity.settings_updated_at = utc_now()
            touched.append((level, entity))
    return touched


def notify_layers(db: Session, touched: Iterable[Tuple[str, Any]]) -> None:
    """The devices those layers reach pull their configuration again. Never raises."""
    from app.services import settings_notify as N

    for level, entity in touched:
        try:
            if level == "company":
                N.notify_machines_for_company_settings(db, str(entity.id), reason=NOTIFY_REASON)
            elif level == "shop":
                N.notify_machines_for_shop_settings(db, str(entity.id), reason=NOTIFY_REASON)
            elif level == "area":
                N.notify_machines_for_area_settings(db, str(entity.id), reason=NOTIFY_REASON)
            else:
                N.notify_machine_settings(db, entity, reason=NOTIFY_REASON)
        except Exception as exc:  # noqa: BLE001 - devices poll anyway
            logger.warning("customer display media notify failed: %s", exc)


def _rows_by_id(db: Session, ids: Iterable[Any]) -> Dict[str, Any]:
    M = _model()
    wanted = []
    for i in {str(x) for x in ids if x}:
        try:
            wanted.append(uuid.UUID(i))
        except ValueError:
            continue
    if not wanted:
        return {}
    return {str(r.id): r for r in db.query(M).filter(M.id.in_(wanted)).all()}


def fill_layer(db: Session, tenant_id: Any, layer: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    A cleaned layer about to be stored: each slide with a `mediaId` checked (this tenant's file)
    and, once its file is ready, given its URL and hash — so a file finished before the save
    is not left without them. A file whose processing failed is refused (remove it, or upload it
    again).
    """
    if not layer or not isinstance(layer.get("playlist"), list):
        return layer
    rows = _rows_by_id(db, (i.get("mediaId") for i in layer["playlist"]))
    out = []
    for n, item in enumerate(layer["playlist"], start=1):
        mid = item.get("mediaId")
        if not mid:
            out.append(item)
            continue
        row = rows.get(mid)
        if row is None or str(row.tenant_id) != str(tenant_id):
            raise CD.CustomerDisplayError("customer_display_invalid", f"פריט {n} במצגת: הקובץ לא נמצא.", "playlist")
        if row.status == STATUS_FAILED:
            raise CD.CustomerDisplayError(
                "customer_display_invalid", f"פריט {n} במצגת: עיבוד הקובץ נכשל. הסירו אותו או העלו מחדש.", "playlist"
            )
        out.append(_item_from(row, item) if row.status in (STATUS_READY, STATUS_DELETED) and row.url else item)
    return {**layer, "playlist": out}


def for_devices(db: Session, effective: Dict[str, Any]) -> Tuple[Dict[str, Any], Set[str]]:
    """
    The resolved configuration as a device gets it: each slide of a file the cloud holds, from
    its row (URL, hash); a slide still being processed (no URL) left out; and the URLs of files
    deleted from the server (`onServer: false` in `media`).
    """
    playlist = effective.get("playlist") or []
    rows = _rows_by_id(db, (i.get("mediaId") for i in playlist if isinstance(i, dict)))
    gone: Set[str] = set()
    out = []
    for item in playlist:
        row = rows.get(item.get("mediaId") or "")
        if row is not None and row.status in (STATUS_READY, STATUS_DELETED) and row.url:
            item = _item_from(row, item)
            if row.status == STATUS_DELETED:
                gone.add(row.url)
        if not item.get("url"):
            continue
        out.append(item)
    return {**effective, "playlist": out}, gone


# ── Presence ─────────────────────────────────────────────────────────────────


def clean_report(raw: Any) -> Optional[Tuple[bool, List[str]]]:
    """The heartbeat's `customerDisplayMedia`: (screen, sorted hashes), None when it cannot be read."""
    if not isinstance(raw, dict):
        return None
    held = raw.get("held")
    if not isinstance(held, list):
        return None
    screen = raw.get("screen")
    hashes = {h for h in (CD._sha256(x) for x in held[: HELD_MAX * 4]) if h}
    return (screen if isinstance(screen, bool) else True), sorted(hashes)[:HELD_MAX]


def apply_report(db: Session, machine: Any, raw: Any, now: Optional[datetime] = None) -> bool:
    """A device's report stored (replacing its last). False when there was nothing to read."""
    cleaned = clean_report(raw)
    if cleaned is None:
        return False
    P = _presence_model()
    now = now or _now()
    row = db.get(P, machine.id)
    if row is None:
        row = P(machine_id=machine.id)
        db.add(row)
    elif (row.screen, list(row.held or [])) == cleaned and (now - (_aware(row.reported_at) or now)) < REPORT_REFRESH:
        return True  # the same as a moment ago: no write on every beat
    row.tenant_id = getattr(machine, "tenant_id", None)
    row.screen, row.held = cleaned
    row.reported_at = now
    return True


def presence_of(db: Session, machine_ids: Sequence[Any]) -> Dict[str, Any]:
    P = _presence_model()
    ids = [x if isinstance(x, uuid.UUID) else uuid.UUID(str(x)) for x in machine_ids]
    if not ids:
        return {}
    return {str(r.machine_id): r for r in db.query(P).filter(P.machine_id.in_(ids)).all()}


def _kiosk_ids(db: Session, machine_ids: Sequence[Any]) -> Set[str]:
    try:
        from app.models.kiosk import KioskDevice

        if not machine_ids:
            return set()
        return {
            str(r[0]) for r in db.query(KioskDevice.machine_id)
            .filter(KioskDevice.machine_id.in_(list(machine_ids)), KioskDevice.home_role.is_(None)).all()
        }
    except Exception:  # noqa: BLE001 - no kiosk table (a narrow test world): no kiosks
        db.rollback()
        return set()


def usage(db: Session, machines: Sequence[Any]) -> Dict[str, Dict[str, Any]]:
    """
    Per device that shows the slideshow — an active till or customer display, the customer
    display on (not a kiosk, a KDS or a board; not a till that said `screen: false`) — the files
    of its effective playlist: {machine id: {media id: playlist item}}.
    """
    machines = [m for m in machines if getattr(m, "is_active", True) and getattr(m, "shop_id", None)]
    kiosks = _kiosk_ids(db, [m.id for m in machines])
    presence = presence_of(db, [m.id for m in machines])
    out: Dict[str, Dict[str, Any]] = {}
    for m in machines:
        mid = str(m.id)
        if mid in kiosks:
            continue
        if getattr(m, "is_fiscal", True) is False and not CD.is_display_device(m):
            continue
        report = presence.get(mid)
        if report is not None and report.screen is False:
            continue
        effective, _ = CD.effective_for_machine(db, m)
        if not effective.get("enabled"):
            continue
        files = {i["mediaId"]: i for i in effective.get("playlist") or [] if isinstance(i, dict) and i.get("mediaId")}
        if files:
            out[mid] = files
    return out


def machines_of(db: Session, level: str, entity: Any) -> List[Any]:
    """The devices a layer reaches."""
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop

    q = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if level == "company":
        q = q.filter(POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id == entity.id)))
    elif level == "shop":
        q = q.filter(POSMachine.shop_id == entity.id)
    elif level == "area":
        q = q.filter(POSMachine.area_id == entity.id)
    else:
        return [entity]
    return q.all()


def presence_view(db: Session, level: str, entity: Any, playlist: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """
    `GET /customer-display/media-presence/{level}/{id}`: per file of [playlist] (the layer's
    effective one), its state and on how many of the devices using it it is — and which lack it.
    """
    machines = machines_of(db, level, entity)
    used = usage(db, machines)
    presence = presence_of(db, list(used))
    by_id = {str(m.id): m for m in machines}
    rows = _rows_by_id(db, (i.get("mediaId") for i in playlist if isinstance(i, dict)))
    items = []
    for mid, row in rows.items():
        users = [m for m, files in used.items() if mid in files]
        held, lacking = [], []
        for m in users:
            report = presence.get(m)
            if report is not None and row.sha256 and row.sha256 in (report.held or []):
                held.append(m)
            else:
                machine = by_id.get(m)
                lacking.append({
                    "machineId": m,
                    "name": CD.machine_label(machine) if machine is not None else m,
                    "posNumber": (getattr(machine, "pos_number", None) or None) if machine is not None else None,
                    "reported": report is not None,
                })
        items.append({**view(row), "held": len(held), "total": len(users), "lacking": lacking})
    return {"level": level, "entityId": str(entity.id), "files": items}


# ── Retention ────────────────────────────────────────────────────────────────


def _chain_for(db: Session, level: str, entity: Any) -> List[Tuple[str, Dict[str, Any]]]:
    from app.models.company import Company
    from app.models.shop import Shop

    if level == "machine":
        return CD.chain_for_machine(db, entity)
    if level == "company":
        return [("company", CD.layer_of(entity.settings))]
    shop = entity if level == "shop" else db.get(Shop, entity.shop_id)
    company = db.get(Company, shop.company_id) if shop is not None else None
    chain = [("company", CD.layer_of(getattr(company, "settings", None))), ("shop", CD.layer_of(getattr(shop, "settings", None)))]
    if level == "area":
        chain.append(("area", CD.layer_of(entity.settings)))
    return chain


def retention_allows(
    policy: Any, row: Any, now: datetime, users: Sequence[str], presence: Dict[str, Any]
) -> bool:
    """Whether one layer's `mediaRetention` lets the server delete [row]."""
    rule = CD.retention_of(policy) or (CD.RETENTION_KEEP, None)
    if rule[0] == CD.RETENTION_KEEP:
        return False
    if rule[0] == "days":
        since = _aware(row.ready_at) or _aware(row.created_at)
        return since is not None and now - since >= timedelta(days=rule[1] or 0)
    # until_downloaded: at least one device uses it, and every one of them has it.
    if not users or not row.sha256:
        return False
    return all(presence.get(m) is not None and row.sha256 in (presence[m].held or []) for m in users)


def retention_pass(db: Session, now: Optional[datetime] = None, *, delete: Callable[[Any], None] = delete_file) -> int:
    """The ready files whose every playlist's retention allows it, deleted from the server. How many."""
    from app.models.pos_machine import POSMachine

    M = _model()
    now = now or _now()
    rows = db.query(M).filter(M.status == STATUS_READY).all()
    by_tenant: Dict[str, List[Any]] = {}
    for r in rows:
        by_tenant.setdefault(str(r.tenant_id), []).append(r)
    deleted = 0
    for tenant_id, files in by_tenant.items():
        tenant = files[0].tenant_id
        machines = db.query(POSMachine).filter(POSMachine.tenant_id == tenant, POSMachine.is_active.is_(True)).all()
        used = usage(db, machines)
        presence = presence_of(db, list(used))
        for row in files:
            naming = layers_naming(db, tenant, str(row.id))
            if not naming:
                continue  # no playlist holds it: left alone
            users = [m for m, f in used.items() if str(row.id) in f]
            if not all(
                retention_allows(CD.resolve(_chain_for(db, level, e))[0].get("mediaRetention"), row, now, users, presence)
                for level, e in naming
            ):
                continue
            try:
                delete(row)
            except Exception:  # noqa: BLE001 - tried again next pass
                logger.exception("customer display media %s: delete failed", row.id)
                continue
            row.status = STATUS_DELETED
            row.deleted_at = now
            db.commit()
            notify_layers(db, naming)
            deleted += 1
    return deleted


# ── Missing on a device ("בעיות") ────────────────────────────────────────────


def missing_on_devices(db: Session, machines: Sequence[Any]) -> List[Tuple[Any, List[Any]]]:
    """
    The devices that reported and lack a file the server deleted (`onServer: false`) that their
    playlist holds: (machine, [files]). Nothing to read when no file was ever deleted.
    """
    M = _model()
    tenants = {m.tenant_id for m in machines if getattr(m, "tenant_id", None) is not None}
    if not tenants or not db.query(M.id).filter(M.tenant_id.in_(list(tenants)), M.status == STATUS_DELETED).first():
        return []
    used = usage(db, machines)
    if not used:
        return []
    rows = _rows_by_id(db, {mid for files in used.values() for mid in files})
    presence = presence_of(db, list(used))
    by_id = {str(m.id): m for m in machines}
    out = []
    for mid, files in used.items():
        report = presence.get(mid)
        if report is None:
            continue
        lacking = [
            rows[f] for f in files
            if f in rows and rows[f].status == STATUS_DELETED and rows[f].sha256 not in (report.held or [])
        ]
        if lacking:
            out.append((by_id[mid], lacking))
    return out


# ── The worker ───────────────────────────────────────────────────────────────

INTERVAL_SECONDS = 15.0
RETENTION_EVERY = timedelta(hours=1)
#: pg advisory lock key of the retention pass (any constant shared by every instance).
LOCK_KEY = 0xCD_3E_D1A
ENV_SWITCH = "CUSTOMER_DISPLAY_MEDIA_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_wake = threading.Event()
_last_retention: Optional[datetime] = None


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def wake() -> None:
    """An upload is waiting: the worker of this process looks now rather than at its next tick."""
    _wake.set()


def run_retention_once(session_factory: Callable[[], Session], now: Optional[datetime] = None) -> Optional[int]:
    """One retention pass under the advisory lock (Postgres); None when another instance holds it."""
    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not bool(lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar()):
                return None
        return retention_pass(db, now)
    finally:
        db.close()
        if lock_conn is not None:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("customer display media: unlock failed")
            lock_conn.close()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> bool:
    """Start the worker (once per process). Returns whether it is running."""
    global _thread
    if not enabled():
        return False
    if _thread is not None and _thread.is_alive():
        return True

    def loop() -> None:
        global _last_retention
        while not _stop.is_set():
            _wake.wait(interval)
            _wake.clear()
            if _stop.is_set():
                return
            try:
                run_jobs(session_factory)
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("customer display media jobs failed")
            now = _now()
            if _last_retention is None or now - _last_retention >= RETENTION_EVERY:
                _last_retention = now
                try:
                    run_retention_once(session_factory, now)
                except Exception:  # noqa: BLE001
                    logger.exception("customer display media retention failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="customer-display-media", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
    _wake.set()
