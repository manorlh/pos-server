"""Z on the till (`zMode = till`) payloads. The wire contract is docs/SHIFTS_API.md §5."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.shift import finite_json


class TillZIn(BaseModel):
    """`POST /sync/{machineId}/till-z` — the till asks for its Z (§5.2)."""

    model_config = ConfigDict(populate_by_name=True)

    #: Made by the till before its first attempt and kept until it has the Z: the
    #: idempotency key. A retry with the same id gets the same Z, never a new number.
    client_request_id: uuid.UUID = Field(..., alias="clientRequestId")
    #: The dashboard request this answers (§5.4), if any.
    till_z_request_id: Optional[uuid.UUID] = Field(None, alias="tillZRequestId")
    #: The newest shift the till wants in this Z (its last closed one). Absent = every
    #: closed shift no Z has taken yet, as on a Z run (§2.4).
    through_shift_id: Optional[uuid.UUID] = Field(None, alias="throughShiftId")
    created_by_user_id: Optional[str] = Field(None, alias="createdByUserId", max_length=100)
    created_by_name: Optional[str] = Field(None, alias="createdByName", max_length=255)
    #: Produced for a dashboard request with nobody at the till.
    unattended: bool = False
    #: The till's own sum over the included shifts (§3.3 keys); audit only.
    till: Optional[Dict[str, Any]] = None
    #: A training Z ("מצב הדרכה"): the till's own, quarantined; no cloud Z is built.
    training: bool = False
    #: Its number in the till's training run ("ה-3"), with `training`.
    number: Optional[str] = Field(None, max_length=100)

    @field_validator("till", mode="before")
    @classmethod
    def _finite_till(cls, value):
        return finite_json(value)


class TillZAckIn(BaseModel):
    """`POST /sync/{machineId}/till-z/ack` (§5.3)."""

    model_config = ConfigDict(populate_by_name=True)

    request_id: uuid.UUID = Field(..., alias="requestId")
    #: `completed` is accepted and changes nothing: a request completes only from §5.2.
    phase: Literal["received", "deferred", "failed", "completed"]
    error_code: Optional[str] = Field(None, alias="errorCode", max_length=64)
    error_message: Optional[str] = Field(None, alias="errorMessage", max_length=2000)


class ShopTillZIn(BaseModel):
    """`POST /shops/{shopId}/till-z` — omitted/null `machineIds` = every till-mode till."""

    model_config = ConfigDict(populate_by_name=True)

    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds")


class TillZRequestOut(BaseModel):
    """A dashboard request for a till's own Z (§5.4)."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: waiting | in_progress | completed | failed | expired | cancelled
    status: str
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    created_by_user_id: Optional[uuid.UUID] = Field(None, alias="createdByUserId")
    initiated_by: Optional[str] = Field(None, alias="initiatedBy")
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    completed_at: Optional[datetime] = Field(None, alias="completedAt")
    #: The Z that answered it, and its number in the till's run; null until then (and
    #: on a request completed with nothing to report).
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    machine_sequence_number: Optional[int] = Field(None, alias="machineSequenceNumber")
    # The till's last report, as the status light reads it (a reading, not live).
    online: Optional[bool] = None
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")
    pending_as_of: Optional[datetime] = Field(None, alias="pendingAsOf")
