"""add multi-tenant foundation

Revision ID: aa11bb22cc33
Revises: b7c6d5e4f3a2
Create Date: 2026-05-04 22:15:00.000000
"""

from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision = "aa11bb22cc33"
down_revision = "b7c6d5e4f3a2"
branch_labels = None
depends_on = None


def _add_tenant_fk_column(table_name: str) -> None:
    op.add_column(table_name, sa.Column("tenant_id", UUID(as_uuid=True), nullable=True))
    op.create_index(f"ix_{table_name}_tenant_id", table_name, ["tenant_id"])
    op.create_foreign_key(
        f"fk_{table_name}_tenant_id",
        table_name,
        "tenants",
        ["tenant_id"],
        ["id"],
        ondelete="SET NULL",
    )


def upgrade() -> None:
    # Do not call Enum.create() separately: PostgreSQL would emit CREATE TYPE twice
    # (once here and again from create_table), causing DuplicateObject.
    tenant_status = sa.Enum("active", "suspended", "archived", name="tenantstatus")
    membership_role = sa.Enum(
        "tenant_owner",
        "tenant_admin",
        "tenant_member",
        name="tenantmembershiprole",
    )

    op.create_table(
        "tenants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("status", tenant_status, nullable=False, server_default="active"),
        sa.Column("timezone", sa.String(100), nullable=False, server_default="UTC"),
        sa.Column("default_currency", sa.String(8), nullable=False, server_default="ILS"),
        sa.Column("locale", sa.String(32), nullable=False, server_default="en"),
        sa.Column("settings", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_tenants_name", "tenants", ["name"], unique=True)
    op.create_index("ix_tenants_slug", "tenants", ["slug"], unique=True)

    _add_tenant_fk_column("merchants")
    _add_tenant_fk_column("users")
    _add_tenant_fk_column("companies")
    _add_tenant_fk_column("shops")
    _add_tenant_fk_column("pos_machines")
    _add_tenant_fk_column("products")
    _add_tenant_fk_column("categories")
    _add_tenant_fk_column("transactions")
    _add_tenant_fk_column("trading_days")
    _add_tenant_fk_column("z_reports")
    _add_tenant_fk_column("pos_users")

    op.create_table(
        "tenant_memberships",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", membership_role, nullable=False, server_default="tenant_member"),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("tenant_id", "user_id", name="uq_tenant_user_membership"),
    )
    op.create_index("ix_tenant_memberships_tenant_id", "tenant_memberships", ["tenant_id"])
    op.create_index("ix_tenant_memberships_user_id", "tenant_memberships", ["user_id"])

    bootstrap_tenant_id = uuid.uuid4()
    op.execute(
        sa.text(
            """
            INSERT INTO tenants (id, name, slug, status, timezone, default_currency, locale)
            VALUES (:id, 'Default Tenant', 'default-tenant', 'active', 'Asia/Jerusalem', 'ILS', 'he-IL')
            """
        ).bindparams(id=bootstrap_tenant_id)
    )

    op.execute(sa.text("UPDATE merchants SET tenant_id = :tid WHERE tenant_id IS NULL").bindparams(tid=bootstrap_tenant_id))
    op.execute(
        sa.text(
            """
            UPDATE users u
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE u.merchant_id = m.id AND u.tenant_id IS NULL
            """
        )
    )
    op.execute(sa.text("UPDATE users SET tenant_id = :tid WHERE tenant_id IS NULL").bindparams(tid=bootstrap_tenant_id))
    op.execute(
        sa.text(
            """
            UPDATE companies c
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE c.merchant_id = m.id AND c.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE shops s
            SET tenant_id = c.tenant_id
            FROM companies c
            WHERE s.company_id = c.id AND s.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE pos_machines pm
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE pm.merchant_id = m.id AND pm.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE products p
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE p.merchant_id = m.id AND p.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE categories c
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE c.merchant_id = m.id AND c.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE transactions t
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE t.merchant_id = m.id AND t.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE trading_days td
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE td.merchant_id = m.id AND td.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE z_reports z
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE z.merchant_id = m.id AND z.tenant_id IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE pos_users pu
            SET tenant_id = m.tenant_id
            FROM merchants m
            WHERE pu.merchant_id = m.id AND pu.tenant_id IS NULL
            """
        )
    )

    bind = op.get_bind()
    users = bind.execute(sa.text("SELECT id, tenant_id, role FROM users WHERE tenant_id IS NOT NULL")).fetchall()
    for user_id, tenant_id, role in users:
        exists = bind.execute(
            sa.text(
                """
                SELECT 1 FROM tenant_memberships
                WHERE tenant_id = :tenant_id AND user_id = :user_id
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id},
        ).first()
        if exists:
            continue
        membership_role_name = "tenant_admin" if role in ("super_admin", "distributor", "merchant_admin") else "tenant_member"
        bind.execute(
            sa.text(
                """
                INSERT INTO tenant_memberships (id, tenant_id, user_id, role, is_default)
                VALUES (:id, :tenant_id, :user_id, CAST(:role AS tenantmembershiprole), true)
                """
            ),
            {
                "id": uuid.uuid4(),
                "tenant_id": tenant_id,
                "user_id": user_id,
                "role": membership_role_name,
            },
        )


def downgrade() -> None:
    op.drop_index("ix_tenant_memberships_user_id", table_name="tenant_memberships")
    op.drop_index("ix_tenant_memberships_tenant_id", table_name="tenant_memberships")
    op.drop_table("tenant_memberships")

    for table_name in [
        "pos_users",
        "z_reports",
        "trading_days",
        "transactions",
        "categories",
        "products",
        "pos_machines",
        "shops",
        "companies",
        "users",
        "merchants",
    ]:
        op.drop_constraint(f"fk_{table_name}_tenant_id", table_name, type_="foreignkey")
        op.drop_index(f"ix_{table_name}_tenant_id", table_name=table_name)
        op.drop_column(table_name, "tenant_id")

    op.drop_index("ix_tenants_slug", table_name="tenants")
    op.drop_index("ix_tenants_name", table_name="tenants")
    op.drop_table("tenants")

    sa.Enum(name="tenantmembershiprole").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="tenantstatus").drop(op.get_bind(), checkfirst=True)
