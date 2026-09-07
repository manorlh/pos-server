"""per-shop Z numbering

A Z report was identifiable only by its UUID. That is fine for a link and useless to a
bookkeeper: you cannot read a UUID off one report, compare it with the one before, and
notice that a close is missing. Each shop now has its own run of Z numbers — 1, 2, 3 …
across all its tills — and a gap in that run means a missing close.

Two pieces:

* `shop_z_sequences` — one counter row per shop, incremented under `SELECT … FOR UPDATE`
  inside the same transaction that inserts the Z. Deliberately not a Postgres SEQUENCE:
  `nextval()` is non-transactional, so a rolled-back close would burn a number and leave
  a hole indistinguishable from a lost Z. The hole has to mean one thing.
* `z_reports.shop_sequence_number` — the number itself. Nullable, because a terminal that
  is not assigned to a shop has no shop sequence to draw from and must still be able to
  close its day.

Existing Z reports **are** backfilled, in `closed_at` order per shop with the row id as
tiebreak. That is a departure from how this codebase has treated other new columns, and
the reason is that this one is not a claim about the past: a Z number is an identifier
that never appeared on any printed document, so assigning one now contradicts nothing a
customer or an inspector holds. Leaving them null would instead start every shop's run
at 1 today and make its earlier closes permanently unnumbered — the sequence would have
a hole at the front by construction. The counters are then seeded past the backfill so
the next live close continues the run rather than colliding with it.

Revision ID: v8w9x0y1z2a3
Revises: u7v8w9x0y1z2
Create Date: 2026-09-07 23:45:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "v8w9x0y1z2a3"
down_revision = "u7v8w9x0y1z2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "shop_sequence_number" not in {c["name"] for c in inspector.get_columns("z_reports")}:
        op.add_column(
            "z_reports", sa.Column("shop_sequence_number", sa.Integer(), nullable=True)
        )

    if "shop_z_sequences" not in inspector.get_table_names():
        op.create_table(
            "shop_z_sequences",
            sa.Column(
                "shop_id",
                sa.dialects.postgresql.UUID(as_uuid=True),
                sa.ForeignKey("shops.id"),
                primary_key=True,
            ),
            sa.Column("next_value", sa.BigInteger(), nullable=False, server_default="1"),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
        )

    # Backfill in close order per shop. `closed_at` is the fiscal ordering; `id` breaks a
    # tie so re-running on a restored dump produces identical numbers rather than an
    # arbitrary permutation.
    bind.execute(
        sa.text(
            """
            WITH numbered AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY shop_id ORDER BY closed_at, id
                       ) AS seq
                FROM z_reports
                WHERE shop_id IS NOT NULL
                  AND shop_sequence_number IS NULL
            )
            UPDATE z_reports z
               SET shop_sequence_number = numbered.seq
              FROM numbered
             WHERE z.id = numbered.id
            """
        )
    )

    # Seed each shop's counter past whatever the backfill assigned, so the next close
    # continues the run. Shops with no Z reports get no row and start at 1 on their
    # first close.
    bind.execute(
        sa.text(
            """
            INSERT INTO shop_z_sequences (shop_id, next_value)
            SELECT shop_id, MAX(shop_sequence_number) + 1
              FROM z_reports
             WHERE shop_id IS NOT NULL
               AND shop_sequence_number IS NOT NULL
             GROUP BY shop_id
            ON CONFLICT (shop_id) DO UPDATE
               SET next_value = GREATEST(
                       shop_z_sequences.next_value, EXCLUDED.next_value
                   )
            """
        )
    )


def downgrade() -> None:
    op.drop_table("shop_z_sequences")
    op.drop_column("z_reports", "shop_sequence_number")
