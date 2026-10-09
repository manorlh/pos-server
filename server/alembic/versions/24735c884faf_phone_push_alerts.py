"""alerts: phone (Web Push) alerts on the exception alerts ("התראות לטלפון")

Revision ID: 24735c884faf
Revises: 3bab01c8184e
Create Date: 2026-10-09

Extends the SMS exception alerts rather than adding a parallel system:

* `exception_alert_rules` — `channel` ("sms" | "push", every existing rule "sms"),
  `owner_user_id` (a push rule is one user's preferences), `categories`, `shop_ids`,
  `event_ids` (what a push rule watches); `company_id` becomes nullable (a push rule follows
  its owner's reach, not one company).
* `exception_alert_dispatches` — `channel`, `user_id`, `subscription_id`, and an index for a
  user's history.
* `push_subscriptions` — the browsers / phones each dashboard user subscribed.

Idempotent: every column / index / table only when missing (the auto-reloading API's
`create_all` makes new tables before alembic runs); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "24735c884faf"
down_revision: Union[str, Sequence[str], None] = "3bab01c8184e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RULES = "exception_alert_rules"
DISPATCHES = "exception_alert_dispatches"
SUBS = "push_subscriptions"


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _columns(table: str) -> set:
    if _offline():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _has_table(table: str) -> bool:
    return False if _offline() else sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    have = _columns(RULES)
    if "channel" not in have:
        op.add_column(RULES, sa.Column("channel", sa.String(12), nullable=False, server_default="sms"))
    if "owner_user_id" not in have:
        op.add_column(RULES, sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(
            "fk_exception_alert_rules_owner_user_id", RULES, "users", ["owner_user_id"], ["id"], ondelete="CASCADE",
        )
    for name in ("categories", "shop_ids", "event_ids"):
        if name not in have:
            op.add_column(RULES, sa.Column(name, postgresql.JSONB(), nullable=True))
    op.alter_column(RULES, "company_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    if "ix_exception_alert_rules_owner_user_id" not in _indexes(RULES):
        op.create_index("ix_exception_alert_rules_owner_user_id", RULES, ["owner_user_id"])

    have = _columns(DISPATCHES)
    if "channel" not in have:
        op.add_column(DISPATCHES, sa.Column("channel", sa.String(12), nullable=False, server_default="sms"))
    if "user_id" not in have:
        op.add_column(DISPATCHES, sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "subscription_id" not in have:
        op.add_column(DISPATCHES, sa.Column("subscription_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "ix_exception_alert_dispatches_user_created" not in _indexes(DISPATCHES):
        op.create_index("ix_exception_alert_dispatches_user_created", DISPATCHES, ["user_id", "created_at"])

    if not _has_table(SUBS):
        op.create_table(
            SUBS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("endpoint", sa.Text(), nullable=False),
            sa.Column("endpoint_hash", sa.String(64), nullable=False),
            sa.Column("p256dh", sa.String(200), nullable=False),
            sa.Column("auth", sa.String(100), nullable=False),
            sa.Column("label", sa.String(120), nullable=True),
            sa.Column("user_agent", sa.String(300), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_failure_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_error", sa.String(200), nullable=True),
            sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("endpoint_hash", name="uq_push_subscriptions_endpoint_hash"),
        )
    if "ix_push_subscriptions_user" not in _indexes(SUBS):
        op.create_index("ix_push_subscriptions_user", SUBS, ["user_id", "disabled_at"])


def downgrade() -> None:
    op.drop_index("ix_push_subscriptions_user", table_name=SUBS)
    op.drop_table(SUBS)
    op.drop_index("ix_exception_alert_dispatches_user_created", table_name=DISPATCHES)
    for name in ("subscription_id", "user_id", "channel"):
        op.drop_column(DISPATCHES, name)
    op.drop_index("ix_exception_alert_rules_owner_user_id", table_name=RULES)
    op.drop_constraint("fk_exception_alert_rules_owner_user_id", RULES, type_="foreignkey")
    for name in ("event_ids", "shop_ids", "categories", "owner_user_id", "channel"):
        op.drop_column(RULES, name)
    # company_id stays nullable: push rules may exist without one.
