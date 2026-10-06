from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from datetime import datetime

from app.schemas.device_profile import KioskOptionsIn
from app.schemas.pos_machine import DeviceModel, DeviceRole


class PairingCodeGenerateRequest(BaseModel):
    """Optional pre-assignment: machine auto-assigns on validate when set."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: The hardware the new device is (`DeviceModel`). Copied onto the machine when it
    #: pairs. Optional here so an older dashboard still generates codes; the dashboard
    #: requires it.
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")
    #: "סוג מכשיר (תפקיד)": "till" (the default) or "kiosk". A kiosk needs `shopId`; the
    #: device that redeems the code is made a kiosk at once (docs/SPEC_DEVICE_ROLE_MODEL.md).
    device_role: Optional[DeviceRole] = Field(None, alias="deviceRole")
    #: The kiosk's name, controlling tills and device lock, for a kiosk code.
    kiosk: Optional[KioskOptionsIn] = None


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
    device_role: Optional[str] = Field(None, alias="deviceRole")
    expires_at: datetime = Field(..., alias="expiresAt")
    is_used: bool = Field(..., alias="isUsed")
    used_at: Optional[datetime] = Field(None, alias="usedAt")
    created_at: datetime = Field(..., alias="createdAt")
