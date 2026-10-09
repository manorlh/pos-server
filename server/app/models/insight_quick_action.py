"""
"פעולות מהירות" from the insights (docs/SPEC_INSIGHTS.md §10): what a manager did, in one
tap, about a product that barely sells or a till that stands out — and the log of it.

* `insight_quick_actions` — one row per action: a quick message to the tills' cashiers (a
  non-blocking banner, through the till messages, `till_message_ids`) or a quick promotion
  (through the promotions, `promotion_id`) — on a product, a category or the whole basket
  ("מבצע מזדמן", a happy hour) — its target (a company, shop, area, till or a
  report event) and the tills it reached (`machine_ids`), when it started and when it ends
  by itself, and who did it. A cancellation ("בטל מבצע") stamps `cancelled_at`.

It is the audit of these actions (written in the same transaction as the message or the
promotion, never updated except to cancel) and the anchor of their result: the product's
sales on `machine_ids` since `starts_at`, against the same hours before.
"""
import uuid

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, JSON, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

QUICK_ACTION_KINDS = ("message", "promotion")
QUICK_ACTION_TARGETS = ("company", "shop", "area", "machine", "event")


class InsightQuickAction(Base):
    __tablename__ = "insight_quick_actions"
    __table_args__ = (
        CheckConstraint("kind IN ('message', 'promotion')", name="ck_insight_quick_actions_kind"),
        Index("ix_insight_quick_actions_tenant_created", "tenant_id", "created_at"),
        Index("ix_insight_quick_actions_tenant_product", "tenant_id", "product_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: message | promotion
    kind = Column(String(16), nullable=False)
    #: The global product it is about; null for a message about a till (an anomaly).
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="SET NULL"), nullable=True)
    product_name = Column(String(255), nullable=True)
    #: An ad-hoc promotion or a happy hour on a category ("מבצע מזדמן"); both null with no
    #: product either: the whole basket.
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True)
    category_name = Column(String(255), nullable=True)
    #: company | shop | area | machine | event
    target_level = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    target_name = Column(String(255), nullable=True)
    #: The tills it reached, as ids (strings) — fixed when it was sent.
    machine_ids = Column(JSON, nullable=False, default=list)
    #: The till messages it sent (one; one per till for an event).
    till_message_ids = Column(JSON, nullable=True)
    #: The promotion it created. Not a foreign key: the promotion may be deleted later.
    promotion_id = Column(UUID(as_uuid=True), nullable=True)
    #: What was chosen: the text, the offer, the duration, the price and cost it was judged by.
    params = Column(JSON, nullable=True)
    #: Why: "slow" | "dead" | "declining" | "anomaly" | "adhoc" | "happy_hour" | "manual".
    source = Column(String(32), nullable=True)
    starts_at = Column(DateTime(timezone=True), nullable=False)
    #: When it ends by itself (null: until cancelled).
    ends_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
