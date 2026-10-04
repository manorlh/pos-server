"""
Table management ("ניהול שולחנות"): zones, tables, the open order on each table, the
cancellation reasons, and where kitchen tickets ("בונים") print.

Five tables (where kitchen tickets print is the kitchen-printers module's, not here):

* `table_zones` — an area of the floor ("אולם", "בר", "מרפסת"), shown as a tab on the
  till. Belongs to a shop and, optionally, to one point of sale (`area_id`): a zone with
  no area is seen by every till of the shop. Laid out as a `map` (tables placed on a
  canvas, optional floor-plan picture) or a `grid` (squares by number).
* `dining_tables` — one table: number (unique among the shop's live tables), name,
  seats, shape and place on its zone's canvas. Also carries the **lock** of the synced
  mode: which till and which employee are inside it now, until when.
* `table_orders` — the order of a table, from opening to payment or cancellation. The
  cart is the till's own snapshot (`cart_json`), opaque here. Every write bumps
  `version`; a write naming another version is refused (409) so two tills can never
  overwrite each other silently. At most one *synced* open order per table, enforced by
  a partial unique index. Single-till orders (`source='local'`) are uploaded for
  reporting only and never take part in that rule.
* `table_events` — what happened to an order, by whom, where: opened, sent, moved, paid,
  cancelled, a lock released by force…
* `table_cancel_reasons` — the tenant's list of cancellation reasons ("סיבות ביטול").
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

TABLE_ZONE_LAYOUTS = ("map", "grid")
TABLE_SHAPES = ("round", "square", "rect")
#: `merged`: its lines were moved into another table's order ("איחוד שולחנות").
TABLE_ORDER_STATUSES = ("open", "paid", "cancelled", "void", "merged")
#: The shapes a zone's sketch is drawn from (walls, a bar, the kitchen pass…).
SKETCH_KINDS = (
    "wall", "bar", "door", "kitchen", "window", "restroom", "plant", "column", "label", "counter",
    "line", "polyline", "freehand", "rect",
)
TABLE_ORDER_SOURCES = ("synced", "local")


class TableZone(Base):
    __tablename__ = "table_zones"
    __table_args__ = (
        CheckConstraint("layout IN ('map', 'grid')", name="ck_table_zones_layout"),
        Index("ix_table_zones_shop", "shop_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The point of sale whose tills see this zone; null = every till of the shop.
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(100), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    layout = Column(String(8), nullable=False, default="grid", server_default="grid")
    #: The floor plan drawn under a map zone's tables (an image URL), if any.
    background_url = Column(String(1000), nullable=True)
    #: The map's coordinate space; tables are placed in these units.
    canvas_width = Column(Integer, nullable=False, default=1000, server_default="1000")
    canvas_height = Column(Integer, nullable=False, default=700, server_default="700")
    #: A drawn floor plan under the tables, as vector shapes in canvas units:
    #: `{"template": str|null, "elements": [{"id", "kind", "x", "y", "w", "h", "rotation", "text"}]}`.
    #: The dashboard edits it; the till draws the same shapes.
    sketch = Column(JSONB, nullable=True)
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class DiningTable(Base):
    __tablename__ = "dining_tables"
    __table_args__ = (
        # One live "table 12" per shop: the number is what the waiter says.
        Index(
            "uq_dining_tables_shop_live_number",
            "shop_id",
            "number",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
        Index("ix_dining_tables_zone", "zone_id"),
        CheckConstraint("shape IN ('round', 'square', 'rect')", name="ck_dining_tables_shape"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False, index=True)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("table_zones.id", ondelete="CASCADE"), nullable=False)
    number = Column(Integer, nullable=False)
    name = Column(String(60), nullable=True)
    seats = Column(Integer, nullable=False, default=4, server_default="4")
    shape = Column(String(8), nullable=False, default="square", server_default="square")
    x = Column(Float, nullable=False, default=0, server_default="0")
    y = Column(Float, nullable=False, default=0, server_default="0")
    width = Column(Float, nullable=False, default=80, server_default="80")
    height = Column(Float, nullable=False, default=80, server_default="80")
    rotation = Column(Integer, nullable=False, default=0, server_default="0")
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # ── The synced mode's lock ────────────────────────────────────────────────
    #: The till inside the table now. A lock is live while `lock_expires_at` is ahead.
    lock_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    #: The employee at that till, as the till names them (free text, like cashier ids).
    lock_pos_user_id = Column(String(100), nullable=True)
    lock_pos_user_name = Column(String(200), nullable=True)
    lock_acquired_at = Column(DateTime(timezone=True), nullable=True)
    lock_expires_at = Column(DateTime(timezone=True), nullable=True)


class TableOrder(Base):
    __tablename__ = "table_orders"
    __table_args__ = (
        Index(
            "uq_table_orders_open_synced",
            "table_id",
            unique=True,
            postgresql_where=text("status = 'open' AND source = 'synced'"),
            sqlite_where=text("status = 'open' AND source = 'synced'"),
        ),
        Index("ix_table_orders_shop_opened", "shop_id", "opened_at"),
        Index("ix_table_orders_shop_status", "shop_id", "status"),
        CheckConstraint(
            "status IN ('open', 'paid', 'cancelled', 'void', 'merged')", name="ck_table_orders_status"
        ),
        CheckConstraint("source IN ('synced', 'local')", name="ck_table_orders_source"),
    )

    #: Generated by the till that opened it, so a retried open is the same order.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    table_id = Column(UUID(as_uuid=True), ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    #: The zone and the table's number and name when last written, for reports that
    #: outlive a renumbered or archived table.
    zone_id = Column(UUID(as_uuid=True), nullable=True)
    table_number = Column(Integer, nullable=True)
    table_name = Column(String(60), nullable=True)
    status = Column(String(16), nullable=False, default="open", server_default="open")
    source = Column(String(8), nullable=False, default="synced", server_default="synced")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    #: The client request that made the current version: a retry of it is answered with
    #: the state it produced instead of a version conflict.
    last_request_id = Column(String(64), nullable=True)
    guests = Column(Integer, nullable=True)
    #: The till's cart snapshot (lines with their products, discounts). Opaque here.
    cart_json = Column(Text, nullable=True)
    #: The till's bookkeeping: what was sent to the kitchen (line → quantity), notes.
    extras_json = Column(Text, nullable=True)
    item_count = Column(Numeric(12, 3), nullable=False, default=0, server_default="0")
    total = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")

    opened_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    opened_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    opened_by_pos_user_id = Column(String(100), nullable=True)
    opened_by_pos_user_name = Column(String(200), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_machine_id = Column(UUID(as_uuid=True), nullable=True)
    updated_by_pos_user_id = Column(String(100), nullable=True)
    updated_by_pos_user_name = Column(String(200), nullable=True)
    #: The last send to the kitchen ("הזמן"); `send_count` > 1 means additions.
    sent_at = Column(DateTime(timezone=True), nullable=True)
    send_count = Column(Integer, nullable=False, default=0, server_default="0")
    #: The bill was printed and nothing has changed since: "ממתין לתשלום".
    bill_printed_at = Column(DateTime(timezone=True), nullable=True)

    closed_at = Column(DateTime(timezone=True), nullable=True)
    closed_machine_id = Column(UUID(as_uuid=True), nullable=True)
    closed_by_pos_user_id = Column(String(100), nullable=True)
    closed_by_pos_user_name = Column(String(200), nullable=True)
    #: Paid: the sale document the till wrote for it.
    transaction_id = Column(String(100), nullable=True)
    transaction_number = Column(String(50), nullable=True)
    paid_total = Column(Numeric(12, 2), nullable=True)
    #: Paid on a version older than the cloud's (the till lost its lock mid-payment).
    pay_conflict = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Cancelled: why, who approved, and what was on it.
    cancel_reason_id = Column(UUID(as_uuid=True), nullable=True)
    cancel_reason_text = Column(String(300), nullable=True)
    cancel_approved_by_user_id = Column(UUID(as_uuid=True), nullable=True)
    cancel_approved_by_pos_user_id = Column(String(100), nullable=True)
    cancel_approved_by_name = Column(String(200), nullable=True)
    cancelled_items = Column(JSONB, nullable=True)
    #: Merged: the order its lines went into.
    merged_into_id = Column(UUID(as_uuid=True), nullable=True)


class TableEvent(Base):
    __tablename__ = "table_events"
    __table_args__ = (Index("ix_table_events_order", "order_id", "occurred_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    table_id = Column(UUID(as_uuid=True), nullable=True)
    order_id = Column(UUID(as_uuid=True), nullable=True)
    #: open | save | send | bill | move | pay | cancel | void | force_release | report
    kind = Column(String(24), nullable=False)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_id = Column(String(100), nullable=True)
    pos_user_name = Column(String(200), nullable=True)
    #: A dashboard user (a force release or a cancel from the dashboard).
    user_id = Column(UUID(as_uuid=True), nullable=True)
    version = Column(Integer, nullable=True)
    details = Column(JSONB, nullable=True)


class TableCancelReason(Base):
    __tablename__ = "table_cancel_reasons"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    #: "אחר": the till asks for free text with it.
    requires_note = Column(Boolean, nullable=False, default=False, server_default="false")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


