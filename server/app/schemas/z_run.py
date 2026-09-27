"""Z run payloads (docs/SHIFTS_API.md §2.3–§2.7, §3.4)."""
from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.shift import ShiftOut


class ZRunMachineIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    through_shift_id: Optional[uuid.UUID] = Field(None, alias="throughShiftId")
    #: Omitted = true when the till has an open shift.
    include_open_shift: Optional[bool] = Field(None, alias="includeOpenShift")


class ZRunCreateIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    machines: List[ZRunMachineIn] = Field(default_factory=list)
    business_date: Optional[date] = Field(None, alias="businessDate")


class ZRunProceedIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    exclude_machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="excludeMachineIds")


class ZRunItemOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    through_shift_id: Optional[uuid.UUID] = Field(None, alias="throughShiftId")
    close_shift_id: Optional[uuid.UUID] = Field(None, alias="closeShiftId")
    status: str
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    ready_at: Optional[datetime] = Field(None, alias="readyAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")


class ZRunOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    shop_id: uuid.UUID = Field(..., alias="shopId")
    status: str
    business_date: Optional[date] = Field(None, alias="businessDate")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    created_by_user_id: Optional[uuid.UUID] = Field(None, alias="createdByUserId")
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    z_number: Optional[int] = Field(None, alias="zNumber")
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    items: List[ZRunItemOut] = Field(default_factory=list)


class ActiveRunOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    run_id: uuid.UUID = Field(..., alias="runId")
    item_status: str = Field(..., alias="itemStatus")


class ZCandidateMachineOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    online: bool = False
    status: Optional[str] = None
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")
    pending_as_of: Optional[datetime] = Field(None, alias="pendingAsOf")
    open_shift: Optional[ShiftOut] = Field(None, alias="openShift")
    till_reported_open_shift_id: Optional[uuid.UUID] = Field(None, alias="tillReportedOpenShiftId")
    closed_shifts: List[ShiftOut] = Field(default_factory=list, alias="closedShifts")
    active_run: Optional[ActiveRunOut] = Field(None, alias="activeRun")
    #: Documents of this till stored with no shift (they named none). No Z takes them.
    orphan_documents: int = Field(0, alias="orphanDocuments")


class ZCandidatesOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    z_scope: str = Field("shop", alias="zScope")
    machines: List[ZCandidateMachineOut] = Field(default_factory=list)
