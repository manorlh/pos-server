import uuid

from sqlalchemy import Column, Date, String, Boolean, ForeignKey, DateTime, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Company(Base):
    __tablename__ = "companies"
    __table_args__ = (
        UniqueConstraint("tenant_id", "company_number", name="uq_companies_tenant_company_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    # Organizational nesting only: a holding group owning several trading companies.
    # It must never change which entity a fiscal document is attributed to — this row
    # is the one holding the ח.פ. See app/services/company_hierarchy.py.
    parent_company_id = Column(
        UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True
    )
    name = Column(String(255), nullable=False)
    #: Company 1, 2, 3 in its tenant, from `org_number_sequences`, never reused
    #: (`app.services.org_numbers`). Null only for a company with no tenant.
    company_number = Column(Integer, nullable=True)
    vat_number = Column(String(20), nullable=True)       # Israeli ח.פ / ע.מ
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    #: "permanent" | "temporary" — a short-term customer or a one-off event. A temporary
    #: one stops selling after `license_expires_on` (app/services/licenses.py). Set by
    #: the super admin only.
    license_type = Column(String(16), nullable=False, default="permanent", server_default="permanent")
    license_expires_on = Column(Date, nullable=True)
    #: "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md, app/services/dealer_types.py):
    #: "company" (חברה בע״מ, the default — today's behaviour), "licensed" (עוסק מורשה)
    #: or "exempt" (עוסק פטור: receipts only, no VAT). Reaches the till as
    #: `businessInfo.dealerType` and `settings.dealerType`. A change applies to new
    #: documents only; who changed it and when is kept below.
    dealer_type = Column(String(16), nullable=False, default="company", server_default="company")
    dealer_type_changed_at = Column(DateTime(timezone=True), nullable=True)
    dealer_type_changed_by = Column(UUID(as_uuid=True), nullable=True)
    #: Every change, oldest first: `{from, to, at, by, byName}`. Appended, never rewritten.
    dealer_type_history = Column(JSONB, nullable=False, default=list, server_default="[]")
    settings = Column(JSONB, nullable=False, server_default="{}")
    settings_updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    parent = relationship(
        "Company",
        remote_side="Company.id",
        foreign_keys=[parent_company_id],
        backref="children",
    )
    shops = relationship("Shop", back_populates="company")
    users = relationship("User", back_populates="company", foreign_keys="User.company_id")
    products = relationship("Product", back_populates="company", foreign_keys="Product.company_id")
    categories = relationship("Category", back_populates="company")
