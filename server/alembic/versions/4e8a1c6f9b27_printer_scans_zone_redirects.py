"""printer_scans, kitchen_zone_redirects, kitchen_print_redirects: printer discovery, print by zone, failover

Revision ID: 4e8a1c6f9b27
Revises: a9c1e3f5b7d9
Create Date: 2026-10-05

* `printer_scans` — "חיפוש מדפסות ברשת": a scan of the shop's LAN run by one of its tills,
  asked for from the dashboard (pending → scanning → done | failed | expired) or run at
  the till itself; the results (IP, port, name, kind…) as JSON. The last few per shop.
* `kitchen_zone_redirects` — "הפניית מדפסות לפי אזור שולחנות": in a table zone, whatever
  routes to one printer prints on another instead (docs/SPEC_PRINT_BY_ZONE.md).
* `kitchen_print_redirects` — "מדפסת חלופית": a ticket / receipt the employee sent to
  another printer when its own was not available (till parameter `printerFailoverPrompt`).

Idempotent: the auto-reloading API runs `create_all` at startup, so a table may exist
before this runs — then only the indexes that are missing are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '4e8a1c6f9b27'
down_revision: Union[str, Sequence[str], None] = 'a9c1e3f5b7d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
SCANS = 'printer_scans'
REDIRECTS = 'kitchen_zone_redirects'
PRINT_REDIRECTS = 'kitchen_print_redirects'


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(SCANS):
        op.create_table(
            SCANS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            sa.Column('requested_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('source', sa.String(16), nullable=False, server_default='dashboard'),
            sa.Column('status', sa.String(16), nullable=False, server_default='pending'),
            sa.Column('subnet', sa.String(64), nullable=True),
            sa.Column('lan_address', sa.String(64), nullable=True),
            sa.Column('results', sa.JSON(), nullable=True),
            sa.Column('error', sa.String(500), nullable=True),
            sa.Column('duration_ms', sa.Integer(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "status IN ('pending', 'scanning', 'done', 'failed', 'expired')",
                name='ck_printer_scans_status',
            ),
            sa.CheckConstraint("source IN ('dashboard', 'till')", name='ck_printer_scans_source'),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(SCANS)}
    if 'ix_printer_scans_tenant_id' not in existing:
        op.create_index('ix_printer_scans_tenant_id', SCANS, ['tenant_id'])
    if 'ix_printer_scans_shop' not in existing:
        op.create_index('ix_printer_scans_shop', SCANS, ['shop_id', 'created_at'])
    if 'ix_printer_scans_machine_status' not in existing:
        op.create_index('ix_printer_scans_machine_status', SCANS, ['machine_id', 'status'])

    if not inspector.has_table(REDIRECTS):
        op.create_table(
            REDIRECTS,
            sa.Column('zone_id', UUID, sa.ForeignKey('table_zones.id', ondelete='CASCADE'), primary_key=True),
            sa.Column(
                'from_printer_id', UUID, sa.ForeignKey('kitchen_printers.id', ondelete='CASCADE'), primary_key=True,
            ),
            sa.Column(
                'to_printer_id', UUID, sa.ForeignKey('kitchen_printers.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(REDIRECTS)}
    if 'ix_kitchen_zone_redirects_tenant_id' not in existing:
        op.create_index('ix_kitchen_zone_redirects_tenant_id', REDIRECTS, ['tenant_id'])
    if 'ix_kitchen_zone_redirects_shop' not in existing:
        op.create_index('ix_kitchen_zone_redirects_shop', REDIRECTS, ['shop_id'])

    if not inspector.has_table(PRINT_REDIRECTS):
        op.create_table(
            PRINT_REDIRECTS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            sa.Column('kind', sa.String(8), nullable=False, server_default='kitchen'),
            sa.Column(
                'from_printer_id', UUID, sa.ForeignKey('kitchen_printers.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column('from_name', sa.String(100), nullable=True),
            sa.Column(
                'to_printer_id', UUID, sa.ForeignKey('kitchen_printers.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column('to_name', sa.String(100), nullable=True),
            sa.Column('ticket', sa.String(200), nullable=True),
            sa.Column('error', sa.String(500), nullable=True),
            sa.Column('temporary_until', sa.DateTime(timezone=True), nullable=True),
            sa.Column('pos_user_id', UUID, nullable=True),
            sa.Column('pos_user_name', sa.String(100), nullable=True),
            sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("kind IN ('kitchen', 'receipt')", name='ck_kitchen_print_redirects_kind'),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(PRINT_REDIRECTS)}
    if 'ix_kitchen_print_redirects_tenant_id' not in existing:
        op.create_index('ix_kitchen_print_redirects_tenant_id', PRINT_REDIRECTS, ['tenant_id'])
    if 'ix_kitchen_print_redirects_shop' not in existing:
        op.create_index('ix_kitchen_print_redirects_shop', PRINT_REDIRECTS, ['shop_id', 'created_at'])


def downgrade() -> None:
    op.drop_table(PRINT_REDIRECTS)
    op.drop_table(REDIRECTS)
    op.drop_table(SCANS)
