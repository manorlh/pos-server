from datetime import datetime
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field, field_validator


class VoucherBase(BaseModel):
    name: str = Field(..., min_length=1)
    is_active: bool = Field(True, alias="isActive")
    title: Optional[str] = None
    subtitle: Optional[str] = None
    body_text: Optional[str] = Field(None, alias="bodyText")
    footer_text: Optional[str] = Field(None, alias="footerText")
    validity_days: Optional[int] = Field(None, ge=0, alias="validityDays")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    value_display_mode: Literal["product_price", "fixed", "none"] = Field(
        "product_price", alias="valueDisplayMode"
    )
    display_value: Optional[Decimal] = Field(None, ge=0, alias="displayValue")
    print_barcode: bool = Field(True, alias="printBarcode")
    print_qr: bool = Field(True, alias="printQr")
    language: Optional[str] = Field("he", max_length=5)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Name cannot be empty")
        return v.strip()

    class Config:
        populate_by_name = True


class VoucherCreate(VoucherBase):
    pass


class VoucherUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    is_active: Optional[bool] = Field(None, alias="isActive")
    title: Optional[str] = None
    subtitle: Optional[str] = None
    body_text: Optional[str] = Field(None, alias="bodyText")
    footer_text: Optional[str] = Field(None, alias="footerText")
    validity_days: Optional[int] = Field(None, ge=0, alias="validityDays")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    value_display_mode: Optional[Literal["product_price", "fixed", "none"]] = Field(
        None, alias="valueDisplayMode"
    )
    display_value: Optional[Decimal] = Field(None, ge=0, alias="displayValue")
    print_barcode: Optional[bool] = Field(None, alias="printBarcode")
    print_qr: Optional[bool] = Field(None, alias="printQr")
    language: Optional[str] = Field(None, max_length=5)

    class Config:
        populate_by_name = True


class VoucherResponse(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID = Field(..., alias="tenantId")
    name: str
    is_active: bool = Field(..., alias="isActive")
    title: Optional[str]
    subtitle: Optional[str]
    body_text: Optional[str] = Field(None, alias="bodyText")
    footer_text: Optional[str] = Field(None, alias="footerText")
    validity_days: Optional[int] = Field(None, alias="validityDays")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    value_display_mode: str = Field(..., alias="valueDisplayMode")
    display_value: Optional[Decimal] = Field(None, alias="displayValue")
    print_barcode: bool = Field(..., alias="printBarcode")
    print_qr: bool = Field(..., alias="printQr")
    language: Optional[str]
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class VoucherListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[VoucherResponse]

    class Config:
        populate_by_name = True


class IssuedVoucherIn(BaseModel):
    """Issued שובר instance from POS — id is client-generated UUID (serial)."""

    id: uuid.UUID
    transaction_item_id: Optional[uuid.UUID] = Field(None, alias="transactionItemId")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    quantity: Decimal = Field(1, ge=0)
    unit_value: Optional[Decimal] = Field(None, alias="unitValue")
    face_value: Optional[Decimal] = Field(None, alias="faceValue")
    issued_at: datetime = Field(..., alias="issuedAt")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    status: Literal["issued", "voided", "redeemed"] = "issued"
    reprint_count: int = Field(0, ge=0, alias="reprintCount")
    last_printed_at: Optional[datetime] = Field(None, alias="lastPrintedAt")

    class Config:
        populate_by_name = True


class IssuedVoucherOut(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    transaction_id: uuid.UUID = Field(..., alias="transactionId")
    transaction_item_id: Optional[uuid.UUID] = Field(None, alias="transactionItemId")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    quantity: Decimal
    unit_value: Optional[Decimal] = Field(None, alias="unitValue")
    face_value: Optional[Decimal] = Field(None, alias="faceValue")
    issued_at: datetime = Field(..., alias="issuedAt")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    status: str
    reprint_count: int = Field(..., alias="reprintCount")
    last_printed_at: Optional[datetime] = Field(None, alias="lastPrintedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
