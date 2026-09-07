"""store net, VAT and the rate on the transaction; add a register number

The VAT split was never stored. It was derived at export time from the gross and the
rate *currently* configured, which means a rate change silently re-states every document
already issued. Israel moved 17% → 18% in January 2025; the next change would have
re-derived every historical receipt at the new figure, so the export would no longer
agree with the paper in the customer's hand.

The split a customer was charged is a fact about the moment of sale, so it is now stored
with the sale:

* `transactions.net_amount`, `vat_amount` — as the till computed them;
* `transactions.vat_rate` — the fraction in force at issue. This is the field that makes
  the other two auditable: without it you cannot tell a correct 17% document from a
  wrong 18% one.
* `transactions.pos_number` — the register a document was issued on, stamped by the
  server from the machine so the document *carries* it rather than only being joinable
  to it. An audit reads the document.
* `pos_machines.pos_number` — the register number as the business numbers its registers
  (till 1, 2, 3 in a branch). Distinct from `machine_code`, which this system generated
  for pairing and which means nothing to a bookkeeper. Documents fall back to
  `machine_code` while it is unset, so the field on a document is never empty.

All nullable, and deliberately not back-filled. Documents issued before this have no
recorded rate, and writing today's rate onto them would invent a fact — the very thing
this migration exists to stop. The tax export keeps deriving those the way it always
has, and prefers the stored figures wherever they are present.

Revision ID: u7v8w9x0y1z2
Revises: t6u7v8w9x0y1
Create Date: 2026-09-07 21:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "u7v8w9x0y1z2"
down_revision = "t6u7v8w9x0y1"
branch_labels = None
depends_on = None


_TRANSACTION_COLUMNS = (
    ("net_amount", sa.Column("net_amount", sa.Numeric(12, 2), nullable=True)),
    ("vat_amount", sa.Column("vat_amount", sa.Numeric(12, 2), nullable=True)),
    ("vat_rate", sa.Column("vat_rate", sa.Numeric(6, 4), nullable=True)),
    ("pos_number", sa.Column("pos_number", sa.String(50), nullable=True)),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing = {c["name"] for c in inspector.get_columns("transactions")}
    for name, column in _TRANSACTION_COLUMNS:
        if name not in existing:
            op.add_column("transactions", column)

    if "pos_number" not in {c["name"] for c in inspector.get_columns("pos_machines")}:
        op.add_column(
            "pos_machines", sa.Column("pos_number", sa.String(50), nullable=True)
        )


def downgrade() -> None:
    op.drop_column("pos_machines", "pos_number")
    for name, _column in reversed(_TRANSACTION_COLUMNS):
        op.drop_column("transactions", name)
