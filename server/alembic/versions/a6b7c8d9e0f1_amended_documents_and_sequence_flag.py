"""shifts/z_reports.amended_documents and shifts.sequence_out_of_order

`amended_documents` — a re-push can rewrite a document's fiscal content (amount,
discount, VAT, tip, tenders…) after its shift went into a Z, and a document can be moved
into such a shift. The Z's figures are frozen, so this was absorbed silently. A moved-in
document is now counted in `late_documents` (it is not in the Z's figures, exactly like
a late one) and a rewritten one in `amended_documents`, on the shift and on its Z.

`sequence_out_of_order` — a shift opened with a sequence number at or below one its till
already used. Accepted (a refusal would jam the till's outbox) but flagged.

Nothing to backfill: past amendments were not recorded, and zero / false is the honest
starting value.

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9e0
Create Date: 2026-09-29 09:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "a6b7c8d9e0f1"
down_revision = "f5a6b7c8d9e0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shifts", sa.Column("amended_documents", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "z_reports", sa.Column("amended_documents", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "shifts",
        sa.Column("sequence_out_of_order", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("shifts", "sequence_out_of_order")
    op.drop_column("z_reports", "amended_documents")
    op.drop_column("shifts", "amended_documents")
