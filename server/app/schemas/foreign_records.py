"""`POST /sync/{B}/foreign-records` and `POST /sync/{m}/unpaired` (P:/specs/foreign-records-upload.md §4, §5.1)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ForeignRecordIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: shift_open | transaction | shift_close | transmission | cash_movement | offline_authorization;
    #: anything else is answered `refused` / `unsupported_kind`, never a 422 for the call.
    kind: str = Field(..., max_length=40)
    id: Optional[str] = Field(None, max_length=64)
    #: The body exactly as the ordinary push of that kind sends it.
    body: Any = None

    @field_validator("id", mode="before")
    @classmethod
    def _id_text(cls, value):
        return None if value is None else str(value)


class ForeignRecordsIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: str = Field(..., alias="machineId", max_length=64)
    tenant_id: Optional[str] = Field(None, alias="tenantId", max_length=64)
    records: List[ForeignRecordIn] = Field(default_factory=list, max_length=200)


class UnpairedIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    by: Optional[str] = Field(None, max_length=200)
    #: manual | forced | cloud_move (anything else is kept as sent, cut).
    reason: Optional[str] = Field(None, max_length=40)
    #: Unsent rows per kind ({"transaction": 0, ...}).
    pending: Optional[Dict[str, Any]] = None
    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
