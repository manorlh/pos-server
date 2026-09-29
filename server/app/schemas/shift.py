"""Shift (משמרת) payloads. The wire contract is docs/SHIFTS_API.md."""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional
import uuid

from decimal import ROUND_HALF_UP, InvalidOperation
import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: The columns money lands in are NUMERIC(12, 2); a sequence lands in INTEGER.
MONEY = dict(max_digits=12, decimal_places=2)
SEQUENCE_MAX = 2**31 - 1
_CENT = Decimal("0.01")


def to_cents(value):
    """
    A money input as a Decimal of whole cents, before the 12-digit bound is checked.

    The till sends doubles (`12.300000000000001`); rounding to the cent first means only
    a value that cannot fit the column — or is not a number, NaN and Infinity included —
    is refused, as a 422 the till parks (never a 500 it retries forever).
    """
    if value is None or isinstance(value, bool):
        return value
    try:
        amount = Decimal(str(value).strip()) if isinstance(value, (str, int, float, Decimal)) else value
    except (InvalidOperation, ValueError):
        return value
    if isinstance(amount, Decimal) and amount.is_finite():
        return amount.quantize(_CENT, rounding=ROUND_HALF_UP)
    return value


def finite_json(value):
    """
    The till's own X, kept for audit, made storable: NaN / Infinity are not JSON and
    Postgres JSONB refuses them, which failed the close with a 500. Each is kept as its
    name in a string (`"NaN"`), which the comparison then reads as a mismatch.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: finite_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite_json(v) for v in value]
    return value


class ShiftOpenIn(BaseModel):
    """
    A shift the till has already opened, reported to the cloud.

    Not a request to open one — the till opens shifts by itself and sells at once, with
    or without a connection. This carries what only the till knows: the real opening
    time, the float, and who opened it.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    business_date: date = Field(..., alias="businessDate")
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber", ge=0, le=SEQUENCE_MAX)
    opened_at: datetime = Field(..., alias="openedAt")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash", **MONEY)
    opened_by_user_id: Optional[str] = Field(None, alias="openedByUserId", max_length=100)
    opened_by_name: Optional[str] = Field(None, alias="openedByName", max_length=255)

    @field_validator("opening_cash", mode="before")
    @classmethod
    def _cents(cls, value):
        return to_cents(value)


class ShiftCloseIn(BaseModel):
    """The till's close of one shift: the count, the document list, and its own X."""

    model_config = ConfigDict(populate_by_name=True)

    closed_at: datetime = Field(..., alias="closedAt")
    closed_by_user_id: Optional[str] = Field(None, alias="closedByUserId", max_length=100)
    closed_by_name: Optional[str] = Field(None, alias="closedByName", max_length=255)
    #: Closed remotely with nobody at the drawer. The server then stores no count,
    #: whatever the body says, so the X cannot claim a variance nobody verified.
    unattended: bool = False
    counted_cash: Optional[Decimal] = Field(None, alias="countedCash", **MONEY)
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash", **MONEY)
    #: Every document of the shift. 409 until each one is on the cloud.
    transaction_ids: List[uuid.UUID] = Field(default_factory=list, alias="transactionIds")
    last_transaction_number: Optional[str] = Field(None, alias="lastTransactionNumber", max_length=100)
    #: The till's own X figures. Stored for audit and compared; never used for a Z.
    till: Optional[Dict[str, Any]] = None
    close_request_id: Optional[uuid.UUID] = Field(None, alias="closeRequestId")

    # Optional open fields, so a shift whose open event never arrived can still close.
    business_date: Optional[date] = Field(None, alias="businessDate")
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber", ge=0, le=SEQUENCE_MAX)
    opened_at: Optional[datetime] = Field(None, alias="openedAt")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash", **MONEY)
    opened_by_user_id: Optional[str] = Field(None, alias="openedByUserId", max_length=100)
    opened_by_name: Optional[str] = Field(None, alias="openedByName", max_length=255)

    @field_validator("counted_cash", "expected_cash", "opening_cash", mode="before")
    @classmethod
    def _cents(cls, value):
        return to_cents(value)

    @field_validator("till", mode="before")
    @classmethod
    def _finite_till(cls, value):
        return finite_json(value)


class ShiftTotalsOut(BaseModel):
    """The X figures (docs/SHIFTS_API.md §3.2)."""

    model_config = ConfigDict(populate_by_name=True)

    #: Net of document discounts (what the sales collected).
    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    #: Σ totalAmount of the sales, before document discounts — compare with the till's
    #: `totalSales`. Null on a shift closed before it was stored and not backfillable.
    gross_sales: Optional[Decimal] = Field(None, alias="grossSales")
    #: Σ documentDiscount of the sales — compare with the till's `totalDiscounts`.
    discounts_total: Optional[Decimal] = Field(None, alias="discountsTotal")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    total_cash: Optional[Decimal] = Field(None, alias="totalCash")
    total_card: Optional[Decimal] = Field(None, alias="totalCard")
    total_tips: Optional[Decimal] = Field(None, alias="totalTips")
    total_cash_tips: Optional[Decimal] = Field(None, alias="totalCashTips")
    total_card_tips: Optional[Decimal] = Field(None, alias="totalCardTips")
    vat_total: Optional[Decimal] = Field(None, alias="vatTotal")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")
    first_transaction_number: Optional[str] = Field(None, alias="firstTransactionNumber")
    last_transaction_number: Optional[str] = Field(None, alias="lastTransactionNumber")


class ShiftOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    business_date: date = Field(..., alias="businessDate")
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber")
    status: str
    opened_at: datetime = Field(..., alias="openedAt")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    opened_by_user_id: Optional[str] = Field(None, alias="openedByUserId")
    opened_by_name: Optional[str] = Field(None, alias="openedByName")
    closed_at: Optional[datetime] = Field(None, alias="closedAt")
    close_accepted_at: Optional[datetime] = Field(None, alias="closeAcceptedAt")
    closed_by_user_id: Optional[str] = Field(None, alias="closedByUserId")
    closed_by_name: Optional[str] = Field(None, alias="closedByName")
    unattended: bool = False
    counted_cash: Optional[Decimal] = Field(None, alias="countedCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    discrepancy: Optional[Decimal] = None
    server_totals: Optional[ShiftTotalsOut] = Field(None, alias="serverTotals")
    till_totals: Optional[Dict[str, Any]] = Field(None, alias="tillTotals")
    totals_mismatch: bool = Field(False, alias="totalsMismatch")
    #: Documents that arrived after the close (see docs/SHIFTS_API.md §3.1).
    late_documents: int = Field(0, alias="lateDocuments")
    #: Documents rewritten (fiscal content) after this shift went into a Z (§1.2).
    amended_documents: int = Field(0, alias="amendedDocuments")
    #: Opened with a sequence number at or below one its till already used (§1.1).
    sequence_out_of_order: bool = Field(False, alias="sequenceOutOfOrder")
    reconstructed: bool = False
    reconstruction_basis: Optional[Dict[str, Any]] = Field(None, alias="reconstructionBasis")
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    z_number: Optional[int] = Field(None, alias="zNumber")

    # Filled on dashboard reads.
    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_name: Optional[str] = Field(None, alias="shopName")
    payment_breakdown: Optional[Dict[str, Any]] = Field(None, alias="paymentBreakdown")


class ShiftCloseResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["accepted", "duplicate"]
    shift_id: uuid.UUID = Field(..., alias="shiftId")
    server_totals: Optional[ShiftTotalsOut] = Field(None, alias="serverTotals")
    totals_mismatch: bool = Field(False, alias="totalsMismatch")
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    z_number: Optional[int] = Field(None, alias="zNumber")
    server_time: datetime = Field(..., alias="serverTime")


class ShiftMissingResponse(BaseModel):
    """409 — push these documents and retry the close."""

    model_config = ConfigDict(populate_by_name=True)

    detail: Literal["missing_transactions"] = "missing_transactions"
    missing_ids: List[uuid.UUID] = Field(..., alias="missingIds")
    stale_ids: List[uuid.UUID] = Field(default_factory=list, alias="staleIds")


class ShiftCloseAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: uuid.UUID = Field(..., alias="requestId")
    phase: Literal["received", "deferred", "completed", "failed"]
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    error_code: Optional[str] = Field(None, alias="errorCode", max_length=64)
    error_message: Optional[str] = Field(None, alias="errorMessage", max_length=2000)


class ShiftCloseAckResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    item_status: str = Field(..., alias="itemStatus")


class LastClosedShift(BaseModel):
    """The till's last closed shift, to prefill the next opening float."""

    model_config = ConfigDict(populate_by_name=True)

    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber")
    business_date: Optional[date] = Field(None, alias="businessDate")
    closed_at: Optional[datetime] = Field(None, alias="closedAt")
    counted_cash: Optional[Decimal] = Field(None, alias="countedCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    reconstructed: bool = False
    #: The highest numeric document number the cloud holds from this machine (a JSON
    #: integer, the till's `Long`); null if none. Sent even when no shift was closed.
    highest_transaction_number: Optional[int] = Field(None, alias="highestTransactionNumber")


class ShiftListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ShiftOut]
