"""
Device groups ("קבוצת מכשירים") — the one hook every feature reads them through.

The `machine_groups` model is being added on another branch (menus by device group). Until it is
merged into this base no device is in a group and no group exists: `groups_of` answers [] and
`group` None, so a block (or anything else) scoped to a group reaches nobody and cannot be created.
Wire the model here, and only here, at merge.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session


def _model():
    try:
        from app.models.machine_group import MachineGroup, MachineGroupMember  # type: ignore
    except Exception:  # noqa: BLE001 - not in this base
        return None
    return MachineGroup, MachineGroupMember  # pragma: no cover - wired at merge


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
    if model is None or machine_id is None:
        return []
    _group, member = model  # pragma: no cover - wired at merge
    rows = db.query(member.group_id).filter(member.machine_id == machine_id).all()  # pragma: no cover
    return [r[0] for r in rows]  # pragma: no cover


def group(db: Session, group_id: Any) -> Optional[Dict[str, Any]]:
    """`{"id", "name", "shopId", "machineIds"}`, or None."""
    model = _model()
    ident = _uuid(group_id)
    if model is None or ident is None:
        return None
    group_cls, member = model  # pragma: no cover - wired at merge
    row = db.get(group_cls, ident)  # pragma: no cover
    if row is None:  # pragma: no cover
        return None
    members = db.query(member.machine_id).filter(member.group_id == row.id).all()  # pragma: no cover
    return {  # pragma: no cover
        "id": row.id, "name": getattr(row, "name", None), "shopId": getattr(row, "shop_id", None),
        "machineIds": [m[0] for m in members],
    }
