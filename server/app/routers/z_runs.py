"""
Producing a Z from the dashboard (docs/SHIFTS_API.md §2.3–§2.7).

Producing a Z needs the roles that could close a day before (`get_current_machine_admin`:
company manager, shop manager, distributor, super admin), and access to the shop.
"""
from __future__ import annotations

import uuid
from typing import Iterable, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
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
from app.services import areas
from app.services import main_till as MT
from app.services import z_runs as ZR
from app.services import z_state
from app.services.till_z import TillZRefused, z_mode_of
from fastapi.responses import JSONResponse

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


def _initiator_name(user: User) -> str:
    return user.username or user.email or str(user.id)


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
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Per till of the shop: reachability, open shift, and closed shifts awaiting a Z.

    `areaId`: only the tills in that area now (`400 area_not_in_shop`). A till's shifts
    are listed whatever area they are stamped with — the Z is about the till.
    """
    shop = _shop_for(db, shop_id, current_user, active_tenant_id)
    area = (
        areas.area_in_shop(db, area_id, shop.id)
        if isinstance(area_id, uuid.UUID)
        else None
    )
    if ZR.expire_overdue_runs(db):
        db.commit()
    tills = ZR.shop_tills(db, shop.id)
    if area is not None:
        # Seated here and in the area now. A till only stranded here by its old shifts
        # has left every area of this shop with its shop, so it cannot be one of these.
        tills = [m for m in tills if str(m.area_id) == str(area.id) and ZR.is_seated_in(m, shop.id)]
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
    tenant = _tenant(db, active_tenant_id)
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
                # "till": it produces its own Z (§5) — the wizard asks it rather than
                # taking it into the shop's run, which refuses it.
                z_mode=z_mode_of(machine),
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
                area_id=machine.area_id,
                area_name=machine.area_name,
                data_state=z_state.till_state(db, machine),
            )
        )
    return ZCandidatesOut(
        shop_id=shop.id,
        shop_name=shop.name,
        area_id=area.id if area is not None else None,
        area_name=area.name if area is not None else None,
        z_scope=ZR.z_scope_of(tenant),
        open_tills_rule=ZR.open_tills_rule(db, tenant, shop),
        machines=machines,
        main_till=MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        dashboard_z_blocked=MT.dashboard_z_refusal(db, shop) is not None,
    )


def _require_cloud_data_confirmation(db: Session, shop, body: ZRunCreateIn, active_tenant_id) -> None:
    """
    `409 {code: cloud_data_confirmation_required, tills}` while a till the run takes shows
    a warning and `confirmCloudData` is not given. A till that produces its own Z is not
    taken by the run, and not checked here.
    """
    if body.confirm_cloud_data:
        return
    own_z = ZR.per_till_ids(db, ZR.shop_tills(db, shop.id), _tenant(db, active_tenant_id), shop)
    wanted = [m.machine_id for m in body.machines if m.machine_id not in own_z]
    machines = db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all() if wanted else []
    flagged = [s for s in z_state.states(db, machines) if s["warnings"]]
    if flagged:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "cloud_data_confirmation_required",
                "message": "יש קופות עם משמרות, מסמכים או דוחות Z שלא הגיעו לענן — יש לאשר שהנתונים בענן הם הנתונים הקיימים.",
                "tills": flagged,
            },
        )


def _note_cloud_data_confirmation(db: Session, run, shop, body: ZRunCreateIn, user: User, active_tenant_id) -> None:
    """Who confirmed the cloud's data for this run, when, and the state the tills were in."""
    from datetime import datetime, timezone

    own_z = ZR.per_till_ids(db, ZR.shop_tills(db, shop.id), _tenant(db, active_tenant_id), shop)
    wanted = [m.machine_id for m in body.machines if m.machine_id not in own_z]
    machines = db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all() if wanted else []
    flagged = [s for s in z_state.states(db, machines) if s["warnings"]]
    if flagged:
        run.cloud_data_confirmation = {
            "by": user.username or user.email or str(user.id),
            "byUserId": str(user.id),
            "at": datetime.now(timezone.utc).isoformat(),
            "text": z_state.CONFIRMATION_TEXT,
            "tills": flagged,
        }


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
    """
    Start a Z for one shop. Multi-shop from the UI is one call per shop.

    409 `{code: open_tills_block_z | open_tills_need_confirmation, tills}` when a shop Z
    would leave tills with open (or un-Z'd) shifts behind and the shop's `shopZOpenTills`
    parameter forbids it, or wants `confirmOpenTills: true` first.
    """
    out = create_run_from_body(db, current_user, active_tenant_id, body)
    if isinstance(out, JSONResponse):
        return out
    run = out
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
    # Who decided to go without them, frozen on the Z with the tills (`openTillsLeftOut`).
    ZR.proceed_without(db, run, body.exclude_machine_ids, deferred_by=_initiator_name(current_user))
    db.commit()
    db.refresh(run)
    return ZR.run_to_out(db, run)


class ZRunForceIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    exclude_machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="excludeMachineIds", max_length=500)
    #: Typed by the super admin: why the Z goes without these tills (on the Z and the record).
    reason: str = Field(..., max_length=300)


@router.post("/z-runs/{run_id}/force", response_model=ZRunOut, response_model_by_alias=True)
def post_z_run_force(
    run_id: uuid.UUID,
    body: ZRunForceIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Support's force ("חסימת Z כשיש משמרות פתוחות", app/services/z_shift_guard.py): a super
    admin builds the Z without the listed tills, with a typed reason — recorded on the Z and
    as an exception; their shifts go into the next Z. 403 for anyone else, 422 without a reason.
    """
    from app.services import remote_till_z
    from app.services import z_shift_guard

    remote_till_z.require_enabled()  # off: no such route — everything exactly as before
    run = _run_or_404(db, run_id, current_user, active_tenant_id)
    z_shift_guard.force_without(db, run, current_user, body.exclude_machine_ids, body.reason)
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
    ZR.cancel_run(db, run, cancelled_by=_initiator_name(current_user))
    db.commit()
    db.refresh(run)
    return ZR.run_to_out(db, run)


def create_run_from_body(db: Session, current_user: User, active_tenant_id, body: ZRunCreateIn, *, wait_for_rest: bool = False):
    """
    The one way a shop's cloud Z run starts — the dashboard's wizard and remote control's "סגירת
    יום סניפית" alike (app/services/remote_till_z.py, `wait_for_rest`): the same refusals, the
    same confirmations, the same run. Returns the run (not committed), or the refusal response.
    """
    shop = _shop_for(db, body.shop_id, current_user, active_tenant_id)
    # "Z only from the main till" (app/services/main_till.py): a shop Z of a shop that has
    # one is started there, not here — 409 `z_only_from_main_till`. A till's own Z ("Z לכל
    # קופה") is not a shop Z and stays the dashboard's to start.
    refusal = MT.dashboard_z_refusal(db, shop)
    if refusal is not None:
        own_z = ZR.per_till_ids(db, ZR.shop_tills(db, shop.id), _tenant(db, active_tenant_id), shop)
        if any(m.machine_id not in own_z for m in body.machines):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=refusal)
    if _is_distributor(current_user):
        wanted = [m.machine_id for m in body.machines]
        found = db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all() if wanted else []
        if len({m.id for m in found}) != len(set(wanted)):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        _check_tills(db, current_user, found, active_tenant_id)
    # The state before a Z from the cloud (docs/SPEC_OFFLINE_TILL_Z.md §4.6.1): a till the
    # run takes that shows a warning is taken only on the operator's explicit word.
    _require_cloud_data_confirmation(db, shop, body, active_tenant_id)
    try:
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
            area_id=body.area_id,
            confirm_open_tills=body.confirm_open_tills,
            force=body.force,
            wait_for_rest=wait_for_rest,
        )
        if body.confirm_cloud_data:
            _note_cloud_data_confirmation(db, run, shop, body, current_user, active_tenant_id)
    except TillZRefused as refused:
        # `422 machine_issues_its_own_z` with the till's id beside the detail (§5.4).
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    return run
