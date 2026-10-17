"""device license product: "סוג רישיון" — till / kiosk / kiosk_till per machine

"סוג רישיון למכשיר" (P:/specs/device-license-type.md): every till / kiosk is licensed as "קופה בלבד" (`till`),
"קיוסק בלבד" (`kiosk`) or "קיוסק + קופה (משולב)" (`kiosk_till`); the non-fiscal devices have none.

* `pos_machines.license_product` VARCHAR(16) NULL, `pos_machines.license_product_history` JSONB NULL.
* `pairing_codes.license_product` VARCHAR(16) NULL — the product a code gives the device it pairs.

Then every fiscal machine without one gets the product today's state amounts to (§6), so nothing changes
on deploy: a kiosk by role (`kiosk_devices.home_role` NULL) — `kiosk`, or `kiosk_till` when the gate
`kioskTillModeEnabled` is open for it or it is disabled (a disabled kiosk works as a till); a till — `till`,
or `kiosk_till` when the gate is open. "The gate is open" is the parameter as the till resolves it: the
machine's own value, else its area's, its shop's, its shop's company's, else the parameter's default (a
value that is not a boolean is passed over; an inactive parameter is off) — one SQL statement, so the
offline render is the real thing. Non-fiscal machines stay NULL.

Add-only and idempotent (each column looked at first: the API's create_all may have made it).

Revision ID: c5e1a8d3f7b9
Revises: 6b3b29c7bc5b
Create Date: 2026-10-16 18:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c5e1a8d3f7b9"
down_revision: Union[str, Sequence[str], None] = "6b3b29c7bc5b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GATE_KEY = "kioskTillModeEnabled"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _columns(table: str) -> set:
    """The table's columns — offline: none of ours yet."""
    if _offline():
        return set()
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return {"__missing__"}
    return {c["name"] for c in inspector.get_columns(table)}


def _level(scope: str, scope_id: str) -> str:
    return (
        "(SELECT CASE CAST(v.value AS TEXT) WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE END "
        "FROM till_parameter_values v "
        f"WHERE v.parameter_id = p.id AND v.scope_type = '{scope}' AND v.scope_id = {scope_id} LIMIT 1)"
    )


#: `kioskTillModeEnabled` for the machine being updated (`pos_machines`), as `resolve_till_parameters` reads it.
GATE_SQL = (
    "COALESCE((SELECT p.is_active AND COALESCE("
    + _level("machine", "pos_machines.id") + ", "
    + _level("area", "pos_machines.area_id") + ", "
    + _level("shop", "pos_machines.shop_id") + ", "
    + _level("company", "(SELECT s.company_id FROM shops s WHERE s.id = pos_machines.shop_id)") + ", "
    + "CASE CAST(p.default_value AS TEXT) WHEN 'true' THEN TRUE ELSE FALSE END"
    + f") FROM till_parameters p WHERE p.key = '{GATE_KEY}'), FALSE)"
)

KIOSK_BY_ROLE = "SELECT 1 FROM kiosk_devices k WHERE k.machine_id = pos_machines.id AND k.home_role IS NULL"

BACKFILL_SQL = (
    "UPDATE pos_machines SET license_product = CASE "
    f"WHEN EXISTS ({KIOSK_BY_ROLE} AND k.enabled = FALSE) THEN 'kiosk_till' "
    f"WHEN EXISTS ({KIOSK_BY_ROLE}) THEN CASE WHEN {GATE_SQL} THEN 'kiosk_till' ELSE 'kiosk' END "
    f"ELSE CASE WHEN {GATE_SQL} THEN 'kiosk_till' ELSE 'till' END "
    "END "
    "WHERE is_fiscal = TRUE AND license_product IS NULL"
)


def upgrade() -> None:
    machines = _columns("pos_machines")
    if "__missing__" not in machines:
        if "license_product" not in machines:
            op.add_column("pos_machines", sa.Column("license_product", sa.String(16), nullable=True))
        if "license_product_history" not in machines:
            op.add_column("pos_machines", sa.Column("license_product_history", postgresql.JSONB(), nullable=True))
    codes = _columns("pairing_codes")
    if "__missing__" not in codes and "license_product" not in codes:
        op.add_column("pairing_codes", sa.Column("license_product", sa.String(16), nullable=True))
    if "__missing__" not in machines:
        op.execute(sa.text(BACKFILL_SQL))


def downgrade() -> None:
    # Never run in production (additive only); kept so the chain stays walkable.
    if _offline():
        op.drop_column("pairing_codes", "license_product")
        op.drop_column("pos_machines", "license_product_history")
        op.drop_column("pos_machines", "license_product")
        return
    codes = _columns("pairing_codes")
    if "license_product" in codes:
        op.drop_column("pairing_codes", "license_product")
    machines = _columns("pos_machines")
    for column in ("license_product_history", "license_product"):
        if column in machines:
            op.drop_column("pos_machines", column)
