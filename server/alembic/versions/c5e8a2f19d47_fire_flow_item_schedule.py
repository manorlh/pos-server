"""FIRE as in restaurants + scheduled items: schedule rules, scheduled KDS tasks, hints per employee

P:/specs/fire-restaurant-flow.md (the till contract in §8) and P:/specs/item-scheduled-send.md:

- products / categories `schedule_after_minutes` (0-600) and `schedule_after_course_ready` (a course id)
  — "itemScheduleRules": the item's table lines go X minutes after the send, or when course Y is ready
  (both: X minutes after Y is ready). Null inherits as `course_id` / `send_silently` do (product → its
  category → the parent); 0 with no course stops the inheritance. Existing rows: null (no rule).
- kds_tasks `scheduled_at` / `scheduled_note` — a held line that waits for its own time, drawn
  greyed on the screens ("מתוזמן 20:30"). Existing tasks: null.
- pos_users `hints_dismissed` — the "how it works" hints an employee chose not to see again
  ("אל תציג שוב"). Existing: null (none).

Revision ID: c5e8a2f19d47
Revises: 4ff6c2ab6d7c
Create Date: 2026-10-14

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c5e8a2f19d47'
down_revision: Union[str, Sequence[str], None] = '4ff6c2ab6d7c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ('products', 'categories'):
        op.add_column(table, sa.Column('schedule_after_minutes', sa.Integer(), nullable=True))
        op.add_column(table, sa.Column('schedule_after_course_ready', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('kds_tasks', sa.Column('scheduled_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('kds_tasks', sa.Column('scheduled_note', sa.String(60), nullable=True))
    op.add_column('pos_users', sa.Column('hints_dismissed', postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column('pos_users', 'hints_dismissed')
    op.drop_column('kds_tasks', 'scheduled_note')
    op.drop_column('kds_tasks', 'scheduled_at')
    for table in ('categories', 'products'):
        op.drop_column(table, 'schedule_after_course_ready')
        op.drop_column(table, 'schedule_after_minutes')
