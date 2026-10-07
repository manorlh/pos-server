"""exception log ("יומן חריגות") and SMS alert rules ("התראות SMS על חריגות")

app/services/exception_alerts:

* `exception_log` — one row per detected exception event, from every detection point,
  unique per source event (`dedupe_key`), with a short code for the SMS link and the
  manager's "טופל" (`acknowledged_*`, `note`).
* `exception_alert_rules` — per company / shop: kinds, thresholds, "N in M minutes",
  recipients, quiet hours, rate limit + digest, on/off.
* `exception_alert_dispatches` — every SMS attempt (sent / dry run / queued / failed /
  held back), per recipient (masked + keyed hash only).
* `exception_alert_rule_changes` — the rules' change log.

Backfill: `audit_exceptions` → `exception_log` (read-only on the source; one INSERT …
SELECT, `ON CONFLICT DO NOTHING`, marked `backfilled` — never alerted). The other
sources: `python -m scripts.backfill_exception_log`.

Idempotent: the auto-reloading API runs `create_all` at startup, so a table may exist
before this runs; only what is missing is created, and the backfill skips what is there.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = 'f3a9c2e7b5d1'
down_revision: Union[str, Sequence[str], None] = 'c7e2f4a9d1b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()
LOG = 'exception_log'
RULES = 'exception_alert_rules'
DISPATCHES = 'exception_alert_dispatches'
CHANGES = 'exception_alert_rule_changes'


def _indexes(inspector, table: str) -> set:
    return {i['name'] for i in inspector.get_indexes(table)}


def _ensure_indexes(inspector, table: str, wanted) -> None:
    have = _indexes(inspector, table)
    for name, columns in wanted:
        if name not in have:
            op.create_index(name, table, columns)


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(LOG):
        op.create_table(
            LOG,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=True),
            sa.Column('company_id', UUID, nullable=True),
            sa.Column('shop_id', UUID, nullable=True),
            sa.Column('area_id', UUID, nullable=True),
            sa.Column('machine_id', UUID, nullable=True),
            sa.Column('kind', sa.String(40), nullable=False),
            sa.Column('severity', sa.String(16), nullable=False, server_default='medium'),
            sa.Column('source', sa.String(32), nullable=False),
            sa.Column('source_id', sa.String(100), nullable=True),
            sa.Column('dedupe_key', sa.String(200), nullable=False),
            sa.Column('short_code', sa.String(16), nullable=False),
            sa.Column('pos_user_id', sa.String(100), nullable=True),
            sa.Column('pos_user_name', sa.String(200), nullable=True),
            sa.Column('amount', sa.Numeric(12, 2), nullable=True),
            sa.Column('value', sa.Numeric(12, 2), nullable=True),
            sa.Column('threshold', sa.Numeric(12, 2), nullable=True),
            sa.Column('summary', sa.String(300), nullable=True),
            sa.Column('details', JSONB, nullable=True),
            sa.Column('transaction_id', UUID, nullable=True),
            sa.Column('shift_id', UUID, nullable=True),
            sa.Column('z_report_id', UUID, nullable=True),
            sa.Column('till_event_id', UUID, nullable=True),
            sa.Column('audit_exception_id', UUID, nullable=True),
            sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('received_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('backfilled', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('acknowledged_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('acknowledged_by_user_id', UUID, sa.ForeignKey('users.id'), nullable=True),
            sa.Column('note', sa.Text(), nullable=True),
            sa.UniqueConstraint('dedupe_key', name='uq_exception_log_dedupe_key'),
            sa.UniqueConstraint('short_code', name='uq_exception_log_short_code'),
        )
        inspector = sa.inspect(bind)
    _ensure_indexes(inspector, LOG, (
        ('ix_exception_log_tenant_occurred', ['tenant_id', 'occurred_at']),
        ('ix_exception_log_shop_occurred', ['shop_id', 'occurred_at']),
        ('ix_exception_log_machine_occurred', ['machine_id', 'occurred_at']),
        ('ix_exception_log_kind', ['kind']),
        ('ix_exception_log_audit_exception', ['audit_exception_id']),
        ('ix_exception_log_pos_user_id', ['pos_user_id']),
        ('ix_exception_log_acknowledged_at', ['acknowledged_at']),
    ))

    if not inspector.has_table(RULES):
        op.create_table(
            RULES,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id'), nullable=True),
            sa.Column('name', sa.String(120), nullable=False),
            sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('kinds', JSONB, nullable=False, server_default='[]'),
            sa.Column('min_severity', sa.String(16), nullable=True),
            sa.Column('min_amount', sa.Numeric(12, 2), nullable=True),
            sa.Column('min_percent', sa.Numeric(7, 2), nullable=True),
            sa.Column('count_threshold', sa.Integer(), nullable=True),
            sa.Column('count_window_minutes', sa.Integer(), nullable=True),
            sa.Column('count_scope', sa.String(16), nullable=False, server_default='machine'),
            sa.Column('recipients', JSONB, nullable=False, server_default='[]'),
            sa.Column('quiet_from', sa.String(5), nullable=True),
            sa.Column('quiet_to', sa.String(5), nullable=True),
            sa.Column('rate_limit_minutes', sa.Integer(), nullable=False, server_default='10'),
            sa.Column('digest_enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_by', UUID, nullable=True),
            sa.Column('updated_by', UUID, nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)
    _ensure_indexes(inspector, RULES, (
        ('ix_exception_alert_rules_scope', ['tenant_id', 'company_id', 'shop_id']),
    ))

    if not inspector.has_table(DISPATCHES):
        op.create_table(
            DISPATCHES,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, nullable=False),
            sa.Column('rule_id', UUID, sa.ForeignKey('exception_alert_rules.id'), nullable=True),
            sa.Column('entry_id', UUID, sa.ForeignKey('exception_log.id'), nullable=True),
            sa.Column('kind', sa.String(12), nullable=False),
            sa.Column('status', sa.String(32), nullable=False),
            sa.Column('reason', sa.String(120), nullable=True),
            sa.Column('provider', sa.String(24), nullable=True),
            sa.Column('provider_mode', sa.String(16), nullable=True),
            sa.Column('notification_id', UUID, nullable=True),
            sa.Column('recipient_hash', sa.String(64), nullable=False),
            sa.Column('recipient_masked', sa.String(32), nullable=False),
            sa.Column('recipient_label', sa.String(120), nullable=True),
            sa.Column('text', sa.Text(), nullable=True),
            sa.Column('dedupe_key', sa.String(200), nullable=False),
            sa.Column('digest_id', UUID, nullable=True),
            sa.Column('digest_count', sa.Integer(), nullable=True),
            sa.Column('created_by', UUID, nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint('dedupe_key', name='uq_exception_alert_dispatches_dedupe_key'),
        )
        inspector = sa.inspect(bind)
    _ensure_indexes(inspector, DISPATCHES, (
        ('ix_exception_alert_dispatches_tenant_id', ['tenant_id']),
        ('ix_exception_alert_dispatches_rule_created', ['rule_id', 'created_at']),
        ('ix_exception_alert_dispatches_entry', ['entry_id']),
        ('ix_exception_alert_dispatches_digest', ['digest_id']),
        ('ix_exception_alert_dispatches_pending', ['status', 'digest_id']),
    ))

    if not inspector.has_table(CHANGES):
        op.create_table(
            CHANGES,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, nullable=False),
            sa.Column('rule_id', UUID, nullable=False),
            sa.Column('action', sa.String(16), nullable=False),
            sa.Column('old_value', JSONB, nullable=True),
            sa.Column('new_value', JSONB, nullable=True),
            sa.Column('user_id', UUID, nullable=True),
            sa.Column('user_email', sa.String(255), nullable=True),
            sa.Column('user_role', sa.String(32), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)
    _ensure_indexes(inspector, CHANGES, (
        ('ix_exception_alert_rule_changes_tenant_id', ['tenant_id']),
        ('ix_exception_alert_rule_changes_rule', ['rule_id', 'created_at']),
    ))

    # Backfill from the exceptions report (read-only on audit_exceptions). Deterministic
    # ids and codes from the exception's id: running it twice changes nothing.
    if inspector.has_table('audit_exceptions'):
        op.execute(sa.text(
            """
            INSERT INTO exception_log (
                id, tenant_id, company_id, shop_id, area_id, machine_id, kind, severity, source,
                source_id, dedupe_key, short_code, pos_user_id, pos_user_name, amount, value,
                threshold, summary, details, transaction_id, shift_id, z_report_id, till_event_id,
                audit_exception_id, occurred_at, received_at, backfilled, acknowledged_at,
                acknowledged_by_user_id, note
            )
            SELECT
                md5('exception_log:' || ae.id::text)::uuid,
                ae.tenant_id, ae.company_id, ae.shop_id, ae.area_id, ae.machine_id,
                left(ae.exception_type, 40), coalesce(ae.severity, 'medium'), 'audit_exception',
                ae.id::text, left('audit:' || ae.id::text, 200),
                substr(md5('exception_log_code:' || ae.id::text), 1, 10),
                ae.pos_user_id, ae.pos_user_name, ae.amount, ae.value, ae.threshold,
                CASE WHEN jsonb_typeof(ae.details -> 'summary') = 'string'
                     THEN left(ae.details ->> 'summary', 300) END,
                ae.details, ae.transaction_id, ae.shift_id,
                CASE WHEN (ae.details ->> 'zReportId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     THEN (ae.details ->> 'zReportId')::uuid END,
                ae.till_event_id, ae.id, ae.occurred_at, coalesce(ae.detected_at, ae.occurred_at), true,
                CASE WHEN ae.status IN ('reviewed', 'dismissed') THEN coalesce(ae.reviewed_at, ae.detected_at) END,
                CASE WHEN ae.status IN ('reviewed', 'dismissed') THEN ae.reviewed_by_user_id END,
                CASE WHEN ae.status IN ('reviewed', 'dismissed') THEN ae.review_note END
            FROM audit_exceptions ae
            ON CONFLICT DO NOTHING
            """
        ))


def downgrade() -> None:
    op.drop_index('ix_exception_alert_rule_changes_rule', table_name=CHANGES)
    op.drop_index('ix_exception_alert_rule_changes_tenant_id', table_name=CHANGES)
    op.drop_table(CHANGES)
    for name in ('ix_exception_alert_dispatches_pending', 'ix_exception_alert_dispatches_digest',
                 'ix_exception_alert_dispatches_entry',
                 'ix_exception_alert_dispatches_rule_created', 'ix_exception_alert_dispatches_tenant_id'):
        op.drop_index(name, table_name=DISPATCHES)
    op.drop_table(DISPATCHES)
    op.drop_index('ix_exception_alert_rules_scope', table_name=RULES)
    op.drop_table(RULES)
    for name in ('ix_exception_log_acknowledged_at', 'ix_exception_log_pos_user_id', 'ix_exception_log_audit_exception',
                 'ix_exception_log_kind', 'ix_exception_log_machine_occurred', 'ix_exception_log_shop_occurred',
                 'ix_exception_log_tenant_occurred'):
        op.drop_index(name, table_name=LOG)
    op.drop_table(LOG)
