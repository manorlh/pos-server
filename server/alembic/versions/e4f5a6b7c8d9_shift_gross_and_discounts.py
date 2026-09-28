"""shifts.gross_sales and shifts.discounts_total

The server's X stored only net sales (`total_sales`, after document discounts), while
the till's X prints gross sales and its discounts. The dashboard could not show the
cloud's side of those two lines. Both are now stored with the rest of the X:

* `gross_sales` — Σ totalAmount of the shift's sales;
* `discounts_total` — Σ documentDiscount of the shift's sales;

where "sales" are what `app.services.shift_totals` counts: status completed, refunded or
partial_refund, and not a credit note (document type 330, or a refund back-link).

Backfilled from the documents for every shift that has an X (`total_sales` not null);
open shifts get theirs at close. A shift already in a Z counts only the documents that
reached the cloud by the time that Z was built, as its frozen X did — later ones are its
`late_documents`, outside the Z.

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-09-28 15:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "e4f5a6b7c8d9"
down_revision = "d3e4f5a6b7c8"
branch_labels = None
depends_on = None


BACKFILL = """
UPDATE shifts AS s
SET gross_sales = COALESCE(d.gross, 0),
    discounts_total = COALESCE(d.discounts, 0)
FROM shifts AS s2
LEFT JOIN z_reports AS z ON z.id = s2.z_report_id
LEFT JOIN LATERAL (
    SELECT SUM(COALESCE(t.total_amount, 0)) AS gross,
           SUM(COALESCE(t.document_discount, 0)) AS discounts
    FROM transactions AS t
    WHERE t.shift_id = s2.id
      AND t.status IN ('completed', 'refunded', 'partial_refund')
      AND COALESCE(t.document_type, 0) <> 330
      AND t.refund_of_transaction_id IS NULL
      AND (
          z.id IS NULL
          OR t.server_received_at IS NULL
          OR t.server_received_at <= z.created_at
      )
) AS d ON TRUE
WHERE s.id = s2.id
  AND s.total_sales IS NOT NULL
"""


def upgrade() -> None:
    op.add_column("shifts", sa.Column("gross_sales", sa.Numeric(12, 2), nullable=True))
    op.add_column("shifts", sa.Column("discounts_total", sa.Numeric(12, 2), nullable=True))
    op.execute(BACKFILL)


def downgrade() -> None:
    op.drop_column("shifts", "discounts_total")
    op.drop_column("shifts", "gross_sales")
