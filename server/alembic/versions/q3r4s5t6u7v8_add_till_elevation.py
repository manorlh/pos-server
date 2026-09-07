"""add till PIN + elevated_sessions + sync_logs.actor_user_id

Lets a named person authorise a narrow action at a till without logging into the
dashboard, and without the till's own token being enough on its own.

Three parts:

* `users.till_pin_*` — a till-only credential, separate from cloud sign-in. bcrypt,
  because it is a human secret. The lockout counters sit here rather than beside
  cloud sign-in on purpose: a cashier idly guessing PINs at a counter must not be
  able to lock their manager out of the dashboard. What is set in the cloud is
  what the person types — there is no first-use change flag.
* `elevated_sessions` — one row per grant, re-read on every authorised request so a
  grant can be revoked immediately instead of lingering until a token expires.
  `token_hash` is SHA-256 (64 hex chars), not bcrypt: the token is 32 bytes from
  `secrets`, so there is no brute force to slow down and bcrypt would only add its
  work factor to every request.
* `sync_logs.actor_user_id` — the log could previously say which machine changed a
  price but never which person. Nullable, because unattended sync (catalog pulls,
  transaction uploads) genuinely has no actor.

Every column is nullable or carries a server default, so existing rows keep their
current meaning: no user has a till PIN, no sync log has an actor, and nobody holds
an elevated session. The feature is inert until someone sets a PIN.

Two indexes on `elevated_sessions` beyond the unique token: grants are listed per
user (an audit feed of who authorised what) and per machine (what happened at this
till), and both are the queries an override-visibility screen makes.

Revision ID: q3r4s5t6u7v8
Revises: p2q3r4s5t6u7
Create Date: 2026-09-01 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision = "q3r4s5t6u7v8"
down_revision = "p2q3r4s5t6u7"
branch_labels = None
depends_on = None


_USER_COLUMNS = (
    ("till_pin_hash", sa.Column("till_pin_hash", sa.String(255), nullable=True)),
    (
        "till_pin_set_at",
        sa.Column("till_pin_set_at", sa.DateTime(timezone=True), nullable=True),
    ),
    (
        "till_pin_failed_count",
        sa.Column(
            "till_pin_failed_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    ),
    (
        "till_pin_locked_until",
        sa.Column("till_pin_locked_until", sa.DateTime(timezone=True), nullable=True),
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing = {c["name"] for c in inspector.get_columns("users")}
    for name, column in _USER_COLUMNS:
        if name not in existing:
            op.add_column("users", column)

    if "actor_user_id" not in {c["name"] for c in inspector.get_columns("sync_logs")}:
        op.add_column(
            "sync_logs", sa.Column("actor_user_id", UUID(as_uuid=True), nullable=True)
        )
        op.create_foreign_key(
            "fk_sync_logs_actor_user_id_users",
            "sync_logs",
            "users",
            ["actor_user_id"],
            ["id"],
        )
        op.create_index("ix_sync_logs_actor_user_id", "sync_logs", ["actor_user_id"])

    if "elevated_sessions" not in inspector.get_table_names():
        op.create_table(
            "elevated_sessions",
            sa.Column(
                "id",
                UUID(as_uuid=True),
                primary_key=True,
                server_default=sa.text("gen_random_uuid()"),
            ),
            sa.Column("token_hash", sa.String(64), nullable=False),
            sa.Column("user_id", UUID(as_uuid=True), nullable=False),
            sa.Column("machine_id", UUID(as_uuid=True), nullable=False),
            sa.Column("shop_id", UUID(as_uuid=True), nullable=False),
            sa.Column("tenant_id", UUID(as_uuid=True), nullable=True),
            sa.Column("scopes", JSONB, nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "absolute_expires_at", sa.DateTime(timezone=True), nullable=False
            ),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.ForeignKeyConstraint(["machine_id"], ["pos_machines.id"]),
            sa.ForeignKeyConstraint(["shop_id"], ["shops.id"]),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.UniqueConstraint("token_hash", name="uq_elevated_sessions_token_hash"),
        )
        op.create_index(
            "ix_elevated_sessions_token", "elevated_sessions", ["token_hash"]
        )
        op.create_index(
            "ix_elevated_sessions_user_created",
            "elevated_sessions",
            ["user_id", "created_at"],
        )
        op.create_index(
            "ix_elevated_sessions_machine_created",
            "elevated_sessions",
            ["machine_id", "created_at"],
        )
        op.create_index("ix_elevated_sessions_user_id", "elevated_sessions", ["user_id"])
        op.create_index("ix_elevated_sessions_shop_id", "elevated_sessions", ["shop_id"])
        op.create_index(
            "ix_elevated_sessions_tenant_id", "elevated_sessions", ["tenant_id"]
        )


def downgrade() -> None:
    # Dropping the table discards live grants, which is the correct reading of a
    # rollback: nobody should still be elevated by a feature that no longer exists.
    op.drop_table("elevated_sessions")

    op.drop_index("ix_sync_logs_actor_user_id", table_name="sync_logs")
    op.drop_constraint("fk_sync_logs_actor_user_id_users", "sync_logs", type_="foreignkey")
    op.drop_column("sync_logs", "actor_user_id")

    for name, _column in reversed(_USER_COLUMNS):
        op.drop_column("users", name)
