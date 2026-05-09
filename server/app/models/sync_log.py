import uuid
import enum

from sqlalchemy import Column, ForeignKey, Enum as SQLEnum, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class SyncDirection(str, enum.Enum):
    SERVER_TO_POS = "server_to_pos"
    POS_TO_SERVER = "pos_to_server"


class SyncEntityType(str, enum.Enum):
    PRODUCTS = "products"
    CATEGORIES = "categories"
    TRANSACTIONS = "transactions"
    Z_REPORT = "z_report"


class SyncAction(str, enum.Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    FULL_SYNC = "full_sync"


class SyncStatus(str, enum.Enum):
    SUCCESS = "success"
    FAILED = "failed"
    CONFLICT_RESOLVED = "conflict_resolved"


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    direction = Column(SQLEnum(SyncDirection, values_callable=lambda x: [e.value for e in x]), nullable=False)
    entity_type = Column(SQLEnum(SyncEntityType, values_callable=lambda x: [e.value for e in x]), nullable=False)
    entity_id = Column(UUID(as_uuid=True), nullable=True)
    action = Column(SQLEnum(SyncAction, values_callable=lambda x: [e.value for e in x]), nullable=False)
    status = Column(SQLEnum(SyncStatus, values_callable=lambda x: [e.value for e in x]), nullable=False, default=SyncStatus.SUCCESS)
    conflict_note = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    # Relationships
    machine = relationship("POSMachine", foreign_keys=[machine_id])
