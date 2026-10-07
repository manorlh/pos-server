"""Request bodies of the KDS and workflow endpoints (app/routers/kds.py, docs/SPEC_KDS.md)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

TEXT_MAX = 200
ITEMS_MAX = 300


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class KdsItemIn(_Body):
    """One line of a release: a delta (more of it, or — negative — taken off)."""

    #: The till's line, the same in every round: "<cart line id>:<component index>".
    line_key: str = Field(alias="lineKey", min_length=1, max_length=120)
    product_id: Optional[str] = Field(None, alias="productId", max_length=64)
    category_id: Optional[str] = Field(None, alias="categoryId", max_length=64)
    name: str = Field(max_length=TEXT_MAX)
    quantity: float
    mods: Optional[List[str]] = Field(None, max_length=40)
    removals: Optional[List[str]] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=500)
    allergies: Optional[List[str]] = Field(None, max_length=20)
    important: bool = False
    seat: Optional[str] = Field(None, max_length=60)
    course: Optional[str] = Field(None, max_length=60)
    meal_name: Optional[str] = Field(None, alias="mealName", max_length=100)


class KdsNoteIn(_Body):
    line_key: str = Field(alias="lineKey", min_length=1, max_length=120)
    notes: Optional[str] = Field(None, max_length=500)


class KdsReleaseIn(_Body):
    """
    `POST /sync/{m}/kds/release`. Idempotent by `id`: a retry (after a timeout, offline)
    returns the first result and creates nothing.
    """

    id: str = Field(min_length=8, max_length=64)
    source: Literal["table", "quick", "kiosk", "external"]
    source_ref: str = Field(alias="sourceRef", min_length=1, max_length=100)
    #: send — a table's "שלח" or a quick sale's "שלח למטבח"; payment — after the payment;
    #: cancel — the whole order was cancelled; manual — anything else.
    trigger: Literal["send", "payment", "manual", "cancel"] = "send"
    paid: bool = False
    #: The mode the worker switched this order to (honoured only when allowed).
    workflow_mode: Optional[Literal["DIRECT_SALE", "ORDER_PROCESS"]] = Field(None, alias="workflowMode")
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")
    display_ref: Optional[str] = Field(None, alias="displayRef", max_length=60)
    table_ref: Optional[str] = Field(None, alias="tableRef", max_length=60)
    zone_name: Optional[str] = Field(None, alias="zoneName", max_length=100)
    service_type: Optional[Literal["eat_in", "take_away"]] = Field(None, alias="serviceType")
    guests: Optional[int] = Field(None, ge=0, le=10_000)
    waiter_name: Optional[str] = Field(None, alias="waiterName", max_length=TEXT_MAX)
    pickup_name: Optional[str] = Field(None, alias="pickupName", max_length=100)
    contact_phone: Optional[str] = Field(None, alias="contactPhone", max_length=30)
    order_note: Optional[str] = Field(None, alias="orderNote", max_length=300)
    pickup_number: Optional[int] = Field(None, alias="pickupNumber", ge=1, le=9999)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=50)
    actor_name: Optional[str] = Field(None, alias="actorName", max_length=TEXT_MAX)
    items: List[KdsItemIn] = Field(default_factory=list, max_length=ITEMS_MAX)
    #: The lines held at the table now (a course not fired): the complete set — null
    #: leaves the held lines as they are.
    held: Optional[List[KdsItemIn]] = Field(None, max_length=ITEMS_MAX)
    note_updates: List[KdsNoteIn] = Field(default_factory=list, alias="noteUpdates", max_length=ITEMS_MAX)
    #: The till printed this round on a fallback printer before the KDS had it.
    fallback_printed: bool = Field(False, alias="fallbackPrinted")


KDS_ACTION_TYPES = (
    "start",
    "item_ready",
    "undo_ready",
    "station_ready",
    "ack_change",
    "ready_for_pickup",
    "undo_pickup",
    "handover",
    "priority",
    "resolve_fallback",
    "remake",
)


class KdsActionIn(_Body):
    """`POST /sync/{m}/kds/actions` — one mutation from a screen, idempotent by `id`."""

    id: str = Field(min_length=8, max_length=64)
    type: Literal[
        "start",
        "item_ready",
        "undo_ready",
        "station_ready",
        "ack_change",
        "ready_for_pickup",
        "undo_pickup",
        "handover",
        "priority",
        "resolve_fallback",
        "remake",
    ]
    task_id: Optional[uuid.UUID] = Field(None, alias="taskId")
    order_id: Optional[uuid.UUID] = Field(None, alias="orderId")
    change_id: Optional[uuid.UUID] = Field(None, alias="changeId")
    station_id: Optional[uuid.UUID] = Field(None, alias="stationId")
    qty: Optional[float] = Field(None, gt=0)
    reason: Optional[str] = Field(None, max_length=200)
    override: bool = False
    resolution: Optional[Literal["prepared", "prepare"]] = None
    priority: Optional[int] = Field(None, ge=0, le=9)
    expected_version: Optional[int] = Field(None, alias="expectedVersion")
    actor_name: Optional[str] = Field(None, alias="actorName", max_length=TEXT_MAX)
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")


class KdsDisplayIn(_Body):
    """The "מסך מוכן / לא מוכן" board's look (docs/SPEC_KDS.md §13)."""

    theme: Literal["dark", "light", "contrast", "brand"] = "dark"
    #: "#rrggbb" for the ready column and the announcement; None = the theme's own.
    accent: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    sound: bool = True
    show_preparing: bool = Field(True, alias="showPreparing")
    title: Optional[str] = Field(None, max_length=60)


class KdsDeviceIn(_Body):
    name: Optional[str] = Field(None, max_length=100)
    role: Literal["station", "expo", "pickup", "manager"] = "station"
    station_ids: List[uuid.UUID] = Field(default_factory=list, alias="stationIds", max_length=30)
    is_active: bool = Field(True, alias="isActive")
    #: The board's look; absent (an older dashboard, a pairing) keeps what the screen has.
    display: Optional[KdsDisplayIn] = None


class KdsStationSettingIn(_Body):
    target_kind: Literal["prep", "view"] = Field("prep", alias="targetKind")
    warn_minutes: int = Field(10, alias="warnMinutes", ge=1, le=240)
    late_minutes: int = Field(20, alias="lateMinutes", ge=1, le=480)


class KdsRouteOverrideIn(_Body):
    target_type: Literal["category", "product"] = Field(alias="targetType")
    target_id: uuid.UUID = Field(alias="targetId")
    station_id: Optional[uuid.UUID] = Field(None, alias="stationId")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    service_type: Optional[Literal["eat_in", "take_away"]] = Field(None, alias="serviceType")


class WorkflowValuesIn(_Body):
    """`PUT /workflow/config` and its preview: values at one level (null removes)."""

    scope_type: Literal["company", "shop", "area", "machine"] = Field(alias="scopeType")
    scope_id: uuid.UUID = Field(alias="scopeId")
    values: Dict[str, Any] = Field(default_factory=dict)
