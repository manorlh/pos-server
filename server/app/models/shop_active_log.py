"""
"סניף לא פעיל" — the log of a shop's active switch (P:/specs/shop-code-and-inactive.md §3).

Owner: "אפשר להפוך לסניף לא פעיל, והפיכה כזו גם תנעל את המכשירים (הרשאה לסופר אדמין)".
Only the super admin turns a shop off or back on, always with a reason, and "כל שינוי נרשם,
עם מי, מתי והסיבה": one row per change (app/services/shop_active.py). The flag itself is
`shops.is_active`; it reaches the devices as `shopActive`.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class ShopActiveLog(Base):
    __tablename__ = "shop_active_log"
    __table_args__ = (Index("ix_shop_active_log_shop_created", "shop_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The state the shop was put in: false = turned off (its devices lock), true = back on.
    active = Column(Boolean, nullable=False)
    #: Why — the text typed in the dashboard's confirmation (required).
    reason = Column(Text, nullable=True)
    #: The dashboard user (the super admin). Not a key: the log outlives an account.
    user_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
