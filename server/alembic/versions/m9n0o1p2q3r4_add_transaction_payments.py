"""add transaction_payments (split tender)

One row per tender leg, so a document can say "₪50 cash, ₪73.40 card". Until now the
only place a document could record how it was paid was `transactions.payment_method`,
a single String(50) — a customer splitting a bill across two tenders could not be
represented at all, and any attempt to record it put the entire document in one
bucket of every report.

`transactions.payment_method` is kept and kept populated: an older till build, every
report written before this change, and the OpenFormat export all read it. It becomes
the single-value summary of the legs — the tender name when there is one, the literal
'mixed' when there is more than one.

Existing documents are backfilled with the one leg they implicitly always had, so the
table is uniform from the first day rather than "rows since August 2026 have legs".
The reports do not depend on the backfill having run (they fall back to the document's
own tender through an outer join), but the data model reads far better for it, and
"which documents have no payment rows" stops being a question with a boring answer.

Revision ID: m9n0o1p2q3r4
Revises: l8m9n0o1p2q3
Create Date: 2026-08-28 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision = "m9n0o1p2q3r4"
down_revision = "l8m9n0o1p2q3"
branch_labels = None
depends_on = None


_TABLE = "transaction_payments"
_INDEX = "ix_transaction_payments_transaction"

# The credit-note document type (330). A credit note's `total_amount` is already the
# money handed back, while a sale's is the gross of its line totals with the discounts
# summed into `document_discount`. Backfilling both with the same expression would
# credit refunds twice over.
_CREDIT_NOTE_DOCUMENT_TYPE = 330


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _TABLE not in inspector.get_table_names():
        op.create_table(
            _TABLE,
            # Client-generated, like transaction_items.id: the till mints the leg and
            # the push is idempotent on it.
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "transaction_id",
                UUID(as_uuid=True),
                sa.ForeignKey("transactions.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("sequence", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("method", sa.String(50), nullable=False),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            # Mirrors transactions.nayax_meta exactly: unvalidated JSONB carrying the
            # acquirer reply (vuid, terminal uid, authorisation number, masked card).
            # On a split document each card leg has its own authorisation.
            sa.Column("nayax_meta", JSONB(), nullable=True),
        )
        op.create_index(_INDEX, _TABLE, ["transaction_id"])

    # Backfill: exactly one leg per existing document, carrying the money that
    # document actually collected. NOT EXISTS makes it safe to re-run.
    op.execute(
        f"""
        INSERT INTO {_TABLE} (id, transaction_id, sequence, method, amount, nayax_meta)
        SELECT gen_random_uuid(),
               t.id,
               1,
               COALESCE(NULLIF(TRIM(t.payment_method), ''), 'other'),
               CASE
                   WHEN t.document_type = {_CREDIT_NOTE_DOCUMENT_TYPE}
                        OR t.refund_of_transaction_id IS NOT NULL
                   THEN COALESCE(t.total_amount, 0)
                   ELSE COALESCE(t.total_amount, 0) - COALESCE(t.document_discount, 0)
               END,
               t.nayax_meta
          FROM transactions t
         WHERE NOT EXISTS (
                   SELECT 1 FROM {_TABLE} p WHERE p.transaction_id = t.id
               )
        """
    )


def downgrade() -> None:
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
