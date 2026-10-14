"""
"מכשיר מזומן לקיוסק" — the server's part (P:/specs/cash-paylink.md §9, §11 the contract, §12 several stations,
§13 cash without internet; app/services/cash_host.py, cash_params.py, cash_stations.py, cash_alerts.py,
cash_station_drawer.py, cash_station_admin.py).

* The role `cash_host`: pairing (a shop, Windows only), a non-fiscal machine flagged `is_cash_host`, never a till
  license, sales refused with its own code, its own endpoints admitting it alone.
* The parameters (§11.10): built-ins, checked on save, typed for the devices; a station's overrides.
* `GET /sync/{m}/cash` for a kiosk and for the host — the secrets' exact HMAC, the ETag.
* The journal: idempotent by id, a transaction only with a higher seq; the owed items and their alerts.
* The owed items at the tills (`cashAlertTills`, '' = the main till): the list, the heartbeat's `cashOwed`,
  "שולם ללקוח" idempotent by movementId and 409 once resolved otherwise.
* The heartbeat's `cash` block, the `cash_unit` alerts opened / closed by it, the offline watch, the tills' kiosk
  alerts (`cash:`), the exception kind's registration (rule, catalog, push type, problems group).
* The kiosk config's `cash_device` (and the TS list), the documents' `cashDevice` (a cash leg), a held credit closed
  by its document, the shop Z's "cash stations" block and its reconciliation, the dashboard routes.
* The migration.

Runs on the in-memory SQLite world of tests/shift_world.py, through the services and the router functions.
"""
from __future__ import annotations

import json
import re
import types
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse

from app.models.audit_exception import AuditException
from app.models.cash_station import CashHostCommand, CashStation, CashStationMovement, CashStationTx
from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.printers import KitchenPrintHost
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.transaction_payment import TransactionPayment
from app.models.user import User, UserRole
from app.routers import cash_stations as CR
from app.routers import cash_stations_sync as CSR
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.schemas.pairing_code import PairingCodeGenerateRequest
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.transaction import TransactionPaymentIn
from app.services import cash_alerts as CA
from app.services import cash_host as CH
from app.services import cash_params as CP
from app.services import cash_station_drawer as CSD
from app.services import cash_stations as CS
from app.services import display_devices as DD
from app.services import kiosk_config as KC
from app.services import kiosk_ops as OPS
from app.services import licenses as L
from app.services import pairing as P
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, make_world

HOST_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
KIOSK_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
SERVER_KEY = "cash-test-server-key"
#: hex(HMAC-SHA256("cash-test-server-key", "cash-host:" + HOST_ID)) and the kiosk's from it.
HOST_DIGEST = "843c69e238d62341332423ac4173ecafcf57c58855bfb911eecdd9f2763da893"
KIOSK_DIGEST = "14b66f5c00190a124885d75cb9a10551e7dee432b3f800c03da0e0a26dbda862"


def now():
    return datetime.now(timezone.utc)


def ms(moment):
    return int(moment.timestamp() * 1000)


# ── The world ─────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_parameters_notify", lambda targets: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    import app.config as config

    monkeypatch.setattr(config.get_settings(), "jwt_secret_key", SERVER_KEY)
    woken = []
    monkeypatch.setattr(OPS, "wake_machine", lambda machine, reason: woken.append((machine.id, reason)))
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    world.till1, world.till2 = world.tills
    world.host = POSMachine(
        id=HOST_ID, tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="שרת מזומן", machine_code="CASH-1", pos_number=None, is_active=True,
        pairing_status=PairingStatus.ASSIGNED, is_fiscal=False, is_cash_host=True, platform="windows",
        last_heartbeat_at=now() - timedelta(seconds=10),
    )
    world.kiosk = POSMachine(
        id=KIOSK_ID, tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="קיוסק 3", machine_code="K-3", pos_number="9", is_active=True, pairing_status=PairingStatus.ASSIGNED,
        platform="windows", last_heartbeat_at=now() - timedelta(seconds=10),
    )
    world.db.add_all([world.host, world.kiosk])
    world.db.flush()
    world.db.add(KioskDevice(machine_id=world.kiosk.id, tenant_id=world.tenant.id, shop_id=world.shop.id,
                             name="קיוסק 3", enabled=True))
    world.station = CashStation(
        id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, shop_id=world.shop.id,
        host_machine_id=world.host.id, name="עמדת מזומן 2", location="ליד קיוסק 3", serial="AE000001",
    )
    world.db.add(world.station)
    world.db.commit()
    world.woken = woken
    return world


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type,
                                scope_id=scope_id, value=value))
    w.db.commit()


def enable_kiosk(w, station=""):
    set_param(w, CP.ENABLED_KEY, "machine", w.kiosk.id, True)
    if station:
        set_param(w, CP.STATION_KEY, "machine", w.kiosk.id, str(station))


def beat(w, **station_fields):
    """The host's heartbeat `cash` block with one station (overrides per field)."""
    item = {"stationId": str(w.station.id), "serial": "AE000001", "state": "ready", "changeAvailableAgorot": 45600,
            "alerts": []}
    item.update(station_fields)
    body = {"api": 1, "lanAddress": "192.168.1.40", "port": 47630, "version": "0.5.0", "stations": [item]}
    w.host.last_heartbeat_at = now()
    assert CS.apply_heartbeat(w.db, w.host, body)
    w.db.commit()
    return body


def tx_entry(w, tx_id=None, *, seq=1, state="DONE", outcome="paid", amount=5735, due=5740, inserted=7000,
             change_due=1260, change_paid=1260, change_owed=0, held=0, refund_paid=0, slip=None, label="57",
             station=None, done_at=None):
    return {
        "type": "tx", "txId": str(tx_id or uuid.uuid4()), "stationId": str(station or w.station.id),
        "hostId": str(w.host.id), "clientId": str(w.kiosk.id), "leaseId": "L1", "state": state, "outcome": outcome,
        "amountAgorot": amount, "dueAgorot": due, "roundingAgorot": due - amount, "insertedAgorot": inserted,
        "remainingAgorot": 0, "escrowAgorot": 0, "changeDueAgorot": change_due, "changePaidAgorot": change_paid,
        "changeOwedAgorot": change_owed, "refundDueAgorot": refund_paid, "refundPaidAgorot": refund_paid,
        "heldAgorot": held, "heldReason": "power_loss" if held else None, "cancelReason": None,
        "inserted": [{"valueAgorot": 5000, "kind": "note", "count": 1}, {"valueAgorot": 1000, "kind": "coin", "count": 2}],
        "paidOut": [{"valueAgorot": 1000, "kind": "coin", "count": 1}],
        "slipCode": slip, "owedId": None, "acked": False, "documentId": None, "documentNumber": None,
        "orderRef": "ord-57", "orderLabel": label, "deviceSerial": "12345",
        "createdAt": ms(NOW), "updatedAt": ms(NOW), "doneAt": ms(done_at or NOW), "seq": seq,
    }


def journal(w, *entries, host=None):
    out = CS.apply_journal(w.db, host or w.host, list(entries))
    w.db.commit()
    return out


def cash_rows(w, code=None, *, open_only=True):
    rows = CA.rows_of_station(w.db, w.station.id, open_only=open_only)
    return [r for r in rows if code is None or r.details.get("code") == code]


def refusal(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def manager(w, shop):
    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, company_id=w.company.id,
             shop_id=shop.id, email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8])
    w.db.add(u)
    w.db.commit()
    return u


# ── The role and pairing ──────────────────────────────────────────────────────


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refusal(out):
    assert isinstance(out, JSONResponse), out
    return out.status_code, json.loads(out.body)


class TestRole:
    def test_a_code_needs_a_shop_and_windows(self, w):
        status_code, body = _refusal(_generate(w, deviceRole="cash_host", platform="windows"))
        assert (status_code, body["detail"]) == (400, "cash_host_requires_shop") and "סניף" in body["message"]
        for platform in ("android", "web"):
            status_code, body = _refusal(_generate(w, shopId=w.shop.id, deviceRole="cash_host", platform=platform))
            assert (status_code, body["detail"]) == (422, "cash_host_windows_only") and "Windows" in body["message"]
        code = _generate(w, shopId=w.shop.id, deviceRole="cash_host", name="שרת המזומן")
        # No platform said: a Windows code.
        assert (code.device_role, code.platform, code.kds_options) == ("cash_host", "windows", {"name": "שרת המזומן"})

    def test_never_offered_in_the_browser_and_listed_as_non_fiscal(self):
        assert DD.ROLE_CASH_HOST == "cash_host" not in DD.WEB_ROLES
        assert "cash_host" in DD.NON_FISCAL_ROLES and not DD.is_fiscal_role("cash_host")
        from app.services import device_profile as DP

        assert "cash_host" in DP.ROLES

    def test_pairing_makes_a_non_fiscal_cash_host_that_knows_it(self, w):
        code = PairingCode(
            id=uuid.uuid4(), code=f"C{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
            tenant_id=w.tenant.id, shop_id=w.shop.id, device_role="cash_host", platform="windows",
            expires_at=now() + timedelta(minutes=5), is_used=False,
        )
        w.db.add(code)
        w.db.flush()
        machine = P.validate_pairing_code(w.db, code.code, {"platform": "windows", "model": "MiniPC"}, None)
        assert machine.is_cash_host is True and machine.is_fiscal is False
        assert (machine.shop_id, machine.pos_number, machine.document_prefix, machine.platform) == (
            w.shop.id, None, None, "windows",
        )
        assert machine.name == "שרת מזומן"  # no name typed: the role's
        me = machines_router.get_my_machine(machine=machine)
        assert (me["deviceRole"], me["fiscal"]) == ("cash_host", False)
        assert machines_router.post_my_heartbeat(None, machine=machine, db=w.db)["deviceRole"] == "cash_host"

    def test_the_other_platform_is_refused_at_redemption(self, w):
        code = PairingCode(
            id=uuid.uuid4(), code=f"C{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
            tenant_id=w.tenant.id, shop_id=w.shop.id, device_role="cash_host", platform="windows",
            expires_at=now() + timedelta(minutes=5), is_used=False,
        )
        w.db.add(code)
        w.db.flush()
        with pytest.raises(DD.PlatformMismatch):
            P.validate_pairing_code(w.db, code.code, {"platform": "android"}, None)

    def test_never_a_till_license_and_its_role_changes_only_by_pairing(self, w):
        from app.services import device_profile as DP

        assert L.effective_license(w.db, w.host)["countsAsTillLicense"] is False
        assert DP.current_role(w.db, w.host) == "cash_host"
        with pytest.raises(DP.DeviceProfileRefused) as e:
            DP.check_role_switch(w.db, w.host, "till")
        assert e.value.body["detail"] == DD.ROLE_CHANGE_REQUIRES_PAIRING
        with pytest.raises(DP.DeviceProfileRefused) as e:
            DP.change_role(w.db, w.admin, w.host, "kds")
        assert e.value.body["detail"] == DD.ROLE_CHANGE_REQUIRES_PAIRING

    def test_no_work_config_and_never_in_the_lan_group(self, w):
        from app.services import work_config as WC
        from app.services.independent_till import lan_members

        with pytest.raises(WC.WorkConfigRefused) as e:
            WC.apply(w.db, w.admin, w.host, {"preset": WC.MAIN_TILL})
        assert e.value.body["detail"] == "work_config_cash_host"
        assert w.host.id not in {m.id for m in lan_members([w.host, w.till1])}

    def test_its_endpoints_admit_it_alone_and_fiscal_ones_refuse_it_with_its_own_code(self, w):
        from app.middleware import auth

        assert auth.require_cash_host_token(machine=w.host) is w.host
        assert auth.require_cash_host(machine=w.host) is w.host
        for other in (w.till1, w.kiosk, types.SimpleNamespace(id=uuid.uuid4(), is_fiscal=False)):
            e = refusal(auth.require_cash_host_token, machine=other)
            assert (e.status_code, e.detail["code"]) == (403, "cash_host_only")
        with pytest.raises(DD.DeviceNotFiscal) as e:
            auth.require_fiscal_machine(machine=w.host)
        body = e.value.body
        assert (e.value.status_code, body["detail"], body["deviceRole"]) == (403, "cash_host_not_a_till", "cash_host")
        assert body["message"] == CH.NOT_A_TILL_MESSAGE and "אינו קופה" in body["message"]


class TestRefusedOverHttp:
    @pytest.fixture(scope="class")
    def client(self):
        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.main import app
        from app.middleware import auth

        host = types.SimpleNamespace(id=uuid.uuid4(), tenant_id=None, shop_id=None, is_fiscal=False, is_cash_host=True)

        def _db():
            yield MagicMock()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[auth.get_pos_machine_for_sync_path] = lambda: host
        app.dependency_overrides[auth.get_pos_machine_from_sync_machine_token] = lambda: host
        try:
            yield TestClient(app)
        finally:
            for dep in (get_db, auth.get_pos_machine_for_sync_path, auth.get_pos_machine_from_sync_machine_token):
                app.dependency_overrides.pop(dep, None)

    @pytest.mark.parametrize("method, path", [
        ("POST", "/sync/{m}/transactions"),
        ("POST", "/sync/{m}/shifts"),
        ("POST", "/sync/{m}/till-z"),
        ("POST", "/sync/{m}/kiosk/orders"),
        ("POST", "/sync/{m}/cash/owed/{s}/pay"),
    ])
    def test_sales_shifts_and_paying_out_are_refused_with_its_own_code(self, client, method, path):
        url = "/api/v1" + path.replace("{m}", str(uuid.uuid4())).replace("{s}", str(uuid.uuid4()))
        res = client.request(method, url, json={"movementId": str(uuid.uuid4())}, headers={"Authorization": "Bearer x"})
        assert res.status_code == 403, res.text
        assert res.json()["detail"] == "cash_host_not_a_till" and res.json()["deviceRole"] == "cash_host"


# ── The parameters (§11.10) ───────────────────────────────────────────────────


class TestParameters:
    def test_every_key_is_a_builtin_with_its_default(self):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        defaults = {
            "cashEnabled": False, "cashStation": "", "cashCoinsAccepted": "10,50,100,200,500,1000",
            "cashNotesAccepted": "2000,5000,10000,20000", "cashMaxChangeAgorot": 10000,
            "cashExactChangeBelowAgorot": 3000, "cashChangeShortfall": "notify", "cashAlertTills": "",
            "cashInsertTimeoutSec": 180, "cashIdleTimeoutSec": 60, "cashQueueTimeoutSec": 120, "cashRefundGraceSec": 120,
            "cashRounding": "nearest_10", "cashSplitWithCard": False, "cashFloatLevels": "{}",
            "cashCashboxCapacity": '{"coins":1500,"notes":500}', "cashLampMap": "{}", "cashSwitchMap": "{}",
            "cashReceiptLines": True, "cashSimulator": False, "cashDriverPath": "", "cashDllPath": "",
            "cashSettleMs": 1000, "cashPayoutTimeoutSec": 60, "cashExtendedEscrow": True, "cashHopperFeeds": "auto",
            "cashUnackedHoldMin": 30, "kioskOfflineBlockCash": False,
        }
        assert set(CP.ALL_KEYS) == set(defaults) - {"kioskOfflineBlockCash"}
        for key, default in defaults.items():
            assert specs[key].default_value == default, key
            assert [p.key for p in TP.BUILTIN_PARAMETERS].count(key) == 1, key
            # Every default is what its own check would store.
            assert TP.validate_keyed_value(key, default) == default, key
        assert specs["cashChangeShortfall"].enum_options == ("prevent", "notify", "ask")
        assert specs["cashRounding"].enum_options == ("none", "nearest_10")
        assert specs["cashAlertTills"].value_type == "string" and specs["cashEnabled"].value_type == "boolean"

    def test_created_at_startup(self, w):
        keys = {k for (k,) in w.db.query(TillParameter.key).all()}
        assert set(CP.ALL_KEYS) | {"kioskOfflineBlockCash"} <= keys

    def test_lists_and_maps_are_checked_and_stored_canonical(self):
        V = TP.validate_keyed_value
        assert V("cashCoinsAccepted", " 100, 10 ,100,500") == "10,100,500"
        assert V("cashNotesAccepted", "20000,2000") == "2000,20000"
        till = str(uuid.uuid4())
        assert V("cashAlertTills", f"{till.upper()}, {till}") == till
        assert V("cashStation", "") == "" and V("cashStation", f" {till.upper()} ") == till
        assert V("cashFloatLevels", '{"100": {"low": 30, "target": 200}}') == '{"100":{"low":30,"target":200}}'
        assert V("cashCashboxCapacity", '{"notes": 400}') == '{"notes":400}'
        assert V("cashLampMap", f'{{"busy": 0, "clients": {{"{till}": 3}}}}') == f'{{"busy":0,"clients":{{"{till}":3}}}}'
        assert V("cashSwitchMap", '{"door": {"n": 0}}') == '{"door":{"n":0,"closedMeans":"closed"}}'
        for key, bad in (
            ("cashCoinsAccepted", "10,20"), ("cashNotesAccepted", "1000"), ("cashAlertTills", "till-1"),
            ("cashStation", "station 2"), ("cashFloatLevels", "[]"), ("cashFloatLevels", '{"7": {"low": 1}}'),
            ("cashCashboxCapacity", '{"bills": 4}'), ("cashLampMap", '{"busy": 99}'),
            ("cashSwitchMap", '{"door": {"n": 0, "closedMeans": "sometimes"}}'), ("cashMaxChangeAgorot", -1),
            ("cashInsertTimeoutSec", 5), ("cashChangeShortfall", "maybe"), ("cashHopperFeeds", "some"),
            ("cashDriverPath", "C:\\x\ny"),
        ):
            with pytest.raises(TP.TillParameterValueError):
                V(key, bad)

    def test_typed_for_the_devices(self):
        typed = CP.typed({"cashCoinsAccepted": "10,500", "cashAlertTills": "", "cashFloatLevels": '{"100":{"low":3}}'})
        assert typed["cashCoinsAccepted"] == [10, 500] and typed["cashAlertTills"] == []
        assert typed["cashFloatLevels"] == {"100": {"low": 3}}
        # A key the map lacks: its default, typed.
        assert typed["cashNotesAccepted"] == [2000, 5000, 10000, 20000]
        assert typed["cashCashboxCapacity"] == {"coins": 1500, "notes": 500}

    def test_a_stations_overrides_are_station_keys_only_checked_and_typed(self):
        assert CP.clean_overrides({"cashCoinsAccepted": [100, 10], "cashRounding": "none", "cashSettleMs": None}) == {
            "cashCoinsAccepted": [10, 100], "cashRounding": "none",
        }
        for bad in ({"cashEnabled": True}, {"cashStation": ""}, {"cashDriverPath": ""}, {"cashRounding": "up"},
                    {"cashMaxChangeAgorot": "5"}):
            with pytest.raises(ValueError):
                CP.clean_overrides(bad)


# ── GET /sync/{m}/cash (§11.2, §11.3) ─────────────────────────────────────────


class TestSyncCash:
    def test_the_secrets_are_the_contracts_hmacs(self, w):
        assert CS.host_secret(HOST_ID) == HOST_DIGEST
        assert CS.client_secret(HOST_DIGEST, KIOSK_ID) == KIOSK_DIGEST
        # The contract's own vector (§11.3), as kiosk-desktop pins it.
        assert CS.client_secret("host-secret", "kiosk-1") == (
            "93e6a695b8a062545b9afb9c6a0c3c84d448f109e32152c837fdb44e11a857c9"
        )

    def test_a_kiosk_not_enabled_gets_no_station(self, w):
        out = CS.view_for(w.db, w.kiosk)
        assert (out["api"], out["role"], out["enabled"], out["station"]) == (1, "client", False, None)
        assert out["settings"]["cashEnabled"] is False and out["settings"]["cashCoinsAccepted"] == [10, 50, 100, 200, 500, 1000]

    def test_an_enabled_kiosk_gets_the_shops_only_station_its_address_and_its_own_secret(self, w):
        enable_kiosk(w)
        out = CS.view_for(w.db, w.kiosk)
        assert out["enabled"] is True
        station = out["station"]
        assert (station["stationId"], station["name"], station["location"], station["hostId"], station["hostName"]) == (
            str(w.station.id), "עמדת מזומן 2", "ליד קיוסק 3", str(HOST_ID), "שרת מזומן",
        )
        # The host never said where it listens: no address — no tile.
        assert station["lanAddress"] is None and station["port"] == 47630
        assert station["secret"] == KIOSK_DIGEST
        beat(w)
        station = CS.view_for(w.db, w.kiosk)["station"]
        assert (station["lanAddress"], station["port"]) == ("192.168.1.40", 47630)

    def test_with_two_stations_the_kiosk_names_one(self, w):
        enable_kiosk(w)
        other = CashStation(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, host_machine_id=w.host.id,
                            name="עמדת מזומן 3", serial="AE000002")
        w.db.add(other)
        w.db.commit()
        assert CS.view_for(w.db, w.kiosk)["station"] is None
        set_param(w, CP.STATION_KEY, "machine", w.kiosk.id, str(other.id))
        assert CS.view_for(w.db, w.kiosk)["station"]["stationId"] == str(other.id)

    def test_the_station_decides_what_it_accepts_and_its_timers_override(self, w):
        enable_kiosk(w)
        set_param(w, CP.COINS_KEY, "machine", w.kiosk.id, "10")  # the kiosk's own word on a station key: not used
        w.station.settings = {"cashCoinsAccepted": [100, 500], "cashIdleTimeoutSec": 90}
        w.db.commit()
        settings = CS.view_for(w.db, w.kiosk)["settings"]
        assert settings["cashCoinsAccepted"] == [100, 500] and settings["cashIdleTimeoutSec"] == 90
        assert settings["cashEnabled"] is True and settings["cashStation"] == ""

    def test_the_host_gets_its_secret_stations_clients_commands_and_settings(self, w):
        enable_kiosk(w)
        w.station.settings = {"cashRounding": "none", "cashSimulator": True}
        set_param(w, CP.DRIVER_PATH_KEY, "machine", w.host.id, "D:\\Paylink\\Paylink.exe")
        CS.create_command(w.db, w.admin, w.station, "refill", {"pieces": [{"valueAgorot": 100, "count": 200}]})
        w.db.commit()
        out = CS.view_for(w.db, w.host)
        assert (out["api"], out["role"], out["hostId"], out["hostSecret"]) == (1, "host", str(HOST_ID), HOST_DIGEST)
        (station,) = out["stations"]
        assert (station["stationId"], station["serial"], station["simulator"]) == (str(w.station.id), "AE000001", True)
        assert station["settings"]["cashRounding"] == "none" and station["settings"]["cashCoinsAccepted"][0] == 10
        assert station["clients"] == [{"machineId": str(KIOSK_ID), "name": "קיוסק 3", "kind": "kiosk"}]
        (command,) = out["commands"]
        assert (command["op"], command["args"], command["stationId"]) == (
            "refill", {"pieces": [{"valueAgorot": 100, "count": 200}]}, str(w.station.id),
        )
        assert out["settings"] == {"cashDriverPath": "D:\\Paylink\\Paylink.exe", "cashDllPath": ""}
        assert out["lanAlertTargets"] == []

    def test_the_hosts_lan_alert_targets_are_the_shops_lan_servers(self, w):
        from app.services.main_till import MAIN_TILL_KEY
        from app.services.printers import print_secret

        set_param(w, MAIN_TILL_KEY, "machine", w.till1.id, True)
        w.db.add(KitchenPrintHost(machine_id=w.till1.id, shop_id=w.shop.id, lan_address="192.168.1.10", port=8765))
        w.db.commit()
        # The print server and the tables host are one device here: one target.
        assert CS.view_for(w.db, w.host)["lanAlertTargets"] == [
            {"lanAddress": "192.168.1.10", "port": 8765, "secret": print_secret(w.shop.id)},
        ]

    def test_the_route_answers_304_on_its_etag(self, w):
        enable_kiosk(w)
        first = Response()
        body = CSR.get_cash(str(w.kiosk.id), request=None, response=first, machine=w.kiosk, db=w.db)
        tag = first.headers["etag"]
        assert tag == f'"{CS.etag_of(body)}"'
        again = CSR.get_cash(str(w.kiosk.id), request=types.SimpleNamespace(headers={"if-none-match": tag}),
                             response=Response(), machine=w.kiosk, db=w.db)
        assert isinstance(again, Response) and again.status_code == 304
        # A change (the host reports its address): a new tag.
        beat(w)
        changed = Response()
        CSR.get_cash(str(w.kiosk.id), request=types.SimpleNamespace(headers={"if-none-match": tag}),
                     response=changed, machine=w.kiosk, db=w.db)
        assert changed.headers["etag"] != tag


# ── The journal (§11.9) ───────────────────────────────────────────────────────


class TestJournal:
    def test_idempotent_by_id_and_a_transaction_only_with_a_higher_seq(self, w):
        tx_id = uuid.uuid4()
        out = journal(w, tx_entry(w, tx_id, seq=3, state="ACCEPTING", outcome=None, inserted=2000))
        assert out == {"api": 1, "accepted": [str(tx_id)], "rejected": []}
        assert journal(w, tx_entry(w, tx_id, seq=2, state="DONE"))["accepted"] == [str(tx_id)]
        row = w.db.get(CashStationTx, tx_id)
        assert (row.state, row.seq, row.inserted_agorot) == ("ACCEPTING", 3, 2000)  # the older version ignored
        journal(w, tx_entry(w, tx_id, seq=7))
        w.db.refresh(row)
        assert (row.state, row.outcome, row.seq, row.inserted_agorot, row.change_paid_agorot, row.rounding_agorot) == (
            "DONE", "paid", 7, 7000, 1260, 5,
        )
        assert (row.client_machine_id, row.order_label, row.device_serial, row.owed_status) == (KIOSK_ID, "57", "12345", "none")
        assert row.data["inserted"][0] == {"valueAgorot": 5000, "kind": "note", "count": 1}
        assert row.done_at is not None

    def test_movements_once_by_id(self, w):
        entry = {"type": "movement", "id": str(uuid.uuid4()), "stationId": str(w.station.id), "kind": "float",
                 "amountAgorot": 20000, "pieces": [{"valueAgorot": 100, "kind": "coin", "count": 200}],
                 "by": {"userId": "u1", "name": "דנה"}, "note": "קרן", "at": ms(NOW)}
        assert journal(w, entry)["accepted"] == [entry["id"]]
        assert journal(w, {**entry, "amountAgorot": 1})["accepted"] == [entry["id"]]
        (row,) = w.db.query(CashStationMovement).all()
        assert (row.kind, row.amount_agorot, row.by, row.note) == ("float", 20000, {"userId": "u1", "name": "דנה"}, "קרן")

    def test_what_is_refused_is_said_per_entry(self, w):
        foreign = CashStation(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, host_machine_id=None, name="X")
        w.db.add(foreign)
        w.db.commit()
        good = tx_entry(w)
        out = journal(
            w,
            {"type": "tx", "stationId": str(w.station.id)},
            tx_entry(w, station=foreign.id),
            {**tx_entry(w), "state": "WEIRD"},
            {"type": "movement", "id": str(uuid.uuid4()), "stationId": str(w.station.id), "kind": "steal"},
            {"type": "other", "id": "x"},
            "not an object",
            good,
        )
        assert out["accepted"] == [good["txId"]]
        assert [r["error"] for r in out["rejected"]] == [
            "missing_id", "unknown_station", "invalid_state", "invalid_kind", "unknown_type", "invalid_entry",
        ]

    def test_change_owed_opens_an_item_and_an_alert_for_the_tills(self, w):
        tx_id = uuid.uuid4()
        journal(w, tx_entry(w, tx_id, change_paid=1000, change_owed=260, slip="C-K7Q3MX"))
        row = w.db.get(CashStationTx, tx_id)
        assert (row.owed_status, row.owed_kind, row.owed_agorot) == ("open", "change_owed", 260)
        (alert,) = cash_rows(w, "change_owed")
        assert alert.details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): עודף חייב ללקוח — הזמנה 57: 2.60 ₪ · C-K7Q3MX"
        assert (alert.machine_id, alert.shop_id, alert.severity, alert.amount) == (HOST_ID, w.shop.id, "medium", Decimal("2.60"))
        # The default alert till (no main till marked: the shop's first till) is woken.
        assert (w.till1.id, "cash_alert") in w.woken
        # The same entry again (no higher seq): nothing new.
        journal(w, tx_entry(w, tx_id, change_paid=1000, change_owed=260))
        assert len(cash_rows(w, "change_owed", open_only=False)) == 1

    def test_the_order_number_given_with_the_ack_follows_the_latest_entry(self, w):
        tx_id = uuid.uuid4()
        journal(w, tx_entry(w, tx_id, seq=1, change_paid=1000, change_owed=260, label=None))
        (alert,) = cash_rows(w, "change_owed")
        assert alert.details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): עודף חייב ללקוח: 2.60 ₪"
        journal(w, {**tx_entry(w, tx_id, seq=2, change_paid=1000, change_owed=260, label="A-57"), "acked": True})
        (alert,) = cash_rows(w, "change_owed")
        assert alert.details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): עודף חייב ללקוח — הזמנה A-57: 2.60 ₪"
        (item,) = CS.owed_items_for_till(w.db, w.till1)
        assert item["orderLabel"] == "A-57"
        # A later entry that says no number keeps the one known.
        journal(w, tx_entry(w, tx_id, seq=3, change_paid=1000, change_owed=260, label=None))
        assert w.db.get(CashStationTx, tx_id).order_label == "A-57"

    def test_a_held_credit_and_its_host_settling_it_later(self, w):
        tx_id = uuid.uuid4()
        journal(w, tx_entry(w, tx_id, seq=1, state="HELD", outcome=None, inserted=3000, change_paid=0, held=3000))
        row = w.db.get(CashStationTx, tx_id)
        assert (row.owed_status, row.owed_kind, row.owed_agorot) == ("open", "held_credit", 3000)
        (alert,) = cash_rows(w, "held_credit")
        assert alert.severity == "high" and "זיכוי מוחזק: 30 ₪" in alert.details["summary"]
        journal(w, tx_entry(w, tx_id, seq=2, state="DONE", outcome="refunded", inserted=3000, change_paid=0,
                            refund_paid=3000))
        w.db.refresh(row)
        assert (row.owed_status, row.resolution) == ("resolved", "host_resolved")
        assert cash_rows(w, "held_credit") == []

    def test_only_a_cash_host_writes_its_journal_and_acks(self, w):
        from app.middleware import auth

        assert CSR.post_cash_journal.__name__  # the route exists
        e = refusal(auth.require_cash_host_token, machine=w.till1)
        assert e.detail["code"] == "cash_host_only"
        # Another host's stations are not this host's.
        other = POSMachine(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
                           name="שרת 2", machine_code="CASH-2", is_active=True, pairing_status=PairingStatus.ASSIGNED,
                           is_fiscal=False, is_cash_host=True)
        w.db.add(other)
        w.db.commit()
        assert journal(w, tx_entry(w), host=other)["rejected"][0]["error"] == "unknown_station"


# ── Owed items at the tills (§11.8) ───────────────────────────────────────────


def _owe(w, amount=1300):
    tx_id = uuid.uuid4()
    journal(w, tx_entry(w, tx_id, change_paid=1260 - amount, change_owed=amount, slip="C-AAAA"))
    return tx_id


class TestOwed:
    def test_listed_to_the_main_till_by_default_and_to_the_alert_tills_when_set(self, w):
        tx_id = _owe(w)
        (item,) = CSR.get_cash_owed(str(w.till1.id), machine=w.till1, db=w.db)["items"]
        assert item == {
            "id": str(tx_id), "kind": "change_owed", "stationId": str(w.station.id), "stationName": "עמדת מזומן 2",
            "txId": str(tx_id), "slipCode": "C-AAAA", "amountAgorot": 1300, "orderLabel": "57", "clientName": "קיוסק 3",
            "createdAt": item["createdAt"],
        }
        assert CS.owed_items_for_till(w.db, w.till2) == []
        # The shop's main till, when one is marked.
        from app.services.main_till import MAIN_TILL_KEY

        set_param(w, MAIN_TILL_KEY, "machine", w.till2.id, True)
        assert [i["id"] for i in CS.owed_items_for_till(w.db, w.till2)] == [str(tx_id)]
        assert CS.owed_items_for_till(w.db, w.till1) == []
        # `cashAlertTills` at the shop.
        set_param(w, CP.ALERT_TILLS_KEY, "shop", w.shop.id, str(w.till1.id))
        assert [i["id"] for i in CS.owed_items_for_till(w.db, w.till1)] == [str(tx_id)]
        assert CS.owed_items_for_till(w.db, w.till2) == []
        # Another shop's till never.
        assert CS.owed_items_for_till(w.db, w.other_till) == []

    def test_the_heartbeat_says_how_many_and_a_tag(self, w):
        # A till some station alerts hears it even with nothing owed; any other device never.
        empty = machines_router.post_my_heartbeat(None, machine=w.till1, db=w.db)["cashOwed"]
        assert empty["count"] == 0
        assert "cashOwed" not in machines_router.post_my_heartbeat(None, machine=w.other_till, db=w.db)
        assert "cashOwed" not in machines_router.post_my_heartbeat(None, machine=w.host, db=w.db)
        tx_id = _owe(w)
        owed = machines_router.post_my_heartbeat(None, machine=w.till1, db=w.db)["cashOwed"]
        assert owed["count"] == 1 and owed["etag"] != empty["etag"]
        assert "cashOwed" not in machines_router.post_my_heartbeat(None, machine=w.till2, db=w.db)
        CS.pay_owed(w.db, w.till1, tx_id, {"movementId": str(uuid.uuid4())})
        w.db.commit()
        after = machines_router.post_my_heartbeat(None, machine=w.till1, db=w.db)["cashOwed"]
        assert after["count"] == 0 and after["etag"] != owed["etag"]

    def test_paid_once_idempotent_by_movement_id(self, w):
        tx_id = _owe(w)
        movement = uuid.uuid4()
        body = CSR.OwedPayIn(movementId=movement, userId="7", userName="דנה", amountAgorot=1300)
        out = CSR.post_cash_owed_pay(str(w.till1.id), str(tx_id), body, machine=w.till1, db=w.db)
        assert out["ok"] is True and out["item"]["resolution"] == "paid_out"
        assert out["item"]["movementId"] == str(movement) and out["item"]["resolvedBy"] == "דנה · Till 1"
        again = CSR.post_cash_owed_pay(str(w.till1.id), str(tx_id), body, machine=w.till1, db=w.db)
        assert again == out
        row = w.db.get(CashStationTx, tx_id)
        assert (row.owed_status, row.resolved_by_machine_id, row.movement_id, row.paid_agorot) == (
            "resolved", w.till1.id, movement, 1300,
        )
        assert cash_rows(w, "change_owed") == []
        e = refusal(CSR.post_cash_owed_pay, str(w.till1.id), str(tx_id), CSR.OwedPayIn(movementId=uuid.uuid4()),
                    machine=w.till1, db=w.db)
        assert (e.status_code, e.detail["code"], e.detail["resolvedBy"]) == (409, "already_resolved", "דנה · Till 1")
        assert e.detail["resolvedAt"] == out["item"]["resolvedAt"]

    def test_what_is_refused(self, w):
        tx_id = _owe(w)
        e = refusal(CS.pay_owed, w.db, w.till2, tx_id, {"movementId": str(uuid.uuid4())})
        assert (e.status_code, e.detail["code"]) == (403, "not_alert_till")
        e = refusal(CS.pay_owed, w.db, w.till1, tx_id, {"movementId": str(uuid.uuid4()), "amountAgorot": 1000})
        assert (e.status_code, e.detail["code"], e.detail["amountAgorot"]) == (409, "amount_mismatch", 1300)
        e = refusal(CS.pay_owed, w.db, w.till1, uuid.uuid4(), {"movementId": str(uuid.uuid4())})
        assert (e.status_code, e.detail["code"]) == (404, "owed_not_found")
        e = refusal(CS.pay_owed, w.db, w.other_till, tx_id, {"movementId": str(uuid.uuid4())})
        assert e.status_code == 404
        closed = w.shift(w.till1, 1)
        e = refusal(CS.pay_owed, w.db, w.till1, tx_id, {"movementId": str(uuid.uuid4()), "shiftId": str(closed.id)})
        assert (e.status_code, e.detail["code"]) == (409, "shift_not_open")

    def test_resolved_on_the_dashboard(self, w):
        tx_id = _owe(w)
        out = CR.post_cash_station_owed_resolve(
            w.station.id, str(tx_id), CR.ResolveIn(resolution="written_off", note="הלקוח ויתר"),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["item"]["resolution"] == "written_off" and out["item"]["resolvedBy"] == "דשבורד: admin"
        e = refusal(CS.pay_owed, w.db, w.till1, tx_id, {"movementId": str(uuid.uuid4())})
        assert (e.status_code, e.detail["code"], e.detail["resolvedBy"]) == (409, "already_resolved", "דשבורד: admin")
        e = refusal(CR.post_cash_station_owed_resolve, w.station.id, str(tx_id), CR.ResolveIn(resolution="paid_out"),
                    current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "already_resolved"
        e = refusal(CR.post_cash_station_owed_resolve, w.station.id, str(_owe(w)), CR.ResolveIn(resolution="eaten"),
                    current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "invalid_resolution"


# ── The heartbeat, the alerts, the tills (§11.8, §11.9) ──────────────────────


class TestHeartbeatAndAlerts:
    def test_the_block_is_kept_cleaned_never_a_422(self, w):
        body = MachineHeartbeatBody.model_validate({"cash": {
            "api": 1, "lanAddress": "192.168.1.40", "port": 99999, "version": "0.5.0", "stations": [
                {"stationId": str(w.station.id), "state": "exploded", "changeAvailableAgorot": "lots",
                 "denominations": [{"valueAgorot": 100, "kind": "coin", "count": 180, "level": "mid"}, "junk"],
                 "cashbox": {"notes": 41, "valueAgorot": 360000, "full": True},
                 "alerts": [{"code": "hopper_low", "unit": "coin:100", "message": "עודף נמוך: 1 ₪"}, {"code": "BAD CODE"}]},
                {"stationId": "not-an-id"},
            ],
        }})
        machines_router.post_my_heartbeat(body, machine=w.host, db=w.db)
        status = w.host.cash_status
        assert (status["lanAddress"], status["port"], status["version"]) == ("192.168.1.40", 47630, "0.5.0")
        (station,) = status["stations"]
        # §11.11: an unknown state reads as a fault.
        assert (station["state"], station["changeAvailableAgorot"], station["cashbox"]["full"]) == ("fault", 0, True)
        assert [d["valueAgorot"] for d in station["denominations"]] == [100]
        assert [a["code"] for a in station["alerts"]] == ["hopper_low"]
        assert w.host.cash_status_at is not None
        # A garbage block: kept as it was, the beat answered.
        assert machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate({"cash": [1, 2]}), machine=w.host,
                                                 db=w.db)["ok"] is True
        assert w.host.cash_status["lanAddress"] == "192.168.1.40"
        # Another device's block is ignored.
        machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate({"cash": {"lanAddress": "1.2.3.4"}}),
                                          machine=w.till1, db=w.db)
        assert w.till1.cash_status is None

    def test_reported_alerts_open_and_close_with_the_station_named(self, w):
        beat(w, alerts=[{"code": "hopper_low", "unit": "coin:100"}, {"code": "door_open", "unit": ""}])
        rows = {r.details["code"]: r for r in cash_rows(w)}
        assert set(rows) == {"hopper_low", "door_open"}
        assert rows["hopper_low"].details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): עודף נמוך"
        assert rows["hopper_low"].exception_type == "cash_unit" and rows["hopper_low"].machine_id == HOST_ID
        assert (w.till1.id, "cash_alert") in w.woken
        # Still reported: nothing new. No longer: closed by itself.
        beat(w, alerts=[{"code": "hopper_low", "unit": "coin:100"}])
        assert [r.details["code"] for r in cash_rows(w)] == ["hopper_low"]
        closed = [r for r in cash_rows(w, "door_open", open_only=False)]
        assert closed[0].details["resolvedAt"] and closed[0].status == "reviewed"
        # The host's own word on the journal's codes is not used; an unknown code is a fault.
        beat(w, alerts=[{"code": "hopper_low", "unit": "coin:100"}, {"code": "held_credit", "unit": "x"},
                        {"code": "flux_capacitor", "unit": ""}])
        assert {r.details["code"] for r in cash_rows(w)} == {"hopper_low", "flux_capacitor"}
        assert cash_rows(w, "flux_capacitor")[0].details["summary"].endswith("תקלה במכשיר המזומן (flux_capacitor)")

    def test_the_offline_watch(self, w):
        w.host.last_heartbeat_at = now() - timedelta(minutes=5)
        w.db.commit()
        assert CA.scan_offline(w.db) == 1
        w.db.commit()
        (row,) = cash_rows(w, "offline")
        assert row.details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): שרת המזומן לא מחובר" and row.severity == "high"
        assert CA.scan_offline(w.db) == 0  # once per outage
        # It beats again: closed.
        beat(w)
        assert cash_rows(w, "offline") == []
        # A host with no active station is never watched.
        w.station.is_active = False
        w.host.last_heartbeat_at = now() - timedelta(minutes=5)
        w.db.commit()
        assert CA.scan_offline(w.db) == 0

    def test_the_tills_kiosk_alerts_carry_them_and_hear_a_till_ack(self, w):
        beat(w, alerts=[{"code": "hopper_low", "unit": "coin:100"}])
        items = [a for a in OPS.alerts_for_till(w.db, w.till1) if a["kind"] == "cash"]
        (item,) = items
        assert item["id"].startswith("cash:") and item["kioskMachineId"] == str(w.station.id)
        assert (item["kioskName"], item["reason"], item["key"]) == ("עמדת מזומן 2", "hopper_low", "hopper_low:coin:100")
        assert item["text"] == "עמדת מזומן 2 (ליד קיוסק 3): עודף נמוך" and item["acknowledgedAt"] is None
        assert [a for a in OPS.alerts_for_till(w.db, w.till2) if a["kind"] == "cash"] == []
        acked = OPS.acknowledge(w.db, w.till1, item["id"], pos_user_name="דנה")
        assert acked["acknowledgedBy"] == "דנה · Till 1" and acked["acknowledgedAt"]
        with pytest.raises(HTTPException) as e:
            OPS.acknowledge(w.db, w.till2, item["id"])
        assert e.value.status_code == 404

    def test_a_kiosks_own_cash_alert_is_its_stations_cash_alert(self, w):
        # The Android / Windows kiosk's own "cash station unreachable" (status.alerts kind "cash", §11.8): taken
        # (it was dropped — only printer/terminal/help were), and routed as the station's cash alert.
        device = w.db.get(KioskDevice, w.kiosk.id)
        reported = [{"kind": "cash", "key": "cash:unreachable", "reason": "unreachable", "text": "אין קשר לעמדת המזומן",
                     "detail": {"stationId": str(w.station.id), "stationName": "עמדת מזומן 2"}}]
        OPS.reconcile(w.db, w.kiosk, device, {}, reported)
        w.db.commit()
        (row,) = cash_rows(w, "unreachable")
        assert row.exception_type == "cash_unit" and row.severity == "high" and row.status == "new"
        assert row.details["summary"] == "עמדת מזומן 2 (ליד קיוסק 3): קיוסק 3 — אין קשר לעמדת המזומן"
        assert (row.details["source"], row.details["unit"]) == ("kiosk", f"kiosk:{w.kiosk.id}")
        assert row.details["kioskName"] == "קיוסק 3" and row.details["stationId"] == str(w.station.id)
        assert (w.till1.id, "cash_alert") in w.woken
        # On the tills once — the station's cash alert (`cashAlertTills`, '' = the main till), never a kiosk row too.
        items = OPS.alerts_for_till(w.db, w.till1)
        assert [(a["kind"], a["reason"]) for a in items] == [("cash", "unreachable")]
        assert items[0]["id"].startswith("cash:") and items[0]["kioskName"] == "עמדת מזומן 2"
        assert OPS.alerts_for_till(w.db, w.till2) == []
        # Still reported: nothing new. The kiosk reaches it again: closed.
        OPS.reconcile(w.db, w.kiosk, device, {}, reported)
        w.db.commit()
        assert len(cash_rows(w, "unreachable", open_only=False)) == 1
        OPS.reconcile(w.db, w.kiosk, device, {}, [])
        w.db.commit()
        assert cash_rows(w, "unreachable") == []
        assert cash_rows(w, "unreachable", open_only=False)[0].details["resolvedAt"]
        # A station id that is not one of its shop's: the kiosk's own station (cashEnabled + cashStation); none, none.
        stray = [dict(reported[0], key="cash:x", detail={"stationId": str(uuid.uuid4())})]
        OPS.reconcile(w.db, w.kiosk, device, {}, stray)
        w.db.commit()
        assert cash_rows(w, "unreachable") == []
        OPS.reconcile(w.db, w.kiosk, device, {}, [])
        enable_kiosk(w, w.station.id)
        OPS.reconcile(w.db, w.kiosk, device, {}, stray)
        w.db.commit()
        assert len(cash_rows(w, "unreachable")) == 1
        # An unknown kind is still dropped.
        OPS.reconcile(w.db, w.kiosk, device, {}, stray + [{"kind": "toaster", "key": "t", "reason": "hot"}])
        assert {r["kind"] for r in OPS._clean_reported(stray + [{"kind": "toaster", "key": "t", "reason": "hot"}])} \
            == {"cash"}

    def test_the_kind_its_rule_its_phone_type_and_its_group(self):
        from types import SimpleNamespace

        from app.services import exceptions as EX
        from app.services import problems as PR
        from app.services.exception_alerts import catalog as CAT
        from app.services.exception_alerts import push as PUSH

        assert CAT.kind_spec("cash_unit").label == "מכשיר מזומן" and "cash_unit" in CAT.OPT_IN_KINDS
        rule = EX.RULES_BY_TYPE["cash_unit"]
        assert rule.default_enabled and rule.push_only and rule.push_default
        assert PUSH.category_of(SimpleNamespace(kind="cash_unit", details={})) == "cash"
        assert "cash" in PUSH.CATEGORY_KEYS and PUSH.CASH_CATEGORY_KEYS == ("cash",)
        assert "cash" in PUSH.clean({})["categories"]  # a new user: on
        assert PR.KIND_GROUP["cash_unit"] == "devices"
        assert len("cash_unit") <= 32


# ── The kiosk config (`cash_device`) ──────────────────────────────────────────


class TestKioskConfig:
    def test_cash_device_is_a_method_that_pays_alone_or_after_a_voucher(self):
        assert "cash_device" in KC.PAYMENT_METHODS and "cash_device" in KC.REMAINDER_METHODS
        for methods in (["cash_device"], ["voucher", "cash_device"], ["card", "voucher", "cash_at_till", "cash_device", "split_card"]):
            cfg = KC.resolve({"payment": {"methods": methods}})
            assert cfg["payment"]["methods"] == methods and KC.validate_config(cfg) == [], methods
        codes = {e.path: e.code for e in KC.validate_config(KC.merge(KC.default_config(), {"payment": {"methods": ["cash"]}}))}
        assert codes.get("payment.methods[0]") == "cash_not_supported"
        assert "cash_device" in KC.limits()["enums"]["paymentMethods"]

    def test_a_kiosk_with_no_card_pays_with_the_cash_station(self):
        from app.services import payment_integration as PI

        assert PI.kiosk_pays_at_till({"payment": {"methods": ["cash_device"]}})
        assert PI.kiosk_pays_at_till({"payment": {"methods": ["cash_at_till"]}})
        assert not PI.kiosk_pays_at_till({"payment": {"methods": ["card", "voucher"]}})

    def test_the_dashboards_list_is_the_same(self):
        source = (Path(__file__).absolute().parents[2] / "client" / "src" / "lib" / "kioskConfig.ts").read_text(encoding="utf-8")

        def listed(name):
            block = re.search(rf"export const {name}: PaymentMethod\[\] = \[(.*?)\];", source, re.S).group(1)
            return tuple(re.findall(r"'([a-z_]+)'", block))

        assert listed("PAYMENT_METHODS") == KC.PAYMENT_METHODS
        assert listed("REMAINDER_METHODS") == KC.REMAINDER_METHODS
        union = re.search(r"export type PaymentMethod = (.*?);", source).group(1)
        assert tuple(re.findall(r"'([a-z_]+)'", union)) == KC.PAYMENT_METHODS


# ── Documents (§11.7) ─────────────────────────────────────────────────────────


def _cash_doc(w, tx_id, *, amount="57.35", rounding=5, station=None):
    shift = w.shift(w.kiosk, 1)
    doc = w.doc(w.kiosk, shift, amount)
    (leg,) = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == doc.id).all()
    leg.nayax_meta = {"cashDevice": CS.clean_cash_device({
        "txId": str(tx_id), "stationId": str(station or w.station.id), "hostId": str(HOST_ID),
        "receivedAgorot": 7000, "changeAgorot": 1260, "changeOwedAgorot": 0, "roundingAgorot": rounding,
    })}
    w.db.commit()
    return shift, doc


class TestDocuments:
    def test_the_leg_keeps_cash_device_and_stays_cash(self):
        from app.services.transactions import _leg_meta

        leg = TransactionPaymentIn.model_validate({
            "id": str(uuid.uuid4()), "method": "cash", "amount": "57.35",
            "cashDevice": {"txId": str(KIOSK_ID).upper(), "stationId": str(HOST_ID), "receivedAgorot": 7000,
                           "changeAgorot": 1260, "roundingAgorot": 5, "slipCode": None, "extra": "dropped"},
        })
        assert leg.method == "cash"
        assert _leg_meta(leg) == {"cashDevice": {
            "txId": str(KIOSK_ID), "stationId": str(HOST_ID), "hostId": None, "receivedAgorot": 7000,
            "changeAgorot": 1260, "changeOwedAgorot": 0, "roundingAgorot": 5, "slipCode": None,
        }}
        # Unreadable: dropped, never a refused document.
        assert TransactionPaymentIn.model_validate({"id": str(uuid.uuid4()), "method": "cash", "amount": 1,
                                                    "cashDevice": "nonsense"}).cash_device is None

    def test_counted_as_cash(self, w):
        from app.services.shift_totals import compute_totals

        shift, _doc = _cash_doc(w, uuid.uuid4())
        totals = compute_totals(w.db, [shift.id])
        assert totals.total_cash == Decimal("57.35")

    def test_a_held_credit_closes_when_its_document_arrives(self, w):
        tx_id = uuid.uuid4()
        journal(w, tx_entry(w, tx_id, state="HELD", outcome=None, held=5740, change_paid=1260))
        _shift, doc = _cash_doc(w, tx_id)
        assert CS.match_documents(w.db, [doc.id]) == 1
        w.db.commit()
        row = w.db.get(CashStationTx, tx_id)
        assert (row.owed_status, row.resolution, row.document_id) == ("resolved", "matched_document", str(doc.id))
        assert cash_rows(w, "held_credit") == []

    def test_and_at_once_when_the_document_came_first(self, w):
        tx_id = uuid.uuid4()
        _cash_doc(w, tx_id)
        journal(w, tx_entry(w, tx_id, state="HELD", outcome=None, held=5740, change_paid=1260))
        row = w.db.get(CashStationTx, tx_id)
        assert (row.owed_status, row.resolution) == ("resolved", "matched_document")
        assert cash_rows(w, "held_credit", open_only=False) == []


# ── The station's drawer and the shop Z (§11.9) ──────────────────────────────


class TestDrawerAndZ:
    def _activity(w):
        tx_id = uuid.uuid4()
        journal(
            w,
            {"type": "movement", "id": str(uuid.uuid4()), "stationId": str(w.station.id), "kind": "float",
             "amountAgorot": 10000, "at": ms(NOW - timedelta(hours=1))},
            {"type": "movement", "id": str(uuid.uuid4()), "stationId": str(w.station.id), "kind": "dump",
             "amountAgorot": 3000, "at": ms(NOW - timedelta(minutes=30))},
            tx_entry(w, tx_id, done_at=NOW - timedelta(minutes=20)),
            tx_entry(w, uuid.uuid4(), state="DONE", outcome="refunded", inserted=2000, change_paid=0, refund_paid=2000,
                     done_at=NOW - timedelta(minutes=10)),
            tx_entry(w, uuid.uuid4(), state="HELD", outcome=None, inserted=1000, change_paid=0, held=1000,
                     done_at=NOW - timedelta(minutes=5)),
        )
        return tx_id

    def test_the_drawer_and_its_reconciliation(self, w):
        tx_id = TestDrawerAndZ._activity(w)
        _cash_doc(w, tx_id)
        out = CR.get_cash_station_drawer(w.station.id, date_from=None, date_to=None, current_user=w.admin,
                                         active_tenant_id=w.tenant.id, db=w.db)
        s = out["summary"]
        assert (s["acceptedAgorot"], s["changeAgorot"], s["refundsAgorot"], s["netAgorot"]) == (10000, 1260, 2000, 6740)
        assert (s["floatAgorot"], s["heldAgorot"], s["expectedAgorot"], s["txCount"]) == (10000, 1000, 16740, 3)
        # Σ kiosk cash legs (57.35 ₪ + 5 rounding) + held = the station's net: no difference.
        assert out["reconciliation"] == {
            "kioskCashAgorot": 5740, "kioskDocuments": 1, "stationNetAgorot": 6740, "changeOwedAgorot": 0,
            "heldAgorot": 1000, "expectedNetAgorot": 6740, "differenceAgorot": 0,
        }
        assert out["balanceAgorot"] == 16740

    def test_the_shop_z_takes_them_once_and_prints_them(self, w):
        from app.services.z_builder import build_z
        from app.services.z_print import build_print_document

        tx_id = TestDrawerAndZ._activity(w)
        shift, _doc = _cash_doc(w, tx_id)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.kiosk, shift.id)])
        w.db.commit()
        block = z.header[CSD.Z_KEY]
        (station,) = block["stations"]
        assert (station["stationId"], station["name"], station["hostName"]) == (str(w.station.id), "עמדת מזומן 2", "שרת מזומן")
        assert (station["netAgorot"], station["expectedAgorot"], station["heldAgorot"]) == (6740, 16740, 1000)
        assert station["reconciliation"]["kioskCashAgorot"] == 5740 and station["reconciliation"]["differenceAgorot"] == 0
        assert block["totals"]["netAgorot"] == 6740
        assert {t.z_report_id for t in w.db.query(CashStationTx).all()} == {z.id}
        assert {m.z_report_id for m in w.db.query(CashStationMovement).all()} == {z.id}
        doc = build_print_document(z, timezone.utc)
        (section,) = [s for s in doc["sections"] if s["title"] == "עמדות מזומן: עמדת מזומן 2"]
        rows = {r["label"]: r["value"] for r in section["rows"]}
        assert rows["נטו"].startswith("₪67.40") or "67.40" in rows["נטו"]
        assert "0.00" in rows["הפרש"]
        # The next Z takes nothing of them again.
        later = w.shift(w.kiosk, 2)
        w.doc(w.kiosk, later, "10.00")
        z2 = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.kiosk, later.id)])
        assert z2.header[CSD.Z_KEY]["stations"][0]["txCount"] == 0

    def test_a_shop_without_stations_has_no_block(self, w):
        from app.services.z_builder import build_z

        shift = w.other_till and w.shift(w.other_till, 1)
        w.doc(w.other_till, shift, "10.00")
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.other_shop.id, selections=[(w.other_till, shift.id)])
        assert CSD.Z_KEY not in (z.header or {})


# ── The dashboard (§12) ───────────────────────────────────────────────────────


def _station_body(**kw):
    return CR.StationIn.model_validate(kw)


class TestDashboard:
    def test_create_list_get_update_remove(self, w):
        out = CR.create_cash_station(
            _station_body(shopId=str(w.shop.id), name="עמדה 3", location="בכניסה", serial="AE000009",
                          hostMachineId=str(HOST_ID), settings={"cashRounding": "none"}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert (out["name"], out["label"], out["serial"], out["host"]["machineId"], out["settings"]) == (
            "עמדה 3", "עמדה 3 (בכניסה)", "AE000009", str(HOST_ID), {"cashRounding": "none"},
        )
        assert out["effectiveSettings"]["cashRounding"] == "none" and out["alertTills"][0]["machineId"] == str(w.till1.id)
        listed = CR.list_cash_stations(shop_id=w.shop.id, company_id=None, include_inactive=False, current_user=w.admin,
                                       active_tenant_id=w.tenant.id, db=w.db)
        assert {s["name"] for s in listed["stations"]} == {"עמדת מזומן 2", "עמדה 3"}
        sid = uuid.UUID(out["stationId"])
        put = CR.put_cash_station(sid, _station_body(location=None, settings={"cashIdleTimeoutSec": 30}),
                                  current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert put["location"] is None and put["settings"] == {"cashIdleTimeoutSec": 30} and put["serial"] == "AE000009"
        gone = CR.delete_cash_station(sid, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert gone == {"ok": True, "stationId": str(sid), "isActive": False}
        assert w.db.get(CashStation, sid).is_active is False

    def test_what_a_station_save_refuses(self, w):
        def create(**kw):
            return refusal(CR.create_cash_station, _station_body(shopId=str(w.shop.id), name="X", **kw),
                           current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert create(hostMachineId=str(w.till1.id)).detail["code"] == "not_a_cash_host"
        assert create(hostMachineId=str(HOST_ID), serial="AE000001").detail["code"] == "serial_taken"
        assert create(settings={"cashEnabled": True}).detail["code"] == "invalid_setting"
        e = refusal(CR.create_cash_station, _station_body(shopId=str(w.shop.id), name="  "), current_user=w.admin,
                    active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "name_required"

    def test_the_detail_shows_the_hosts_report(self, w):
        enable_kiosk(w)
        beat(w, denominations=[{"valueAgorot": 100, "kind": "coin", "count": 180}], queue=1,
             alerts=[{"code": "hopper_low", "unit": "coin:100"}])
        _owe(w)
        out = CR.get_cash_station(w.station.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["status"]["state"] == "ready" and out["status"]["changeAvailableAgorot"] == 45600
        assert out["status"]["denominations"][0]["count"] == 180 and out["status"]["queue"] == 1
        assert out["clients"] == [{"machineId": str(KIOSK_ID), "name": "קיוסק 3", "kind": "kiosk"}]
        assert {a["code"] for a in out["alerts"]} == {"hopper_low", "change_owed"}
        assert out["owed"] == {"count": 1, "amountAgorot": 1300}
        assert out["host"]["online"] is True and out["host"]["lanAddress"] == "192.168.1.40"

    def test_journal_movements_and_owed_pages(self, w):
        tx_id = _owe(w)
        page = CR.get_cash_station_journal(w.station.id, date_from=None, date_to=None, state="DONE", outcome=None,
                                           owed="open", limit=10, offset=0, current_user=w.admin,
                                           active_tenant_id=w.tenant.id, db=w.db)
        assert page["total"] == 1 and page["items"][0]["txId"] == str(tx_id)
        assert page["items"][0]["owed"]["kind"] == "change_owed"
        owed = CR.get_cash_station_owed(w.station.id, which="open", current_user=w.admin,
                                        active_tenant_id=w.tenant.id, db=w.db)
        assert [i["id"] for i in owed["changeOwed"]] == [str(tx_id)] and owed["heldCredit"] == []
        moves = CR.get_cash_station_movements(w.station.id, date_from=None, date_to=None, kind=None, limit=10, offset=0,
                                              current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert moves["total"] == 0

    def test_a_command_reaches_the_host_and_is_acknowledged_once(self, w):
        out = CR.post_cash_station_command(
            w.station.id, CR.CommandIn(op="count", args={"countedAgorot": 45600, "note": "ספירה"}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert (out["op"], out["status"], out["args"]) == ("count", "pending", {"countedAgorot": 45600, "note": "ספירה"})
        assert (HOST_ID, "cash_command") in w.woken
        assert [c["id"] for c in CS.view_for(w.db, w.host)["commands"]] == [out["id"]]
        movement = str(uuid.uuid4())
        ack = CSR.post_cash_command_ack(str(HOST_ID), out["id"], CSR.CommandAckIn(status="done", movementId=movement),
                                        machine=w.host, db=w.db)
        assert ack["command"]["status"] == "done" and ack["command"]["movementId"] == movement
        again = CSR.post_cash_command_ack(str(HOST_ID), out["id"], CSR.CommandAckIn(status="failed"), machine=w.host, db=w.db)
        assert again["command"]["status"] == "done"
        assert [c["id"] for c in CS.view_for(w.db, w.host)["commands"]] == []
        # The ops the host carries out with no arguments.
        for op in ("maintenance_on", "maintenance_off", "reset_alerts", "ext_return", "ext_stack", "deliver_pending"):
            cmd = CR.post_cash_station_command(w.station.id, CR.CommandIn(op=op, args={"note": "dropped"}),
                                               current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
            assert (cmd["op"], cmd["args"]) == (op, {})
        e = refusal(CR.post_cash_station_command, w.station.id, CR.CommandIn(op="explode"), current_user=w.admin,
                    active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "invalid_op"
        w.station.host_machine_id = None
        w.db.commit()
        e = refusal(CR.post_cash_station_command, w.station.id, CR.CommandIn(op="refill"), current_user=w.admin,
                    active_tenant_id=w.tenant.id, db=w.db)
        assert e.detail["code"] == "station_has_no_host"
        e = refusal(CS.ack_command, w.db, w.host, uuid.uuid4(), {"status": "done"})
        assert e.detail["code"] == "unknown_command"

    def test_a_dump_of_one_denomination_keeps_its_value_and_count(self, w):
        out = CR.post_cash_station_command(
            w.station.id, CR.CommandIn(op="dump", args={"valueAgorot": 2000, "notes": 3, "note": "לקופסה"}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["args"] == {"valueAgorot": 2000, "notes": 3, "note": "לקופסה"}
        whole = CS.create_command(w.db, w.admin, w.station, "dump", {"valueAgorot": 100})
        assert whole.args == {"valueAgorot": 100}
        # Not a dump: the two are not its arguments.
        assert CS.create_command(w.db, w.admin, w.station, "count", {"valueAgorot": 100, "notes": 2}).args == {}
        for bad in ({"valueAgorot": 300}, {"valueAgorot": True}, {"notes": 0}, {"notes": "3"}, {"notes": 2.5}):
            e = refusal(CS.create_command, w.db, w.admin, w.station, "dump", bad)
            assert e.detail["code"] == "invalid_args", bad

    def test_a_kiosk_assigned_and_taken_off_from_the_station_page(self, w, monkeypatch):
        from fastapi import BackgroundTasks

        told = []
        monkeypatch.setattr(TP, "publish_parameters_notify", lambda targets: told.append(list(targets)))
        tasks = BackgroundTasks()
        out = CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=True), tasks,
                                         current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        for task in tasks.tasks:
            task.func(*task.args, **task.kwargs)
        assert out["clients"] == [{"machineId": str(KIOSK_ID), "name": "קיוסק 3", "kind": "kiosk"}]
        params = CS.machine_params(w.db, w.kiosk)
        assert (params["cashEnabled"], params["cashStation"]) == (True, str(w.station.id))
        assert told == [[(str(w.tenant.id), str(w.kiosk.id))]]  # the kiosk re-pulls its parameters
        assert (HOST_ID, "cash_stations") in w.woken
        assert CS.view_for(w.db, w.kiosk)["station"]["stationId"] == str(w.station.id)
        # The same again: nothing changes, nobody is told.
        told.clear()
        tasks = BackgroundTasks()
        CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=True), tasks,
                                   current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert tasks.tasks == []
        # Taken off: cash off at its own level, its station left as it was.
        out = CR.put_cash_station_client(w.station.id, w.kiosk.id, CR.ClientIn(assigned=False), BackgroundTasks(),
                                         current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["clients"] == []
        params = CS.machine_params(w.db, w.kiosk)
        assert (params["cashEnabled"], params["cashStation"]) == (False, str(w.station.id))
        # Each write is in the parameters' change log.
        from app.models.till_parameter import TillParameterChange

        assert w.db.query(TillParameterChange).filter(TillParameterChange.scope_id == w.kiosk.id).count() == 3

    def test_only_a_device_of_the_stations_shop_and_in_the_users_scope(self, w):
        from fastapi import BackgroundTasks

        for machine_id in (w.other_till.id, w.host.id, uuid.uuid4()):
            e = refusal(CR.put_cash_station_client, w.station.id, machine_id, CR.ClientIn(assigned=True),
                        BackgroundTasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
            assert (e.status_code, e.detail["code"]) == (404, "client_not_found")
        e = refusal(CR.put_cash_station_client, w.station.id, w.kiosk.id, CR.ClientIn(assigned=True), BackgroundTasks(),
                    current_user=manager(w, w.other_shop), active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 403
        # A manager of the station's shop may.
        out = CR.put_cash_station_client(w.station.id, w.till2.id, CR.ClientIn(assigned=True), BackgroundTasks(),
                                         current_user=manager(w, w.shop), active_tenant_id=w.tenant.id, db=w.db)
        assert {c["machineId"]: c["kind"] for c in out["clients"]} == {str(w.till2.id): "till"}

    def test_scope(self, w):
        theirs = manager(w, w.other_shop)
        e = refusal(CR.get_cash_station, w.station.id, current_user=theirs, active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 403
        assert CR.list_cash_stations(shop_id=None, company_id=None, include_inactive=False, current_user=theirs,
                                     active_tenant_id=w.tenant.id, db=w.db) == {"stations": []}
        mine = manager(w, w.shop)
        assert [s["stationId"] for s in CR.list_cash_stations(
            shop_id=None, company_id=None, include_inactive=False, current_user=mine, active_tenant_id=w.tenant.id, db=w.db,
        )["stations"]] == [str(w.station.id)]
        e = refusal(CR.get_cash_station, w.station.id, current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db)
        assert e.status_code == 404

    def test_the_route_map(self):
        from app.services import dashboard_access as DA
        from app.services import dashboard_sections as DS

        def rule(method, path):
            index = DS.rule_index_for(method, path)
            return DS.ROUTE_RULES[index][2]

        assert rule("GET", "/cash-stations").sections == ("devices", "kiosks")
        assert rule("GET", "/cash-stations/{station_id}/journal").level == "view"
        assert rule("PUT", "/cash-stations/{station_id}").sections == ("devices",)
        assert rule("POST", "/cash-stations/{station_id}/owed/{tx_id}/resolve").sections == ("devices",)
        assert rule("POST", "/cash-stations/{station_id}/commands").sections == ("devices", "device_control")
        assigned = rule("PUT", "/cash-stations/{station_id}/clients/{machine_id}")
        assert assigned.sections == ("devices",) and assigned.needed_level("PUT") == DS.EDIT
        (devices,) = [s for s in DS.SECTIONS if s.id == "devices"]
        assert "/dashboard/cash-stations" in devices.pages
        assert DA is not None


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self):
        import importlib.util

        path = Path(__file__).absolute().parents[1] / "alembic" / "versions" / "c4f1a9d7e2b6_cash_stations.py"
        spec = importlib.util.spec_from_file_location("migration_c4f1a9d7e2b6", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_additive_with_its_data_step_and_offline(self):
        import io

        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == ("c4f1a9d7e2b6", "4ff6c2ab6d7c")
        engine = sa.create_engine("sqlite://")
        original = ["till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached"]
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE pos_machines (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("INSERT INTO pos_machines (id) VALUES ('a')"))
            conn.execute(sa.text(
                "CREATE TABLE exception_alert_rules (id CHAR(32) PRIMARY KEY, channel VARCHAR, categories JSON, deleted_at DATETIME)"
            ))
            conn.execute(sa.text("INSERT INTO exception_alert_rules VALUES ('all', 'push', :c, NULL)"),
                         {"c": json.dumps(original)})
            conn.execute(sa.text("INSERT INTO exception_alert_rules VALUES ('some', 'push', :c, NULL)"),
                         {"c": json.dumps(["large_void"])})
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            cols = {c["name"] for c in insp.get_columns("pos_machines")}
            assert {"is_cash_host", "cash_status", "cash_status_at"} <= cols
            assert conn.execute(sa.text("SELECT is_cash_host FROM pos_machines")).scalar() in (0, False)
            assert "ix_pos_machines_is_cash_host" in {i["name"] for i in insp.get_indexes("pos_machines")}
            for table in ("cash_stations", "cash_station_txs", "cash_station_movements", "cash_host_commands"):
                assert insp.has_table(table), table
            tx_cols = {c["name"] for c in insp.get_columns("cash_station_txs")}
            assert {"tx_id", "seq", "owed_status", "movement_id", "z_report_id", "data", "held_agorot"} <= tx_cols
            got = dict(conn.execute(sa.text("SELECT id, categories FROM exception_alert_rules")).fetchall())
            assert json.loads(got["all"]) == [*original, "cash"] and json.loads(got["some"]) == ["large_void"]
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "ALTER TABLE pos_machines ADD COLUMN is_cash_host BOOLEAN DEFAULT false NOT NULL" in sql
        assert "CREATE TABLE cash_stations" in sql and "CREATE TABLE cash_station_txs" in sql
        assert "cash_status JSONB" in sql

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "c4f1a9d7e2b6" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("c4f1a9d7e2b6").down_revision == "4ff6c2ab6d7c"


# ── What kiosk-desktop's cash host really sends (its golden fixtures, the same bytes) ──────────


KIOSK_DESKTOP = Path(__file__).parent / "fixtures" / "kiosk_desktop"
FIXTURE_STATION = "5a7c0000-0000-4000-8000-0000000000c1"
FIXTURE_HOST = "a1b2c3d4-0000-4000-8000-0000000000aa"
FIXTURE_KIOSK = "549e903c-4aba-4528-bc4a-c61b4019a64e"


def _as_world(w, value):
    """The fixture's ids made the world's (the station, the host, the kiosk)."""
    text = json.dumps(value)
    for old, new in ((FIXTURE_STATION, w.station.id), (FIXTURE_HOST, w.host.id), (FIXTURE_KIOSK, w.kiosk.id)):
        text = text.replace(old, str(new))
    return json.loads(text)


class TestTheKioskDesktopHost:
    def test_its_journal_is_taken_whole(self, w):
        body = _as_world(w, json.loads((KIOSK_DESKTOP / "cash_journal.json").read_text(encoding="utf-8")))
        out = journal(w, *body["entries"])
        assert out["rejected"] == []
        assert len(out["accepted"]) == 3
        paid = w.db.get(CashStationTx, uuid.UUID("7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b"))
        assert (paid.state, paid.outcome, paid.change_owed_agorot, paid.slip_code, paid.order_label) == ("DONE", "paid", 260, "C-K7Q3MX", "K-57")
        assert (paid.owed_status, paid.owed_kind, paid.owed_agorot) == ("open", "change_owed", 260)
        assert paid.document_number == "457"
        held = w.db.get(CashStationTx, uuid.UUID("8d1f6b2c-3e4a-4d6f-9b0c-1d2e3f4a5b6c"))
        assert (held.state, held.held_agorot, held.held_reason, held.owed_kind) == ("HELD", 2000, "power_loss", "held_credit")
        (move,) = w.db.query(CashStationMovement).all()
        assert (move.kind, move.amount_agorot) == ("refill", 20000)

    def test_its_heartbeat_block_is_kept_and_its_alerts_open(self, w):
        body = _as_world(w, json.loads((KIOSK_DESKTOP / "cash_heartbeat.json").read_text(encoding="utf-8")))
        w.host.last_heartbeat_at = now()
        machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate(body), machine=w.host, db=w.db)
        w.db.commit()
        status = w.host.cash_status
        assert (status["lanAddress"], status["port"]) == ("192.168.1.40", 47630)
        (station,) = status["stations"]
        assert (station["state"], station["changeAvailableAgorot"]) == ("ready", 20300)
        assert [d["valueAgorot"] for d in station["denominations"]] == [100, 1000]
        assert [r.details.get("code") for r in cash_rows(w)] == ["hopper_low"]
