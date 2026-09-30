"""
Normalisation for the device identity / health fields a till reports.

Kept apart from the heartbeat write itself so both entry points — the periodic
heartbeat and pairing, which learns the serial from `device_info` — apply exactly
the same rules, and so the rules can be tested without a database.

The governing principle throughout: a bad value degrades to "unknown", it never
raises. These fields ride on the heartbeat, and rejecting a heartbeat over a
malformed battery string would take a healthy terminal off the dashboard.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from app.models.pos_machine import BATTERY_STATUSES

if TYPE_CHECKING:
    from app.models.pos_machine import POSMachine
    from app.schemas.printer import HeartbeatPrinter

SERIAL_MAX_LEN = 64

# Keys the till (and the desktop) have used for the hardware serial inside
# `device_info`. The Android build sends "serial"; accept the obvious variants so
# a client that spells it differently still lands the value in the column.
_DEVICE_INFO_SERIAL_KEYS = ("serial", "serialNumber", "serial_number", "deviceSerial")


def normalize_serial_number(value: Any) -> Optional[str]:
    """Trimmed serial, or None for anything blank/unusable."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:SERIAL_MAX_LEN]


def serial_from_device_info(device_info: Any) -> Optional[str]:
    """Pull the hardware serial out of a pairing `device_info` blob, if present."""
    if not isinstance(device_info, dict):
        return None
    for key in _DEVICE_INFO_SERIAL_KEYS:
        serial = normalize_serial_number(device_info.get(key))
        if serial:
            return serial
    return None


def normalize_battery_percent(value: Any) -> Optional[int]:
    """
    Clamp to 0..100, preserving None.

    None means "the device could not read it" and is a distinct, meaningful state:
    it must never become 0, because "unknown charge" and "about to shut down" are
    the two things a distributor most needs to tell apart.
    """
    if value is None:
        return None
    try:
        pct = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(100, pct))


def normalize_battery_status(value: Any) -> Optional[str]:
    """Map to one of BATTERY_STATUSES; an unrecognised string becomes 'unknown'."""
    if value is None:
        return None
    text = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    if not text:
        return None
    if text in BATTERY_STATUSES:
        return text
    return "unknown"


def normalize_clock_skew_ms(value: Any) -> Optional[int]:
    """
    Signed device-minus-server offset in milliseconds.

    Signed and unbounded on purpose: negative means the device is behind, and a
    terminal that booted with an unset clock is legitimately out by decades.
    """
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def apply_printer_block(
    machine: "POSMachine", block: Optional["HeartbeatPrinter"], *, now: Optional[datetime] = None
) -> None:
    """
    The heartbeat's `printer` block (docs/SHIFTS_API.md §1.6a): a snapshot, replacing the
    stored reading field by field. No block, no change — an older till sends none, and
    that must not read as "the printer is fine".
    """
    if block is None:
        return
    machine.printer_status = block.status
    machine.printer_error_code = block.code
    machine.printer_message = block.message
    machine.printer_status_at = _utc(block.at)
    machine.printer_last_ok_at = _utc(block.last_print_ok_at)
    machine.printer_reported_at = now or datetime.now(timezone.utc)
