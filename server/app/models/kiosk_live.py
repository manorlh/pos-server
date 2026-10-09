"""
"שליטה חיה בקיוסקים": a product or a category hidden on the kiosks of a shop for now — "הגריל
סגור" — until a time or until shown again (app/services/kiosk_live.py).

The kiosks are not told about this table: every kiosk's effective config gets the active rows
added to `catalog.hiddenProducts` / `catalog.hiddenCategories`, which the Android, web and
Windows kiosks already apply. Showing again stamps `cleared_at` (rows are never deleted, for
the record of who hid what).
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

KIOSK_HIDE_KINDS = ("product", "category")


class KioskQuickHide(Base):
    __tablename__ = "kiosk_quick_hides"
    __table_args__ = (Index("ix_kiosk_quick_hides_shop", "shop_id", "cleared_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: "product" or "category".
    kind = Column(String(16), nullable=False)
    #: The product's or the category's id.
    item_id = Column(UUID(as_uuid=True), nullable=False)
    #: The name as it was, for the panel and the record.
    item_name = Column(String(255), nullable=True)
    until = Column(DateTime(timezone=True), nullable=True)
    note = Column(String(200), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    cleared_by_name = Column(String(200), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
