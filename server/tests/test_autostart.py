"""
"הפעלה אוטומטית כשהמכשיר נדלק" — on by default (P:/specs/autostart-default.md, app/services/autostart.py).

* **The parameter** (§1): `autoStartOnBoot`, a built-in boolean, on by default, at every level
  (company / shop / area / till); the tills pull it with their other parameters.
* **The heartbeat** (§3): `autostart: {enabled, granted, homeApp, deviceOwner, ready}` kept in
  `device_info["autostart"]` with `reportedAt` — cleaned key by key, never a 422; absent: as it was.
* **The dashboard**: "תקינות מכשירים" and the devices list / page say ready (and how), missing, off —
  nothing for a device that never reported.
* **"בעיות"**: a low item for a device whose parameter is on and whose last report says not ready;
  never for an unknown one, nor one set off.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterChange
from app.models.user import User, UserRole
from app.routers import kiosks as KR
from app.routers import machines as MR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kiosk import KioskCreateIn
from app.schemas.pos_machine import MachineHeartbeatBody, POSMachineResponse
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify
from app.services import autostart as A
from app.services import kiosk_health as H
from app.services import problems as P
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, make_world

KEY = A.AUTO_START_KEY

READY_PERMISSION = {"enabled": True, "granted": True, "homeApp": False, "deviceOwner": False, "ready": True}
NOT_READY = {"enabled": True, "granted": False, "homeApp": False, "deviceOwner": False, "ready": False}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("publish_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    world.db.add(world.bar)
    world.db.flush()
    world.first, world.second = world.tills
    world.first.area_id = world.bar.id
    world.db.commit()
    return world


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _set(w, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    parameter = w.db.query(TillParameter).filter(TillParameter.key == KEY).one()
    out = R.set_till_parameter_value(
        parameter_id=parameter.id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=w.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    w.db.commit()
    return out


def _pulled(w, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def beat(w, machine, body):
    MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate(body), machine=machine, db=w.db, request=None)
    w.db.commit()


def report(w, machine, block):
    beat(w, machine, {"autostart": block})


# ═════════════════════════════════════════════════════════════════════════════
# The parameter
# ═════════════════════════════════════════════════════════════════════════════


class TestTheParameter:
    def test_it_is_a_builtin_boolean_on_by_default(self, w):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
        assert spec.label == "הפעלה אוטומטית כשהמכשיר נדלק"
        assert spec.value_type == "boolean" and spec.default_value is True and not spec.admin_only
        # The hint: Android needs one approval on the device, unless home app or "נעילת קופה".
        assert "פעם אחת" in spec.description and "מסך הבית" in spec.description and "נעילת קופה" in spec.description
        row = w.db.query(TillParameter).filter(TillParameter.key == KEY).one()
        assert row.is_active and row.value_type == "boolean" and row.default_value is True

    def test_every_till_gets_it_on_by_default(self, w):
        assert _pulled(w, w.first) is True and _pulled(w, w.other_till) is True
        assert TP.till_parameters_for_machine(w.db, w.second).parameters[KEY] is True
        assert A.enabled_by_machine(w.db, [w.first, w.second, w.other_till]) == {
            w.first.id: True, w.second.id: True, w.other_till.id: True,
        }

    def test_every_level_and_the_change_log(self, w):
        tills = [w.first, w.second, w.other_till]

        def pulled():
            return [_pulled(w, t) for t in tills]

        # The company off: every till.
        _set(w, "company", w.company.id, False)
        assert pulled() == [False, False, False]
        # The shop back on: its tills, the other shop keeps the company's.
        _set(w, "shop", w.shop.id, True)
        assert pulled() == [True, True, False]
        # The bar (the first till's area) off.
        _set(w, "area", w.bar.id, False)
        assert pulled() == [False, True, False]
        # The till itself wins.
        _set(w, "machine", w.first.id, True)
        assert pulled() == [True, True, False]
        # The cloud's own resolution (the problems screen) agrees with what the tills get.
        enabled = A.enabled_by_machine(w.db, tills)
        assert [enabled[t.id] for t in tills] == pulled()
        changes = w.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == KEY).all()
        assert sorted(c.scope_type for c in changes) == ["area", "company", "machine", "shop"]

    def test_switched_off_by_a_super_admin_the_cloud_goes_by_the_default(self, w):
        row = w.db.query(TillParameter).filter(TillParameter.key == KEY).one()
        row.is_active = False
        w.db.commit()
        assert _pulled(w, w.first) is None
        assert A.enabled_by_machine(w.db, [w.first]) == {w.first.id: True}

    def test_no_parameter_row_is_on(self, w):
        w.db.query(TillParameter).filter(TillParameter.key == KEY).delete()
        w.db.commit()
        assert A.enabled_by_machine(w.db, [w.first, w.other_till]) == {w.first.id: True, w.other_till.id: True}
        assert A.enabled_by_machine(w.db, []) == {}


# ═════════════════════════════════════════════════════════════════════════════
# The heartbeat
# ═════════════════════════════════════════════════════════════════════════════


class TestTheHeartbeat:
    def test_the_report_is_kept_in_device_info_beside_what_was_there(self, w):
        w.first.device_info = {"model": "V2s", "manufacturer": "SUNMI", "batteryPresent": True}
        w.db.commit()
        report(w, w.first, NOT_READY)
        info = w.first.device_info
        assert info["model"] == "V2s" and info["batteryPresent"] is True
        kept = info["autostart"]
        assert {k: kept[k] for k in A.REPORT_KEYS} == NOT_READY
        assert isinstance(kept["reportedAt"], str) and kept["reportedAt"]
        # The next report replaces it whole.
        report(w, w.first, {"enabled": True, "homeApp": True, "ready": True})
        assert {k: v for k, v in w.first.device_info["autostart"].items() if k != "reportedAt"} == {
            "enabled": True, "homeApp": True, "ready": True,
        }

    def test_absent_or_unreadable_leaves_it_as_it_was_and_never_fails_the_beat(self, w):
        report(w, w.first, READY_PERMISSION)
        before = dict(w.first.device_info["autostart"])
        beat(w, w.first, {"batteryPercent": 50, "batteryStatus": "discharging"})  # an older build
        assert w.first.device_info["autostart"] == before
        beat(w, w.first, {"autostart": "yes", "batteryStatus": "full"})  # not an object
        assert w.first.device_info["autostart"] == before and w.first.battery_status == "full"
        beat(w, w.first, {"autostart": {"enabled": "maybe", "colour": "red"}})  # nothing usable
        assert w.first.device_info["autostart"] == before
        assert MachineHeartbeatBody.model_validate({"autostart": [1, 2]}).autostart is None

    def test_cleaned_key_by_key_and_ready_worked_out_when_not_said(self):
        # Only the known keys, only booleans ("true" and 1 are not).
        assert A.clean_report({"enabled": True, "granted": "true", "ready": 1, "extra": True}) == {"enabled": True}
        # `ready` from the three ways when the device did not say it.
        assert A.clean_report({"granted": False, "homeApp": True}) == {"granted": False, "homeApp": True, "ready": True}
        assert A.clean_report({"enabled": True, "granted": False}) == {"enabled": True, "granted": False, "ready": False}
        # The device's own `ready` stands.
        assert A.clean_report({"granted": False, "ready": True})["ready"] is True
        assert A.clean_report({}) is None and A.clean_report(None) is None and A.clean_report("x") is None

    def test_another_device_is_left_alone(self, w):
        report(w, w.first, NOT_READY)
        assert A.report_of(w.second) is None and A.status_of_machine(w.second) is None


# ═════════════════════════════════════════════════════════════════════════════
# The indicator
# ═════════════════════════════════════════════════════════════════════════════


class TestTheStatus:
    @pytest.mark.parametrize(
        "kept, state, via",
        [
            # Unknown: no report, or one that says neither on/off nor ready.
            (None, None, None),
            ({}, None, None),
            ({"granted": None}, None, None),
            # Off on the device: grey, whatever else it says.
            ({"enabled": False, "ready": True, "deviceOwner": True}, "off", None),
            ({"enabled": False}, "off", None),
            # Ready, and how — the most reliable way named.
            ({"enabled": True, "granted": True, "homeApp": True, "deviceOwner": True, "ready": True}, "ready", "lock"),
            ({"enabled": True, "granted": True, "homeApp": True, "ready": True}, "ready", "home"),
            (READY_PERMISSION, "ready", "permission"),
            ({"enabled": True, "ready": True}, "ready", None),
            # On and not ready: "חסר אישור במכשיר".
            (NOT_READY, "missing", None),
            ({"ready": False}, "missing", None),
        ],
    )
    def test_the_matrix(self, kept, state, via):
        status = A.status_of(kept)
        if state is None:
            assert status is None
        else:
            assert status["state"] == state and status["via"] == via

    def test_the_words(self):
        assert A.label(A.status_of(READY_PERMISSION)) == "מוכן · הרשאה"
        assert A.label(A.status_of({"enabled": True, "homeApp": True, "ready": True})) == "מוכן · מסך בית"
        assert A.label(A.status_of({"deviceOwner": True, "ready": True})) == "מוכן · נעילת קופה"
        assert A.label(A.status_of({"ready": True})) == "מוכן"
        assert A.label(A.status_of(NOT_READY)) == "חסר אישור במכשיר"
        assert A.label(A.status_of({"enabled": False})) == "כבוי"
        assert A.label(None) is None


# ═════════════════════════════════════════════════════════════════════════════
# The dashboard
# ═════════════════════════════════════════════════════════════════════════════


class TestTheDashboard:
    def test_the_health_view_says_it_per_device_and_nothing_when_unknown(self, w):
        report(w, w.first, NOT_READY)
        report(w, w.second, {"enabled": True, "granted": False, "homeApp": True, "deviceOwner": False, "ready": True})
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=1))
        devices = {d["machineId"]: d for d in out["devices"]}
        assert devices[str(w.first.id)]["autoStart"]["state"] == "missing"
        assert devices[str(w.second.id)]["autoStart"]["state"] == "ready"
        assert devices[str(w.second.id)]["autoStart"]["via"] == "home"
        assert devices[str(w.second.id)]["autoStart"]["reportedAt"]
        assert devices[str(w.other_till.id)]["autoStart"] is None  # never reported: no indicator
        # It is not a health part: the device's overall state does not move for it.
        before = devices[str(w.first.id)]["overall"]
        report(w, w.first, READY_PERMISSION)
        again = {d["machineId"]: d for d in H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=1))["devices"]}
        assert again[str(w.first.id)]["overall"] == before
        assert again[str(w.first.id)]["autoStart"]["state"] == "ready"

    def test_a_kiosk_row_says_it_too(self, w):
        KR.create_kiosk(
            body=KioskCreateIn(machineId=w.second.id, name="קיוסק"), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        w.db.commit()
        report(w, w.second, {"enabled": False, "ready": False})
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=1))
        (row,) = [k for k in out["kiosks"] if k["machineId"] == str(w.second.id)]
        assert row["autoStart"]["state"] == "off"
        assert str(w.second.id) not in {d["machineId"] for d in out["devices"]}

    def test_the_devices_list_and_page_carry_it(self, w):
        report(w, w.first, READY_PERMISSION)
        row = MR._enrich_machine_status(w.first, w.db)
        assert row["autoStart"]["state"] == "ready" and row["autoStart"]["via"] == "permission"
        out = POSMachineResponse.model_validate(row).model_dump(mode="json", by_alias=True)
        assert out["autoStart"]["state"] == "ready"
        assert MR._enrich_machine_status(w.other_till, w.db)["autoStart"] is None


# ═════════════════════════════════════════════════════════════════════════════
# "בעיות"
# ═════════════════════════════════════════════════════════════════════════════


def _items(w):
    out = P.build(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=1))
    devices = next(g for g in out["groups"] if g["key"] == "devices")
    return {i["id"]: i for i in devices["items"] if i["kind"] == A.PROBLEM_KIND}


class TestTheProblems:
    def test_a_device_on_and_not_ready_is_a_low_item(self, w):
        report(w, w.first, NOT_READY)
        items = _items(w)
        assert set(items) == {f"autostart:{w.first.id}"}
        item = items[f"autostart:{w.first.id}"]
        assert item["severity"] == "low" and item["title"] == "פתיחה אוטומטית לא מוכנה"
        assert item["machineId"] == str(w.first.id) and item["shopId"] == str(w.shop.id)
        assert item["link"] == f"/dashboard/machines/{w.first.id}" and item["since"]

    def test_never_for_an_unknown_a_ready_or_a_device_set_off(self, w):
        # Unknown (an older APK): nothing, whatever the parameter.
        assert _items(w) == {}
        # Ready: nothing.
        report(w, w.first, READY_PERMISSION)
        assert _items(w) == {}
        # Not ready, but the parameter set off for it in the cloud: nothing.
        report(w, w.first, NOT_READY)
        report(w, w.other_till, NOT_READY)
        _set(w, "machine", w.first.id, False)
        assert set(_items(w)) == {f"autostart:{w.other_till.id}"}
        # Off for the other shop too.
        _set(w, "shop", w.other_shop.id, False)
        assert _items(w) == {}
        # Back on at the till: listed again; it clears with the report that says ready.
        _set(w, "machine", w.first.id, True)
        assert set(_items(w)) == {f"autostart:{w.first.id}"}
        report(w, w.first, {"enabled": True, "deviceOwner": True, "ready": True})
        assert _items(w) == {}

    def test_not_in_a_shop_out_of_reach(self, w):
        report(w, w.other_till, NOT_READY)
        manager = User(
            id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, company_id=w.company.id,
            shop_id=w.shop.id, email="m@x", username="shopmgr", is_active=True,
        )
        w.db.add(manager)
        w.db.flush()
        out = P.build(w.db, manager, w.tenant.id, now=NOW + timedelta(minutes=1))
        assert not any(i["kind"] == A.PROBLEM_KIND for g in out["groups"] for i in g["items"])
