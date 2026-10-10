"""Customer details for an invoice ("פרטי לקוח לחשבונית") and the reissue link

The buyer's details a till prints on a tax invoice, frozen on the document like the name, phone
and address already are (docs/SPEC_CUSTOMER_INVOICE.md):

`transactions.customer_vat_number` — the buyer's ח.פ. / ע.מ. as the till took it (digits).
`transactions.customer_email` — optional.
`transactions.reissue_of_transaction_id` — "הפק חשבונית על שם לקוח": set on the credit note that
cancels the original and on the new invoice that replaces it, both naming the original. Not a
foreign key, like `refund_of_transaction_id`: a document is never refused over a link.

`transaction_customer_details` — "הדפס העתק עם פרטי לקוח" (§3.5): the customer's details a till added to a
COPY of an issued document, a separate append-only record linked to it by id (who added them, when).
The document's own row is not touched by it, now or ever.

Add-only and idempotent (the columns and the table are looked at first). Revision ID: a1eece573e4e,
revises 31958d027cef (re-chained at the integration, 10.10.2026; written on 5a7c9e1b3d2f).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "a1eece573e4e"
down_revision: Union[str, Sequence[str], None] = "31958d027cef"
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


def _tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


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
    if "transaction_customer_details" not in _tables():
        op.create_table(
            "transaction_customer_details",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("transaction_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("customer_name", sa.String(255), nullable=False),
            sa.Column("customer_vat_number", sa.String(20), nullable=False),
            sa.Column("customer_address", sa.String(500), nullable=True),
            sa.Column("customer_phone", sa.String(30), nullable=True),
            sa.Column("customer_email", sa.String(255), nullable=True),
            sa.Column("added_by_id", sa.String(100), nullable=True),
            sa.Column("added_by_name", sa.String(200), nullable=True),
            sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index(
            "ix_transaction_customer_details_transaction", "transaction_customer_details", ["transaction_id", "added_at"]
        )
        op.create_index("ix_transaction_customer_details_tenant", "transaction_customer_details", ["tenant_id"])


def downgrade() -> None:
    if "transaction_customer_details" in _tables():
        op.drop_table("transaction_customer_details")
    if INDEX in _indexes("transactions"):
        op.drop_index(INDEX, table_name="transactions")
    have = _columns("transactions")
    for column in ("reissue_of_transaction_id", "customer_email", "customer_vat_number"):
        if column in have:
            op.drop_column("transactions", column)
