"""Offline card authorization runs (Agamento `authorizePendingTransactions`)

* `offline_authorizations` — one run of one till, as reported (id is the till's).
* `offline_authorization_items` — each terminal uid the run answered, approved or
  declined. Matched to card legs per till by uid (app/services/offline_authorizations.py).

Parent is the till parameters (c9d0e1f2a3b4).

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-10-03 21:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
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
    # already from the models, as for the till parameters (c9d0e1f2a3b4); only what is
    # missing is created.
    tables = _existing_tables()
    if "offline_authorizations" not in tables:
        _create_offline_authorizations()
    if "offline_authorization_items" not in tables:
        _create_offline_authorization_items()
    tables = _existing_tables()
    _ensure_index(
        "offline_authorizations", tables, "ix_offline_authorizations_machine_authorized",
        ["machine_id", "authorized_at"],
    )
    _ensure_index("offline_authorizations", tables, "ix_offline_authorizations_tenant_id", ["tenant_id"])
    _ensure_index("offline_authorizations", tables, "ix_offline_authorizations_shop_id", ["shop_id"])
    _ensure_index(
        "offline_authorization_items", tables, "ix_offline_authorization_items_machine_uid",
        ["machine_id", "terminal_uid"],
    )


def _ensure_index(table: str, tables: set, name: str, columns: list) -> None:
    if name not in _existing_indexes(table, tables):
        op.create_index(name, table, columns)


def _create_offline_authorizations() -> None:
    op.create_table(
        "offline_authorizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("total_amount_agorot", sa.BigInteger(), nullable=True),
        sa.Column("total_count", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def _create_offline_authorization_items() -> None:
    op.create_table(
        "offline_authorization_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "authorization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("offline_authorizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("terminal_uid", sa.String(64), nullable=False),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.UniqueConstraint(
            "authorization_id", "terminal_uid", name="uq_offline_authorization_items_uid"
        ),
        sa.CheckConstraint(
            "outcome IN ('approved', 'declined')", name="ck_offline_authorization_items_outcome"
        ),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_offline_authorization_items_machine_uid", table_name="offline_authorization_items"
    )
    op.drop_table("offline_authorization_items")
    op.drop_index("ix_offline_authorizations_shop_id", table_name="offline_authorizations")
    op.drop_index("ix_offline_authorizations_tenant_id", table_name="offline_authorizations")
    op.drop_index(
        "ix_offline_authorizations_machine_authorized", table_name="offline_authorizations"
    )
    op.drop_table("offline_authorizations")
