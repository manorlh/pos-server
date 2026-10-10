"""Card attempt commands: a manager's check / decision for an unresolved card attempt

Revision ID: 5e1c9b7d3a80
Revises: 3b8f6d2a9c41
Create Date: 2026-10-08

The owner: "אני לא רואה איפה התשלום התקוע הזה בשום מקום — תוודא שלא יקרה יותר". A card attempt
left UNKNOWN now reaches "עסקאות שלא הושלמו" as outcome `unresolved` (and, found charged later,
`approved_late`) — `failed_payment_attempts.outcome` is free text, so no schema change there.
This table holds the manager's commands to the till that made it (app/models/card_attempt_command.py):
check on the terminal, or decide approved / not approved; carried on the heartbeat
(`pendingCardCommands`) and answered by the till.

Idempotent: the auto-reloading API may have created the table already (create_all at
startup) — then only the missing indexes / constraints are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '5e1c9b7d3a80'
down_revision: Union[str, Sequence[str], None] = '3b8f6d2a9c41'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'card_attempt_commands'
CHECKS = (
    ('ck_card_attempt_commands_action', "action IN ('check', 'mark_approved', 'mark_not_approved')"),
    (
        'ck_card_attempt_commands_status',
        "status IN ('pending', 'done', 'failed', 'not_found', 'busy', 'expired', 'cancelled')",
    ),
)
INDEXES = (
    ('ix_card_attempt_commands_tenant_id', ['tenant_id']),
    ('ix_card_attempt_commands_machine_status', ['machine_id', 'status']),
    ('ix_card_attempt_commands_attempt', ['failed_payment_attempt_id']),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=True),
            sa.Column('shop_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column('machine_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('pos_machines.id'), nullable=False),
            sa.Column('failed_payment_attempt_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column('vuid', sa.String(100), nullable=True),
            sa.Column('action', sa.String(24), nullable=False),
            sa.Column('requested_by_user_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column('requested_by_name', sa.String(200), nullable=True),
            sa.Column('requested_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('status', sa.String(16), nullable=False, server_default='pending'),
            sa.Column('result_outcome', sa.String(16), nullable=True),
            sa.Column('result_message', sa.String(300), nullable=True),
            sa.Column('answered_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('cancelled_by_name', sa.String(200), nullable=True),
            *[sa.CheckConstraint(sql, name=name) for name, sql in CHECKS],
        )
        inspector = sa.inspect(bind)
    else:
        have_checks = {c.get('name') for c in inspector.get_check_constraints(TABLE)}
        for name, sql in CHECKS:
            if name not in have_checks:
                op.create_check_constraint(name, TABLE, sql)
    have = {ix['name'] for ix in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    op.drop_table(TABLE)
