"""independent till: "קופה עצמאית בתוך סניף" — docs/SPEC_INDEPENDENT_TILL.md

Revision ID: d7f1a3c5e9b2
Revises: c4e6a8b0d2f4
Create Date: 2026-10-06

One column, `pos_machines.independent_till` (boolean, default false): a till of the shop
that makes its own Z and stays outside the shop's LAN group. And one check,
`ck_pos_machines_independent_till_mode`: an independent till is always in `z_mode = 'till'`
— the database itself refuses a till that is both in the shop Z and independent.

Additive only: every existing till stays as it was (not independent). Idempotent: the
column and the check are added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd7f1a3c5e9b2'
down_revision: Union[str, Sequence[str], None] = 'c4e6a8b0d2f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CHECK = "ck_pos_machines_independent_till_mode"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("pos_machines")}
    if "independent_till" not in columns:
        op.add_column(
            "pos_machines",
            sa.Column("independent_till", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    checks = {c.get("name") for c in inspector.get_check_constraints("pos_machines")}
    if CHECK not in checks:
        op.create_check_constraint(CHECK, "pos_machines", "NOT independent_till OR z_mode = 'till'")


def downgrade() -> None:
    op.drop_constraint(CHECK, "pos_machines", type_="check")
    op.drop_column("pos_machines", "independent_till")
