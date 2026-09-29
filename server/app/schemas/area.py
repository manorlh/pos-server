"""Shop area payloads (docs/AREAS_API.md §2.1, §2.4)."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: The width of `shop_areas.name`.
AREA_NAME_MAX = 100


def _clean_name(value):
    """Trimmed, not empty, at most `AREA_NAME_MAX` — "Bar " and "Bar" are one name."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("name must be text")
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("name must not be empty")
    if len(cleaned) > AREA_NAME_MAX:
        raise ValueError(f"name must be at most {AREA_NAME_MAX} characters")
    return cleaned


class AreaCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    sort_order: Optional[int] = Field(None, alias="sortOrder")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if value is None:
            raise ValueError("name is required")
        return _clean_name(value)


class AreaUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = None
    sort_order: Optional[int] = Field(None, alias="sortOrder")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        # An explicit null is "unchanged", like an omitted name: an area always has one.
        return _clean_name(value)


class AreaMembershipIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds")


class AreaStatusOut(BaseModel):
    """The roll-up (`app.services.machine_status.rollup_status`). Rendered, never re-derived."""

    model_config = ConfigDict(populate_by_name=True)

    worst: Optional[str] = None
    counts: Dict[str, int] = Field(default_factory=dict)


class AreaMachineOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    name: Optional[str] = None
    pos_number: Optional[str] = Field(None, alias="posNumber")
    status: Optional[str] = None


class AreaOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    shop_id: uuid.UUID = Field(..., alias="shopId")
    name: str
    sort_order: int = Field(0, alias="sortOrder")
    archived_at: Optional[datetime] = Field(None, alias="archivedAt")
    #: Active tills in it now.
    machine_count: int = Field(0, alias="machineCount")
    status: AreaStatusOut
    #: Those tills, each with its primary status.
    machines: List[AreaMachineOut] = Field(default_factory=list)
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
