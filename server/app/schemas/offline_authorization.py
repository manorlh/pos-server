"""
Offline card authorization: the till's report (`POST /sync/{machine_id}/offline-authorizations`)
and the dashboard's list of runs (`GET /reports/offline-authorizations`).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.reports import ReportWindowOut
from app.schemas.transmission import (
    INT32_MAX,
    MAX_TERMINAL_IDS,
    TERMINAL_ID_LENGTH,
    _lenient,
    count_or_none,
)

#: BIGINT: an agorot total beyond it is not a reading.
INT64_MAX = 2**63 - 1


def _uids(value) -> List[str]:
    """Blanks dropped, duplicates collapsed (first order kept), each cut to 64."""
    if not isinstance(value, (list, tuple)):
        return []
    out: List[str] = []
    seen = set()
    for raw in value:
        if raw is None or isinstance(raw, (dict, list, bool)):
            continue
        text = str(raw).strip()[:TERMINAL_ID_LENGTH]
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= MAX_TERMINAL_IDS:
            break
    return out


class OfflineAuthorizationIn(BaseModel):
    """
    One `authorizePendingTransactions` run, reported by the till. Only `id` and
    `authorizedAt` are required; anything else that cannot be read is None or empty,
    never a 422 — the run happened, and its declines are money.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    authorized_at: datetime = Field(..., alias="authorizedAt")
    status_code: Optional[int] = Field(None, alias="statusCode")
    approved: List[str] = Field(default_factory=list)
    declined: List[str] = Field(default_factory=list)
    #: Agorot, the approved total as the terminal reported it.
    total_amount: Optional[int] = Field(None, alias="totalAmount")
    total_count: Optional[int] = Field(None, alias="totalCount")

    @field_validator("status_code", mode="wrap")
    @classmethod
    def _status_code(cls, value, handler):
        parsed = _lenient(handler, value)
        if parsed is None or abs(parsed) > INT32_MAX:
            return None
        return parsed

    @field_validator("total_amount", mode="wrap")
    @classmethod
    def _amount(cls, value, handler):
        parsed = _lenient(handler, value)
        if parsed is None or abs(parsed) > INT64_MAX:
            return None
        return parsed

    @field_validator("total_count", mode="wrap")
    @classmethod
    def _count(cls, value, handler):
        return count_or_none(value)

    @field_validator("approved", "declined", mode="wrap")
    @classmethod
    def _ids(cls, value, handler):
        return _uids(value)


# ── The dashboard report (`GET /reports/offline-authorizations`) ─────────────


class OfflineDeclinedLegOut(BaseModel):
    """One uid a run declined, and the card leg it matched on that till, if any."""

    model_config = ConfigDict(populate_by_name=True)

    terminal_uid: str = Field(..., alias="terminalUid")
    #: False when no document of the till carries the uid (yet): its sale is unknown.
    matched: bool = False
    transaction_id: Optional[uuid.UUID] = Field(None, alias="transactionId")
    document_number: Optional[str] = Field(None, alias="documentNumber")
    amount: Optional[Decimal] = None
    #: The original sale's time, not the run's.
    sold_at: Optional[datetime] = Field(None, alias="soldAt")


class OfflineAuthorizationRowOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    authorized_at: datetime = Field(..., alias="authorizedAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    status_code: Optional[int] = Field(None, alias="statusCode")
    approved_count: int = Field(0, alias="approvedCount")
    #: The terminal's own approved total when it sent one, else the matched legs' sum.
    approved_amount: Decimal = Field(Decimal("0"), alias="approvedAmount")
    declined_count: int = Field(0, alias="declinedCount")
    #: Σ of the matched declined legs; an unmatched uid has no amount.
    declined_amount: Decimal = Field(Decimal("0"), alias="declinedAmount")
    declined_unmatched_count: int = Field(0, alias="declinedUnmatchedCount")
    declined: List[OfflineDeclinedLegOut] = Field(default_factory=list)


class OfflineAuthorizationTotalsOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    authorization_count: int = Field(0, alias="authorizationCount")
    approved_count: int = Field(0, alias="approvedCount")
    approved_amount: Decimal = Field(Decimal("0"), alias="approvedAmount")
    declined_count: int = Field(0, alias="declinedCount")
    declined_amount: Decimal = Field(Decimal("0"), alias="declinedAmount")
    declined_unmatched_count: int = Field(0, alias="declinedUnmatchedCount")


class OfflineAuthorizationReportResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    totals: OfflineAuthorizationTotalsOut
    items: List[OfflineAuthorizationRowOut]
    #: More runs matched than the cap; the totals are of the rows returned.
    truncated: bool = False
