"""Z report reads. The wire contract is docs/SHIFTS_API.md §3.5–§3.6."""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.shift import ShiftOut


class ZReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: The shop's Z counter. Null only on a legacy Z from a terminal with no shop.
    shop_sequence_number: Optional[int] = Field(None, alias="shopSequenceNumber")
    business_date: date = Field(..., alias="businessDate")
    period_start: Optional[datetime] = Field(None, alias="periodStart")
    period_end: Optional[datetime] = Field(None, alias="periodEnd")
    shift_count: Optional[int] = Field(None, alias="shiftCount")
    machine_count: Optional[int] = Field(None, alias="machineCount")
    z_run_id: Optional[uuid.UUID] = Field(None, alias="zRunId")
    created_by_user_id: Optional[uuid.UUID] = Field(None, alias="createdByUserId")

    #: At least one included shift was reconstructed for a dead till.
    reconstructed: bool = False
    #: Legacy rows only (per-shift detail now lives on the shift).
    reconstructed_by: Optional[str] = Field(None, alias="reconstructedBy")
    reconstruction_basis: Optional[dict] = Field(None, alias="reconstructionBasis")
    unattended: bool = False
    #: Documents of its shifts that arrived after it was built (not in its figures).
    late_documents: int = Field(0, alias="lateDocuments")

    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    discounts_total: Optional[Decimal] = Field(None, alias="discountsTotal")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    total_tips: Optional[Decimal] = Field(None, alias="totalTips")
    total_cash_tips: Optional[Decimal] = Field(None, alias="totalCashTips")
    total_card_tips: Optional[Decimal] = Field(None, alias="totalCardTips")
    vat_total: Optional[Decimal] = Field(None, alias="vatTotal")
    transactions_count: Optional[int] = Field(None, alias="transactionsCount")
    payment_breakdown: Optional[Dict[str, Any]] = Field(None, alias="paymentBreakdown")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    actual_cash: Optional[Decimal] = Field(None, alias="actualCash")
    discrepancy: Optional[Decimal] = None
    closed_at: datetime = Field(..., alias="closedAt")
    created_at: datetime = Field(..., alias="createdAt")

    #: A pre-shift Z issued by one till (it has `machineId` and no per-till sections).
    legacy: bool = False
    #: Legacy rows only.
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    #: Legacy rows: the till's own Z blob.
    payload: Optional[dict] = None

    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_name: Optional[str] = Field(None, alias="shopName")


class ZReportBusinessOut(BaseModel):
    """The Z's header as frozen when it was built (`z_reports.header`)."""

    model_config = ConfigDict(populate_by_name=True)

    business_name: Optional[str] = Field(None, alias="businessName")
    vat_number: Optional[str] = Field(None, alias="vatNumber")
    company_reg_number: Optional[str] = Field(None, alias="companyRegNumber")
    company_id: Optional[str] = Field(None, alias="companyId")
    address: Optional[str] = None
    address_number: Optional[str] = Field(None, alias="addressNumber")
    city: Optional[str] = None
    zip: Optional[str] = None
    branch_id: Optional[str] = Field(None, alias="branchId")
    shop_id: Optional[str] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    captured_at: Optional[str] = Field(None, alias="capturedAt")


class ZReportDetailOut(ZReportOut):
    #: The per-register sections, as stored at build time (money as decimal strings).
    per_machine: List[Dict[str, Any]] = Field(default_factory=list, alias="perMachine")
    shifts: List[ShiftOut] = Field(default_factory=list)
    business: Optional[ZReportBusinessOut] = None


class ZReportListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ZReportOut]
