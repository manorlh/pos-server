"""
Z runs: producing a shop's Z from the dashboard (shifts-plan §4.5, docs/SHIFTS_API.md §2).

An operator picks a shop and, per till, "up to which shift". A till that still has an
open shift is asked to close it (Ably now, the heartbeat on its next beat); its item
becomes ready only when that close is **accepted** — every document on the cloud. When
every item is ready or excluded the Z is built (`app.services.z_builder`). A till that
never answers can be left out (`proceed`), and an unfinished run expires after 36 h.

The till-facing half — acknowledgements, the heartbeat handover, completion on an
accepted close — is here too, behind `app.services.remote_close`.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User
from app.models.z_run import (
    LIVE_ITEM_STATUSES,
    PENDING_ITEM_STATUSES,
    ZRun,
    ZRunItem,
    ZRunItemStatus,
    ZRunStatus,
)
from app.services.machine_status import is_online
from app.services.z_builder import ZBuildRefused, build_z, shift_order_key, unreported_shifts

logger = logging.getLogger(__name__)

#: How long an unfinished run stays worth finishing — long enough for a till that is off
#: overnight, short enough that it cannot close a shift nobody expects a Z for any more.
Z_RUN_TTL_HOURS = 36

Z_SCOPE_SHOP = "shop"
Z_SCOPE_MACHINE = "machine"


def z_scope_of(tenant: Optional[Tenant]) -> str:
    """The tenant's `zScope` setting: one Z per shop (default) or one till per Z."""
    raw = ((tenant.settings or {}) if tenant is not None else {}).get("zScope")
    return Z_SCOPE_MACHINE if raw == Z_SCOPE_MACHINE else Z_SCOPE_SHOP


# ── Candidates ────────────────────────────────────────────────────────────────


def shop_tills(db: Session, shop_id: uuid.UUID) -> List[POSMachine]:
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop_id,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
        )
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )


def _live_items(db: Session, machine_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, ZRunItem]:
    if not machine_ids:
        return {}
    rows = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(list(machine_ids)),
            ZRunItem.status.in_(LIVE_ITEM_STATUSES),
            ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]),
        )
        .all()
    )
    return {item.machine_id: item for item in rows}


@dataclass
class TillCandidates:
    machine: POSMachine
    open_shift: Optional[Shift]
    closed: List[Shift]


def till_candidates(db: Session, machine: POSMachine) -> TillCandidates:
    shifts = unreported_shifts(db, machine.id)
    open_shift = next((s for s in shifts if s.status == ShiftStatus.OPEN), None)
    closed = [s for s in shifts if s.status == ShiftStatus.CLOSED]
    # Only closed shifts *before* any open one can be taken without closing it first.
    if open_shift is not None:
        closed = [s for s in closed if shift_order_key(s) < shift_order_key(open_shift)]
    return TillCandidates(machine=machine, open_shift=open_shift, closed=closed)


# ── Expiry ────────────────────────────────────────────────────────────────────


def expire_overdue_runs(db: Session, *, now: Optional[datetime] = None) -> int:
    """
    Retire what nobody finished within the TTL. Lazy — there is no scheduler here — and
    called from every read and write path, so an open dashboard sees it happen.

    The items still waiting for a till expire; the operator can then `proceed` without
    them. A run left with nothing ready expires as a whole.
    """
    now = now or datetime.now(timezone.utc)
    runs = (
        db.query(ZRun)
        .filter(ZRun.status == ZRunStatus.WAITING, ZRun.expires_at < now)
        .all()
    )
    changed = 0
    for run in runs:
        for item in run.items:
            if item.status in PENDING_ITEM_STATUSES:
                item.status = ZRunItemStatus.EXPIRED
                item.error_code = "expired"
                item.error_message = "The till did not close its shift in time"
                item.failed_at = now
                changed += 1
        if not any(i.status == ZRunItemStatus.READY for i in run.items):
            run.status = ZRunStatus.EXPIRED
            run.error_code = "expired"
            run.error_message = "The Z run was not finished in time"
            changed += 1
    return changed


# ── Create ────────────────────────────────────────────────────────────────────


@dataclass
class MachineSelection:
    machine_id: uuid.UUID
    through_shift_id: Optional[uuid.UUID] = None
    include_open_shift: Optional[bool] = None


def _reported_open_is_live(db: Session, machine: POSMachine) -> bool:
    """
    The till says it has a shift open that the cloud may not have heard of yet.

    Ignored when the cloud already holds that shift closed: the claim is only refreshed
    on the next heartbeat, and a close-shift instruction for a closed shift would never
    be answered.
    """
    claimed = machine.reported_open_shift_id
    if claimed is None:
        return False
    known = db.query(Shift.status).filter(Shift.id == claimed).first()
    return known is None or known[0] == ShiftStatus.OPEN


def _initiator(user: User) -> str:
    return user.username or user.email or str(user.id)


def _send_close(machine: POSMachine, item: ZRunItem, user: User, now: datetime) -> None:
    from app.services.ably_notify import publish_close_shift_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay, not a failure: the till collects it on its next heartbeat.
        return
    publish_close_shift_notify(
        str(machine.tenant_id),
        str(machine.id),
        str(item.id),
        str(item.close_shift_id) if item.close_shift_id else None,
        _initiator(user),
    )
    item.sent_at = now


def create_z_run(
    db: Session,
    user: User,
    tenant: Tenant,
    shop: Shop,
    selections: Sequence[MachineSelection],
    *,
    business_date: Optional[date] = None,
    now: Optional[datetime] = None,
) -> ZRun:
    """Start a run (and build at once when nothing needs closing). Raises HTTPException."""
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)

    if not selections:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no_machines")
    wanted = list(dict.fromkeys(sel.machine_id for sel in selections))
    if z_scope_of(tenant) == Z_SCOPE_MACHINE and len(wanted) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="z_scope_machine_one_till"
        )

    tills = {m.id: m for m in shop_tills(db, shop.id)}
    for machine_id in wanted:
        if machine_id not in tills:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=f"machine_not_in_shop:{machine_id}"
            )

    live = _live_items(db, wanted)
    if live:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"z_run_in_progress:{next(iter(live.values())).run_id}",
        )

    run = ZRun(
        id=uuid.uuid4(),
        tenant_id=tenant.id,
        shop_id=shop.id,
        created_by_user_id=user.id,
        status=ZRunStatus.WAITING,
        business_date=business_date,
        expires_at=now + timedelta(hours=Z_RUN_TTL_HOURS),
    )
    db.add(run)
    db.flush()

    by_id = {sel.machine_id: sel for sel in selections}
    to_notify: List[tuple] = []
    for machine_id in wanted:
        sel = by_id[machine_id]
        machine = tills[machine_id]
        cand = till_candidates(db, machine)
        reported_open = _reported_open_is_live(db, machine)
        has_open = cand.open_shift is not None or reported_open
        include_open = has_open if sel.include_open_shift is None else bool(sel.include_open_shift)
        include_open = include_open and has_open

        item = ZRunItem(id=uuid.uuid4(), run_id=run.id, machine_id=machine_id, include_open_shift=include_open)
        if include_open:
            if sel.through_shift_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="through_shift_with_open_shift"
                )
            item.status = ZRunItemStatus.WAITING_CLOSE
            item.close_shift_id = (
                cand.open_shift.id if cand.open_shift is not None else machine.reported_open_shift_id
            )
            item.through_shift_id = cand.open_shift.id if cand.open_shift is not None else None
            to_notify.append((machine, item))
        elif sel.through_shift_id is not None:
            if sel.through_shift_id not in {s.id for s in cand.closed}:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"through_shift_not_candidate:{machine_id}",
                )
            item.status = ZRunItemStatus.READY
            item.through_shift_id = sel.through_shift_id
            item.ready_at = now
        elif cand.closed:
            item.status = ZRunItemStatus.READY
            item.through_shift_id = cand.closed[-1].id
            item.ready_at = now
        else:
            item.status = ZRunItemStatus.EXCLUDED
            item.error_code = "nothing_to_report"
            item.error_message = "No closed shift waiting for a Z"
        db.add(item)

    db.flush()
    db.refresh(run)
    if all(i.status == ZRunItemStatus.EXCLUDED for i in run.items):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="nothing_to_report")

    for machine, item in to_notify:
        _send_close(machine, item, user, now)
    finalise_if_ready(db, run, now=now)
    return run


# ── Finalise / proceed / cancel ───────────────────────────────────────────────


def _selections(db: Session, run: ZRun):
    ready = [i for i in run.items if i.status == ZRunItemStatus.READY]
    machines = {
        m.id: m
        for m in db.query(POSMachine).filter(POSMachine.id.in_([i.machine_id for i in ready])).all()
    } if ready else {}
    return [(machines[i.machine_id], i.through_shift_id) for i in ready]


def lock_run(db: Session, run: ZRun) -> ZRun:
    """
    Re-read `run` and its items under a row lock on the run.

    Two tills whose closes complete a run at the same moment would otherwise each see the
    other's item still closing and neither would build; a dashboard poll and a till close
    could both build. Serialising on the run row, and reading the items fresh after the
    lock, makes exactly one of them see the whole picture.
    """
    db.flush()
    locked = (
        db.query(ZRun)
        .filter(ZRun.id == run.id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    db.query(ZRunItem).filter(ZRunItem.run_id == locked.id).populate_existing().all()
    return locked


def finalise_if_ready(db: Session, run: ZRun, *, now: Optional[datetime] = None) -> bool:
    """
    Build the Z when every item is ready or excluded. Returns True if it was built.

    Never raises for a refused build: the run is marked failed with the reason, and the
    caller's own work (a till's accepted close, say) still commits. The build runs in a
    savepoint so a refusal leaves nothing of it behind.
    """
    run = lock_run(db, run)
    if run.status != ZRunStatus.WAITING:
        return False
    statuses = [i.status for i in run.items]
    if not statuses or any(s not in (ZRunItemStatus.READY, ZRunItemStatus.EXCLUDED) for s in statuses):
        return False
    if not any(s == ZRunItemStatus.READY for s in statuses):
        return False
    now = now or datetime.now(timezone.utc)
    savepoint = db.begin_nested()
    try:
        z = build_z(
            db,
            tenant_id=run.tenant_id,
            shop_id=run.shop_id,
            selections=_selections(db, run),
            created_by_user_id=run.created_by_user_id,
            z_run_id=run.id,
            business_date=run.business_date,
            now=now,
        )
        savepoint.commit()
    except ZBuildRefused as refused:
        savepoint.rollback()
        logger.warning("Z run %s refused: %s (%s)", run.id, refused.code, refused.message)
        run.status = ZRunStatus.FAILED
        run.error_code = refused.code
        run.error_message = refused.message
        db.flush()
        return False
    run.status = ZRunStatus.COMPLETED
    run.z_report_id = z.id
    run.completed_at = now
    db.flush()
    return True


def _require_waiting(run: ZRun) -> None:
    if run.status != ZRunStatus.WAITING:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="run_not_waiting")


def proceed_without(
    db: Session, run: ZRun, exclude_machine_ids: Iterable[uuid.UUID], *, now: Optional[datetime] = None
) -> ZRun:
    """Build now without the listed tills; their shifts wait for the next Z (no gap)."""
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)
    _require_waiting(run)
    excluded = set(exclude_machine_ids)
    for item in run.items:
        if item.machine_id in excluded and item.status != ZRunItemStatus.EXCLUDED:
            item.status = ZRunItemStatus.EXCLUDED
            item.error_code = item.error_code or "excluded_by_operator"
    not_ready = [
        str(i.machine_id)
        for i in run.items
        if i.status not in (ZRunItemStatus.READY, ZRunItemStatus.EXCLUDED)
    ]
    if not_ready:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "items_not_ready", "machineIds": not_ready},
        )
    if not any(i.status == ZRunItemStatus.READY for i in run.items):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="nothing_to_report")
    finalise_if_ready(db, run, now=now)
    return run


def cancel_run(db: Session, run: ZRun) -> ZRun:
    _require_waiting(run)
    for item in run.items:
        if item.status != ZRunItemStatus.EXCLUDED:
            item.status = ZRunItemStatus.EXCLUDED
            item.error_code = "cancelled"
    run.status = ZRunStatus.CANCELLED
    db.flush()
    return run


def get_run(db: Session, run_id: uuid.UUID, tenant_id: uuid.UUID) -> Optional[ZRun]:
    return (
        db.query(ZRun)
        .options(joinedload(ZRun.items).joinedload(ZRunItem.machine))
        .filter(ZRun.id == run_id, ZRun.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def _item_for_till(db: Session, machine: POSMachine, item_id: uuid.UUID) -> Optional[ZRunItem]:
    return (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.id == item_id,
            ZRunItem.machine_id == machine.id,
            ZRun.tenant_id == machine.tenant_id,
        )
        .first()
    )


def apply_close_shift_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    shift_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> ZRunItem:
    """A till's acknowledgement of a close-shift instruction (`request_id` = item id)."""
    now = now or datetime.now(timezone.utc)
    item = _item_for_till(db, machine, request_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="close_request_not_found")
    run = item.run
    if run.status != ZRunStatus.WAITING or item.status not in PENDING_ITEM_STATUSES:
        # Cancelled, expired, finished, or already ready: accepted and changes nothing.
        return item

    if phase in ("received", "deferred"):
        item.status = ZRunItemStatus.CLOSING
        item.received_at = item.received_at or now
        if phase == "deferred":
            item.error_code = error_code or "deferred"
            item.error_message = error_message
        else:
            item.error_code = None
            item.error_message = None
        if shift_id is not None and item.close_shift_id is None:
            item.close_shift_id = shift_id
    elif phase == "completed":
        # Informational. The item becomes ready when the close itself is accepted.
        pass
    elif phase == "failed":
        item.status = ZRunItemStatus.FAILED
        item.error_code = error_code or "failed"
        item.error_message = error_message
        item.failed_at = now
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")
    db.flush()
    return item


def on_shift_close_accepted(
    db: Session, machine: POSMachine, shift: Shift, *, now: Optional[datetime] = None
) -> Optional[ZRunItem]:
    """
    The cloud now holds every document of `shift` and has closed it.

    A run waiting for this till's close has its item made ready — through this shift —
    and is finalised if that was the last one. Matched by the instruction id the close
    carried, else by the shift the run asked to close, else by the till's only waiting
    item (the run may not have known the shift's id if its open had not synced).
    """
    now = now or datetime.now(timezone.utc)
    items = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine.id,
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .all()
    )
    if not items:
        return None
    match = next((i for i in items if shift.close_request_item_id and i.id == shift.close_request_item_id), None)
    match = match or next((i for i in items if i.close_shift_id == shift.id), None)
    match = match or next((i for i in items if i.close_shift_id is None), None)
    if match is None:
        return None
    run = lock_run(db, match.run)
    if run.status != ZRunStatus.WAITING or match.status not in PENDING_ITEM_STATUSES:
        return None
    match.status = ZRunItemStatus.READY
    match.close_shift_id = shift.id
    match.through_shift_id = shift.id
    match.ready_at = now
    match.error_code = None
    match.error_message = None
    db.flush()
    finalise_if_ready(db, match.run, now=now)
    return match


def take_pending_close_shift(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """The instruction to hand this till on its heartbeat, as `{requestId, shiftId}`."""
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)
    item = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine.id,
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .order_by(ZRunItem.created_at.asc())
        .first()
    )
    if item is None:
        return None
    if item.sent_at is None:
        item.sent_at = now
    return {
        "requestId": str(item.id),
        "shiftId": str(item.close_shift_id) if item.close_shift_id else None,
    }


def close_shift_pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    if not machine_ids:
        return set()
    rows = (
        db.query(ZRunItem.machine_id)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(machine_ids),
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .all()
    )
    return {r[0] for r in rows}


# ── Out ───────────────────────────────────────────────────────────────────────


def run_to_out(db: Session, run: ZRun) -> dict:
    z_number = None
    if run.z_report_id is not None:
        from app.models.z_report import ZReport

        z = db.query(ZReport).filter(ZReport.id == run.z_report_id).first()
        z_number = z.shop_sequence_number if z is not None else None
    return {
        "id": run.id,
        "shopId": run.shop_id,
        "status": run.status,
        "businessDate": run.business_date,
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
        "expiresAt": run.expires_at,
        "createdByUserId": run.created_by_user_id,
        "zReportId": run.z_report_id,
        "zNumber": z_number,
        "errorCode": run.error_code,
        "errorMessage": run.error_message,
        "items": [
            {
                "id": i.id,
                "machineId": i.machine_id,
                "machineName": i.machine.name if i.machine is not None else None,
                "throughShiftId": i.through_shift_id,
                "closeShiftId": i.close_shift_id,
                "status": i.status,
                "errorCode": i.error_code,
                "errorMessage": i.error_message,
                "sentAt": i.sent_at,
                "receivedAt": i.received_at,
                "readyAt": i.ready_at,
                "updatedAt": i.updated_at,
            }
            for i in run.items
        ],
    }
