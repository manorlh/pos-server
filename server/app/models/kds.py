"""
KDS — the kitchen display system and the order's preparation lifecycle
(docs/SPEC_KDS.md; owner's spec "חלק א — KDS" §4–12 and "תצורת עבודה לעמדה").

The stations themselves are the kitchen printers module's (`kitchen_stations`, with the
product / category → station assignments in `kitchen_station_targets`); this module
adds what a screen needs on top of them:

* `kds_devices` — a till paired as a KDS screen of a shop: a station screen (one or more
  stations), the Expo, a pickup screen or the kitchen manager.
* `kds_station_settings` — per shop and station: a preparation target or a view-only
  one ("יעד צפייה" never blocks readiness), and its timer thresholds.
* `kds_route_overrides` — "override לפי סניף/נקודת מכירה/סוג שירות" (§6).
* `kds_shop_state` — a counter bumped by every change in the shop (the screens poll it),
  the daily pickup numbers and the public pickup screen's opaque token.
* `kds_orders` — one per order released to the kitchen (a table's order, a quick sale,
  a kiosk order), with its `workflow_mode` / `config_version` snapshot.
* `kds_dispatches` — a release ("סבב"): one per send of a table, one per paid quick sale.
  The id is the till's idempotency key: a retried release is the same row.
* `kds_tasks` — one item at one station, from one round: ordered / cancelled / prepared
  quantities (active = ordered − cancelled), release (hold / released) and preparation
  (queued / preparing / ready) states, and a version.
* `kds_changes` — a cancellation or a note change on tasks the kitchen has, kept until a
  station acknowledges it ("ראיתי").
* `kds_groups` — the fulfillment group (one per order in P0): waiting →
  ready_for_pickup → handed_over (or cancelled).
* `kds_actions` — every mutation from a screen, by its idempotency key, with its result.
The ready event goes to the shared transactional outbox (`outbox_events`,
app/models/outbox.py — the notification service's), in the same transaction.
"""
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

KDS_DEVICE_ROLES = ("station", "expo", "pickup", "manager")
KDS_TARGET_KINDS = ("prep", "view")
KDS_SOURCES = ("table", "quick", "kiosk", "external")
KDS_ORDER_STATUSES = ("open", "ready", "handed_over", "cancelled", "closed")
KDS_RELEASE_STATES = ("hold", "released")
KDS_PREP_STATES = ("queued", "preparing", "ready")
KDS_GROUP_STATES = ("waiting", "ready_for_pickup", "handed_over", "cancelled")
KDS_CHANGE_KINDS = ("cancel", "note", "remake", "fallback", "override", "priority")
WORKFLOW_MODES = ("DIRECT_SALE", "ORDER_PROCESS")


class KdsDevice(Base):
    __tablename__ = "kds_devices"
    __table_args__ = (
        CheckConstraint("role IN ('station', 'expo', 'pickup', 'manager')", name="ck_kds_devices_role"),
        Index("ix_kds_devices_shop", "shop_id"),
        Index(
            "uq_kds_devices_machine",
            "machine_id",
            unique=True,
            postgresql_where=text("machine_id IS NOT NULL"),
            sqlite_where=text("machine_id IS NOT NULL"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The till that shows the screen.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(100), nullable=False)
    role = Column(String(16), nullable=False, default="station", server_default="station")
    #: A station screen's stations (kitchen station ids); empty for the other roles.
    station_ids = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    #: The board's look — `{theme, accent, sound, showPreparing, title}` (a pickup screen; null =
    #: the defaults). Sent with the screen in `kds/board` (docs/SPEC_KDS.md §13).
    display = Column(JSON, nullable=True)
    #: The screen's orders (any role — a kitchen screen on top of its stations, the pickup board):
    #: `{areaIds, machineIds}` — only orders released at those points of sale (`kds_orders.area_id`)
    #: or by those tills / kiosks (`kds_orders.machine_id`); null or both empty = the whole shop
    #: (docs/SPEC_KDS.md §15).
    scope = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KdsStationSetting(Base):
    """A station in one shop: a preparation target or a view-only one, and its timers."""

    __tablename__ = "kds_station_settings"
    __table_args__ = (CheckConstraint("target_kind IN ('prep', 'view')", name="ck_kds_station_settings_kind"),)

    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), primary_key=True)
    station_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_stations.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    target_kind = Column(String(8), nullable=False, default="prep", server_default="prep")
    #: The card turns orange ("מתעכב") after this many minutes, red ("באיחור") after the next.
    warn_minutes = Column(Integer, nullable=False, default=10, server_default="10")
    late_minutes = Column(Integer, nullable=False, default=20, server_default="20")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KdsRouteOverride(Base):
    """
    A product or category goes to another station in this shop — optionally only at one
    point of sale (`area_id`) and / or for one service type. `station_id` null: no
    station here (the item is shown on the Expo as unrouted, never dropped).
    """

    __tablename__ = "kds_route_overrides"
    __table_args__ = (
        CheckConstraint("target_type IN ('category', 'product')", name="ck_kds_route_overrides_type"),
        CheckConstraint(
            "service_type IS NULL OR service_type IN ('eat_in', 'take_away')", name="ck_kds_route_overrides_service"
        ),
        Index("ix_kds_route_overrides_shop", "shop_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True)
    service_type = Column(String(16), nullable=True)
    target_type = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    station_id = Column(UUID(as_uuid=True), ForeignKey("kitchen_stations.id", ondelete="CASCADE"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KdsShopState(Base):
    """Per shop: the change counter the screens poll, the pickup numbers, the public token."""

    __tablename__ = "kds_shop_state"

    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=0, server_default="0")
    #: The public pickup screen's opaque token (unguessable; rotated from the dashboard).
    pickup_token = Column(String(64), nullable=True, unique=True)
    #: Pickup numbers restart every business day (the shop's local date).
    pickup_day = Column(Date, nullable=True)
    pickup_next = Column(Integer, nullable=False, default=1, server_default="1")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KitchenOrder(Base):
    __tablename__ = "kds_orders"
    __table_args__ = (
        CheckConstraint("source IN ('table', 'quick', 'kiosk', 'external')", name="ck_kds_orders_source"),
        CheckConstraint(
            "status IN ('open', 'ready', 'handed_over', 'cancelled', 'closed')", name="ck_kds_orders_status"
        ),
        CheckConstraint("workflow_mode IN ('DIRECT_SALE', 'ORDER_PROCESS')", name="ck_kds_orders_workflow_mode"),
        Index("uq_kds_orders_source", "tenant_id", "source", "source_ref", unique=True),
        Index("ix_kds_orders_shop_status", "shop_id", "status"),
        # The board's orders handed over a moment ago, and the till's "הזמנות להכנה" of the last
        # day (app/services/kds.py) — by time, not by every order the shop ever had.
        Index("ix_kds_orders_shop_updated", "shop_id", "updated_at"),
        Index("ix_kds_orders_shop_created", "shop_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    #: The till that released it first.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    source = Column(String(16), nullable=False)
    #: The source's own id: the table order, the quick sale's cart / basket, the kiosk order.
    source_ref = Column(String(100), nullable=False)
    #: What the cards and the pickup screen call it ("שולחן 12", "1043").
    display_ref = Column(String(60), nullable=True)
    #: A physical table — null for a quick sale or a kiosk order (no fake table).
    table_ref = Column(String(60), nullable=True)
    zone_name = Column(String(100), nullable=True)
    service_type = Column(String(16), nullable=True)
    guests = Column(Integer, nullable=True)
    waiter_name = Column(String(200), nullable=True)
    #: "שם לאיסוף". Never on the public pickup screen.
    pickup_name = Column(String(100), nullable=True)
    #: The order contact snapshot (for the ready message). Never on a screen.
    contact_phone = Column(String(30), nullable=True)
    order_note = Column(String(300), nullable=True)
    pickup_number = Column(Integer, nullable=True)
    #: A kiosk order's pickup label as its slip printed it — "A-17", or "17" with the kiosk's
    #: "מספר בלבד" (`pickup.labelFormat`); the cards and the pickup screen show it. Null otherwise.
    pickup_label = Column(String(32), nullable=True)
    transaction_number = Column(String(50), nullable=True)
    #: Locked at the first release: a later change of the till's configuration applies
    #: to new orders only.
    workflow_mode = Column(String(16), nullable=False, default="ORDER_PROCESS")
    config_version = Column(String(16), nullable=True)
    config_snapshot = Column(JSON, nullable=True)
    paid = Column(Boolean, nullable=False, default=False, server_default="false")
    status = Column(String(16), nullable=False, default="open", server_default="open")
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    priority_reason = Column(String(200), nullable=True)
    round_count = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    first_released_at = Column(DateTime(timezone=True), nullable=True)
    ready_at = Column(DateTime(timezone=True), nullable=True)
    handed_over_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KitchenDispatch(Base):
    __tablename__ = "kds_dispatches"
    __table_args__ = (
        Index("uq_kds_dispatches_round", "order_id", "round_no", unique=True),
        Index("ix_kds_dispatches_shop", "shop_id", "created_at"),
    )

    #: The till's idempotency key.
    id = Column(String(64), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    order_id = Column(UUID(as_uuid=True), ForeignKey("kds_orders.id", ondelete="CASCADE"), nullable=False)
    round_no = Column(Integer, nullable=False)
    #: send (a table) | payment (a paid sale / kiosk order) | manual | cancel.
    trigger = Column(String(16), nullable=False, default="send")
    is_addition = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The till printed it on a printer because the KDS could not be reached in time.
    fallback_printed = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Recorded for the snapshot only: no KDS task (DIRECT_SALE with a printer only).
    no_tasks = Column(Boolean, nullable=False, default=False, server_default="false")
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    actor_name = Column(String(200), nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=True)
    item_count = Column(Integer, nullable=False, default=0, server_default="0")
    #: What the till sent, as it sent it (audit).
    payload = Column(JSON, nullable=True)
    #: What the release did (returned again to a retry).
    result = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KitchenTask(Base):
    __tablename__ = "kds_tasks"
    __table_args__ = (
        CheckConstraint("release_state IN ('hold', 'released')", name="ck_kds_tasks_release"),
        CheckConstraint("prep_state IN ('queued', 'preparing', 'ready')", name="ck_kds_tasks_prep"),
        CheckConstraint("target_kind IN ('prep', 'view')", name="ck_kds_tasks_kind"),
        Index("uq_kds_tasks_line", "dispatch_id", "line_key", "station_key", unique=True),
        Index("ix_kds_tasks_order", "order_id"),
        Index("ix_kds_tasks_shop_state", "shop_id", "prep_state"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    order_id = Column(UUID(as_uuid=True), ForeignKey("kds_orders.id", ondelete="CASCADE"), nullable=False)
    dispatch_id = Column(String(64), ForeignKey("kds_dispatches.id", ondelete="CASCADE"), nullable=False)
    round_no = Column(Integer, nullable=False, default=1)
    group_id = Column(UUID(as_uuid=True), nullable=True)
    #: Null: no station routes it — shown on the Expo as unrouted, never dropped.
    station_id = Column(UUID(as_uuid=True), nullable=True)
    #: `station_id` as text, '-' for none (part of the unique key).
    station_key = Column(String(40), nullable=False)
    station_name = Column(String(60), nullable=True)
    target_kind = Column(String(8), nullable=False, default="prep", server_default="prep")
    #: Counts for the order's readiness (a view-only task never does).
    required = Column(Boolean, nullable=False, default=True, server_default="true")
    #: The till's line ("<cart line id>:<component>"), the same across rounds.
    line_key = Column(String(120), nullable=False)
    product_id = Column(String(64), nullable=True)
    category_id = Column(String(64), nullable=True)
    name = Column(String(200), nullable=False)
    mods = Column(JSON, nullable=True)
    removals = Column(JSON, nullable=True)
    notes = Column(String(500), nullable=True)
    allergies = Column(JSON, nullable=True)
    important = Column(Boolean, nullable=False, default=False, server_default="false")
    seat = Column(String(60), nullable=True)
    course = Column(String(60), nullable=True)
    meal_name = Column(String(100), nullable=True)
    ordered_qty = Column(Numeric(12, 3), nullable=False, default=0)
    cancelled_qty = Column(Numeric(12, 3), nullable=False, default=0)
    prepared_qty = Column(Numeric(12, 3), nullable=False, default=0)
    release_state = Column(String(8), nullable=False, default="released", server_default="released")
    prep_state = Column(String(12), nullable=False, default="queued", server_default="queued")
    #: Printed on a fallback printer before the KDS had it: reconciled explicitly.
    fallback_printed = Column(Boolean, nullable=False, default=False, server_default="false")
    fallback_resolved_at = Column(DateTime(timezone=True), nullable=True)
    #: More was prepared than is now active (prepared before a cancellation) — recorded.
    over_prepared = Column(Boolean, nullable=False, default=False, server_default="false")
    linked_task_id = Column(UUID(as_uuid=True), nullable=True)
    remake_reason = Column(String(200), nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    released_at = Column(DateTime(timezone=True), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    ready_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KitchenChange(Base):
    __tablename__ = "kds_changes"
    __table_args__ = (
        Index("ix_kds_changes_order", "order_id"),
        # "מוכן" reads the task's last cancellation (`_last_cancel_at`) on every bump.
        Index("ix_kds_changes_task", "task_id"),
        # The board's changes still waiting for an acknowledgement, per shop.
        Index(
            "ix_kds_changes_shop_unacked",
            "shop_id",
            postgresql_where=text("acked_at IS NULL AND requires_ack IS true"),
            sqlite_where=text("acked_at IS NULL AND requires_ack IS true"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    order_id = Column(UUID(as_uuid=True), ForeignKey("kds_orders.id", ondelete="CASCADE"), nullable=False)
    task_id = Column(UUID(as_uuid=True), nullable=True)
    dispatch_id = Column(String(64), nullable=True)
    station_id = Column(UUID(as_uuid=True), nullable=True)
    kind = Column(String(12), nullable=False)
    qty = Column(Numeric(12, 3), nullable=True)
    text = Column(String(500), nullable=True)
    before = Column(JSON, nullable=True)
    after = Column(JSON, nullable=True)
    requires_ack = Column(Boolean, nullable=False, default=True, server_default="true")
    acked_at = Column(DateTime(timezone=True), nullable=True)
    acked_by = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class FulfillmentGroup(Base):
    __tablename__ = "kds_groups"
    __table_args__ = (
        CheckConstraint(
            "state IN ('waiting', 'ready_for_pickup', 'handed_over', 'cancelled')", name="ck_kds_groups_state"
        ),
        Index("uq_kds_groups_key", "order_id", "key", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    order_id = Column(UUID(as_uuid=True), ForeignKey("kds_orders.id", ondelete="CASCADE"), nullable=False)
    #: "order" — the whole order (P0); later by course or packing group.
    key = Column(String(40), nullable=False, default="order")
    state = Column(String(20), nullable=False, default="waiting", server_default="waiting")
    ready_at = Column(DateTime(timezone=True), nullable=True)
    ready_by = Column(String(200), nullable=True)
    #: A manager marked it ready before every required task was: why.
    override_reason = Column(String(200), nullable=True)
    handed_over_at = Column(DateTime(timezone=True), nullable=True)
    handed_over_by = Column(String(200), nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KitchenAction(Base):
    __tablename__ = "kds_actions"
    __table_args__ = (Index("ix_kds_actions_shop", "shop_id", "created_at"),)

    #: The screen's idempotency key.
    id = Column(String(64), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    device_id = Column(UUID(as_uuid=True), nullable=True)
    type = Column(String(24), nullable=False)
    target_id = Column(String(64), nullable=True)
    actor_name = Column(String(200), nullable=True)
    reason = Column(String(200), nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=True)
    #: applied | noop | rejected
    outcome = Column(String(12), nullable=False, default="applied")
    result = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
