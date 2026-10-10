""""קבוצות מכשירים" (app/services/machine_groups.py): the dashboard's requests."""
import uuid
from typing import List, Optional

from pydantic import BaseModel, Field


class MachineGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    company_id: uuid.UUID = Field(..., alias="companyId")
    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds", max_length=500)

    class Config:
        populate_by_name = True


class MachineGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=100_000)

    class Config:
        populate_by_name = True


class MachineGroupMembersIn(BaseModel):
    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds", max_length=500)

    class Config:
        populate_by_name = True
