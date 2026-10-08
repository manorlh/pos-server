"""
"מכשירי תשלום" — several card terminals for a till without one of its own
(app/services/payment_devices.py, app/routers/payment_devices.py).

What each class pins:

* **Config** — each kind keeps exactly its fields, normalised as the till reads them (defaults
  filled in, empty values left out), and refuses a bad one with a machine-readable code and the
  field; an address typed as a URL is split.
* **CRUD** — nickname rules (trimmed, 1–40, unique in the shop whatever its case), tills of the
  shop only, sort order, partial PUT, a kind change, deletion clearing every default naming it,
  the shop's stamp moved and its tills told.
* **Secrets** — write-only (mask keeps, null removes), encrypted apart, dropped for a kind that
  does not use them, never in any dashboard answer.
* **Permissions** — the shop's managers; another shop's manager and a cashier are refused.
* **Settings keys** — `multiPaymentDevices` managed and resettable; `defaultPaymentDeviceId`
  only a device of that shop (that applies to the till), refused on a tenant / company, checked
  only when it changes.
* **The till's sync** — the exact contract: JSON strings, the applicability filter, inactive
  devices included, secrets only to a till without built-in clearing, nothing to a kiosk, and a
  watermark that moves so a delta pull is not "unchanged".
* **SynqPay pairing per device** — the key stored on the device with its audit, the checks, the
  rejection report; without `paymentDeviceId` nothing changes.
* **The migration** — a unique revision on the single head.

Runs on the in-memory SQLite world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.middleware.auth import CatalogActor
from app.models.kiosk import KioskDevice
from app.models.payment_device import PaymentDevice
from app.models.payment_secret import PaymentIntegrationSecret
from app.models.shop_area import ShopArea
from app.routers import payment_devices as R
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.routers import synqpay_pairing as SR
from app.schemas.payment_devices import PaymentDeviceIn
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.synqpay_pairing import SynqpayKeyRejectedIn, SynqpayPairingIn
from app.services import payment_devices as PD
from app.services import settings_notify
from app.services.settings_merge import MANAGED_SETTING_KEYS
from test_shop_areas import _ctx, refused, w  # noqa: F401

PASSWORD = "s3cret-Pass!"
KEY = "1234abcd"
SERIAL = "244RKR528387"

AGAMENTO = {"nickname": "Nayax bar", "kind": "agamento_lan", "config": {"host": "192.168.1.20"}}
ZCREDIT = {
    "nickname": "Z pinpad",
    "kind": "zcredit_pinpad",
    "config": {"pinpadId": "PINPAD123456"},
    "zcreditPassword": PASSWORD,
}
SYNQ = {
    "nickname": "Synq",
    "kind": "synqpay",
    "config": {"model": "dx8000", "connection": "lan", "host": "192.168.1.40"},
}


@pytest.fixture
def pd(w, monkeypatch):
    """The world: Till 1 a P18 tablet (no built-in clearing), Till 2 an F20-like till (built-in)."""
    w.shop_notified = []
    monkeypatch.setattr(
        settings_notify,
        "notify_machines_for_shop_settings",
        lambda db, shop_id, reason: w.shop_notified.append((str(shop_id), reason)),
    )
    for name in (
        "notify_machine_settings",
        "notify_machines_for_area_settings",
        "notify_machines_for_shop_settings",
        "notify_machines_for_company_settings",
        "notify_machines_for_tenant_settings",
    ):
        monkeypatch.setattr(settings_router, name, lambda *a, **k: None)
    w.tablet, w.f20 = w.tills
    w.tablet.device_model = "P18"
    w.db.commit()
    assert w.tablet.has_builtin_terminal is False
    assert w.f20.has_builtin_terminal is True
    return w


def body(data):
    return PaymentDeviceIn.model_validate(data)


def create(w, data, *, user=None, shop=None):
    return R.create_payment_device((shop or w.shop).id, body(data), **_ctx(w, user))


def update(w, device_id, data, *, user=None):
    return R.update_payment_device(uuid.UUID(str(device_id)), body(data), **_ctx(w, user))


def delete(w, device_id, *, user=None):
    return R.delete_payment_device(uuid.UUID(str(device_id)), **_ctx(w, user))


def listed(w, *, user=None, shop=None):
    return R.list_payment_devices((shop or w.shop).id, **_ctx(w, user))


def pulled(w, till, since=None):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=since, machine=till, db=w.db)


def code_of(exc) -> str:
    return exc.detail["code"]


def device_row(w, device_id) -> PaymentDevice:
    w.db.expire_all()
    return w.db.get(PaymentDevice, uuid.UUID(str(device_id)))


def device_secrets(w, device_id):
    w.db.expire_all()
    return (
        w.db.query(PaymentIntegrationSecret)
        .filter(PaymentIntegrationSecret.level == "payment_device", PaymentIntegrationSecret.entity_id == uuid.UUID(str(device_id)))
        .all()
    )


def patch_shop(w, *, user=None, **data):
    return settings_router.patch_shop_settings(
        shop_id=str(w.shop.id), data=PosSettingsV1Patch(**data), **_ctx(w, user)
    )


def patch_machine(w, till, **data):
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=PosSettingsV1Patch(**data), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def as_kiosk(w, till):
    w.db.add(KioskDevice(machine_id=till.id, tenant_id=w.tenant.id, shop_id=till.shop_id, name="kiosk"))
    w.db.commit()
    till.__dict__.pop("_is_kiosk_cached", None)


# ── Config ────────────────────────────────────────────────────────────────────


class TestConfig:
    def test_agamento_defaults(self):
        assert PD.clean_config("agamento_lan", {"host": " 192.168.1.20 "}) == {
            "host": "192.168.1.20", "port": 8080, "path": "/SPICy", "https": False,
        }

    def test_agamento_full_and_normalised(self):
        cfg = PD.clean_config("agamento_lan", {
            "host": "Pinpad.Local", "port": "8081", "path": "/SPICy2", "https": True,
            "mac": "AA-BB-CC-DD-EE-0F", "terminalNumber": "0012345", "junk": 1,
        })
        assert cfg == {
            "host": "pinpad.local", "port": 8081, "path": "/SPICy2", "https": True,
            "mac": "aa:bb:cc:dd:ee:0f", "terminalNumber": "0012345",
        }

    def test_an_address_typed_as_a_url_is_split(self):
        assert PD.clean_config("agamento_lan", {"host": "http://192.168.1.20:8080/SPICy"}) == {
            "host": "192.168.1.20", "port": 8080, "path": "/SPICy", "https": False,
        }
        cfg = PD.clean_config("agamento_lan", {"host": "https://10.0.0.9:9443"})
        assert (cfg["host"], cfg["port"], cfg["path"], cfg["https"]) == ("10.0.0.9", 9443, "/SPICy", True)
        # A field typed apart wins over the URL's part.
        cfg = PD.clean_config("agamento_lan", {"host": "http://10.0.0.9:9000/x", "port": 8085, "path": "/SPICy"})
        assert (cfg["port"], cfg["path"]) == (8085, "/SPICy")

    @pytest.mark.parametrize("mac,expected", [
        ("aabbccddeeff", "aa:bb:cc:dd:ee:ff"),
        ("AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff"),
        ("aabb.ccdd.eeff", "aa:bb:cc:dd:ee:ff"),
    ])
    def test_mac_spellings(self, mac, expected):
        assert PD.clean_config("agamento_lan", {"host": "10.0.0.1", "mac": mac})["mac"] == expected

    @pytest.mark.parametrize("raw,code,field", [
        ({}, "host_required", "config.host"),
        ({"host": "  "}, "host_required", "config.host"),
        ({"host": "192.168.1.300"}, "host_invalid", "config.host"),
        ({"host": "ftp://1.2.3.4"}, "host_invalid", "config.host"),
        ({"host": "my_host"}, "host_invalid", "config.host"),
        ({"host": "1.2.3.4", "port": 70000}, "port_invalid", "config.port"),
        ({"host": "1.2.3.4", "port": "80a"}, "port_invalid", "config.port"),
        ({"host": "1.2.3.4", "port": True}, "port_invalid", "config.port"),
        ({"host": "http://1.2.3.4:99999"}, "port_invalid", "config.port"),
        ({"host": "1.2.3.4", "path": "SPICy"}, "path_invalid", "config.path"),
        ({"host": "1.2.3.4", "https": "yes"}, "https_invalid", "config.https"),
        ({"host": "1.2.3.4", "mac": "zz:zz"}, "mac_invalid", "config.mac"),
        ({"host": "1.2.3.4", "terminalNumber": "12a"}, "terminal_number_invalid", "config.terminalNumber"),
        ({"host": "1.2.3.4", "terminalNumber": "1" * 21}, "terminal_number_invalid", "config.terminalNumber"),
    ])
    def test_agamento_refusals(self, raw, code, field):
        with pytest.raises(PD.PaymentDeviceError) as e:
            PD.clean_config("agamento_lan", raw)
        assert e.value.status_code == 422
        assert e.value.detail["code"] == code and e.value.detail["field"] == field
        assert e.value.detail["msg"]

    def test_zcredit(self):
        assert PD.clean_config("zcredit_pinpad", {"pinpadId": "PINPAD123456"}) == {"pinpadId": "123456"}
        assert PD.clean_config(
            "zcredit_pinpad", {"pinpadId": "abc9", "terminalNumber": "0882123", "mode": "TEST", "host": "x"}
        ) == {"pinpadId": "abc9", "terminalNumber": "0882123", "mode": "test"}

    @pytest.mark.parametrize("raw,code", [
        ({}, "pinpad_required"),
        ({"pinpadId": "PINPAD"}, "pinpad_invalid"),
        ({"pinpadId": "12-3"}, "pinpad_invalid"),
        ({"pinpadId": "1", "mode": "live"}, "mode_invalid"),
        ({"pinpadId": "1", "terminalNumber": "x"}, "terminal_number_invalid"),
    ])
    def test_zcredit_refusals(self, raw, code):
        with pytest.raises(PD.PaymentDeviceError) as e:
            PD.clean_config("zcredit_pinpad", raw)
        assert e.value.detail["code"] == code

    def test_synqpay_lan_and_usb(self):
        assert PD.clean_config("synqpay", {"model": "DX8000", "connection": "lan", "host": "192.168.1.40"}) == {
            "model": "dx8000", "connection": "lan", "host": "192.168.1.40", "protocol": "tcp", "tls": False,
        }
        cfg = PD.clean_config("synqpay", {
            "model": "rx5000", "connection": "usb_serial", "host": "10.0.0.1", "protocol": "http", "port": "9443",
            "tls": True, "usbDevice": "0b00:0080", "serialNumber": SERIAL, "terminalNumber": "77",
        })
        # USB: no address (the host is for the network only).
        assert cfg == {
            "model": "rx5000", "connection": "usb", "protocol": "http", "port": 9443, "tls": True,
            "usbDevice": "0B00:0080", "serialNumber": SERIAL, "terminalNumber": "77",
        }

    @pytest.mark.parametrize("raw,code", [
        ({"connection": "lan", "host": "1.2.3.4"}, "model_required"),
        ({"model": "foo", "connection": "lan", "host": "1.2.3.4"}, "model_invalid"),
        ({"model": "dx8000"}, "connection_required"),
        ({"model": "dx8000", "connection": "wifi"}, "connection_invalid"),
        ({"model": "dx8000", "connection": "lan"}, "host_required"),
        ({"model": "dx8000", "connection": "lan", "host": "1.2.3"}, "host_invalid"),
        ({"model": "dx8000", "connection": "usb", "protocol": "udp"}, "protocol_invalid"),
        ({"model": "dx8000", "connection": "usb", "port": 0}, "port_invalid"),
        ({"model": "dx8000", "connection": "usb", "tls": "no"}, "tls_invalid"),
        ({"model": "dx8000", "connection": "usb", "usbDevice": "12:34"}, "usb_device_invalid"),
        ({"model": "dx8000", "connection": "usb", "serialNumber": "ab"}, "serial_invalid"),
    ])
    def test_synqpay_refusals(self, raw, code):
        with pytest.raises(PD.PaymentDeviceError) as e:
            PD.clean_config("synqpay", raw)
        assert e.value.detail["code"] == code

    def test_kind_and_config_shape(self):
        for value, code in ((None, "kind_required"), ("", "kind_required"), ("nayax", "kind_invalid"), (3, "kind_invalid")):
            with pytest.raises(PD.PaymentDeviceError) as e:
                PD.clean_kind(value)
            assert e.value.detail["code"] == code
        assert PD.clean_kind(" Agamento-LAN ") == "agamento_lan"
        with pytest.raises(PD.PaymentDeviceError) as e:
            PD.clean_config("agamento_lan", ["192.168.1.1"])
        assert e.value.detail["code"] == "config_invalid"

    def test_till_config_fills_defaults_and_drops_empties(self):
        assert PD.till_config("agamento_lan", {"host": "1.2.3.4", "mac": None, "terminalNumber": ""}) == {
            "host": "1.2.3.4", "port": 8080, "path": "/SPICy", "https": False,
        }
        assert PD.till_config("synqpay", {"model": "dx8000", "connection": "usb"}) == {
            "model": "dx8000", "connection": "usb", "protocol": "tcp", "tls": False,
        }


# ── CRUD ──────────────────────────────────────────────────────────────────────


class TestCrud:
    def test_create_answers_the_dashboard_shape(self, pd):
        out = create(pd, AGAMENTO)
        assert set(out) == {
            "id", "nickname", "kind", "active", "sortOrder", "config", "shopId", "machineIds",
            "createdAt", "updatedAt", "secrets",
        }
        assert out["nickname"] == "Nayax bar" and out["kind"] == "agamento_lan"
        assert out["active"] is True and out["sortOrder"] == 0 and out["machineIds"] == []
        assert out["config"] == {"host": "192.168.1.20", "port": 8080, "path": "/SPICy", "https": False}
        assert out["shopId"] == str(pd.shop.id)
        assert out["secrets"]["zcreditPassword"]["set"] is False
        assert out["secrets"]["synqpayApiKey"]["set"] is False
        row = device_row(pd, out["id"])
        assert row.tenant_id == pd.tenant.id and row.shop_id == pd.shop.id

    def test_nickname_rules(self, pd):
        assert create(pd, {**AGAMENTO, "nickname": "  Bar   one "})["nickname"] == "Bar one"
        for nickname, code in ((None, "nickname_required"), ("   ", "nickname_required"), ("x" * 41, "nickname_too_long"),
                               ("a\x07b", "nickname_invalid")):
            e = refused(create, pd, {**AGAMENTO, "nickname": nickname})
            assert (e.status_code, code_of(e), e.detail["field"]) == (422, code, "nickname")
        assert create(pd, {**AGAMENTO, "nickname": "x" * 40})["nickname"] == "x" * 40

    def test_nickname_unique_in_the_shop_whatever_its_case(self, pd):
        first = create(pd, {**AGAMENTO, "nickname": "Bar"})
        e = refused(create, pd, {**AGAMENTO, "nickname": "bAR "})
        assert (e.status_code, code_of(e)) == (409, "nickname_taken")
        # Another shop may use it.
        create(pd, {**AGAMENTO, "nickname": "Bar"}, shop=pd.other_shop)
        second = create(pd, {**AGAMENTO, "nickname": "Kitchen"})
        e = refused(update, pd, second["id"], {"nickname": "BAR"})
        assert (e.status_code, code_of(e)) == (409, "nickname_taken")
        # Its own nickname in another case is fine.
        assert update(pd, first["id"], {"nickname": "BAR"})["nickname"] == "BAR"

    def test_machine_ids_are_the_shops_tills(self, pd):
        out = create(pd, {**AGAMENTO, "machineIds": [str(pd.tablet.id), str(pd.tablet.id).upper()]})
        assert out["machineIds"] == [str(pd.tablet.id)]
        e = refused(create, pd, {**AGAMENTO, "nickname": "x", "machineIds": [str(pd.other_till.id)]})
        assert (code_of(e), e.detail["field"]) == ("machine_not_in_shop", "machineIds")
        e = refused(create, pd, {**AGAMENTO, "nickname": "x", "machineIds": ["nope"]})
        assert code_of(e) == "machine_ids_invalid"
        e = refused(create, pd, {**AGAMENTO, "nickname": "x", "machineIds": [str(uuid.uuid4())]})
        assert code_of(e) == "machine_not_in_shop"
        as_kiosk(pd, pd.f20)
        e = refused(create, pd, {**AGAMENTO, "nickname": "x", "machineIds": [str(pd.f20.id)]})
        assert code_of(e) == "machine_is_kiosk"

    def test_a_till_that_moved_away_is_dropped_not_refused(self, pd):
        out = create(pd, {**AGAMENTO, "machineIds": [str(pd.tablet.id), str(pd.f20.id)]})
        pd.f20.shop_id = pd.other_shop.id
        pd.db.commit()
        again = update(pd, out["id"], {"machineIds": out["machineIds"]})
        assert again["machineIds"] == [str(pd.tablet.id)]

    def test_sort_order_and_active(self, pd):
        assert create(pd, {**AGAMENTO, "sortOrder": 9999, "active": False})["sortOrder"] == 9999
        for value in (-1, 10000, True, "x", 1.5):
            e = refused(create, pd, {**AGAMENTO, "nickname": "n", "sortOrder": value})
            assert code_of(e) == "sort_order_invalid"
        e = refused(create, pd, {**AGAMENTO, "nickname": "n", "active": "yes"})
        assert code_of(e) == "active_invalid"

    def test_put_changes_only_what_it_sends(self, pd):
        out = create(pd, {**AGAMENTO, "machineIds": [str(pd.tablet.id)], "sortOrder": 3})
        again = update(pd, out["id"], {"active": False})
        assert again["active"] is False
        assert (again["nickname"], again["config"], again["machineIds"], again["sortOrder"]) == (
            out["nickname"], out["config"], out["machineIds"], 3,
        )
        again = update(pd, out["id"], {"config": {"host": "10.0.0.7", "port": 8090}})
        assert again["config"] == {"host": "10.0.0.7", "port": 8090, "path": "/SPICy", "https": False}
        assert update(pd, out["id"], {"machineIds": []})["machineIds"] == []

    def test_a_kind_change_validates_the_new_kind_and_drops_the_old_secrets(self, pd):
        out = create(pd, ZCREDIT)
        assert len(device_secrets(pd, out["id"])) == 1
        e = refused(update, pd, out["id"], {"kind": "agamento_lan"})
        assert (code_of(e), e.detail["field"]) == ("host_required", "config.host")
        assert device_row(pd, out["id"]).kind == "zcredit_pinpad"
        again = update(pd, out["id"], {"kind": "agamento_lan", "config": {"host": "10.0.0.8"}})
        assert again["kind"] == "agamento_lan"
        assert again["config"]["host"] == "10.0.0.8"
        assert device_secrets(pd, out["id"]) == []
        assert again["secrets"]["zcreditPassword"]["set"] is False

    def test_delete_takes_its_secrets_and_every_default_naming_it(self, pd):
        keep = create(pd, {**AGAMENTO, "nickname": "keep"})
        gone = create(pd, ZCREDIT)
        area = ShopArea(id=uuid.uuid4(), tenant_id=pd.tenant.id, shop_id=pd.shop.id, name="Bar",
                        settings={"defaultPaymentDeviceId": gone["id"]})
        pd.db.add(area)
        pd.shop.settings = {"defaultPaymentDeviceId": gone["id"], "multiPaymentDevices": True}
        pd.tablet.settings = {"defaultPaymentDeviceId": gone["id"], "globalTaxRate": 17}
        pd.f20.settings = {"defaultPaymentDeviceId": keep["id"]}
        pd.db.commit()
        assert delete(pd, gone["id"]).status_code == 204
        pd.db.expire_all()
        assert device_row(pd, gone["id"]) is None
        assert device_secrets(pd, gone["id"]) == []
        assert pd.shop.settings == {"multiPaymentDevices": True}
        assert pd.db.get(ShopArea, area.id).settings == {}
        assert pd.tablet.settings == {"globalTaxRate": 17}
        assert pd.f20.settings == {"defaultPaymentDeviceId": keep["id"]}
        assert [d["id"] for d in listed(pd)["devices"]] == [keep["id"]]
        assert refused(delete, pd, gone["id"]).status_code == 404

    def test_narrowing_the_tills_clears_a_dropped_tills_default(self, pd):
        out = create(pd, AGAMENTO)
        pd.tablet.settings = {"defaultPaymentDeviceId": out["id"]}
        pd.f20.settings = {"defaultPaymentDeviceId": out["id"]}
        pd.db.commit()
        update(pd, out["id"], {"machineIds": [str(pd.tablet.id)]})
        pd.db.expire_all()
        assert pd.tablet.settings == {"defaultPaymentDeviceId": out["id"]}
        assert pd.f20.settings == {}

    def test_every_write_moves_the_shops_stamp_and_tells_its_tills(self, pd):
        old = datetime(2026, 1, 1, tzinfo=timezone.utc)

        def reset():
            pd.shop.settings_updated_at = old
            pd.db.commit()
            pd.shop_notified.clear()

        def moved():
            pd.db.expire_all()
            stamp = pd.shop.settings_updated_at
            stamp = stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
            return stamp > old and pd.shop_notified == [(str(pd.shop.id), PD.NOTIFY_REASON)]

        reset()
        out = create(pd, ZCREDIT)
        assert moved()
        reset()
        update(pd, out["id"], {"zcreditPassword": "another"})
        assert moved()
        reset()
        delete(pd, out["id"])
        assert moved()

    def test_the_list(self, pd):
        pd.company.settings = {"multiPaymentDevices": True}
        pd.shop.settings = {"multiPaymentDevices": False}
        pd.db.commit()
        create(pd, {**AGAMENTO, "nickname": "b", "sortOrder": 2})
        create(pd, {**AGAMENTO, "nickname": "A", "sortOrder": 2})
        create(pd, {**AGAMENTO, "nickname": "z", "sortOrder": 1})
        create(pd, {**AGAMENTO, "nickname": "elsewhere"}, shop=pd.other_shop)
        page = listed(pd, user=pd.manager)
        assert [d["nickname"] for d in page["devices"]] == ["z", "A", "b"]
        assert page["multiPaymentDevices"] is False
        assert page["multiPaymentDevicesInherited"] is True
        assert page["multiPaymentDevicesInheritedSource"] == "company"
        assert page["canEdit"] is True
        machines = {m["id"]: m for m in page["machines"]}
        assert set(machines) == {str(pd.tablet.id), str(pd.f20.id)}
        assert machines[str(pd.tablet.id)]["hasBuiltinTerminal"] is False
        assert machines[str(pd.f20.id)]["hasBuiltinTerminal"] is True
        assert {k["value"] for k in page["kinds"]} == {"zcredit_pinpad", "synqpay", "agamento_lan"}
        as_kiosk(pd, pd.f20)
        assert [m["id"] for m in listed(pd)["machines"]] == [str(pd.tablet.id)]

    def test_the_tills_own_view(self, pd):
        everyone = create(pd, {**AGAMENTO, "nickname": "all"})
        create(pd, {**AGAMENTO, "nickname": "f20 only", "machineIds": [str(pd.f20.id)]})
        out = R.machine_payment_devices(pd.tablet.id, **_ctx(pd))
        assert out["shopId"] == str(pd.shop.id)
        assert out["hasBuiltinTerminal"] is False and out["isKiosk"] is False
        assert [d["id"] for d in out["devices"]] == [everyone["id"]]


# ── Secrets ───────────────────────────────────────────────────────────────────


class TestSecrets:
    def test_stored_encrypted_and_never_answered(self, pd):
        out = create(pd, ZCREDIT)
        assert out["secrets"]["zcreditPassword"]["set"] is True
        rows = device_secrets(pd, out["id"])
        assert [(r.key, r.level, r.origin) for r in rows] == [("zcreditPassword", "payment_device", "dashboard")]
        assert PASSWORD not in rows[0].ciphertext
        for answer in (out, listed(pd), R.machine_payment_devices(pd.tablet.id, **_ctx(pd))):
            assert PASSWORD not in json.dumps(answer, default=str)
        assert PASSWORD not in json.dumps(device_row(pd, out["id"]).config)

    def test_mask_keeps_null_removes_value_replaces(self, pd):
        out = create(pd, ZCREDIT)
        before = device_secrets(pd, out["id"])[0].ciphertext
        update(pd, out["id"], {"zcreditPassword": "••••"})
        assert device_secrets(pd, out["id"])[0].ciphertext == before
        update(pd, out["id"], {"zcreditPassword": "new-one"})
        assert device_secrets(pd, out["id"])[0].ciphertext != before
        assert update(pd, out["id"], {"zcreditPassword": None})["secrets"]["zcreditPassword"]["set"] is False
        assert device_secrets(pd, out["id"]) == []

    def test_a_secret_the_kind_does_not_use_is_dropped(self, pd):
        out = create(pd, {**AGAMENTO, "zcreditPassword": PASSWORD, "synqpayApiKey": KEY})
        assert device_secrets(pd, out["id"]) == []
        z = create(pd, {**ZCREDIT, "nickname": "z2", "synqpayApiKey": KEY})
        assert [r.key for r in device_secrets(pd, z["id"])] == ["zcreditPassword"]

    def test_a_bad_secret_is_refused_without_echoing_it(self, pd):
        e = refused(create, pd, {**SYNQ, "synqpayApiKey": "bad key!"})
        assert (code_of(e), e.detail["field"]) == ("synqpay_key_invalid", "synqpayApiKey")
        assert "bad key!" not in json.dumps(e.detail)
        e = refused(create, pd, {**ZCREDIT, "zcreditPassword": "a\nb"})
        assert code_of(e) == "secret_invalid" and "a\nb" not in json.dumps(e.detail)
        e = refused(create, pd, {**ZCREDIT, "zcreditPassword": 12345})
        assert code_of(e) == "secret_invalid"
        assert pd.db.query(PaymentDevice).count() == 0

    def test_the_schema_never_prints_a_secret(self):
        parsed = body({**ZCREDIT, "synqpayApiKey": KEY})
        assert PASSWORD not in repr(parsed) and KEY not in repr(parsed)
        assert "zcreditPassword" not in parsed.model_dump(by_alias=True)


# ── Permissions ───────────────────────────────────────────────────────────────


class TestPermissions:
    def test_the_shops_managers_write_others_are_refused(self, pd):
        out = create(pd, AGAMENTO, user=pd.manager)
        assert create(pd, {**AGAMENTO, "nickname": "cm"}, user=pd.company_manager)["nickname"] == "cm"
        assert refused(create, pd, {**AGAMENTO, "nickname": "n"}, user=pd.north_manager).status_code == 403
        assert refused(create, pd, {**AGAMENTO, "nickname": "c"}, user=pd.cashier).status_code == 403
        assert refused(update, pd, out["id"], {"active": False}, user=pd.north_manager).status_code == 403
        assert refused(update, pd, out["id"], {"active": False}, user=pd.cashier).status_code == 403
        assert refused(delete, pd, out["id"], user=pd.north_manager).status_code == 403
        assert refused(listed, pd, user=pd.north_manager).status_code == 403
        assert device_row(pd, out["id"]).active is True

    def test_another_tenant_is_refused(self, pd):
        e = refused(R.list_payment_devices, pd.foreign_shop.id, **_ctx(pd))
        assert e.status_code in (403, 404)
        e = refused(R.create_payment_device, pd.foreign_shop.id, body(AGAMENTO), **_ctx(pd))
        assert e.status_code in (403, 404)

    def test_unknown_ids(self, pd):
        assert refused(update, pd, uuid.uuid4(), {"active": False}).status_code == 404
        assert refused(R.list_payment_devices, uuid.uuid4(), **_ctx(pd)).status_code == 404


# ── Settings keys ─────────────────────────────────────────────────────────────


class TestSettingsKeys:
    def test_managed_and_resettable(self):
        assert {"multiPaymentDevices", "defaultPaymentDeviceId"} <= set(MANAGED_SETTING_KEYS)
        assert {"multiPaymentDevices", "defaultPaymentDeviceId"} <= set(settings_router.TIP_RESETTABLE_KEYS)

    def test_the_switch_at_the_shop_and_the_till(self, pd):
        patch_shop(pd, multiPaymentDevices=True)
        assert pd.shop.settings["multiPaymentDevices"] is True
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is True
        patch_machine(pd, pd.tablet, multiPaymentDevices=False)
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is False
        assert pulled(pd, pd.f20).settings["multiPaymentDevices"] is True
        patch_machine(pd, pd.tablet, multiPaymentDevices=None)
        assert "multiPaymentDevices" not in (pd.tablet.settings or {})
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is True
        patch_shop(pd, multiPaymentDevices=None)
        assert "multiPaymentDevices" not in pulled(pd, pd.tablet).settings

    def test_the_default_device_is_a_device_of_that_shop(self, pd):
        mine = create(pd, AGAMENTO)
        theirs = create(pd, AGAMENTO, shop=pd.other_shop)
        patch_shop(pd, defaultPaymentDeviceId=mine["id"].upper())
        assert pd.shop.settings["defaultPaymentDeviceId"] == mine["id"]
        for value in (theirs["id"], str(uuid.uuid4())):
            e = refused(patch_shop, pd, defaultPaymentDeviceId=value)
            assert (e.status_code, code_of(e), e.detail["field"]) == (422, "payment_device_not_in_shop", "defaultPaymentDeviceId")
        patch_shop(pd, defaultPaymentDeviceId="")
        assert "defaultPaymentDeviceId" not in pd.shop.settings
        with pytest.raises(ValidationError):
            PosSettingsV1Patch(defaultPaymentDeviceId="not-an-id")

    def test_at_a_till_it_must_apply_to_the_till(self, pd):
        f20_only = create(pd, {**AGAMENTO, "machineIds": [str(pd.f20.id)]})
        everyone = create(pd, {**AGAMENTO, "nickname": "all"})
        e = refused(patch_machine, pd, pd.tablet, defaultPaymentDeviceId=f20_only["id"])
        assert code_of(e) == "payment_device_not_for_machine"
        patch_machine(pd, pd.tablet, defaultPaymentDeviceId=everyone["id"])
        patch_machine(pd, pd.f20, defaultPaymentDeviceId=f20_only["id"])
        assert pd.f20.settings["defaultPaymentDeviceId"] == f20_only["id"]
        e = refused(patch_machine, pd, pd.other_till, defaultPaymentDeviceId=everyone["id"])
        assert code_of(e) == "payment_device_not_in_shop"

    def test_at_an_area_a_device_of_its_shop(self, pd):
        out = create(pd, AGAMENTO)
        area = ShopArea(id=uuid.uuid4(), tenant_id=pd.tenant.id, shop_id=pd.shop.id, name="Bar")
        pd.db.add(area)
        pd.db.commit()
        settings_router.patch_area_settings(
            area_id=str(area.id), data=PosSettingsV1Patch(defaultPaymentDeviceId=out["id"]), **_ctx(pd)
        )
        assert pd.db.get(ShopArea, area.id).settings["defaultPaymentDeviceId"] == out["id"]

    def test_refused_above_the_shop(self, pd):
        out = create(pd, AGAMENTO)
        e = refused(
            settings_router.patch_company_settings,
            company_id=str(pd.company.id), data=PosSettingsV1Patch(defaultPaymentDeviceId=out["id"]), **_ctx(pd),
        )
        assert code_of(e) == "payment_device_level_invalid"
        e = refused(
            settings_router.patch_tenant_settings,
            tenant_id=str(pd.tenant.id), data=PosSettingsV1Patch(defaultPaymentDeviceId=out["id"]),
            current_user=pd.admin, db=pd.db,
        )
        assert code_of(e) == "payment_device_level_invalid"
        # The switch itself may be set there (the generic form).
        settings_router.patch_company_settings(
            company_id=str(pd.company.id), data=PosSettingsV1Patch(multiPaymentDevices=True), **_ctx(pd)
        )
        assert pd.company.settings["multiPaymentDevices"] is True

    def test_a_stored_value_round_trips_unchecked(self, pd):
        """The dialog sends the whole form: a value stored earlier must not block an unrelated save."""
        stale = create(pd, AGAMENTO, shop=pd.other_shop)
        pd.tablet.settings = {"defaultPaymentDeviceId": stale["id"]}
        pd.db.commit()
        patch_machine(pd, pd.tablet, defaultPaymentDeviceId=stale["id"], globalTaxRate=17)
        assert pd.tablet.settings["globalTaxRate"] == 17


# ── The till's sync ───────────────────────────────────────────────────────────


class TestTillSync:
    def test_nothing_without_devices(self, pd):
        settings = pulled(pd, pd.tablet).settings
        for key in ("paymentDevices", "paymentDeviceSecrets", "defaultPaymentDeviceId"):
            assert key not in settings

    def test_the_exact_contract(self, pd):
        z = create(pd, {**ZCREDIT, "sortOrder": 1, "config": {"pinpadId": "PINPAD123456", "mode": "production"}})
        a = create(pd, {"nickname": "Nayax", "kind": "agamento_lan", "sortOrder": 1,
                        "config": {"host": "192.168.1.20", "mac": "AA:BB:CC:DD:EE:FF", "terminalNumber": "1234567"}})
        s = create(pd, {**SYNQ, "active": False, "sortOrder": 0, "synqpayApiKey": KEY})
        settings = pulled(pd, pd.tablet).settings
        assert isinstance(settings["paymentDevices"], str)
        devices = json.loads(settings["paymentDevices"])
        # By sort order, then nickname; the inactive one included.
        assert [d["id"] for d in devices] == [s["id"], a["id"], z["id"]]
        assert devices[0] == {
            "id": s["id"], "nickname": "Synq", "kind": "synqpay", "active": False, "sortOrder": 0,
            "config": {"model": "dx8000", "connection": "lan", "host": "192.168.1.40", "protocol": "tcp", "tls": False},
        }
        assert devices[1] == {
            "id": a["id"], "nickname": "Nayax", "kind": "agamento_lan", "active": True, "sortOrder": 1,
            "config": {"host": "192.168.1.20", "port": 8080, "path": "/SPICy", "https": False,
                       "mac": "aa:bb:cc:dd:ee:ff", "terminalNumber": "1234567"},
        }
        assert devices[2] == {
            "id": z["id"], "nickname": "Z pinpad", "kind": "zcredit_pinpad", "active": True, "sortOrder": 1,
            "config": {"pinpadId": "123456", "mode": "production"},
        }
        assert isinstance(settings["paymentDeviceSecrets"], str)
        assert json.loads(settings["paymentDeviceSecrets"]) == {
            z["id"]: {"zcreditPassword": PASSWORD},
            s["id"]: {"synqpayApiKey": KEY},
        }
        # Hebrew stays readable (ensure_ascii=False).
        update(pd, a["id"], {"nickname": "מסופון בר"})
        assert "מסופון בר" in pulled(pd, pd.tablet).settings["paymentDevices"]

    def test_only_the_devices_that_apply_to_the_till(self, pd):
        everyone = create(pd, {**AGAMENTO, "nickname": "all"})
        f20_only = create(pd, {**AGAMENTO, "nickname": "f20", "machineIds": [str(pd.f20.id)]})
        create(pd, {**AGAMENTO, "nickname": "north"}, shop=pd.other_shop)
        ids = lambda till: [d["id"] for d in json.loads(pulled(pd, till).settings["paymentDevices"])]  # noqa: E731
        assert ids(pd.tablet) == [everyone["id"]]
        assert ids(pd.f20) == [everyone["id"], f20_only["id"]]
        assert len(ids(pd.other_till)) == 1

    def test_secrets_only_to_a_till_without_built_in_clearing(self, pd):
        create(pd, ZCREDIT)
        f20 = pulled(pd, pd.f20).settings
        assert "paymentDevices" in f20 and "paymentDeviceSecrets" not in f20
        assert PASSWORD not in json.dumps(f20, default=str)
        assert "paymentDeviceSecrets" in pulled(pd, pd.tablet).settings

    def test_a_kiosk_gets_nothing(self, pd):
        create(pd, ZCREDIT)
        as_kiosk(pd, pd.tablet)
        settings = pulled(pd, pd.tablet).settings
        assert "paymentDevices" not in settings and "paymentDeviceSecrets" not in settings

    def test_the_default_only_when_it_is_one_of_the_tills_devices(self, pd):
        everyone = create(pd, {**AGAMENTO, "nickname": "all"})
        f20_only = create(pd, {**AGAMENTO, "nickname": "f20", "machineIds": [str(pd.f20.id)]})
        patch_shop(pd, defaultPaymentDeviceId=f20_only["id"])
        assert pulled(pd, pd.f20).settings["defaultPaymentDeviceId"] == f20_only["id"]
        assert "defaultPaymentDeviceId" not in pulled(pd, pd.tablet).settings
        patch_machine(pd, pd.tablet, defaultPaymentDeviceId=everyone["id"])
        assert pulled(pd, pd.tablet).settings["defaultPaymentDeviceId"] == everyone["id"]

    def test_a_change_moves_the_watermark(self, pd):
        first = pulled(pd, pd.tablet)
        since = first.settings_updated_at.isoformat()
        assert pulled(pd, pd.tablet, since=since).sync_type == "unchanged"
        out = create(pd, ZCREDIT)
        after = pulled(pd, pd.tablet, since=since)
        assert after.sync_type == "delta" and "paymentDevices" in after.settings
        since = after.settings_updated_at.isoformat()
        assert pulled(pd, pd.tablet, since=since).sync_type == "unchanged"
        update(pd, out["id"], {"zcreditPassword": "changed"})
        again = pulled(pd, pd.tablet, since=since)
        assert again.sync_type == "delta"
        assert json.loads(again.settings["paymentDeviceSecrets"])[out["id"]]["zcreditPassword"] == "changed"
        since = again.settings_updated_at.isoformat()
        delete(pd, out["id"])
        gone = pulled(pd, pd.tablet, since=since)
        assert gone.sync_type == "delta" and "paymentDevices" not in gone.settings


# ── SynqPay pairing per device ────────────────────────────────────────────────


def pair(w, till, *, device_id=None, key=KEY, serial=SERIAL):
    data = {"synqpayApiKey": key, "serialNumber": serial}
    if device_id is not None:
        data["paymentDeviceId"] = str(device_id)
    return SR.store_synqpay_pairing(
        str(till.id), SynqpayPairingIn.model_validate(data), machine=till,
        actor=CatalogActor(pos_user_id=uuid.uuid4()), db=w.db,
    )


def reject(w, till, device_id=None):
    data = {"detail": "HTTP 401"}
    if device_id is not None:
        data["paymentDeviceId"] = str(device_id)
    return SR.report_synqpay_key_rejected(str(till.id), SynqpayKeyRejectedIn.model_validate(data), machine=till, db=w.db)


class TestSynqpayPairing:
    def test_the_key_goes_to_the_device_whatever_the_tills_integration(self, pd):
        s = create(pd, SYNQ)
        pd.shop.settings_updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        pd.db.commit()
        pd.shop_notified.clear()
        out = pair(pd, pd.tablet, device_id=s["id"])
        assert out["paymentDeviceId"] == s["id"] and out["origin"] == "till_pairing"
        assert KEY not in json.dumps(out, default=str)
        rows = device_secrets(pd, s["id"])
        assert [(r.key, r.origin, r.terminal_serial) for r in rows] == [("synqpayApiKey", "till_pairing", SERIAL)]
        assert rows[0].paired_by_machine_id == pd.tablet.id
        # Nothing on the till's own layer.
        assert pd.db.query(PaymentIntegrationSecret).filter(PaymentIntegrationSecret.level == "machine").count() == 0
        assert device_row(pd, s["id"]).config["serialNumber"] == SERIAL
        assert pd.shop_notified == [(str(pd.shop.id), PD.NOTIFY_REASON)]
        stamp = pd.shop.settings_updated_at
        assert (stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)) > datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert json.loads(pulled(pd, pd.tablet).settings["paymentDeviceSecrets"]) == {s["id"]: {"synqpayApiKey": KEY}}
        status = listed(pd)["devices"][0]["secrets"]["synqpayApiKey"]
        assert status["set"] is True and status["origin"] == "till_pairing" and status["terminalSerial"] == SERIAL

    def test_a_serial_already_set_is_kept(self, pd):
        s = create(pd, {**SYNQ, "config": {**SYNQ["config"], "serialNumber": "OWN-1234"}})
        pair(pd, pd.tablet, device_id=s["id"])
        assert device_row(pd, s["id"]).config["serialNumber"] == "OWN-1234"

    def test_the_device_must_be_the_tills_synqpay(self, pd):
        theirs = create(pd, SYNQ, shop=pd.other_shop)
        e = refused(pair, pd, pd.tablet, device_id=theirs["id"])
        assert (e.status_code, code_of(e)) == (404, "payment_device_not_found")
        e = refused(pair, pd, pd.tablet, device_id=uuid.uuid4())
        assert (e.status_code, code_of(e)) == (404, "payment_device_not_found")
        nayax = create(pd, AGAMENTO)
        e = refused(pair, pd, pd.tablet, device_id=nayax["id"])
        assert (e.status_code, code_of(e)) == (409, "payment_device_not_synqpay")
        f20_only = create(pd, {**SYNQ, "nickname": "f20", "machineIds": [str(pd.f20.id)]})
        e = refused(pair, pd, pd.tablet, device_id=f20_only["id"])
        assert (e.status_code, code_of(e)) == (409, "payment_device_not_for_machine")
        e = refused(pair, pd, pd.tablet, device_id=f20_only["id"], key="bad key")
        assert code_of(e) == "secret_invalid"
        assert device_secrets(pd, f20_only["id"]) == []

    def test_without_a_device_nothing_changes(self, pd):
        create(pd, SYNQ)
        e = refused(pair, pd, pd.tablet)
        assert (e.status_code, e.detail["code"]) == (409, "not_synqpay")

    def test_the_rejection_is_marked_on_the_device(self, pd):
        s = create(pd, SYNQ)
        assert reject(pd, pd.tablet, s["id"])["recorded"] is False
        pair(pd, pd.tablet, device_id=s["id"])
        first = reject(pd, pd.tablet, s["id"])
        assert first["recorded"] is True and first["paymentDeviceId"] == s["id"]
        again = reject(pd, pd.tablet, s["id"])
        assert again["rejectedAt"] == first["rejectedAt"]
        status = listed(pd)["devices"][0]["secrets"]["synqpayApiKey"]
        assert status["rejectedAt"] is not None and status["rejectedByMachineId"] == str(pd.tablet.id)
        # A new pairing clears it.
        pair(pd, pd.tablet, device_id=s["id"], key="99zz")
        assert listed(pd)["devices"][0]["secrets"]["synqpayApiKey"]["rejectedAt"] is None
        theirs = create(pd, SYNQ, shop=pd.other_shop)
        assert refused(reject, pd, pd.tablet, theirs["id"]).status_code == 404


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    REVISION = "7d2e4b9f1a63"

    def test_a_unique_revision_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).absolute().parents[1]
        versions = root / "alembic" / "versions"
        declaring = [
            p.name for p in versions.glob("*.py")
            if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{self.REVISION}['\"]", p.read_text(encoding="utf-8"), re.M)
        ]
        assert declaring == [f"{self.REVISION}_payment_devices.py"]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert self.REVISION in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision(self.REVISION).down_revision == "a6d2f8c4e0b7"

    def test_idempotent_create(self):
        text = (pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions"
                / f"{self.REVISION}_payment_devices.py").read_text(encoding="utf-8")
        assert "has_table(TABLE)" in text and "uq_payment_devices_shop_nickname" in text
        assert "ck_payment_devices_kind" in text
