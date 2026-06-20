import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from app.database import get_db
from app.schemas.pos_machine import POSMachineUpdate, POSMachineResponse
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.user import User, UserRole
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.models.trading_day import TradingDay
from app.models.sync_log import SyncLog
from app.models.pairing_code import PairingCode
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
from app.services.sync import update_machine_sync_timestamp, get_catalog_change_watermark_for_machine
from app.services.catalog_notify import notify_machine_catalog_changed
from app.services.shop_validation import shop_belongs_to_company
from app.services.mqtt_broker import machine_mqtt_refresh_info

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


def _enrich_machine_status(machine: POSMachine, db: Session) -> Dict[str, Any]:
    last_catalog_change_at = get_catalog_change_watermark_for_machine(db, machine)
    last_sync_at = machine.last_sync_at
    catalog_pull_stale = False
    if last_catalog_change_at is not None:
        if last_sync_at is None:
            catalog_pull_stale = True
        else:
            catalog_pull_stale = (last_sync_at + timedelta(seconds=5)) < last_catalog_change_at

    return {
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
        "lastSyncAt": machine.last_sync_at,
        "lastCatalogChangeAt": last_catalog_change_at,
        "catalogPullStale": catalog_pull_stale,
        "createdAt": machine.created_at,
        "updatedAt": machine.updated_at,
    }


def _check_machine_list_access(current_user: User, machine: POSMachine, db: Session) -> bool:
    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if current_user.role == UserRole.COMPANY_MANAGER and machine.shop_id:
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
        return shop is not None and shop.company_id == current_user.company_id
    if current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
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
        company_shop_ids = db.query(Shop.id).filter(Shop.company_id == current_user.company_id)
        query = query.filter(POSMachine.shop_id.in_(company_shop_ids))
    elif current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(POSMachine.shop_id == current_user.shop_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        return []

    if shop_id:
        query = query.filter(POSMachine.shop_id == shop_id)
    if distributor_id:
        query = query.filter(POSMachine.distributor_id == distributor_id)

    machines = query.offset(skip).limit(limit).all()
    return [_enrich_machine_status(m, db) for m in machines]


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


@router.get("/me")
def get_my_machine(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
):
    """POS desktop: resolve shop/tenant and MQTT broker endpoint using machine JWT only."""
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "pairingStatus": machine.pairing_status.value if hasattr(machine.pairing_status, "value") else machine.pairing_status,
        "mqttClientId": machine.mqtt_client_id,
        **machine_mqtt_refresh_info(),
    }


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
                if shop.company_id != current_user.company_id:
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
    db.query(Product).filter(Product.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )
    db.query(Category).filter(Category.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )

    if _machine_has_history(db, machine_id):
        machine.is_active = False
        machine.pairing_status = PairingStatus.UNPAIRED
        machine.shop_id = None
        machine.mqtt_client_id = None
        db.commit()
        return {"deleted": True, "mode": "soft", "machineId": str(machine.id)}

    db.delete(machine)
    db.commit()
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
