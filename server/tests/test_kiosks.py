"""
The customer self-order KIOSK (app/services/kiosk_config.py, kiosk_pickup.py, kiosk_control.py,
app/routers/kiosks.py; the contract in the coordinator's kiosk_contract.md).

* The config: defaults valid; company → shop → machine merge (objects merge, lists replace,
  null inherits and is dropped on save); strict validation with paths; configVersion; the
  media manifest with the font files, deduped.
* The shop-wide pickup sequence: sequential, idempotent per order key, per shop and per
  date, wraps at max, labels with a prefix.
* Orders: the snapshot is immutable, statuses update, a non-kiosk is refused.
* The kiosk sync: `kiosk: false` for a regular till, the config / state / media / controls
  for a kiosk.
* Commands: pause / resume from the dashboard and from a controlling till; a till that is
  not a controller gets 403 `not_kiosk_controller`; close_shift through `request_close`,
  till_z through `till_z.request_for_machine`, their refusals passed through and audited.
* Permissions and devices: cashier / shift supervisor / another shop's manager refused;
  convert / patch / delete; invalid controllers refused.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse

from app.models.company import Company
from app.models.kiosk import KioskCommand, KioskDevice, KioskOrder, KioskSettings
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import ShiftStatus
from app.models.shift_close_request import ShiftCloseRequest
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.till_z_request import TillZRequest
from app.models.user import User, UserRole
from app.routers import kiosks as R
from app.schemas.kiosk import (
    KioskCommandIn,
    KioskCreateIn,
    KioskOrdersIn,
    KioskPatchIn,
    KioskSettingsIn,
    KioskSyncIn,
    PickupNumberIn,
)
from app.services import ably_notify
from app.services import kiosk_config as C
from app.services import kiosk_control as S
from app.services import kiosk_pickup as P
from shift_world import accept_str_uuids, make_world

SHA = "a" * 64
GF = "https://raw.githubusercontent.com/google/fonts/main"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    world.kiosk, world.till = world.tills  # "Till 1" becomes the kiosk, "Till 2" controls it
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north-mgr", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    world.supervisor = _user(world, "sup", UserRole.SHIFT_SUPERVISOR, shop=world.shop)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    return world


def _user(w, name, role, shop=None, company=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=(company or w.company).id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _till(w, name, shop, tenant=None, code=None):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=(tenant or w.tenant).id, shop_id=shop.id, distributor_id=w.admin.id,
        name=name, machine_code=code or f"X-{uuid.uuid4().hex[:8]}", pos_number=None, is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
        last_heartbeat_at=datetime.now(timezone.utc) - timedelta(seconds=10),
    )
    w.db.add(m)
    w.db.flush()
    return m


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


def convert(w, machine=None, *, controllers=None, user=None, name=None, lock=False):
    body = KioskCreateIn(
        machineId=(machine or w.kiosk).id, name=name,
        controllerMachineIds=[str(c.id) for c in (controllers if controllers is not None else [w.till])],
        lockDevice=lock,
    )
    return R.create_kiosk(body=body, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def put(w, level, entity_id, overrides, user=None):
    return R.put_settings(
        body=KioskSettingsIn(overrides=overrides), level=level, scope_id=entity_id,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def get_settings(w, level, entity_id, user=None):
    return R.get_settings(
        level=level, scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def sync(w, machine, status=None):
    return R.kiosk_sync(
        machine_id=str(machine.id), body=KioskSyncIn(status=status) if status is not None else None,
        machine=machine, db=w.db,
    )


def till_command(w, till, kiosk, action, **extra):
    response = Response()
    out = R.post_till_kiosk_command(
        machine_id=str(till.id), kiosk_machine_id=str(kiosk.id),
        body=KioskCommandIn(action=action, **extra), response=response, machine=till, db=w.db,
    )
    return out, response.status_code


def dashboard_command(w, kiosk, action, user=None, **extra):
    response = Response()
    out = R.post_kiosk_command(
        machine_id=kiosk.id, body=KioskCommandIn(action=action, **extra), response=response,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return out, response.status_code


def order(local_id="o1", **over):
    base = {
        "localId": local_id, "transactionId": None, "transactionNumber": None,
        "pickupNumber": 17, "pickupLabel": "A-17", "businessDate": date.today().isoformat(),
        "serviceType": "take_away", "fulfillmentMode": "BON", "configVersion": "abc",
        "customerName": "דנה", "customerPhone": "0501234567", "itemCount": 2, "totalAgorot": 4500,
        "tipAgorot": 0, "paidAt": datetime.now(timezone.utc).isoformat(), "bonStatus": "queued",
        "receiptStatus": "pending", "status": "paid",
    }
    base.update(over)
    return base


def post_orders(w, machine, *orders):
    return R.post_kiosk_orders(
        machine_id=str(machine.id), body=KioskOrdersIn(orders=list(orders)), machine=machine, db=w.db,
    )


def pickup(w, machine, key, day=None):
    return R.post_pickup_number(
        machine_id=str(machine.id), body=PickupNumberIn(orderKey=key, businessDate=day or date(2026, 10, 6)),
        machine=machine, db=w.db,
    )


def paths(errors):
    return {e.path: e.code for e in errors}


# ── The config: defaults, fonts ──────────────────────────────────────────────


def test_defaults_are_valid_and_complete():
    cfg = C.default_config()
    assert C.validate_config(cfg) == []
    assert cfg["general"]["fulfillmentMode"] == "BON"
    assert cfg["payment"] == {
        "methods": ["card"], "tipEnabled": False, "tipPresets": [10, 12, 15], "receiptPolicy": "always",
        "customerName": "optional", "customerPhone": "off", "tableNumber": "off", "detailsStep": "before_pay", "minOrderAgorot": 0,
        "tipOther": True, "checkoutSteps": ["tip", "details", "payMethod"],
        # "חובה / רשות / כבוי" per step (docs/SPEC_KIOSK_INSIGHTS.md §4).
        "stepModes": {
            "service": "required", "tip": "optional", "payMethod": "required",
            "upsellItem": "optional", "upsellSteps": "optional", "upsellCheckout": "optional",
        },
        # "תשלום בקופה" (§23): an open order expires after this long; the bon waits for the money.
        "cashAtTillExpiryMin": 30, "cashAtTillKitchenBeforePay": False,
        # "לוגו במסך התשלום": its own upload; none by default — nothing shows.
        "waitLogo": {"media": None, "style": "plain"},
        # "פיצול תשלום בכרטיסים" (§23.7): its options; the method itself is off (not in `methods`).
        "splitCard": {"counts": [2, 3, 4], "otherAmount": True, "minPerCardAgorot": 1000},
    }
    assert cfg["printing"] == {
        "bonMode": "routing", "bonPrinterId": None, "bonCopies": 1, "receiptPrinterId": None,
        # One paper (the owner, 08.10.2026): no separate number slip; the number is on the receipt.
        "pickupSlip": False, "orderNumberOnReceipt": True,
        # An unprinted bon prints again by itself when the printer is back, within this many minutes (§16.8).
        "bonAutoRetryMin": 10,
        # "בון מטבח במדפסת הקיוסק" (§5): off — the kiosk never prints the kitchen bon on its own printer.
        "bonOnKiosk": False,
    }
    assert cfg["timers"] == {"inactivitySec": 60, "warningSec": 20, "successSec": 12, "attractSlideSec": 8}
    assert cfg["hours"]["ranges"] == [{"days": [0, 1, 2, 3, 4, 5, 6], "open": "08:00", "close": "23:00"}]
    assert cfg["messages"] == [] and cfg["texts"] == {} and cfg["screenImages"] == {}
    # The defaults are what an empty path resolves to.
    assert C.resolve({}, {}, {}) == cfg


def test_defaults_endpoint_and_font_catalog(w):
    out = R.get_defaults(current_user=w.manager)
    assert out["defaults"] == C.DEFAULT_CONFIG and out["kdsAvailable"] is True  # every kiosk releases to the KDS
    fonts = {f["id"]: f for f in out["fonts"]}
    assert list(fonts)[0] == "system" and fonts["system"]["regular"] is None
    assert fonts["rubik"] == {
        "id": "rubik", "label": "Rubik", "cssFamily": "Rubik",
        "regular": f"{GF}/ofl/rubik/Rubik%5Bwght%5D.ttf", "bold": None, "variable": True,
    }
    assert fonts["alef"]["regular"] == f"{GF}/ofl/alef/Alef-Regular.ttf"
    assert fonts["alef"]["bold"] == f"{GF}/ofl/alef/Alef-Bold.ttf"
    assert fonts["noto_sans_hebrew"]["regular"] == f"{GF}/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf"
    assert len(fonts) == 10
    assert out["limits"]["timers"]["inactivitySec"] == {"min": 15, "max": 600}
    assert "attractTitle" in out["limits"]["textKeys"]
    assert refused(R.get_defaults, current_user=w.cashier).status_code == 403


def test_routes_and_the_422_shape_over_http(monkeypatch):
    """The fixed /kiosks paths come before /kiosks/{machine_id}; the 422 body is the contract's."""
    from unittest.mock import MagicMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user

    order_of = [getattr(r, "path", "") for r in R.router.routes]
    first_param = order_of.index("/kiosks/{machine_id}")
    for fixed in ("/kiosks/defaults", "/kiosks/candidates", "/kiosks/settings", "/kiosks/media"):
        assert order_of.index(fixed) < first_param

    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, email="a@x", username="admin")
    company_id = uuid.uuid4()
    monkeypatch.setattr(
        S, "settings_scope",
        lambda db, user, level, scope_id, tenant_id: S.SettingsScope("company", None, None, company_id=company_id),
    )
    app = FastAPI()
    app.include_router(R.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: MagicMock()
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[get_current_machine_admin] = lambda: admin
    app.dependency_overrides[get_active_tenant_id] = lambda: uuid.uuid4()
    client = TestClient(app)
    assert client.get("/api/v1/kiosks/defaults").json()["defaults"]["printing"]["pickupSlip"] is False
    res = client.put(
        f"/api/v1/kiosks/settings?level=company&id={company_id}",
        json={"overrides": {"theme": {"cornerRadius": 41}}},
    )
    assert res.status_code == 422
    assert res.json() == {"detail": {"code": "invalid_kiosk_config", "errors": [
        {"path": "theme.cornerRadius", "code": "out_of_range", "message": "must be between 0 and 40"},
    ]}}


# ── Media upload ─────────────────────────────────────────────────────────────


def _upload(data: bytes, content_type: str, name: str = "f"):
    import io

    from starlette.datastructures import Headers, UploadFile

    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": content_type}))


def _png() -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (40, 30), (200, 10, 10)).save(out, format="PNG")
    return out.getvalue()


def _media(user, data, content_type, tenant_id=None):
    import asyncio

    return asyncio.run(R.upload_kiosk_media(
        file=_upload(data, content_type), current_user=user, active_tenant_id=tenant_id or uuid.uuid4(),
    ))


def test_media_upload_local_store_answers_the_stored_files_sha256(monkeypatch, tmp_path):
    from app.services import cloudinary_service, local_media

    monkeypatch.setattr(cloudinary_service, "cloudinary_configured", lambda *a, **k: False)
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, email="m@x", username="m")
    tenant_id = uuid.uuid4()

    out = _media(manager, _png(), "image/png", tenant_id)
    assert out["kind"] == "image" and len(out["sha256"]) == 64
    stored = tmp_path / out["url"].split(f"{local_media.MEDIA_PREFIX}/", 1)[1]
    assert f"pos/{tenant_id}/kiosk/" in out["url"]
    assert out["sha256"] == hashlib.sha256(stored.read_bytes()).hexdigest()
    assert out["bytes"] == stored.stat().st_size
    assert C.validate_layer({"theme": {"logo": {"url": out["url"], "kind": "image", "sha256": out["sha256"],
                                                "bytes": out["bytes"]}}})[1] == []

    video = b"\x00\x00\x00\x18ftypmp42" + b"\x01" * 100
    out = _media(manager, video, "video/mp4")
    assert out["kind"] == "video" and out["bytes"] == len(video)
    assert out["sha256"] == hashlib.sha256(video).hexdigest()
    stored = tmp_path / out["url"].split(f"{local_media.MEDIA_PREFIX}/", 1)[1]
    assert stored.read_bytes() == video


def test_media_upload_refusals(monkeypatch, tmp_path):
    from app.middleware.auth import get_current_machine_admin
    from app.services import cloudinary_service, local_media

    monkeypatch.setattr(cloudinary_service, "cloudinary_configured", lambda *a, **k: False)
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    for role in (UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR):
        user = User(id=uuid.uuid4(), role=role, email="c@x", username="c")
        assert refused(get_current_machine_admin, current_user=user).status_code == 403
        assert refused(_media, user, _png(), "image/png").status_code == 403
    admin = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, email="a@x", username="a")
    assert refused(_media, admin, b"GIF89a....", "image/gif").status_code == 415
    assert refused(_media, admin, b"not an image", "image/png").status_code == 400
    assert refused(_media, admin, b"", "video/mp4").status_code == 400
    assert refused(_media, admin, b"\x00" * (25 * 1024 * 1024 + 1), "video/mp4").status_code == 413
    assert list(tmp_path.iterdir()) == []


def test_media_upload_through_cloudinary(monkeypatch):
    import cloudinary.uploader

    from app.services import cloudinary_service

    calls = []
    monkeypatch.setattr(cloudinary_service, "cloudinary_configured", lambda *a, **k: True)
    monkeypatch.setattr(cloudinary_service, "configure_cloudinary", lambda *a, **k: None)

    def fake_upload(contents, **kwargs):
        calls.append(kwargs)
        return {"secure_url": f"https://res.cloudinary.com/x/{kwargs['resource_type']}/1.bin", "bytes": 77}

    monkeypatch.setattr(cloudinary.uploader, "upload", fake_upload)
    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, email="a@x", username="a")
    image = _media(admin, _png(), "image/png")
    assert image == {"url": "https://res.cloudinary.com/x/image/1.bin", "kind": "image", "bytes": 77, "sha256": None}
    video = b"\x1aE\xdf\xa3webm" + b"\x02" * 50
    out = _media(admin, video, "video/webm")
    assert out["sha256"] == hashlib.sha256(video).hexdigest() and out["bytes"] == len(video)
    assert [c["resource_type"] for c in calls] == ["image", "video"]
    assert all(c["folder"].endswith("/kiosk") for c in calls)


# ── Merge ────────────────────────────────────────────────────────────────────


def test_merge_objects_lists_and_null():
    company = {"theme": {"primaryColor": "#111111", "cornerRadius": 10}, "general": {"languages": ["he", "en"]},
               "texts": {"attractTitle": "ברוכים"}}
    shop = {"theme": {"cornerRadius": 30}, "general": {"languages": ["en"]}, "texts": {"cartTitle": "סל"}}
    machine = {"theme": {"primaryColor": None, "logo": {"url": "https://x/l.png", "kind": "image"}}}
    cfg = C.resolve(company, shop, machine)
    assert cfg["theme"]["primaryColor"] == "#111111"          # null inherits
    assert cfg["theme"]["cornerRadius"] == 30                 # the nearer layer wins
    assert cfg["theme"]["accentColor"] == "#16A34A"           # untouched default
    assert cfg["general"]["languages"] == ["en"]              # lists replace
    assert cfg["texts"] == {"attractTitle": "ברוכים", "cartTitle": "סל"}  # maps merge
    assert cfg["theme"]["logo"] == {"url": "https://x/l.png", "kind": "image", "sha256": None, "bytes": None}
    # A MediaRef replaces whole: a later layer's ref never inherits the parent's sha256.
    a = C.resolve({"theme": {"logo": {"url": "https://x/a.png", "kind": "image", "sha256": SHA, "bytes": 5}}},
                  {"theme": {"logo": {"url": "https://x/b.png", "kind": "image"}}})
    assert a["theme"]["logo"] == {"url": "https://x/b.png", "kind": "image", "sha256": None, "bytes": None}


def test_merge_through_the_settings_endpoints(w):
    convert(w)
    put(w, "company", w.company.id, {"theme": {"primaryColor": "#111111", "cornerRadius": 10},
                                     "attract": {"sections": ["hero", "club"]}})
    put(w, "shop", w.shop.id, {"theme": {"cornerRadius": 30}, "attract": {"videoMuted": False}})
    out = put(w, "machine", w.kiosk.id, {"theme": {"primaryColor": None, "mode": "dark"}})
    assert out["overrides"] == {"theme": {"mode": "dark"}}    # null dropped on save
    stored = w.db.query(KioskSettings).filter(KioskSettings.level == "machine").one()
    assert stored.overrides == {"theme": {"mode": "dark"}}
    assert out["inherited"]["theme"]["cornerRadius"] == 30 and out["inherited"]["theme"]["mode"] == "light"
    eff = out["effective"]
    assert eff["theme"]["primaryColor"] == "#111111" and eff["theme"]["cornerRadius"] == 30
    assert eff["theme"]["mode"] == "dark"
    assert {k: v for k, v in eff["attract"].items() if k not in ("cta", "welcome")} == {
        "sections": ["hero", "club"], "playlist": [], "videoMuted": False, "showHelp": True,
    }
    assert eff["attract"]["cta"]["position"] == "bottom_center"
    # "ברוכים הבאים" as it always was (docs/SPEC_KIOSK_LAYOUTS.md).
    assert eff["attract"]["welcome"]["position"] == "bottom" and eff["attract"]["welcome"]["enabled"] is True
    assert out["configVersion"] == C.config_version(eff)
    assert out["updatedBy"] == "admin"
    bundle = R.get_effective(machine_id=w.kiosk.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert bundle["config"] == eff and bundle["configVersion"] == out["configVersion"]
    # The shop's other till is not a kiosk: no machine level for it.
    assert refused(get_settings, w, "machine", w.till.id).detail == "kiosk_not_found"
    # Another shop does not get this shop's layer.
    north = get_settings(w, "shop", w.other_shop.id)
    assert north["effective"]["theme"]["cornerRadius"] == 10 and north["overrides"] == {}


# ── Validation ───────────────────────────────────────────────────────────────


def test_validation_errors_have_paths():
    _cleaned, errors = C.validate_layer({
        "bogus": 1,
        "theme": {"foo": 1, "primaryColor": "blue", "cornerRadius": 41, "logo": {"url": "ftp://x", "kind": "image"}},
        "screenImages": {"nope": None, "pay": {"url": "https://x/p.png", "kind": "image", "sha256": "ABC"}},
        "texts": {"attractTitle": "x" * 201},
        "messages": [{"id": "m1", "kind": "banner", "screens": ["attract", "lobby"], "foo": 1}],
        "printing": {"bonCopies": 4},
    })
    got = paths(errors)
    assert got["bogus"] == "unknown_key"
    assert got["theme.foo"] == "unknown_key"
    assert got["theme.primaryColor"] == "invalid_color"
    assert got["theme.cornerRadius"] == "out_of_range"
    assert got["theme.logo.url"] == "invalid_url"
    assert got["screenImages.nope"] == "unknown_key"
    assert got["screenImages.pay.sha256"] == "invalid_sha256"
    assert got["texts.attractTitle"] == "too_long"
    assert got["messages[0].screens[1]"] == "invalid_value"
    assert got["messages[0].foo"] == "unknown_key"
    assert got["printing.bonCopies"] == "out_of_range"


def test_cross_field_rules(monkeypatch):
    # The KDS switch closed: KDS is refused by its code.
    monkeypatch.setattr(C, "kds_available", lambda: False)

    def errs(layer):
        cleaned, layer_errors = C.validate_layer(layer)
        assert layer_errors == []
        return paths(C.validate_config(C.merge(C.default_config(), cleaned)))

    assert errs({"timers": {"warningSec": 60}})["timers.warningSec"] == "must_be_less"
    assert "timers.warningSec" not in errs({"timers": {"warningSec": 59}})
    assert errs({"printing": {"bonMode": "single"}})["printing.bonPrinterId"] == "required"
    assert errs({"printing": {"bonMode": "single", "bonPrinterId": str(uuid.uuid4())}}) == {}
    assert errs({"general": {"fulfillmentMode": "KDS"}})["general.fulfillmentMode"] == "kds_not_available"
    assert errs({"payment": {"methods": ["card", "cash"]}})["payment.methods[1]"] == "cash_not_supported"
    assert errs({"pickup": {"start": 50, "max": 50}})["pickup.start"] == "must_be_less"
    assert errs({"club": {"enabled": True}})["club.joinUrl"] == "required"
    assert errs({"club": {"enabled": True, "joinUrl": "mailto:x@y"}})["club.joinUrl"] == "invalid_url"
    assert errs({"club": {"enabled": True, "joinUrl": "https://club.example/join"}}) == {}
    assert errs({"messages": [{"id": "a", "kind": "banner"}, {"id": "a", "kind": "notice"}]})["messages[1].id"] == "duplicate"
    assert errs({"messages": [{"id": "a", "kind": "notice", "productId": "p1"}]})["messages[0].productId"] == "banner_only"
    assert errs({"messages": [{"id": "a", "kind": "banner", "startsAt": "2026-10-06T10:00:00+03:00",
                               "endsAt": "2026-10-06T09:00:00+03:00"}]})["messages[0].endsAt"] == "must_be_after"
    # The KDS hook: once available, KDS is accepted.
    monkeypatch.setattr(C, "kds_available", lambda: True)
    assert errs({"general": {"fulfillmentMode": "KDS"}}) == {}


def test_kds_error_message_is_the_token(monkeypatch):
    monkeypatch.setattr(C, "kds_available", lambda: False)
    errors = C.validate_config(C.merge(C.default_config(), {"general": {"fulfillmentMode": "KDS"}}))
    assert [e.to_wire() for e in errors] == [
        {"path": "general.fulfillmentMode", "code": "kds_not_available", "message": "kds_not_available"}
    ]


def test_media_ref_shape():
    good = {"url": "https://cdn.example/a.png", "kind": "image", "sha256": SHA, "bytes": 1234}
    _c, errors = C.validate_layer({"theme": {"backgroundImage": good}})
    assert errors == []
    for bad, path in (
        ({**good, "sha256": "A" * 64}, "theme.backgroundImage.sha256"),
        ({**good, "sha256": "a" * 63}, "theme.backgroundImage.sha256"),
        ({**good, "url": "javascript:alert(1)"}, "theme.backgroundImage.url"),
        ({**good, "url": "https://x/" + "a" * 1000}, "theme.backgroundImage.url"),
        ({**good, "kind": "video"}, "theme.backgroundImage.kind"),
        ({**good, "bytes": -1}, "theme.backgroundImage.bytes"),
        ({**good, "extra": 1}, "theme.backgroundImage.extra"),
    ):
        _c, errors = C.validate_layer({"theme": {"backgroundImage": bad}})
        assert path in paths(errors), (bad, errors)
    # A playlist takes videos.
    _c, errors = C.validate_layer({"attract": {"playlist": [{"media": {**good, "kind": "video"}, "durationSec": 1}]}})
    assert paths(errors) == {"attract.playlist[0].durationSec": "out_of_range"}


def test_put_settings_refuses_with_the_contract_shape(w, monkeypatch):
    monkeypatch.setattr(C, "kds_available", lambda: False)  # the KDS switch closed
    err = refused(put, w, "shop", w.shop.id, {"theme": {"cornerRadius": 99, "nope": 1}})
    assert err.status_code == 422
    assert err.detail["code"] == "invalid_kiosk_config"
    assert {e["path"] for e in err.detail["errors"]} == {"theme.cornerRadius", "theme.nope"}
    assert all(set(e) == {"path", "code", "message"} for e in err.detail["errors"])
    assert w.db.query(KioskSettings).count() == 0
    # KDS and cash, by their codes.
    err = refused(put, w, "shop", w.shop.id, {"general": {"fulfillmentMode": "KDS"}, "payment": {"methods": ["cash"]}})
    assert {(e["path"], e["code"]) for e in err.detail["errors"]} == {
        ("general.fulfillmentMode", "kds_not_available"), ("payment.methods[0]", "cash_not_supported"),
    }


def test_put_settings_validates_on_the_parents(w):
    put(w, "company", w.company.id, {"timers": {"inactivitySec": 30}})
    # 25 < 60 (the default) but not < 30 (the company's): refused for the shop.
    err = refused(put, w, "shop", w.shop.id, {"timers": {"warningSec": 30}})
    assert [(e["path"], e["code"]) for e in err.detail["errors"]] == [("timers.warningSec", "must_be_less")]
    put(w, "shop", w.shop.id, {"timers": {"warningSec": 25}})
    # A parent's later change that breaks a child is repaired in what the kiosk gets.
    put(w, "company", w.company.id, {"timers": {"inactivitySec": 21}})
    eff = get_settings(w, "shop", w.shop.id)["effective"]
    assert eff["timers"]["inactivitySec"] == 21 and eff["timers"]["warningSec"] == 20
    assert C.validate_config(eff) == []


def test_stored_layer_with_stale_keys_is_sanitised():
    cfg = C.resolve({"theme": {"cornerRadius": 12, "retiredKey": True}, "gone": {"x": 1}})
    assert cfg["theme"]["cornerRadius"] == 12 and "retiredKey" not in cfg["theme"] and "gone" not in cfg
    assert C.validate_config(cfg) == []


# ── configVersion and the media manifest ─────────────────────────────────────


def test_config_version_is_stable_and_changes():
    a = C.default_config()
    b = json.loads(json.dumps(a))  # same content, rebuilt
    assert C.config_version(a) == C.config_version(b)
    canonical = json.dumps(a, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert C.config_version(a) == hashlib.sha256(canonical.encode()).hexdigest()[:16]
    assert len(C.config_version(a)) == 16
    b["theme"]["cornerRadius"] = 21
    assert C.config_version(a) != C.config_version(b)


def test_media_manifest_includes_fonts_and_dedupes():
    logo = {"url": "https://cdn.example/logo.png", "kind": "image", "sha256": SHA, "bytes": 10}
    cfg = C.resolve({
        "theme": {"font": "alef", "logo": logo, "backgroundImage": logo},
        "screenImages": {"pay": {"url": "https://cdn.example/pay.png", "kind": "image"}},
        "attract": {"playlist": [
            {"media": {"url": "https://cdn.example/v.mp4", "kind": "video", "sha256": SHA, "bytes": 99}},
            {"media": logo, "durationSec": 5},
        ]},
        "catalog": {"categoryImages": {"c1": {"url": "https://cdn.example/c1.png", "kind": "image"}}},
        "messages": [{"id": "m1", "kind": "banner", "image": {"url": "https://cdn.example/m.png", "kind": "image"}}],
    })
    media = C.media_manifest(cfg)
    urls = [m["url"] for m in media]
    assert len(urls) == len(set(urls))
    assert set(urls) == {
        "https://cdn.example/logo.png", "https://cdn.example/pay.png", "https://cdn.example/v.mp4",
        "https://cdn.example/c1.png", "https://cdn.example/m.png",
        f"{GF}/ofl/alef/Alef-Regular.ttf", f"{GF}/ofl/alef/Alef-Bold.ttf",
    }
    assert {"url": "https://cdn.example/logo.png", "kind": "image", "sha256": SHA, "bytes": 10} in media
    fonts = [m for m in media if m["kind"] == "font"]
    assert len(fonts) == 2 and all(m["sha256"] is None for m in fonts)
    assert cfg["attract"]["playlist"][0]["durationSec"] == 8  # an item's missing key gets its default
    assert C.font_of(cfg)["id"] == "alef"
    assert C.media_manifest(C.default_config()) == []


# ── Pickup numbers ───────────────────────────────────────────────────────────


def test_pickup_label_rule():
    assert P.pickup_label("A", 17) == "A-17"
    assert P.pickup_label("", 17) == "17"
    assert P.pickup_label(None, 5) == "5"
    assert P.next_number(0, 1, 999) == 1
    assert P.next_number(41, 1, 999) == 42
    assert P.next_number(999, 1, 999) == 1
    assert P.next_number(3, 100, 999) == 100


def test_pickup_sequence_is_shop_wide_idempotent_and_wraps(w):
    north_kiosk = w.other_till
    convert(w, controllers=[])
    second = _till(w, "Kiosk 2", w.shop)
    convert(w, second, controllers=[])
    convert(w, north_kiosk, controllers=[])
    put(w, "shop", w.shop.id, {"pickup": {"scope": "shop", "prefix": "A", "start": 5, "max": 7}})

    assert pickup(w, w.kiosk, "k1-o1") == {"number": 5, "label": "A-5"}
    assert pickup(w, second, "k2-o1") == {"number": 6, "label": "A-6"}     # one sequence for the shop
    assert pickup(w, w.kiosk, "k1-o1") == {"number": 5, "label": "A-5"}    # idempotent per key
    assert pickup(w, w.kiosk, "k1-o2") == {"number": 7, "label": "A-7"}
    assert pickup(w, w.kiosk, "k1-o3") == {"number": 5, "label": "A-5"}    # wraps max → start
    # Another shop and another day start their own sequences.
    assert pickup(w, north_kiosk, "n-o1") == {"number": 1, "label": "1"}
    assert pickup(w, w.kiosk, "k1-o1", day=date(2026, 10, 7)) == {"number": 5, "label": "A-5"}
    # A regular till may not draw.
    assert refused(pickup, w, w.till, "x").detail == "not_a_kiosk"


def test_pickup_counter_is_locked_on_postgres(w):
    """SQLite ignores the lock, so the Postgres SQL itself is asserted."""
    from sqlalchemy.dialects import postgresql

    dialect = postgresql.dialect()
    select_sql = str(P.counter_lock_query(w.db, w.shop.id, date(2026, 10, 6)).statement.compile(dialect=dialect))
    assert "FOR UPDATE" in select_sql
    insert_sql = str(P.counter_upsert_statement(w.shop.id, date(2026, 10, 6)).compile(dialect=dialect))
    assert "ON CONFLICT (shop_id, business_date) DO NOTHING" in insert_sql


# ── Orders ───────────────────────────────────────────────────────────────────


def test_order_snapshot_is_immutable_and_statuses_update(w):
    convert(w)
    out = post_orders(w, w.kiosk, order("o1"), order("o2", fulfillmentMode="KDS", serviceType="eat_in", tableRef="12"))
    assert out == {"accepted": ["o1", "o2"], "rejected": []}
    again = post_orders(w, w.kiosk, order(
        "o1", fulfillmentMode="KDS", pickupNumber=99, pickupLabel="99", totalAgorot=1, serviceType="eat_in",
        transactionId="tx-1", transactionNumber="1001",
        bonStatus="printed", bonDetail="printer 1", receiptStatus="printed", status="paid_print_failed",
    ))
    assert again == {"accepted": ["o1"], "rejected": []}
    w.db.expire_all()
    row = w.db.query(KioskOrder).filter(KioskOrder.local_id == "o1").one()
    assert (row.fulfillment_mode, row.pickup_number, row.pickup_label, row.total_agorot, row.service_type) == (
        "BON", 17, "A-17", 4500, "take_away"
    )
    assert (row.bon_status, row.bon_detail, row.receipt_status, row.status) == (
        "printed", "printer 1", "printed", "paid_print_failed"
    )
    # A transaction the first post did not have yet is filled in, once.
    assert (row.transaction_id, row.transaction_number) == ("tx-1", "1001")
    post_orders(w, w.kiosk, order("o1", transactionId="tx-2"))
    w.db.expire_all()
    assert w.db.query(KioskOrder).filter(KioskOrder.local_id == "o1").one().transaction_id == "tx-1"
    assert w.db.query(KioskOrder).count() == 2


def test_bad_order_is_rejected_alone_and_non_kiosk_refused(w):
    convert(w)
    out = post_orders(w, w.kiosk, order("ok"), order("bad", fulfillmentMode="TABLE"), {"nothing": True})
    assert out["accepted"] == ["ok"]
    assert out["rejected"][0] == {"localId": "bad", "reason": "invalid:fulfillmentMode"}
    assert out["rejected"][1]["localId"] is None
    err = refused(post_orders, w, w.till, order("x"))
    assert (err.status_code, err.detail) == (403, "not_a_kiosk")


def test_orders_list_masks_the_phone(w):
    convert(w)
    today = S.business_today(w.db, w.tenant.id)
    post_orders(w, w.kiosk, order("o1", businessDate=today.isoformat()))
    rows = R.get_kiosk_orders(machine_id=w.kiosk.id, day=None, current_user=w.manager,
                              active_tenant_id=w.tenant.id, db=w.db)
    assert rows[0]["customerPhone"] == "*******567"
    rows = R.get_kiosk_orders(machine_id=w.kiosk.id, day=today, current_user=w.company_manager,
                              active_tenant_id=w.tenant.id, db=w.db)
    assert rows[0]["customerPhone"] == "0501234567"
    summary = R.list_kiosks(company_id=None, shop_id=None, current_user=w.admin,
                            active_tenant_id=w.tenant.id, db=w.db)[0]
    assert summary["ordersToday"] == 1 and summary["salesTodayAgorot"] == 4500
    assert summary["lastOrderAt"] is not None


# ── The kiosk sync ───────────────────────────────────────────────────────────


def test_sync_for_a_regular_till(w):
    out = sync(w, w.till)
    assert out["kiosk"] is False and out["controls"] == [] and "serverTime" in out
    assert "config" not in out


def test_sync_for_a_kiosk_and_its_controller(w):
    convert(w, name="קיוסק כניסה")
    put(w, "machine", w.kiosk.id, {"theme": {"font": "rubik"}})
    out = sync(w, w.kiosk, {"flowState": "attract", "shiftOpen": True, "appliedConfigVersion": "old",
                            "mediaReady": False, "mediaMissing": 1, "bonPrinter": "ok", "junk": 1,
                            "unprintedBons": 2, "pendingOrders": 0})
    assert out["kiosk"] is True and out["machineId"] == str(w.kiosk.id) and out["name"] == "קיוסק כניסה"
    assert out["configVersion"] == C.config_version(out["config"])
    assert out["config"]["theme"]["font"] == "rubik" and out["font"]["id"] == "rubik"
    assert out["media"] == [{"url": f"{GF}/ofl/rubik/Rubik%5Bwght%5D.ttf", "kind": "font", "sha256": None, "bytes": None}]
    assert out["state"] == {"paused": False, "message": None, "since": None, "by": None, "until": None, "mode": None}
    assert out["kdsAvailable"] is True and out["controls"] == []
    device = w.db.get(KioskDevice, w.kiosk.id)
    assert device.status["flowState"] == "attract" and "junk" not in device.status
    assert device.last_kiosk_sync_at is not None

    # The controlling till sees the kiosk; not yet on the latest config.
    controls = sync(w, w.till)["controls"]
    assert out_of(controls, w.kiosk)["configUpToDate"] is False
    assert out_of(controls, w.kiosk)["flowState"] == "attract"
    assert out_of(controls, w.kiosk)["unprintedBons"] == 2
    sync(w, w.kiosk, {"appliedConfigVersion": out["configVersion"], "flowState": "weird"})
    summary = out_of(sync(w, w.till)["controls"], w.kiosk)
    assert summary["configUpToDate"] is True and summary["flowState"] == "unknown"
    assert summary["controllers"] == [{"machineId": str(w.till.id), "name": "Till 2"}]
    assert summary["fulfillmentMode"] == "BON" and summary["zMode"] == "cloud"
    # The other shop's till controls nothing.
    assert sync(w, w.other_till)["controls"] == []

    # Disabled: the till works as a regular till until enabled again.
    R.patch_kiosk(machine_id=w.kiosk.id, body=KioskPatchIn(enabled=False), current_user=w.admin,
                  active_tenant_id=w.tenant.id, db=w.db)
    assert sync(w, w.kiosk)["kiosk"] is False


def out_of(summaries, machine):
    return next(s for s in summaries if s["machineId"] == str(machine.id))


# ── Commands ─────────────────────────────────────────────────────────────────


def test_pause_and_resume_from_the_dashboard(w):
    convert(w)
    out, code = dashboard_command(w, w.kiosk, "pause", message="סגור להפסקה")
    assert code == 201 and out["status"] == "applied" and out["source"] == "dashboard"
    assert out["requestedByName"] == "admin"
    state = sync(w, w.kiosk)["state"]
    assert state["paused"] is True and state["message"] == "סגור להפסקה" and state["by"] == "admin"
    assert state["since"] is not None
    dashboard_command(w, w.kiosk, "resume")
    assert sync(w, w.kiosk)["state"] == {"paused": False, "message": None, "since": None, "by": None, "until": None, "mode": None}
    history = R.get_kiosk_commands(machine_id=w.kiosk.id, limit=20, current_user=w.manager,
                                   active_tenant_id=w.tenant.id, db=w.db)
    assert [h["action"] for h in history] == ["resume", "pause"]


def _pos_user(w, first, role):
    from app.models.pos_user import PosUser

    u = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=f"u-{uuid.uuid4().hex[:6]}",
                first_name=first, pin_hash="x", role=role, is_active=True)
    w.db.add(u)
    w.db.flush()
    return u


def test_pause_from_a_controlling_till(w):
    from app.models.pos_user import PosUserRole

    convert(w)
    manager = _pos_user(w, "דנה", PosUserRole.SHOP_MANAGER)
    out, code = till_command(w, w.till, w.kiosk, "pause", posUserId=str(manager.id), posUserName="דנה", message="רגע")
    assert code == 201 and out["source"] == "till" and out["requestedByName"] == "Till 2 · דנה"
    device = w.db.get(KioskDevice, w.kiosk.id)
    assert device.paused is True and device.paused_by == "Till 2 · דנה"
    row = w.db.query(KioskCommand).one()
    assert row.requested_by_machine_id == w.till.id and row.requested_by_user_id is None
    till_command(w, w.till, w.kiosk, "resume", posUserId=str(manager.id))
    w.db.expire_all()
    assert w.db.get(KioskDevice, w.kiosk.id).paused is False


def test_a_till_that_is_not_a_controller_is_refused(w):
    other = _till(w, "Till 3", w.shop)
    convert(w)
    err = refused(till_command, w, other, w.kiosk, "pause")
    assert (err.status_code, err.detail) == (403, "not_kiosk_controller")
    # Across tenants: a till of another tenant naming this kiosk.
    t2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2", timezone="Asia/Jerusalem")
    w.db.add(t2)
    w.db.flush()
    c2 = Company(id=uuid.uuid4(), tenant_id=t2.id, name="Other", vat_number="1")
    w.db.add(c2)
    w.db.flush()
    s2 = Shop(id=uuid.uuid4(), tenant_id=t2.id, company_id=c2.id, name="S2", settings={})
    w.db.add(s2)
    w.db.flush()
    foreign = _till(w, "Foreign", s2, tenant=t2)
    assert refused(till_command, w, foreign, w.kiosk, "pause").detail == "not_kiosk_controller"
    # Naming a till that is no kiosk at all.
    assert refused(till_command, w, w.till, other, "pause").detail == "kiosk_not_found"
    assert w.db.query(KioskCommand).count() == 0


def test_close_shift_goes_through_request_close(w):
    convert(w)
    # No open shift: the existing channel's 409 is passed through, and audited.
    err = refused(till_command, w, w.till, w.kiosk, "close_shift", posUserName="דנה")
    assert (err.status_code, err.detail) == (409, "no_open_shift")
    row = w.db.query(KioskCommand).one()
    assert (row.action, row.status, row.detail, row.source) == ("close_shift", "refused", "no_open_shift", "till")

    w.shift(w.kiosk, 1, status=ShiftStatus.OPEN)
    w.db.commit()
    out, code = till_command(w, w.till, w.kiosk, "close_shift", posUserName="דנה")
    assert code == 201 and out["status"] == "requested"
    req = w.db.query(ShiftCloseRequest).one()
    assert out["requestId"] == str(req.id) and req.machine_id == w.kiosk.id
    assert req.created_by_user_id == w.kiosk.distributor_id
    # From the dashboard, the pending request comes back.
    out, _ = dashboard_command(w, w.kiosk, "close_shift")
    assert out["requestId"] == str(req.id) and out["detail"] == "already_pending"


def test_till_z_refused_for_a_cloud_z_kiosk_and_requested_for_a_till_z_one(w):
    convert(w)
    answer, _ = till_command(w, w.till, w.kiosk, "till_z")
    assert isinstance(answer, JSONResponse) and answer.status_code == 422
    assert json.loads(answer.body)["detail"] == "machine_not_till_z"
    row = w.db.query(KioskCommand).one()
    assert (row.status, row.detail) == ("refused", "machine_not_till_z")

    w.kiosk.z_mode = "till"
    w.db.commit()
    out, code = dashboard_command(w, w.kiosk, "till_z", force=True)
    assert code == 201 and out["status"] == "requested"
    req = w.db.query(TillZRequest).one()
    assert out["requestId"] == str(req.id) and req.force_close is True


# ── Permissions ──────────────────────────────────────────────────────────────


def test_cashier_and_shift_supervisor_are_refused(w):
    convert(w)
    for user in (w.cashier, w.supervisor):
        assert refused(R.list_kiosks, company_id=None, shop_id=None, current_user=user,
                       active_tenant_id=w.tenant.id, db=w.db).status_code == 403
        assert refused(get_settings, w, "shop", w.shop.id, user=user).status_code == 403
        assert refused(R.get_effective, machine_id=w.kiosk.id, current_user=user,
                       active_tenant_id=w.tenant.id, db=w.db).status_code == 403
        assert refused(R.get_candidates, shop_id=None, current_user=user,
                       active_tenant_id=w.tenant.id, db=w.db).status_code == 403


def test_scope_by_role(w):
    convert(w)
    north = _till(w, "North kiosk", w.other_shop)
    convert(w, north, controllers=[])

    def listed(user):
        return {s["machineId"] for s in R.list_kiosks(company_id=None, shop_id=None, current_user=user,
                                                     active_tenant_id=w.tenant.id, db=w.db)}

    assert listed(w.admin) == {str(w.kiosk.id), str(north.id)}
    assert listed(w.company_manager) == {str(w.kiosk.id), str(north.id)}
    assert listed(w.manager) == {str(w.kiosk.id)}
    assert listed(w.north_manager) == {str(north.id)}
    # Another shop's manager: no reading, no settings, no commands for this kiosk.
    assert refused(R.get_effective, machine_id=w.kiosk.id, current_user=w.north_manager,
                   active_tenant_id=w.tenant.id, db=w.db).status_code == 403
    assert refused(put, w, "machine", w.kiosk.id, {}, user=w.north_manager).status_code == 403
    assert refused(put, w, "shop", w.shop.id, {}, user=w.north_manager).status_code == 403
    assert refused(dashboard_command, w, w.kiosk, "pause", user=w.north_manager).status_code == 403
    # A shop manager does not reach the company layer; the company manager does.
    assert refused(get_settings, w, "company", w.company.id, user=w.manager).status_code == 403
    assert get_settings(w, "company", w.company.id, user=w.company_manager)["level"] == "company"
    put(w, "shop", w.shop.id, {"theme": {"mode": "dark"}}, user=w.manager)
    # A distributor: their own tills only.
    distributor = _user(w, "dist", UserRole.DISTRIBUTOR)
    assert listed(distributor) == set()
    w.kiosk.distributor_id = distributor.id
    w.db.commit()
    assert listed(distributor) == {str(w.kiosk.id)}
    # Another tenant's active tenant id.
    assert refused(R.get_effective, machine_id=w.kiosk.id, current_user=w.admin,
                   active_tenant_id=uuid.uuid4(), db=w.db).detail == "tenant_forbidden"


# ── Devices ──────────────────────────────────────────────────────────────────


def test_convert_patch_delete(w):
    candidates = R.get_candidates(shop_id=w.shop.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    assert {c["machineId"] for c in candidates} == {str(w.kiosk.id), str(w.till.id)}

    summary = convert(w, user=w.manager)
    assert summary["machineId"] == str(w.kiosk.id) and summary["name"] == "Till 1"
    assert summary["controllerMachineIds"] == [str(w.till.id)] and summary["enabled"] is True
    assert summary["configVersion"] == C.config_version(C.default_config())
    assert summary["appliedConfigVersion"] is None and summary["configUpToDate"] is False
    assert refused(convert, w).detail == "already_kiosk"
    candidates = R.get_candidates(shop_id=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert str(w.kiosk.id) not in {c["machineId"] for c in candidates}

    out = R.patch_kiosk(machine_id=w.kiosk.id, body=KioskPatchIn(name="  קיוסק   כניסה ", controllerMachineIds=[]),
                        current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["name"] == "קיוסק כניסה" and out["controllerMachineIds"] == [] and out["controllers"] == []

    post_orders(w, w.kiosk, order("o1"))
    dashboard_command(w, w.kiosk, "pause")
    result = R.delete_kiosk(machine_id=w.kiosk.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    assert result.status_code == 204
    assert w.db.get(KioskDevice, w.kiosk.id) is None
    assert w.db.query(KioskOrder).count() == 1 and w.db.query(KioskCommand).count() == 1
    assert sync(w, w.kiosk)["kiosk"] is False


def test_convert_needs_an_assigned_till_and_can_lock_the_device(w):
    w.kiosk.pairing_status = PairingStatus.PAIRED
    w.db.commit()
    assert refused(convert, w).detail == "machine_not_assigned"
    w.kiosk.pairing_status = PairingStatus.ASSIGNED
    w.db.commit()
    convert(w, lock=True)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "kioskMode").one()
    value = w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id, TillParameterValue.scope_type == "machine",
    ).one()
    assert value.scope_id == w.kiosk.id and value.value is True


def test_invalid_controllers_are_refused(w):
    other_company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other Co", vat_number="2")
    w.db.add(other_company)
    w.db.flush()
    other_company_shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other_company.id,
                              name="Elsewhere", settings={})
    w.db.add(other_company_shop)
    w.db.flush()
    stranger = _till(w, "Stranger", other_company_shop)
    second_kiosk = _till(w, "Kiosk 2", w.shop)
    convert(w, second_kiosk, controllers=[])

    for bad in (w.kiosk.id, second_kiosk.id, stranger.id, uuid.uuid4(), "not-a-uuid"):
        body = KioskCreateIn(machineId=w.kiosk.id, controllerMachineIds=[str(w.till.id), str(bad)])
        err = refused(R.create_kiosk, body=body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (err.status_code, err.detail) == (422, f"invalid_controller:{bad}")
        w.db.rollback()
    assert w.db.get(KioskDevice, w.kiosk.id) is None

    # The other shop of the same company may control it.
    convert(w, controllers=[w.till, w.other_till])
    for bad in (second_kiosk.id, stranger.id):
        err = refused(R.patch_kiosk, machine_id=w.kiosk.id, body=KioskPatchIn(controllerMachineIds=[str(bad)]),
                      current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert err.detail == f"invalid_controller:{bad}"
        w.db.rollback()
    w.db.expire_all()
    assert w.db.get(KioskDevice, w.kiosk.id).controller_machine_ids == [str(w.till.id), str(w.other_till.id)]
    # A till that becomes a kiosk stops controlling the others.
    convert(w, w.till, controllers=[])
    w.db.expire_all()
    assert w.db.get(KioskDevice, w.kiosk.id).controller_machine_ids == [str(w.other_till.id)]


# ── Categories: the side rail and a picture per category ─────────────────────


def test_category_layout_defaults_to_the_side_rail_and_is_validated():
    assert C.default_config()["theme"]["categoryLayout"] == "side"
    cleaned, errors = C.validate_layer({"theme": {"categoryLayout": "top"}})
    assert errors == [] and cleaned == {"theme": {"categoryLayout": "top"}}
    assert C.resolve(cleaned)["theme"]["categoryLayout"] == "top"
    _c, errors = C.validate_layer({"theme": {"categoryLayout": "left"}})
    assert paths(errors) == {"theme.categoryLayout": "invalid_value"}
    # null in a layer inherits (the side rail by default).
    cleaned, errors = C.validate_layer({"theme": {"categoryLayout": None}})
    assert errors == [] and C.resolve(cleaned)["theme"]["categoryLayout"] == "side"


def test_category_images_are_validated_per_category():
    good = {"url": "https://cdn.example/burgers.png", "kind": "image", "sha256": SHA, "bytes": 2048}
    cleaned, errors = C.validate_layer({"catalog": {"categoryImages": {"cat-1": good, "cat-2": {"url": "https://x/d.webp", "kind": "image"}}}})
    assert errors == []
    assert cleaned["catalog"]["categoryImages"]["cat-1"] == good
    for bad, path, code in (
        ({**good, "kind": "video"}, "catalog.categoryImages.cat-1.kind", "invalid_value"),
        ({**good, "sha256": "xyz"}, "catalog.categoryImages.cat-1.sha256", "invalid_sha256"),
        ({**good, "url": "ftp://cdn.example/a.png"}, "catalog.categoryImages.cat-1.url", "invalid_url"),
        ("https://cdn.example/a.png", "catalog.categoryImages.cat-1", "invalid_media"),
    ):
        _c, errors = C.validate_layer({"catalog": {"categoryImages": {"cat-1": bad}}})
        assert paths(errors).get(path) == code, (bad, [e.to_wire() for e in errors])
    _c, errors = C.validate_layer({"catalog": {"categoryImages": ["https://cdn.example/a.png"]}})
    assert paths(errors) == {"catalog.categoryImages": "invalid_type"}
    _c, errors = C.validate_layer({"catalog": {"categoryImages": {"x" * 200: good}}})
    assert list(paths(errors).values()) == ["unknown_key"]


def test_category_images_merge_per_category_across_levels():
    company = {"catalog": {"categoryImages": {"c1": {"url": "https://cdn.example/c1.png", "kind": "image"}}}}
    shop = {"catalog": {"categoryImages": {"c2": {"url": "https://cdn.example/c2.png", "kind": "image"}}}}
    kiosk = {"catalog": {"categoryImages": {"c1": {"url": "https://cdn.example/c1-kiosk.png", "kind": "image"}}}}
    images = C.resolve(company, shop, kiosk)["catalog"]["categoryImages"]
    assert images["c1"]["url"] == "https://cdn.example/c1-kiosk.png"
    assert images["c2"]["url"] == "https://cdn.example/c2.png"


def test_media_manifest_carries_category_images_but_not_hidden_ones():
    cfg = C.resolve({
        "catalog": {
            "categoryImages": {
                "shown": {"url": "https://cdn.example/shown.png", "kind": "image", "sha256": SHA},
                "hidden": {"url": "https://cdn.example/hidden.png", "kind": "image"},
            },
            "hiddenCategories": ["hidden"],
        },
    })
    media = C.media_manifest(cfg)
    assert [m["url"] for m in media] == ["https://cdn.example/shown.png"]
    assert media[0]["sha256"] == SHA


# ── "סגנון ממשק" presets, dietary marks, reduce motion ───────────────────────


def test_new_keys_have_safe_defaults_and_validate():
    d = C.default_config()
    assert d["general"]["showDietary"] is True and d["general"]["reduceMotion"] is False
    assert d["theme"]["uiStyle"] == "wolt"
    cleaned, errors = C.validate_layer({
        "general": {"showDietary": False, "reduceMotion": True},
        "theme": {"uiStyle": "classic", "typeScale": "xlarge", "typeWeight": "light", "cartStyle": "panel", "animation": "subtle"},
    })
    assert errors == []
    assert cleaned["theme"]["uiStyle"] == "classic"
    _c, errors = C.validate_layer({
        "general": {"showDietary": "yes", "reduceMotion": 1},
        "theme": {"uiStyle": "material", "typeScale": "huge", "typeWeight": "black", "cartStyle": "drawer", "animation": "crazy"},
    })
    got = paths(errors)
    for path in ("theme.uiStyle", "theme.typeScale", "theme.typeWeight", "theme.cartStyle", "theme.animation"):
        assert got[path] == "invalid_value", path
    assert got["general.showDietary"] == "invalid_type"
    assert got["general.reduceMotion"] == "invalid_type"


def test_bon_on_kiosk_is_off_for_every_kiosk_until_a_level_turns_it_on():
    """"בון מטבח במדפסת הקיוסק" (docs/SPEC_KIOSK.md §5, the owner 07.10.2026): off by default — an
    existing kiosk whose stored layers never had the key gets it off; any level may turn it on."""
    assert C.DEFAULT_CONFIG["printing"]["bonOnKiosk"] is False
    # An existing kiosk: its stored layers (the Royal kiosk's, single printer and all) say nothing of it.
    existing = {"printing": {"bonMode": "single", "bonPrinterId": str(uuid.uuid4()), "receiptPrinterId": None, "bonAutoRetryMin": 0}}
    cleaned, errors = C.validate_layer(existing)
    assert errors == []
    cfg = C.resolve({}, {}, cleaned)
    assert cfg["printing"]["bonOnKiosk"] is False
    assert C.validate_config(cfg) == []
    # The key changes what every kiosk is sent: its version moves, so each kiosk takes the new config.
    before = json.loads(json.dumps(cfg))
    before["printing"].pop("bonOnKiosk")
    assert C.config_version(before) != C.config_version(cfg)
    # On at the shop, off again on one kiosk.
    on, errors = C.validate_layer({"printing": {"bonOnKiosk": True}})
    assert errors == []
    assert C.resolve({}, on, {})["printing"]["bonOnKiosk"] is True
    assert C.resolve({}, on, {"printing": {"bonOnKiosk": False}})["printing"]["bonOnKiosk"] is False
    # null in a layer is "inherit".
    inherit, errors = C.validate_layer({"printing": {"bonOnKiosk": None}})
    assert errors == [] and C.resolve(on, inherit)["printing"]["bonOnKiosk"] is True
    _c, errors = C.validate_layer({"printing": {"bonOnKiosk": "yes"}})
    assert paths(errors) == {"printing.bonOnKiosk": "invalid_type"}


def test_one_paper_the_order_number_on_the_receipt_and_no_separate_slip_by_default():
    """The owner, 08.10.2026: "ברירת מחדל הדפסת חשבונית ללא המספר הזמנה. בחשבונית יכול להופיע מספר
    הזמנה" — the separate number slip (`printing.pickupSlip`) is off by default, the receipt prints the
    order number (`printing.orderNumberOnReceipt`, on). A level that saved the slip keeps it."""
    assert C.DEFAULT_CONFIG["printing"]["pickupSlip"] is False
    assert C.DEFAULT_CONFIG["printing"]["orderNumberOnReceipt"] is True
    # An existing kiosk whose layers never had either key (the Royal kiosk's machine layer).
    existing = {"printing": {"bonMode": "single", "bonPrinterId": str(uuid.uuid4()), "receiptPrinterId": None, "bonAutoRetryMin": 0}}
    cleaned, errors = C.validate_layer(existing)
    assert errors == []
    cfg = C.resolve({}, {}, cleaned)
    assert cfg["printing"]["pickupSlip"] is False and cfg["printing"]["orderNumberOnReceipt"] is True
    assert C.validate_config(cfg) == []
    # A saved config keeps what it saved: the slip on, the number off the receipt.
    saved, errors = C.validate_layer({"printing": {"pickupSlip": True, "orderNumberOnReceipt": False}})
    assert errors == []
    kept = C.resolve({}, saved, {})
    assert kept["printing"]["pickupSlip"] is True and kept["printing"]["orderNumberOnReceipt"] is False
    # A kiosk below may change it again; null inherits.
    assert C.resolve({}, saved, {"printing": {"pickupSlip": False}})["printing"]["pickupSlip"] is False
    inherit, errors = C.validate_layer({"printing": {"orderNumberOnReceipt": None}})
    assert errors == [] and C.resolve(saved, inherit)["printing"]["orderNumberOnReceipt"] is False
    _c, errors = C.validate_layer({"printing": {"orderNumberOnReceipt": "yes", "pickupSlip": 1}})
    assert paths(errors) == {"printing.orderNumberOnReceipt": "invalid_type", "printing.pickupSlip": "invalid_type"}
    # The new key moves the version, so every kiosk takes the new config.
    before = json.loads(json.dumps(cfg))
    before["printing"].pop("orderNumberOnReceipt")
    assert C.config_version(before) != C.config_version(cfg)


def test_the_default_style_is_the_look_kiosks_had():
    cfg = C.resolve()
    before = {
        "mode": "light", "font": "system", "primaryColor": "#1F6FEB", "accentColor": "#16A34A",
        "cornerRadius": 20, "cardStyle": "elevated", "buttonShape": "pill", "gridDensity": "comfortable",
        "imageRatio": "4:3", "categoryStyle": "chips", "showDescriptions": True,
    }
    assert {k: cfg["theme"][k] for k in before} == before
    assert C.validate_config(cfg) == []


def test_a_preset_sets_the_theme_and_explicit_settings_win_at_any_level():
    for style, preset in C.UI_PRESETS.items():
        cfg = C.resolve({"theme": {"uiStyle": style}})
        assert {k: cfg["theme"][k] for k in C.PRESET_THEME_KEYS} == preset, style
        assert C.validate_config(cfg) == [], style
    # The company sets its brand colour; a shop picks the dark style; the kiosk a radius.
    company = {"theme": {"primaryColor": "#FF6600"}}
    shop = {"theme": {"uiStyle": "minimal_dark"}}
    kiosk = {"theme": {"cornerRadius": 30}}
    cfg = C.resolve(company, shop, kiosk)
    assert cfg["theme"]["uiStyle"] == "minimal_dark"
    assert cfg["theme"]["primaryColor"] == "#FF6600"  # explicit above the style's choice
    assert cfg["theme"]["cornerRadius"] == 30  # explicit below it
    assert cfg["theme"]["mode"] == "dark" and cfg["theme"]["typeWeight"] == "light"  # from the style
    # A kiosk picking another style than its shop: its own style decides.
    cfg = C.resolve(shop, {"theme": {"uiStyle": "classic"}})
    assert cfg["theme"]["cartStyle"] == "panel" and cfg["theme"]["buttonShape"] == "square"
    assert C.style_of(shop, {"theme": {"uiStyle": None}}) == "minimal_dark"


def test_the_tech_style_is_one_pick_its_theme_cta_and_motion():
    """"טכנולוגי": one tap in the designer — the theme, the attract button and the transitions."""
    assert C.UI_STYLES[-1] == "tech" and set(C.UI_STYLES) == set(C.UI_PRESETS) == set(C.UI_PRESET_CTA) == set(C.UI_PRESET_MOTION)
    cfg = C.resolve({"theme": {"uiStyle": "tech"}})
    assert C.validate_config(cfg) == []
    theme = cfg["theme"]
    assert theme["mode"] == "dark" and theme["backgroundColor"] == "#0B0F14" and theme["surfaceColor"] == "#111821"
    # One electric accent: the brand colour is the accent (dark words on it, as on the dashboard and the till).
    assert theme["primaryColor"] == theme["accentColor"] == "#22E1FF"
    assert theme["cardStyle"] == "outlined" and theme["cornerRadius"] == 10 and theme["buttonShape"] == "rounded"
    assert cfg["attract"]["cta"]["animation"] == "none" and cfg["attract"]["cta"]["shadow"] is False
    assert cfg["attract"]["cta"]["icon"] == "arrow" and cfg["attract"]["cta"]["position"] == "bottom_center"
    assert cfg["motion"] == {
        "categorySwitch": "fade", "itemsEnter": "cascade", "screenChange": "fade", "sheet": "scale",
        "addToCart": "fly", "speed": "normal", "effects": "auto", **MOTION_ENGINE_DEFAULTS,
    }
    assert C.preset_layer("tech")["theme"] == C.UI_PRESETS["tech"]
    # The brand colour stays configurable on top of the style.
    cfg = C.resolve({"theme": {"uiStyle": "tech"}}, {"theme": {"primaryColor": "#3B82F6"}})
    assert cfg["theme"]["primaryColor"] == "#3B82F6" and cfg["theme"]["backgroundColor"] == "#0B0F14"
    # Offered to the designer.
    assert C.limits()["enums"]["uiStyle"][-1] == "tech"


def test_settings_answer_the_parents_explicit_layers(w):
    put(w, "company", w.company.id, {"theme": {"uiStyle": "ios", "cornerRadius": 9}})
    view = get_settings(w, "shop", w.shop.id)
    assert view["inheritedLayers"] == {"theme": {"uiStyle": "ios", "cornerRadius": 9}}
    assert view["inherited"]["theme"]["typeScale"] == "large"  # the ios preset
    assert view["inherited"]["theme"]["cornerRadius"] == 9  # explicit beats the preset


# ── "מצב שאין אינטרנט — תתריע": the kiosk_offline exception ──────────────────


def _offline_rows(w):
    from app.models.audit_exception import AuditException

    return w.db.query(AuditException).filter(AuditException.exception_type == "kiosk_offline").all()


def test_kiosk_offline_exception_while_away_and_closed_when_back(w):
    from app.services import kiosk_offline as O

    convert(w)
    device = w.db.get(KioskDevice, w.kiosk.id)
    now = datetime.now(timezone.utc)
    device.last_kiosk_sync_at = now - timedelta(minutes=3)
    device.status = {"shiftOpen": True}
    w.db.flush()
    cfg = C.resolve()
    # Three minutes: nothing yet (the rule's default is five).
    assert O.note_listing(w.db, w.kiosk, device, cfg, now=now) is None
    # Six minutes, trading: one exception, listed once however often the dashboard polls.
    device.last_kiosk_sync_at = now - timedelta(minutes=6)
    w.db.flush()
    row = O.note_listing(w.db, w.kiosk, device, cfg, now=now)
    assert row is not None and row.details["backAt"] is None and row.severity == "high"
    assert O.note_listing(w.db, w.kiosk, device, cfg, now=now + timedelta(seconds=15)) is None
    assert len(_offline_rows(w)) == 1
    # Back: its first sync closes it, with the minutes it was away.
    S.kiosk_sync(w.db, w.kiosk, {"flowState": "attract"}, now=now + timedelta(minutes=4))
    w.db.flush()
    rows = _offline_rows(w)
    assert len(rows) == 1 and rows[0].details["backAt"] and int(rows[0].value) == 10


def test_kiosk_offline_respects_hours_trading_and_the_rule(w, monkeypatch):
    from app.services import kiosk_offline as O

    convert(w)
    device = w.db.get(KioskDevice, w.kiosk.id)
    now = datetime(2026, 10, 6, 1, 0, tzinfo=timezone.utc)  # a Tuesday night
    device.last_kiosk_sync_at = now - timedelta(minutes=30)
    w.db.flush()
    # No hours and no open shift reported: not trading, no alert.
    device.status = {"shiftOpen": False}
    assert O.note_listing(w.db, w.kiosk, device, C.resolve(), now=now) is None
    # Hours on, outside them: none either.
    monkeypatch.setattr(O, "_local", lambda db, machine, at: at)
    night = C.resolve({"hours": {"enabled": True, "ranges": [{"days": [0, 1, 2, 3, 4, 5, 6], "open": "08:00", "close": "23:00"}]}})
    assert O.note_listing(w.db, w.kiosk, device, night, now=now) is None
    # A range past midnight covers it.
    late = C.resolve({"hours": {"enabled": True, "ranges": [{"days": [1], "open": "18:00", "close": "03:00"}]}})
    assert O.note_listing(w.db, w.kiosk, device, late, now=now) is not None
    # The rule switched off: nothing.
    monkeypatch.setattr(O, "rule_of", lambda db, machine: None)
    device.last_kiosk_sync_at = now - timedelta(minutes=60)
    assert O.note_back(w.db, w.kiosk, device, late, device.last_kiosk_sync_at, now=now) is not None  # closes the open one
    assert O.note_listing(w.db, w.kiosk, device, late, now=now) is None


def test_a_gap_nobody_watched_is_recorded_when_the_kiosk_returns(w):
    from app.services import kiosk_offline as O

    convert(w)
    device = w.db.get(KioskDevice, w.kiosk.id)
    now = datetime.now(timezone.utc)
    device.status = {"shiftOpen": True}
    w.db.flush()
    row = O.note_back(w.db, w.kiosk, device, C.resolve(), now - timedelta(minutes=12), now=now)
    assert row is not None and row.details["backAt"] and int(row.value) == 12
    # A short blip records nothing.
    assert O.note_back(w.db, w.kiosk, device, C.resolve(), now - timedelta(minutes=1), now=now) is None


def test_the_exception_type_is_a_rule():
    from app.services import exceptions as E

    assert E.RULES_BY_TYPE["kiosk_offline"].params[0].default == 5
    assert E.RULES_BY_TYPE["kiosk_offline"].params[0].key == "offlineMinutes"


# ── "כפתור מסך הפתיחה": the attract screen's call to action ───────────────────


def test_cta_defaults_validate_and_follow_the_style():
    cta = C.default_config()["attract"]["cta"]
    assert cta["position"] == "bottom_center" and cta["tapAnywhere"] is True and cta["animation"] == "pulse"
    for style, preset in C.UI_PRESET_CTA.items():
        got = C.resolve({"theme": {"uiStyle": style}})["attract"]["cta"]
        assert {k: got[k] for k in C.PRESET_CTA_KEYS} == preset, style
    # An explicit choice beats the style's, at any level; the rest still follows the style.
    company = {"attract": {"cta": {"position": "middle_center", "subtitle": "גע כדי להתחיל"}}}
    kiosk = {"theme": {"uiStyle": "classic"}}
    got = C.resolve(company, kiosk)["attract"]["cta"]
    assert got["position"] == "middle_center" and got["subtitle"] == "גע כדי להתחיל"
    assert got["size"] == "xl" and got["icon"] == "cart"


def test_cta_validation():
    good = {
        "size": "custom", "widthPct": 60, "heightDp": 120, "position": "custom", "x": 30, "y": 70,
        "fillColor": "#112233", "textColor": "#FFFFFF", "fontSize": 30, "fontWeight": "black",
        "radius": 100, "borderColor": "#000000", "borderWidth": 2, "shadow": False,
        "icon": "hand", "iconPosition": "start", "animation": "glow", "subtitle": "גע כדי להתחיל",
        "tapAnywhere": False,
    }
    cleaned, errors = C.validate_layer({"attract": {"cta": good}})
    assert errors == [] and cleaned["attract"]["cta"] == good
    _c, errors = C.validate_layer({"attract": {"cta": {
        "size": "huge", "widthPct": 10, "heightDp": 40, "position": "corner", "x": 101, "y": -1,
        "fillColor": "red", "fontSize": 99, "fontWeight": "thin", "radius": 101, "borderWidth": 9,
        "icon": "rocket", "iconPosition": "middle", "animation": "spin", "subtitle": "x" * 81,
        "tapAnywhere": "yes", "bogus": 1,
    }}})
    got = paths(errors)
    expected = {
        "attract.cta.size": "invalid_value", "attract.cta.widthPct": "out_of_range", "attract.cta.heightDp": "out_of_range",
        "attract.cta.position": "invalid_value", "attract.cta.x": "out_of_range", "attract.cta.y": "out_of_range",
        "attract.cta.fillColor": "invalid_color", "attract.cta.fontSize": "out_of_range", "attract.cta.fontWeight": "invalid_value",
        "attract.cta.radius": "out_of_range", "attract.cta.borderWidth": "out_of_range", "attract.cta.icon": "invalid_value",
        "attract.cta.iconPosition": "invalid_value", "attract.cta.animation": "invalid_value", "attract.cta.subtitle": "too_long",
        "attract.cta.tapAnywhere": "invalid_type", "attract.cta.bogus": "unknown_key",
    }
    for path, code in expected.items():
        assert got.get(path) == code, (path, got.get(path))


# ── "לקיוסק אין עובד בפועל": the kiosk runs as itself ─────────────────────────


def test_kiosk_sync_names_the_kiosk_as_its_own_operator(w):
    from app.services import kiosk_identity as KI

    convert(w, name="קיוסק רויאל")
    out = sync(w, w.kiosk)
    assert out["operator"] == {"id": f"kiosk:{w.kiosk.id}", "name": "קיוסק רויאל"}
    assert KI.is_kiosk_operator(out["operator"]["id"]) and not KI.is_kiosk_operator(str(w.till.id))
    assert KI.machine_id_of(out["operator"]["id"]) == w.kiosk.id
    # A regular till has no kiosk operator.
    assert "operator" not in sync(w, w.till)


def test_documents_and_reports_carry_the_kiosk_identity(w):
    from app.services import kiosk_identity as KI
    from app.services import reports as RP
    from app.services.exceptions import Detector

    convert(w, name="קיוסק רויאל")
    w.db.commit()
    op = KI.operator_id(w.kiosk.id)
    names = RP._load_cashier_names(w.db, [op, str(uuid.uuid4()), "legacy-name", None])
    assert list(names) == [op]
    assert RP._display_name(names[op]) == "קיוסק רויאל"
    # Field 1233 of the open format: a short, stable kiosk code (9 characters).
    code = KI.open_format_code(op)
    assert code == "K" + w.kiosk.id.hex[:8] and len(code) == 9
    assert KI.open_format_code(str(uuid.uuid4())) is None
    # The exceptions feed names it too.
    detector = Detector(w.db)
    assert detector.name(op) == "קיוסק רויאל"


def test_attendance_never_sees_the_kiosk(w):
    from app.models.pos_user import PosUser
    from app.services import kiosk_identity as KI

    convert(w, name="קיוסק רויאל")
    w.db.commit()
    # Not a till user: no roster row, no PIN, nothing attendance could list or clock in.
    assert w.db.query(PosUser).filter(PosUser.username.ilike("%kiosk%")).count() == 0
    assert KI.machine_id_of(KI.operator_id(w.kiosk.id)) == w.kiosk.id


# ── "נעילה למכירה" and "פתיחה אוטומטית" (docs/SPEC_KIOSK.md §15) ──────────────

from zoneinfo import ZoneInfo  # noqa: E402

from app.services import kiosk_schedule as KS  # noqa: E402

IL = ZoneInfo("Asia/Jerusalem")
WEEK = [0, 1, 2, 3, 4, 5, 6]


def _at(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=IL)


def test_lock_windows():
    now = datetime(2026, 10, 6, 9, 0, tzinfo=timezone.utc)  # 12:00 in Israel
    assert KS.lock_until("manual", now=now, zone=IL) is None
    assert KS.lock_until(None, now=now, zone=IL) is None
    assert KS.lock_until("minutes", now=now, zone=IL, minutes=45) == now + timedelta(minutes=45)
    assert KS.lock_until("time", now=now, zone=IL, until_time="15:30") == datetime(2026, 10, 6, 12, 30, tzinfo=timezone.utc)
    cases = (
        ("time", {"until_time": "11:00"}, "until_passed"),
        ("time", {"until_time": "25:00"}, "invalid_until_time"),
        ("minutes", {"minutes": 0}, "invalid_minutes"),
        ("minutes", {"minutes": 1441}, "invalid_minutes"),
        ("next_open", {}, "no_schedule"),
        ("forever", {}, "invalid_lock_mode"),
    )
    for mode, extra, code in cases:
        with pytest.raises(KS.LockRefused) as caught:
            KS.lock_until(mode, now=now, zone=IL, **extra)
        assert caught.value.code == code and caught.value.message
    # Until the next automatic opening: tomorrow 07:00 local.
    hours = {"enabled": True, "ranges": [{"days": WEEK, "open": "07:00", "close": "23:00"}]}
    assert KS.lock_until("next_open", now=now, zone=IL, hours=hours) == datetime(2026, 10, 7, 4, 0, tzinfo=timezone.utc)
    # A lock with an end holds until then, on any clock (the kiosk's own, offline).
    end = now + timedelta(minutes=10)
    assert KS.lock_active(True, end, now) and not KS.lock_active(True, end, end) and KS.lock_active(True, None, end)
    assert not KS.lock_active(False, None, now)


def test_auto_open_schedule_across_midnight_and_dst():
    late = {"enabled": True, "ranges": [{"days": [5], "open": "18:00", "close": "02:00"}]}  # Friday 18:00 to 02:00
    assert KS.is_open(late, _at(2026, 10, 9, 23, 0))  # Friday night
    assert KS.is_open(late, _at(2026, 10, 10, 1, 59))  # past midnight: Friday's
    assert not KS.is_open(late, _at(2026, 10, 10, 2, 0))
    assert not KS.is_open(late, _at(2026, 10, 10, 18, 30))  # Saturday is not in it
    assert KS.next_opening(late, _at(2026, 10, 10, 2, 0)) == _at(2026, 10, 16, 18, 0)
    # No closing time: it opens, and never closes by itself.
    open_only = {"enabled": True, "ranges": [{"days": WEEK, "open": "07:00", "close": None}]}
    assert KS.is_open(open_only, _at(2026, 10, 6, 3, 0))
    assert KS.next_opening(open_only, _at(2026, 10, 6, 3, 0)) == _at(2026, 10, 6, 7, 0)
    assert KS.next_opening(open_only, _at(2026, 10, 6, 7, 0)) == _at(2026, 10, 7, 7, 0)
    # DST in Israel 2026: on 27.3 02:00 becomes 03:00; on 25.10 02:00 becomes 01:00.
    gap = {"enabled": True, "ranges": [{"days": WEEK, "open": "02:30", "close": "10:00"}]}
    opening = KS.next_opening(gap, _at(2026, 3, 27, 0, 0))
    assert (opening.hour, opening.minute) == (3, 30) and opening.utcoffset() == timedelta(hours=3)
    back = {"enabled": True, "ranges": [{"days": WEEK, "open": "01:30", "close": "10:00"}]}
    first = KS.next_opening(back, _at(2026, 10, 25, 0, 0))
    assert (first.hour, first.minute, first.utcoffset()) == (1, 30, timedelta(hours=3))  # the first of the two
    # From one opening to the next across the fall-back night is 25 real hours.
    daily = {"enabled": True, "ranges": [{"days": WEEK, "open": "07:00", "close": "23:00"}]}
    a = KS.next_opening(daily, _at(2026, 10, 24, 8, 0))
    assert a == _at(2026, 10, 25, 7, 0)
    assert a.astimezone(timezone.utc) - _at(2026, 10, 24, 7, 0).astimezone(timezone.utc) == timedelta(hours=25)
    assert KS.next_opening({"enabled": False}, _at(2026, 10, 6, 3, 0)) is None


def test_schedule_and_auto_z_agree():
    daily = {"enabled": True, "ranges": [{"days": WEEK, "open": "07:00", "close": "23:00"}]}
    assert KS.schedule_issues(daily, "23:30") == []
    assert KS.schedule_issues(daily, "23:00") == []  # the close itself: closed
    assert KS.schedule_issues(daily, "22:00")[0]["code"] == "auto_z_while_open"
    assert KS.schedule_issues(daily, "07:00")[0]["code"] == "auto_z_at_opening"
    assert KS.schedule_issues(daily, "") == [] and KS.schedule_issues({"enabled": False}, "12:00") == []
    late = {"enabled": True, "ranges": [{"days": WEEK, "open": "18:00", "close": "02:00"}]}
    assert KS.schedule_issues(late, "01:00")[0]["code"] == "auto_z_while_open"
    assert KS.schedule_issues(late, "03:00") == []
    # The simple form: with a close and no Z time, the Z runs at the close.
    hours, auto = KS.simple_schedule({"enabled": True, "days": [0, 1], "open": "08:00", "close": "22:00"})
    assert hours == {"enabled": True, "ranges": [{"days": [0, 1], "open": "08:00", "close": "22:00"}]} and auto == "22:00"
    assert KS.simple_schedule({"enabled": True, "open": "08:00"})[1] is None


def test_lock_from_a_till_needs_a_manager_and_is_audited(w):
    from app.models.pos_user import PosUserRole

    convert(w)
    cashier = _pos_user(w, "יוסי", PosUserRole.CASHIER)
    manager = _pos_user(w, "דנה", PosUserRole.SHOP_MANAGER)
    w.db.commit()
    for who in (None, str(cashier.id), str(uuid.uuid4())):
        out = till_command(w, w.till, w.kiosk, "pause", posUserId=who)[0]
        assert out.status_code == 403 and b"kiosk_control_requires_manager" in out.body
    assert w.db.query(KioskCommand).count() == 0
    out, code = till_command(w, w.till, w.kiosk, "pause", posUserId=str(manager.id), untilMode="minutes", minutes=30, message="ניקיון")
    assert code == 201
    device = w.db.get(KioskDevice, w.kiosk.id)
    assert device.paused and device.paused_mode == "minutes" and device.paused_until is not None
    state = sync(w, w.kiosk)["state"]
    assert state["paused"] and state["mode"] == "minutes" and state["until"] and state["by"] == "Till 2 · דנה"
    # The controlling till sees who, since when and until when.
    k = next(c for c in sync(w, w.till)["controls"] if c["machineId"] == str(w.kiosk.id))
    assert k["paused"] and k["pausedBy"] == "Till 2 · דנה" and k["pausedUntil"] and k["pausedMode"] == "minutes"
    # A refusal is audited, with a Hebrew message.
    out = till_command(w, w.till, w.kiosk, "pause", posUserId=str(manager.id), untilMode="next_open")[0]
    assert out.status_code == 422 and b"no_schedule" in out.body
    assert w.db.query(KioskCommand).filter(KioskCommand.status == "refused").count() == 1


def test_an_ended_lock_lifts_by_itself_once(w):
    convert(w)
    dashboard_command(w, w.kiosk, "pause", untilMode="minutes", minutes=5)
    device = w.db.get(KioskDevice, w.kiosk.id)
    later = S._aware(device.paused_until) + timedelta(seconds=1)
    assert S.state_of(device, now=later)["paused"] is False  # already, before anything is written
    S.expire_locks(w.db, [device], now=later)
    S.expire_locks(w.db, [device], now=later)
    assert device.paused is False and device.paused_until is None
    auto = w.db.query(KioskCommand).filter(KioskCommand.source == "schedule").all()
    assert len(auto) == 1 and auto[0].action == "resume" and auto[0].requested_by_name == "סיום נעילה"


def test_auto_open_schedule_from_a_till_writes_the_kiosk_level(w):
    from app.models.pos_user import PosUserRole

    convert(w)
    manager = _pos_user(w, "דנה", PosUserRole.SHOP_MANAGER)
    w.db.commit()
    form = {"enabled": True, "days": WEEK, "open": "07:00", "close": "23:00"}
    out, code = till_command(w, w.till, w.kiosk, "schedule", posUserId=str(manager.id), schedule=form)
    assert code == 201 and out["action"] == "schedule"
    eff = sync(w, w.kiosk)["config"]
    assert eff["hours"] == {"enabled": True, "ranges": [{"days": WEEK, "open": "07:00", "close": "23:00"}]}
    assert eff["operations"]["autoCloseAt"] == "23:00"
    # The dashboard sees it at the kiosk level (both ways).
    layer = get_settings(w, "machine", w.kiosk.id)["overrides"]
    assert layer["hours"]["ranges"][0]["open"] == "07:00"
    # Inconsistent: a Z while open is refused, nothing written.
    bad = {"enabled": True, "days": WEEK, "open": "07:00", "close": "23:00", "autoCloseAt": "12:00"}
    out = till_command(w, w.till, w.kiosk, "schedule", posUserId=str(manager.id), schedule=bad)[0]
    assert out.status_code == 422 and b"schedule_inconsistent" in out.body
    assert sync(w, w.kiosk)["config"]["operations"]["autoCloseAt"] == "23:00"
    # Opening only (no close); then a lock until the next opening.
    dashboard_command(w, w.kiosk, "schedule", schedule={"enabled": True, "open": "07:00"})
    eff = sync(w, w.kiosk)["config"]
    assert eff["hours"]["ranges"][0]["close"] is None
    out, code = dashboard_command(w, w.kiosk, "pause", untilMode="next_open")
    assert code == 201
    until = S._aware(w.db.get(KioskDevice, w.kiosk.id).paused_until).astimezone(IL)
    assert (until.hour, until.minute) == (7, 0)


# ── The kiosk UI batch: menu mode, service placement, details step, upsell, end message ─


def test_ui_batch_defaults_and_validation():
    d = C.default_config()
    assert d["catalog"]["oneCategory"] is True
    assert d["general"]["servicePlacement"] == "after_start"
    assert (d["payment"]["detailsStep"], d["payment"]["tableNumber"]) == ("before_pay", "off")
    assert d["upsell"] == {"maxShown": 2}
    assert d["success"] == {"message": "", "image": None}
    # Every style's button is centred at the bottom by default.
    for style in C.UI_PRESET_CTA:
        assert C.resolve({"theme": {"uiStyle": style}})["attract"]["cta"]["position"] == "bottom_center"
    good = {
        "catalog": {"oneCategory": False},
        "general": {"servicePlacement": "attract"},
        "payment": {"detailsStep": "after_service", "tableNumber": "required"},
        "upsell": {"maxShown": 3},
        "success": {"message": "תודה! נתראה", "image": {"url": "https://cdn/x.png", "kind": "image", "sha256": None, "bytes": None}},
    }
    cleaned, errors = C.validate_layer(good)
    assert errors == [] and cleaned == good
    # The kiosk's own rules of the first round are gone (the menu's rules, §19): a layer
    # that still has them loses them quietly, never refused.
    retired = {"upsell": {"when": "both", "maxShown": 2, "rules": [{"id": "x", "offerProductIds": ["p2"]}]}}
    cleaned, errors = C.validate_layer(retired)
    assert errors == [] and cleaned == {"upsell": {"maxShown": 2}}
    assert retired["upsell"]["rules"], "the caller's layer is not changed"
    _c, errors = C.validate_layer({
        "general": {"servicePlacement": "lobby"},
        "payment": {"detailsStep": "never", "tableNumber": "maybe"},
        "upsell": {"maxShown": 6},
        "success": {"message": "x" * 301},
    })
    got = paths(errors)
    for path, code in {
        "general.servicePlacement": "invalid_value", "payment.detailsStep": "invalid_value", "payment.tableNumber": "invalid_value",
        "upsell.maxShown": "out_of_range", "success.message": "too_long",
    }.items():
        assert got.get(path) == code, (path, got.get(path))
    # The end message's picture is downloaded with the rest of the kiosk's media.
    eff = C.resolve(good)
    assert any(m["url"] == "https://cdn/x.png" for m in C.media_manifest(eff))


def test_checkout_steps_tip_other_and_tip_texts():
    """"טיפ לצוות" before the payment: the steps' order, "סכום אחר", the tip screen's texts."""
    d = C.default_config()
    assert d["payment"]["checkoutSteps"] == ["tip", "details", "payMethod"] and d["payment"]["tipOther"] is True
    assert C.limits()["enums"]["checkoutSteps"] == ["tip", "details", "payMethod"]
    good = {
        "payment": {"tipEnabled": True, "tipOther": False, "checkoutSteps": ["details", "tip"]},
        "texts": {"tipTitle": "טיפ?", "tipSkip": "בלי", "stepReview": "הסל", "stepPay": "לתשלום"},
    }
    cleaned, errors = C.validate_layer(good)
    assert errors == [] and cleaned == good
    assert C.validate_config(C.resolve(good)) == []
    _c, errors = C.validate_layer({"payment": {"checkoutSteps": ["tip", "tip"]}})
    assert any(e.path.startswith("payment.checkoutSteps") and e.code == "duplicate" for e in errors)
    _c, errors = C.validate_layer({"payment": {"checkoutSteps": ["review", "pay"], "tipOther": "yes"}})
    got = paths(errors)
    assert any(p.startswith("payment.checkoutSteps") for p in got)
    assert "payment.tipOther" in got
    # "לאכול כאן או לקחת?": pick then "להמשך" (default), or straight on; every new screen text is editable.
    assert d["general"]["serviceSelect"] == "confirm"
    cleaned, errors = C.validate_layer({"general": {"serviceSelect": "instant"}, "texts": {"nameTitle": "שם?", "kbSpace": "space", "reviewItems": "{n} פריטים"}})
    assert errors == []
    _c, errors = C.validate_layer({"general": {"serviceSelect": "double"}})
    assert paths(errors).get("general.serviceSelect") == "invalid_value"
    for key in ("serviceSubtitle", "nameConfirm", "nameSkip", "kbToEnglish", "reviewHint", "searchTitle", "noteSave", "tipOtherError"):
        assert key in C.TEXT_KEYS


def test_attract_button_may_be_hidden_then_the_whole_screen_starts():
    """"אפשר לבטל גם כפתור ברוכים הבאים, ובנגיעה במסך יעבור להזמנה"."""
    cta = C.default_config()["attract"]["cta"]
    assert cta["visible"] is True and cta["touchHint"] is True
    hidden = {"attract": {"cta": {"visible": False, "touchHint": False}}, "texts": {"attractTouchHint": "געו כדי להתחיל"}}
    cleaned, errors = C.validate_layer(hidden)
    assert errors == [] and cleaned == hidden
    assert C.validate_config(C.resolve(hidden)) == []
    # Hidden with "כל המסך פותח הזמנה" off: nothing would start an order — refused.
    errors = C.validate_config(C.resolve({"attract": {"cta": {"visible": False, "tapAnywhere": False}}}))
    assert paths(errors).get("attract.cta.tapAnywhere") == "required_when_hidden"
    _c, errors = C.validate_layer({"attract": {"cta": {"visible": "no"}}})
    assert paths(errors).get("attract.cta.visible") == "invalid_type"


def test_a_specials_picture_reaches_the_kiosk_with_its_media(w):
    """docs/SPEC_KIOSK.md §21: an upsell rule's own picture (place kiosk) is in the kiosk's media."""
    from app.models.menu import UpsellRule

    convert(w)
    def rule(name, place, url, active=True):
        w.db.add(UpsellRule(
            id=uuid.uuid4(), tenant_id=w.tenant.id, name=name, trigger_type="transition", trigger_ids=["order_start"],
            action="add", place=place, image_url=url, is_active=active, display="popup",
        ))
    rule("special", "kiosk", "https://cdn/special.png")
    rule("till only", "quick,tables", "https://cdn/till.png")
    rule("off", "kiosk", "https://cdn/off.png", active=False)
    rule("relative", "quick,kiosk", "/media/x/special2.png")
    w.db.flush()
    urls = [m["url"] for m in C.effective_bundle(w.db, w.kiosk)["media"]]
    assert "https://cdn/special.png" in urls
    assert any(u.endswith("/media/x/special2.png") and u.startswith("http") for u in urls)
    assert "https://cdn/till.png" not in urls and "https://cdn/off.png" not in urls


# ── "עריכת תפריט הקיוסק" (docs/SPEC_KIOSK.md §22) ─────────────────────────────


def _menu_put(w, machine, body):
    from app.schemas.kiosk import KioskMenuIn

    out = R.put_kiosk_menu(str(machine.id), KioskMenuIn.model_validate(body), machine=machine, db=w.db)
    if isinstance(out, JSONResponse):
        return out.status_code, json.loads(out.body)
    return 200, out


def test_the_kiosk_menu_is_saved_for_the_shop_with_a_manager_and_audited(w, monkeypatch):
    from app.models.pos_user import PosUserRole
    from app.services import kiosk_menu as KM

    woken = []
    monkeypatch.setattr(KM, "wake_kiosks", lambda tenant, ids: woken.extend(ids))
    convert(w)
    other = _till(w, "Kiosk 2", w.shop)
    convert(w, other, name="קיוסק 2")
    # The second kiosk had its own order (a machine layer): the shop's menu takes over.
    C_layer = {"catalog": {"categoryOrder": ["old"], "oneCategory": False}}
    S.save_settings(w.db, w.admin, S.SettingsScope("machine", other, w.tenant.id, machine_id=other.id), C_layer)
    manager = _pos_user(w, "דנה", PosUserRole.SHOP_MANAGER)
    cashier = _pos_user(w, "רון", PosUserRole.CASHIER)
    w.db.commit()  # a refusal rolls the request back
    sync = S.kiosk_sync(w.db, w.kiosk, {"flowState": "attract"})
    base = sync["menuVersion"]
    menu = {
        "categoryOrder": ["c2", "c1"], "productOrder": {"c1": ["p2", "p1"]},
        "hiddenCategories": ["c3"], "hiddenProducts": ["p9"], "featuredProductIds": ["p1"],
    }
    # A cashier's PIN is not enough; neither is no approver.
    for approver in (str(cashier.id), None):
        code, body = _menu_put(w, w.kiosk, {"approverId": approver, "baseVersion": base, "menu": menu})
        assert (code, body["detail"]) == (403, "kiosk_control_requires_manager")
    code, out = _menu_put(w, w.kiosk, {"approverId": str(manager.id), "baseVersion": base, "menu": menu})
    assert code == 200 and out["savedBy"] == "דנה" and out["menuVersion"] != base
    w.db.commit()
    # Shop level: both kiosks get it; the second lost its own order but kept its other keys.
    for k in (w.kiosk, other):
        eff = C.effective_config(w.db, k)["catalog"]
        assert (eff["categoryOrder"], eff["productOrder"], eff["hiddenProducts"], eff["featuredProductIds"]) == (
            ["c2", "c1"], {"c1": ["p2", "p1"]}, ["p9"], ["p1"],
        )
    assert C.effective_config(w.db, other)["catalog"]["oneCategory"] is False
    shop_row = C.layer_row(w.db, "shop", w.shop.id)
    assert shop_row.overrides["catalog"]["hiddenCategories"] == ["c3"]
    assert S.kiosk_sync(w.db, other, {"flowState": "attract"})["menuVersion"] == out["menuVersion"]
    # Audited, by the manager's name, and the shop's kiosks woken.
    audit = w.db.query(KioskCommand).filter(KioskCommand.action == "menu").one()
    assert audit.status == "applied" and audit.requested_by_name.startswith("דנה") and "kioskLayersCleared=1" in audit.detail
    assert set(woken) == {str(w.kiosk.id), str(other.id)}


def test_the_kiosk_menu_version_check_and_validation(w, monkeypatch):
    from app.models.pos_user import PosUserRole
    from app.services import kiosk_menu as KM

    monkeypatch.setattr(KM, "wake_kiosks", lambda tenant, ids: None)
    convert(w)
    manager = _pos_user(w, "דנה", PosUserRole.SHOP_MANAGER)
    w.db.commit()  # a refusal rolls the request back
    base = S.kiosk_sync(w.db, w.kiosk, {})["menuVersion"]
    ok = {"approverId": str(manager.id), "baseVersion": base, "menu": {"categoryOrder": ["a", "b"]}}
    assert _menu_put(w, w.kiosk, ok)[0] == 200
    w.db.commit()
    # A second save from the same (now old) version: refused, the current version handed back.
    code, body = _menu_put(w, w.kiosk, {**ok, "menu": {"categoryOrder": ["b", "a"]}})
    assert (code, body["detail"], body["message"]) == (409, "kiosk_menu_changed", "התפריט השתנה — טען מחדש")
    assert body["menuVersion"] == S.kiosk_sync(w.db, w.kiosk, {})["menuVersion"]
    # Only the menu's keys, valid ones.
    current = body["menuVersion"]
    for bad in ({"oneCategory": True}, {"categoryOrder": "x"}):
        code, body = _menu_put(w, w.kiosk, {**ok, "baseVersion": current, "menu": bad})
        assert (code, body["detail"]) == (422, "invalid_kiosk_menu")
    # A till that is not a kiosk.
    assert refused(R.put_kiosk_menu, str(w.till.id), __import__("app.schemas.kiosk", fromlist=["KioskMenuIn"]).KioskMenuIn(menu={}), machine=w.till, db=w.db).status_code == 403
    # The dashboard's save of the shop layer passes the same check when it changes the menu.
    view = S.settings_view(w.db, S.settings_scope(w.db, w.admin, "shop", w.shop.id, w.tenant.id))
    assert view["menuVersion"] == current
    from app.schemas.kiosk import KioskSettingsIn

    stale = KioskSettingsIn.model_validate({"overrides": {"catalog": {"categoryOrder": ["z"]}}, "menuVersion": base})
    out = R.put_settings(stale, level="shop", scope_id=w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert isinstance(out, JSONResponse) and out.status_code == 409
    # Not touching the menu (the same keys): no conflict, whatever the version.
    same = KioskSettingsIn.model_validate({"overrides": {**view["overrides"], "theme": {"uiStyle": "ios"}}, "menuVersion": base})
    out = R.put_settings(same, level="shop", scope_id=w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert not isinstance(out, JSONResponse) and out["overrides"]["theme"]["uiStyle"] == "ios"


# ── "הנפשות ומעברים": the transitions, per style, layered and validated ───────

MOTION_KEYS = ("categorySwitch", "itemsEnter", "screenChange", "sheet", "addToCart", "speed")
#: "מנוע הנפשות" (kiosk_motion.py; tests/test_kiosk_motion.py): a new kiosk's engine keys.
MOTION_ENGINE_DEFAULTS = {"preset": "standard", "globalSpeed": None, "speedMultiplier": 1.0, "events": {}}


def test_motion_defaults_follow_the_style_and_animate_in_every_style():
    d = C.default_config()
    assert d["motion"] == {
        "categorySwitch": "slide", "itemsEnter": "cascade", "screenChange": "slide",
        "sheet": "scale", "addToCart": "fly", "speed": "normal", "effects": "auto", **MOTION_ENGINE_DEFAULTS,
    }
    # "אפקטים" is the device's (auto), never a style's: the presets decide the six transition keys.
    assert {**C.UI_PRESET_MOTION["wolt"], "effects": "auto", **MOTION_ENGINE_DEFAULTS} == d["motion"] and C.PRESET_MOTION_KEYS == MOTION_KEYS
    for style, preset in C.UI_PRESET_MOTION.items():
        assert "effects" not in preset, style
        cfg = C.resolve({"theme": {"uiStyle": style}})
        assert cfg["motion"] == {**preset, "effects": "auto", **MOTION_ENGINE_DEFAULTS}, style
        assert C.validate_config(cfg) == [], style
        # The owner's request, in every style: the category's grid moves and its dishes pop in.
        assert preset["categorySwitch"] != "none" and preset["itemsEnter"] in ("pop", "cascade"), style
        # The add-to-cart stays the pop-and-fly everywhere (docs/SPEC_KIOSK.md §18).
        assert preset["addToCart"] == "fly", style
    assert C.preset_layer("classic")["motion"] == C.UI_PRESET_MOTION["classic"]
    assert C.preset_layer("material")["motion"] == C.UI_PRESET_MOTION["wolt"]


def test_motion_is_layered_company_shop_kiosk_and_explicit_beats_the_style():
    company = {"motion": {"speed": "fast"}}
    shop = {"theme": {"uiStyle": "minimal_dark"}, "motion": {"itemsEnter": "flip"}}
    kiosk = {"motion": {"categorySwitch": "push"}}
    got = C.resolve(company, shop, kiosk)["motion"]
    assert got == {
        "categorySwitch": "push",  # the kiosk's own
        "itemsEnter": "flip",  # the shop's
        "screenChange": "fade", "sheet": "fade", "addToCart": "fly",  # the minimal_dark style's
        "speed": "fast",  # the company's, above the style's "relaxed"
        "effects": "auto",  # the default: the device decides
        **MOTION_ENGINE_DEFAULTS,  # Runner Standard, the speed by `speed`
    }
    assert C.explicit_layers(company, shop, kiosk)["motion"] == {"speed": "fast", "itemsEnter": "flip", "categorySwitch": "push"}
    # null inherits; an empty section overrides nothing.
    assert C.resolve(company, {"motion": {"speed": None}})["motion"]["speed"] == "fast"
    cleaned, errors = C.validate_layer({"motion": {}})
    assert errors == [] and cleaned == {}


def test_motion_validation():
    good = {"motion": {
        "categorySwitch": "fade_scale", "itemsEnter": "rise", "screenChange": "zoom",
        "sheet": "slide_up", "addToCart": "bounce", "speed": "relaxed",
    }}
    cleaned, errors = C.validate_layer(good)
    assert errors == [] and cleaned == good
    for fx in C.MOTION_CATEGORY_SWITCH:
        assert C.validate_layer({"motion": {"categorySwitch": fx}})[1] == [], fx
    _c, errors = C.validate_layer({"motion": {
        "categorySwitch": "spin", "itemsEnter": "explode", "screenChange": "push", "sheet": "zoom",
        "addToCart": "teleport", "speed": "warp", "effects": "turbo", "wobble": True,
    }})
    got = paths(errors)
    for key in MOTION_KEYS + ("effects",):
        assert got[f"motion.{key}"] == "invalid_value", key
    for effects in ("auto", "full", "light"):
        assert C.validate_layer({"motion": {"effects": effects}}) == ({"motion": {"effects": effects}}, []), effects
    assert got["motion.wobble"] == "unknown_key"
    _c, errors = C.validate_layer({"motion": "lively"})
    assert paths(errors)["motion"] == "invalid_type"
    enums = C.limits()["enums"]
    assert enums["motionCategorySwitch"] == ["slide", "fade", "fade_scale", "push", "none"]
    assert enums["motionItemsEnter"] == ["pop", "cascade", "rise", "flip", "none"]
    assert enums["motionScreenChange"] == ["slide", "fade", "zoom", "none"]
    assert enums["motionSheet"] == ["slide_up", "scale", "fade", "none"]
    assert enums["motionAddToCart"] == ["fly", "bounce", "none"]
    assert enums["motionSpeed"] == ["fast", "normal", "relaxed"]
    assert enums["motionEffects"] == ["auto", "full", "light"]


def test_motion_is_saved_and_reaches_the_kiosk(w):
    convert(w)
    put(w, "company", w.company.id, {"motion": {"speed": "relaxed"}})
    put(w, "machine", w.kiosk.id, {"theme": {"uiStyle": "classic"}, "motion": {"itemsEnter": "rise"}})
    out = sync(w, w.kiosk)
    assert out["config"]["motion"] == {
        "categorySwitch": "push", "itemsEnter": "rise", "screenChange": "fade",
        "sheet": "scale", "addToCart": "fly", "speed": "relaxed", "effects": "auto", **MOTION_ENGINE_DEFAULTS,
    }
    assert out["configVersion"] == C.config_version(out["config"])
    view = get_settings(w, "machine", w.kiosk.id)
    assert view["overrides"]["motion"] == {"itemsEnter": "rise"}
    assert view["inheritedLayers"]["motion"] == {"speed": "relaxed"}
    # A change of a transition alone is a new config version for the kiosk.
    before = out["configVersion"]
    put(w, "machine", w.kiosk.id, {"theme": {"uiStyle": "classic"}, "motion": {"itemsEnter": "flip"}})
    assert sync(w, w.kiosk)["configVersion"] != before
    # "אפקטים: קל" for this kiosk reaches it (a new config version), the rest inherited.
    before = sync(w, w.kiosk)["configVersion"]
    put(w, "machine", w.kiosk.id, {"theme": {"uiStyle": "classic"}, "motion": {"itemsEnter": "flip", "effects": "light"}})
    out = sync(w, w.kiosk)
    assert out["config"]["motion"]["effects"] == "light" and out["configVersion"] != before
    # Refused with the contract's 422 shape.
    err = refused(put, w, "machine", w.kiosk.id, {"motion": {"sheet": "spin"}})
    assert err.status_code == 422
    assert {"path": "motion.sheet", "code": "invalid_value"}.items() <= err.detail["errors"][0].items()


def test_the_shared_motion_golden_speaks_the_configs_vocabulary():
    """tests/fixtures/kiosk_motion_timings.json — the one motion table of the till (KioskTransitions,
    KioskMotion, KioskEase, KioskPerf), the dashboard and the web kiosks (kioskConfig.ts) — names
    exactly the config's effects and every one of them, and its examples are valid motion configs."""
    gold = json.loads((Path(__file__).parent / "fixtures" / "kiosk_motion_timings.json").read_text(encoding="utf-8"))
    assert tuple(gold["screenChange"]) == C.MOTION_SCREEN_CHANGE
    assert tuple(gold["categorySwitch"]) == C.MOTION_CATEGORY_SWITCH
    assert tuple(gold["itemsEnter"]) == C.MOTION_ITEMS_ENTER
    assert tuple(gold["stagger"]) == C.MOTION_ITEMS_ENTER
    assert tuple(gold["sheet"]) == C.MOTION_SHEET
    assert tuple(gold["speedFactor"]) == C.MOTION_SPEEDS
    assert tuple(gold["effects"]) == C.MOTION_EFFECTS
    for table in ("screenChange", "categorySwitch", "itemsEnter", "stagger", "sheet"):
        assert gold[table]["none"] == 0 and all(v > 0 for k, v in gold[table].items() if k != "none"), table
    # Snappy (the owner, 07.10.2026): a screen at most 220 ms, a window 260, the last card by 200 ms.
    assert max(gold["screenChange"].values()) <= 220 and max(gold["sheet"].values()) <= 260 and gold["staggerCapMs"] == 200
    assert gold["add"]["lively"]["popMs"] + gold["add"]["lively"]["flyMs"] == 560 and gold["add"]["lively"]["countUpMs"] == 360
    assert gold["light"] == {"categorySwitch": "fade", "itemsEnter": "none", "screenChange": "fade", "sheet": "fade", "speed": "fast"}
    for ex in gold["examples"]:
        assert C.validate_layer({"motion": ex["motion"]})[1] == [], ex["motion"]
        assert ex["animation"] in C.ANIMATIONS


# ── "ללא סוג שירות" and "לוגו במסך התשלום" (the owner, 07.10.2026) ─────────────


def test_service_mode_none_validates_and_turns_the_service_step_off():
    d = C.default_config()
    assert d["general"]["serviceMode"] == "types"
    cleaned, errors = C.validate_layer({"general": {"serviceMode": "none"}})
    assert errors == [] and cleaned == {"general": {"serviceMode": "none"}}
    _c, errors = C.validate_layer({"general": {"serviceMode": "maybe"}})
    assert paths(errors).get("general.serviceMode") == "invalid_value"
    # Never asked: the step is off, whatever its own mode and however many types are kept.
    none = C.resolve({"general": {"serviceMode": "none", "serviceTypes": ["take_away", "eat_in"]}})
    assert C.step_mode(none, "service") == "off"
    assert none["general"]["serviceTypes"] == ["take_away", "eat_in"], "kept for the day it is back"
    # A config stored before it (no serviceMode) keeps asking as it did.
    assert C.step_mode(C.resolve({"general": {"serviceTypes": ["take_away", "eat_in"]}}), "service") == "required"
    assert C.limits()["enums"]["serviceMode"] == ["types", "none"]


def test_an_order_with_no_service_is_kept_with_none(w):
    convert(w)
    out = post_orders(w, w.kiosk, order("n1", serviceType=None), order("n2"))
    assert out == {"accepted": ["n1", "n2"], "rejected": []}
    w.db.expire_all()
    rows = {r.local_id: r for r in w.db.query(KioskOrder).all()}
    assert rows["n1"].service_type is None and rows["n2"].service_type == "take_away"
    assert S.order_out(rows["n1"], full_phone=False)["serviceType"] is None
    # A word that is neither is still refused.
    bad = post_orders(w, w.kiosk, order("n3", serviceType="drive_in"))
    assert bad["rejected"] == [{"localId": "n3", "reason": "invalid:serviceType"}]


def test_the_payment_wait_logo_is_validated_and_downloaded_with_the_media():
    d = C.default_config()
    assert d["payment"]["waitLogo"] == {"media": None, "style": "plain"}
    ref = {"url": "https://cdn.example/wait-logo.png", "kind": "image", "sha256": SHA, "bytes": 120}
    good = {"payment": {"waitLogo": {"media": ref, "style": "plate"}}}
    cleaned, errors = C.validate_layer(good)
    assert errors == [] and cleaned == good
    eff = C.resolve(good)
    assert eff["payment"]["waitLogo"] == {"media": ref, "style": "plate"}
    assert ref in C.media_manifest(eff), "cached on the kiosk like the other pictures"
    # A layer that changes only the style keeps the picture of the layer under it.
    assert C.resolve(good, {"payment": {"waitLogo": {"style": "plain"}}})["payment"]["waitLogo"] == {"media": ref, "style": "plain"}
    _c, errors = C.validate_layer({"payment": {"waitLogo": {"media": {"url": "ftp://x", "kind": "image"}, "style": "glow"}}})
    got = paths(errors)
    assert got.get("payment.waitLogo.style") == "invalid_value"
    assert any(p.startswith("payment.waitLogo.media") for p in got), got
    _c, errors = C.validate_layer({"payment": {"waitLogo": {"media": {"url": "https://cdn.example/v.mp4", "kind": "video"}}}})
    assert any(p.startswith("payment.waitLogo.media") for p in paths(errors))
