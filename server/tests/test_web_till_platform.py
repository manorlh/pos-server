"""
"קופת WEB" — the till on the "web" (browser) and "ios" (iPad / iPhone shell) platforms, behind
`WEB_TILL_ENABLED` (off) — web-till spec v2 §9.1, work plan S0-3.

* **Off (the default): nothing changes.** A web code is a kiosk's, a KDS's or a board's; a till's is
  refused (422 `web_platform_not_a_till`, the same message as before). An iOS code follows the same
  rules, with its own message. A browser / iOS kiosk is not made a till on the machine page, nor by
  "back to a regular till" on the kiosks page.
* **On:** a web / iOS till code is made, and the device that redeems it is an ordinary fiscal till
  (`platform` web / ios, a register number, `deviceRole` till).
* **"ios" is a platform:** the schema takes it, the device says it, and a code for one platform
  refuses a device of another (`platform_mismatch`) in both directions.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router / service functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.routers import kiosks as KR
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeValidate
from app.services import device_profile as DP
from app.services import display_devices as DD
from app.services import kiosk_control
from app.services import pairing as P
from app.services import register_number
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

WEB_TILL = {"platform": "web", "client": "r2m-app-till", "browser": "Chrome", "os": "Windows", "model": "Windows PC", "manufacturer": "browser"}
IOS_TILL = {"platform": "ios", "client": "r2m-shell-ios", "os": "iPadOS 17.5", "model": "iPad13,18", "manufacturer": "Apple"}
WEB_KIOSK = {"platform": "web", "client": "r2m-web-kiosk", "browser": "Chrome", "os": "Android", "model": "SM-T220", "manufacturer": "browser"}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "9"))
    TP.ensure_builtin_parameters(world.db)
    world.db.commit()
    return world


@pytest.fixture
def on(monkeypatch):
    """WEB_TILL_ENABLED on, for this test only."""
    monkeypatch.setattr(get_settings(), "web_till_enabled", True)
    assert DD.web_till_enabled() is True


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _code(w, *, role, platform) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"T{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=w.shop.id, device_role=role, platform=platform,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def _web_kiosk(w, platform="web", info=WEB_KIOSK) -> POSMachine:
    """A browser (or iOS) kiosk, paired by its code: its `kiosk_devices` row and all."""
    code = _code(w, role="kiosk", platform=platform)
    machine = P.validate_pairing_code(w.db, code.code, info, "קיוסק דפדפן")
    assert DP.current_role(w.db, machine) == "kiosk" and DD.platform_of(machine) == platform
    return machine


# ── The switch ────────────────────────────────────────────────────────────────


def test_the_switch_is_off_by_default():
    assert Settings.model_fields["web_till_enabled"].default is False
    assert DD.web_till_enabled() is False


def test_the_roles_of_each_platform(monkeypatch):
    assert DD.roles_for_platform("android") == DD.ROLES
    assert DD.roles_for_platform("windows") == DD.ROLES
    assert DD.roles_for_platform(None) == DD.ROLES
    for platform in ("web", "ios"):
        assert DD.roles_for_platform(platform) == ("kiosk", "kds", "order_status_board")
    monkeypatch.setattr(get_settings(), "web_till_enabled", True)
    for platform in ("web", "ios"):
        assert set(DD.roles_for_platform(platform)) == {"till", "kiosk", "kds", "order_status_board"}
    assert DD.roles_for_platform("android") == DD.ROLES


# ── "ios" is a platform ───────────────────────────────────────────────────────


def test_ios_is_a_platform():
    assert DD.PLATFORM_IOS == "ios" and "ios" in DD.PLATFORMS
    assert DD.PLATFORM_LABELS["ios"] == "iPad / iPhone (iOS)"
    assert DD.WEB_TILL_PLATFORMS == ("web", "ios")
    assert DD.platform_of_device_info(IOS_TILL) == "ios"
    assert DD.platform_of_device_info({"platform": " IOS"}) == "ios"
    # Unchanged for every other device.
    assert DD.platform_of_device_info(WEB_TILL) == "web"
    assert DD.platform_of_device_info({"platform": "windows"}) == "windows"
    assert DD.platform_of_device_info({"platform": "macos"}) == "android"
    assert DD.platform_of_device_info(None) == "android"


def test_the_schema_takes_ios():
    assert PairingCodeGenerateRequest(deviceRole="kiosk", platform="ios").platform == "ios"
    with pytest.raises(ValidationError):
        PairingCodeGenerateRequest(deviceRole="kiosk", platform="macos")


# ── Off: the refusals of today ────────────────────────────────────────────────


class TestOff:
    def test_a_web_till_code_is_refused_as_before(self, w):
        for role in ("till", None):
            body = {"deviceRole": role} if role else {}
            status_code, out = _refusal(_generate(w, platform="web", **body))
            assert (status_code, out) == (422, {"detail": "web_platform_not_a_till", "message": DD.WEB_PLATFORM_NOT_A_TILL_MESSAGE})

    def test_an_ios_till_code_is_refused_with_its_own_words(self, w):
        status_code, out = _refusal(_generate(w, deviceRole="till", platform="ios"))
        assert (status_code, out["detail"]) == (422, "web_platform_not_a_till")
        assert out["message"] == DD.IOS_PLATFORM_NOT_A_TILL_MESSAGE
        assert "iPad" in out["message"] and "לא קופה" in out["message"]

    def test_the_other_roles_and_platforms_are_untouched(self, w):
        for platform in ("web", "ios"):
            kiosk = _generate(w, shopId=w.shop.id, deviceRole="kiosk", platform=platform)
            assert (kiosk.device_role, kiosk.platform) == ("kiosk", platform)
            board = _generate(w, shopId=w.shop.id, deviceRole="order_status_board", platform=platform)
            assert (board.device_role, board.platform) == ("order_status_board", platform)
        for platform in ("android", "windows"):
            till = _generate(w, shopId=w.shop.id, deviceRole="till", platform=platform)
            assert (till.device_role, till.platform) == ("till", platform)
        assert DD.web_platform_refusal("android", "till") is None
        assert DD.web_platform_refusal("windows", None) is None
        assert DD.web_platform_refusal(None, "till") is None

    def test_a_web_kiosk_is_not_made_a_till_on_the_machine_page(self, w):
        machine = _web_kiosk(w)
        with pytest.raises(DP.DeviceProfileRefused) as refused:
            DP.check_role_switch(w.db, machine, "till")
        assert refused.value.status_code == 422
        assert refused.value.body["detail"] == "web_platform_not_a_till"
        assert refused.value.body["machineId"] == str(machine.id)
        # Its other moves are the same as for any kiosk / display device.
        with pytest.raises(DP.DeviceProfileRefused) as display:
            DP.check_role_switch(w.db, machine, "kds")
        assert display.value.body["detail"] == "device_role_change_requires_pairing"

    def test_nor_back_to_a_till_on_the_kiosks_page(self, w):
        machine = _web_kiosk(w)
        status_code, out = _refusal(
            KR.delete_kiosk(machine_id=machine.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        )
        assert (status_code, out["detail"]) == (422, "web_platform_not_a_till")
        assert DP.current_role(w.db, machine) == "kiosk"

    def test_an_android_kiosk_still_goes_back_to_a_till(self, w):
        code = _code(w, role="kiosk", platform="android")
        machine = P.validate_pairing_code(w.db, code.code, {"model": "F20"}, "קיוסק")
        assert DP.current_role(w.db, machine) == "kiosk"
        out = KR.delete_kiosk(machine_id=machine.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out.status_code == 204
        assert DP.current_role(w.db, machine) == "till"


# ── On: the web till ──────────────────────────────────────────────────────────


@pytest.mark.usefixtures("on")
class TestOn:
    @pytest.mark.parametrize("platform", ["web", "ios"])
    def test_a_till_code_is_made(self, w, platform):
        code = _generate(w, shopId=w.shop.id, deviceRole="till", platform=platform)
        assert (code.device_role, code.platform) == ("till", platform)
        assert DD.web_platform_refusal(platform, "till") is None
        assert DD.web_platform_refusal(platform, None) is None

    @pytest.mark.parametrize("platform, info", [("web", WEB_TILL), ("ios", IOS_TILL)])
    def test_the_device_is_an_ordinary_fiscal_till(self, w, platform, info):
        code = _code(w, role="till", platform=platform)
        machine = P.validate_pairing_code(w.db, code.code, info, "קופת WEB")
        assert (machine.platform, machine.is_fiscal, machine.shop_id) == (platform, True, w.shop.id)
        assert machine.pos_number == "9"
        assert DP.current_role(w.db, machine) == "till" and DD.platform_of(machine) == platform
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["fiscal"], me["platform"]) == ("till", True, platform)

    def test_a_web_kiosk_may_become_a_till(self, w):
        machine = _web_kiosk(w)
        try:
            DP.check_role_switch(w.db, machine, "till")
        except DP.DeviceProfileRefused as refused:  # the rules of any kiosk may still say no
            assert refused.body["detail"] != "web_platform_not_a_till"


# ── Platforms never cross ─────────────────────────────────────────────────────


@pytest.mark.usefixtures("on")
@pytest.mark.parametrize(
    "code_platform, info, device",
    [
        ("ios", WEB_TILL, "web"),
        ("ios", {"model": "F20"}, "android"),
        ("ios", {"platform": "windows"}, "windows"),
        ("web", IOS_TILL, "ios"),
        ("android", IOS_TILL, "ios"),
        ("windows", IOS_TILL, "ios"),
    ],
)
def test_a_code_of_another_platform_refuses_the_device_before_anything_is_created(w, code_platform, info, device):
    code = _code(w, role="till", platform=code_platform)
    w.db.expire_on_commit = False
    w.db.commit()
    before = w.db.query(POSMachine).count()
    status_code, body = _refusal(pairing_router.validate_pairing(PairingCodeValidate(code=code.code, device_info=info), db=w.db))
    assert (status_code, body["detail"], body["codePlatform"], body["devicePlatform"]) == (422, "platform_mismatch", code_platform, device)
    assert w.db.query(POSMachine).count() == before
    assert w.db.get(PairingCode, code.id).is_used is False
