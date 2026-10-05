"""
"סקירת שינויים לפני שידור לקופות" (docs/SPEC_MENU_BROADCAST_REVIEW.md).

Two tables:

* `catalog_publications` — a shop's broadcast menu versions. While a shop is in review
  mode (the tables module on, or the `menuBroadcastReview` override), its tills are served
  the menu of its latest publication instead of the live catalog tables; the live tables
  are the draft. `snapshot` is exactly what the shop's tills would have been sent at the
  moment of publishing, at shop level (app/services/menu_broadcast.py); the old versions'
  snapshots are dropped after a while, their summary kept for the history list.
  `closed_at` is when the shop was seen out of review mode after this publication: its
  tills then pull the live catalog in full once.
* `shop_work_types` — the shop's "סוגי עבודה" besides tables (Take Away, quick order,
  deliveries). Informational for now: nothing reads them to hide or change anything.
  Tables themselves are the till parameter `tablesMode`, not a column here.
"""
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import deferred
from sqlalchemy.sql import func

from app.database import Base

#: `catalog_publications.kind`: the automatic first version of a shop entering review
#: mode (its live catalog as it stood), or a broadcast someone approved.
KIND_INITIAL = "initial"
KIND_BROADCAST = "broadcast"


class CatalogPublication(Base):
    __tablename__ = "catalog_publications"
    __table_args__ = (
        UniqueConstraint("shop_id", "version", name="uq_catalog_publications_shop_version"),
        Index("ix_catalog_publications_shop_published", "shop_id", "published_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: 1, 2, 3… per shop.
    version = Column(Integer, nullable=False)
    kind = Column(String(16), nullable=False, default=KIND_BROADCAST)
    #: What the shop's tills are served (products, categories, the menu block); null once
    #: pruned from an old version. Deferred: the pull of a shop out of review mode reads
    #: only the newest row's stamps, not its menu.
    snapshot = deferred(Column(JSON(none_as_null=True), nullable=True))
    #: Counts per kind of change against the version before, for the history list.
    summary = Column(JSON, nullable=True)
    #: sha256 of the snapshot's content: "approve" refuses when the draft moved since the
    #: review was shown.
    fingerprint = Column(String(64), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    published_by_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    published_by_name = Column(String(255), nullable=True)
    note = Column(String(500), nullable=True)
    #: The shop was found out of review mode after this version (its tills went live).
    closed_at = Column(DateTime(timezone=True), nullable=True)


class ShopWorkTypes(Base):
    __tablename__ = "shop_work_types"

    shop_id = Column(
        UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id = Column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    take_away = Column(Boolean, nullable=True)
    quick_order = Column(Boolean, nullable=True)
    delivery = Column(Boolean, nullable=True)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    updated_by_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
