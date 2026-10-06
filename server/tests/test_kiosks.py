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
        "methods": ["card"], "tipEnabled": False, "tipPresets": [10, 12, 15], "receiptPolicy": "ask",
        "customerName": "optional", "customerPhone": "off", "minOrderAgorot": 0,
    }
    assert cfg["printing"] == {
        "bonMode": "routing", "bonPrinterId": None, "bonCopies": 1, "receiptPrinterId": None, "pickupSlip": True,
    }
    assert cfg["timers"] == {"inactivitySec": 60, "warningSec": 20, "successSec": 12, "attractSlideSec": 8}
    assert cfg["hours"]["ranges"] == [{"days": [0, 1, 2, 3, 4, 5, 6], "open": "08:00", "close": "23:00"}]
    assert cfg["messages"] == [] and cfg["texts"] == {} and cfg["screenImages"] == {}
    # The defaults are what an empty path resolves to.
    assert C.resolve({}, {}, {}) == cfg


def test_defaults_endpoint_and_font_catalog(w):
    out = R.get_defaults(current_user=w.manager)
    assert out["defaults"] == C.DEFAULT_CONFIG and out["kdsAvailable"] is False
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
    assert client.get("/api/v1/kiosks/defaults").json()["defaults"]["printing"]["pickupSlip"] is True
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
    assert eff["attract"] == {"sections": ["hero", "club"], "playlist": [], "videoMuted": False, "showHelp": True}
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


def test_kds_error_message_is_the_token():
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


def test_put_settings_refuses_with_the_contract_shape(w):
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
    assert out["state"] == {"paused": False, "message": None, "since": None, "by": None}
    assert out["kdsAvailable"] is False and out["controls"] == []
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
    assert sync(w, w.kiosk)["state"] == {"paused": False, "message": None, "since": None, "by": None}
    history = R.get_kiosk_commands(machine_id=w.kiosk.id, limit=20, current_user=w.manager,
                                   active_tenant_id=w.tenant.id, db=w.db)
    assert [h["action"] for h in history] == ["resume", "pause"]


def test_pause_from_a_controlling_till(w):
    convert(w)
    out, code = till_command(w, w.till, w.kiosk, "pause", posUserName="דנה", message="רגע")
    assert code == 201 and out["source"] == "till" and out["requestedByName"] == "Till 2 · דנה"
    device = w.db.get(KioskDevice, w.kiosk.id)
    assert device.paused is True and device.paused_by == "Till 2 · דנה"
    row = w.db.query(KioskCommand).one()
    assert row.requested_by_machine_id == w.till.id and row.requested_by_user_id is None
    till_command(w, w.till, w.kiosk, "resume")
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
