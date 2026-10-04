"""products: "לא מקבל הנחות" (`no_discount`)

A product the till gives no discount of any kind: no line discount, no share of a
basket discount, no promotion. Guarded: the app's `create_all` never adds a column, but a
dev database may already have it from a previous run of this revision.

Revision ID: c47b8c9d0e15
Revises: b36a7b8c9d04
"""
from alembic import context, op
import sqlalchemy as sa

revision = "c47b8c9d0e15"
down_revision = "b36a7b8c9d04"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    if context.is_offline_mode():
        return False
    cols = sa.inspect(op.get_bind()).get_columns("products")
    return any(c["name"] == "no_discount" for c in cols)


def upgrade() -> None:
    if not _has_column():
        op.add_column(
            "products",
            sa.Column("no_discount", sa.Boolean(), nullable=False, server_default="false"),
        )


def downgrade() -> None:
    op.drop_column("products", "no_discount")
