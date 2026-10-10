"""Table management ("ניהול שולחנות"): the till's and the dashboard's request bodies."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#: The till's cart snapshot is opaque here, but bounded: a table of 200 lines is ~200 kB.
CART_JSON_MAX = 1_000_000
EXTRAS_JSON_MAX = 200_000


def _clean_text(value, limit: int):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("must be text")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"at most {limit} characters")
    return value or None


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class PosUserRef(_Camel):
    """The employee signed in at the calling till, as the till names them."""

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)


class TableEnterIn(PosUserRef):
    pass


class TableHeartbeatIn(PosUserRef):
    pass


class _Versioned(PosUserRef):
    #: The order the till holds. A new one gets an id from the till, so a retried open
    #: is the same order.
    order_id: uuid.UUID = Field(..., alias="orderId")
    #: The version the till's copy is based on; null for a table it found free.
    expected_version: Optional[int] = Field(None, alias="expectedVersion", ge=0)
    #: Unique per write: a retry of a write that went through is answered, not refused.
    request_id: Optional[str] = Field(None, alias="requestId", max_length=64)


class WaiterRef(_Camel):
    """The table's waiter, when the till says (a new table: the opener; "החלפת מלצר": another)."""

    waiter_pos_user_id: Optional[str] = Field(None, alias="waiterPosUserId", max_length=100)
    waiter_pos_user_name: Optional[str] = Field(None, alias="waiterPosUserName", max_length=200)


class TableSaveIn(_Versioned, WaiterRef):
    #: save — keep it (autosave, before payment); send — "הזמן", then leave;
    #: bill — the bill was printed; leave — back to the tables screen.
    action: Literal["save", "send", "bill", "leave"] = "save"
    guests: Optional[int] = Field(None, ge=0, le=999)
    cart_json: str = Field(..., alias="cartJson", max_length=CART_JSON_MAX)
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)
    #: Shekels, after discounts — what the table owes now.
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)


class TableBillPrintedIn(_Versioned):
    """"הדפסת חשבון" from the floor: the order as the till read it (orderId, its version)."""


class TablePayIn(_Versioned):
    transaction_id: str = Field(..., alias="transactionId", min_length=1, max_length=100)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=50)
    paid_total: Decimal = Field(..., alias="paidTotal", ge=-10_000_000, le=10_000_000)
    guests: Optional[int] = Field(None, ge=0, le=999)
    cart_json: Optional[str] = Field(None, alias="cartJson", max_length=CART_JSON_MAX)
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)


class TablePartPayIn(_Versioned):
    """
    "פיצול חשבון": a part of the order was paid (its own sale). The table after it: the lines
    left (`cartJson`…), and its extras with the part recorded among `partials`.
    """

    transaction_id: str = Field(..., alias="transactionId", min_length=1, max_length=100)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=50)
    amount: Decimal = Field(..., ge=-10_000_000, le=10_000_000)
    cart_json: str = Field(..., alias="cartJson", max_length=CART_JSON_MAX)
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)


class CancelledItemIn(_Camel):
    name: str = Field(..., max_length=200)
    quantity: float = Field(..., ge=-1_000_000, le=1_000_000)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)


class TableCancelIn(_Versioned):
    reason_id: uuid.UUID = Field(..., alias="reasonId")
    reason_text: Optional[str] = Field(None, alias="reasonText")
    items: List[CancelledItemIn] = Field(default_factory=list, max_length=500)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)

    @field_validator("reason_text", mode="before")
    @classmethod
    def _reason_text(cls, value):
        return _clean_text(value, 300)


class TableMoveIn(_Versioned):
    target_table_id: uuid.UUID = Field(..., alias="targetTableId")


class TableTransferIn(_Versioned):
    """
    "העברת פריטים": lines of the open order (this table) moved to another table. The till
    built both orders: this one after (its `cartJson`…) and the target's after (`target*`),
    on the target as it read it (`targetOrderId`/`targetExpectedVersion`; null — free).
    """

    cart_json: str = Field(..., alias="cartJson", max_length=CART_JSON_MAX)
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)
    target_table_id: uuid.UUID = Field(..., alias="targetTableId")
    target_order_id: uuid.UUID = Field(..., alias="targetOrderId")
    target_expected_version: Optional[int] = Field(None, alias="targetExpectedVersion", ge=0)
    target_cart_json: str = Field(..., alias="targetCartJson", max_length=CART_JSON_MAX)
    target_extras_json: Optional[str] = Field(None, alias="targetExtrasJson", max_length=EXTRAS_JSON_MAX)
    target_item_count: float = Field(0, alias="targetItemCount", ge=0, le=1_000_000)
    target_total: Decimal = Field(Decimal("0"), alias="targetTotal", ge=-10_000_000, le=10_000_000)
    target_guests: Optional[int] = Field(None, alias="targetGuests", ge=0, le=999)


class ReservationIn(PosUserRef):
    """"הזמנת שולחן": a time, a party, and a table when one is set aside."""

    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    table_id: Optional[uuid.UUID] = Field(None, alias="tableId")
    reserved_at: datetime = Field(..., alias="reservedAt")
    duration_minutes: int = Field(90, alias="durationMinutes", ge=15, le=600)
    guests: Optional[int] = Field(None, ge=1, le=999)
    customer_name: str = Field(..., alias="customerName", min_length=1, max_length=120)
    phone: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=300)


class ReservationUpdate(_Camel):
    table_id: Optional[uuid.UUID] = Field(None, alias="tableId")
    reserved_at: Optional[datetime] = Field(None, alias="reservedAt")
    duration_minutes: Optional[int] = Field(None, alias="durationMinutes", ge=15, le=600)
    guests: Optional[int] = Field(None, ge=1, le=999)
    customer_name: Optional[str] = Field(None, alias="customerName", min_length=1, max_length=120)
    phone: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=300)
    status: Optional[Literal["booked", "seated", "cancelled", "no_show"]] = None


class ReservationStatusIn(PosUserRef):
    status: Literal["booked", "seated", "cancelled", "no_show"]


class TableAdhocIn(PosUserRef):
    """"פתיחת שולחן לפי מספר": the table of this number, made when it is on no map."""

    number: int = Field(..., ge=1, le=9999)


class TableReleaseIn(PosUserRef):
    #: Another till's lock, by a manager (`table:unlock`).
    force: bool = False


class TableCleanedIn(PosUserRef):
    """"נוקה": the table is cleared and laid again."""


class TableRenameIn(PosUserRef):
    #: Null or blank: the table goes back to its number alone.
    name: Optional[str] = Field(None, max_length=60)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class MergePrepareIn(PosUserRef):
    """Lock the target and every source for a merge, and read their orders."""

    source_table_ids: List[uuid.UUID] = Field(..., alias="sourceTableIds", min_length=1, max_length=20)


class MergeSourceIn(_Camel):
    table_id: uuid.UUID = Field(..., alias="tableId")
    order_id: uuid.UUID = Field(..., alias="orderId")
    expected_version: int = Field(..., alias="expectedVersion", ge=0)


class TableMergeIn(_Versioned):
    """
    "איחוד שולחנות": the target's order as the till merged it (`TableSaveIn`'s fields),
    and the source orders it took the lines of, each at the version the till read.
    """

    guests: Optional[int] = Field(None, ge=0, le=9999)
    cart_json: str = Field(..., alias="cartJson", max_length=CART_JSON_MAX)
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)
    sources: List[MergeSourceIn] = Field(..., min_length=1, max_length=20)


class LocalOrderIn(WaiterRef):
    """One order of a single-till ("קופה אחת") till, uploaded for the reports."""

    id: uuid.UUID
    table_id: uuid.UUID = Field(..., alias="tableId")
    status: Literal["open", "paid", "cancelled", "void", "merged"]
    merged_into_id: Optional[uuid.UUID] = Field(None, alias="mergedIntoId")
    version: int = Field(..., ge=1)
    guests: Optional[int] = Field(None, ge=0, le=999)
    item_count: float = Field(0, alias="itemCount", ge=0, le=1_000_000)
    total: Decimal = Field(Decimal("0"), ge=-10_000_000, le=10_000_000)
    opened_at: datetime = Field(..., alias="openedAt")
    opened_by_pos_user_id: Optional[str] = Field(None, alias="openedByPosUserId", max_length=100)
    opened_by_pos_user_name: Optional[str] = Field(None, alias="openedByPosUserName", max_length=200)
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    send_count: int = Field(0, alias="sendCount", ge=0)
    bill_printed_at: Optional[datetime] = Field(None, alias="billPrintedAt")
    closed_at: Optional[datetime] = Field(None, alias="closedAt")
    closed_by_pos_user_id: Optional[str] = Field(None, alias="closedByPosUserId", max_length=100)
    closed_by_pos_user_name: Optional[str] = Field(None, alias="closedByPosUserName", max_length=200)
    transaction_id: Optional[str] = Field(None, alias="transactionId", max_length=100)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=50)
    paid_total: Optional[Decimal] = Field(None, alias="paidTotal", ge=-10_000_000, le=10_000_000)
    cancel_reason_id: Optional[uuid.UUID] = Field(None, alias="cancelReasonId")
    cancel_reason_text: Optional[str] = Field(None, alias="cancelReasonText", max_length=300)
    cancel_approved_by_pos_user_id: Optional[str] = Field(None, alias="cancelApprovedByPosUserId", max_length=100)
    cancel_approved_by_name: Optional[str] = Field(None, alias="cancelApprovedByName", max_length=200)
    cancelled_items: Optional[List[CancelledItemIn]] = Field(None, alias="cancelledItems", max_length=500)
    #: The order's extras (its waiter, the parts paid on their own — their tips are counted).
    extras_json: Optional[str] = Field(None, alias="extrasJson", max_length=EXTRAS_JSON_MAX)
    #: The LAN host's mirror only: the order's cart, so a till taking over from a dead host
    #: has the dishes (`app.services.tables.host_seed`). A single till does not send it.
    cart_json: Optional[str] = Field(None, alias="cartJson", max_length=CART_JSON_MAX)


class TablesReportIn(_Camel):
    orders: List[LocalOrderIn] = Field(default_factory=list, max_length=200)


class TakeOverIn(_Camel):
    """"העבר את השרת לקופה הזו": who at the till decided (a manager, checked on the till)."""

    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)


class TableRestoreIn(_Camel):
    """"שחזור שולחן": who at the till restores it, and the manager who approved (checked on the till)."""

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)
    approved_by: Optional[str] = Field(None, alias="approvedBy", max_length=200)


# ── Dashboard ─────────────────────────────────────────────────────────────────

SKETCH_KINDS = (
    "wall", "bar", "door", "kitchen", "window", "restroom", "plant", "column", "label", "counter",
    "stairs", "cashier", "host", "exit", "stage", "sofa",
    # Drawn with the editor's tools: a line, a polyline (a wall of several segments),
    # a freehand stroke, a rectangle (outline or filled).
    "line", "polyline", "freehand", "rect",
    # The business's logo, placed on the floor: its own picture (`src`), else the business's.
    "logo",
    # Sketch schema 2 ("סמלים", docs: specs/table-map-decor.md): the DJ booth.
    "dj_booth",
)
#: What a variant means on each kind that takes one; any other kind keeps none.
#: counter — the bar's shape; restroom — whose (none: the both-sexes sign); exit — a plain
#: exit ("יציאה"; none: the emergency exit, "יציאת חירום").
SKETCH_VARIANTS = {
    "counter": ("straight", "L", "U"),
    "restroom": ("men", "women", "accessible"),
    "exit": ("plain",),
}
#: The sketch schema this server speaks. A till that sends a lower one (or none — every
#: till before the decor symbols) cannot keep what came with schema 2: its map designer
#: drops kinds and variants it does not know when it saves. Those are kept for it
#: (app/services/tables.py, keep_decor_unknown_to_till). A new kind or variant: add it
#: here with the schema it comes with, and raise SKETCH_SCHEMA (the till's too).
SKETCH_SCHEMA = 2
#: The schema each kind / variant came with (absent: 1, every till knows it).
SKETCH_KIND_SINCE = {"dj_booth": 2}
SKETCH_VARIANT_SINCE = {
    ("counter", "U"): 2,
    ("restroom", "men"): 2,
    ("restroom", "women"): 2,
    ("restroom", "accessible"): 2,
    ("exit", "plain"): 2,
}
#: `clean` — the flat, neutral floor (the default when nothing is chosen).
SKETCH_BACKGROUNDS = ("clean", "wood", "tiles", "light", "dark", "image")
SketchBackground = Literal["clean", "wood", "tiles", "light", "dark", "image"]
SKETCH_SRC_MAX = 1000
SKETCH_ELEMENTS_MAX = 600
SKETCH_POINTS_MAX = 4000


class SketchElementIn(_Camel):
    """One shape of a zone's sketch, in the zone's canvas units."""

    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal[
        "wall", "bar", "door", "kitchen", "window", "restroom", "plant", "column", "label", "counter",
        "stairs", "cashier", "host", "exit", "stage", "sofa",
        "line", "polyline", "freehand", "rect", "logo", "dj_booth",
    ]
    x: float = Field(..., ge=-100, le=5100)
    y: float = Field(..., ge=-100, le=5100)
    w: float = Field(..., ge=0, le=5200)
    h: float = Field(..., ge=0, le=5200)
    rotation: int = Field(0, ge=0, le=359)
    text: Optional[str] = Field(None, max_length=60)
    #: A bar counter ("counter"): straight, L- or U-shaped, with this many stools in front.
    #: Restrooms: "men" / "women" / "accessible" (none: both). An exit: "plain" (none: the
    #: emergency exit). See SKETCH_VARIANTS; on any other kind it is not kept.
    variant: Optional[Literal["straight", "L", "U", "men", "women", "accessible", "plain"]] = None
    stools: int = Field(0, ge=0, le=40)
    #: A drawn line, polyline or freehand stroke: its points as x, y, x, y… (canvas units).
    points: Optional[List[float]] = Field(None, max_length=SKETCH_POINTS_MAX)
    #: A drawn shape's colour ("#rrggbb"), stroke width (canvas units) and, for a
    #: rectangle, whether it is filled.
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    stroke: Optional[float] = Field(None, ge=0.5, le=60)
    filled: Optional[bool] = None
    #: A logo's own picture (an uploaded image's URL); none — the business's logo.
    src: Optional[str] = Field(None, max_length=SKETCH_SRC_MAX)

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, value):
        return _clean_text(value, 60)

    @field_validator("src", mode="before")
    @classmethod
    def _src(cls, value):
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("src is a URL")
        value = value.strip()
        if not value:
            return None
        if not (value.startswith("https://") or value.startswith("http://") or value.startswith("/")):
            raise ValueError("src is an http(s) URL")
        return value

    @field_validator("points")
    @classmethod
    def _points(cls, value):
        if value is None:
            return None
        if len(value) % 2 or len(value) < 4:
            raise ValueError("points are x, y pairs, at least two of them")
        if any(not (-100 <= v <= 5100) for v in value):
            raise ValueError("a point is off the canvas")
        return [round(float(v), 1) for v in value]

    @model_validator(mode="after")
    def _drawn_need_points(self):
        if self.kind in ("line", "polyline", "freehand") and not self.points:
            raise ValueError(f"a {self.kind} needs points")
        allowed = SKETCH_VARIANTS.get(self.kind)
        if allowed is not None and self.variant is not None and self.variant not in allowed:
            raise ValueError(f"a {self.kind} is {', '.join(allowed)}, not {self.variant}")
        return self


class SketchIn(_Camel):
    #: Which ready-made sketch it started from, for the record only.
    template: Optional[str] = Field(None, max_length=40)
    #: The floor under it all: wood planks (the default), tiles, plain light or dark, or
    #: the zone's uploaded image. Drawn by the till itself — no picture to download.
    background: Optional[SketchBackground] = None
    elements: List[SketchElementIn] = Field(default_factory=list, max_length=SKETCH_ELEMENTS_MAX)


class ZoneCreate(_Camel):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    name: str = Field(..., min_length=1, max_length=100)
    layout: Literal["map", "grid"] = "grid"
    background_url: Optional[str] = Field(None, alias="backgroundUrl", max_length=1000)
    canvas_width: int = Field(1000, alias="canvasWidth", ge=200, le=5000)
    canvas_height: int = Field(700, alias="canvasHeight", ge=200, le=5000)
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)
    sketch: Optional[SketchIn] = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        cleaned = _clean_text(value, 100)
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


class ZoneUpdate(_Camel):
    """Only the fields sent change; `areaId` / `backgroundUrl` / `sketch` sent as null clear them."""

    sketch: Optional[SketchIn] = None
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    name: Optional[str] = Field(None, max_length=100)
    layout: Optional[Literal["map", "grid"]] = None
    background_url: Optional[str] = Field(None, alias="backgroundUrl", max_length=1000)
    canvas_width: Optional[int] = Field(None, alias="canvasWidth", ge=200, le=5000)
    canvas_height: Optional[int] = Field(None, alias="canvasHeight", ge=200, le=5000)
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if value is None:
            return None
        cleaned = _clean_text(value, 100)
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


#: What a table is for (app/services/table_policies.py).
TableKind = Literal["regular", "staff", "managers"]


class TableCreate(_Camel):
    zone_id: uuid.UUID = Field(..., alias="zoneId")
    number: int = Field(..., ge=1, le=99_999)
    name: Optional[str] = Field(None, max_length=60)
    seats: int = Field(4, ge=0, le=99)
    shape: Literal["round", "square", "rect"] = "square"
    x: Optional[float] = Field(None, ge=0, le=5000)
    y: Optional[float] = Field(None, ge=0, le=5000)
    width: float = Field(80, ge=20, le=2000)
    height: float = Field(80, ge=20, le=2000)
    rotation: int = Field(0, ge=0, le=359)
    #: "סוג שולחן": regular / staff ("שולחן עובדים") / managers ("שולחן מנהלים"), its
    #: discount % ("הנחת שולחן", 0–100), or a type that decides both.
    kind: Optional[TableKind] = None
    discount_percent: Optional[Decimal] = Field(None, alias="discountPercent", ge=0, le=100, decimal_places=2)
    type_id: Optional[uuid.UUID] = Field(None, alias="typeId")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class TableUpdate(_Camel):
    zone_id: Optional[uuid.UUID] = Field(None, alias="zoneId")
    number: Optional[int] = Field(None, ge=1, le=99_999)
    name: Optional[str] = Field(None, max_length=60)
    seats: Optional[int] = Field(None, ge=0, le=99)
    shape: Optional[Literal["round", "square", "rect"]] = None
    x: Optional[float] = Field(None, ge=0, le=5000)
    y: Optional[float] = Field(None, ge=0, le=5000)
    width: Optional[float] = Field(None, ge=20, le=2000)
    height: Optional[float] = Field(None, ge=20, le=2000)
    rotation: Optional[int] = Field(None, ge=0, le=359)
    #: The policy: a kind, a discount (null clears it), a type (null: the table's own).
    kind: Optional[TableKind] = None
    discount_percent: Optional[Decimal] = Field(None, alias="discountPercent", ge=0, le=100, decimal_places=2)
    type_id: Optional[uuid.UUID] = Field(None, alias="typeId")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class BulkTablesIn(_Camel):
    """"Add tables 1–100 to this zone": numbers already taken in the shop are skipped."""

    from_number: int = Field(..., alias="from", ge=1, le=99_999)
    to_number: int = Field(..., alias="to", ge=1, le=99_999)
    seats: int = Field(4, ge=0, le=99)
    shape: Literal["round", "square", "rect"] = "square"
    #: Every table added of this type ("סוג שולחן"), when one is named.
    type_id: Optional[uuid.UUID] = Field(None, alias="typeId")


class TableTypeIn(_Camel):
    """"סוג שולחן": a policy reusable across the shop's tables (app/services/table_policies.py)."""

    shop_id: uuid.UUID = Field(..., alias="shopId")
    name: str = Field(..., min_length=1, max_length=60)
    kind: TableKind = "regular"
    discount_percent: Decimal = Field(Decimal("0"), alias="discountPercent", ge=0, le=100, decimal_places=2)
    require_approval: Optional[bool] = Field(None, alias="requireApproval")
    require_reason: Optional[bool] = Field(None, alias="requireReason")
    staff_mode: Literal["percent", "price_list", "allowance"] = Field("percent", alias="staffMode")
    staff_allowance: Optional[Decimal] = Field(None, alias="staffAllowance", ge=0, le=100_000, decimal_places=2)
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class TableTypeUpdate(_Camel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    kind: Optional[TableKind] = None
    discount_percent: Optional[Decimal] = Field(None, alias="discountPercent", ge=0, le=100, decimal_places=2)
    require_approval: Optional[bool] = Field(None, alias="requireApproval")
    require_reason: Optional[bool] = Field(None, alias="requireReason")
    staff_mode: Optional[Literal["percent", "price_list", "allowance"]] = Field(None, alias="staffMode")
    staff_allowance: Optional[Decimal] = Field(None, alias="staffAllowance", ge=0, le=100_000, decimal_places=2)
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class TablePositionIn(_Camel):
    id: uuid.UUID
    x: float = Field(..., ge=0, le=5000)
    y: float = Field(..., ge=0, le=5000)
    width: Optional[float] = Field(None, ge=20, le=2000)
    height: Optional[float] = Field(None, ge=20, le=2000)
    rotation: Optional[int] = Field(None, ge=0, le=359)


class TablePositionsIn(_Camel):
    items: List[TablePositionIn] = Field(..., max_length=1000)


# ── The till's edit mode: one batch, all or nothing ──────────────────────────


class TillZoneIn(_Camel):
    """A zone in a till's layout batch: an existing one (`id`) edited or archived, or a new
    one (no `id`) that the batch's tables name by its `clientId`."""

    id: Optional[uuid.UUID] = None
    client_id: Optional[str] = Field(None, alias="clientId", min_length=1, max_length=64)
    name: Optional[str] = Field(None, max_length=100)
    layout: Optional[Literal["map", "grid"]] = None
    #: The floor under the map — merged into the zone's sketch; its drawn shapes are kept.
    background: Optional[SketchBackground] = None
    #: The whole floor plan drawn on the till's map designer — the dashboard's own shape
    #: and rules (`SketchIn`); sent as null it clears the plan. Not sent: left as it is.
    sketch: Optional[SketchIn] = None
    canvas_width: Optional[int] = Field(None, alias="canvasWidth", ge=200, le=5000)
    canvas_height: Optional[int] = Field(None, alias="canvasHeight", ge=200, le=5000)
    archive: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return None if value is None else _clean_text(value, 100)


class TillTableIn(_Camel):
    """A table in a till's layout batch: an existing one (`id`) edited or archived, or a new
    one placed in an existing zone (`zoneId`) or in one the batch creates (`zoneClientId`)."""

    id: Optional[uuid.UUID] = None
    zone_id: Optional[uuid.UUID] = Field(None, alias="zoneId")
    zone_client_id: Optional[str] = Field(None, alias="zoneClientId", min_length=1, max_length=64)
    number: Optional[int] = Field(None, ge=1, le=99_999)
    name: Optional[str] = Field(None, max_length=60)
    seats: Optional[int] = Field(None, ge=0, le=99)
    shape: Optional[Literal["round", "square", "rect"]] = None
    x: Optional[float] = Field(None, ge=0, le=5000)
    y: Optional[float] = Field(None, ge=0, le=5000)
    width: Optional[float] = Field(None, ge=20, le=2000)
    height: Optional[float] = Field(None, ge=20, le=2000)
    rotation: Optional[int] = Field(None, ge=0, le=359)
    archive: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)


class TillLayoutIn(PosUserRef):
    """"שמור" in the till's edit mode: zones and tables added, changed and removed at once."""

    zones: List[TillZoneIn] = Field(default_factory=list, max_length=50)
    tables: List[TillTableIn] = Field(default_factory=list, max_length=1000)
    #: The sketch schema the till's map designer knows (SKETCH_SCHEMA). None: a till from
    #: before the decor symbols — what it cannot know is kept when it saves a plan.
    sketch_schema: Optional[int] = Field(None, alias="sketchSchema", ge=1, le=1000)


class ReasonCreate(_Camel):
    name: str = Field(..., max_length=100)
    requires_note: bool = Field(False, alias="requiresNote")
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        cleaned = _clean_text(value, 100)
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


class ReasonUpdate(_Camel):
    name: Optional[str] = Field(None, max_length=100)
    requires_note: Optional[bool] = Field(None, alias="requiresNote")
    sort_order: Optional[int] = Field(None, alias="sortOrder", ge=0, le=10_000)
    is_active: Optional[bool] = Field(None, alias="isActive")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if value is None:
            return None
        cleaned = _clean_text(value, 100)
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


class DashboardCancelIn(_Camel):
    reason_id: uuid.UUID = Field(..., alias="reasonId")
    reason_text: Optional[str] = Field(None, alias="reasonText")

    @field_validator("reason_text", mode="before")
    @classmethod
    def _reason_text(cls, value):
        return _clean_text(value, 300)
