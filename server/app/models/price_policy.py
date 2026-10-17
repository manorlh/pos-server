"""
"מדיניות מחירים של הרשת" and "יומן שינויי מחיר" (P:/specs/chain-areas.md §9).

* `price_policies` — one row per company: who below the chain may change prices (`editors`), per-shop exceptions,
  products / categories whose price the chain locked, and the allowed range around the chain's price. No row =
  `editors = "area"`, nothing locked, no range: today's behaviour. Along a chain of companies the strictest row
  applies (app/services/price_policy.py).
* `price_changes` — every price written, at any level, from the dashboard or a till: who, where, old → new.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Numeric, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class PricePolicy(Base):
    __tablename__ = "price_policies"

    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    #: "chain" | "shop" | "area" — the lowest level whose managers may set prices.
    editors = Column(String(10), nullable=False, default="area", server_default="area")
    #: `{shop_id: "chain" | "shop" | "area"}` — a shop's own exception (still no looser than a parent's policy).
    shop_editors = Column(JSONB, nullable=True)
    #: Product / category ids (strings) whose price only the chain sets.
    locked_product_ids = Column(JSONB, nullable=True)
    locked_category_ids = Column(JSONB, nullable=True)
    #: Allowed distance from the chain's price, in percent, for a price set below the chain; null = any.
    max_delta_pct = Column(Numeric(6, 2), nullable=True)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PriceChange(Base):
    __tablename__ = "price_changes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    #: "base" (the chain's, `products.price`) | "shop" | "area"
    level = Column(String(10), nullable=False)
    #: The shop / point of sale (null for "base").
    target_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    old_price = Column(Numeric(10, 2), nullable=True)
    new_price = Column(Numeric(10, 2), nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    #: "dashboard" | "till"
    source = Column(String(12), nullable=False, default="dashboard", server_default="dashboard")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)
