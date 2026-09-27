import uuid
import enum

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    Integer,
    JSON,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PairingStatus(str, enum.Enum):
    UNPAIRED = "unpaired"
    PAIRED = "paired"
    ASSIGNED = "assigned"


# Values the till may report for `battery_status`. Anything else is stored as
# "unknown" rather than rejected: a heartbeat carrying an unexpected string is
# still a live terminal saying hello, and dropping it would take the machine
# offline on the dashboard for a reason that has nothing to do with the machine.
BATTERY_STATUSES = ("charging", "discharging", "full", "not_charging", "unknown")


class POSMachine(Base):
    __tablename__ = "pos_machines"
    __table_args__ = (
        # A plain unique constraint is already "where both are non-null" in Postgres:
        # NULLs compare distinct, so any number of shopless or unnumbered machines
        # coexist, while two tills in one shop can never both be "register 2".
        UniqueConstraint("shop_id", "pos_number", name="uq_pos_machines_shop_pos_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    pairing_session_id = Column(UUID(as_uuid=True), ForeignKey("pairing_sessions.id"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    machine_code = Column(String(100), unique=True, nullable=False, index=True)
    #: Register number as the *business* numbers its registers — till 1, 2, 3 in a
    #: branch. Distinct from `machine_code`, which is a pairing identifier this system
    #: generated and which means nothing to a bookkeeper.
    #:
    #: Allocated from the shop's `shop_register_sequences` counter whenever the machine
    #: gets a shop (`app.services.register_number`), so it is never reused within a
    #: shop and always belongs to the *current* `shop_id`: a machine that changes shop
    #: gives its number up and draws the new shop's next one. Null exactly when there
    #: is no shop. Stored as text because `transactions.pos_number` is text and a
    #: document copies it verbatim; documents fall back to `machine_code` when null.
    pos_number = Column(String(50), nullable=True)
    mqtt_client_id = Column(String(255), unique=True, nullable=True)
    pairing_status = Column(SQLEnum(PairingStatus, values_callable=lambda x: [e.value for e in x]), nullable=False, default=PairingStatus.UNPAIRED)
    device_info = Column(JSON, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)

    # Bumped whenever this terminal is unpaired. Machine tokens carry the version
    # they were minted at, so revoking is permanent: a machine that is later
    # re-paired gets a new version, and every token issued before it stays dead
    # even though the row is active again.
    #
    # Existing tokens in the field carry no version claim at all. Those are read as
    # version 1 — the default — so nothing that is paired today stops working.
    token_version = Column(Integer, default=1, nullable=False, server_default="1")
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True)
    mqtt_connected = Column(Boolean, nullable=True)
    app_version = Column(String(64), nullable=True)
    last_sync_at = Column(DateTime(timezone=True), nullable=True)

    # ── Device identity and health ────────────────────────────────────────────
    # First-class columns rather than keys inside `device_info`, because these are
    # the things a distributor sorts and filters a fleet by: "which tills are
    # running flat", "which till has a drifting clock", "which physical box is
    # standing on that counter". None of that is answerable from a JSON blob.

    # The terminal's hardware serial, e.g. "F2003183A700217". Indexed: support
    # gets handed a serial off the back of a unit and needs the machine row.
    serial_number = Column(String(64), nullable=True, index=True)

    # NULL means the device could not read the battery, which is NOT 0. Never
    # coerce one into the other — "unknown charge" and "about to die" call for
    # opposite reactions from whoever is watching the fleet.
    battery_percent = Column(SmallInteger, nullable=True)
    battery_status = Column(String(16), nullable=True)

    # Outbox depth as the terminal last reported it, with the moment it said so.
    #
    # Stored, unlike before, because the dashboard's status light needs it. The earlier
    # reasoning — that it is stale the moment it lands — is still correct and is exactly
    # why `pending_count_at` sits beside it: this is a last-known reading, like the
    # battery percentage, and the UI must say "as of HH:MM" rather than present it as
    # live. It must never gate a close: that check reads the real documents.
    #
    # `pending_documents` counts undelivered *sales* only. `pending_count` is the whole
    # outbox, which also carries trading-day rows and close-day acknowledgements — a
    # till stuck on one acknowledgement is not a till holding unsynced takings, and a
    # status light that cannot tell them apart cries wolf.
    pending_count = Column(Integer, nullable=True)
    pending_documents = Column(Integer, nullable=True)
    pending_count_at = Column(DateTime(timezone=True), nullable=True)

    # Device clock minus server clock, in milliseconds. SIGNED: negative means
    # the device is behind. BigInteger because a terminal that came up with an
    # unset clock is out by decades, which overflows a 32-bit int in ms.
    clock_skew_ms = Column(BigInteger, nullable=True)

    # When health was last actually reported. Distinct from last_heartbeat_at,
    # which an older till build bumps while sending none of the fields above —
    # without this there is no way to tell a fresh 4% reading from a stale one.
    last_health_report_at = Column(DateTime(timezone=True), nullable=True)

    # ── The till's own catalog ────────────────────────────────────────────────
    # "all": the shop's whole catalog — the default, and every till's behaviour before
    # this column existed. "selected": only the products on this till's whitelist
    # (`machine_catalog_items`) that are also in its shop's catalog. The rule lives in
    # `app/services/machine_catalog.py`; nothing else reads these two columns.
    #
    # `catalog_mode_updated_at` is stamped on every change of mode so the catalog
    # watermark moves when only the mode changed. NULL means "never changed", which is
    # every till that existed when the column was added.
    catalog_mode = Column(String(16), nullable=False, default="all", server_default="all")
    catalog_mode_updated_at = Column(DateTime(timezone=True), nullable=True)

    # ── The shift the till says it has open, from its heartbeat ──────────────
    # The cloud learns of a shift from the till's open event, which an offline till
    # queues. This is the till's own claim, refreshed every beat, so the Z wizard can
    # tell "no shift open" from "a shift is open that the cloud has not heard of yet".
    # Not an identity and not a foreign key: the shift may not exist here yet.
    reported_open_shift_id = Column(UUID(as_uuid=True), nullable=True)
    reported_open_shift_opened_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop", back_populates="machines")
    distributor = relationship("User", foreign_keys=[distributor_id])
    products = relationship("Product", back_populates="pos_machine")
    categories = relationship("Category", back_populates="pos_machine")
