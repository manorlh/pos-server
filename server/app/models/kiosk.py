"""
The R2M customer self-order KIOSK ("קיוסק הזמנה עצמית").

A kiosk is an ordinary paired till (`pos_machines`) that the dashboard converted. It keeps
everything a till has — shifts, Z, documents, the outbox, kitchen printing, its receipt
printer, branding, till parameters and the Android device lock (`kioskMode`, a different
thing: the lock-task mode of `system/KioskLock.kt`). These tables only add what the
self-order flow needs on top:

* `kiosk_settings` — the kiosk config as PARTIAL override layers: company → shop → machine.
  The effective config is DEFAULTS ⊕ company ⊕ shop ⊕ machine (app/services/kiosk_config.py).
  The overrides are camelCase JSON, exactly as on the wire.
* `kiosk_devices` — which tills are kiosks: name, enabled, pause state, the tills that may
  control it ("controllers"), and the kiosk's last reported status.
* `kiosk_orders` — one row per paid kiosk order, as the kiosk reported it. The snapshot
  (fulfillment mode, pickup number, service type, amounts…) never changes after the first
  insert; only the bon / receipt / order status does.
* `kiosk_pickup_counters` / `kiosk_pickup_allocations` — the shop-wide daily pickup
  sequence ("pickup.scope = shop"), idempotent per order key.
* `kiosk_commands` — the audit of pause / resume / close shift / till Z, from the
  dashboard or from a controlling till, with the outcome.
"""
import uuid

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: JSON on SQLite (the tests), JSONB on Postgres.
KioskJSON = JSON().with_variant(JSONB(), "postgresql")

KIOSK_SETTINGS_LEVELS = ("company", "shop", "machine")
KIOSK_COMMAND_ACTIONS = ("pause", "resume", "close_shift", "till_z")
KIOSK_COMMAND_SOURCES = ("dashboard", "till")
KIOSK_COMMAND_STATUSES = ("applied", "requested", "refused")


class KioskSettings(Base):
    """One partial override layer of the kiosk config. Exactly one of the ids is set."""

    __tablename__ = "kiosk_settings"
    __table_args__ = (
        UniqueConstraint("level", "company_id", "shop_id", "machine_id", name="uq_kiosk_settings_scope"),
        CheckConstraint("level IN ('company', 'shop', 'machine')", name="ck_kiosk_settings_level"),
        # NULLs compare distinct in the constraint above, so each level also gets its own
        # partial unique index: one row per company, per shop, per machine.
        Index(
            "uq_kiosk_settings_company", "company_id", unique=True,
            postgresql_where=text("level = 'company'"), sqlite_where=text("level = 'company'"),
        ),
        Index(
            "uq_kiosk_settings_shop", "shop_id", unique=True,
            postgresql_where=text("level = 'shop'"), sqlite_where=text("level = 'shop'"),
        ),
        Index(
            "uq_kiosk_settings_machine", "machine_id", unique=True,
            postgresql_where=text("level = 'machine'"), sqlite_where=text("level = 'machine'"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    level = Column(String(16), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True)
    #: The partial layer, camelCase as on the wire. `null` values are never stored.
    overrides = Column(KioskJSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class KioskDevice(Base):
    """A till converted into a self-order kiosk. Deleting the row makes it a regular till again."""

    __tablename__ = "kiosk_devices"

    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    #: Copies of the machine's shop and company when it was converted (refreshed on every
    #: kiosk sync). The machine row stays the authority.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(100), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    paused = Column(Boolean, nullable=False, default=False, server_default="false")
    pause_message = Column(String(300), nullable=True)
    paused_at = Column(DateTime(timezone=True), nullable=True)
    paused_by = Column(String(200), nullable=True)
    #: "נעילה למכירה" until when (null: until reopened by hand) and how it was asked
    #: ("manual" | "time" | "minutes" | "next_open") — docs/SPEC_KIOSK.md §15.
    paused_until = Column(DateTime(timezone=True), nullable=True)
    paused_mode = Column(String(20), nullable=True)
    #: The tills that may pause / resume / close this kiosk (same company, never itself,
    #: never another kiosk). A list of machine id strings.
    controller_machine_ids = Column(KioskJSON, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_kiosk_sync_at = Column(DateTime(timezone=True), nullable=True)
    #: The kiosk's last reported status (`POST /sync/{id}/kiosk/sync`), cleaned.
    status = Column(KioskJSON, nullable=True)
    applied_config_version = Column(String(32), nullable=True)


class KioskOrder(Base):
    """
    A paid kiosk order as the kiosk reported it. Upserted by (machine_id, local_id).

    Snapshot fields — everything but the four status columns — are written once, at the
    first insert, and never changed (a change of the kiosk's config applies to new orders
    only; spec §A "fulfillment_mode_snapshot").
    """

    __tablename__ = "kiosk_orders"
    __table_args__ = (
        UniqueConstraint("machine_id", "local_id", name="uq_kiosk_orders_machine_local"),
        Index("ix_kiosk_orders_machine_date", "machine_id", "business_date"),
        Index("ix_kiosk_orders_shop_date", "shop_id", "business_date"),
        # "תשלום בקופה": the shop's orders waiting at the tills.
        Index("ix_kiosk_orders_shop_open", "shop_id", "open_state"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    local_id = Column(String(64), nullable=False)
    transaction_id = Column(String(64), nullable=True)
    transaction_number = Column(String(64), nullable=True)
    pickup_number = Column(Integer, nullable=False)
    pickup_label = Column(String(32), nullable=False)
    business_date = Column(Date, nullable=False)
    service_type = Column(String(16), nullable=False)
    table_ref = Column(String(64), nullable=True)
    #: "BON" | "KDS" — the snapshot; never changed after the insert.
    fulfillment_mode = Column(String(8), nullable=False)
    config_version = Column(String(32), nullable=True)
    customer_name = Column(String(100), nullable=True)
    customer_phone = Column(String(32), nullable=True)
    item_count = Column(Integer, nullable=False, default=0)
    total_agorot = Column(BigInteger, nullable=False, default=0)
    tip_agorot = Column(BigInteger, nullable=False, default=0)
    #: Null while an order to pay at the till is open (`pay_at_till`).
    paid_at = Column(DateTime(timezone=True), nullable=True)
    bon_status = Column(String(16), nullable=False)
    bon_detail = Column(String(500), nullable=True)
    receipt_status = Column(String(16), nullable=False)
    status = Column(String(24), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # ── "תשלום בקופה" (docs/SPEC_KIOSK.md §23, app/services/kiosk_open_orders.py) ──────────
    # An order the customer chose to pay at the till: the kiosk wrote NO tax document for it.
    # It waits here, open, for one of the shop's tills — which locks it, takes the money with
    # its own document, and marks it paid (or cancels it with a reason). `paid_at` stays null
    # until then. A kiosk-paid order has `pay_at_till` false and `open_state` null.
    pay_at_till = Column(Boolean, nullable=False, default=False, server_default="false")
    #: open → paid | cancelled | expired.
    open_state = Column(String(16), nullable=True)
    #: What is left for the till to take (the order + its tip − the vouchers already applied).
    due_agorot = Column(BigInteger, nullable=True)
    voucher_agorot = Column(BigInteger, nullable=True)
    #: The order's lines as the tills list and print them: [{name, quantity, totalAgorot, notes}].
    lines = Column(KioskJSON, nullable=True)
    #: The kiosk's basket as the till rebuilds it (opaque here: the Android HeldSaleCodec form).
    cart = Column(KioskJSON, nullable=True)
    #: Prepaid vouchers redeemed on the kiosk towards this order, pending until it is paid:
    #: [{redemptionId, serial, amountAgorot, eventName, redeemed: [{productId, tillProductId, name, quantity}]}].
    vouchers = Column(KioskJSON, nullable=True)
    #: Not paid by then: expired (from the kiosk's `payment.cashAtTillExpiryMin`).
    expires_at = Column(DateTime(timezone=True), nullable=True)
    #: "בטיפול בקופה X": the till paying it now (a lock that goes stale on its own).
    locked_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    locked_by_name = Column(String(200), nullable=True)
    locked_at = Column(DateTime(timezone=True), nullable=True)
    paid_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    paid_by_name = Column(String(200), nullable=True)
    #: Paid, cancelled or expired: when, why (a cancel's reason; "expired"), by whom.
    closed_at = Column(DateTime(timezone=True), nullable=True)
    close_reason = Column(String(300), nullable=True)
    closed_by_name = Column(String(200), nullable=True)
    #: "שלח למטבח לפני תשלום": the kiosk already printed its bon — the till must not again.
    kitchen_sent = Column(Boolean, nullable=False, default=False, server_default="false")


class KioskPickupCounter(Base):
    """The shop's daily pickup sequence: the last number handed out that business day."""

    __tablename__ = "kiosk_pickup_counters"

    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), primary_key=True)
    business_date = Column(Date, primary_key=True)
    last_number = Column(Integer, nullable=False, default=0)


class KioskPickupAllocation(Base):
    """One number of the shop's daily sequence, by the kiosk's order key (idempotency)."""

    __tablename__ = "kiosk_pickup_allocations"
    __table_args__ = (
        UniqueConstraint("shop_id", "business_date", "order_key", name="uq_kiosk_pickup_allocations_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    business_date = Column(Date, nullable=False)
    order_key = Column(String(64), nullable=False)
    number = Column(Integer, nullable=False)
    label = Column(String(32), nullable=False)
    #: The kiosk that asked (information only).
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KioskCommand(Base):
    """The audit of one command to a kiosk, and what came of it."""

    __tablename__ = "kiosk_commands"
    __table_args__ = (
        CheckConstraint(
            "action IN ('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled', 'menu')",
            name="ck_kiosk_commands_action",
        ),
        CheckConstraint("source IN ('dashboard', 'till', 'schedule')", name="ck_kiosk_commands_source"),
        CheckConstraint("status IN ('applied', 'requested', 'refused')", name="ck_kiosk_commands_status"),
        Index("ix_kiosk_commands_kiosk_created", "kiosk_machine_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    kiosk_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    action = Column(String(16), nullable=False)
    message = Column(String(300), nullable=True)
    force = Column(Boolean, nullable=False, default=False, server_default="false")
    source = Column(String(16), nullable=False)
    requested_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requested_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    requested_by_name = Column(String(200), nullable=True)
    status = Column(String(16), nullable=False)
    #: The shift-close request's or till-Z request's id.
    request_id = Column(UUID(as_uuid=True), nullable=True)
    #: The refusal (`no_open_shift`, `machine_not_till_z`…) or a note.
    detail = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
