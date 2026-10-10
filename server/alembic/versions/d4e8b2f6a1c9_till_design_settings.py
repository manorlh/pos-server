"""till design: "עיצוב קופה" — the till design layers (app/models/till_design.py)

Revision ID: d4e8b2f6a1c9
Revises: e7d1b4a9c3f6
Create Date: 2026-10-07

One new table, `till_design_settings`: the till design config (docs/SPEC_TILL_DESIGN.md) as
partial override layers company → shop → area (point of sale) → machine, one row per entity
that set anything.

Additive only: nothing existing changes, and a till with no row anywhere keeps today's
screens. Idempotent: the auto-reloading API runs `create_all` at startup, so the table may
exist before this runs — then only its missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d4e8b2f6a1c9"
down_revision: Union[str, Sequence[str], None] = "e7d1b4a9c3f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "till_design_settings"
UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()

#: (name, columns, unique, partial WHERE or None)
INDEXES = (
    ("ix_till_design_settings_tenant_id", ["tenant_id"], False, None),
    ("uq_till_design_settings_company", ["company_id"], True, "level = 'company'"),
    ("uq_till_design_settings_shop", ["shop_id"], True, "level = 'shop'"),
    ("uq_till_design_settings_area", ["area_id"], True, "level = 'area'"),
    ("uq_till_design_settings_machine", ["machine_id"], True, "level = 'machine'"),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
            sa.Column("area_id", UUID, sa.ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True),
            sa.Column("overrides", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_by_user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.UniqueConstraint(
                "level", "company_id", "shop_id", "area_id", "machine_id", name="uq_till_design_settings_scope"
            ),
            sa.CheckConstraint(
                "level IN ('company', 'shop', 'area', 'machine')", name="ck_till_design_settings_level"
            ),
        )
        inspector = sa.inspect(bind)
    existing = {i["name"] for i in inspector.get_indexes(TABLE)}
    for name, columns, unique, where in INDEXES:
        if name in existing:
            continue
        if where is not None:
            op.create_index(name, TABLE, columns, unique=unique, postgresql_where=sa.text(where))
        else:
            op.create_index(name, TABLE, columns, unique=unique)


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(TABLE):
        op.drop_table(TABLE)
