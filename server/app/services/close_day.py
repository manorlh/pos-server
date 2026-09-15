"""Cloud-initiated close-day orchestration."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set
import uuid

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.models.close_day import (
    CloseDayItemStatus,
    CloseDayRequest,
    CloseDayRequestItem,
    CloseDayRequestStatus,
)
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.trading_day import TradingDay, TradingDayStatus
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.services.machine_status import ONLINE_WINDOW_SEC, is_online
from app.services.transactions import find_open_trading_day
from app.services.permission_matrix import SHOP_SCOPED_ROLES

#: Kept as a re-export so existing callers and tests keep their name, but there is now
#: exactly one definition of the window and it lives in `machine_status`. Two copies of
#: this threshold meant the dashboard and this module could disagree about whether a
#: terminal was reachable.
MQTT_ONLINE_WINDOW_SEC = ONLINE_WINDOW_SEC
PENDING_ITEM_STATUSES = (
    CloseDayItemStatus.PENDING,
    CloseDayItemStatus.SENT,
    CloseDayItemStatus.RECEIVED,
)


def machine_is_mqtt_online(machine: POSMachine, now: Optional[datetime] = None) -> bool:
    """Delegates, so this and the dashboard's status light cannot drift apart."""
    return is_online(machine.last_heartbeat_at, now=now)


def get_pending_close_day_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    if not machine_ids:
        return set()
    rows = (
        db.query(CloseDayRequestItem.machine_id)
        .filter(
            CloseDayRequestItem.machine_id.in_(machine_ids),
            CloseDayRequestItem.status.in_(PENDING_ITEM_STATUSES),
        )
        .all()
    )
    return {r[0] for r in rows}


def get_open_trading_days_for_machines(
    db: Session, machine_ids: List[uuid.UUID]
) -> Dict[uuid.UUID, TradingDay]:
    if not machine_ids:
        return {}
    rows = (
        db.query(TradingDay)
        .filter(
            TradingDay.machine_id.in_(machine_ids),
            TradingDay.status == TradingDayStatus.OPEN,
        )
        .all()
    )
    out: Dict[uuid.UUID, TradingDay] = {}
    for td in rows:
        existing = out.get(td.machine_id)
        if existing is None or td.opened_at > existing.opened_at:
            out[td.machine_id] = td
    return out


def trading_day_status_for_machine(
    db: Session, machine_id: uuid.UUID, open_td: Optional[TradingDay]
) -> str:
    if open_td is not None:
        return "open"
    return "none"


def _recompute_request_status(request: CloseDayRequest) -> None:
    items = request.items
    if not items:
        request.status = CloseDayRequestStatus.FAILED
        return
    statuses = [item.status for item in items]
    if all(s == CloseDayItemStatus.COMPLETED for s in statuses):
        request.status = CloseDayRequestStatus.COMPLETED
    elif all(s in (CloseDayItemStatus.FAILED, CloseDayItemStatus.CANCELLED, CloseDayItemStatus.EXPIRED) for s in statuses):
        request.status = CloseDayRequestStatus.FAILED
    elif any(s == CloseDayItemStatus.COMPLETED for s in statuses) and any(
        s in (CloseDayItemStatus.FAILED, CloseDayItemStatus.CANCELLED, CloseDayItemStatus.EXPIRED) for s in statuses
    ):
        request.status = CloseDayRequestStatus.PARTIAL
    elif any(s in PENDING_ITEM_STATUSES for s in statuses):
        request.status = CloseDayRequestStatus.IN_PROGRESS
    else:
        request.status = CloseDayRequestStatus.IN_PROGRESS


def _item_to_out(item: CloseDayRequestItem, machine_name: Optional[str] = None) -> dict:
    name = machine_name
    if name is None and item.machine is not None:
        name = item.machine.name
    status_val = item.status.value if hasattr(item.status, "value") else item.status
    return {
        "id": item.id,
        "machineId": item.machine_id,
        "machineName": name,
        "tradingDayId": item.trading_day_id,
        "zReportId": item.z_report_id,
        "status": status_val,
        "errorCode": item.error_code,
        "errorMessage": item.error_message,
        "sentAt": item.sent_at,
        "receivedAt": item.received_at,
        "completedAt": item.completed_at,
        "failedAt": item.failed_at,
    }


#: How long an undelivered instruction stays worth delivering.
#:
#: Long enough to cover a till that is off overnight and comes back for the morning
#: shift; short enough that it cannot close a day nobody is expecting a Z for any more.
CLOSE_DAY_TTL_HOURS = 36


def expire_overdue_close_day_items(db: Session, *, now: Optional[datetime] = None) -> int:
    """
    Retire instructions that were never collected.

    Lazy rather than scheduled: there is no scheduler in this service, and a sweep that
    only runs when somebody looks is enough for a horizon measured in hours. Called
    from the read and create paths, so a dashboard that is open sees it happen.

    Only undelivered work expires. An item a till has already acknowledged is its
    business to finish or fail, and overwriting that would lose the fact that a terminal
    tried.
    """
    now = now or datetime.now(timezone.utc)
    items = (
        db.query(CloseDayRequestItem)
        .join(CloseDayRequest, CloseDayRequestItem.request_id == CloseDayRequest.id)
        .filter(
            CloseDayRequestItem.status.in_(
                [CloseDayItemStatus.PENDING, CloseDayItemStatus.SENT]
            ),
            CloseDayRequest.expires_at.is_not(None),
            CloseDayRequest.expires_at < now,
        )
        .all()
    )
    for item in items:
        item.status = CloseDayItemStatus.EXPIRED
        item.error_code = "expired"
        item.error_message = "The terminal did not collect this instruction in time"
        item.failed_at = now
        db.add(item)
    if items:
        for request in {item.request for item in items if item.request is not None}:
            _recompute_request_status(request)
    return len(items)


def take_pending_close_day_for_machine(
    db: Session, machine: POSMachine, *, now: Optional[datetime] = None
) -> Optional[CloseDayRequestItem]:
    """
    The instruction this terminal should act on, if any — the pull half of delivery.

    Called from the heartbeat, which every till already sends on a timer. That is what
    makes an offline terminal a non-problem: nothing has to reach it, it asks. Ably
    stays as the fast path for a till that is awake, but it is no longer the only one,
    and a dropped notification is no longer a close that never happens.

    Marks the item SENT on handing it over, so the dashboard can tell "waiting for the
    till" from "the till has it".
    """
    now = now or datetime.now(timezone.utc)
    expire_overdue_close_day_items(db, now=now)
    item = (
        db.query(CloseDayRequestItem)
        .join(CloseDayRequest, CloseDayRequestItem.request_id == CloseDayRequest.id)
        .filter(
            CloseDayRequestItem.machine_id == machine.id,
            CloseDayRequestItem.status.in_(
                [CloseDayItemStatus.PENDING, CloseDayItemStatus.SENT]
            ),
        )
        .order_by(CloseDayRequestItem.created_at.asc())
        .first()
    )
    if item is None:
        return None
    if item.status == CloseDayItemStatus.PENDING:
        item.status = CloseDayItemStatus.SENT
        item.sent_at = now
        db.add(item)
    return item


def resolve_machines_for_close_day(
    db: Session,
    current_user: User,
    active_tenant_id: uuid.UUID,
    *,
    machine_ids: Optional[List[uuid.UUID]] = None,
    shop_id: Optional[uuid.UUID] = None,
    shop_ids: Optional[List[uuid.UUID]] = None,
) -> List[POSMachine]:
    """
    Resolve a close-day selection to a set of machines.

    Three ways to say it, and they combine: named machines, one shop, or several
    shops. `shop_id` is kept beside `shop_ids` because the shipped dashboard sends
    the singular form; it is folded into the list rather than handled twice.

    The result is a *set* — picking two shops that happen to share a terminal, or
    naming a machine that is also in a chosen shop, must not queue two closes for it.
    """
    wanted_shops = list(shop_ids or [])
    if shop_id and shop_id not in wanted_shops:
        wanted_shops.append(shop_id)
    if not machine_ids and not wanted_shops:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide machineIds, shopId or shopIds",
        )

    query = db.query(POSMachine).filter(
        POSMachine.is_active.is_(True),
        POSMachine.pairing_status == PairingStatus.ASSIGNED,
    )
    if current_user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == current_user.id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        from app.services.company_hierarchy import visible_shop_ids

        query = query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, current_user)))
    elif current_user.role in SHOP_SCOPED_ROLES:
        query = query.filter(POSMachine.shop_id == current_user.shop_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    query = query.filter(POSMachine.tenant_id == active_tenant_id)

    # Named machines OR machines in a chosen shop — a union, not an intersection, so
    # "these two tills plus everything in the Dizengoff branch" means what it says.
    clauses = []
    if wanted_shops:
        clauses.append(POSMachine.shop_id.in_(wanted_shops))
    if machine_ids:
        clauses.append(POSMachine.id.in_(machine_ids))
    query = query.filter(or_(*clauses) if len(clauses) > 1 else clauses[0])

    machines = query.all()
    if machine_ids:
        found = {m.id for m in machines}
        missing = set(machine_ids) - found
        if missing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="One or more machines not found",
            )

    machines = _drop_shop_machines_without_an_open_day(db, machines, machine_ids)

    if not machines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No machines with an open trading day",
        )
    return machines


def _drop_shop_machines_without_an_open_day(
    db: Session, machines: List[POSMachine], machine_ids: Optional[List[uuid.UUID]]
) -> List[POSMachine]:
    """
    Keep a shop's already-closed tills out of the request, but not a named one.

    "Close the Dizengoff branch" means "close what is open there". Queuing an item for
    each till that had already closed produced a request reporting four failures and two
    successes on a six-till shop that behaved perfectly — and a result screen that cries
    wolf is one people stop reading.

    A till the operator ticked *by name* is deliberately kept. They pointed at that
    terminal, so silently dropping it answers nothing; the `no_open_day` item tells them
    why it did not close, which is the thing they actually wanted to know.
    """
    named = {str(mid) for mid in (machine_ids or [])}
    shop_derived = [m for m in machines if str(m.id) not in named]
    if not shop_derived:
        return machines

    open_days = get_open_trading_days_for_machines(db, [m.id for m in shop_derived])
    return [
        m for m in machines
        if str(m.id) in named or m.id in open_days
    ]


def create_close_day_request(
    db: Session,
    current_user: User,
    active_tenant_id: uuid.UUID,
    machines: List[POSMachine],
    *,
    shop_id: Optional[uuid.UUID] = None,
    ttl_hours: Optional[int] = None,
) -> CloseDayRequest:
    from app.services.ably_notify import publish_close_day_notify

    now = datetime.now(timezone.utc)
    machine_ids = [m.id for m in machines]
    open_days = get_open_trading_days_for_machines(db, machine_ids)
    pending_ids = get_pending_close_day_machine_ids(db, machine_ids)

    request = CloseDayRequest(
        tenant_id=active_tenant_id,
        initiated_by_user_id=current_user.id,
        shop_id=shop_id,
        status=CloseDayRequestStatus.PENDING,
        expires_at=now + timedelta(hours=ttl_hours or CLOSE_DAY_TTL_HOURS),
    )
    db.add(request)
    db.flush()

    initiator_name = current_user.username or current_user.email or str(current_user.id)

    for machine in machines:
        td = open_days.get(machine.id)
        item = CloseDayRequestItem(
            request_id=request.id,
            machine_id=machine.id,
            trading_day_id=td.id if td else None,
            status=CloseDayItemStatus.PENDING,
        )

        if machine.id in pending_ids:
            item.status = CloseDayItemStatus.FAILED
            item.error_code = "close_already_pending"
            item.error_message = "A close-day request is already in progress for this machine"
            item.failed_at = now
        elif td is None:
            item.status = CloseDayItemStatus.FAILED
            item.error_code = "no_open_day"
            item.error_message = "No open trading day on server for this machine"
            item.failed_at = now
        elif not machine.tenant_id:
            item.status = CloseDayItemStatus.FAILED
            item.error_code = "no_tenant"
            item.error_message = "Machine missing tenant context"
            item.failed_at = now
        elif not machine_is_mqtt_online(machine, now):
            # Offline is a delay, not a failure. It used to fail here on a
            # ninety-second heartbeat window, so a till that happened to be
            # mid-reboot was written off and nothing ever told it. The instruction
            # stays PENDING and the terminal collects it on its next heartbeat —
            # which it sends on a timer regardless — so it closes when it wakes.
            # `expires_at` is what stops this waiting forever.
            item.status = CloseDayItemStatus.PENDING
        else:
            publish_close_day_notify(
                str(machine.tenant_id),
                str(machine.id),
                str(request.id),
                initiator_name,
            )
            item.status = CloseDayItemStatus.SENT
            item.sent_at = now

        db.add(item)

    db.flush()
    db.refresh(request)
    _recompute_request_status(request)
    db.commit()
    db.refresh(request)
    return request


def get_close_day_request(
    db: Session,
    request_id: uuid.UUID,
    active_tenant_id: uuid.UUID,
) -> Optional[CloseDayRequest]:
    return (
        db.query(CloseDayRequest)
        .options(
            joinedload(CloseDayRequest.items).joinedload(CloseDayRequestItem.machine),
        )
        .filter(CloseDayRequest.id == request_id, CloseDayRequest.tenant_id == active_tenant_id)
        .first()
    )


def request_to_out(request: CloseDayRequest) -> dict:
    status_val = request.status.value if hasattr(request.status, "value") else request.status
    return {
        "id": request.id,
        "status": status_val,
        "shopId": request.shop_id,
        "createdAt": request.created_at,
        "updatedAt": request.updated_at,
        "items": [_item_to_out(i) for i in request.items],
    }


def create_response_out(request: CloseDayRequest) -> dict:
    status_val = request.status.value if hasattr(request.status, "value") else request.status
    return {
        "requestId": request.id,
        "status": status_val,
        "items": [_item_to_out(i) for i in request.items],
    }


def apply_close_day_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    z_report_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> CloseDayRequestItem:
    now = datetime.now(timezone.utc)
    item = (
        db.query(CloseDayRequestItem)
        .join(CloseDayRequest, CloseDayRequest.id == CloseDayRequestItem.request_id)
        .filter(
            CloseDayRequestItem.request_id == request_id,
            CloseDayRequestItem.machine_id == machine.id,
            CloseDayRequest.tenant_id == machine.tenant_id,
        )
        .first()
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Close-day request item not found")

    if phase == "received":
        if item.status in (CloseDayItemStatus.SENT, CloseDayItemStatus.RECEIVED):
            item.status = CloseDayItemStatus.RECEIVED
            item.received_at = item.received_at or now
    elif phase == "completed":
        if z_report_id:
            zr = db.query(ZReport).filter(ZReport.id == z_report_id, ZReport.machine_id == machine.id).first()
            if not zr:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="zReportId not found for machine")
            item.z_report_id = zr.id
            item.trading_day_id = zr.trading_day_id
        item.status = CloseDayItemStatus.COMPLETED
        item.completed_at = now
    elif phase == "failed":
        item.status = CloseDayItemStatus.FAILED
        item.error_code = error_code or "failed"
        item.error_message = error_message
        item.failed_at = now
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")

    db.flush()
    request = db.query(CloseDayRequest).filter(CloseDayRequest.id == request_id).first()
    if request:
        _recompute_request_status(request)
    db.commit()
    db.refresh(item)
    return item


def complete_close_day_item_for_z_report(
    db: Session,
    machine_id: uuid.UUID,
    request_id: uuid.UUID,
    z_report_id: uuid.UUID,
) -> None:
    """Auto-complete pending item when z-report includes requestId."""
    item = (
        db.query(CloseDayRequestItem)
        .filter(
            CloseDayRequestItem.request_id == request_id,
            CloseDayRequestItem.machine_id == machine_id,
            CloseDayRequestItem.status.in_(PENDING_ITEM_STATUSES),
        )
        .first()
    )
    if item is None:
        return
    now = datetime.now(timezone.utc)
    item.status = CloseDayItemStatus.COMPLETED
    item.z_report_id = z_report_id
    item.completed_at = now
    zr = db.query(ZReport).filter(ZReport.id == z_report_id).first()
    if zr:
        item.trading_day_id = zr.trading_day_id
    request = db.query(CloseDayRequest).filter(CloseDayRequest.id == request_id).first()
    if request:
        _recompute_request_status(request)
