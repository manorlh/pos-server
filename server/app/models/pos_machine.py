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
    CheckConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.sunmi import SUNMI_MODEL_IDS, SUNMI_MODELS, detect_sunmi, sunmi_model
from app.models.synqpay_devices import SYNQPAY_DEVICE_MODEL_IDS, detect_synqpay
from app.models.vendor_devices import (
    VENDOR_DEVICE_MODEL_IDS,
    detect_vendor_device,
    machine_has_builtin_terminal,
    vendor_device_model,
)


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
# "סוג מכשיר" (docs/SPEC_DEVICE_ROLE_MODEL.md): hardware the till has no printer / drawer
# driver for yet — a LANDI terminal and a Feitian tablet (their vendors' SDKs are not in
# the app) — and a plain Android tablet, which has neither by definition. None of the
# three prints on a head of its own or charges on a terminal of its own; they print on a
# shop receipt printer and charge on a network pinpad / Z-Credit, like a P18.
DEVICE_MODEL_LANDI = "LANDI"
DEVICE_MODEL_FEITIAN_TABLET = "FEITIAN_TABLET"
DEVICE_MODEL_GENERIC_ANDROID = "GENERIC_ANDROID"
DEVICE_MODELS = (
    DEVICE_MODEL_N55F,
    DEVICE_MODEL_MODO,
    DEVICE_MODEL_P18,
    DEVICE_MODEL_LANDI,
    DEVICE_MODEL_FEITIAN_TABLET,
    DEVICE_MODEL_GENERIC_ANDROID,
    # SUNMI (docs/SPEC_SUNMI.md, app/models/sunmi.py): handhelds, desktops, the K2 kiosk.
    *SUNMI_MODEL_IDS,
    # SynqPay terminals the till runs on (docs/SPEC_SYNQPAY.md §1.5, app/models/synqpay_devices.py):
    # a terminal of their own, like the F20.
    *SYNQPAY_DEVICE_MODEL_IDS,
    # PAX A77 / Urovo i9100 (Android 8.1, app/models/vendor_devices.py): Agamento / TC as their
    # terminal, like the F20; their printer through the vendor's API.
    *VENDOR_DEVICE_MODEL_IDS,
)

_NO_PRINTER_MODELS = frozenset({
    DEVICE_MODEL_MODO,
    DEVICE_MODEL_P18,
    DEVICE_MODEL_LANDI,
    DEVICE_MODEL_FEITIAN_TABLET,
    DEVICE_MODEL_GENERIC_ANDROID,
    *(m.id for m in SUNMI_MODELS if not m.printer),
    # SynqPay's printer API (PAL) is in its SDK only, not in the app: no till receipts there yet.
    *SYNQPAY_DEVICE_MODEL_IDS,
})

#: Models whose built-in printer / cash drawer the till cannot drive *yet*: the hardware
#: has them, the vendor SDK has not been obtained. The dashboard says "בקרוב"; nothing
#: claims they print.
_DRIVER_PENDING_MODELS = frozenset({DEVICE_MODEL_LANDI, DEVICE_MODEL_FEITIAN_TABLET, *SYNQPAY_DEVICE_MODEL_IDS})

#: Models with a cash drawer port the till drives itself: the SUNMI desktops (T1/T2/T2s/T3,
#: D2/D2s/D3 — the print service's drawer API, docs/SPEC_SUNMI.md). The F20 / Nova 55F has
#: no drawer port (`FtReceiptPrinter.hasCashDrawer` is false); elsewhere a drawer opens
#: through an external receipt printer's RJ-11 port (its `cashDrawer` flag).
_CASH_DRAWER_PORT_MODELS: frozenset = frozenset(m.id for m in SUNMI_MODELS if m.drawer_port)

#: What a till reports as its model (Android's `Build.MODEL`, `device_info["model"]`),
#: lower-cased, for the hardware it tells apart on its own. The 55F and the Modo are not
#: here: the units met so far do not report a model that names them.
_REPORTED_MODELS = {
    "nebullar p18": DEVICE_MODEL_P18,
    "p18": DEVICE_MODEL_P18,
}

#: What a till reports as its maker (`Build.MANUFACTURER`, `device_info["manufacturer"]`),
#: lower-cased, when the maker alone names the model. Not Feitian: the F20 and a Feitian
#: tablet report the same maker.
_REPORTED_MANUFACTURERS = {
    "landi": DEVICE_MODEL_LANDI,
}


def device_has_printer(device_model) -> bool:
    """Whether a till of this model prints: a 55F, or a till whose model is unknown."""
    return device_model not in _NO_PRINTER_MODELS


#: Models with no card terminal of their own. A P18 has a secure payment chip, but it is
#: Kozen's and the till does not drive it, so a P18 always charges on an external Nayax
#: pinpad on the network (app/services/payment_terminal.py). A Modo has no printer, but it
#: does have Agamento.
_NO_BUILTIN_TERMINAL_MODELS = frozenset({
    DEVICE_MODEL_P18,
    DEVICE_MODEL_LANDI,
    DEVICE_MODEL_FEITIAN_TABLET,
    DEVICE_MODEL_GENERIC_ANDROID,
    # Every SUNMI: no Agamento on it. The P-series' own EMV reader is SUNMI's PayHardware,
    # which the till does not drive — it charges on a network pinpad / Z-Credit.
    *SUNMI_MODEL_IDS,
})


def device_has_builtin_terminal(device_model) -> bool:
    """
    Whether a till of this model charges cards on its own terminal (Agamento on the
    device): a 55F, a Modo, or a till whose model is unknown. A P18 does not, nor do the
    LANDI, the Feitian tablet and a generic tablet.
    """
    return device_model not in _NO_BUILTIN_TERMINAL_MODELS


def device_has_cash_drawer_port(device_model) -> bool:
    """Whether a till of this model opens a drawer on a port of its own (the SUNMI desktops)."""
    return device_model in _CASH_DRAWER_PORT_MODELS


def device_paper_width_mm(device_model) -> "int | None":
    """
    The paper a model's own head takes: 58 for a 55F (and a till whose model is unknown),
    the SUNMI table's width for a SUNMI; None without a head (or a SUNMI the table does not
    know — its print service says). The till prints at what its print service reports.
    """
    sunmi = sunmi_model(device_model)
    if sunmi is not None:
        return sunmi.paper_mm
    return 58 if device_has_printer(device_model) else None


def device_has_builtin_scanner(device_model) -> bool:
    """A scan head of its own (SUNMI V2 PRO, V2s PLUS, V3, L2, K2; Urovo i9100) — not the camera."""
    vendor = vendor_device_model(device_model)
    if vendor is not None:
        return vendor.scanner
    sunmi = sunmi_model(device_model)
    return bool(sunmi and sunmi.scanner)


def device_driver_pending(device_model) -> bool:
    """A LANDI or a Feitian tablet: built-in printer / drawer support is "בקרוב"."""
    return device_model in _DRIVER_PENDING_MODELS


def device_capabilities(device_model, *, kiosk: bool = False) -> dict:
    """
    The capability flags of a model, as the dashboard and the spec's table show them. A
    kiosk has no built-in terminal whatever the model: it charges on an external pinpad.
    """
    return {
        "builtinPrinter": device_has_printer(device_model),
        "builtinTerminal": device_has_builtin_terminal(device_model) and not kiosk,
        "cashDrawerPort": device_has_cash_drawer_port(device_model),
        "driverPending": device_driver_pending(device_model),
        "paperWidthMm": device_paper_width_mm(device_model),
        "builtinScanner": device_has_builtin_scanner(device_model),
    }


#: Where `POSMachine.is_kiosk` keeps its answer on the instance (not a column).
_KIOSK_CACHE = "_is_kiosk_cached"


def set_kiosk_cache(machine, is_kiosk: "bool | None") -> None:
    """Tell a machine instance whether it is a kiosk (None: look it up again when asked)."""
    if isinstance(machine, POSMachine):
        if is_kiosk is None:
            machine.__dict__.pop(_KIOSK_CACHE, None)
        else:
            machine.__dict__[_KIOSK_CACHE] = bool(is_kiosk)


def _normalized(value) -> "str | None":
    return " ".join(value.split()).lower() if isinstance(value, str) else None


def detect_device_model(device_info) -> "str | None":
    """
    The model a till names itself at pairing (`device_info["model"]`, else its maker
    `device_info["manufacturer"]`), when it is one we recognise — so a Nebullar P18 is a
    P18 without anyone choosing it. None otherwise.
    """
    if not isinstance(device_info, dict):
        return None
    # A SynqPay terminal says so (its payment app is installed), then which one by its model
    # (app/models/synqpay_devices.py): a terminal of its own, like the F20.
    synqpay = detect_synqpay(device_info)
    if synqpay is not None:
        return synqpay
    # A SUNMI names itself by its maker (or brand) and its model (app/models/sunmi.py); a
    # SUNMI the table does not know is the generic "SUNMI".
    sunmi = detect_sunmi(device_info)
    if sunmi is not None:
        return sunmi
    # A PAX A77 / Urovo i9100 by its maker (or brand) and model (app/models/vendor_devices.py).
    vendor = detect_vendor_device(device_info)
    if vendor is not None:
        return vendor
    by_model = _REPORTED_MODELS.get(_normalized(device_info.get("model")) or "")
    if by_model is not None:
        return by_model
    return _REPORTED_MANUFACTURERS.get(_normalized(device_info.get("manufacturer")) or "")


class POSMachine(Base):
    __tablename__ = "pos_machines"
    __table_args__ = (
        # A plain unique constraint is already "where both are non-null" in Postgres:
        # NULLs compare distinct, so any number of shopless or unnumbered machines
        # coexist, while two tills in one shop can never both be "register 2".
        UniqueConstraint("shop_id", "pos_number", name="uq_pos_machines_shop_pos_number"),
        # "קופה עצמאית" (docs/SPEC_INDEPENDENT_TILL.md): an independent till makes its own Z,
        # never the shop's — so a till can never be both in the shop Z and independent.
        CheckConstraint(
            "NOT independent_till OR z_mode = 'till'", name="ck_pos_machines_independent_till_mode"
        ),
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
    #: "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): what this till's document numbers
    #: are printed and exported under — `20000057`. Digits only, 1–3 characters. Null means
    #: the default, the register number (`effective_document_prefix`). Unique among the
    #: tills of its whole business — every branch (`app.services.document_prefix`) — and given up with the
    #: shop like the register number. Every document freezes the prefix it was issued
    #: with (`transactions.document_prefix`), so a change here never rewrites history.
    document_prefix = Column(String(3), nullable=True)
    mqtt_client_id = Column(String(255), unique=True, nullable=True)
    pairing_status = Column(SQLEnum(PairingStatus, values_callable=lambda x: [e.value for e in x]), nullable=False, default=PairingStatus.UNPAIRED)
    device_info = Column(JSON, nullable=True)
    #: One of `DEVICE_MODELS`, chosen on the dashboard; null = unknown, read as a 55F. The
    #: till learns whether it has a printer from `GET /machines/me`. At pairing the model
    #: the device names itself (`detect_device_model`) wins over the chosen one.
    device_model = Column(String(16), nullable=True)
    #: The model the dashboard chose — on the pairing code, or later on the machine page —
    #: kept beside `device_model` so the machine page can warn when the hardware said
    #: otherwise (docs/SPEC_DEVICE_ROLE_MODEL.md §4). Null: never chosen.
    device_model_chosen = Column(String(16), nullable=True)
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
    # Indexed for the device search's "last seen" and "app version" (app/services/device_identity.py).
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True, index=True)
    mqtt_connected = Column(Boolean, nullable=True)
    app_version = Column(String(64), nullable=True, index=True)
    last_sync_at = Column(DateTime(timezone=True), nullable=True)

    # ── Device identity and health ────────────────────────────────────────────
    # First-class columns rather than keys inside `device_info`, because these are
    # the things a distributor sorts and filters a fleet by: "which tills are
    # running flat", "which till has a drifting clock", "which physical box is
    # standing on that counter". None of that is answerable from a JSON blob.

    # The terminal's hardware serial, e.g. "F2003183A700217". Indexed: support
    # gets handed a serial off the back of a unit and needs the machine row.
    serial_number = Column(String(64), nullable=True, index=True)

    # ── Device identity for the cloud's device search (app/services/device_identity.py) ──
    #: Where `serial_number` came from: "ftpos" | "sunmi" | "build" | "ro.serialno" — the
    #: vendor SDK, Android's own serial, or the system property. Null: not said.
    serial_source = Column(String(32), nullable=True)
    #: The heartbeat's `cellular` block as last sent (SIMs, default data SIM, data path, LAN
    #: address, phone numbers where the till may read them), and when.
    cellular = Column(JSONB, nullable=True)
    cellular_reported_at = Column(DateTime(timezone=True), nullable=True)
    #: Flattened from `cellular` for the search: "פרטנר,סלקום" and "0541234567,0521234567".
    sim_carriers = Column(String(200), nullable=True, index=True)
    phone_numbers = Column(String(200), nullable=True, index=True)
    #: The address the last heartbeat came from, as the cloud saw it; the device's own LAN one.
    last_ip = Column(String(64), nullable=True, index=True)
    lan_ip = Column(String(64), nullable=True, index=True)

    # ── Device owner and silent updates (app/services/device_management.py) ──
    #: The heartbeat's `deviceManagement` block as last sent, cleaned: whether the app is the
    #: device owner, which path its updates take (device_owner / self_update / urovo / pax —
    #: silent; tap — someone confirms on screen), how its kiosk lock holds, and a technician's
    #: release of the device owner. Null: the till has said nothing (an older build).
    device_management = Column(JSONB, nullable=True)
    device_management_reported_at = Column(DateTime(timezone=True), nullable=True)
    #: The dashboard's "הפעל מחדש" for a device-owner till, while it waits and as it ended:
    #: {id, status, requestedAt, requestedBy, updatedAt, reason}. Handed over on the heartbeat.
    reboot_request = Column(JSONB, nullable=True)

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
    # ── Zs the till closed with no connection, as its heartbeat says ─────────
    # (docs/SPEC_OFFLINE_TILL_Z.md §4.4) How many it holds not uploaded yet, and whether
    # one is held in a conflict. While either says so — or the till may close offline and
    # is not seen — nothing in the cloud makes, numbers or switches its Z. NULL: never said.
    offline_till_z_pending = Column(Integer, nullable=True)
    offline_till_z_conflict = Column(Boolean, nullable=False, default=False, server_default="false")
    offline_till_z_reported_at = Column(DateTime(timezone=True), nullable=True)
    #: The last number of its own Z run the till reported (`offlineTillZ.lastNumber`).
    offline_till_z_last_number = Column(Integer, nullable=True)
    # ── Support produced this till's Z from the cloud (offline till Z spec §4.6) ──
    # A till destroyed, lost or permanently broken: its shifts closed and its Z made from
    # what the cloud holds, by support. `support_z`: who, when, why, the basis, the Z and
    # the numbers skipped; the till, if it ever comes back, is told and makes nothing for
    # that period. NULL: never.
    support_z = Column(JSONB, nullable=True)
    support_z_at = Column(DateTime(timezone=True), nullable=True)
    # The till's per-series document counters ({"320": n, "330": n, "400": n}) as its
    # heartbeat last said — a replacement device starts each series after them.
    reported_document_counters = Column(JSONB, nullable=True)
    document_counters_reported_at = Column(DateTime(timezone=True), nullable=True)
    # ── A reset of the till's data, ordered from the cloud by support (§4.7) ──
    # The till has no reset of its own: support orders one, the till carries it out under
    # its guards and reports. The last command — kind, reason, who, when, status
    # (pending / done / refused / failed / expired) and the till's report. NULL: never.
    till_reset = Column(JSONB, nullable=True)
    # ── "הוחלפה קופה" (offline till Z spec §4.6.2) ────────────────────────────
    # Every replacement of the till, oldest first: the old and the new device, who, when,
    # why, and whether support produced its Z first. And the last one, until the till's
    # next Z says it ("המכשיר הוחלף בתאריך …"). NULL: never replaced / already said.
    replacements = Column(JSONB, nullable=True)
    replacement_note_pending = Column(JSONB, nullable=True)
    # ── Re-paired as a new machine (docs/SHIFTS_API.md §1.2c-bis) ──────────────
    #: The machine this same device was before it redeemed an ordinary pairing code as a
    #: new machine (matched by its serial at pairing). What the device still delivers that
    #: it issued as that machine is filed under it — its tenant, shop and shift.
    predecessor_machine_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: What the predecessor still owed when the device was re-paired: its open shift, the
    #: documents it last reported unsent, its counters (app/services/document_filing.py).
    repair_handover = Column(JSONB, nullable=True)
    #: Corrections to documents already in a Z (a re-push with other fiscal content),
    #: waiting for this till's next Z, which carries each as an adjustment (§1.2-amended).
    pending_z_adjustments = Column(JSONB, nullable=True)
    #: Every change of `z_mode` (who produces the till's Z), oldest first: `[{at, from, to}]`.
    #: A document goes to the Z kind its till was in when it was issued — a later switch
    #: never moves it (`document_filing.mode_at`). NULL: never switched since this was kept.
    z_mode_history = Column(JSONB, nullable=True)
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
    #: "עקיפת בדיקת מספר מסוף" as the till applies it, from its heartbeat
    #: (`terminalNumberCheckBypass`, app/services/terminal_check_bypass.py). Null: never said.
    terminal_number_check_bypass_reported = Column(Boolean, nullable=True)
    # ── Who produces this till's Z (docs/SHIFTS_API.md §5.1) ──────────────────
    # "cloud": the shop's Z run builds it, numbered in the shop's run — the default, and
    # every till's behaviour before this column existed. "till": the till asks for its
    # own Z (`POST /sync/{id}/till-z`), numbered per till (`machine_z_sequences`), and no
    # cloud Z ever takes its shifts. Changed only through `app.services.till_z.set_z_mode`,
    # which refuses a switch while shifts are waiting for a Z of the old mode.
    z_mode = Column(String(8), nullable=False, default="cloud", server_default="cloud")
    # ── "קופה עצמאית בתוך סניף" (docs/SPEC_INDEPENDENT_TILL.md) ─────────────────
    # A till of the shop that is not part of the shop: its own Z (`z_mode` "till", by the
    # check above), never listed or waited for by the shop Z, and outside the shop's LAN
    # group — never the main till, tables host or print server, never using them; its
    # tables off unless set at its own level. Changed only through
    # `app.services.independent_till.set_independent` (super admin, over a clean break).
    independent_till = Column(Boolean, nullable=False, default=False, server_default="false")
    # ── "מכשיר תצוגה" (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2) ─────────────────────
    #: False for a display device — a KDS kitchen screen or the "מוכן / לא מוכן" board,
    #: added as one on the dashboard. The owner: such a device is NOT a till and not an
    #: accounting system — no register number, no document prefix, no shifts, no Z, no
    #: cash, no payments, no documents; never a shop Z participant, the main till or a host
    #: (app/services/display_devices.py). Enforced on every fiscal till endpoint
    #: (`require_fiscal_machine`, 403 `device_not_fiscal`). Set at pairing only — a change
    #: between a till and a display device is a new pairing.
    is_fiscal = Column(Boolean, nullable=False, default=True, server_default="true", index=True)
    #: "android" | "windows": what the device runs, from `device_info.platform` at pairing.
    #: Null: a device paired before the column — Android.
    platform = Column(String(16), nullable=True)
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
    def effective_document_prefix(self):
        """The prefix this till issues documents under now: its own, else its register number."""
        from app.services.document_prefix import effective_prefix

        return effective_prefix(self)

    @property
    def has_printer(self) -> bool:
        return device_has_printer(self.device_model)

    @property
    def has_builtin_terminal(self) -> bool:
        # "מכשירי הסליקה הם חיצוניים" (docs/SPEC_DEVICE_ROLE_MODEL.md): a kiosk charges on an
        # external pinpad on the network whatever its model, never on a built-in terminal —
        # so `machines/me`, the payment integration and the pinpad warning all read it so.
        # A PAX A77 / Urovo i9100 has Agamento's terminal only if the till found Agamento on it
        # when it paired (app/models/vendor_devices.py), as an F20 does.
        vendor = machine_has_builtin_terminal(self.device_model, self.device_info)
        if vendor is not None:
            return vendor and not self.is_kiosk
        return device_has_builtin_terminal(self.device_model) and not self.is_kiosk

    @property
    def is_kiosk(self) -> bool:
        """
        Whether this till is a self-order kiosk (a `kiosk_devices` row). Looked up once per
        instance and kept; `set_kiosk_cache` primes it for a list (one query for all) and
        corrects it when the role changes. No session: not a kiosk.
        """
        cached = self.__dict__.get(_KIOSK_CACHE)
        if cached is not None:
            return cached
        from sqlalchemy.orm import object_session

        found = False
        session = object_session(self)
        if session is not None and self.id is not None:
            from app.models.kiosk import KioskDevice

            with session.no_autoflush:
                found = session.get(KioskDevice, self.id) is not None
        self.__dict__[_KIOSK_CACHE] = found
        return found

    @property
    def has_cash_drawer_port(self) -> bool:
        return device_has_cash_drawer_port(self.device_model)

    @property
    def device_driver_pending(self) -> bool:
        return device_driver_pending(self.device_model)

    @property
    def device_model_reported(self) -> "str | None":
        """The model the device named itself when it paired, if we recognise it."""
        return detect_device_model(self.device_info)
