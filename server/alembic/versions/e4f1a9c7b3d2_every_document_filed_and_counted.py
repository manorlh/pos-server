"""Every document filed under the till that issued it, and counted exactly once

* `transactions.claimed_shift_id` — the shift id exactly as the till sent it (not a foreign
  key): a document waiting for its shift is moved in when that shift reaches the cloud.
* `transactions.pushed_by_machine_id` — the machine whose token delivered the document, when
  it is not the machine that issued it (a till re-paired as a new machine sends what its
  previous machine issued; the document is filed under that previous machine).
* `transactions.number_conflict_of` / `duplicate_copy` — a second document with the number
  another document of the same till and series already holds: stored, flagged, and — when
  it is the same document again (`duplicate_copy`) — left out of every total.
* The unique key on (machine, series, number) becomes a partial unique index over the
  documents that hold their number (`number_conflict_of IS NULL`), so the second one lands.
* `pos_machines.predecessor_machine_id` / `repair_handover` — the machine this device was
  before it was re-paired as a new machine, and what that machine still owed at the re-pair.
* `pos_machines.pending_z_adjustments` — corrections to documents already in a Z, waiting
  for the till's next Z.

Idempotent (the auto-reloading dev API may run `create_all` first): every column, index and
constraint is looked at before it is added or dropped. Never downgraded in place.

Revision ID: e4f1a9c7b3d2
Revises: 5b9d3f7a2c18
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e4f1a9c7b3d2"
down_revision: Union[str, Sequence[str], None] = "5b9d3f7a2c18"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_UNIQUE = "uq_tx_machine_series_number"
PRIMARY_INDEX = "uq_tx_machine_series_number_primary"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def _uniques(insp, table: str) -> set:
    return set() if insp is None else {u["name"] for u in insp.get_unique_constraints(table)}


def upgrade() -> None:
    insp = _inspector()

    tx_cols = _columns(insp, "transactions")
    if "claimed_shift_id" not in tx_cols:
        op.add_column("transactions", sa.Column("claimed_shift_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "pushed_by_machine_id" not in tx_cols:
        op.add_column("transactions", sa.Column("pushed_by_machine_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "number_conflict_of" not in tx_cols:
        op.add_column("transactions", sa.Column("number_conflict_of", postgresql.UUID(as_uuid=True), nullable=True))
    if "duplicate_copy" not in tx_cols:
        op.add_column(
            "transactions",
            sa.Column("duplicate_copy", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    have = _indexes(insp, "transactions")
    for name, cols in (
        ("ix_transactions_claimed_shift", ["claimed_shift_id"]),
        ("ix_transactions_number_conflict_of", ["number_conflict_of"]),
    ):
        if name not in have:
            op.create_index(name, "transactions", cols)
    if PRIMARY_INDEX not in have:
        op.create_index(
            PRIMARY_INDEX,
            "transactions",
            ["machine_id", "document_series", "transaction_number"],
            unique=True,
            postgresql_where=sa.text("number_conflict_of IS NULL"),
        )
    if OLD_UNIQUE in _uniques(insp, "transactions"):
        op.drop_constraint(OLD_UNIQUE, "transactions", type_="unique")
    elif OLD_UNIQUE in have:
        op.drop_index(OLD_UNIQUE, table_name="transactions")

    m_cols = _columns(insp, "pos_machines")
    if "predecessor_machine_id" not in m_cols:
        op.add_column("pos_machines", sa.Column("predecessor_machine_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "repair_handover" not in m_cols:
        op.add_column("pos_machines", sa.Column("repair_handover", postgresql.JSONB(), nullable=True))
    if "pending_z_adjustments" not in m_cols:
        op.add_column("pos_machines", sa.Column("pending_z_adjustments", postgresql.JSONB(), nullable=True))
    if "ix_pos_machines_predecessor_machine_id" not in _indexes(insp, "pos_machines"):
        op.create_index("ix_pos_machines_predecessor_machine_id", "pos_machines", ["predecessor_machine_id"])


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_index("ix_pos_machines_predecessor_machine_id", table_name="pos_machines")
    op.drop_column("pos_machines", "pending_z_adjustments")
    op.drop_column("pos_machines", "repair_handover")
    op.drop_column("pos_machines", "predecessor_machine_id")
    op.create_unique_constraint(OLD_UNIQUE, "transactions", ["machine_id", "document_series", "transaction_number"])
    op.drop_index(PRIMARY_INDEX, table_name="transactions")
    op.drop_index("ix_transactions_number_conflict_of", table_name="transactions")
    op.drop_index("ix_transactions_claimed_shift", table_name="transactions")
    op.drop_column("transactions", "duplicate_copy")
    op.drop_column("transactions", "number_conflict_of")
    op.drop_column("transactions", "pushed_by_machine_id")
    op.drop_column("transactions", "claimed_shift_id")
