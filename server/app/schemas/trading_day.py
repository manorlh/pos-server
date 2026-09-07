from datetime import date, datetime
from decimal import Decimal
from typing import Optional
import uuid

from pydantic import BaseModel, Field


class TradingDayOpenIn(BaseModel):
    """
    A day the till has already opened, reported to the cloud.

    Not a request to open one — the till opens days by itself and sells immediately,
    with or without a connection. This is the till telling the cloud what happened,
    carrying the values only it knows: the real opening time, the float that went in
    the drawer, and who counted it. Before this existed the cloud inferred an opening
    time from the first sale that happened to arrive, and never learned the float at
    all until the Z landed hours later.
    """

    model_config = {"populate_by_name": True}

    id: uuid.UUID
    day_date: date = Field(..., alias="dayDate")
    opened_at: datetime = Field(..., alias="openedAt")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    opened_by: Optional[str] = Field(None, alias="openedBy")
    #: Per-machine counter assigned by the till, so a missing day is visible.
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber")


class TradingDayOut(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    day_date: date = Field(..., alias="dayDate")
    opened_at: datetime = Field(..., alias="openedAt")
    closed_at: Optional[datetime] = Field(None, alias="closedAt")
    opening_cash: Optional[Decimal] = Field(None, alias="openingCash")
    closing_cash: Optional[Decimal] = Field(None, alias="closingCash")
    expected_cash: Optional[Decimal] = Field(None, alias="expectedCash")
    actual_cash: Optional[Decimal] = Field(None, alias="actualCash")
    discrepancy: Optional[Decimal]
    opened_by: Optional[str] = Field(None, alias="openedBy")
    closed_by: Optional[str] = Field(None, alias="closedBy")
    sequence_number: Optional[int] = Field(None, alias="sequenceNumber")
    status: str

    class Config:
        from_attributes = True
        populate_by_name = True
