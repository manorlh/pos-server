from pydantic import BaseModel, ConfigDict, Field
from typing import List, Literal, Optional
import uuid
from datetime import date, datetime


class CompanyBase(BaseModel):
    name: str = Field(..., min_length=1)
    #: Organizational parent (a holding group). Null for a top-level company. Nesting
    #: never moves fiscal attribution: documents stay with the company that holds the ח.פ.
    parent_company_id: Optional[uuid.UUID] = Field(None, alias="parentCompanyId")
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    address: Optional[str] = None
    city: Optional[str] = None
    is_active: bool = Field(True, alias="isActive")
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

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
    #: "permanent" | "temporary" (a short-term customer, an event) — super admin only.
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    #: A temporary customer's last day of sales.
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

    class Config:
        populate_by_name = True


class CompanyResponse(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    parent_company_id: Optional[uuid.UUID] = Field(None, alias="parentCompanyId")
    name: str
    #: Company 1, 2, 3 in its tenant; never reused.
    company_number: Optional[int] = Field(None, alias="companyNumber")
    vat_number: Optional[str] = Field(None, alias="vatNumber")
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


class ParentOption(BaseModel):
    """One candidate parent, and why it may or may not be chosen."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    name: str
    #: Edges above this company, so the picker can indent the tree rather than show a
    #: flat list in which "NORTH trading" and "NORTH kiosks" look like peers.
    depth: int
    allowed: bool
    #: Why not, when `allowed` is false — shown beside the disabled row. A picker that
    #: silently omits impossible parents leaves the operator wondering where a company
    #: went; one that says "would exceed 5 levels" answers the question.
    reason: Optional[str] = None


class ParentOptionsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    options: List[ParentOption]
    #: What a move would carry with it. Zero for a company being created, which is the
    #: whole reason setting a parent at creation is safe and moving one later is not.
    moves_shops: int = Field(0, alias="movesShops")
    moves_machines: int = Field(0, alias="movesMachines")
    moves_companies: int = Field(0, alias="movesCompanies")
    #: True when this company may be detached to sit at the top level.
    may_detach: bool = Field(True, alias="mayDetach")
