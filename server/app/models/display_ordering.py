"""
"סדר תצוגה" — one ordering model for the four channels (specs/digital-menu-ordering-cards-plan.md §5,
app/services/display_ordering.py, the pure rule app/services/display_ordering_rules.py).

* `display_orderings` — a named ordering: the categories' order, each category's products, the
  pinned ones, where new items go, and an optimistic `version`. `legacy_flat` keeps the tills' flat
  list it was read from (or last wrote), so writing back keeps its interleaving.
* `display_ordering_bindings` — which ordering a channel uses at a level (tenant / company / shop /
  area / machine / profile). Several bindings on one ordering = "מקושר" (they move together);
  one binding on its own ordering = "עצמאי"; "הועתק פעם אחת" = a binding on a copy, with
  `copied_from_ordering_id` / `copied_at` (information only — no link after it).

A binding of the tills or the kiosks is written through to the keys they read today
(`productOrder` / `categoryOrder` in the settings layers, `catalog.*` in the kiosk layers) on every
save, so no till or kiosk needs to change. `legacy_hash` is the hash of those keys as last written
or read, to notice a write that did not go through the ordering.
"""
import uuid

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: Where a binding is set, widest first.
BINDING_LEVELS = ("tenant", "company", "shop", "area", "machine", "profile")
BINDING_CHANNELS = ("pos", "kiosk", "online", "menu")


class DisplayOrdering(Base):
    __tablename__ = "display_orderings"
    __table_args__ = (Index("ix_display_orderings_tenant", "tenant_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(120), nullable=True)
    #: Category ids in order ([] = the catalog's own order).
    categories = Column(JSON, nullable=False, default=list)
    #: `{category id: [product ids]}`.
    products = Column(JSON, nullable=False, default=dict)
    #: `{"categories": [ids], "products": {category id: [ids]}}` — first, in this order.
    pinned = Column(JSON, nullable=False, default=dict)
    #: "end" (after the positioned ones, in the catalog's order) or "by_name".
    new_items = Column(String(16), nullable=False, default="end", server_default="end")
    #: The tills' flat `productOrder` this was read from / last written as.
    legacy_flat = Column(JSON, nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class DisplayOrderingBinding(Base):
    __tablename__ = "display_ordering_bindings"
    __table_args__ = (
        CheckConstraint(
            "level IN ('tenant', 'company', 'shop', 'area', 'machine', 'profile')",
            name="ck_display_ordering_bindings_level",
        ),
        CheckConstraint(
            "channel IN ('pos', 'kiosk', 'online', 'menu')", name="ck_display_ordering_bindings_channel",
        ),
        UniqueConstraint("tenant_id", "level", "target_id", "channel", name="uq_display_ordering_bindings"),
        Index("ix_display_ordering_bindings_ordering", "ordering_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    level = Column(String(16), nullable=False)
    #: The tenant, company, shop, point of sale, device or profile (by `level`). Not a key: polymorphic.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    channel = Column(String(8), nullable=False)
    ordering_id = Column(UUID(as_uuid=True), ForeignKey("display_orderings.id", ondelete="CASCADE"), nullable=False)
    #: "הועתק פעם אחת": the ordering this one was copied from, and when (information only).
    copied_from_ordering_id = Column(UUID(as_uuid=True), nullable=True)
    copied_at = Column(DateTime(timezone=True), nullable=True)
    #: The hash of the device keys at this level as last written / read (tills and kiosks only).
    legacy_hash = Column(String(64), nullable=True)
    updated_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
