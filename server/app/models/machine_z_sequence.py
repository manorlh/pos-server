from sqlalchemy import Column, DateTime, ForeignKey, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class MachineZSequence(Base):
    """
    Per-till counter for till Z numbers (docs/SHIFTS_API.md §5, `zMode = till`).

    The same pattern as `ShopZSequence`, for the same reason: a row incremented under
    `SELECT … FOR UPDATE` in the transaction that inserts the Z, never a Postgres
    SEQUENCE — `nextval()` survives a rollback, and a hole in a till's run must mean "a
    Z is missing", not "a request failed and was retried".

    `last_number` is the last number issued (0 = none yet), so the next Z is
    `last_number + 1` and a till's first Z is 1. The row is also the lock every till Z of
    the till — and a change of its `z_mode` — serialises on: two requests of one till at
    once take turns, and the second sees the first's Z.

    Independent of the shop's numbering and never reset: a till switched to `cloud` and
    back continues its run.
    """

    __tablename__ = "machine_z_sequences"

    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), primary_key=True)
    last_number = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
