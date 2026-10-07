import uuid

from sqlalchemy import Column, Date, String, Boolean, ForeignKey, DateTime, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Shop(Base):
    __tablename__ = "shops"
    __table_args__ = (
        UniqueConstraint("company_id", "shop_number", name="uq_shops_company_shop_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    #: Shop 1, 2, 3 in its company, from `org_number_sequences`, never reused; a shop
    #: moved to another company draws that company's next (`app.services.org_numbers`).
    shop_number = Column(Integer, nullable=True)
    #: "קוד סניף" — the branch code the tax export files every document under (field
    #: 1231). Mandatory: digits, 1–7, unique in the company (`app.services.branch_code`).
    #: Nullable only for rows from before the rule; migration f3a9c2d7e1b4 filled those.
    branch_id = Column(String(50), nullable=True)
    #: True for a code migration f3a9c2d7e1b4 assigned on its own, until the shop's code is
    #: next saved. A record only: the code is internal (owner: "קוד סניף אינו למס הכנסה").
    branch_id_auto_assigned = Column(Boolean, nullable=False, default=False, server_default="false")
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    #: "permanent" | "temporary" — a short-term customer or a one-off event. A temporary
    #: one stops selling after `license_expires_on` (app/services/licenses.py). Set by
    #: the super admin only.
    license_type = Column(String(16), nullable=False, default="permanent", server_default="permanent")
    license_expires_on = Column(Date, nullable=True)
    #: "מצב הדרכה" (docs/SPEC_TRAINING_MODE.md, app/services/training_mode.py): the shop's
    #: tills sell for practice — their documents go to `training_documents`, never to the
    #: real tables. Reaches the till as `trainingMode` (GET /machines/me, the settings sync).
    training_mode = Column(Boolean, nullable=False, default=False, server_default="false")
    training_started_at = Column(DateTime(timezone=True), nullable=True)
    training_started_by = Column(UUID(as_uuid=True), nullable=True)
    training_ended_at = Column(DateTime(timezone=True), nullable=True)
    training_ended_by = Column(UUID(as_uuid=True), nullable=True)
    #: "רשת מקומית" (docs/SPEC_LAN_MODE.md §4): the shop works on its LAN through its main
    #: till — with a main till, the shop is in local mode (`local_shop_z.local_mode_of_shop`).
    #: Switched on the shop page's main till card, through the shop Z producer's guard.
    local_network = Column(Boolean, nullable=False, default=False, server_default="false")
    local_network_changed_at = Column(DateTime(timezone=True), nullable=True)
    settings = Column(JSONB, nullable=False, server_default="{}")
    settings_updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    company = relationship("Company", back_populates="shops")
    machines = relationship("POSMachine", back_populates="shop")
    users = relationship("User", back_populates="shop", foreign_keys="User.shop_id")
    products = relationship("Product", back_populates="shop")
    categories = relationship("Category", back_populates="shop")
    product_overrides = relationship(
        "ShopProductOverride", back_populates="shop", cascade="all, delete-orphan"
    )
