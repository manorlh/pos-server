"""products: "היכן הפריט נמכר" (`sales_channel`)

Where a product is sold: `all` (קופות וקיוסק — every product so far, and the default for
a new one), `kiosk_only` (קיוסק בלבד) or `pos_only` (קופות בלבד). The tills hide
`kiosk_only` from the sell screen and the kiosk hides `pos_only`
(docs/SPEC_PRODUCT_CHANNELS.md, app/services/sales_channel.py).

Additive and guarded: the app's `create_all` never adds a column, but a dev database may
already have it from a previous run of this revision.

Revision ID: 5c1e9a7f3b28
Revises: b9f3d5a7c2e4
"""
from alembic import context, op
import sqlalchemy as sa

revision = "5c1e9a7f3b28"
down_revision = "b9f3d5a7c2e4"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    if context.is_offline_mode():
        return False
    cols = sa.inspect(op.get_bind()).get_columns("products")
    return any(c["name"] == "sales_channel" for c in cols)


def upgrade() -> None:
    if not _has_column():
        op.add_column(
            "products",
            sa.Column("sales_channel", sa.String(length=16), nullable=False, server_default="all"),
        )


def downgrade() -> None:
    op.drop_column("products", "sales_channel")
