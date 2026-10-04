"""Live sales by item ("מכירות לפי פריט — חי"): `GET /reports/live-items`."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.reports import ReportWindowOut


class LiveItemRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    sku: Optional[str] = None
    name: Optional[str] = None
    #: Units sold minus units credited back.
    qty: float
    units_sold: float = Field(..., alias="unitsSold")
    units_refunded: float = Field(..., alias="unitsRefunded")
    gross: float
    discounts: float
    refunds: float
    #: gross - discounts - refunds, as on the product sales report.
    net: float
    #: This product's net as a percentage of the scope's net (0 when that is not > 0).
    share: float


class LiveItemTotals(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    qty: float
    gross: float
    discounts: float
    refunds: float
    net: float
    product_count: int = Field(..., alias="productCount")


class LiveItemsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: ReportWindowOut
    generated_at: datetime = Field(..., alias="generatedAt")
    #: `day`, `range` or `shift` (the documents of the shifts open now, whenever they began).
    period: str
    #: In `shift` mode: how many open shifts the figures cover.
    open_shift_count: Optional[int] = Field(None, alias="openShiftCount")
    truncated: bool
    row_limit: int = Field(..., alias="rowLimit")
    totals: LiveItemTotals
    rows: List[LiveItemRow]
