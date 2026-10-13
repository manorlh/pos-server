"""demo_company_items — what the one-click "בניית חברת הדגמה" built

"בניית חברת הדגמה" (P:/specs/demo-company.md, app/services/demo_company.py): a super admin's one
click builds a whole live demo company. Every thing it creates (and every step it completes) is a
row here under a stable key, unique in the organization, so a second click completes only what is
missing and never makes anything twice or overwrites what the owner changed. The company's row
cascades with the company; `build_lock` (company null, `locked_until`) keeps two clicks at once
from building twice.

Idempotent: the table is looked at first (the API's create_all may have made it before this runs —
then only its missing indexes are added). The downgrade drops only what this revision adds.

Revision ID: d3f8a6c2b9e1, revises c7e4a2f9d1b6 (13.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d3f8a6c2b9e1"
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "demo_company_items"
INDEXES = (("ix_demo_company_items_company", ["company_id"]),)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment: its migration context says
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return False
    return sa.inspect(op.get_bind()).has_table(table)


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _uuid():
    return postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    if not _has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", _uuid(), primary_key=True),
            sa.Column("tenant_id", _uuid(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", _uuid(), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("item_key", sa.String(length=120), nullable=False),
            sa.Column("entity_type", sa.String(length=32), nullable=False),
            sa.Column("entity_id", _uuid(), nullable=True),
            sa.Column("shop_id", _uuid(), nullable=True),
            sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", _uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("tenant_id", "item_key", name="uq_demo_company_items_tenant_key"),
        )
    have = _indexes(TABLE)
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    if _has_table(TABLE):
        op.drop_table(TABLE)
