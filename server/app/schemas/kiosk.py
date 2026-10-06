"""Wire shapes of the self-order kiosk (app/routers/kiosks.py, app/services/kiosk_control.py)."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


# ── The till ─────────────────────────────────────────────────────────────────


class KioskSyncIn(_Camel):
    """`POST /sync/{id}/kiosk/sync`. `status` is the kiosk's own report; every field optional."""

    status: Optional[Dict[str, Any]] = None


class KioskOrderIn(_Camel):
    """One paid kiosk order as the kiosk reports it (validated one by one, never the batch)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    local_id: str = Field(..., alias="localId", min_length=1, max_length=64)
    transaction_id: Optional[str] = Field(None, alias="transactionId", max_length=64)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=64)
    pickup_number: int = Field(..., alias="pickupNumber", ge=0, le=99999)
    pickup_label: str = Field(..., alias="pickupLabel", max_length=32)
    business_date: date = Field(..., alias="businessDate")
    service_type: Literal["take_away", "eat_in"] = Field(..., alias="serviceType")
    table_ref: Optional[str] = Field(None, alias="tableRef", max_length=64)
    fulfillment_mode: Literal["BON", "KDS"] = Field(..., alias="fulfillmentMode")
    config_version: Optional[str] = Field(None, alias="configVersion", max_length=32)
    customer_name: Optional[str] = Field(None, alias="customerName", max_length=100)
    customer_phone: Optional[str] = Field(None, alias="customerPhone", max_length=32)
    item_count: int = Field(..., alias="itemCount", ge=0)
    total_agorot: int = Field(..., alias="totalAgorot")
    tip_agorot: int = Field(0, alias="tipAgorot", ge=0)
    paid_at: datetime = Field(..., alias="paidAt")
    bon_status: Literal["none", "queued", "sent", "printed", "failed"] = Field(..., alias="bonStatus")
    bon_detail: Optional[str] = Field(None, alias="bonDetail", max_length=500)
    receipt_status: Literal["printed", "declined", "failed", "skipped", "pending"] = Field(..., alias="receiptStatus")
    status: Literal["paid", "paid_print_failed", "recovered"]


class KioskOrdersIn(_Camel):
    """`POST /sync/{id}/kiosk/orders`. Items are checked one by one: a bad one is rejected alone."""

    orders: List[Any] = Field(default_factory=list, max_length=500)


class PickupNumberIn(_Camel):
    order_key: str = Field(..., alias="orderKey", min_length=1, max_length=64)
    business_date: date = Field(..., alias="businessDate")


class KioskCommandIn(_Camel):
    action: Literal["pause", "resume", "close_shift", "till_z"]
    message: Optional[str] = Field(None, max_length=300)
    force: bool = False
    #: The till user who pressed it, for the audit (a controlling till only).
    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=100)


# ── The dashboard ────────────────────────────────────────────────────────────


class KioskCreateIn(_Camel):
    machine_id: uuid.UUID = Field(..., alias="machineId")
    name: Optional[str] = Field(None, max_length=100)
    controller_machine_ids: Optional[List[str]] = Field(None, alias="controllerMachineIds", max_length=50)
    #: Also turn on the Android device lock (the till parameter `kioskMode`) for this till.
    lock_device: bool = Field(False, alias="lockDevice")


class KioskPatchIn(_Camel):
    name: Optional[str] = Field(None, max_length=100)
    enabled: Optional[bool] = None
    controller_machine_ids: Optional[List[str]] = Field(None, alias="controllerMachineIds", max_length=50)


class KioskSettingsIn(_Camel):
    """`PUT /kiosks/settings`: the whole partial layer of that level (replaces the stored one)."""

    overrides: Dict[str, Any] = Field(default_factory=dict)
