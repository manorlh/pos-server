from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
import uuid
from decimal import Decimal
from datetime import datetime


class ProductBase(BaseModel):
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    price: Decimal = Field(..., ge=0)
    sku: str = Field(..., min_length=1)
    category_id: uuid.UUID = Field(..., alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: bool = Field(True, alias="inStock")
    stock_quantity: int = Field(0, ge=0, alias="stockQuantity")
    barcode: Optional[str] = None
    tax_rate: Optional[Decimal] = Field(None, ge=0, alias="taxRate")

    @field_validator("name", "sku")
    @classmethod
    def validate_non_empty(cls, v):
        if isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if isinstance(v, str) else v

    class Config:
        populate_by_name = True


class ProductCreate(ProductBase):
    merchant_id: Optional[uuid.UUID] = Field(None, alias="merchantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    catalog_level: Literal["global", "local"] = Field("global", alias="catalogLevel")
    global_product_id: Optional[uuid.UUID] = Field(None, alias="globalProductId")


class ProductUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    price: Optional[Decimal] = Field(None, ge=0)
    sku: Optional[str] = Field(None, min_length=1)
    category_id: Optional[uuid.UUID] = Field(None, alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: Optional[bool] = Field(None, alias="inStock")
    stock_quantity: Optional[int] = Field(None, ge=0, alias="stockQuantity")
    barcode: Optional[str] = None
    tax_rate: Optional[Decimal] = Field(None, ge=0, alias="taxRate")
    is_local_override: Optional[bool] = Field(None, alias="isLocalOverride")

    @field_validator("name", "sku")
    @classmethod
    def validate_non_empty(cls, v):
        if v is not None and isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if v and isinstance(v, str) else v

    class Config:
        populate_by_name = True


class ProductResponse(BaseModel):
    id: uuid.UUID
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    global_product_id: Optional[uuid.UUID] = Field(None, alias="globalProductId")
    catalog_level: str = Field(..., alias="catalogLevel")
    is_local_override: bool = Field(..., alias="isLocalOverride")
    name: str
    description: Optional[str]
    price: Decimal
    sku: str
    category_id: uuid.UUID = Field(..., alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: bool = Field(..., alias="inStock")
    is_available: bool = Field(..., alias="isAvailable")
    stock_quantity: int = Field(..., alias="stockQuantity")
    barcode: Optional[str]
    tax_rate: Optional[Decimal] = Field(None, alias="taxRate")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
