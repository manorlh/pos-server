from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from app.models.pos_machine import PairingStatus as ModelPairingStatus


class PairingStatus(str):
    UNPAIRED = "unpaired"
    PAIRED = "paired"
    ASSIGNED = "assigned"


class POSMachineBase(BaseModel):
    name: str
    machine_code: str = Field(..., alias="machineCode")

    model_config = ConfigDict(populate_by_name=True)


class POSMachineCreate(POSMachineBase):
    distributor_id: uuid.UUID
    device_info: Optional[Dict[str, Any]] = None


class POSMachineUpdate(BaseModel):
    name: Optional[str] = None
    merchant_id: Optional[uuid.UUID] = Field(None, alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    is_active: Optional[bool] = Field(None, alias="isActive")

    model_config = ConfigDict(populate_by_name=True)


class POSMachineResponse(POSMachineBase):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    merchant_id: Optional[uuid.UUID] = Field(None, alias="merchantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    distributor_id: uuid.UUID = Field(..., alias="distributorId")
    mqtt_client_id: Optional[str] = Field(None, alias="mqttClientId")
    pairing_status: ModelPairingStatus = Field(..., alias="pairingStatus")
    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
    is_active: bool = Field(..., alias="isActive")
    last_heartbeat_at: Optional[datetime] = Field(None, alias="lastHeartbeatAt")
    last_sync_at: Optional[datetime] = Field(None, alias="lastSyncAt")
    last_catalog_change_at: Optional[datetime] = Field(None, alias="lastCatalogChangeAt")
    catalog_pull_stale: Optional[bool] = Field(None, alias="catalogPullStale")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

