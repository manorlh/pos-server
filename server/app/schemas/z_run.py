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
    #: A Z for this area of the shop: every listed till must be in it now (some may be
    #: left off). Still the shop's Z, under the shop's number (docs/AREAS_API.md §2.3).
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")


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
    # The till's last report, as the status light reads it (a reading, not live).
    online: Optional[bool] = None
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")
    pending_as_of: Optional[datetime] = Field(None, alias="pendingAsOf")
    #: While waiting for the till's close: documents of the closing shift the cloud
    #: already holds. Null once the item is ready/excluded/ended, or if the shift is unknown.
    documents_on_cloud: Optional[int] = Field(None, alias="documentsOnCloud")


class ZRunOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    shop_id: uuid.UUID = Field(..., alias="shopId")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
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
    #: "cloud" (taken by the shop's Z run) or "till" (produces its own Z, §5).
    z_mode: str = Field("cloud", alias="zMode")
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
    #: False for a till listed only for its closed shifts of this shop: retired,
    #: unpaired or since moved to another shop. It can be included, never asked to close.
    in_shop: bool = Field(True, alias="inShop")
    is_active: bool = Field(True, alias="isActive")
    #: The till's area now (not its shifts' stamps).
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")


class ZCandidatesOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    #: Echoes an `areaId` filter: only that area's tills are listed.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
    z_scope: str = Field("shop", alias="zScope")
    machines: List[ZCandidateMachineOut] = Field(default_factory=list)
