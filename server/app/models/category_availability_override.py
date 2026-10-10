"""
Whether a category is active for one shop, one area of a shop or one till.

The category's own `categories.is_active` is tenant-wide and stays the floor: a
category switched off there is off everywhere. These rows can only narrow it further,
nearest wins — machine → area → shop. How they combine is decided in exactly one place,
`app/services/category_availability.py`.

One table for the three levels, told apart by `level`, because nothing about a
category's setting differs between them but whose it is. `target_id` is the shop, the
area or the till, so it carries no foreign key; the category's does, with
`ON DELETE CASCADE`, so a setting never blocks deleting the category.

`is_active` is tri-state for the same reason as the product levels: NULL = not set here
(inherit), and clearing writes NULL with a fresh `updated_at` rather than deleting the
row, so the tills' delta pull and the catalog watermark can see the change.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The values of `level`, farthest first.
CATEGORY_LEVELS = ("shop", "area", "machine")


class CategoryAvailabilityOverride(Base):
    __tablename__ = "category_availability_overrides"
    __table_args__ = (
        UniqueConstraint(
            "level", "target_id", "category_id", name="uq_category_availability_override"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: "shop", "area" or "machine".
    level = Column(String(16), nullable=False)
    #: The shop's, the area's or the till's id, by `level`.
    target_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    category_id = Column(
        UUID(as_uuid=True),
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    is_active = Column(Boolean, nullable=True)
    #: "חסימה קבועה": never opened by "פתיחת פריטים אוטומטית אחרי Z"
    #: (app/services/availability_reopen.py); meaningful only while `is_active` is false.
    block_permanent = Column(Boolean, nullable=False, default=False, server_default="false")
    #: When the current switch-off began; NULL when on, or for one older than the column.
    blocked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
