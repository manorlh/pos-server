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
    opened_by: Optional[str] = Field(None, alias="openedBy")
    closed_by: Optional[str] = Field(None, alias="closedBy")

    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")

    # POS sends the list of transaction IDs it expects to be present on the cloud.
    # Server returns 409 if any are missing or stale, so POS can flush again.
    transaction_ids: List[uuid.UUID] = Field(default_factory=list, alias="transactionIds")

    # Full ZReportData blob from POS (passes through to z_reports.payload).
    payload: Optional[dict] = None


class ZReportUpsertResponse(BaseModel):
    """200 OK response — idempotent (status='accepted' on first call, 'duplicate' on retry)."""

    model_config = ConfigDict(populate_by_name=True)

    status: Literal["accepted", "duplicate"]
    z_report_id: uuid.UUID = Field(..., alias="zReportId")
    trading_day_id: uuid.UUID = Field(..., alias="tradingDayId")
    server_time: datetime = Field(..., alias="serverTime")


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
    machine_id: uuid.UUID = Field(..., alias="machineId")
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    day_date: date = Field(..., alias="dayDate")
    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    closing_cash: Optional[Decimal] = Field(None, alias="closingCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    actual_cash: Optional[Decimal] = Field(None, alias="actualCash")
    discrepancy: Optional[Decimal]
    payload: Optional[dict]
    closed_at: datetime = Field(..., alias="closedAt")
    created_at: datetime = Field(..., alias="createdAt")


class ZReportListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ZReportOut]
