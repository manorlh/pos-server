"""Payment devices: the till's mode / group replace the device's tills; Z-Credit pinpad = PinPad only

Revision ID: 3b8f6d2a9c41
Revises: b3e7c1a9d5f2
Create Date: 2026-10-08

Chained after main's b3e7c1a9d5f2 (the kiosk motion engine, already run), which came from the
same parent 7d2e4b9f1a63 (the payment devices table): one line, 7d2e4b9f1a63 → b3e7c1a9d5f2 →
3b8f6d2a9c41 → 5e1c9b7d3a80 → 8c4a2f6e1b93.

The owner's decisions on "מכשירי תשלום" (app/services/payment_devices.py):

* Which devices a till uses is now a setting of the shop / area / till layers —
  `paymentDeviceMode` ("fixed" | "group"), `fixedPaymentDeviceId`, `paymentDeviceGroup` — and
  no longer the device's own list of tills (`payment_devices.machine_ids`). A shop where some
  device was narrowed to some tills keeps what each till had: every non-kiosk till of that shop
  whose own layer has no device choice yet gets `paymentDeviceMode` = "group" and
  `paymentDeviceGroup` = the devices that applied to it (by sort order, then nickname), its
  settings stamp moved; a till no device applied to gets `multiPaymentDevices` = false (it had
  none). Then the column is dropped — the code no longer reads it.
* The default device is gone: `defaultPaymentDeviceId` is removed from every layer's settings.
* A Z-Credit pinpad is its PinPad only — the terminal number, mode and password are the
  branch's: `terminalNumber` / `mode` leave the pinpads' config, and their `zcreditPassword`
  secrets (level "payment_device") are deleted.

Idempotent: every step looks before it writes; a database without the table only loses the
legacy settings key.
"""
import json
from collections import defaultdict
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '3b8f6d2a9c41'
down_revision: Union[str, Sequence[str], None] = 'b3e7c1a9d5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'payment_devices'
LEGACY_DEFAULT_KEY = 'defaultPaymentDeviceId'
LAYER_TABLES = ('tenants', 'companies', 'shops', 'shop_areas', 'pos_machines')


def _ids(value) -> list:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return [str(x).lower() for x in value] if isinstance(value, list) else []


def _settings(value) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return dict(value) if isinstance(value, dict) else {}


def _strip_legacy_default(bind, inspector) -> None:
    for table in LAYER_TABLES:
        if not inspector.has_table(table):
            continue
        bind.execute(sa.text(
            f"UPDATE {table} SET settings = settings - '{LEGACY_DEFAULT_KEY}' "
            f"WHERE settings IS NOT NULL AND (settings - '{LEGACY_DEFAULT_KEY}') <> settings"
        ))


def _tills_from_machine_ids(bind, inspector) -> None:
    """Each device's tills → the tills' own `paymentDeviceMode` / `paymentDeviceGroup`."""
    devices = bind.execute(sa.text(
        f"SELECT id, shop_id, machine_ids, sort_order, nickname FROM {TABLE}"
    )).fetchall()
    by_shop = defaultdict(list)
    for d in devices:
        by_shop[str(d.shop_id)].append(d)
    kiosks = set()
    if inspector.has_table('kiosk_devices'):
        kiosks = {str(r[0]).lower() for r in bind.execute(sa.text('SELECT machine_id FROM kiosk_devices'))}
    for shop_id, devs in by_shop.items():
        if not any(_ids(d.machine_ids) for d in devs):
            continue
        devs = sorted(devs, key=lambda d: (int(d.sort_order or 0), (d.nickname or '').casefold(), str(d.id)))
        tills = bind.execute(
            sa.text('SELECT id, settings FROM pos_machines WHERE shop_id = CAST(:s AS uuid)'), {'s': shop_id}
        ).fetchall()
        for till in tills:
            till_id = str(till.id).lower()
            if till_id in kiosks:
                continue
            settings = _settings(till.settings)
            if 'paymentDeviceGroup' in settings or 'paymentDeviceMode' in settings:
                continue
            applying = [str(d.id) for d in devs if not _ids(d.machine_ids) or till_id in _ids(d.machine_ids)]
            if applying:
                settings['paymentDeviceMode'] = 'group'
                settings['paymentDeviceGroup'] = applying
            elif settings.get('multiPaymentDevices') is not False:
                settings['multiPaymentDevices'] = False
            else:
                continue
            bind.execute(
                sa.text(
                    'UPDATE pos_machines SET settings = CAST(:v AS jsonb), settings_updated_at = now() '
                    'WHERE id = CAST(:i AS uuid)'
                ),
                {'v': json.dumps(settings, ensure_ascii=False), 'i': str(till.id)},
            )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    _strip_legacy_default(bind, inspector)
    if not inspector.has_table(TABLE):
        return
    bind.execute(sa.text(
        f"UPDATE {TABLE} SET config = config - 'terminalNumber' - 'mode' "
        f"WHERE kind = 'zcredit_pinpad' AND (config - 'terminalNumber' - 'mode') <> config"
    ))
    if inspector.has_table('payment_integration_secrets'):
        bind.execute(sa.text(
            "DELETE FROM payment_integration_secrets WHERE level = 'payment_device' AND key = 'zcreditPassword'"
        ))
    columns = {c['name'] for c in inspector.get_columns(TABLE)}
    if 'machine_ids' in columns:
        _tills_from_machine_ids(bind, inspector)
        op.drop_column(TABLE, 'machine_ids')


def downgrade() -> None:
    # The column comes back empty (every till of the shop); the tills' settings stay as they are.
    bind = op.get_bind()
    columns = {c['name'] for c in sa.inspect(bind).get_columns(TABLE)}
    if 'machine_ids' not in columns:
        op.add_column(
            TABLE,
            sa.Column('machine_ids', postgresql.JSONB(), nullable=False, server_default='[]'),
        )
