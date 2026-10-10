"""insight_quick_actions + promotions.announcement: the insights' one-tap actions and "הודעה לעובדים"

Revision ID: e5b8d2c6a1f9
Revises: 6d818753b5ec
Create Date: 2026-10-09

Re-chained at the integration merge (integration/fri, 09.10.2026): written on 6b1e9d4f2a87,
now after feat/home-board's 6d818753b5ec (users.preferences) so the chain stays linear. The two
touch different tables; the upgrade itself is unchanged.

* `insight_quick_actions` — "פעולות מהירות" from the insights (docs/SPEC_INSIGHTS.md §10): a
  quick message to the tills (a non-blocking banner through `till_messages`) or a quick
  promotion (through `promotions`) on a product, a category or the whole basket ("מבצע
  מזדמן", a happy hour), or a message to a till that stands out; its target, the tills it
  reached, when it ends by itself, who did it and whether it was cancelled. The audit of
  these actions and the anchor of their result.
* `promotions.announcement` — "שלח הודעה לעובדים" (app/services/promotion_announcements.py):
  the settings and the till messages a promotion planned at its start and its end. Null
  for every existing promotion: never asked for.

Idempotent: the auto-reloading API runs `create_all` at startup, so the table may exist
before this runs — then only what is missing (indexes, the column) is added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e5b8d2c6a1f9'
down_revision: Union[str, Sequence[str], None] = '6d818753b5ec'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TABLE = 'insight_quick_actions'
INDEXES = (
    ('ix_insight_quick_actions_tenant_created', ['tenant_id', 'created_at']),
    ('ix_insight_quick_actions_tenant_product', ['tenant_id', 'product_id']),
)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def upgrade() -> None:
    if _offline():
        has_table, existing, promo_columns = False, set(), set()
    else:
        inspector = sa.inspect(op.get_bind())
        has_table = inspector.has_table(TABLE)
        existing = {i['name'] for i in inspector.get_indexes(TABLE)} if has_table else set()
        promo_columns = {c['name'] for c in inspector.get_columns('promotions')}

    if not has_table:
        op.create_table(
            TABLE,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('kind', sa.String(16), nullable=False),
            sa.Column('product_id', UUID, sa.ForeignKey('products.id', ondelete='SET NULL'), nullable=True),
            sa.Column('product_name', sa.String(255), nullable=True),
            sa.Column('category_id', UUID, sa.ForeignKey('categories.id', ondelete='SET NULL'), nullable=True),
            sa.Column('category_name', sa.String(255), nullable=True),
            sa.Column('target_level', sa.String(16), nullable=False),
            sa.Column('target_id', UUID, nullable=False),
            sa.Column('target_name', sa.String(255), nullable=True),
            sa.Column('machine_ids', sa.JSON(), nullable=False),
            sa.Column('till_message_ids', sa.JSON(), nullable=True),
            sa.Column('promotion_id', UUID, nullable=True),
            sa.Column('params', sa.JSON(), nullable=True),
            sa.Column('source', sa.String(32), nullable=True),
            sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('ends_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('cancelled_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("kind IN ('message', 'promotion')", name='ck_insight_quick_actions_kind'),
        )
    for name, columns in INDEXES:
        if name not in existing:
            op.create_index(name, TABLE, columns)

    if 'announcement' not in promo_columns:
        op.add_column('promotions', sa.Column('announcement', sa.JSON(), nullable=True))


def downgrade() -> None:
    offline = _offline()
    inspector = None if offline else sa.inspect(op.get_bind())
    if offline or 'announcement' in {c['name'] for c in inspector.get_columns('promotions')}:
        op.drop_column('promotions', 'announcement')
    if not offline and not inspector.has_table(TABLE):
        return
    for name, _columns in reversed(INDEXES):
        op.drop_index(name, table_name=TABLE)
    op.drop_table(TABLE)
