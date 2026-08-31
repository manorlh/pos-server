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
    password: str


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


class UserResponse(UserBase):
    # Responses may include legacy seeded addresses (e.g. admin@pos.local).
    # Keep creation/update validation strict while avoiding response serialization failures.
    email: str
    id: uuid.UUID
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    model_config = _WIRE
