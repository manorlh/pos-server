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
