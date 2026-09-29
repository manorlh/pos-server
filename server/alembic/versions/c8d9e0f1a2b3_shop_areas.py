"""shop areas: a shop's tills grouped into bar, kitchen, terrace (docs/AREAS_API.md)

* `shop_areas` — the areas themselves. Archived, never deleted; a live name is unique
  per shop regardless of case (a partial unique index, so an archived "Bar" does not
  block a new one).
* `pos_machines.area_id` — membership, plain and nullable, so a settings layer per area
  can later read the same column. `pos_machines.area_changed_at` stamps a change of it,
  for the till's settings watermark.
* `shifts.area_id` — the till's area when the shift was created in the cloud. Area
  reports filter on this stamp, never on the till's current area.
* `z_runs.area_id`, `z_reports.area_id` — which area a Z was started for. The Z is
  still the shop's, under the shop's one number.

Nothing is backfilled: every till starts unassigned, and every existing shift and Z is
truthfully "no area".

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-09-29 20:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "c8d9e0f1a2b3"
down_revision = "b7c8d9e0f1a2"
branch_labels = None
depends_on = None


#: (table, foreign-key name, index name or None) for each `area_id` column.
_AREA_COLUMNS = (
    ("pos_machines", "fk_pos_machines_area_id_shop_areas", "ix_pos_machines_area_id"),
    ("shifts", "fk_shifts_area_id_shop_areas", "ix_shifts_area_id"),
    ("z_runs", "fk_z_runs_area_id_shop_areas", None),
    ("z_reports", "fk_z_reports_area_id_shop_areas", "ix_z_reports_area_id"),
)


def upgrade() -> None:
    op.create_table(
        "shop_areas",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column(
            "shop_id",
            UUID(as_uuid=True),
            sa.ForeignKey("shops.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_shop_areas_tenant_id", "shop_areas", ["tenant_id"])
    op.create_index("ix_shop_areas_shop_id", "shop_areas", ["shop_id"])
    op.create_index(
        "uq_shop_areas_shop_live_name",
        "shop_areas",
        ["shop_id", sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    for table, fk_name, index_name in _AREA_COLUMNS:
        op.add_column(table, sa.Column("area_id", UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(fk_name, table, "shop_areas", ["area_id"], ["id"])
        if index_name:
            op.create_index(index_name, table, ["area_id"])

    op.add_column(
        "pos_machines", sa.Column("area_changed_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    # Loses which area every till is in and which area each shift and Z was taken
    # under. No figure changes: an area never was a fiscal scope.
    op.drop_column("pos_machines", "area_changed_at")
    for table, fk_name, index_name in reversed(_AREA_COLUMNS):
        if index_name:
            op.drop_index(index_name, table_name=table)
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.drop_column(table, "area_id")
    op.drop_index("uq_shop_areas_shop_live_name", table_name="shop_areas")
    op.drop_index("ix_shop_areas_shop_id", table_name="shop_areas")
    op.drop_index("ix_shop_areas_tenant_id", table_name="shop_areas")
    op.drop_table("shop_areas")
