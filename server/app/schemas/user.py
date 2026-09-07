from pydantic import BaseModel, ConfigDict, EmailStr, Field
from typing import Optional, List
from datetime import datetime
import uuid
from app.models.user import UserRole


#: Every other schema in this package speaks camelCase on the wire — see
#: `pos_user.py`, `shop.py`, `product.py`. This one did not, and the cost was real in
#: both directions: `GET /users` returned `is_active`, so a dashboard reading
#: `isActive` saw undefined and rendered *every* user as inactive; and
#: `POST/PUT /users` accepted only `company_id`, so a super_admin creating a scoped
#: user had the scope silently dropped.
#:
#: `populate_by_name` keeps snake_case accepted on the way in, so any existing caller
#: — including anything mid-deploy — keeps working.
_WIRE = ConfigDict(populate_by_name=True, from_attributes=True)


class UserBase(BaseModel):
    model_config = _WIRE

    email: EmailStr
    username: str
    role: UserRole = UserRole.CASHIER
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


class UserCreate(UserBase):
    #: Optional so a user can be invited by email alone.
    #:
    #: Setting one is not neutral: `POST /auth/login` is live and accepts
    #: username + password, so choosing somebody's password means being able to sign
    #: in as them. For a system whose audit trail says "Yossi authorised this", that
    #: is exactly what must not be possible. An invited user gets no password, signs
    #: in with Clerk when they are ready, and authorises at a till with their own PIN.
    password: Optional[str] = None
    #: Optional too — derived from the email when omitted. Nobody should have to
    #: invent a login name for a person who may never type one.
    username: Optional[str] = None


class UserUpdate(BaseModel):
    model_config = _WIRE

    email: Optional[EmailStr] = None
    username: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    is_active: Optional[bool] = Field(None, alias="isActive")


class CurrentUserResponse(UserBase):
    """
    `GET /users/me` — who is connected, and what they may do.

    The capability fields exist so the dashboard stops re-deriving permission rules
    that only the server can be right about. It previously offered every role in the
    create dialog and let the save fail with a 403, which advertises authority the
    caller does not have and blames them for using it.
    """

    email: str
    id: uuid.UUID
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    #: Exactly the roles this user may assign when creating or editing another user.
    #: Empty means the user may not create anyone, which is the cashier case.
    creatable_roles: List[UserRole] = Field(default_factory=list, alias="creatableRoles")
    #: Whether this user may read the staff list at all.
    can_read_users: bool = Field(False, alias="canReadUsers")
    #: Whether this user may create, edit or deactivate staff.
    can_manage_users: bool = Field(False, alias="canManageUsers")
    #: Whether this user may manage till operators.
    can_manage_pos_users: bool = Field(False, alias="canManagePosUsers")

    #: Till-PIN state. The hash itself is never sent anywhere — this is only enough
    #: for the dashboard to say "you can authorise actions at a till" or offer to
    #: set a PIN.
    has_till_pin: bool = Field(False, alias="hasTillPin")
    #: Scopes this user could hold at a till, so the dashboard can explain what a
    #: PIN would actually let them do rather than describing it vaguely.
    till_scopes: List[str] = Field(default_factory=list, alias="tillScopes")


class UserResponse(UserBase):
    # Responses may include legacy seeded addresses (e.g. admin@pos.local).
    # Keep creation/update validation strict while avoiding response serialization failures.
    email: str

    #: Whether this person holds a till PIN, so the staff list can show who is able
    #: to authorise actions at a terminal. Derived from the hash's presence — the
    #: hash itself is never serialised anywhere.
    has_till_pin: bool = Field(False, alias="hasTillPin")
    id: uuid.UUID
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    model_config = _WIRE
