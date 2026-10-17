"""Deleting old release files ("מחיקת קובץ" / "ניקוי גרסאות ישנות" in "עדכוני גרסה").

The release row stays, its stored file goes: guards (live assignment, newest active of its
platform, active without retire), the devices-on-version warning, idempotency, a storage
failure leaving the row untouched, the audit row, a deleted release never offered /
downloaded / assigned / reinstated, the bulk preview and run (confirm "מחק"), the super
admin gate and the migration on the single head.

Handlers run against the in-memory SQLite world of tests/shift_world.py, called directly;
storage is a temp directory (never a real release file), its failures mocked.
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.config import get_settings
from app.models.app_release import AppRelease, AppReleaseAssignment, AppReleaseFileDeletion
from app.models.kiosk_web import KioskWebDeviceStatus
from app.models.user import User, UserRole
from app.routers import app_release_files as RF
from app.routers import app_releases as R
from app.routers.sync import get_app_update, get_app_update_apk
from app.schemas.app_release import AppReleaseAssignmentIn, AppReleaseUpdate
from app.services import app_release_files as F
from app.services import app_updates as AU
from shift_world import make_world

ADMIN_ID = None


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 3, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = make_world()
    w.dir = tmp_path / "releases"
    w.dir.mkdir()
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(w.dir))
    monkeypatch.setattr(AU, "publish_settings_notify", lambda *a, **k: None)
    global ADMIN_ID
    ADMIN_ID = w.admin.id  # a real users row: file_deleted_by / deleted_by_user_id are foreign keys
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=ADMIN_ID)


def _release(world, code, name=None, *, active=True, platform="android", size=1000, minutes=0):
    rid = uuid.uuid4()
    ext = {"windows": "exe", "kiosk_web": "zip"}.get(platform, "apk")
    path = world.dir / f"{rid}.{ext}"
    data = os.urandom(size)
    path.write_bytes(data)
    r = AppRelease(
        id=rid,
        platform=platform,
        version_code=code,
        version_name=name or f"0.1.{code}",
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=size,
        file_path=str(path),
        is_active=active,
        created_at=_ts(minutes),
    )
    world.db.add(r)
    world.db.commit()
    return r


def _assign(world, release, level="shop", target_id=None):
    a = AppReleaseAssignment(
        id=uuid.uuid4(),
        release_id=release.id,
        level=level,
        target_id=target_id or world.shop.id,
        tenant_id=world.tenant.id,
        created_at=_ts(),
    )
    world.db.add(a)
    world.db.commit()
    return a


def _delete(world, release, retire=False):
    return RF.delete_app_release_file(release_id=release.id, admin=_admin(), db=world.db, retire=retire)


def _refused(fn, code, status=409):
    with pytest.raises(HTTPException) as exc:
        fn()
    assert exc.value.status_code == status
    assert exc.value.detail == code


def _audits(world):
    return world.db.query(AppReleaseFileDeletion).all()


# ── One release ──────────────────────────────────────────────────────────────


def test_a_retired_release_loses_its_file_and_keeps_its_row(world):
    old = _release(world, 10, active=False, size=4321)
    _release(world, 11)  # the newest active one
    path = Path(old.file_path)

    out = _delete(world, old)

    assert not path.exists()
    assert out.storage_result == "deleted"
    assert out.freed_bytes == 4321
    assert out.retired is False
    assert out.release.file_deleted_at is not None
    row = world.db.query(AppRelease).filter(AppRelease.id == old.id).one()
    assert row.file_deleted_at is not None and row.file_deleted_by == ADMIN_ID
    assert row.file_path == str(path)  # history: where it was
    [audit] = _audits(world)
    assert (audit.release_id, audit.version_name, audit.size_bytes, audit.mode, audit.storage_result) == (
        old.id, "0.1.10", 4321, "single", "deleted",
    )
    assert audit.deleted_by_user_id == ADMIN_ID
    # The list shows the badge's field.
    listed = {r.id: r for r in R.list_app_releases(_admin=_admin(), db=world.db)}
    assert listed[old.id].file_deleted_at is not None
    assert R.AppReleaseOut.model_validate(listed[old.id]).model_dump(by_alias=True)["fileDeletedAt"] is not None


def test_deleting_again_is_a_no_op(world):
    old = _release(world, 10, active=False)
    _release(world, 11)
    _delete(world, old)
    again = _delete(world, old)
    assert again.storage_result is None
    assert again.freed_bytes == 0
    assert len(_audits(world)) == 1


def test_a_file_already_gone_is_marked_as_already_missing(world):
    old = _release(world, 10, active=False)
    _release(world, 11)
    os.remove(old.file_path)
    out = _delete(world, old)
    assert out.storage_result == "already_missing"
    assert world.db.get(AppRelease, old.id).file_deleted_at is not None
    assert _audits(world)[0].storage_result == "already_missing"


def test_the_guards(world):
    assigned = _release(world, 9, active=False)
    _assign(world, assigned)
    older_active = _release(world, 10)
    newest = _release(world, 11)

    _refused(lambda: _delete(world, assigned), "app_release_has_assignments")
    _refused(lambda: _delete(world, older_active), "app_release_not_retired")
    _refused(lambda: _delete(world, newest, retire=True), "app_release_latest")
    for r in (assigned, older_active, newest):
        assert Path(r.file_path).exists()
        assert world.db.get(AppRelease, r.id).file_deleted_at is None
    assert _audits(world) == []

    check = RF.check_app_release_file_delete(release_id=newest.id, _admin=_admin(), db=world.db, retire=True)
    assert (check.allowed, check.reasons) == (False, ["app_release_latest"])
    check = RF.check_app_release_file_delete(release_id=older_active.id, _admin=_admin(), db=world.db, retire=True)
    assert (check.allowed, check.needs_retire) == (True, True)


def test_retire_and_delete_in_one_confirm(world):
    older = _release(world, 10)
    _release(world, 11)
    out = _delete(world, older, retire=True)
    assert out.retired is True
    row = world.db.get(AppRelease, older.id)
    assert row.is_active is False and row.file_deleted_at is not None
    assert _audits(world)[0].retired is True


def test_another_platform_does_not_make_a_release_the_latest(world):
    android = _release(world, 10)  # the only android one: newest of its platform
    _release(world, 2_000_000, "2.0.0", platform="windows")
    _refused(lambda: _delete(world, android, retire=True), "app_release_latest")


def test_a_storage_failure_changes_nothing(world, monkeypatch):
    older = _release(world, 10)
    _release(world, 11)

    def boom(path):
        raise PermissionError("denied")

    monkeypatch.setattr(F.os, "remove", boom)
    _refused(lambda: _delete(world, older, retire=True), "app_release_file_delete_failed", status=502)
    world.db.expire_all()
    row = world.db.get(AppRelease, older.id)
    assert row.is_active is True  # the retire was rolled back with it
    assert row.file_deleted_at is None
    assert _audits(world) == []
    assert Path(older.file_path).exists()


def test_a_path_that_is_not_the_releases_own_file_is_never_touched(world, tmp_path):
    outsider = tmp_path / "keep-me.txt"
    outsider.write_text("x")
    old = _release(world, 10, active=False)
    _release(world, 11)
    old.file_path = str(outsider)
    world.db.commit()
    _refused(lambda: _delete(world, old), "app_release_file_delete_failed", status=502)
    assert outsider.exists()
    assert world.db.get(AppRelease, old.id).file_deleted_at is None


def test_devices_still_on_the_version_warn_but_never_block(world):
    old = _release(world, 10, "0.1.10", active=False)
    _release(world, 11)
    world.tills[0].app_version = "0.1.10"
    world.tills[1].app_version = "0.1.10"
    world.other_till.app_version = "0.1.11"
    world.db.commit()
    check = RF.check_app_release_file_delete(release_id=old.id, _admin=_admin(), db=world.db, retire=True)
    assert (check.allowed, check.devices_on_version) == (True, 2)
    out = _delete(world, old)
    assert out.devices_on_version == 2
    assert _audits(world)[0].devices_on_version == 2


def test_a_windows_device_on_the_same_name_does_not_count_for_android(world):
    old = _release(world, 10, "1.0.0", active=False)
    _release(world, 11)
    world.tills[0].app_version = "1.0.0"
    world.tills[0].device_info = {"platform": "windows"}
    world.db.commit()
    assert F.devices_on_version(world.db, old) == 0


def test_kiosk_web_counts_the_bundle_the_kiosk_reported(world):
    old = _release(world, 5, "5.0.0", active=False, platform="kiosk_web")
    world.db.add(KioskWebDeviceStatus(machine_id=world.tills[0].id, renderer="web", bundle_version="5.0.0"))
    world.db.commit()
    assert F.devices_on_version(world.db, old) == 1


# ── A deleted file is never served again ─────────────────────────────────────


def test_a_release_without_its_file_is_never_offered_downloaded_sent_or_reinstated(world):
    old = _release(world, 10, active=False)
    _release(world, 11, active=False)
    _delete(world, old)

    _refused(
        lambda: R.update_app_release(
            release_id=old.id, body=AppReleaseUpdate(isActive=True), background_tasks=BackgroundTasks(),
            _admin=_admin(), db=world.db,
        ),
        "app_release_file_deleted",
    )
    _refused(
        lambda: R.create_app_release_assignment(
            release_id=old.id, body=AppReleaseAssignmentIn(level="shop", targetId=world.shop.id),
            background_tasks=BackgroundTasks(), admin=_admin(), db=world.db,
        ),
        "app_release_file_deleted",
    )
    # Notes still editable.
    R.update_app_release(
        release_id=old.id, body=AppReleaseUpdate(notes="old"), background_tasks=BackgroundTasks(),
        _admin=_admin(), db=world.db,
    )

    # Even if the row were made active and assigned behind the dashboard's back.
    row = world.db.get(AppRelease, old.id)
    row.is_active = True
    world.db.commit()
    _assign(world, row, "machine", world.tills[0].id)
    till = world.tills[0]
    offer = get_app_update(
        machine_id=str(till.id), version_code=1, version_name="0.0.1", machine=till, db=world.db, platform=None
    )
    assert offer.available is False
    with pytest.raises(HTTPException) as exc:
        get_app_update_apk(machine_id=str(till.id), release_id=old.id, machine=till, db=world.db)
    assert exc.value.status_code in (404, 410)
    assert AU.newest_releases(world.db).get("android") is None


def test_the_pure_resolver_skips_a_deleted_file():
    from types import SimpleNamespace

    m = uuid.uuid4()
    chain = AU.MachineChain(machine_id=m, area_id=None, shop_id=None, company_id=None, tenant_id=None)
    rel = SimpleNamespace(id=uuid.uuid4(), version_code=1, version_name="1", is_active=True,
                          platform="android", file_deleted_at=_ts())
    asg = SimpleNamespace(id=uuid.uuid4(), level="machine", target_id=m, created_at=_ts(), cancelled_at=None,
                          rollout_percent=100)
    assert AU.resolve_assignment([(asg, rel)], chain) is None
    rel.file_deleted_at = None
    assert AU.resolve_assignment([(asg, rel)], chain) == (asg, rel)


# ── Bulk cleanup ─────────────────────────────────────────────────────────────


def _android_six(world):
    """Codes 1..6: 6 newest active, 5 retired, 4 retired + assigned, 3 active, 2 and 1 retired."""
    rels = {}
    for code, active in ((1, False), (2, False), (3, True), (4, False), (5, False), (6, True)):
        rels[code] = _release(world, code, active=active, size=100 * code, minutes=code)
    _assign(world, rels[4])
    return rels


def test_the_preview_keeps_the_newest_n_per_platform(world):
    rels = _android_six(world)
    win_old = _release(world, 1_000_000, "1.0.0", platform="windows", active=False, size=7)
    _release(world, 1_000_001, "1.0.1", platform="windows", size=9)

    out = RF.preview_app_release_file_cleanup(_admin=_admin(), db=world.db, keep=2, platform=None)

    by = {p.platform: p for p in out.platforms}
    android = by["android"]
    assert [r.version_name for r in android.kept] == ["0.1.6", "0.1.5"]
    assert [r.version_name for r in android.delete] == ["0.1.3", "0.1.2", "0.1.1"]
    assert [(r.version_name, r.reasons) for r in android.skipped] == [("0.1.4", ["app_release_has_assignments"])]
    assert android.total_bytes == 300 + 200 + 100
    assert by["windows"].delete == [] and len(by["windows"].kept) == 2
    assert out.total_count == 3 and out.total_bytes == 600
    assert out.confirm_word == "מחק"
    # Nothing changed.
    assert all(Path(r.file_path).exists() for r in rels.values()) and Path(win_old.file_path).exists()

    default = RF.preview_app_release_file_cleanup(_admin=_admin(), db=world.db, keep=None, platform="android")
    assert default.keep == 3 and [p.platform for p in default.platforms] == ["android"]
    _refused(lambda: RF.preview_app_release_file_cleanup(_admin=_admin(), db=world.db, keep=0, platform=None),
             "keep_invalid", status=422)


def test_the_newest_active_is_skipped_even_below_the_kept_ones(world):
    newest_active = _release(world, 1)
    _release(world, 2, active=False)
    _release(world, 3, active=False)
    out = RF.preview_app_release_file_cleanup(_admin=_admin(), db=world.db, keep=2, platform="android")
    [p] = out.platforms
    assert p.delete == []
    assert [(r.release_id, r.reasons) for r in p.skipped] == [(newest_active.id, ["app_release_latest"])]


def _run(world, ids, confirm="מחק", keep=2, platform=None):
    return RF.run_app_release_file_cleanup(
        body=RF.CleanupIn(keep=keep, platform=platform, releaseIds=ids, confirm=confirm), admin=_admin(), db=world.db
    )


def test_the_cleanup_needs_the_typed_word(world):
    rels = _android_six(world)
    _refused(lambda: _run(world, [rels[1].id], confirm="delete"), "cleanup_confirm_required", status=422)
    _refused(lambda: _run(world, [rels[1].id], confirm=""), "cleanup_confirm_required", status=422)
    assert Path(rels[1].file_path).exists()


def test_the_cleanup_deletes_only_what_the_plan_still_allows(world):
    rels = _android_six(world)
    stranger = uuid.uuid4()
    out = _run(world, [rels[3].id, rels[2].id, rels[4].id, rels[6].id, stranger, rels[2].id], confirm=" מחק ")

    assert sorted(r.version_name for r in out.deleted) == ["0.1.2", "0.1.3"]
    assert out.freed_bytes == 500
    failed = {f.release_id: f.reason for f in out.failed}
    assert failed == {
        rels[4].id: "app_release_has_assignments",
        rels[6].id: "not_in_plan",
        stranger: "not_in_plan",
    }
    for code in (2, 3):
        row = world.db.get(AppRelease, rels[code].id)
        assert row.file_deleted_at is not None and row.is_active is False
        assert not Path(rels[code].file_path).exists()
    for code in (1, 4, 5, 6):
        assert Path(rels[code].file_path).exists()
    audits = _audits(world)
    assert len(audits) == 2 and {a.mode for a in audits} == {"cleanup"}
    assert {a.retired for a in audits} == {True, False}  # 3 was active, 2 retired


def test_one_storage_failure_does_not_stop_the_cleanup(world, monkeypatch):
    rels = _android_six(world)
    real_remove = os.remove

    def flaky(path):
        if str(rels[3].id) in str(path):
            raise PermissionError("denied")
        real_remove(path)

    monkeypatch.setattr(F.os, "remove", flaky)
    out = _run(world, [rels[3].id, rels[2].id, rels[1].id])
    assert sorted(r.version_name for r in out.deleted) == ["0.1.1", "0.1.2"]
    assert [(f.release_id, f.reason) for f in out.failed] == [(rels[3].id, "app_release_file_delete_failed")]
    world.db.expire_all()
    row = world.db.get(AppRelease, rels[3].id)
    assert row.file_deleted_at is None and row.is_active is True
    assert len(_audits(world)) == 2


# ── Gates and schema ─────────────────────────────────────────────────────────


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: MagicMock()
    try:
        yield app, TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("role", [r for r in UserRole if r != UserRole.SUPER_ADMIN], ids=lambda r: r.value)
def test_everyone_but_a_super_admin_gets_403(client, role):
    from app.middleware.auth import get_current_user

    app, http = client
    app.dependency_overrides[get_current_user] = lambda: MagicMock(spec=User, role=role)
    rid = uuid.uuid4()
    for method, url, body in [
        ("GET", f"/api/v1/app-releases/{rid}/file-delete-check", None),
        ("DELETE", f"/api/v1/app-releases/{rid}/file?retire=true", None),
        ("GET", "/api/v1/app-releases/file-cleanup", None),
        ("POST", "/api/v1/app-releases/file-cleanup", {"releaseIds": [str(rid)], "confirm": "מחק"}),
    ]:
        resp = http.request(method, url, **({"json": body} if body is not None else {}))
        assert resp.status_code == 403, (method, url, resp.text)


def test_every_route_hangs_on_the_super_admin_gate():
    from app.middleware.auth import get_current_super_admin

    def calls(dependant):
        yield dependant.call
        for sub in dependant.dependencies:
            yield from calls(sub)

    routes = [r for r in RF.router.routes if hasattr(r, "dependant")]
    assert len(routes) == 4
    for route in routes:
        assert get_current_super_admin in set(calls(route.dependant)), route.path


def test_the_migration_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).resolve().parents[1]
    revision = "c4e7a2f9b1d8"
    declaring = [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]
    assert declaring == [f"{revision}_app_release_file_delete.py"]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
