"""What a Z reopened — `GET /availability/reopens` (docs/SPEC_AVAILABILITY.md)."""
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class ReopenItemOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["product", "category"]
    item_id: uuid.UUID = Field(..., alias="itemId")
    name: Optional[str] = None
    #: "reopened", or "kept_stock": tracks stock and had none, so it stayed closed.
    outcome: Literal["reopened", "kept_stock"]
    blocked_at: Optional[datetime] = Field(None, alias="blockedAt")


class ReopenRunOut(BaseModel):
    """One scope whose day one Z closed: the shop, a point of sale or a till."""

    model_config = ConfigDict(populate_by_name=True)

    z_report_id: uuid.UUID = Field(..., alias="zReportId")
    #: The shop's number for a shop Z, the till's own for a till Z.
    z_number: Optional[int] = Field(None, alias="zNumber")
    z_origin: Optional[str] = Field(None, alias="zOrigin")
    level: Literal["shop", "area", "machine"]
    target_id: uuid.UUID = Field(..., alias="targetId")
    target_name: str = Field("", alias="targetName")
    closed_at: datetime = Field(..., alias="closedAt")
    mode: Literal["day", "all"]
    ignore_stock: bool = Field(False, alias="ignoreStock")
    reopened_count: int = Field(0, alias="reopenedCount")
    kept_count: int = Field(0, alias="keptCount")
    items: List[ReopenItemOut] = Field(default_factory=list)
