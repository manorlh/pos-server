"""add is_weighed and unit_label to products

The till's cart quantity becomes a decimal so goods can be sold by weight, and the
product has to be the thing that says whether that applies: the cashier must not have
to remember which items open the scale keypad, and a receipt for 0.734 of something
needs to be able to say 0.734 *of what*.

`is_weighed` is NOT NULL with a server_default of false, matching `is_open_price` and
`track_stock`: every existing product is sold by the piece, and an added boolean that
arrives NULL just moves the question into every reader.

`unit_label` is nullable free text (ק"ג, ליטר, יח'), not an enum. The merchant's own
label is what appears on the shelf and the receipt, and a closed list would need a
migration for the first shop that sells by the מטר.

The two flags are deliberately independent of `is_open_price` — see the note in
`app/schemas/product.py`.

Revision ID: o1p2q3r4s5t6
Revises: n0o1p2q3r4s5
Create Date: 2026-08-28 12:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "o1p2q3r4s5t6"
down_revision = "n0o1p2q3r4s5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    product_cols = {c["name"] for c in sa.inspect(bind).get_columns("products")}
    if "is_weighed" not in product_cols:
        op.add_column(
            "products",
            sa.Column(
                "is_weighed",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
    if "unit_label" not in product_cols:
        op.add_column("products", sa.Column("unit_label", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "unit_label")
    op.drop_column("products", "is_weighed")
