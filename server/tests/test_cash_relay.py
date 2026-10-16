"""
"קיוסק מארח וניתוב ענן/מקומי" — the server's part (P:/specs/cash-paylink.md §14; app/services/cash_host.py,
cash_params.py, cash_stations.py, cash_relay.py, cash_station_admin.py; app/routers/cash_stations_sync.py,
cash_stations.py).

* The host kiosk ("מארח עמדת מזומן", §14.1): who may be one, on / off from the dashboard (and off only without active
  stations), a station's host may be one, `GET /sync/{m}/cash` gives it the client's answer with the host's in
  `host`, its heartbeat, journal and command acks are taken like a dedicated host's, the offline watch covers it.
* `cashRoute` (§14.2): a built-in, enum lan | cloud | auto, typed for the client; the host's answer names each
  client's route and each station's `relay`.
* The relay (§14.4): a client's call kept by its `requestId` (the same again — the same; other content — 409),
  refused unless assigned / not on the LAN / the station has a host / a §11.4 call of it; handed to the host once;
  its answer back to the client; lapses (`expired`, `lost`); the long poll (`relay: false` — no wait).
* The shared golden `cash_relay_golden.json` (the same bytes in kiosk-desktop and pos-android): its signature, its
  shapes as this server makes them.
* The migration: additive, idempotent, offline (PostgreSQL), on the single head.

Runs on the in-memory SQLite world (tests/shift_world.py, via tests/test_cash_stations.py's world).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException, Response

from app.middleware import auth
from app.models.cash_station import CashHostCommand, CashRelayRequest, CashStation
from app.models.pos_machine import PairingStatus, POSMachine
from app.routers import cash_stations as CR
from app.routers import cash_stations_sync as CSR
from app.services import cash_alerts as CA
from app.services import cash_host as CH
from app.services import cash_params as CP
from app.services import cash_relay as CRL
from app.services import cash_station_admin as A
from app.services import cash_stations as CS
from app.services import till_parameters as TP
from test_cash_stations import KIOSK_ID, enable_kiosk, now, set_param, w  # noqa: F401 - `w` is the world fixture

FIXTURES = Path(__file__).absolute().parent / "fixtures" / "kiosk_desktop"
#: SHA-256 of cash_relay_golden.json (LF bytes) — the same pinned in kiosk-desktop and pos-android.
GOLDEN_SHA256 = "1e677302bb731f7677308b68413d6f3c2be31eadf72a5c18d34c19e1ac4bc163"
TX = "7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b"


def golden():
    return json.loads((FIXTURES / "cash_relay_golden.json").read_text(encoding="utf-8"))


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def inline(monkeypatch):
    """The routers' DB steps inline (the in-memory SQLite world has one connection per thread)."""

    async def _inline(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(CSR, "run_in_threadpool", _inline)
    monkeypatch.setattr(CRL, "_last_purge", None)


def sign(secret, method, path, ts, nonce, body):
    canonical = "\n".join([method.upper(), path, str(ts), nonce, hashlib.sha256(body.encode("utf-8")).hexdigest()])
    return base64.urlsafe_b64encode(hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def windows_kiosk(w, name="קיוסק מארח", code="K-H"):
    from app.models.kiosk import KioskDevice

    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name=name,
        machine_code=code, pos_number="11", is_active=True, pairing_status=PairingStatus.ASSIGNED, platform="windows",
        last_heartbeat_at=now() - timedelta(seconds=5),
    )
    w.db.add(m)
    w.db.flush()
    w.db.add(KioskDevice(machine_id=m.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name=name, enabled=True))
    w.db.commit()
    return m


def call(w, client, *, request_id=None, method="POST", path=None, body='{"reason":"customer"}', station=None,
         client_id=None, ts="1760000000000", nonce="nonce-relay-test-0001", sig="A" * 43, wait=0):
    station = station or w.station
    return {
        "requestId": request_id or str(uuid.uuid4()),
        "stationId": str(station.id),
        "method": method,
        "path": path or f"/cash/stations/{station.id}/tx/{TX}/cancel",
        "client": client_id or str(client.id),
        "ts": ts,
        "nonce": nonce,
        "sig": sig,
        "body": body,
        "waitMs": wait,
    }


def cloud_client(w, route="cloud"):
    """The world's kiosk takes cash at the station, its route `route`."""
    enable_kiosk(w, w.station.id)
    set_param(w, CP.ROUTE_KEY, "machine", w.kiosk.id, route)
    return w.kiosk


def refused(fn, *args, **kwargs):
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    detail = e.value.detail
    return e.value.status_code, (detail.get("code") if isinstance(detail, dict) else detail)


# ── cashRoute (§14.2) ──────────────────────────────────────────────────────────


class TestRouteParameter:
    def test_a_builtin_enum_lan_by_default_typed_for_the_client(self, w):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        assert specs["cashRoute"].default_value == "lan"
        assert specs["cashRoute"].enum_options == ("lan", "cloud", "auto")
        assert "cashRoute" in CP.KIOSK_KEYS and "cashRoute" not in CP.STATION_KEYS
        assert TP.validate_keyed_value("cashRoute", "cloud") == "cloud"
        with pytest.raises(Exception):
            TP.validate_keyed_value("cashRoute", "wifi")
        assert [CP.route_of(v) for v in ("lan", "cloud", "auto", "x", None)] == ["lan", "cloud", "auto", "lan", "lan"]
        enable_kiosk(w, w.station.id)
        assert CS.client_view(w.db, w.kiosk)["settings"]["cashRoute"] == "lan"
        set_param(w, CP.ROUTE_KEY, "shop", w.shop.id, "auto")
        assert CS.client_view(w.db, w.kiosk)["settings"]["cashRoute"] == "auto"
        # The device's own value overrides its shop's (§14.2: the device level is its override).
        set_param(w, CP.ROUTE_KEY, "machine", w.kiosk.id, "cloud")
        assert CS.client_view(w.db, w.kiosk)["settings"]["cashRoute"] == "cloud"

    def test_the_host_hears_each_clients_route_and_whether_to_listen(self, w):
        enable_kiosk(w, w.station.id)
        (station,) = CS.host_view(w.db, w.host)["stations"]
        assert station["relay"] is False
        assert station["clients"] == [{"machineId": str(w.kiosk.id), "name": "קיוסק 3", "kind": "kiosk", "route": "lan"}]
        assert CRL.relay_wanted(w.db, w.host) is False
        set_param(w, CP.ROUTE_KEY, "machine", w.kiosk.id, "auto")
        (station,) = CS.host_view(w.db, w.host)["stations"]
        assert station["relay"] is True and station["clients"][0]["route"] == "auto"
        assert CRL.relay_wanted(w.db, w.host) is True
        # The dashboard's station page shows each client's way too.
        assert A.station_out(w.db, w.station)["clients"][0]["route"] == "auto"


    def test_the_station_page_sets_a_kiosks_route(self, w):
        from fastapi import BackgroundTasks

        out = CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=True, route="cloud"),
                                         BackgroundTasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["clients"][0]["route"] == "cloud"
        assert CS.client_view(w.db, w.kiosk)["settings"]["cashRoute"] == "cloud"
        assert CRL.relay_wanted(w.db, w.host) is True
        # Assigned again without a route: the route stays.
        out = CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=True), BackgroundTasks(),
                                         current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["clients"][0]["route"] == "cloud"
        with pytest.raises(HTTPException) as e:
            CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=True, route="wifi"),
                                       BackgroundTasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 422 and e.value.detail["code"] == "invalid_route"


# ── The host kiosk (§14.1) ────────────────────────────────────────────────────


class TestEmbeddedHost:
    def test_who_may_be_one(self, w):
        k = windows_kiosk(w)
        assert CH.embedded_refusal(k) is None
        assert "Windows" in CH.embedded_refusal(w.till1)  # an Android till
        assert CH.embedded_refusal(w.host) and "ייעודי" in CH.embedded_refusal(w.host)
        k.is_fiscal = False
        assert CH.embedded_refusal(k)
        k.is_fiscal = True
        k.shop_id = None
        assert CH.embedded_refusal(k)
        w.db.rollback()
        # The flag alone is not enough: a device that may not be one never hosts.
        w.till1.cash_host_embedded = True
        assert not CH.is_embedded_host(w.till1) and not CH.hosts_cash(w.till1)
        k = w.db.get(POSMachine, k.id)
        k.cash_host_embedded = True
        assert CH.is_embedded_host(k) and CH.hosts_cash(k) and not CH.is_cash_host(k)
        assert CH.hosts_cash(w.host)

    def test_on_and_off_from_the_dashboard(self, w):
        k = windows_kiosk(w)
        out = CR.get_embedded_host(k.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out == {"machineId": str(k.id), "name": "קיוסק מארח", "embedded": False, "allowed": True, "reason": None,
                       "active": False, "shopId": str(w.shop.id), "stations": []}
        out = CR.put_embedded_host(k.id, CR.EmbeddedHostIn(embedded=True), current_user=w.admin,
                                   active_tenant_id=w.tenant.id, db=w.db)
        assert out["embedded"] is True and out["active"] is True
        assert w.db.get(POSMachine, k.id).cash_host_embedded is True
        assert (k.id, "cash_stations") in w.woken
        # A station may now name it its host.
        station = CS.get_station(w.db, CR.create_cash_station(
            CR.StationIn(shopId=w.shop.id, name="עמדה בקיוסק", hostMachineId=k.id), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db)["stationId"])
        assert station.host_machine_id == k.id and CS.host_of(w.db, station).id == k.id
        assert A.station_out(w.db, station)["host"]["embedded"] is True
        out = CR.get_embedded_host(k.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert [s["name"] for s in out["stations"]] == ["עמדה בקיוסק"]
        # Off only once no active station names it.
        with pytest.raises(HTTPException) as e:
            CR.put_embedded_host(k.id, CR.EmbeddedHostIn(embedded=False), current_user=w.admin,
                                 active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 409 and e.value.detail["code"] == "host_has_stations"
        assert [s["name"] for s in e.value.detail["stations"]] == ["עמדה בקיוסק"]
        assert w.db.get(POSMachine, k.id).cash_host_embedded is True
        CR.put_cash_station(station.id, CR.StationIn(hostMachineId=w.host.id), current_user=w.admin,
                            active_tenant_id=w.tenant.id, db=w.db)
        out = CR.put_embedded_host(k.id, CR.EmbeddedHostIn(embedded=False), current_user=w.admin,
                                   active_tenant_id=w.tenant.id, db=w.db)
        assert out["embedded"] is False and out["active"] is False

    def test_refused_for_a_device_that_may_not_be_one(self, w):
        with pytest.raises(HTTPException) as e:
            CR.put_embedded_host(w.till1.id, CR.EmbeddedHostIn(embedded=True), current_user=w.admin,
                                 active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 409 and e.value.detail["code"] == "embedded_host_not_allowed"
        assert "Windows" in e.value.detail["message"]
        out = CR.get_embedded_host(w.host.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["allowed"] is False and out["reason"]
        with pytest.raises(HTTPException) as e:
            CR.get_embedded_host(uuid.uuid4(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 404
        # A station's host: a plain kiosk is still refused.
        with pytest.raises(HTTPException) as e:
            CR.put_cash_station(w.station.id, CR.StationIn(hostMachineId=w.kiosk.id), current_user=w.admin,
                                active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.detail["code"] == "not_a_cash_host"

    def test_its_cash_view_is_the_clients_with_the_hosts(self, w):
        k = windows_kiosk(w)
        k.cash_host_embedded = True
        w.station.host_machine_id = k.id
        w.db.commit()
        # It takes cash at its own station; another kiosk at it through the cloud.
        set_param(w, CP.ENABLED_KEY, "machine", k.id, True)
        set_param(w, CP.STATION_KEY, "machine", k.id, str(w.station.id))
        cloud_client(w, "cloud")
        view = CSR.get_cash(str(k.id), request=None, response=Response(), machine=k, db=w.db)
        assert view["role"] == "client" and view["enabled"] is True
        assert view["station"]["hostId"] == str(k.id)
        host = view["host"]
        assert host["role"] == "host" and host["hostId"] == str(k.id) and len(host["hostSecret"]) == 64
        (station,) = host["stations"]
        assert station["stationId"] == str(w.station.id) and station["relay"] is True
        assert {c["machineId"]: c["route"] for c in station["clients"]} == {str(k.id): "lan", str(w.kiosk.id): "cloud"}
        # Its own secret as a client is the one its host part derives.
        assert view["station"]["secret"] == CS.client_secret(host["hostSecret"], k.id)
        # Its own payments never need the relay: only it on the station — none.
        set_param(w, CP.ROUTE_KEY, "machine", k.id, "cloud")
        set_param(w, CP.ROUTE_KEY, "machine", w.kiosk.id, "lan")
        assert CS.host_view(w.db, k)["stations"][0]["relay"] is False
        # Another kiosk: no `host`; the dedicated host: the host's answer as before.
        assert "host" not in CS.view_for(w.db, w.kiosk)
        assert CS.view_for(w.db, w.host)["role"] == "host"
        # Flag off: a plain kiosk again — its station has no host now (no tile anywhere).
        k.cash_host_embedded = False
        w.db.commit()
        assert "host" not in CS.view_for(w.db, k) and CS.host_of(w.db, w.station) is None

    def test_its_heartbeat_journal_and_acks_are_a_hosts(self, w):
        k = windows_kiosk(w)
        w.station.host_machine_id = k.id
        w.db.commit()
        block = {"api": 1, "lanAddress": "192.168.1.41", "port": 47630, "version": "0.6.0",
                 "stations": [{"stationId": str(w.station.id), "state": "ready", "alerts": []}]}
        assert CS.apply_heartbeat(w.db, k, block) is False  # not a host yet
        with pytest.raises(HTTPException) as e:
            auth._refuse_unless_cash_host(k)
        assert e.value.detail["code"] == "cash_host_only"
        k.cash_host_embedded = True
        w.db.commit()
        assert CS.apply_heartbeat(w.db, k, block) is True
        assert CS.host_lan(k) == ("192.168.1.41", 47630)
        assert auth._refuse_unless_cash_host(k) is k
        out = CSR.post_cash_journal(str(k.id), CSR.JournalIn(entries=[]), machine=k, db=w.db)
        assert out["accepted"] == [] and out["rejected"] == []
        command = CS.create_command(w.db, w.admin, w.station, "reset_alerts", {})
        w.db.commit()
        acked = CSR.post_cash_command_ack(str(k.id), str(command.id), CSR.CommandAckIn(status="done"), machine=k, db=w.db)
        assert acked["command"]["status"] == "done"
        assert w.db.get(CashHostCommand, command.id).status == "done"

    def test_the_offline_watch_covers_it(self, w):
        k = windows_kiosk(w)
        k.cash_host_embedded = True
        w.station.host_machine_id = k.id
        k.last_heartbeat_at = now() - timedelta(minutes=5)
        w.db.commit()
        assert CA.scan_offline(w.db) >= 1
        codes = [(r.details or {}).get("code") for r in CA.rows_of_station(w.db, w.station.id)]
        assert "offline" in codes


# ── The relay (§14.4) ─────────────────────────────────────────────────────────


class TestRelaySubmit:
    def test_kept_by_its_id_the_same_again_is_the_same(self, w):
        client = cloud_client(w)
        body = call(w, client)
        row = CRL.submit(w.db, client, body)
        w.db.commit()
        assert (row.state, row.host_machine_id, row.client_machine_id, row.station_id) == (
            "pending", w.host.id, client.id, w.station.id)
        assert row.signed == {"client": str(client.id), "ts": "1760000000000", "nonce": "nonce-relay-test-0001",
                              "sig": "A" * 43}
        assert row.body == '{"reason":"customer"}' and row.method == "POST"
        again = CRL.submit(w.db, client, dict(body))
        assert again.id == row.id and w.db.query(CashRelayRequest).count() == 1
        assert refused(CRL.submit, w.db, client, {**body, "nonce": "nonce-relay-test-0002"}) == (409, "relay_conflict")

    def test_refusals(self, w):
        enable_kiosk(w, w.station.id)
        client = w.kiosk
        # Its route is the LAN (the default).
        assert refused(CRL.submit, w.db, client, call(w, client)) == (409, "cloud_route_off")
        set_param(w, CP.ROUTE_KEY, "machine", client.id, "auto")
        assert CRL.submit(w.db, client, call(w, client)).state == "pending"
        # Not a client of this station: another device, another station, cash off.
        other = CashStation(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                            host_machine_id=w.host.id, name="עמדה 3", serial="AE000003")
        w.db.add(other)
        w.db.commit()
        assert refused(CRL.submit, w.db, client, call(w, client, station=other)) == (403, "not_assigned")
        assert refused(CRL.submit, w.db, w.till1, call(w, w.till1)) == (403, "not_assigned")
        # The station's host gone: no relay.
        w.station.host_machine_id = None
        w.db.commit()
        assert refused(CRL.submit, w.db, client, call(w, client)) == (409, "no_host")
        w.station.host_machine_id = w.host.id
        w.db.commit()
        # Its form: a §11.4 call of that station, signed as the device itself.
        bad = [
            {"requestId": "nope"},
            {"method": "PUT"},
            {"path": "/cash/health"},
            {"path": f"/cash/stations/{w.station.id}/events"},
            {"path": f"/cash/stations/{other.id}/status", "method": "GET", "body": ""},
            {"path": f"/cash/stations/{w.station.id}/status?x=1", "method": "GET", "body": ""},
            {"path": f"/cash/stations/{w.station.id}/tx/{TX}/void"},
            {"method": "GET", "path": f"/cash/stations/{w.station.id}/status", "body": "{}"},
            {"client": str(w.till1.id)},
            {"nonce": "short"},
            {"sig": "x" * 42},
            {"ts": "17600"},
            {"body": "x" * (CRL.BODY_MAX + 1)},
        ]
        for change in bad:
            status_code, code = refused(CRL.submit, w.db, client, {**call(w, client), **change})
            assert (status_code, code) == (422, "bad_request"), change

    def test_every_lan_call_of_its_station_is_relayed(self, w):
        client = cloud_client(w)
        sid = str(w.station.id)
        for method, rest, body in (
            ("GET", "status", ""), ("POST", "lease", '{"txId":"x"}'), ("DELETE", "lease/0b7c6d5e-aaaa-4bbb-8ccc-0123456789ab", ""),
            ("POST", f"tx/{TX}/start", "{}"), ("GET", f"tx/{TX}", ""), ("POST", f"tx/{TX}/cancel", "{}"),
            ("POST", f"tx/{TX}/ack", "{}"), ("POST", f"tx/{TX}/split", "{}"), ("POST", f"tx/{TX}/finish", "{}"),
        ):
            assert CRL.is_station_call(method, f"/cash/stations/{sid}/{rest}", sid), (method, rest)
            assert CRL.submit(w.db, client, call(w, client, method=method, path=f"/cash/stations/{sid}/{rest}", body=body))
        assert not CRL.is_station_call("GET", "/cash/health", sid)


class TestRelayHost:
    def test_handed_once_answered_once(self, w):
        client = cloud_client(w)
        first = CRL.submit(w.db, client, call(w, client))
        second = CRL.submit(w.db, client, call(w, client, method="GET", path=f"/cash/stations/{w.station.id}/status", body=""))
        w.db.commit()
        taken = CRL.take(w.db, w.host)
        w.db.commit()
        assert [r.id for r in taken] == [first.id, second.id]
        assert CRL.take(w.db, w.host) == []  # each once
        out = CRL.request_out(taken[0], now())
        assert set(out) == {"requestId", "clientId", "stationId", "method", "path", "client", "ts", "nonce", "sig",
                            "body", "ageMs"}
        assert out["clientId"] == str(client.id) and out["body"] == '{"reason":"customer"}' and out["ageMs"] >= 0
        # Another host's answers are ignored; a bad one is ignored; its own stored once.
        assert CRL.store_replies(w.db, w.kiosk, [{"requestId": str(first.id), "status": 200, "body": {}}]) == 0
        assert CRL.store_replies(w.db, w.host, [{"requestId": str(first.id), "status": "200"}, "x", None]) == 0
        reply = {"requestId": str(first.id), "status": 409, "body": {"error": "not_holder", "position": 2}, "hostTime": 1760000000180}
        assert CRL.store_replies(w.db, w.host, [reply]) == 1
        assert CRL.store_replies(w.db, w.host, [{**reply, "status": 200}]) == 0
        w.db.commit()
        row = w.db.get(CashRelayRequest, first.id)
        assert CRL.out(row) == {"api": 1, "requestId": str(first.id), "state": "done",
                                "reply": {"status": 409, "body": {"error": "not_holder", "position": 2}, "hostTime": 1760000000180}}

    def test_lapses(self, w):
        client = cloud_client(w)
        t0 = now()
        row = CRL.submit(w.db, client, call(w, client), now=t0)
        late = CRL.submit(w.db, client, call(w, client), now=t0)
        w.db.commit()
        assert not CRL.settle(row, t0 + timedelta(seconds=9))
        # Not taken in time: expired — and never handed to the host after that.
        assert CRL.settle(row, t0 + timedelta(seconds=10)) and row.state == "expired"
        assert CRL.take(w.db, w.host, now=t0 + timedelta(seconds=11)) == []
        # Taken and not answered: lost.
        late.state, late.taken_at = "taken", t0
        assert not CRL.settle(late, t0 + timedelta(seconds=19))
        assert CRL.settle(late, t0 + timedelta(seconds=20)) and late.state == "lost"
        assert CRL.out(late) == {"api": 1, "requestId": str(late.id), "state": "lost"}

    def test_purged_after_a_day(self, w):
        client = cloud_client(w)
        old = CRL.submit(w.db, client, call(w, client), now=now() - timedelta(hours=25))
        fresh = CRL.submit(w.db, client, call(w, client))
        w.db.commit()
        assert CRL.purge(w.db, force=True) == 1
        w.db.commit()
        assert w.db.get(CashRelayRequest, fresh.id) is not None and w.db.query(CashRelayRequest).count() == 1
        assert old is not None

    def test_a_host_kiosk_takes_its_own_stations_calls(self, w):
        k = windows_kiosk(w)
        k.cash_host_embedded = True
        w.station.host_machine_id = k.id
        w.db.commit()
        client = cloud_client(w)
        row = CRL.submit(w.db, client, call(w, client))
        w.db.commit()
        assert row.host_machine_id == k.id
        assert CRL.take(w.db, w.host) == [] and [r.id for r in CRL.take(w.db, k)] == [row.id]


class TestRelayHttp:
    def test_a_call_through_the_cloud_and_back(self, w, inline):
        client = cloud_client(w)
        body = call(w, client)
        first = run(CSR.post_cash_relay(str(client.id), CSR.RelayIn(**body), machine=client, db=w.db))
        assert first == {"api": 1, "requestId": body["requestId"], "state": "pending"}
        polled = run(CSR.post_cash_relay_poll(str(w.host.id), CSR.RelayPollIn(replies=[], waitMs=0), machine=w.host, db=w.db))
        assert polled["relay"] is True and [r["requestId"] for r in polled["requests"]] == [body["requestId"]]
        req = polled["requests"][0]
        assert {k: req[k] for k in ("method", "path", "client", "ts", "nonce", "sig", "body")} == {
            k: body[k] for k in ("method", "path", "client", "ts", "nonce", "sig", "body")}
        reply = {"requestId": body["requestId"], "status": 200, "body": {"txId": TX, "state": "REFUNDING", "seq": 4},
                 "hostTime": 1760000000180}
        again = run(CSR.post_cash_relay_poll(str(w.host.id), CSR.RelayPollIn(replies=[reply], waitMs=0), machine=w.host, db=w.db))
        assert again["requests"] == []
        done = run(CSR.get_cash_relay(str(client.id), body["requestId"], wait_ms=0, machine=client, db=w.db))
        assert done["state"] == "done" and done["reply"]["body"]["state"] == "REFUNDING"
        # A network retry of the same call: the same answer, nothing new for the host.
        retry = run(CSR.post_cash_relay(str(client.id), CSR.RelayIn(**body), machine=client, db=w.db))
        assert retry == done
        with pytest.raises(HTTPException) as e:
            run(CSR.get_cash_relay(str(w.till1.id), body["requestId"], wait_ms=0, machine=w.till1, db=w.db))
        assert e.value.status_code == 404

    def test_the_long_poll_waits_only_when_wanted(self, w, inline, monkeypatch):
        monkeypatch.setattr(CRL, "HOST_CHECK_IDLE_S", 0.01)
        monkeypatch.setattr(CRL, "HOST_CHECK_ACTIVE_S", 0.01)
        enable_kiosk(w, w.station.id)
        # Nobody routes through the cloud: answered at once, `relay: false`.
        out = run(CSR.post_cash_relay_poll(str(w.host.id), CSR.RelayPollIn(waitMs=25_000), machine=w.host, db=w.db))
        assert out == {"api": 1, "relay": False, "requests": []}
        set_param(w, CP.ROUTE_KEY, "machine", w.kiosk.id, "cloud")
        import time

        t0 = time.monotonic()
        out = run(CSR.post_cash_relay_poll(str(w.host.id), CSR.RelayPollIn(waitMs=150), machine=w.host, db=w.db))
        assert out == {"api": 1, "relay": True, "requests": []} and time.monotonic() - t0 >= 0.14
        assert CRL.wait_ms_of(99_999, 0, CRL.HOST_WAIT_MAX_MS) == 25_000 and CRL.wait_ms_of("x", 6, 10) == 6

    def test_a_pending_call_answers_pending_then_expired(self, w, inline, monkeypatch):
        monkeypatch.setattr(CRL, "CLIENT_CHECK_S", 0.01)
        client = cloud_client(w)
        body = call(w, client, wait=50)
        out = run(CSR.post_cash_relay(str(client.id), CSR.RelayIn(**body), machine=client, db=w.db))
        assert out["state"] == "pending"
        row = w.db.get(CashRelayRequest, uuid.UUID(body["requestId"]))
        row.created_at = now() - timedelta(seconds=11)
        w.db.commit()
        out = run(CSR.get_cash_relay(str(client.id), body["requestId"], wait_ms=5_000, machine=client, db=w.db))
        assert out["state"] == "expired"


# ── The shared golden (§14.8) ────────────────────────────────────────────────


class TestGolden:
    def test_the_same_bytes_in_the_three_repos(self):
        raw = (FIXTURES / "cash_relay_golden.json").read_bytes().replace(b"\r\n", b"\n")
        assert hashlib.sha256(raw).hexdigest() == GOLDEN_SHA256

    def test_its_signatures(self):
        g = golden()
        assert CS.client_secret(g["hostSecret"], g["clientId"]) == g["clientSecret"]
        # §11.3's test vector still holds.
        assert CS.client_secret("host-secret", "kiosk-1") == "93e6a695b8a062545b9afb9c6a0c3c84d448f109e32152c837fdb44e11a857c9"
        for key in ("request", "statusRequest"):
            r = g[key]
            assert sign(g["clientSecret"], r["method"], r["path"], r["ts"], r["nonce"], r["body"]) == r["sig"], key

    def test_its_shapes_are_this_servers(self, w):
        g = golden()
        assert g["limits"] == {
            "executeMaxAgeMs": CRL.EXECUTE_MAX_AGE_MS, "pickupMs": int(CRL.PICKUP.total_seconds() * 1000),
            "answerMs": int(CRL.ANSWER.total_seconds() * 1000), "clientWaitMaxMs": CRL.CLIENT_WAIT_MAX_MS,
            "hostWaitMaxMs": CRL.HOST_WAIT_MAX_MS, "bodyMaxBytes": CRL.BODY_MAX, "autoLanFreshMs": 30_000,
        }
        assert set(g["request"]) == set(CSR.RelayIn.model_fields[k].alias or k for k in CSR.RelayIn.model_fields)
        # The golden's call, sent for a real station and device: the host's view of it is the golden's poll answer.
        client = cloud_client(w)
        req = {**g["request"], "stationId": str(w.station.id), "client": str(client.id),
               "path": g["request"]["path"].replace("st-1", str(w.station.id))}
        row = CRL.submit(w.db, client, req)
        out = CRL.request_out(row, now())
        assert set(out) == set(g["poll"]["answer"]["requests"][0])
        assert set(CRL.out(row)) == set(g["answers"]["pending"])
        row.state, row.reply = "done", g["answers"]["done"]["reply"]
        assert CRL.out(row) == {**g["answers"]["done"], "requestId": str(row.id)}
        for state in ("expired", "lost"):
            row.state = state
            assert CRL.out(row) == {**g["answers"][state], "requestId": str(row.id)}
        assert set(g["poll"]["body"]) == {"replies", "waitMs"}
        assert set(g["poll"]["body"]["replies"][0]) == {"requestId", "status", "body", "hostTime"}


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self):
        import importlib.util

        path = Path(__file__).absolute().parents[1] / "alembic" / "versions" / "f3a8c6e1d9b4_cash_host_kiosk_relay.py"
        spec = importlib.util.spec_from_file_location("migration_f3a8c6e1d9b4", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_additive_idempotent_offline_and_on_the_single_head(self):
        import sqlalchemy as sa
        from alembic.config import Config
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory

        module = self._module()
        assert (module.revision, module.down_revision) == ("f3a8c6e1d9b4", "e5a9c3d1f7b2")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for table in ("tenants", "pos_machines", "cash_stations"):
                conn.execute(sa.text(f"CREATE TABLE {table} (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("INSERT INTO pos_machines (id) VALUES ('a')"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            assert "cash_host_embedded" in {c["name"] for c in insp.get_columns("pos_machines")}
            assert conn.execute(sa.text("SELECT cash_host_embedded FROM pos_machines")).scalar() in (0, False)
            assert insp.has_table("cash_relay_requests")
            cols = {c["name"] for c in insp.get_columns("cash_relay_requests")}
            assert {"id", "host_machine_id", "client_machine_id", "station_id", "method", "path", "signed", "body",
                    "digest", "state", "reply", "created_at", "taken_at", "done_at"} <= cols
            assert {"ix_cash_relay_requests_host_state", "ix_cash_relay_requests_created"} <= {
                i["name"] for i in insp.get_indexes("cash_relay_requests")}
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "ALTER TABLE pos_machines ADD COLUMN cash_host_embedded BOOLEAN DEFAULT false NOT NULL" in sql
        assert "CREATE TABLE cash_relay_requests" in sql and "signed JSONB NOT NULL" in sql
        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        # One head, with this revision on its line (release 17.10 joins it with its siblings in 6b3b29c7bc5b).
        (head,) = script.get_heads()
        assert "f3a8c6e1d9b4" in {r.revision for r in script.iterate_revisions(head, "base")}
