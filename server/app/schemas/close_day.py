"""Close-day request schemas."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field, ConfigDict


class CloseDayCreateIn(BaseModel):
    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")

    model_config = ConfigDict(populate_by_name=True)


class CloseDayItemOut(BaseModel):
    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    status: str
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    completed_at: Optional[datetime] = Field(None, alias="completedAt")
    failed_at: Optional[datetime] = Field(None, alias="failedAt")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class CloseDayRequestOut(BaseModel):
    id: uuid.UUID
    status: str
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    items: List[CloseDayItemOut]

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class CloseDayCreateResponse(BaseModel):
    request_id: uuid.UUID = Field(..., alias="requestId")
    status: str
    items: List[CloseDayItemOut]

    model_config = ConfigDict(populate_by_name=True)


class CloseDayAckIn(BaseModel):
    request_id: uuid.UUID = Field(..., alias="requestId")
    phase: Literal["received", "completed", "failed"]
    z_report_id: Optional[uuid.UUID] = Field(None, alias="zReportId")
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")

    model_config = ConfigDict(populate_by_name=True)


class CloseDayAckResponse(BaseModel):
    ok: bool = True
    item_status: str = Field(..., alias="itemStatus")

    model_config = ConfigDict(populate_by_name=True)
