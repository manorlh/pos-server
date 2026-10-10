"""
"נעילת הקופה לנקודת המכירה שלה" — the area lock (docs/SPEC_AREA_LOCK.md).

The owner, 09.10.2026: a device assigned to a point of sale (an area of the shop,
`pos_machines.area_id`) is locked to that point of sale only — dynamic in the cloud,
through the till-parameter layers company → shop → area → till.

The till parameter `areaScopeLock` (boolean, **default on**) decides it per till. It has
an effect only when the till stands in an area: a till without one sees its whole shop,
as before. When it is on, every till-facing endpoint that reads or acts on data of other
tills of the shop narrows that to the tills of the same area (`pos_machines.area_id`),
and acting on another area's document / table / kiosk is refused with
`{"detail": "area_locked", "message": <Hebrew>}`.

**Never fiscal.** Document numbering, the Z's scope and the shop-Z participation do not
read this lock: a Z follows the work configuration (docs/SPEC_DEVICE_WORK_CONFIG.md) exactly
as before. Selling is never blocked by it — only reads and acts on other tills' data.

**Dashboard users are unaffected.** `/sync/{machine_id}/…` also admits a dashboard user
(`get_pos_machine_for_sync_path`); that path marks the machine row (`mark_dashboard_caller`),
and a marked row is never locked.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

AREA_SCOPE_LOCK_KEY = "areaScopeLock"

#: Registered with the other built-in till parameters (app/services/till_parameters.py).
AREA_LOCK_PARAMETER_SPECS = (
    dict(
        key=AREA_SCOPE_LOCK_KEY,
        label="נעילת הקופה לנקודת המכירה שלה",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל וקופה משויכת לנקודת מכירה (אזור בסניף): הקופה רואה ופועלת רק על הנתונים של נקודת המכירה "
            "שלה — מסמכים מ-24 השעות האחרונות וזיכוי שלהם, עסקאות מושהות, שולחנות, קיוסקים, מדפסות, התראות "
            "ומסכי KDS של הקופות באותה נקודת מכירה בלבד. פעולה על מסמך, שולחן או קיוסק של נקודת מכירה אחרת "
            "נחסמת עם הודעה. קופה בלי נקודת מכירה — כמו היום (כל הסניף). "
            "לא משנה את מספור המסמכים, את היקף ה-Z ואת ההשתתפות ב-Z הסניפי — אלה לפי תצורת העבודה. "
            "המכירה עצמה לעולם לא נחסמת. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)

#: The refusal code, and its Hebrew message per kind of target.
AREA_LOCKED = "area_locked"
MESSAGES: Dict[str, str] = {
    "document": "המסמך שייך לנקודת מכירה אחרת",
    "table": "השולחן שייך לנקודת מכירה אחרת",
    "held_sale": "העסקה המושהית שייכת לנקודת מכירה אחרת",
    "kiosk": "הקיוסק שייך לנקודת מכירה אחרת",
    "order": "ההזמנה שייכת לנקודת מכירה אחרת",
    "device": "המכשיר שייך לנקודת מכירה אחרת",
    "reservation": "ההזמנה לשולחן שייכת לנקודת מכירה אחרת",
}

#: Set on a machine row loaded for a dashboard user on a till path (`get_pos_machine_for_sync_path`).
_DASHBOARD_CALLER_ATTR = "_area_lock_dashboard_caller"


def mark_dashboard_caller(machine: POSMachine) -> None:
    """The machine row was loaded for a dashboard user, not by its own token: never locked."""
    try:
        setattr(machine, _DASHBOARD_CALLER_ATTR, True)
    except Exception:  # pragma: no cover - a frozen test double
        pass


def is_dashboard_caller(machine: Any) -> bool:
    return bool(getattr(machine, _DASHBOARD_CALLER_ATTR, False) is True)


def _as_uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def parameter_value(db: Session, machine: POSMachine) -> bool:
    """
    `areaScopeLock` as it resolves for this till (till → area → shop → company → default).

    Missing definition, inactive definition, or no value anywhere: the default, on.
    """
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import resolve_till_parameters, scope_chain_for_machine

    parameter = db.query(TillParameter).filter(TillParameter.key == AREA_SCOPE_LOCK_KEY).first()
    if parameter is None or not parameter.is_active:
        return True
    chain = scope_chain_for_machine(db, machine)
    scopes = chain.scopes()
    values = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
        )
        .all()
        if scopes
        else []
    )
    resolved = resolve_till_parameters([parameter], values, chain).parameters
    value = resolved.get(AREA_SCOPE_LOCK_KEY)
    return True if value is None else bool(value)


@dataclass(frozen=True)
class AreaScope:
    """What a till may see of its shop: everything (`locked` False) or one area."""

    shop_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID]
    area_name: Optional[str]
    locked: bool

    def covers_shared(self, area_id: Any) -> bool:
        """
        A shop resource that may stand in an area or serve the whole shop (a kiosk, a zone, a
        printer): visible while open, and when locked if it is the till's area's or has none.
        """
        if not self.locked:
            return True
        ident = _as_uuid(area_id)
        return ident is None or ident == self.area_id

    def as_json(self) -> Optional[Dict[str, Any]]:
        """`{areaId, areaName}` while locked, else None (the whole shop)."""
        if not self.locked:
            return None
        return {"areaId": str(self.area_id), "areaName": self.area_name}


def scope_for(db: Session, machine: Optional[POSMachine]) -> AreaScope:
    """The scope a till's request runs in. Open for a dashboard caller and an area-less till."""
    if machine is None:
        return AreaScope(shop_id=None, area_id=None, area_name=None, locked=False)
    shop_id = _as_uuid(getattr(machine, "shop_id", None))
    area_id = _as_uuid(getattr(machine, "area_id", None))
    if shop_id is None or area_id is None or is_dashboard_caller(machine):
        return AreaScope(shop_id=shop_id, area_id=area_id, area_name=None, locked=False)
    from app.models.shop_area import ShopArea

    area = db.query(ShopArea).filter(ShopArea.id == area_id).first()
    # A dangling or foreign area id (never written by the services) locks nothing.
    if area is None or _as_uuid(area.shop_id) != shop_id:
        return AreaScope(shop_id=shop_id, area_id=None, area_name=None, locked=False)
    if not parameter_value(db, machine):
        return AreaScope(shop_id=shop_id, area_id=area_id, area_name=area.name, locked=False)
    return AreaScope(shop_id=shop_id, area_id=area_id, area_name=area.name, locked=True)


def is_locked(db: Session, machine: Optional[POSMachine]) -> bool:
    return scope_for(db, machine).locked


def area_machine_ids(db: Session, scope: AreaScope) -> Set[uuid.UUID]:
    """The ids of the machines of the scope's area (every machine row, active or not)."""
    if not scope.locked:
        return set()
    rows = (
        db.query(POSMachine.id)
        .filter(POSMachine.shop_id == scope.shop_id, POSMachine.area_id == scope.area_id)
        .all()
    )
    return {_as_uuid(r[0]) for r in rows}


class AreaLocked(HTTPException):
    """
    Acting on another area's row. Answered `{"detail": "area_locked", "message": <Hebrew>,
    "kind": …}` by `area_locked_handler` (app/main.py); without the handler it is still a plain
    `{"detail": "area_locked"}` of the same status (like `DeviceNotFiscal`).
    """

    def __init__(self, kind: str = "document", status_code: int = status.HTTP_403_FORBIDDEN):
        super().__init__(status_code=status_code, detail=AREA_LOCKED)
        self.kind = kind
        self.body: Dict[str, Any] = {"detail": AREA_LOCKED, "message": message_for(kind), "kind": kind}


def message_for(kind: str) -> str:
    return MESSAGES.get(kind, MESSAGES["document"])


async def area_locked_handler(request: Any, exc: AreaLocked):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=exc.status_code, content=exc.body, headers=exc.headers)


def refusal(kind: str = "document") -> AreaLocked:
    return AreaLocked(kind)


def require_shared_device(db: Session, till: POSMachine, device: Any, kind: str = "device") -> None:
    """
    Refuse (403 `area_locked`) acting on a device (a kiosk, another till) of another area. A device
    without an area serves the whole shop and stays reachable.
    """
    if device is None:
        return
    scope = scope_for(db, till)
    if not scope.covers_shared(getattr(device, "area_id", None)):
        raise refusal(kind)


def keep_shared_devices(db: Session, till: POSMachine, items: Iterable[Any], area_of) -> List[Any]:
    """`items` whose device (`area_of(item)` → its area id) is the till's area's or has none, while locked."""
    scope = scope_for(db, till)
    items = list(items)
    if not scope.locked:
        return items
    return [i for i in items if scope.covers_shared(area_of(i))]


def areas_of_machines(db: Session, machine_ids: Iterable[Any]) -> Dict[uuid.UUID, Optional[uuid.UUID]]:
    """machine id → its area id (None for none), for the ids given."""
    ids = [i for i in {_as_uuid(x) for x in machine_ids} if i is not None]
    if not ids:
        return {}
    return {_as_uuid(r[0]): _as_uuid(r[1]) for r in db.query(POSMachine.id, POSMachine.area_id).filter(POSMachine.id.in_(ids)).all()}
