"""
Dashboard CRUD for POS users (cashiers / shop managers per shop).

Mounted under /shops/{shop_id}/pos-users so RBAC and shop scoping match the rest
of the dashboard. Soft-delete (is_active = false) keeps historical
transactions.cashier_id references intact.
"""
from typing import List
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.company import Company
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.pos_user import (
    PosUserCreate, PosUserUpdate, PosUserResetPin, PosUserResponse,
)
from app.services.auth import get_password_hash
from app.services.pos_user_notify import notify_machines_for_shop_pos_users


router = APIRouter(prefix="/shops", tags=["pos-users"])


# ── Auth helpers ─────────────────────────────────────────────────────────────

def _get_shop_or_404(db: Session, shop_id: str) -> Shop:
    try:
        sid = uuid_mod.UUID(str(shop_id))
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid shop_id")
    shop = db.query(Shop).filter(Shop.id == sid).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    return shop


def _check_read(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return
    if user.role == UserRole.MERCHANT_ADMIN:
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if company and company.merchant_id == user.merchant_id:
            return
    if user.role == UserRole.COMPANY_MANAGER and shop.company_id == user.company_id:
        return
    if user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and shop.id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_write(user: User, shop: Shop, db: Session) -> None:
    """Cashiers cannot manage other POS users."""
    if user.role == UserRole.CASHIER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    _check_read(user, shop, db)


def _resolve_merchant_id_for_shop(db: Session, shop: Shop) -> uuid_mod.UUID:
    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if not company or not company.merchant_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop has no merchant")
    return company.merchant_id


# ── List / Create ────────────────────────────────────────────────────────────

@router.get("/{shop_id}/pos-users", response_model=List[PosUserResponse])
def list_pos_users(
    shop_id: str,
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_read(current_user, shop, db)

    q = db.query(PosUser).filter(PosUser.shop_id == shop.id, PosUser.tenant_id == active_tenant_id)
    if not include_inactive:
        q = q.filter(PosUser.is_active.is_(True))
    q = q.order_by(PosUser.username)
    return q.all()


@router.post(
    "/{shop_id}/pos-users",
    response_model=PosUserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_pos_user(
    shop_id: str,
    data: PosUserCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    merchant_id = _resolve_merchant_id_for_shop(db, shop)

    existing = (
        db.query(PosUser)
        .filter(PosUser.shop_id == shop.id, PosUser.username == data.username)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists in this shop",
        )

    if data.worker_number:
        wn_dup = (
            db.query(PosUser)
            .filter(PosUser.shop_id == shop.id, PosUser.worker_number == data.worker_number)
            .first()
        )
        if wn_dup:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Worker number already exists in this shop",
            )

    user = PosUser(
        tenant_id=active_tenant_id,
        merchant_id=merchant_id,
        shop_id=shop.id,
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        worker_number=data.worker_number,
        pin_hash=get_password_hash(data.pin),
        role=data.role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_created")
    return user


# ── Update / Reset-PIN / Soft-Delete ─────────────────────────────────────────

def _get_pos_user_in_shop_or_404(db: Session, shop: Shop, pos_user_id: str) -> PosUser:
    try:
        uid = uuid_mod.UUID(str(pos_user_id))
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid pos_user_id")
    pu = db.query(PosUser).filter(PosUser.id == uid, PosUser.shop_id == shop.id).first()
    if not pu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
    return pu


@router.put("/{shop_id}/pos-users/{pos_user_id}", response_model=PosUserResponse)
def update_pos_user(
    shop_id: str,
    pos_user_id: str,
    data: PosUserUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)

    payload = data.model_dump(exclude_unset=True, by_alias=False)

    if "worker_number" in payload:
        wn = payload["worker_number"]
        if wn:
            dup = (
                db.query(PosUser)
                .filter(
                    PosUser.shop_id == shop.id,
                    PosUser.worker_number == wn,
                    PosUser.id != pu.id,
                )
                .first()
            )
            if dup:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Worker number already exists in this shop",
                )

    for field in ("first_name", "last_name", "worker_number", "role", "is_active"):
        if field in payload:
            setattr(pu, field, payload[field])

    if "pin" in payload and payload["pin"] is not None:
        pu.pin_hash = get_password_hash(payload["pin"])

    db.commit()
    db.refresh(pu)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_updated")
    return pu


@router.post(
    "/{shop_id}/pos-users/{pos_user_id}/reset-pin",
    response_model=PosUserResponse,
)
def reset_pos_user_pin(
    shop_id: str,
    pos_user_id: str,
    body: PosUserResetPin,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)

    pu.pin_hash = get_password_hash(body.pin)
    db.commit()
    db.refresh(pu)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_pin_reset")
    return pu


@router.delete(
    "/{shop_id}/pos-users/{pos_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def deactivate_pos_user(
    shop_id: str,
    pos_user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Soft delete: flips is_active=false. Keeps historical transactions.cashier_id valid."""
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)

    if pu.is_active:
        pu.is_active = False
        db.commit()

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_deactivated")
    return None
