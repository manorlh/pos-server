from sqlalchemy import Column, BigInteger, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: A shop's first till is register 1. The number is read by a person standing at a
#: counter ("till 2 is the one by the door"), so it starts where people count from.
DEFAULT_SHOP_REGISTER_SEQUENCE_START = 1


class ShopRegisterSequence(Base):
    """
    Per-shop counter for register numbers — till 1, 2, 3 in a branch.

    The next number to hand out, not the highest one in use. That difference is the
    whole point: a counter only ever moves forward, so when the shop's top till is
    retired or removed its number stays spent. `max(pos_number) + 1` would issue that
    number again to the next till, and a document that says "register 3" would then
    name two physical machines.

    Incremented under `SELECT … FOR UPDATE` in the same transaction as the assignment,
    like `shop_z_sequences`, and for the same reason it is not a Postgres SEQUENCE: a
    pairing that rolls back must not burn a number. A separate table rather than a
    column on `shops`, so that allocating a number locks this row and not the shop row
    every settings save and profile edit also writes.

    `ON DELETE CASCADE`: a shop can only be deleted while nothing else references it —
    no transactions, no Z reports — which means no document ever carried one of its
    register numbers, so its run has nothing left to protect.
    """

    __tablename__ = "shop_register_sequences"

    shop_id = Column(
        UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), primary_key=True
    )
    next_value = Column(
        BigInteger, nullable=False, default=DEFAULT_SHOP_REGISTER_SEQUENCE_START
    )
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
