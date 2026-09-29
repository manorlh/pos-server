"""mixed basket: basket_id, refund_of_item_id, buyer details, exchange totals, tolerant refund link, till-user approver

One till basket that mixes sold and returned lines is committed as several documents
sharing a `basketId` (docs/SHIFTS_API.md §1.2a):

* `transactions.basket_id` (nullable, indexed) — the basket a document belongs to;
* `transaction_items.refund_of_item_id` (nullable, indexed, **no** foreign key) — the
  original sale line a credit-note line returns;
* `transactions.customer_name` / `customer_phone` / `customer_address` — the buyer's
  details as printed (the regulation requires them on a return);
* `shifts.total_exchange`, `z_reports.total_exchange` — the net of the `exchange` tender
  legs, shown apart from cash and card. Null on rows computed before this;
* `transactions.approved_by_pos_user_id` (nullable, FK `pos_users`) — the till user
  (a shop manager on the till's roster) who approved a refund or a discount, beside the
  existing `approved_by_user_id` for a cloud account. At most one of the two is set.

And the known issue with `transactions.refund_of_transaction_id`: its foreign key made a
credit note that reached the cloud before its original fail to store. The constraint is
dropped (the link is resolved when read, within the tenant, and the original is settled
when it arrives) and the column is indexed instead, since the settlement and the export
look credit notes up by it.

No data changes: nothing held carries a basket, an item link or an exchange leg yet.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3 (shop areas)
Create Date: 2026-09-30 09:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d9e0f1a2b3c4"
down_revision = "c8d9e0f1a2b3"
branch_labels = None
depends_on = None


_REFUND_FK = "transactions_refund_of_transaction_id_fkey"


def upgrade() -> None:
    op.add_column("transactions", sa.Column("basket_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index("ix_transactions_basket", "transactions", ["basket_id"])
    op.add_column("transactions", sa.Column("customer_name", sa.String(255), nullable=True))
    op.add_column("transactions", sa.Column("customer_phone", sa.String(30), nullable=True))
    op.add_column("transactions", sa.Column("customer_address", sa.String(500), nullable=True))
    op.add_column(
        "transactions",
        sa.Column(
            "approved_by_pos_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("pos_users.id", name="fk_transactions_approved_by_pos_user_id_pos_users"),
            nullable=True,
        ),
    )

    op.add_column(
        "transaction_items",
        sa.Column("refund_of_item_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_transaction_items_refund_of_item", "transaction_items", ["refund_of_item_id"]
    )

    op.add_column("shifts", sa.Column("total_exchange", sa.Numeric(12, 2), nullable=True))
    op.add_column("z_reports", sa.Column("total_exchange", sa.Numeric(12, 2), nullable=True))

    op.execute(f"ALTER TABLE transactions DROP CONSTRAINT IF EXISTS {_REFUND_FK}")
    op.create_index("ix_transactions_refund_of", "transactions", ["refund_of_transaction_id"])


def downgrade() -> None:
    op.drop_index("ix_transactions_refund_of", table_name="transactions")
    # NOT VALID: credit notes stored ahead of their originals while the constraint was
    # gone must survive the downgrade — they are fiscal documents. New rows are checked.
    op.execute(
        f"ALTER TABLE transactions ADD CONSTRAINT {_REFUND_FK} "
        "FOREIGN KEY (refund_of_transaction_id) REFERENCES transactions (id) NOT VALID"
    )

    op.drop_column("z_reports", "total_exchange")
    op.drop_column("shifts", "total_exchange")

    op.drop_index("ix_transaction_items_refund_of_item", table_name="transaction_items")
    op.drop_column("transaction_items", "refund_of_item_id")

    op.drop_column("transactions", "approved_by_pos_user_id")
    op.drop_column("transactions", "customer_address")
    op.drop_column("transactions", "customer_phone")
    op.drop_column("transactions", "customer_name")
    op.drop_index("ix_transactions_basket", table_name="transactions")
    op.drop_column("transactions", "basket_id")
