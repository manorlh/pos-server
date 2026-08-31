import uuid

from sqlalchemy import (
    Column, String, Boolean, ForeignKey, DateTime, Index, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class Customer(Base):
    """
    A named business or private customer — tenant-scoped, like `Voucher`.

    Scoped to the tenant rather than the shop because a חשבונית מס is issued by the
    business, not by the branch: the same ח.פ. buys at any of the merchant's shops
    and must appear as one customer on one set of books. It also matches how the
    catalog already reaches the till (products/categories/vouchers are resolved per
    tenant and shipped to every machine of that tenant).

    `vat_number` is the ח.פ. / ע.מ. and is what turns a receipt into a tax invoice,
    so it is stored as typed, digits and all: normalising or check-digit-validating
    it here would reject the legitimate cases this system has to carry — a foreign
    company with a non-Israeli registration, or an אישור עוסק פטור. It is validated
    only far enough to be usable (see `app/schemas/customer.py`).
    """

    __tablename__ = "customers"
    __table_args__ = (
        # Two customers with the same ח.פ. inside one tenant are the same legal
        # entity entered twice, and a tax invoice raised against the wrong one of the
        # pair is not correctable after the fact. A plain UNIQUE is enough rather than
        # a partial index: in Postgres NULLs never collide under a unique constraint,
        # and most customers — every walk-in with a phone number and nothing else —
        # have no VAT number at all.
        UniqueConstraint("tenant_id", "vat_number", name="uq_customer_vat_tenant"),
        Index("ix_customers_tenant_name", "tenant_id", "name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    name = Column(String(255), nullable=False)
    vat_number = Column(String(20), nullable=True, index=True)
    phone = Column(String(30), nullable=True)
    email = Column(String(255), nullable=True)

    # Address is kept as separate parts, not one free-text blob, because the
    # OpenFormat customer fields on the C100 document record are separate fields
    # (street / house number / city / postcode / country) and a single line cannot
    # be split back into them reliably.
    address = Column(String(255), nullable=True)
    address_number = Column(String(20), nullable=True)
    city = Column(String(100), nullable=True)
    postal_code = Column(String(20), nullable=True)
    country = Column(String(60), nullable=True)

    notes = Column(String(1000), nullable=True)

    is_active = Column(Boolean, default=True, nullable=False, server_default="true")

    # Tombstone, distinct from `is_active`.
    #
    # `is_active=false` is the merchant archiving a customer they no longer sell to;
    # `deleted_at` is the merchant removing them. Both keep the row, because a till
    # that has been offline for a week may still push a sale referencing a customer
    # deleted yesterday — and a document that loses its customer link is a tax
    # invoice that can no longer say who it was issued to. Deletion therefore stops
    # the customer reaching new sales without breaking old ones.
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
