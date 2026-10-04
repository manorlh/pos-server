from pydantic import BaseModel, Field
from typing import Literal, Optional
import uuid
from datetime import date, datetime


class ShopBase(BaseModel):
    name: str = Field(..., min_length=1)
    branch_id: Optional[str] = Field(None, alias="branchId")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: bool = Field(True, alias="isActive")
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

    class Config:
        populate_by_name = True


class ShopCreate(ShopBase):
    company_id: uuid.UUID = Field(..., alias="companyId")


class ShopUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    branch_id: Optional[str] = Field(None, alias="branchId")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

    class Config:
        populate_by_name = True


class ShopResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID = Field(..., alias="companyId")
    name: str
    #: Shop 1, 2, 3 in its company; never reused.
    shop_number: Optional[int] = Field(None, alias="shopNumber")
    branch_id: Optional[str] = Field(None, alias="branchId")
    address: Optional[str]
    city: Optional[str]
    is_active: bool = Field(..., alias="isActive")
    license_type: str = Field("permanent", alias="licenseType")
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
