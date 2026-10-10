"""Failed payment attempts ("עסקאות שלא הושלמו")

Revision ID: 5d9e1f3a7c62
Revises: a4c8e2f6b9d3
Create Date: 2026-10-07

docs/SPEC_FAILED_PAYMENTS.md: a payment that fails on the terminal (declined, cancelled,
no answer, terminal error, card lock) issues no tax document, so no report showed it. The
till now records every failed / aborted attempt and pushes it
(`POST /sync/{machine_id}/failed-payments`, idempotent by the till's id). One row per
attempt; never part of any fiscal total.

Idempotent: the auto-reloading dev API runs `create_all` at startup and may have made the
table before this runs — then only the missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '5d9e1f3a7c62'
down_revision: Union[str, Sequence[str], None] = 'a4c8e2f6b9d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "failed_payment_attempts"

INDEXES = (
    ("ix_failed_payment_attempts_tenant_occurred", ["tenant_id", "occurred_at"]),
    ("ix_failed_payment_attempts_machine_occurred", ["machine_id", "occurred_at"]),
    ("ix_failed_payment_attempts_shift", ["shift_id"]),
    ("ix_failed_payment_attempts_transaction", ["transaction_id"]),
    ("ix_failed_payment_attempts_paid_by", ["paid_by_transaction_id"]),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        uuid = postgresql.UUID(as_uuid=True)
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("shift_id", uuid, nullable=True),
            sa.Column("business_date", sa.Date(), nullable=True),
            sa.Column("pos_user_id", sa.String(100), nullable=True),
            sa.Column("employee_name", sa.String(200), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("amount_agorot", sa.BigInteger(), nullable=False),
            sa.Column("method", sa.String(32), nullable=False, server_default="card"),
            sa.Column("kind", sa.String(32), nullable=False, server_default="sale"),
            sa.Column("channel", sa.String(32), nullable=False, server_default="till"),
            sa.Column("terminal_type", sa.String(32), nullable=True),
            sa.Column("terminal_id", sa.String(64), nullable=True),
            sa.Column("outcome", sa.String(32), nullable=False),
            sa.Column("reason_code", sa.String(64), nullable=True),
            sa.Column("reason_message", sa.String(300), nullable=True),
            sa.Column("card_brand", sa.String(16), nullable=True),
            sa.Column("card_last4", sa.String(4), nullable=True),
            sa.Column("line_count", sa.Integer(), nullable=True),
            sa.Column("vuid", sa.String(100), nullable=True),
            sa.Column("transaction_id", uuid, nullable=True),
            sa.Column("paid_by_transaction_id", uuid, nullable=True),
            sa.Column("paid_by_method", sa.String(16), nullable=True),
            sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)
    have = {i["name"] for i in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(TABLE):
        op.drop_table(TABLE)
