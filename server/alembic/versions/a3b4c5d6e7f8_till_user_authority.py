"""let a till user carry authority, and a shop rename its own category buttons

Three changes, one reason: a shop manager signed in at a till was being asked to
approve themselves.

* `elevated_sessions.pos_user_id` — a grant may now be held by a till user who typed a
  username, not only a cloud account that typed an email. `user_id` becomes nullable
  and a CHECK keeps exactly one of the two set, so every grant still has one holder.
* `pos_users.pin_failed_count` / `pin_locked_until` — the cloud now checks a till
  user's PIN at the approval prompt, so it gets the lockout a cloud account's PIN
  already has.
* `sync_logs.actor_pos_user_id`, `z_reports.approved_by_pos_user_id` — where the audit
  names a till user who acted or approved. Beside the existing `users` columns rather
  than replacing them: a distributor approving from another city has no till login.
* `shop_category_overrides` — a shop's own name for a tenant category. Categories are
  served tenant-wide, so a till renaming the category row renamed it on every till in
  the tenant.

Nothing is backfilled. Every existing grant was taken by email and keeps its
`user_id`, so the CHECK holds for the rows already there.

Revision ID: a3b4c5d6e7f8
Revises: z2a3b4c5d6e7
Create Date: 2026-09-23 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "a3b4c5d6e7f8"
down_revision = "z2a3b4c5d6e7"
branch_labels = None
depends_on = None


#: (table, column, foreign-key constraint name) — every one references pos_users.id.
_POS_USER_REFS = (
    ("elevated_sessions", "pos_user_id", "fk_elevated_sessions_pos_user_id_pos_users"),
    ("sync_logs", "actor_pos_user_id", "fk_sync_logs_actor_pos_user_id_pos_users"),
    ("z_reports", "approved_by_pos_user_id", "fk_z_reports_approved_by_pos_user_id_pos_users"),
)

_ONE_HOLDER = "ck_elevated_sessions_one_holder"


def _columns(inspector, table: str) -> set[str]:
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    for table, column, fk_name in _POS_USER_REFS:
        if column in _columns(inspector, table):
            continue
        op.add_column(table, sa.Column(column, UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(fk_name, table, "pos_users", [column], ["id"])
        op.create_index(f"ix_{table}_{column}", table, [column])

    op.alter_column("elevated_sessions", "user_id", existing_type=UUID(as_uuid=True), nullable=True)
    existing_checks = {c["name"] for c in inspector.get_check_constraints("elevated_sessions")}
    if _ONE_HOLDER not in existing_checks:
        op.create_check_constraint(
            _ONE_HOLDER, "elevated_sessions", "(user_id IS NULL) <> (pos_user_id IS NULL)"
        )

    pos_user_columns = _columns(inspector, "pos_users")
    if "pin_failed_count" not in pos_user_columns:
        op.add_column(
            "pos_users",
            sa.Column("pin_failed_count", sa.Integer(), nullable=False, server_default="0"),
        )
    if "pin_locked_until" not in pos_user_columns:
        op.add_column(
            "pos_users", sa.Column("pin_locked_until", sa.DateTime(timezone=True), nullable=True)
        )

    if "shop_category_overrides" not in inspector.get_table_names():
        op.create_table(
            "shop_category_overrides",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
            sa.Column(
                "category_id", UUID(as_uuid=True), sa.ForeignKey("categories.id"), nullable=False
            ),
            sa.Column("name", sa.String(255), nullable=True),
            sa.Column(
                "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
            ),
            sa.Column(
                "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
            ),
            sa.UniqueConstraint("shop_id", "category_id", name="uq_shop_category_override"),
        )
        op.create_index("ix_shop_category_overrides_shop_id", "shop_category_overrides", ["shop_id"])
        op.create_index(
            "ix_shop_category_overrides_category_id", "shop_category_overrides", ["category_id"]
        )


def downgrade() -> None:
    op.drop_table("shop_category_overrides")
    op.drop_column("pos_users", "pin_locked_until")
    op.drop_column("pos_users", "pin_failed_count")

    op.drop_constraint(_ONE_HOLDER, "elevated_sessions", type_="check")
    # Grants held by a till user have no cloud account to fall back to. Revoking them
    # is the only way `user_id` can become NOT NULL again, and a rolled-back feature's
    # grants should not outlive it.
    op.execute("DELETE FROM elevated_sessions WHERE user_id IS NULL")
    op.alter_column("elevated_sessions", "user_id", existing_type=UUID(as_uuid=True), nullable=False)

    for table, column, fk_name in reversed(_POS_USER_REFS):
        op.drop_index(f"ix_{table}_{column}", table_name=table)
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.drop_column(table, column)
