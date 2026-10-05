"""
Promotions ("מבצעים"): defined in the cloud, pulled by the tills, computed on the till.

* `promotions` — one promotion: its type and the type's parameters (`config`), when it
  runs (dates, weekdays, an hour window that may cross midnight), where it runs (a list
  of companies / shops / areas / tills — none is the whole organization), how often it
  may apply in one sale, and its priority. Paused promotions are kept but not sent.
* `transaction_promotions` — what a promotion took off one document, as the till
  reported it: how many times it applied and the money. What the promotions report
  and the Z read. The per-line share is on `transaction_items.promotion_discount`.

See app/services/promotions.py for the rules and docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1.
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
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The seven kinds of promotion (spec §1.3), in the order the dashboard lists them.
PROMOTION_TYPES = (
    "buy_x_get_y",  # 1+1, 2+1: every X units, the Y cheapest free (or N% off)
    "bundle_price",  # 3 for ₪20
    "discount",  # 20% (or ₪5) off every unit of the group
    "threshold_gift",  # spend ₪100 → a gift product (offered by the till)
    "threshold_item_price",  # spend ₪100 → one item of a group at a special price
    "threshold_basket_discount",  # spend ₪200 → 10% (or ₪20) off the basket
    "combo",  # hot dog + drink for ₪30
)

#: Where a promotion runs, widest first — the till parameters' levels.
PROMOTION_SCOPE_LEVELS = ("company", "shop", "area", "machine")


class Promotion(Base):
    __tablename__ = "promotions"
    __table_args__ = (
        CheckConstraint(
            "promo_type IN ('buy_x_get_y', 'bundle_price', 'discount', 'threshold_gift', "
            "'threshold_item_price', 'threshold_basket_discount', 'combo')",
            name="ck_promotions_type",
        ),
        Index("ix_promotions_tenant_updated", "tenant_id", "updated_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    promo_type = Column(String(32), nullable=False)
    #: The type's parameters and groups, validated by `app.schemas.promotion`. Category
    #: ids are stored as chosen; the till receives them with their sub-categories added.
    config = Column(JSON, nullable=False)
    #: `[{"type": "company"|"shop"|"area"|"machine", "id": "<uuid>"}]`. Empty / null:
    #: every till of the organization. A company means its whole group.
    scopes = Column(JSON, nullable=True)

    #: Local dates (the shop's), inclusive. Null: open-ended.
    valid_from = Column(Date, nullable=True)
    valid_to = Column(Date, nullable=True)
    #: Weekdays as a list of ints, 0 = Sunday (א׳) … 6 = Saturday (ש׳). Null: every day.
    weekdays = Column(JSON, nullable=True)
    #: "HH:MM" local; both or neither. `end_time` < `start_time` crosses midnight
    #: (22:00–02:00), and the hours after midnight belong to the day it started.
    start_time = Column(String(5), nullable=True)
    end_time = Column(String(5), nullable=True)

    #: How many times it may apply in one sale. Null: no limit (threshold types: once).
    max_applications = Column(Integer, nullable=True)
    #: Higher wins first. Within one priority the till picks what is best for the customer.
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    is_paused = Column(Boolean, nullable=False, default=False, server_default="false")

    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class TransactionPromotion(Base):
    """One promotion on one document: how often it applied there and what it took off."""

    __tablename__ = "transaction_promotions"
    __table_args__ = (
        Index("ix_transaction_promotions_transaction", "transaction_id"),
        Index("ix_transaction_promotions_promotion", "promotion_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transaction_id = Column(
        UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
    )
    #: Not a foreign key: a document keeps naming a promotion that was deleted since.
    promotion_id = Column(UUID(as_uuid=True), nullable=True)
    #: As printed on the receipt, kept with the document like a line's product name.
    promotion_name = Column(String(120), nullable=True)
    promotion_type = Column(String(32), nullable=True)
    applications = Column(Integer, nullable=False, default=1, server_default="1")
    discount_amount = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")
