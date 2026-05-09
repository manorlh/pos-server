import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.schemas.tenant import TenantCreate, TenantOut, TenantUpdate


router = APIRouter(prefix="/tenants", tags=["tenants"])


def _ensure_membership_for_user_home_tenant(db: Session, user: User) -> None:
    """If the user row points at a tenant but membership is missing, create it (migration / data repair)."""
    if not user.tenant_id:
        return
    exists = (
        db.query(TenantMembership)
        .filter(
            TenantMembership.user_id == user.id,
            TenantMembership.tenant_id == user.tenant_id,
        )
        .first()
    )
    if exists:
        return
    tenant = db.query(Tenant).filter(Tenant.id == user.tenant_id).first()
    if not tenant:
        return
    if user.role in (
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.MERCHANT_ADMIN,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    ):
        role = TenantMembershipRole.TENANT_ADMIN
    else:
        role = TenantMembershipRole.TENANT_MEMBER
    db.add(
        TenantMembership(
            tenant_id=user.tenant_id,
            user_id=user.id,
            role=role,
            is_default=True,
        )
    )


def _can_manage_tenant(current_user: User, tenant_id: uuid.UUID, db: Session) -> bool:
    if current_user.role.value == "super_admin":
        return True
    m = (
        db.query(TenantMembership)
        .filter(
            TenantMembership.tenant_id == tenant_id,
            TenantMembership.user_id == current_user.id,
            TenantMembership.role.in_([TenantMembershipRole.TENANT_OWNER, TenantMembershipRole.TENANT_ADMIN]),
        )
        .first()
    )
    return m is not None


@router.get("/mine", response_model=list[TenantOut])
def list_my_tenants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role == UserRole.SUPER_ADMIN:
        return db.query(Tenant).order_by(Tenant.name.asc()).all()

    _ensure_membership_for_user_home_tenant(db, current_user)
    db.flush()

    memberships = (
        db.query(TenantMembership)
        .filter(TenantMembership.user_id == current_user.id)
        .order_by(TenantMembership.is_default.desc(), TenantMembership.created_at.asc())
        .all()
    )
    tenant_ids = [m.tenant_id for m in memberships]
    if not tenant_ids:
        db.commit()
        return []
    rows = db.query(Tenant).filter(Tenant.id.in_(tenant_ids)).all()
    by_id = {t.id: t for t in rows}
    out = [by_id[tid] for tid in tenant_ids if tid in by_id]
    db.commit()
    return out


@router.post("", response_model=TenantOut, status_code=status.HTTP_201_CREATED)
def create_tenant(
    body: TenantCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = db.query(Tenant).filter((Tenant.name == body.name) | (Tenant.slug == body.slug)).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Tenant name or slug already exists")

    tenant = Tenant(
        name=body.name,
        slug=body.slug,
        timezone=body.timezone,
        default_currency=body.default_currency,
        locale=body.locale,
    )
    db.add(tenant)
    db.flush()
    db.add(
        TenantMembership(
            tenant_id=tenant.id,
            user_id=current_user.id,
            role=TenantMembershipRole.TENANT_OWNER,
            is_default=True,
        )
    )
    if not current_user.tenant_id:
        current_user.tenant_id = tenant.id
    db.commit()
    db.refresh(tenant)
    return tenant


@router.patch("/{tenant_id}", response_model=TenantOut)
def update_tenant(
    tenant_id: uuid.UUID,
    body: TenantUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    if not _can_manage_tenant(current_user, tenant_id, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    for field, value in body.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(tenant, field, value)
    db.commit()
    db.refresh(tenant)
    return tenant
