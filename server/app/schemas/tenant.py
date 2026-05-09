from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, Field, ConfigDict

from app.models.tenant import TenantStatus
from app.models.tenant_membership import TenantMembershipRole


class TenantCreate(BaseModel):
    name: str
    slug: str
    timezone: str = "Asia/Jerusalem"
    default_currency: str = Field("ILS", alias="defaultCurrency")
    locale: str = "he-IL"

    model_config = ConfigDict(populate_by_name=True)


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    timezone: Optional[str] = None
    default_currency: Optional[str] = Field(None, alias="defaultCurrency")
    locale: Optional[str] = None
    status: Optional[TenantStatus] = None
    settings: Optional[dict] = None

    model_config = ConfigDict(populate_by_name=True)


class TenantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    name: str
    slug: str
    status: TenantStatus
    timezone: str
    default_currency: str = Field(..., alias="defaultCurrency")
    locale: str
    settings: Optional[dict]
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")


class TenantMembershipOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tenant_id: uuid.UUID = Field(..., alias="tenantId")
    user_id: uuid.UUID = Field(..., alias="userId")
    role: TenantMembershipRole
    is_default: bool = Field(..., alias="isDefault")


class TenantListResponse(BaseModel):
    items: List[TenantOut]
