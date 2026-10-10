"""
Device groups ("קבוצת מכשירים") — the one hook every feature reads them through.

Wired at the integration merge (09.10.2026) to feat/menu-groups' model (app/models/machine_group.py:
`MachineGroup` — a named group of tills across the shops of ONE company — and its members). A group
here is `{"id", "name", "tenantId", "companyId", "shopId", "machineIds"}`:

* `companyId` — the group's company: who may act on the whole group (a company scope);
* `shopId` — the one shop all its members stand in, else None (a group across shops);
* `machineIds` — its active members.

Blocks ("חסימות ואזל", app/services/sold_out.py) and remote control (app/routers/device_commands.py)
read groups only through here; the groups themselves are made and edited by
app/services/machine_groups.py ("קבוצות מכשירים" under ארגון › מכשירים).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session


def _model():
    try:
        from app.models.machine_group import MachineGroup, MachineGroupMember
    except Exception:  # noqa: BLE001 - a base without device groups
        return None
    return MachineGroup, MachineGroupMember


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def available() -> bool:
    return _model() is not None


def groups_of(db: Session, machine_id: Any) -> List[Any]:
    """The ids of the groups a device is in."""
    model = _model()
    ident = _uuid(machine_id)
    if model is None or ident is None:
        return []
    _group, member = model
    return [r[0] for r in db.query(member.group_id).filter(member.machine_id == ident).all()]


def _members(db: Session, group_ids: List[Any]) -> Dict[Any, List[Any]]:
    """Each group's ACTIVE members: `{group_id: [(machine_id, shop_id), ...]}`."""
    from app.models.pos_machine import POSMachine

    model = _model()
    if model is None or not group_ids:
        return {}
    _group, member = model
    rows = (
        db.query(member.group_id, POSMachine.id, POSMachine.shop_id)
        .join(POSMachine, POSMachine.id == member.machine_id)
        .filter(member.group_id.in_(group_ids), POSMachine.is_active.is_(True))
        .all()
    )
    out: Dict[Any, List[Any]] = {}
    for gid, mid, sid in rows:
        out.setdefault(gid, []).append((mid, sid))
    return out


def _view(row, members: List[Any]) -> Dict[str, Any]:
    shops = {sid for _mid, sid in members if sid is not None}
    return {
        "id": row.id,
        "name": getattr(row, "name", None),
        "tenantId": row.tenant_id,
        "companyId": row.company_id,
        "shopId": next(iter(shops)) if len(shops) == 1 else None,
        "machineIds": [mid for mid, _sid in members],
    }


def group(db: Session, group_id: Any, tenant_id: Any = None) -> Optional[Dict[str, Any]]:
    """The group (see the module's docstring), or None — also for another tenant's when `tenant_id` is given."""
    model = _model()
    ident = _uuid(group_id)
    if model is None or ident is None:
        return None
    group_cls, _member = model
    row = db.get(group_cls, ident)
    if row is None or (tenant_id is not None and str(row.tenant_id) != str(tenant_id)):
        return None
    return _view(row, _members(db, [row.id]).get(row.id, []))


def for_shop(db: Session, shop) -> List[Dict[str, Any]]:
    """The groups with an active member in this shop (the block scope picker of that shop), by name."""
    from app.models.pos_machine import POSMachine

    model = _model()
    if model is None or shop is None:
        return []
    group_cls, member = model
    ids = [
        r[0] for r in db.query(member.group_id)
        .join(POSMachine, POSMachine.id == member.machine_id)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .distinct().all()
    ]
    if not ids:
        return []
    rows = db.query(group_cls).filter(group_cls.id.in_(ids), group_cls.tenant_id == shop.tenant_id).all()
    members = _members(db, [r.id for r in rows])
    return sorted((_view(r, members.get(r.id, [])) for r in rows), key=lambda g: (g["name"] or "", str(g["id"])))
