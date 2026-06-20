from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.user import UserCreate, UserUpdate, UserResponse
from app.models.user import User, UserRole
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.services.auth import get_password_hash, get_user_by_username

router = APIRouter(prefix="/users", tags=["users"])

ROLE_LEVEL = {
    UserRole.CASHIER: 1,
    UserRole.SHOP_MANAGER: 2,
    UserRole.COMPANY_MANAGER: 3,
    UserRole.DISTRIBUTOR: 4,
    UserRole.SUPER_ADMIN: 5,
}

CREATABLE_ROLES = {
    UserRole.SUPER_ADMIN: {r for r in UserRole if r != UserRole.MERCHANT_ADMIN},
    UserRole.DISTRIBUTOR: {
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER, UserRole.CASHIER,
    },
    UserRole.COMPANY_MANAGER: {UserRole.SHOP_MANAGER, UserRole.CASHIER},
    UserRole.SHOP_MANAGER: {UserRole.CASHIER},
    UserRole.CASHIER: set(),
}


def _check_scope_access(actor: User, target: User) -> bool:
    if actor.role == UserRole.SUPER_ADMIN:
        return True
    if actor.role == UserRole.DISTRIBUTOR:
        return True
    if actor.role == UserRole.COMPANY_MANAGER:
        return target.company_id is not None and target.company_id == actor.company_id
    if actor.role == UserRole.SHOP_MANAGER:
        return target.shop_id is not None and target.shop_id == actor.shop_id
    return actor.id == target.id


def _apply_scope_filter(query, actor: User):
    if actor.role == UserRole.SUPER_ADMIN:
        return query
    if actor.role == UserRole.DISTRIBUTOR:
        return query
    if actor.role == UserRole.COMPANY_MANAGER:
        return query.filter(User.company_id == actor.company_id)
    if actor.role == UserRole.SHOP_MANAGER:
        return query.filter(User.shop_id == actor.shop_id)
    return query.filter(User.id == actor.id)


@router.get("/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("", response_model=List[UserResponse])
def list_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    role: Optional[UserRole] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = _apply_scope_filter(db.query(User), current_user, db).filter(User.tenant_id == active_tenant_id)

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
    allowed = CREATABLE_ROLES.get(current_user.role, set())
    if user_data.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You cannot create users with role '{user_data.role.value}'",
        )

    if current_user.role != UserRole.SUPER_ADMIN:
        if current_user.role == UserRole.COMPANY_MANAGER:
            if user_data.company_id and user_data.company_id != current_user.company_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign user to another company")
            user_data.company_id = current_user.company_id
        elif current_user.role == UserRole.SHOP_MANAGER:
            user_data.company_id = current_user.company_id
            if user_data.shop_id and user_data.shop_id != current_user.shop_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign user to another shop")
            user_data.shop_id = current_user.shop_id

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
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)

    is_self = current_user.id == user.id

    if not is_self:
        if not _check_scope_access(current_user, user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        if ROLE_LEVEL[current_user.role] <= ROLE_LEVEL[user.role]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot modify a user with equal or higher role",
            )

    update_data = user_data.model_dump(exclude_unset=True)

    if is_self and current_user.role != UserRole.SUPER_ADMIN:
        update_data.pop("role", None)
        update_data.pop("company_id", None)
        update_data.pop("shop_id", None)
        update_data.pop("is_active", None)

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
