from sqlalchemy import Column, BigInteger, DateTime, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: A tenant's first company is company 1, a company's first shop is shop 1.
DEFAULT_ORG_NUMBER_START = 1

#: `kind` values: what is being numbered, and so what `owner_id` is.
KIND_COMPANY = "company"  # owner_id: the tenant
KIND_SHOP = "shop"  # owner_id: the company


class OrgNumberSequence(Base):
    """
    Counters for company and shop numbers: company 1, 2, 3 in a tenant; shop 1, 2 in a
    company. The same idea as `shop_register_sequences` for tills, one table for both.

    The *next* number to hand out, never the highest in use, so a deleted company or shop
    leaves its number spent: `max + 1` would issue it again. Incremented under
    `SELECT … FOR UPDATE` in the transaction that creates the row (`app.services.
    org_numbers`), so a create that rolls back gives its number back.

    No foreign key: `owner_id` names a tenant or a company depending on `kind`, and the
    counter must outlive a deleted company for its shops' numbers to stay spent too.
    """

    __tablename__ = "org_number_sequences"

    kind = Column(String(16), primary_key=True)
    owner_id = Column(UUID(as_uuid=True), primary_key=True)
    next_value = Column(BigInteger, nullable=False, default=DEFAULT_ORG_NUMBER_START)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
