"""merge windows7 release platform + unpair / cloud pairing

Two heads built on a1d5e8c3b7f2, merged into main one after the other (#134, #135):

- d9e4b1f7a3c6 — unpair and re-pair from the cloud (foreign records guard)
- b7e3a9d1c5f2 — "windows7" in the app releases' platform CHECK (P:/specs/windows7-till.md)

Different tables; nothing of its own.

Revision ID: e8c1f4a7b2d9
Revises: d9e4b1f7a3c6, b7e3a9d1c5f2
Create Date: 2026-10-17 15:10:00

"""
from typing import Sequence, Union


revision: str = "e8c1f4a7b2d9"
down_revision: Union[str, Sequence[str], None] = ("d9e4b1f7a3c6", "b7e3a9d1c5f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
