"""pairing codes: the work configuration chosen when the device is added

"תצורת עבודה למכשיר" (docs/SPEC_DEVICE_WORK_CONFIG.md): the add-device dialog's step stores the
plan on the pairing code, applied to the machine right after it pairs.

* `pairing_codes.work_config` — the plan (`{preset, tablesMode, …}`), null for "לפי הסניף";
* `pairing_codes.work_config_result` — how applying it went (`{applied, changes, detail,
  message, at}`), shown on the device page.

Additive and idempotent (the auto-reloading API may have added the columns with `create_all`
on a fresh table; a dev database may have them from an earlier run). Nothing existing changes.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = 'e5b9d3f7a1c4'
down_revision: Union[str, Sequence[str], None] = 'c7e2f4a9d1b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'pairing_codes'


def _columns(bind) -> set:
    return {c['name'] for c in sa.inspect(bind).get_columns(TABLE)}


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    have = _columns(op.get_bind())
    if 'work_config' not in have:
        op.add_column(TABLE, sa.Column('work_config', sa.JSON(), nullable=True))
    if 'work_config_result' not in have:
        op.add_column(TABLE, sa.Column('work_config_result', sa.JSON(), nullable=True))


def downgrade() -> None:
    have = _columns(op.get_bind())
    if 'work_config_result' in have:
        op.drop_column(TABLE, 'work_config_result')
    if 'work_config' in have:
        op.drop_column(TABLE, 'work_config')
