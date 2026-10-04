"""
The reports of docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3: payment methods, hour of day,
department, document sequence, cash variance. Money as float, like every report schema
(`app/schemas/reports.py`). camelCase on the wire.
"""
from datetime import date, datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.schemas.reports import ReportWindowOut


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


# ── Payment methods ──────────────────────────────────────────────────────────


class PaymentMethodRow(_Camel):
    day: date
    shop_id: Optional[uuid.UUID] = None
    shop_name: Optional[str] = None
    machine_id: Optional[uuid.UUID] = None
    machine_name: Optional[str] = None
    #: The tender as stored ("cash", "card", "voucher", …).
    method: str
    #: cash | card | exchange | other — `normalize_tender`.
    bucket: str
    amount: float
    documents: int


class PaymentMethodTotal(_Camel):
    method: str
    bucket: str
    amount: float
    documents: int
    share: float


class PaymentMethodsReportResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    rows: List[PaymentMethodRow]
    totals: List[PaymentMethodTotal]
    total: float


# ── Card brands / acquirers (דוח סליקה) ──────────────────────────────────────


class CardBrandRow(_Camel):
    """Card legs of one shop, brand (מותג) and acquirer (חברת סליקה)."""

    shop_id: Optional[uuid.UUID] = None
    shop_name: Optional[str] = None
    #: visa | mastercard | amex | diners | isracard | jcb | discover | maestro | other
    brand: str
    #: isracard | cal | max | diners | amex | other | unknown
    acquirer: str
    sales_count: int
    sales_amount: float
    #: Credit notes on a card, positive.
    refunds_count: int
    refunds_amount: float
    net: float


class CardBrandTotal(_Camel):
    #: The brand or acquirer code (see CardBrandRow).
    key: str
    sales_count: int
    sales_amount: float
    refunds_count: int
    refunds_amount: float
    net: float
    #: Share of the card net, percent.
    share: float


class CardBrandsReportResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    rows: List[CardBrandRow]
    by_brand: List[CardBrandTotal]
    by_acquirer: List[CardBrandTotal]
    sales_count: int
    sales_amount: float
    refunds_count: int
    refunds_amount: float
    net: float


# ── Hour of day ──────────────────────────────────────────────────────────────


class HourlyCell(_Camel):
    #: 0 = Sunday … 6 = Saturday (the Israeli week).
    weekday: int
    hour: int
    net: float
    documents: int


class HourlyRow(_Camel):
    hour: int
    net: float
    documents: int
    average_basket: float


class HourlyReportResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    cells: List[HourlyCell]
    by_hour: List[HourlyRow]
    total: float
    documents: int


# ── Department ───────────────────────────────────────────────────────────────


class DepartmentRow(_Camel):
    category_id: Optional[uuid.UUID] = None
    category_name: Optional[str] = None
    units: float
    gross: float
    discounts: float
    refunds: float
    net: float
    share: float


class DepartmentReportResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    rows: List[DepartmentRow]
    totals: DepartmentRow


# ── Document sequence ────────────────────────────────────────────────────────


class SequenceGap(_Camel):
    #: First and last missing number (inclusive).
    from_number: int
    to_number: int
    missing: int


class SequenceRow(_Camel):
    machine_id: uuid.UUID
    machine_name: Optional[str] = None
    shop_name: Optional[str] = None
    document_type: Optional[int] = None
    first_number: Optional[str] = None
    last_number: Optional[str] = None
    documents: int
    missing: int
    duplicates: List[str]
    non_numeric: int
    gaps: List[SequenceGap]


class DocumentSequenceResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    rows: List[SequenceRow]
    total_missing: int


# ── Cash variance ────────────────────────────────────────────────────────────


class CashVarianceShift(_Camel):
    shift_id: uuid.UUID
    business_date: date
    shop_name: Optional[str] = None
    machine_name: Optional[str] = None
    sequence_number: Optional[int] = None
    cashier: Optional[str] = None
    opened_at: datetime
    closed_at: Optional[datetime] = None
    expected_cash: Optional[float] = None
    counted_cash: Optional[float] = None
    #: counted − expected; null when nobody counted.
    variance: Optional[float] = None
    unattended: bool = False


class CashVarianceCashier(_Camel):
    cashier: Optional[str] = None
    shifts: int
    counted_shifts: int
    over: float
    short: float
    net: float


class CashVarianceResponse(_Camel):
    window: ReportWindowOut
    generated_at: datetime
    shifts: List[CashVarianceShift]
    by_cashier: List[CashVarianceCashier]
    total_variance: float
    uncounted: int
