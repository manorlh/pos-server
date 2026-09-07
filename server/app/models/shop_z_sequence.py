import uuid

from sqlalchemy import Column, BigInteger, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: Shop Z numbering starts at 1. Unlike SKUs there is no reason to start high — a Z
#: number is read by a bookkeeper counting closures, and "Z 1" is the first close.
DEFAULT_SHOP_Z_SEQUENCE_START = 1


class ShopZSequence(Base):
    """
    Per-shop counter for Z-report numbers.

    A row per shop, incremented under `SELECT … FOR UPDATE` in the same transaction that
    inserts the Z. That is deliberately **not** a Postgres SEQUENCE: `nextval()` is
    non-transactional, so a rolled-back close would burn a number and leave a hole. A
    hole in this sequence has to mean "a Z is missing", which is the entire reason the
    number exists — if it can also mean "a close failed and retried", an auditor cannot
    tell the two apart and the number tells them nothing.

    Serialising every close in a shop on one row is fine: a close happens once per till
    per day, so the contention is a handful of rows a day against a lock held for the
    length of one insert.
    """

    __tablename__ = "shop_z_sequences"

    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), primary_key=True)
    next_value = Column(BigInteger, nullable=False, default=DEFAULT_SHOP_Z_SEQUENCE_START)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
