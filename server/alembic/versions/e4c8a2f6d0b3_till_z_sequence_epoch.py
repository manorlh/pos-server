"""till Z sequence epoch: an independent till starts at Z 1 — docs/SPEC_INDEPENDENT_TILL.md §3.1

Revision ID: e4c8a2f6d0b3
Revises: c9f1b3d5e7a0
Create Date: 2026-10-06

The owner: "מעבר בין קופה בסניפי לעצמאי מתחיל את הקופה מ-Z אחד (העצמאית)". A till made
independent starts a new run of its own Zs at 1. So a till's run is (machine, epoch):

* `machine_z_sequences.epoch` (int, default 0) and `started_at` (when the run began, null
  for the till's first run, from before epochs existed);
* `z_reports.machine_sequence_epoch` (int, default 0): the run a till Z is numbered in;
* the uniqueness of a till Z's number is per run: `uq_z_reports_machine_sequence` becomes
  (machine_id, machine_sequence_epoch, machine_sequence_number) — an old "till 6, Z 1" and a
  new one never collide.

Additive: every existing row is epoch 0, as before. Idempotent.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e4c8a2f6d0b3'
down_revision: Union[str, Sequence[str], None] = 'c9f1b3d5e7a0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX = "uq_z_reports_machine_sequence"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    seq_cols = {c["name"] for c in inspector.get_columns("machine_z_sequences")}
    if "epoch" not in seq_cols:
        op.add_column(
            "machine_z_sequences",
            sa.Column("epoch", sa.Integer(), nullable=False, server_default="0"),
        )
    if "started_at" not in seq_cols:
        op.add_column("machine_z_sequences", sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
    z_cols = {c["name"] for c in inspector.get_columns("z_reports")}
    if "machine_sequence_epoch" not in z_cols:
        op.add_column(
            "z_reports",
            sa.Column("machine_sequence_epoch", sa.Integer(), nullable=False, server_default="0"),
        )
    indexes = {i["name"]: i for i in inspector.get_indexes("z_reports")}
    held = indexes.get(INDEX)
    if held is not None and "machine_sequence_epoch" not in (held.get("column_names") or []):
        op.drop_index(INDEX, table_name="z_reports")
        held = None
    if held is None:
        op.create_index(
            INDEX,
            "z_reports",
            ["machine_id", "machine_sequence_epoch", "machine_sequence_number"],
            unique=True,
            postgresql_where=sa.text("machine_sequence_number IS NOT NULL"),
        )


def downgrade() -> None:
    op.drop_index(INDEX, table_name="z_reports")
    op.create_index(
        INDEX,
        "z_reports",
        ["machine_id", "machine_sequence_number"],
        unique=True,
        postgresql_where=sa.text("machine_sequence_number IS NOT NULL"),
    )
    op.drop_column("z_reports", "machine_sequence_epoch")
    op.drop_column("machine_z_sequences", "started_at")
    op.drop_column("machine_z_sequences", "epoch")
