import uuid
import enum

from sqlalchemy import Column, String, ForeignKey, JSON, Enum as SQLEnum, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class DevicePairingStatus(str, enum.Enum):
    WAITING = "waiting"
    CLAIMED = "claimed"
    DELIVERED = "delivered"
    EXPIRED = "expired"


class DevicePairingRequest(Base):
    """POS device waiting for mobile claim; nonce correlates poll + claim."""

    __tablename__ = "device_pairing_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_nonce = Column(String(128), unique=True, nullable=False, index=True)
    status = Column(
        SQLEnum(DevicePairingStatus, name="devicepairingstatus", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=DevicePairingStatus.WAITING,
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
    device_info = Column(JSON, nullable=True)
    machine_name = Column(String(255), nullable=True)
    pairing_session_id = Column(UUID(as_uuid=True), ForeignKey("pairing_sessions.id"), nullable=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    credentials_payload = Column(JSON, nullable=True)
    claimed_at = Column(DateTime(timezone=True), nullable=True)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    pairing_session = relationship("PairingSession", foreign_keys=[pairing_session_id])
    pos_machine = relationship("POSMachine", foreign_keys=[pos_machine_id])
