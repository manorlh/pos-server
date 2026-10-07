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
    #: "Z לכל קופה": the till's own Z counter (and no shop number). Null on a shop Z.
    machine_sequence_number: Optional[int] = Field(None, alias="machineSequenceNumber")
    #: The number the Z is known by — the till's own under "Z לכל קופה", else the shop's.
    z_number: Optional[int] = Field(None, alias="zNumber")
    #: True for a till's own Z ("Z לכל קופה").
    per_till: bool = Field(False, alias="perTill")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    business_date: date = Field(..., alias="businessDate")
    #: The local date the Z was produced (`closedAt` in the list's timezone). Filled by
    #: the list (`GET /z-reports`), which can filter and sort on it (`dateBasis`).
    production_date: Optional[date] = Field(None, alias="productionDate")
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
    #: Documents of its shifts rewritten (fiscal content) after it was built.
    amended_documents: int = Field(0, alias="amendedDocuments")

    total_sales: Optional[Decimal] = Field(None, alias="totalSales")
    #: Σ totalAmount of the sales, before document discounts (= totalSales + discountsTotal).
    gross_sales: Optional[Decimal] = Field(None, alias="grossSales")
    #: Sales less refunds (= totalSales − totalRefunds).
    net_sales: Optional[Decimal] = Field(None, alias="netSales")
    total_refunds: Optional[Decimal] = Field(None, alias="totalRefunds")
    discounts_total: Optional[Decimal] = Field(None, alias="discountsTotal")
    total_cash_sales: Optional[Decimal] = Field(None, alias="totalCashSales")
    total_card_sales: Optional[Decimal] = Field(None, alias="totalCardSales")
    #: Net of the `exchange` legs of mixed baskets (§1.2a); zero when every basket is
    #: complete. Null on a Z built before it was stored.
    total_exchange: Optional[Decimal] = Field(None, alias="totalExchange")
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
    #: Σ of the per-till `betweenShiftAdjustments` (§3.6): cash put into or taken out of
    #: the drawers between shifts, part of `expectedCash`. Null on a Z built before it
    #: was stored, and on a legacy Z.
    between_shift_adjustments: Optional[Decimal] = Field(None, alias="betweenShiftAdjustments")
    #: Σ of the per-till `offline` blocks: offline-approved card sales that went through an
    #: authorization run, and those of them the acquirer declined. Null on a Z built before
    #: the block was stored, and on a legacy Z.
    offline_authorization_count: Optional[int] = Field(None, alias="offlineAuthorizationCount")
    offline_approved_count: Optional[int] = Field(None, alias="offlineApprovedCount")
    offline_declined_count: Optional[int] = Field(None, alias="offlineDeclinedCount")
    offline_declined_amount: Optional[Decimal] = Field(None, alias="offlineDeclinedAmount")
    closed_at: datetime = Field(..., alias="closedAt")
    created_at: datetime = Field(..., alias="createdAt")

    #: A pre-shift Z issued by one till (it has `machineId` and no per-till sections).
    legacy: bool = False
    #: "cloud" (a Z run over the shop's tills) or "till" (the till's own Z, §5).
    origin: str = "cloud"
    #: A till Z's number in its till's own run; null on a cloud Z (its number is
    #: `shopSequenceNumber`). Shown as "קופה {posNumber or machineName} · Z {this}".
    machine_sequence_number: Optional[int] = Field(None, alias="machineSequenceNumber")
    #: A till Z's run: 0 for the till's first, +1 each time it was made independent (which
    #: starts its Zs at 1 again), and when that run began — shown beside the number so two
    #: "Z 1" of one till are told apart (docs/SPEC_INDEPENDENT_TILL.md §3.1).
    machine_sequence_epoch: int = Field(0, alias="machineSequenceEpoch")
    sequence_started_at: Optional[str] = Field(None, alias="sequenceStartedAt")
    #: A local shop Z checked against the cloud's documents (docs/SPEC_INDEPENDENT_TILL.md
    #: §8.12): `{state: waiting|incomplete|verified|mismatch|closed_by_support|unverified,
    #: message, checkedAt, tills: [{machineId, posNumber, state, message, named, arrived,
    #: missing, shiftsAwaited, …}]}`; null on any other Z.
    verification: Optional[Dict[str, Any]] = None
    #: The register number of a till Z's till, as frozen in its section; null otherwise.
    pos_number: Optional[str] = Field(None, alias="posNumber")
    #: Who pressed "הפק Z" at the till; null when produced remotely, and on a cloud Z.
    created_by_name: Optional[str] = Field(None, alias="createdByName")
    #: A till Z whose till-sent figures differed from the built ones (shown, not refused).
    totals_mismatch: bool = Field(False, alias="totalsMismatch")
    #: A till Z closed at the till with no connection and uploaded later
    #: (docs/SPEC_OFFLINE_TILL_Z.md): "נסגר ללא חיבור", when it came up, and where the
    #: cloud's figures differ from the till's paper (`[{key, till, cloud}]`, null = none).
    built_offline: bool = Field(False, alias="builtOffline")
    uploaded_at: Optional[datetime] = Field(None, alias="uploadedAt")
    #: The shop's branch code ("קוד סניף") as frozen on the Z (else the shop's now). With the
    #: till number (`posNumber`, a till Z) it tells apart two Zs of one branch that carry the
    #: same number (docs/SPEC_INDEPENDENT_TILL.md §11).
    branch_code: Optional[str] = Field(None, alias="branchCode")
    #: What the Z includes, frozen at build (docs/SPEC_INDEPENDENT_TILL.md §7):
    #: `{kind: shop|area|till|independent_till, label, tills, independentOutside}`; null on
    #: a Z built before it was stored.
    scope: Optional[Dict[str, Any]] = None
    #: "סוג Z" (docs/SPEC_REPORTS.md §4): `shop` (Z סניפי) | `independent` (Z עצמאי) |
    #: `till` (Z לכל קופה) | `kiosk` (a kiosk's own Z) | `legacy` — app/services/z_table.py.
    z_type: Optional[str] = Field(None, alias="zType")
    offline_discrepancies: Optional[List[Dict[str, Any]]] = Field(None, alias="offlineDiscrepancies")
    #: The card batch transmission the till ran before the Z, with the terminal's answer
    #: (`{outcome, batchNumber, statusMessage, transactionCount, amount, byBrand, …}`).
    card_transmission: Optional[Dict[str, Any]] = Field(None, alias="cardTransmission")
    #: Produced by support from the cloud for a dead till (offline till Z spec §4.6):
    #: `{by, at, reason, reasonText, note, skippedNumbers}`; null otherwise.
    produced_by_support: Optional[Dict[str, Any]] = Field(None, alias="producedBySupport")
    #: Late documents of a support Z this Z took, in their own section (§4.6.3).
    late_from_earlier: Optional[List[Dict[str, Any]]] = Field(None, alias="lateFromEarlier")
    #: Documents that arrived after this Z and were carried into the next one (§4.6.3).
    late_carried_out: Optional[int] = Field(None, alias="lateCarriedOut")
    #: "המכשיר הוחלף בתאריך …": the till(s) whose device was replaced before this Z (§4.6.2).
    devices_replaced: Optional[List[Dict[str, Any]]] = Field(None, alias="devicesReplaced")
    #: The till of a till Z, and of a legacy row; null on a cloud Z (it spans tills).
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    #: Legacy rows: the till's own Z blob.
    payload: Optional[dict] = None

    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_name: Optional[str] = Field(None, alias="shopName")
    #: The shop's number in its company today ("#3"); a live label, not part of the Z.
    shop_number: Optional[int] = Field(None, alias="shopNumber")
    #: The area the Z was started for, and its name as frozen in the header at build.
    #: Both null for a whole-shop or hand-picked Z.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")


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
    area_id: Optional[str] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
    captured_at: Optional[str] = Field(None, alias="capturedAt")
    #: A shop Z produced on the operator's confirmation without some tills
    #: (`shopZOpenTills`): `{tills: [{id, posNumber, name, openShiftId}],
    #: confirmedByUserId, confirmedByName, confirmedAt}`. Absent otherwise.
    open_tills_left_out: Optional[Dict[str, Any]] = Field(None, alias="openTillsLeftOut")
    #: A local shop Z: stored exactly as the main till printed it — `{producedBy: {machineId,
    #: posNumber, name}, note}` (docs/SPEC_INDEPENDENT_TILL.md §8.7). Absent otherwise.
    as_printed: Optional[Dict[str, Any]] = Field(None, alias="asPrinted")


class ZReportDetailOut(ZReportOut):
    #: The per-register sections, as stored at build time (money as decimal strings).
    per_machine: List[Dict[str, Any]] = Field(default_factory=list, alias="perMachine")
    #: A till Z: the till's own sum as it sent it (audit; never the figures).
    till_totals: Optional[Dict[str, Any]] = Field(None, alias="tillTotals")
    #: A Z closed offline: what the till printed (its number, shifts, document range and
    #: section), kept beside the cloud's figures.
    offline_report: Optional[Dict[str, Any]] = Field(None, alias="offlineReport")
    shifts: List[ShiftOut] = Field(default_factory=list)
    business: Optional[ZReportBusinessOut] = None
    #: Card legs per brand (מותג) × acquirer (חברת סליקה), summed over the sections:
    #: {brand, acquirer, salesCount, salesAmount, refundsCount, refundsAmount, net}.
    card_brands: List[Dict[str, Any]] = Field(default_factory=list, alias="cardBrands")
    #: "stored" — frozen in the sections at build time; "documents" — a Z built before
    #: the split, read now from its documents; null — no card split (a till-issued Z).
    card_brands_source: Optional[str] = Field(None, alias="cardBrandsSource")
    #: Per waiter ("פירוט לפי מלצר", app/services/z_waiters.py): {waiterId, waiter,
    #: salesCount, sales, refundsCount, refunds, net, cash, card, other, tips, tables,
    #: guests}. "stored" — frozen on the header at build; "documents" — a Z built before
    #: it was stored, read now from its documents; null — none (a till-issued Z).
    by_waiter: List[Dict[str, Any]] = Field(default_factory=list, alias="byWaiter")
    by_waiter_source: Optional[str] = Field(None, alias="byWaiterSource")


class ZReportWindow(BaseModel):
    """The date window a Z list was actually filtered on."""

    model_config = ConfigDict(populate_by_name=True)

    from_date: Optional[date] = Field(None, alias="from")
    to_date: Optional[date] = Field(None, alias="to")
    #: True when the caller gave no range and the default (the last 90 days) applied.
    defaulted: bool = False
    #: Which date `from`/`to` are: "business" (the Z's business date) or "production"
    #: (the local date of its `closedAt`).
    date_basis: str = Field("business", alias="dateBasis")
    #: The timezone production dates are measured in (the tenant's, else Israel).
    timezone: Optional[str] = None


class ZReportListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ZReportOut]
    window: Optional[ZReportWindow] = None
