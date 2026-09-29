import uuid

from sqlalchemy import (
    Boolean, Column, ForeignKey, Numeric, Integer, Date,
    DateTime, String, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ZReport(Base):
    """
    A Z report (דו״ח Z), built by the cloud over closed shifts of **one shop**.

    Its figures are computed server-side from the documents the cloud holds, never taken
    from a till. It links to 1..N shifts over 1..N tills of that shop (`shifts.z_report_id`)
    and carries a per-till section for each (`per_machine`), so a per-shop Z is a set of
    per-register summaries under one shop number.

    Rows from before shifts existed are till-issued, one per trading day: they keep their
    `machine_id` and have no `per_machine`. New rows have `machine_id` NULL.
    """

    __tablename__ = "z_reports"
    __table_args__ = (
        Index("ix_z_reports_shop_business_date", "shop_id", "business_date"),
        # A shop's Z number names one document. Two rows with one number would make the
        # number meaningless, which is the one thing it exists to prevent.
        Index(
            "uq_z_reports_shop_sequence",
            "shop_id",
            "shop_sequence_number",
            unique=True,
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    #: Legacy, till-issued rows only. NULL on a cloud-built Z, which spans tills.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    #: The area the run that built it was for (`z_runs.area_id`); NULL for a whole-shop or
    #: hand-picked Z. Its name as of the build is frozen in `header.areaName`.
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id"), nullable=True, index=True)

    #: The shop-local date the Z is filed under (default: that of its latest shift).
    business_date = Column(Date, nullable=False)
    #: Opening of the earliest and close of the latest included shift.
    period_start = Column(DateTime(timezone=True), nullable=True)
    period_end = Column(DateTime(timezone=True), nullable=True)
    shift_count = Column(Integer, nullable=True)
    machine_count = Column(Integer, nullable=True)
    vat_total = Column(Numeric(12, 2), nullable=True)
    discounts_total = Column(Numeric(12, 2), nullable=True)
    #: Net takings per tender method, e.g. {"cash": "100.00", "card": "250.00"}.
    payment_breakdown = Column(JSONB, nullable=True)
    #: The per-register sections (see docs/SHIFTS_API.md §3.6). NULL on legacy rows.
    per_machine = Column(JSONB, nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    #: Who issued it, frozen at build (app/services/z_header.py). Served as stored —
    #: never re-derived from live settings, which may have changed since.
    header = Column(JSONB, nullable=True)
    #: Documents of its shifts that reached the cloud after it was built. They are
    #: stored (a fiscal document is never dropped) but are not in its figures.
    late_documents = Column(Integer, nullable=False, default=0, server_default="0")
    #: Documents of its shifts whose fiscal content was rewritten after it was built.
    #: Its figures are the ones it was built with (see `Shift.amended_documents`).
    amended_documents = Column(Integer, nullable=False, default=0, server_default="0")
    #: The run that built it. NULL on legacy rows.
    z_run_id = Column(UUID(as_uuid=True), ForeignKey("z_runs.id"), nullable=True, index=True)

    #: The shop's own Z counter — 1, 2, 3 … across every till in the shop.
    #:
    #: A Z already has a globally unique `id`, but a UUID is not a number a bookkeeper
    #: can read off one report and check against the previous one. This is, and a gap in
    #: it means a close is missing.
    #:
    #: Allocated by the cloud, not the till: no till can know what the others in the
    #: shop have closed, least of all offline. The consequence is that the paper torn
    #: off at close does not carry it — the till learns it from the upsert
    #: acknowledgement, so a reprint does. Nullable because a terminal that is not
    #: assigned to a shop has no shop sequence to draw from.
    shop_sequence_number = Column(Integer, nullable=True)

    # Snapshot totals (denormalised from items at close time for fast list queries)
    total_sales = Column(Numeric(12, 2), nullable=True)
    total_refunds = Column(Numeric(12, 2), nullable=True)
    total_cash_sales = Column(Numeric(12, 2), nullable=True)
    total_card_sales = Column(Numeric(12, 2), nullable=True)
    total_tips = Column(Numeric(12, 2), nullable=True)
    total_cash_tips = Column(Numeric(12, 2), nullable=True)
    total_card_tips = Column(Numeric(12, 2), nullable=True)
    transactions_count = Column(Integer, nullable=True)

    #: At least one included shift was closed with nobody at the drawer.
    #:
    #: Matters because `actual_cash` is then left NULL rather than copied from
    #: `expected_cash`. Copying it made every unattended Z assert a variance of exactly
    #: zero — a shop with a real shortfall got a document claiming it balanced. Null
    #: says "nobody counted", which is the truth, and this flag says why.
    unattended = Column(Boolean, nullable=False, default=False, server_default="false")

    #: At least one included shift was reconstructed by the cloud for a dead till. The
    #: per-shift detail (who, from what) now lives on `shifts`; legacy Z rows keep their
    #: own `reconstructed_by` / `reconstruction_basis`.
    reconstructed = Column(Boolean, nullable=False, default=False, server_default="false")
    reconstructed_by = Column(String(255), nullable=True)
    reconstruction_basis = Column(JSONB, nullable=True)

    #: Who authorised this close, when the till's own operator could not.
    #:
    #: Filled from a live elevation grant presented with the close, so it names a
    #: person the server itself authenticated moments earlier — not a name the device
    #: chose. Nullable because the common close needs no second person: a till whose
    #: operator is a manager closes its own day, and null there means "none was
    #: required", not "missing".
    approved_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    #: The till user whose grant closed the day, when the approver typed a username.
    #: Mutually exclusive with `approved_by_user_id` for the same reason a grant has one
    #: holder: a close approved by two people is a close nobody can be asked about.
    approved_by_pos_user_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_users.id"), nullable=True
    )

    opening_cash = Column(Numeric(12, 2), nullable=True)
    closing_cash = Column(Numeric(12, 2), nullable=True)
    expected_cash = Column(Numeric(12, 2), nullable=True)
    actual_cash = Column(Numeric(12, 2), nullable=True)
    discrepancy = Column(Numeric(12, 2), nullable=True)

    # Full ZReportData blob from POS — keeps the door open for richer analytics later.
    payload = Column(JSONB, nullable=True)

    closed_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    shifts = relationship(
        "Shift", back_populates="z_report", foreign_keys="Shift.z_report_id",
        order_by="Shift.opened_at",
    )
    machine = relationship("POSMachine")
    shop = relationship("Shop")
