"""Kiosk orders paid at the till ("תשלום בקופה")

Revision ID: a4c8e2f6b9d3
Revises: 3b8e6d2f9a14
Create Date: 2026-10-07

docs/SPEC_KIOSK.md §23: a kiosk customer may choose to pay at the till. The kiosk issues no
tax document; it posts an OPEN order (`kiosk_orders.pay_at_till`, `open_state = 'open'`) with
its lines, its basket and any prepaid voucher already redeemed towards it. One of the shop's
tills locks it, takes the money with its own document and marks it paid — or cancels it with
a reason; unpaid it expires. `paid_at` becomes nullable (an open order is not paid).

Idempotent: every column / index is added only when missing (the auto-reloading dev API may
have created them first).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a4c8e2f6b9d3'
down_revision: Union[str, Sequence[str], None] = '3b8e6d2f9a14'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "kiosk_orders"


def _json():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


COLUMNS = (
    ("pay_at_till", lambda: sa.Column("pay_at_till", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
    ("open_state", lambda: sa.Column("open_state", sa.String(16), nullable=True)),
    ("due_agorot", lambda: sa.Column("due_agorot", sa.BigInteger(), nullable=True)),
    ("voucher_agorot", lambda: sa.Column("voucher_agorot", sa.BigInteger(), nullable=True)),
    ("lines", lambda: sa.Column("lines", _json(), nullable=True)),
    ("cart", lambda: sa.Column("cart", _json(), nullable=True)),
    ("vouchers", lambda: sa.Column("vouchers", _json(), nullable=True)),
    ("expires_at", lambda: sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True)),
    ("locked_by_machine_id", lambda: sa.Column("locked_by_machine_id", postgresql.UUID(as_uuid=True), nullable=True)),
    ("locked_by_name", lambda: sa.Column("locked_by_name", sa.String(200), nullable=True)),
    ("locked_at", lambda: sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True)),
    ("paid_by_machine_id", lambda: sa.Column("paid_by_machine_id", postgresql.UUID(as_uuid=True), nullable=True)),
    ("paid_by_name", lambda: sa.Column("paid_by_name", sa.String(200), nullable=True)),
    ("closed_at", lambda: sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True)),
    ("close_reason", lambda: sa.Column("close_reason", sa.String(300), nullable=True)),
    ("closed_by_name", lambda: sa.Column("closed_by_name", sa.String(200), nullable=True)),
    ("kitchen_sent", lambda: sa.Column("kitchen_sent", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
)

INDEX = "ix_kiosk_orders_shop_open"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        return
    have = {c["name"] for c in inspector.get_columns(TABLE)}
    for name, make in COLUMNS:
        if name not in have:
            op.add_column(TABLE, make())
    op.alter_column(TABLE, "paid_at", existing_type=sa.DateTime(timezone=True), nullable=True)
    indexes = {i["name"] for i in inspector.get_indexes(TABLE)}
    if INDEX not in indexes:
        op.create_index(INDEX, TABLE, ["shop_id", "open_state"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        return
    # Orders that never were paid cannot keep a NOT NULL paid_at: they go.
    op.execute("DELETE FROM kiosk_orders WHERE paid_at IS NULL")
    op.alter_column(TABLE, "paid_at", existing_type=sa.DateTime(timezone=True), nullable=False)
    indexes = {i["name"] for i in inspector.get_indexes(TABLE)}
    if INDEX in indexes:
        op.drop_index(INDEX, table_name=TABLE)
    have = {c["name"] for c in inspector.get_columns(TABLE)}
    for name, _make in reversed(COLUMNS):
        if name in have:
            op.drop_column(TABLE, name)
