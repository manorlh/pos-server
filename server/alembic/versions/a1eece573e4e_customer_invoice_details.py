"""Customer details for an invoice ("פרטי לקוח לחשבונית") and the reissue link

The buyer's details a till prints on a tax invoice, frozen on the document like the name, phone
and address already are (docs/SPEC_CUSTOMER_INVOICE.md):

`transactions.customer_vat_number` — the buyer's ח.פ. / ע.מ. as the till took it (digits).
`transactions.customer_email` — optional.
`transactions.reissue_of_transaction_id` — "הפק חשבונית על שם לקוח": set on the credit note that
cancels the original and on the new invoice that replaces it, both naming the original. Not a
foreign key, like `refund_of_transaction_id`: a document is never refused over a link.

Add-only and idempotent (the columns are looked at first). Revision ID: a1eece573e4e, revises
5a7c9e1b3d2f.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "a1eece573e4e"
down_revision: Union[str, Sequence[str], None] = "5a7c9e1b3d2f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX = "ix_transactions_reissue_of"


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    from sqlalchemy.dialects import postgresql

    have = _columns("transactions")
    if "customer_vat_number" not in have:
        op.add_column("transactions", sa.Column("customer_vat_number", sa.String(20), nullable=True))
    if "customer_email" not in have:
        op.add_column("transactions", sa.Column("customer_email", sa.String(255), nullable=True))
    if "reissue_of_transaction_id" not in have:
        op.add_column(
            "transactions",
            sa.Column("reissue_of_transaction_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
    if INDEX not in _indexes("transactions"):
        op.create_index(INDEX, "transactions", ["reissue_of_transaction_id"])


def downgrade() -> None:
    if INDEX in _indexes("transactions"):
        op.drop_index(INDEX, table_name="transactions")
    have = _columns("transactions")
    for column in ("reissue_of_transaction_id", "customer_email", "customer_vat_number"):
        if column in have:
            op.drop_column("transactions", column)
