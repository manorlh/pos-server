"""prepaid vouchers ("שוברי הפקה"): batches, their items, vouchers and redemptions

* `prepaid_voucher_batches` — one print run: event, logo, text, validity, shops, and
  whether a voucher may be redeemed in parts.
* `prepaid_voucher_batch_items` — the goods each voucher of the batch is worth.
* `prepaid_vouchers` — one voucher: serial, unguessable code, balance per item.
* `prepaid_voucher_redemptions` — every redemption; unique per (till, client request id).

Unrelated to `vouchers` / `issued_vouchers` and to `ticket_mode` (b2d3f4a5c6e7).

Guarded like a1c2e3f4b5d6: the app's `create_all` may already have made the tables from
the models, so only what is missing is created.

Revision ID: c3e4f5a6b7d8
Revises: b2d3f4a5c6e7
Create Date: 2026-10-03 20:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c3e4f5a6b7d8"
down_revision = "b2d3f4a5c6e7"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _index(name: str, table: str, cols, tables: set, unique: bool = False) -> None:
    if name not in _existing_indexes(table, tables):
        op.create_index(name, table, cols, unique=unique)


def upgrade() -> None:
    tables = _existing_tables()
    if "prepaid_voucher_batches" not in tables:
        op.create_table(
            "prepaid_voucher_batches",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("shop_ids", sa.JSON(), nullable=True),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("event_name", sa.String(200), nullable=True),
            sa.Column("logo_url", sa.String(500), nullable=True),
            sa.Column("free_text", sa.Text(), nullable=True),
            sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
            sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("split_allowed", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column("next_serial", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_by", UUID, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint("status IN ('active', 'cancelled')", name="ck_prepaid_voucher_batches_status"),
        )
    tables_now = _existing_tables() | {"prepaid_voucher_batches"}
    _index("ix_prepaid_voucher_batches_tenant_id", "prepaid_voucher_batches", ["tenant_id"], tables_now)
    _index("ix_prepaid_voucher_batches_company_id", "prepaid_voucher_batches", ["company_id"], tables_now)

    if "prepaid_voucher_batch_items" not in tables:
        op.create_table(
            "prepaid_voucher_batch_items",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "batch_id", UUID,
                sa.ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("product_id", UUID, sa.ForeignKey("products.id"), nullable=False),
            sa.Column("product_name", sa.String(255), nullable=False),
            sa.Column("quantity", sa.Integer(), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.UniqueConstraint("batch_id", "product_id", name="uq_prepaid_voucher_batch_items_product"),
            sa.CheckConstraint("quantity > 0", name="ck_prepaid_voucher_batch_items_quantity"),
        )
    tables_now = _existing_tables() | {"prepaid_voucher_batch_items"}
    _index("ix_prepaid_voucher_batch_items_batch_id", "prepaid_voucher_batch_items", ["batch_id"], tables_now)

    if "prepaid_vouchers" not in tables:
        op.create_table(
            "prepaid_vouchers",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column(
                "batch_id", UUID,
                sa.ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("serial", sa.Integer(), nullable=False),
            sa.Column("code", sa.String(32), nullable=False),
            sa.Column("remaining", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("first_redeemed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_redeemed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("batch_id", "serial", name="uq_prepaid_vouchers_batch_serial"),
            sa.CheckConstraint(
                "status IN ('active', 'partially_used', 'used', 'cancelled')",
                name="ck_prepaid_vouchers_status",
            ),
        )
    tables_now = _existing_tables() | {"prepaid_vouchers"}
    _index("ix_prepaid_vouchers_code", "prepaid_vouchers", ["code"], tables_now, unique=True)
    _index("ix_prepaid_vouchers_tenant_id", "prepaid_vouchers", ["tenant_id"], tables_now)
    _index("ix_prepaid_vouchers_batch_id", "prepaid_vouchers", ["batch_id"], tables_now)

    if "prepaid_voucher_redemptions" not in tables:
        op.create_table(
            "prepaid_voucher_redemptions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column(
                "voucher_id", UUID,
                sa.ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("batch_id", UUID, nullable=False),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id"), nullable=True),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("pos_user_id", sa.String(100), nullable=True),
            sa.Column("pos_user_name", sa.String(200), nullable=True),
            sa.Column("client_request_id", sa.String(100), nullable=False),
            sa.Column("transaction_id", sa.String(100), nullable=True),
            sa.Column("items", sa.JSON(), nullable=False),
            sa.Column("forfeited", sa.JSON(), nullable=True),
            sa.Column("redeemed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint(
                "machine_id", "client_request_id", name="uq_prepaid_voucher_redemptions_request"
            ),
        )
    tables_now = _existing_tables() | {"prepaid_voucher_redemptions"}
    for col in ("tenant_id", "voucher_id", "batch_id", "machine_id"):
        _index(f"ix_prepaid_voucher_redemptions_{col}", "prepaid_voucher_redemptions", [col], tables_now)


def downgrade() -> None:
    op.drop_table("prepaid_voucher_redemptions")
    op.drop_table("prepaid_vouchers")
    op.drop_table("prepaid_voucher_batch_items")
    op.drop_table("prepaid_voucher_batches")
