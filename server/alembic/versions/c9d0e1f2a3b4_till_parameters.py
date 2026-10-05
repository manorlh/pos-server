"""Till parameters: super-admin key/value settings resolved per till

* `till_parameters` — the definitions (key, label, type, default, active). Global.
* `till_parameter_values` — a parameter's value at a company, shop, area or till.
  The till takes the most specific one (app/services/till_parameters.py).

Parent is the till's own settings layer (b8c9d0e1f2a3).

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-03 19:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
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
    # The app's `create_all` on start-up may have made both tables (and their indexes)
    # already from the models, as for the machine catalog (f8a9b0c1d2e3); only what is
    # missing is created.
    tables = _existing_tables()
    if "till_parameters" not in tables:
        _create_till_parameters()
    if "till_parameter_values" not in tables:
        _create_till_parameter_values()
    indexes = _existing_indexes("till_parameter_values", _existing_tables())
    if "ix_till_parameter_values_parameter_id" not in indexes:
        op.create_index(
            "ix_till_parameter_values_parameter_id", "till_parameter_values", ["parameter_id"]
        )
    if "ix_till_parameter_values_scope" not in indexes:
        op.create_index(
            "ix_till_parameter_values_scope", "till_parameter_values", ["scope_type", "scope_id"]
        )


def _create_till_parameters() -> None:
    op.create_table(
        "till_parameters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.String(64), nullable=False, unique=True),
        sa.Column("label", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("value_type", sa.String(16), nullable=False),
        sa.Column("enum_options", postgresql.JSONB(), nullable=True),
        sa.Column("default_value", postgresql.JSONB(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "value_type IN ('string', 'integer', 'decimal', 'boolean', 'enum')",
            name="ck_till_parameters_value_type",
        ),
    )


def _create_till_parameter_values() -> None:
    op.create_table(
        "till_parameter_values",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "parameter_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("till_parameters.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("scope_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "parameter_id", "scope_type", "scope_id", name="uq_till_parameter_values_scope"
        ),
        sa.CheckConstraint(
            "scope_type IN ('company', 'shop', 'area', 'machine')",
            name="ck_till_parameter_values_scope_type",
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_till_parameter_values_scope", table_name="till_parameter_values")
    op.drop_index("ix_till_parameter_values_parameter_id", table_name="till_parameter_values")
    op.drop_table("till_parameter_values")
    op.drop_table("till_parameters")
