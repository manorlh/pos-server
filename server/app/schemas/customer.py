from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, EmailStr, Field, field_validator


def _clean(v: Optional[str]) -> Optional[str]:
    """Trim, and treat a whitespace-only value as absent rather than as data."""
    if v is None:
        return None
    s = v.strip()
    return s or None


class CustomerBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    # ח.פ. / ע.מ. Stored as typed.
    #
    # Not check-digit validated and not stripped down to nine digits, because the
    # legitimate cases that would break are the ones a merchant hits soonest: a
    # foreign company with a non-Israeli registration, and an עוסק פטור whose number
    # is not a company number at all. The tax export normalises what it needs when it
    # writes the field, so being lenient here costs the filing nothing.
    vat_number: Optional[str] = Field(None, max_length=20, alias="vatNumber")
    phone: Optional[str] = Field(None, max_length=30)
    email: Optional[EmailStr] = None

    address: Optional[str] = Field(None, max_length=255)
    address_number: Optional[str] = Field(None, max_length=20, alias="addressNumber")
    city: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20, alias="postalCode")
    country: Optional[str] = Field(None, max_length=60)

    notes: Optional[str] = Field(None, max_length=1000)
    is_active: bool = Field(True, alias="isActive")

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Name cannot be empty")
        return v.strip()

    @field_validator(
        "vat_number", "phone", "address", "address_number", "city",
        "postal_code", "country", "notes",
        mode="before",
    )
    @classmethod
    def clean_optional(cls, v):
        return _clean(v) if isinstance(v, str) else v

    class Config:
        populate_by_name = True


class CustomerCreate(CustomerBase):
    pass


class CustomerUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    vat_number: Optional[str] = Field(None, max_length=20, alias="vatNumber")
    phone: Optional[str] = Field(None, max_length=30)
    email: Optional[EmailStr] = None
    address: Optional[str] = Field(None, max_length=255)
    address_number: Optional[str] = Field(None, max_length=20, alias="addressNumber")
    city: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20, alias="postalCode")
    country: Optional[str] = Field(None, max_length=60)
    notes: Optional[str] = Field(None, max_length=1000)
    is_active: Optional[bool] = Field(None, alias="isActive")

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        if v is not None and not v.strip():
            raise ValueError("Name cannot be empty")
        return v.strip() if isinstance(v, str) else v

    @field_validator(
        "vat_number", "phone", "address", "address_number", "city",
        "postal_code", "country", "notes",
        mode="before",
    )
    @classmethod
    def clean_optional(cls, v):
        return _clean(v) if isinstance(v, str) else v

    class Config:
        populate_by_name = True


class CustomerResponse(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID = Field(..., alias="tenantId")
    name: str
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    phone: Optional[str]
    email: Optional[str]
    address: Optional[str]
    address_number: Optional[str] = Field(None, alias="addressNumber")
    city: Optional[str]
    postal_code: Optional[str] = Field(None, alias="postalCode")
    country: Optional[str]
    notes: Optional[str]
    is_active: bool = Field(..., alias="isActive")
    deleted_at: Optional[datetime] = Field(None, alias="deletedAt")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class CustomerListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[CustomerResponse]

    class Config:
        populate_by_name = True
