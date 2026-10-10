"""document prefix: every till's own "קידומת מסמכים" — docs/SPEC_DOCUMENT_PREFIX.md

Revision ID: d0c5e7a9f3b1
Revises: b6e2d8f4a1c7
Create Date: 2026-10-06

* `pos_machines.document_prefix` — the till's chosen prefix (digits, 1–3). Null is the
  default, the register number, so every existing till has one with no setup.
* `transactions.document_prefix` — the prefix a document was issued under, frozen on it
  by the till. Not back-filled: a document from before has none stored and reads as its
  `pos_number` (the register that issued it), which the code resolves when reading
  rather than writing a value no till ever printed onto history.

Both columns are added only when missing, so a database the API's `create_all` reached
first upgrades cleanly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d0c5e7a9f3b1"
down_revision: Union[str, Sequence[str], None] = "b6e2d8f4a1c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_state(table: str, column: str) -> str:
    """'missing-table', 'present' or 'missing'."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return "missing-table"
    return "present" if any(c["name"] == column for c in inspector.get_columns(table)) else "missing"


def upgrade() -> None:
    if _column_state("pos_machines", "document_prefix") == "missing":
        op.add_column("pos_machines", sa.Column("document_prefix", sa.String(length=3), nullable=True))
    if _column_state("transactions", "document_prefix") == "missing":
        op.add_column("transactions", sa.Column("document_prefix", sa.String(length=10), nullable=True))


def downgrade() -> None:
    # Never run on a live database: the frozen prefixes are fiscal data (see the spec).
    if _column_state("transactions", "document_prefix") == "present":
        op.drop_column("transactions", "document_prefix")
    if _column_state("pos_machines", "document_prefix") == "present":
        op.drop_column("pos_machines", "document_prefix")
