import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, ConfigDict, Field
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from sqlalchemy.exc import IntegrityError
from app.database import get_db
from app.schemas.pos_machine import POSMachineUpdate, POSMachineResponse, MachineHeartbeatBody
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.user import User, UserRole
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.models.trading_day import TradingDay
from app.models.sync_log import SyncLog
from app.models.pairing_code import PairingCode
from app.models.device_pairing_request import DevicePairingRequest
from app.models.product import Product
from app.models.category import Category
from app.middleware.auth import (
    get_current_user,
    get_current_distributor,
    get_current_machine_admin,
    get_pos_machine_from_machine_token,
    get_active_tenant_id,
    ensure_same_tenant,
)
from app.services.sync import (
    update_machine_sync_timestamp,
    update_machine_heartbeat,
    get_catalog_change_watermark_for_machine,
)
from app.services.catalog_notify import notify_machine_catalog_changed
from app.services.company_hierarchy import user_covers_company, visible_shop_ids
from app.services.shop_validation import shop_belongs_to_company
from app.services.realtime_info import (
    machine_realtime_connection_info,
    machine_realtime_refresh_info,
)
from app.services.machine_status import StatusInput, resolve_status
from app.services.administrative_close import reconstruct_z_report
from app.services.pairing import create_pairing_code
from app.services.transactions import find_open_trading_day
from app.services.permission_matrix import SHOP_SCOPED_ROLES
from app.services.close_day import (
    get_open_trading_days_for_machines,
    get_pending_close_day_machine_ids,
    take_pending_close_day_for_machine,
)

router = APIRouter(prefix="/machines", tags=["machines"])


def _scope_machines_by_tenant(query, current_user: User, active_tenant_id):
    """Include legacy paired machines with null tenant_id for their pairing distributor."""
    if current_user.role == UserRole.DISTRIBUTOR:
        return query.filter(
            or_(
                POSMachine.tenant_id == active_tenant_id,
                and_(
                    POSMachine.tenant_id.is_(None),
                    POSMachine.distributor_id == current_user.id,
                ),
            )
        )
    return query.filter(POSMachine.tenant_id == active_tenant_id)


def _enrich_machine_status(
    machine: POSMachine,
    db: Session,
    *,
    open_trading_days: Optional[Dict[uuid_mod.UUID, TradingDay]] = None,
    pending_close_ids: Optional[set] = None,
) -> Dict[str, Any]:
    last_catalog_change_at = get_catalog_change_watermark_for_machine(db, machine)
    last_sync_at = machine.last_sync_at
    catalog_pull_stale = False
    if last_catalog_change_at is not None:
        if last_sync_at is None:
            catalog_pull_stale = True
        else:
            catalog_pull_stale = (last_sync_at + timedelta(seconds=5)) < last_catalog_change_at

    open_td = None
    if open_trading_days is not None:
        open_td = open_trading_days.get(machine.id)
    else:
        from app.services.transactions import find_open_trading_day
        open_td = find_open_trading_day(db, machine.id)

    if open_td is not None:
        trading_day_status = "open"
    else:
        trading_day_status = "none"

    close_day_pending = False
    if pending_close_ids is not None:
        close_day_pending = machine.id in pending_close_ids
    else:
        close_day_pending = machine.id in get_pending_close_day_machine_ids(db, [machine.id])

    result: Dict[str, Any] = {
        "id": machine.id,
        "name": machine.name,
        "machineCode": machine.machine_code,
        "tenantId": machine.tenant_id,
        "shopId": machine.shop_id,
        "distributorId": machine.distributor_id,
        "mqttClientId": machine.mqtt_client_id,
        "pairingStatus": machine.pairing_status,
        "deviceInfo": machine.device_info,
        "isActive": machine.is_active,
        "lastHeartbeatAt": machine.last_heartbeat_at,
        "mqttConnected": machine.mqtt_connected,
        "appVersion": machine.app_version,
        "lastSyncAt": machine.last_sync_at,
        "serialNumber": machine.serial_number,
        # Passed through untouched. A null battery reading means the device could
        # not read it and must render as unknown, not as 0%.
        "batteryPercent": machine.battery_percent,
        "batteryStatus": machine.battery_status,
        "clockSkewMs": machine.clock_skew_ms,
        "lastHealthReportAt": machine.last_health_report_at,
        "lastCatalogChangeAt": last_catalog_change_at,
        "catalogPullStale": catalog_pull_stale,
        "tradingDayStatus": trading_day_status,
        "tradingDayId": open_td.id if open_td else None,
        "dayDate": open_td.day_date if open_td else None,
        "openedAt": open_td.opened_at if open_td else None,
        "openedBy": open_td.opened_by if open_td else None,
        "closeDayPending": close_day_pending,
        "createdAt": machine.created_at,
        "updatedAt": machine.updated_at,
    }

    # Resolved server-side so the dashboard, the close-day gate and anything added later
    # all read one definition. The raw fields above stay, because a detail panel still
    # wants the underlying readings.
    resolved = resolve_status(
        StatusInput(
            is_active=bool(machine.is_active),
            pairing_status=(
                machine.pairing_status.value
                if hasattr(machine.pairing_status, "value")
                else machine.pairing_status
            ),
            last_heartbeat_at=machine.last_heartbeat_at,
            trading_day_open=open_td is not None,
            day_date=open_td.day_date if open_td else None,
            close_day_pending=close_day_pending,
            pending_documents=machine.pending_documents,
            pending_count=machine.pending_count,
            pending_count_at=machine.pending_count_at,
            catalog_pull_stale=catalog_pull_stale,
            clock_skew_ms=machine.clock_skew_ms,
            battery_percent=machine.battery_percent,
            mqtt_connected=machine.mqtt_connected,
        )
    )
    result["status"] = resolved.status
    result["online"] = resolved.online
    result["statusFlags"] = resolved.flags
    result["pendingDocuments"] = resolved.pending_documents
    result["pendingAsOf"] = resolved.pending_as_of
    return result


def _enrich_machines_batch(machines: List[POSMachine], db: Session) -> List[Dict[str, Any]]:
    if not machines:
        return []
    ids = [m.id for m in machines]
    open_days = get_open_trading_days_for_machines(db, ids)
    pending_ids = get_pending_close_day_machine_ids(db, ids)
    return [
        _enrich_machine_status(m, db, open_trading_days=open_days, pending_close_ids=pending_ids)
        for m in machines
    ]


def _check_machine_list_access(current_user: User, machine: POSMachine, db: Session) -> bool:
    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if current_user.role == UserRole.COMPANY_MANAGER and machine.shop_id:
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
        return shop is not None and user_covers_company(db, current_user, shop.company_id)
    if current_user.role in SHOP_SCOPED_ROLES:
        return machine.shop_id == current_user.shop_id
    return False


@router.get("", response_model=List[POSMachineResponse])
def list_machines(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    tenant_id: Optional[str] = Query(None, alias="tenantId"),
    distributor_id: Optional[str] = Query(None, alias="distributorId"),
    include_inactive: bool = Query(
        False,
        description="Include decommissioned (is_active=false) machines.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List machines (filtered by shop/tenant/role/distributor)."""
    query = db.query(POSMachine)
    scope_tid = active_tenant_id
    if tenant_id:
        try:
            scope_tid = uuid_mod.UUID(str(tenant_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid tenantId")
    query = _scope_machines_by_tenant(query, current_user, scope_tid)

    if not include_inactive:
        query = query.filter(POSMachine.is_active.is_(True))

    if current_user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == current_user.id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, current_user)))
    elif current_user.role in SHOP_SCOPED_ROLES:
        query = query.filter(POSMachine.shop_id == current_user.shop_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        return []

    if shop_id:
        query = query.filter(POSMachine.shop_id == shop_id)
    if distributor_id:
        query = query.filter(POSMachine.distributor_id == distributor_id)

    machines = query.offset(skip).limit(limit).all()
    return _enrich_machines_batch(machines, db)


@router.get("/unassigned", response_model=List[POSMachineResponse])
def list_unassigned_machines(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List unassigned paired machines (distributor/super_admin only)."""
    query = db.query(POSMachine).filter(
        POSMachine.pairing_status == PairingStatus.PAIRED,
        POSMachine.shop_id.is_(None),
    )
    query = _scope_machines_by_tenant(query, current_user, active_tenant_id)

    if current_user.role != UserRole.SUPER_ADMIN:
        query = query.filter(POSMachine.distributor_id == current_user.id)

    return query.all()


@router.get("/me/ably-auth")
def get_my_ably_auth(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
):
    """POS desktop: Ably token (subscribe-only on this machine's channel)."""
    from app.services.ably_notify import create_token_request_for_machine, is_enabled

    if not is_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Realtime notify is not configured",
        )
    try:
        return create_token_request_for_machine(machine)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/me")
def get_my_machine(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
):
    """POS desktop: resolve shop/tenant and realtime (Ably) endpoint using machine JWT only."""
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "pairingStatus": machine.pairing_status.value if hasattr(machine.pairing_status, "value") else machine.pairing_status,
        "mqttClientId": machine.mqtt_client_id,
        **machine_realtime_refresh_info(machine=machine),
    }


@router.post("/me/heartbeat")
def post_my_heartbeat(
    body: MachineHeartbeatBody | None = None,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """
    Till / POS desktop: periodic online signal over HTTP (replaces MQTT heartbeat publish).

    Also the channel for device health — serial, battery, clock skew — because it is
    the one call every terminal already makes on a timer whether or not anything has
    happened. Every field in the body is optional: an older till build sends a subset
    and must not be turned away.
    """
    update_machine_heartbeat(
        db,
        str(machine.id),
        mqtt_connected=body.mqtt_connected if body is not None else None,
        app_version=body.app_version if body is not None else None,
        serial_number=body.serial_number if body is not None else None,
        battery_percent=body.battery_percent if body is not None else None,
        battery_status=body.battery_status if body is not None else None,
        clock_skew_ms=body.clock_skew_ms if body is not None else None,
        pending_count=body.pending_count if body is not None else None,
        pending_documents=body.pending_documents if body is not None else None,
    )
    # The pull half of remote close-day. Every till already calls this on a timer, so
    # it is the one channel that does not care whether the terminal was reachable when
    # a manager pressed the button — a till that was off simply finds the instruction
    # when it comes back. Ably still notifies an awake till instantly; this is what
    # makes a missed notification a delay rather than a close that never happens.
    pending = take_pending_close_day_for_machine(db, machine)
    db.commit()

    response = {
        "ok": True,
        "serverTime": datetime.now(timezone.utc).isoformat(),
    }
    if pending is not None:
        response["pendingCloseDay"] = {
            "requestId": str(pending.request_id),
            "tradingDayId": str(pending.trading_day_id) if pending.trading_day_id else None,
        }
    return response


@router.get("/{machine_id}", response_model=POSMachineResponse)
def get_machine(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get machine details."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return _enrich_machine_status(machine, db)


@router.put("/{machine_id}", response_model=POSMachineResponse)
def update_machine(
    machine_id: str,
    machine_data: POSMachineUpdate,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Update machine."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    update_data = machine_data.model_dump(exclude_unset=True, by_alias=False)

    if "shop_id" in update_data:
        sid = update_data["shop_id"]
        if sid is not None:
            shop = db.query(Shop).filter(Shop.id == sid).first()
            if not shop:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop not found")
            ensure_same_tenant(shop.tenant_id, active_tenant_id)
            if current_user.role == UserRole.COMPANY_MANAGER:
                if not user_covers_company(db, current_user, shop.company_id):
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
            if not shop_belongs_to_company(db, sid, shop.company_id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="shopId does not belong to its company",
                )
            machine.tenant_id = shop.tenant_id or machine.tenant_id
            machine.pairing_status = PairingStatus.ASSIGNED

    for field, value in update_data.items():
        setattr(machine, field, value)

    db.commit()
    db.refresh(machine)
    return machine


def _machine_has_history(db: Session, machine_id: str) -> bool:
    if db.query(Transaction.id).filter(Transaction.machine_id == machine_id).first():
        return True
    if db.query(ZReport.id).filter(ZReport.machine_id == machine_id).first():
        return True
    if db.query(TradingDay.id).filter(TradingDay.machine_id == machine_id).first():
        return True
    if db.query(SyncLog.id).filter(SyncLog.machine_id == machine_id).first():
        return True
    return False


@router.delete("/{machine_id}")
def delete_machine(
    machine_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Remove a POS device (hard or soft delete depending on history)."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    db.query(PairingCode).filter(PairingCode.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )
    # Detach transient pairing requests so the FK doesn't block a hard delete.
    # These are pairing artifacts, not sales history, so clearing the reference
    # is safe (the column is nullable).
    db.query(DevicePairingRequest).filter(
        DevicePairingRequest.pos_machine_id == machine_id
    ).update({DevicePairingRequest.pos_machine_id: None}, synchronize_session=False)
    db.query(Product).filter(Product.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )
    db.query(Category).filter(Category.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )

    def _soft_delete() -> Dict[str, Any]:
        machine.is_active = False
        machine.pairing_status = PairingStatus.UNPAIRED
        machine.shop_id = None
        machine.mqtt_client_id = None
        # Machine tokens do not expire, so unpairing is the revocation. Bumping the
        # version kills every token this terminal was ever issued, for good: if the
        # row is later reactivated and re-paired, it mints at the new version and
        # the old ones stay dead.
        machine.token_version = (machine.token_version or 1) + 1
        db.commit()
        return {"deleted": True, "mode": "soft", "machineId": str(machine.id)}

    if _machine_has_history(db, machine_id):
        return _soft_delete()

    db.delete(machine)
    try:
        db.commit()
    except IntegrityError:
        # Another table still references this machine (e.g. issued vouchers,
        # stock movements). Fall back to a soft delete instead of 500ing.
        db.rollback()
        machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
        if not machine:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
        return _soft_delete()
    return {"deleted": True, "mode": "hard", "machineId": machine_id}


@router.post("/{machine_id}/sync", status_code=status.HTTP_200_OK)
def trigger_sync(
    machine_id: str,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Trigger manual sync for a machine."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if machine.pairing_status != PairingStatus.ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a shop before syncing",
        )

    if not machine.shop_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine is not assigned to a shop",
        )

    if not machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine tenant context required for sync",
        )

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    update_machine_sync_timestamp(db, str(machine.id))
    notify_machine_catalog_changed(
        str(machine.tenant_id),
        str(machine.id),
        reason="manual_sync",
    )

    return {
        "message": "Catalog change notification sent; POS should pull via GET /sync/{machineId}/catalog",
    }


class ReconstructCloseBody(BaseModel):
    """Options for closing a dead terminal's day from the cloud."""

    model_config = ConfigDict(populate_by_name=True)

    #: Skip the "terminal has been silent long enough" guard.
    #:
    #: For the case where the operator knows the unit is unusable — smashed, stolen,
    #: returned to the distributor — and is not going to wait two hours to say so. It is
    #: recorded in the Z's reconstruction basis, because "a human overrode the guard" is
    #: part of how complete the document is.
    force: bool = False
    #: Free text kept with the document — why this was done, by whom, in their words.
    note: Optional[str] = Field(None, max_length=500)


@router.post("/{machine_id}/trading-day/reconstruct-close")
def reconstruct_close_trading_day(
    machine_id: uuid_mod.UUID,
    body: ReconstructCloseBody | None = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Close a trading day whose terminal can no longer close it.

    Produces a Z built from the documents the cloud already holds, marked `reconstructed`
    and attributed to the caller, with `actual_cash` left unknown because nobody counted
    a drawer. See `app/services/administrative_close.py` for why each of those matters.

    Guarded: refuses while the terminal is still online, or has been seen within the last
    two hours, unless `force` is passed — a day closed under a working till would leave a
    cashier selling into a day the cloud thinks has ended.

    Idempotent. A day that already has a Z returns it rather than filing a second fiscal
    document or burning another shop Z number.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    day = find_open_trading_day(db, machine.id)
    if day is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="no_open_trading_day"
        )

    options = body or ReconstructCloseBody()
    z_report, created = reconstruct_z_report(
        db,
        machine,
        day,
        current_user,
        force=options.force,
        note=options.note,
    )
    db.commit()
    db.refresh(z_report)

    return {
        "created": created,
        "zReportId": str(z_report.id),
        "tradingDayId": str(z_report.trading_day_id),
        "shopSequenceNumber": z_report.shop_sequence_number,
        "reconstructed": bool(z_report.reconstructed),
        "basis": z_report.reconstruction_basis,
    }


@router.post("/{machine_id}/replacement-code")
def create_replacement_pairing_code(
    machine_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A pairing code that hands this terminal's identity to a replacement device.

    The new unit adopts the same machine row — same id, same `machine_code`, same shop
    and register number — so documents already filed against it still point at the till
    the shop knows, and the day's reporting does not split across two machines. Pairing
    bumps `token_version`, which kills whatever token the old unit still holds.

    Refuses while the terminal has an open trading day: the replacement has none of that
    day's records and its Z would declare a fraction of what was actually taken. Close
    the day first with `reconstruct-close`.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    # Checked here as well as at redemption so the operator is told now, while they are
    # looking at the screen, rather than when the engineer is standing at the counter
    # with a new terminal in their hand.
    if find_open_trading_day(db, machine.id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="open_trading_day — close this terminal's day before replacing it.",
        )

    code = create_pairing_code(
        db,
        current_user.id,
        tenant_id=machine.tenant_id,
        company_id=None,
        shop_id=None,
        target_machine_id=machine.id,
    )
    return {
        "code": code.code,
        "expiresAt": code.expires_at,
        "replacesMachineId": str(machine.id),
        "machineCode": machine.machine_code,
    }
