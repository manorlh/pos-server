"""Request bodies of /report-events (docs/SPEC_EVENTS.md §6). Responses are plain dicts."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class ReportEventCreate(_Camel):
    shop_id: uuid.UUID
    name: str = Field(..., max_length=200)
    #: Local date (YYYY-MM-DD) and hour (HH:MM) in the tenant's timezone — all four required.
    start_date: str
    start_time: str
    end_date: str
    end_time: str
    machine_ids: List[uuid.UUID] = Field(default_factory=list)
    #: "העבר לאירוע הזה": tills (also in `machine_ids`) to take out of overlapping draft events.
    move_machine_ids: List[uuid.UUID] = Field(default_factory=list)
    producer_name: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=4000)
    thresholds: Optional[Dict[str, Any]] = None


class ReportEventUpdate(_Camel):
    """Only the fields sent change (draft only)."""

    name: Optional[str] = Field(None, max_length=200)
    start_date: Optional[str] = None
    start_time: Optional[str] = None
    end_date: Optional[str] = None
    end_time: Optional[str] = None
    machine_ids: Optional[List[uuid.UUID]] = None
    #: "העבר לאירוע הזה": tills of the event to take out of overlapping draft events.
    move_machine_ids: List[uuid.UUID] = Field(default_factory=list)
    producer_name: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=4000)
    thresholds: Optional[Dict[str, Any]] = None


class ReportEventTillsChange(_Camel):
    """"שיוך קופות מהיר לאירוע": add / remove / move tills in one go, all or nothing (draft only)."""

    add: List[uuid.UUID] = Field(default_factory=list, max_length=500)
    remove: List[uuid.UUID] = Field(default_factory=list, max_length=500)
    #: Tills to take out of overlapping draft events and add here ("העבר לאירוע הזה").
    move: List[uuid.UUID] = Field(default_factory=list, max_length=500)


class ReportEventConfirm(_Camel):
    #: Confirm although a blocking check failed (the event has not ended yet).
    force: bool = False
    note: Optional[str] = Field(None, max_length=1000)
