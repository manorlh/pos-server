import uuid
import enum

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
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

# Values the till may report for `printer_status` (the heartbeat's `printer` block). The
# same rule as the battery: an unexpected string is stored as "unknown", never a 422.
PRINTER_STATUSES = ("ok", "no_paper", "overheated", "error", "unavailable", "unknown")

# The hardware a till is, as the dashboard records it. A Nova 55F has a built-in printer;
# a Modo has none. A Nebullar P18 (Kozen) is a tablet: its printer speaks Kozen's own SDK,
# which the till does not drive yet, so it does not print either. NULL is "not recorded"
# and reads as a 55F, which every till that existed before the column was.
DEVICE_MODEL_N55F = "N55F"
DEVICE_MODEL_MODO = "MODO"
DEVICE_MODEL_P18 = "P18"
DEVICE_MODELS = (DEVICE_MODEL_N55F, DEVICE_MODEL_MODO, DEVICE_MODEL_P18)

_NO_PRINTER_MODELS = frozenset({DEVICE_MODEL_MODO, DEVICE_MODEL_P18})

#: What a till reports as its model (Android's `Build.MODEL`, `device_info["model"]`),
#: lower-cased, for the hardware it tells apart on its own. The 55F and the Modo are not
#: here: the units met so far do not report a model that names them.
_REPORTED_MODELS = {
    "nebullar p18": DEVICE_MODEL_P18,
    "p18": DEVICE_MODEL_P18,
}


def device_has_printer(device_model) -> bool:
    """Whether a till of this model prints: a 55F, or a till whose model is unknown."""
    return device_model not in _NO_PRINTER_MODELS


#: Models with no card terminal of their own. A P18 has a secure payment chip, but it is
#: Kozen's and the till does not drive it, so a P18 always charges on an external Nayax
#: pinpad on the network (app/services/payment_terminal.py). A Modo has no printer, but it
#: does have Agamento.
_NO_BUILTIN_TERMINAL_MODELS = frozenset({DEVICE_MODEL_P18})


def device_has_builtin_terminal(device_model) -> bool:
    """
    Whether a till of this model charges cards on its own terminal (Agamento on the
    device): a 55F, a Modo, or a till whose model is unknown. A P18 does not.
    """
    return device_model not in _NO_BUILTIN_TERMINAL_MODELS


def detect_device_model(device_info) -> "str | None":
    """
    The model a till names itself at pairing (`device_info["model"]`), when it is one we
    recognise — so a Nebullar P18 is a P18 without anyone choosing it. None otherwise.
    """
    if not isinstance(device_info, dict):
        return None
    reported = device_info.get("model")
    if not isinstance(reported, str):
        return None
    return _REPORTED_MODELS.get(" ".join(reported.split()).lower())


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
    #: The area of its shop this till stands in (bar, kitchen…), or none. Always an area
    #: of the *current* `shop_id`: `set_machine_shop` clears it whenever the shop changes,
    #: the way it gives up the register number. Shifts copy it when they open
    #: (`shifts.area_id`); reports read that stamp, never this column, so moving a till
    #: never rewrites what an area took.
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id"), nullable=True, index=True)
    #: When `area_id` last changed. The till's settings watermark includes it, so a till
    #: moved between areas sees its new area on its next delta settings pull. Its own
    #: column rather than `updated_at`, which every heartbeat moves.
    area_changed_at = Column(DateTime(timezone=True), nullable=True)
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
    #: "N55F" | "MODO" (`DEVICE_MODELS`), chosen on the dashboard; null = unknown, read
    #: as a 55F. The till learns whether it has a printer from `GET /machines/me`.
    device_model = Column(String(16), nullable=True)
    #: "לקוח קבוע / זמני" for this till alone — a till lent for an event in a permanent
    #: shop. The earliest end among the till, its shop, companies and organization wins
    #: (app/services/licenses.py). Set by a super admin only.
    license_type = Column(String(16), nullable=False, default="permanent", server_default="permanent")
    license_expires_on = Column(Date, nullable=True)
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

    # ── POS settings for this one till ────────────────────────────────────────
    # The last layer of tenant → company → shop → till (`settings_merge`): the same
    # keys, so a till can ask for a tip where the rest of its shop does not, or offer
    # different percentages at the bar than at the counter. Empty for almost every till.
    # `settings_updated_at` NULL means never written — every till that existed when the
    # column was added — so the settings watermark does not move for them.
    settings = Column(JSONB, nullable=False, default=dict, server_default="{}")
    settings_updated_at = Column(DateTime(timezone=True), nullable=True)

    # ── The shift the till says it has open, from its heartbeat ──────────────
    # The cloud learns of a shift from the till's open event, which an offline till
    # queues. This is the till's own claim, refreshed every beat, so the Z wizard can
    # tell "no shift open" from "a shift is open that the cloud has not heard of yet".
    # Not an identity and not a foreign key: the shift may not exist here yet.
    reported_open_shift_id = Column(UUID(as_uuid=True), nullable=True)
    reported_open_shift_opened_at = Column(DateTime(timezone=True), nullable=True)
    #: The shop's master till has "סגירת Z סניפי" on screen until then (refreshed while it
    #: is open). Meanwhile the heartbeat tells every till of the shop to beat fast, so the
    #: close a shop Z sends is picked up in seconds even when realtime is down.
    shop_z_screen_until = Column(DateTime(timezone=True), nullable=True)

    # ── Card transmission, as the till last reported it (docs/SHIFTS_API.md §4.2) ─
    # A snapshot from the heartbeat's `transmission` block, replaced whole whenever a beat
    # carries one; `transmission_reported_at` says how old it is. Like the backlog above,
    # a last-known reading: the dashboard shows it "as of", and our own records of which
    # card legs went out (`transaction_payments.transmission_id`) sit beside it.
    transmission_pending_count = Column(Integer, nullable=True)
    transmission_pending_amount = Column(Numeric(12, 2), nullable=True)
    #: Card sales in a successful batch that the terminal did not name by uid (an id
    #: format the till could not match), which the till *assumes* went out. Information
    #: only: not verified, never a flag.
    transmission_assumed_count = Column(Integer, nullable=True)
    transmission_oldest_pending_at = Column(DateTime(timezone=True), nullable=True)
    transmission_last_success_at = Column(DateTime(timezone=True), nullable=True)
    transmission_last_attempt_at = Column(DateTime(timezone=True), nullable=True)
    transmission_last_error = Column(String(500), nullable=True)
    transmission_source = Column(String(32), nullable=True)
    transmission_reported_at = Column(DateTime(timezone=True), nullable=True)
    #: The first time this till said anything about transmissions. Card legs of documents
    #: from before it are never "untransmitted": the feature did not exist when they were
    #: sold. Cleared when a replacement device adopts the till, which starts it again.
    transmission_tracking_started_at = Column(DateTime(timezone=True), nullable=True)

    # ── The built-in printer, as the till last reported it ────────────────────
    # A snapshot from the heartbeat's `printer` block, replaced whole whenever a beat
    # carries one. `printer_status_at` is when the till observed it (its clock);
    # `printer_reported_at` is when we received it (ours) — a till offline since then
    # leaves a reading the dashboard must show "as of", not as live.
    printer_status = Column(String(16), nullable=True)
    #: The vendor's code (115 no paper, 116 overheated, 120 error, 132/133 black mark).
    printer_error_code = Column(Integer, nullable=True)
    printer_message = Column(String(200), nullable=True)
    printer_status_at = Column(DateTime(timezone=True), nullable=True)
    printer_last_ok_at = Column(DateTime(timezone=True), nullable=True)
    printer_reported_at = Column(DateTime(timezone=True), nullable=True)

    # ── The card terminal (Agamento), as the till last reported it ────────────
    # From the heartbeat's `terminal` block; a beat without one leaves these alone.
    # `terminal_reported_at` is when we received it — null = the till never reported.
    terminal_number = Column(String(20), nullable=True)
    #: "SHVA" or "PELECARD" as the terminal reports it.
    terminal_clearing_server = Column(String(16), nullable=True)
    terminal_offline_mode = Column(Boolean, nullable=True)
    terminal_reported_at = Column(DateTime(timezone=True), nullable=True)
    #: The till's last write into Agamento (`forceTerminalNumber`, `clearingServer`):
    #: {field, value, ok, error, at}. Kept until the till reports a newer one.
    terminal_last_write = Column(JSONB, nullable=True)
    #: The business name and supplier number (מספר ספק) the terminal is set up under, as
    #: Agamento names them. Kept once seen: a reply that omits them does not clear them.
    terminal_merchant_name = Column(String(120), nullable=True)
    terminal_supplier_number = Column(String(30), nullable=True)
    # ── Who produces this till's Z (docs/SHIFTS_API.md §5.1) ──────────────────
    # "cloud": the shop's Z run builds it, numbered in the shop's run — the default, and
    # every till's behaviour before this column existed. "till": the till asks for its
    # own Z (`POST /sync/{id}/till-z`), numbered per till (`machine_z_sequences`), and no
    # cloud Z ever takes its shifts. Changed only through `app.services.till_z.set_z_mode`,
    # which refuses a switch while shifts are waiting for a Z of the old mode.
    z_mode = Column(String(8), nullable=False, default="cloud", server_default="cloud")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop", back_populates="machines")
    area = relationship("ShopArea")
    distributor = relationship("User", foreign_keys=[distributor_id])
    products = relationship("Product", back_populates="pos_machine")
    categories = relationship("Category", back_populates="pos_machine")

    @property
    def area_name(self):
        """The current area's name, for responses built straight from the row."""
        return self.area.name if self.area is not None else None

    @property
    def has_printer(self) -> bool:
        return device_has_printer(self.device_model)

    @property
    def has_builtin_terminal(self) -> bool:
        return device_has_builtin_terminal(self.device_model)
