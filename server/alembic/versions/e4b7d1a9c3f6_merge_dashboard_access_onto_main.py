"""merge the dashboard-access line (7c3e9a1d5b20) with main's newer head (a1f0b62029f1)

No schema of its own: main went on from 1dbac9d07adb to its own merge a1f0b62029f1 (with
9d4b2e7a1c63) while this branch joined 1dbac9d07adb with d4a8c2e6f0b1 ("הרשאות דשבורד") in
7c3e9a1d5b20. Joining the two keeps one head; nobody's migration is rewritten.

Revision ID: e4b7d1a9c3f6
Revises: 7c3e9a1d5b20, a1f0b62029f1
Create Date: 2026-10-08 15:00:00.000000
"""
from typing import Sequence, Union


revision: str = "e4b7d1a9c3f6"
down_revision: Union[str, Sequence[str], None] = ("7c3e9a1d5b20", "a1f0b62029f1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
