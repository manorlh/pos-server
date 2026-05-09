from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime
import uuid
from app.models.user import UserRole


class UserBase(BaseModel):
    email: EmailStr
    username: str
    role: UserRole = UserRole.CASHIER
    tenant_id: Optional[uuid.UUID] = None
    merchant_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None


class UserCreate(UserBase):
    password: str


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    merchant_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    is_active: Optional[bool] = None


class UserResponse(UserBase):
    # Responses may include legacy seeded addresses (e.g. admin@pos.local).
    # Keep creation/update validation strict while avoiding response serialization failures.
    email: str
    id: uuid.UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
