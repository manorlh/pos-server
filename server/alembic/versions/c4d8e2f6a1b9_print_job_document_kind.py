"""print job kind `document`: a bill / receipt printed on another till

"הדפסת חשבון וקבלה על המדפסת המובנית של קופה אחרת" (P:/specs/bill-print-other-till.md §4): the
sending till renders the document to an image and relays it like a kitchen ticket — over the LAN
first, else through `kitchen_print_jobs` as a job of the new kind `document` (app/services/remote_print.py).
The kind's check takes the new word; nothing else changes (a receipt printer of type `cloud` was
always allowed by the printers' own checks — the schema refused it). Idempotent: the check is
dropped if present and made again.

Revision ID: c4d8e2f6a1b9
Revises: bb6205ba290c
Create Date: 2026-10-14
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c4d8e2f6a1b9'
down_revision: Union[str, Sequence[str], None] = 'bb6205ba290c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KINDS = "kind IN ('ticket', 'test', 'document')"
OLD_KINDS = "kind IN ('ticket', 'test')"


def upgrade() -> None:
    op.execute("ALTER TABLE kitchen_print_jobs DROP CONSTRAINT IF EXISTS ck_kitchen_print_jobs_kind")
    op.create_check_constraint('ck_kitchen_print_jobs_kind', 'kitchen_print_jobs', KINDS)


def downgrade() -> None:
    # A relayed document lives minutes and an older schema has no word for it: gone.
    op.execute("DELETE FROM kitchen_print_jobs WHERE kind = 'document'")
    op.execute("ALTER TABLE kitchen_print_jobs DROP CONSTRAINT IF EXISTS ck_kitchen_print_jobs_kind")
    op.create_check_constraint('ck_kitchen_print_jobs_kind', 'kitchen_print_jobs', OLD_KINDS)
