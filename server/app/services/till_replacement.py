"""
"הוחלפה קופה" — a till's device replaced, documented (docs/SPEC_OFFLINE_TILL_Z.md §4.6.2).

The owner: "תיעוד שהוחלפה קופה, אבל אפשר להוציא Z מהענן עם הנתונים הקיימים". When a
replacement device redeems a replacement code (the last step of a dead-till recovery too),
the till keeps its identity — same row, register number and Z run — and this records:

* the old device and the new one (what each reported of itself), who created the code,
  when the new one took over, why, and whether support produced the till's Z from the
  cloud first (§4.6);
* on the machine (`pos_machines.replacements`, the machine page's history) and as one
  `till_replaced` exception for the audit;
* the next Z of the till says it once: "המכשיר הוחלף בתאריך …" (`header.devicesReplaced`).

Producing a Z from the cloud with the data it holds stays as it is (§4.6).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from sqlalchemy.orm import Session

from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.models.user import User

logger = logging.getLogger(__name__)

EXCEPTION_TYPE = "till_replaced"
LABEL = "הוחלפה קופה"

#: What a device says of itself that tells one unit from another.
DEVICE_KEYS = (
    "serialNumber", "serial", "terminalSerial", "manufacturer", "brand", "model", "device",
    "androidId", "deviceId", "appVersion", "osVersion", "sdkInt",
)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    return (moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)).isoformat()


def device_of(info: Optional[Dict[str, Any]], model: Optional[str] = None) -> Dict[str, Any]:
    """One device as the record keeps it. Pure."""
    info = info if isinstance(info, dict) else {}
    out = {k: info.get(k) for k in DEVICE_KEYS if info.get(k) not in (None, "")}
    if model:
        out["deviceModel"] = model
    return out


def snapshot(db: Session, machine_id) -> Optional[Dict[str, Any]]:
    """The till as it stands before the new device adopts it."""
    try:
        machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    except Exception:  # noqa: BLE001 - the record says less; the pairing goes on
        return None
    if machine is None:
        return None
    return {
        "device": device_of(machine.device_info, getattr(machine, "device_model", None)),
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "appVersion": getattr(machine, "app_version", None),
    }


def _who(db: Session, user_id) -> Optional[str]:
    if user_id is None:
        return None
    try:
        user = db.query(User).filter(User.id == user_id).first()
    except Exception:  # noqa: BLE001 - a name for the record; never fails the pairing
        return str(user_id)
    if user is None:
        return str(user_id)
    return user.username or user.email or str(user.id)


def record(
    db: Session,
    machine: POSMachine,
    code: PairingCode,
    before: Optional[Dict[str, Any]],
    *,
    device_info: Optional[Dict[str, Any]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Document the replacement the new device just made. The caller commits."""
    now = now or datetime.now(timezone.utc)
    previous = list(getattr(machine, "replacements", None) or [])
    support = getattr(machine, "support_z", None) or None
    last_at = previous[-1].get("at") if previous else None
    # Support's Z of the dead till since the last replacement, if any (§4.6).
    support_first = bool(support and support.get("at") and (last_at is None or str(support["at"]) > str(last_at)))
    entry = {
        "id": str(uuid.uuid4()),
        "at": now.isoformat(),
        "by": _who(db, getattr(code, "distributor_id", None)),
        "byUserId": str(code.distributor_id) if getattr(code, "distributor_id", None) else None,
        "reason": (getattr(code, "replacement_reason", None) or "").strip() or None,
        "codeCreatedAt": _iso(getattr(code, "created_at", None)),
        "oldDevice": (before or {}).get("device") or {},
        "oldLastHeartbeatAt": (before or {}).get("lastHeartbeatAt"),
        "newDevice": device_of(device_info if device_info is not None else getattr(machine, "device_info", None),
                               getattr(machine, "device_model", None)),
        "posNumber": getattr(machine, "pos_number", None),
        "supportZFirst": support_first,
        "supportZ": (
            {k: support.get(k) for k in ("at", "by", "reasonText", "zNumber", "zReportId")}
            if support_first else None
        ),
    }
    machine.replacements = previous + [entry]
    machine.replacement_note_pending = {"id": entry["id"], "at": entry["at"]}
    _audit(db, machine, entry, now)
    logger.warning("till %s replaced: %s", machine.id, entry)
    return entry


def _audit(db: Session, machine: POSMachine, entry: Dict[str, Any], now: datetime) -> None:
    from app.services.exceptions import record_z_exception

    parts = [f"{LABEL} ע״י {entry.get('by') or '—'}"]
    if entry.get("reason"):
        parts.append(entry["reason"])
    old, new = entry.get("oldDevice") or {}, entry.get("newDevice") or {}
    old_id = old.get("serialNumber") or old.get("serial") or old.get("deviceModel")
    new_id = new.get("serialNumber") or new.get("serial") or new.get("deviceModel")
    if old_id or new_id:
        parts.append(f"{old_id or '—'} ← {new_id or '—'}")
    parts.append(
        f"Z הופק מהענן ע״י התמיכה לפני ההחלפה (Z מס׳ {(entry.get('supportZ') or {}).get('zNumber') or '—'})"
        if entry.get("supportZFirst") else "לא הופק Z מהענן לפני ההחלפה"
    )
    try:
        record_z_exception(
            db, machine,
            exception_type=EXCEPTION_TYPE,
            key=f"{EXCEPTION_TYPE}:{machine.id}:{entry['id']}",
            occurred_at=now,
            details={**entry, "summary": " · ".join(parts)},
        )
    except Exception:  # noqa: BLE001 - the replacement is done; the machine keeps the record
        logger.exception("could not record the replacement of till %s", machine.id)


def note_on_z(z, machines: Iterable[POSMachine]) -> None:
    """
    The first Z of a till after its device was replaced says so, once: `devicesReplaced`
    on the header ("המכשיר הוחלף בתאריך …"). Called by the builder.
    """
    notes = []
    for machine in machines:
        pending = getattr(machine, "replacement_note_pending", None)
        if not pending:
            continue
        notes.append({
            "machineId": str(machine.id),
            "posNumber": machine.pos_number,
            "name": machine.name,
            "at": pending.get("at"),
            "id": pending.get("id"),
        })
        machine.replacement_note_pending = None
    if notes:
        z.header = {**(z.header or {}), "devicesReplaced": notes}
