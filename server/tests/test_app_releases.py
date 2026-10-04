"""Remote app updates for tills ("עדכון קופות"): releases, assignments and the till's side.

Covers the resolution order till → area → shop → company → tenant (newest at a level,
cancelled and retired left out), the offer rule (never the version the till runs, never
a downgrade), the APK download refusing any release but the resolved one, the status
upsert, the upload (hash, size, version read from the APK's manifest), the rollout view,
and the role gates: everything super admin only except the rollout, which the tenant's
machine admins may read.

The pure parts run on plain objects; the handlers run against the in-memory SQLite world
of tests/shift_world.py, called directly. HTTP is only used for the gates.
"""
from __future__ import annotations

import hashlib
import io
import struct
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import get_settings
from app.models.app_release import AppRelease, AppReleaseAssignment, AppReleaseMachineStatus
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.routers import app_releases as R
from app.routers.sync import get_app_update, get_app_update_apk, post_app_update_status
from app.schemas.app_release import AppReleaseAssignmentIn, AppReleaseUpdate, AppUpdateStatusIn
from app.services import app_updates as AU
from app.services.apk_manifest import ApkManifestError, ApkVersion, parse_binary_manifest, read_apk_version
from app.services.app_updates import MachineChain, offer_for, resolve_assignment
from shift_world import make_world


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 3, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


# ── A minimal APK: a zip with a compiled AndroidManifest.xml ─────────────────


def _string_pool(strings):
    header_size = 28
    body = b""
    offsets = []
    for text in strings:
        offsets.append(len(body))
        encoded = text.encode("utf-16-le")
        body += struct.pack("<H", len(text)) + encoded + b"\x00\x00"
    while len(body) % 4:
        body += b"\x00"
    strings_start = header_size + 4 * len(strings)
    size = strings_start + len(body)
    head = struct.pack("<HHIIIIII", 0x0001, header_size, size, len(strings), 0, 0, strings_start, 0)
    return head + struct.pack(f"<{len(strings)}I", *offsets) + body


def _manifest(version_code: int, version_name: str, *, named: bool = True) -> bytes:
    """
    `<manifest android:versionCode=… android:versionName=…>`. With `named` false the
    attribute names are blank in the string pool, as in a stripped release build, and
    only the resource map says which is which.
    """
    strings = ["versionCode" if named else "", "versionName" if named else "", "manifest", version_name]
    pool = _string_pool(strings)
    resmap = struct.pack("<HHI", 0x0180, 8, 16) + struct.pack("<II", 0x0101021B, 0x0101021C)
    attrs = struct.pack("<IIIHBBI", 0xFFFFFFFF, 0, 0xFFFFFFFF, 8, 0, 0x10, version_code)
    attrs += struct.pack("<IIIHBBI", 0xFFFFFFFF, 1, 3, 8, 0, 0x03, 3)
    ext = struct.pack("<IIHHHHHH", 0xFFFFFFFF, 2, 20, 20, 2, 0, 0, 0)
    element_size = 16 + len(ext) + len(attrs)
    element = struct.pack("<HHIII", 0x0102, 16, element_size, 1, 0xFFFFFFFF) + ext + attrs
    body = pool + resmap + element
    return struct.pack("<HHI", 0x0003, 8, 8 + len(body)) + body


def _apk(version_code: int = 42, version_name: str = "1.4.2", **kw) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AndroidManifest.xml", _manifest(version_code, version_name, **kw))
        z.writestr("classes.dex", b"dex\n035\x00" + b"\x00" * 64)
    return buf.getvalue()


def test_the_manifest_reader_finds_the_version():
    assert read_apk_version(io.BytesIO(_apk(42, "1.4.2"))) == ApkVersion(version_code=42, version_name="1.4.2")


def test_the_manifest_reader_goes_by_resource_ids_when_names_are_stripped():
    parsed = parse_binary_manifest(_manifest(7, "0.1.7+abc", named=False))
    assert (parsed.version_code, parsed.version_name) == (7, "0.1.7+abc")


def test_the_manifest_reader_refuses_what_is_not_an_apk():
    with pytest.raises(ApkManifestError):
        read_apk_version(io.BytesIO(b"not a zip"))
    with pytest.raises(ApkManifestError):
        parse_binary_manifest(b"<manifest/>")


# ── Resolution (pure) ────────────────────────────────────────────────────────

M, A, S, C, T = (uuid.uuid4() for _ in range(5))
CHAIN = MachineChain(machine_id=M, area_id=A, shop_id=S, company_id=C, tenant_id=T)


def _rel(code=10, name=None, active=True):
    return SimpleNamespace(id=uuid.uuid4(), version_code=code, version_name=name or f"v{code}", is_active=active)


def _asg(level, target, minutes=0, cancelled=False):
    return SimpleNamespace(
        id=uuid.uuid4(),
        level=level,
        target_id=target,
        created_at=_ts(minutes),
        cancelled_at=_ts(minutes + 1) if cancelled else None,
        auto_install=False,
    )


@pytest.mark.parametrize(
    "levels, expected",
    [
        (["tenant", "company", "shop", "area", "machine"], "machine"),
        (["tenant", "company", "shop", "area"], "area"),
        (["tenant", "company", "shop"], "shop"),
        (["tenant", "company"], "company"),
        (["tenant"], "tenant"),
    ],
)
def test_the_most_specific_level_wins(levels, expected):
    targets = {"machine": M, "area": A, "shop": S, "company": C, "tenant": T}
    # The less specific ones are newer, so recency alone would pick them.
    rows = [(_asg(level, targets[level], minutes=10 - i), _rel(name=level)) for i, level in enumerate(reversed(levels))]
    assignment, release = resolve_assignment(rows, CHAIN)
    assert assignment.level == expected and release.version_name == expected


def test_within_a_level_the_newest_wins():
    rows = [
        (_asg("shop", S, minutes=0), _rel(name="old")),
        (_asg("shop", S, minutes=30), _rel(name="new")),
        (_asg("shop", S, minutes=10), _rel(name="middle")),
    ]
    assert resolve_assignment(rows, CHAIN)[1].version_name == "new"


def test_cancelled_assignments_and_retired_releases_do_not_count():
    rows = [
        (_asg("machine", M, minutes=50, cancelled=True), _rel(name="cancelled")),
        (_asg("area", A, minutes=40), _rel(name="retired", active=False)),
        (_asg("shop", S, minutes=0), _rel(name="shop")),
    ]
    assert resolve_assignment(rows, CHAIN)[1].version_name == "shop"


def test_assignments_off_the_chain_are_ignored():
    rows = [(_asg("shop", uuid.uuid4()), _rel()), (_asg("machine", uuid.uuid4()), _rel())]
    assert resolve_assignment(rows, CHAIN) is None
    # A till with no area simply has no area level.
    no_area = MachineChain(machine_id=M, shop_id=S, company_id=C, tenant_id=T)
    assert resolve_assignment([(_asg("area", A), _rel())], no_area) is None


def test_never_a_downgrade_and_never_the_same_version():
    release = _rel(code=20, name="2.0")
    assert offer_for(release, 19, "1.9") is True
    assert offer_for(release, 20, "2.0-rc") is True
    assert offer_for(release, 20, "2.0") is False  # already runs it
    assert offer_for(release, 21, "2.1") is False  # would be a downgrade


# ── The till's side on a real (SQLite) world ─────────────────────────────────


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    w.tmp = tmp_path
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    return w


@pytest.fixture
def published(monkeypatch):
    sent = []
    monkeypatch.setattr(
        AU, "publish_settings_notify", lambda tenant_id, machine_id, reason: sent.append((machine_id, reason))
    )
    return sent


def _release(world, code, name, active=True):
    path = world.tmp / f"{name}.apk"
    data = _apk(code, name)
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(),
        version_code=code,
        version_name=name,
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        file_path=str(path),
        is_active=active,
        created_at=_ts(),
    )
    world.db.add(r)
    world.db.commit()
    return r


def _assign(world, release, level, target_id, minutes=0, auto_install=False):
    a = AppReleaseAssignment(
        id=uuid.uuid4(),
        release_id=release.id,
        level=level,
        target_id=target_id,
        tenant_id=world.tenant.id,
        auto_install=auto_install,
        created_at=_ts(minutes),
    )
    world.db.add(a)
    world.db.commit()
    return a


def _offer(world, till, code=1, name="0.0.1"):
    return get_app_update(
        machine_id=str(till.id), version_code=code, version_name=name, machine=till, db=world.db
    )


def test_the_till_is_offered_its_most_specific_release(world):
    company_rel = _release(world, 10, "1.0")
    area_rel = _release(world, 11, "1.1")
    _assign(world, company_rel, "company", world.company.id, minutes=60)
    _assign(world, area_rel, "area", world.area.id, auto_install=True)

    in_area = _offer(world, world.tills[0])
    assert in_area.available is True
    assert in_area.release_id == str(area_rel.id)
    assert (in_area.version_code, in_area.version_name) == (11, "1.1")
    assert in_area.sha256 == area_rel.sha256 and in_area.size_bytes == area_rel.size_bytes
    assert in_area.auto_install is True

    # The other till of the shop is in no area: the company's release reaches it.
    assert _offer(world, world.tills[1]).version_name == "1.0"


def test_the_wire_shape_when_nothing_is_offered(world):
    body = _offer(world, world.tills[0]).model_dump(by_alias=True)
    assert body == {
        "available": False,
        "releaseId": None,
        "versionCode": None,
        "versionName": None,
        "sha256": None,
        "sizeBytes": None,
        "notes": None,
        "autoInstall": False,
    }


def test_a_till_already_on_the_release_or_past_it_is_offered_nothing(world):
    rel = _release(world, 10, "1.0")
    _assign(world, rel, "tenant", world.tenant.id)
    assert _offer(world, world.tills[0], code=10, name="1.0").available is False
    assert _offer(world, world.tills[0], code=12, name="1.2").available is False
    assert _offer(world, world.tills[0], code=9, name="0.9").available is True


def test_the_apk_is_served_only_for_the_resolved_release(world):
    shop_rel = _release(world, 10, "1.0")
    machine_rel = _release(world, 11, "1.1")
    _assign(world, shop_rel, "shop", world.shop.id)
    _assign(world, machine_rel, "machine", world.tills[0].id)

    resp = get_app_update_apk(machine_id=str(world.tills[0].id), release_id=machine_rel.id, machine=world.tills[0], db=world.db)
    assert isinstance(resp, FileResponse)
    assert resp.path == machine_rel.file_path
    assert resp.media_type == "application/vnd.android.package-archive"

    # Assigned to its shop, but not what this till resolves to.
    with pytest.raises(HTTPException) as exc:
        get_app_update_apk(machine_id=str(world.tills[0].id), release_id=shop_rel.id, machine=world.tills[0], db=world.db)
    assert exc.value.status_code == 404
    # Another shop's till resolves to nothing at all.
    with pytest.raises(HTTPException):
        get_app_update_apk(machine_id=str(world.other_till.id), release_id=shop_rel.id, machine=world.other_till, db=world.db)


def test_status_reports_are_upserted_per_till_and_release(world):
    rel = _release(world, 10, "1.0")
    till = world.tills[0]

    def report(status, message=None, version="0.9"):
        return post_app_update_status(
            machine_id=str(till.id),
            body=AppUpdateStatusIn(releaseId=rel.id, status=status, versionName=version, message=message),
            machine=till,
            db=world.db,
        )

    report("downloading")
    out = report("failed", message="INSTALL_FAILED_UPDATE_INCOMPATIBLE", version="0.9")
    assert out.status == "failed"
    rows = world.db.query(AppReleaseMachineStatus).all()
    assert len(rows) == 1
    assert (rows[0].status, rows[0].message, rows[0].version_name) == (
        "failed", "INSTALL_FAILED_UPDATE_INCOMPATIBLE", "0.9",
    )

    with pytest.raises(HTTPException) as exc:
        post_app_update_status(
            machine_id=str(till.id),
            body=AppUpdateStatusIn(releaseId=uuid.uuid4(), status="installed", versionName="1.0"),
            machine=till,
            db=world.db,
        )
    assert exc.value.status_code == 404


def test_an_unknown_status_is_refused():
    with pytest.raises(Exception):
        AppUpdateStatusIn(releaseId=uuid.uuid4(), status="exploded", versionName="1")


# ── Dashboard handlers ───────────────────────────────────────────────────────


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _upload(world, data, **form):
    return R.upload_app_release(
        file=UploadFile(file=io.BytesIO(data), filename="till.apk"),
        version_name=form.get("version_name"),
        version_code=form.get("version_code"),
        notes=form.get("notes"),
        admin=_admin(),
        db=world.db,
    )


def test_upload_hashes_measures_and_reads_the_version(world):
    data = _apk(42, "1.4.2")
    out = _upload(world, data, notes=" fixes printing ")
    assert (out.version_code, out.version_name) == (42, "1.4.2")
    assert out.sha256 == hashlib.sha256(data).hexdigest()
    assert out.size_bytes == len(data)
    assert out.notes == "fixes printing"
    stored = world.db.query(AppRelease).one()
    with open(stored.file_path, "rb") as f:
        assert f.read() == data
    # Nothing but the release itself is left in the directory.
    assert [p.name for p in (world.tmp / "releases").iterdir()] == [f"{stored.id}.apk"]


def test_upload_refuses_a_taken_version_a_mismatch_and_a_non_apk(world):
    _upload(world, _apk(42, "1.4.2"))
    with pytest.raises(HTTPException) as exc:
        _upload(world, _apk(43, "1.4.2"))
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        _upload(world, _apk(44, "1.4.4"), version_name="1.4.5")
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        _upload(world, b"plain text")
    assert exc.value.detail == "invalid_apk"
    assert len(list((world.tmp / "releases").iterdir())) == 1


def test_upload_falls_back_to_the_typed_version_when_the_manifest_is_unreadable(world):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AndroidManifest.xml", b"garbage")
    with pytest.raises(HTTPException) as exc:
        _upload(world, buf.getvalue())
    assert exc.value.detail["code"] == "apk_version_required"
    out = _upload(world, buf.getvalue(), version_name="2.0", version_code=200)
    assert (out.version_code, out.version_name) == (200, "2.0")


def test_upload_refuses_a_file_over_the_limit(world, monkeypatch):
    monkeypatch.setattr(get_settings(), "app_release_max_bytes", 100)
    with pytest.raises(HTTPException) as exc:
        _upload(world, _apk())
    assert exc.value.status_code == 413
    assert list((world.tmp / "releases").iterdir()) == []


def test_assigning_tells_the_tills_it_reaches(world, published):
    rel = _release(world, 10, "1.0")
    tasks = BackgroundTasks()
    out = R.create_app_release_assignment(
        release_id=rel.id,
        body=AppReleaseAssignmentIn(level="shop", targetId=world.shop.id, autoInstall=True),
        background_tasks=tasks,
        admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    assert out.target_name == "Center" and out.target_context == "Acme"
    assert out.tenant_id == world.tenant.id and out.auto_install is True
    assert out.machine_count == 2
    assert sorted(m for m, _ in published) == sorted(str(t.id) for t in world.tills)
    assert {reason for _, reason in published} == {AU.NOTIFY_REASON}


def test_assigning_refuses_a_missing_target_and_a_retired_release(world, published):
    rel = _release(world, 10, "1.0")
    with pytest.raises(HTTPException) as exc:
        R.create_app_release_assignment(
            release_id=rel.id,
            body=AppReleaseAssignmentIn(level="area", targetId=uuid.uuid4()),
            background_tasks=BackgroundTasks(),
            admin=_admin(),
            db=world.db,
        )
    assert exc.value.detail == "area_not_found"
    R.update_app_release(
        release_id=rel.id, body=AppReleaseUpdate(isActive=False), background_tasks=BackgroundTasks(),
        _admin=_admin(), db=world.db,
    )
    with pytest.raises(HTTPException) as exc:
        R.create_app_release_assignment(
            release_id=rel.id,
            body=AppReleaseAssignmentIn(level="tenant", targetId=world.tenant.id),
            background_tasks=BackgroundTasks(),
            admin=_admin(),
            db=world.db,
        )
    assert exc.value.detail == "app_release_retired"


def test_cancelling_falls_back_to_the_next_level(world, published):
    company_rel = _release(world, 10, "1.0")
    machine_rel = _release(world, 11, "1.1")
    _assign(world, company_rel, "company", world.company.id)
    mine = _assign(world, machine_rel, "machine", world.tills[0].id)
    assert _offer(world, world.tills[0]).version_name == "1.1"

    tasks = BackgroundTasks()
    R.cancel_app_release_assignment(assignment_id=mine.id, background_tasks=tasks, _admin=_admin(), db=world.db)
    _run(tasks)
    assert _offer(world, world.tills[0]).version_name == "1.0"
    assert [m for m, _ in published] == [str(world.tills[0].id)]
    listed = R.list_app_release_assignments(
        release_id=machine_rel.id, include_cancelled=True, _admin=_admin(), db=world.db
    )
    assert listed[0].cancelled_at is not None


def test_the_rollout_shows_each_till_its_target_and_last_report(world):
    rel = _release(world, 10, "1.0")
    _assign(world, rel, "area", world.area.id)
    world.tills[0].app_version = "0.9"
    world.db.add(
        AppReleaseMachineStatus(
            id=uuid.uuid4(), machine_id=world.tills[0].id, release_id=rel.id, status="downloading",
            version_name="0.9", updated_at=_ts(5), created_at=_ts(5),
        )
    )
    world.db.commit()
    rows = R.get_app_release_rollout(
        tenant_id=None, company_id=None, shop_id=world.shop.id,
        current_user=_admin(), active_tenant_id=world.tenant.id, db=world.db,
    )
    by_name = {r.machine_name: r for r in rows}
    assert set(by_name) == {"Till 1", "Till 2"}
    first = by_name["Till 1"]
    assert (first.company_name, first.shop_name, first.area_name) == ("Acme", "Center", "Bar")
    assert (first.current_version, first.target_version, first.assignment_level) == ("0.9", "1.0", "area")
    assert first.status == "downloading" and first.up_to_date is False
    assert by_name["Till 2"].release_id is None and by_name["Till 2"].status is None


def test_the_rollout_of_another_tenant_is_for_a_super_admin_only(world):
    manager = MagicMock(spec=User, role=UserRole.COMPANY_MANAGER)
    with pytest.raises(HTTPException) as exc:
        R.get_app_release_rollout(
            tenant_id=uuid.uuid4(), company_id=None, shop_id=None,
            current_user=manager, active_tenant_id=world.tenant.id, db=world.db,
        )
    assert exc.value.status_code == 403


# ── Gates over HTTP ──────────────────────────────────────────────────────────


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


_SUPER_ADMIN_ROUTES = [
    ("get", "/api/v1/app-releases", None),
    ("patch", f"/api/v1/app-releases/{uuid.uuid4()}", {"notes": "x"}),
    ("post", f"/api/v1/app-releases/{uuid.uuid4()}/assignments", {"level": "shop", "targetId": str(uuid.uuid4())}),
    ("get", f"/api/v1/app-releases/{uuid.uuid4()}/assignments", None),
    ("delete", f"/api/v1/app-release-assignments/{uuid.uuid4()}", None),
]


@pytest.mark.parametrize("role", [r for r in UserRole if r != UserRole.SUPER_ADMIN], ids=lambda r: r.value)
def test_everyone_but_a_super_admin_gets_403_on_releases(client, role):
    from app.middleware.auth import get_current_user

    app, http = client
    app.dependency_overrides[get_current_user] = lambda: MagicMock(spec=User, role=role)
    for method, url, body in _SUPER_ADMIN_ROUTES:
        kwargs = {"json": body} if body is not None else {}
        resp = http.request(method.upper(), url, **kwargs)
        assert resp.status_code == 403, (method, url, resp.text)
    resp = http.post(
        "/api/v1/app-releases",
        files={"file": ("a.apk", _apk(), "application/vnd.android.package-archive")},
        data={"versionName": "1", "versionCode": "1"},
    )
    assert resp.status_code == 403


@pytest.mark.parametrize("role", [UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR], ids=lambda r: r.value)
def test_the_rollout_is_not_for_till_staff(client, role):
    from app.middleware.auth import get_active_tenant_id, get_current_user

    app, http = client
    app.dependency_overrides[get_current_user] = lambda: MagicMock(spec=User, role=role)
    app.dependency_overrides[get_active_tenant_id] = lambda: uuid.uuid4()
    assert http.get("/api/v1/app-releases/rollout").status_code == 403


def test_every_release_route_but_the_rollout_hangs_on_the_super_admin_gate():
    from app.middleware.auth import get_current_machine_admin, get_current_super_admin

    def calls(dependant):
        yield dependant.call
        for sub in dependant.dependencies:
            yield from calls(sub)

    routes = [r for r in R.router.routes if hasattr(r, "dependant")]
    assert len(routes) == 7
    for route in routes:
        gates = set(calls(route.dependant))
        if route.path == "/app-releases/rollout":
            assert get_current_machine_admin in gates
        else:
            assert get_current_super_admin in gates, route.path
