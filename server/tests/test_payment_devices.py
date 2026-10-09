"""
"מכשירי תשלום" — several card terminals for a till without one of its own
(app/services/payment_devices.py, app/routers/payment_devices.py).

What each class pins:

* **Config** — each kind keeps exactly its fields, normalised as the till reads them (defaults
  filled in, empty values left out), and refuses a bad one with a machine-readable code and the
  field; an address typed as a URL is split. A Z-Credit pinpad is its PinPad only: the terminal
  number, mode and password are the branch's (dropped when sent).
* **CRUD** — nickname rules (trimmed, 1–40, unique in the shop whatever its case), sort order,
  partial PUT, a kind change, several devices on one terminal number, deletion clearing every
  fixed device / group naming it, deactivation clearing nothing, the shop's stamp moved and its
  tills told.
* **Secrets** — SynqPay's key only: write-only (mask keeps, null removes), encrypted apart,
  dropped for another kind, never in any dashboard answer.
* **Permissions** — the shop's managers; another shop's manager and a cashier are refused.
* **The till's device choice** — `paymentDeviceMode` / `fixedPaymentDeviceId` /
  `paymentDeviceGroup` on the shop, an area, a till; devices of that shop only; a "fixed" mode
  needs its device (its own or from above); refused on a tenant / company / kiosk; checked only
  when it changes; the per-till summary on the dashboard.
* **The till's sync** — the exact contract: JSON strings (the group too), all the shop's
  devices, the mode / fixed / group as merged, the terminal number unguarded, secrets only to a
  till without built-in clearing, nothing to a kiosk, and a watermark that moves.
* **SynqPay pairing per device** — the key stored on the device with its audit, the checks, the
  rejection report; without `paymentDeviceId` nothing changes.
* **The migrations** — unique revisions on the single head.

Runs on the in-memory SQLite world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from datetime import datetime, timezone
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
from app.services import payment_secrets as PS
from app.services import settings_notify
from app.services.settings_merge import MANAGED_SETTING_KEYS
from test_shop_areas import _ctx, refused, w  # noqa: F401

KEY = "1234abcd"
SERIAL = "244RKR528387"

AGAMENTO = {"nickname": "Nayax bar", "kind": "agamento_lan", "config": {"host": "192.168.1.20"}}
ZCREDIT = {"nickname": "Z pinpad", "kind": "zcredit_pinpad", "config": {"pinpadId": "PINPAD123456"}}
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


def patch_area(w, area, **data):
    return settings_router.patch_area_settings(area_id=str(area.id), data=PosSettingsV1Patch(**data), **_ctx(w))


def new_area(w, till=None):
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name=f"Area {uuid.uuid4().hex[:4]}")
    w.db.add(area)
    w.db.flush()
    if till is not None:
        till.area_id = area.id
    w.db.commit()
    return area


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

    def test_zcredit_is_its_pinpad_only(self):
        assert PD.clean_config("zcredit_pinpad", {"pinpadId": "PINPAD123456"}) == {"pinpadId": "123456"}
        # The terminal number, mode (even a bad one) and anything else are the branch's: dropped.
        assert PD.clean_config(
            "zcredit_pinpad", {"pinpadId": "abc9", "terminalNumber": "0882123", "mode": "nonsense", "host": "x"}
        ) == {"pinpadId": "abc9"}
        assert PD.till_config("zcredit_pinpad", {"pinpadId": "abc9", "terminalNumber": "1", "mode": "test"}) == {
            "pinpadId": "abc9"
        }

    @pytest.mark.parametrize("raw,code", [
        ({}, "pinpad_required"),
        ({"pinpadId": "PINPAD"}, "pinpad_invalid"),
        ({"pinpadId": "12-3"}, "pinpad_invalid"),
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
            "id", "nickname", "kind", "active", "sortOrder", "config", "shopId", "createdAt", "updatedAt", "secrets",
        }
        assert out["nickname"] == "Nayax bar" and out["kind"] == "agamento_lan"
        assert out["active"] is True and out["sortOrder"] == 0
        assert out["config"] == {"host": "192.168.1.20", "port": 8080, "path": "/SPICy", "https": False}
        assert out["shopId"] == str(pd.shop.id)
        assert set(out["secrets"]) == {"synqpayApiKey"} and out["secrets"]["synqpayApiKey"]["set"] is False
        row = device_row(pd, out["id"])
        assert row.tenant_id == pd.tenant.id and row.shop_id == pd.shop.id

    def test_the_tills_and_a_pinpads_password_are_not_the_devices(self, pd):
        """`machineIds`, `zcreditPassword` (and a pinpad's number / mode) sent are ignored."""
        out = create(pd, {
            **ZCREDIT, "machineIds": [str(pd.tablet.id)], "zcreditPassword": "pw",
            "config": {"pinpadId": "PINPAD1", "terminalNumber": "0882", "mode": "test"},
        })
        assert "machineIds" not in out and out["config"] == {"pinpadId": "1"}
        assert device_secrets(pd, out["id"]) == []
        assert not hasattr(device_row(pd, out["id"]), "machine_ids")

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

    def test_several_devices_share_one_terminal_number(self, pd):
        """"כל המכשירים יכולים להיות עם אותו מספר מסוף": nothing is unique about it."""
        a = create(pd, {**AGAMENTO, "config": {"host": "10.0.0.1", "terminalNumber": "1234567"}})
        b = create(pd, {**AGAMENTO, "nickname": "Nayax 2", "config": {"host": "10.0.0.2", "terminalNumber": "1234567"}})
        s = create(pd, {**SYNQ, "config": {**SYNQ["config"], "terminalNumber": "1234567"}})
        assert {d["config"]["terminalNumber"] for d in (a, b, s)} == {"1234567"}
        assert update(pd, b["id"], {"config": {"host": "10.0.0.3", "terminalNumber": "1234567"}})["config"]["host"] == "10.0.0.3"
        devices = json.loads(pulled(pd, pd.tablet).settings["paymentDevices"])
        assert [d["config"].get("terminalNumber") for d in devices] == ["1234567"] * 3

    def test_sort_order_and_active(self, pd):
        assert create(pd, {**AGAMENTO, "sortOrder": 9999, "active": False})["sortOrder"] == 9999
        for value in (-1, 10000, True, "x", 1.5):
            e = refused(create, pd, {**AGAMENTO, "nickname": "n", "sortOrder": value})
            assert code_of(e) == "sort_order_invalid"
        e = refused(create, pd, {**AGAMENTO, "nickname": "n", "active": "yes"})
        assert code_of(e) == "active_invalid"

    def test_put_changes_only_what_it_sends(self, pd):
        out = create(pd, {**AGAMENTO, "sortOrder": 3})
        again = update(pd, out["id"], {"active": False})
        assert again["active"] is False
        assert (again["nickname"], again["config"], again["sortOrder"]) == (out["nickname"], out["config"], 3)
        again = update(pd, out["id"], {"config": {"host": "10.0.0.7", "port": 8090}})
        assert again["config"] == {"host": "10.0.0.7", "port": 8090, "path": "/SPICy", "https": False}

    def test_a_kind_change_validates_the_new_kind_and_drops_the_old_secret(self, pd):
        out = create(pd, {**SYNQ, "synqpayApiKey": KEY})
        assert len(device_secrets(pd, out["id"])) == 1
        e = refused(update, pd, out["id"], {"kind": "agamento_lan"})
        assert (code_of(e), e.detail["field"]) == ("host_required", "config.host")
        assert device_row(pd, out["id"]).kind == "synqpay"
        again = update(pd, out["id"], {"kind": "agamento_lan", "config": {"host": "10.0.0.8"}})
        assert again["kind"] == "agamento_lan" and again["config"]["host"] == "10.0.0.8"
        assert device_secrets(pd, out["id"]) == []
        assert again["secrets"]["synqpayApiKey"]["set"] is False

    def test_delete_clears_every_fixed_device_and_group_naming_it(self, pd):
        keep = create(pd, {**AGAMENTO, "nickname": "keep"})
        gone = create(pd, ZCREDIT)
        area = new_area(pd)
        area.settings = {"paymentDeviceGroup": [gone["id"]], "paymentDeviceMode": "group"}
        pd.shop.settings = {
            "multiPaymentDevices": True, "paymentDeviceMode": "fixed", "fixedPaymentDeviceId": gone["id"],
            "paymentDeviceGroup": [keep["id"], gone["id"]],
        }
        pd.tablet.settings = {"fixedPaymentDeviceId": gone["id"], "paymentDeviceMode": "fixed", "globalTaxRate": 17}
        pd.f20.settings = {"fixedPaymentDeviceId": keep["id"], "paymentDeviceMode": "fixed"}
        pd.other_till.settings = {"paymentDeviceGroup": [gone["id"]]}  # another shop's till: untouched
        pd.db.commit()
        assert delete(pd, gone["id"]).status_code == 204
        pd.db.expire_all()
        assert device_row(pd, gone["id"]) is None
        assert device_secrets(pd, gone["id"]) == []
        # The fixed device and its "fixed" mode go; the group keeps the others.
        assert pd.shop.settings == {"multiPaymentDevices": True, "paymentDeviceGroup": [keep["id"]]}
        # A group left empty is removed (the layer inherits again), not "every device".
        assert pd.db.get(ShopArea, area.id).settings == {"paymentDeviceMode": "group"}
        assert pd.db.get(ShopArea, area.id).settings_updated_at is not None
        assert pd.tablet.settings == {"globalTaxRate": 17}
        assert pd.tablet.settings_updated_at is not None
        assert pd.f20.settings == {"fixedPaymentDeviceId": keep["id"], "paymentDeviceMode": "fixed"}
        assert pd.other_till.settings == {"paymentDeviceGroup": [gone["id"]]}
        assert [d["id"] for d in listed(pd)["devices"]] == [keep["id"]]
        assert refused(delete, pd, gone["id"]).status_code == 404

    def test_deactivating_clears_nothing(self, pd):
        out = create(pd, AGAMENTO)
        patch_shop(pd, paymentDeviceMode="fixed", fixedPaymentDeviceId=out["id"])
        update(pd, out["id"], {"active": False})
        pd.db.expire_all()
        assert pd.shop.settings["fixedPaymentDeviceId"] == out["id"]
        settings = pulled(pd, pd.tablet).settings
        assert settings["fixedPaymentDeviceId"] == out["id"]
        assert json.loads(settings["paymentDevices"])[0]["active"] is False

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
        out = create(pd, SYNQ)
        assert moved()
        reset()
        update(pd, out["id"], {"synqpayApiKey": "another1"})
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
        assert (page["paymentDeviceMode"], page["fixedPaymentDeviceId"], page["paymentDeviceGroup"]) == (None, None, None)
        assert page["canEdit"] is True
        machines = {m["id"]: m for m in page["machines"]}
        assert set(machines) == {str(pd.tablet.id), str(pd.f20.id)}
        assert machines[str(pd.tablet.id)]["hasBuiltinTerminal"] is False
        assert machines[str(pd.f20.id)]["hasBuiltinTerminal"] is True
        assert {k["value"] for k in page["kinds"]} == {"zcredit_pinpad", "synqpay", "agamento_lan"}
        as_kiosk(pd, pd.f20)
        assert [m["id"] for m in listed(pd)["machines"]] == [str(pd.tablet.id)]

    def test_the_tills_own_view_is_its_shops_devices(self, pd):
        a = create(pd, {**AGAMENTO, "nickname": "a"})
        b = create(pd, {**AGAMENTO, "nickname": "b", "active": False})
        create(pd, {**AGAMENTO, "nickname": "north"}, shop=pd.other_shop)
        out = R.machine_payment_devices(pd.tablet.id, **_ctx(pd))
        assert out["shopId"] == str(pd.shop.id)
        assert out["hasBuiltinTerminal"] is False and out["isKiosk"] is False
        assert [d["id"] for d in out["devices"]] == [a["id"], b["id"]]
        as_kiosk(pd, pd.tablet)
        out = R.machine_payment_devices(pd.tablet.id, **_ctx(pd))
        assert out["isKiosk"] is True and out["devices"] == []


# ── Secrets ───────────────────────────────────────────────────────────────────


class TestSecrets:
    def test_stored_encrypted_and_never_answered(self, pd):
        out = create(pd, {**SYNQ, "synqpayApiKey": KEY})
        assert out["secrets"]["synqpayApiKey"]["set"] is True
        rows = device_secrets(pd, out["id"])
        assert [(r.key, r.level, r.origin) for r in rows] == [("synqpayApiKey", "payment_device", "dashboard")]
        assert KEY not in rows[0].ciphertext
        for answer in (out, listed(pd), R.machine_payment_devices(pd.tablet.id, **_ctx(pd))):
            assert KEY not in json.dumps(answer, default=str)

    def test_mask_keeps_null_removes_value_replaces(self, pd):
        out = create(pd, {**SYNQ, "synqpayApiKey": KEY})
        before = device_secrets(pd, out["id"])[0].ciphertext
        update(pd, out["id"], {"synqpayApiKey": "••••"})
        assert device_secrets(pd, out["id"])[0].ciphertext == before
        update(pd, out["id"], {"synqpayApiKey": "newone99"})
        assert device_secrets(pd, out["id"])[0].ciphertext != before
        assert update(pd, out["id"], {"synqpayApiKey": None})["secrets"]["synqpayApiKey"]["set"] is False
        assert device_secrets(pd, out["id"]) == []

    def test_a_secret_the_kind_does_not_use_is_dropped(self, pd):
        assert device_secrets(pd, create(pd, {**AGAMENTO, "synqpayApiKey": KEY})["id"]) == []
        assert device_secrets(pd, create(pd, {**ZCREDIT, "synqpayApiKey": KEY})["id"]) == []

    def test_a_pinpads_old_password_is_never_sent_and_goes_on_its_next_save(self, pd):
        out = create(pd, ZCREDIT)
        row = PaymentIntegrationSecret(
            id=uuid.uuid4(), level="payment_device", entity_id=uuid.UUID(out["id"]), key="zcreditPassword",
            ciphertext=PS.encrypt("old-pw"), tenant_id=pd.tenant.id,
        )
        pd.db.add(row)
        pd.db.commit()
        assert "paymentDeviceSecrets" not in pulled(pd, pd.tablet).settings
        assert "old-pw" not in json.dumps(listed(pd), default=str)
        update(pd, out["id"], {"active": True})
        assert device_secrets(pd, out["id"]) == []

    def test_a_bad_secret_is_refused_without_echoing_it(self, pd):
        e = refused(create, pd, {**SYNQ, "synqpayApiKey": "bad key!"})
        assert (code_of(e), e.detail["field"]) == ("synqpay_key_invalid", "synqpayApiKey")
        assert "bad key!" not in json.dumps(e.detail)
        e = refused(create, pd, {**SYNQ, "synqpayApiKey": "a\nb"})
        assert code_of(e) == "secret_invalid" and "a\nb" not in json.dumps(e.detail)
        e = refused(create, pd, {**SYNQ, "synqpayApiKey": 12345})
        assert code_of(e) == "secret_invalid"
        assert pd.db.query(PaymentDevice).count() == 0

    def test_the_schema_never_prints_a_secret(self):
        parsed = body({**SYNQ, "synqpayApiKey": KEY})
        assert KEY not in repr(parsed)
        assert "synqpayApiKey" not in parsed.model_dump(by_alias=True)


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


# ── The till's device choice (settings keys) ──────────────────────────────────


class TestDeviceChoice:
    def test_managed_and_resettable(self):
        keys = {"multiPaymentDevices", "paymentDeviceMode", "fixedPaymentDeviceId", "paymentDeviceGroup"}
        assert keys <= set(MANAGED_SETTING_KEYS)
        assert keys <= set(settings_router.TIP_RESETTABLE_KEYS)
        assert "defaultPaymentDeviceId" not in MANAGED_SETTING_KEYS
        # An old client's default device is ignored, not stored.
        assert "defaultPaymentDeviceId" not in PosSettingsV1Patch(defaultPaymentDeviceId=str(uuid.uuid4())).model_dump(by_alias=True, exclude_unset=True)

    def test_the_switch_at_the_shop_and_the_till(self, pd):
        create(pd, AGAMENTO)
        patch_shop(pd, multiPaymentDevices=True)
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is True
        patch_machine(pd, pd.tablet, multiPaymentDevices=False)
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is False
        assert pulled(pd, pd.f20).settings["multiPaymentDevices"] is True
        patch_machine(pd, pd.tablet, multiPaymentDevices=None)
        assert "multiPaymentDevices" not in (pd.tablet.settings or {})
        assert pulled(pd, pd.tablet).settings["multiPaymentDevices"] is True

    def test_shop_default_and_till_override(self, pd):
        a = create(pd, {**AGAMENTO, "nickname": "a"})
        b = create(pd, {**AGAMENTO, "nickname": "b"})
        patch_shop(pd, paymentDeviceMode="group", paymentDeviceGroup=[b["id"].upper(), a["id"], b["id"]])
        assert pd.shop.settings["paymentDeviceGroup"] == [b["id"], a["id"]]
        patch_machine(pd, pd.tablet, paymentDeviceMode="fixed", fixedPaymentDeviceId=a["id"])
        tablet = pulled(pd, pd.tablet).settings
        f20 = pulled(pd, pd.f20).settings
        assert (tablet["paymentDeviceMode"], tablet["fixedPaymentDeviceId"]) == ("fixed", a["id"])
        assert f20["paymentDeviceMode"] == "group" and json.loads(f20["paymentDeviceGroup"]) == [b["id"], a["id"]]
        # Back to the shop's.
        patch_machine(pd, pd.tablet, paymentDeviceMode=None, fixedPaymentDeviceId=None)
        assert pulled(pd, pd.tablet).settings["paymentDeviceMode"] == "group"
        # `[]` on a till: every device of the shop, over the shop's group.
        patch_machine(pd, pd.f20, paymentDeviceGroup=[])
        assert pd.f20.settings["paymentDeviceGroup"] == []
        assert "paymentDeviceGroup" not in pulled(pd, pd.f20).settings

    def test_only_devices_of_that_shop(self, pd):
        mine = create(pd, AGAMENTO)
        theirs = create(pd, AGAMENTO, shop=pd.other_shop)
        for data, field in (
            ({"fixedPaymentDeviceId": theirs["id"]}, "fixedPaymentDeviceId"),
            ({"fixedPaymentDeviceId": str(uuid.uuid4())}, "fixedPaymentDeviceId"),
            ({"paymentDeviceGroup": [mine["id"], theirs["id"]]}, "paymentDeviceGroup"),
        ):
            e = refused(patch_shop, pd, **data)
            assert (e.status_code, code_of(e), e.detail["field"]) == (422, "payment_device_not_in_shop", field)
            e = refused(patch_machine, pd, pd.tablet, **data)
            assert code_of(e) == "payment_device_not_in_shop"
        e = refused(patch_machine, pd, pd.other_till, fixedPaymentDeviceId=mine["id"])
        assert code_of(e) == "payment_device_not_in_shop"
        with pytest.raises(ValidationError):
            PosSettingsV1Patch(paymentDeviceGroup=["not-an-id"])
        with pytest.raises(ValidationError):
            PosSettingsV1Patch(paymentDeviceMode="default")
        with pytest.raises(ValidationError):
            PosSettingsV1Patch(fixedPaymentDeviceId="nope")

    def test_a_fixed_mode_needs_its_device(self, pd):
        a = create(pd, AGAMENTO)
        e = refused(patch_shop, pd, paymentDeviceMode="fixed")
        assert (code_of(e), e.detail["field"]) == ("fixed_payment_device_required", "fixedPaymentDeviceId")
        e = refused(patch_machine, pd, pd.tablet, paymentDeviceMode="fixed")
        assert code_of(e) == "fixed_payment_device_required"
        # A till may take the shop's fixed device; an area's counts too.
        patch_shop(pd, fixedPaymentDeviceId=a["id"])
        patch_machine(pd, pd.tablet, paymentDeviceMode="fixed")
        assert pulled(pd, pd.tablet).settings["fixedPaymentDeviceId"] == a["id"]
        area = new_area(pd, pd.f20)
        patch_area(pd, area, paymentDeviceMode="fixed")
        assert pulled(pd, pd.f20).settings["paymentDeviceMode"] == "fixed"
        # Removing the own device under an own "fixed" mode, with none above, is refused.
        patch_machine(pd, pd.other_till, multiPaymentDevices=True)  # another shop: nothing above
        b = create(pd, AGAMENTO, shop=pd.other_shop)
        patch_machine(pd, pd.other_till, paymentDeviceMode="fixed", fixedPaymentDeviceId=b["id"])
        e = refused(patch_machine, pd, pd.other_till, fixedPaymentDeviceId=None)
        assert code_of(e) == "fixed_payment_device_required"

    def test_refused_above_the_shop_and_on_a_kiosk(self, pd):
        out = create(pd, AGAMENTO)
        for data in ({"fixedPaymentDeviceId": out["id"]}, {"paymentDeviceMode": "group"}, {"paymentDeviceGroup": [out["id"]]}):
            e = refused(
                settings_router.patch_company_settings,
                company_id=str(pd.company.id), data=PosSettingsV1Patch(**data), **_ctx(pd),
            )
            assert code_of(e) == "payment_device_level_invalid"
            e = refused(
                settings_router.patch_tenant_settings,
                tenant_id=str(pd.tenant.id), data=PosSettingsV1Patch(**data), current_user=pd.admin, db=pd.db,
            )
            assert code_of(e) == "payment_device_level_invalid"
        # The switch itself may be set there (the generic form).
        settings_router.patch_company_settings(
            company_id=str(pd.company.id), data=PosSettingsV1Patch(multiPaymentDevices=True), **_ctx(pd)
        )
        as_kiosk(pd, pd.f20)
        e = refused(patch_machine, pd, pd.f20, paymentDeviceMode="group")
        assert code_of(e) == "payment_device_kiosk"

    def test_a_stored_value_round_trips_unchecked(self, pd):
        """The dialog sends the whole form: a value stored earlier must not block an unrelated save."""
        stale = create(pd, AGAMENTO, shop=pd.other_shop)
        pd.tablet.settings = {"paymentDeviceMode": "fixed", "fixedPaymentDeviceId": stale["id"], "paymentDeviceGroup": [stale["id"]]}
        pd.db.commit()
        patch_machine(
            pd, pd.tablet, paymentDeviceMode="fixed", fixedPaymentDeviceId=stale["id"],
            paymentDeviceGroup=[stale["id"]], globalTaxRate=17,
        )
        assert pd.tablet.settings["globalTaxRate"] == 17

    def test_the_per_till_summary(self, pd):
        a = create(pd, {**AGAMENTO, "nickname": "a"})
        b = create(pd, {**AGAMENTO, "nickname": "b"})
        patch_shop(pd, multiPaymentDevices=True, paymentDeviceMode="group", paymentDeviceGroup=[b["id"]])
        patch_machine(pd, pd.tablet, paymentDeviceMode="fixed", fixedPaymentDeviceId=a["id"])
        machines = {m["id"]: m for m in listed(pd)["machines"]}
        tablet, f20 = machines[str(pd.tablet.id)], machines[str(pd.f20.id)]
        assert tablet["choice"] == {"enabled": True, "mode": "fixed", "fixedDeviceId": a["id"], "groupDeviceIds": [b["id"]]}
        assert tablet["ownChoice"] is True
        assert f20["choice"] == {"enabled": True, "mode": "group", "fixedDeviceId": None, "groupDeviceIds": [b["id"]]}
        assert f20["ownChoice"] is False and f20["hasBuiltinTerminal"] is True
        page = listed(pd)
        assert (page["paymentDeviceMode"], page["paymentDeviceGroup"]) == ("group", [b["id"]])
        # Nothing set: a group of every device.
        assert PD.till_choice({}, [a["id"]]) == {"enabled": False, "mode": "group", "fixedDeviceId": None, "groupDeviceIds": None}


# ── The till's sync ───────────────────────────────────────────────────────────


class TestTillSync:
    def test_nothing_without_devices(self, pd):
        patch_shop(pd, expectedTerminalNumber="1234567")
        settings = pulled(pd, pd.tablet).settings
        for key in ("paymentDevices", "paymentDeviceSecrets", "paymentDeviceMode", "fixedPaymentDeviceId",
                    "paymentDeviceGroup", "paymentDevicesTerminalNumber", "defaultPaymentDeviceId"):
            assert key not in settings

    def test_the_exact_contract(self, pd):
        z = create(pd, {**ZCREDIT, "sortOrder": 1})
        a = create(pd, {"nickname": "Nayax", "kind": "agamento_lan", "sortOrder": 1,
                        "config": {"host": "192.168.1.20", "mac": "AA:BB:CC:DD:EE:FF", "terminalNumber": "1234567"}})
        s = create(pd, {**SYNQ, "active": False, "sortOrder": 0, "synqpayApiKey": KEY})
        create(pd, {**AGAMENTO, "nickname": "north"}, shop=pd.other_shop)
        patch_shop(pd, paymentDeviceMode="group", paymentDeviceGroup=[z["id"], a["id"]])
        settings = pulled(pd, pd.tablet).settings
        assert isinstance(settings["paymentDevices"], str)
        devices = json.loads(settings["paymentDevices"])
        # All the shop's, by sort order then nickname; the inactive one included.
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
            "config": {"pinpadId": "123456"},
        }
        assert json.loads(settings["paymentDeviceSecrets"]) == {s["id"]: {"synqpayApiKey": KEY}}
        assert settings["paymentDeviceMode"] == "group"
        assert isinstance(settings["paymentDeviceGroup"], str)
        assert json.loads(settings["paymentDeviceGroup"]) == [z["id"], a["id"]]
        assert "fixedPaymentDeviceId" not in settings
        # Hebrew stays readable (ensure_ascii=False).
        update(pd, a["id"], {"nickname": "מסופון בר"})
        assert "מסופון בר" in pulled(pd, pd.tablet).settings["paymentDevices"]

    def test_mode_fixed_and_group_as_merged(self, pd):
        a = create(pd, {**AGAMENTO, "nickname": "a"})
        b = create(pd, {**AGAMENTO, "nickname": "b"})
        settings = pulled(pd, pd.tablet).settings
        # Nothing set: no mode, no group (a group of all), no fixed device.
        assert "paymentDeviceMode" not in settings and "paymentDeviceGroup" not in settings
        patch_shop(pd, paymentDeviceMode="fixed", fixedPaymentDeviceId=b["id"])
        settings = pulled(pd, pd.tablet).settings
        assert (settings["paymentDeviceMode"], settings["fixedPaymentDeviceId"]) == ("fixed", b["id"])
        # A fixed device or group naming what is not the shop's device is left out / filtered.
        pd.shop.settings = {**pd.shop.settings, "fixedPaymentDeviceId": str(uuid.uuid4()),
                            "paymentDeviceGroup": [str(uuid.uuid4()), a["id"]]}
        pd.db.commit()
        settings = pulled(pd, pd.tablet).settings
        assert "fixedPaymentDeviceId" not in settings
        assert json.loads(settings["paymentDeviceGroup"]) == [a["id"]]
        pd.shop.settings = {**pd.shop.settings, "paymentDeviceGroup": [str(uuid.uuid4())]}
        pd.db.commit()
        assert "paymentDeviceGroup" not in pulled(pd, pd.tablet).settings

    def test_the_terminal_number_is_merged_and_unguarded(self, pd):
        create(pd, AGAMENTO)
        patch_shop(pd, expectedTerminalNumber="1234567")
        tablet = pulled(pd, pd.tablet).settings
        # The guard keeps an inherited number off a tablet's terminal config…
        assert "expectedTerminalNumber" not in tablet
        # …but the devices' card lock reads it.
        assert tablet["paymentDevicesTerminalNumber"] == "1234567"
        assert pulled(pd, pd.f20).settings["expectedTerminalNumber"] == "1234567"
        assert pulled(pd, pd.f20).settings["paymentDevicesTerminalNumber"] == "1234567"
        # The deepest layer wins; "" at a layer means no number there.
        patch_machine(pd, pd.tablet, expectedTerminalNumber="7654321")
        assert pulled(pd, pd.tablet).settings["paymentDevicesTerminalNumber"] == "7654321"
        patch_machine(pd, pd.tablet, expectedTerminalNumber="")
        assert "paymentDevicesTerminalNumber" not in pulled(pd, pd.tablet).settings

    def test_secrets_only_to_a_till_without_built_in_clearing(self, pd):
        create(pd, {**SYNQ, "synqpayApiKey": KEY})
        f20 = pulled(pd, pd.f20).settings
        assert "paymentDevices" in f20 and "paymentDeviceSecrets" not in f20
        assert KEY not in json.dumps(f20, default=str)
        assert "paymentDeviceSecrets" in pulled(pd, pd.tablet).settings

    def test_a_kiosk_gets_nothing(self, pd):
        a = create(pd, {**SYNQ, "synqpayApiKey": KEY})
        patch_shop(pd, paymentDeviceMode="fixed", fixedPaymentDeviceId=a["id"], expectedTerminalNumber="1")
        as_kiosk(pd, pd.tablet)
        settings = pulled(pd, pd.tablet).settings
        for key in ("paymentDevices", "paymentDeviceSecrets", "paymentDeviceMode", "fixedPaymentDeviceId",
                    "paymentDeviceGroup", "paymentDevicesTerminalNumber"):
            assert key not in settings

    def test_a_change_moves_the_watermark(self, pd):
        first = pulled(pd, pd.tablet)
        since = first.settings_updated_at.isoformat()
        assert pulled(pd, pd.tablet, since=since).sync_type == "unchanged"
        out = create(pd, SYNQ)
        after = pulled(pd, pd.tablet, since=since)
        assert after.sync_type == "delta" and "paymentDevices" in after.settings
        since = after.settings_updated_at.isoformat()
        assert pulled(pd, pd.tablet, since=since).sync_type == "unchanged"
        update(pd, out["id"], {"synqpayApiKey": "changed1"})
        again = pulled(pd, pd.tablet, since=since)
        assert again.sync_type == "delta"
        assert json.loads(again.settings["paymentDeviceSecrets"])[out["id"]]["synqpayApiKey"] == "changed1"
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

    def test_the_device_must_be_the_shops_synqpay(self, pd):
        theirs = create(pd, SYNQ, shop=pd.other_shop)
        e = refused(pair, pd, pd.tablet, device_id=theirs["id"])
        assert (e.status_code, code_of(e)) == (404, "payment_device_not_found")
        e = refused(pair, pd, pd.tablet, device_id=uuid.uuid4())
        assert (e.status_code, code_of(e)) == (404, "payment_device_not_found")
        nayax = create(pd, AGAMENTO)
        e = refused(pair, pd, pd.tablet, device_id=nayax["id"])
        assert (e.status_code, code_of(e)) == (409, "payment_device_not_synqpay")
        mine = create(pd, {**SYNQ, "nickname": "mine"})
        e = refused(pair, pd, pd.tablet, device_id=mine["id"], key="bad key")
        assert code_of(e) == "secret_invalid"
        assert device_secrets(pd, mine["id"]) == []

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


# ── The migrations ────────────────────────────────────────────────────────────


VERSIONS = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions"


def _declaring(revision: str):
    return [
        p.name for p in VERSIONS.glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]


class TestMigrations:
    TABLE = "7d2e4b9f1a63"
    CHOICE = "3b8f6d2a9c41"

    def test_unique_revisions_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        assert _declaring(self.TABLE) == [f"{self.TABLE}_payment_devices.py"]
        assert _declaring(self.CHOICE) == [f"{self.CHOICE}_payment_device_choice.py"]
        root = VERSIONS.parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        line = {r.revision for r in script.walk_revisions("base", heads[0])}
        assert {self.TABLE, self.CHOICE} <= line
        assert script.get_revision(self.TABLE).down_revision == "a6d2f8c4e0b7"
        # After main's kiosk motion engine (b3e7c1a9d5f2), itself on 7d2e4b9f1a63: one line.
        assert script.get_revision(self.CHOICE).down_revision == "b3e7c1a9d5f2"
        assert script.get_revision("b3e7c1a9d5f2").down_revision == self.TABLE

    def test_idempotent_create(self):
        text = (VERSIONS / f"{self.TABLE}_payment_devices.py").read_text(encoding="utf-8")
        assert "has_table(TABLE)" in text and "uq_payment_devices_shop_nickname" in text
        assert "ck_payment_devices_kind" in text

    def test_the_choice_migration_does_what_the_owner_decided(self):
        text = (VERSIONS / f"{self.CHOICE}_payment_device_choice.py").read_text(encoding="utf-8")
        # Looks before it writes.
        assert "has_table" in text and "'machine_ids' in columns" in text
        assert "drop_column(TABLE, 'machine_ids')" in text
        assert "level = 'payment_device' AND key = 'zcreditPassword'" in text
        assert "config - 'terminalNumber' - 'mode'" in text
        assert "defaultPaymentDeviceId" in text
        for table in ("tenants", "companies", "shops", "shop_areas", "pos_machines"):
            assert f"'{table}'" in text
        assert "paymentDeviceGroup" in text and "settings_updated_at = now()" in text


# ── An Agamento handheld that moved (the till's relink) ──────────────────────


def relink(w, till, device_id, **data):
    from app.schemas.payment_devices import PaymentDeviceHostIn

    out = R.machine_set_payment_device_host(
        machine_id=str(till.id), device_id=str(device_id), body=PaymentDeviceHostIn.model_validate(data),
        machine=till, db=w.db,
    )
    if hasattr(out, "status_code"):  # a refusal: `{detail: code, message}`, as pinpad-host
        return out.status_code, json.loads(out.body)
    return 200, out


def till_events(w):
    from app.models.audit_exception import TillEvent

    w.db.expire_all()
    return w.db.query(TillEvent).filter(TillEvent.event_type == PD.DEVICE_HOST_EVENT).all()


class TestDeviceHostRelink:
    NAYAX = {
        "nickname": "Nayax bar", "kind": "agamento_lan",
        "config": {"host": "192.168.1.20", "path": "/SPICy2", "https": True, "mac": "aa:bb:cc:dd:ee:ff",
                   "terminalNumber": "1234567"},
    }

    def test_the_till_moves_its_shops_handheld(self, pd):
        d = create(pd, self.NAYAX)
        pd.shop.settings_updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        pd.db.commit()
        pd.shop_notified.clear()
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.77", reason="relocated",
                           terminalNumber="01234567", previousHost="192.168.1.20", serial="SN-1")
        assert code == 200
        assert out == {
            "deviceId": d["id"], "host": "192.168.1.77", "port": 8080, "previousHost": "192.168.1.20",
            "reason": "relocated", "terminalMatches": True, "unchanged": False,
        }
        # Only the address moved; the rest of the device is kept.
        assert device_row(pd, d["id"]).config == {
            "host": "192.168.1.77", "port": 8080, "path": "/SPICy2", "https": True,
            "mac": "aa:bb:cc:dd:ee:ff", "terminalNumber": "1234567",
        }
        assert pd.shop_notified == [(str(pd.shop.id), PD.NOTIFY_REASON)]
        stamp = pd.shop.settings_updated_at
        assert (stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)) > datetime(2026, 1, 1, tzinfo=timezone.utc)
        (event,) = till_events(pd)
        assert event.machine_id == pd.tablet.id and event.shop_id == pd.shop.id
        assert event.details["deviceId"] == d["id"] and event.details["deviceNickname"] == "Nayax bar"
        assert (event.details["from"], event.details["to"], event.details["reason"]) == ("192.168.1.20", "192.168.1.77", "relocated")
        # Every till of the shop gets the new address.
        devices = json.loads(pulled(pd, pd.f20).settings["paymentDevices"])
        assert devices[0]["config"]["host"] == "192.168.1.77"

    def test_the_same_address_is_answered_unchanged(self, pd):
        d = create(pd, self.NAYAX)
        pd.shop_notified.clear()
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.20", terminalNumber="1234567")
        assert code == 200 and out["unchanged"] is True
        assert till_events(pd) == [] and pd.shop_notified == []

    def test_a_port_and_the_tills_spellings(self, pd):
        d = create(pd, self.NAYAX)
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.30", port=8081, terminal="1234567", **{"from": "x"})
        assert code == 200 and out["port"] == 8081
        assert device_row(pd, d["id"]).config["port"] == 8081
        assert till_events(pd)[0].details["tillPreviousHost"] == "x"

    def test_a_move_by_itself_must_name_the_same_terminal(self, pd):
        d = create(pd, self.NAYAX)
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.30")
        assert (code, out["detail"]) == (422, "terminal_number_required") and out["message"]
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.30", terminalNumber="7654321")
        assert (code, out["detail"]) == (409, "terminal_mismatch")
        assert device_row(pd, d["id"]).config["host"] == "192.168.1.20"
        # A technician's pick needs no terminal number.
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.31", reason="technician")
        assert code == 200 and out["terminalMatches"] is None

    def test_without_its_own_number_the_tills_expected_one_counts(self, pd):
        d = create(pd, AGAMENTO)
        code, _ = relink(pd, pd.tablet, d["id"], host="192.168.1.40", terminalNumber="999")
        assert code == 200  # nothing set anywhere: no check
        patch_shop(pd, expectedTerminalNumber="1234567")
        code, out = relink(pd, pd.tablet, d["id"], host="192.168.1.41", terminalNumber="999")
        assert (code, out["detail"]) == (409, "terminal_mismatch")
        code, _ = relink(pd, pd.tablet, d["id"], host="192.168.1.41", terminalNumber="1234567")
        assert code == 200

    def test_refusals(self, pd):
        d = create(pd, self.NAYAX)
        theirs = create(pd, self.NAYAX, shop=pd.other_shop)
        synq = create(pd, SYNQ)
        for device_id, data, expected in (
            (theirs["id"], {"host": "192.168.1.9", "reason": "technician"}, (404, "payment_device_not_found")),
            (str(uuid.uuid4()), {"host": "192.168.1.9", "reason": "technician"}, (404, "payment_device_not_found")),
            ("nope", {"host": "192.168.1.9", "reason": "technician"}, (404, "payment_device_not_found")),
            (synq["id"], {"host": "192.168.1.9", "reason": "technician"}, (409, "payment_device_not_agamento_lan")),
            (d["id"], {"host": "8.8.8.8", "reason": "technician"}, (422, "host_not_private")),
            (d["id"], {"host": "http://192.168.1.9", "reason": "technician"}, (422, "host_invalid")),
            (d["id"], {"host": "192.168.1.9", "reason": "guess"}, (422, "reason_invalid")),
        ):
            code, out = relink(pd, pd.tablet, device_id, **data)
            assert (code, out["detail"]) == expected, (device_id, data)
        as_kiosk(pd, pd.f20)
        code, out = relink(pd, pd.f20, d["id"], host="192.168.1.9", reason="technician")
        assert (code, out["detail"]) == (409, "payment_device_kiosk")
        assert device_row(pd, d["id"]).config["host"] == "192.168.1.20"
        assert till_events(pd) == []


# ── One USB terminal per till (`nayax_usb` beside a SynqPay device on USB) ─────


SYNQ_USB = {"nickname": "Synq USB", "kind": "synqpay", "config": {"model": "rx5000", "connection": "usb"}}


def put_terminal(w, till, **data):
    return sync_router.machine_set_payment_terminal(
        str(till.id), sync_router.PaymentTerminalIn(**data), machine=till,
        actor=CatalogActor(pos_user_id=uuid.uuid4()), db=w.db,
    )


class TestOneUsbTerminal:
    def assert_usb_refusal(self, exc, till, field):
        from app.services import payment_integration as PI

        assert exc.status_code == 422
        assert exc.detail["code"] == "usb_terminal_second"
        assert exc.detail["field"] == field
        assert exc.detail["msg"].startswith(PI.ONE_USB_TERMINAL_HE)
        assert exc.detail["machineId"] == str(till.id)

    def test_a_usb_synqpay_device_beside_a_tills_usb_c4_is_refused(self, pd):
        patch_shop(pd, multiPaymentDevices=True)
        patch_machine(pd, pd.tablet, paymentIntegration="nayax_usb")
        exc = refused(create, pd, SYNQ_USB)
        self.assert_usb_refusal(exc, pd.tablet, "config.connection")
        assert "Synq USB" in exc.detail["msg"]
        assert listed(pd)["devices"] == []
        # LAN / Z-Credit devices are fine beside it.
        synq = create(pd, SYNQ)
        create(pd, ZCREDIT)
        create(pd, AGAMENTO)
        # Turning the LAN SynqPay into a USB one is refused; it stays on the network.
        exc = refused(update, pd, synq["id"], {"config": {"model": "dx8000", "connection": "usb"}})
        self.assert_usb_refusal(exc, pd.tablet, "config.connection")
        assert device_row(pd, synq["id"]).config["connection"] == "lan"
        # With the switch off nothing collides.
        patch_machine(pd, pd.tablet, multiPaymentDevices=False)
        usb = create(pd, SYNQ_USB)
        assert usb["config"]["connection"] == "usb"
        # A device already on USB is not re-checked by an unrelated edit.
        assert update(pd, usb["id"], {"nickname": "Synq USB 2"})["nickname"] == "Synq USB 2"

    def test_a_tills_usb_c4_beside_a_usb_device_is_refused(self, pd):
        usb = create(pd, SYNQ_USB)
        lan = create(pd, AGAMENTO)
        patch_shop(pd, multiPaymentDevices=True)
        # The till's own layer: refused, nothing written.
        exc = refused(patch_machine, pd, pd.tablet, paymentIntegration="nayax_usb")
        self.assert_usb_refusal(exc, pd.tablet, "paymentIntegration")
        assert "paymentIntegration" not in (pd.tablet.settings or {})
        # The shop's layer reaches both tills (the F20 takes the external type as well).
        exc = refused(patch_shop, pd, paymentIntegration="nayax_usb")
        assert exc.detail["code"] == "usb_terminal_second"
        assert "paymentIntegration" not in (pd.shop.settings or {})
        # A fixed LAN device leaves no USB one to charge on: allowed.
        patch_machine(pd, pd.tablet, paymentDeviceMode="fixed", fixedPaymentDeviceId=lan["id"])
        patch_machine(pd, pd.tablet, paymentIntegration="nayax_usb")
        assert pd.tablet.settings["paymentIntegration"] == "nayax_usb"
        # Its group naming the USB device is refused.
        exc = refused(patch_machine, pd, pd.tablet, paymentDeviceMode="group", paymentDeviceGroup=[usb["id"]])
        self.assert_usb_refusal(exc, pd.tablet, "paymentDeviceMode")
        assert pd.tablet.settings["paymentDeviceMode"] == "fixed"
        # A group without it is fine.
        patch_machine(pd, pd.tablet, paymentDeviceMode="group", paymentDeviceGroup=[lan["id"]])
        # Switching the devices on above a till on USB with every device: refused.
        patch_machine(pd, pd.f20, multiPaymentDevices=False, paymentIntegration="nayax_usb")
        exc = refused(patch_machine, pd, pd.f20, multiPaymentDevices=True)
        self.assert_usb_refusal(exc, pd.f20, "multiPaymentDevices")
        # Unchanged values never block a save (the dashboard sends the whole form).
        patch_machine(pd, pd.f20, multiPaymentDevices=False, paymentIntegration="nayax_usb", tipPresets=[10])

    def test_an_area_or_a_company_write_is_checked_for_its_tills(self, pd):
        create(pd, SYNQ_USB)
        area = new_area(pd, pd.tablet)
        patch_area(pd, area, multiPaymentDevices=True)
        exc = refused(patch_area, pd, area, paymentIntegration="nayax_usb")
        self.assert_usb_refusal(exc, pd.tablet, "paymentIntegration")
        exc = refused(
            settings_router.patch_company_settings,
            company_id=str(pd.company.id), data=PosSettingsV1Patch(paymentIntegration="nayax_usb"), **_ctx(pd),
        )
        assert exc.detail["code"] == "usb_terminal_second"

    def test_a_kiosk_has_no_devices_and_never_collides(self, pd):
        as_kiosk(pd, pd.tablet)
        patch_shop(pd, multiPaymentDevices=True)
        pd.tablet.settings = {"paymentIntegration": "nayax_usb"}
        pd.db.commit()
        assert create(pd, SYNQ_USB)["config"]["connection"] == "usb"

    def test_a_payment_device_is_never_a_usb_c4(self, pd):
        assert PD.KINDS == ("zcredit_pinpad", "synqpay", "agamento_lan")
        for kind in ("nayax_usb", "Nayax-USB"):
            exc = refused(create, pd, {"nickname": "C4", "kind": kind, "config": {}})
            assert (exc.status_code, exc.detail["code"], exc.detail["field"]) == (422, "kind_usb_terminal", "kind")
        exc = refused(create, pd, {"nickname": "C4", "kind": "agamento_lan", "config": {"host": "192.168.1.9", "connection": "usb"}})
        assert (exc.detail["code"], exc.detail["field"]) == ("kind_usb_terminal", "config.connection")
        assert listed(pd)["devices"] == []

    def test_the_tills_own_usb_choice_is_refused_beside_a_usb_device(self, pd, monkeypatch):
        from app.services import payment_integration as PI

        monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
        create(pd, SYNQ_USB)
        patch_shop(pd, multiPaymentDevices=True)
        exc = refused(put_terminal, pd, pd.tablet, host="", connection="usb")
        assert exc.status_code == 422
        assert isinstance(exc.detail, str) and exc.detail.startswith(PI.ONE_USB_TERMINAL_HE)
        assert "paymentIntegration" not in (pd.tablet.settings or {})
        # Without the USB device in its choice the till may.
        lan = create(pd, AGAMENTO)
        patch_machine(pd, pd.tablet, paymentDeviceMode="fixed", fixedPaymentDeviceId=lan["id"])
        assert put_terminal(pd, pd.tablet, connection="usb")["paymentIntegration"] == "nayax_usb"
