import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ShopArea(Base):
    """
    An area of a shop — bar, kitchen, terrace — grouping some of its tills
    (docs/AREAS_API.md).

    A filter over the shop's tills, never a fiscal scope of its own: a Z "for an area"
    is an ordinary shop Z whose till list is the area's, under the shop's one Z number.
    Membership is `pos_machines.area_id` and nothing else, and the area's settings layer
    (`settings`, between the shop's and each till's) hangs off that same column.

    **Archived, never deleted.** Shifts, Z runs and Zs keep pointing at the area they
    were stamped with; deleting it would either break those keys or rewrite history.
    The shop's own row going is the one exception (the key cascades), and that is
    only possible for a shop nothing fiscal references.
    """

    __tablename__ = "shop_areas"
    __table_args__ = (
        # One live "Bar" per shop, whatever its case. Archived names are free to be
        # reused: the old area stays in history under its name, a new one takes it.
        Index(
            "uq_shop_areas_shop_live_name",
            "shop_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            # Only so the in-memory SQLite test worlds enforce the same rule.
            sqlite_where=text("archived_at IS NULL"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(
        UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name = Column(String(100), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    archived_at = Column(DateTime(timezone=True), nullable=True)
    # ── POS settings for this point of sale ───────────────────────────────────
    # The layer between the shop and its tills in tenant → company → shop → area → till
    # (`settings_merge`): the same keys, so the bar can take card instalments while the
    # counter does not. Empty for almost every area. `settings_updated_at` NULL means
    # never written, so no till's settings watermark moved when the column was added.
    settings = Column(JSONB, nullable=False, default=dict, server_default="{}")
    settings_updated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Also the tills' settings watermark for the area's name (see the settings sync).
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop")
