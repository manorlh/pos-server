"""
"עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md): a named, partial kiosk config layer of design
groups only (look, layout, attract, texts…), kept per company — shared to its shops — or per shop.

A kiosk settings layer (`kiosk_settings`, any level) may assign one (`design_id`) or say "no design"
(`design_off`); the nearest assignment along the kiosk's path wins and sits right before that level's own
overrides (app/services/kiosk_designs.py `compose`). The kiosks still receive one merged config.
"""
import uuid

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

DesignJSON = JSON().with_variant(JSONB(), "postgresql")


class KioskDesign(Base):
    """One saved design. `shop_id` set: that shop's own; else the company's (every shop of it)."""

    __tablename__ = "kiosk_designs"
    __table_args__ = (Index("ix_kiosk_designs_company", "company_id", "shop_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(80), nullable=False)
    #: The design groups it carries (kiosk_designs.GROUPS ids). Only their paths are ever stored or applied.
    groups = Column(DesignJSON, nullable=False, default=list)
    #: The partial layer, camelCase as on the wire, validated by kiosk_config.SCHEMA.
    overrides = Column(DesignJSON, nullable=False, default=dict)
    #: Bumped on every change: a save from an older copy is refused (409 `kiosk_design_changed`).
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class KioskDesignAudit(Base):
    """Who did what to a design or an assignment. Kept after the design is deleted (no FK on design_id)."""

    __tablename__ = "kiosk_design_audit"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    design_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    #: create | update | rename | duplicate | archive | restore | delete | assign
    action = Column(String(20), nullable=False)
    design_name = Column(String(80), nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    detail = Column(DesignJSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
