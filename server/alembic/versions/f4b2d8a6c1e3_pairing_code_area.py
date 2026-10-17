"""pairing_codes.area_id — "נקודת מכירה" chosen when a device is added

P:/specs/area-gaps.md §1: the add-device dialog may name a point of sale of the chosen shop; the code keeps it
and the device that redeems it lands in that area (`areas.set_machine_area`). One nullable column, add-only,
idempotent (a live API's `create_all` may have made it already). Null — no area, exactly as before.

Revision ID: f4b2d8a6c1e3
Revises: b87054615214
Create Date: 2026-10-17 10:00:00

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "f4b2d8a6c1e3"
down_revision: Union[str, Sequence[str], None] = "b87054615214"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_column(table: str, column: str) -> bool:
    if _offline():
        return False
    inspector = sa.inspect(op.get_bind())
    return inspector.has_table(table) and column in {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    if not _has_column("pairing_codes", "area_id"):
        op.add_column(
            "pairing_codes",
            sa.Column(
                "area_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("shop_areas.id", name="fk_pairing_codes_area_id_shop_areas", ondelete="SET NULL"),
                nullable=True,
            ),
        )


def downgrade() -> None:
    if _offline() or _has_column("pairing_codes", "area_id"):
        op.drop_constraint("fk_pairing_codes_area_id_shop_areas", "pairing_codes", type_="foreignkey")
        op.drop_column("pairing_codes", "area_id")
