import uuid
import enum

from sqlalchemy import (
    Column, String, Boolean, ForeignKey, Integer,
    Enum as SQLEnum, DateTime, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PosUserRole(str, enum.Enum):
    """Subset of UserRole suitable for till operators. Dashboard-only roles are intentionally absent."""
    CASHIER = "cashier"
    SHOP_MANAGER = "shop_manager"


class PosUser(Base):
    """
    A till operator (cashier / shop manager) belonging to one shop.

    Distinct from `users` (dashboard accounts). PIN is bcrypt-hashed on the cloud and
    the hash is shipped to assigned POS machines so login works fully offline.
    """

    __tablename__ = "pos_users"
    __table_args__ = (
        UniqueConstraint("shop_id", "username", name="uq_pos_user_shop_username"),
        Index("ix_pos_users_shop_updated", "shop_id", "updated_at"),
        # Partial UNIQUE on (shop_id, worker_number) is created by the Alembic migration
        # because partial indexes are PostgreSQL-specific and cleanest when expressed in DDL.
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)

    username = Column(String(64), nullable=False)
    first_name = Column(String(100), nullable=True)
    last_name = Column(String(100), nullable=True)
    worker_number = Column(String(32), nullable=True)

    pin_hash = Column(String(255), nullable=False)
    role = Column(
        SQLEnum(PosUserRole, name="posuserrole", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=PosUserRole.CASHIER,
    )

    is_active = Column(Boolean, nullable=False, default=True)

    #: The employee's job title ("מלצר", "ברמן"…; app/models/attendance.py `EmployeeRole`),
    #: for attendance and phase 2's tip weights. Never a permission — that is `role`.
    employee_role_id = Column(
        UUID(as_uuid=True), ForeignKey("employee_roles.id", ondelete="SET NULL"), nullable=True
    )

    #: The till role ("תפקידים והרשאות", app/models/till_role.py): what this person may do
    #: at a till. Null — not assigned yet: they keep the legacy role matching `role`
    #: exactly as before roles existed. `role` itself stays what older tills read; it is
    #: kept equal to the assigned role's `legacy_role` (app/services/till_roles.py).
    till_role_id = Column(
        UUID(as_uuid=True), ForeignKey("till_roles.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Per-user exceptions to the role: `{"states": {code: state}, "limits": {code: {...}}}`.
    permission_overrides = Column(JSONB, nullable=True)

    #: Wrong PINs typed at an *elevation* prompt, and the lockout they earn.
    #:
    #: Only the cloud-checked path counts here. The till's own sign-in verifies the same
    #: PIN offline against the synced hash and cannot report to anyone; that is the
    #: price of a till that works without a network, and a lockout here does not pretend
    #: to close it. What it does stop is guessing a manager's PIN through the approval
    #: prompt from a till that is online, which is otherwise unlimited.
    pin_failed_count = Column(Integer, nullable=False, default=0, server_default="0")
    pin_locked_until = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop")
    till_role = relationship("TillRole", foreign_keys=[till_role_id], lazy="select")
