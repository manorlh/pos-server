"""Accounting export API (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2). camelCase on the wire."""
from datetime import date, datetime
from decimal import Decimal
from typing import Dict, List, Literal, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class AccountingSettingsIn(_Camel):
    """One level's own values. Omitted / empty = inherit (shop) or unset (company)."""

    movement_type: Optional[str] = Field(None, max_length=3)
    branch_code: Optional[str] = Field(None, max_length=9)
    encoding: Optional[Literal["cp1255", "cp862"]] = None
    method: Optional[Literal["flexible", "detailed"]] = None
    accounts: Dict[str, Optional[str]] = Field(default_factory=dict)
    card_brands: Dict[str, Optional[str]] = Field(default_factory=dict)
    #: Card receipts per acquirer (חברת סליקה); wins over `card_brands` for a leg.
    card_acquirers: Dict[str, Optional[str]] = Field(default_factory=dict)
    voucher_sales_as_liability: Optional[bool] = None
    #: company — one file for the company; shop — a separate file (batch) per shop.
    #: The company's choice; ignored on a shop row.
    export_level: Optional[Literal["company", "shop"]] = None
    #: Company level: one entry for all shops per day / month, each line with its shop's
    #: cost centre. Ignored on a shop row.
    consolidate: Optional[bool] = None
    #: The shop's cost centre (מרכז רווח) in the books; falls back to the branch code.
    cost_center: Optional[str] = Field(None, max_length=5)

    @field_validator("accounts", "card_brands", "card_acquirers")
    @classmethod
    def _account_keys_fit(cls, value: Dict[str, Optional[str]]):
        for k, v in value.items():
            if v is not None and len(str(v).strip()) > 15:
                raise ValueError(f"account for {k} is longer than 15 characters")
        return value

    def stored(self) -> dict:
        return {
            "movementType": self.movement_type,
            "branchCode": self.branch_code,
            "encoding": self.encoding,
            "method": self.method,
            "accounts": self.accounts,
            "cardBrands": self.card_brands,
            "cardAcquirers": self.card_acquirers,
            "voucherSalesAsLiability": self.voucher_sales_as_liability,
            "exportLevel": self.export_level,
            "consolidate": self.consolidate,
            "costCenter": self.cost_center,
        }


class AccountingSettingsPut(_Camel):
    company_id: uuid.UUID
    shop_id: Optional[uuid.UUID] = None
    settings: AccountingSettingsIn


class AccountingSettingsOut(_Camel):
    company_id: uuid.UUID
    shop_id: Optional[uuid.UUID] = None
    #: The company row's own values (normalized).
    company: dict
    #: The shop row's own values; null when no shop was asked for.
    shop: Optional[dict] = None
    #: Merged: what an export of this company/shop uses.
    effective: dict
    #: Core settings no export can go without, e.g. "movementType", "accounts.cash".
    missing: List[str]
    account_keys: List[str]
    updated_at: Optional[datetime] = None


class ExportedRef(_Camel):
    batch_id: uuid.UUID
    batch_number: int
    created_at: datetime
    #: company | shop — the level the Z was exported at.
    level: str = "company"


class AccountingZRow(_Camel):
    id: uuid.UUID
    shop_id: Optional[uuid.UUID] = None
    shop_name: Optional[str] = None
    shop_sequence_number: Optional[int] = None
    business_date: date
    closed_at: datetime
    #: The local date the Z was produced (`closed_at` in the shop's timezone) — what
    #: `dateBasis=production` lists by. The Z's export is the same either way.
    production_date: Optional[date] = None
    net_sales: Optional[float] = None
    vat_total: Optional[float] = None
    exported: List[ExportedRef] = Field(default_factory=list)


class AccountingZListResponse(_Camel):
    items: List[AccountingZRow]
    truncated: bool = False


class JournalLineOut(_Camel):
    side: Literal["D", "C"]
    key: str
    account: Optional[str] = None
    amount: Decimal
    label: str
    #: A consolidated company entry: the line's shop cost centre and shop.
    branch: Optional[str] = None
    shop_name: Optional[str] = None


class JournalEntryOut(_Camel):
    shop_id: Optional[uuid.UUID] = None
    shop_name: str
    reference1: int
    reference2: str
    entry_date: date
    details: str
    branch: str
    movement_type: str
    z_ids: List[uuid.UUID]
    total_debit: Decimal
    total_credit: Decimal
    lines: List[JournalLineOut]


class ProblemOut(_Camel):
    code: str
    z_id: Optional[uuid.UUID] = None
    z_number: Optional[int] = None
    shop_name: str = ""
    detail: str = ""


class ExportRequest(_Camel):
    company_id: uuid.UUID
    z_report_ids: List[uuid.UUID] = Field(..., min_length=1, max_length=2000)
    format: Literal["hashavshevet", "priority", "excel"] = "hashavshevet"
    #: Default: the company's setting.
    method: Optional[Literal["flexible", "detailed"]] = None
    encoding: Optional[Literal["cp1255", "cp862"]] = None
    grouping: Literal["z", "day", "month"] = "z"
    #: company — one batch; shop — one batch per shop of the chosen Zs.
    #: Default: the company's `exportLevel` setting.
    level: Optional[Literal["company", "shop"]] = None
    #: Company level only: one entry for all shops (default: the company's setting).
    consolidate: Optional[bool] = None
    #: Required to export a Z that is already in a batch (at either level).
    confirm_reexport: bool = False


class PreviewResponse(_Camel):
    entries: List[JournalEntryOut]
    problems: List[ProblemOut]
    already_exported: List[uuid.UUID]


class ExportBatchRef(_Camel):
    id: uuid.UUID
    batch_number: int
    shop_id: Optional[uuid.UUID] = None
    shop_name: Optional[str] = None
    file_name: str


class ExportBatchOut(_Camel):
    id: uuid.UUID
    batch_number: int
    company_id: uuid.UUID
    company_name: Optional[str] = None
    shop_id: Optional[uuid.UUID] = None
    shop_name: Optional[str] = None
    format: str
    method: str
    encoding: str
    grouping: str
    level: str = "company"
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    z_count: int
    entry_count: int
    line_count: int
    total_debit: Decimal
    is_reexport: bool
    file_name: str
    created_by: Optional[str] = None
    created_at: datetime
    z_report_ids: List[uuid.UUID] = Field(default_factory=list)
    #: Every batch the same export request wrote (a per-shop export writes one per
    #: shop), this one included. Empty when listed later.
    group_batches: List[ExportBatchRef] = Field(default_factory=list)


class ExportBatchListResponse(_Camel):
    items: List[ExportBatchOut]
