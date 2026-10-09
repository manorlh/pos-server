"""device role and model when a device is added (docs/SPEC_DEVICE_ROLE_MODEL.md)

* `pos_machines.device_model_chosen` — the model the dashboard chose (the pairing code,
  or the machine page), beside `device_model`, so the machine page can warn when the
  hardware named another model at pairing.
* `pairing_codes.device_role` — "till" | "kiosk", null = till; a kiosk code makes the
  device a kiosk as it pairs.
* `pairing_codes.kiosk_options` — that kiosk's name, controlling tills and device lock.

The new model values (LANDI, FEITIAN_TABLET, GENERIC_ANDROID) fit the existing
`device_model` String(16); nothing to change there. Additive and guarded: the API's
`create_all` may have added the columns first.

Revision ID: c4e8a2d6f0b3
Revises: f3a9c2d7e1b4
Create Date: 2026-10-06 12:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "c4e8a2d6f0b3"
down_revision = "f3a9c2d7e1b4"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("pos_machines", "device_model_chosen", lambda: sa.String(16)),
    ("pairing_codes", "device_role", lambda: sa.String(16)),
    ("pairing_codes", "kiosk_options", lambda: sa.JSON()),
)


def _existing_columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table, column, kind in _COLUMNS:
        if column not in _existing_columns(table):
            op.add_column(table, sa.Column(column, kind(), nullable=True))


def downgrade() -> None:
    for table, column, _kind in reversed(_COLUMNS):
        if column in _existing_columns(table):
            op.drop_column(table, column)
