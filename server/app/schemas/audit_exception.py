"""Exceptions ("חריגות"): the till's events in, the dashboard's list, review and rules."""
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.transaction import meta_as_dict


class TillEventIn(BaseModel):
    """
    One thing the till did that no document carries. `id` is client-generated; a resend
    of the same id is a no-op. `details` is free JSON (≤ 16 KB), e.g. for a voided line
    `{"productName": "…", "quantity": 1}`, for a completed basket
    `{"startedAt": "…", "completedAt": "…", "lineCount": 3}`.
    """

    id: uuid.UUID
    type: Literal["drawer_open", "line_void", "basket_cancel", "basket_completed", "reprint", "forced_z_close"]
    occurred_at: datetime = Field(..., alias="occurredAt")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    amount: Optional[Decimal] = Field(None, ge=-10_000_000, le=10_000_000)
    transaction_id: Optional[uuid.UUID] = Field(None, alias="transactionId")
    details: Optional[Dict[str, Any]] = None
    #: A training event ("מצב הדרכה"): quarantined, never an exception to review.
    training: bool = False

    class Config:
        populate_by_name = True

    @field_validator("details", mode="before")
    @classmethod
    def _details(cls, value):
        return meta_as_dict(value)


class TillEventOut(BaseModel):
    id: uuid.UUID
    status: Literal["accepted", "duplicate"]


class RuleParamOut(BaseModel):
    key: str
    default: float
    min: float
    max: float
    integer: bool


class RuleOut(BaseModel):
    type: str
    available: bool
    source: str
    severity: str
    default_enabled: bool = Field(..., alias="defaultEnabled")
    params: List[RuleParamOut]
    #: This level's own values; null = inherits.
    own_enabled: Optional[bool] = Field(None, alias="ownEnabled")
    own_params: Dict[str, float] = Field(default_factory=dict, alias="ownParams")
    #: What applies at this level, from the levels above (this level's own values ignored).
    inherited_enabled: bool = Field(..., alias="inheritedEnabled")
    inherited_params: Dict[str, float] = Field(..., alias="inheritedParams")
    inherited_sources: Dict[str, Optional[str]] = Field(..., alias="inheritedSources")
    #: What applies at this level, own values included.
    effective_enabled: bool = Field(..., alias="effectiveEnabled")
    effective_params: Dict[str, float] = Field(..., alias="effectiveParams")

    class Config:
        populate_by_name = True


class RulesResponse(BaseModel):
    level: str
    id: Optional[uuid.UUID] = None
    can_write: bool = Field(..., alias="canWrite")
    rules: List[RuleOut]

    class Config:
        populate_by_name = True


class RuleIn(BaseModel):
    type: str
    #: null = inherit.
    enabled: Optional[bool] = None
    #: Thresholds this level sets; a key left out or null inherits.
    params: Optional[Dict[str, Optional[float]]] = None


class RulesPut(BaseModel):
    """Replaces this level's own values for the types listed; types not listed are untouched."""

    rules: List[RuleIn]


class ExceptionOut(BaseModel):
    id: uuid.UUID
    type: str
    severity: str
    status: str
    occurred_at: datetime = Field(..., alias="occurredAt")
    detected_at: datetime = Field(..., alias="detectedAt")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    shift_number: Optional[int] = Field(None, alias="shiftNumber")
    transaction_id: Optional[uuid.UUID] = Field(None, alias="transactionId")
    transaction_number: Optional[str] = Field(None, alias="transactionNumber")
    #: The document's type: a number names a document only with it (one series per type,
    #: docs/SPEC_DOCUMENT_PREFIX.md).
    document_type: Optional[int] = Field(None, alias="documentType")
    pos_user_id: Optional[str] = Field(None, alias="posUserId")
    pos_user_name: Optional[str] = Field(None, alias="posUserName")
    amount: Optional[float] = None
    value: Optional[float] = None
    threshold: Optional[float] = None
    details: Optional[Dict[str, Any]] = None
    reviewed_by: Optional[str] = Field(None, alias="reviewedBy")
    reviewed_at: Optional[datetime] = Field(None, alias="reviewedAt")
    review_note: Optional[str] = Field(None, alias="reviewNote")

    class Config:
        populate_by_name = True


class ExceptionListResponse(BaseModel):
    total: int
    page: int
    page_size: int = Field(..., alias="pageSize")
    items: List[ExceptionOut]

    class Config:
        populate_by_name = True


class CountRow(BaseModel):
    key: Optional[str] = None
    label: Optional[str] = None
    total: int
    new: int
    amount: float


class ExceptionSummaryResponse(BaseModel):
    total: int
    new: int
    reviewed: int
    dismissed: int
    by_type: List[CountRow] = Field(..., alias="byType")
    by_employee: List[CountRow] = Field(..., alias="byEmployee")

    class Config:
        populate_by_name = True


class ReviewIn(BaseModel):
    status: Literal["new", "reviewed", "dismissed"]
    note: Optional[str] = Field(None, max_length=2000)


class BulkReviewIn(ReviewIn):
    ids: List[uuid.UUID] = Field(..., min_length=1, max_length=500)


class RescanIn(BaseModel):
    from_date: Optional[str] = Field(None, alias="from")
    to_date: Optional[str] = Field(None, alias="to")

    class Config:
        populate_by_name = True


class RescanOut(BaseModel):
    created: int
    updated: int
