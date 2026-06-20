import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, ConfigDict


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


class MobileClaimResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_code: str = Field(..., alias="machineCode")
    company_name: str = Field(..., alias="companyName")
    shop_name: str = Field(..., alias="shopName")


class MobileCompanyRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    name: str


class MobileShopRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    name: str
    company_id: uuid.UUID = Field(..., alias="companyId")


class MobileContextResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_expires_at: datetime = Field(..., alias="sessionExpiresAt")
    session_expire_hours: int = Field(..., alias="sessionExpireHours")
    machines_paired_count: int = Field(..., alias="machinesPairedCount")
    default_company_id: Optional[uuid.UUID] = Field(None, alias="defaultCompanyId")
    default_shop_id: Optional[uuid.UUID] = Field(None, alias="defaultShopId")
    companies: List[MobileCompanyRow]
    shops: List[MobileShopRow] = Field(default_factory=list)
