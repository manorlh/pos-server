"""Kiosk web bundles: the kiosk's screens as a zip, released through the app-releases system.

Covers the upload (version, versionCode and bridgeApi from the bundle's manifest; every
refusal of a bad bundle as `422 invalid_bundle`; a typed version that disagrees), the offer
with `?platform=kiosk_web` (bridgeApi, machine over shop) and its independence from the
Android APK's offer, the download's media type, rollback allowed for bundles and still
refused for Android, the kiosk's `POST /sync/{id}/kiosk-web/status`, the rollout's
"kiosk_web" rows, and the kiosk config switch `general.renderer`.

The handlers run against the in-memory SQLite world of tests/shift_world.py, called
directly (as tests/test_app_releases.py does); HTTP only for the request validation.
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError

from app.config import get_settings
from app.models.app_release import AppRelease, AppReleaseAssignment, AppReleaseMachineStatus
from app.models.kiosk import KioskDevice
from app.models.kiosk_web import KioskWebDeviceStatus
from app.models.user import User, UserRole
from app.routers import app_releases as R
from app.routers.kiosk_web import post_kiosk_web_status
from app.routers.sync import get_app_update, get_app_update_apk, post_app_update_status
from app.schemas.app_release import AppReleaseAssignmentIn, AppUpdateStatusIn
from app.schemas.kiosk_web import KioskWebStatusIn
from app.services import app_updates as AU
from app.services import kiosk_config as C
from app.services import kiosk_web_bundle as B
from shift_world import make_world


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_FILES = {
    "index.html": b"<!doctype html><html><body><div id=root></div></body></html>",
    "assets/index-abc.js": b"console.log('kiosk');",
    "assets/index-abc.css": b"body{margin:0}",
}


def _manifest(files=None, **overrides):
    files = _FILES if files is None else files
    m = {
        "kind": "r2m-kiosk-web",
        "version": "2026.10.07-1530",
        "versionCode": 913530,
        "bridgeApi": 1,
        "entry": "index.html",
        "builtAt": "2026-10-07T15:30:12.000Z",
        "files": [{"path": p, "sha256": _sha(d), "size": len(d)} for p, d in files.items()],
    }
    m.update(overrides)
    return m


def _bundle(files=None, manifest=None, extra=None, with_manifest=True, **overrides) -> bytes:
    """A zip: manifest.json (built from `files` unless given) + the files (+ `extra` entries)."""
    files = _FILES if files is None else files
    m = manifest if manifest is not None else _manifest(files, **overrides)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        if with_manifest:
            z.writestr("manifest.json", m if isinstance(m, (bytes, str)) else json.dumps(m))
        for path, data in files.items():
            z.writestr(path, data)
        for path, data in (extra or {}).items():
            z.writestr(path, data)
    return buf.getvalue()


# ── The world ────────────────────────────────────────────────────────────────


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = make_world()
    w.tmp = tmp_path
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    monkeypatch.setattr(AU, "publish_settings_notify", lambda tenant_id, machine_id, reason: None)
    return w


def _make_kiosk(world, till, enabled=True):
    world.db.add(KioskDevice(
        machine_id=till.id, tenant_id=world.tenant.id, shop_id=till.shop_id, name=till.name, enabled=enabled,
    ))
    world.db.commit()


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)


def _upload(world, data, filename="kiosk-web.zip", platform="kiosk_web", **form):
    return R.upload_app_release(
        file=UploadFile(file=io.BytesIO(data), filename=filename),
        version_name=form.get("version_name"),
        version_code=form.get("version_code"),
        notes=form.get("notes"),
        admin=_admin(),
        db=world.db,
        platform=platform,
    )


def _web_release(world, name, code, bridge_api=1, minutes=0, active=True):
    data = _bundle(version=name, versionCode=code, bridgeApi=bridge_api)
    path = world.tmp / f"web-{name}.zip"
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(), platform="kiosk_web", version_code=code, version_name=name,
        sha256=_sha(data), size_bytes=len(data), file_path=str(path), bridge_api=bridge_api,
        is_active=active, created_at=_ts(minutes),
    )
    world.db.add(r)
    world.db.commit()
    return r


def _apk_release(world, code, name):
    path = world.tmp / f"{name}.apk"
    path.write_bytes(b"PK-not-really")
    r = AppRelease(
        id=uuid.uuid4(), platform="android", version_code=code, version_name=name, sha256="0" * 64,
        size_bytes=13, file_path=str(path), is_active=True, created_at=_ts(),
    )
    world.db.add(r)
    world.db.commit()
    return r


def _assign(world, release, level, target_id, minutes=0, **extra):
    a = AppReleaseAssignment(
        id=uuid.uuid4(), release_id=release.id, level=level, target_id=target_id, tenant_id=world.tenant.id,
        auto_install=extra.pop("auto_install", False), created_at=_ts(minutes), **extra,
    )
    world.db.add(a)
    world.db.commit()
    return a


def _offer(world, till, code=1, name="0.0.1", platform="kiosk_web"):
    return get_app_update(
        machine_id=str(till.id), version_code=code, version_name=name, machine=till, db=world.db, platform=platform,
    )


def _status(world, till, **body):
    return post_kiosk_web_status(
        machine_id=str(till.id), body=KioskWebStatusIn(**body), machine=till, db=world.db,
    )


# ── Upload ───────────────────────────────────────────────────────────────────


def test_a_bundle_upload_takes_its_version_code_and_bridge_api_from_the_manifest(world):
    data = _bundle(bridgeApi=2, minChrome=111, somethingNew={"x": 1})  # unknown keys are ignored
    out = _upload(world, data, notes=" new attract screen ")
    assert (out.platform, out.version_name, out.version_code, out.bridge_api) == (
        "kiosk_web", "2026.10.07-1530", 913530, 2,
    )
    assert out.sha256 == _sha(data) and out.size_bytes == len(data) and out.notes == "new attract screen"
    body = out.model_dump(by_alias=True)
    assert body["bridgeApi"] == 2
    stored = world.db.query(AppRelease).one()
    assert (stored.platform, stored.bridge_api) == ("kiosk_web", 2)
    assert [p.name for p in (world.tmp / "releases").iterdir()] == [f"{stored.id}.zip"]
    with open(stored.file_path, "rb") as f:
        assert f.read() == data
    # The same typed version is fine; the list by platform shows it with its bridgeApi.
    listed = R.list_app_releases(_admin=_admin(), db=world.db, platform="kiosk_web")
    assert [(r.version_name, r.bridge_api) for r in listed] == [("2026.10.07-1530", 2)]


def test_android_and_windows_releases_have_no_bridge_api(world):
    rel = _apk_release(world, 10, "1.0")
    assert R._out(rel).model_dump(by_alias=True)["bridgeApi"] is None


def test_a_typed_version_that_agrees_is_accepted_one_that_disagrees_is_refused(world):
    out = _upload(world, _bundle(), version_name="2026.10.07-1530", version_code=913530)
    assert out.version_code == 913530
    for form in ({"version_name": "2026.10.07-1600"}, {"version_code": 1}):
        with pytest.raises(HTTPException) as exc:
            _upload(world, _bundle(version="2026.10.08-0900", versionCode=920900), **form)
        assert exc.value.status_code == 422 and exc.value.detail["code"] == "bundle_version_mismatch"
    assert len(list((world.tmp / "releases").iterdir())) == 1


def _refusal(world, data) -> str:
    with pytest.raises(HTTPException) as exc:
        _upload(world, data)
    assert exc.value.status_code == 422, exc.value.detail
    assert exc.value.detail["code"] == "invalid_bundle", exc.value.detail
    assert isinstance(exc.value.detail["msg"], str) and exc.value.detail["msg"]
    return exc.value.detail["msg"]


def test_bundle_refusals(world):
    good = _manifest()
    tampered = dict(_FILES, **{"assets/index-abc.js": b"console.log('KIOSK');"})  # same size
    assert len(tampered["assets/index-abc.js"]) == len(_FILES["assets/index-abc.js"])
    cases = {
        "not a zip": b"plain text, not a zip",
        "empty": b"",
        "no manifest": _bundle(with_manifest=False),
        "manifest not json": _bundle(manifest=b"{not json"),
        "manifest not an object": _bundle(manifest=json.dumps([1, 2])),
        "wrong kind": _bundle(kind="r2m-kiosk"),
        "no version": _bundle(version=""),
        "version too long": _bundle(version="v" * 65),
        "versionCode missing": _bundle(versionCode=None),
        "versionCode text": _bundle(versionCode="913530"),
        "versionCode zero": _bundle(versionCode=0),
        "versionCode past int32": _bundle(versionCode=2_147_483_648),
        "bridgeApi missing": _bundle(bridgeApi=None),
        "bridgeApi zero": _bundle(bridgeApi=0),
        "bridgeApi bool": _bundle(bridgeApi=True),
        "entry not listed": _bundle(entry="main.html"),
        "sha mismatch": _bundle(files=tampered, manifest=dict(good, files=good["files"])),
        "size mismatch": _bundle(manifest=dict(good, files=[
            dict(f, size=f["size"] + 1) if f["path"] == "index.html" else f for f in good["files"]
        ])),
        "listed file missing": _bundle(manifest=dict(good, files=good["files"] + [
            {"path": "assets/missing.js", "sha256": _sha(b"x"), "size": 1}
        ])),
        "unlisted extra entry": _bundle(extra={"assets/extra.js": b"extra"}),
        "traversal in the manifest": _bundle(
            files={"index.html": _FILES["index.html"], "../evil.js": b"evil"},
        ),
        "traversal entry in the zip": _bundle(extra={"../evil.js": b"evil"}),
        "absolute path": _bundle(files={"index.html": _FILES["index.html"], "/etc/x.js": b"x"}),
        "backslash path": _bundle(manifest=dict(good, files=good["files"] + [
            {"path": "assets\\x.js", "sha256": _sha(b"x"), "size": 1}
        ])),
        "drive letter": _bundle(manifest=dict(good, files=good["files"] + [
            {"path": "C:/x.js", "sha256": _sha(b"x"), "size": 1}
        ])),
        "uppercase sha": _bundle(manifest=dict(good, files=[
            dict(f, sha256=f["sha256"].upper()) for f in good["files"]
        ])),
        "manifest lists itself": _bundle(manifest=dict(good, files=good["files"] + [
            {"path": "manifest.json", "sha256": _sha(b"x"), "size": 1}
        ])),
        "no files": _bundle(manifest=dict(good, files=[])),
    }
    messages = {name: _refusal(world, data) for name, data in cases.items()}
    assert "not in the manifest" in messages["unlisted extra entry"]
    assert "not in the zip" in messages["listed file missing"]
    assert "sha256" in messages["sha mismatch"]
    assert "unsafe path" in messages["traversal in the manifest"]
    assert "unsafe path" in messages["traversal entry in the zip"]
    assert "kind" in messages["wrong kind"]
    assert "manifest.json" in messages["no manifest"]
    # Nothing is left on disk, and no release was made.
    assert list((world.tmp / "releases").iterdir()) == []
    assert world.db.query(AppRelease).count() == 0


def test_directories_in_the_zip_are_fine(world):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("assets/", b"")
        z.writestr("manifest.json", json.dumps(_manifest()))
        for path, data in _FILES.items():
            z.writestr(path, data)
    assert _upload(world, buf.getvalue()).version_code == 913530


def test_a_bundle_version_is_unique_within_kiosk_web_only(world):
    _apk_release(world, 10, "2026.10.07-1530")  # an APK with the same name does not block it
    _upload(world, _bundle())
    with pytest.raises(HTTPException) as exc:
        _upload(world, _bundle(versionCode=913531))
    assert exc.value.status_code == 409 and exc.value.detail == "app_release_version_taken"


def test_a_bundle_over_the_limit_is_413(world, monkeypatch):
    monkeypatch.setattr(get_settings(), "app_release_max_bytes", 100)
    with pytest.raises(HTTPException) as exc:
        _upload(world, _bundle())
    assert exc.value.status_code == 413


def test_the_path_rule():
    for ok in ("index.html", "assets/index-abc.js", "a/b/c.d.e", "fonts/נ.woff2"):
        assert B.unsafe_path_reason(ok) is None, ok
    for bad in ("", "/x", "../x", "a/../x", "a/./x", "a//x", "a/", "a\\x", "C:/x", "c:x", "a\x00b", None, 5):
        assert B.unsafe_path_reason(bad) is not None, bad


# ── Offer, download, status ──────────────────────────────────────────────────


def test_the_kiosk_is_offered_its_bundle_with_the_bridge_api_machine_over_shop(world):
    shop_rel = _web_release(world, "2026.10.06-1000", 900, bridge_api=1)
    mine = _web_release(world, "2026.10.07-1530", 913530, bridge_api=2)
    _assign(world, mine, "machine", world.tills[0].id, minutes=0, auto_install=True)
    _assign(world, shop_rel, "shop", world.shop.id, minutes=30)  # newer, but less specific

    offer = _offer(world, world.tills[0])
    body = offer.model_dump(by_alias=True)
    assert (body["available"], body["platform"], body["versionName"], body["versionCode"], body["bridgeApi"]) == (
        True, "kiosk_web", "2026.10.07-1530", 913530, 2,
    )
    assert body["releaseId"] == str(mine.id) and body["sha256"] == mine.sha256 and body["autoInstall"] is True
    other = _offer(world, world.tills[1]).model_dump(by_alias=True)
    assert (other["versionName"], other["bridgeApi"]) == ("2026.10.06-1000", 1)
    # Never the version it already runs.
    assert _offer(world, world.tills[0], code=913530, name="2026.10.07-1530").available is False


def test_every_offer_carries_bridge_api(world):
    nothing = _offer(world, world.tills[0]).model_dump(by_alias=True)
    assert nothing["available"] is False and nothing["platform"] == "kiosk_web"
    assert "bridgeApi" in nothing and nothing["bridgeApi"] is None
    apk = _apk_release(world, 10, "1.0")
    _assign(world, apk, "shop", world.shop.id)
    till_offer = _offer(world, world.tills[0], platform=None).model_dump(by_alias=True)
    assert till_offer["available"] is True and till_offer["bridgeApi"] is None


def test_bundles_and_the_apk_never_interfere(world):
    bundle = _web_release(world, "2026.10.07-1530", 913530)
    _assign(world, bundle, "machine", world.tills[0].id)
    # The APK's own call (no platform) sees no bundle.
    assert _offer(world, world.tills[0], platform=None).available is False
    assert _offer(world, world.tills[0], platform="windows").available is False
    apk = _apk_release(world, 10, "1.0")
    _assign(world, apk, "shop", world.shop.id, minutes=5)
    as_android = _offer(world, world.tills[0], platform=None)
    assert (as_android.platform, as_android.version_name) == ("android", "1.0")
    as_web = _offer(world, world.tills[0])
    assert (as_web.platform, as_web.version_name) == ("kiosk_web", "2026.10.07-1530")
    # The other till has the APK but no bundle.
    assert _offer(world, world.tills[1]).available is False


def test_the_bundle_download_is_a_zip(world):
    bundle = _web_release(world, "2026.10.07-1530", 913530)
    _assign(world, bundle, "shop", world.shop.id)
    resp = get_app_update_apk(machine_id=str(world.tills[0].id), release_id=bundle.id, machine=world.tills[0], db=world.db)
    assert isinstance(resp, FileResponse) and resp.path == bundle.file_path
    assert resp.media_type == "application/zip"
    assert resp.filename == "kiosk-web-2026.10.07-1530.zip"
    with pytest.raises(HTTPException) as exc:  # another shop's kiosk resolves to nothing
        get_app_update_apk(machine_id=str(world.other_till.id), release_id=bundle.id, machine=world.other_till, db=world.db)
    assert exc.value.status_code == 404


def test_progress_reports_for_a_bundle_use_the_same_endpoint(world):
    bundle = _web_release(world, "2026.10.07-1530", 913530, bridge_api=3)
    till = world.tills[0]
    out = post_app_update_status(
        machine_id=str(till.id),
        body=AppUpdateStatusIn(releaseId=bundle.id, status="declined", versionName="2026.10.06-1000",
                               message="APK bridge API 2 < 3"),
        machine=till, db=world.db,
    )
    assert out.status == "declined"
    row = world.db.query(AppReleaseMachineStatus).one()
    assert (row.release_id, row.status) == (bundle.id, "declined")


def _send(world, release, **body):
    return R.create_app_release_assignment(
        release_id=release.id,
        body=AppReleaseAssignmentIn(level="machine", targetId=world.tills[0].id, **body),
        background_tasks=BackgroundTasks(),
        admin=_admin(),
        db=world.db,
    )


def test_a_bundle_may_be_rolled_back_an_apk_still_may_not(world):
    older = _web_release(world, "2026.10.06-1000", 900)
    _web_release(world, "2026.10.07-1530", 913530)
    out = _send(world, older, allowDowngrade=True, autoInstall=True)
    assert (out.platform, out.allow_downgrade) == ("kiosk_web", True)
    rollback = _offer(world, world.tills[0], code=913530, name="2026.10.07-1530")
    assert (rollback.available, rollback.version_name, rollback.allow_downgrade) == (True, "2026.10.06-1000", True)
    # Without the flag a lower bundle is not offered.
    _send(world, older)
    assert _offer(world, world.tills[0], code=913530, name="2026.10.07-1530").available is False
    assert AU.allows_downgrade(SimpleNamespace(allow_downgrade=True), SimpleNamespace(platform="kiosk_web")) is True
    assert AU.allows_downgrade(SimpleNamespace(allow_downgrade=True), SimpleNamespace(platform="android")) is False

    apk = _apk_release(world, 10, "1.0")
    with pytest.raises(HTTPException) as exc:
        _send(world, apk, allowDowngrade=True)
    assert exc.value.status_code == 422 and exc.value.detail == "downgrade_not_supported_on_android"


def test_a_bundle_assignment_counts_the_kiosk_web_devices(world):
    bundle = _web_release(world, "2026.10.07-1530", 913530)
    _make_kiosk(world, world.tills[0])
    out = R.create_app_release_assignment(
        release_id=bundle.id,
        body=AppReleaseAssignmentIn(level="shop", targetId=world.shop.id),
        background_tasks=BackgroundTasks(), admin=_admin(), db=world.db,
    )
    assert out.machine_count == 1
    _status(world, world.tills[1], renderer="native")  # an Android device that reported a web status
    listed = R.list_app_release_assignments(release_id=bundle.id, include_cancelled=False, _admin=_admin(), db=world.db)
    assert listed[0].machine_count == 2


def test_the_kiosk_web_status_is_upserted_one_row_per_machine(world):
    till = world.tills[0]
    out = _status(
        world, till, renderer="native", configured="web", bundleVersion="2026.10.07-1530",
        bundleVersionCode=913530, bundleSource="bundled", apkBridgeApi=1, fallbackReason="ready_timeout",
        message="x" * 900,
    )
    body = out.model_dump(by_alias=True)
    assert body["ok"] is True and body["updatedAt"] is not None
    row = world.db.get(KioskWebDeviceStatus, till.id)
    assert (row.renderer, row.configured, row.bundle_version, row.bundle_version_code, row.bundle_source) == (
        "native", "web", "2026.10.07-1530", 913530, "bundled",
    )
    assert (row.apk_bridge_api, row.fallback_reason, len(row.message)) == (1, "ready_timeout", 500)

    _status(world, till, renderer="web", configured="web", bundleVersion="2026.10.08-0900",
            bundleSource="downloaded", previousVersion="2026.10.07-1530", pendingVersion=None)
    world.db.expire_all()
    rows = world.db.query(KioskWebDeviceStatus).all()
    assert len(rows) == 1
    row = rows[0]
    assert (row.renderer, row.bundle_version, row.previous_version, row.fallback_reason, row.message) == (
        "web", "2026.10.08-0900", "2026.10.07-1530", None, None,
    )


def test_the_status_body_rules():
    # A short token of any name is accepted; a long one is clipped, not refused.
    body = KioskWebStatusIn(renderer="web", fallbackReason="something_new", bundleVersionCode=2**40)
    assert body.fallback_reason == "something_new" and body.bundle_version_code is None
    assert len(KioskWebStatusIn(renderer="web", fallbackReason="r" * 40).fallback_reason) == 32
    for bad in ({"renderer": "html"}, {"renderer": "web", "configured": "flash"}, {}):
        with pytest.raises(ValidationError):
            KioskWebStatusIn(**bad)


def test_a_bad_renderer_is_422_over_http():
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.main import app
    from app.middleware.auth import get_pos_machine_for_sync_path

    app.dependency_overrides[get_db] = lambda: MagicMock()
    app.dependency_overrides[get_pos_machine_for_sync_path] = lambda: SimpleNamespace(id=uuid.uuid4())
    try:
        http = TestClient(app)
        url = f"/api/v1/sync/{uuid.uuid4()}/kiosk-web/status"
        assert http.post(url, json={"renderer": "html"}).status_code == 422
        assert http.post(url, json={"renderer": "web", "configured": "flash"}).status_code == 422
        assert http.post(url, json={"configured": "web"}).status_code == 422
    finally:
        app.dependency_overrides.clear()


# ── Rollout ──────────────────────────────────────────────────────────────────


def _rollout(world, platform=None):
    return R.get_app_release_rollout(
        tenant_id=None, company_id=None, shop_id=None,
        current_user=_admin(), active_tenant_id=world.tenant.id, db=world.db, platform=platform,
    )


def test_the_rollout_shows_the_kiosks_bundle_renderer_and_fallback(world):
    old = _web_release(world, "2026.10.06-1000", 900)
    new = _web_release(world, "2026.10.07-1530", 913530, minutes=5)
    _web_release(world, "2026.10.08-0900", 920900, minutes=10)  # newest, assigned to no one
    _assign(world, old, "shop", world.shop.id)
    _assign(world, new, "machine", world.tills[0].id)
    kiosk, till = world.tills
    _make_kiosk(world, kiosk)
    kiosk.app_version = "0.1.300"
    world.db.commit()
    _status(world, kiosk, renderer="native", configured="web", bundleVersion="2026.10.06-1000",
            bundleSource="bundled", pendingVersion="2026.10.07-1530", fallbackReason="js_errors",
            message="3 errors in 60 s")
    world.db.add(AppReleaseMachineStatus(
        id=uuid.uuid4(), machine_id=kiosk.id, release_id=new.id, status="downloaded",
        version_name="2026.10.06-1000", updated_at=_ts(20), created_at=_ts(20),
    ))
    world.db.commit()

    web = _rollout(world, "kiosk_web")
    assert [(r.machine_name, r.platform) for r in web] == [(kiosk.name, "kiosk_web")]
    row = web[0]
    assert row.device_role == "kiosk"
    assert (row.current_version, row.target_version, row.assignment_level) == (
        "2026.10.06-1000", "2026.10.07-1530", "machine",
    )
    assert (row.up_to_date, row.behind, row.newest_version, row.behind_newest) == (
        False, True, "2026.10.08-0900", True,
    )
    assert (row.status, row.renderer, row.renderer_configured, row.fallback_reason) == (
        "downloaded", "native", "web", "js_errors",
    )
    assert (row.pending_version, row.bundle_source, row.web_status_message) == (
        "2026.10.07-1530", "bundled", "3 errors in 60 s",
    )
    assert row.web_status_at is not None
    body = row.model_dump(by_alias=True)
    assert {"renderer", "rendererConfigured", "fallbackReason", "pendingVersion", "bundleSource",
            "webStatusAt", "webStatusMessage"} <= set(body)

    # The "all" view: every device's own row, plus the kiosk's kiosk_web row; the Android
    # rows carry no web fields and still measure the APK.
    everything = _rollout(world)
    pairs = [(r.machine_name, r.platform) for r in everything]
    assert pairs.count((kiosk.name, "android")) == 1 and pairs.count((kiosk.name, "kiosk_web")) == 1
    assert pairs.index((kiosk.name, "android")) < pairs.index((kiosk.name, "kiosk_web"))
    android_row = next(r for r in everything if r.machine_name == kiosk.name and r.platform == "android")
    assert android_row.current_version == "0.1.300" and android_row.renderer is None
    assert (till.name, "kiosk_web") not in pairs
    assert all(r.platform == "android" for r in _rollout(world, "android"))


def test_the_kiosk_web_devices_are_android_kiosks_and_reporters_only(world):
    kiosk, till = world.tills
    _make_kiosk(world, kiosk)
    disabled = world.other_till
    _make_kiosk(world, disabled, enabled=False)  # a disabled kiosk works as a till
    assert [r.machine_name for r in _rollout(world, "kiosk_web")] == [kiosk.name]
    # An Android device that reports a web status is one too (no assignment: nothing resolved).
    _status(world, till, renderer="native", bundleVersion="2026.10.06-1000")
    rows = {r.machine_name: r for r in _rollout(world, "kiosk_web")}
    assert set(rows) == {kiosk.name, till.name}
    assert rows[till.name].current_version == "2026.10.06-1000" and rows[till.name].release_id is None
    assert rows[kiosk.name].current_version is None and rows[kiosk.name].renderer is None
    # A Windows kiosk never takes the Android bundle.
    kiosk.device_info = {"platform": "windows"}
    world.db.commit()
    assert [r.machine_name for r in _rollout(world, "kiosk_web")] == [till.name]


# ── Kiosk config: general.renderer ───────────────────────────────────────────


def test_the_renderer_switch_defaults_to_native_and_takes_web_only():
    assert C.DEFAULT_CONFIG["general"]["renderer"] == "native"
    assert C.default_config()["general"]["renderer"] == "native"
    cleaned, errors = C.validate_layer({"general": {"renderer": "web"}})
    assert errors == [] and cleaned == {"general": {"renderer": "web"}}
    assert C.validate_config(C.merge(C.default_config(), cleaned)) == []
    assert C.resolve({"general": {"renderer": "native"}}, {"general": {"renderer": "web"}})["general"]["renderer"] == "web"
    _cleaned, errors = C.validate_layer({"general": {"renderer": "html"}})
    assert {e.path: e.code for e in errors} == {"general.renderer": "invalid_value"}
    errors = C.validate_config(C.merge(C.default_config(), {"general": {"renderer": "html"}}))
    assert {e.path: e.code for e in errors} == {"general.renderer": "invalid_value"}
