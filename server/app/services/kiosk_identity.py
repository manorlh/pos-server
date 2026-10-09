"""
"לקיוסק אין עובד בפועל" (docs/SPEC_KIOSK.md §14): a self-order kiosk has no employee. Its
shifts, documents and Zs run as the kiosk itself — a system operator the cloud names here,
stable per kiosk: `kiosk:<machine id>`, called by the kiosk's name ("קיוסק רויאל").

It is not a `pos_users` row: it never signs in, never shows in a till's roster, has no PIN
and no attendance. It travels where a till user's id travels (`transactions.cashier_id`,
`shifts.opened_by_pos_user_id`, the Z's closer — all free text), and the places that turn
such an id into a name ask here first (reports, the exceptions feed); the open-format file
gets a short code of its own (`open_format_code`).
"""
from __future__ import annotations

import types
import uuid
from typing import Any, Dict, Iterable, Optional

from sqlalchemy.orm import Session

#: The prefix that marks a kiosk's own operator id.
PREFIX = "kiosk:"
#: Its name when the kiosk has none.
FALLBACK_NAME = "קיוסק"


def operator_id(machine_id: Any) -> str:
    return f"{PREFIX}{machine_id}"


def is_kiosk_operator(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def machine_id_of(value: Any) -> Optional[uuid.UUID]:
    if not is_kiosk_operator(value):
        return None
    try:
        return uuid.UUID(value[len(PREFIX):])
    except (ValueError, AttributeError, TypeError):
        return None


def operator_of(device, machine=None) -> Dict[str, str]:
    """`{id, name}` for `kiosk/sync`: who the kiosk's shifts and documents are filed under."""
    name = (getattr(device, "name", None) or getattr(machine, "name", None) or FALLBACK_NAME).strip() or FALLBACK_NAME
    return {"id": operator_id(device.machine_id), "name": name}


def names_for(db: Session, values: Iterable[Any]) -> Dict[str, str]:
    """The kiosk name for each kiosk operator id among `values` (others are left out)."""
    from app.models.kiosk import KioskDevice
    from app.models.pos_machine import POSMachine

    wanted = {v: machine_id_of(v) for v in values if is_kiosk_operator(v)}
    ids = [m for m in wanted.values() if m is not None]
    if not ids:
        return {}
    devices = {d.machine_id: d.name for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all()}
    missing = [m for m in ids if not devices.get(m)]
    machines = (
        {m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(missing)).all()} if missing else {}
    )
    out: Dict[str, str] = {}
    for value, mid in wanted.items():
        if mid is None:
            continue
        out[value] = (devices.get(mid) or machines.get(mid) or FALLBACK_NAME).strip() or FALLBACK_NAME
    return out


def name_of(db: Session, value: Any) -> Optional[str]:
    return names_for(db, [value]).get(value) if is_kiosk_operator(value) else None


def as_pos_user(value: str, name: str):
    """A stand-in with a till user's name fields, for code that reads `first_name` / `username`."""
    return types.SimpleNamespace(
        id=value, first_name=name, last_name=None, username=name, worker_number=None, role=None, is_active=True,
    )


def open_format_code(value: Any) -> Optional[str]:
    """
    Field 1233 (the cashier, 9 characters) for a kiosk's document: "K" and the first eight
    hex digits of its machine id — short, stable, and plainly not an employee.
    """
    mid = machine_id_of(value)
    return f"K{mid.hex[:8]}" if mid is not None else None
