import uuid

from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PairingCode(Base):
    __tablename__ = "pairing_codes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(50), unique=True, nullable=False, index=True)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)

    #: A terminal this code *replaces*.
    #:
    #: Normally validating a pairing code creates a new machine row. When this is set the
    #: new device adopts the named row instead — same id, same machine_code, same shop,
    #: same register number — so a terminal swapped out on the counter keeps the identity
    #: its documents and its shop's reporting already refer to. Pairing bumps
    #: `token_version` on adoption, which kills every token the dead unit held.
    target_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True
    )
    #: A replacement code created although the till still held untransmitted card sales
    #: (docs/SHIFTS_API.md §4.9): who accepted that they will not be transmitted by the
    #: new device, and when. Its adoption is then not refused for them.
    untransmitted_acknowledged_by_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    untransmitted_acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    #: The hardware the code was generated for ("N55F" | "MODO" | "P18"), copied onto the machine
    #: when a device redeems it. Null leaves the machine's model as it is.
    device_model = Column(String(16), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, default=False, nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    # Relationships
    distributor = relationship("User", foreign_keys=[distributor_id])
    pos_machine = relationship("POSMachine", foreign_keys=[pos_machine_id])
