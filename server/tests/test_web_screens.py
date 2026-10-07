"""
The browser KDS and "מסך מוכן / לא מוכן" board (`/kds`, `/board` on the dashboard's own site —
client/src/components/screen-web, docs/SPEC_KDS.md §13): display devices on the "web" platform.

* **Pairing.** A "דפדפן (Web)" code is a kiosk's, a KDS's or a board's — never a till's
  (`web_platform_not_a_till`). A browser redeeming a web KDS / board code becomes a display device:
  `platform = "web"`, `is_fiscal = false`, no register number, its `kds_devices` row (the board's
  role `pickup`). A code of another platform refuses the browser, and a web code refuses an Android
  / Windows device — before anything is created.
* **What it may call.** The KDS endpoints answer it (`kds/device`, `kds/board`, `kds/actions`: a web
  station bumps an item, the web board reads numbers only and is read-only); every fiscal endpoint
  refuses it (403 `device_not_fiscal`), as for any display device.
* **The board's look** (`kds_devices.display`): saved from the KDS page, cleaned, sent with the
  screen in `kds/board`; a save without it keeps it. The KDS page marks a browser screen (`platform`).

Runs on the in-memory SQLite worlds of tests/shift_world.py and tests/test_kds.py.
"""
from __future__ import annotations

import json
import re
import types
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.models.kds import KdsDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.printers import KitchenStation
from app.routers import kds as kds_router
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.kds import KdsDeviceIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeValidate
from app.services import display_devices as DD
from app.services import kiosk_control
from app.services import pairing as P
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world
from test_kds import act, board, device, item, kd, release  # noqa: F401
from test_kitchen_printers import k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401

#: What the browser screens send at pairing (lib/kioskWebApi.ts `webDeviceInfo`, client r2m-web-<route>).
WEB_KDS = {"platform": "web", "client": "r2m-web-kds", "browser": "Chrome", "os": "Android", "model": "SM-T220", "manufacturer": "browser"}
WEB_BOARD = {"platform": "web", "client": "r2m-web-board", "browser": "Edge", "os": "Windows", "model": "Windows PC", "manufacturer": "browser"}


@pytest.fixture
def sw(monkeypatch):
    """The pairing world (shift_world): a tenant, a company, a shop, two tills, a grill station."""
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    TP.ensure_builtin_parameters(world.db)
    world.grill = KitchenStation(id=uuid.uuid4(), tenant_id=world.tenant.id, name="גריל")
    world.db.add(world.grill)
    world.db.commit()
    return world


def _generate(world, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _code(world, *, role, platform, options=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"S{uuid.uuid4().hex[:7].upper()}", distributor_id=world.admin.id,
        tenant_id=world.tenant.id, shop_id=world.shop.id, device_role=role, platform=platform,
        kds_options=options, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    world.db.add(code)
    world.db.flush()
    return code


def _screen(world, machine) -> KdsDevice:
    return world.db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).one()


def _pair_web(world, role, options, info):
    code = _code(world, role=role, platform="web", options=options)
    return P.validate_pairing_code(world.db, code.code, info, "מסך דפדפן")


# ── Pairing ───────────────────────────────────────────────────────────────────


class TestWebCodes:
    def test_a_web_code_is_a_kiosks_a_kds_or_a_boards(self, sw):
        kds = _generate(
            sw, shopId=sw.shop.id, deviceRole="kds", platform="web",
            kds={"name": "גריל", "screenRole": "station", "stationIds": [str(sw.grill.id)]},
        )
        assert (kds.device_role, kds.platform, kds.kds_options["screenRole"]) == ("kds", "web", "station")
        board_code = _generate(sw, shopId=sw.shop.id, deviceRole="order_status_board", platform="web")
        assert (board_code.device_role, board_code.platform, board_code.kds_options["screenRole"]) == ("order_status_board", "web", "pickup")
        kiosk = _generate(sw, shopId=sw.shop.id, deviceRole="kiosk", platform="web")
        assert (kiosk.device_role, kiosk.platform) == ("kiosk", "web")

    def test_never_a_tills(self, sw):
        status_code, body = _refusal(_generate(sw, deviceRole="till", platform="web"))
        assert (status_code, body["detail"]) == (422, "web_platform_not_a_till")
        assert "קופה" in body["message"] and "מסך מטבח" in body["message"]
        assert DD.web_platform_refusal("web", None) is not None
        for role in ("kiosk", "kds", "order_status_board"):
            assert DD.web_platform_refusal("web", role) is None
        assert DD.web_platform_refusal("android", "till") is None

    def test_a_screen_still_needs_its_shop_and_station(self, sw):
        status_code, body = _refusal(_generate(sw, deviceRole="kds", platform="web"))
        assert (status_code, body["detail"]) == (400, "kds_requires_shop")
        status_code, body = _refusal(_generate(sw, shopId=sw.shop.id, deviceRole="kds", platform="web", kds={"screenRole": "station"}))
        assert (status_code, body["detail"]) == (422, "station_device_needs_a_station")


class TestWebPairing:
    def test_a_browser_kds_is_a_web_display_device(self, sw):
        machine = _pair_web(sw, "kds", {"name": "גריל", "screenRole": "station", "stationIds": [str(sw.grill.id)]}, WEB_KDS)
        assert (machine.platform, machine.is_fiscal, machine.pos_number, machine.document_prefix) == ("web", False, None, None)
        assert (machine.shop_id, machine.pairing_status) == (sw.shop.id, PairingStatus.ASSIGNED)
        assert machine.device_info["client"] == "r2m-web-kds" and DD.platform_of(machine) == "web"
        screen = _screen(sw, machine)
        assert (screen.role, screen.station_ids, screen.name) == ("station", [str(sw.grill.id)], "גריל")
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["fiscal"], me["platform"], me["posNumber"]) == ("kds", False, "web", None)

    def test_a_browser_board_is_a_pickup_screen(self, sw):
        machine = _pair_web(sw, "order_status_board", {"name": None, "screenRole": "pickup", "stationIds": []}, WEB_BOARD)
        assert (machine.platform, machine.is_fiscal) == ("web", False)
        assert _screen(sw, machine).role == "pickup"
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["platform"]) == ("order_status_board", "web")

    @pytest.mark.parametrize(
        "code_platform, info, device",
        [("android", WEB_KDS, "web"), ("windows", WEB_BOARD, "web"), ("web", {"model": "F20"}, "android"), ("web", {"platform": "windows"}, "windows")],
    )
    def test_another_platform_is_refused_before_anything_is_created(self, sw, code_platform, info, device):
        code = _code(sw, role="kds", platform=code_platform, options={})
        sw.db.expire_on_commit = False
        sw.db.commit()
        before = sw.db.query(POSMachine).count()
        status_code, body = _refusal(pairing_router.validate_pairing(PairingCodeValidate(code=code.code, device_info=info), db=sw.db))
        assert (status_code, body["detail"], body["codePlatform"], body["devicePlatform"]) == (422, "platform_mismatch", code_platform, device)
        assert sw.db.query(POSMachine).count() == before
        assert sw.db.get(PairingCode, code.id).is_used is False


# ── What a browser screen may call ────────────────────────────────────────────


class TestWebScreenAccess:
    def test_the_kds_endpoints_answer_it(self, sw):
        kds = _pair_web(sw, "kds", {"name": "Expo", "screenRole": "expo", "stationIds": []}, WEB_KDS)
        out = kds_router.get_kds_device(str(kds.id), machine=kds, db=sw.db)
        assert out["device"]["role"] == "expo" and out["shopName"] == sw.shop.name
        b = kds_router.get_kds_board(str(kds.id), since=None, machine=kds, db=sw.db)
        assert (b["syncType"], b["device"]["role"], b["orders"]) == ("full", "expo", [])
        board_machine = _pair_web(sw, "order_status_board", {"screenRole": "pickup", "stationIds": []}, WEB_BOARD)
        p = kds_router.get_kds_board(str(board_machine.id), since=None, machine=board_machine, db=sw.db)
        assert p["pickup"] == {"preparing": [], "ready": [], "serverTime": p["pickup"]["serverTime"]}
        assert "orders" not in p
        # It is seen: the KDS page's "נראה לאחרונה".
        assert _screen(sw, board_machine).last_seen_at is not None

    def test_every_fiscal_dependency_refuses_it(self, sw):
        from app.middleware import auth

        machine = _pair_web(sw, "kds", {"screenRole": "expo"}, WEB_KDS)
        for dep in (auth.require_fiscal_machine, auth.require_fiscal_machine_token):
            with pytest.raises(DD.DeviceNotFiscal) as exc:
                dep(machine=machine)
            assert (exc.value.status_code, exc.value.body["detail"]) == (403, "device_not_fiscal")

    @pytest.mark.parametrize(
        "method, path",
        [("POST", "/sync/{m}/transactions"), ("POST", "/sync/{m}/shifts"), ("POST", "/sync/{m}/till-z"),
         ("POST", "/sync/{m}/kiosk/open-orders"), ("POST", "/sync/{m}/prepaid-vouchers/redeem")],
    )
    def test_over_http_a_web_screen_is_refused_as_a_till(self, method, path):
        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.main import app
        from app.middleware import auth

        screen = types.SimpleNamespace(id=uuid.uuid4(), tenant_id=None, shop_id=None, is_fiscal=False, platform="web")

        def _db():
            yield MagicMock()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[auth.get_pos_machine_for_sync_path] = lambda: screen
        app.dependency_overrides[auth.get_pos_machine_from_sync_machine_token] = lambda: screen
        try:
            url = "/api/v1" + re.sub(r"\{[^}]+\}", str(screen.id), path)
            res = TestClient(app).request(method, url, json={}, headers={"Authorization": "Bearer x"})
        finally:
            for dep in (get_db, auth.get_pos_machine_for_sync_path, auth.get_pos_machine_from_sync_machine_token):
                app.dependency_overrides.pop(dep, None)
        assert res.status_code == 403, res.text
        assert res.json()["detail"] == "device_not_fiscal"


def _webify(machine):
    """What a browser pairing makes of a screen machine (TestWebPairing): web, non-fiscal, no number."""
    machine.platform = "web"
    machine.is_fiscal = False
    machine.pos_number = None
    machine.device_info = dict(WEB_KDS)
    return machine


class TestWebKitchen:
    def test_a_web_station_bumps_and_the_web_board_shows_the_number(self, kd):
        _webify(kd.grill_screen)
        _webify(kd.pickup_screen)
        kd.db.flush()
        a = release(kd, source="kiosk", ref="w1", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        grill = board(kd, kd.grill_screen)
        task = grill["orders"][0]["tasks"][0]
        out = act(kd, kd.grill_screen, "item_ready", taskId=task["id"], expectedVersion=task["version"])
        assert out["outcome"] == "applied"
        ready = board(kd, kd.pickup_screen)["pickup"]["ready"]
        assert [r["number"] for r in ready] == [str(a["pickupNumber"])]
        # The board reads; it never acts.
        with pytest.raises(Exception) as exc:
            act(kd, kd.pickup_screen, "handover", orderId=a["orderId"])
        assert "pickup_screen_is_read_only" in str(getattr(exc.value, "detail", exc.value))

    def test_the_kds_page_marks_a_browser_screen(self, kd):
        _webify(kd.expo_screen)
        kd.db.flush()
        out = kds_router.get_kds_shop(kd.shop.id, **_ctx(kd))
        platforms = {m["id"]: m["platform"] for m in out["machines"]}
        assert platforms[str(kd.expo_screen.id)] == "web"
        assert platforms[str(kd.waiter.id)] == "android"


class TestBoardLook:
    def test_saved_cleaned_and_sent_with_the_screen(self, kd):
        body = KdsDeviceIn(
            role="pickup", name="TV", display={"theme": "light", "accent": "#16A34A", "sound": False, "showPreparing": False, "title": "  איסוף   הזמנות "},
        )
        out = kds_router.put_kds_device(kd.shop.id, kd.pickup_screen.id, body, **_ctx(kd))
        want = {"theme": "light", "accent": "#16a34a", "sound": False, "showPreparing": False, "title": "איסוף הזמנות"}
        # The v1 keys as saved; every v2 key (docs/SPEC_KDS.md §14) at today's look.
        assert {k: out["display"][k] for k in want} == want
        assert out["display"]["v"] == 2 and out["display"]["boardLayout"] == "columns" and out["display"]["layout"] == "tickets"
        b = board(kd, kd.pickup_screen)
        assert b["device"]["display"] == out["display"] and "pickup" in b
        # A save without it (an older dashboard, a pairing) keeps it.
        kds_router.put_kds_device(kd.shop.id, kd.pickup_screen.id, KdsDeviceIn(role="pickup", name="TV 2"), **_ctx(kd))
        assert board(kd, kd.pickup_screen)["device"]["display"] == out["display"]

    def test_none_set_is_null_and_a_bad_value_is_refused(self, kd):
        assert board(kd, kd.expo_screen)["device"]["display"] is None
        for bad in ({"theme": "neon"}, {"accent": "green"}, {"accent": "#12345"}, {"title": "x" * 61}):
            with pytest.raises(ValidationError):
                KdsDeviceIn(role="pickup", display=bad)

    def test_a_stored_value_is_cleaned_on_the_way_out(self):
        from app.services import kds as KDS

        assert KDS.display_out(None) is None
        out = KDS.display_out({"theme": "neon", "accent": "red", "sound": None, "title": ""})
        assert {k: out[k] for k in ("theme", "accent", "sound", "showPreparing", "title")} == {
            "theme": "dark", "accent": None, "sound": True, "showPreparing": True, "title": None,
        }
