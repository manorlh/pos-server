from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from datetime import datetime

from app.schemas.pos_machine import DeviceModel


class PairingCodeGenerateRequest(BaseModel):
    """Optional pre-assignment: machine auto-assigns on validate when set."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: The hardware the new device is: "N55F", "MODO" or "P18". Copied onto the machine when it
    #: pairs. Optional here so an older dashboard still generates codes; the dashboard
    #: requires it.
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")


class PairingCodeCreate(BaseModel):
    distributor_id: uuid.UUID


class PairingCodeValidate(BaseModel):
    code: str
    device_info: Optional[Dict[str, Any]] = None
    machine_name: Optional[str] = None


class MachineAssignRequest(BaseModel):
    """JSON body uses camelCase (shopId) from the dashboard."""

    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")


class PairingCodeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    code: str
    distributor_id: uuid.UUID
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    device_model: Optional[str] = Field(None, alias="deviceModel")
    expires_at: datetime = Field(..., alias="expiresAt")
    is_used: bool = Field(..., alias="isUsed")
    used_at: Optional[datetime] = Field(None, alias="usedAt")
    created_at: datetime = Field(..., alias="createdAt")
