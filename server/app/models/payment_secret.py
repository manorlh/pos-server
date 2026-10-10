import uuid

from sqlalchemy import Column, DateTime, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The settings layers a payment secret can be set on, least specific first — the same
#: layers as the POS settings (app/services/settings_merge.py).
PAYMENT_SECRET_LEVELS = ("tenant", "company", "shop", "area", "machine")

#: `PaymentIntegrationSecret.origin`: the till paired with its terminal, or typed in the dashboard.
ORIGIN_TILL_PAIRING = "till_pairing"
ORIGIN_DASHBOARD = "dashboard"


class PaymentIntegrationSecret(Base):
    """
    A card integration's secret (the Z-Credit terminal password), on one settings layer.

    Kept out of the layers' `settings` JSON on purpose: that JSON is read back by the
    dashboard and by every report that dumps a layer, and a password must never travel
    there. The value is encrypted at rest (app/services/payment_secrets.py); the only
    reader of the clear text is the till's own authenticated settings sync.
    """

    __tablename__ = "payment_integration_secrets"
    __table_args__ = (
        UniqueConstraint("level", "entity_id", "key", name="uq_payment_integration_secrets_layer_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: "tenant" | "company" | "shop" | "area" | "machine" (PAYMENT_SECRET_LEVELS).
    level = Column(String(16), nullable=False)
    #: The id of the tenant, company, shop, area or till the secret is set on.
    entity_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    #: The settings key it stands for, e.g. "zcreditPassword".
    key = Column(String(64), nullable=False)
    #: Fernet token; never the clear text.
    ciphertext = Column(Text, nullable=False)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # ── Where the value came from (docs/SPEC_SYNQPAY.md §2.2) ──────────────────
    #: "till_pairing" (the till paired with its SynqPay terminal) or "dashboard" (typed by
    #: hand); null for a row written before this was kept.
    origin = Column(String(16), nullable=True)
    #: The till pairing: when, by which till, on whose authority (a till manager, or a cloud
    #: account's grant), and the terminal's serial number.
    paired_at = Column(DateTime(timezone=True), nullable=True)
    paired_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    paired_by_pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    paired_by_user_id = Column(UUID(as_uuid=True), nullable=True)
    terminal_serial = Column(String(32), nullable=True)
    #: The terminal refused this value (HTTP 401 / NOT_AUTHENTICATED), as a till reported it.
    #: A new value clears it.
    rejected_at = Column(DateTime(timezone=True), nullable=True)
    rejected_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
