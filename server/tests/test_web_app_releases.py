"""
The "web_app" update channel — the signed "r2m-app" screens bundle of every role for every host
(web-till spec v2 §8.1, §8.4; work plan S0-4).

* **The bundle** (app/services/web_bundles.py, `kiosk_web_bundle.py` renamed): kind "r2m-app",
  roles, a protocol this server knows, `shellApi`; `manifest.sig` = Ed25519 over manifest.json
  under a key of `web_bundle_public_keys` — missing, wrong, or no key configured: refused. The
  kiosk web bundle reads exactly as before (and still may not carry an unlisted file).
* **The upload** (`POST /app-releases`, platform "web_app"): `422 invalid_bundle` for anything
  wrong; the release keeps `protocol` and `shellApi` (and `bridgeApi` when the manifest has one).
* **The offer** (`GET /sync/{m}/app-update?platform=web_app&protocol=&shellApi=`): a bundle the
  device's engine or shell cannot run is passed over (`web_app_fits`) — the next assignment in
  order applies; the download resolves with the same filter. `422 invalid_protocol`.
* **`machine_platform`** knows "web" and "ios" (their app is the bundle: "web_app") — they are no
  longer counted as Android devices; `machines_under(…, "web_app")` adds the devices that
  reported on an r2m-app release. Rollback allowed, as for the kiosk bundle.
* **The migration** db2bc1f604fe: on the single head; the CHECK takes "web_app"; two nullable
  columns; idempotent.

Runs on the in-memory SQLite world of tests/shift_world.py, the handlers called directly.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import get_settings
from app.models.app_release import APP_RELEASE_PLATFORMS, AppRelease, AppReleaseAssignment, AppReleaseMachineStatus
from app.models.user import User, UserRole
from app.routers import app_releases as R
from app.routers.sync import get_app_update, get_app_update_apk
from app.schemas.app_release import AppPlatform, AppReleaseAssignmentIn
from app.services import app_updates as AU
from app.services import kiosk_web_bundle as KWB
from app.services import web_bundles as WB
from shift_world import make_world

MIGRATION = "db2bc1f604fe"


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 9, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _keypair():
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return private, public


PRIVATE, PUBLIC = _keypair()
OTHER_PRIVATE, OTHER_PUBLIC = _keypair()
B64 = base64.b64encode(PUBLIC).decode()

_FILES = {
    "index.html": b"<!doctype html><html><body><div id=root></div></body></html>",
    "assets/app-abc.js": b"console.log('r2m-app');",
    "assets/app-abc.css": b"body{margin:0}",
}


def _manifest(files=None, **overrides):
    files = _FILES if files is None else files
    m = {
        "kind": "r2m-app",
        "version": "2026.11.18-1420",
        "versionCode": 988700,
        "roles": ["till", "kiosk", "kds", "board", "display"],
        "protocol": 1,
        "shellApi": {"electron": 1, "android": 1, "ios": 1},
        "bridgeApi": 1,
        "minChrome": 111,
        "minSafari": 16.4,
        "entry": "index.html",
        "builtAt": "2026-11-18T14:20:00.000Z",
        "files": [{"path": p, "sha256": _sha(d), "size": len(d)} for p, d in files.items()],
    }
    m.update(overrides)
    return m


def _bundle(files=None, manifest=None, signer=PRIVATE, signature=None, extra=None, **overrides) -> bytes:
    """A zip: manifest.json, manifest.sig (signed by `signer`, or `signature` as given), the files."""
    files = _FILES if files is None else files
    m = manifest if manifest is not None else _manifest(files, **overrides)
    raw = m if isinstance(m, bytes) else json.dumps(m).encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", raw)
        if signature is not None:
            z.writestr("manifest.sig", signature)
        elif signer is not None:
            z.writestr("manifest.sig", base64.b64encode(signer.sign(raw)).decode() + "\n")
        for path, data in files.items():
            z.writestr(path, data)
        for path, data in (extra or {}).items():
            z.writestr(path, data)
    return buf.getvalue()


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = make_world()
    w.tmp = tmp_path
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    monkeypatch.setattr(get_settings(), "web_bundle_public_keys", B64)
    monkeypatch.setattr(AU, "publish_settings_notify", lambda tenant_id, machine_id, reason: None)
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None)


def _upload(world, data, platform="web_app", **form):
    return R.upload_app_release(
        file=UploadFile(file=io.BytesIO(data), filename="r2m-app.zip"),
        version_name=form.get("version_name"), version_code=form.get("version_code"), notes=None,
        admin=_admin(), db=world.db, platform=platform,
    )


def _refused(world, data, **form) -> str:
    with pytest.raises(HTTPException) as exc:
        _upload(world, data, **form)
    assert exc.value.status_code == 422, exc.value.detail
    assert exc.value.detail["code"] == "invalid_bundle", exc.value.detail
    return exc.value.detail["msg"]


def _release(world, name, code, protocol=1, shell_api=None, minutes=0):
    data = _bundle(version=name, versionCode=code, protocol=protocol)
    path = world.tmp / f"app-{name}.zip"
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(), platform="web_app", version_code=code, version_name=name, sha256=_sha(data),
        size_bytes=len(data), file_path=str(path), protocol=protocol,
        shell_api=shell_api if shell_api is not None else {"electron": 1, "android": 1, "ios": 1},
        is_active=True, created_at=_ts(minutes),
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


def _offer(world, till, code=1, name="0", platform="web_app", **params):
    return get_app_update(
        machine_id=str(till.id), version_code=code, version_name=name, machine=till, db=world.db,
        platform=platform, protocol=params.get("protocol"), shell_api=params.get("shell_api"),
    )


def _platformed(world, till, platform):
    till.platform = platform
    world.db.commit()
    return till


# ── The bundle ───────────────────────────────────────────────────────────────


class TestBundle:
    def test_a_signed_bundle_reads_with_its_roles_protocol_and_shell_api(self, tmp_path):
        path = tmp_path / "b.zip"
        path.write_bytes(_bundle(roles=["till", "kds", "something_new"]))
        m = WB.read_bundle(str(path), WB.KIND_APP, public_keys=[PUBLIC])
        assert (m.kind, m.version, m.version_code, m.protocol, m.bridge_api) == ("r2m-app", "2026.11.18-1420", 988700, 1, 1)
        assert m.shell_api == {"electron": 1, "android": 1, "ios": 1}
        assert m.roles == ("till", "kds")  # an unknown role is ignored
        assert m.signed_by == WB.key_id(PUBLIC) and len(m.signed_by) == 16
        assert {f.path for f in m.files} == set(_FILES)

    def test_the_signature_is_required_and_checked(self, tmp_path):
        def read(data, keys=(PUBLIC,)):
            path = tmp_path / f"{uuid.uuid4()}.zip"
            path.write_bytes(data)
            with pytest.raises(WB.BundleError) as exc:
                WB.read_bundle(str(path), WB.KIND_APP, public_keys=list(keys))
            return str(exc.value)

        assert "manifest.sig is missing" in read(_bundle(signer=None))
        assert "does not match" in read(_bundle(signer=OTHER_PRIVATE))
        assert "not base64" in read(_bundle(signature=b"!!not base64!!"))
        assert "64 bytes" in read(_bundle(signature=base64.b64encode(b"short")))
        assert "no bundle signing key configured" in read(_bundle(), keys=())
        # A file changed after signing: its hash no longer matches the signed manifest.
        tampered = dict(_FILES)
        signed = _manifest(_FILES)
        tampered["assets/app-abc.js"] = b"console.log('evil!!!');"  # the same size, other bytes
        assert len(tampered["assets/app-abc.js"]) == len(_FILES["assets/app-abc.js"])
        assert "sha256 differs" in read(_bundle(files=tampered, manifest=signed))
        # The manifest changed after signing (a new hash for the changed file): the signature fails.
        raw = json.dumps(_manifest(tampered)).encode()
        sig = base64.b64encode(PRIVATE.sign(json.dumps(signed).encode()))
        assert "does not match" in read(_bundle(files=tampered, manifest=raw, signature=sig))

    def test_a_second_trusted_key_rotates_in(self, tmp_path):
        path = tmp_path / "b.zip"
        path.write_bytes(_bundle(signer=OTHER_PRIVATE))
        m = WB.read_bundle(str(path), WB.KIND_APP, public_keys=[PUBLIC, OTHER_PUBLIC])
        assert m.signed_by == WB.key_id(OTHER_PUBLIC)

    def test_the_manifest_rules(self):
        ok = _manifest()
        assert WB.parse_app_manifest(ok).protocol == 1
        for change, words in (
            ({"kind": "r2m-kiosk-web"}, "kind"),
            ({"protocol": 2}, "not one this server knows"),
            ({"protocol": 0}, "protocol"),
            ({"protocol": "1"}, "protocol"),
            ({"roles": []}, "roles"),
            ({"roles": ["printer"]}, "name none"),
            ({"shellApi": {"electron": -1}}, "shellApi.electron"),
            ({"shellApi": [1]}, "shellApi"),
            ({"bridgeApi": 0}, "bridgeApi"),
        ):
            with pytest.raises(WB.BundleError) as exc:
                WB.parse_app_manifest({**ok, **change})
            assert words in str(exc.value), change
        # Optional: shellApi (nothing needed) and bridgeApi.
        bare = {k: v for k, v in ok.items() if k not in ("shellApi", "bridgeApi")}
        m = WB.parse_app_manifest(bare)
        assert (m.shell_api, m.bridge_api) == ({}, None)
        with pytest.raises(WB.BundleError):
            WB.parse_app_manifest({**ok, "files": [*ok["files"], {"path": "manifest.sig", "sha256": "0" * 64, "size": 1}]})

    def test_the_public_keys_setting(self):
        assert WB.parse_public_keys("") == []
        assert WB.parse_public_keys(f" {B64}, {base64.b64encode(OTHER_PUBLIC).decode()}\n{B64}") == [PUBLIC, OTHER_PUBLIC]
        for bad in ("not-base64!", base64.b64encode(b"x" * 31).decode()):
            with pytest.raises(WB.BundleError):
                WB.parse_public_keys(bad)

    def test_the_kiosk_web_bundle_reads_as_before(self, tmp_path):
        files = {"index.html": b"<html></html>"}
        manifest = {
            "kind": "r2m-kiosk-web", "version": "2026.10.07-1530", "versionCode": 913530, "bridgeApi": 1,
            "entry": "index.html", "files": [{"path": "index.html", "sha256": _sha(files["index.html"]), "size": 13}],
        }
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("manifest.json", json.dumps(manifest))
            z.writestr("index.html", files["index.html"])
        path = tmp_path / "k.zip"
        path.write_bytes(buf.getvalue())
        m = KWB.read_bundle(str(path))  # the old module name, unchanged
        assert (m.kind, m.bridge_api, m.protocol, m.signed_by) == ("r2m-kiosk-web", 1, None, None)
        assert KWB.parse_manifest(manifest).version_code == 913530 and KWB.BUNDLE_KIND == "r2m-kiosk-web"
        # A kiosk bundle is not signed: a manifest.sig in it is a file the manifest does not list.
        with zipfile.ZipFile(path, "a") as z:
            z.writestr("manifest.sig", "x")
        with pytest.raises(WB.BundleError) as exc:
            KWB.read_bundle(str(path))
        assert "manifest.sig is in the zip but not in the manifest" in str(exc.value)


# ── The upload ───────────────────────────────────────────────────────────────


class TestUpload:
    def test_a_web_app_upload_keeps_protocol_and_shell_api(self, world):
        data = _bundle(shellApi={"electron": 2, "ios": 1})
        out = _upload(world, data)
        body = out.model_dump(by_alias=True)
        assert (body["platform"], body["versionName"], body["versionCode"], body["protocol"], body["shellApi"], body["bridgeApi"]) == (
            "web_app", "2026.11.18-1420", 988700, 1, {"electron": 2, "ios": 1}, 1,
        )
        stored = world.db.query(AppRelease).one()
        assert (stored.platform, stored.protocol, stored.shell_api, stored.sha256) == ("web_app", 1, {"electron": 2, "ios": 1}, _sha(data))
        assert stored.file_path.endswith(f"{stored.id}.zip")
        assert [r.version_name for r in R.list_app_releases(_admin=_admin(), db=world.db, platform="web_app")] == ["2026.11.18-1420"]

    def test_an_unsigned_or_wrongly_signed_bundle_is_refused(self, world, monkeypatch):
        assert "manifest.sig is missing" in _refused(world, _bundle(signer=None))
        assert "does not match" in _refused(world, _bundle(signer=OTHER_PRIVATE))
        monkeypatch.setattr(get_settings(), "web_bundle_public_keys", "")
        assert "no bundle signing key configured" in _refused(world, _bundle())
        assert world.db.query(AppRelease).count() == 0
        assert not any((world.tmp / "releases").iterdir())  # nothing left on disk

    def test_an_unknown_protocol_or_a_kiosk_bundle_is_refused(self, world):
        assert "not one this server knows" in _refused(world, _bundle(protocol=7))
        kiosk = _manifest(kind="r2m-kiosk-web")
        assert "kind must be 'r2m-app'" in _refused(world, _bundle(manifest=kiosk))

    def test_a_typed_version_must_agree(self, world):
        with pytest.raises(HTTPException) as exc:
            _upload(world, _bundle(), version_name="2026.11.18-1421")
        assert exc.value.detail["code"] == "bundle_version_mismatch"

    def test_the_platform_sets_agree(self):
        assert AU.PLATFORMS == APP_RELEASE_PLATFORMS
        assert set(AppPlatform.__args__) == set(APP_RELEASE_PLATFORMS)
        assert AU.normalize_platform(" WEB_APP ") == "web_app"
        check = next(c for c in AppRelease.__table__.constraints if getattr(c, "name", None) == "ck_app_releases_platform")
        assert "'web_app'" in str(check.sqltext)
        assert set(WB.KIND_OF_PLATFORM) == {"kiosk_web", "web_app"}


# ── The offer ────────────────────────────────────────────────────────────────


class TestOffer:
    def test_a_browser_is_offered_its_bundle_with_protocol_and_shell_api(self, world):
        till = _platformed(world, world.tills[0], "web")
        rel = _release(world, "2026.11.18-1420", 988700)
        _assign(world, rel, "shop", world.shop.id, auto_install=True)
        body = _offer(world, till, protocol="1", shell_api=0).model_dump(by_alias=True)
        assert (body["available"], body["platform"], body["versionName"], body["protocol"], body["shellApi"]) == (
            True, "web_app", "2026.11.18-1420", 1, {"electron": 1, "android": 1, "ios": 1},
        )
        assert body["autoInstall"] is True and body["bridgeApi"] is None
        # Nothing said: nothing filtered.
        assert _offer(world, till).available is True
        # The APK's own call never sees it.
        assert _offer(world, till, platform=None).available is False

    def test_a_bundle_the_engine_does_not_speak_is_passed_over(self, world):
        till = world.tills[0]
        old = _release(world, "2026.11.01-0900", 900000, protocol=1, minutes=0)
        new = _release(world, "2026.12.01-0900", 990000, protocol=2, minutes=1)
        _assign(world, old, "tenant", world.tenant.id, minutes=0)
        _assign(world, new, "shop", world.shop.id, minutes=10)
        assert _offer(world, till, protocol="2").version_name == "2026.12.01-0900"
        assert _offer(world, till, protocol="1-2").version_name == "2026.12.01-0900"
        # An engine on protocol 1 keeps to the bundle it can run.
        on_one = _offer(world, till, protocol="1")
        assert (on_one.available, on_one.version_name, on_one.protocol) == (True, "2026.11.01-0900", 1)
        # Already on it: nothing — never the newer bundle it cannot run.
        assert _offer(world, till, code=900000, name="2026.11.01-0900", protocol="1").available is False
        assert _offer(world, till, protocol="3").available is False

    def test_a_shell_too_old_for_the_bundle_is_passed_over(self, world):
        windows = _platformed(world, world.tills[0], "windows")
        ipad = _platformed(world, world.tills[1], "ios")
        old = _release(world, "2026.11.01-0900", 900000, shell_api={"electron": 1, "ios": 1})
        new = _release(world, "2026.12.01-0900", 990000, shell_api={"electron": 3, "ios": 2}, minutes=1)
        _assign(world, old, "tenant", world.tenant.id, minutes=0)
        _assign(world, new, "shop", world.shop.id, minutes=10)
        assert _offer(world, windows, shell_api=3).version_name == "2026.12.01-0900"
        assert _offer(world, windows, shell_api=2).version_name == "2026.11.01-0900"
        assert _offer(world, ipad, shell_api=2).version_name == "2026.12.01-0900"
        assert _offer(world, ipad, shell_api=1).version_name == "2026.11.01-0900"
        # A browser has no shell: the shell API never holds it back.
        browser = _platformed(world, world.tills[1], "web")
        assert _offer(world, browser, shell_api=0).version_name == "2026.12.01-0900"

    def test_the_download_resolves_with_the_same_filter(self, world):
        till = world.tills[0]
        old = _release(world, "2026.11.01-0900", 900000, protocol=1)
        new = _release(world, "2026.12.01-0900", 990000, protocol=2, minutes=1)
        _assign(world, old, "tenant", world.tenant.id, minutes=0)
        _assign(world, new, "shop", world.shop.id, minutes=10)
        resp = get_app_update_apk(
            machine_id=str(till.id), release_id=old.id, machine=till, db=world.db, protocol="1", shell_api=None,
        )
        assert isinstance(resp, FileResponse) and resp.path == old.file_path
        assert (resp.media_type, resp.filename) == ("application/zip", "r2m-app-2026.11.01-0900.zip")
        with pytest.raises(HTTPException) as exc:  # without the filter it resolves to the newer one
            get_app_update_apk(machine_id=str(till.id), release_id=old.id, machine=till, db=world.db)
        assert exc.value.status_code == 404
        assert get_app_update_apk(
            machine_id=str(till.id), release_id=new.id, machine=till, db=world.db,
        ).path == new.file_path

    def test_a_malformed_protocol_is_422(self, world):
        for bad in ("x", "2-1", "0", "1-", "1..2..3"):
            with pytest.raises(HTTPException) as exc:
                _offer(world, world.tills[0], protocol=bad)
            assert (exc.value.status_code, exc.value.detail) == (422, "invalid_protocol"), bad
        assert AU.parse_protocol_range("1..3") == (1, 3) and AU.parse_protocol_range(" 2 ") == (2, 2)
        assert AU.parse_protocol_range(None) is None and AU.parse_protocol_range("") is None
        # Other platforms ignore the parameters.
        assert _offer(world, world.tills[0], platform="kiosk_web", protocol="x").available is False

    def test_fits_only_ever_filters_web_app(self):
        rel = SimpleNamespace(platform="web_app", protocol=2, shell_api={"android": 2})
        assert AU.web_app_fits(rel, "android", 2, (2, 2)) is True
        assert AU.web_app_fits(rel, "android", 1, None) is False
        assert AU.web_app_fits(rel, "electron", 0, None) is True  # not named: needs nothing
        assert AU.web_app_fits(rel, "browser", 0, (1, 1)) is False
        assert AU.web_app_fits(SimpleNamespace(platform="android", protocol=None), "android", 0, (9, 9)) is True

    def test_a_bundle_may_be_rolled_back(self, world):
        till = world.tills[0]
        older = _release(world, "2026.11.01-0900", 900000)
        _release(world, "2026.12.01-0900", 990000, minutes=1)
        out = R.create_app_release_assignment(
            release_id=older.id,
            body=AppReleaseAssignmentIn(level="machine", targetId=till.id, allowDowngrade=True),
            background_tasks=BackgroundTasks(), admin=_admin(), db=world.db,
        )
        assert (out.platform, out.allow_downgrade) == ("web_app", True)
        back = _offer(world, till, code=990000, name="2026.12.01-0900")
        assert (back.available, back.version_name, back.allow_downgrade) == (True, "2026.11.01-0900", True)


# ── Which devices ────────────────────────────────────────────────────────────


class TestDevices:
    def test_machine_platform_knows_the_browser_and_ios(self):
        for platform, expected in (("web", "web_app"), ("ios", "web_app"), ("windows", "windows"), ("android", "android")):
            assert AU.machine_platform(SimpleNamespace(platform=platform, device_info=None)) == expected, platform
        # An older row with no stored platform: what the device said at pairing.
        assert AU.machine_platform(SimpleNamespace(platform=None, device_info={"platform": "web"})) == "web_app"
        assert AU.machine_platform(SimpleNamespace(platform=None, device_info={"platform": "Windows "})) == "windows"
        assert AU.machine_platform(SimpleNamespace(device_info={"model": "N55F"})) == "android"
        assert AU.shell_of_machine(SimpleNamespace(platform="windows")) == "electron"
        assert AU.shell_of_machine(SimpleNamespace(platform="web")) == "browser"
        assert AU.shell_of_machine(SimpleNamespace(platform="ios")) == "ios"
        assert AU.shell_of_machine(SimpleNamespace(platform=None, device_info=None)) == "android"

    def test_web_app_reaches_the_browsers_and_the_devices_that_reported(self, world):
        browser = _platformed(world, world.tills[0], "web")
        apk = world.tills[1]
        rel = _release(world, "2026.11.18-1420", 988700)
        assert [m.id for m in AU.machines_under(world.db, "shop", world.shop.id, platform="web_app")] == [browser.id]
        # A browser is no longer counted as an Android device.
        assert browser.id not in {m.id for m in AU.machines_under(world.db, "shop", world.shop.id, platform="android")}
        world.db.add(AppReleaseMachineStatus(
            id=uuid.uuid4(), machine_id=apk.id, release_id=rel.id, status="installed", created_at=_ts(), updated_at=_ts(),
        ))
        world.db.commit()
        reached = {m.id for m in AU.machines_under(world.db, "shop", world.shop.id, platform="web_app")}
        assert reached == {browser.id, apk.id}


# ── The migration ────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self, monkeypatch):
        import importlib.util

        path = next(Path(__file__).absolute().parents[1].glob(f"alembic/versions/{MIGRATION}_*.py"))
        spec = importlib.util.spec_from_file_location("web_app_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "context", SimpleNamespace(is_offline_mode=lambda: False))
        return module

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert MIGRATION in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision(MIGRATION).down_revision == "b8e2d4f6a1c3"

    def test_adds_the_columns_once(self, monkeypatch):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module(monkeypatch)
        # SQLite: no ALTER of a CHECK — exercise the columns, the CHECK step is a no-op stub here.
        monkeypatch.setattr(module, "_check_sql", lambda insp, table, name: "platform IN ('web_app')")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.exec_driver_sql("CREATE TABLE app_releases (id CHAR(32) PRIMARY KEY, platform VARCHAR(16))")
            for _ in range(2):  # idempotent: the second run finds them
                with Operations.context(MigrationContext.configure(conn)):
                    module.upgrade()
            columns = {c["name"] for c in sa.inspect(conn).get_columns("app_releases")}
        assert {"protocol", "shell_api"} <= columns

    def test_the_check_takes_web_app(self):
        sql = _render(f"b8e2d4f6a1c3:{MIGRATION}")
        assert "DROP CONSTRAINT ck_app_releases_platform" in sql
        assert "CHECK (platform IN ('android', 'windows', 'kiosk_web', 'web_app'))" in sql
        assert "ADD COLUMN protocol INTEGER" in sql and "ADD COLUMN shell_api JSONB" in sql


def _render(*args) -> str:
    import logging
    import os

    from alembic import command
    from alembic.config import Config

    here = Path(__file__).absolute().parents[1]
    buf = io.StringIO()
    cfg = Config(os.path.join(here, "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", os.path.join(here, "alembic"))
    # alembic's env.py runs fileConfig(), which disables every existing logger: put them back,
    # or a later test's caplog sees nothing (tests/test_till_roles.py `_render`).
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    try:
        command.upgrade(cfg, *args, sql=True)
    finally:
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())
