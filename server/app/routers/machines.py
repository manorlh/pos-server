from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.pos_machine import POSMachineUpdate, POSMachineResponse
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.user import User, UserRole
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
    get_current_merchant,
    get_pos_machine_from_machine_token,
    get_active_tenant_id,
    ensure_same_tenant,
)
from app.services.sync import update_machine_sync_timestamp, get_catalog_change_watermark_for_machine
from app.services.catalog_notify import notify_machine_catalog_changed
from app.services.shop_validation import shop_belongs_to_merchant

router = APIRouter(prefix="/machines", tags=["machines"])


def _enrich_machine_status(machine: POSMachine, db: Session) -> Dict[str, Any]:
    last_catalog_change_at = get_catalog_change_watermark_for_machine(db, machine)
    last_sync_at = machine.last_sync_at
    catalog_pull_stale = False
    if last_catalog_change_at is not None:
        if last_sync_at is None:
            catalog_pull_stale = True
        else:
            # Allow tiny clock skew between processes.
            catalog_pull_stale = (last_sync_at + timedelta(seconds=5)) < last_catalog_change_at

    return {
        "id": machine.id,
        "name": machine.name,
        "machineCode": machine.machine_code,
        "merchantId": machine.merchant_id,
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


@router.get("", response_model=List[POSMachineResponse])
def list_machines(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    merchant_id: Optional[str] = Query(None),
    distributor_id: Optional[str] = Query(None),
    include_inactive: bool = Query(
        False,
        description="Include decommissioned (is_active=false) machines. Defaults to false so the dashboard doesn't show removed devices.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List machines (filtered by merchant/role/distributor)"""
    query = db.query(POSMachine).filter(POSMachine.tenant_id == active_tenant_id)

    # Hide decommissioned machines by default. The DELETE endpoint sets
    # is_active=False when the machine has history (transactions / Z-reports /
    # etc.) that we don't want to lose, so they should disappear from the
    # default UI but remain queryable for audits.
    if not include_inactive:
        query = query.filter(POSMachine.is_active.is_(True))
    
    # Role-based filtering
    if current_user.role == UserRole.MERCHANT_ADMIN:
        # Merchants can only see machines in their merchant
        if current_user.merchant_id:
            query = query.filter(POSMachine.merchant_id == current_user.merchant_id)
    elif current_user.role == UserRole.DISTRIBUTOR:
        # Distributors can see machines they paired
        query = query.filter(POSMachine.distributor_id == current_user.id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        # Other roles cannot see machines
        return []
    
    # Additional filters
    if merchant_id:
        query = query.filter(POSMachine.merchant_id == merchant_id)
    if distributor_id:
        query = query.filter(POSMachine.distributor_id == distributor_id)
    
    machines = query.offset(skip).limit(limit).all()
    return [_enrich_machine_status(m, db) for m in machines]


@router.get("/unassigned", response_model=List[POSMachineResponse])
def list_unassigned_machines(
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List unassigned paired machines (distributor/super_admin only)"""
    query = db.query(POSMachine).filter(
        POSMachine.tenant_id == active_tenant_id,
        POSMachine.pairing_status == PairingStatus.PAIRED,
        POSMachine.merchant_id.is_(None)
    )
    
    # Filter by distributor if not super admin
    if current_user.role != UserRole.SUPER_ADMIN:
        query = query.filter(POSMachine.distributor_id == current_user.id)
    
    machines = query.all()
    return machines


@router.get("/me")
def get_my_machine(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
):
    """POS desktop: resolve merchant/shop after assignment using machine JWT only."""
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "merchantId": str(machine.merchant_id) if machine.merchant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "pairingStatus": machine.pairing_status.value if hasattr(machine.pairing_status, "value") else machine.pairing_status,
        "mqttClientId": machine.mqtt_client_id,
    }


@router.get("/{machine_id}", response_model=POSMachineResponse)
def get_machine(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get machine details"""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Machine not found"
        )
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    
    # Check permissions
    if current_user.role == UserRole.MERCHANT_ADMIN:
        if machine.merchant_id != current_user.merchant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    elif current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    elif current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied"
        )
    
    return _enrich_machine_status(machine, db)


@router.put("/{machine_id}", response_model=POSMachineResponse)
def update_machine(
    machine_id: str,
    machine_data: POSMachineUpdate,
    current_user: User = Depends(get_current_merchant),  # Merchant, distributor, or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Update machine"""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Machine not found"
        )
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    
    # Check permissions
    if current_user.role == UserRole.MERCHANT_ADMIN:
        if machine.merchant_id != current_user.merchant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    elif current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    
    # Update fields (internal keys from model_dump without alias)
    update_data = machine_data.model_dump(exclude_unset=True, by_alias=False)

    if "shop_id" in update_data:
        sid = update_data["shop_id"]
        effective_merchant = update_data.get("merchant_id", machine.merchant_id)
        if sid is not None:
            if not effective_merchant:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Assign a merchant before setting shopId",
                )
            if not shop_belongs_to_merchant(db, sid, effective_merchant):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="shopId does not belong to this merchant",
                )

    for field, value in update_data.items():
        setattr(machine, field, value)

    if machine.shop_id and machine.merchant_id:
        if not shop_belongs_to_merchant(db, machine.shop_id, machine.merchant_id):
            machine.shop_id = None
    elif machine.shop_id and not machine.merchant_id:
        machine.shop_id = None

    db.commit()
    db.refresh(machine)
    return machine


def _machine_has_history(db: Session, machine_id: str) -> bool:
    """
    True if the machine has any rows we must preserve for audit / accounting:
    transactions, Z-reports, trading days, or sync logs.

    Each table is queried with a `LIMIT 1` exists check so this stays O(1)
    regardless of history size.
    """
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
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """
    Remove a POS device.

    Two modes, chosen automatically:

    - **hard**: machine has no transactions / Z-reports / trading days / sync
      logs → the row is fully deleted (along with pending pairing codes and
      machine-level catalog overrides).
    - **soft (decommission)**: machine has history → the row is kept so the
      historical FKs (transactions.machine_id, z_reports.machine_id, …) stay
      valid, but it is marked `is_active=False`, unpaired, and stripped of its
      MQTT credentials so it can no longer connect, sync, or appear in the
      dashboard list.

    This avoids the foreign-key violation a naive `db.delete()` would hit on
    any machine that has ever closed a Z, while still letting the operator
    cleanly remove the device from the dashboard.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Machine not found"
        )
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    # Check permissions
    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )

    # Always clean up rows that don't constitute history and would block a
    # hard delete. Pairing codes are short-lived and machine-scoped catalog
    # overrides have no meaning once the device is gone.
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
        # Soft-delete: keep the row so historical FKs remain valid, but
        # decommission it so it disappears from listings, can't be reassigned,
        # and can't reconnect over MQTT.
        machine.is_active = False
        machine.pairing_status = PairingStatus.UNPAIRED
        machine.merchant_id = None
        machine.shop_id = None
        machine.mqtt_client_id = None
        db.commit()
        return {"deleted": True, "mode": "soft", "machineId": str(machine.id)}

    # Hard delete: no history, safe to drop the row entirely.
    db.delete(machine)
    db.commit()
    return {"deleted": True, "mode": "hard", "machineId": machine_id}


@router.post("/{machine_id}/sync", status_code=status.HTTP_200_OK)
def trigger_sync(
    machine_id: str,
    current_user: User = Depends(get_current_merchant),  # Merchant, distributor, or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Trigger manual sync for a machine"""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Machine not found"
        )
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    
    if machine.pairing_status != PairingStatus.ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a merchant before syncing"
        )
    
    if not machine.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine is not assigned to a merchant"
        )
    
    # Check permissions
    if current_user.role == UserRole.MERCHANT_ADMIN:
        if machine.merchant_id != current_user.merchant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    
    update_machine_sync_timestamp(db, str(machine.id))
    notify_machine_catalog_changed(
        str(machine.merchant_id),
        str(machine.id),
        reason="manual_sync",
    )

    return {
        "message": "Catalog change notification sent; POS should pull via GET /sync/{machineId}/catalog",
    }

