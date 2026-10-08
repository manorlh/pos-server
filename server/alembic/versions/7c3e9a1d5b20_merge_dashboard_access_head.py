"""merge the dashboard-access head ("הרשאות דשבורד", d4a8c2e6f0b1) with main's (1dbac9d07adb)

No schema of its own: d4a8c2e6f0b1 branched from e9a3c7f1b5d2 while main went on to the cloud
Z-Credit refund merge (1dbac9d07adb). Joining them keeps one head; neither branch's migrations
are rewritten.

Revision ID: 7c3e9a1d5b20
Revises: 1dbac9d07adb, d4a8c2e6f0b1
Create Date: 2026-10-08 12:00:00.000000
"""
from typing import Sequence, Union


revision: str = "7c3e9a1d5b20"
down_revision: Union[str, Sequence[str], None] = ("1dbac9d07adb", "d4a8c2e6f0b1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
