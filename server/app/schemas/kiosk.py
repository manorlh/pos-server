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
    #: Null: "ללא סוג שירות" (the kiosk's general.serviceMode = none) — the order has no service.
    service_type: Optional[Literal["take_away", "eat_in"]] = Field(None, alias="serviceType")
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


class KioskMenuIn(_Camel):
    """`POST /sync/{id}/kiosk/menu` — "עריכת תפריט הקיוסק" (docs/SPEC_KIOSK.md §22)."""

    #: The till user whose manager PIN was entered on the kiosk.
    approver_id: Optional[str] = Field(None, alias="approverId", max_length=64)
    #: The `menuVersion` the edit started from (kiosk/sync); another is refused 409.
    base_version: Optional[str] = Field(None, alias="baseVersion", max_length=32)
    #: The catalog's menu keys (categoryOrder, productOrder, hiddenCategories, hiddenProducts, featuredProductIds).
    menu: Dict[str, Any] = Field(default_factory=dict)


class PickupNumberIn(_Camel):
    order_key: str = Field(..., alias="orderKey", min_length=1, max_length=64)
    business_date: date = Field(..., alias="businessDate")


class KioskCommandIn(_Camel):
    #: `bon_print` / `bon_handled` ("הדפס עכשיו" / "סמן כטופל", docs/SPEC_KIOSK.md §16.8): the
    #: order's local id in `message`.
    action: Literal["pause", "resume", "close_shift", "till_z", "schedule", "bon_print", "bon_handled"]
    message: Optional[str] = Field(None, max_length=300)
    force: bool = False
    #: "נעילה למכירה" (pause): until reopened by hand ("manual", the default), HH:MM today
    #: ("time" + `untilTime`), for N minutes ("minutes" + `minutes`), or until the kiosk's next
    #: automatic opening ("next_open") — docs/SPEC_KIOSK.md §15.
    until_mode: Optional[Literal["manual", "time", "minutes", "next_open"]] = Field(None, alias="untilMode")
    until_time: Optional[str] = Field(None, alias="untilTime", max_length=5)
    minutes: Optional[int] = Field(None, ge=1, le=1440)
    #: "פתיחה אוטומטית" (schedule): `{enabled, days, open, close?, autoCloseAt?}`.
    schedule: Optional[Dict[str, Any]] = None
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
    #: The shop layer's `menuVersion` the dashboard loaded: a save that changes the kiosk menu
    #: from another version is refused 409 `kiosk_menu_changed` (docs/SPEC_KIOSK.md §22).
    menu_version: Optional[str] = Field(None, alias="menuVersion", max_length=32)
