"""
"מסך לקוח" (app/services/customer_display.py, app/routers/customer_display.py,
P:/specs/customer-display.md).

Covers the layer's cleaning (what the dashboard may send), the resolution field by field over
company → shop → area → device, what a device pulls (a till; a paired display and its till; the
media to keep, the ETag), the cloud relay (only what is newer; stale reads idle), the pairing
role (non-fiscal, `machines/me` role, the till checked) and the dashboard's route rule. Pure
functions on plain values, and the rest on an in-memory SQLite world (never the configured DB).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401  (every mapper, so relationships resolve)
from app.database import Base
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services import customer_display as CD
from app.services import display_devices as DD


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


MEDIA = "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4"
IMAGE = "https://res.cloudinary.com/demo/image/upload/v1/slide.png"
LOGO = "https://res.cloudinary.com/demo/image/upload/v1/logo.png"


# ── The layer the dashboard sends ────────────────────────────────────────────


def test_a_layer_keeps_only_what_it_sets_and_completes_show():
    layer = CD.clean_layer(
        {"enabled": True, "theme": "light", "show": {"prices": False}, "idleTimeoutSec": 0, "welcomeText": "  שלום   לכם "},
        level="shop",
    )
    assert layer == {
        "enabled": True,
        "theme": "light",
        "show": {k: (k != "prices") for k in CD.SHOW_KEYS},
        "idleTimeoutSec": 0,
        "welcomeText": "שלום לכם",
    }
    assert CD.clean_layer(None, level="company") is None
    assert CD.clean_layer({"enabled": None}, level="company") == {}


def test_the_playlist_from_the_upload_ordered_with_durations():
    layer = CD.clean_layer(
        {"playlist": [{"url": IMAGE, "kind": "image", "durationSec": 5}, {"url": MEDIA, "kind": "video", "durationSec": 30.0, "bytes": 1234}]},
        level="company",
    )
    assert layer["playlist"] == [
        {"url": IMAGE, "kind": "image", "durationSec": 5},
        {"url": MEDIA, "kind": "video", "durationSec": 30, "bytes": 1234},
    ]
    # A slide with no duration takes the default.
    assert CD.clean_layer({"playlist": [{"url": IMAGE, "kind": "image"}]}, level="company")["playlist"][0]["durationSec"] == 8


@pytest.mark.parametrize(
    "raw",
    [
        {"layout": "sideways"},
        {"theme": "pink"},
        {"language": "fr"},
        {"enabled": "yes"},
        {"show": {"secrets": True}},
        {"show": {"items": 1}},
        {"idleTimeoutSec": -1},
        {"idleTimeoutSec": 3601},
        {"thanksSec": 1},
        {"welcomeText": "x" * 81},
        {"logoUrl": "http://evil.example/logo.png"},
        {"playlist": "nope"},
        {"playlist": [{"url": "http://plain.example/a.png", "kind": "image"}]},
        {"playlist": [{"url": IMAGE, "kind": "gif"}]},
        {"playlist": [{"url": IMAGE, "kind": "image", "durationSec": 2}]},
        {"playlist": [{"url": IMAGE, "kind": "image", "durationSec": 301}]},
        {"playlist": [{"url": IMAGE, "kind": "image"}] * 21},
        {"cashierName": "x"},
    ],
)
def test_anything_else_is_refused_in_hebrew(raw):
    with pytest.raises(CD.CustomerDisplayError) as err:
        CD.clean_layer(raw, level="shop")
    assert err.value.code == "customer_display_invalid"
    assert any("\u0590" <= ch <= "\u05ff" for ch in err.value.message)


def test_the_mirrored_till_only_on_a_devices_own_layer_and_the_device_flag_never_from_outside():
    till = str(uuid.uuid4())
    assert CD.clean_layer({"mirrorTillId": till}, level="machine") == {"mirrorTillId": till}
    with pytest.raises(CD.CustomerDisplayError):
        CD.clean_layer({"mirrorTillId": till}, level="shop")
    assert CD.clean_layer({"device": True, "enabled": True}, level="machine") == {"enabled": True}


# ── The resolution ───────────────────────────────────────────────────────────


def test_off_by_default_and_the_deepest_layer_wins_field_by_field():
    effective, sources = CD.resolve([("company", {}), ("shop", {}), ("area", {}), ("machine", {})])
    assert effective == CD.DEFAULTS and effective["enabled"] is False and sources == {}
    effective, sources = CD.resolve(
        [
            ("company", {"enabled": True, "theme": "light", "playlist": [{"url": IMAGE, "kind": "image", "durationSec": 5}]}),
            ("shop", {"theme": "brand", "idleTimeoutSec": 60}),
            ("area", {}),
            ("machine", {"enabled": False, "playlist": []}),
        ]
    )
    assert effective["enabled"] is False and sources["enabled"] == "machine"
    assert effective["theme"] == "brand" and sources["theme"] == "shop"
    assert effective["idleTimeoutSec"] == 60
    # The playlist replaces as a whole: the till's empty list wins over the company's.
    assert effective["playlist"] == [] and sources["playlist"] == "machine"


def test_a_stored_value_that_no_longer_fits_falls_through():
    effective, sources = CD.resolve([("company", {"theme": "light"}), ("machine", {"theme": "neon", "idleTimeoutSec": "5"})])
    assert effective["theme"] == "light" and sources["theme"] == "company"
    assert effective["idleTimeoutSec"] == CD.IDLE_DEFAULT and "idleTimeoutSec" not in sources


def test_the_media_to_keep_logo_first_then_the_playlist_once_each():
    effective = dict(CD.DEFAULTS, playlist=[
        {"url": IMAGE, "kind": "image", "durationSec": 5},
        {"url": MEDIA, "kind": "video", "durationSec": 9, "bytes": 99},
        {"url": IMAGE, "kind": "image", "durationSec": 7},
    ])
    assert CD.media_of(effective, {"logoUrl": LOGO}) == [
        {"url": LOGO, "kind": "image", "bytes": None},
        {"url": IMAGE, "kind": "image", "bytes": None},
        {"url": MEDIA, "kind": "video", "bytes": 99},
    ]
    assert CD.etag_of({"a": 1}) == CD.etag_of({"a": 1}) != CD.etag_of({"a": 2})


# ── A world ──────────────────────────────────────────────────────────────────

_TABLES = ("tenants", "companies", "shops", "shop_areas", "pos_machines", "kitchen_print_hosts", "customer_display_states")


@pytest.fixture
def world():
    engine = create_engine("sqlite://")
    for name in _TABLES:
        Base.metadata.tables[name].create(engine)
    db = sessionmaker(bind=engine)()
    tenant = Tenant(id=uuid.uuid4(), name="T", slug="t", settings={"brandLogoUrl": LOGO, "brandPrimaryColor": "#112233"})
    db.add(tenant)
    db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="חברה", settings={})
    db.add(company)
    db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="סניף הרצליה", settings={})
    other = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="סניף אחר", settings={})
    db.add_all([shop, other])
    db.flush()
    area = ShopArea(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, name="בר", settings={})
    db.add(area)
    db.flush()

    def machine(name, s, *, fiscal=True, number=None, area_id=None):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=tenant.id, shop_id=s.id, distributor_id=uuid.uuid4(), name=name,
            machine_code=f"M-{uuid.uuid4().hex[:8]}", pos_number=number, is_active=True, is_fiscal=fiscal,
            area_id=area_id, settings={},
        )
        db.add(m)
        db.flush()
        return m

    till = machine("קופה ראשית", shop, number="1", area_id=area.id)
    till2 = machine("קופה בר", shop, number="2")
    far = machine("קופה רחוקה", other, number="1")
    screen = machine("מסך לקוח", shop, fiscal=False)
    CD.apply_on_pairing(screen, {CD.MIRROR_KEY: str(till.id)})
    db.commit()
    return SimpleNamespace(db=db, tenant=tenant, company=company, shop=shop, other=other, area=area,
                           till=till, till2=till2, far=far, screen=screen)


def test_layers_on_the_real_entities_and_branding_from_the_tenant(world):
    w = world
    CD.write_layer(w.company, "company", {"enabled": True, "playlist": [{"url": IMAGE, "kind": "image", "durationSec": 5}]})
    CD.write_layer(w.area, "area", {"theme": "light"})
    w.db.commit()
    payload = CD.device_payload(w.db, w.till)
    assert payload["role"] == "till"
    assert payload["config"]["enabled"] is True and payload["config"]["theme"] == "light"
    assert payload["sources"] == {"enabled": "company", "playlist": "company", "theme": "area"}
    assert payload["branding"] == {"shopName": "סניף הרצליה", "logoUrl": LOGO, "primaryColor": "#112233"}
    assert [m["url"] for m in payload["media"]] == [LOGO, IMAGE]
    # The till is mirrored by the paired screen: it serves its state, with its own token.
    assert payload["serve"] is True and payload["displays"] == 1
    assert payload["token"] == CD.display_token(w.till.id) != CD.display_token(w.till2.id)
    assert CD.device_payload(w.db, w.till2)["serve"] is False
    # A kitchen screen (non-fiscal, no customer-display mark) is neither: it shows no customer screen.
    w.till2.is_fiscal = False
    w.db.commit()
    kds = CD.device_payload(w.db, w.till2)
    assert kds["role"] == "none" and "token" not in kds and "till" not in kds


def test_a_layer_written_keeps_the_rest_of_the_settings_and_clears_to_inherit(world):
    w = world
    w.shop.settings = {"tipPresets": [10, 12]}
    w.db.commit()
    CD.write_layer(w.shop, "shop", {"enabled": True})
    w.db.commit()
    assert w.shop.settings == {"tipPresets": [10, 12], "customerDisplay": {"enabled": True}}
    assert w.shop.settings_updated_at is not None
    CD.write_layer(w.shop, "shop", None)
    w.db.commit()
    assert w.shop.settings == {"tipPresets": [10, 12]}


def test_a_paired_screen_is_a_customer_display_of_its_till(world):
    w = world
    assert CD.is_display_device(w.screen) and not CD.is_display_device(w.till)
    assert DD.role_of_display(w.db, w.screen) == DD.ROLE_CUSTOMER_DISPLAY
    payload = CD.device_payload(w.db, w.screen)
    assert payload["role"] == "display"
    assert payload["config"]["enabled"] is True  # on, from its own layer
    assert payload["till"]["machineId"] == str(w.till.id)
    assert payload["till"]["name"] == "קופה 1 · קופה ראשית"
    assert payload["till"]["token"] == CD.display_token(w.till.id)
    assert payload["till"]["lan"] == {"address": None, "port": None}
    # Where the till listens, once it reported.
    from app.services.printers import report_print_host

    report_print_host(w.db, w.till, "192.168.1.20", 8399)
    w.db.commit()
    assert CD.device_payload(w.db, w.screen)["till"]["lan"] == {"address": "192.168.1.20", "port": 8399}
    # A dashboard write replaces the layer's fields, but never drops what it is, nor the till it mirrors.
    CD.write_layer(w.screen, "machine", {"theme": "light"})
    w.db.commit()
    assert CD.is_display_device(w.screen) and CD.mirrored_till_id(w.screen) == str(w.till.id)
    assert CD.layer_view("machine", w.screen, [])["own"] == {"mirrorTillId": str(w.till.id), "theme": "light"}


def test_the_till_to_mirror_is_an_active_till_of_the_same_shop(world):
    w = world
    assert CD.check_till_for_display(w.db, w.shop.id, w.till2.id) is w.till2
    for bad in (w.far.id, w.screen.id, uuid.uuid4(), "not-a-uuid"):
        with pytest.raises(CD.CustomerDisplayError) as err:
            CD.check_till_for_display(w.db, w.shop.id, bad)
        assert err.value.code == "customer_display_till_invalid"
    w.till2.is_active = False
    w.db.commit()
    with pytest.raises(CD.CustomerDisplayError):
        CD.check_till_for_display(w.db, w.shop.id, w.till2.id)


# ── The relay ────────────────────────────────────────────────────────────────


def _state(phase="basket", total=4500):
    return {"v": 1, "seq": 1, "phase": phase, "lines": [{"id": "l1", "name": "קפה", "qty": 1, "total": total}],
            "promotions": [], "vouchers": [], "discount": 0, "total": total, "itemCount": 1,
            "tip": None, "payment": None, "cash": None, "thanks": None}


def test_the_relay_hands_a_display_only_what_is_newer(world):
    w = world
    first = CD.get_state(w.db, w.till.id)
    assert first["seq"] == 0 and first["state"]["phase"] == "idle" and first["stale"] is True
    assert CD.get_state(w.db, w.till.id, after=0) is None
    assert CD.put_state(w.db, w.till, _state()) == 1
    assert CD.put_state(w.db, w.till, _state(total=5000)) == 2
    w.db.commit()
    got = CD.get_state(w.db, w.till.id, after=1)
    assert got["seq"] == 2 and got["state"]["total"] == 5000 and got["stale"] is False
    assert CD.get_state(w.db, w.till.id, after=2) is None


def test_a_state_left_behind_reads_idle(world):
    w = world
    CD.put_state(w.db, w.till, _state())
    w.db.commit()
    later = datetime.now(timezone.utc) + CD.STATE_STALE_AFTER + timedelta(seconds=1)
    got = CD.get_state(w.db, w.till.id, after=1, now=later)
    assert got["stale"] is True and got["state"]["phase"] == "idle"


@pytest.mark.parametrize("bad", [None, "x", {"v": 2}, {"phase": "basket"}, {"v": 1, "pad": "x" * (CD.STATE_MAX_BYTES + 1)}])
def test_the_relay_takes_only_a_small_version_1_state(world, bad):
    with pytest.raises(CD.CustomerDisplayError):
        CD.put_state(world.db, world.till, bad)


# ── The routes ───────────────────────────────────────────────────────────────


def test_the_device_config_answers_304_on_its_etag(world):
    from app.routers import customer_display as R

    w = world
    req = SimpleNamespace(headers={})
    first = R.get_device_config(machine_id=str(w.till.id), request=req, machine=w.till, db=w.db)
    etag = first.headers["ETag"]
    again = R.get_device_config(machine_id=str(w.till.id), request=SimpleNamespace(headers={"if-none-match": etag}), machine=w.till, db=w.db)
    assert again.status_code == 304
    CD.write_layer(w.shop, "shop", {"enabled": True})
    w.db.commit()
    changed = R.get_device_config(machine_id=str(w.till.id), request=SimpleNamespace(headers={"if-none-match": etag}), machine=w.till, db=w.db)
    assert changed.status_code == 200 and changed.headers["ETag"] != etag


def test_a_till_pushes_and_its_screen_reads_through_the_cloud(world):
    from app.routers import customer_display as R

    w = world
    assert R.put_till_state(machine_id=str(w.till.id), body={"state": _state()}, machine=w.till, db=w.db) == {"seq": 1}
    got = R.get_display_state(machine_id=str(w.screen.id), after=None, machine=w.screen, db=w.db)
    assert got["seq"] == 1 and got["state"]["phase"] == "basket"
    assert R.get_display_state(machine_id=str(w.screen.id), after=1, machine=w.screen, db=w.db).status_code == 204
    # A till is no customer display: it cannot read another's screen.
    with pytest.raises(HTTPException) as err:
        R.get_display_state(machine_id=str(w.till2.id), after=None, machine=w.till2, db=w.db)
    assert err.value.status_code == 409
    with pytest.raises(HTTPException) as err:
        R.put_till_state(machine_id=str(w.till.id), body={"state": {"v": 9}}, machine=w.till, db=w.db)
    assert err.value.status_code == 422


def test_binding_a_screen_moves_which_till_serves(world):
    from app.routers import customer_display as R

    w = world
    with patch.object(R, "_entity_and_parents", return_value=(w.screen, [])), patch.object(R, "_notify"), \
            patch.object(R, "_notify_tills") as tills:
        row = R.bind_display(machine_id=str(w.screen.id), body={"tillMachineId": str(w.till2.id)},
                             current_user=None, active_tenant_id=None, db=w.db)
    assert row["mirrorTillId"] == str(w.till2.id)
    assert tills.call_args.args[1] == {str(w.till.id), str(w.till2.id)}
    assert CD.device_payload(w.db, w.till2)["serve"] is True
    assert CD.device_payload(w.db, w.till)["serve"] is False
    with patch.object(R, "_entity_and_parents", return_value=(w.screen, [])), patch.object(R, "_notify"), patch.object(R, "_notify_tills"):
        row = R.bind_display(machine_id=str(w.screen.id), body={"tillMachineId": None}, current_user=None, active_tenant_id=None, db=w.db)
    assert row["mirrorTillId"] is None and CD.is_display_device(w.screen)
    with patch.object(R, "_entity_and_parents", return_value=(w.screen, [])), pytest.raises(HTTPException) as err:
        R.bind_display(machine_id=str(w.screen.id), body={"tillMachineId": str(w.far.id)}, current_user=None, active_tenant_id=None, db=w.db)
    assert err.value.status_code == 422 and err.value.detail["code"] == "customer_display_till_invalid"


def test_a_dashboard_write_is_cleaned_and_its_devices_told(world):
    from app.routers import customer_display as R

    w = world
    with patch.object(R, "_entity_and_parents", return_value=(w.shop, [("company", w.company)])), \
            patch.object(R, "_notify") as notify:
        view = R.put_layer(level="shop", entity_id=str(w.shop.id), body={"settings": {"enabled": True, "theme": "dark"}},
                           current_user=None, active_tenant_id=None, db=w.db)
    assert view["own"] == {"enabled": True, "theme": "dark"} and view["effective"]["enabled"] is True
    notify.assert_called_once()
    with patch.object(R, "_entity_and_parents", return_value=(w.shop, [])), pytest.raises(HTTPException) as err:
        R.put_layer(level="shop", entity_id=str(w.shop.id), body={"settings": {"theme": "neon"}},
                    current_user=None, active_tenant_id=None, db=w.db)
    assert err.value.status_code == 422 and err.value.detail["field"] == "theme"


# ── Pairing, and what the routes are ─────────────────────────────────────────


def test_a_customer_display_is_a_non_fiscal_role_a_browser_may_run():
    assert DD.ROLE_CUSTOMER_DISPLAY in DD.NON_FISCAL_ROLES and DD.ROLE_CUSTOMER_DISPLAY in DD.WEB_ROLES
    assert DD.is_fiscal_role("customer_display") is False
    assert DD.web_platform_refusal("web", "customer_display") is None
    assert "customer_display" in DD.REQUIRES_SHOP_MESSAGES


def test_a_pairing_code_checks_its_till_and_marks_the_device(world):
    w = world
    opts = DD.check_pairing_request(
        w.db, role="customer_display", shop_id=w.shop.id, kds=SimpleNamespace(name="  מסך   קופה 2 ", till_machine_id=w.till2.id),
    )
    assert opts == {"name": "מסך קופה 2", "mirrorTillId": str(w.till2.id)}
    from app.services.device_profile import DeviceProfileRefused

    with pytest.raises(DeviceProfileRefused) as err:
        DD.check_pairing_request(w.db, role="customer_display", shop_id=w.shop.id, kds=SimpleNamespace(name=None, till_machine_id=w.far.id))
    assert err.value.status_code == 422
    with pytest.raises(DeviceProfileRefused):
        DD.check_pairing_request(w.db, role="customer_display", shop_id=None, kds=None)


def test_the_routes_are_mounted_and_guarded():
    from app.main import app
    from app.services.dashboard_sections import rule_for

    paths = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set())}
    for method, path in [
        ("GET", "/api/v1/customer-display/settings/{level}/{entity_id}"),
        ("PUT", "/api/v1/customer-display/settings/{level}/{entity_id}"),
        ("GET", "/api/v1/customer-display/displays"),
        ("PUT", "/api/v1/customer-display/displays/{machine_id}/till"),
        ("GET", "/api/v1/sync/{machine_id}/customer-display"),
        ("PUT", "/api/v1/sync/{machine_id}/customer-display/state"),
        ("GET", "/api/v1/sync/{machine_id}/customer-display/state"),
        ("PUT", "/api/v1/sync/{machine_id}/customer-display/lan"),
    ]:
        assert (method, path) in paths, path
    rule = rule_for("PUT", "/customer-display/settings/{}/{}")
    assert rule.kind == "section" and set(rule.sections) == {"till_settings", "devices"}
    assert rule_for("GET", "/sync/{}/customer-display").kind == "till"
