"""Request bodies of the production vouchers' settlement, deliveries, replacements, controls and simulator."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate


class _In(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


def _text(value, limit: int) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s[:limit] or None


# ── Settlement (§14) ──────────────────────────────────────────────────────────


class SettlementAgreementIn(_In):
    name: str = Field(..., min_length=1, max_length=200)
    company_id: uuid.UUID = Field(..., alias="companyId")
    production_name: Optional[str] = Field(None, alias="productionName", max_length=200)
    production_id: Optional[uuid.UUID] = Field(None, alias="productionId")
    event_name: Optional[str] = Field(None, alias="eventName", max_length=200)
    report_event_id: Optional[uuid.UUID] = Field(None, alias="reportEventId")
    batch_ids: Optional[List[uuid.UUID]] = Field(None, alias="batchIds")
    billing_basis: str = Field("redemption", alias="billingBasis")
    period_from: Optional[date] = Field(None, alias="periodFrom")
    period_to: Optional[date] = Field(None, alias="periodTo")
    currency: str = "ILS"
    cancelled_policy: str = Field("exclude", alias="cancelledPolicy")
    replacement_policy: str = Field("free", alias="replacementPolicy")
    notes: Optional[str] = Field(None, max_length=4000)

    @field_validator("production_name", "event_name", "notes", mode="before")
    @classmethod
    def _strip(cls, v):
        return _text(v, 4000)


class SettlementAgreementUpdate(_In):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    production_name: Optional[str] = Field(None, alias="productionName", max_length=200)
    event_name: Optional[str] = Field(None, alias="eventName", max_length=200)
    report_event_id: Optional[uuid.UUID] = Field(None, alias="reportEventId")
    batch_ids: Optional[List[uuid.UUID]] = Field(None, alias="batchIds")
    billing_basis: Optional[str] = Field(None, alias="billingBasis")
    period_from: Optional[date] = Field(None, alias="periodFrom")
    period_to: Optional[date] = Field(None, alias="periodTo")
    cancelled_policy: Optional[str] = Field(None, alias="cancelledPolicy")
    replacement_policy: Optional[str] = Field(None, alias="replacementPolicy")
    status: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=4000)
    gap_note: Optional[str] = Field(None, alias="gapNote", max_length=4000)


class SettlementInvoiceLineIn(_In):
    batch_id: uuid.UUID = Field(..., alias="batchId")
    quantity: int = Field(..., ge=1, le=1_000_000)


class SettlementInvoiceIn(_In):
    number: str = Field(..., min_length=1, max_length=64)
    invoice_date: date = Field(..., alias="invoiceDate")
    system: Optional[str] = Field(None, max_length=100)
    #: ₪, as the invoice says.
    #: ≤ ₪1,000,000,000 (agorot, a 64-bit integer).
    amount: Decimal = Field(..., ge=0, le=Decimal("1000000000"))
    currency: str = "ILS"
    note: Optional[str] = Field(None, max_length=4000)
    gap_note: Optional[str] = Field(None, alias="gapNote", max_length=4000)
    lines: List[SettlementInvoiceLineIn] = Field(default_factory=list)


class SettlementInvoiceUpdate(_In):
    note: Optional[str] = Field(None, max_length=4000)
    gap_note: Optional[str] = Field(None, alias="gapNote", max_length=4000)


class ReasonIn(_In):
    reason: Optional[str] = Field(None, max_length=1000)


# ── Deliveries ────────────────────────────────────────────────────────────────


class DeliveryIn(_In):
    serial_from: int = Field(..., alias="serialFrom", ge=1)
    serial_to: int = Field(..., alias="serialTo", ge=1)
    delivered_at: Optional[datetime] = Field(None, alias="deliveredAt")
    recipient: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=1000)
    chargeable: bool = True


# ── Replacement (§16) ─────────────────────────────────────────────────────────


class ReplacementItemIn(_In):
    product_id: uuid.UUID = Field(..., alias="productId")
    quantity: Decimal = Field(..., ge=0)


class ReplacementIn(_In):
    reason_kind: str = Field(..., alias="reasonKind")
    reason: str = Field(..., min_length=2, max_length=1000)
    #: What the replacement gives (goods); absent: what the original had left.
    items: Optional[List[ReplacementItemIn]] = None
    #: A discount voucher's uses; absent: the original's uses left.
    uses: Optional[int] = Field(None, ge=1, le=1000)
    #: Replace although a sale that held the original never ended (after looking into it; audited).
    force: bool = False


# ── Controls (§18.3 / §18.4 / §18.5) ──────────────────────────────────────────


class PauseIn(_In):
    scope_kind: str = Field(..., alias="scopeKind")
    scope_value: str = Field(..., alias="scopeValue", min_length=1, max_length=200)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    reason: str = Field(..., min_length=2, max_length=500)
    until: Optional[datetime] = None


class ResumeIn(_In):
    note: Optional[str] = Field(None, max_length=1000)


class QuotaIn(_In):
    scope_kind: str = Field(..., alias="scopeKind")
    scope_value: str = Field(..., alias="scopeValue", min_length=1, max_length=200)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    max_redemptions: int = Field(..., alias="maxRedemptions", ge=0, le=10_000_000)
    period: str = "overall"
    period_from: Optional[datetime] = Field(None, alias="periodFrom")
    period_to: Optional[datetime] = Field(None, alias="periodTo")
    warn_percent: int = Field(80, alias="warnPercent", ge=1, le=100)
    note: Optional[str] = Field(None, max_length=1000)


class QuotaUpdate(_In):
    max_redemptions: Optional[int] = Field(None, alias="maxRedemptions", ge=0, le=10_000_000)
    warn_percent: Optional[int] = Field(None, alias="warnPercent", ge=1, le=100)
    period_from: Optional[datetime] = Field(None, alias="periodFrom")
    period_to: Optional[datetime] = Field(None, alias="periodTo")
    active: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=1000)
    reason: Optional[str] = Field(None, max_length=1000)


class StaffTestBatchIn(PrepaidVoucherBatchCreate):
    """A new batch of staff test vouchers: the batch form's body, and an optional note."""

    test_note: Optional[str] = Field(None, alias="testNote", max_length=1000)


class StaffTestMarkIn(_In):
    note: Optional[str] = Field(None, max_length=1000)


# ── Simulator (§18.1) ─────────────────────────────────────────────────────────


class SimulateLineIn(_In):
    product_id: uuid.UUID = Field(..., alias="productId")
    quantity: Decimal = Field(Decimal(1), gt=0, le=Decimal(1000))
    #: ₪ per unit; absent: the price where it is sold (the shop's, else the catalog's).
    price: Optional[Decimal] = Field(None, ge=0)
    #: ₪ off the line by promotions (cover / discount kinds).
    promotion: Optional[Decimal] = Field(None, ge=0)


class SimulateIn(_In):
    type_id: Optional[uuid.UUID] = Field(None, alias="typeId")
    batch_id: Optional[uuid.UUID] = Field(None, alias="batchId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    lines: List[SimulateLineIn] = Field(default_factory=list, max_length=200)
    #: A manager approved a forced discount (a `manager` policy).
    approved: bool = False
