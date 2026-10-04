"""prepaid vouchers: a free-text note per voucher

"נמסר לדני — במה", "הוחלף בשובר 0042": written on the dashboard, shown there and in the
till's lookup (`note`). Guarded: the app's `create_all` never adds a column, but a dev
database may already have it from a previous run of this revision.

Revision ID: b14e5f6a7b82
Revises: b03d4e5f6a71
"""
from alembic import context, op
import sqlalchemy as sa

revision = "b14e5f6a7b82"
down_revision = "b03d4e5f6a71"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    if context.is_offline_mode():
        return False
    cols = sa.inspect(op.get_bind()).get_columns("prepaid_vouchers")
    return any(c["name"] == "note" for c in cols)


def upgrade() -> None:
    if not _has_column():
        op.add_column("prepaid_vouchers", sa.Column("note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("prepaid_vouchers", "note")
