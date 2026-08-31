"""add companies.parent_company_id (nested companies)

A group that owns several trading companies had nowhere to live: the hierarchy was
Tenant → Company → Shop → POSMachine and `Company` had no parent. This adds a nullable
self-referencing FK so the company table becomes a forest.

Nullable, with no backfill: every existing company is a root, which is exactly what it
was before this migration. Nothing about an existing row changes meaning.

Indexed because it is read on the hot path — the authorization recursive CTE in
`app/services/company_hierarchy.py` walks `parent_company_id = <id>` at every level, and
without the index that is a sequential scan of `companies` per level per request.

Deliberately NOT added here:

* No `CHECK (id <> parent_company_id)`. Self-parenting is one shape of cycle and the
  interesting ones (A→B→A) are unreachable by a column constraint anyway, so the rule
  lives in one place — the write guard in `app/routers/companies.py` — rather than half
  in SQL and half in Python. The CTE is depth-capped so bad data cannot hang a request.
* No `ON DELETE` clause. Deleting a company that still has children is refused by the
  router with 422, mirroring how a category with children is refused. A cascade would
  silently delete subsidiaries (and their shops' FK parents); SET NULL would silently
  reorganise the group. Neither is a decision a DELETE on the parent should make.

Revision ID: p2q3r4s5t6u7
Revises: o1p2q3r4s5t6
Create Date: 2026-08-31 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "p2q3r4s5t6u7"
down_revision = "o1p2q3r4s5t6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("companies")}
    if "parent_company_id" not in columns:
        op.add_column(
            "companies",
            sa.Column("parent_company_id", UUID(as_uuid=True), nullable=True),
        )
        op.create_foreign_key(
            "fk_companies_parent_company_id_companies",
            "companies",
            "companies",
            ["parent_company_id"],
            ["id"],
        )

    indexes = {i["name"] for i in inspector.get_indexes("companies")}
    if "ix_companies_parent_company_id" not in indexes:
        op.create_index(
            "ix_companies_parent_company_id", "companies", ["parent_company_id"]
        )


def downgrade() -> None:
    op.drop_index("ix_companies_parent_company_id", table_name="companies")
    op.drop_constraint(
        "fk_companies_parent_company_id_companies", "companies", type_="foreignkey"
    )
    op.drop_column("companies", "parent_company_id")
