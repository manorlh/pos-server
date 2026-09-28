"""
Producing a Z from the dashboard (docs/SHIFTS_API.md §2.3–§2.7).

Producing a Z needs the roles that could close a day before (`get_current_machine_admin`:
company manager, shop manager, distributor, super admin), and access to the shop.
"""
from __future__ import annotations

import uuid
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_machine_admin
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers.shops import _check_shop_access
from app.schemas.z_run import (
    ActiveRunOut,
    ZCandidateMachineOut,
    ZCandidatesOut,
    ZRunCreateIn,
    ZRunOut,
    ZRunProceedIn,
)
from app.routers.machines import _awaiting_z_by_machine, _tenant_timezones, check_shift_admin_access
from app.services.machine_status import StatusInput, resolve_status
from app.services.remote_close import close_shift_pending_machine_ids
from app.services.shifts import orphan_documents_by_machine, shift_to_out
from app.services import z_runs as ZR

router = APIRouter(tags=["z-runs"])


def _shop_for(db: Session, shop_id, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    # A shop with no tenant belongs to no tenant the caller acts in — never a pass.
    # (`ensure_same_tenant` lets a NULL through, which is right for legacy machines only.)
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    _check_shop_access(user, shop, db)
    return shop


def _is_distributor(user: User) -> bool:
    return user.role == UserRole.DISTRIBUTOR


def _check_tills(db: Session, user: User, machines: Iterable[POSMachine], tenant_id) -> None:
    """
    A distributor acts only on their own terminals.

    Shop access admits any distributor to any shop of the tenant, which let one produce a
    Z over — or read the candidates of — another distributor's tills. The same per-till
    rule as a remote or administrative close (`check_shift_admin_access`) applies here to
    every till a run takes or a read shows. Other roles are bounded by the shop itself.
    """
    if not _is_distributor(user):
        return
    for machine in machines:
        check_shift_admin_access(db, machine, user, tenant_id)


def _tenant(db: Session, tenant_id) -> Tenant:
    return db.query(Tenant).filter(Tenant.id == tenant_id).first()


def _run_or_404(db: Session, run_id: uuid.UUID, user: User, tenant_id) -> "ZR.ZRun":
    run = ZR.get_run(db, run_id, tenant_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z run not found")
    _shop_for(db, run.shop_id, user, tenant_id)
    _check_tills(db, user, [i.machine for i in run.items if i.machine is not None], tenant_id)
    return run


def _summary(shift):
    out = shift_to_out(shift)
    out.till_totals = None
    out.reconstruction_basis = None
    return out


@router.get(
    "/shops/{shop_id}/z-candidates",
    response_model=ZCandidatesOut,
    response_model_by_alias=True,
)
def get_z_candidates(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Per till of the shop: reachability, open shift, and closed shifts awaiting a Z."""
    shop = _shop_for(db, shop_id, current_user, active_tenant_id)
    if ZR.expire_overdue_runs(db):
        db.commit()
    tills = ZR.shop_tills(db, shop.id)
    if _is_distributor(current_user):
        # Only their own terminals: another distributor's tills are not listed at all.
        tills = [m for m in tills if str(m.distributor_id) == str(current_user.id)]
        _check_tills(db, current_user, tills, active_tenant_id)
    ids = [m.id for m in tills]
    live = ZR._live_items(db, ids)
    orphans = orphan_documents_by_machine(db, ids)
    # The same readings the machines page feeds the status light.
    pending_close = close_shift_pending_machine_ids(db, ids)
    awaiting = _awaiting_z_by_machine(db, ids)
    timezones = _tenant_timezones(db, tills)
    machines = []
    for machine in tills:
        cand = ZR.till_candidates(db, machine, shop.id)
        light = resolve_status(
            StatusInput(
                is_active=bool(machine.is_active),
                pairing_status=(
                    machine.pairing_status.value
                    if hasattr(machine.pairing_status, "value")
                    else machine.pairing_status
                ),
                last_heartbeat_at=machine.last_heartbeat_at,
                shift_open=cand.open_shift is not None,
                business_date=cand.open_shift.business_date if cand.open_shift else None,
                close_shift_pending=machine.id in pending_close,
                oldest_awaiting_z_date=awaiting.get(machine.id, (0, None))[1],
                timezone_name=timezones.get(machine.tenant_id),
                pending_documents=machine.pending_documents,
                pending_count=machine.pending_count,
                pending_count_at=machine.pending_count_at,
                clock_skew_ms=machine.clock_skew_ms,
                battery_percent=machine.battery_percent,
                mqtt_connected=machine.mqtt_connected,
            )
        )
        item = live.get(machine.id)
        seated = ZR.is_seated_in(machine, shop.id)
        machines.append(
            ZCandidateMachineOut(
                machine_id=machine.id,
                machine_name=machine.name,
                pos_number=machine.pos_number,
                online=light.online,
                status=light.status,
                pending_documents=light.pending_documents,
                pending_as_of=light.pending_as_of,
                open_shift=_summary(cand.open_shift) if cand.open_shift is not None else None,
                # Only a claim a close instruction could still answer (UI-4): not one for a
                # shift the cloud holds closed, not another till's, not a retired till's.
                till_reported_open_shift_id=(
                    machine.reported_open_shift_id
                    if seated and ZR._reported_open_is_live(db, machine)
                    else None
                ),
                closed_shifts=[_summary(s) for s in cand.closed],
                active_run=ActiveRunOut(run_id=item.run_id, item_status=item.status) if item else None,
                orphan_documents=orphans.get(machine.id, 0),
                in_shop=seated,
                is_active=bool(machine.is_active),
            )
        )
    return ZCandidatesOut(
        shop_id=shop.id,
        shop_name=shop.name,
        z_scope=ZR.z_scope_of(_tenant(db, active_tenant_id)),
        machines=machines,
    )


@router.post(
    "/z-runs",
    response_model=ZRunOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def post_z_run(
    body: ZRunCreateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Start a Z for one shop. Multi-shop from the UI is one call per shop."""
    shop = _shop_for(db, body.shop_id, current_user, active_tenant_id)
    if _is_distributor(current_user):
        wanted = [m.machine_id for m in body.machines]
        found = db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all() if wanted else []
        if len({m.id for m in found}) != len(set(wanted)):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        _check_tills(db, current_user, found, active_tenant_id)
    run = ZR.create_z_run(
        db,
        current_user,
        _tenant(db, active_tenant_id),
        shop,
        [
            ZR.MachineSelection(
                machine_id=m.machine_id,
                through_shift_id=m.through_shift_id,
                include_open_shift=m.include_open_shift,
            )
            for m in body.machines
        ],
        business_date=body.business_date,
    )
    db.commit()
    db.refresh(run)
    return ZR.run_to_out(db, run)


@router.get("/z-runs/{run_id}", response_model=ZRunOut, response_model_by_alias=True)
def get_z_run(
    run_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Progress. Also sweeps expiry, and builds the Z if every item became ready."""
    run = _run_or_404(db, run_id, current_user, active_tenant_id)
    changed = ZR.expire_overdue_runs(db)
    changed = ZR.finalise_if_ready(db, run) or changed
    if changed:
        db.commit()
        db.refresh(run)
    return ZR.run_to_out(db, run)


@router.post("/z-runs/{run_id}/proceed", response_model=ZRunOut, response_model_by_alias=True)
def post_z_run_proceed(
    run_id: uuid.UUID,
    body: ZRunProceedIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Build now without the listed tills; their shifts wait for the next Z."""
    run = _run_or_404(db, run_id, current_user, active_tenant_id)
    ZR.proceed_without(db, run, body.exclude_machine_ids)
    db.commit()
    db.refresh(run)
    return ZR.run_to_out(db, run)


@router.post("/z-runs/{run_id}/cancel", response_model=ZRunOut, response_model_by_alias=True)
def post_z_run_cancel(
    run_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    run = _run_or_404(db, run_id, current_user, active_tenant_id)
    ZR.cancel_run(db, run)
    db.commit()
    db.refresh(run)
    return ZR.run_to_out(db, run)
