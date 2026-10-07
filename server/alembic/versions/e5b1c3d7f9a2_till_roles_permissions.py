"""Till roles and permissions ("תפקידים והרשאות", docs/SPEC_ROLES_PERMISSIONS.md)

* `till_roles` — a company's till roles (built-ins + custom), each with only the
  permissions / limits it sets itself (the rest come from its template in code).
* `till_role_changes` — the audit of roles and of till users' role / overrides.
* `pos_users.till_role_id` / `pos_users.permission_overrides` — a till user's role and
  their own exceptions to it.

No data is moved: every existing till user keeps `till_role_id = NULL`, which resolves to
the legacy role matching `pos_users.role` — exactly today's behaviour (a cashier with
today's manager-approval gates, a shop manager with everything). A company's roles are
created when its roles are first opened (app/services/till_roles.py
`ensure_company_roles`), and its unassigned users are pointed at those legacy roles then.

Idempotent: the auto-reloading dev API's `create_all` may make the new tables before this
runs, so every table, column and index is looked at first. Never downgraded in place.

Revision ID: e5b1c3d7f9a2
Revises: c7e2f4a9d1b6
Create Date: 2026-10-08
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e5b1c3d7f9a2"
down_revision: Union[str, Sequence[str], None] = "c7e2f4a9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ROLES = "till_roles"
CHANGES = "till_role_changes"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def _uniques(insp, table: str) -> set:
    return set() if insp is None else {u["name"] for u in insp.get_unique_constraints(table)}


def _fks(insp, table: str) -> set:
    return set() if insp is None else {f["name"] for f in insp.get_foreign_keys(table)}


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)

    if not _has_table(insp, ROLES):
        op.create_table(
            ROLES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
            sa.Column("builtin_key", sa.String(32), nullable=True),
            sa.Column("base_key", sa.String(32), nullable=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("permissions", postgresql.JSONB(), nullable=False, server_default="{}"),
            sa.Column("limits", postgresql.JSONB(), nullable=False, server_default="{}"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="100"),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", uuid, nullable=True),
            sa.Column("updated_by", uuid, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("company_id", "builtin_key", name="uq_till_roles_company_builtin"),
        )
        insp = _inspector()
    have = _indexes(insp, ROLES)
    for name, cols in (("ix_till_roles_company", ["company_id"]), ("ix_till_roles_tenant_id", ["tenant_id"])):
        if name not in have:
            op.create_index(name, ROLES, cols)

    if not _has_table(insp, CHANGES):
        op.create_table(
            CHANGES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, nullable=False),
            sa.Column("company_id", uuid, nullable=False),
            sa.Column("role_id", uuid, nullable=True),
            sa.Column("role_name", sa.String(100), nullable=True),
            sa.Column("pos_user_id", uuid, nullable=True),
            sa.Column("pos_user_name", sa.String(200), nullable=True),
            sa.Column("action", sa.String(20), nullable=False),
            sa.Column("old_value", postgresql.JSONB(), nullable=True),
            sa.Column("new_value", postgresql.JSONB(), nullable=True),
            sa.Column("user_id", uuid, nullable=True),
            sa.Column("user_email", sa.String(255), nullable=True),
            sa.Column("user_role", sa.String(32), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    have = _indexes(insp, CHANGES)
    for name, cols in (
        ("ix_till_role_changes_company_created", ["company_id", "created_at"]),
        ("ix_till_role_changes_role", ["role_id"]),
        ("ix_till_role_changes_pos_user", ["pos_user_id"]),
        ("ix_till_role_changes_tenant_id", ["tenant_id"]),
    ):
        if name not in have:
            op.create_index(name, CHANGES, cols)

    cols = _columns(insp, "pos_users")
    if "till_role_id" not in cols:
        op.add_column("pos_users", sa.Column("till_role_id", uuid, nullable=True))
    if "permission_overrides" not in cols:
        op.add_column("pos_users", sa.Column("permission_overrides", postgresql.JSONB(), nullable=True))
    insp = _inspector()
    # A column `create_all` added would already carry an (auto-named) FK; only add ours
    # when there is none on the column.
    has_fk = insp is not None and any(
        "till_role_id" in (f.get("constrained_columns") or []) for f in insp.get_foreign_keys("pos_users")
    )
    if not has_fk:
        op.create_foreign_key(
            "fk_pos_users_till_role_id", "pos_users", ROLES, ["till_role_id"], ["id"], ondelete="SET NULL"
        )
    if "ix_pos_users_till_role_id" not in _indexes(insp, "pos_users"):
        op.create_index("ix_pos_users_till_role_id", "pos_users", ["till_role_id"])


def downgrade() -> None:
    insp = _inspector()
    offline = insp is None
    if offline or "ix_pos_users_till_role_id" in _indexes(insp, "pos_users"):
        op.drop_index("ix_pos_users_till_role_id", table_name="pos_users")
    if offline or "fk_pos_users_till_role_id" in _fks(insp, "pos_users"):
        op.drop_constraint("fk_pos_users_till_role_id", "pos_users", type_="foreignkey")
    cols = _columns(insp, "pos_users")
    for name in ("permission_overrides", "till_role_id"):
        if offline or name in cols:
            op.drop_column("pos_users", name)
    for table in (CHANGES, ROLES):
        if offline or _has_table(insp, table):
            op.drop_table(table)
