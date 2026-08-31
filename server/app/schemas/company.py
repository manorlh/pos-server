from pydantic import BaseModel, Field
from typing import Optional
import uuid
from datetime import datetime


class CompanyBase(BaseModel):
    name: str = Field(..., min_length=1)
    #: Organizational parent (a holding group). Null for a top-level company. Nesting
    #: never moves fiscal attribution: documents stay with the company that holds the ח.פ.
    parent_company_id: Optional[uuid.UUID] = Field(None, alias="parentCompanyId")
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: bool = Field(True, alias="isActive")

    class Config:
        populate_by_name = True


class CompanyCreate(CompanyBase):
    pass


class CompanyUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    #: Send null to detach from the group; distributor/super-admin only.
    parent_company_id: Optional[uuid.UUID] = Field(None, alias="parentCompanyId")
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")

    class Config:
        populate_by_name = True


class CompanyResponse(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    parent_company_id: Optional[uuid.UUID] = Field(None, alias="parentCompanyId")
    name: str
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    address: Optional[str]
    city: Optional[str]
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
