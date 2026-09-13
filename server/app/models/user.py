import uuid
import enum

from sqlalchemy import Column, String, Boolean, ForeignKey, Enum as SQLEnum, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    DISTRIBUTOR = "distributor"
    MERCHANT_ADMIN = "merchant_admin"  # legacy DB value; migrated to company_manager
    COMPANY_MANAGER = "company_manager"
    SHOP_MANAGER = "shop_manager"
    #: אחמ"ש — a senior cashier who may authorise the things a cashier may not: a
    #: refund, a discount, closing the day. Deliberately has no dashboard write access
    #: at all; its whole purpose is at the register, through elevation.
    SHIFT_SUPERVISOR = "shift_supervisor"
    CASHIER = "cashier"


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id = Column(String(255), unique=True, nullable=True, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    role = Column(SQLEnum(UserRole, values_callable=lambda x: [e.value for e in x]), nullable=False, default=UserRole.CASHIER)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)

    # ── Till PIN ──────────────────────────────────────────────────────────────
    # A separate credential from cloud sign-in, for authorising actions at a till.
    # It is bcrypt (a human secret, unlike the session token) and it must NEVER be
    # sent to a device: `pos_users.pin_hash` is shipped so shift login works
    # offline, but elevation is verified in the cloud only, so this hash has no
    # reason to leave the server. The sync code next door is easy to imitate by
    # accident — don't.
    till_pin_hash = Column(String(255), nullable=True)
    till_pin_set_at = Column(DateTime(timezone=True), nullable=True)
    # Lockout counters live here, deliberately apart from cloud sign-in: a cashier
    # guessing PINs at a counter must not be able to lock their manager out of the
    # dashboard.
    till_pin_failed_count = Column(Integer, default=0, nullable=False, server_default="0")
    till_pin_locked_until = Column(DateTime(timezone=True), nullable=True)

    @property
    def has_till_pin(self) -> bool:
        """Whether this person can authorise anything at a till. Never the hash."""
        return bool(self.till_pin_hash)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant", foreign_keys=[tenant_id])
    company = relationship("Company", back_populates="users", foreign_keys=[company_id])
    shop = relationship("Shop", back_populates="users", foreign_keys=[shop_id])
    distributor_machines = relationship("POSMachine", back_populates="distributor", foreign_keys="POSMachine.distributor_id")
    tenant_memberships = relationship("TenantMembership", back_populates="user", cascade="all, delete-orphan")
