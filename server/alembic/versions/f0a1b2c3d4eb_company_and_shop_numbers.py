"""number every company in its tenant and every shop in its company, never reused

The till shows "חברה #N · סניף #M · קופה #K"; the register number (c5d6e7f8a9b0) was
the last of the three. The same design:

* `org_number_sequences` — one counter row per run, holding the *next* number:
  (`kind` = "company", `owner_id` = the tenant) and (`kind` = "shop", `owner_id` = the
  company). No foreign key: the owner is one of two tables, and a deleted company's
  counter must stay so its numbers stay spent.
* `companies.company_number`, `shops.shop_number` — with a plain UNIQUE on
  (`tenant_id`, `company_number`) and (`company_id`, `shop_number`); NULLs compare
  distinct, so unnumbered rows coexist.
* A backfill of every company (per tenant) and every shop (per company), inactive ones
  included so their numbers are spent, in creation order with the id as tiebreak, then
  each counter seeded past it. Only rows without a number are filled, continuing above
  both the run's numbers and its counter, so a re-run never reissues one.

Guarded like f0a1b2c3d4ea: the table, columns and constraints are created only if absent
(`create_all` may have made them), and the seed only ever raises a counter.

Parent is the till device model (f0a1b2c3d4ea).

Revision ID: f0a1b2c3d4eb
Revises: f0a1b2c3d4ea
Create Date: 2026-10-04 11:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f0a1b2c3d4eb"
down_revision = "f0a1b2c3d4ea"
branch_labels = None
depends_on = None


_TABLE = "org_number_sequences"

#: (table, number column, owner column, counter kind, unique constraint)
_RUNS = (
    ("companies", "company_number", "tenant_id", "company", "uq_companies_tenant_company_number"),
    ("shops", "shop_number", "company_id", "shop", "uq_shops_company_shop_number"),
)


def upgrade() -> None:
    bind = op.get_bind()
    offline = context.is_offline_mode()
    inspector = None if offline else sa.inspect(bind)
    tables = set() if offline else set(inspector.get_table_names())

    if _TABLE not in tables:
        op.create_table(
            _TABLE,
            sa.Column("kind", sa.String(16), primary_key=True),
            sa.Column("owner_id", UUID(as_uuid=True), primary_key=True),
            sa.Column("next_value", sa.BigInteger(), nullable=False, server_default="1"),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
        )

    for table, column, owner, kind, unique in _RUNS:
        columns = set() if offline else {c["name"] for c in inspector.get_columns(table)}
        if column not in columns:
            op.add_column(table, sa.Column(column, sa.Integer(), nullable=True))

        # Number the rows that have none, per owner, in creation order — continuing above
        # the owner's highest number and its counter, so a re-run never reissues one.
        op.execute(
            f"""
            WITH top AS (
                SELECT t.{owner} AS owner_id,
                       GREATEST(
                           COALESCE(MAX(t.{column}), 0),
                           COALESCE(MAX(q.next_value) - 1, 0)
                       ) AS highest
                  FROM {table} t
                  LEFT JOIN {_TABLE} q ON q.kind = '{kind}' AND q.owner_id = t.{owner}
                 WHERE t.{owner} IS NOT NULL
                 GROUP BY t.{owner}
            ),
            numbered AS (
                SELECT t.id,
                       top.highest + row_number() OVER (
                           PARTITION BY t.{owner} ORDER BY t.created_at, t.id
                       ) AS seq
                  FROM {table} t
                  JOIN top ON top.owner_id = t.{owner}
                 WHERE t.{column} IS NULL
            )
            UPDATE {table}
               SET {column} = numbered.seq
              FROM numbered
             WHERE {table}.id = numbered.id
            """
        )

        # Seed each run's counter past its highest number. Only ever raised.
        op.execute(
            f"""
            INSERT INTO {_TABLE} (kind, owner_id, next_value)
            SELECT '{kind}', {owner}, MAX({column}) + 1
              FROM {table}
             WHERE {owner} IS NOT NULL AND {column} IS NOT NULL
             GROUP BY {owner}
            ON CONFLICT (kind, owner_id) DO UPDATE
               SET next_value = GREATEST({_TABLE}.next_value, EXCLUDED.next_value)
            """
        )

        uniques = set() if offline else {u["name"] for u in inspector.get_unique_constraints(table)}
        if unique not in uniques:
            op.create_unique_constraint(unique, table, [owner, column])


def downgrade() -> None:
    for table, column, _owner, _kind, unique in reversed(_RUNS):
        op.drop_constraint(unique, table, type_="unique")
        op.drop_column(table, column)
    op.drop_table(_TABLE)
