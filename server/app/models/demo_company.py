"""
"בניית חברת הדגמה" (P:/specs/demo-company.md, app/services/demo_company.py) — what one click built.

One table, `demo_company_items`: a row per thing the build created (or a step it completed),
under a stable key (`item_key`, unique in the organization) — "shop:snack", "area:restaurant:hall",
"step:restaurant:work_profile", "device:snack:kiosk"… A second click reads it and completes only
what has no row yet: what the build made once is never made again, and what the owner changed or
deleted since is left as he left it. The row of the company itself ("company") says which company
is the organization's demo company; deleting that company drops every row (ON DELETE CASCADE), and
the next click builds a new one.

`build_lock` (company null) is the organization's build lock: `locked_until` while a build runs,
so two clicks at once never build twice.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class DemoCompanyItem(Base):
    __tablename__ = "demo_company_items"
    __table_args__ = (
        UniqueConstraint("tenant_id", "item_key", name="uq_demo_company_items_tenant_key"),
        Index("ix_demo_company_items_company", "company_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    #: The demo company; null only for the organization's build lock.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    #: "company", "shop:snack", "area:restaurant:hall", "step:snack:kiosk", "device:restaurant:kds"…
    item_key = Column(String(120), nullable=False)
    #: company | shop | area | zone | table | menu_load | catalog_menu | printer | kitchen_station |
    #: pos_user | voucher_batch | club | club_source | digital_menu | pairing_code | step | lock
    entity_type = Column(String(32), nullable=False)
    #: Not a key: the row may have been deleted by the owner since; the build then leaves it so.
    entity_id = Column(UUID(as_uuid=True), nullable=True)
    #: The shop it belongs to (not a key either: a shop the owner deleted keeps its rows, so the
    #: build does not make it again).
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: What the summary shows of it (a device's role and name, the logo's URL…). Never a PIN.
    data = Column(JSONB, nullable=True)
    #: The build lock only: a build runs until then.
    locked_until = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
