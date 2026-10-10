"""
"מופיע ב" — a shop's or a point of sale's exception to a product's channel default
(app/services/product_channels.py, specs/digital-menu-ordering-cards-plan.md §4.2).

The product's own four switches (`products.sales_channel` for the tills and the kiosks,
`channel_online`, `channel_menu`) are the organisation's default. A row here says, for one
channel, that a shop or a point of sale differs: the nearest level that says wins (point of sale,
then shop, then the product). `allowed` NULL is "back to inherit" — the row stays, with its
`updated_at`, so a till pulling deltas sees the change.

This is permission to appear, not a restriction: hiding and blocking sales are blocks
(`sold_out_marks`), and a block always wins.
"""
import uuid

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The levels an exception is set at, nearest last.
OVERRIDE_LEVELS = ("shop", "area")


class ProductChannelOverride(Base):
    __tablename__ = "product_channel_overrides"
    __table_args__ = (
        CheckConstraint("level IN ('shop', 'area')", name="ck_product_channel_overrides_level"),
        CheckConstraint(
            "channel IN ('pos', 'kiosk', 'online', 'menu')", name="ck_product_channel_overrides_channel",
        ),
        UniqueConstraint("product_id", "level", "target_id", "channel", name="uq_product_channel_overrides"),
        Index("ix_product_channel_overrides_target", "tenant_id", "level", "target_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: The global product (a till's own copy is never named here).
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    level = Column(String(8), nullable=False)
    #: The shop or the point of sale (`shop_areas`), by `level`. Not a key: polymorphic.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    channel = Column(String(8), nullable=False)
    #: True / False — appears there or not; NULL — no exception (inherit), kept for the deltas.
    allowed = Column(Boolean, nullable=True)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
