"""Cloud-initiated close-day orchestration."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set
import uuid

from fastapi import HTTPException, status
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
from app.services.transactions import find_open_trading_day

MQTT_ONLINE_WINDOW_SEC = 90
PENDING_ITEM_STATUSES = (
    CloseDayItemStatus.PENDING,
    CloseDayItemStatus.SENT,
    CloseDayItemStatus.RECEIVED,
)


def machine_is_mqtt_online(machine: POSMachine, now: Optional[datetime] = None) -> bool:
    if not machine.last_heartbeat_at:
        return False
    ref = now or datetime.now(timezone.utc)
    hb = machine.last_heartbeat_at
    if hb.tzinfo is None:
        hb = hb.replace(tzinfo=timezone.utc)
    return (ref - hb).total_seconds() <= MQTT_ONLINE_WINDOW_SEC


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


def resolve_machines_for_close_day(
    db: Session,
    current_user: User,
    active_tenant_id: uuid.UUID,
    *,
    machine_ids: Optional[List[uuid.UUID]] = None,
    shop_id: Optional[uuid.UUID] = None,
) -> List[POSMachine]:
    if not machine_ids and not shop_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide machineIds or shopId")

    query = db.query(POSMachine).filter(
        POSMachine.is_active.is_(True),
        POSMachine.pairing_status == PairingStatus.ASSIGNED,
    )
    if current_user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == current_user.id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        from app.models.shop import Shop

        shop_ids = db.query(Shop.id).filter(Shop.company_id == current_user.company_id)
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    elif current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(POSMachine.shop_id == current_user.shop_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    query = query.filter(POSMachine.tenant_id == active_tenant_id)

    if shop_id:
        query = query.filter(POSMachine.shop_id == shop_id)
    if machine_ids:
        query = query.filter(POSMachine.id.in_(machine_ids))

    machines = query.all()
    if machine_ids and len(machines) != len(set(machine_ids)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="One or more machines not found")
    if not machines:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No eligible machines")
    return machines


def create_close_day_request(
    db: Session,
    current_user: User,
    active_tenant_id: uuid.UUID,
    machines: List[POSMachine],
    *,
    shop_id: Optional[uuid.UUID] = None,
) -> CloseDayRequest:
    from app.services.mqtt import mqtt_service

    now = datetime.now(timezone.utc)
    machine_ids = [m.id for m in machines]
    open_days = get_open_trading_days_for_machines(db, machine_ids)
    pending_ids = get_pending_close_day_machine_ids(db, machine_ids)

    request = CloseDayRequest(
        tenant_id=active_tenant_id,
        initiated_by_user_id=current_user.id,
        shop_id=shop_id,
        status=CloseDayRequestStatus.PENDING,
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
            item.status = CloseDayItemStatus.FAILED
            item.error_code = "machine_offline"
            item.error_message = "Machine is offline (no recent MQTT heartbeat)"
            item.failed_at = now
        else:
            mqtt_service.publish_close_day_notify(
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
