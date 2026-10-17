"""
"Windows 7 (קופה)" — the Windows app's build for old PCs runs the till only (app/services/windows7.py,
P:/specs/windows7-till.md).

* The device says so at pairing (`device_info.appBuild == "win7"`): a code of another role is refused before anything
  is created (422 `windows7_till_only`); a till code pairs it as a Windows till.
* The dashboard's `windows7: true` code request: a Windows till licensed "קופה בלבד" only.
* A role change of such a machine to anything but the till: 409 `windows7_till_only`.
* App updates: its releases are a platform of their own, `windows7` — it is never offered a standard ("windows",
  Electron 44) installer, nor a standard device a `windows7` one; the rollout lists it as `windows7`.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router / service functions.
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import UploadFile
from fastapi.responses import FileResponse, JSONResponse

from app.config import get_settings
from app.models.app_release import AppRelease, AppReleaseAssignment
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.routers import app_releases as R
from app.routers import pairing as pairing_router
from app.routers.sync import get_app_update, get_app_update_apk
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeValidate
from app.services import app_updates as AU
from app.services import device_profile
from app.services import display_devices as DD
from app.services import pairing as P
from app.services import register_number
from app.services import till_parameters as TP
from app.services import windows7 as W7
from shift_world import accept_str_uuids, make_world

WIN7_INFO = {"platform": "windows", "appBuild": "win7", "model": "Windows kiosk"}
WIN10_INFO = {"platform": "windows", "model": "Windows kiosk"}
_INSTALLER = b"MZ" + b"\x90\x00" * 40 + b"This program cannot be run in DOS mode."


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


@pytest.fixture
def w(monkeypatch, tmp_path):
    accept_str_uuids(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "7"))
    world.tmp = tmp_path
    # Committed (a refusal rolls back), not expired (SQLite reads `expires_at` back naive).
    world.db.expire_on_commit = False
    world.db.commit()
    return world


# ── The pure rules ────────────────────────────────────────────────────────────


def test_the_device_is_the_windows7_build_only_when_it_says_so_on_windows():
    assert W7.is_windows7_device_info(WIN7_INFO) is True
    assert W7.is_windows7_device_info({"platform": "Windows", "appBuild": " WIN7 "}) is True
    assert W7.is_windows7_device_info(WIN10_INFO) is False
    assert W7.is_windows7_device_info({"platform": "android", "appBuild": "win7"}) is False
    assert W7.is_windows7_device_info(None) is False
    assert W7.is_windows7_machine(SimpleNamespace(device_info=WIN7_INFO)) is True
    assert W7.role_allowed(None) and W7.role_allowed("till")
    for role in ("kiosk", "kds", "order_status_board", "customer_display", "local_server", "cash_host"):
        assert not W7.role_allowed(role), role


def test_the_dashboard_request_must_be_a_windows_till_licensed_till_only():
    assert W7.check_pairing_request("windows", "till", None) is None
    assert W7.check_pairing_request(None, None, "till") is None
    assert W7.check_pairing_request("android", "till", None)["detail"] == W7.NOT_WINDOWS
    assert W7.check_pairing_request("windows", "kiosk", None)["detail"] == W7.TILL_ONLY
    assert W7.check_pairing_request("windows", "till", "kiosk_till")["detail"] == W7.LICENSE_TILL_ONLY
    assert "Windows 7" in W7.TILL_ONLY_MESSAGE and "קופה בלבד" in W7.TILL_ONLY_MESSAGE


# ── Pairing ───────────────────────────────────────────────────────────────────


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _code(w, *, role, platform=None, shop=True) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"W{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=w.shop.id if shop else None, device_role=role, platform=platform,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


class TestGenerate:
    def test_a_windows7_code_is_a_windows_till_licensed_till_only(self, w):
        out = _generate(w, deviceRole="till", platform="windows", windows7=True)
        assert not isinstance(out, JSONResponse), out
        code = w.db.query(PairingCode).filter(PairingCode.code == out.code).one()
        assert (code.platform, code.device_role or "till", code.license_product) == ("windows", "till", "till")

    def test_no_platform_means_windows(self, w):
        out = _generate(w, deviceRole="till", windows7=True)
        assert w.db.query(PairingCode).filter(PairingCode.code == out.code).one().platform == "windows"

    @pytest.mark.parametrize(
        "body, detail",
        [
            ({"deviceRole": "kiosk", "shopId": "SHOP", "platform": "windows"}, W7.TILL_ONLY),
            ({"deviceRole": "kds", "shopId": "SHOP", "platform": "windows"}, W7.TILL_ONLY),
            ({"deviceRole": "till", "platform": "android"}, W7.NOT_WINDOWS),
            ({"deviceRole": "till", "platform": "windows", "licenseProduct": "kiosk_till"}, W7.LICENSE_TILL_ONLY),
        ],
    )
    def test_anything_else_is_refused_while_the_dialog_is_open(self, w, body, detail):
        before = w.db.query(PairingCode).count()
        body = {k: (w.shop.id if v == "SHOP" else v) for k, v in body.items()}
        out = _generate(w, windows7=True, **body)
        assert isinstance(out, JSONResponse), out
        assert out.status_code == 422 and json.loads(out.body)["detail"] == detail
        assert w.db.query(PairingCode).count() == before


class TestValidate:
    def _validate(self, w, code, info):
        w.db.expire_on_commit = False
        w.db.commit()
        return pairing_router.validate_pairing(PairingCodeValidate(code=code.code, device_info=info), db=w.db)

    @pytest.mark.parametrize("role", ["kiosk", "kds", "order_status_board", "cash_host"])
    def test_the_windows7_build_never_pairs_as_another_role(self, w, role):
        code = _code(w, role=role, platform="windows")
        before = w.db.query(POSMachine).count()
        out = self._validate(w, code, WIN7_INFO)
        assert isinstance(out, JSONResponse), out
        body = json.loads(out.body)
        assert (out.status_code, body["detail"], body["codeRole"]) == (422, W7.TILL_ONLY, role)
        assert "Windows 7" in body["message"]
        assert w.db.query(POSMachine).count() == before
        assert w.db.get(PairingCode, code.id).is_used is False

    def test_a_till_code_pairs_it_as_a_windows_till(self, w):
        code = _code(w, role="till", platform="windows")  # kept: the session holds it weakly
        machine = P.validate_pairing_code(w.db, code.code, WIN7_INFO, "קופה ישנה")
        assert machine is not None and machine.platform == "windows" and machine.is_fiscal is True
        assert AU.machine_platform(machine) == AU.PLATFORM_WINDOWS7

    def test_a_code_without_a_role_is_a_till_s(self, w):
        code = _code(w, role=None, platform="windows")
        assert P.validate_pairing_code(w.db, code.code, WIN7_INFO, "x") is not None

    def test_the_standard_windows_build_is_not_limited(self, w):
        code = _code(w, role="kds", platform="windows")
        assert DD.check_platform(code, WIN10_INFO) == "windows"
        with pytest.raises(DD.PlatformMismatch):
            DD.check_platform(code, WIN7_INFO)


def test_a_windows7_machine_is_never_made_another_role(w):
    code = _code(w, role="till", platform="windows")
    machine = P.validate_pairing_code(w.db, code.code, WIN7_INFO, "קופה")
    with pytest.raises(device_profile.DeviceProfileRefused) as exc:
        device_profile.check_role_switch(w.db, machine, "kiosk")
    assert exc.value.status_code == 409 and exc.value.body["detail"] == W7.TILL_ONLY
    device_profile.check_role_switch(w.db, machine, "till")  # the same role passes


# ── App updates ───────────────────────────────────────────────────────────────


def _release(w, name, platform, minutes=0):
    path = w.tmp / f"{platform}-{name}.exe"
    data = _INSTALLER + name.encode()
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(), platform=platform, version_code=AU.windows_version_code(name), version_name=name,
        sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), file_path=str(path), is_active=True,
        created_at=_ts(minutes),
    )
    w.db.add(r)
    w.db.commit()
    return r


def _assign(w, release, level, target_id):
    a = AppReleaseAssignment(
        id=uuid.uuid4(), release_id=release.id, level=level, target_id=target_id, tenant_id=w.tenant.id,
        auto_install=False, created_at=_ts(),
    )
    w.db.add(a)
    w.db.commit()
    return a


def _offer(w, machine, platform):
    return get_app_update(machine_id=str(machine.id), version_code=5_000, version_name="0.5.0", machine=machine, db=w.db, platform=platform)


def test_the_platform_rules():
    assert AU.normalize_platform("Windows7") == "windows7"
    assert "windows7" in AU.PLATFORMS and "windows7" in AU.DOWNGRADE_PLATFORMS and "windows7" in AU.WINDOWS_PLATFORMS
    assert AU.machine_platform(SimpleNamespace(device_info=WIN7_INFO)) == "windows7"
    assert AU.machine_platform(SimpleNamespace(device_info=WIN10_INFO)) == "windows"
    assert AU.version_from_installer_name("R2M-POS-Win7-Till-setup-0.5.11.exe") == "0.5.11"
    assert AU.version_from_installer_name("R2M-POS-Windows-0.5.11-setup.exe") == "0.5.11"


def test_windows7_and_windows_releases_never_reach_each_other(w):
    standard = _release(w, "0.6.0", "windows")
    legacy = _release(w, "0.6.0", "windows7")  # the same version name: unique within its platform only
    _assign(w, standard, "shop", w.shop.id)
    _assign(w, legacy, "shop", w.shop.id)
    till = w.tills[0]

    as_win7 = _offer(w, till, "windows7")
    assert (as_win7.available, as_win7.platform, as_win7.release_id) == (True, "windows7", str(legacy.id))
    assert as_win7.allow_downgrade is False
    as_win = _offer(w, till, "windows")
    assert (as_win.available, as_win.platform, as_win.release_id) == (True, "windows", str(standard.id))

    exe = get_app_update_apk(machine_id=str(till.id), release_id=legacy.id, machine=till, db=w.db)
    assert isinstance(exe, FileResponse) and exe.filename == "R2M-POS-Win7-Till-setup-0.6.0.exe"

    # Only a standard release assigned: the Windows 7 build is offered nothing.
    other = w.tills[1]
    only_standard = _release(w, "0.7.0", "windows", minutes=5)
    _assign(w, only_standard, "machine", other.id)
    w.db.query(AppReleaseAssignment).filter(AppReleaseAssignment.release_id == legacy.id).delete()
    w.db.commit()
    assert _offer(w, other, "windows7").available is False
    assert _offer(w, other, "windows").version_name == "0.7.0"


def test_upload_a_windows7_installer_by_its_file_name(w):
    out = R.upload_app_release(
        file=UploadFile(file=io.BytesIO(_INSTALLER), filename="R2M-POS-Win7-Till-setup-0.5.11.exe"),
        version_name=None, version_code=None, notes=None,
        admin=SimpleNamespace(id=None), db=w.db, platform="windows7",
    )
    assert (out.platform, out.version_name, out.version_code) == ("windows7", "0.5.11", 5_011)
    stored = w.db.query(AppRelease).one()
    assert stored.file_path.endswith(".exe")


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self, monkeypatch, offline=False):
        import importlib.util
        from pathlib import Path

        path = next(Path(__file__).absolute().parents[1].glob("alembic/versions/b7e3a9d1c5f2_*.py"))
        spec = importlib.util.spec_from_file_location("app_release_windows7_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "context", SimpleNamespace(is_offline_mode=lambda: offline))
        return module

    def test_on_the_single_head(self):
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "b7e3a9d1c5f2" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("b7e3a9d1c5f2").down_revision == "a1d5e8c3b7f2"

    def test_the_check_gets_windows7_and_sqlite_is_left_to_the_model(self, monkeypatch):
        module = self._module(monkeypatch)
        assert "'windows7'" in module.PLATFORMS_SQL and "'windows7'" not in module.OLD_PLATFORMS_SQL
        for value in ("android", "windows", "kiosk_web"):
            assert f"'{value}'" in module.PLATFORMS_SQL and f"'{value}'" in module.OLD_PLATFORMS_SQL
        # The model's own CHECK says the same.
        ck = next(c for c in AppRelease.__table__.constraints if getattr(c, "name", None) == module.CK_PLATFORM)
        assert "'windows7'" in str(ck.sqltext)

        calls = []
        monkeypatch.setattr(module, "op", SimpleNamespace(
            get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
            drop_constraint=lambda *a, **k: calls.append(("drop", a)),
            create_check_constraint=lambda *a, **k: calls.append(("create", a)),
        ))
        module.upgrade()
        module.downgrade()
        assert calls == []

    def test_postgres_drops_and_makes_the_check_again_once(self, monkeypatch):
        calls = []
        state = {"sql": "platform IN ('android', 'windows', 'kiosk_web')"}
        module = self._module(monkeypatch)

        class Insp:
            def has_table(self, name):
                return True

            def get_check_constraints(self, table):
                return [{"name": module.CK_PLATFORM, "sqltext": state["sql"]}]

        def create(name, table, sql):
            calls.append(("create", sql))
            state["sql"] = sql

        monkeypatch.setattr(module, "op", SimpleNamespace(
            get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql")),
            drop_constraint=lambda name, table, type_: calls.append(("drop", name)),
            create_check_constraint=create,
        ))
        monkeypatch.setattr(module, "_inspector", lambda: Insp())
        module.upgrade()
        module.upgrade()  # idempotent: the second run finds windows7 there
        assert calls == [("drop", module.CK_PLATFORM), ("create", module.PLATFORMS_SQL)]
        module.downgrade()
        assert calls[-1] == ("create", module.OLD_PLATFORMS_SQL)
