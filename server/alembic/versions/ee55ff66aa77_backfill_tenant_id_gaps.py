"""backfill remaining null tenant_id rows

Revision ID: ee55ff66aa77
Revises: cc33dd44ee55
Create Date: 2026-05-30 18:00:00.000000
"""

from alembic import op


revision = "ee55ff66aa77"
down_revision = "cc33dd44ee55"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Pairing codes without tenant (e.g. created before tenant-scoped pairing)
    op.execute(
        """
        UPDATE pairing_codes pc
        SET tenant_id = u.tenant_id
        FROM users u
        WHERE pc.distributor_id = u.id
          AND pc.tenant_id IS NULL
          AND u.tenant_id IS NOT NULL
        """
    )

    # Machines: from assigned merchant, shop, or distributor user
    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE pm.merchant_id = m.id
          AND pm.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = s.tenant_id
        FROM shops s
        WHERE pm.shop_id = s.id
          AND pm.tenant_id IS NULL
          AND s.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = pc.tenant_id
        FROM pairing_codes pc
        WHERE pc.pos_machine_id = pm.id
          AND pm.tenant_id IS NULL
          AND pc.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = u.tenant_id
        FROM users u
        WHERE pm.distributor_id = u.id
          AND pm.tenant_id IS NULL
          AND u.tenant_id IS NOT NULL
        """
    )

    # Products: merchant, machine, shop, or global parent
    op.execute(
        """
        UPDATE products p
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE p.merchant_id = m.id
          AND p.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE products p
        SET tenant_id = pm.tenant_id
        FROM pos_machines pm
        WHERE p.pos_machine_id = pm.id
          AND p.tenant_id IS NULL
          AND pm.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE products p
        SET tenant_id = s.tenant_id
        FROM shops s
        WHERE p.shop_id = s.id
          AND p.tenant_id IS NULL
          AND s.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE products p
        SET tenant_id = gp.tenant_id
        FROM products gp
        WHERE p.global_product_id = gp.id
          AND p.tenant_id IS NULL
          AND gp.tenant_id IS NOT NULL
        """
    )

    # Categories: merchant, machine, shop
    op.execute(
        """
        UPDATE categories c
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE c.merchant_id = m.id
          AND c.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE categories c
        SET tenant_id = pm.tenant_id
        FROM pos_machines pm
        WHERE c.pos_machine_id = pm.id
          AND c.tenant_id IS NULL
          AND pm.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE categories c
        SET tenant_id = s.tenant_id
        FROM shops s
        WHERE c.shop_id = s.id
          AND c.tenant_id IS NULL
          AND s.tenant_id IS NOT NULL
        """
    )

    # POS users: merchant or shop
    op.execute(
        """
        UPDATE pos_users pu
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE pu.merchant_id = m.id
          AND pu.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE pos_users pu
        SET tenant_id = s.tenant_id
        FROM shops s
        WHERE pu.shop_id = s.id
          AND pu.tenant_id IS NULL
          AND s.tenant_id IS NOT NULL
        """
    )

    # Transactions / trading days / z-reports: merchant or machine
    op.execute(
        """
        UPDATE transactions t
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE t.merchant_id = m.id
          AND t.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE transactions t
        SET tenant_id = pm.tenant_id
        FROM pos_machines pm
        WHERE t.machine_id = pm.id
          AND t.tenant_id IS NULL
          AND pm.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE trading_days td
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE td.merchant_id = m.id
          AND td.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE trading_days td
        SET tenant_id = pm.tenant_id
        FROM pos_machines pm
        WHERE td.machine_id = pm.id
          AND td.tenant_id IS NULL
          AND pm.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE z_reports z
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE z.merchant_id = m.id
          AND z.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE z_reports z
        SET tenant_id = pm.tenant_id
        FROM pos_machines pm
        WHERE z.machine_id = pm.id
          AND z.tenant_id IS NULL
          AND pm.tenant_id IS NOT NULL
        """
    )

    # Companies / shops / users without tenant
    op.execute(
        """
        UPDATE companies c
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE c.merchant_id = m.id
          AND c.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE shops s
        SET tenant_id = c.tenant_id
        FROM companies c
        WHERE s.company_id = c.id
          AND s.tenant_id IS NULL
          AND c.tenant_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE users u
        SET tenant_id = m.tenant_id
        FROM merchants m
        WHERE u.merchant_id = m.id
          AND u.tenant_id IS NULL
          AND m.tenant_id IS NOT NULL
        """
    )


def downgrade() -> None:
    # Data backfill is not reversed
    pass
