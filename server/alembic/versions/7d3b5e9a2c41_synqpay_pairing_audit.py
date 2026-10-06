"""payment secrets: where a key came from — the SynqPay pairing at the till, and its rejection

"צימוד מסוף SynqPay" (docs/SPEC_SYNQPAY.md §2.2): the till pairs with its terminal itself and
sends the API key to the cloud, which keeps it encrypted on the machine's layer as before
(`payment_integration_secrets`). Beside the ciphertext, the row now says:

* `origin` — `till_pairing` (the till paired) or `dashboard` (typed by hand); null for rows
  written before this column.
* `paired_at`, `paired_by_machine_id`, `paired_by_pos_user_id`, `paired_by_user_id`,
  `terminal_serial` — when, by which till, on whose authority (a till manager or a cloud
  account's grant), and the terminal's serial number it was paired with.
* `rejected_at`, `rejected_by_machine_id` — the terminal refused this key (HTTP 401 /
  NOT_AUTHENTICATED) as a till reported it; cleared by a new key.

Idempotent: a dev database may already have a column from a previous run.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = '7d3b5e9a2c41'
down_revision: Union[str, Sequence[str], None] = '5c9e2a7d1f43'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TABLE = 'payment_integration_secrets'

COLUMNS = (
    ('origin', lambda: sa.String(16)),
    ('paired_at', lambda: sa.DateTime(timezone=True)),
    ('paired_by_machine_id', lambda: UUID),
    ('paired_by_pos_user_id', lambda: UUID),
    ('paired_by_user_id', lambda: UUID),
    ('terminal_serial', lambda: sa.String(32)),
    ('rejected_at', lambda: sa.DateTime(timezone=True)),
    ('rejected_by_machine_id', lambda: UUID),
)


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    inspector = sa.inspect(op.get_bind())
    have = {c['name'] for c in inspector.get_columns(TABLE)}
    for name, kind in COLUMNS:
        if name not in have:
            op.add_column(TABLE, sa.Column(name, kind(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    have = {c['name'] for c in inspector.get_columns(TABLE)}
    for name, _ in reversed(COLUMNS):
        if name in have:
            op.drop_column(TABLE, name)
