import re
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.user import UserCreate, UserUpdate, UserResponse, CurrentUserResponse
from app.schemas.elevation import TillPinAssign, TillPinSet, TillPinState
from app.services.elevation import PinPolicyError, clear_till_pin, set_till_pin
from app.services.permission_matrix import Action, Resource, may
from app.services.permission_matrix import roles_for as _roles_for
from app.services.permissions import till_grantable_scopes
from app.models.user import User, UserRole
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.shop import Shop
from app.services.auth import get_password_hash, get_user_by_username
from app.services.company_hierarchy import company_scope_ids, user_covers_company

router = APIRouter(prefix="/users", tags=["users"])

#: Named so a test can prove what `/users/me` advertises is what the endpoint enforces.
POS_USER_WRITE_ROLES = _roles_for(Resource.POS_USER, Action.WRITE)

ROLE_LEVEL = {
    UserRole.CASHIER: 1,
    # Above a cashier and below a manager: may authorise a refund or a discount at the
    # register, may not administer anything from a desk.
    UserRole.SHIFT_SUPERVISOR: 2,
    UserRole.SHOP_MANAGER: 3,
    UserRole.COMPANY_MANAGER: 4,
    UserRole.DISTRIBUTOR: 5,
    UserRole.SUPER_ADMIN: 6,
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
        UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER,
    },
    UserRole.COMPANY_MANAGER: {
        UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER,
    },
    # A shop manager staffs their own shop, supervisors included — that is the whole
    # point of the role, and routing it through head office would leave a branch unable
    # to cover a shift.
    UserRole.SHOP_MANAGER: {UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER},
    # No dashboard administration at all: a supervisor's authority is at the register.
    UserRole.SHIFT_SUPERVISOR: set(),
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
            # Same grid the endpoint enforces on, so the dashboard cannot offer a
            # button the save would then refuse.
            "can_manage_pos_users": may(current_user.role, Resource.POS_USER, Action.WRITE),
            "has_till_pin": bool(current_user.till_pin_hash),
            "till_scopes": sorted(
                scope.value for scope in till_grantable_scopes(current_user.role)
            ),
        }
    )


# ── Till PIN ──────────────────────────────────────────────────────────────────
# Declared before the `/{user_id}` variants so the literal "me" is not swallowed
# by the path parameter.


def _till_pin_state(user: User) -> TillPinState:
    return TillPinState(
        has_pin=bool(user.till_pin_hash),
        set_at=user.till_pin_set_at,
    )


@router.put("/me/till-pin", response_model=TillPinState, response_model_by_alias=True)
def set_my_till_pin(
    data: TillPinSet,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Choose your own till PIN."""
    try:
        set_till_pin(db, current_user, data.pin)
    except PinPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    db.commit()
    db.refresh(current_user)
    return _till_pin_state(current_user)


@router.delete("/me/till-pin", response_model=TillPinState, response_model_by_alias=True)
def clear_my_till_pin(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    clear_till_pin(db, current_user)
    db.commit()
    db.refresh(current_user)
    return _till_pin_state(current_user)


def _authorise_till_pin_admin(current_user: User, target: User, db: Session) -> None:
    """
    Same bar as editing the user: you may manage them, and they are not your equal
    or senior. Issuing someone a till PIN is handing out authority in their name, so
    it must not be easier than changing their role.
    """
    if current_user.id == target.id:
        return
    if not _check_scope_access(current_user, target, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if ROLE_LEVEL[current_user.role] <= ROLE_LEVEL[target.role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot modify a user with equal or higher role",
        )


@router.post(
    "/{user_id}/till-pin", response_model=TillPinState, response_model_by_alias=True
)
def assign_till_pin(
    user_id: str,
    data: TillPinAssign,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set somebody else's till PIN.

    What is set here is exactly what they type at the till — there is no first-use
    change step. So whoever sets it knows it, and an approval recorded against that
    person is only as strong as how the PIN was passed to them. Deliberate: see
    `_authorise_till_pin_admin`, which is why this needs the same authority as
    changing their role.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)
    _authorise_till_pin_admin(current_user, user, db)

    try:
        set_till_pin(db, user, data.pin)
    except PinPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    db.commit()
    db.refresh(user)
    return _till_pin_state(user)


@router.delete(
    "/{user_id}/till-pin", response_model=TillPinState, response_model_by_alias=True
)
def revoke_till_pin(
    user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Take away someone's ability to authorise anything at a till."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)
    _authorise_till_pin_admin(current_user, user, db)

    clear_till_pin(db, user)
    db.commit()
    db.refresh(user)
    return _till_pin_state(user)


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


def _derive_username(db: Session, email: str) -> str:
    """A login name from the email's local part, suffixed until it is free."""
    base = re.sub(r"[^a-zA-Z0-9_]", "_", email.split("@", 1)[0]).strip("_")[:80]
    base = re.sub(r"_+", "_", base) or "user"
    for attempt in range(12):
        candidate = base if attempt == 0 else f"{base}_{uuid.uuid4().hex[:4]}"
        if not db.query(User.id).filter(User.username == candidate[:100]).first():
            return candidate[:100]
    return f"user_{uuid.uuid4().hex[:8]}"


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

    # Lowercase on the way in. Clerk sign-in claims an invited row by *lowered*
    # email, so storing `Yossi@` and `yossi@` as two rows would let one of them be
    # unclaimable — and which one the linker found would be arbitrary.
    email = str(user_data.email).strip().lower()
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already exists")

    username = (user_data.username or "").strip() or _derive_username(db, email)
    if get_user_by_username(db, username):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already exists")

    db_user = User(
        email=email,
        username=username,
        hashed_password=(
            get_password_hash(user_data.password) if user_data.password else None
        ),
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
    a FK to `users.id`, some of them NOT NULL — `pos_machines.distributor_id` and
    `z_runs.created_by_user_id` among them — so deleting a distributor who had ever
    paired a terminal either failed with an integrity error or took the terminals with
    it. And it destroyed the audit trail: "who produced that Z" has no answer once the
    row is gone.

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
