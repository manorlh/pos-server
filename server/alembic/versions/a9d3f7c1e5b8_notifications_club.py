"""notifications (019 SMS) and the customer club — docs/SPEC_NOTIFICATIONS_CLUB.md

Revision ID: a9d3f7c1e5b8
Revises: f3b7d1a9c5e2
Create Date: 2026-10-06

New tables only (app/models/outbox.py, app/models/notifications.py, app/models/club.py):
the shared transactional outbox (`outbox_events`, written by KDS in the same transaction
as ReadyForPickup), the notification queue with its attempts, delivery reports,
templates and provider accounts, the P1 campaign skeleton, and the club (programs,
documents, landing pages, QR source tokens, customers, memberships, consent events,
suppressions, OTP challenges, benefit grants, sale links, audit) plus the P1 points
ledger and redemption reservations (no writer in P0).

Additive only: no existing table or row is touched. Idempotent: the auto-reloading API
and the test suite run `create_all`, so a table may already exist — then only its missing
indexes are added. The 019 token is not a column here: it lives encrypted in
`payment_integration_secrets` (key `sms019Token`).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a9d3f7c1e5b8'
down_revision: Union[str, Sequence[str], None] = 'f3b7d1a9c5e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ['outbox_events', 'notification_provider_configs', 'notification_templates', 'notifications', 'notification_attempts', 'notification_delivery_events', 'notification_campaigns', 'notification_campaign_recipients', 'club_programs', 'club_document_versions', 'club_landing_pages', 'club_source_tokens', 'club_customers', 'club_memberships', 'club_consent_events', 'club_suppressions', 'club_otp_challenges', 'club_benefit_grants', 'club_sale_links', 'club_audit_events', 'club_points_ledger', 'club_redemption_reservations']


def _index(inspector, name, table, columns, unique=False):
    existing = {ix["name"] for ix in inspector.get_indexes(table)}
    if name not in existing:
        op.create_index(name, table, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('outbox_events'):
        op.create_table('outbox_events',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('shop_id', sa.UUID(), nullable=True),
        sa.Column('aggregate_type', sa.String(length=40), nullable=False),
        sa.Column('aggregate_id', sa.String(length=100), nullable=False),
        sa.Column('aggregate_version', sa.Integer(), server_default='1', nullable=False),
        sa.Column('event_type', sa.String(length=60), nullable=False),
        sa.Column('dedupe_key', sa.String(length=300), nullable=False),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('payload_redacted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('state', sa.String(length=16), server_default='pending', nullable=False),
        sa.Column('available_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('lease_owner', sa.String(length=80), nullable=True),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('result', sa.String(length=200), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'dedupe_key', name='uq_outbox_events_tenant_dedupe')
        )
    _index(sa.inspect(bind), 'ix_outbox_events_aggregate', 'outbox_events', ['tenant_id', 'aggregate_type', 'aggregate_id', 'occurred_at'], unique=False)
    _index(sa.inspect(bind), 'ix_outbox_events_pending', 'outbox_events', ['state', 'available_at'], unique=False)
    _index(sa.inspect(bind), 'ix_outbox_events_tenant_id', 'outbox_events', ['tenant_id'], unique=False)

    if not inspector.has_table('notification_provider_configs'):
        op.create_table('notification_provider_configs',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('scope_key', sa.String(length=40), nullable=False),
        sa.Column('provider', sa.String(length=16), server_default='019', nullable=False),
        sa.Column('mode', sa.String(length=8), server_default='mock', nullable=False),
        sa.Column('account_username', sa.String(length=100), nullable=True),
        sa.Column('sender', sa.String(length=11), nullable=True),
        sa.Column('brand_name', sa.String(length=60), nullable=True),
        sa.Column('paused', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('paused_reason', sa.String(length=200), nullable=True),
        sa.Column('paused_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rate_per_minute', sa.Integer(), server_default='30', nullable=False),
        sa.Column('daily_quota', sa.Integer(), server_default='500', nullable=False),
        sa.Column('alert_threshold', sa.Integer(), server_default='400', nullable=False),
        sa.Column('test_numbers', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('live_restricted_to_test_numbers', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('enabled_events', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('order_ready_ttl_minutes', sa.Integer(), server_default='10', nullable=False),
        sa.Column('dlr_polling_enabled', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('last_alert', sa.String(length=200), nullable=True),
        sa.Column('last_alert_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'scope_key', name='uq_notification_provider_configs_scope')
        )
    _index(sa.inspect(bind), 'ix_notification_provider_configs_company_id', 'notification_provider_configs', ['company_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notification_provider_configs_tenant_id', 'notification_provider_configs', ['tenant_id'], unique=False)

    if not inspector.has_table('notification_templates'):
        op.create_table('notification_templates',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('scope_key', sa.String(length=40), nullable=False),
        sa.Column('category', sa.String(length=24), nullable=False),
        sa.Column('channel', sa.String(length=8), server_default='sms', nullable=False),
        sa.Column('language', sa.String(length=8), server_default='he', nullable=False),
        sa.Column('event_type', sa.String(length=40), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=12), server_default='draft', nullable=False),
        sa.Column('name', sa.String(length=120), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('fallback_body', sa.Text(), nullable=True),
        sa.Column('allowed_variables', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('approved_by', sa.UUID(), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('activated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'scope_key', 'event_type', 'channel', 'language', 'version', name='uq_notification_templates_version')
        )
    _index(sa.inspect(bind), 'ix_notification_templates_lookup', 'notification_templates', ['tenant_id', 'event_type', 'status'], unique=False)
    _index(sa.inspect(bind), 'ix_notification_templates_tenant_id', 'notification_templates', ['tenant_id'], unique=False)

    if not inspector.has_table('notifications'):
        op.create_table('notifications',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('shop_id', sa.UUID(), nullable=True),
        sa.Column('config_id', sa.UUID(), nullable=True),
        sa.Column('category', sa.String(length=24), nullable=False),
        sa.Column('channel', sa.String(length=8), server_default='sms', nullable=False),
        sa.Column('event_type', sa.String(length=40), nullable=False),
        sa.Column('source_event_id', sa.UUID(), nullable=True),
        sa.Column('aggregate_ref', sa.String(length=100), nullable=True),
        sa.Column('context_label', sa.String(length=120), nullable=True),
        sa.Column('recipient_ciphertext', sa.Text(), nullable=False),
        sa.Column('recipient_hash', sa.String(length=64), nullable=False),
        sa.Column('recipient_masked', sa.String(length=32), nullable=False),
        sa.Column('template_id', sa.UUID(), nullable=True),
        sa.Column('template_key', sa.String(length=80), nullable=True),
        sa.Column('template_version', sa.Integer(), nullable=True),
        sa.Column('body_snapshot', sa.Text(), nullable=False),
        sa.Column('secret_vars_ciphertext', sa.Text(), nullable=True),
        sa.Column('dedupe_key', sa.String(length=300), nullable=False),
        sa.Column('priority', sa.Integer(), nullable=False),
        sa.Column('state', sa.String(length=20), server_default='queued', nullable=False),
        sa.Column('state_reason', sa.String(length=120), nullable=True),
        sa.Column('is_test', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('not_before', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('lease_owner', sa.String(length=80), nullable=True),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('attempt_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('max_attempts', sa.Integer(), server_default='5', nullable=False),
        sa.Column('provider', sa.String(length=16), nullable=True),
        sa.Column('provider_mode', sa.String(length=8), nullable=True),
        sa.Column('provider_ref', sa.String(length=64), nullable=True),
        sa.Column('provider_external_id', sa.String(length=64), nullable=True),
        sa.Column('provider_status', sa.String(length=16), nullable=True),
        sa.Column('resend_of_id', sa.UUID(), nullable=True),
        sa.Column('resend_reason', sa.String(length=200), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('final_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_dlr_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('next_dlr_poll_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['config_id'], ['notification_provider_configs.id'], ),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'dedupe_key', name='uq_notifications_tenant_dedupe')
        )
    _index(sa.inspect(bind), 'ix_notifications_aggregate', 'notifications', ['tenant_id', 'aggregate_ref'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_company_id', 'notifications', ['company_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_provider_external_id', 'notifications', ['provider_external_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_queue', 'notifications', ['state', 'priority', 'not_before'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_recipient', 'notifications', ['tenant_id', 'recipient_hash'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_shop_id', 'notifications', ['shop_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_source_event_id', 'notifications', ['source_event_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_tenant_created', 'notifications', ['tenant_id', 'created_at'], unique=False)
    _index(sa.inspect(bind), 'ix_notifications_tenant_id', 'notifications', ['tenant_id'], unique=False)

    if not inspector.has_table('notification_attempts'):
        op.create_table('notification_attempts',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('notification_id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('sequence', sa.Integer(), nullable=False),
        sa.Column('correlation_id', sa.String(length=64), nullable=False),
        sa.Column('mode', sa.String(length=8), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('outcome', sa.String(length=16), nullable=True),
        sa.Column('error_class', sa.String(length=40), nullable=True),
        sa.Column('provider_status', sa.String(length=16), nullable=True),
        sa.Column('provider_message', sa.String(length=200), nullable=True),
        sa.Column('http_status', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['notification_id'], ['notifications.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('notification_id', 'sequence', name='uq_notification_attempts_seq')
        )
    _index(sa.inspect(bind), 'ix_notification_attempts_notification_id', 'notification_attempts', ['notification_id'], unique=False)

    if not inspector.has_table('notification_delivery_events'):
        op.create_table('notification_delivery_events',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=True),
        sa.Column('notification_id', sa.UUID(), nullable=True),
        sa.Column('provider', sa.String(length=16), nullable=False),
        sa.Column('external_id', sa.String(length=64), nullable=True),
        sa.Column('shipment_id', sa.String(length=64), nullable=True),
        sa.Column('raw_status', sa.String(length=16), nullable=True),
        sa.Column('mapped_state', sa.String(length=20), nullable=True),
        sa.Column('applied', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('event_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('dedupe_key', sa.String(length=128), nullable=False),
        sa.ForeignKeyConstraint(['notification_id'], ['notifications.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('provider', 'dedupe_key', name='uq_notification_delivery_events_dedupe')
        )
    _index(sa.inspect(bind), 'ix_notification_delivery_events_external_id', 'notification_delivery_events', ['external_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notification_delivery_events_notification_id', 'notification_delivery_events', ['notification_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notification_delivery_events_tenant_id', 'notification_delivery_events', ['tenant_id'], unique=False)

    if not inspector.has_table('notification_campaigns'):
        op.create_table('notification_campaigns',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('status', sa.String(length=16), server_default='draft', nullable=False),
        sa.Column('template_id', sa.UUID(), nullable=True),
        sa.Column('audience', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('shop_ids', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('scheduled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('frequency_cap_days', sa.Integer(), nullable=True),
        sa.Column('budget_messages', sa.Integer(), nullable=True),
        sa.Column('version', sa.Integer(), server_default='1', nullable=False),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('approved_by', sa.UUID(), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id')
        )
    _index(sa.inspect(bind), 'ix_notification_campaigns_company_id', 'notification_campaigns', ['company_id'], unique=False)
    _index(sa.inspect(bind), 'ix_notification_campaigns_tenant_id', 'notification_campaigns', ['tenant_id'], unique=False)

    if not inspector.has_table('notification_campaign_recipients'):
        op.create_table('notification_campaign_recipients',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('campaign_id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=False),
        sa.Column('notification_id', sa.UUID(), nullable=True),
        sa.Column('status', sa.String(length=24), server_default='pending', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['campaign_id'], ['notification_campaigns.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('campaign_id', 'membership_id', name='uq_campaign_recipients_member')
        )
    _index(sa.inspect(bind), 'ix_notification_campaign_recipients_campaign_id', 'notification_campaign_recipients', ['campaign_id'], unique=False)

    if not inspector.has_table('club_programs'):
        op.create_table('club_programs',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('next_member_number', sa.Integer(), server_default='1001', nullable=False),
        sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('company_id', name='uq_club_programs_company')
        )
    _index(sa.inspect(bind), 'ix_club_programs_tenant_id', 'club_programs', ['tenant_id'], unique=False)

    if not inspector.has_table('club_document_versions'):
        op.create_table('club_document_versions',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=10), server_default='draft', nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('url', sa.String(length=500), nullable=True),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['club_id'], ['club_programs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('club_id', 'kind', 'version', name='uq_club_document_versions')
        )
    _index(sa.inspect(bind), 'ix_club_document_versions_tenant_id', 'club_document_versions', ['tenant_id'], unique=False)

    if not inspector.has_table('club_landing_pages'):
        op.create_table('club_landing_pages',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('is_published', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('business_name', sa.String(length=120), nullable=True),
        sa.Column('logo_url', sa.String(length=500), nullable=True),
        sa.Column('headline', sa.String(length=120), nullable=True),
        sa.Column('intro', sa.String(length=500), nullable=True),
        sa.Column('benefits', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('email_enabled', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('birthday_enabled', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('last_name_enabled', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('signup_benefit_enabled', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('signup_benefit_title', sa.String(length=120), nullable=True),
        sa.Column('signup_benefit_valid_days', sa.Integer(), nullable=True),
        sa.Column('success_message', sa.String(length=300), nullable=True),
        sa.Column('updated_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['club_id'], ['club_programs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('club_id', name='uq_club_landing_pages_club')
        )
    _index(sa.inspect(bind), 'ix_club_landing_pages_tenant_id', 'club_landing_pages', ['tenant_id'], unique=False)

    if not inspector.has_table('club_source_tokens'):
        op.create_table('club_source_tokens',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('token', sa.String(length=64), nullable=False),
        sa.Column('shop_id', sa.UUID(), nullable=True),
        sa.Column('machine_id', sa.UUID(), nullable=True),
        sa.Column('source_kind', sa.String(length=16), server_default='link', nullable=False),
        sa.Column('label', sa.String(length=120), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['club_id'], ['club_programs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token', name='uq_club_source_tokens_token')
        )
    _index(sa.inspect(bind), 'ix_club_source_tokens_tenant_id', 'club_source_tokens', ['tenant_id'], unique=False)

    if not inspector.has_table('club_customers'):
        op.create_table('club_customers',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('first_name', sa.String(length=60), nullable=False),
        sa.Column('last_name', sa.String(length=60), nullable=True),
        sa.Column('phone_ciphertext', sa.Text(), nullable=False),
        sa.Column('phone_hash', sa.String(length=64), nullable=False),
        sa.Column('phone_masked', sa.String(length=32), nullable=False),
        sa.Column('phone_verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('email', sa.String(length=200), nullable=True),
        sa.Column('birth_day', sa.SmallInteger(), nullable=True),
        sa.Column('birth_month', sa.SmallInteger(), nullable=True),
        sa.Column('language', sa.String(length=8), server_default='he', nullable=False),
        sa.Column('source_shop_id', sa.UUID(), nullable=True),
        sa.Column('signup_source', sa.String(length=16), nullable=True),
        sa.Column('tax_customer_id', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['tax_customer_id'], ['customers.id'], ),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'company_id', 'phone_hash', name='uq_club_customers_phone')
        )
    _index(sa.inspect(bind), 'ix_club_customers_company_id', 'club_customers', ['company_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_customers_tenant_id', 'club_customers', ['tenant_id'], unique=False)

    if not inspector.has_table('club_memberships'):
        op.create_table('club_memberships',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('customer_id', sa.UUID(), nullable=False),
        sa.Column('member_number', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=32), server_default='pending_phone_verification', nullable=False),
        sa.Column('status_reason', sa.String(length=200), nullable=True),
        sa.Column('qr_token', sa.String(length=64), nullable=False),
        sa.Column('unsubscribe_token', sa.String(length=64), nullable=False),
        sa.Column('source_token_id', sa.UUID(), nullable=True),
        sa.Column('source_shop_id', sa.UUID(), nullable=True),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status_changed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['club_id'], ['club_programs.id'], ),
        sa.ForeignKeyConstraint(['customer_id'], ['club_customers.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('club_id', 'customer_id', name='uq_club_memberships_customer'),
        sa.UniqueConstraint('club_id', 'member_number', name='uq_club_memberships_number'),
        sa.UniqueConstraint('qr_token', name='uq_club_memberships_qr_token'),
        sa.UniqueConstraint('unsubscribe_token')
        )
    _index(sa.inspect(bind), 'ix_club_memberships_company_id', 'club_memberships', ['company_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_memberships_customer_id', 'club_memberships', ['customer_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_memberships_tenant_id', 'club_memberships', ['tenant_id'], unique=False)

    if not inspector.has_table('club_consent_events'):
        op.create_table('club_consent_events',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('customer_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=True),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('granted', sa.Boolean(), nullable=False),
        sa.Column('document_version_id', sa.UUID(), nullable=True),
        sa.Column('document_version', sa.Integer(), nullable=True),
        sa.Column('text_snapshot', sa.Text(), nullable=True),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('source_token_id', sa.UUID(), nullable=True),
        sa.Column('actor_user_id', sa.UUID(), nullable=True),
        sa.Column('ip_hash', sa.String(length=64), nullable=True),
        sa.Column('idempotency_key', sa.String(length=120), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['customer_id'], ['club_customers.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('idempotency_key', name='uq_club_consent_events_idem')
        )
    _index(sa.inspect(bind), 'ix_club_consent_events_customer', 'club_consent_events', ['customer_id', 'kind', 'occurred_at'], unique=False)
    _index(sa.inspect(bind), 'ix_club_consent_events_tenant_id', 'club_consent_events', ['tenant_id'], unique=False)

    if not inspector.has_table('club_suppressions'):
        op.create_table('club_suppressions',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('phone_hash', sa.String(length=64), nullable=False),
        sa.Column('channel', sa.String(length=8), server_default='sms', nullable=False),
        sa.Column('scope', sa.String(length=12), server_default='marketing', nullable=False),
        sa.Column('reason', sa.String(length=24), nullable=False),
        sa.Column('source', sa.String(length=24), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('lifted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('lifted_by', sa.UUID(), nullable=True),
        sa.PrimaryKeyConstraint('id')
        )
    _index(sa.inspect(bind), 'ix_club_suppressions_lookup', 'club_suppressions', ['tenant_id', 'phone_hash', 'channel'], unique=False)
    _index(sa.inspect(bind), 'ix_club_suppressions_tenant_id', 'club_suppressions', ['tenant_id'], unique=False)

    if not inspector.has_table('club_otp_challenges'):
        op.create_table('club_otp_challenges',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('source_token_id', sa.UUID(), nullable=True),
        sa.Column('purpose', sa.String(length=24), server_default='club_signup', nullable=False),
        sa.Column('phone_hash', sa.String(length=64), nullable=False),
        sa.Column('phone_ciphertext', sa.Text(), nullable=True),
        sa.Column('session_hash', sa.String(length=64), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=12), server_default='pending', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('max_attempts', sa.Integer(), server_default='5', nullable=False),
        sa.Column('send_count', sa.Integer(), server_default='1', nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_sent_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('registration_token_hash', sa.String(length=64), nullable=True),
        sa.Column('registration_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('registered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ip_hash', sa.String(length=64), nullable=True),
        sa.Column('notification_id', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
    _index(sa.inspect(bind), 'ix_club_otp_challenges_ip', 'club_otp_challenges', ['ip_hash', 'created_at'], unique=False)
    _index(sa.inspect(bind), 'ix_club_otp_challenges_phone', 'club_otp_challenges', ['tenant_id', 'phone_hash', 'created_at'], unique=False)
    _index(sa.inspect(bind), 'ix_club_otp_challenges_session', 'club_otp_challenges', ['session_hash'], unique=False)

    if not inspector.has_table('club_benefit_grants'):
        op.create_table('club_benefit_grants',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=False),
        sa.Column('club_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=False),
        sa.Column('customer_id', sa.UUID(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('title', sa.String(length=120), nullable=False),
        sa.Column('status', sa.String(length=12), server_default='available', nullable=False),
        sa.Column('valid_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('unique_key', sa.String(length=160), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['membership_id'], ['club_memberships.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('unique_key', name='uq_club_benefit_grants_key')
        )
    _index(sa.inspect(bind), 'ix_club_benefit_grants_membership_id', 'club_benefit_grants', ['membership_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_benefit_grants_tenant_id', 'club_benefit_grants', ['tenant_id'], unique=False)

    if not inspector.has_table('club_sale_links'):
        op.create_table('club_sale_links',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('transaction_id', sa.UUID(), nullable=False),
        sa.Column('customer_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=False),
        sa.Column('machine_id', sa.UUID(), nullable=True),
        sa.Column('shop_id', sa.UUID(), nullable=True),
        sa.Column('rules_snapshot', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('linked_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['customer_id'], ['club_customers.id'], ),
        sa.ForeignKeyConstraint(['membership_id'], ['club_memberships.id'], ),
        sa.ForeignKeyConstraint(['transaction_id'], ['transactions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('transaction_id', name='uq_club_sale_links_tx')
        )
    _index(sa.inspect(bind), 'ix_club_sale_links_customer_id', 'club_sale_links', ['customer_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_sale_links_membership_id', 'club_sale_links', ['membership_id'], unique=False)
    _index(sa.inspect(bind), 'ix_club_sale_links_tenant_id', 'club_sale_links', ['tenant_id'], unique=False)

    if not inspector.has_table('club_audit_events'):
        op.create_table('club_audit_events',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('company_id', sa.UUID(), nullable=True),
        sa.Column('domain', sa.String(length=16), nullable=False),
        sa.Column('subject_type', sa.String(length=24), nullable=False),
        sa.Column('subject_id', sa.UUID(), nullable=True),
        sa.Column('action', sa.String(length=32), nullable=False),
        sa.Column('actor_user_id', sa.UUID(), nullable=True),
        sa.Column('actor_machine_id', sa.UUID(), nullable=True),
        sa.Column('reason', sa.String(length=200), nullable=True),
        sa.Column('details', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
    _index(sa.inspect(bind), 'ix_club_audit_events_subject', 'club_audit_events', ['tenant_id', 'subject_type', 'subject_id'], unique=False)

    if not inspector.has_table('club_points_ledger'):
        op.create_table('club_points_ledger',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('points', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('transaction_id', sa.UUID(), nullable=True),
        sa.Column('rule_version', sa.Integer(), nullable=True),
        sa.Column('reverses_id', sa.UUID(), nullable=True),
        sa.Column('reason', sa.String(length=200), nullable=True),
        sa.Column('actor_user_id', sa.UUID(), nullable=True),
        sa.Column('unique_key', sa.String(length=160), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['membership_id'], ['club_memberships.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('unique_key', name='uq_club_points_ledger_key')
        )
    _index(sa.inspect(bind), 'ix_club_points_ledger_member', 'club_points_ledger', ['membership_id', 'created_at'], unique=False)
    _index(sa.inspect(bind), 'ix_club_points_ledger_tenant_id', 'club_points_ledger', ['tenant_id'], unique=False)

    if not inspector.has_table('club_redemption_reservations'):
        op.create_table('club_redemption_reservations',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tenant_id', sa.UUID(), nullable=False),
        sa.Column('membership_id', sa.UUID(), nullable=False),
        sa.Column('grant_id', sa.UUID(), nullable=True),
        sa.Column('points', sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column('status', sa.String(length=10), server_default='reserved', nullable=False),
        sa.Column('transaction_ref', sa.String(length=100), nullable=True),
        sa.Column('machine_id', sa.UUID(), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('unique_key', sa.String(length=160), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['membership_id'], ['club_memberships.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('unique_key', name='uq_club_redemption_reservations_key')
        )
    _index(sa.inspect(bind), 'ix_club_redemption_reservations_tenant_id', 'club_redemption_reservations', ['tenant_id'], unique=False)


def downgrade() -> None:
    # Never run on a shared database (it drops the message history and the club).
    for table in reversed(TABLES):
        op.drop_table(table)
