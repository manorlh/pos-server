from datetime import date, datetime
from decimal import Decimal
from typing import Optional
import uuid

from pydantic import BaseModel, Field


class TradingDayOut(BaseModel):
    id: uuid.UUID
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
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
    status: str

    class Config:
        from_attributes = True
        populate_by_name = True
