"""promotions ("מבצעים"): the promotions, what each took off a document, and the line share

* `promotions` — one promotion: type, parameters (JSON), dates / weekdays / hours,
  scope (companies, shops, areas, tills), max applications, priority, paused.
* `transaction_promotions` — per document and promotion: applications and discount.
* `transaction_items.promotion_discount` / `promotion_id` — the line's share.

Guarded like ae1b2c3d4e5f: the app's `create_all` may already have made the tables, and
a dev database may already have the columns from a previous run of this revision.

Revision ID: b25f6a7b8c93
Revises: b14e5f6a7b82
Create Date: 2026-10-04 02:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "b25f6a7b8c93"
down_revision = "b14e5f6a7b82"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    tables = _existing_tables()
    if "promotions" not in tables:
        op.create_table(
            "promotions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("promo_type", sa.String(32), nullable=False),
            sa.Column("config", sa.JSON(), nullable=False),
            sa.Column("scopes", sa.JSON(), nullable=True),
            sa.Column("valid_from", sa.Date(), nullable=True),
            sa.Column("valid_to", sa.Date(), nullable=True),
            sa.Column("weekdays", sa.JSON(), nullable=True),
            sa.Column("start_time", sa.String(5), nullable=True),
            sa.Column("end_time", sa.String(5), nullable=True),
            sa.Column("max_applications", sa.Integer(), nullable=True),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_paused", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column(
                "created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint(
                "promo_type IN ('buy_x_get_y', 'bundle_price', 'discount', 'threshold_gift', "
                "'threshold_item_price', 'threshold_basket_discount', 'combo')",
                name="ck_promotions_type",
            ),
        )
    indexes = _existing_indexes("promotions", _existing_tables())
    if "ix_promotions_tenant_id" not in indexes:
        op.create_index("ix_promotions_tenant_id", "promotions", ["tenant_id"])
    if "ix_promotions_tenant_updated" not in indexes:
        op.create_index("ix_promotions_tenant_updated", "promotions", ["tenant_id", "updated_at"])

    if "transaction_promotions" not in tables:
        op.create_table(
            "transaction_promotions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "transaction_id", UUID, sa.ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("promotion_id", UUID, nullable=True),
            sa.Column("promotion_name", sa.String(120), nullable=True),
            sa.Column("promotion_type", sa.String(32), nullable=True),
            sa.Column("applications", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("discount_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        )
    indexes = _existing_indexes("transaction_promotions", _existing_tables())
    if "ix_transaction_promotions_transaction" not in indexes:
        op.create_index("ix_transaction_promotions_transaction", "transaction_promotions", ["transaction_id"])
    if "ix_transaction_promotions_promotion" not in indexes:
        op.create_index("ix_transaction_promotions_promotion", "transaction_promotions", ["promotion_id"])

    cols = _existing_columns("transaction_items")
    if "promotion_discount" not in cols:
        op.add_column("transaction_items", sa.Column("promotion_discount", sa.Numeric(12, 2), nullable=True))
    if "promotion_id" not in cols:
        op.add_column("transaction_items", sa.Column("promotion_id", UUID, nullable=True))


def downgrade() -> None:
    op.drop_column("transaction_items", "promotion_id")
    op.drop_column("transaction_items", "promotion_discount")
    op.drop_index("ix_transaction_promotions_promotion", table_name="transaction_promotions")
    op.drop_index("ix_transaction_promotions_transaction", table_name="transaction_promotions")
    op.drop_table("transaction_promotions")
    op.drop_index("ix_promotions_tenant_updated", table_name="promotions")
    op.drop_index("ix_promotions_tenant_id", table_name="promotions")
    op.drop_table("promotions")
