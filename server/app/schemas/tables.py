"""Table management ("ניהול שולחנות"): the till's and the dashboard's request bodies."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

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
    #: With `send`: the till stays in the table ("שגר והמשך", `tablesAfterSend` = stay,
    #: P:/specs/tables-send-selected-stay.md §2) — the send is recorded, the lock kept.
    stay: Optional[bool] = None
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
    """
    "פתיחת שולחן לפי מספר": the table of this number, made when it is on no map.

    "שחזור שולחן" onto a taken number (P:/specs/table-restore-payments.md §1): with `name` (the label,
    "ש-12") and where it goes — `nearTableId` (beside the original, in its zone) or `zoneId` — the
    table is made there, shown by its label alone (`labelOnly`), on TABLE_RESTORE's authority
    (`X-Pos-User-Id`). `number` may then be left out: the cloud picks one (9012 for 12, …).
    """

    number: Optional[int] = Field(None, ge=1, le=9999)
    name: Optional[str] = Field(None, max_length=60)
    zone_id: Optional[uuid.UUID] = Field(None, alias="zoneId")
    near_table_id: Optional[uuid.UUID] = Field(None, alias="nearTableId")
    #: "3B" typed on the keypad (P:/specs/table-scope.md §6.3): the labelled table — never made when there is none
    #: (404 `table_not_found`); outside the till's scope, 403 `table_out_of_scope` with the table.
    label: Optional[str] = Field(None, max_length=40)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)

    @field_validator("label", mode="before")
    @classmethod
    def _label(cls, value):
        return _clean_text(value, 40)

    @model_validator(mode="after")
    def _number_or_name(self):
        if self.number is None and not self.name and not self.label:
            raise ValueError("number or name is required")
        return self

    @property
    def labelled(self) -> bool:
        """A restored table's label or place: the restore's request, not "a table by number"."""
        return bool(self.name) or self.zone_id is not None or self.near_table_id is not None


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
    #: Gap 1 (P:/specs/local-server-switch.md §8): the till was the shop's server before a
    #: switch and sends the changes it never uploaded — an order the cloud changed since the
    #: switch is a conflict, not applied.
    former_host: bool = Field(False, alias="formerHost")


class TakeOverIn(_Camel):
    """"העבר את השרת לקופה הזו": who at the till decided (a manager, checked on the till)."""

    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)


class TableRestoreIn(_Camel):
    """"שחזור שולחן": who at the till restores it, and the manager who approved (checked on the till)."""

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)
    approved_by: Optional[str] = Field(None, alias="approvedBy", max_length=200)
    #: The till opens the restored order under an id derived from this one: it may claim the order
    #: again to finish a restore its answer was lost to (app/services/tables.py `mark_restored`).
    finish: bool = False


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
#: Sketch schema 3 (P:/specs/table-map-decor-v3.md §1, §2): the symbols of service, guests,
#: atmosphere and safety, the greenery, the direction arrow (at any angle), and the coloured
#: area ("אזור": a rectangle or a polygon, under everything).
SKETCH_KINDS_3 = (
    "service_station", "coffee_station", "buffet", "dessert_station", "display_fridge", "elevator",
    "kids_corner", "smoking", "no_smoking", "coat_check", "waiting_area", "tv", "speaker", "pickup",
    "delivery_exit", "trash", "sink", "first_aid", "fire_extinguisher", "parking", "outdoor", "heater",
    "fan_ac", "arrow",
    # "צמחייה" (the owner, 14.10): a tree, a planter, a green wall, a hedge, flowers.
    "tree", "planter", "green_wall", "hedge", "flowers",
    "area",
)
SKETCH_KINDS = SKETCH_KINDS + SKETCH_KINDS_3
#: What a variant means on each kind that takes one; any other kind keeps none.
#: counter — the bar's shape; restroom — whose (none: the both-sexes sign); exit — a plain
#: exit ("יציאה"; none: the emergency exit, "יציאת חירום"); bar ("דלפק") — what it pours (none:
#: a plain bar); door — which entrance (none: "כניסה"); plant — its size (none: the usual pot).
SKETCH_VARIANTS = {
    "counter": ("straight", "L", "U"),
    "restroom": ("men", "women", "accessible"),
    "exit": ("plain",),
    "bar": ("cocktail", "beer", "wine"),
    "door": ("main", "side", "staff"),
    "plant": ("large", "small"),
}
SKETCH_VARIANT_VALUES = tuple(dict.fromkeys(v for values in SKETCH_VARIANTS.values() for v in values))
#: The sketch schema this server speaks. A till that sends a lower one (or none — every
#: till before the decor symbols) cannot keep what came after its own: its map designer
#: drops kinds and variants it does not know when it saves. Those are kept for it
#: (app/services/tables.py, keep_decor_unknown_to_till). A new kind or variant: add it
#: here with the schema it comes with, and raise SKETCH_SCHEMA (the till's too).
#: Schema 4 (P:/specs/table-map-decor-v3.md §8): a text's and a logo's style (SKETCH_FIELD_SINCE).
SKETCH_SCHEMA = 4
#: The schema each kind / variant came with (absent: 1, every till knows it).
SKETCH_KIND_SINCE = {"dj_booth": 2, **{kind: 3 for kind in SKETCH_KINDS_3}}
SKETCH_VARIANT_SINCE = {
    ("counter", "U"): 2,
    ("restroom", "men"): 2,
    ("restroom", "women"): 2,
    ("restroom", "accessible"): 2,
    ("exit", "plain"): 2,
    **{(kind, v): 3 for kind in ("bar", "door", "plant") for v in SKETCH_VARIANTS[kind]},
}
#: An area's fill when none was sent (the first of the dashboard's palette: green) and its
#: opacity, in percent (10–60; 30 when none was sent). Stored on every area, so the till
#: never has to guess.
SKETCH_AREA_FILL_DEFAULT = "#22c55e"
SKETCH_AREA_OPACITY_MIN = 10
SKETCH_AREA_OPACITY_MAX = 60
SKETCH_AREA_OPACITY_DEFAULT = 30
#: `clean` — the flat, neutral floor (the default when nothing is chosen).
SKETCH_BACKGROUNDS = ("clean", "wood", "tiles", "light", "dark", "image")
SketchBackground = Literal["clean", "wood", "tiles", "light", "dark", "image"]
SKETCH_SRC_MAX = 1000
SKETCH_ELEMENTS_MAX = 600
SKETCH_POINTS_MAX = 4000
#: A text's words ("label", several lines) and any other shape's.
SKETCH_LABEL_TEXT_MAX = 200
SKETCH_TEXT_MAX = 60
#: "טקסט ולוגו" (schema 4, P:/specs/table-map-decor-v3.md §8). A text's size: a named one or a
#: whole number of canvas units (the zone's, like w / h).
SKETCH_FONT_SIZES = {"s": 14, "m": 20, "l": 28, "xl": 40}
SKETCH_FONT_SIZE_MIN = 10
SKETCH_FONT_SIZE_MAX = 72
SKETCH_LABEL_ALIGNS = ("left", "center", "right")
SKETCH_BG_OPACITY_MIN = 10
SKETCH_BG_OPACITY_MAX = 100
SKETCH_BG_OPACITY_DEFAULT = 100
SKETCH_LOGO_SOURCES = ("business", "image")
SKETCH_LOGO_OPACITY_MIN = 20
SKETCH_LOGO_OPACITY_MAX = 100
#: The fields each kind gained with a schema (absent: every till knows them). A till of an
#: older schema never sends them, so it never changed them: kept for it on a shape it kept.
SKETCH_FIELD_SINCE = {
    "label": {"fontSize": 4, "bold": 4, "bg": 4, "bgOpacity": 4, "align": 4},
    "logo": {"source": 4, "opacity": 4, "keepAspect": 4},
}


class SketchElementIn(_Camel):
    """One shape of a zone's sketch, in the zone's canvas units."""

    id: str = Field(..., min_length=1, max_length=64)
    #: One of SKETCH_KINDS (schema 3 included).
    kind: Literal[SKETCH_KINDS]  # type: ignore[valid-type]
    x: float = Field(..., ge=-100, le=5100)
    y: float = Field(..., ge=-100, le=5100)
    w: float = Field(..., ge=0, le=5200)
    h: float = Field(..., ge=0, le=5200)
    rotation: int = Field(0, ge=0, le=359)
    #: The words: a text's ("label") up to 200 characters on several lines; any other's up to 60.
    text: Optional[str] = Field(None, max_length=SKETCH_LABEL_TEXT_MAX)
    #: A bar counter ("counter"): straight, L- or U-shaped, with this many stools in front.
    #: Restrooms: "men" / "women" / "accessible" (none: both). An exit: "plain" (none: the
    #: emergency exit). A bar: cocktail / beer / wine. An entrance: main / side / staff. A
    #: plant: large / small. See SKETCH_VARIANTS; on any other kind it is not kept.
    variant: Optional[Literal[SKETCH_VARIANT_VALUES]] = None  # type: ignore[valid-type]
    stools: int = Field(0, ge=0, le=40)
    #: A drawn line, polyline or freehand stroke: its points as x, y, x, y… (canvas units).
    #: An area: its polygon's corners (none: the rectangle x, y, w, h).
    points: Optional[List[float]] = Field(None, max_length=SKETCH_POINTS_MAX)
    #: A drawn shape's colour ("#rrggbb"), stroke width (canvas units) and, for a
    #: rectangle, whether it is filled. On a symbol, its own colour (none: the theme's); on
    #: a label, its words'; on an area, its name's.
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    stroke: Optional[float] = Field(None, ge=0.5, le=60)
    filled: Optional[bool] = None
    #: A logo's own picture (an uploaded image's URL); none — the business's logo.
    src: Optional[str] = Field(None, max_length=SKETCH_SRC_MAX)
    #: An area ("אזור"): its fill ("#rrggbb", from the dashboard's palette) and how opaque it
    #: is, in percent (10–60). A logo: how opaque it is (20–100). On any other kind neither is kept.
    fill: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    opacity: Optional[int] = Field(None, ge=SKETCH_AREA_OPACITY_MIN, le=SKETCH_LOGO_OPACITY_MAX)
    #: Schema 4 (P:/specs/table-map-decor-v3.md §8). A text ("label"): its size (s / m / l / xl or
    #: 10–72 canvas units; none — fitted to its box), bold, a chip behind it (`bg`, `bgOpacity`
    #: 10–100) and its alignment in the box (none: centred).
    font_size: Optional[Union[str, int]] = Field(None, alias="fontSize")
    bold: Optional[StrictBool] = None
    bg: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    bg_opacity: Optional[int] = Field(None, alias="bgOpacity", ge=SKETCH_BG_OPACITY_MIN, le=SKETCH_BG_OPACITY_MAX)
    align: Optional[Literal[SKETCH_LABEL_ALIGNS]] = None  # type: ignore[valid-type]
    #: A logo: the business's (`business`) or the uploaded picture in `src` (`image`); none —
    #: `src` decides. `keepAspect` false: stretched to its box (none: fitted, its proportions kept).
    source: Optional[Literal[SKETCH_LOGO_SOURCES]] = None  # type: ignore[valid-type]
    keep_aspect: Optional[StrictBool] = Field(None, alias="keepAspect")

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, value):
        # Several lines (a text's): one kind of line break.
        if isinstance(value, str):
            value = value.replace("\r\n", "\n").replace("\r", "\n")
        return _clean_text(value, SKETCH_LABEL_TEXT_MAX)

    @field_validator("font_size", mode="before")
    @classmethod
    def _font_size(cls, value):
        if value is None:
            return None
        if isinstance(value, str):
            if value not in SKETCH_FONT_SIZES:
                raise ValueError(f"fontSize is {', '.join(SKETCH_FONT_SIZES)} or {SKETCH_FONT_SIZE_MIN}–{SKETCH_FONT_SIZE_MAX}")
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("fontSize is a size name or a whole number")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError("fontSize is a whole number")
            value = int(value)
        if not SKETCH_FONT_SIZE_MIN <= value <= SKETCH_FONT_SIZE_MAX:
            raise ValueError(f"fontSize is {SKETCH_FONT_SIZE_MIN}–{SKETCH_FONT_SIZE_MAX}")
        return value

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
        if self.kind == "area" and self.points is not None and len(self.points) < 6:
            raise ValueError("an area's polygon has at least three corners")
        allowed = SKETCH_VARIANTS.get(self.kind)
        if allowed is not None and self.variant is not None and self.variant not in allowed:
            raise ValueError(f"a {self.kind} is {', '.join(allowed)}, not {self.variant}")
        if self.kind != "label" and self.text is not None and len(self.text) > SKETCH_TEXT_MAX:
            raise ValueError(f"text: at most {SKETCH_TEXT_MAX} characters")
        if self.opacity is not None:
            if self.kind == "area" and self.opacity > SKETCH_AREA_OPACITY_MAX:
                raise ValueError(f"an area's opacity is {SKETCH_AREA_OPACITY_MIN}–{SKETCH_AREA_OPACITY_MAX}")
            if self.kind == "logo" and self.opacity < SKETCH_LOGO_OPACITY_MIN:
                raise ValueError(f"a logo's opacity is {SKETCH_LOGO_OPACITY_MIN}–{SKETCH_LOGO_OPACITY_MAX}")
        if self.kind == "logo" and self.source == "image" and not self.src:
            raise ValueError("a logo of an uploaded picture needs its src")
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


#: "מספר שולחן (אפשר עם אותיות, למשל 3B)" (P:/specs/table-scope.md §6.1): a number, or a text that is one ("12"),
#: or a label ("3B") — checked by app/services/table_labels.py (422 `table_label_invalid`).
NumberOrLabel = Union[int, str]


class TableCreate(_Camel):
    zone_id: uuid.UUID = Field(..., alias="zoneId")
    number: NumberOrLabel
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
    #: A number makes the table its number (a label it had is dropped); a label ("3B") labels it.
    number: Optional[NumberOrLabel] = None
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
    """
    "Add tables 1–100 to this zone": numbers already taken in the shop are skipped. With letters ("3A" … "3L",
    P:/specs/table-scope.md §9): the same beginning, a letter or a number at the end — labels taken are skipped.
    """

    from_number: NumberOrLabel = Field(..., alias="from")
    to_number: NumberOrLabel = Field(..., alias="to")
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
    #: "3B" (P:/specs/table-scope.md §6.1): sent — the table is labelled (null: its number again); absent (a till
    #: from before labels) — its label stays. A new labelled table needs no `number` (an internal one is picked).
    label: Optional[str] = Field(None, max_length=40)
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

    @field_validator("label", mode="before")
    @classmethod
    def _label(cls, value):
        return _clean_text(value, 40)


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
    #: The order and its version as the dashboard showed them: another order or version now is 409
    #: `order_changed` (the dashboard refreshes). Absent (an older dashboard): not compared.
    order_id: Optional[uuid.UUID] = Field(None, alias="orderId")
    expected_version: Optional[int] = Field(None, alias="expectedVersion", ge=0)

    @field_validator("reason_text", mode="before")
    @classmethod
    def _reason_text(cls, value):
        return _clean_text(value, 300)


# ── "כרטיס שולחן": the dashboard's actions (P:/specs/live-tables-cloud.md §6.8) ──────────────


class ReprintPickIn(_Camel):
    """One line of one round, picked for a reprint (the till's ReprintPick)."""

    round_id: str = Field(..., alias="roundId", min_length=1, max_length=120)
    line_id: str = Field(..., alias="lineId", min_length=1, max_length=120)


class CardMergeSourceIn(_Camel):
    """An open table merged into the card's, at the order and version the dashboard showed."""

    table_id: uuid.UUID = Field(..., alias="tableId")
    order_id: Optional[uuid.UUID] = Field(None, alias="orderId")
    expected_version: Optional[int] = Field(None, alias="expectedVersion", ge=0)


class TableActionIn(_Camel):
    """
    `POST /tables/tables/{id}/actions/{action}`: the order and version the card showed, the click's id
    (a retry of it is the same request — the same command, the same tickets), and the action's own.
    """

    order_id: uuid.UUID = Field(..., alias="orderId")
    expected_version: Optional[int] = Field(None, alias="expectedVersion", ge=0)
    request_id: uuid.UUID = Field(..., alias="requestId")
    #: fire / hold.
    course_id: Optional[str] = Field(None, alias="courseId", max_length=100)
    hold: bool = True
    #: reprint: everything, a round, or lines of rounds.
    scope: Literal["all", "round", "lines"] = "all"
    round_id: Optional[str] = Field(None, alias="roundId", max_length=120)
    picks: List[ReprintPickIn] = Field(default_factory=list, max_length=500)
    #: set-waiter.
    waiter_pos_user_id: Optional[uuid.UUID] = Field(None, alias="waiterPosUserId")
    #: move.
    target_table_id: Optional[uuid.UUID] = Field(None, alias="targetTableId")
    #: merge: into the card's table.
    sources: List[CardMergeSourceIn] = Field(default_factory=list, max_length=10)
    #: note (empty clears it).
    text: Optional[str] = Field(None, max_length=500)
    #: print-bill: the till, and its receipt printer (none: the till's own).
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    printer_id: Optional[uuid.UUID] = Field(None, alias="printerId")
    #: print-bill on another till (P:/specs/bill-print-other-till.md §7): the till that holds the table
    #: reckons it and relays it to this one, which prints it on its own receipt printer.
    print_on: Optional[uuid.UUID] = Field(None, alias="printOn")
    #: set-waiter: "גם שיוך" — the table's assignment moves to the new waiter too
    #: (P:/specs/table-waiter-assignment.md §4).
    also_assignment: bool = Field(False, alias="alsoAssignment")


# ── "שיוך שולחנות למלצרים" (P:/specs/table-waiter-assignment.md; app/services/table_assignments.py) ──


class AssignmentChangeIn(_Camel):
    """One tap of the assignment mode: a waiter on (or off) a zone or a table — one of the two."""

    action: Literal["assign", "unassign"] = "assign"
    #: The waiter; for `unassign`, none — everyone's assignment of the target.
    pos_user_id: Optional[uuid.UUID] = Field(None, alias="posUserId")
    table_id: Optional[uuid.UUID] = Field(None, alias="tableId")
    zone_id: Optional[uuid.UUID] = Field(None, alias="zoneId")

    @model_validator(mode="after")
    def _one_target(self):
        if (self.table_id is None) == (self.zone_id is None):
            raise ValueError("exactly one of tableId, zoneId")
        if self.action == "assign" and self.pos_user_id is None:
            raise ValueError("posUserId is required to assign")
        return self


class TableAssignmentsIn(PosUserRef):
    """`POST /sync/{m}/tables/assignments`: the taps in order, after "נקה הכל" when `clear`."""

    clear: bool = False
    changes: List[AssignmentChangeIn] = Field(default_factory=list, max_length=500)


class TableAssignmentCopyIn(PosUserRef):
    """"העתק שיוך מאתמול" / "מהמשמרת הקודמת"."""

    source: Literal["yesterday", "previous_shift"] = Field(..., alias="from")


class AssignmentReportRowIn(_Camel):
    """One row of a LAN host's (or a single till's) copy, as it holds it — its own id."""

    id: uuid.UUID
    zone_id: Optional[uuid.UUID] = Field(None, alias="zoneId")
    table_id: Optional[uuid.UUID] = Field(None, alias="tableId")
    pos_user_id: uuid.UUID = Field(..., alias="posUserId")
    business_day: Optional[date] = Field(None, alias="businessDay")
    assigned_by: Optional[str] = Field(None, alias="assignedBy", max_length=200)
    assigned_by_pos_user_id: Optional[uuid.UUID] = Field(None, alias="assignedByPosUserId")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    released_at: Optional[datetime] = Field(None, alias="releasedAt")
    released_reason: Optional[
        Literal["unassigned", "replaced", "z", "clear", "clock_out", "copy", "target_gone", "expired"]
    ] = Field(None, alias="releasedReason")
    released_by: Optional[str] = Field(None, alias="releasedBy", max_length=200)


class TableAssignmentsReportIn(_Camel):
    """`POST /sync/{m}/tables/assignments/report`: the host's rows — live ones and those released lately."""

    assignments: List[AssignmentReportRowIn] = Field(default_factory=list, max_length=2000)


class DashboardAssignmentsIn(_Camel):
    """`POST /tables/assignments`: the dashboard's assignment mode, as the till's."""

    shop_id: uuid.UUID = Field(..., alias="shopId")
    clear: bool = False
    changes: List[AssignmentChangeIn] = Field(default_factory=list, max_length=500)


class DashboardAssignmentCopyIn(_Camel):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    source: Literal["yesterday", "previous_shift"] = Field(..., alias="from")


# ── "שולחן תפוס" (P:/specs/table-waiter-assignment.md §8; app/services/table_notices.py) ──


class TableEntryRequestIn(PosUserRef):
    """"בקש מדנה לצאת": who asks (the employee signed in at the asking till)."""


class TableNoticeAnswerIn(PosUserRef):
    """leaving — "שמור וצא"; ignored — "התעלם"; seen — a notice read."""

    answer: Literal["leaving", "ignored", "seen"]
