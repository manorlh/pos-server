from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.user import UserCreate, UserUpdate, UserResponse
from app.models.user import User, UserRole
from app.models.merchant import Merchant
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.auth import get_password_hash, get_user_by_username

router = APIRouter(prefix="/users", tags=["users"])

# Role hierarchy — higher number = more privileged
ROLE_LEVEL = {
    UserRole.CASHIER: 1,
    UserRole.SHOP_MANAGER: 2,
    UserRole.COMPANY_MANAGER: 3,
    UserRole.MERCHANT_ADMIN: 4,
    UserRole.DISTRIBUTOR: 5,
    UserRole.SUPER_ADMIN: 6,
}

# Which roles each role can create/manage
CREATABLE_ROLES = {
    UserRole.SUPER_ADMIN: {r for r in UserRole},
    UserRole.DISTRIBUTOR: {
        UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER, UserRole.CASHIER,
    },
    UserRole.MERCHANT_ADMIN: {
        UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.CASHIER,
    },
    UserRole.COMPANY_MANAGER: {UserRole.SHOP_MANAGER, UserRole.CASHIER},
    UserRole.SHOP_MANAGER: {UserRole.CASHIER},
    UserRole.CASHIER: set(),
}


def _check_scope_access(actor: User, target: User) -> bool:
    """Check if actor has scope access to target user."""
    if actor.role == UserRole.SUPER_ADMIN:
        return True
    if actor.role == UserRole.DISTRIBUTOR:
        return True  # filtered at query level via merchant join
    if actor.role == UserRole.MERCHANT_ADMIN:
        return target.merchant_id is not None and target.merchant_id == actor.merchant_id
    if actor.role == UserRole.COMPANY_MANAGER:
        return target.company_id is not None and target.company_id == actor.company_id
    if actor.role == UserRole.SHOP_MANAGER:
        return target.shop_id is not None and target.shop_id == actor.shop_id
    return actor.id == target.id


def _apply_scope_filter(query, actor: User, db: Session):
    """Filter user query to only show users within actor's scope."""
    if actor.role == UserRole.SUPER_ADMIN:
        return query
    if actor.role == UserRole.DISTRIBUTOR:
        merchant_ids = [
            m.id for m in db.query(Merchant.id)
            .filter(Merchant.distributor_id == actor.id).all()
        ]
        return query.filter(User.merchant_id.in_(merchant_ids))
    if actor.role == UserRole.MERCHANT_ADMIN:
        return query.filter(User.merchant_id == actor.merchant_id)
    if actor.role == UserRole.COMPANY_MANAGER:
        return query.filter(User.company_id == actor.company_id)
    if actor.role == UserRole.SHOP_MANAGER:
        return query.filter(User.shop_id == actor.shop_id)
    # CASHIER: only themselves
    return query.filter(User.id == actor.id)


@router.get("/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(get_current_user)):
    """Get current user information"""
    return current_user


@router.get("", response_model=List[UserResponse])
def list_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    merchant_id: Optional[str] = Query(None),
    company_id: Optional[str] = Query(None),
    shop_id: Optional[str] = Query(None),
    role: Optional[UserRole] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """List users with role-based filtering"""
    query = _apply_scope_filter(db.query(User), current_user, db).filter(User.tenant_id == active_tenant_id)

    if merchant_id:
        query = query.filter(User.merchant_id == merchant_id)
    if company_id:
        query = query.filter(User.company_id == company_id)
    if shop_id:
        query = query.filter(User.shop_id == shop_id)
    if role:
        query = query.filter(User.role == role)

    return query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    user_data: UserCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Create a new user with role-based permission checks"""
    # Check if actor can create this role
    allowed = CREATABLE_ROLES.get(current_user.role, set())
    if user_data.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You cannot create users with role '{user_data.role.value}'",
        )

    # Scope validation: non-super_admin must assign users within their scope
    if current_user.role != UserRole.SUPER_ADMIN:
        if current_user.role == UserRole.DISTRIBUTOR:
            if user_data.merchant_id:
                merchant = db.query(Merchant).filter(
                    Merchant.id == user_data.merchant_id,
                    Merchant.distributor_id == current_user.id,
                ).first()
                if not merchant:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Merchant not in your scope")
        elif current_user.role == UserRole.MERCHANT_ADMIN:
            if user_data.merchant_id and user_data.merchant_id != current_user.merchant_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign user to another merchant")
            user_data.merchant_id = current_user.merchant_id
        elif current_user.role == UserRole.COMPANY_MANAGER:
            user_data.merchant_id = current_user.merchant_id
            if user_data.company_id and user_data.company_id != current_user.company_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign user to another company")
            user_data.company_id = current_user.company_id
        elif current_user.role == UserRole.SHOP_MANAGER:
            user_data.merchant_id = current_user.merchant_id
            user_data.company_id = current_user.company_id
            if user_data.shop_id and user_data.shop_id != current_user.shop_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign user to another shop")
            user_data.shop_id = current_user.shop_id

    # Uniqueness checks
    if get_user_by_username(db, user_data.username):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already exists")
    if db.query(User).filter(User.email == user_data.email).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already exists")

    db_user = User(
        email=user_data.email,
        username=user_data.username,
        hashed_password=get_password_hash(user_data.password),
        role=user_data.role,
        tenant_id=active_tenant_id,
        merchant_id=user_data.merchant_id,
        company_id=user_data.company_id,
        shop_id=user_data.shop_id,
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Get user details"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)

    if not _check_scope_access(current_user, user) and current_user.id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return user


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: str,
    user_data: UserUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Update user — managers can update users within their scope"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)

    is_self = current_user.id == user.id

    # Permission check: self-update or scope access with higher role
    if not is_self:
        if not _check_scope_access(current_user, user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        if ROLE_LEVEL[current_user.role] <= ROLE_LEVEL[user.role]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot modify a user with equal or higher role",
            )

    update_data = user_data.model_dump(exclude_unset=True)

    # Non-admins editing themselves cannot change their own role or scope
    if is_self and current_user.role != UserRole.SUPER_ADMIN:
        update_data.pop("role", None)
        update_data.pop("merchant_id", None)
        update_data.pop("company_id", None)
        update_data.pop("shop_id", None)
        update_data.pop("is_active", None)

    # Role change validation: can only assign roles you're allowed to create
    if "role" in update_data:
        new_role = update_data["role"]
        allowed = CREATABLE_ROLES.get(current_user.role, set())
        if new_role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cannot assign role '{new_role}'",
            )

    if "password" in update_data:
        update_data["hashed_password"] = get_password_hash(update_data.pop("password"))

    for field, value in update_data.items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Delete user — must have scope access and higher role"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)

    if current_user.id == user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete yourself")

    if not _check_scope_access(current_user, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if ROLE_LEVEL[current_user.role] <= ROLE_LEVEL[user.role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot delete a user with equal or higher role",
        )

    db.delete(user)
    db.commit()
    return None
