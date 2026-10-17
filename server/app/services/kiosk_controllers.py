"""
"שליטה מקופות" — which tills control a kiosk (P:/specs/area-gaps.md §2).

Until now a kiosk's controlling tills were only its explicit list (`kiosk_devices.controller_machine_ids`).
The built-in till parameter `kioskControllerSource` (company → shop → area → the kiosk itself, the deepest
wins) adds the kiosk's point of sale:

* `list` — the default, as before: only the tills in the list.
* `area` — every till of the kiosk's point of sale (same shop and area, active, a fiscal till — never a
  kiosk, a screen or a server). A kiosk with no point of sale has none.
* `both` — the list and the point of sale's tills.

Dynamic: decided on every request from the machines' `area_id` as it is now, so a till moved into or out
of the area gains or loses control at once. The area lock (app/services/area_lock.py) still applies on top.
While no level anywhere holds a value, every kiosk is `list` and nothing is queried beyond that check.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

KEY = "kioskControllerSource"
LIST = "list"
AREA = "area"
BOTH = "both"
SOURCES = (LIST, AREA, BOTH)
DEFAULT = LIST
LABELS = {
    LIST: "רק הקופות שנבחרו (ברירת מחדל)",
    AREA: "כל הקופות של נקודת המכירה של הקיוסק",
    BOTH: "הקופות שנבחרו וגם קופות נקודת המכירה",
}
INVALID_MESSAGE = "שליטה מקופות: list, area או both"

PARAMETER_SPECS = (
    dict(
        key=KEY,
        label="קיוסק — שליטה מקופות",
        value_type="enum",
        enum_options=SOURCES,
        enum_labels=LABELS,
        default_value=DEFAULT,
        description=(
            "אילו קופות שולטות בקיוסק (נעילה ופתיחה, פתיחה אוטומטית, סגירת משמרת / Z, בונים, חסימת פריטים "
            "ומצב עבודה): list — רק הקופות שנבחרו בהגדרות הקיוסק (ברירת המחדל, כמו היום); area — כל הקופות "
            "של נקודת המכירה של הקיוסק, אוטומטית (קופה שעוברת נקודת מכירה מקבלת או מאבדת שליטה מיד); both — "
            "שניהם. קיוסק בלי נקודת מכירה — רק הקופות שנבחרו. נעילת הקופה לנקודת המכירה שלה ממשיכה לחול. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או לקיוסק עצמו."
        ),
    ),
)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def clean(value: Any) -> Optional[str]:
    """A value for the parameter (None = inherit); ValueError otherwise."""
    if value is None:
        return None
    if value not in SOURCES:
        raise ValueError(INVALID_MESSAGE)
    return value


def _parameter(db: Session):
    from app.models.till_parameter import TillParameter

    return db.query(TillParameter).filter(TillParameter.key == KEY).first()


def any_value(db: Session) -> bool:
    """Whether any level holds a value at all (no: every kiosk is `list`, nothing more to read)."""
    from app.models.till_parameter import TillParameterValue

    parameter = _parameter(db)
    if parameter is None or not parameter.is_active:
        return False
    return (
        db.query(TillParameterValue.id).filter(TillParameterValue.parameter_id == parameter.id).first() is not None
    )


def source_of(db: Session, kiosk_machine: Optional[POSMachine]) -> str:
    """`kioskControllerSource` as it resolves for the kiosk (kiosk → area → shop → company → default)."""
    if kiosk_machine is None:
        return DEFAULT
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameterValue
    from app.services.till_parameters import resolve_till_parameters, scope_chain_for_machine

    parameter = _parameter(db)
    if parameter is None or not parameter.is_active:
        return DEFAULT
    chain = scope_chain_for_machine(db, kiosk_machine)
    scopes = chain.scopes()
    if not scopes:
        return DEFAULT
    values = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
        )
        .all()
    )
    value = resolve_till_parameters([parameter], values, chain).parameters.get(KEY)
    return value if value in SOURCES else DEFAULT


def own_value(db: Session, kiosk_machine: POSMachine) -> Optional[str]:
    """The value set on the kiosk itself (None: it inherits)."""
    from app.models.till_parameter import TillParameterValue

    parameter = _parameter(db)
    if parameter is None:
        return None
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == kiosk_machine.id,
        )
        .first()
    )
    value = row.value if row is not None else None
    return value if value in SOURCES else None


def _is_kiosk_by_role(db: Session, machine_id: Any) -> bool:
    from app.models.kiosk import KioskDevice

    row = db.query(KioskDevice).filter(KioskDevice.machine_id == machine_id).first()
    return row is not None and row.home_role is None


def may_control_by_area(db: Session, till: POSMachine) -> bool:
    """A till that may control its point of sale's kiosks: active, fiscal, in an area, never a kiosk itself."""
    return (
        till is not None
        and bool(till.is_active)
        and getattr(till, "is_fiscal", True) is not False
        and till.shop_id is not None
        and till.area_id is not None
        and not _is_kiosk_by_role(db, till.id)
    )


def area_tills(db: Session, kiosk_machine: POSMachine) -> List[POSMachine]:
    """The tills of the kiosk's point of sale (empty for a kiosk with none)."""
    if kiosk_machine is None or kiosk_machine.area_id is None or kiosk_machine.shop_id is None:
        return []
    rows = (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == kiosk_machine.shop_id,
            POSMachine.area_id == kiosk_machine.area_id,
            POSMachine.is_active.is_(True),
            POSMachine.id != kiosk_machine.id,
        )
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    return [m for m in rows if getattr(m, "is_fiscal", True) is not False and not _is_kiosk_by_role(db, m.id)]


def is_controller(db: Session, till: POSMachine, device: Any, kiosk_machine: Optional[POSMachine] = None) -> bool:
    """Whether `till` controls the kiosk `device` (same tenant is the caller's check)."""
    listed = str(till.id) in {str(c) for c in (getattr(device, "controller_machine_ids", None) or [])}
    if not any_value(db):
        return listed
    kiosk_machine = kiosk_machine or db.get(POSMachine, device.machine_id)
    source = source_of(db, kiosk_machine)
    if source == LIST:
        return listed
    in_area = (
        kiosk_machine is not None
        and kiosk_machine.area_id is not None
        and str(till.id) != str(kiosk_machine.id)
        and str(till.shop_id) == str(kiosk_machine.shop_id)
        and str(till.area_id) == str(kiosk_machine.area_id)
        and may_control_by_area(db, till)
    )
    if source == AREA:
        return in_area
    return listed or in_area


def controlled_ids(db: Session, till: POSMachine, devices: Iterable[Any]) -> Set[str]:
    """The machine ids (strings) of `devices` this till controls — one parameter check when nothing is set."""
    devices = list(devices)
    if not any_value(db):
        return {
            str(d.machine_id) for d in devices
            if str(till.id) in {str(c) for c in (d.controller_machine_ids or [])}
        }
    ids = [d.machine_id for d in devices]
    machines: Dict[str, POSMachine] = (
        {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()} if ids else {}
    )
    return {str(d.machine_id) for d in devices if is_controller(db, till, d, machines.get(str(d.machine_id)))}


def summary_fields(db: Session, kiosk_machine: POSMachine, device: Any, names: Dict[Any, Any]) -> Dict[str, Any]:
    """`controllerSource`, `controllerSourceOwn`, `areaControllers` for a kiosk's summary."""
    source = source_of(db, kiosk_machine) if any_value(db) else DEFAULT
    area = area_tills(db, kiosk_machine) if source in (AREA, BOTH) else []
    listed = [str(c) for c in (getattr(device, "controller_machine_ids", None) or [])]
    effective: List[str] = [] if source == AREA else list(listed)
    for m in area:
        if str(m.id) not in effective:
            effective.append(str(m.id))
    return {
        "controllerSource": source,
        "controllerSourceOwn": own_value(db, kiosk_machine) if any_value(db) else None,
        "areaControllers": [{"machineId": str(m.id), "name": m.name} for m in area],
        "controllersEffective": effective,
    }


def set_source(db: Session, kiosk_machine: POSMachine, value: Optional[str], user: Any, *, now: Optional[datetime] = None) -> None:
    """The kiosk's own value (None clears — it inherits again), recorded in the parameters' log. 422 if invalid."""
    from app.models.till_parameter import TillParameterValue
    from app.services import till_parameter_audit as AUDIT
    from app.services.till_parameters import ensure_builtin_parameters

    try:
        value = clean(value)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    now = now or datetime.now(timezone.utc)
    ensure_builtin_parameters(db)
    parameter = _parameter(db)
    if parameter is None:  # pragma: no cover - created just above
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="parameter missing")
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == kiosk_machine.id,
        )
        .first()
    )
    old = row.value if row is not None else None
    if old == value:
        return
    if value is None:
        if row is not None:
            db.delete(row)
        action = AUDIT.CLEAR
    else:
        if row is None:
            db.add(TillParameterValue(
                id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=kiosk_machine.id, value=value,
            ))
        else:
            row.value = value
        action = AUDIT.SET
    AUDIT.record_change(
        db, parameter=parameter, scope_type="machine", scope_id=kiosk_machine.id,
        action=action, old_value=old, new_value=value, user=user, now=now,
    )
    parameter.updated_at = now
    db.flush()
