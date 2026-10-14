"""courses FIRE v2: menu_courses.auto_fire_minutes, products / categories send_silently

"שלבי הגשה, שלב 2" (P:/specs/courses-fire-v2.md):

- menu_courses.auto_fire_minutes — with the till parameter `autoFire` on `after_minutes`, the course
  goes by itself so many minutes after the course before it went out (§1). Existing courses: 15.
- products.send_silently, categories.send_silently — "יוצא בלי בון" (§2): the item's table lines are
  marked sent at "שלח" with no kitchen ticket and no KDS. Null inherits (product → its category → the
  parent category); existing rows inherit, which at the top is off.

Revision ID: b637e9784d58
Revises: ba584f6fb704
Create Date: 2026-10-14

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b637e9784d58'
down_revision: Union[str, Sequence[str], None] = 'ba584f6fb704'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'menu_courses',
        sa.Column('auto_fire_minutes', sa.Integer(), nullable=False, server_default=sa.text('15')),
    )
    op.add_column('products', sa.Column('send_silently', sa.Boolean(), nullable=True))
    op.add_column('categories', sa.Column('send_silently', sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column('categories', 'send_silently')
    op.drop_column('products', 'send_silently')
    op.drop_column('menu_courses', 'auto_fire_minutes')
