"""add ticket_mode to categories and products (item-ticket / "שובר" printing)

An item ticket is an operational slip the till prints after a sale — "5 נקניקיות",
handed over the counter and exchanged for the goods. It is unrelated to the value
vouchers in `vouchers` / `issued_vouchers` (gift cards with a serial and an expiry).

Values: "off", "per_unit", "per_line", "per_sale".
- categories.ticket_mode: NULL means "off".
- products.ticket_mode: NULL means "inherit the category's mode"; an explicit
  "off" on the product switches it off even when the category prints.

Revision ID: b2d3f4a5c6e7
Revises: a1c2e3f4b5d6
Create Date: 2026-10-03 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "b2d3f4a5c6e7"
down_revision = "a1c2e3f4b5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "ticket_mode" not in {c["name"] for c in insp.get_columns("categories")}:
        op.add_column("categories", sa.Column("ticket_mode", sa.String(16), nullable=True))
    if "ticket_mode" not in {c["name"] for c in insp.get_columns("products")}:
        op.add_column("products", sa.Column("ticket_mode", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "ticket_mode")
    op.drop_column("categories", "ticket_mode")
