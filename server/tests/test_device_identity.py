"""
Device identity and the cloud's device search (app/services/device_identity.py).

What each class pins, and how it could look fine while doing damage:

* **Heartbeat** — `serialSource` and the `cellular` block are stored, cleaned field by field
  and never a 422 (a heartbeat that fails shows the till as dead); the carriers and phone
  numbers are flattened for the search, the numbers in their local form; the address the beat
  came from is the edge's (Fly-Client-IP) or the socket's, never X-Forwarded-For.
* **Pairing** — the serial's source lands with the serial; a replacement unit drops the old
  unit's SIMs.
* **The SIM prompt's line** — the cloud composes exactly what the till composes (the shared
  fixture tests/fixtures/sim_prompt_texts.json is also in pos-android's test resources).
* **Search** — every filter, the pagination and the scope: a shop's manager never finds another
  shop's device, a tenant's never another tenant's; a super admin finds any.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import machine_search as search_router
from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody, POSMachineResponse
from app.services import ably_notify, device_identity as di
from app.services.kiosk_ops import alert_text
from shift_world import accept_str_uuids, make_world

FIXTURE = Path(__file__).parent / "fixtures" / "sim_prompt_texts.json"

CELLULAR = {
    "sims": [
        {"slot": 1, "carrier": "פרטנר", "mccMnc": "42501", "networkType": "4G", "signal": 0,
         "inService": False, "dataEnabled": True, "defaultData": True, "phoneNumber": "+972 54-123-4567"},
        {"slot": 2, "carrier": "סלקום", "mccMnc": "42502", "networkType": "5G", "signal": 3,
         "inService": True, "dataEnabled": False},
    ],
    "defaultDataSlot": 1,
    "transport": "wifi",
    "validated": False,
    "viaCellular": True,
    "lanIp": "192.168.0.207",
    "phoneStatePermission": True,
    "phoneNumberPermission": True,
}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_transmit_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def request_from(ip=None, peer="10.1.2.3", forwarded=None):
    headers = {}
    if ip:
        headers["fly-client-ip"] = ip
    if forwarded:
        headers["x-forwarded-for"] = forwarded
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host=peer) if peer else None)


def beat(w, till, payload=None, request=None):
    body = MachineHeartbeatBody.model_validate(payload) if payload is not None else None
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db, request=request)


# ── Heartbeat ────────────────────────────────────────────────────────────────


class TestHeartbeat:
    def test_the_block_and_the_source_are_stored(self, w):
        till = w.tills[0]
        beat(w, till, {"serialNumber": "K7Z2412260010", "serialSource": "ro.serialno", "cellular": CELLULAR},
             request_from(ip="31.168.1.2"))
        assert till.serial_number == "K7Z2412260010"
        assert till.serial_source == "ro.serialno"
        assert till.cellular["sims"][0]["carrier"] == "פרטנר"
        assert till.cellular["sims"][0]["phoneNumber"] == "0541234567"
        assert till.cellular["sims"][1]["networkType"] == "5G"
        assert till.cellular["viaCellular"] is True
        assert till.sim_carriers == "פרטנר,סלקום"
        assert till.phone_numbers == "0541234567"
        assert till.lan_ip == "192.168.0.207"
        assert till.last_ip == "31.168.1.2"
        assert till.cellular_reported_at is not None

    def test_the_socket_peer_without_the_edge_and_never_x_forwarded_for(self, w):
        till = w.tills[0]
        beat(w, till, {"appVersion": "1"}, request_from(peer="10.9.9.9", forwarded="6.6.6.6"))
        assert till.last_ip == "10.9.9.9"

    def test_an_old_till_changes_nothing(self, w):
        till = w.tills[0]
        beat(w, till, {"serialNumber": "F2003183A700375", "serialSource": "ftpos", "cellular": CELLULAR})
        beat(w, till, {"appVersion": "1.0", "serialNumber": "F2003183A700375"})
        assert till.serial_source == "ftpos"
        assert till.sim_carriers == "פרטנר,סלקום"
        beat(w, till, None)
        assert till.cellular["defaultDataSlot"] == 1

    def test_an_unknown_source_or_one_without_a_serial_is_dropped(self, w):
        till = w.tills[0]
        beat(w, till, {"serialNumber": "X1", "serialSource": "imei"})
        assert till.serial_source is None
        beat(w, till, {"serialSource": "build"})
        assert till.serial_source is None

    def test_garbage_never_fails_the_beat(self, w):
        body = MachineHeartbeatBody.model_validate({"cellular": "nope", "serialSource": 5})
        assert body.cellular is None and body.serial_source is None
        till = w.tills[0]
        beat(w, till, {"cellular": {"sims": [{"slot": "x"}, {"slot": 9}, "junk", {"slot": 2, "signal": 77,
                                                                                    "carrier": "x" * 90}],
                                    "lanIp": 5, "validated": "yes"}})
        assert till.cellular == {"sims": [{"slot": 2, "carrier": "x" * 40}]}
        assert till.sim_carriers == "x" * 40
        assert till.phone_numbers is None and till.lan_ip is None

    def test_no_sims_clears_the_search_columns(self, w):
        till = w.tills[0]
        beat(w, till, {"cellular": CELLULAR})
        beat(w, till, {"cellular": {"sims": [], "transport": "ethernet", "lanIp": "10.0.0.8"}})
        assert till.sim_carriers is None and till.phone_numbers is None
        assert till.lan_ip == "10.0.0.8"

    def test_the_list_and_the_page_carry_it(self, w):
        till = w.tills[0]
        beat(w, till, {"serialNumber": "S1", "serialSource": "sunmi", "cellular": CELLULAR}, request_from(ip="1.2.3.4"))
        rows = machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
            include_inactive=False, area_id=None, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        mine = next(r for r in rows if r["id"] == till.id)
        out = POSMachineResponse.model_validate(mine).model_dump(by_alias=True)
        assert out["serialSource"] == "sunmi"
        assert out["lastIp"] == "1.2.3.4" and out["lanIp"] == "192.168.0.207"
        assert out["cellular"]["sims"][1]["carrier"] == "סלקום"
        assert out["cellularReportedAt"] is not None


# ── Pairing ──────────────────────────────────────────────────────────────────


class TestPairing:
    def _create(self, device_info):
        from app.services.pairing import create_pos_machine

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None
        created = []
        db.add.side_effect = created.append
        create_pos_machine(db, distributor_id=uuid.uuid4(), tenant_id=uuid.uuid4(), device_info=device_info)
        return created[0]

    def test_the_source_lands_with_the_serial(self):
        m = self._create({"model": "HIT", "serial": "K7Z2412260010", "serial_source": "ro.serialno"})
        assert m.serial_number == "K7Z2412260010" and m.serial_source == "ro.serialno"

    def test_no_source_without_a_serial_or_an_unknown_one(self):
        assert self._create({"model": "P18", "serial_source": "build"}).serial_source is None
        assert self._create({"serial": "A1", "serial_source": "magic"}).serial_source is None
        assert self._create({"serial": "A1"}).serial_source is None


# ── The SIM prompt's line ────────────────────────────────────────────────────


class TestSimPromptText:
    def test_the_shared_fixture(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        assert len(cases) >= 7
        for case in cases:
            assert di.sim_prompt_text(case["detail"]) == case["text"]

    def test_the_owner_line_as_the_tills_get_it(self):
        detail = {"from": "sim", "fromSlot": 1, "fromCarrier": "פרטנר", "toSlot": 2, "toCarrier": "סלקום"}
        assert alert_text("קיוסק רויאל", "terminal", di.SIM_PROMPT_REASON, detail) == (
            "קיוסק רויאל — אין אינטרנט ברשת פרטנר (סים 1). לעבור לנתונים של סים 2 (סלקום)?"
        )
        assert alert_text("ק", "terminal", di.SIM_PROMPT_REASON, {}) == "ק — אין אינטרנט"

    def test_the_parameter_is_registered_on_by_default(self):
        from app.services.till_parameters import BUILTIN_PARAMETERS

        p = next(p for p in BUILTIN_PARAMETERS if p.key == di.CELLULAR_FALLBACK_KEY)
        assert p.value_type == "boolean" and p.default_value is True

    def test_phone_numbers_in_their_local_form(self):
        assert di.normalize_phone("+972-54-123-4567") == "0541234567"
        assert di.normalize_phone("054 1234567") == "0541234567"
        assert di.normalize_phone("ab") is None


# ── Search ───────────────────────────────────────────────────────────────────


def _search(w, user=None, **kw):
    f = di.SearchFilters(**{k: v for k, v in kw.items() if k not in ("skip", "limit")})
    return di.search(w.db, user or w.admin, w.tenant.id, f, skip=kw.get("skip", 0), limit=kw.get("limit", 50), now=w.now)


def _names(result):
    return sorted(r["name"] for r in result["items"])


@pytest.fixture
def fleet(w):
    """Three tills of the world, told apart by everything the search reads; and another tenant's."""
    w.now = datetime.now(timezone.utc)
    t1, t2, north = w.tills[0], w.tills[1], w.other_till
    t1.serial_number, t1.device_model, t1.app_version = "F2003183A700375", "N55F", "0.1.207-device"
    t1.last_heartbeat_at = w.now - timedelta(minutes=1)
    t2.serial_number, t2.device_model, t2.app_version = "K7Z2412260010", "P18", "0.1.190-device"
    t2.last_heartbeat_at = w.now - timedelta(hours=3)
    north.serial_number, north.device_model, north.app_version = "P1861GB2592700180", "P18", "0.1.207-device"
    north.last_heartbeat_at = None
    beat(w, t1, {"cellular": CELLULAR}, request_from(ip="31.168.1.2"))
    beat(w, t2, {"cellular": {"sims": [{"slot": 1, "carrier": "פלאפון", "phoneNumber": "0501112222"}],
                              "lanIp": "192.168.1.50"}}, request_from(ip="82.80.1.1"))
    # The beats moved last seen to now: put it back where each till is meant to be.
    t1.last_heartbeat_at = w.now - timedelta(minutes=1)
    t2.last_heartbeat_at = w.now - timedelta(hours=3)

    other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    w.db.add(other_tenant)
    w.db.flush()
    other_company = Company(id=uuid.uuid4(), tenant_id=other_tenant.id, name="Beta", vat_number="514141414")
    w.db.add(other_company)
    w.db.flush()
    other_shop = Shop(id=uuid.uuid4(), tenant_id=other_tenant.id, company_id=other_company.id, name="Eilat", settings={})
    w.db.add(other_shop)
    w.db.flush()
    stranger = POSMachine(
        id=uuid.uuid4(), tenant_id=other_tenant.id, shop_id=other_shop.id, distributor_id=w.admin.id,
        name="Eilat 1", machine_code="M-99", pos_number="1", is_active=True,
        pairing_status=PairingStatus.ASSIGNED, serial_number="F2003183A700999",
        last_heartbeat_at=w.now - timedelta(minutes=2),
    )
    w.db.add(stranger)
    w.db.flush()
    w.stranger = stranger
    w.other_tenant = other_tenant
    return w


class TestSearch:
    def test_by_serial_prefix_in_any_case(self, fleet):
        assert _names(_search(fleet, serial="f2003183")) == ["Eilat 1", "Till 1"]
        assert _names(_search(fleet, serial="K7Z2412260010")) == ["Till 2"]
        assert _search(fleet, serial="7Z24")["total"] == 0

    def test_by_till_number_name_shop_company_and_tenant(self, fleet):
        assert _names(_search(fleet, pos_number="2")) == ["Till 2"]
        assert _names(_search(fleet, name="nor")) == ["North 1"]
        assert _names(_search(fleet, shop_id=fleet.shop.id)) == ["Till 1", "Till 2"]
        assert _names(_search(fleet, company_id=fleet.company.id)) == ["North 1", "Till 1", "Till 2"]
        assert _names(_search(fleet, tenant_id=fleet.other_tenant.id)) == ["Eilat 1"]

    def test_by_model_role_and_version(self, fleet):
        from app.models.kiosk import KioskDevice

        assert _names(_search(fleet, model="p18")) == ["North 1", "Till 2"]
        fleet.db.add(KioskDevice(machine_id=fleet.tills[1].id, tenant_id=fleet.tenant.id, shop_id=fleet.shop.id,
                                 name="קיוסק", enabled=True))
        fleet.db.flush()
        kiosks = _search(fleet, role="kiosk")
        assert _names(kiosks) == ["Till 2"] and kiosks["items"][0]["deviceRole"] == "kiosk"
        assert "Till 2" not in _names(_search(fleet, role="till"))
        assert _names(_search(fleet, app_version="0.1.207")) == ["North 1", "Till 1"]

    def test_by_last_seen(self, fleet):
        assert _names(_search(fleet, last_seen="online")) == ["Eilat 1", "Till 1"]
        assert _names(_search(fleet, last_seen="24h")) == ["Eilat 1", "Till 1", "Till 2"]
        assert _names(_search(fleet, last_seen="never")) == ["North 1"]
        assert _search(fleet, last_seen="over7d")["total"] == 0

    def test_by_ip_carrier_and_phone(self, fleet):
        assert _names(_search(fleet, ip="31.168")) == ["Till 1"]
        assert _names(_search(fleet, ip="192.168.1.")) == ["Till 2"]
        assert _names(_search(fleet, carrier="סלקום")) == ["Till 1"]
        assert _names(_search(fleet, carrier="פלאפון")) == ["Till 2"]
        assert _names(_search(fleet, phone="+972-54-123-4567")) == ["Till 1"]
        assert _names(_search(fleet, phone="1112222")) == ["Till 2"]

    def test_free_text_over_all_of_it(self, fleet):
        assert _names(_search(fleet, q="k7z24")) == ["Till 2"]
        assert _names(_search(fleet, q="center")) == ["Till 1", "Till 2"]
        assert _names(_search(fleet, q="סלקום")) == ["Till 1"]
        assert _names(_search(fleet, q="054-1234567")) == ["Till 1"]
        assert _names(_search(fleet, q="82.80")) == ["Till 2"]
        assert _names(_search(fleet, q="Beta")) == ["Eilat 1"]

    def test_the_row(self, fleet):
        row = _search(fleet, serial="F2003183A700375")["items"][0]
        assert row["shopName"] == "Center" and row["companyName"] == "Acme" and row["tenantName"] == "T"
        assert row["online"] is True and row["deviceRole"] == "till"
        assert [s["carrier"] for s in row["sims"]] == ["פרטנר", "סלקום"]
        assert row["sims"][0]["phoneNumber"] == "0541234567"
        assert row["lastIp"] == "31.168.1.2" and row["lanIp"] == "192.168.0.207" and row["viaCellular"] is True

    def test_paginated_newest_seen_first(self, fleet):
        first = _search(fleet, limit=2)
        assert first["total"] == 4 and len(first["items"]) == 2
        assert [r["name"] for r in first["items"]] == ["Till 1", "Eilat 1"]
        rest = _search(fleet, skip=2, limit=2)
        assert [r["name"] for r in rest["items"]] == ["Till 2", "North 1"]
        assert _search(fleet, limit=1000)["limit"] == di.SEARCH_LIMIT_MAX

    def test_inactive_only_on_request(self, fleet):
        fleet.tills[1].is_active = False
        fleet.db.flush()
        assert "Till 2" not in _names(_search(fleet))
        assert "Till 2" in _names(_search(fleet, include_inactive=True))

    def test_a_shop_manager_finds_only_the_shop(self, fleet):
        manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=fleet.tenant.id,
                       shop_id=fleet.shop.id, email="m@x", username="m")
        fleet.db.add(manager)
        fleet.db.flush()
        assert _names(_search(fleet, user=manager)) == ["Till 1", "Till 2"]
        assert _search(fleet, user=manager, serial="P1861")["total"] == 0
        assert _search(fleet, user=manager, tenant_id=fleet.other_tenant.id)["total"] == 0

    def test_a_distributor_finds_only_its_own_in_its_tenant(self, fleet):
        dist = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=fleet.tenant.id, email="d@x", username="d")
        fleet.db.add(dist)
        fleet.db.flush()
        fleet.tills[0].distributor_id = dist.id
        fleet.db.flush()
        assert _names(_search(fleet, user=dist)) == ["Till 1"]

    def test_a_cashier_of_no_dashboard_role_sees_nothing_beyond_the_shop(self, fleet):
        other = User(id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=fleet.tenant.id,
                     shop_id=fleet.other_shop.id, email="c@x", username="c")
        fleet.db.add(other)
        fleet.db.flush()
        assert _names(_search(fleet, user=other)) == ["North 1"]

    def test_the_route(self, fleet):
        def call(**kw):
            args = dict(
                q=None, serial=None, pos_number=None, name=None, shop_id=None, company_id=None, tenant_id=None,
                model=None, role=None, app_version=None, last_seen=None, ip=None, carrier=None, phone=None,
                include_inactive=False, skip=0, limit=50, current_user=fleet.admin,
                active_tenant_id=fleet.tenant.id, db=fleet.db,
            )
            args.update(kw)
            return search_router.search_machines(**args)

        assert call(serial="K7Z")["total"] == 1
        assert call(shop_id=str(fleet.shop.id))["total"] == 2
        for bad in (dict(role="printer"), dict(last_seen="yesterday"), dict(shop_id="not-a-uuid")):
            with pytest.raises(HTTPException) as e:
                call(**bad)
            assert e.value.status_code == 400
