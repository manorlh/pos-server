"""Card attempt commands: the check's answer, decisions that wait, the mismatch confirmation

Revision ID: 8c4a2f6e1b93
Revises: 5e1c9b7d3a80
Create Date: 2026-10-08

The owner: "את ההכרעה — שיהיה ניתן לבצע בענן, והוא יכניס את העסקה או יבטל אותה לאחר בדיקה".
The cloud's decision is the main path for an unresolved card (app/services/card_attempt_commands.py):

* `details` — what the terminal said on a check (verdict, its uid, time, amount…);
* `expires_at` nullable — a decision waits for the till as long as it takes (a check still ends
  after 24 h); the pending decisions written before this lose their end;
* `verdict_at_decision`, `check_command_id`, `mismatch_confirmed` — a decision against the
  check (or with none) is made only on the manager's explicit confirmation, kept here.

Idempotent: each column is added only when missing, the column made nullable only when it is not.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '8c4a2f6e1b93'
down_revision: Union[str, Sequence[str], None] = '5e1c9b7d3a80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'card_attempt_commands'
COLUMNS = (
    ('details', lambda: sa.Column('details', postgresql.JSONB(), nullable=True)),
    ('verdict_at_decision', lambda: sa.Column('verdict_at_decision', sa.String(16), nullable=True)),
    ('check_command_id', lambda: sa.Column('check_command_id', postgresql.UUID(as_uuid=True), nullable=True)),
    (
        'mismatch_confirmed',
        lambda: sa.Column('mismatch_confirmed', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        return  # 5e1c9b7d3a80 creates it; nothing to widen
    columns = {c['name']: c for c in inspector.get_columns(TABLE)}
    for name, make in COLUMNS:
        if name not in columns:
            op.add_column(TABLE, make())
    if not columns['expires_at'].get('nullable', True):
        op.alter_column(TABLE, 'expires_at', existing_type=sa.DateTime(timezone=True), nullable=True)
    bind.execute(sa.text(
        f"UPDATE {TABLE} SET expires_at = NULL "
        "WHERE action IN ('mark_approved', 'mark_not_approved') AND status = 'pending' AND expires_at IS NOT NULL"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"UPDATE {TABLE} SET expires_at = requested_at + interval '24 hours' WHERE expires_at IS NULL"))
    op.alter_column(TABLE, 'expires_at', existing_type=sa.DateTime(timezone=True), nullable=False)
    for name, _make in reversed(COLUMNS):
        op.drop_column(TABLE, name)
