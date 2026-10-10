"""
"חזרה אוטומטית לקיוסק" — after a manager took R2M POS for Windows out to the desktop
("יציאה לשולחן העבודה", permission DESKTOP_EXIT), the device comes back to full screen by itself
once nobody has touched the keyboard or mouse for this many minutes (kiosk-desktop
main/shell/desktopMode.ts). The owner (08.10.2026): on by default, 10 minutes, set from the cloud.

A POS setting like any other (tenant → company → shop → point of sale → till, the deepest layer
wins), so a device's own settings dialog can turn it off or change the minutes:

* `desktopIdleReturnMinutes`: a whole number 0–240; 0 = never by itself; unset = the default 10;
  `null` in a PATCH resets the layer to inherit.
* Always sent to the device on its settings pull, resolved (`resolve`): a reset reaches it on any
  pull, and the device's own kiosk.json value is only a fallback for a server that sends none.
"""
from __future__ import annotations

from typing import Any, Mapping

KEY = "desktopIdleReturnMinutes"
DEFAULT_MINUTES = 10
MAX_MINUTES = 240
MESSAGE = f"חזרה אוטומטית לקיוסק: מספר שלם של דקות, 0 (כבוי) עד {MAX_MINUTES}"


def clean_minutes(value: Any) -> int:
    """A layer's value: a whole number 0–MAX_MINUTES (not a bool, not text). ValueError otherwise."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(MESSAGE)
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(MESSAGE)
        value = int(value)
    if value < 0 or value > MAX_MINUTES:
        raise ValueError(MESSAGE)
    return value


def resolve(merged: Mapping[str, Any]) -> int:
    """What the device gets: the deepest layer's minutes, or the default when none sets them."""
    value = merged.get(KEY) if isinstance(merged, Mapping) else None
    if value is None:
        return DEFAULT_MINUTES
    try:
        return clean_minutes(value)
    except ValueError:
        return DEFAULT_MINUTES
