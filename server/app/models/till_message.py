import uuid

from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

#: Where a message can be sent, widest first. `target_id` names a row of `companies`,
#: `shops`, `shop_areas` or `pos_machines` by `target_level`.
TILL_MESSAGE_LEVELS = ("company", "shop", "area", "machine")

#: When a message goes out: at once, once at `send_at`, or on a weekly schedule.
TILL_MESSAGE_SCHEDULES = ("now", "scheduled", "recurring")


class TillMessage(Base):
    """
    A message a manager pushes to tills ("הודעות לקופות"), shown full-screen on each
    till until the signed-in employee taps "קראתי".

    Who it reaches is decided once, when it is sent: a receipt row per active till in
    the target (`TillMessageReceipt`). A till added to the shop afterwards does not get
    it; a till moved out of the area still does. The target is kept for display.

    `expires_at` is when it stops being shown (null: until acknowledged). Cancelling
    sets it to the moment of cancellation and stamps `cancelled_at`.

    Scheduling (`schedule_kind`): "now" writes the receipts when sent. "scheduled" and
    "recurring" write them lazily, when the first till (or the dashboard) asks after the
    due moment — there is no background scheduler. A scheduled message's audience is
    resolved once, at `send_at` (`sent_at` stamps it); a recurring one's afresh for each
    occurrence, so a till added since gets the next one. Each occurrence's receipts carry
    its local date (`TillMessageReceipt.occurrence_date`) and must be acknowledged anew.
    Local times are in `timezone` (the tenant's, fixed when the message is created).
    """

    __tablename__ = "till_messages"
    __table_args__ = (
        CheckConstraint(
            "target_level IN ('company', 'shop', 'area', 'machine')",
            name="ck_till_messages_target_level",
        ),
        CheckConstraint(
            "schedule_kind IN ('now', 'scheduled', 'recurring')",
            name="ck_till_messages_schedule_kind",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)
    title = Column(String(200), nullable=True)
    body = Column(Text, nullable=False)
    target_level = Column(String(16), nullable=False)
    #: The company's, shop's, area's or till's id, by `target_level`. No foreign key.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)

    schedule_kind = Column(String(16), nullable=False, default="now", server_default="now")
    #: "scheduled": when it goes out.
    send_at = Column(DateTime(timezone=True), nullable=True)
    #: When its receipts were written ("now": at creation; "scheduled": at `send_at`,
    #: lazily). Null: not sent yet. Unused for "recurring".
    sent_at = Column(DateTime(timezone=True), nullable=True)
    #: IANA zone the schedule's local dates and times are in.
    timezone = Column(String(64), nullable=True)
    #: "recurring": weekdays as digits, 0 = Sunday (א׳) … 6 = Saturday (ש׳), e.g. "01234".
    recur_days = Column(String(7), nullable=True)
    #: "recurring": local time of day, "HH:MM".
    recur_time = Column(String(5), nullable=True)
    recur_start_date = Column(Date, nullable=True)
    recur_end_date = Column(Date, nullable=True)
    #: "recurring": an occurrence is shown for this long; null = to the end of its day.
    #: Never past the next occurrence.
    occurrence_ttl_minutes = Column(Integer, nullable=True)
    paused_at = Column(DateTime(timezone=True), nullable=True)
    #: "recurring": the latest occurrence handled (delivered, or skipped as already
    #: started when the message was created, edited or resumed).
    last_occurrence_date = Column(Date, nullable=True)

    sender = relationship("User")
    receipts = relationship(
        "TillMessageReceipt",
        back_populates="message",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class TillMessageReceipt(Base):
    """
    One till's copy of a message: when it first fetched it, and who acknowledged it.
    A recurring message has one per till per occurrence (`occurrence_date`); any other
    message one per till (`occurrence_date` null).
    """

    __tablename__ = "till_message_receipts"
    __table_args__ = (
        Index(
            "uq_till_message_receipts_once",
            "message_id",
            "machine_id",
            unique=True,
            postgresql_where=text("occurrence_date IS NULL"),
            sqlite_where=text("occurrence_date IS NULL"),
        ),
        Index(
            "uq_till_message_receipts_occurrence",
            "message_id",
            "machine_id",
            "occurrence_date",
            unique=True,
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id = Column(
        UUID(as_uuid=True),
        ForeignKey("till_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    machine_id = Column(
        UUID(as_uuid=True),
        ForeignKey("pos_machines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: First time the till fetched it (`GET /sync/{id}/messages`).
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    #: The till's signed-in employee, as the till reports them. Free text, like
    #: `transactions.cashier_id`: a till's user id is not trusted to be a row here.
    acknowledged_by_pos_user_id = Column(String(100), nullable=True)
    acknowledged_by_pos_user_name = Column(String(200), nullable=True)
    #: Recurring messages: the occurrence's local date, when it began, when it ends.
    occurrence_date = Column(Date, nullable=True)
    occurs_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)

    message = relationship("TillMessage", back_populates="receipts")
    machine = relationship("POSMachine")
