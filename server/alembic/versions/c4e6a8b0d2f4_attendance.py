"""attendance: "נוכחות עובדים" phase 1 — docs/SPEC_ATTENDANCE.md

Revision ID: c4e6a8b0d2f4
Revises: b5e7d9f1a3c6
Create Date: 2026-10-06

Four new tables (app/models/attendance.py): `employee_roles` (job titles with a tip
weight), `attendance_shifts`, `attendance_breaks` and `attendance_adjustments` (corrections
and manager actions — the audit). And one nullable column, `pos_users.employee_role_id`:
an employee's job title, never their permissions. Additive only: nothing existing changes.

Idempotent: the auto-reloading API runs `create_all` at startup, so the tables may exist
before this runs — then only what is missing (indexes, the column) is added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c4e6a8b0d2f4'
down_revision: Union[str, Sequence[str], None] = 'b5e7d9f1a3c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def _ts(name, nullable=True, now=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable,
                     server_default=sa.func.now() if now else None)


def _indexes(inspector, table, wanted):
    existing = {i['name'] for i in inspector.get_indexes(table)}
    for name, columns, unique in wanted:
        if name not in existing:
            op.create_index(name, table, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('employee_roles'):
        op.create_table(
            'employee_roles',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('name', sa.String(60), nullable=False),
            sa.Column('tip_weight', sa.Numeric(6, 3), nullable=False, server_default='1'),
            sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
            sa.Column('is_active', sa.Boolean, nullable=False, server_default=sa.true()),
            _ts('created_at', False, True),
            _ts('updated_at', False, True),
            sa.UniqueConstraint('tenant_id', 'name', name='uq_employee_roles_tenant_name'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'employee_roles', [('ix_employee_roles_tenant_id', ['tenant_id'], False)])

    pos_user_columns = {c['name'] for c in inspector.get_columns('pos_users')}
    if 'employee_role_id' not in pos_user_columns:
        op.add_column(
            'pos_users',
            sa.Column('employee_role_id', UUID, sa.ForeignKey('employee_roles.id', ondelete='SET NULL'), nullable=True),
        )

    if not inspector.has_table('attendance_shifts'):
        op.create_table(
            'attendance_shifts',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('company_id', UUID, nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('area_id', UUID, nullable=True),
            sa.Column('pos_user_id', UUID, sa.ForeignKey('pos_users.id', ondelete='CASCADE'), nullable=False),
            sa.Column('employee_role_id', UUID, nullable=True),
            sa.Column('employee_role_name', sa.String(60), nullable=True),
            sa.Column('status', sa.String(20), nullable=False, server_default='working'),
            sa.Column('source', sa.String(16), nullable=False, server_default='till'),
            _ts('clock_in_at', False),
            _ts('clock_in_device_at'),
            _ts('clock_in_server_at'),
            sa.Column('clock_in_machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            _ts('clock_out_at'),
            _ts('clock_out_device_at'),
            _ts('clock_out_server_at'),
            sa.Column('clock_out_machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            sa.Column('closed_by', sa.String(16), nullable=True),
            sa.Column('closed_by_name', sa.String(200), nullable=True),
            sa.Column('closed_by_pos_user_id', sa.String(100), nullable=True),
            sa.Column('closed_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('close_reason', sa.Text, nullable=True),
            sa.Column('clock_skew_seconds', sa.Integer, nullable=True),
            sa.Column('flags', JSONB, nullable=True),
            sa.Column('details', JSONB, nullable=True),
            _ts('created_at', False, True),
            _ts('updated_at', False, True),
            sa.CheckConstraint(
                "status IN ('working', 'on_break', 'finished', 'pending_approval')",
                name='ck_attendance_shifts_status',
            ),
            sa.CheckConstraint("source IN ('till', 'dashboard')", name='ck_attendance_shifts_source'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'attendance_shifts', [
        ('ix_attendance_shifts_shop_in', ['shop_id', 'clock_in_at'], False),
        ('ix_attendance_shifts_user_in', ['pos_user_id', 'clock_in_at'], False),
        ('ix_attendance_shifts_tenant_status', ['tenant_id', 'status'], False),
    ])

    if not inspector.has_table('attendance_breaks'):
        op.create_table(
            'attendance_breaks',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('shift_id', UUID, sa.ForeignKey('attendance_shifts.id', ondelete='CASCADE'), nullable=False),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('pos_user_id', UUID, nullable=False),
            sa.Column('source', sa.String(16), nullable=False, server_default='till'),
            _ts('start_at', False),
            _ts('start_device_at'),
            _ts('start_server_at'),
            sa.Column('start_machine_id', UUID, nullable=True),
            _ts('end_at'),
            _ts('end_device_at'),
            _ts('end_server_at'),
            sa.Column('end_machine_id', UUID, nullable=True),
            _ts('created_at', False, True),
            _ts('updated_at', False, True),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'attendance_breaks', [
        ('ix_attendance_breaks_shift', ['shift_id', 'start_at'], False),
        ('ix_attendance_breaks_tenant_id', ['tenant_id'], False),
    ])

    if not inspector.has_table('attendance_adjustments'):
        op.create_table(
            'attendance_adjustments',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('company_id', UUID, nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('shift_id', UUID, sa.ForeignKey('attendance_shifts.id', ondelete='SET NULL'), nullable=True),
            sa.Column('break_id', UUID, nullable=True),
            sa.Column('pos_user_id', UUID, sa.ForeignKey('pos_users.id', ondelete='CASCADE'), nullable=False),
            sa.Column('kind', sa.String(20), nullable=False),
            sa.Column('field', sa.String(20), nullable=True),
            _ts('original_time'),
            _ts('requested_time'),
            _ts('requested_end_time'),
            _ts('approved_time'),
            _ts('approved_end_time'),
            sa.Column('reason', sa.Text, nullable=True),
            sa.Column('status', sa.String(16), nullable=False, server_default='pending'),
            sa.Column('source', sa.String(16), nullable=False, server_default='till'),
            sa.Column('requested_by_pos_user_id', sa.String(100), nullable=True),
            sa.Column('requested_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('requested_by_name', sa.String(200), nullable=True),
            sa.Column('requested_machine_id', UUID, nullable=True),
            _ts('requested_device_at'),
            _ts('requested_at', False, True),
            sa.Column('decided_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('decided_by_pos_user_id', sa.String(100), nullable=True),
            sa.Column('decided_by_name', sa.String(200), nullable=True),
            _ts('decided_at'),
            sa.Column('decision_note', sa.Text, nullable=True),
            sa.Column('old_value', JSONB, nullable=True),
            sa.Column('new_value', JSONB, nullable=True),
            _ts('created_at', False, True),
            _ts('updated_at', False, True),
            sa.CheckConstraint(
                "status IN ('pending', 'approved', 'rejected')", name='ck_attendance_adjustments_status'
            ),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'attendance_adjustments', [
        ('ix_attendance_adjustments_shop_status', ['shop_id', 'status'], False),
        ('ix_attendance_adjustments_shift', ['shift_id'], False),
        ('ix_attendance_adjustments_user', ['pos_user_id', 'requested_at'], False),
        ('ix_attendance_adjustments_tenant_id', ['tenant_id'], False),
    ])


def downgrade() -> None:
    op.drop_table('attendance_adjustments')
    op.drop_table('attendance_breaks')
    op.drop_table('attendance_shifts')
    op.drop_column('pos_users', 'employee_role_id')
    op.drop_table('employee_roles')
