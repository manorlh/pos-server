"""
Response schemas for the operational reports (products, cashiers, tips, shop feed).

Money is exposed as `float` rather than `Decimal`, matching the dashboard KPI
schemas (`app/schemas/dashboard.py`) so the UI gets one number format across every
report surface. The fiscal export path keeps Decimal; these are management reports.
"""
from datetime import date, datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field


class ReportWindowOut(BaseModel):
    """
    The window the server actually used, echoed back on every report.

    Echoed rather than assumed, because the merchant thinks in Israel local time
    while documents are stamped in UTC: the UI has to be able to label a report
    "27 Aug, 18:00–22:00 Asia/Jerusalem" using the server's resolved values, not
    its own guess about which timezone the hours were interpreted in.
    """

    model_config = ConfigDict(populate_by_name=True)

    from_date: date = Field(..., alias="from")
    to_date: date = Field(..., alias="to")
    from_hour: Optional[int] = Field(None, alias="fromHour")
    to_hour: Optional[int] = Field(None, alias="toHour")
    timezone: str
    # The absolute UTC bounds of the outer day range (end exclusive). With an hour
    # filter the covered set is a subset of this span, not the whole of it.
    window_start: datetime = Field(..., alias="windowStart")
    window_end: datetime = Field(..., alias="windowEnd")


# ── 2a. Product sales ─────────────────────────────────────────────────────────

class ProductSalesRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    sku: Optional[str] = None

    units_sold: float = Field(..., alias="unitsSold")
    units_refunded: float = Field(..., alias="unitsRefunded")
    #: unitsSold - unitsRefunded. What actually left the shop.
    units_net: float = Field(..., alias="unitsNet")

    gross: float
    discounts: float
    #: Money credited back on this product via credit notes. Always >= 0, and it
    #: SUBTRACTS from net — a credit note never adds to a product's takings.
    refunds: float
    #: gross - discounts - refunds
    net: float

    lines_sold: int = Field(..., alias="linesSold")
    lines_refunded: int = Field(..., alias="linesRefunded")


class ProductSalesTotals(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    units_sold: float = Field(..., alias="unitsSold")
    units_refunded: float = Field(..., alias="unitsRefunded")
    units_net: float = Field(..., alias="unitsNet")
    gross: float
    discounts: float
    refunds: float
    net: float
    product_count: int = Field(..., alias="productCount")


class ProductSalesReportResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    #: True when the row cap trimmed the tail. The totals still cover every row.
    truncated: bool
    row_limit: int = Field(..., alias="rowLimit")
    totals: ProductSalesTotals
    rows: List[ProductSalesRow]


# ── 2b. Per-cashier ───────────────────────────────────────────────────────────

class CashierSalesRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Null for documents whose cashier_id is missing or is not a known pos_user.
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    cashier_name: Optional[str] = Field(None, alias="cashierName")
    worker_number: Optional[str] = Field(None, alias="workerNumber")

    #: Sales + credit notes. Cancelled and pending documents are never counted.
    document_count: int = Field(..., alias="documentCount")
    sales_count: int = Field(..., alias="salesCount")
    refunds_count: int = Field(..., alias="refundsCount")

    gross: float
    discounts: float
    refunds: float
    #: gross - discounts - refunds
    net: float
    average_basket: float = Field(..., alias="averageBasket")

    #: Net money by tender: sales less their discounts, less credit notes paid back
    #: on the same tender. These three sum to `net`.
    cash_net: float = Field(..., alias="cashNet")
    card_net: float = Field(..., alias="cardNet")
    other_net: float = Field(..., alias="otherNet")

    tips: float


class CashierSalesReportResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    totals: CashierSalesRow
    rows: List[CashierSalesRow]


# ── 2c. Tips ──────────────────────────────────────────────────────────────────

class TipMethodRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Normalised tip payment method: "cash", "card", or "other".
    method: str
    amount: float
    document_count: int = Field(..., alias="documentCount")


class TipsByCashierRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cashier_id: Optional[str] = Field(None, alias="cashierId")
    cashier_name: Optional[str] = Field(None, alias="cashierName")
    worker_number: Optional[str] = Field(None, alias="workerNumber")

    tips_total: float = Field(..., alias="tipsTotal")
    tips_cash: float = Field(..., alias="tipsCash")
    tips_card: float = Field(..., alias="tipsCard")
    tips_other: float = Field(..., alias="tipsOther")
    #: Documents that carried a non-zero tip.
    tipped_document_count: int = Field(..., alias="tippedDocumentCount")
    #: Net takings by this cashier over the window, for a tips-to-sales ratio.
    sales_net: float = Field(..., alias="salesNet")


class TipsRangeReportResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    tips_total: float = Field(..., alias="tipsTotal")
    tips_cash: float = Field(..., alias="tipsCash")
    tips_card: float = Field(..., alias="tipsCard")
    tips_other: float = Field(..., alias="tipsOther")
    by_method: List[TipMethodRow] = Field(..., alias="byMethod")
    by_cashier: List[TipsByCashierRow] = Field(..., alias="byCashier")


# ── 2e. Shop-wide recent documents (fixed contract — the till calls this) ─────

class ShopTransactionRow(BaseModel):
    """
    Deliberately thin: enough for a cashier to identify another till's document and
    see what it was worth, and nothing fiscal. Field names and types are fixed by
    the shipped Android client (ShopTransactionDto) — do not rename or retype.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str
    transaction_number: Optional[str] = Field(None, alias="transactionNumber")
    document_type: Optional[int] = Field(None, alias="documentType")
    total: float = 0.0
    payment_method: Optional[str] = Field(None, alias="paymentMethod")
    status: Optional[str] = None
    cashier_name: Optional[str] = Field(None, alias="cashierName")
    machine_name: Optional[str] = Field(None, alias="machineName")
    created_at: Optional[str] = Field(None, alias="createdAt")


class ShopTransactionsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    server_time: str = Field(..., alias="serverTime")
    transactions: List[ShopTransactionRow]


# ── 2f. Day summary — several tills' Z reports rolled into one day ────────────
#
# Named "day summary" (סיכום יומי) and not "union Z". A Z report is a fiscal
# document a single terminal issues once and cannot reissue; this is a read over
# several of them. Giving it a Z-like name would invite someone to treat it as a
# filing, or to expect printing it to close anything.

class DaySummaryTotals(BaseModel):
    """
    One day's takings across every contributing terminal.

    Money fields are plain sums. The two nullable ones are the point of this schema:
    a figure that cannot be computed completely is returned as `null` with a count of
    what was missing, never as a partial sum. An understated total that looks like a
    total is worse than an obvious gap — the manager reconciling the day would have no
    way to tell.
    """

    model_config = ConfigDict(populate_by_name=True)

    sales: float = 0.0
    refunds: float = 0.0
    #: `sales - refunds`. Precomputed so every caller subtracts the same way.
    net: float = 0.0
    cash_sales: float = Field(0.0, alias="cashSales")
    card_sales: float = Field(0.0, alias="cardSales")
    transactions_count: int = Field(0, alias="transactionsCount")

    tips: float = 0.0
    cash_tips: float = Field(0.0, alias="cashTips")
    card_tips: float = Field(0.0, alias="cardTips")

    opening_cash: float = Field(0.0, alias="openingCash")
    expected_cash: float = Field(0.0, alias="expectedCash")

    #: Null unless *every* contributing Z reported its VAT.
    #:
    #: VAT is read from the Z payload (`taxCollected`), which older reports predate.
    #: Summing only the ones that have it would understate the day's VAT while
    #: presenting it as the day's VAT.
    vat: Optional[float] = None
    vat_missing_count: int = Field(0, alias="vatMissingCount")

    #: Null unless *every* contributing Z was actually counted.
    #:
    #: An unattended close leaves `actual_cash` NULL on purpose — nobody opened the
    #: drawer. Treating that as zero would make a day containing one unattended till
    #: report a variance that nobody verified, which is exactly the lie the
    #: `unattended` flag was added to stop.
    actual_cash: Optional[float] = Field(None, alias="actualCash")
    variance: Optional[float] = None
    uncounted_count: int = Field(0, alias="uncountedCount")


class DaySummaryContributor(BaseModel):
    """
    One Z report behind a day's figures, and the drill-down target.

    `zReportId` is what `GET /z-reports/{id}` takes, so the summary never has to
    restate a Z's contents — the reader follows the link to the document itself.
    """

    model_config = ConfigDict(populate_by_name=True)

    z_report_id: uuid.UUID = Field(..., alias="zReportId")
    #: The shop's Z number, which is what a bookkeeper will quote. Null on a Z from a
    #: terminal with no shop.
    shop_sequence_number: Optional[int] = Field(None, alias="shopSequenceNumber")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    closed_at: Optional[datetime] = Field(None, alias="closedAt")
    unattended: bool = False
    #: Built by the cloud because the terminal could not close its own day. Shown in the
    #: drill-down so a day whose figures rest on a reconstruction says so on its face.
    reconstructed: bool = False
    #: True when this Z has no counted cash, i.e. it is why `variance` is null.
    uncounted: bool = False

    sales: float = 0.0
    refunds: float = 0.0
    net: float = 0.0
    cash_sales: float = Field(0.0, alias="cashSales")
    card_sales: float = Field(0.0, alias="cardSales")
    tips: float = 0.0
    transactions_count: int = Field(0, alias="transactionsCount")
    expected_cash: float = Field(0.0, alias="expectedCash")
    actual_cash: Optional[float] = Field(None, alias="actualCash")
    discrepancy: Optional[float] = None


class DaySummaryRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    day_date: date = Field(..., alias="dayDate")
    #: Distinct terminals that filed a Z for this day, not the number of Z reports.
    #: A till that ran two shifts files two, and "3 tills" is the useful figure.
    machine_count: int = Field(0, alias="machineCount")
    z_report_count: int = Field(0, alias="zReportCount")
    totals: DaySummaryTotals
    contributors: List[DaySummaryContributor] = Field(default_factory=list)


class DaySummaryReportResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Echoed back like every other report here, so the UI labels the range with the
    #: server's resolved timezone rather than its own guess about it.
    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    #: Rolled across every day in the range, under the same completeness rules.
    totals: DaySummaryTotals
    days: List[DaySummaryRow]
