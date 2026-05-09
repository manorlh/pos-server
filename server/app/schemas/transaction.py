from datetime import datetime
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field


class TransactionItemIn(BaseModel):
    """Single item line incoming from POS. id is client-generated UUID."""

    id: uuid.UUID
    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    sku: Optional[str] = None
    quantity: Decimal
    unit_price: Decimal = Field(..., alias="unitPrice")
    total_price: Decimal = Field(..., alias="totalPrice")
    discount: Optional[Decimal] = None
    discount_type: Optional[str] = Field(None, alias="discountType")
    transaction_type: Optional[int] = Field(None, alias="transactionType")
    line_discount: Optional[Decimal] = Field(None, alias="lineDiscount")
    notes: Optional[str] = None

    class Config:
        populate_by_name = True


class TransactionIn(BaseModel):
    """Single transaction incoming from POS. id is client-generated UUID."""

    id: uuid.UUID
    transaction_number: str = Field(..., alias="transactionNumber")
    status: Literal["pending", "completed", "cancelled", "refunded", "partial_refund"] = "completed"

    document_type: Optional[int] = Field(None, alias="documentType")
    document_production_date: Optional[datetime] = Field(None, alias="documentProductionDate")
    payment_method: Optional[str] = Field(None, alias="paymentMethod")

    amount_tendered: Optional[Decimal] = Field(None, alias="amountTendered")
    change_amount: Optional[Decimal] = Field(None, alias="changeAmount")
    total_amount: Decimal = Field(0, alias="totalAmount")
    total_discount: Optional[Decimal] = Field(None, alias="totalDiscount")
    document_discount: Optional[Decimal] = Field(None, alias="documentDiscount")
    wht_deduction: Optional[Decimal] = Field(None, alias="whtDeduction")

    customer_id: Optional[str] = Field(None, alias="customerId")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    notes: Optional[str] = None

    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")

    # Trading day envelope — POS sends its own trading_day_id; server resolves/auto-opens.
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")
    day_date: Optional[str] = Field(None, alias="dayDate", description="ISO date YYYY-MM-DD for trading day resolution")

    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    items: List[TransactionItemIn] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class TransactionsBatchRequest(BaseModel):
    transactions: List[TransactionIn]


class TransactionUpsertResult(BaseModel):
    id: uuid.UUID
    status: Literal["accepted", "duplicate", "rejected"]
    reason: Optional[str] = None
    server_received_at: Optional[datetime] = Field(None, alias="serverReceivedAt")

    class Config:
        populate_by_name = True


class TransactionsBatchResponse(BaseModel):
    server_time: datetime = Field(..., alias="serverTime")
    results: List[TransactionUpsertResult]

    class Config:
        populate_by_name = True


# ── Read / dashboard ──────────────────────────────────────────────────────────

class TransactionItemOut(BaseModel):
    id: uuid.UUID
    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    sku: Optional[str]
    quantity: Decimal
    unit_price: Decimal = Field(..., alias="unitPrice")
    total_price: Decimal = Field(..., alias="totalPrice")
    discount: Optional[Decimal]
    discount_type: Optional[str] = Field(None, alias="discountType")
    transaction_type: Optional[int] = Field(None, alias="transactionType")
    line_discount: Optional[Decimal] = Field(None, alias="lineDiscount")
    notes: Optional[str]

    class Config:
        from_attributes = True
        populate_by_name = True


class TransactionOut(BaseModel):
    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")

    transaction_number: str = Field(..., alias="transactionNumber")
    status: str

    document_type: Optional[int] = Field(None, alias="documentType")
    document_production_date: Optional[datetime] = Field(None, alias="documentProductionDate")
    payment_method: Optional[str] = Field(None, alias="paymentMethod")

    amount_tendered: Optional[Decimal] = Field(None, alias="amountTendered")
    change_amount: Optional[Decimal] = Field(None, alias="changeAmount")
    total_amount: Decimal = Field(..., alias="totalAmount")
    total_discount: Optional[Decimal] = Field(None, alias="totalDiscount")
    document_discount: Optional[Decimal] = Field(None, alias="documentDiscount")
    wht_deduction: Optional[Decimal] = Field(None, alias="whtDeduction")

    customer_id: Optional[str] = Field(None, alias="customerId")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    notes: Optional[str]

    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")

    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    server_received_at: datetime = Field(..., alias="serverReceivedAt")

    items: List[TransactionItemOut] = Field(default_factory=list)

    class Config:
        from_attributes = True
        populate_by_name = True


class TransactionListItem(BaseModel):
    """Lighter row for list views (no items)."""

    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")
    transaction_number: str = Field(..., alias="transactionNumber")
    status: str
    payment_method: Optional[str] = Field(None, alias="paymentMethod")
    total_amount: Decimal = Field(..., alias="totalAmount")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    created_at: datetime = Field(..., alias="createdAt")
    server_received_at: datetime = Field(..., alias="serverReceivedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class TransactionListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[TransactionListItem]

    class Config:
        populate_by_name = True
