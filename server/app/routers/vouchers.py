from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.voucher import Voucher
from app.models.product import Product
from app.models.user import User, UserRole
from app.schemas.voucher import VoucherCreate, VoucherUpdate, VoucherResponse, VoucherListResponse
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.catalog_notify import notify_all_machines_for_tenant

router = APIRouter(prefix="/vouchers", tags=["vouchers"])

_CATALOG_ROLES = (
    UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
)


def _trigger_catalog_notify(db: Session, tenant_id):
    tid = str(tenant_id) if tenant_id else None
    if tid:
        notify_all_machines_for_tenant(db, tid, reason="voucher_change")


@router.get("", response_model=VoucherListResponse)
def list_vouchers(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
    is_active: Optional[bool] = Query(None, alias="isActive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Voucher).filter(Voucher.tenant_id == active_tenant_id)
    if is_active is not None:
        query = query.filter(Voucher.is_active == is_active)
    total = query.count()
    items = (
        query.order_by(Voucher.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return VoucherListResponse(page=page, page_size=page_size, total=total, items=items)


@router.post("", response_model=VoucherResponse, status_code=status.HTTP_201_CREATED)
def create_voucher(
    data: VoucherCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    voucher = Voucher(
        tenant_id=active_tenant_id,
        name=data.name,
        is_active=data.is_active,
        title=data.title,
        subtitle=data.subtitle,
        body_text=data.body_text,
        footer_text=data.footer_text,
        validity_days=data.validity_days,
        valid_from=data.valid_from,
        valid_until=data.valid_until,
        value_display_mode=data.value_display_mode,
        display_value=data.display_value,
        print_barcode=data.print_barcode,
        print_qr=data.print_qr,
        language=data.language,
    )
    db.add(voucher)
    db.commit()
    db.refresh(voucher)
    _trigger_catalog_notify(db, active_tenant_id)
    return voucher


@router.get("/{voucher_id}", response_model=VoucherResponse)
def get_voucher(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = db.query(Voucher).filter(Voucher.id == voucher_id).first()
    if not voucher:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voucher not found")
    ensure_same_tenant(voucher.tenant_id, active_tenant_id)
    return voucher


@router.put("/{voucher_id}", response_model=VoucherResponse)
def update_voucher(
    voucher_id: str,
    data: VoucherUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    voucher = db.query(Voucher).filter(Voucher.id == voucher_id).first()
    if not voucher:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voucher not found")
    ensure_same_tenant(voucher.tenant_id, active_tenant_id)

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(voucher, field, value)

    db.commit()
    db.refresh(voucher)
    _trigger_catalog_notify(db, active_tenant_id)
    return voucher


@router.delete("/{voucher_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_voucher(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    voucher = db.query(Voucher).filter(Voucher.id == voucher_id).first()
    if not voucher:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voucher not found")
    ensure_same_tenant(voucher.tenant_id, active_tenant_id)

    if db.query(Product).filter(Product.voucher_id == voucher_id).count():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Voucher is linked to products",
        )

    tenant_id = str(voucher.tenant_id)
    db.delete(voucher)
    db.commit()
    _trigger_catalog_notify(db, tenant_id)
