"""
"עיצוב קופה" — the till design config as PARTIAL override layers (docs/SPEC_TILL_DESIGN.md).

`till_design_settings`: one row per company, shop, point of sale (area) or till that set
anything. The effective config a till gets is DEFAULTS ⊕ company ⊕ shop ⊕ area ⊕ machine
(app/services/till_design.py). The overrides are camelCase JSON, exactly as on the wire;
`null` values are never stored (a null in a layer means "inherit").
"""
import uuid

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base
from app.models.kiosk import KioskJSON

TILL_DESIGN_LEVELS = ("company", "shop", "area", "machine")


class TillDesignSettings(Base):
    """One partial layer of the till design. Exactly one of the four ids is set."""

    __tablename__ = "till_design_settings"
    __table_args__ = (
        UniqueConstraint("level", "company_id", "shop_id", "area_id", "machine_id", name="uq_till_design_settings_scope"),
        CheckConstraint("level IN ('company', 'shop', 'area', 'machine')", name="ck_till_design_settings_level"),
        # NULLs compare distinct in the constraint above: one partial unique index per level.
        Index(
            "uq_till_design_settings_company", "company_id", unique=True,
            postgresql_where=text("level = 'company'"), sqlite_where=text("level = 'company'"),
        ),
        Index(
            "uq_till_design_settings_shop", "shop_id", unique=True,
            postgresql_where=text("level = 'shop'"), sqlite_where=text("level = 'shop'"),
        ),
        Index(
            "uq_till_design_settings_area", "area_id", unique=True,
            postgresql_where=text("level = 'area'"), sqlite_where=text("level = 'area'"),
        ),
        Index(
            "uq_till_design_settings_machine", "machine_id", unique=True,
            postgresql_where=text("level = 'machine'"), sqlite_where=text("level = 'machine'"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    level = Column(String(16), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True)
    #: The partial layer, camelCase as on the wire.
    overrides = Column(KioskJSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
