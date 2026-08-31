"""Device identity / health: heartbeat contract, normalisation, pairing serial."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from app.schemas.pos_machine import MachineHeartbeatBody
from app.services.machine_health import (
    normalize_battery_percent,
    normalize_battery_status,
    normalize_clock_skew_ms,
    normalize_serial_number,
    serial_from_device_info,
)
from app.services.sync import update_machine_heartbeat


# ── Heartbeat request contract (the shipped Android till sends this exactly) ──

def test_heartbeat_accepts_full_android_payload() -> None:
    body = MachineHeartbeatBody.model_validate(
        {
            "appVersion": "1.4.2",
            "pendingCount": 3,
            "realtimeConnected": True,
            "serialNumber": "F2003183A700217",
            "batteryPercent": 41,
            "batteryStatus": "discharging",
            "clockSkewMs": -1874,
        }
    )
    assert body.app_version == "1.4.2"
    assert body.pending_count == 3
    assert body.mqtt_connected is True
    assert body.serial_number == "F2003183A700217"
    assert body.battery_percent == 41
    assert body.battery_status == "discharging"
    assert body.clock_skew_ms == -1874


def test_heartbeat_accepts_older_till_build_without_health_fields() -> None:
    """An older build in the field sends a strict subset; it must not 422."""
    body = MachineHeartbeatBody.model_validate(
        {"appVersion": "1.1.0", "pendingCount": 0, "realtimeConnected": False}
    )
    assert body.mqtt_connected is False
    assert body.serial_number is None
    assert body.battery_percent is None
    assert body.battery_status is None
    assert body.clock_skew_ms is None


def test_heartbeat_accepts_desktop_mqtt_connected_spelling() -> None:
    """The desktop says mqttConnected, the till says realtimeConnected: same column."""
    assert MachineHeartbeatBody.model_validate({"mqttConnected": True}).mqtt_connected is True
    assert (
        MachineHeartbeatBody.model_validate({"realtimeConnected": True}).mqtt_connected is True
    )


def test_heartbeat_accepts_empty_body() -> None:
    body = MachineHeartbeatBody()
    assert body.app_version is None
    assert body.mqtt_connected is None


# ── Normalisation ────────────────────────────────────────────────────────────

def test_battery_percent_preserves_null_and_zero_distinctly() -> None:
    """Null means 'could not read it'; it must never become 0."""
    assert normalize_battery_percent(None) is None
    assert normalize_battery_percent(0) == 0
    assert normalize_battery_percent(41) == 41


def test_battery_percent_clamps_instead_of_rejecting() -> None:
    assert normalize_battery_percent(150) == 100
    assert normalize_battery_percent(-5) == 0
    # Garbage degrades to unknown rather than raising: this rides on a heartbeat.
    assert normalize_battery_percent("nonsense") is None


def test_battery_status_normalises_to_known_values() -> None:
    assert normalize_battery_status("Charging") == "charging"
    assert normalize_battery_status("not-charging") == "not_charging"
    assert normalize_battery_status("NOT CHARGING") == "not_charging"
    assert normalize_battery_status("full") == "full"
    assert normalize_battery_status("wat") == "unknown"
    assert normalize_battery_status(None) is None
    assert normalize_battery_status("   ") is None


def test_clock_skew_keeps_sign_and_large_magnitudes() -> None:
    """Negative means the device is behind; a never-set clock is out by decades."""
    assert normalize_clock_skew_ms(-1874) == -1874
    assert normalize_clock_skew_ms(0) == 0
    assert normalize_clock_skew_ms(1_800_000_000_000) == 1_800_000_000_000
    assert normalize_clock_skew_ms(None) is None


def test_serial_number_trims_and_drops_blanks() -> None:
    assert normalize_serial_number("  F2003183A700217 ") == "F2003183A700217"
    assert normalize_serial_number("") is None
    assert normalize_serial_number("   ") is None
    assert normalize_serial_number(None) is None
    assert len(normalize_serial_number("X" * 200)) == 64


def test_serial_from_device_info_reads_the_tills_key() -> None:
    assert serial_from_device_info({"model": "P2", "serial": "F2003183A700217"}) == (
        "F2003183A700217"
    )
    assert serial_from_device_info({"serialNumber": "ABC"}) == "ABC"
    assert serial_from_device_info({"model": "P2"}) is None
    assert serial_from_device_info(None) is None
    assert serial_from_device_info("not-a-dict") is None


# ── Heartbeat write ──────────────────────────────────────────────────────────

def _db_with_machine(machine):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine
    return db


def _machine():
    m = MagicMock()
    m.id = uuid.uuid4()
    m.serial_number = None
    m.battery_percent = None
    m.battery_status = None
    m.clock_skew_ms = None
    m.last_health_report_at = None
    return m


def test_heartbeat_persists_health_and_stamps_report_time() -> None:
    machine = _machine()
    db = _db_with_machine(machine)

    update_machine_heartbeat(
        db,
        str(machine.id),
        mqtt_connected=True,
        app_version="1.4.2",
        serial_number="F2003183A700217",
        battery_percent=41,
        battery_status="Discharging",
        clock_skew_ms=-1874,
    )

    assert machine.serial_number == "F2003183A700217"
    assert machine.battery_percent == 41
    assert machine.battery_status == "discharging"
    assert machine.clock_skew_ms == -1874
    assert machine.last_heartbeat_at is not None
    assert machine.last_health_report_at is not None
    db.commit.assert_called_once()


def test_heartbeat_without_health_fields_leaves_last_known_values() -> None:
    """An older till build must not wipe what a newer one reported."""
    machine = _machine()
    machine.serial_number = "F2003183A700217"
    machine.battery_percent = 41
    machine.battery_status = "discharging"
    machine.clock_skew_ms = -1874
    machine.last_health_report_at = "earlier"
    db = _db_with_machine(machine)

    update_machine_heartbeat(db, str(machine.id), mqtt_connected=False, app_version="1.1.0")

    assert machine.serial_number == "F2003183A700217"
    assert machine.battery_percent == 41
    assert machine.clock_skew_ms == -1874
    # Heartbeat time moves; health-report time does not, so the dashboard can tell
    # a fresh 41% from a stale one.
    assert machine.last_heartbeat_at is not None
    assert machine.last_health_report_at == "earlier"


def test_heartbeat_refreshes_serial_when_the_unit_is_swapped() -> None:
    machine = _machine()
    machine.serial_number = "OLD-UNIT-SERIAL"
    db = _db_with_machine(machine)

    update_machine_heartbeat(db, str(machine.id), serial_number="F2003183A700217")

    assert machine.serial_number == "F2003183A700217"


def test_heartbeat_reporting_zero_battery_is_not_treated_as_missing() -> None:
    machine = _machine()
    db = _db_with_machine(machine)

    update_machine_heartbeat(db, str(machine.id), battery_percent=0, battery_status="discharging")

    assert machine.battery_percent == 0
    assert machine.last_health_report_at is not None


def test_heartbeat_on_unknown_machine_is_a_no_op() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    update_machine_heartbeat(db, str(uuid.uuid4()), battery_percent=10)
    db.commit.assert_not_called()


# ── Pairing: the serial lands on the machine row ──────────────────────────────

def test_pairing_lifts_the_serial_out_of_device_info() -> None:
    """
    The till puts its serial in `device_info` at pairing time on both paths (the
    code path via POST /pairing/validate and the QR path via device/register →
    claim). Lifting it into the column makes the unit identifiable by the number
    printed on the box from the moment it is paired, not only after its first
    heartbeat.
    """
    from app.services.pairing import create_pos_machine

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    created = []
    db.add.side_effect = created.append

    create_pos_machine(
        db,
        distributor_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        device_info={"model": "P2", "serial": "F2003183A700217", "platform": "android"},
        machine_name="Counter 1",
    )

    assert len(created) == 1
    assert created[0].serial_number == "F2003183A700217"


def test_pairing_without_a_serial_leaves_the_column_null() -> None:
    from app.services.pairing import create_pos_machine

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    created = []
    db.add.side_effect = created.append

    create_pos_machine(
        db,
        distributor_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        device_info={"model": "P2", "platform": "android"},
    )

    assert created[0].serial_number is None
