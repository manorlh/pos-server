"""
"ניטור סוללה" — the till parameter `batteryMonitoring` (app/services/battery_alerts.py). The owner:
"אפשר לבטל מצב סוללה על קופות כי אין בהם סוללות".

* **The rule** (pure, `battery_monitored(param, model, battery_present)`): "on" always, "off" never;
  "auto" (and unset) — not when the device says it has no battery, nor on a mains-only model
  (`device_is_mains_only`: the SUNMI / iMin desktops, the SUNMI K2); else watched.
* **The parameter**: built in, an enum "auto" / "on" / "off", "auto" by default; set at every level
  and audited like the others; the tills pull the answer — "on" / "off", never "auto".
* **The heartbeat**: `batteryPresent` kept in `device_info` (no reading when false); a device not
  watched raises nothing, and an open cycle of it ends quietly — no push. Other devices still alert.
* **The dashboard**: "ללא סוללה" / "ניטור סוללה כבוי" instead of a percent and history.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.device_battery import DeviceBatteryAlert
from app.models.pos_machine import DEVICE_MODELS, device_is_mains_only
from app.models.till_parameter import TillParameter, TillParameterChange
from app.models.user import User, UserRole
from app.routers import kiosks as KR
from app.routers import machines as MR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kiosk import KioskSettingsIn
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify
from app.services import battery_alerts as B
from app.services import kiosk_health as H
from app.services import kiosk_ops as OPS
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, make_world

KEY = B.MONITORING_KEY


class TestTheRule:
    @pytest.mark.parametrize(
        "param, model, present, expected",
        [
            # "on": always — even a desktop that says it has no battery.
            ("on", "SUNMI_T2_MINI", False, True),
            ("on", None, None, True),
            # "off": never — even a handheld with a battery.
            ("off", "SUNMI_V2_PRO", True, False),
            ("off", None, None, False),
            # "auto": by the device.
            ("auto", None, None, True),
            ("auto", None, True, True),
            ("auto", None, False, False),
            ("auto", "SUNMI_V2_PRO", True, True),
            ("auto", "SUNMI_T2_MINI", None, False),
            ("auto", "SUNMI_T2_MINI", True, False),  # a desktop's made-up battery does not count
            ("auto", "IMIN_D4", None, False),
            ("auto", "SUNMI_K2", None, False),
            ("auto", "IMIN_FALCON2", True, True),  # a tablet in its dock has a battery
            # Unset, or a value that is not one of the three: "auto".
            (None, "SUNMI_T2", None, False),
            (None, "N55F", None, True),
            ("whatever", None, False, False),
            (" ON ", "SUNMI_T2", None, True),
        ],
    )
    def test_the_matrix(self, param, model, present, expected):
        assert B.battery_monitored(param, model, present) is expected

    def test_the_mains_only_models(self):
        mains = {"SUNMI_T1", "SUNMI_T2", "SUNMI_T2_MINI", "SUNMI_T2S", "SUNMI_T3", "SUNMI_D2_MINI", "SUNMI_D2S",
                 "SUNMI_D2S_PLUS", "SUNMI_D3", "SUNMI_K2", "IMIN_D4", "IMIN_D4_PRO", "IMIN_SWAN2", "IMIN_FALCON1"}
        assert {m for m in DEVICE_MODELS if device_is_mains_only(m)} == mains
        # Every one of them is a model the tables know.
        assert mains <= set(DEVICE_MODELS)
        # With a battery, or not known: left to the device's own word.
        for model in ("N55F", "MODO", "P18", "SUNMI_V2_PRO", "SUNMI_P2", "SUNMI_L2", "SUNMI_M2", "SUNMI_D3_MINI",
                      "SUNMI", "IMIN_FALCON2", "IMIN_FALCON2MAX", "IMIN_D1", "IMIN_M2", "IMIN_SWIFT2", "IMIN",
                      "LANDI_C20_PRO", "FEITIAN_M500", "PAX_A77", "UROVO_I9100", None, "unknown"):
            assert device_is_mains_only(model) is False, model


# ═════════════════════════════════════════════════════════════════════════════
# On the SQLite world
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(ably_notify, "publish_notify", lambda tenant, machine, event, body: world.woken.append((machine, body.get("reason"))))
    for name in ("publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.handheld, world.main = world.tills
    from app.services import main_till as MT

    monkeypatch.setattr(MT, "main_till_of_shop", lambda db, shop_id: world.main)
    # The shop chose "הקופה הראשית" (the default is "רק המכשיר עצמו" — no other till would hear).
    KR.put_settings(
        body=KioskSettingsIn(overrides={"alerts": {"battery": {"tills": "main"}}}), level="shop", scope_id=world.shop.id,
        current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
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
    return out


def _pulled(w, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def beat(w, machine, body, now=NOW):
    MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate(body), machine=machine, db=w.db, request=None)
    w.db.commit()


def reading(w, machine, percent, status="discharging", now=NOW):
    machine.battery_percent = percent
    machine.battery_status = status
    out = B.on_heartbeat(w.db, machine, now=now)
    w.db.commit()
    return out


def battery_alerts_for(w, till):
    return [a for a in OPS.alerts_for_till(w.db, till, now=NOW) if a["kind"] == "battery"]


class TestTheParameter:
    def test_it_is_a_builtin_enum_auto_by_default(self, w):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
        assert spec.label == "ניטור סוללה (סוללה חלשה והתראות)"
        assert spec.value_type == "enum" and tuple(spec.enum_options) == ("auto", "on", "off")
        assert spec.default_value == "auto"
        assert spec.description == (
            "אוטומטי — רק במכשיר שיש בו סוללה. כבוי — לקופה קבועה בלי סוללה: בלי פס 'סוללה חלשה', "
            "בלי אזעקה ובלי התראות סוללה על המכשיר הזה. פעיל — תמיד"
        )
        # Beside the thresholds and the alarm, in the same group (and the manager's phone alert after it,
        # P:/specs/push-more.md §A).
        keys = [s["key"] for s in B.BATTERY_PARAMETER_SPECS]
        assert keys == [B.THRESHOLDS_KEY, B.SOUND_KEY, KEY, B.PUSH_LEVEL_KEY]
        row = w.db.query(TillParameter).filter(TillParameter.key == KEY).one()
        assert row.is_active and row.default_value == "auto" and row.enum_options == ["auto", "on", "off"]

    def test_the_tills_get_the_answer_never_auto(self, w):
        # A till of unknown model, nothing said about its battery: watched.
        assert _pulled(w, w.handheld) == "on"
        # A T2 mini on "auto": not watched.
        w.main.device_model = "SUNMI_T2_MINI"
        w.db.commit()
        assert _pulled(w, w.main) == "off"
        assert TP.till_parameters_for_machine(w.db, w.main).parameters[KEY] == "off"
        # A device that says it has no battery.
        w.other_till.device_info = {"model": "X", "batteryPresent": False}
        w.db.commit()
        assert _pulled(w, w.other_till) == "off"

    def test_every_level_and_the_change_log(self, w):
        w.main.device_model = "SUNMI_T2"
        w.db.commit()
        # The company says "on": the desktop too.
        _set(w, "company", w.company.id, "on")
        assert _pulled(w, w.main) == "on" and _pulled(w, w.handheld) == "on"
        # The shop says "off": both, and the other shop keeps the company's.
        _set(w, "shop", w.shop.id, "off")
        assert _pulled(w, w.main) == "off" and _pulled(w, w.handheld) == "off"
        assert _pulled(w, w.other_till) == "on"
        # The till itself back to "auto": its model decides.
        _set(w, "machine", w.main.id, "auto")
        _set(w, "machine", w.handheld.id, "auto")
        assert _pulled(w, w.main) == "off" and _pulled(w, w.handheld) == "on"
        changes = w.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == KEY).all()
        assert sorted((c.scope_type, c.new_value) for c in changes) == [
            ("company", "on"), ("machine", "auto"), ("machine", "auto"), ("shop", "off"),
        ]

    def test_a_value_not_one_of_the_three_is_refused(self, w):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            _set(w, "shop", w.shop.id, "sometimes")
        assert exc.value.status_code == 422

    def test_switched_off_by_a_super_admin_nothing_is_sent(self, w):
        row = w.db.query(TillParameter).filter(TillParameter.key == KEY).one()
        row.is_active = False
        w.db.commit()
        assert _pulled(w, w.handheld) is None
        # The cloud itself then goes by "auto".
        w.main.device_model = "SUNMI_D3"
        w.db.commit()
        assert B.monitored(w.db, w.main) is False and B.monitored(w.db, w.handheld) is True


class TestTheHeartbeat:
    def test_battery_present_is_kept_and_a_reading_without_a_battery_is_none(self, w):
        w.main.device_info = {"model": "T2mini", "manufacturer": "SUNMI"}
        w.db.commit()
        beat(w, w.main, {"batteryPercent": 100, "batteryStatus": "full"})
        assert w.main.battery_percent == 100 and "batteryPresent" not in w.main.device_info
        beat(w, w.main, {"batteryStatus": "unknown", "batteryPresent": False})
        assert w.main.device_info == {"model": "T2mini", "manufacturer": "SUNMI", "batteryPresent": False}
        assert w.main.battery_percent is None and w.main.battery_status == "unknown"
        # Absent (an older build): as it was.
        beat(w, w.main, {"batteryStatus": "unknown"})
        assert w.main.device_info["batteryPresent"] is False
        # An unreadable value never fails the beat.
        beat(w, w.main, {"batteryPresent": "maybe", "batteryStatus": "full"})
        assert w.main.device_info["batteryPresent"] is False and w.main.battery_status == "full"
        beat(w, w.main, {"batteryPercent": 80, "batteryStatus": "discharging", "batteryPresent": True})
        assert w.main.device_info["batteryPresent"] is True and w.main.battery_percent == 80

    def test_a_desktop_on_auto_raises_nothing_and_a_handheld_still_does(self, w):
        w.main.device_model = "SUNMI_T2_MINI"
        w.db.commit()
        # The T2 mini "discharging" at 4 %: nothing.
        assert reading(w, w.main, 4) is None
        assert w.db.query(DeviceBatteryAlert).filter(DeviceBatteryAlert.machine_id == w.main.id).count() == 0
        # The handheld: the main till hears of it, as before.
        fired = reading(w, w.handheld, 9)
        assert fired is not None and fired.level == 10
        assert (str(w.main.id), "battery_alert") in [(str(m), r) for m, r in w.woken]
        assert len(battery_alerts_for(w, w.main)) == 1

    def test_switched_off_the_open_cycle_ends_quietly(self, w):
        fired = reading(w, w.handheld, 9)
        assert fired is not None and len(battery_alerts_for(w, w.main)) == 1
        woken = len(w.woken)
        # Set off on the dashboard: gone from the tills at once, before the device beats again.
        _set(w, "machine", w.handheld.id, "off")
        assert battery_alerts_for(w, w.main) == []
        # Its next beat ends the cycle — no "recovered", no push.
        beat(w, w.handheld, {"batteryPercent": 8, "batteryStatus": "discharging"})
        rows = w.db.query(DeviceBatteryAlert).filter(DeviceBatteryAlert.machine_id == w.handheld.id).all()
        assert len(rows) == 1
        assert rows[0].cleared_at is not None and rows[0].clear_reason == B.CLEAR_NOT_MONITORED
        assert rows[0].cycle_ended_at is not None
        assert len(w.woken) == woken
        # Lower still: nothing fires while it is off.
        assert reading(w, w.handheld, 3, now=NOW + timedelta(minutes=1)) is None
        # Back on: a new cycle, the next reading fires again.
        _set(w, "machine", w.handheld.id, "on")
        assert reading(w, w.handheld, 3, now=NOW + timedelta(minutes=2)).level == 5

    def test_a_device_that_says_it_has_no_battery_ends_its_cycle(self, w):
        reading(w, w.handheld, 12)
        beat(w, w.handheld, {"batteryStatus": "unknown", "batteryPresent": False})
        row = w.db.query(DeviceBatteryAlert).filter(DeviceBatteryAlert.machine_id == w.handheld.id).one()
        assert row.clear_reason == B.CLEAR_NOT_MONITORED and row.cycle_ended_at is not None
        assert battery_alerts_for(w, w.main) == []


class TestTheDashboard:
    def test_no_battery_and_monitoring_off_instead_of_a_percent_and_history(self, w):
        reading(w, w.handheld, 9)
        reading(w, w.handheld, 30, status="charging", now=NOW + timedelta(minutes=1))
        w.main.device_model = "IMIN_D4_PRO"
        w.main.battery_percent, w.main.battery_status = 100, "full"
        w.other_till.battery_percent, w.other_till.battery_status = 70, "discharging"
        w.db.commit()
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=2))
        devices = {d["name"]: d for d in out["devices"]}
        desktop, handheld, other = devices["Till 2"], devices["Till 1"], devices["North 1"]
        assert desktop["battery"] is None and desktop["batteryMonitored"] is False
        assert desktop["batteryPart"]["code"] == "no_battery" and desktop["batteryPart"]["level"] == "off"
        assert desktop["overall"] in ("ok", "offline")
        assert handheld["batteryMonitored"] is True and handheld["battery"]["percent"] == 30
        assert [e["machineId"] for e in out["batteryHistory"]] == [str(w.handheld.id)]
        # The handheld set off: "ניטור סוללה כבוי", and its history is gone with it.
        _set(w, "machine", w.handheld.id, "off")
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=3))
        handheld = {d["name"]: d for d in out["devices"]}["Till 1"]
        assert handheld["battery"] is None and handheld["batteryPart"]["code"] == "monitoring_off"
        assert out["batteryHistory"] == []
        # "off" on a device that has no battery says "ללא סוללה" — it is the truth.
        _set(w, "machine", w.main.id, "off")
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=3))
        assert {d["name"]: d for d in out["devices"]}["Till 2"]["batteryPart"]["code"] == "no_battery"
        assert other["batteryMonitored"] is True and other["battery"]["percent"] == 70

    def test_the_part_says_why(self):
        assert H.battery_part({"percent": 4}, None, "no_battery") == H._part("battery", "off", "no_battery")
        assert H.battery_part(None, None, "monitoring_off")["code"] == "monitoring_off"
        assert H.battery_part(None, None)["code"] == "none"
