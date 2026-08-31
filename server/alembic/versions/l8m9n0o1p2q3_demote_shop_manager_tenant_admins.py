"""demote tenant_admin memberships held by shop managers and cashiers

`_ensure_membership_for_user_home_tenant` used to grant TENANT_ADMIN to everyone from
shop_manager upward, and it runs on GET /tenants/mine — which the dashboard calls on
every load. So a single shop's manager was silently given standing to PATCH the tenant
and to write tenant-wide POS settings, which fan out to every machine in every shop.

The code no longer grants it, but rows created before that fix still carry it. This
migration brings the data in line with the rule.

Deliberately scoped by the *user's* role, not by the membership row alone: a
super_admin, distributor or company_manager holding tenant_admin is correct and is left
untouched. TENANT_OWNER is never demoted — that is a real ownership claim, and someone
has to be able to administer the tenant.

Revision ID: l8m9n0o1p2q3
Revises: k7l8m9n0o1p2
Create Date: 2026-08-28 10:00:00.000000
"""

from alembic import op


revision = "l8m9n0o1p2q3"
down_revision = "k7l8m9n0o1p2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE tenant_memberships tm
           SET role = 'tenant_member'
          FROM users u
         WHERE u.id = tm.user_id
           AND tm.role = 'tenant_admin'
           AND u.role IN ('shop_manager', 'cashier')
        """
    )


def downgrade() -> None:
    """
    Not reversible, and deliberately not faked.

    Re-promoting every shop_manager and cashier would hand tenant administration back
    to exactly the accounts this exists to take it from, and there is no record of
    which rows this touched. A no-op downgrade is the honest choice: reverting the
    schema chain past this point leaves the data correct rather than restoring a hole.
    """
    pass
