"""kitchen printer host on its own USB port

A `cloud` printer's host till may reach it on its own USB port (`host_connection` 'usb'):
"המדפסת המקומית של קופה" — a kiosk's bon printed on the USB printer attached to a till
(docs/SPEC_KIOSK.md §16.9). Idempotent: the check is dropped if present and made again.

Revision ID: 3b8e6d2f9a14
Revises: 7d3b5e9a2c41
Create Date: 2026-10-07
"""
from typing import Sequence, Union

from alembic import op

revision: str = '3b8e6d2f9a14'
down_revision: Union[str, Sequence[str], None] = '7d3b5e9a2c41'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS ck_kitchen_printers_host_connection")
    op.create_check_constraint(
        'ck_kitchen_printers_host_connection',
        'kitchen_printers',
        "host_connection IS NULL OR host_connection IN ('till', 'network', 'bluetooth', 'usb')",
    )


def downgrade() -> None:
    # A USB host connection reads as the host's own printer on an older schema.
    op.execute("UPDATE kitchen_printers SET host_connection = 'till' WHERE host_connection = 'usb'")
    op.execute("ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS ck_kitchen_printers_host_connection")
    op.create_check_constraint(
        'ck_kitchen_printers_host_connection',
        'kitchen_printers',
        "host_connection IS NULL OR host_connection IN ('till', 'network', 'bluetooth')",
    )
