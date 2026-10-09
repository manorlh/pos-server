"""voucher distribution over WhatsApp ("הפצה בוואטסאפ"): recipients, assignments, links, audit, Cloud API config

Revision ID: c3f8a1d6e94b
Revises: 0a4df5f5984e
Create Date: 2026-10-09

Re-chained at the integration merge (integration/fri, 09.10.2026): written on 6b1e9d4f2a87, now
after the integration head 0a4df5f5984e (event-live's producer view) so the chain stays linear.
New tables only; the upgrade itself is unchanged.

New tables only (app/models/voucher_distribution.py) — nothing existing changes:

* `voucher_distributions` — per batch: the messages, the PDF layout, the links' expiry.
* `voucher_distribution_recipients` — a person (or a group send), the phone encrypted with a keyed
  hash, the personal link (its SHA-256 and its ciphertext only), where the sending stands.
* `voucher_distribution_assignments` — voucher → recipient; the voucher unique (one recipient).
* `voucher_distribution_events` — the audit trail.
* `whatsapp_cloud_configs` — per company, the optional WhatsApp Cloud API (secrets encrypted).

Idempotent: a table the auto-reloading dev API already created (`create_all`) is kept and only its
missing indexes are added; offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c3f8a1d6e94b'
down_revision: Union[str, Sequence[str], None] = '0a4df5f5984e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def _now():
    return sa.text('now()')


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _tables():
    return {
        'voucher_distributions': (
            [
                sa.Column('id', UUID, primary_key=True),
                sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
                sa.Column('batch_id', UUID, sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
                sa.Column('message_template', sa.Text(), nullable=True),
                sa.Column('group_message_template', sa.Text(), nullable=True),
                sa.Column('layout', sa.String(16), nullable=False, server_default='a6'),
                sa.Column('link_expires_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('created_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('updated_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.UniqueConstraint('batch_id', name='uq_voucher_distributions_batch'),
            ],
            [('ix_voucher_distributions_tenant_id', ['tenant_id'], False)],
        ),
        'voucher_distribution_recipients': (
            [
                sa.Column('id', UUID, primary_key=True),
                sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
                sa.Column('batch_id', UUID, sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
                sa.Column('kind', sa.String(8), nullable=False, server_default='person'),
                sa.Column('name', sa.String(200), nullable=True),
                sa.Column('phone_ciphertext', sa.Text(), nullable=True),
                sa.Column('phone_hash', sa.String(64), nullable=True),
                sa.Column('group_no', sa.Integer(), nullable=True),
                sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
                sa.Column('token_hash', sa.String(64), nullable=True),
                sa.Column('token_ciphertext', sa.Text(), nullable=True),
                sa.Column('token_issued_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('token_expires_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('token_revoked_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('token_version', sa.Integer(), nullable=False, server_default='0'),
                sa.Column('status', sa.String(16), nullable=False, server_default='pending'),
                sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('sent_via', sa.String(16), nullable=True),
                sa.Column('sent_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('sent_by_name', sa.String(200), nullable=True),
                sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('failed_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('failure_reason', sa.String(300), nullable=True),
                sa.Column('opened_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('last_opened_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('open_count', sa.Integer(), nullable=False, server_default='0'),
                sa.Column('downloaded_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('download_count', sa.Integer(), nullable=False, server_default='0'),
                sa.Column('api_status', sa.String(16), nullable=True),
                sa.Column('api_message_id', sa.String(128), nullable=True),
                sa.Column('api_attempts', sa.Integer(), nullable=False, server_default='0'),
                sa.Column('api_next_attempt_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('api_lease_until', sa.DateTime(timezone=True), nullable=True),
                sa.Column('api_last_error', sa.String(300), nullable=True),
                sa.Column('created_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
                sa.Column('anonymized_at', sa.DateTime(timezone=True), nullable=True),
                sa.CheckConstraint("kind IN ('person', 'group')", name='ck_voucher_distribution_recipients_kind'),
                sa.CheckConstraint(
                    "status IN ('pending', 'sent', 'delivered', 'read', 'failed')",
                    name='ck_voucher_distribution_recipients_status',
                ),
                sa.UniqueConstraint('token_hash', name='uq_voucher_distribution_recipients_token'),
            ],
            [
                ('ix_voucher_distribution_recipients_tenant_id', ['tenant_id'], False),
                ('ix_voucher_distribution_recipients_batch', ['batch_id', 'sort_order'], False),
                ('ix_voucher_distribution_recipients_phone', ['batch_id', 'phone_hash'], False),
                ('ix_voucher_distribution_recipients_api', ['api_status', 'api_next_attempt_at'], False),
                ('ix_voucher_distribution_recipients_wamid', ['api_message_id'], False),
            ],
        ),
        'voucher_distribution_assignments': (
            [
                sa.Column('id', UUID, primary_key=True),
                sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
                sa.Column('batch_id', UUID, sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
                sa.Column('recipient_id', UUID, sa.ForeignKey('voucher_distribution_recipients.id', ondelete='CASCADE'),
                          nullable=False),
                sa.Column('voucher_id', UUID, sa.ForeignKey('prepaid_vouchers.id', ondelete='CASCADE'), nullable=False),
                sa.Column('serial', sa.Integer(), nullable=False),
                sa.Column('assigned_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('assigned_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.UniqueConstraint('voucher_id', name='uq_voucher_distribution_assignments_voucher'),
            ],
            [
                ('ix_voucher_distribution_assignments_tenant_id', ['tenant_id'], False),
                ('ix_voucher_distribution_assignments_recipient', ['recipient_id', 'serial'], False),
                ('ix_voucher_distribution_assignments_batch', ['batch_id'], False),
            ],
        ),
        'voucher_distribution_events': (
            [
                sa.Column('id', UUID, primary_key=True),
                sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
                sa.Column('batch_id', UUID, sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
                sa.Column('recipient_id', UUID, nullable=True),
                sa.Column('action', sa.String(32), nullable=False),
                sa.Column('user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('user_name', sa.String(200), nullable=True),
                sa.Column('details', sa.JSON(), nullable=True),
                sa.Column('ip', sa.String(64), nullable=True),
                sa.Column('user_agent', sa.String(200), nullable=True),
                sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            ],
            [
                ('ix_voucher_distribution_events_tenant_id', ['tenant_id'], False),
                ('ix_voucher_distribution_events_batch', ['batch_id', 'created_at'], False),
                ('ix_voucher_distribution_events_recipient', ['recipient_id', 'created_at'], False),
            ],
        ),
        'whatsapp_cloud_configs': (
            [
                sa.Column('id', UUID, primary_key=True),
                sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
                sa.Column('company_id', UUID, sa.ForeignKey('companies.id', ondelete='CASCADE'), nullable=False),
                sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
                sa.Column('phone_number_id', sa.String(64), nullable=True),
                sa.Column('business_account_id', sa.String(64), nullable=True),
                sa.Column('template_name', sa.String(128), nullable=True),
                sa.Column('template_language', sa.String(16), nullable=False, server_default='he'),
                sa.Column('body_params', sa.JSON(), nullable=True),
                sa.Column('api_version', sa.String(16), nullable=True),
                sa.Column('access_token_ciphertext', sa.Text(), nullable=True),
                sa.Column('app_secret_ciphertext', sa.Text(), nullable=True),
                sa.Column('verify_token_ciphertext', sa.Text(), nullable=True),
                sa.Column('updated_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
                sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=_now()),
                sa.UniqueConstraint('company_id', name='uq_whatsapp_cloud_configs_company'),
            ],
            [('ix_whatsapp_cloud_configs_tenant_id', ['tenant_id'], False)],
        ),
    }


def upgrade() -> None:
    inspector = None if _offline() else sa.inspect(op.get_bind())
    for table, (columns, indexes) in _tables().items():
        exists = inspector is not None and inspector.has_table(table)
        if not exists:
            op.create_table(table, *columns)
        have = {i['name'] for i in inspector.get_indexes(table)} if exists else set()
        for name, cols, unique in indexes:
            if name not in have:
                op.create_index(name, table, cols, unique=unique)


def downgrade() -> None:
    inspector = None if _offline() else sa.inspect(op.get_bind())
    for table in reversed(list(_tables())):
        if inspector is None or inspector.has_table(table):
            op.drop_table(table)
