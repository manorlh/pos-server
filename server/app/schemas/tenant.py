from datetime import date, datetime
from typing import List, Literal, Optional
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
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

    model_config = ConfigDict(populate_by_name=True)


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    timezone: Optional[str] = None
    default_currency: Optional[str] = Field(None, alias="defaultCurrency")
    locale: Optional[str] = None
    status: Optional[TenantStatus] = None
    settings: Optional[dict] = None
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

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
    license_type: str = Field("permanent", alias="licenseType")
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")
    created_by_user_id: Optional[uuid.UUID] = Field(None, alias="createdBy")
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
