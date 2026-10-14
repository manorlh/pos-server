"""
"מצב סנכרון של מכשיר" (P:/specs/device-sync-status.md §5; app/services/sync_status.py).

Dashboard (user JWT + X-Tenant-Id; the machine's own read rules, as `GET /machines/{id}`):

GET  /machines/sync-status?shopId=|machineIds=   → {generatedAt, items: [status]} — up to 200 devices
                                                  (the devices list's "סנכרון" column, "סנכרן את כל הסניף")
GET  /machines/{machine_id}/sync-status          → one device: per domain ✓ / ⏳ / ✗, last pull, what
                                                  changed and when, the outbox, stale or not

Till (machine JWT):

POST /sync/{machine_id}/sync-state               {syncState, outbox} — after every sync (§5.4); replaced
                                                  whole like the heartbeat's; never refused for its content

"סנכרן עכשיו" itself is the existing `sync_now` command (`POST /device-commands`, its Ably wake).

Registered before the machines router, so `/machines/sync-status` is never read as a machine id.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User, UserRole
from app.services import sync_status as svc
from app.services import sync_versions

router = APIRouter(prefix="/machines", tags=["machines"])
till_router = APIRouter(prefix="/sync", tags=["sync"])

#: The most devices one read compares.
MAX_DEVICES = 200


def _may_read(db: Session, user: User, machine: POSMachine) -> bool:
    """`GET /machines/{id}`'s own rule: a distributor their devices, the others by their shops."""
    from app.routers.machines import _check_machine_list_access

    if user.role == UserRole.DISTRIBUTOR:
        return machine.distributor_id == user.id
    return bool(_check_machine_list_access(user, machine, db))


@router.get("/sync-status")
def list_sync_status(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds", max_length=MAX_DEVICES),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Many devices at once: a shop's (`shopId`) or the ones named (`machineIds`), each as
    `GET /machines/{id}/sync-status` answers it. A device the user may not read is left out.
    """
    if shop_id is None and not machine_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "scope_required", "message": "shopId or machineIds is required"},
        )
    q = db.query(POSMachine).filter(POSMachine.tenant_id == active_tenant_id)
    if machine_ids:
        q = q.filter(POSMachine.id.in_(list(machine_ids)))
    else:
        q = q.filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True))
    machines = [
        m for m in q.order_by(POSMachine.pos_number, POSMachine.name).limit(MAX_DEVICES).all()
        if _may_read(db, current_user, m)
    ]
    now = datetime.now(timezone.utc)
    thresholds = svc.stale_minutes_by_machine(db, machines)
    ctx = sync_versions.VersionContext(db)
    items = [svc.evaluate(ctx, m, now=now, stale_minutes=thresholds.get(str(m.id))) for m in machines]
    for item, m in zip(items, machines):
        item["machineName"] = m.name
        item["posNumber"] = m.pos_number
        item["shopId"] = str(m.shop_id) if m.shop_id else None
    db.rollback()  # a read: nothing a version's computation touched is kept
    return {"generatedAt": now.isoformat(), "items": items}


@router.get("/{machine_id}/sync-status")
def get_sync_status(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One device: its sync report against the cloud's versions now (P:/specs/device-sync-status.md §5.7)."""
    try:
        mid = uuid.UUID(str(machine_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    machine = db.get(POSMachine, mid)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    if not _may_read(db, current_user, machine):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    now = datetime.now(timezone.utc)
    threshold = svc.stale_minutes_by_machine(db, [machine]).get(str(machine.id))
    out = svc.evaluate(sync_versions.VersionContext(db), machine, now=now, stale_minutes=threshold)
    out["generatedAt"] = now.isoformat()
    db.rollback()  # a read
    return out


@till_router.post("/{machine_id}/sync-state")
def post_sync_state(
    machine_id: str,
    body: Any = Body(None),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The till's report after a sync (§5.4): `{syncState, outbox}`, stored as the heartbeat stores
    it. A block that cannot be read is left out — the call itself is never refused for it.
    """
    now = datetime.now(timezone.utc)
    data = body if isinstance(body, dict) else {}
    svc.apply_report(machine, data.get("syncState"), data.get("outbox"), now=now)
    db.commit()
    return {"ok": True, "receivedAt": now.isoformat()}
