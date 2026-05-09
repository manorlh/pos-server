from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from datetime import datetime


class PairingCodeCreate(BaseModel):
    distributor_id: uuid.UUID


class PairingCodeValidate(BaseModel):
    code: str
    device_info: Optional[Dict[str, Any]] = None
    machine_name: Optional[str] = None


class MachineAssignRequest(BaseModel):
    """JSON body uses camelCase (merchantId, shopId) from the dashboard."""

    model_config = ConfigDict(populate_by_name=True)

    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


class PairingCodeResponse(BaseModel):
    id: uuid.UUID
    code: str
    distributor_id: uuid.UUID
    pos_machine_id: Optional[uuid.UUID]
    expires_at: datetime
    is_used: bool
    used_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True

