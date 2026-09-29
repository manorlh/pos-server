from datetime import datetime
from decimal import Decimal
from typing import Any, List, Literal, Optional, Union
import uuid

import json
import math

from pydantic import BaseModel, Field, field_validator

from app.schemas.stock import StockMovementIn


#: The most of an acquirer reply kept. A reply is a few hundred bytes; anything near
#: this is not one, and is kept cut, as text, rather than parsed.
META_MAX_CHARS = 16 * 1024


def cut_text(value, limit: int):
    """
    Free text as sent, trimmed and cut to `limit` — never a validation error.

    For the buyer details on a document: an over-long address must not refuse a fiscal
    document the till has already printed, so it is cut to what the column holds.
    """
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    text = text.strip()
    return text[:limit] or None


def _reject_constant(name):
    """`json.loads` hook: NaN / Infinity are not JSON, and Postgres JSONB refuses them."""
    raise ValueError(f"non-JSON constant {name}")


def _raw(text: str) -> dict:
    if len(text) > META_MAX_CHARS:
        return {"raw": text[:META_MAX_CHARS], "truncated": True}
    return {"raw": text}


def meta_as_dict(value):
    """
    An acquirer reply as an object, whatever shape it arrived in.

    A JSON string is parsed; anything that is not a JSON object — invalid JSON, a list,
    a bare number — is kept verbatim as `{"raw": ...}`. Never a validation error: a
    rejected field here rejects the whole batch, and with it a card sale that has
    already been charged. Nor a database error, which fails the document just the same:
    a reply over 16 KB, one nested deeper than the parser can follow, or one carrying
    NaN / Infinity (which JSONB refuses) is kept as `{"raw": <text, cut to 16 KB>}`.
    """
    if value is None:
        return value
    if isinstance(value, dict):
        try:
            text = json.dumps(value, allow_nan=False)
        except (ValueError, TypeError, RecursionError):
            return _raw(str(value))
        return value if len(text) <= META_MAX_CHARS else _raw(text)
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8", "replace")
    if isinstance(value, str):
        if not value.strip():
            return None
        if len(value) > META_MAX_CHARS:
            return _raw(value)
        try:
            parsed = json.loads(value, parse_constant=_reject_constant)
        except (ValueError, RecursionError):
            return _raw(value)
        return parsed if isinstance(parsed, dict) else _raw(value)
    if isinstance(value, (list, int, float, bool)):
        try:
            json.dumps(value, allow_nan=False)
        except (ValueError, TypeError, RecursionError):
            return _raw(str(value))
        return {"raw": value}
    return _raw(str(value))


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
    #: The acquirer's reply. The Android till sends it as a JSON *string*; the desktop
    #: as an object. Both are stored as an object (see `_meta_as_dict`).
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")
    #: Number of credit instalments (תשלומים) on a card leg. No column of its own:
    #: stored in the leg's `nayax_meta` as `creditPayments`, beside the acquirer reply
    #: it came from.
    credit_payments: Optional[int] = Field(None, alias="creditPayments")

    class Config:
        populate_by_name = True

    @field_validator("nayax_meta", mode="before")
    @classmethod
    def _meta_as_dict(cls, value):
        return meta_as_dict(value)

    @field_validator("credit_payments", mode="before")
    @classmethod
    def _instalments(cls, value):
        """An unreadable instalment count is dropped, never a rejected document."""
        if value is None or value == "":
            return None
        try:
            count = int(value)
        except (TypeError, ValueError, OverflowError):
            # OverflowError: a JSON 1e999 arrives as float("inf").
            return None
        return count if 0 <= count <= 2**31 - 1 else None


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
    #: On a credit-note line returned from a receipt: the id of the original sale line
    #: (`items[].id` of the original document). Optional; absent on a catalogue return.
    #: An original the cloud does not hold yet is fine — it may arrive later.
    refund_of_item_id: Optional[uuid.UUID] = Field(None, alias="refundOfItemId")

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

    #: The till basket this document was committed in: the documents of one basket that
    #: mixes sold and returned lines share it (docs/SHIFTS_API.md §1.2a). Optional.
    basket_id: Optional[uuid.UUID] = Field(None, alias="basketId")
    #: The buyer's details as printed (required by regulation on a return). Free text,
    #: trimmed and cut to the column, never a reason to refuse the document.
    customer_name: Optional[str] = Field(None, alias="customerName")
    customer_phone: Optional[str] = Field(None, alias="customerPhone")
    customer_address: Optional[str] = Field(None, alias="customerAddress")

    #: The cloud `users` row the till says authorised this document — the person who
    #: typed a PIN for the refund or the discount. Optional, and absent is the ordinary
    #: case: a till whose own operator already holds the authority approves nothing.
    #:
    #: A claim, not a fact, until `app.services.approvals` has checked it against that
    #: user's standing permissions. A claim that fails takes the document down with it.
    approved_by_user_id: Optional[uuid.UUID] = Field(None, alias="approvedByUserId")

    # The shift this document was issued in — the till's own shift id. The server
    # resolves it by id only; see `app.services.shifts.resolve_shift_for_document`.
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    business_date: Optional[str] = Field(None, alias="businessDate", description="ISO date YYYY-MM-DD of the shift")

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

    @field_validator("nayax_meta", mode="before")
    @classmethod
    def _meta_as_dict(cls, value):
        return meta_as_dict(value)

    @field_validator("customer_name", mode="before")
    @classmethod
    def _cut_name(cls, value):
        return cut_text(value, 255)

    @field_validator("customer_phone", mode="before")
    @classmethod
    def _cut_phone(cls, value):
        return cut_text(value, 30)

    @field_validator("customer_address", mode="before")
    @classmethod
    def _cut_address(cls, value):
        return cut_text(value, 500)


class TransactionsBatchRequest(BaseModel):
    """The batch with every document validated — what one strict parse looks like."""

    transactions: List[TransactionIn]


class TransactionsBatchEnvelope(BaseModel):
    """
    The batch as `POST /sync/{m}/transactions` accepts it: only the envelope is checked.

    Each document is validated on its own afterwards (`validate_documents`), so one
    document the model refuses is answered `rejected` while the rest of the batch still
    lands. Validating the list here made one bad field a 422 for the whole batch, and
    the till retried that batch forever — every sale behind it jammed with it.
    """

    transactions: List[Any]


class TransactionUpsertResult(BaseModel):
    #: A UUID for every document the model accepted. A document refused by validation
    #: is answered with its id exactly as sent when that was a string, so the till can
    #: match it even when the id itself was what failed.
    id: Union[uuid.UUID, str]
    status: Literal["accepted", "duplicate", "rejected"]
    reason: Optional[str] = None
    #: A stored document's reference links that could not be read and were dropped
    #: (`items[0].productId: unreadable 'p12', stored without the link`). Null otherwise.
    warnings: Optional[List[str]] = None
    server_received_at: Optional[datetime] = Field(None, alias="serverReceivedAt")

    class Config:
        populate_by_name = True


class UnidentifiedDocument(BaseModel):
    """A refused document with no string id to answer by: its position in the batch."""

    index: int
    status: Literal["rejected"] = "rejected"
    reason: str


class TransactionsBatchResponse(BaseModel):
    server_time: datetime = Field(..., alias="serverTime")
    results: List[TransactionUpsertResult]
    #: Null unless something in the batch had no string id at all. Kept out of `results`
    #: because a shipped till decodes `results[].id` as a non-null string, and one null
    #: there would fail the decoding of the whole answer.
    unidentified: Optional[List[UnidentifiedDocument]] = None

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
    refund_of_item_id: Optional[uuid.UUID] = Field(None, alias="refundOfItemId")

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
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")

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
    #: The original's document number, when the cloud holds it (same tenant). Filled on
    #: the dashboard detail read only.
    refund_of_transaction_number: Optional[str] = Field(None, alias="refundOfTransactionNumber")
    #: A credit note that took its original's credited total past what it collected.
    over_credited: Optional[bool] = Field(False, alias="overCredited")
    nayax_meta: Optional[dict] = Field(None, alias="nayaxMeta")
    basket_id: Optional[uuid.UUID] = Field(None, alias="basketId")
    customer_name: Optional[str] = Field(None, alias="customerName")
    customer_phone: Optional[str] = Field(None, alias="customerPhone")
    customer_address: Optional[str] = Field(None, alias="customerAddress")
    #: Verified at ingest, so what comes back out is a name the server stood behind.
    approved_by_user_id: Optional[uuid.UUID] = Field(None, alias="approvedByUserId")

    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    server_received_at: datetime = Field(..., alias="serverReceivedAt")

    items: List[TransactionItemOut] = Field(default_factory=list)
    payments: List[TransactionPaymentOut] = Field(default_factory=list)
    issued_vouchers: List[IssuedVoucherOut] = Field(default_factory=list, alias="issuedVouchers")
    #: The other documents of its basket (same `basketId`, same tenant), oldest first.
    #: Filled on the dashboard detail read only; empty for a document with no basket.
    basket_documents: List["BasketDocumentOut"] = Field(default_factory=list, alias="basketDocuments")

    class Config:
        from_attributes = True
        populate_by_name = True


class BasketDocumentOut(BaseModel):
    """One sibling document of a mixed basket, as the detail view links it."""

    id: uuid.UUID
    transaction_number: str = Field(..., alias="transactionNumber")
    document_type: Optional[int] = Field(None, alias="documentType")
    status: str
    total_amount: Decimal = Field(..., alias="totalAmount")
    payment_method: Optional[str] = Field(None, alias="paymentMethod")
    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    created_at: datetime = Field(..., alias="createdAt")

    class Config:
        from_attributes = True
        populate_by_name = True


TransactionOut.model_rebuild()


class TransactionListItem(BaseModel):
    """Lighter row for list views (no items)."""

    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    transaction_number: str = Field(..., alias="transactionNumber")
    status: str
    document_type: Optional[int] = Field(None, alias="documentType")
    payment_method: Optional[str] = Field(None, alias="paymentMethod")
    total_amount: Decimal = Field(..., alias="totalAmount")
    tip_amount: Decimal = Field(0, alias="tipAmount")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    refund_of_transaction_id: Optional[uuid.UUID] = Field(None, alias="refundOfTransactionId")
    basket_id: Optional[uuid.UUID] = Field(None, alias="basketId")
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
