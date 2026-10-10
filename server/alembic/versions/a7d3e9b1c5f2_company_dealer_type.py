"""companies.dealer_type: "סוג עוסק" — company / licensed (עוסק מורשה) / exempt (עוסק פטור)

Revision ID: a7d3e9b1c5f2
Revises: 8c2e4a6f0b13
Create Date: 2026-10-06

docs/SPEC_BUSINESS_TYPE.md. An exempt dealer issues receipts (400) with no VAT; a
licensed dealer behaves like a company (320/330 with VAT). Every existing company gets
"company" — today's behaviour — so nothing already issued or configured changes. Who
changed the type and when is kept beside it, and every change in `dealer_type_history`.

Additive and idempotent: each column is added only when it is missing (the auto-reloaded
API's `create_all` never adds columns to an existing table, but a re-run must not fail).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a7d3e9b1c5f2'
down_revision: Union[str, Sequence[str], None] = '8c2e4a6f0b13'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'companies'


def _columns():
    return [
        sa.Column('dealer_type', sa.String(16), nullable=False, server_default='company'),
        sa.Column('dealer_type_changed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dealer_type_changed_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            'dealer_type_history',
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    ]


def upgrade() -> None:
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for column in _columns():
        if column.name not in existing:
            op.add_column(TABLE, column)


def downgrade() -> None:
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for column in reversed(_columns()):
        if column.name in existing:
            op.drop_column(TABLE, column.name)
