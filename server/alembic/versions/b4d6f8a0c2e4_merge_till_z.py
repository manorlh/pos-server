"""merge: Z on the till (main) with the R2M branch

Joins the two heads: a2b3c4d5e6f7 (Z on the till, `zMode`) and a7c9e1f3b5d6 (receipt
printers). Nothing of its own.

Revision ID: b4d6f8a0c2e4
Revises: a7c9e1f3b5d6, a2b3c4d5e6f7
Create Date: 2026-10-05
"""
from typing import Sequence, Union

revision: str = 'b4d6f8a0c2e4'
down_revision: Union[str, Sequence[str], None] = ('a7c9e1f3b5d6', 'a2b3c4d5e6f7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
