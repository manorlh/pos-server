import uuid
import enum

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Text,
    Enum as SQLEnum, DateTime, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class StockMovementReason(str, enum.Enum):
    SALE = "sale"
    REFUND = "refund"
    GOODS_RECEIPT = "goods_receipt"
    ADJUSTMENT = "adjustment"
    STOCKTAKE = "stocktake"
    WASTAGE = "wastage"


class StockMovement(Base):
    """Append-only inventory ledger entry (idempotent by id)."""

    __tablename__ = "stock_movements"
    __table_args__ = (
        Index("ix_stock_movements_shop_created", "shop_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client- or server-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False, index=True)
    delta = Column(Numeric(12, 3), nullable=False)
    reason = Column(
        SQLEnum(StockMovementReason, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
    )
    transaction_id = Column(UUID(as_uuid=True), ForeignKey("transactions.id"), nullable=True, index=True)
    transaction_item_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True, index=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    note = Column(Text, nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    shop = relationship("Shop")
    product = relationship("Product")
    transaction = relationship("Transaction")
    machine = relationship("POSMachine")
