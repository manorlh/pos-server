from pydantic import BaseModel, Field, field_validator
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
    #: Open the shop in "מצב הדרכה" (docs/SPEC_TRAINING_MODE.md). The dashboard's form
    #: sends it on by default; absent (an older client, an API caller) is off.
    training_mode: bool = Field(False, alias="trainingMode")
    #: "סוג אינטגרציית אשראי" for all the shop's tills (app/services/payment_integration.py),
    #: written on the shop's settings layer. Absent or "auto" = automatic (nothing stored).
    payment_integration: Optional[str] = Field(None, alias="paymentIntegration")

    @field_validator("payment_integration")
    @classmethod
    def _check_payment_integration(cls, v: Optional[str]) -> Optional[str]:
        from app.services.payment_integration import validate_integration

        return validate_integration(v)


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
    #: The code was assigned by the migration that made it mandatory, and not saved since.
    branch_id_auto_assigned: bool = Field(False, alias="branchIdAutoAssigned")
    address: Optional[str]
    city: Optional[str]
    is_active: bool = Field(..., alias="isActive")
    license_type: str = Field("permanent", alias="licenseType")
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")
    #: "מצב הדרכה": the badge and the stripe on the dashboard.
    training_mode: bool = Field(False, alias="trainingMode")
    training_started_at: Optional[datetime] = Field(None, alias="trainingStartedAt")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
