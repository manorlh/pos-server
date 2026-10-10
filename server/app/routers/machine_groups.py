"""
"קבוצות מכשירים" — named groups of tills across the shops of one company, a level a catalog menu
("תפריטים") can be assigned to (app/services/machine_groups.py).

GET    /machine-groups                    → the groups the user sees (`companyId`: that company
                                            and those beneath it), with their tills
POST   /machine-groups                    → `{name, companyId, machineIds}`
PATCH  /machine-groups/{id}               → `{name?, sortOrder?}`
PUT    /machine-groups/{id}/machines      → `{machineIds}`, the members replaced
DELETE /machine-groups/{id}               → the group, its members and the menus assigned to it

Every write bumps the organization's menus and wakes its tills after the commit (catalog notify,
reason `catalog_menus_updated`), so each till's next pull carries its groups and their menus.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.schemas.machine_group import MachineGroupCreate, MachineGroupMembersIn, MachineGroupUpdate
from app.services import catalog_menus as CM
from app.services import machine_groups as G

router = APIRouter(prefix="/machine-groups", tags=["machine-groups"])


def _changed(db: Session, tenant_id, background_tasks: BackgroundTasks) -> None:
    targets = CM.notify_targets(db, tenant_id)
    db.commit()
    background_tasks.add_task(CM.publish_notify, targets)


def _one(db: Session, user: User, tenant_id, group_id):
    for g in G.list_groups(db, user, tenant_id):
        if g["id"] == str(group_id):
            return g
    return None


@router.get("")
def list_machine_groups(
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return G.list_groups(db, current_user, active_tenant_id, company_id=G._as_uuid(company_id))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_machine_group(
    body: MachineGroupCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = G.create(
        db, current_user, active_tenant_id, company_id=body.company_id, name=body.name, machine_ids=body.machine_ids,
    )
    _changed(db, active_tenant_id, background_tasks)
    return _one(db, current_user, active_tenant_id, group.id)


@router.patch("/{group_id}")
def update_machine_group(
    group_id: str,
    body: MachineGroupUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = G.rename(db, current_user, active_tenant_id, group_id, name=body.name, sort_order=body.sort_order)
    _changed(db, active_tenant_id, background_tasks)
    return _one(db, current_user, active_tenant_id, group.id)


@router.put("/{group_id}/machines")
def set_machine_group_members(
    group_id: str,
    body: MachineGroupMembersIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = G.set_members(db, current_user, active_tenant_id, group_id, body.machine_ids)
    _changed(db, active_tenant_id, background_tasks)
    return _one(db, current_user, active_tenant_id, group.id)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_machine_group(
    group_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    G.delete(db, current_user, active_tenant_id, group_id)
    _changed(db, active_tenant_id, background_tasks)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
