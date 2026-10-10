"""sales targets and competition ("יעדים ותחרות")

* `sales_targets` — a day (every day, or one date) or event target per shop, point of sale or
  cashier (app/services/sales_targets.py).
* `sales_target_hits` — a target reached in one period, once (the exceptions log's "יעד הושג").

The till leaderboard's switches are built-in till parameters (created at startup) — no DDL.
Idempotent (each table and index is looked at first). Never downgraded in place.

Revision ID: af7b5d2e4c96
Revises: 7c4e2a9d1f63
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "af7b5d2e4c96"
down_revision: Union[str, Sequence[str], None] = "7c4e2a9d1f63"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TARGETS = "sales_targets"
HITS = "sales_target_hits"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(TARGETS):
        op.create_table(
            TARGETS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("scope", sa.String(16), nullable=False),
            sa.Column("area_id", uuid, sa.ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True),
            sa.Column("pos_user_id", uuid, sa.ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=True),
            sa.Column("period", sa.String(16), nullable=False, server_default="day"),
            sa.Column("day", sa.Date(), nullable=True),
            sa.Column("event_id", uuid, sa.ForeignKey("report_events.id", ondelete="CASCADE"), nullable=True),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("day_start", sa.String(5), nullable=False, server_default="08:00"),
            sa.Column("day_end", sa.String(5), nullable=False, server_default="23:00"),
            sa.Column("name", sa.String(120), nullable=True),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        )
    have = _indexes(insp, TARGETS) if insp is not None and insp.has_table(TARGETS) else set()
    for name, cols in (("ix_sales_targets_tenant_id", ["tenant_id"]), ("ix_sales_targets_shop", ["shop_id", "archived_at"])):
        if name not in have:
            op.create_index(name, TARGETS, cols)

    if insp is None or not insp.has_table(HITS):
        op.create_table(
            HITS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("target_id", uuid, sa.ForeignKey("sales_targets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("pos_user_id", uuid, nullable=True),
            sa.Column("period_key", sa.String(64), nullable=False),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("actual", sa.Numeric(12, 2), nullable=False),
            sa.Column("label", sa.String(200), nullable=True),
            sa.Column("reached_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("target_id", "period_key", name="uq_sales_target_hit_period"),
        )
    have = _indexes(insp, HITS) if insp is not None and insp.has_table(HITS) else set()
    for name, cols in (
        ("ix_sales_target_hits_tenant_id", ["tenant_id"]),
        ("ix_sales_target_hits_target_id", ["target_id"]),
        ("ix_sales_target_hits_shop_id", ["shop_id"]),
    ):
        if name not in have:
            op.create_index(name, HITS, cols)


def downgrade() -> None:
    op.drop_table(HITS)
    op.drop_table(TARGETS)
