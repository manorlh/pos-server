from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Literal
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
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: bool = Field(False, alias="trackStock")
    # "General item": the cashier types the amount at the till, so `price` is only the
    # suggestion the till pre-fills.
    is_open_price: bool = Field(False, alias="isOpenPrice")
    # Sold by weight/volume: the till's cart quantity is a decimal for this product and
    # `price` is per `unitLabel`.
    #
    # `isWeighed` and `isOpenPrice` are both allowed on the same product, and that is a
    # decision rather than an oversight: they describe different halves of a cart line.
    # `isWeighed` governs the *quantity* the cashier enters, `isOpenPrice` governs the
    # *amount*. Loose goods weighed on a scale the till cannot read — the cashier types
    # the money the scale printed — is precisely both at once, and it is an ordinary deli
    # counter, not a corner case. Forbidding the pair would block a real configuration;
    # silently ignoring one of the two flags would leave the till guessing which keypad
    # to open.
    is_weighed: bool = Field(False, alias="isWeighed")
    unit_label: Optional[str] = Field(None, max_length=16, alias="unitLabel")

    @field_validator("name", "sku")
    @classmethod
    def validate_non_empty(cls, v):
        if isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if isinstance(v, str) else v

    class Config:
        populate_by_name = True


class ProductCreate(ProductBase):
    sku: Optional[str] = Field(None, min_length=1)
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
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: Optional[bool] = Field(None, alias="trackStock")
    is_open_price: Optional[bool] = Field(None, alias="isOpenPrice")
    is_weighed: Optional[bool] = Field(None, alias="isWeighed")
    unit_label: Optional[str] = Field(None, max_length=16, alias="unitLabel")

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
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
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
    global_sku: Optional[str] = Field(None, alias="globalSku")
    sku_auto_assigned: bool = Field(False, alias="skuAutoAssigned")
    category_id: uuid.UUID = Field(..., alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: bool = Field(..., alias="inStock")
    is_available: bool = Field(..., alias="isAvailable")
    stock_quantity: int = Field(..., alias="stockQuantity")
    barcode: Optional[str]
    tax_rate: Optional[Decimal] = Field(None, alias="taxRate")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: bool = Field(False, alias="trackStock")
    is_open_price: bool = Field(False, alias="isOpenPrice")
    is_weighed: bool = Field(False, alias="isWeighed")
    unit_label: Optional[str] = Field(None, alias="unitLabel")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class ProductListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ProductResponse]

    class Config:
        populate_by_name = True
