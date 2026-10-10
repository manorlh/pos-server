"""
A participant of a local shop Z that is not on the shop's LAN — closed through the cloud.

docs/SPEC_INDEPENDENT_TILL.md §8.14. In local mode the main till closes every participating
till over the LAN (§8.3). A till or kiosk at another location (its own internet, set
"מרוחק (דרך הענן)" in the "קופות בזד הסניפי" card) cannot hear it there, so the main till
asks the cloud: one row per request, handed to that machine on its heartbeat
(`pendingShopZPart`). The machine closes its shift with the same rules as a LAN close,
builds its part (its section and manifest, §8.12) and uploads it here; the main till pulls
it and includes it in the local shop Z — the same answer it would have had over the LAN.

`request_id` is the main till's request for that machine in that round (a "נסה שוב" makes
a new one); the machine closes for it at most once (its shift carries the id).
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class ShopZRemotePart(Base):
    __tablename__ = "shop_z_remote_parts"
    __table_args__ = (
        Index("ix_shop_z_remote_parts_machine_state", "machine_id", "state"),
        Index("ix_shop_z_remote_parts_shop_round", "shop_id", "round_id"),
        Index("uq_shop_z_remote_parts_request", "request_id", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False)
    #: The remote participant asked to close.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: The main till that asked.
    main_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    round_id = Column(String(64), nullable=False)
    request_id = Column(String(64), nullable=False)
    force = Column(Boolean, nullable=False, default=True, server_default="true")
    #: requested → delivered → reported → taken; or superseded (a new request for the
    #: machine), cancelled, expired.
    state = Column(String(16), nullable=False, default="requested", server_default="requested")
    #: The machine's latest answer: closed | no_open_shift | waiting_card | blocked_payment |
    #: blocked_tables | failed (the LAN close's outcomes).
    outcome = Column(String(24), nullable=True)
    message = Column(Text, nullable=True)
    #: The machine's report as it sent it — `{requestId, roundId, machineId, outcome, shiftId,
    #: message, section}`, the section with its manifest — handed to the main till as is.
    report = Column(JSONB, nullable=True)
    requested_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    reported_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    #: The local shop Z that took the part.
    z_report_id = Column(UUID(as_uuid=True), nullable=True)
