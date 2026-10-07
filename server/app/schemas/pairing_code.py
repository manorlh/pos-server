from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from datetime import datetime

from app.schemas.device_profile import KdsScreenOptionsIn, KioskOptionsIn
from app.schemas.work_config import WorkConfigIn
from app.schemas.pos_machine import DeviceModel, DevicePlatform, DeviceRole


class PairingCodeGenerateRequest(BaseModel):
    """Optional pre-assignment: machine auto-assigns on validate when set."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: The hardware the new device is (`DeviceModel`). Copied onto the machine when it
    #: pairs. Optional here so an older dashboard still generates codes; the dashboard
    #: requires it.
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")
    #: "סוג מכשיר (תפקיד)": "till" (the default), "kiosk", "kds" or "order_status_board". All
    #: but a till need `shopId`; the device that redeems the code is made one at once
    #: (docs/SPEC_DEVICE_ROLE_MODEL.md). A KDS / board is a display device, never a till.
    device_role: Optional[DeviceRole] = Field(None, alias="deviceRole")
    #: The kiosk's name, controlling tills and device lock, for a kiosk code.
    kiosk: Optional[KioskOptionsIn] = None
    #: "android" (the default) | "windows": a device of the other platform is refused at
    #: redemption (422 `platform_mismatch`).
    platform: Optional[DevicePlatform] = None
    #: A KDS code's screen (`screenRole` station / expo / manager, `stationIds`, `name`); a
    #: board code's `name`. Ignored for a till / kiosk.
    kds: Optional[KdsScreenOptionsIn] = None
    #: "תצורת עבודה" (docs/SPEC_DEVICE_WORK_CONFIG.md): a preset and overrides, applied to the
    #: machine right after it pairs. Absent / null: "לפי הסניף". Needs `shopId`.
    work_config: Optional[WorkConfigIn] = Field(None, alias="workConfig")


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
    platform: Optional[str] = None
    #: The plan the code carries, and — once a device redeemed it — how applying it went.
    work_config: Optional[Dict[str, Any]] = Field(None, alias="workConfig")
    work_config_result: Optional[Dict[str, Any]] = Field(None, alias="workConfigResult")
    expires_at: datetime = Field(..., alias="expiresAt")
    is_used: bool = Field(..., alias="isUsed")
    used_at: Optional[datetime] = Field(None, alias="usedAt")
    created_at: datetime = Field(..., alias="createdAt")
