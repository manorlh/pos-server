from typing import List
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.merchant import MerchantCreate, MerchantUpdate, MerchantResponse
from app.models.merchant import Merchant
from app.models.user import User, UserRole
from app.middleware.auth import (
    get_current_user,
    get_current_distributor,
    get_current_super_admin,
    get_active_tenant_id,
    ensure_same_tenant,
)

router = APIRouter(prefix="/merchants", tags=["merchants"])


@router.get("", response_model=List[MerchantResponse])
def list_merchants(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List merchants (filtered by role)"""
    query = db.query(Merchant).filter(Merchant.tenant_id == active_tenant_id)
    
    # Role-based filtering
    if current_user.role == UserRole.DISTRIBUTOR:
        # Distributors can only see their own merchants
        query = query.filter(Merchant.distributor_id == current_user.id)
    elif current_user.role == UserRole.MERCHANT_ADMIN:
        # Merchants can only see their own merchant
        if current_user.merchant_id:
            query = query.filter(Merchant.id == current_user.merchant_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        # Other roles cannot see merchants
        return []
    
    merchants = query.offset(skip).limit(limit).all()
    return merchants


@router.post("", response_model=MerchantResponse, status_code=status.HTTP_201_CREATED)
def create_merchant(
    merchant_data: MerchantCreate,
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Create a new merchant (distributor/super_admin only)"""
    # If distributor, use their ID
    if current_user.role == UserRole.DISTRIBUTOR:
        merchant_data.distributor_id = current_user.id
    
    db_merchant = Merchant(
        tenant_id=active_tenant_id,
        name=merchant_data.name,
        distributor_id=merchant_data.distributor_id
    )
    db.add(db_merchant)
    db.commit()
    db.refresh(db_merchant)
    return db_merchant


@router.get("/{merchant_id}", response_model=MerchantResponse)
def get_merchant(
    merchant_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get merchant details"""
    merchant = db.query(Merchant).filter(Merchant.id == merchant_id).first()
    if not merchant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Merchant not found"
        )
    ensure_same_tenant(merchant.tenant_id, active_tenant_id)
    
    # Check permissions
    if current_user.role == UserRole.DISTRIBUTOR:
        if merchant.distributor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    elif current_user.role == UserRole.MERCHANT_ADMIN:
        if merchant.id != current_user.merchant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    elif current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied"
        )
    
    return merchant


@router.put("/{merchant_id}", response_model=MerchantResponse)
def update_merchant(
    merchant_id: str,
    merchant_data: MerchantUpdate,
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Update merchant"""
    merchant = db.query(Merchant).filter(Merchant.id == merchant_id).first()
    if not merchant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Merchant not found"
        )
    ensure_same_tenant(merchant.tenant_id, active_tenant_id)
    
    # Check permissions
    if current_user.role == UserRole.DISTRIBUTOR:
        if merchant.distributor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
    
    # Update fields
    update_data = merchant_data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(merchant, field, value)
    
    db.commit()
    db.refresh(merchant)
    return merchant


@router.delete("/{merchant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_merchant(
    merchant_id: str,
    current_user: User = Depends(get_current_super_admin),  # Only super admin
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Delete merchant (super admin only)"""
    merchant = db.query(Merchant).filter(Merchant.id == merchant_id).first()
    if not merchant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Merchant not found"
        )
    ensure_same_tenant(merchant.tenant_id, active_tenant_id)
    
    db.delete(merchant)
    db.commit()
    return None

