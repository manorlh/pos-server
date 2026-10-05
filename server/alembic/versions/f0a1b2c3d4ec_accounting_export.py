"""accounting export: account mapping, export batches and the Zs they carried

docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.

* `accounting_settings` — the account mapping per company, with an optional override
  row per shop (one of each, by two partial unique indexes).
* `accounting_export_batches` — one export each ("מנה N" per tenant), with the file.
* `accounting_export_items` — (batch, Z) pairs; a Z in any batch is "exported".

Guarded like f0a1b2c3d4e5: the app's `create_all` may already have made the tables from
the models, so only what is missing is created.

Parent is the company and shop numbers (f0a1b2c3d4eb).

Revision ID: f0a1b2c3d4ec
Revises: f0a1b2c3d4eb
Create Date: 2026-10-04 12:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f0a1b2c3d4ec"
down_revision = "f0a1b2c3d4eb"
branch_labels = None
depends_on = None


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    tables = _existing_tables()
    if "accounting_settings" not in tables:
        op.create_table(
            "accounting_settings",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("settings", postgresql.JSONB(), nullable=False, server_default="{}"),
            sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    if "accounting_export_batches" not in tables:
        op.create_table(
            "accounting_export_batches",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("batch_number", sa.Integer(), nullable=False),
            sa.Column("format", sa.String(16), nullable=False),
            sa.Column("method", sa.String(16), nullable=False, server_default="flexible"),
            sa.Column("encoding", sa.String(16), nullable=False, server_default="cp1255"),
            sa.Column("grouping", sa.String(8), nullable=False, server_default="z"),
            sa.Column("date_from", sa.Date(), nullable=True),
            sa.Column("date_to", sa.Date(), nullable=True),
            sa.Column("z_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("entry_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("line_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_debit", sa.Numeric(14, 2), nullable=False, server_default="0"),
            sa.Column("is_reexport", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("file_name", sa.String(255), nullable=False),
            sa.Column("file_content", sa.LargeBinary(), nullable=False),
            sa.Column("file_sha256", sa.String(64), nullable=False),
            sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("tenant_id", "batch_number", name="uq_accounting_export_batches_number"),
        )
    if "accounting_export_items" not in tables:
        op.create_table(
            "accounting_export_items",
            sa.Column(
                "batch_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("accounting_export_batches.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "z_report_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("z_reports.id"), primary_key=True
            ),
        )

    tables = _existing_tables()
    wanted = (
        ("accounting_settings", "ix_accounting_settings_tenant_id", ["tenant_id"], {}),
        ("accounting_settings", "ix_accounting_settings_company_id", ["company_id"], {}),
        (
            "accounting_settings",
            "uq_accounting_settings_company",
            ["company_id"],
            dict(unique=True, postgresql_where=sa.text("shop_id IS NULL")),
        ),
        (
            "accounting_settings",
            "uq_accounting_settings_shop",
            ["shop_id"],
            dict(unique=True, postgresql_where=sa.text("shop_id IS NOT NULL")),
        ),
        ("accounting_export_batches", "ix_accounting_export_batches_tenant_id", ["tenant_id"], {}),
        ("accounting_export_batches", "ix_accounting_export_batches_company_id", ["company_id"], {}),
        ("accounting_export_batches", "ix_accounting_export_batches_shop_id", ["shop_id"], {}),
        ("accounting_export_items", "ix_accounting_export_items_z_report_id", ["z_report_id"], {}),
    )
    for table, name, columns, kw in wanted:
        if name not in _existing_indexes(table, tables):
            op.create_index(name, table, columns, **kw)


def downgrade() -> None:
    op.drop_index("ix_accounting_export_items_z_report_id", table_name="accounting_export_items")
    op.drop_table("accounting_export_items")
    op.drop_index("ix_accounting_export_batches_shop_id", table_name="accounting_export_batches")
    op.drop_index("ix_accounting_export_batches_company_id", table_name="accounting_export_batches")
    op.drop_index("ix_accounting_export_batches_tenant_id", table_name="accounting_export_batches")
    op.drop_table("accounting_export_batches")
    op.drop_index("uq_accounting_settings_shop", table_name="accounting_settings")
    op.drop_index("uq_accounting_settings_company", table_name="accounting_settings")
    op.drop_index("ix_accounting_settings_company_id", table_name="accounting_settings")
    op.drop_index("ix_accounting_settings_tenant_id", table_name="accounting_settings")
    op.drop_table("accounting_settings")
