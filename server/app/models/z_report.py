import uuid

from sqlalchemy import (
    Boolean, Column, ForeignKey, Numeric, Integer, Date,
    DateTime, String, Index, UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ZOrigin:
    #: Built by a Z run over a shop's tills, numbered in the shop's run.
    CLOUD = "cloud"
    #: Asked for by one till in `zMode = till` (docs/SHIFTS_API.md §5), numbered per till.
    TILL = "till"


class ZReport(Base):
    """
    A Z report (דו״ח Z), built by the cloud over closed shifts of **one shop**.

    Its figures are computed server-side from the documents the cloud holds, never taken
    from a till. It links to 1..N shifts over 1..N tills of that shop (`shifts.z_report_id`)
    and carries a per-till section for each (`per_machine`), so a per-shop Z is a set of
    per-register summaries under one shop number.

    A **till Z** (`origin = till`, docs/SHIFTS_API.md §5) is the same document over one
    till: the same builder, figures and per-till section, but asked for by the till and
    numbered in that till's own run (`machine_sequence_number`), with `machine_id` set and
    no shop number.

    Rows from before shifts existed are till-issued, one per trading day: they keep their
    `machine_id` and have no `per_machine` (`origin` reads `cloud` on them; `legacy` on
    the wire is what marks them). A cloud Z has `machine_id` NULL.
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
        # The same for a till's own run — per run (`machine_sequence_epoch`): an independent
        # till starts again at 1 (docs/SPEC_INDEPENDENT_TILL.md §3.1). Partial, so the cloud
        # Zs (all NULL) are free.
        Index(
            "uq_z_reports_machine_sequence",
            "machine_id",
            "machine_sequence_epoch",
            "machine_sequence_number",
            unique=True,
            postgresql_where=text("machine_sequence_number IS NOT NULL"),
            sqlite_where=text("machine_sequence_number IS NOT NULL"),
        ),
        # One request of the till, one Z: the backstop to the counter lock.
        UniqueConstraint("client_request_id", name="uq_z_reports_client_request_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    #: The till of a till Z, and of a legacy till-issued row. NULL on a cloud-built Z,
    #: which spans tills.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True, index=True)
    #: `cloud` (a Z run built it) or `till` (the till asked for it, §5). See `ZOrigin`.
    origin = Column(String(8), nullable=False, default=ZOrigin.CLOUD, server_default=ZOrigin.CLOUD)
    #: A till Z's number in its till's own run — 1, 2, 3 … per till, gapless, never reset
    #: (`machine_z_sequences`). NULL on a cloud Z, whose number is the shop's.
    machine_sequence_number = Column(Integer, nullable=True)
    #: The till's run this number is in (`machine_z_sequences.epoch`): 0 for its first,
    #: one more each time it is made independent — which starts its Zs at 1 again.
    machine_sequence_epoch = Column(Integer, nullable=False, default=0, server_default="0")
    #: The till's idempotency key for a till Z (`clientRequestId`): a retried request
    #: answers this row again instead of numbering a second Z. NULL on a cloud Z.
    client_request_id = Column(UUID(as_uuid=True), nullable=True)
    #: Who pressed "הפק Z" at the till (its till user's name); NULL when it was produced
    #: for a dashboard request with nobody at the till, and on a cloud Z.
    created_by_name = Column(String(255), nullable=True)
    #: That till user's id as the till knows it (text, like `shifts.opened_by_pos_user_id`:
    #: a claim of the till, not a key). `created_by_user_id` stays the dashboard user —
    #: on a till Z, the one whose request it answered.
    created_by_pos_user_id = Column(String(100), nullable=True)
    #: The till's own sum over the included shifts, as sent with a till Z (§3.3 keys),
    #: kept for audit like a shift's `till_totals` — never used for the figures.
    till_totals = Column(JSONB, nullable=True)
    #: A till Z whose `till_totals` disagree with the built figures on a compared key.
    #: Shown, never a refusal: the figures are the cloud's either way.
    totals_mismatch = Column(Boolean, nullable=False, default=False, server_default="false")
    #: A till Z closed at the till with no connection to the cloud and uploaded later
    #: (docs/SPEC_OFFLINE_TILL_Z.md): numbered by the till, built here from the documents
    #: like any till Z, with what the till printed kept beside it (`offline_report`) and
    #: every figure that differs listed (`offline_discrepancies`, null/empty = none).
    built_offline = Column(Boolean, nullable=False, default=False, server_default="false")
    uploaded_at = Column(DateTime(timezone=True), nullable=True)
    offline_report = Column(JSONB, nullable=True)
    offline_discrepancies = Column(JSONB, nullable=True)
    #: The card batch transmission the till ran before this Z (doPeriodic), with the
    #: terminal's answer — `{outcome, batchNumber, statusMessage, byBrand, …}`. Null when
    #: the till sent none (a cloud Z, or a till from before it).
    card_transmission = Column(JSONB, nullable=True)
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
    #: assigned to a shop has no shop sequence to draw from — and NULL on a till Z,
    #: which is numbered in its till's run instead (`machine_sequence_number`).
    shop_sequence_number = Column(Integer, nullable=True)

    # Snapshot totals (denormalised from items at close time for fast list queries)
    total_sales = Column(Numeric(12, 2), nullable=True)
    total_refunds = Column(Numeric(12, 2), nullable=True)
    total_cash_sales = Column(Numeric(12, 2), nullable=True)
    total_card_sales = Column(Numeric(12, 2), nullable=True)
    #: Net of the `exchange` tender legs (see `Shift.total_exchange`): zero when every
    #: mixed basket of its shifts is complete. Null on a Z built before it was stored.
    total_exchange = Column(Numeric(12, 2), nullable=True)
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

    @property
    def is_till_z(self) -> bool:
        return self.origin == ZOrigin.TILL

    @property
    def z_number(self):
        """
        The number this Z is quoted by: the till's own run for a till Z, the shop's run
        otherwise. What every `zNumber` on the wire is (a shift's, the heartbeat's
        `recentShiftZs`, a close response) — the till prints it on the X reprint.
        """
        return self.machine_sequence_number if self.is_till_z else self.shop_sequence_number
