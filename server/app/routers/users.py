from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.user import UserCreate, UserUpdate, UserResponse, CurrentUserResponse
from app.models.user import User, UserRole
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.shop import Shop
from app.services.auth import get_password_hash, get_user_by_username
from app.services.company_hierarchy import company_scope_ids, user_covers_company

router = APIRouter(prefix="/users", tags=["users"])

ROLE_LEVEL = {
    UserRole.CASHIER: 1,
    UserRole.SHOP_MANAGER: 2,
    UserRole.COMPANY_MANAGER: 3,
    UserRole.DISTRIBUTOR: 4,
    UserRole.SUPER_ADMIN: 5,
}

#: Roles that may read the staff list at all. A dashboard cashier is a shop *viewer*
#: — it already reads transactions, Z-reports and the tax export — and enumerating the
#: company's staff is not part of that job.
USER_READ_ROLES = {
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.SHOP_MANAGER,
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


def _check_scope_access(actor: User, target: User, db: Session) -> bool:
    if actor.role == UserRole.SUPER_ADMIN:
        return True
    if actor.role == UserRole.DISTRIBUTOR:
        return True
    if actor.role == UserRole.COMPANY_MANAGER:
        # Staff of the group *and* of its subsidiaries. A group manager who cannot
        # manage the staff of the companies they own is locked out of their own org.
        return target.company_id is not None and user_covers_company(
            db, actor, target.company_id
        )
    if actor.role == UserRole.SHOP_MANAGER:
        return target.shop_id is not None and target.shop_id == actor.shop_id
    return actor.id == target.id


def _ensure_assignment_in_scope(actor: User, db: Session, *, company_id, shop_id) -> None:
    """
    A caller may only place a user in a company (or shop) their own scope covers.

    Both `POST /users` and `PUT /users/{id}` accept `companyId` / `shopId`, and both
    need this: reading a user is scoped by `_check_scope_access`, but *writing* their
    company decides which scope they land in afterwards. Before nested companies the
    create path pinned a company manager's users to `actor.company_id` and the update
    path checked nothing at all — so a manager could move a cashier they control into
    another company. With a group tree there are now several companies a manager may
    legitimately assign into, which is precisely why the rule has to be one function
    used by both paths instead of a line in each.
    """
    if actor.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return  # tenant-level roles; the tenant guard is what bounds them

    if company_id is not None and not user_covers_company(db, actor, company_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot assign user to another company",
        )

    if shop_id is None:
        return
    if actor.role == UserRole.SHOP_MANAGER:
        if shop_id != actor.shop_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot assign user to another shop",
            )
        return
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop or not user_covers_company(db, actor, shop.company_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot assign user to another company's shop",
        )


def _apply_scope_filter(query, actor: User, db: Session):
    if actor.role == UserRole.SUPER_ADMIN:
        return query
    if actor.role == UserRole.DISTRIBUTOR:
        return query
    if actor.role == UserRole.COMPANY_MANAGER:
        return query.filter(User.company_id.in_(company_scope_ids(db, actor)))
    if actor.role == UserRole.SHOP_MANAGER:
        return query.filter(User.shop_id == actor.shop_id)
    return query.filter(User.id == actor.id)


@router.get("/me", response_model=CurrentUserResponse, response_model_by_alias=True)
def get_current_user_info(current_user: User = Depends(get_current_user)):
    """
    Who is connected, and what they may do.

    The capabilities are computed from the same constants the endpoints enforce, so
    the dashboard renders what the server will actually accept instead of offering
    every role and letting the save 403.
    """
    creatable = CREATABLE_ROLES.get(current_user.role, set())
    return CurrentUserResponse.model_validate(current_user).model_copy(
        update={
            # Highest first: the create dialog should lead with the most senior role
            # the caller can actually delegate.
            "creatable_roles": sorted(creatable, key=lambda r: ROLE_LEVEL[r], reverse=True),
            "can_read_users": current_user.role in USER_READ_ROLES,
            "can_manage_users": bool(creatable),
            "can_manage_pos_users": current_user.role != UserRole.CASHIER,
        }
    )


@router.get("", response_model=List[UserResponse], response_model_by_alias=True)
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
    if current_user.role not in USER_READ_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    query = _apply_scope_filter(db.query(User), current_user, db).filter(User.tenant_id == active_tenant_id)

    if company_id:
        query = query.filter(User.company_id == company_id)
    if shop_id:
        query = query.filter(User.shop_id == shop_id)
    if role:
        query = query.filter(User.role == role)

    return query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED, response_model_by_alias=True)
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
            _ensure_assignment_in_scope(
                current_user, db, company_id=user_data.company_id, shop_id=user_data.shop_id
            )
            # Unspecified still means "my own company", not "any subsidiary".
            user_data.company_id = user_data.company_id or current_user.company_id
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


@router.get("/{user_id}", response_model=UserResponse, response_model_by_alias=True)
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

    # Reading yourself is always fine — that is what /me is for, and the dialog uses
    # it. Reading anyone else is the same disclosure the list makes.
    if current_user.role not in USER_READ_ROLES and current_user.id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    if not _check_scope_access(current_user, user, db) and current_user.id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return user


@router.put("/{user_id}", response_model=UserResponse, response_model_by_alias=True)
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
        if not _check_scope_access(current_user, user, db):
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

    # Same rule as on create: moving a user between companies or shops is bounded by
    # what the caller covers. `is_self` for a non-super-admin has already had both
    # fields dropped above.
    if "company_id" in update_data or "shop_id" in update_data:
        _ensure_assignment_in_scope(
            current_user,
            db,
            company_id=update_data.get("company_id"),
            shop_id=update_data.get("shop_id"),
        )

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


def _authorise_activation_change(current_user: User, user: User, verb: str, db: Session) -> None:
    """The guards shared by deactivate and reactivate."""
    if current_user.id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot {verb} yourself",
        )
    if not _check_scope_access(current_user, user, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if ROLE_LEVEL[current_user.role] <= ROLE_LEVEL[user.role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Cannot {verb} a user with equal or higher role",
        )


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Soft delete: flips `is_active` to false. Mirrors what POS users already do.

    This used to be `db.delete(user)`, which was wrong twice over. Seven tables carry
    a FK to `users.id`, two of them NOT NULL — `pos_machines.distributor_id` and
    `close_day_requests.initiated_by_user_id` — so deleting a distributor who had ever
    paired a terminal either failed with an integrity error or took the terminals with
    it. And it destroyed the audit trail: "who ordered that close-day" has no answer
    once the row is gone.

    Deactivating is also what the word means operationally. Staff leave; the documents
    they touched do not.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)
    _authorise_activation_change(current_user, user, "deactivate", db)

    if user.is_active:
        user.is_active = False
        db.commit()


@router.post("/{user_id}/activate", response_model=UserResponse, response_model_by_alias=True)
def activate_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Bring a deactivated user back.

    Same authority as deactivating: if you were allowed to switch someone off, you are
    allowed to switch them on. Without this, a mis-click was permanent for everyone
    below super_admin, which is the kind of thing that makes people avoid the button
    that keeps the staff list honest.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)
    _authorise_activation_change(current_user, user, "activate", db)

    if not user.is_active:
        user.is_active = True
        db.commit()
    db.refresh(user)
    return user
    return None
