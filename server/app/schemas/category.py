from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
import uuid
import re
from datetime import datetime


class CategoryBase(BaseModel):
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    is_active: bool = Field(True, alias="isActive")
    sort_order: int = Field(0, alias="sortOrder")

    @field_validator("name")
    @classmethod
    def validate_non_empty(cls, v):
        if isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if isinstance(v, str) else v

    @field_validator("color")
    @classmethod
    def validate_color_format(cls, v):
        if v is not None and not re.match(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$", v):
            raise ValueError("Color must be a valid hex color code (e.g., #RRGGBB or #RGB)")
        return v

    class Config:
        populate_by_name = True


class CategoryCreate(CategoryBase):
    merchant_id: Optional[uuid.UUID] = Field(None, alias="merchantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    catalog_level: Literal["global", "local"] = Field("global", alias="catalogLevel")


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    is_active: Optional[bool] = Field(None, alias="isActive")
    sort_order: Optional[int] = Field(None, alias="sortOrder")

    @field_validator("name")
    @classmethod
    def validate_non_empty(cls, v):
        if v is not None and isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if v and isinstance(v, str) else v

    @field_validator("color")
    @classmethod
    def validate_color_format(cls, v):
        if v is not None and not re.match(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$", v):
            raise ValueError("Color must be a valid hex color code (e.g., #RRGGBB or #RGB)")
        return v

    class Config:
        populate_by_name = True


class CategoryResponse(BaseModel):
    id: uuid.UUID
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    catalog_level: str = Field(..., alias="catalogLevel")
    name: str
    description: Optional[str]
    color: Optional[str]
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    is_active: bool = Field(..., alias="isActive")
    sort_order: int = Field(..., alias="sortOrder")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    children: Optional[list["CategoryResponse"]] = None

    class Config:
        from_attributes = True
        populate_by_name = True
