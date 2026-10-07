"""
The browser kiosk (`/k` on the dashboard's own site — client/src/components/kiosk-web,
docs/SPEC_KIOSK.md §27): a kiosk on the "web" platform.

* Pairing: a code for "דפדפן (Web)" is a kiosk's (or a KDS / board's — test_web_screens.py), never a till's; the browser says `device_info.platform =
  "web"` and is stored so (the dashboard tells it apart); a code for another platform refuses it,
  and a web code refuses a till — before anything is created.
* Its health and its funnel keep "web" as the platform.
* What it SENDS — the open order of "מזומן בקופה" (it never writes a tax document) — is pinned as a
  golden fixture built by its own code (client/src/lib/kioskWebOrders.test.ts writes
  tests/fixtures/kiosk_web/open_order.json): it validates against the cloud's schema, its money
  adds up, its basket is the till's held-sale form (pos-android HeldSaleCodec) the paying till
  rebuilds, and it lands as an open order the shop's tills list.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router / service functions.
"""
from __future__ import annotations

import json
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.responses import JSONResponse

from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.routers import kiosks as KR
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.kiosk import KioskCreateIn
from app.schemas.kiosk_open_orders import KioskOpenOrderIn, KioskOpenOrdersIn
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeValidate
from app.services import ably_notify
from app.services import display_devices as DD
from app.services import kiosk_control
from app.services import kiosk_funnel
from app.services import kiosk_health
from app.services import kiosk_open_orders as S
from app.services import pairing as P
from app.services import register_number
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "kiosk_web" / "open_order.json"
WEB_DEVICE = {"platform": "web", "client": "r2m-web-kiosk", "browser": "Chrome", "os": "Android", "model": "SM-T220", "manufacturer": "browser"}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    world.woken = []
    monkeypatch.setattr(ably_notify, "publish_notify", lambda tenant, machine, event, body: world.woken.append((machine, event)))
    TP.ensure_builtin_parameters(world.db)
    world.db.commit()
    return world


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


def _code(w, *, role, platform):
    code = PairingCode(
        id=uuid.uuid4(), code=f"W{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=w.shop.id, device_role=role, platform=platform,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def fixture_orders() -> list:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["orders"]


# ── The platform ──────────────────────────────────────────────────────────────


def test_the_browser_says_web_and_is_web():
    assert DD.platform_of_device_info(WEB_DEVICE) == "web"
    assert DD.platform_of_device_info({"platform": "WEB "}) == "web"
    assert DD.platform_of_device_info({"platform": "windows"}) == "windows"
    assert DD.platform_of_device_info({}) == "android"
    assert "web" in DD.PLATFORMS and DD.PLATFORM_LABELS["web"]


def test_a_web_code_is_never_a_tills(w):
    # The browser runs the kiosk (`/k`) — and the KDS / board (`/kds`, `/board`: tests/test_web_screens.py).
    code = _generate(w, shopId=w.shop.id, deviceRole="kiosk", platform="web")
    assert (code.device_role, code.platform) == ("kiosk", "web")
    status_code, body = _refusal(_generate(w, deviceRole="till", platform="web"))
    assert (status_code, body["detail"]) == (422, "web_platform_not_a_till")
    assert "קיוסק" in body["message"]


def test_a_web_kiosk_pairs_as_web(w, monkeypatch):
    monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "8"))
    code = _code(w, role="kiosk", platform="web")
    machine = P.validate_pairing_code(w.db, code.code, WEB_DEVICE, "קיוסק דפדפן")
    assert machine.platform == "web"
    assert machine.device_info["platform"] == "web" and machine.device_info["browser"] == "Chrome"
    assert DD.platform_of(machine) == "web"


@pytest.mark.parametrize(
    "code_platform, info, device",
    [("android", WEB_DEVICE, "web"), ("windows", WEB_DEVICE, "web"), ("web", {"model": "F20"}, "android"), ("web", {"platform": "windows"}, "windows")],
)
def test_another_platforms_code_refuses_it_before_anything_is_created(w, code_platform, info, device):
    code = _code(w, role="kiosk", platform=code_platform)
    w.db.expire_on_commit = False
    w.db.commit()
    before = w.db.query(POSMachine).count()
    status_code, body = _refusal(pairing_router.validate_pairing(PairingCodeValidate(code=code.code, device_info=info), db=w.db))
    assert (status_code, body["detail"], body["codePlatform"], body["devicePlatform"]) == (422, "platform_mismatch", code_platform, device)
    assert "דפדפן" in body["message"]
    assert w.db.query(POSMachine).count() == before
    assert w.db.get(PairingCode, code.id).is_used is False


def test_its_health_and_its_funnel_keep_web():
    assert kiosk_health.clean_health({"platform": "web", "screen": "catalog"})["platform"] == "web"
    now = datetime.now(timezone.utc)
    event = kiosk_funnel.clean_event({"sessionId": "s1", "seq": 1, "type": "session_start", "at": now.isoformat(), "data": {"platform": "web"}}, now)
    assert event is not None and event["data"]["platform"] == "web"


# ── What it sends: the open order ─────────────────────────────────────────────


def test_the_open_order_validates_and_adds_up():
    body = KioskOpenOrdersIn.model_validate({"orders": fixture_orders()})
    (raw,) = body.orders
    order = KioskOpenOrderIn.model_validate(raw)
    assert order.state == "open" and order.kitchen_sent is False
    assert order.due_agorot == order.total_agorot + order.tip_agorot - order.voucher_agorot == 8900
    assert sum(line.total_agorot for line in order.lines) == order.total_agorot
    assert order.vouchers[0].redeemed[0].product_id == "p-burger"


def test_its_basket_is_the_tills_held_sale():
    (raw,) = fixture_orders()
    cart = raw["cart"]
    assert cart["fulfillment"] == "BON" and cart["bon"]["mode"] in ("routing", "single")
    held = json.loads(cart["codec"])
    assert held["cartId"] == raw["localId"]
    lines = {line["id"]: line for line in held["lines"]}
    burger = lines["l1"]
    # HeldSaleCodec.decode: the product is a JSON string; prices in agorot; the details v1 in shekels.
    product = json.loads(burger["product"])
    assert product["id"] == product["cloudId"] == "p-burger" and product["price"] == 5400
    assert burger["unitPrice"] == 5900 and burger["quantity"] == 2 and burger["discount"] == 0
    details = burger["details"]
    assert details["v"] == 1 and details["basePrice"] == 54
    assert [m["kind"] for m in details["modifiers"]] == ["choice", "addon", "removal"]
    assert sum(m["charged"] for m in details["modifiers"]) * 100 + details["basePrice"] * 100 == burger["unitPrice"]
    # The dish's note once (in the details), never also as the line's note.
    assert details["noteText"] == "עשוי היטב" and burger["notes"] is None
    assert lines["l2"]["details"] is None


def test_it_lands_as_an_open_order_the_shops_tills_list(w):
    kiosk, till = w.tills
    KR.create_kiosk(body=KioskCreateIn(machineId=kiosk.id, name="קיוסק דפדפן"), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    kiosk.platform = "web"
    w.db.commit()
    (raw,) = fixture_orders()
    # Without the voucher (its redemption is another test's): what the till takes is the rest.
    raw = {**raw, "vouchers": [], "voucherAgorot": 0, "dueAgorot": raw["totalAgorot"] + raw["tipAgorot"]}
    created = datetime.fromisoformat(raw["createdAt"].replace("Z", "+00:00"))
    out = S.upsert_from_kiosk(w.db, kiosk, [raw], now=created + timedelta(seconds=2))
    w.db.commit()
    assert out["accepted"] == [raw["localId"]] and out["rejected"] == []
    listed = S.list_for_till(w.db, till, now=created + timedelta(seconds=3))
    (o,) = [x for x in listed if x["localId"] == raw["localId"]]
    assert o["pickupLabel"] == "W-17" and o["dueAgorot"] == 14300
    assert json.loads(o["cart"]["codec"])["lines"][0]["unitPrice"] == 5900
    # Posting it again (the kiosk's retry) changes nothing.
    again = S.upsert_from_kiosk(w.db, kiosk, [raw], now=created + timedelta(seconds=4))
    assert again["accepted"] == [raw["localId"]]
