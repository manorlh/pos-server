from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from datetime import datetime


class PairingCodeGenerateRequest(BaseModel):
    """Optional pre-assignment: machine auto-assigns on validate when set."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


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
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    code: str
    distributor_id: uuid.UUID
    merchant_id: Optional[uuid.UUID] = Field(None, alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    expires_at: datetime = Field(..., alias="expiresAt")
    is_used: bool = Field(..., alias="isUsed")
    used_at: Optional[datetime] = Field(None, alias="usedAt")
    created_at: datetime = Field(..., alias="createdAt")
