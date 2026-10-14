"""
"שיוך שולחנות ואזורים למלצר" (P:/specs/table-waiter-assignment.md §1–§6) and the notices of the
floor addressed to one device or one waiter (§5, §8 `request`).

Two tables (the rules: app/services/table_assignments.py):

* `table_assignments` — one waiter on one zone ("גינה") or one table, set before the table is
  opened. A zone covers every table in it, those added later too; a table's own assignment beats
  its zone's. Rows are written once and only ever *released* (`released_at`, `released_reason`),
  never edited — so a LAN host's copy and the cloud's merge as a set of rows by id, a release
  being final wherever it was made (§6, the LAN mirror). Whether an unreleased row still holds
  is read against `tableAssignmentReset` (`business_day`: the shop's business day it was made on).
* `table_notices` — a short message about a table for one device or one waiter: "יוסי מבקש
  להיכנס לשולחן 12" to the device inside it (§8 `request`), "מוכן להגשה" from the KDS and
  "שולחן מתעכב" for the assigned waiter (§5). Pulled by the till (and woken through Ably),
  answered once, gone at `expires_at`.
"""
from __future__ import annotations

import uuid

from sqlalchemy import CheckConstraint, Column, Date, DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: Why a row stopped holding: unassigned by hand, replaced by another waiter (`single`), the Z,
#: "נקה הכל" (`clear`), the waiter's clock-out, or the LAN host / a single till said so.
RELEASE_REASONS = ("unassigned", "replaced", "z", "clear", "clock_out", "copy", "target_gone", "expired")
#: Where it was made.
ASSIGNMENT_SOURCES = ("till", "dashboard", "lan", "copy")

NOTICE_KINDS = ("entry_request", "kds_ready", "overdue")
NOTICE_ANSWERS = ("leaving", "ignored", "seen")


class TableAssignment(Base):
    __tablename__ = "table_assignments"
    __table_args__ = (
        CheckConstraint(
            "(zone_id IS NULL AND table_id IS NOT NULL) OR (zone_id IS NOT NULL AND table_id IS NULL)",
            name="ck_table_assignments_target",
        ),
        Index("ix_table_assignments_shop_released", "shop_id", "released_at"),
        Index("ix_table_assignments_shop_day", "shop_id", "business_day"),
        # One live row per waiter and target: assigning twice is the same assignment.
        Index(
            "uq_table_assignments_live_table",
            "table_id",
            "pos_user_id",
            unique=True,
            postgresql_where=text("released_at IS NULL AND table_id IS NOT NULL"),
            sqlite_where=text("released_at IS NULL AND table_id IS NOT NULL"),
        ),
        Index(
            "uq_table_assignments_live_zone",
            "zone_id",
            "pos_user_id",
            unique=True,
            postgresql_where=text("released_at IS NULL AND zone_id IS NOT NULL"),
            sqlite_where=text("released_at IS NULL AND zone_id IS NOT NULL"),
        ),
    )

    #: The writer's own (a LAN host makes its ids, so a re-sent report is the same row).
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: What is assigned: a zone or a table, never both.
    zone_id = Column(UUID(as_uuid=True), ForeignKey("table_zones.id", ondelete="CASCADE"), nullable=True)
    table_id = Column(UUID(as_uuid=True), ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=True)
    #: The waiter.
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False)
    #: The shop's business day it was made on (`tableAssignmentReset` reads it).
    business_day = Column(Date, nullable=False)
    #: Who assigned it, as shown ("רותי (מנהלת)"), and their id: a till user or a dashboard user.
    assigned_by = Column(String(200), nullable=True)
    assigned_by_pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    assigned_by_user_id = Column(UUID(as_uuid=True), nullable=True)
    #: till | dashboard | lan | copy
    source = Column(String(12), nullable=False, default="till", server_default="till")
    #: The device it was made on (a till, the LAN host).
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    released_at = Column(DateTime(timezone=True), nullable=True)
    released_reason = Column(String(16), nullable=True)
    released_by = Column(String(200), nullable=True)


class TableNotice(Base):
    __tablename__ = "table_notices"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('entry_request', 'kds_ready', 'overdue')", name="ck_table_notices_kind"
        ),
        Index("ix_table_notices_to_machine", "to_machine_id", "expires_at"),
        Index("ix_table_notices_shop_user", "shop_id", "to_pos_user_id", "expires_at"),
        # One notice per event: a KDS order ready twice, an overdue episode seen by two passes.
        Index("uq_table_notices_dedupe", "dedupe_key", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    table_id = Column(UUID(as_uuid=True), ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=True)
    order_id = Column(UUID(as_uuid=True), nullable=True)
    #: entry_request | kds_ready | overdue
    kind = Column(String(16), nullable=False)
    #: The device it is for (the one inside the table; the waiter's, when the cloud knows it).
    to_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True)
    #: The waiter it is for: shown on any device they are signed in at.
    to_pos_user_id = Column(String(100), nullable=True)
    #: Who asks (an entry request): the device and the employee.
    from_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    from_pos_user_id = Column(String(100), nullable=True)
    from_pos_user_name = Column(String(200), nullable=True)
    #: The words the till shows ("יוסי מבקש להיכנס לשולחן 12").
    text = Column(String(300), nullable=False)
    payload = Column(JSONB, nullable=True)
    dedupe_key = Column(String(160), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)
    #: The first pull that handed it to a till.
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    #: leaving ("שמור וצא") | ignored ("התעלם") | seen (a notice read).
    answer = Column(String(12), nullable=True)
    answered_at = Column(DateTime(timezone=True), nullable=True)
    answered_by_name = Column(String(200), nullable=True)
