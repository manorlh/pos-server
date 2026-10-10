"""
"גשר לדפדפן" (docs/SPEC_KIOSK.md §28) — the cloud's side of the Windows bridge of a browser kiosk:

* the browser kiosk reports its bridge in `status.health.bridge` (kiosk/sync); the cloud keeps the
  known keys only and shows a "גשר Windows" part in "תקינות מכשירים" — only for a kiosk that has one;
* "התקנת גשר ל-Windows" in the add-device dialog downloads the newest Windows release under the
  bridge's name (the installer reads "bridge" in its own name and starts in bridge mode), for any
  machine admin; nothing uploaded → `available: false` / 404.

The handlers run against the in-memory world of tests/shift_world.py, called directly.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse

from app.config import get_settings
from app.models.app_release import AppRelease
from app.routers import windows_bridge as R
from app.services import app_updates as AU
from app.services import kiosk_health as KH
from shift_world import make_world

INSTALLER = b"MZ" + b"\x90\x00" * 40 + b"This program cannot be run in DOS mode."


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = make_world()
    w.tmp = tmp_path
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    return w


def _win(world, name, *, active=True, minutes=0, platform="windows"):
    path = world.tmp / f"{platform}-{name}.bin"
    data = INSTALLER + name.encode()
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(),
        platform=platform,
        version_code=AU.windows_version_code(name),
        version_name=name,
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        file_path=str(path),
        is_active=active,
        created_at=datetime(2026, 10, 7, 9, minutes, tzinfo=timezone.utc),
    )
    world.db.add(r)
    world.db.commit()
    return r


ADMIN = SimpleNamespace(id=uuid.uuid4())


# ── The health report ─────────────────────────────────────────────────────────


def test_the_bridge_block_is_kept_with_known_keys_only():
    out = KH.clean_health({
        "platform": "web",
        "bridge": {
            "paired": True, "present": True, "linked": True, "version": "0.3.0", "at": "2026-10-07T10:00:00Z",
            "card": True, "print": True, "drawer": "yes", "secret": "never-stored", "token": "x",
        },
    })
    assert out["platform"] == "web"
    assert out["bridge"] == {
        "paired": True, "present": True, "linked": True, "version": "0.3.0", "at": "2026-10-07T10:00:00Z",
        "card": True, "print": True,
    }
    assert "bridge" not in KH.clean_health({"bridge": "on"})
    assert "bridge" not in KH.clean_health({"bridge": {"junk": 1}})


def test_the_bridge_part_only_for_a_kiosk_that_has_one():
    assert KH.bridge_part({}) is None
    assert KH.bridge_part({"platform": "web"}) is None
    ok = KH.bridge_part({"bridge": {"paired": True, "present": True, "linked": True, "version": "0.3.0", "card": True, "print": True}})
    assert (ok["key"], ok["level"], ok["code"]) == ("bridge", "ok", "ok")
    assert ok["detail"] == {"version": "0.3.0", "card": True, "print": True}
    down = KH.bridge_part({"bridge": {"paired": True, "present": False, "at": "2026-10-07T10:00:00Z"}})
    assert (down["level"], down["code"], down["detail"]["at"]) == ("error", "down", "2026-10-07T10:00:00Z")
    assert KH.bridge_part({"bridge": {"paired": False, "present": True}})["code"] == "not_paired"
    assert KH.bridge_part({"bridge": {"paired": True, "present": True, "linked": False}})["code"] == "not_linked"


def test_a_downed_bridge_makes_the_kiosk_red_in_the_overall():
    parts = [KH._part("app", "ok", "running"), KH.bridge_part({"bridge": {"paired": True, "present": False}})]
    assert KH.overall(parts, True) == "error"


# ── The download ──────────────────────────────────────────────────────────────


def test_no_windows_release_says_so(world):
    assert R.get_newest_windows_installer(db=world.db, current_user=ADMIN) == {"available": False}
    with pytest.raises(HTTPException) as exc:
        R.download_newest_windows_installer(flavor=None, db=world.db, current_user=ADMIN)
    assert exc.value.status_code == 404 and exc.value.detail == "windows_release_missing"


def test_the_newest_active_windows_release_under_the_bridges_name(world):
    _win(world, "0.2.0", minutes=1)
    newest = _win(world, "0.3.0", minutes=2)
    _win(world, "0.4.0", active=False, minutes=3)  # retired: never offered
    info = R.get_newest_windows_installer(db=world.db, current_user=ADMIN)
    assert info == {
        "available": True, "versionName": "0.3.0", "sizeBytes": newest.size_bytes, "sha256": newest.sha256,
        "fileName": "R2M-POS-Windows-bridge-setup.exe",
    }
    resp = R.download_newest_windows_installer(flavor=None, db=world.db, current_user=ADMIN)
    assert isinstance(resp, FileResponse)
    assert resp.path == newest.file_path
    assert resp.media_type == "application/vnd.microsoft.portable-executable"
    # The name the installer reads to start as the bridge.
    assert 'filename="R2M-POS-Windows-bridge-setup.exe"' in resp.headers["content-disposition"]
    app = R.download_newest_windows_installer(flavor="app", db=world.db, current_user=ADMIN)
    assert 'filename="R2M-POS-Windows-0.3.0-setup.exe"' in app.headers["content-disposition"]


def test_a_release_whose_file_is_gone_is_not_offered(world):
    r = _win(world, "0.3.0")
    import os

    os.remove(r.file_path)
    assert R.get_newest_windows_installer(db=world.db, current_user=ADMIN) == {"available": False}


def test_the_download_is_for_machine_admins_only():
    """The route's dependency is the machine admins' gate (company / shop manager, distributor, super admin)."""
    routes = {r.path: r for r in R.router.routes if getattr(r, "path", "").endswith("/app-releases/windows/latest/download")}
    assert routes, "the download route is mounted"
    deps = [d.call for d in next(iter(routes.values())).dependant.dependencies]
    assert R.get_current_machine_admin in deps
