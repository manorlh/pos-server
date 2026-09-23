import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ShopCategoryOverride(Base):
    """
    What one shop calls a tenant category, on top of the category itself.

    Categories have no shop tier: `get_categories_for_sync` serves every tenant category
    to every till with a shop, so renaming the category row renames it on every till in
    the tenant. A till renaming its own button must therefore write here instead, the
    same way a till repricing a product writes `shop_product_overrides` rather than the
    master.

    `name` is nullable rather than the row being deleted to reset it. The tills pull
    categories by delta on `updated_at`, and a deleted row leaves nothing with a
    timestamp for the next pull to find — the till would keep the local name forever.
    A NULL name with a fresh `updated_at` is a change the delta can see.
    """

    __tablename__ = "shop_category_overrides"
    __table_args__ = (
        UniqueConstraint("shop_id", "category_id", name="uq_shop_category_override"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)
    category_id = Column(
        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=False, index=True
    )
    name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    shop = relationship("Shop")
    category = relationship("Category")
