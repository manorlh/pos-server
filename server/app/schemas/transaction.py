from datetime import datetime
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field

from app.schemas.stock import StockMovementIn


class IssuedVoucherIn(BaseModel):
    """Issued שובר from POS — id is client-generated UUID (serial)."""

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


class TransactionPaymentIn(BaseModel):
    """
    One tender leg incoming from POS. id is a client-generated UUID.

    `amount` is the money applied to the document on this tender, **not** the money
    handed over: ₪100 offered against a ₪50 bill is `amount: 50`, with the ₪100 and
    the ₪50 change staying in the document's `amountTendered` / `changeAmount`.

    Tips are not tender legs. A tip stays on the document (`tipAmount` +
    `tipPaymentMethod`) exactly as it is today, so the legs of a document sum to the
    document itself and nothing else. Sending the tip inside a leg would break the
    reconciliation check below and reject the push.
    """

    id: uuid.UUID
    sequence: int = Field(1, ge=1, description="Order the tenders were taken in, 1-based")
    method: str = Field(..., min_length=1, max_length=50)
    amount: Decimal = Field(..., ge=0)
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")

    class Config:
        populate_by_name = True


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
    #: The VAT split as the till computed it at the moment of sale. Optional so an
    #: older build keeps working; when absent the server derives it from the gross and
    #: the machine's current rate, which is what every document used to do.
    net_amount: Optional[Decimal] = Field(None, alias="netAmount")
    vat_amount: Optional[Decimal] = Field(None, alias="vatAmount")
    vat_rate: Optional[Decimal] = Field(None, alias="vatRate")
    tip_amount: Decimal = Field(0, ge=0, alias="tipAmount")
    tip_payment_method: Optional[Literal["cash", "card"]] = Field(None, alias="tipPaymentMethod")
    total_discount: Optional[Decimal] = Field(None, alias="totalDiscount")
    document_discount: Optional[Decimal] = Field(None, alias="documentDiscount")
    wht_deduction: Optional[Decimal] = Field(None, alias="whtDeduction")

    customer_id: Optional[str] = Field(None, alias="customerId")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    notes: Optional[str] = None

    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")

    #: The cloud `users` row the till says authorised this document — the person who
    #: typed a PIN for the refund or the discount. Optional, and absent is the ordinary
    #: case: a till whose own operator already holds the authority approves nothing.
    #:
    #: A claim, not a fact, until `app.services.approvals` has checked it against that
    #: user's standing permissions. A claim that fails takes the document down with it.
    approved_by_user_id: Optional[uuid.UUID] = Field(None, alias="approvedByUserId")

    # Trading day envelope — POS sends its own trading_day_id; server resolves/auto-opens.
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")
    day_date: Optional[str] = Field(None, alias="dayDate", description="ISO date YYYY-MM-DD for trading day resolution")

    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    items: List[TransactionItemIn] = Field(default_factory=list)
    # Optional on purpose. A till build that knows nothing about split tender sends
    # only `paymentMethod` and keeps working exactly as before — the server
    # synthesises the single leg it implies, so reporting has one code path.
    payments: List[TransactionPaymentIn] = Field(default_factory=list)
    issued_vouchers: List[IssuedVoucherIn] = Field(default_factory=list, alias="issuedVouchers")
    stock_movements: List[StockMovementIn] = Field(default_factory=list, alias="stockMovements")

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


class TransactionPaymentOut(BaseModel):
    id: uuid.UUID
    sequence: int
    method: str
    amount: Decimal
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")

    class Config:
        from_attributes = True
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


class TransactionOut(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
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
    tip_amount: Decimal = Field(0, alias="tipAmount")
    tip_payment_method: Optional[str] = Field(None, alias="tipPaymentMethod")
    total_discount: Optional[Decimal] = Field(None, alias="totalDiscount")
    document_discount: Optional[Decimal] = Field(None, alias="documentDiscount")
    wht_deduction: Optional[Decimal] = Field(None, alias="whtDeduction")

    customer_id: Optional[str] = Field(None, alias="customerId")
    customer_ref_id: Optional[uuid.UUID] = Field(None, alias="customerRefId")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    notes: Optional[str]

    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")
    #: Verified at ingest, so what comes back out is a name the server stood behind.
    approved_by_user_id: Optional[uuid.UUID] = Field(None, alias="approvedByUserId")

    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    server_received_at: datetime = Field(..., alias="serverReceivedAt")

    items: List[TransactionItemOut] = Field(default_factory=list)
    payments: List[TransactionPaymentOut] = Field(default_factory=list)
    issued_vouchers: List[IssuedVoucherOut] = Field(default_factory=list, alias="issuedVouchers")

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
    tip_amount: Decimal = Field(0, alias="tipAmount")
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
