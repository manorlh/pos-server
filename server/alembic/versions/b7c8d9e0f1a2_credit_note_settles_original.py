"""transactions.over_credited, and originals settled by the credit notes already held

A credit note arriving at the cloud used to leave the sale it refunds `completed`: the
till marks its own copy `refunded` / `partial_refund` but pushes only the credit note.
The cloud now settles the original itself from the cumulative credited amount
(`app.services.transactions.settle_credited_originals`), and this migration does the
same once for the documents already held:

* an original in a counted status (completed / refunded / partial_refund) whose counted
  credit notes add up to at least what it collected (total − document discount, one
  agora of slack) becomes `refunded`; one credited less, but something, becomes
  `partial_refund`. Cancelled and pending originals are left alone.
* `over_credited` is set on each credit note that took its original's running credited
  total (oldest first) past what the original collected.

Only within one tenant, as the service does. Neither change moves an X or a Z: both
statuses count exactly as `completed` does (`SALE_STATUSES`).

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
Create Date: 2026-09-29 18:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b7c8d9e0f1a2"
down_revision = "a6b7c8d9e0f1"
branch_labels = None
depends_on = None


_COUNTED = "('completed', 'refunded', 'partial_refund')"

_CREDITS = f"""
    SELECT c.id,
           c.refund_of_transaction_id AS original_id,
           o.total_amount - COALESCE(o.document_discount, 0) AS collected,
           SUM(c.total_amount) OVER (
               PARTITION BY c.refund_of_transaction_id
               ORDER BY c.created_at, c.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running
      FROM transactions c
      JOIN transactions o ON o.id = c.refund_of_transaction_id
     WHERE c.id <> o.id
       AND c.tenant_id IS NOT DISTINCT FROM o.tenant_id
       AND c.status IN {_COUNTED}
"""


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("over_credited", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.execute(
        f"""
        UPDATE transactions t
           SET over_credited = true
          FROM ({_CREDITS}) credits
         WHERE t.id = credits.id
           AND credits.running > credits.collected + 0.01
        """
    )

    op.execute(
        f"""
        UPDATE transactions o
           SET status = CASE
                   WHEN credited.total >= (o.total_amount - COALESCE(o.document_discount, 0)) - 0.01
                   THEN 'refunded'::transactionstatus
                   ELSE 'partial_refund'::transactionstatus
               END
          FROM (
                SELECT c.refund_of_transaction_id AS original_id, SUM(c.total_amount) AS total
                  FROM transactions c
                  JOIN transactions o2 ON o2.id = c.refund_of_transaction_id
                 WHERE c.id <> o2.id
                   AND c.tenant_id IS NOT DISTINCT FROM o2.tenant_id
                   AND c.status IN {_COUNTED}
                 GROUP BY c.refund_of_transaction_id
               ) credited
         WHERE o.id = credited.original_id
           AND o.status IN {_COUNTED}
           AND credited.total > 0
        """
    )


def downgrade() -> None:
    # The settled statuses stay: they are what the till itself holds for those sales.
    op.drop_column("transactions", "over_credited")
