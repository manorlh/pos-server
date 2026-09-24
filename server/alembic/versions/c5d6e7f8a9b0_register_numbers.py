"""number each shop's registers: till 1, 2, 3, never reused

`pos_machines.pos_number` has existed since `u7v8w9x0y1z2` and was never assigned, so
every document synced so far carries the pairing code (`machine_code`) in its register
field. From here on each machine gets a register number from its shop's own run.

Three pieces:

* `shop_register_sequences` — one counter row per shop, holding the *next* number,
  incremented under `SELECT … FOR UPDATE` in the transaction that assigns it. A table of
  its own, like `shop_z_sequences`, rather than a column on `shops`: allocating locks
  this row and not the shop row that every settings save and profile edit also writes.
  A counter rather than `max(pos_number) + 1` is what makes a number never come back:
  when a shop's top till is retired or removed, max+1 would issue its number again.
  `ON DELETE CASCADE` to `shops`, because a shop can only be deleted while nothing
  references it — no documents — so its run has nothing left to protect.
* `uq_pos_machines_shop_pos_number` — a plain UNIQUE on `(shop_id, pos_number)`. In
  Postgres NULLs compare distinct, so this is already "unique where both are non-null":
  shopless and unnumbered machines coexist freely, two tills in one shop cannot both be
  register 2.
* A backfill of every machine that has a shop, **including retired and inactive ones**,
  numbered per shop by `created_at` with `id` as tiebreak, then each counter seeded past
  it. Retired machines are numbered so that their numbers are taken and never reissued.
  The backfill only fills machines that have no number, and continues above the shop's
  counter as well as its machines, so running it again numbers stragglers without ever
  reissuing a number that was spent in between.

Backfilling is safe for the same reason it was for Z numbers (`v8w9x0y1z2a3`): this
identifier has never appeared on any printed or synced document, so assigning it now
contradicts nothing anyone holds. Documents already stored keep the `machine_code` they
were stamped with; only documents synced after this carry the number.

Not reachable by the backfill: machines removed with history. A soft delete has always
set `shop_id` to NULL, so those rows no longer say which shop they were in, and none of
their documents carries a number that could collide.

Idempotent in the way its neighbours are: the table and the constraint are created only
if absent, the backfill only touches machines that have no number yet (continuing each
shop's run above any number already present), and the seed only ever raises a counter.

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
Create Date: 2026-09-25 10:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "c5d6e7f8a9b0"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


_TABLE = "shop_register_sequences"
_UNIQUE = "uq_pos_machines_shop_pos_number"

#: A value the backfill and the seed treat as a register number. Bounded so the cast to
#: BIGINT cannot overflow on something typed by hand.
_NUMERIC = "'^[0-9]{1,9}$'"


def upgrade() -> None:
    bind = op.get_bind()
    offline = context.is_offline_mode()
    if offline:
        # `alembic upgrade --sql` has no database to inspect; emit every statement.
        tables: set[str] = set()
        uniques: set[str] = set()
    else:
        inspector = sa.inspect(bind)
        tables = set(inspector.get_table_names())
        uniques = {u["name"] for u in inspector.get_unique_constraints("pos_machines")}

    if _TABLE not in tables:
        op.create_table(
            _TABLE,
            sa.Column(
                "shop_id",
                UUID(as_uuid=True),
                sa.ForeignKey("shops.id", ondelete="CASCADE"),
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

    # Number every machine that has a shop and no number yet, per shop, in creation
    # order with the id as tiebreak — so re-running on a restored dump produces the
    # same numbers rather than an arbitrary permutation. Retired machines are included
    # on purpose: their numbers must be spent, not left for the next till.
    #
    # On a first run every shop starts at 1. On a re-run a shop continues above both
    # its highest number still on a machine *and* its counter: the counter remembers
    # numbers whose machines have since been removed or moved away, and starting from
    # the machines alone would hand one of those out again.
    op.execute(
        f"""
        WITH top AS (
            SELECT m.shop_id,
                   GREATEST(
                       COALESCE(
                           MAX(m.pos_number::bigint)
                               FILTER (WHERE m.pos_number ~ {_NUMERIC}),
                           0
                       ),
                       COALESCE(MAX(q.next_value) - 1, 0)
                   ) AS highest
              FROM pos_machines m
              LEFT JOIN {_TABLE} q ON q.shop_id = m.shop_id
             WHERE m.shop_id IS NOT NULL
             GROUP BY m.shop_id
        ),
        numbered AS (
            SELECT m.id,
                   top.highest + row_number() OVER (
                       PARTITION BY m.shop_id ORDER BY m.created_at, m.id
                   ) AS seq
              FROM pos_machines m
              JOIN top ON top.shop_id = m.shop_id
             WHERE m.pos_number IS NULL
        )
        UPDATE pos_machines p
           SET pos_number = numbered.seq::text
          FROM numbered
         WHERE p.id = numbered.id
        """
    )

    # Seed each shop's counter past the highest number now in use, so the next till
    # continues the run. Only ever raises a counter, never lowers one. Shops with no
    # machines get no row and start at 1 when their first till arrives.
    op.execute(
        f"""
        INSERT INTO {_TABLE} (shop_id, next_value)
        SELECT shop_id, MAX(pos_number::bigint) + 1
          FROM pos_machines
         WHERE shop_id IS NOT NULL
           AND pos_number ~ {_NUMERIC}
         GROUP BY shop_id
        ON CONFLICT (shop_id) DO UPDATE
           SET next_value = GREATEST({_TABLE}.next_value, EXCLUDED.next_value)
        """
    )

    if _UNIQUE not in uniques:
        if not offline:
            # The backfill cannot produce a duplicate, but a number typed in by hand
            # could already be one. Say which, rather than failing on the constraint
            # with only the index name to go on.
            clashes = bind.execute(
                sa.text(
                    """
                    SELECT shop_id, pos_number, count(*) AS n
                      FROM pos_machines
                     WHERE shop_id IS NOT NULL AND pos_number IS NOT NULL
                     GROUP BY shop_id, pos_number
                    HAVING count(*) > 1
                    """
                )
            ).fetchall()
            if clashes:
                raise RuntimeError(
                    "Two machines in one shop already share a register number; resolve "
                    f"these before upgrading: {[tuple(r) for r in clashes]}"
                )
        op.create_unique_constraint(_UNIQUE, "pos_machines", ["shop_id", "pos_number"])


def downgrade() -> None:
    op.drop_constraint(_UNIQUE, "pos_machines", type_="unique")
    op.drop_table(_TABLE)
    # `pos_machines.pos_number` values are left in place. Documents synced since the
    # upgrade already carry them, and clearing them would let a later re-upgrade
    # renumber the tills — handing a number that is on paper to a different machine.
