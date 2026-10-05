"""
Accounting export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2).

* `AccountingSettings` — the account mapping ("הגדרות הנהלת חשבונות"): one row per
  company (`shop_id` NULL) and at most one override row per shop. The shop row holds
  only what it changes; `app.services.accounting.settings` merges the two.
* `AccountingExportBatch` — one export ("מנה"): who, when, which format, and the file
  itself, so the exact bytes handed to the bookkeeper can be downloaded again.
* `AccountingExportItem` — which Zs a batch carried. A Z in any batch is "exported";
  exporting it again needs an explicit confirmation (no double posting by accident).

Kept apart from `companies.settings` / `shops.settings` on purpose: those are pushed to
the tills, and account numbers are nothing a till should carry.
"""
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AccountingSettings(Base):
    __tablename__ = "accounting_settings"
    __table_args__ = (
        # One company row and one row per shop. Two partial indexes because a plain
        # UNIQUE (company_id, shop_id) lets any number of company rows through (NULLs
        # compare distinct).
        Index(
            "uq_accounting_settings_company",
            "company_id",
            unique=True,
            postgresql_where=text("shop_id IS NULL"),
            sqlite_where=text("shop_id IS NULL"),
        ),
        Index(
            "uq_accounting_settings_shop",
            "shop_id",
            unique=True,
            postgresql_where=text("shop_id IS NOT NULL"),
            sqlite_where=text("shop_id IS NOT NULL"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    #: NULL = the company's own mapping; set = that shop's override.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    settings = Column(JSONB, nullable=False, server_default="{}")
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AccountingExportBatch(Base):
    __tablename__ = "accounting_export_batches"
    __table_args__ = (
        UniqueConstraint("tenant_id", "batch_number", name="uq_accounting_export_batches_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    #: Set when every Z of the batch is of one shop (the usual case); NULL for several.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    #: "מנה N" — 1, 2, 3 … per tenant.
    batch_number = Column(Integer, nullable=False)
    #: hashavshevet | priority | excel
    format = Column(String(16), nullable=False)
    #: flexible | detailed (the MOVEIN layout; ignored for excel)
    method = Column(String(16), nullable=False, server_default="flexible")
    #: cp1255 | cp862
    encoding = Column(String(16), nullable=False, server_default="cp1255")
    #: z | day | month — what one journal entry covers.
    grouping = Column(String(8), nullable=False, server_default="z")
    #: company — one file for the company's chosen Zs; shop — this batch is one shop's
    #: file of a per-shop export (export level, settings `exportLevel`).
    level = Column(String(8), nullable=False, default="company", server_default="company")
    date_from = Column(Date, nullable=True)
    date_to = Column(Date, nullable=True)
    z_count = Column(Integer, nullable=False, server_default="0")
    entry_count = Column(Integer, nullable=False, server_default="0")
    line_count = Column(Integer, nullable=False, server_default="0")
    total_debit = Column(Numeric(14, 2), nullable=False, server_default="0")
    #: At least one Z had been exported before and the user confirmed exporting it again.
    is_reexport = Column(Boolean, nullable=False, default=False, server_default="false")
    file_name = Column(String(255), nullable=False)
    file_content = Column(LargeBinary, nullable=False)
    file_sha256 = Column(String(64), nullable=False)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    items = relationship(
        "AccountingExportItem", back_populates="batch", cascade="all, delete-orphan"
    )


class AccountingExportItem(Base):
    __tablename__ = "accounting_export_items"

    batch_id = Column(
        UUID(as_uuid=True),
        ForeignKey("accounting_export_batches.id", ondelete="CASCADE"),
        primary_key=True,
    )
    z_report_id = Column(
        UUID(as_uuid=True), ForeignKey("z_reports.id"), primary_key=True, index=True
    )

    batch = relationship("AccountingExportBatch", back_populates="items")
