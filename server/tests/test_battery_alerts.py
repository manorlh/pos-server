"""
"סוללה חלשה" — low-battery alerts for any device (app/services/battery_alerts.py,
docs/SPEC_KIOSK_INSIGHTS.md §6).

* **The rule** (pure): 15 / 10 / 5 by default, each once per discharge cycle; a lower level
  escalates; cleared when charging or 5 points above the threshold; the cycle ends when charging or
  5 above the highest; a skipped level fires the worse one only; a reading with no percent does nothing.
* **The settings**: `lowBatteryThresholds` per shop / device; bad values fall back to the default.
* **The heartbeat** writes the rows; the tills get them by `alerts.battery` (main till / all /
  selected, everyone / managers), never the device itself; "הבנתי" marks one; charging clears it.
* **The dashboard**: the device's battery, the open alert and the history in "תקינות מכשירים".
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.models.device_battery import DeviceBatteryAlert
from app.models.pos_machine import POSMachine
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import kiosks as KR
from app.routers import machines as MR
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.schemas.pos_machine import MachineHeartbeatBody
from app.services import ably_notify
from app.services import battery_alerts as B
from app.services import kiosk_health as H
from app.services import kiosk_ops as OPS
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, make_world


def run(readings, thresholds=(15, 10, 5)):
    """The rule over a list of (percent, charging): what fired, cleared and ended, step by step."""
    state = B.CycleState()
    out = []
    for percent, charging in readings:
        s = B.step(state, percent, charging, thresholds)
        if s.clear:
            state.open_level = None
        if s.end_cycle:
            state = B.CycleState()
        if s.fire is not None:
            state.open_cycle = True
            state.fired.add(s.fire)
            state.open_level = s.fire
        out.append((s.fire, s.clear, s.end_cycle))
    return out


class TestTheRule:
    def test_each_level_once_down_to_critical_then_charging_ends_the_cycle(self):
        out = run([(30, False), (16, False), (15, False), (14, False), (10, False), (9, False), (5, False), (4, False), (4, True)])
        assert [f for f, _, _ in out] == [None, None, 15, None, 10, None, 5, None, None]
        assert out[4][1] == "escalated" and out[6][1] == "escalated"
        assert out[-1] == (None, "charging", True)
        assert B.severity_of(5, (15, 10, 5)) == "critical" and B.severity_of(10, (15, 10, 5)) == "warning"

    def test_hysteresis_and_once_per_cycle(self):
        out = run([(10, False), (14, False), (15, False), (11, False), (10, False), (5, False)])
        # 10 fires; climbing to 15 (10 + 5) clears it; back at 10 it does not fire again; 5 does.
        assert out[0][0] == 10 and out[1] == (None, None, False)
        assert out[2] == (None, "recovered", False)
        assert out[4] == (None, None, False)
        assert out[5][0] == 5

    def test_back_above_the_highest_plus_five_ends_the_cycle(self):
        out = run([(15, False), (19, False), (20, False), (15, False)])
        assert out[0][0] == 15 and out[1] == (None, None, False)
        assert out[2] == (None, "recovered", True)
        # A new cycle: 15 fires again.
        assert out[3][0] == 15

    def test_a_skipped_level_fires_the_worse_one_only(self):
        out = run([(16, False), (9, False), (12, False), (6, False), (5, False)])
        assert [f for f, _, _ in out] == [None, 10, None, None, 5]

    def test_no_percent_and_charging_change_nothing_outside_a_cycle(self):
        assert run([(None, False), (8, True), (50, False)]) == [(None, None, False)] * 3

    def test_thresholds_parse(self):
        assert B.parse_thresholds("15,10,5") == (15, 10, 5)
        assert B.parse_thresholds("8; 20") == (20, 8)
        assert B.parse_thresholds([60, 0, "12", 12]) == (12,)
        assert B.parse_thresholds("abc") == B.DEFAULT_THRESHOLDS and B.parse_thresholds(None) == B.DEFAULT_THRESHOLDS


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
    TP.ensure_builtin_parameters(world.db)
    world.handheld, world.main = world.tills
    world.third = POSMachine(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="Till 3", machine_code="X-3", pos_number="9", is_active=True, pairing_status=world.main.pairing_status,
        last_heartbeat_at=NOW,
    )
    world.db.add(world.third)
    world.db.commit()
    return world


def beat(w, machine, percent, status="discharging", now=NOW):
    machine.battery_percent = percent
    machine.battery_status = status
    out = B.on_heartbeat(w.db, machine, now=now)
    w.db.commit()
    return out


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value))
    w.db.commit()


def put(w, overrides, level="shop", entity=None):
    return KR.put_settings(
        body=KioskSettingsIn(overrides=overrides), level=level, scope_id=(entity or w.shop).id,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


class TestOnTheTills:
    def test_the_handheld_tells_the_main_till_and_charging_clears_it(self, w, monkeypatch):
        from app.services import main_till as MT

        monkeypatch.setattr(MT, "main_till_of_shop", lambda db, shop_id: w.main)
        assert beat(w, w.handheld, 40) is None
        fired = beat(w, w.handheld, 10, now=NOW + timedelta(minutes=1))
        assert fired.level == 10 and fired.severity == "warning"
        assert (str(w.main.id), "battery_alert") in [(str(m), r) for m, r in w.woken]
        alerts = [a for a in OPS.alerts_for_till(w.db, w.main, now=NOW) if a["kind"] == "battery"]
        assert len(alerts) == 1
        a = alerts[0]
        assert a["text"] == "המסופון Till 1 — סוללה 10% · חברו למטען" and a["severity"] == "warning"
        assert a["detail"] == {"percent": 10, "level": 10, "critical": False, "device": "המסופון"}
        # Only the main till (the default route); never the device itself.
        assert not [x for x in OPS.alerts_for_till(w.db, w.third, now=NOW) if x["kind"] == "battery"]
        assert not [x for x in OPS.alerts_for_till(w.db, w.handheld, now=NOW) if x["kind"] == "battery"]
        # Down to 5: critical, the 10 escalated — one open alert.
        beat(w, w.handheld, 5, now=NOW + timedelta(minutes=2))
        alerts = [a for a in OPS.alerts_for_till(w.db, w.main, now=NOW) if a["kind"] == "battery"]
        assert len(alerts) == 1 and alerts[0]["severity"] == "critical" and "קריטי" in alerts[0]["text"]
        # "הבנתי" marks it, still open.
        out = OPS.acknowledge(w.db, w.main, alerts[0]["id"], pos_user_name="דנה")
        assert out["acknowledgedBy"] == "דנה · Till 2"
        w.db.commit()
        # Plugged in: gone, the cycle ended.
        beat(w, w.handheld, 6, status="charging", now=NOW + timedelta(minutes=3))
        assert not [a for a in OPS.alerts_for_till(w.db, w.main, now=NOW) if a["kind"] == "battery"]
        rows = w.db.query(DeviceBatteryAlert).order_by(DeviceBatteryAlert.raised_at).all()
        assert [(r.level, r.clear_reason) for r in rows] == [(10, "escalated"), (5, "charging")]
        assert all(r.cycle_ended_at is not None for r in rows) and rows[0].cycle_id == rows[1].cycle_id

    def test_the_route_all_selected_and_managers(self, w):
        beat(w, w.handheld, 14)
        put(w, {"alerts": {"battery": {"tills": "all", "audience": "managers"}}})
        for till in (w.main, w.third):
            got = [a for a in OPS.alerts_for_till(w.db, till, now=NOW) if a["kind"] == "battery"]
            assert len(got) == 1 and got[0]["audience"] == "managers"
        put(w, {"alerts": {"battery": {"tills": "selected", "machineIds": [str(w.third.id)]}}})
        assert [a for a in OPS.alerts_for_till(w.db, w.third, now=NOW) if a["kind"] == "battery"]
        assert not [a for a in OPS.alerts_for_till(w.db, w.main, now=NOW) if a["kind"] == "battery"]

    def test_thresholds_per_device(self, w):
        set_param(w, B.THRESHOLDS_KEY, "machine", w.handheld.id, "30,20")
        fired = beat(w, w.handheld, 28)
        assert fired.level == 30 and fired.severity == "warning"
        assert beat(w, w.handheld, 19, now=NOW + timedelta(minutes=1)).severity == "critical"
        # Another device keeps the default.
        assert beat(w, w.third, 28) is None
        assert B.settings_of(w.db, w.third) == ((15, 10, 5), True)
        set_param(w, B.SOUND_KEY, "shop", w.shop.id, False)
        assert B.settings_of(w.db, w.third)[1] is False

    def test_a_kiosk_with_a_battery_is_named_so(self, w):
        KR.create_kiosk(
            body=KioskCreateIn(machineId=w.third.id, name="קיוסק"), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert B.device_label(w.db, w.third) == "הקיוסק"
        assert B.alert_text("הקיוסק", "קיוסק", 5, True) == "הקיוסק קיוסק — סוללה 5% · קריטי: חברו למטען מיד"

    def test_the_heartbeat_writes_it(self, w):
        body = MachineHeartbeatBody.model_validate({"batteryPercent": 9, "batteryStatus": "discharging"})
        MR.post_my_heartbeat(body=body, machine=w.handheld, db=w.db, request=None)
        row = w.db.query(DeviceBatteryAlert).one()
        assert row.level == 10 and row.percent == 9 and row.machine_id == w.handheld.id

    def test_the_dashboard_shows_the_battery_and_the_history(self, w):
        beat(w, w.handheld, 15)
        beat(w, w.handheld, 30, status="charging", now=NOW + timedelta(minutes=5))
        beat(w, w.handheld, 4, now=NOW + timedelta(minutes=9))
        out = H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=10))
        devices = {d["name"]: d for d in out["devices"]}
        hh = devices["Till 1"]
        assert hh["battery"]["percent"] == 4 and hh["battery"]["charging"] is False
        assert hh["batteryPart"]["code"] == "critical" and hh["overall"] in ("error", "offline")
        assert [e["level"] for e in out["batteryHistory"]] == [5, 15]
        assert out["batteryHistory"][1]["clearReason"] == "charging"
