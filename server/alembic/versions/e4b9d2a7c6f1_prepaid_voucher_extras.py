"""production vouchers: settlement agreements, external invoices, deliveries, replacements, pauses, quotas, test batches

Revision ID: e4b9d2a7c6f1
Revises: c5d2a8e4f913
Create Date: 2026-10-09

The helper's part of production vouchers (spec §14, §16, §18; the contract's helper section) — new
tables only, nothing existing changes:

* `prepaid_settlement_agreements` — an agreement with a production (billing basis, period, ₪ only,
  how cancelled and replacement vouchers are charged) and the batches it covers;
* `prepaid_settlement_invoices`, `…_invoice_lines`, `…_invoice_files` — external invoice references,
  the vouchers per batch each covers, an optional file;
* `prepaid_voucher_deliveries` — serial ranges handed over to the production;
* `prepaid_voucher_replacements` — a replacement voucher and its original;
* `prepaid_redemption_pauses`, `prepaid_redemption_quotas` — paused redemptions and quotas;
* `prepaid_voucher_test_batches` — batches of staff test vouchers;
* `prepaid_voucher_extra_events` — their audit trail;
* on the core's `prepaid_voucher_reservations`: the index `ix_prepaid_voucher_reservations_batch_held`
  (batch, status, expiry) — what a redemption quota counts at every check.

Idempotent: a table the API already made (`create_all` at start-up) is left as it is and only its
missing indexes are added. Offline (`--sql`): the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e4b9d2a7c6f1'
down_revision: Union[str, Sequence[str], None] = 'c5d2a8e4f913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _now():
    return sa.text('now()')


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _tables():
    """(name, columns + constraints, indexes [(name, columns, unique)]) in dependency order."""
    return [
        ('prepaid_settlement_agreements', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', _uuid(), sa.ForeignKey('companies.id'), nullable=False),
            sa.Column('name', sa.String(200), nullable=False),
            sa.Column('production_name', sa.String(200), nullable=True),
            sa.Column('production_id', _uuid(), sa.ForeignKey('prepaid_productions.id', ondelete='SET NULL'), nullable=True),
            sa.Column('event_name', sa.String(200), nullable=True),
            sa.Column('report_event_id', _uuid(), sa.ForeignKey('report_events.id', ondelete='SET NULL'), nullable=True),
            sa.Column('batch_ids', sa.JSON(), nullable=True),
            sa.Column('billing_basis', sa.String(16), nullable=False, server_default='redemption'),
            sa.Column('period_from', sa.Date(), nullable=True),
            sa.Column('period_to', sa.Date(), nullable=True),
            sa.Column('currency', sa.String(3), nullable=False, server_default='ILS'),
            sa.Column('cancelled_policy', sa.String(16), nullable=False, server_default='exclude'),
            sa.Column('replacement_policy', sa.String(16), nullable=False, server_default='free'),
            sa.Column('status', sa.String(16), nullable=False, server_default='active'),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('gap_note', sa.Text(), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.CheckConstraint("billing_basis IN ('redemption', 'delivery')", name='ck_prepaid_settlement_agreements_basis'),
            sa.CheckConstraint("currency = 'ILS'", name='ck_prepaid_settlement_agreements_currency'),
            sa.CheckConstraint("cancelled_policy IN ('exclude', 'charge')", name='ck_prepaid_settlement_agreements_cancelled'),
            sa.CheckConstraint("replacement_policy IN ('free', 'charge')", name='ck_prepaid_settlement_agreements_replacement'),
            sa.CheckConstraint("status IN ('active', 'closed')", name='ck_prepaid_settlement_agreements_status'),
        ], [('ix_prepaid_settlement_agreements_tenant', ['tenant_id', 'company_id'], False)]),
        ('prepaid_settlement_invoices', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('agreement_id', _uuid(), sa.ForeignKey('prepaid_settlement_agreements.id', ondelete='CASCADE'), nullable=False),
            sa.Column('number', sa.String(64), nullable=False),
            sa.Column('invoice_date', sa.Date(), nullable=False),
            sa.Column('system', sa.String(100), nullable=True),
            sa.Column('amount', sa.BigInteger(), nullable=False),
            sa.Column('currency', sa.String(3), nullable=False, server_default='ILS'),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('gap_note', sa.Text(), nullable=True),
            sa.Column('file_name', sa.String(255), nullable=True),
            sa.Column('file_type', sa.String(100), nullable=True),
            sa.Column('file_size', sa.Integer(), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('voided_by_name', sa.String(200), nullable=True),
            sa.Column('void_reason', sa.Text(), nullable=True),
            sa.CheckConstraint("currency = 'ILS'", name='ck_prepaid_settlement_invoices_currency'),
        ], [('ix_prepaid_settlement_invoices_agreement', ['agreement_id'], False)]),
        ('prepaid_settlement_invoice_lines', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('invoice_id', _uuid(), sa.ForeignKey('prepaid_settlement_invoices.id', ondelete='CASCADE'), nullable=False),
            sa.Column('batch_id', _uuid(), sa.ForeignKey('prepaid_voucher_batches.id'), nullable=False),
            sa.Column('quantity', sa.Integer(), nullable=False),
            sa.Column('unit_price', sa.BigInteger(), nullable=True),
            sa.Column('amount', sa.BigInteger(), nullable=True),
            sa.Column('voucher_ids', sa.JSON(), nullable=True),
            sa.Column('serials', sa.JSON(), nullable=True),
            sa.CheckConstraint('quantity > 0', name='ck_prepaid_settlement_invoice_lines_quantity'),
        ], [('ix_prepaid_settlement_invoice_lines_invoice', ['invoice_id'], False),
            ('ix_prepaid_settlement_invoice_lines_batch', ['batch_id'], False)]),
        ('prepaid_settlement_invoice_files', [
            sa.Column('invoice_id', _uuid(), sa.ForeignKey('prepaid_settlement_invoices.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('data', sa.LargeBinary(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        ], []),
        ('prepaid_voucher_deliveries', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('batch_id', _uuid(), sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
            sa.Column('serial_from', sa.Integer(), nullable=False),
            sa.Column('serial_to', sa.Integer(), nullable=False),
            sa.Column('count', sa.Integer(), nullable=False),
            sa.Column('chargeable', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('recipient', sa.String(200), nullable=True),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('user_id', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('user_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('voided_by_name', sa.String(200), nullable=True),
            sa.Column('void_reason', sa.Text(), nullable=True),
            sa.CheckConstraint('serial_from >= 1 AND serial_to >= serial_from', name='ck_prepaid_voucher_deliveries_range'),
        ], [('ix_prepaid_voucher_deliveries_batch', ['batch_id', 'delivered_at'], False)]),
        ('prepaid_voucher_replacements', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('batch_id', _uuid(), sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
            sa.Column('original_voucher_id', _uuid(), sa.ForeignKey('prepaid_vouchers.id', ondelete='CASCADE'), nullable=False),
            sa.Column('replacement_voucher_id', _uuid(), sa.ForeignKey('prepaid_vouchers.id', ondelete='CASCADE'), nullable=False),
            sa.Column('reason_kind', sa.String(16), nullable=False),
            sa.Column('reason', sa.Text(), nullable=False),
            sa.Column('original_status', sa.String(16), nullable=True),
            sa.Column('details', sa.JSON(), nullable=True),
            sa.Column('user_id', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('user_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.UniqueConstraint('original_voucher_id', name='uq_prepaid_voucher_replacements_original'),
            sa.UniqueConstraint('replacement_voucher_id', name='uq_prepaid_voucher_replacements_replacement'),
            sa.CheckConstraint("reason_kind IN ('lost', 'damaged', 'cancelled', 'other')", name='ck_prepaid_voucher_replacements_reason'),
        ], [('ix_prepaid_voucher_replacements_batch', ['batch_id'], False)]),
        ('prepaid_redemption_pauses', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', _uuid(), sa.ForeignKey('companies.id'), nullable=True),
            sa.Column('scope_kind', sa.String(16), nullable=False),
            sa.Column('scope_value', sa.String(200), nullable=False),
            sa.Column('scope_label', sa.String(200), nullable=True),
            sa.Column('reason', sa.Text(), nullable=False),
            sa.Column('until', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column('resumed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('resumed_by_name', sa.String(200), nullable=True),
            sa.Column('resume_note', sa.Text(), nullable=True),
            sa.CheckConstraint("scope_kind IN ('production', 'event', 'type', 'batch')", name='ck_prepaid_redemption_pauses_scope'),
        ], [('ix_prepaid_redemption_pauses_tenant', ['tenant_id', 'resumed_at'], False)]),
        ('prepaid_redemption_quotas', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', _uuid(), sa.ForeignKey('companies.id'), nullable=True),
            sa.Column('scope_kind', sa.String(16), nullable=False),
            sa.Column('scope_value', sa.String(200), nullable=False),
            sa.Column('scope_label', sa.String(200), nullable=True),
            sa.Column('max_redemptions', sa.Integer(), nullable=False),
            sa.Column('period', sa.String(16), nullable=False, server_default='overall'),
            sa.Column('period_from', sa.DateTime(timezone=True), nullable=True),
            sa.Column('period_to', sa.DateTime(timezone=True), nullable=True),
            sa.Column('warn_percent', sa.Integer(), nullable=False, server_default='80'),
            sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.CheckConstraint("scope_kind IN ('production', 'event', 'type', 'batch')", name='ck_prepaid_redemption_quotas_scope'),
            sa.CheckConstraint("period IN ('overall', 'day', 'range')", name='ck_prepaid_redemption_quotas_period'),
            sa.CheckConstraint('max_redemptions >= 0', name='ck_prepaid_redemption_quotas_max'),
        ], [('ix_prepaid_redemption_quotas_tenant', ['tenant_id', 'active'], False)]),
        ('prepaid_voucher_test_batches', [
            sa.Column('batch_id', _uuid(), sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_by_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        ], [('ix_prepaid_voucher_test_batches_tenant_id', ['tenant_id'], False)]),
        ('prepaid_voucher_extra_events', [
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('action', sa.String(32), nullable=False),
            sa.Column('ref_id', _uuid(), nullable=True),
            sa.Column('batch_id', _uuid(), nullable=True),
            sa.Column('reason', sa.Text(), nullable=True),
            sa.Column('details', sa.JSON(), nullable=True),
            sa.Column('user_id', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('user_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        ], [('ix_prepaid_voucher_extra_events_tenant', ['tenant_id', 'created_at'], False)]),
    ]


#: Every table this revision makes, in the order they are made.
TABLES = tuple(name for name, _cols, _ix in _tables())

#: On the core's table: a quota counts the holds of its batches still running at every redemption check.
RESERVATIONS = 'prepaid_voucher_reservations'
HELD_INDEX = ('ix_prepaid_voucher_reservations_batch_held', ['batch_id', 'status', 'expires_at'])


def upgrade() -> None:
    offline = _offline()
    insp = None if offline else sa.inspect(op.get_bind())
    for name, columns, indexes in _tables():
        exists = (not offline) and insp.has_table(name)
        if not exists:
            op.create_table(name, *columns)
        have = set() if (offline or not exists) else {i['name'] for i in insp.get_indexes(name)}
        for ix_name, ix_cols, unique in indexes:
            if ix_name not in have:
                op.create_index(ix_name, name, ix_cols, unique=unique)
    if offline or insp.has_table(RESERVATIONS):
        have = set() if offline else {i['name'] for i in insp.get_indexes(RESERVATIONS)}
        if HELD_INDEX[0] not in have:
            op.create_index(HELD_INDEX[0], RESERVATIONS, HELD_INDEX[1])


def downgrade() -> None:
    offline = _offline()
    insp = None if offline else sa.inspect(op.get_bind())
    if offline or (insp.has_table(RESERVATIONS)
                   and HELD_INDEX[0] in {i['name'] for i in insp.get_indexes(RESERVATIONS)}):
        op.drop_index(HELD_INDEX[0], table_name=RESERVATIONS)
    for name in reversed(TABLES):
        if offline or insp.has_table(name):
            op.drop_table(name)
