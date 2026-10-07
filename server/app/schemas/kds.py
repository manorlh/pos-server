"""Request bodies of the KDS and workflow endpoints (app/routers/kds.py, docs/SPEC_KDS.md)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

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


_SoundTone = Literal["chime", "bell", "knock", "beep", "off"]


class KdsFieldsIn(_Body):
    """What a kitchen ticket shows (all on = today's ticket)."""

    table: bool = True
    name: bool = True
    waiter: bool = True
    guests: bool = True
    course: bool = True
    notes: bool = True
    allergens: bool = True
    modifiers: bool = True


class KdsSoundsIn(_Body):
    """A sound per event on a kitchen screen ("off" = silent)."""

    new: _SoundTone = "chime"
    change: _SoundTone = "knock"
    late: _SoundTone = "off"


class KdsMediaIn(_Body):
    """A picture / video of the board's media panel — a kiosk MediaRef (`POST /kiosks/media`)."""

    url: str = Field(max_length=1000, pattern=r"^https?://\S+$")
    kind: Literal["image", "video"] = "image"
    sha256: Optional[str] = Field(None, pattern=r"^[0-9a-fA-F]{64}$")
    size: Optional[int] = Field(None, alias="bytes", ge=0)
    duration_sec: int = Field(8, alias="durationSec", ge=3, le=300)


class KdsDisplayIn(_Body):
    """
    How a screen looks (docs/SPEC_KDS.md §13.4.3, §14; app/services/kds_display.py). Version 1 was
    the board's five keys; every new key defaults to today's look.
    """

    theme: Literal["dark", "light", "contrast", "brand"] = "dark"
    #: "#rrggbb": the board's ready column / the kitchen's accent; None = the theme's own.
    accent: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    sound: bool = True
    show_preparing: bool = Field(True, alias="showPreparing")
    title: Optional[str] = Field(None, max_length=60)
    # The board ("מסך מוכן / לא מוכן").
    board_layout: Literal["columns", "spotlight", "grid", "split", "ticker"] = Field("columns", alias="boardLayout")
    #: A ready number leaves the board after this many minutes; None = as the cloud keeps it.
    ready_minutes: Optional[int] = Field(None, alias="readyMinutes", ge=1, le=240)
    media: List[KdsMediaIn] = Field(default_factory=list, max_length=12)
    promo_text: Optional[str] = Field(None, alias="promoText", max_length=140)
    # The kitchen screen.
    layout: Literal["tickets", "columns", "rail", "list", "big"] = "tickets"
    columns_by: Literal["station", "course"] = Field("station", alias="columnsBy")
    density: Literal["compact", "normal", "large"] = "normal"
    font_scale: float = Field(1.0, alias="fontScale", ge=0.8, le=1.6)
    age_colors: bool = Field(True, alias="ageColors")
    #: The screen's own age thresholds (both or neither); None = the stations' settings.
    warn_minutes: Optional[int] = Field(None, alias="warnMinutes", ge=1, le=240)
    late_minutes: Optional[int] = Field(None, alias="lateMinutes", ge=1, le=480)
    show: KdsFieldsIn = Field(default_factory=KdsFieldsIn, alias="fields")
    sounds: KdsSoundsIn = Field(default_factory=KdsSoundsIn)
    clock: bool = True
    counts: bool = True

    @model_validator(mode="after")
    def _thresholds_together(self) -> "KdsDisplayIn":
        if (self.warn_minutes is None) != (self.late_minutes is None):
            raise ValueError("warnMinutes and lateMinutes are set together")
        if self.warn_minutes is not None and self.late_minutes is not None and self.late_minutes <= self.warn_minutes:
            raise ValueError("lateMinutes must be after warnMinutes")
        return self


class KdsScopeIn(_Body):
    """Which orders a screen shows (a kitchen screen on top of its stations, the board): those of these points of sale or these machines (none = all)."""

    area_ids: List[uuid.UUID] = Field(default_factory=list, alias="areaIds", max_length=50)
    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds", max_length=100)


class KdsDeviceIn(_Body):
    name: Optional[str] = Field(None, max_length=100)
    role: Literal["station", "expo", "pickup", "manager"] = "station"
    station_ids: List[uuid.UUID] = Field(default_factory=list, alias="stationIds", max_length=30)
    is_active: bool = Field(True, alias="isActive")
    #: The screen's look; absent (an older dashboard, a pairing) keeps what the screen has.
    display: Optional[KdsDisplayIn] = None
    #: True: the screen drops its own look and follows the shop's default (`display` is ignored).
    display_inherit: bool = Field(False, alias="displayInherit")
    #: The screen's orders (points of sale / tills and kiosks); absent keeps, empty = the whole shop.
    scope: Optional[KdsScopeIn] = None


class KdsReadyActionIn(_Body):
    """
    `POST /sync/{m}/kds/ready-actions` — "הזמנות להכנה" on a till (a shop with a board and no
    KDS): the order is ready, handed over, or back one step. Idempotent by `id`, like a screen's.
    """

    id: str = Field(min_length=8, max_length=64)
    type: Literal["ready", "handover", "undo"]
    order_id: uuid.UUID = Field(alias="orderId")
    actor_name: Optional[str] = Field(None, alias="actorName", max_length=TEXT_MAX)
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")


class KdsDisplayDefaultsIn(_Body):
    """`PUT /kds/shops/{shop}/display-defaults`: a key absent stays, null removes the default."""

    kds: Optional[KdsDisplayIn] = None
    board: Optional[KdsDisplayIn] = None


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
