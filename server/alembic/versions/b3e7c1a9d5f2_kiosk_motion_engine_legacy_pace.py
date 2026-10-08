"""kiosk motion engine: the kiosks from before it keep their pace ("legacy")

Revision ID: b3e7c1a9d5f2
Revises: a6d2f8c4e0b7
Create Date: 2026-10-08 12:00:00.000000

"מנוע הנפשות" (app/services/kiosk_motion.py): a new kiosk gets Runner Standard — the spec's clearer,
longer timings (press 450 ms, add 750, screen 650, success 1000). A kiosk that exists today must not
change its pace on upgrade, so every company that has a kiosk now gets `motion.preset: "legacy"`
in its company layer (the transitions' kinds and times as before the engine, the new feedback at
the fast pace). The dashboard shows it as "Runner Classic"; one pick of Runner Standard at the
company (or a shop, or one kiosk) moves it.

Data only, idempotent: a company layer that already names a preset is left alone; a company with
no layer gets one holding only the stamp. No schema change.
"""
import json
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3e7c1a9d5f2"
down_revision: Union[str, Sequence[str], None] = "a6d2f8c4e0b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LEGACY = "legacy"


def _as_dict(value):
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("kiosk_settings", "kiosk_devices", "pos_machines", "shops", "companies"):
        if not inspector.has_table(table):
            return
    postgres = bind.dialect.name == "postgresql"
    as_json = "CAST(:o AS JSONB)" if postgres else ":o"

    def as_id(name: str) -> str:
        return f"CAST(:{name} AS UUID)" if postgres else f":{name}"

    # Every company with a kiosk today: by its machine's shop (the authority), else the kiosk's own copy.
    companies = bind.execute(sa.text(
        """
        SELECT DISTINCT COALESCE(s.company_id, d.company_id) AS company_id
        FROM kiosk_devices d
        LEFT JOIN pos_machines m ON m.id = d.machine_id
        LEFT JOIN shops s ON s.id = m.shop_id
        """
    )).fetchall()
    for (company,) in companies:
        if company is None:
            continue
        company_id = str(company)
        row = bind.execute(
            sa.text(f"SELECT id, overrides FROM kiosk_settings WHERE level = 'company' AND company_id = {as_id('c')}"),
            {"c": company_id},
        ).first()
        if row is not None:
            overrides = _as_dict(row[1])
            motion = overrides.get("motion") if isinstance(overrides.get("motion"), dict) else {}
            if motion.get("preset"):
                continue  # already chosen: never overwritten
            overrides["motion"] = {**motion, "preset": LEGACY}
            bind.execute(
                sa.text(f"UPDATE kiosk_settings SET overrides = {as_json} WHERE id = {as_id('id')}"),
                {"o": json.dumps(overrides, ensure_ascii=False), "id": str(row[0])},
            )
            continue
        tenant = bind.execute(sa.text(f"SELECT tenant_id FROM companies WHERE id = {as_id('c')}"), {"c": company_id}).scalar()
        # (SQLite — the tests — keeps a UUID as its 32 hex digits, as SQLAlchemy writes it.)
        new_id = str(uuid.uuid4()) if postgres else uuid.uuid4().hex
        params = {"id": new_id, "c": company_id, "o": json.dumps({"motion": {"preset": LEGACY}})}
        if tenant is not None:
            params["t"] = str(tenant)
        bind.execute(
            sa.text(
                "INSERT INTO kiosk_settings (id, tenant_id, level, company_id, shop_id, machine_id, overrides, updated_at) "
                f"VALUES ({as_id('id')}, {as_id('t') if tenant is not None else 'NULL'}, 'company', {as_id('c')}, "
                f"NULL, NULL, {as_json}, CURRENT_TIMESTAMP)"
            ),
            params,
        )


def downgrade() -> None:
    # Data only: the stamp is a valid setting the dashboard can change; nothing to undo.
    pass
