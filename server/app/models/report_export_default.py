"""
"ברירת מחדל לייצוא" (specs/reports-upgrade.md §2ב, §4.3): which columns a company's Excel and
PDF exports of a report take by default, set by the company's manager, a distributor or a
super admin. One row per company and report; an empty choice is no row.

* `report_export_defaults` — the choice: `columns` is the ordered list of column keys (the
  dashboard's own keys for that report — the server never interprets them).
* `report_export_default_audit` — every change, with the list before and after.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class ReportExportDefault(Base):
    __tablename__ = "report_export_defaults"
    __table_args__ = (
        UniqueConstraint("company_id", "report_key", name="uq_report_export_defaults_company_report"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    report_key = Column(String(64), nullable=False)
    #: Ordered column keys, e.g. ["productName", "unitsNet", "net"].
    columns = Column(JSONB, nullable=False, default=list)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ReportExportDefaultAudit(Base):
    __tablename__ = "report_export_default_audit"
    __table_args__ = (Index("ix_report_export_default_audit_company", "company_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    report_key = Column(String(64), nullable=False)
    #: set | clear
    action = Column(String(16), nullable=False)
    before = Column(JSONB, nullable=True)
    after = Column(JSONB, nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
