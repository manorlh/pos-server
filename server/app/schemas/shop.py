from pydantic import BaseModel, Field
from typing import Optional
import uuid
from datetime import datetime


class ShopBase(BaseModel):
    name: str = Field(..., min_length=1)
    branch_id: Optional[str] = Field(None, alias="branchId")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: bool = Field(True, alias="isActive")

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

    class Config:
        populate_by_name = True


class ShopResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID = Field(..., alias="companyId")
    name: str
    branch_id: Optional[str] = Field(None, alias="branchId")
    address: Optional[str]
    city: Optional[str]
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
