import uuid
import enum

from sqlalchemy import Column, String, Boolean, ForeignKey, JSON, Enum as SQLEnum, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PairingStatus(str, enum.Enum):
    UNPAIRED = "unpaired"
    PAIRED = "paired"
    ASSIGNED = "assigned"


class POSMachine(Base):
    __tablename__ = "pos_machines"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name = Column(String(255), nullable=False)
    machine_code = Column(String(100), unique=True, nullable=False, index=True)
    mqtt_client_id = Column(String(255), unique=True, nullable=True)
    pairing_status = Column(SQLEnum(PairingStatus, values_callable=lambda x: [e.value for e in x]), nullable=False, default=PairingStatus.UNPAIRED)
    device_info = Column(JSON, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True)
    last_sync_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    merchant = relationship("Merchant", back_populates="machines")
    shop = relationship("Shop", back_populates="machines")
    distributor = relationship("User", foreign_keys=[distributor_id])
    products = relationship("Product", back_populates="pos_machine")
    categories = relationship("Category", back_populates="pos_machine")
