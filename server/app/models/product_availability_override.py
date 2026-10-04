"""
Whether a product can be sold, set for one company, one area of a shop or one till.

Three of the five levels a product's availability is decided at. The other two already
existed: the product's own `products.is_available`, and the shop's
`shop_product_overrides.is_available`. How the five combine is decided in exactly one
place, `app/services/product_availability.py`.

"Unavailable" means *locked*, not hidden: the till still shows the product and refuses
to sell it. Hiding is `shop_product_overrides.is_listed` and has nothing to do with
these tables.

`is_available` is tri-state on every row: NULL = not set here (inherit from the level
above), true = available, false = locked. Clearing a level sets NULL rather than
deleting the row, for the same reason `shop_category_overrides.name` does: the tills
pull by delta on `updated_at`, and a deleted row leaves no timestamp for the next pull
or the catalog watermark to find — the till would keep the lock forever.

`ON DELETE CASCADE` on every foreign key: a setting about a product, a company or a
till means nothing once that row is gone, and must never be what blocks deleting it.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class CompanyProductOverride(Base):
    """
    A company's own setting for a product, for **its own shops only**.

    It never reaches a sub-company's shops, even when the product is sold there (a
    parent's product with "include sub-companies"): in that shop only the sub-company's
    own row is consulted. See `company_level_company_id` in the availability service.
    """

    __tablename__ = "company_product_overrides"
    __table_args__ = (
        UniqueConstraint("company_id", "product_id", name="uq_company_product_override"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(
        UUID(as_uuid=True),
        ForeignKey("companies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(
        UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    is_available = Column(Boolean, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AreaProductOverride(Base):
    """
    A point of sale's setting for a global product: every till standing in the area
    (`pos_machines.area_id`), between the shop's setting and each till's own.
    """

    __tablename__ = "area_product_overrides"
    __table_args__ = (
        UniqueConstraint("area_id", "product_id", name="uq_area_product_override"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    area_id = Column(
        UUID(as_uuid=True),
        ForeignKey("shop_areas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(
        UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    is_available = Column(Boolean, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class MachineProductOverride(Base):
    """One till's own setting for a global product, nearest of all five levels."""

    __tablename__ = "machine_product_overrides"
    __table_args__ = (
        UniqueConstraint("machine_id", "product_id", name="uq_machine_product_override"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(
        UUID(as_uuid=True),
        ForeignKey("pos_machines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(
        UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    is_available = Column(Boolean, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
