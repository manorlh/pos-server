"""freeze the Z header; count documents that arrive after a close

* `z_reports.header` — who issued the Z (business name, VAT id, company id, address,
  branch, shop), frozen when the Z is built so a later settings change cannot rewrite a
  filed Z. Existing Zs are backfilled from the settings as they stand now (that is the
  best there is for them; `capturedAt` says when).
* `shifts.late_documents`, `z_reports.late_documents` — documents that reached the cloud
  after the shift was closed / after its Z was built.

The backfill is self-contained on purpose (a frozen copy of
`app.services.settings_merge.build_business_info` over tenant → company → shop settings),
so this revision does not change meaning when that code does.

Revision ID: b1c2d3e4f5a6
Revises: a0b1c2d3e4f5
Create Date: 2026-09-28 00:30:00.000000
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "b1c2d3e4f5a6"
down_revision = "a0b1c2d3e4f5"
branch_labels = None
depends_on = None


def _d(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return dict(value) if isinstance(value, dict) else {}


def _merge(*layers):
    out = {}
    for layer in layers:
        for key, val in _d(layer).items():
            if key in out and isinstance(out[key], dict) and isinstance(val, dict):
                out[key] = {**out[key], **val}
            else:
                out[key] = val
    return out


def upgrade() -> None:
    op.add_column("z_reports", sa.Column("header", JSONB(), nullable=True))
    op.add_column(
        "z_reports",
        sa.Column("late_documents", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "shifts",
        sa.Column("late_documents", sa.Integer(), nullable=False, server_default="0"),
    )

    bind = op.get_bind()
    captured = datetime.now(timezone.utc).isoformat()
    rows = bind.execute(sa.text(
        """
        SELECT z.id, s.id, s.name, s.address, s.city, s.branch_id, s.settings,
               c.id, c.name, c.vat_number, c.address, c.city, c.settings, t.settings
          FROM z_reports z
          JOIN shops s ON s.id = z.shop_id
          LEFT JOIN companies c ON c.id = s.company_id
          LEFT JOIN tenants t ON t.id = c.tenant_id
         WHERE z.header IS NULL
        """
    )).fetchall()
    for (z_id, shop_id, shop_name, shop_address, shop_city, branch_id, shop_settings,
         company_id, company_name, vat_number, company_address, company_city,
         company_settings, tenant_settings) in rows:
        if company_id is None:
            header = {"shopId": str(shop_id), "shopName": shop_name, "capturedAt": captured}
        else:
            bi = _d(_merge(tenant_settings, company_settings, shop_settings).get("businessInfo"))
            address = shop_address or company_address or ""
            city = shop_city or company_city or ""
            header = {
                "businessName": bi.get("companyName") or company_name,
                "vatNumber": bi.get("vatNumber") or vat_number or None,
                "companyRegNumber": bi.get("companyRegNumber"),
                "companyId": str(company_id),
                "address": bi.get("companyAddress") or address or None,
                "addressNumber": bi.get("companyAddressNumber") or "1",
                "city": bi.get("companyCity") or city or None,
                "zip": bi.get("companyZip") or None,
                "branchId": bi.get("branchId") or branch_id,
                "shopId": str(shop_id),
                "shopName": shop_name,
                "capturedAt": captured,
                "backfilled": True,
            }
        bind.execute(
            sa.text("UPDATE z_reports SET header = CAST(:h AS JSONB) WHERE id = :id"),
            {"h": json.dumps(header), "id": z_id},
        )


def downgrade() -> None:
    op.drop_column("shifts", "late_documents")
    op.drop_column("z_reports", "late_documents")
    op.drop_column("z_reports", "header")
