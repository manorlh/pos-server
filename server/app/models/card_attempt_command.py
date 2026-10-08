"""
"תשלום לא מוכרע" — a manager's command to a till about a card attempt whose result is unknown
(app/services/card_attempt_commands.py).

A card attempt left UNKNOWN reaches "עסקאות שלא הושלמו" as outcome `unresolved`. From there a
manager may ask the till that made it to:

* `check` — "בדוק במסוף": run the lookup by the attempt's vuid on the terminal (read-only) and
  report what the terminal says (`details`: verdict, its uid, time, amount…);
* `mark_approved` — "אשר והכנס את העסקה": the cloud's decision — the till completes the pending
  documents (a normal sale);
* `mark_not_approved` — "בטל": the till voids them.

One row per command. It travels on the till's heartbeat (`pendingCardCommands`) while pending —
a check for 24 h at most, a decision until the till takes it — and the till answers it
(`POST /sync/{m}/card-commands/{id}/result`); the attempt's own row is then updated by the
till's normal failed-payment upload. A decision against what the terminal said (or with no
check at all) is made only on the manager's explicit confirmation, kept here.
"""
import uuid

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

ACTION_CHECK = "check"
ACTION_MARK_APPROVED = "mark_approved"
ACTION_MARK_NOT_APPROVED = "mark_not_approved"
ACTIONS = (ACTION_CHECK, ACTION_MARK_APPROVED, ACTION_MARK_NOT_APPROVED)
#: The cloud's decisions: they wait for the till as long as it takes (never expire).
DECISIONS = (ACTION_MARK_APPROVED, ACTION_MARK_NOT_APPROVED)

STATUS_PENDING = "pending"
#: What the till answers.
TILL_STATUSES = ("done", "failed", "not_found", "busy")
#: `expired`: no answer within the time; `cancelled`: withdrawn from the dashboard.
STATUSES = (STATUS_PENDING, *TILL_STATUSES, "expired", "cancelled")
#: What the till found (`check`) or did: approved | not_charged | unknown.
RESULT_OUTCOMES = ("approved", "not_charged", "unknown")
#: What the terminal said on a check (`details.verdict`).
CHECK_VERDICTS = ("approved", "cancelled", "not_found", "unknown")
#: `verdict_at_decision` when no check was ever answered.
NOT_CHECKED = "not_checked"


class CardAttemptCommand(Base):
    __tablename__ = "card_attempt_commands"
    __table_args__ = (
        CheckConstraint(
            "action IN ('check', 'mark_approved', 'mark_not_approved')", name="ck_card_attempt_commands_action"
        ),
        CheckConstraint(
            "status IN ('pending', 'done', 'failed', 'not_found', 'busy', 'expired', 'cancelled')",
            name="ck_card_attempt_commands_status",
        ),
        Index("ix_card_attempt_commands_machine_status", "machine_id", "status"),
        Index("ix_card_attempt_commands_attempt", "failed_payment_attempt_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: The till that made the attempt — the only one that can act on it.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: The attempt ("עסקאות שלא הושלמו" row) and its terminal request id, as the till knows it.
    failed_payment_attempt_id = Column(UUID(as_uuid=True), nullable=True)
    vuid = Column(String(100), nullable=True)
    action = Column(String(24), nullable=False)
    #: Who asked, as they were then (an account may be renamed or removed later).
    requested_by_user_id = Column(UUID(as_uuid=True), nullable=True)
    requested_by_name = Column(String(200), nullable=True)
    requested_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: A check's end of life (24 h); null for a decision, which waits for the till.
    expires_at = Column(DateTime(timezone=True), nullable=True)
    #: First handed to the till (its heartbeat, or the realtime wake-up).
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False, default=STATUS_PENDING, server_default=STATUS_PENDING)
    result_outcome = Column(String(16), nullable=True)
    result_message = Column(String(300), nullable=True)
    answered_at = Column(DateTime(timezone=True), nullable=True)
    #: Who withdrew it (`cancelled`), as they were then.
    cancelled_by_name = Column(String(200), nullable=True)
    #: A check's answer from the terminal: `{verdict, terminalUid?, at?, amountAgorot?, last4?,
    #: authNumber?, brand?, checkedAt}` (approved | cancelled | not_found | unknown).
    details = Column(JSONB, nullable=True)
    #: A decision: what the latest answered check said when it was made (`CHECK_VERDICTS`, or
    #: `not_checked`), that check, and whether the manager confirmed going against it.
    verdict_at_decision = Column(String(16), nullable=True)
    check_command_id = Column(UUID(as_uuid=True), nullable=True)
    mismatch_confirmed = Column(Boolean, nullable=False, default=False, server_default="false")
