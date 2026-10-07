"""
"תפקידים והרשאות" for till users (docs/SPEC_ROLES_PERMISSIONS.md).

* `till_roles` — a company's till roles: the built-ins (`builtin_key`: waiter, cashier,
  supervisor, manager and the two legacy roles that keep today's behaviour) and its own
  custom ones. `permissions` / `limits` hold only what the role sets itself; everything
  else comes from its template (`app/services/till_permissions.py`). Custom roles are
  soft-deleted (`deleted_at`); built-ins are never deleted.
* `till_role_changes` — who changed what, when, before → after: a role created, edited,
  renamed, deleted, a user assigned, a user's overrides, "apply the spec's defaults".
  Append-only.

A till user's role is `pos_users.till_role_id` (null: not yet assigned — they keep the
legacy role matching `pos_users.role`), with optional per-user overrides in
`pos_users.permission_overrides`.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class TillRole(Base):
    __tablename__ = "till_roles"
    __table_args__ = (
        UniqueConstraint("company_id", "builtin_key", name="uq_till_roles_company_builtin"),
        Index("ix_till_roles_company", "company_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    #: waiter | cashier | supervisor | manager | legacy_cashier | legacy_manager; null = custom.
    builtin_key = Column(String(32), nullable=True)
    #: A custom role's template (the built-in it was created from); null = cashier.
    base_key = Column(String(32), nullable=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    #: `{code: allow|approval|deny}` — only what this role sets itself.
    permissions = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: `{code: {maxPercent|maxAmount: number}}` — only what this role sets itself.
    limits = Column(JSONB, nullable=False, default=dict, server_default="{}")
    sort_order = Column(Integer, nullable=False, default=100, server_default="100")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class TillRoleChange(Base):
    """One change to a till role or to a till user's role / overrides. Never updated or deleted."""

    __tablename__ = "till_role_changes"
    __table_args__ = (
        Index("ix_till_role_changes_company_created", "company_id", "created_at"),
        Index("ix_till_role_changes_role", "role_id"),
        Index("ix_till_role_changes_pos_user", "pos_user_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    #: Not foreign keys: the log outlives what it describes.
    role_id = Column(UUID(as_uuid=True), nullable=True)
    role_name = Column(String(100), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_name = Column(String(200), nullable=True)
    #: create | update | delete | assign | overrides | apply_defaults
    action = Column(String(20), nullable=False)
    old_value = Column(JSONB, nullable=True)
    new_value = Column(JSONB, nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    user_email = Column(String(255), nullable=True)
    user_role = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
