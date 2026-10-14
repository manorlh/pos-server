"""
"מסך לקוח": the slideshow's files (app/services/customer_display_media.py,
P:/specs/customer-display-transitions.md §3א, §5).

Covers the upload's checks, the compression (an image to WebP / JPEG 1920 px; a video through
ffmpeg — faked here — or stored as uploaded with a warning when there is none), the worker's
lease and its write of the URL and hash into every playlist naming the file, what a device gets
(no slide still being processed; `sha256`; `onServer`), the devices' presence reports through the
heartbeat, "קיים ב-X מתוך Y", the retention policy (keep / days:N / until_downloaded, every layer
naming the file), "העלה מחדש" and the "בעיות" item. In-memory SQLite (never the configured DB).
"""
from __future__ import annotations

import hashlib
import io
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from starlette.datastructures import Headers, UploadFile

import app.models  # noqa: F401  (every mapper, so relationships resolve)
from app.database import Base
from app.models.company import Company
from app.models.customer_display import CustomerDisplayMedia
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services import customer_display as CD
from app.services import customer_display_media as CDM


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
_TABLES = (
    "tenants", "companies", "shops", "shop_areas", "pos_machines", "kitchen_print_hosts", "customer_display_states",
    "customer_display_media", "customer_display_media_presence", "kiosk_devices",
)


def png(width=40, height=20, mode="RGB", color=(200, 30, 30)) -> bytes:
    out = io.BytesIO()
    Image.new(mode, (width, height), color).save(out, format="PNG")
    return out.getvalue()


@pytest.fixture
def world():
    engine = create_engine("sqlite://")
    for name in _TABLES:
        Base.metadata.tables[name].create(engine)
    db = sessionmaker(bind=engine)()
    tenant = Tenant(id=uuid.uuid4(), name="T", slug="t", settings={})
    other_tenant = Tenant(id=uuid.uuid4(), name="O", slug="o", settings={})
    db.add_all([tenant, other_tenant])
    db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="חברה", settings={})
    other_company = Company(id=uuid.uuid4(), tenant_id=other_tenant.id, name="אחרת", settings={})
    db.add_all([company, other_company])
    db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="סניף", settings={})
    db.add(shop)
    db.flush()
    area = ShopArea(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, name="בר", settings={})
    db.add(area)
    db.flush()

    def machine(name, *, fiscal=True, number=None):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, distributor_id=uuid.uuid4(), name=name,
            machine_code=f"M-{uuid.uuid4().hex[:8]}", pos_number=number, is_active=True, is_fiscal=fiscal,
            settings={},
        )
        db.add(m)
        db.flush()
        return m

    till = machine("קופה ראשית", number="1")
    till2 = machine("קופה 2", number="2")
    kds = machine("מסך מטבח", fiscal=False)
    screen = machine("מסך לקוח", fiscal=False)
    CD.apply_on_pairing(screen, {CD.MIRROR_KEY: str(till.id)})
    db.commit()
    return SimpleNamespace(db=db, tenant=tenant, other_tenant=other_tenant, company=company, other_company=other_company,
                           shop=shop, area=area, till=till, till2=till2, kds=kds, screen=screen)


class FakeStore:
    """Stands in for Cloudinary / the media store: a URL per file, the bytes kept."""

    def __init__(self):
        self.files = {}

    def __call__(self, data, *, tenant_id, kind, ext):
        pid = f"pos/{tenant_id}/branding/customer-display/{uuid.uuid4().hex}.{ext}"
        self.files[pid] = data
        return f"https://res.cloudinary.com/demo/{kind}/upload/{pid}", "cloudinary", pid


_colors = iter(range(1, 255))


def upload(w, contents=None, ctype="image/png", quality="720p"):
    """A new upload; by default an image of its own (its own hash)."""
    contents = contents or png(color=(next(_colors), 30, 30))
    row = CDM.create(w.db, tenant_id=w.tenant.id, user_id=None, contents=contents, content_type=ctype,
                     video_quality=quality)
    w.db.commit()
    return row


def ready(w, row=None, **kw):
    """An uploaded image, processed (a fake store)."""
    row = row or upload(w)
    store = kw.pop("store", FakeStore())
    CDM.claim(w.db, NOW, only_id=row.id)
    CDM.process(w.db, row.id, now=kw.pop("now", NOW), store=store, notify=False, **kw)
    w.db.refresh(row)
    return row


def slide(row, **extra):
    return {"mediaId": str(row.id), "kind": row.kind, "durationSec": 6, **extra}


def set_layer(entity, layer):
    entity.settings = {**(entity.settings or {}), CD.SETTINGS_KEY: {**CD.layer_of(entity.settings), **layer}}


# ── The upload ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "contents, ctype, code",
    [
        (b"GIF89a", "image/gif", "customer_display_media_type"),
        (b"", "image/png", "customer_display_media_empty"),
        (b"\0" * (CD.MEDIA_MAX_BYTES + 1), "video/mp4", "customer_display_media_too_large"),
        (b"not a png at all", "image/png", "customer_display_media_unreadable"),
    ],
    ids=["type", "empty", "too_large", "unreadable"],
)
def test_an_upload_that_does_not_fit_is_refused_in_hebrew(contents, ctype, code):
    with pytest.raises(CDM.MediaRefused) as err:
        CDM.kind_of_upload(contents, ctype)
    assert err.value.code == code and any("\u0590" <= ch <= "\u05ff" for ch in err.value.message)


def test_an_upload_waits_for_the_worker_with_its_original(world):
    original = png()
    row = upload(world, original, "image/png", quality="1080p")
    assert row.status == "processing" and row.kind == "image" and row.source == original and row.url is None
    view = CDM.view(row)
    assert view["status"] == "processing" and view["url"] is None and view["onServer"] is True
    video = upload(world, b"\0\0\0\x18ftypmp42", "video/mp4", quality="4k")
    assert video.kind == "video" and video.video_quality == "720p"


# ── Compression ──────────────────────────────────────────────────────────────


def test_an_image_is_made_webp_80_at_most_1920_on_its_long_side():
    out = CDM.compress_image(png(4000, 1000), webp=True)
    assert (out.ext, out.content_type, out.width, out.height) == ("webp", "image/webp", 1920, 480)
    assert Image.open(io.BytesIO(out.data)).format == "WEBP"
    # Small: left its size. A transparent one keeps its transparency in WebP.
    small = CDM.compress_image(png(300, 200, mode="RGBA", color=(0, 0, 0, 0)), webp=True)
    assert (small.width, small.height) == (300, 200) and Image.open(io.BytesIO(small.data)).mode == "RGBA"
    # No WebP in this Pillow: JPEG 80, transparency flattened on white.
    jpeg = CDM.compress_image(png(2400, 3000, mode="RGBA", color=(0, 0, 0, 0)), webp=False)
    assert (jpeg.ext, jpeg.width, jpeg.height) == ("jpg", 1536, 1920)
    decoded = Image.open(io.BytesIO(jpeg.data))
    assert decoded.format == "JPEG" and decoded.getpixel((10, 10)) == (255, 255, 255)


def test_a_video_becomes_h264_mp4_without_sound_its_short_side_720_or_1080():
    args = CDM.ffmpeg_args("in.webm", "out.mp4", "720p", exe="/usr/bin/ffmpeg")
    assert args[0] == "/usr/bin/ffmpeg" and args[args.index("-i") + 1] == "in.webm" and args[-1] == "out.mp4"
    for flag, value in (("-c:v", "libx264"), ("-pix_fmt", "yuv420p"), ("-movflags", "+faststart"), ("-profile:v", "main")):
        assert args[args.index(flag) + 1] == value
    assert "-an" in args
    scale = args[args.index("-vf") + 1]
    assert scale == "scale='if(gte(iw,ih),-2,trunc(min(720,iw)/2)*2)':'if(gte(iw,ih),trunc(min(720,ih)/2)*2,-2)'"
    assert "min(1080,ih)" in CDM.ffmpeg_args("a", "b", "1080p")[CDM.ffmpeg_args("a", "b", "1080p").index("-vf") + 1]


def test_a_video_is_compressed_by_ffmpeg_or_kept_as_uploaded_with_a_warning():
    original = b"\0\0\0\x18ftypisom-original"
    # No ffmpeg on this server: stored as uploaded, and said so.
    out, warning = CDM.compress_video(original, "video/mp4", "720p", which=lambda _: None)
    assert (out.data, out.ext, warning) == (original, "mp4", CDM.WARN_FFMPEG_MISSING)

    seen = {}

    def fake_ffmpeg(args, **kw):
        seen["args"], seen["kw"] = args, kw
        with open(args[-1], "wb") as f:
            f.write(b"compressed-mp4")
        with open(args[args.index("-i") + 1], "rb") as f:
            seen["input"] = f.read()
        return SimpleNamespace(returncode=0, stderr=b"")

    out, warning = CDM.compress_video(original, "video/webm", "1080p", which=lambda _: "/bin/ffmpeg", run=fake_ffmpeg)
    assert (out.data, out.ext, out.content_type, warning) == (b"compressed-mp4", "mp4", "video/mp4", None)
    assert seen["input"] == original and seen["args"][0] == "/bin/ffmpeg" and seen["kw"]["timeout"] == CDM.FFMPEG_TIMEOUT_SEC
    assert seen["args"][seen["args"].index("-i") + 1].endswith(".webm")

    def failing(args, **kw):
        return SimpleNamespace(returncode=1, stderr=b"Invalid data found")

    out, warning = CDM.compress_video(original, "video/mp4", "720p", which=lambda _: "ffmpeg", run=failing)
    assert (out.data, warning) == (original, CDM.WARN_COMPRESS_FAILED)

    def slow(args, **kw):
        raise subprocess.TimeoutExpired(args, kw["timeout"])

    assert CDM.compress_video(original, "video/mp4", "720p", which=lambda _: "ffmpeg", run=slow)[1] == CDM.WARN_COMPRESS_FAILED


# ── The worker ───────────────────────────────────────────────────────────────


def test_the_worker_leases_one_file_at_a_time(world):
    row = upload(world)
    assert CDM.claim(world.db, NOW) == row.id
    world.db.refresh(row)
    assert row.attempts == 1 and row.lease_until is not None
    # Leased: no other worker takes it, until the lease ran out.
    assert CDM.claim(world.db, NOW + timedelta(minutes=1)) is None
    assert CDM.claim(world.db, NOW + CDM.LEASE + timedelta(seconds=1)) == row.id


def test_a_processed_file_is_stored_without_its_original_and_written_into_its_playlists(world):
    w = world
    row = upload(w, png(3000, 2000))
    set_layer(w.company, {"enabled": True, "playlist": [slide(row, transition="zoom")]})
    set_layer(w.till, {"playlist": [{"url": "https://x.example/a.png", "kind": "image", "durationSec": 5}, slide(row)]})
    set_layer(w.other_company, {"playlist": [slide(row)]})  # another tenant: never touched
    w.db.commit()
    store = FakeStore()
    with patch.object(CDM, "notify_layers") as notify:
        CDM.claim(w.db, NOW, only_id=row.id)
        CDM.process(w.db, row.id, now=NOW, store=store)
    w.db.refresh(row)
    (pid, data), = store.files.items()
    assert row.status == "ready" and row.source is None and row.public_id == pid and row.storage == "cloudinary"
    assert row.sha256 == hashlib.sha256(data).hexdigest() and row.bytes == len(data)
    assert (row.width, row.height) == (1920, 1280) and row.url.endswith(".webp") and row.warning is None
    company_slide = CD.layer_of(w.company.settings)["playlist"][0]
    assert company_slide == {"mediaId": str(row.id), "kind": "image", "durationSec": 6, "transition": "zoom",
                             "url": row.url, "sha256": row.sha256, "bytes": row.bytes}
    till_list = CD.layer_of(w.till.settings)["playlist"]
    assert till_list[0]["url"] == "https://x.example/a.png" and till_list[1]["url"] == row.url
    assert "url" not in CD.layer_of(w.other_company.settings)["playlist"][0]
    assert w.company.settings_updated_at is not None
    assert {lvl for lvl, _ in notify.call_args.args[1]} == {"company", "machine"}
    # The stored layers still pass the dashboard's checks.
    assert CD.clean_layer(CD.layer_of(w.company.settings), level="company")["playlist"][0]["sha256"] == row.sha256


def test_a_video_without_ffmpeg_is_stored_as_uploaded_with_a_warning(world):
    row = upload(world, b"\0\0\0\x18ftypmp42-raw", "video/mp4")
    row = ready(world, row, which=lambda _: None)
    assert row.status == "ready" and row.warning == "ffmpeg_missing" and row.bytes == len(b"\0\0\0\x18ftypmp42-raw")
    assert CDM.view(row)["warning"] == "ffmpeg_missing"


def test_a_file_that_keeps_failing_is_marked_failed_and_dropped(world):
    row = upload(world)

    def broken(*a, **kw):
        raise RuntimeError("cloudinary down")

    for attempt in range(1, CDM.MAX_ATTEMPTS + 1):
        assert CDM.claim(world.db, NOW + timedelta(hours=attempt)) == row.id
        CDM.process(world.db, row.id, now=NOW, store=broken, notify=False)
        world.db.refresh(row)
        assert row.error == "cloudinary down"
    assert row.status == "failed" and row.source is None
    # A worker that died on every attempt: failed too, once its last lease ran out.
    stuck = upload(world)
    stuck.attempts = CDM.MAX_ATTEMPTS
    stuck.lease_until = NOW - timedelta(minutes=1)
    world.db.commit()
    assert CDM.fail_stuck(world.db, NOW) == 1
    world.db.refresh(stuck)
    assert stuck.status == "failed" and stuck.source is None


# ── The layers and what a device gets ────────────────────────────────────────


def test_a_slide_of_a_file_being_processed_has_no_url_yet():
    mid = str(uuid.uuid4())
    sha = "ab" * 32
    assert CD.clean_playlist_item({"mediaId": mid, "kind": "video", "durationSec": 10}) == {
        "mediaId": mid, "kind": "video", "durationSec": 10,
    }
    assert CD.clean_playlist_item({"mediaId": mid.upper(), "url": "https://x/a.webp", "kind": "image", "sha256": sha.upper()}) == {
        "mediaId": mid, "url": "https://x/a.webp", "kind": "image", "durationSec": 8, "sha256": sha,
    }
    for bad in (
        {"kind": "image"},  # neither a URL nor a file
        {"mediaId": "nope", "url": "https://x/a.webp", "kind": "image"},
        {"mediaId": mid, "url": "http://plain/a.png", "kind": "image"},
        {"mediaId": mid, "kind": "image", "sha256": "xyz"},
    ):
        assert CD.clean_playlist_item(bad) is None, bad
    with pytest.raises(CD.CustomerDisplayError):
        CD.clean_layer({"mediaRetention": "days:0"}, level="shop")
    assert CD.clean_layer({"videoQuality": "1080p", "mediaRetention": "days:30"}, level="shop") == {
        "videoQuality": "1080p", "mediaRetention": "days:30",
    }


@pytest.mark.parametrize("value", ["keep", "until_downloaded", "days:1", "days:365"])
def test_the_retention_values(value):
    assert CD.clean_field("mediaRetention", value) == value


@pytest.mark.parametrize("value", ["days:", "days:366", "days:-1", "days:01", "days:1.5", "forever", 30, None])
def test_a_retention_that_does_not_fit_is_refused(value):
    assert CD.retention_of(value) is None
    with pytest.raises(CD.CustomerDisplayError) as err:
        CD.clean_field("mediaRetention", value)
    assert err.value.field == "mediaRetention"


def test_a_layer_saved_before_its_file_is_ready_and_after(world):
    w = world
    pending = upload(w)
    done = ready(w)
    layer = CD.clean_layer({"playlist": [slide(pending), slide(done)]}, level="shop")
    filled = CDM.fill_layer(w.db, w.tenant.id, layer)
    assert "url" not in filled["playlist"][0]
    assert filled["playlist"][1]["url"] == done.url and filled["playlist"][1]["sha256"] == done.sha256
    # Another tenant's file is no file of this layer; a failed one is refused until removed.
    with pytest.raises(CD.CustomerDisplayError) as err:
        CDM.fill_layer(w.db, w.other_tenant.id, layer)
    assert err.value.message == "פריט 1 במצגת: הקובץ לא נמצא."
    pending.status = "failed"
    w.db.commit()
    with pytest.raises(CD.CustomerDisplayError) as err:
        CDM.fill_layer(w.db, w.tenant.id, layer)
    assert "נכשל" in err.value.message


def test_a_device_gets_only_ready_slides_with_their_hash_and_whether_the_server_has_them(world):
    w = world
    pending = upload(w)
    done = ready(w)
    gone = ready(w)
    gone.status, gone.deleted_at = "deleted", NOW
    set_layer(w.shop, {"enabled": True, "playlist": [slide(pending), slide(done), slide(gone)]})
    w.db.commit()
    payload = CD.device_payload(w.db, w.till)
    assert [s.get("mediaId") for s in payload["config"]["playlist"]] == [str(done.id), str(gone.id)]
    assert payload["config"]["playlist"][0]["sha256"] == done.sha256 and payload["config"]["playlist"][0]["url"] == done.url
    assert [(m["url"], m["sha256"], m["onServer"]) for m in payload["media"]] == [
        (done.url, done.sha256, True), (gone.url, gone.sha256, False),
    ]
    assert payload["config"]["videoQuality"] == "720p" and payload["config"]["mediaRetention"] == "keep"


# ── Presence ─────────────────────────────────────────────────────────────────


def test_a_presence_report_is_cleaned_never_refused():
    sha = "c" * 64
    assert CDM.clean_report({"screen": False, "held": []}) == (False, [])
    assert CDM.clean_report({"held": [sha.upper(), sha, "short", 7, None]}) == (True, [sha])
    many = [f"{i:064x}" for i in range(150)]
    assert len(CDM.clean_report({"held": many})[1]) == CDM.HELD_MAX
    for bad in (None, [], "x", {"screen": True}, {"held": "abc"}):
        assert CDM.clean_report(bad) is None
    # The heartbeat's body takes it as it comes; an unreadable one is dropped, never a 422.
    from app.schemas.pos_machine import MachineHeartbeatBody

    body = MachineHeartbeatBody.model_validate({"customerDisplayMedia": {"screen": True, "held": [sha]}})
    assert body.customer_display_media == {"screen": True, "held": [sha]}
    assert MachineHeartbeatBody.model_validate({"customerDisplayMedia": ["x"]}).customer_display_media is None


def test_a_report_replaces_the_last_and_the_same_one_is_not_written_on_every_beat(world):
    from app.models.customer_display import CustomerDisplayMediaPresence as P

    w = world
    a, b = "a" * 64, "b" * 64
    assert CDM.apply_report(w.db, w.till, {"held": [a]}, NOW)
    w.db.commit()
    assert CDM.apply_report(w.db, w.till, {"held": [a]}, NOW + timedelta(minutes=1))
    w.db.commit()
    row = w.db.get(P, w.till.id)
    assert row.held == [a] and CDM._aware(row.reported_at) == NOW
    CDM.apply_report(w.db, w.till, {"held": [a]}, NOW + CDM.REPORT_REFRESH + timedelta(seconds=1))
    w.db.commit()
    assert CDM._aware(w.db.get(P, w.till.id).reported_at) == NOW + CDM.REPORT_REFRESH + timedelta(seconds=1)
    CDM.apply_report(w.db, w.till, {"screen": True, "held": [b]}, NOW + CDM.REPORT_REFRESH + timedelta(minutes=1))
    w.db.commit()
    assert w.db.get(P, w.till.id).held == [b]
    assert CDM.apply_report(w.db, w.till, "garbage", NOW) is False


def test_x_of_y_devices_and_who_lacks_a_file(world):
    w = world
    a, b = ready(w), ready(w)
    set_layer(w.shop, {"enabled": True, "playlist": [slide(a), slide(b)]})
    set_layer(w.kds, {"enabled": True})  # a kitchen screen: never a customer display
    w.db.commit()
    assert CDM.apply_report(w.db, w.till, {"screen": True, "held": [a.sha256, b.sha256]}, NOW)
    assert CDM.apply_report(w.db, w.screen, {"screen": True, "held": [a.sha256]}, NOW)
    w.db.commit()
    files = {f["id"]: f for f in CDM.presence_view(w.db, "shop", w.shop, CD.layer_of(w.shop.settings)["playlist"])["files"]}
    # The till, its paired screen and till 2 (never reported) use them; the KDS does not.
    assert (files[str(a.id)]["held"], files[str(a.id)]["total"]) == (2, 3)
    assert (files[str(b.id)]["held"], files[str(b.id)]["total"]) == (1, 3)
    lacking = {x["machineId"]: x for x in files[str(b.id)]["lacking"]}
    assert set(lacking) == {str(w.screen.id), str(w.till2.id)}
    assert lacking[str(w.screen.id)]["reported"] is True and lacking[str(w.till2.id)]["reported"] is False
    assert lacking[str(w.till2.id)]["name"] == "קופה 2 · קופה 2"
    # A till that shows no customer screen says so, and is no longer counted.
    CDM.apply_report(w.db, w.till2, {"screen": False, "held": []}, NOW)
    w.db.commit()
    files = {f["id"]: f for f in CDM.presence_view(w.db, "shop", w.shop, CD.layer_of(w.shop.settings)["playlist"])["files"]}
    assert files[str(a.id)]["total"] == 2
    # The screen switched off at a level: not counted either.
    set_layer(w.screen, {"enabled": False})
    w.db.commit()
    assert CDM.presence_view(w.db, "machine", w.screen, [slide(a)])["files"][0]["total"] == 0


# ── Retention ────────────────────────────────────────────────────────────────


def _retain(w, now, deleted=None):
    deleted = [] if deleted is None else deleted
    with patch.object(CDM, "notify_layers"):
        n = CDM.retention_pass(w.db, now, delete=deleted.append)
    return n, deleted


def test_keep_never_deletes_and_a_file_no_playlist_holds_is_left_alone(world):
    w = world
    kept, loose = ready(w), ready(w)
    set_layer(w.shop, {"enabled": True, "playlist": [slide(kept)]})
    w.db.commit()
    assert _retain(w, NOW + timedelta(days=999))[0] == 0
    set_layer(w.company, {"mediaRetention": "days:1"})
    w.db.commit()
    n, deleted = _retain(w, NOW + timedelta(days=2))
    assert n == 1 and deleted == [kept]  # `loose` is in no playlist
    w.db.refresh(kept)
    w.db.refresh(loose)
    assert kept.status == "deleted" and kept.deleted_at is not None and loose.status == "ready"


def test_days_n_counts_from_when_the_file_was_ready(world):
    w = world
    row = ready(w, now=NOW)
    set_layer(w.shop, {"enabled": True, "mediaRetention": "days:7", "playlist": [slide(row)]})
    w.db.commit()
    assert _retain(w, NOW + timedelta(days=6, hours=23))[0] == 0
    assert _retain(w, NOW + timedelta(days=7))[0] == 1


def test_until_downloaded_waits_for_every_device_using_it(world):
    w = world
    row = ready(w)
    set_layer(w.shop, {"enabled": True, "mediaRetention": "until_downloaded", "playlist": [slide(row)]})
    w.db.commit()
    later = NOW + timedelta(hours=1)
    assert _retain(w, later)[0] == 0  # nobody reported
    CDM.apply_report(w.db, w.till, {"held": [row.sha256]}, NOW)
    CDM.apply_report(w.db, w.screen, {"held": [row.sha256]}, NOW)
    w.db.commit()
    assert _retain(w, later)[0] == 0  # till 2 has not confirmed
    CDM.apply_report(w.db, w.till2, {"screen": False, "held": []}, NOW)  # no customer screen there
    w.db.commit()
    n, deleted = _retain(w, later)
    assert n == 1 and deleted == [row]
    payload = CD.device_payload(w.db, w.screen)
    assert payload["media"][0]["onServer"] is False and payload["config"]["playlist"][0]["url"] == row.url


def test_every_layer_holding_a_file_must_allow_its_deletion(world):
    w = world
    row = ready(w)
    set_layer(w.company, {"enabled": True, "mediaRetention": "days:1", "playlist": [slide(row)]})
    set_layer(w.area, {"mediaRetention": "keep", "playlist": [slide(row)]})
    w.db.commit()
    assert _retain(w, NOW + timedelta(days=3))[0] == 0
    set_layer(w.area, {"mediaRetention": "days:2"})
    w.db.commit()
    assert _retain(w, NOW + timedelta(days=3))[0] == 1


def test_a_deleted_file_lacking_on_a_device_is_reuploaded_and_flagged_meanwhile(world):
    w = world
    row = ready(w)
    set_layer(w.shop, {"enabled": True, "mediaRetention": "days:1", "playlist": [slide(row)]})
    w.db.commit()
    CDM.apply_report(w.db, w.till, {"held": [row.sha256]}, NOW)
    CDM.apply_report(w.db, w.screen, {"held": []}, NOW)  # a new screen, paired after
    w.db.commit()
    assert CDM.missing_on_devices(w.db, [w.till, w.till2, w.screen]) == []  # nothing deleted yet
    _retain(w, NOW + timedelta(days=2))
    missing = CDM.missing_on_devices(w.db, [w.till, w.till2, w.screen])
    # Only the device that reported and lacks it (till 2 never reported: unknown, not flagged).
    assert [(m.id, [f.id for f in files]) for m, files in missing] == [(w.screen.id, [row.id])]
    files = CDM.presence_view(w.db, "shop", w.shop, CD.layer_of(w.shop.settings)["playlist"])["files"]
    assert files[0]["onServer"] is False and {x["machineId"] for x in files[0]["lacking"] if x["reported"]} == {str(w.screen.id)}

    # "העלה מחדש": the file again; its playlists get the new URL, the devices download it.
    old_url = row.url
    CDM.restart(w.db, row, contents=png(64, 64, color=(1, 2, 3)), content_type="image/png", video_quality="720p")
    w.db.commit()
    assert row.status == "processing"
    ready(w, row)
    assert row.status == "ready" and row.url != old_url and row.deleted_at is None
    assert CD.layer_of(w.shop.settings)["playlist"][0]["url"] == row.url
    assert CD.device_payload(w.db, w.screen)["media"][0]["onServer"] is True
    with pytest.raises(CDM.MediaRefused) as err:
        CDM.restart(w.db, row, contents=png(), content_type="image/png", video_quality="720p")
    assert err.value.status == 409


def test_the_problems_screen_lists_a_device_lacking_a_deleted_file(world):
    from app.services import problems as P

    w = world
    a, b = ready(w), ready(w)
    for r in (a, b):
        r.status, r.deleted_at = "deleted", NOW
    set_layer(w.shop, {"enabled": True, "playlist": [slide(a), slide(b)]})
    CDM.apply_report(w.db, w.screen, {"held": [a.sha256]}, NOW)
    CDM.apply_report(w.db, w.till, {"held": []}, NOW)
    w.db.commit()
    items = {i.machine_id: i for i, _topic in P._customer_display_media_items(w.db, [w.till, w.till2, w.screen, w.kds])}
    assert set(items) == {w.till.id, w.screen.id}
    assert items[w.till.id].title == "2 קובצי מצגת חסרים במסך הלקוח" and items[w.screen.id].title == "קובץ מצגת חסר במסך הלקוח"
    item = items[w.screen.id]
    assert (item.kind, item.group, item.severity) == ("customer_display_media_missing", "devices", "low")
    assert item.link == f"/dashboard/customer-display?scopeType=machine&scopeId={w.screen.id}"


# ── The routes ───────────────────────────────────────────────────────────────


def _file(data: bytes, ctype: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename="upload", headers=Headers({"content-type": ctype}))


def test_the_dashboard_uploads_polls_saves_and_reads_presence(world):
    from app.routers import customer_display as R

    w = world
    user = SimpleNamespace(id=None)
    parents = [("company", w.company)]
    set_layer(w.shop, {"videoQuality": "1080p"})
    w.db.commit()
    with patch.object(R, "_entity_and_parents", return_value=(w.shop, parents)), patch.object(CDM, "wake") as wake:
        made = R.upload_media(level="shop", entity_id=str(w.shop.id), video_quality=None, file=_file(b"\0\0\0\x18ftypmp42", "video/mp4"),
                              current_user=user, active_tenant_id=w.tenant.id, db=w.db)
        wake.assert_called_once()
        with pytest.raises(HTTPException) as err:
            R.upload_media(level="shop", entity_id=str(w.shop.id), video_quality=None, file=_file(b"x", "text/plain"),
                           current_user=user, active_tenant_id=w.tenant.id, db=w.db)
        assert err.value.status_code == 415 and err.value.detail["code"] == "customer_display_media_type"
    assert made["status"] == "processing" and made["kind"] == "video" and made["videoQuality"] == "1080p"
    listed = R.list_media(ids=f"{made['id']},junk", current_user=user, active_tenant_id=w.tenant.id, db=w.db)
    assert [f["id"] for f in listed["files"]] == [made["id"]]
    assert R.list_media(ids=made["id"], current_user=user, active_tenant_id=w.other_tenant.id, db=w.db) == {"files": []}

    # Saved while still processing: kept with no URL; a device sees nothing of it yet.
    with patch.object(R, "_entity_and_parents", return_value=(w.shop, parents)), patch.object(R, "_notify"):
        view = R.put_layer(level="shop", entity_id=str(w.shop.id),
                           body={"settings": {"enabled": True, "playlist": [{"mediaId": made["id"], "kind": "video", "durationSec": 9}]}},
                           current_user=user, active_tenant_id=w.tenant.id, db=w.db)
    assert view["own"]["playlist"] == [{"mediaId": made["id"], "kind": "video", "durationSec": 9}]
    assert CD.device_payload(w.db, w.till)["config"]["playlist"] == []
    with patch.object(CDM, "notify_layers"):
        CDM.claim(w.db, NOW)
        CDM.process(w.db, uuid.UUID(made["id"]), now=NOW, store=FakeStore(), which=lambda _: None)
    assert CD.device_payload(w.db, w.till)["config"]["playlist"][0]["url"].endswith(".mp4")

    with patch.object(R, "_entity_and_parents", return_value=(w.shop, parents)):
        presence = R.media_presence(level="shop", entity_id=str(w.shop.id), current_user=user, active_tenant_id=w.tenant.id, db=w.db)
        with pytest.raises(HTTPException) as err:
            R.reupload_media(media_id=made["id"], level="shop", entity_id=str(w.shop.id), video_quality=None,
                             file=_file(png(), "image/png"), current_user=user, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 409
    (entry,) = presence["files"]
    assert entry["id"] == made["id"] and entry["status"] == "ready" and entry["total"] == 3 and entry["held"] == 0


def test_the_media_routes_are_mounted_and_guarded():
    from app.main import app
    from app.services.dashboard_sections import rule_for

    paths = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set())}
    for method, path in [
        ("POST", "/api/v1/customer-display/media"),
        ("GET", "/api/v1/customer-display/media"),
        ("POST", "/api/v1/customer-display/media/{media_id}/reupload"),
        ("GET", "/api/v1/customer-display/media-presence/{level}/{entity_id}"),
    ]:
        assert (method, path) in paths, path
    for method, path in (("POST", "/customer-display/media"), ("POST", "/customer-display/media/{}/reupload"),
                         ("GET", "/customer-display/media-presence/{}/{}")):
        rule = rule_for(method, path)
        assert rule.kind == "section" and set(rule.sections) == {"till_settings", "devices"}, path
