"""Release files in shared storage (app/services/release_storage.py).

The API runs on two Fly machines whose disks every deploy wipes, so release files (APKs, Windows
installers, kiosk web bundles) go to an S3-compatible bucket. Here the bucket is an in-memory fake
behind httpx.MockTransport that checks what S3 checks (a signed request, the payload SHA-256).

Covers: the Signature V4 signer (AWS's own example), upload into the bucket, the device download
streamed through the API with Range, a release whose file is in no storage (never offered, never a
500, "fileAvailable": false, 409 on assign) and "העלאה מחדש" (same SHA-256 only), the file delete
in the bucket, and the local-disk fallback when no bucket is configured.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import re
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.config import get_settings
from app.models.app_release import AppRelease
from app.routers import app_release_files as RF
from app.routers import app_releases as R
from app.routers.sync import get_app_update, get_app_update_apk
from app.schemas.app_release import AppReleaseAssignmentIn
from app.services import release_storage as RS
from test_app_releases import _admin, _apk, _assign, world  # noqa: F401  (fixture)

ENDPOINT = "https://s3.test"
BUCKET = "pos-releases"


# ── Signature V4 ─────────────────────────────────────────────────────────────


def test_the_signer_matches_the_aws_example():
    # "Example: GET Object" in the AWS S3 Signature V4 documentation (header-based auth).
    headers = RS.sign_v4(
        "GET",
        "https://examplebucket.s3.amazonaws.com/test.txt",
        {"Range": "bytes=0-9"},
        access_key_id="AKIAIOSFODNN7EXAMPLE",
        secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region="us-east-1",
        payload_sha256=hashlib.sha256(b"").hexdigest(),
        now=datetime(2013, 5, 24, tzinfo=timezone.utc),
    )
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )


# ── A fake bucket ────────────────────────────────────────────────────────────


class FakeBucket:
    def __init__(self):
        self.objects: dict = {}
        self.calls: list = []
        self.fail = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        parts = urlsplit(str(request.url))
        assert parts.scheme + "://" + parts.netloc == ENDPOINT
        path = unquote(parts.path)
        bucket, _, key = path.lstrip("/").partition("/")
        self.calls.append((request.method, key))
        assert bucket == BUCKET
        assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=KEYID/")
        if self.fail:
            return httpx.Response(500)
        if request.method == "PUT":
            body = request.read()
            if hashlib.sha256(body).hexdigest() != request.headers["x-amz-content-sha256"]:
                return httpx.Response(400, text="XAmzContentSHA256Mismatch")
            self.objects[key] = body
            return httpx.Response(200)
        if request.method == "GET" and not key:
            prefix = parse_qs(parts.query).get("prefix", [""])[0]
            keys = "".join(f"<Contents><Key>{k}</Key></Contents>" for k in self.objects if k.startswith(prefix))
            xml = (
                '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<IsTruncated>false</IsTruncated>{keys}</ListBucketResult>"
            )
            return httpx.Response(200, content=xml.encode())
        if key not in self.objects:
            return httpx.Response(404)
        data = self.objects[key]
        if request.method == "DELETE":
            del self.objects[key]
            return httpx.Response(204)
        headers = {"content-length": str(len(data)), "etag": '"e"'}
        if request.method == "HEAD":
            return httpx.Response(200, headers=headers)
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", request.headers.get("range", ""))
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else len(data) - 1
            if start >= len(data):
                return httpx.Response(416, headers={"content-range": f"bytes */{len(data)}"})
            part = data[start : end + 1]
            return httpx.Response(
                206,
                content=part,
                headers={"content-length": str(len(part)), "content-range": f"bytes {start}-{end}/{len(data)}"},
            )
        return httpx.Response(200, content=data, headers=headers)


def _no_tigris_env(monkeypatch):
    for name in ("BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def bucket(world, monkeypatch):  # noqa: F811
    _no_tigris_env(monkeypatch)
    s = get_settings()
    monkeypatch.setattr(s, "release_storage_bucket", BUCKET)
    monkeypatch.setattr(s, "release_storage_endpoint", ENDPOINT)
    monkeypatch.setattr(s, "release_storage_access_key_id", "KEYID")
    monkeypatch.setattr(s, "release_storage_secret_access_key", "SECRET")
    monkeypatch.setattr(s, "release_storage_region", "auto")
    monkeypatch.setattr(s, "release_storage_prefix", "app-releases/")
    fake = FakeBucket()
    RS.set_http_client(httpx.Client(transport=httpx.MockTransport(fake)))
    yield fake
    RS.set_http_client(None)


@pytest.fixture
def local(world, monkeypatch):  # noqa: F811
    _no_tigris_env(monkeypatch)
    monkeypatch.setattr(get_settings(), "release_storage_bucket", "")
    RS.clear_cache()
    yield
    RS.clear_cache()


def _upload(world, data, filename="till.apk"):  # noqa: F811
    return R.upload_app_release(
        file=UploadFile(file=io.BytesIO(data), filename=filename),
        version_name=None, version_code=None, notes=None, admin=_admin(), db=world.db, platform=None,
    )


def _reupload(world, release_id, data, filename="till.apk"):  # noqa: F811
    return R.reupload_app_release_file(
        release_id=release_id, background_tasks=BackgroundTasks(),
        file=UploadFile(file=io.BytesIO(data), filename=filename), _admin=_admin(), db=world.db,
    )


def _offer(world, till, code=1, name="0.0.1"):  # noqa: F811
    return get_app_update(machine_id=str(till.id), version_code=code, version_name=name, machine=till, db=world.db,
                          platform=None)


def _download(world, release, range_header=None, method="GET"):  # noqa: F811
    till = world.tills[0]
    headers = {"range": range_header} if range_header else {}
    request = SimpleNamespace(method=method, headers=headers)
    return get_app_update_apk(machine_id=str(till.id), release_id=release.id, machine=till, db=world.db,
                              request=request)


def _body(resp) -> bytes:
    async def collect():
        out = b""
        async for chunk in resp.body_iterator:
            out += chunk if isinstance(chunk, bytes) else chunk.encode()
        return out

    return asyncio.run(collect())


# ── The bucket ───────────────────────────────────────────────────────────────


def test_an_upload_goes_to_the_bucket_not_the_machine_disk(world, bucket):  # noqa: F811
    data = _apk(42, "1.4.2")
    out = _upload(world, data)
    row = world.db.query(AppRelease).one()
    assert row.file_path == f"s3://{BUCKET}/app-releases/{row.id}.apk"
    assert bucket.objects[f"app-releases/{row.id}.apk"] == data
    assert out.file_available is True and out.file_storage == "s3"
    # Nothing left on this machine's disk (no final file, no .part).
    releases_dir = world.tmp / "releases"
    assert not releases_dir.exists() or list(releases_dir.iterdir()) == []
    assert RS.storage_status()["shared"] is True


def test_devices_download_through_the_api_with_range(world, bucket):  # noqa: F811
    data = _apk(42, "1.4.2")
    _upload(world, data)
    row = world.db.query(AppRelease).one()
    _assign(world, row, "shop", world.shop.id)
    assert _offer(world, world.tills[0]).available is True

    whole = _download(world, row)
    assert isinstance(whole, StreamingResponse) and whole.status_code == 200
    assert whole.media_type == "application/vnd.android.package-archive"
    assert whole.headers["content-length"] == str(len(data))
    assert whole.headers["accept-ranges"] == "bytes"
    assert 'filename="app-1.4.2.apk"' in whole.headers["content-disposition"]
    assert hashlib.sha256(_body(whole)).hexdigest() == row.sha256

    # A resumed download: the rest of the file from byte 10.
    part = _download(world, row, "bytes=10-")
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 10-{len(data) - 1}/{len(data)}"
    assert _body(part) == data[10:]

    head = _download(world, row, method="HEAD")
    assert head.status_code == 200 and head.headers["content-length"] == str(len(data))


def test_a_bucket_outage_is_a_503_not_a_500(world, bucket):  # noqa: F811
    _upload(world, _apk(42, "1.4.2"))
    row = world.db.query(AppRelease).one()
    _assign(world, row, "shop", world.shop.id)
    bucket.fail = True
    with pytest.raises(HTTPException) as exc:
        _download(world, row)
    assert exc.value.status_code == 503


def test_an_object_gone_from_the_bucket_is_not_offered_and_can_be_uploaded_again(world, bucket):  # noqa: F811
    data = _apk(42, "1.4.2")
    _upload(world, data)
    row = world.db.query(AppRelease).one()
    _assign(world, row, "shop", world.shop.id)
    bucket.objects.clear()
    RS.clear_cache()
    assert _offer(world, world.tills[0]).available is False
    listed = {r.id: r for r in R.list_app_releases(_admin=_admin(), db=world.db, platform=None)}
    assert listed[row.id].file_available is False

    again = _reupload(world, row.id, data)
    assert again.file_available is True
    assert bucket.objects[f"app-releases/{row.id}.apk"] == data
    assert _offer(world, world.tills[0]).available is True


def test_deleting_the_file_removes_the_object(world, bucket):  # noqa: F811
    _upload(world, _apk(41, "1.4.1"))
    old = world.db.query(AppRelease).one()
    _upload(world, _apk(42, "1.4.2"))
    out = RF.delete_app_release_file(release_id=old.id, admin=_admin(), db=world.db, retire=True)
    assert out.storage_result == "deleted"
    assert f"app-releases/{old.id}.apk" not in bucket.objects
    assert len(bucket.objects) == 1


def test_tigris_names_configure_the_bucket(monkeypatch):
    # `fly storage create` sets these on the app; nothing else is needed.
    monkeypatch.setattr(get_settings(), "release_storage_bucket", "")
    monkeypatch.setattr(get_settings(), "release_storage_access_key_id", "")
    monkeypatch.setattr(get_settings(), "release_storage_secret_access_key", "")
    monkeypatch.setattr(get_settings(), "release_storage_endpoint", "")
    monkeypatch.setattr(get_settings(), "release_storage_region", "")
    monkeypatch.setenv("BUCKET_NAME", "tigris-bucket")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "tid_x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "tsec_x")
    monkeypatch.setenv("AWS_ENDPOINT_URL_S3", "https://fly.storage.tigris.dev")
    monkeypatch.setenv("AWS_REGION", "auto")
    cfg = RS.s3_config()
    assert cfg is not None
    assert (cfg.bucket, cfg.endpoint, cfg.region, cfg.prefix) == (
        "tigris-bucket", "https://fly.storage.tigris.dev", "auto", "app-releases/"
    )
    assert RS._object_url(cfg, cfg.bucket, "app-releases/x.apk") == "https://fly.storage.tigris.dev/tigris-bucket/app-releases/x.apk"


# ── Local disk (no bucket) ───────────────────────────────────────────────────


def test_without_a_bucket_files_stay_on_local_disk(world, local, monkeypatch):  # noqa: F811
    data = _apk(42, "1.4.2")
    out = _upload(world, data)
    row = world.db.query(AppRelease).one()
    assert out.file_storage == "local" and out.file_available is True
    assert open(row.file_path, "rb").read() == data
    _assign(world, row, "shop", world.shop.id)
    assert isinstance(_download(world, row), FileResponse)
    assert RS.storage_status() == {"backend": "local", "shared": False, "ephemeral": False}
    monkeypatch.setenv("FLY_APP_NAME", "pos-cloud-api")
    assert RS.storage_status()["ephemeral"] is True


def test_a_release_whose_file_is_nowhere_is_never_offered_nor_a_500(world, local):  # noqa: F811
    data = _apk(42, "1.4.2")
    _upload(world, data)
    row = world.db.query(AppRelease).one()
    _assign(world, row, "shop", world.shop.id)
    assert _offer(world, world.tills[0]).available is True

    # The machine that kept it was redeployed.
    import os

    os.remove(row.file_path)
    assert _offer(world, world.tills[0]).available is False
    with pytest.raises(HTTPException) as exc:
        _download(world, row)
    assert exc.value.status_code == 404
    listed = {r.id: r for r in R.list_app_releases(_admin=_admin(), db=world.db, platform=None)}
    assert listed[row.id].file_available is False and listed[row.id].file_deleted_at is None
    with pytest.raises(HTTPException) as exc:
        R.create_app_release_assignment(
            release_id=row.id,
            body=AppReleaseAssignmentIn(level="machine", target_id=world.tills[0].id),
            background_tasks=BackgroundTasks(), admin=_admin(), db=world.db,
        )
    assert (exc.value.status_code, exc.value.detail) == (409, "app_release_file_missing")

    # "העלאה מחדש": another build is refused, the same one restores it.
    with pytest.raises(HTTPException) as exc:
        _reupload(world, row.id, _apk(43, "1.4.3"))
    assert exc.value.status_code == 422 and exc.value.detail["code"] == "app_release_sha_mismatch"
    out = _reupload(world, row.id, data)
    assert out.file_available is True
    assert _offer(world, world.tills[0]).available is True
    assert hashlib.sha256(open(world.db.query(AppRelease).one().file_path, "rb").read()).hexdigest() == row.sha256


def test_a_deleted_file_is_not_uploaded_again(world, local):  # noqa: F811
    _upload(world, _apk(41, "1.4.1"))
    old = world.db.query(AppRelease).one()
    _upload(world, _apk(42, "1.4.2"))
    RF.delete_app_release_file(release_id=old.id, admin=_admin(), db=world.db, retire=True)
    with pytest.raises(HTTPException) as exc:
        _reupload(world, old.id, _apk(41, "1.4.1"))
    assert (exc.value.status_code, exc.value.detail) == (409, "app_release_file_deleted")


def test_an_unknown_release_is_404(world, local):  # noqa: F811
    with pytest.raises(HTTPException) as exc:
        _reupload(world, uuid.uuid4(), _apk(41, "1.4.1"))
    assert exc.value.status_code == 404
