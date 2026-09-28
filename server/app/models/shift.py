import uuid
import enum

from sqlalchemy import (
    Boolean, Column, String, ForeignKey, Integer, Numeric, Date,
    Enum as SQLEnum, DateTime, Index, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ShiftStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"


class Shift(Base):
    """
    A till's shift (משמרת), authored by the till. It replaced the trading day.

    Identity is the row's own id, which the till generates, never `(machine_id, date)`:
    many shifts on one calendar date is ordinary retail. What has to be true is enforced
    instead — **at most one open shift per till**, as a partial unique index.

    A shift is `closed` on the cloud only once the till's close was accepted with every
    one of its documents present (or an operator closed it administratively for a dead
    till). Closing a shift files an X report — its figures, recomputed here from the
    documents — and **creates no Z**. A Z is built later, in the cloud, over one or more
    closed shifts of one shop; `z_report_id` then points at it. A shift is in at most one
    Z by construction, and the Z builder sets that link under a row lock.

    `business_date` is the local date the shift opened, a reporting attribute.
    `sequence_number` orders a till's shifts, which is what "a Z takes every shift up to
    N, oldest first, no gaps" is decided on.
    """

    __tablename__ = "shifts"
    __table_args__ = (
        Index("ix_shifts_machine_status", "machine_id", "status"),
        # The real invariant. A till may have many shifts on one date, but only ever one
        # open at a time.
        Index(
            "uq_shift_one_open",
            "machine_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
            # Only so the in-memory SQLite test worlds enforce the same rule.
            sqlite_where=text("status = 'open'"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)

    business_date = Column(Date, nullable=False)
    #: Per-till counter, assigned by the till. Nullable for shifts that predate it.
    sequence_number = Column(Integer, nullable=True)
    opened_at = Column(DateTime(timezone=True), nullable=False)
    #: The till's own close time.
    closed_at = Column(DateTime(timezone=True), nullable=True)
    #: When the cloud accepted the close, i.e. when it held every document of the shift.
    close_accepted_at = Column(DateTime(timezone=True), nullable=True)

    opening_cash = Column(Numeric(12, 2), nullable=True)
    #: Legacy trading-day figure, no longer written.
    closing_cash = Column(Numeric(12, 2), nullable=True)
    #: The till's expected drawer at close, as it printed it on the X.
    expected_cash = Column(Numeric(12, 2), nullable=True)
    #: The cash counted at close. NULL means nobody counted — never "counted zero".
    counted_cash = Column(Numeric(12, 2), nullable=True)
    #: counted - expected; NULL whenever `counted_cash` is.
    discrepancy = Column(Numeric(12, 2), nullable=True)

    # Names as the till shows them, and the till user's id as the till knows it. Kept
    # apart because a name is not an identity (the till used to mix the two).
    opened_by = Column(String(255), nullable=True)
    closed_by = Column(String(255), nullable=True)
    opened_by_pos_user_id = Column(String(100), nullable=True)
    closed_by_pos_user_id = Column(String(100), nullable=True)

    #: Closed with nobody at the drawer (remote close, or administrative close).
    unattended = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The remote close instruction (a Z-run item) this close answered, if any.
    close_request_item_id = Column(UUID(as_uuid=True), ForeignKey("z_run_items.id"), nullable=True)
    #: The standalone remote close (no Z) this close answered, if any.
    close_request_id = Column(
        UUID(as_uuid=True),
        # shift_close_requests.shift_id points back here; one side of the cycle is added after.
        ForeignKey(
            "shift_close_requests.id",
            use_alter=True,
            name="fk_shifts_close_request_id_shift_close_requests",
        ),
        nullable=True,
    )

    # ── The X, recomputed by the server from the documents it holds ───────────
    total_sales = Column(Numeric(12, 2), nullable=True)
    total_refunds = Column(Numeric(12, 2), nullable=True)
    total_cash = Column(Numeric(12, 2), nullable=True)
    total_card = Column(Numeric(12, 2), nullable=True)
    total_tips = Column(Numeric(12, 2), nullable=True)
    total_cash_tips = Column(Numeric(12, 2), nullable=True)
    total_card_tips = Column(Numeric(12, 2), nullable=True)
    vat_total = Column(Numeric(12, 2), nullable=True)
    transactions_count = Column(Integer, nullable=True)
    first_transaction_number = Column(String(100), nullable=True)
    last_transaction_number = Column(String(100), nullable=True)
    #: The till's own X figures, kept for audit. Never used for a Z.
    till_totals = Column(JSONB, nullable=True)
    #: The till's X disagreed with the server's by more than a rounding cent.
    totals_mismatch = Column(Boolean, nullable=False, default=False, server_default="false")

    #: Documents that reached the cloud after this shift was closed. While the shift is
    #: not in a Z its X is recomputed to include them; once it is, they are stored but
    #: the Z's figures are not (the Z is flagged too).
    late_documents = Column(Integer, nullable=False, default=0, server_default="0")

    #: The Z this shift is in, once one has been built. NULL = still awaiting a Z.
    z_report_id = Column(UUID(as_uuid=True), ForeignKey("z_reports.id"), nullable=True, index=True)

    #: Closed by an operator from the cloud's documents because the till could not
    #: (dead-till recovery). The X was built by the cloud, nobody counted a drawer, and
    #: `reconstruction_basis` records what it was built from.
    reconstructed = Column(Boolean, nullable=False, default=False, server_default="false")
    reconstructed_by = Column(String(255), nullable=True)
    reconstruction_basis = Column(JSONB, nullable=True)

    #: Who authorised the close when a grant was presented. Null = none was required.
    approved_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    approved_by_pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id"), nullable=True)

    status = Column(
        SQLEnum(ShiftStatus, name="shiftstatus", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ShiftStatus.OPEN,
    )

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    machine = relationship("POSMachine")
    shop = relationship("Shop")
    transactions = relationship("Transaction", back_populates="shift")
    z_report = relationship("ZReport", back_populates="shifts", foreign_keys=[z_report_id])
