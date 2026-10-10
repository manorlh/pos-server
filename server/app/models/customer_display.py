"""
"מסך לקוח" — the cloud relay of a till's customer screen (app/services/customer_display.py).

One row per till: the latest state it published for a paired customer display that cannot
reach it over the shop's LAN (a browser at `/display`, or an Android display on another
network). Replaced on every push, never a history; `seq` grows by one per push so a display
asks only for what is newer. Holds only what the customer sees on the screen anyway.
"""
from sqlalchemy import BigInteger, Column, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class CustomerDisplayState(Base):
    __tablename__ = "customer_display_states"

    till_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True
    )
    seq = Column(BigInteger, nullable=False, default=0, server_default="0")
    state = Column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
