"""
"תפריטים" — named sales menus ("בוקר", "צהריים", "הפי האוור", "קיוסק"), docs/SPEC_MENUS.md.

Not the modifier layer of app/models/menu.py ("menu" there is what a dish is ordered
with): a catalog menu decides *what is sold, in what order and at what price* while it is
active, on the tills and kiosks it is assigned to.

* `catalog_menus` — the menu itself: placed on a company (null: the whole organization),
  its channel (till / kiosk / both), its schedule (weekdays and hour ranges that may cross
  midnight, an optional date range, or "always") and whether it is on at all.
* `catalog_menu_categories` — the categories it shows, in its order; each either with all
  of its products or only the ones listed in `catalog_menu_products`.
* `catalog_menu_products` — products in the menu's order, with an optional price that
  applies only while the menu is active (VAT follows the product).
* `catalog_menu_assignments` — which menus a company, shop, point of sale (area) or till
  gets, several per level, with a priority among menus of the same level.
* `catalog_menu_fallbacks` — what a till sells when no menu is active: the full catalog
  (the default) or nothing. Per level; the most specific level that says wins.
* `catalog_menu_sync_state` — when the organization's menus last changed (deletes
  included): what decides whether a delta catalog pull carries the `catalogMenus` block.

The rules are in app/services/catalog_menu_rules.py (pure, shared with the till by golden
fixtures) and app/services/catalog_menus.py.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: Where a menu is offered: the tills' sell screen, the self-order kiosk, or both.
MENU_CHANNELS = ("pos", "kiosk", "both")
#: Assignment levels, widest first — the till parameters' levels.
ASSIGNMENT_LEVELS = ("company", "shop", "area", "machine")
#: What a till sells when no menu is active.
FALLBACK_CATALOG = "catalog"
FALLBACK_NONE = "none"
FALLBACK_MODES = (FALLBACK_CATALOG, FALLBACK_NONE)


class CatalogMenu(Base):
    __tablename__ = "catalog_menus"
    __table_args__ = (
        CheckConstraint("channel IN ('pos', 'kiosk', 'both')", name="ck_catalog_menus_channel"),
        Index("ix_catalog_menus_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: Null: the whole organization. Set: that company and every company under it.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(80), nullable=False)
    channel = Column(String(8), nullable=False, default="both", server_default="both")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Active at any hour of any day (the date range, when set, still applies).
    always = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Weekdays as a list of ints, 0 = Sunday (א׳) … 6 = Saturday (ש׳). Null: every day.
    weekdays = Column(JSON, nullable=True)
    #: `[{"start": "HH:MM", "end": "HH:MM"}]`, local. `end` <= `start` crosses midnight
    #: (22:00–02:00, and 00:00–00:00 is the whole day); the hours after midnight belong
    #: to the day the range started. Null / empty: the whole day.
    time_ranges = Column(JSON, nullable=True)
    #: Local dates (the shop's), inclusive. Null: open-ended.
    valid_from = Column(Date, nullable=True)
    valid_to = Column(Date, nullable=True)
    #: A colour for the dashboard's chips ("#F59E0B"); nothing reads it on the till.
    color = Column(String(16), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CatalogMenuCategory(Base):
    __tablename__ = "catalog_menu_categories"
    __table_args__ = (
        UniqueConstraint("menu_id", "category_id", name="uq_catalog_menu_categories"),
        Index("ix_catalog_menu_categories_menu", "menu_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    menu_id = Column(UUID(as_uuid=True), ForeignKey("catalog_menus.id", ondelete="CASCADE"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    #: Every product of the category (the listed ones first, in their order). False: only
    #: the products listed for the menu.
    all_products = Column(Boolean, nullable=False, default=True, server_default="true")


class CatalogMenuProduct(Base):
    __tablename__ = "catalog_menu_products"
    __table_args__ = (
        UniqueConstraint("menu_id", "product_id", name="uq_catalog_menu_products"),
        Index("ix_catalog_menu_products_menu", "menu_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    menu_id = Column(UUID(as_uuid=True), ForeignKey("catalog_menus.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    #: The price while the menu is active (VAT follows the product). Null: the catalog's
    #: (the shop's) price.
    price = Column(Numeric(12, 2), nullable=True)


class CatalogMenuAssignment(Base):
    __tablename__ = "catalog_menu_assignments"
    __table_args__ = (
        CheckConstraint(
            "level IN ('company', 'shop', 'area', 'machine')", name="ck_catalog_menu_assignments_level",
        ),
        UniqueConstraint("menu_id", "level", "target_id", name="uq_catalog_menu_assignments"),
        Index("ix_catalog_menu_assignments_target", "tenant_id", "level", "target_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    menu_id = Column(UUID(as_uuid=True), ForeignKey("catalog_menus.id", ondelete="CASCADE"), nullable=False)
    level = Column(String(16), nullable=False)
    #: The company, shop, area or till (by `level`). Not a key: polymorphic.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: Among menus of the same level active at the same moment, the higher wins.
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CatalogMenuFallback(Base):
    __tablename__ = "catalog_menu_fallbacks"
    __table_args__ = (
        CheckConstraint(
            "level IN ('company', 'shop', 'area', 'machine')", name="ck_catalog_menu_fallbacks_level",
        ),
        CheckConstraint("mode IN ('catalog', 'none')", name="ck_catalog_menu_fallbacks_mode"),
        UniqueConstraint("level", "target_id", name="uq_catalog_menu_fallbacks"),
        Index("ix_catalog_menu_fallbacks_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    level = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: FALLBACK_MODES: "הקטלוג המלא" / "לא למכור".
    mode = Column(String(16), nullable=False)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CatalogMenuSyncState(Base):
    """When an organization's menus, assignments or fallbacks last changed."""

    __tablename__ = "catalog_menu_sync_state"

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    changed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
