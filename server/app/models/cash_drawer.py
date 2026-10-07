"""
"מגירת מזומן" — what the tills record about their cash drawers (the owner's drawer spec,
docs/SPEC_ROLES_PERMISSIONS.md):

* `cash_drawer_events` — the audit of §14: one row per attempt to open a drawer (a cash
  sale's, a manual one with its reason, a cash movement's, a count's, a test, a refund's,
  one after the close) — approved, denied or failed — and per manager override / refusal
  of any other gated action (`category = permission`). Client id; a resend is a no-op.
  Never deleted.
* `cash_movements` — Cash In / Cash Out / Deposit and the counts (§7, §9): separate from
  the openings ("פתיחה אינה בהכרח Cash In/Out"), with the expected balance before and
  after (§8 snapshots), and for a count what was counted and the variance.

Not foreign keys to the till's documents or shift: they may land before them.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class CashDrawerEvent(Base):
    __tablename__ = "cash_drawer_events"
    __table_args__ = (
        Index("ix_cash_drawer_events_machine_occurred", "machine_id", "occurred_at"),
        Index("ix_cash_drawer_events_shop_occurred", "shop_id", "occurred_at"),
        Index("ix_cash_drawer_events_shift", "shift_id"),
        Index("ix_cash_drawer_events_tenant_occurred", "tenant_id", "occurred_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: drawer | permission
    category = Column(String(16), nullable=False, default="drawer")
    #: CASH_SALE | MANUAL | CHANGE | CASH_IN | CASH_OUT | DEPOSIT | COUNT | TEST | REFUND |
    #: AFTER_CLOSE | PERMISSION
    event_type = Column(String(24), nullable=False)
    permission = Column(String(64), nullable=True)
    #: allow | approval | deny — what the role said.
    decision = Column(String(16), nullable=True)
    #: approved | denied | failed
    result = Column(String(16), nullable=False)
    result_reason = Column(String(300), nullable=True)
    drawer_id = Column(String(100), nullable=True)
    drawer_name = Column(String(200), nullable=True)
    device_id = Column(String(100), nullable=True)
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    employee_id = Column(String(100), nullable=True)
    employee_name = Column(String(200), nullable=True)
    employee_role = Column(String(100), nullable=True)
    approver_id = Column(String(100), nullable=True)
    approver_name = Column(String(200), nullable=True)
    approver_method = Column(String(16), nullable=True)
    table_id = Column(String(100), nullable=True)
    sale_id = Column(UUID(as_uuid=True), nullable=True)
    payment_id = Column(String(100), nullable=True)
    original_sale_id = Column(UUID(as_uuid=True), nullable=True)
    reason = Column(String(32), nullable=True)
    reason_note = Column(Text, nullable=True)
    movement_id = Column(UUID(as_uuid=True), nullable=True)
    cash_movement_type = Column(String(16), nullable=True)
    amount = Column(Numeric(12, 2), nullable=True)
    expected_balance = Column(Numeric(12, 2), nullable=True)
    offline = Column(Boolean, nullable=False, default=False, server_default="false")
    training = Column(Boolean, nullable=False, default=False, server_default="false")
    details = Column(JSONB, nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CashMovement(Base):
    __tablename__ = "cash_movements"
    __table_args__ = (
        Index("ix_cash_movements_machine_occurred", "machine_id", "occurred_at"),
        Index("ix_cash_movements_shop_occurred", "shop_id", "occurred_at"),
        Index("ix_cash_movements_shift", "shift_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: cash_in | cash_out | deposit | count
    movement_type = Column(String(16), nullable=False)
    #: Positive; a count's counted amount.
    amount = Column(Numeric(12, 2), nullable=False)
    expected_before = Column(Numeric(12, 2), nullable=True)
    expected_after = Column(Numeric(12, 2), nullable=True)
    #: A count: counted − expected.
    variance = Column(Numeric(12, 2), nullable=True)
    blind = Column(Boolean, nullable=False, default=False, server_default="false")
    reason = Column(String(100), nullable=True)
    note = Column(Text, nullable=True)
    source = Column(String(200), nullable=True)
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    employee_id = Column(String(100), nullable=True)
    employee_name = Column(String(200), nullable=True)
    approver_id = Column(String(100), nullable=True)
    approver_name = Column(String(200), nullable=True)
    drawer_event_id = Column(UUID(as_uuid=True), nullable=True)
    offline = Column(Boolean, nullable=False, default=False, server_default="false")
    training = Column(Boolean, nullable=False, default=False, server_default="false")
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
