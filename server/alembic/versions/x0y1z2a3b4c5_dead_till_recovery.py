"""reconstructed Z reports, and pairing codes that replace a terminal

A terminal that dies mid-day leaves a trading day nobody can end: `apply_z_report` is
reachable only from the till-facing sync endpoint with that machine's own token. Five such
days already exist in this database, going back to July, each holding real documents.

Two capabilities, and the columns they need:

* `z_reports.reconstructed` / `reconstructed_by` / `reconstruction_basis` — a Z built by
  the cloud from the documents it holds, for a day whose terminal cannot close it. Marked
  so no reader mistakes it for one the terminal printed, attributed to whoever authorised
  it, and carrying what it was built from: documents held, last heartbeat, and the backlog
  the terminal last reported. That last figure is the honest measure of what might be
  missing, and without it a reader has nothing to judge the document by.

* `pairing_codes.target_machine_id` — a code that hands an existing terminal's identity to
  a replacement device instead of creating a new machine row. The replacement keeps the
  id, the machine_code, the shop and the register number, so documents already filed still
  point at the till the shop knows.

`reconstructed` defaults false with a server default, so every Z already filed reads as
what it is: issued by a terminal.

Revision ID: x0y1z2a3b4c5
Revises: w9x0y1z2a3b4
Create Date: 2026-09-13 09:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "x0y1z2a3b4c5"
down_revision = "w9x0y1z2a3b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    existing = {c["name"] for c in inspector.get_columns("z_reports")}
    if "reconstructed" not in existing:
        op.add_column(
            "z_reports",
            sa.Column(
                "reconstructed",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
    if "reconstructed_by" not in existing:
        op.add_column("z_reports", sa.Column("reconstructed_by", sa.String(255), nullable=True))
    if "reconstruction_basis" not in existing:
        op.add_column(
            "z_reports", sa.Column("reconstruction_basis", postgresql.JSONB(), nullable=True)
        )

    if "target_machine_id" not in {c["name"] for c in inspector.get_columns("pairing_codes")}:
        op.add_column(
            "pairing_codes",
            sa.Column(
                "target_machine_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("pos_machines.id"),
                nullable=True,
            ),
        )


def downgrade() -> None:
    op.drop_column("pairing_codes", "target_machine_id")
    op.drop_column("z_reports", "reconstruction_basis")
    op.drop_column("z_reports", "reconstructed_by")
    op.drop_column("z_reports", "reconstructed")
