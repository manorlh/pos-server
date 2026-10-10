"""
"התאמת אשראי מול Z-Credit" — our Z-Credit card legs against what the Z-Credit terminal itself
recorded, transaction by transaction (docs/SPEC_ZCREDIT.md "חלק ג׳").

The owner (09.10.2026): "יש אפשרות ב-Z-Credit לעשות התאמה בין העסקאות אשראי שלנו מול מסוף
Z-Credit?"

* `zcredit_recon_runs` — one run of one Z-Credit terminal for one business day: when, by whom
  (the nightly job or "הרץ התאמה עכשיו"), the outcome, the totals per category and the deposits
  compared. A day may be run again; the latest run of a terminal and day is the current one.
* `zcredit_recon_items` — one row per transaction compared: its category, both sides (Z-Credit's
  reference, amount, status, deposit; our document, leg, amount, transmission) and the owner's
  "טופל" with a note. A rerun carries "טופל" over by the item's `fingerprint`.

Read-only toward Z-Credit: nothing here refunds, voids or deposits. The terminal number is kept
whole (a run must know which terminal it read) but never leaves the server unmasked — the
dashboard sees its last four digits only; card numbers are kept as their last four only.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class ZCreditReconTrigger:
    NIGHTLY = "nightly"
    MANUAL = "manual"


class ZCreditReconRunStatus:
    #: Being run now (a row left here by a crash is closed as failed by the next run).
    RUNNING = "running"
    DONE = "done"
    #: Z-Credit could not be read (credentials, no connection, an error code): nothing compared.
    FAILED = "failed"


class ZCreditReconCategory:
    """What became of one transaction (docs/SPEC_ZCREDIT.md "חלק ג׳", the categories)."""

    #: ✅ Both sides agree: amount, status, deposit.
    MATCHED = "matched"
    #: ⚠️ Same transaction, another amount.
    AMOUNT_MISMATCH = "amount_mismatch"
    #: ⚠️ Voided / refunded at Z-Credit and whole in ours, or the other way round.
    STATUS_MISMATCH = "status_mismatch"
    #: ❌ A transaction at Z-Credit and no document of ours.
    ZCREDIT_ONLY = "zcredit_only"
    #: ❌ A document of ours and no transaction at Z-Credit.
    OURS_ONLY = "ours_only"
    #: ⚠️ One Z-Credit transaction on two documents of ours, or listed twice by Z-Credit.
    DUPLICATE = "duplicate"
    #: ⚠️ Deposited at Z-Credit and not transmitted in ours, or the other way round.
    DEPOSIT_MISMATCH = "deposit_mismatch"


RECON_CATEGORIES = (
    ZCreditReconCategory.MATCHED,
    ZCreditReconCategory.AMOUNT_MISMATCH,
    ZCreditReconCategory.STATUS_MISMATCH,
    ZCreditReconCategory.ZCREDIT_ONLY,
    ZCreditReconCategory.OURS_ONLY,
    ZCreditReconCategory.DUPLICATE,
    ZCreditReconCategory.DEPOSIT_MISMATCH,
)
#: ❌ — each one raises an exception (the exceptions log / alerts).
HARD_CATEGORIES = (ZCreditReconCategory.ZCREDIT_ONLY, ZCreditReconCategory.OURS_ONLY)


class ZCreditReconRun(Base):
    __tablename__ = "zcredit_recon_runs"
    __table_args__ = (
        Index("ix_zcredit_recon_runs_terminal_day", "tenant_id", "terminal_key", "business_date"),
        Index("ix_zcredit_recon_runs_tenant_day", "tenant_id", "business_date"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: The terminal, whole (server-side only) — and its stable opaque key and last four for the dashboard.
    terminal_number = Column(String(20), nullable=False)
    terminal_key = Column(String(32), nullable=False)
    terminal_last4 = Column(String(4), nullable=True)
    #: The settings layer the credentials came from (tenant … machine).
    credential_source = Column(String(16), nullable=True)
    #: The tills and shops charging on this terminal when it ran.
    machine_ids = Column(JSONB, nullable=False, default=list)
    shop_ids = Column(JSONB, nullable=False, default=list)
    business_date = Column(Date, nullable=False)
    timezone = Column(String(64), nullable=False, default="Asia/Jerusalem")
    trigger = Column(String(16), nullable=False, default=ZCreditReconTrigger.MANUAL)
    status = Column(String(16), nullable=False, default=ZCreditReconRunStatus.RUNNING)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    #: `{category: {count, zcredit, ours}}` (shekels as strings) and the overall counts.
    summary = Column(JSONB, nullable=False, default=dict)
    #: The deposits compared: Z-Credit's totals against our transmissions and legs.
    deposits = Column(JSONB, nullable=False, default=list)
    zcredit_rows = Column(Integer, nullable=False, default=0, server_default="0")
    our_legs = Column(Integer, nullable=False, default=0, server_default="0")
    lookups = Column(Integer, nullable=False, default=0, server_default="0")
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at = Column(DateTime(timezone=True), nullable=True)


class ZCreditReconItem(Base):
    __tablename__ = "zcredit_recon_items"
    __table_args__ = (
        Index("ix_zcredit_recon_items_run", "run_id"),
        Index("ix_zcredit_recon_items_open", "tenant_id", "category", "handled_at"),
        Index("ix_zcredit_recon_items_fingerprint", "tenant_id", "fingerprint"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(UUID(as_uuid=True), ForeignKey("zcredit_recon_runs.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    category = Column(String(24), nullable=False)
    #: Stable across reruns of the same terminal and day: what "טופל" carries over by.
    fingerprint = Column(String(160), nullable=False)
    #: Free words: why this category (Hebrew, for the owner).
    reason = Column(Text, nullable=True)

    # ── Z-Credit's side ─────────────────────────────────────────────────────
    zc_reference = Column(String(64), nullable=True)
    zc_amount_agorot = Column(Integer, nullable=True)
    zc_status_code = Column(Integer, nullable=True)
    zc_deal_type = Column(String(4), nullable=True)
    zc_deposit_id = Column(String(64), nullable=True)
    zc_card_last4 = Column(String(4), nullable=True)
    zc_card_name = Column(String(64), nullable=True)
    zc_payments = Column(Integer, nullable=True)
    zc_approval = Column(String(32), nullable=True)
    #: `SaveDate`, the terminal's local time as Z-Credit wrote it.
    zc_save_date = Column(DateTime(timezone=False), nullable=True)
    #: "report" (the day's report) or "lookup" (a status query for a leg the report did not list).
    zc_source = Column(String(16), nullable=True)

    # ── Our side ────────────────────────────────────────────────────────────
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    payment_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    document_number = Column(String(40), nullable=True)
    document_type = Column(Integer, nullable=True)
    our_amount_agorot = Column(Integer, nullable=True)
    our_status = Column(String(24), nullable=True)
    our_card_last4 = Column(String(4), nullable=True)
    our_created_at = Column(DateTime(timezone=True), nullable=True)
    our_transmitted = Column(Boolean, nullable=True)
    our_batch = Column(String(64), nullable=True)
    #: Other documents of ours on the same transaction (a duplicate), and for a Z-Credit charge
    #: with no document the documents it may belong to (same card, amount, time) — the
    #: "צור זיכוי" candidates. `[{transactionId, paymentId, documentNumber, …}]`.
    related = Column(JSONB, nullable=False, default=list)

    # ── The owner's handling ────────────────────────────────────────────────
    handled_at = Column(DateTime(timezone=True), nullable=True)
    handled_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    handled_by_name = Column(String(255), nullable=True)
    handled_note = Column(Text, nullable=True)
    #: The exception raised for a ❌ (the exceptions log), when one was.
    exception_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
