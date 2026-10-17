import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, ConfigDict

from app.schemas.pos_machine import DeviceModel


class PairingSessionCreateResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: uuid.UUID = Field(..., alias="sessionId")
    session_token: str = Field(..., alias="sessionToken")
    expires_at: datetime = Field(..., alias="expiresAt")
    mobile_url: str = Field(..., alias="mobileUrl")
    session_expire_hours: int = Field(..., alias="sessionExpireHours")


class PairingSessionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    expires_at: datetime = Field(..., alias="expiresAt")
    machines_paired_count: int = Field(..., alias="machinesPairedCount")
    created_at: datetime = Field(..., alias="createdAt")


class DeviceRegisterRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
    machine_name: Optional[str] = Field(None, alias="machineName")


class DeviceRegisterResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    device_nonce: str = Field(..., alias="deviceNonce")
    expires_at: datetime = Field(..., alias="expiresAt")
    #: "קוד מכשיר" (P:/specs/foreign-records-upload.md §6.1): 6 characters (A-Z, 2-9, no look-alikes) the
    #: device shows as XXX-XXX; the dashboard claims it by it. Grants nothing alone. Rotated by registering again.
    device_code: Optional[str] = Field(None, alias="deviceCode")
    code_expires_at: Optional[datetime] = Field(None, alias="codeExpiresAt")


class DevicePollWaitingResponse(BaseModel):
    status: str = "waiting"


class MobileSessionPatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


class MobileClaimRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    device_nonce: str = Field(..., alias="deviceNonce")
    company_id: uuid.UUID = Field(..., alias="companyId")
    shop_id: uuid.UUID = Field(..., alias="shopId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    #: "N55F" | "MODO" | "P18", as on `POST /pairing/generate`; omitted leaves it unknown (a
    #: 55F) unless the device names its model itself.
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")


class MobileClaimResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_code: str = Field(..., alias="machineCode")
    company_name: str = Field(..., alias="companyName")
    shop_name: str = Field(..., alias="shopName")
    #: The register number the claimed till was given in that shop.
    pos_number: Optional[str] = Field(None, alias="posNumber")


class MobileCompanyRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    name: str


class MobileShopRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    name: str
    company_id: uuid.UUID = Field(..., alias="companyId")
    #: "סניף לא פעיל": a claim into it is refused (409 `shop_inactive`); shown so the page can say so.
    is_active: bool = Field(True, alias="isActive")


class MobileContextResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_expires_at: datetime = Field(..., alias="sessionExpiresAt")
    session_expire_hours: int = Field(..., alias="sessionExpireHours")
    machines_paired_count: int = Field(..., alias="machinesPairedCount")
    default_company_id: Optional[uuid.UUID] = Field(None, alias="defaultCompanyId")
    default_shop_id: Optional[uuid.UUID] = Field(None, alias="defaultShopId")
    companies: List[MobileCompanyRow]
    shops: List[MobileShopRow] = Field(default_factory=list)


class DeviceRequestClaimIn(BaseModel):
    """`POST /pairing/device-requests/claim` (P:/specs/foreign-records-upload.md §6.2)."""

    model_config = ConfigDict(populate_by_name=True)

    device_code: str = Field(..., alias="deviceCode", min_length=4, max_length=16)
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    machine_name: Optional[str] = Field(None, alias="machineName", max_length=255)
    confirm: bool = False
