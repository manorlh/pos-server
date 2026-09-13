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
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, default=False, nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    # Relationships
    distributor = relationship("User", foreign_keys=[distributor_id])
    pos_machine = relationship("POSMachine", foreign_keys=[pos_machine_id])
