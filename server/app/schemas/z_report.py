from datetime import date, datetime
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field


class ZReportIn(BaseModel):
    """Z-report payload from POS at end of trading day."""

    model_config = ConfigDict(populate_by_name=True)

    trading_day_id: uuid.UUID = Field(..., alias="tradingDayId")
    day_date: date = Field(..., alias="dayDate")
    opened_at: datetime = Field(..., alias="openedAt")
    closed_at: datetime = Field(..., alias="closedAt")

    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    closing_cash: Optional[Decimal] = Field(None, alias="closingCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    actual_cash: Optional[Decimal] = Field(None, alias="actualCash")
    discrepancy: Optional[Decimal] = None
    #: Closed from the cloud with nobody at the drawer. When true the server ignores
    #: any counted figure and stores NULL, so the Z cannot claim a variance of zero
    #: that nobody verified.
    unattended: bool = False
    opened_by: Optional[str] = Field(None, alias="openedBy")
    closed_by: Optional[str] = Field(None, alias="closedBy")

    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    total_tips: Optional[Decimal] = Field(None, alias="totalTips")
    total_cash_tips: Optional[Decimal] = Field(None, alias="totalCashTips")
    total_card_tips: Optional[Decimal] = Field(None, alias="totalCardTips")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")

    # POS sends the list of transaction IDs it expects to be present on the cloud.
    # Server returns 409 if any are missing or stale, so POS can flush again.
    transaction_ids: List[uuid.UUID] = Field(default_factory=list, alias="transactionIds")

    # Full ZReportData blob from POS (passes through to z_reports.payload).
    payload: Optional[dict] = None

    # Links cloud-initiated close-day request (belt-and-suspenders completion).
    close_day_request_id: Optional[uuid.UUID] = Field(None, alias="closeDayRequestId")


class ZReportUpsertResponse(BaseModel):
    """200 OK response — idempotent (status='accepted' on first call, 'duplicate' on retry)."""

    model_config = ConfigDict(populate_by_name=True)

    status: Literal["accepted", "duplicate"]
    z_report_id: uuid.UUID = Field(..., alias="zReportId")
    trading_day_id: uuid.UUID = Field(..., alias="tradingDayId")
    server_time: datetime = Field(..., alias="serverTime")
    #: The shop's Z number for this close, assigned by the server.
    #:
    #: Returned so the till can store it and print it on a reprint. It cannot be on the
    #: paper torn off at close: no till knows what the other tills in the shop have
    #: closed, and an offline close has nobody to ask. Returned on a duplicate too —
    #: with the number the first close was given — so a till that never saw the original
    #: acknowledgement still ends up holding the right one.
    shop_sequence_number: Optional[int] = Field(None, alias="shopSequenceNumber")


class ZReportMissingResponse(BaseModel):
    """409 Conflict response — POS must flush these tx ids and retry."""

    model_config = ConfigDict(populate_by_name=True)

    detail: Literal["missing_transactions"] = "missing_transactions"
    missing_ids: List[uuid.UUID] = Field(..., alias="missingIds")
    stale_ids: List[uuid.UUID] = Field(default_factory=list, alias="staleIds")


class ZReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    trading_day_id: uuid.UUID = Field(..., alias="tradingDayId")
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    day_date: date = Field(..., alias="dayDate")
    #: The shop's Z counter. Null on a Z from a terminal with no shop, and on closes
    #: filed before the column existed and outside the migration's backfill.
    shop_sequence_number: Optional[int] = Field(None, alias="shopSequenceNumber")
    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    total_tips: Optional[Decimal] = Field(None, alias="totalTips")
    total_cash_tips: Optional[Decimal] = Field(None, alias="totalCashTips")
    total_card_tips: Optional[Decimal] = Field(None, alias="totalCardTips")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    closing_cash: Optional[Decimal] = Field(None, alias="closingCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    actual_cash: Optional[Decimal] = Field(None, alias="actualCash")
    discrepancy: Optional[Decimal]
    payload: Optional[dict]
    closed_at: datetime = Field(..., alias="closedAt")
    created_at: datetime = Field(..., alias="createdAt")

    # Filled in by the list endpoint so a Z-report history table can name the
    # terminal and branch without a lookup per row. Left None on the single-report
    # read, where the caller already knows which machine it asked about.
    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_name: Optional[str] = Field(None, alias="shopName")


class ZReportListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ZReportOut]
