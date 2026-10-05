"""Specials banner on the tills, and the upsell "חלון בחירה"

Revision ID: 5f1c3a7e9d20
Revises: a7d3e9b1c5f2
Create Date: 2026-10-06

* `till_messages.display` ("fullscreen" | "banner", default "fullscreen" — every message
  already sent stays full-screen), `product_id` (a banner's product, SET NULL when the
  product goes) and `color` (a banner's preset).
* `upsell_rules`: `options` (several products and/or categories), `prompt`, `display`
  ("card" | "popup", default "card"), `place` ("quick" | "tables" | "both", default
  "both"), `skip_if_present` (default true — what an "add" rule always did) and
  `once_per_order` (default false — once per line, as before). `product_id` may now be
  null (a rule of several options), and `trigger_type` may be "order" ("בכל הזמנה").
* `upsell_stats.declined` ("הלקוח סירב") and `accepted_options` (taken, per option).

Additive and idempotent: a column is added only when missing; the check constraints are
re-created only to widen them (every existing row keeps satisfying them).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '5f1c3a7e9d20'
down_revision: Union[str, Sequence[str], None] = 'a7d3e9b1c5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _message_columns():
    return [
        sa.Column('display', sa.String(16), nullable=False, server_default='fullscreen'),
        sa.Column(
            'product_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('products.id', ondelete='SET NULL', name='fk_till_messages_product_id'),
            nullable=True,
        ),
        sa.Column('color', sa.String(16), nullable=True),
    ]


def _rule_columns():
    return [
        sa.Column('options', sa.JSON(), nullable=True),
        sa.Column('prompt', sa.String(200), nullable=True),
        sa.Column('display', sa.String(16), nullable=False, server_default='card'),
        sa.Column('place', sa.String(16), nullable=False, server_default='both'),
        sa.Column('skip_if_present', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('once_per_order', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    ]


def _stat_columns():
    return [
        sa.Column('declined', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('accepted_options', sa.JSON(), nullable=True),
    ]


def _add_missing(table, columns):
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}
    for column in columns:
        if column.name not in existing:
            op.add_column(table, column)


def _checks(table):
    return {c['name'] for c in sa.inspect(op.get_bind()).get_check_constraints(table)}


def upgrade() -> None:
    _add_missing('till_messages', _message_columns())
    if 'ck_till_messages_display' not in _checks('till_messages'):
        op.create_check_constraint('ck_till_messages_display', 'till_messages', "display IN ('fullscreen', 'banner')")

    _add_missing('upsell_rules', _rule_columns())
    op.alter_column('upsell_rules', 'product_id', existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    checks = _checks('upsell_rules')
    if 'ck_upsell_rules_trigger_type' in checks:
        op.drop_constraint('ck_upsell_rules_trigger_type', 'upsell_rules', type_='check')
    op.create_check_constraint(
        'ck_upsell_rules_trigger_type', 'upsell_rules', "trigger_type IN ('product', 'category', 'order')",
    )
    if 'ck_upsell_rules_display' not in checks:
        op.create_check_constraint('ck_upsell_rules_display', 'upsell_rules', "display IN ('card', 'popup')")
    if 'ck_upsell_rules_place' not in checks:
        op.create_check_constraint('ck_upsell_rules_place', 'upsell_rules', "place IN ('quick', 'tables', 'both')")

    _add_missing('upsell_stats', _stat_columns())


def downgrade() -> None:
    # Never run with parallel work on the dev database (it drops columns other rows use).
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('upsell_stats')}
    for column in reversed(_stat_columns()):
        if column.name in existing:
            op.drop_column('upsell_stats', column.name)
    checks = _checks('upsell_rules')
    for name in ('ck_upsell_rules_place', 'ck_upsell_rules_display'):
        if name in checks:
            op.drop_constraint(name, 'upsell_rules', type_='check')
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('upsell_rules')}
    for column in reversed(_rule_columns()):
        if column.name in existing:
            op.drop_column('upsell_rules', column.name)
    if 'ck_till_messages_display' in _checks('till_messages'):
        op.drop_constraint('ck_till_messages_display', 'till_messages', type_='check')
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('till_messages')}
    for column in reversed(_message_columns()):
        if column.name in existing:
            op.drop_column('till_messages', column.name)
