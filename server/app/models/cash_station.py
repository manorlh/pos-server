"""
"עמדת מזומן" — a PayLink cash unit for the self-order kiosks (P:/specs/cash-paylink.md §11, §12).

* `CashStation` — one PayLink unit ("עמדה"), by its USB serial (`serial`; '' = the box's default
  unit, `OpenSpecificMHE`), run by a cash host (`host_machine_id`, a `pos_machines.is_cash_host`
  box of the same shop). A host may run several; a station has its own queue, journal, float,
  drawer, Z and alerts. Kiosks pick one with the till parameter `cashStation` (many to one).
  `settings`: the station's own overrides of the §11.10 station parameters (lists and maps typed).
* `CashStationTx` — the cloud's copy of the host's journal (§11.9): one row per transaction
  (`tx_id`, made by the kiosk), the last version by `seq`, with its money in agorot and — when it
  ended with change owed to the customer or a credit held in the unit — the "owed" item a till pays
  out ("שולם ללקוח", §11.8) or the dashboard resolves.
* `CashStationMovement` — the station drawer's own movements: float, refill, collect, count, dump,
  adjust (§11.9), by their host-made id.
* `CashHostCommand` — what the dashboard asks a host to do at a station (refill, count, collect,
  dump, deliver_pending, float), delivered with `GET /sync/{host}/cash`, acknowledged once.
* `CashCreditRedemption` — stage 2 (§11.15א): a cash credit (change owed the customer kept for a next order, an
  owed item of kind `change_credit`) redeemed towards an order at a till or a kiosk, by the device's own id.

Amounts are integer agorot throughout, as on the LAN (§11 preamble).
"""
import uuid

from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

TX_STATES = ("LEASED", "ACCEPTING", "SETTLING", "PAYING_CHANGE", "PARTIAL", "REFUNDING", "DONE", "HELD")
FINAL_STATES = ("DONE", "HELD")
OUTCOMES = ("paid", "refunded", "nothing_inserted")
MOVEMENT_KINDS = ("float", "refill", "collect", "count", "dump", "adjust")
COMMAND_OPS = (
    "refill", "count", "collect", "dump", "deliver_pending", "float",
    # What the host also carries out, with no arguments: maintenance on / off (no kiosk is served meanwhile), its
    # alerts cleared, and a recycler's extended escrow returned / stacked.
    "maintenance_on", "maintenance_off", "reset_alerts", "ext_return", "ext_stack",
)
#: The ops that take no arguments (anything sent with them is dropped).
NO_ARG_OPS = ("deliver_pending", "maintenance_on", "maintenance_off", "reset_alerts", "ext_return", "ext_stack")
COMMAND_STATUSES = ("pending", "done", "refused", "failed")
#: `change_credit` (§11.15א): change owed the customer chose to keep as a credit for a next order — redeemed by its
#: code at a till or a kiosk, never paid out from a drawer.
OWED_KINDS = ("change_owed", "held_credit", "change_credit")
#: What the customer chose for change owed (§11.15א).
OWED_CHOICES = ("slip", "credit", "tip")
#: `cash_credit_redemptions.status`.
REDEMPTION_STATUSES = ("redeemed", "released", "confirmed")
OWED_STATUSES = ("none", "open", "resolved")
#: How an owed item ended: a till paid it ("שולם ללקוח"), the dashboard marked it applied to an
#: order ("קוזז") or written off, a kiosk document of the same transaction arrived, or the host
#: itself settled it (a later journal entry with nothing held any more).
RESOLUTIONS = ("paid_out", "applied", "written_off", "matched_document", "host_resolved", "redeemed", "tip")


class CashStation(Base):
    __tablename__ = "cash_stations"
    __table_args__ = (
        Index("ix_cash_stations_shop", "shop_id", "is_active"),
        Index("ix_cash_stations_host", "host_machine_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The cash host that runs it; null — none yet (the kiosks get no station).
    host_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    #: "עמדת מזומן 2".
    name = Column(String(100), nullable=False)
    #: "ליד קיוסק 3" — where it stands, said in every alert.
    location = Column(String(100), nullable=True)
    #: The PayLink unit's USB serial ("AE000001"); '' = the host's default unit.
    serial = Column(String(32), nullable=False, default="", server_default="")
    #: Its overrides of the station parameters (§11.10), typed: {"cashCoinsAccepted": [10, 50], …}.
    settings = Column(JSONB, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CashStationTx(Base):
    __tablename__ = "cash_station_txs"
    __table_args__ = (
        Index("ix_cash_station_txs_station_created", "station_id", "created_at"),
        Index("ix_cash_station_txs_shop_owed", "shop_id", "owed_status"),
        Index("ix_cash_station_txs_z", "z_report_id"),
    )

    #: The kiosk's `txId` (UUID v4): the same id is the same transaction (§11.1).
    tx_id = Column(UUID(as_uuid=True), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    station_id = Column(UUID(as_uuid=True), ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False)
    host_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    client_machine_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    state = Column(String(16), nullable=False)
    outcome = Column(String(20), nullable=True)
    amount_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    due_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    rounding_agorot = Column(Integer, nullable=False, default=0, server_default="0")
    inserted_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    change_due_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    change_paid_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    change_owed_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    refund_due_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    refund_paid_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    held_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    held_reason = Column(String(32), nullable=True)
    cancel_reason = Column(String(32), nullable=True)
    #: `ask` (§11.15א): the kiosk asks the customer what to do with the change owed; what was chosen (slip | credit | tip).
    change_owed_ask = Column(Boolean, nullable=False, default=False, server_default="false")
    change_owed_as = Column(String(8), nullable=True)
    #: Cash + card (§11.15ב): what the cash paid; the card paid the rest. 0: cash alone.
    split_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    #: "C-K7Q3MX" — on the "עודף חייב" slip.
    slip_code = Column(String(32), nullable=True)
    order_ref = Column(String(100), nullable=True)
    order_label = Column(String(100), nullable=True)
    device_serial = Column(String(64), nullable=True)
    document_id = Column(String(64), nullable=True)
    document_number = Column(String(64), nullable=True)
    acked = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The host's version counter: a journal entry replaces the row only with a higher one.
    seq = Column(BigInteger, nullable=False, default=0, server_default="0")
    #: The whole entry as the host sent it (cleaned: what this table has no column for — the pieces
    #: inserted and paid out, the deadlines, the error).
    data = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    done_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    # ── The owed item (§11.8): change owed to the customer, or a credit held in the unit ──
    #: none | open | resolved.
    owed_status = Column(String(12), nullable=False, default="none", server_default="none")
    #: change_owed | held_credit.
    owed_kind = Column(String(16), nullable=True)
    owed_agorot = Column(BigInteger, nullable=True)
    owed_at = Column(DateTime(timezone=True), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    resolved_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: {"userId", "name"} — the till's employee, or the dashboard user.
    resolved_by_user = Column(JSONB, nullable=True)
    #: paid_out | applied | written_off | matched_document | host_resolved.
    resolution = Column(String(20), nullable=True)
    resolution_note = Column(String(300), nullable=True)
    #: "שולם ללקוח": the till's drawer movement (`cash_out`) of the same id, and the shift it is in.
    movement_id = Column(UUID(as_uuid=True), nullable=True, unique=True)
    paid_shift_id = Column(UUID(as_uuid=True), nullable=True)
    paid_agorot = Column(BigInteger, nullable=True)
    #: The shop Z that took it into its "עמדות מזומן" section (each transaction in exactly one).
    z_report_id = Column(UUID(as_uuid=True), nullable=True)


class CashStationMovement(Base):
    __tablename__ = "cash_station_movements"
    __table_args__ = (
        Index("ix_cash_station_movements_station_at", "station_id", "at"),
        Index("ix_cash_station_movements_z", "z_report_id"),
    )

    #: Made by the host: the same id is the same movement.
    id = Column(UUID(as_uuid=True), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    station_id = Column(UUID(as_uuid=True), ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False)
    host_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: float | refill | collect | count | dump | adjust.
    kind = Column(String(12), nullable=False)
    #: float / refill: put in; collect: taken out; adjust: signed; dump: moved inside the unit.
    amount_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    expected_agorot = Column(BigInteger, nullable=True)
    counted_agorot = Column(BigInteger, nullable=True)
    #: [{"valueAgorot", "kind", "count"}].
    pieces = Column(JSONB, nullable=True)
    #: {"userId", "name"}.
    by = Column(JSONB, nullable=True)
    note = Column(String(300), nullable=True)
    at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    z_report_id = Column(UUID(as_uuid=True), nullable=True)


class CashCreditRedemption(Base):
    """A cash credit taken for an order (§11.15א), by the device's own id; released when the order was not paid."""

    __tablename__ = "cash_credit_redemptions"
    __table_args__ = (Index("ix_cash_credit_redemptions_tx", "tx_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    tx_id = Column(UUID(as_uuid=True), ForeignKey("cash_station_txs.tx_id", ondelete="CASCADE"), nullable=False)
    station_id = Column(UUID(as_uuid=True), ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False)
    code = Column(String(32), nullable=False)
    #: The till / kiosk that took it.
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    amount_agorot = Column(BigInteger, nullable=False, default=0, server_default="0")
    #: redeemed | released | confirmed.
    status = Column(String(12), nullable=False, default="redeemed", server_default="redeemed")
    #: The document whose `cash_credit` leg confirmed it.
    document_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    released_at = Column(DateTime(timezone=True), nullable=True)
    confirmed_at = Column(DateTime(timezone=True), nullable=True)


class CashHostCommand(Base):
    __tablename__ = "cash_host_commands"
    __table_args__ = (Index("ix_cash_host_commands_host_status", "host_machine_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    host_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    station_id = Column(UUID(as_uuid=True), ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False)
    #: refill | count | collect | dump | deliver_pending | float | maintenance_on | maintenance_off | reset_alerts |
    #: ext_return | ext_stack.
    op = Column(String(20), nullable=False)
    #: {"pieces": [{"valueAgorot", "count"}], "countedAgorot", "note"}.
    args = Column(JSONB, nullable=True)
    #: {"userId", "name"} — who asked.
    by = Column(JSONB, nullable=True)
    #: pending | done | refused | failed.
    status = Column(String(12), nullable=False, default="pending", server_default="pending")
    message = Column(String(300), nullable=True)
    movement_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    acked_at = Column(DateTime(timezone=True), nullable=True)
