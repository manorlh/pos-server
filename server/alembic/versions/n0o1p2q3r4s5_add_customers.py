"""add customers and link transactions to them

`transactions.customer_id` has always been a free-text String(100) that nothing
validated and nothing ever set. An Israeli business customer needs a name and a
ח.פ. / ע.מ. on a חשבונית מס, and neither can come out of an unvalidated string.

Two columns rather than one conversion, on purpose:

* `customer_id` stays exactly as it is — String(100), free text, still accepted from
  any till. Converting it to a UUID FK in place would mean casting whatever is already
  in it and nulling everything that does not parse, which is irreversible data loss on
  a live fiscal table for no gain; and typing the wire field as a UUID would make an
  older till's push fail schema validation at the door, over a field that has no
  bearing on whether the sale happened.

* `customer_ref_id` is the validated link, written server-side only when
  `customer_id` names a real customer **of the pushing machine's tenant**. This is the
  column the receipt and tax-export code joins on, so an unresolvable reference reads
  as "no customer" rather than producing a tax invoice addressed to nobody — or, worse,
  to another merchant's customer.

Customers are soft-deleted (`deleted_at`), never removed, because a till that has been
offline can push a sale tomorrow for a customer deleted today, and that document must
keep the identity it was issued to. The FK would refuse the write otherwise.

Revision ID: n0o1p2q3r4s5
Revises: m9n0o1p2q3r4
Create Date: 2026-08-28 12:10:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "n0o1p2q3r4s5"
down_revision = "m9n0o1p2q3r4"
branch_labels = None
depends_on = None


_TABLE = "customers"
_TENANT_INDEX = "ix_customers_tenant_id"
_VAT_INDEX = "ix_customers_vat_number"
_NAME_INDEX = "ix_customers_tenant_name"
_TX_INDEX = "ix_transactions_customer_ref_id"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _TABLE not in inspector.get_table_names():
        op.create_table(
            _TABLE,
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "tenant_id",
                UUID(as_uuid=True),
                sa.ForeignKey("tenants.id"),
                nullable=False,
            ),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("vat_number", sa.String(20), nullable=True),
            sa.Column("phone", sa.String(30), nullable=True),
            sa.Column("email", sa.String(255), nullable=True),
            # Address in parts, not one line: the OpenFormat customer fields on the
            # C100 document record are separate fields, and a single free-text line
            # cannot be split back into them reliably.
            sa.Column("address", sa.String(255), nullable=True),
            sa.Column("address_number", sa.String(20), nullable=True),
            sa.Column("city", sa.String(100), nullable=True),
            sa.Column("postal_code", sa.String(20), nullable=True),
            sa.Column("country", sa.String(60), nullable=True),
            sa.Column("notes", sa.String(1000), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            # Tombstone. Distinct from is_active: archived is "we do not sell to them
            # any more", deleted is "remove them from the tills".
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            # NULLs never collide under a Postgres unique constraint, so the vast
            # majority of customers (no VAT number) are unaffected while two rows
            # cannot claim the same registration inside one tenant.
            sa.UniqueConstraint("tenant_id", "vat_number", name="uq_customer_vat_tenant"),
        )
        op.create_index(_TENANT_INDEX, _TABLE, ["tenant_id"])
        op.create_index(_VAT_INDEX, _TABLE, ["vat_number"])
        # The list view is always "this tenant's customers, by name".
        op.create_index(_NAME_INDEX, _TABLE, ["tenant_id", "name"])

    tx_columns = {c["name"] for c in inspector.get_columns("transactions")}
    if "customer_ref_id" not in tx_columns:
        op.add_column(
            "transactions",
            sa.Column(
                "customer_ref_id",
                UUID(as_uuid=True),
                sa.ForeignKey("customers.id"),
                nullable=True,
            ),
        )
        op.create_index(_TX_INDEX, "transactions", ["customer_ref_id"])


def downgrade() -> None:
    op.drop_index(_TX_INDEX, table_name="transactions")
    op.drop_column("transactions", "customer_ref_id")
    op.drop_index(_NAME_INDEX, table_name=_TABLE)
    op.drop_index(_VAT_INDEX, table_name=_TABLE)
    op.drop_index(_TENANT_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
