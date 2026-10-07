"""The shop's local network: "לא משמש כשרת מקומי" and the switch "רשת מקומית"

docs/SPEC_LAN_MODE.md §3–4.

* `pos_machines.lan_server_excluded` (bool, default false) — the device is never the shop's
  local server (main till, tables host, print server, shop Z master), yet stays in its LAN
  group and its shop Z; `pos_machines.lan_server_excluded_at` — when the dashboard set it
  (null: never chosen, the dashboard pre-ticks kiosks and handhelds).
* `pos_machines.lan_sync` (JSONB) / `lan_sync_reported_at` — a local server's sync lag from its
  heartbeat (§6): the changes the cloud copy does not have yet and the oldest one's moment.
* `shops.local_network` (bool, default false) — "רשת מקומית": with a main till, the shop is in
  local mode (the main till produces the shop Z on the LAN); `shops.local_network_changed_at`
  — when a person last switched it.

Data: local mode used to follow the configuration — a main till, and `tablesMode` «רשת מקומית
(קופה ראשית)» for the shop or the main till being the shop's print server. Every shop in local
mode by that rule gets the switch on (`shops_in_local_mode`, the rule as it was), so no shop's
Z production moves with this migration. A shop someone already switched (`local_network_changed_at`
set) is left as it is.

Idempotent; never downgraded in place (shared dev DB).

Revision ID: c3e9f1a7b5d2
Revises: e7d1b4a9c3f6
Create Date: 2026-10-07
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c3e9f1a7b5d2"
down_revision: Union[str, Sequence[str], None] = "e7d1b4a9c3f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MISSING = object()
#: `tables.mode_of` → "lan": the Hebrew option and its code.
_LAN_VALUES = ("רשת מקומית (קופה ראשית)", "lan")

_params = sa.table(
    "till_parameters",
    sa.column("id", sa.Uuid()),
    sa.column("key", sa.String()),
    sa.column("value_type", sa.String()),
    sa.column("enum_options", sa.JSON()),
    sa.column("default_value", sa.JSON()),
    sa.column("is_active", sa.Boolean()),
)
_values = sa.table(
    "till_parameter_values",
    sa.column("parameter_id", sa.Uuid()),
    sa.column("scope_type", sa.String()),
    sa.column("scope_id", sa.Uuid()),
    sa.column("value", sa.JSON()),
)
_machines = sa.table(
    "pos_machines",
    sa.column("id", sa.Uuid()),
    sa.column("shop_id", sa.Uuid()),
    sa.column("area_id", sa.Uuid()),
    sa.column("pos_number", sa.String()),
    sa.column("name", sa.String()),
    sa.column("is_active", sa.Boolean()),
    sa.column("independent_till", sa.Boolean()),
    sa.column("is_fiscal", sa.Boolean()),
)
_shops = sa.table(
    "shops",
    sa.column("id", sa.Uuid()),
    sa.column("company_id", sa.Uuid()),
)


def _id(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value if isinstance(value, uuid.UUID) else uuid.UUID(str(value)))


def _valid(value_type: str, enum_options: Any, value: Any) -> bool:
    """`till_parameters.validate_value` for the types these keys use."""
    if value is None:
        return False
    if value_type == "boolean":
        return isinstance(value, bool)
    if value_type == "enum":
        return isinstance(value, str) and value in (enum_options or ())
    if value_type == "string":
        return isinstance(value, str)
    if value_type in ("integer", "decimal"):
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return False


def _till_order(m: dict):
    number = (m["pos_number"] or "").strip()
    return (0, int(number), "") if number.isdigit() else (1, 0, number or m["id"])


def shops_in_local_mode(bind) -> Set[str]:
    """
    The shops in local mode by the rule before the switch (`local_shop_z.local_mode_of_shop`
    as it was): a main till — the shop's active till of its LAN group (not independent, not a
    display device) whose `mainTill` resolves on, the lowest register number of several — and
    the shop's `tablesMode` (shop, else company, else default) «רשת מקומית (קופה ראשית)», or
    the shop's print server (`printHostTill`, else the main till) being the main till.
    """
    params = {
        row.key: row
        for row in bind.execute(
            sa.select(_params).where(_params.c.key.in_(("mainTill", "printHostTill", "tablesMode")))
        )
    }
    main_param = params.get("mainTill")
    if main_param is None or not main_param.is_active:
        return set()
    wanted = [p.id for p in params.values()]
    values: Dict[Tuple[str, str, str], Any] = {}
    for row in bind.execute(sa.select(_values).where(_values.c.parameter_id.in_(wanted))):
        values[(_id(row.parameter_id), row.scope_type, _id(row.scope_id))] = row.value

    def resolve(key: str, chain: Iterable[Tuple[str, Optional[str]]]) -> Any:
        p = params.get(key)
        if p is None or not p.is_active:
            return _MISSING
        for scope_type, scope_id in chain:
            if scope_id is None:
                continue
            v = values.get((_id(p.id), scope_type, scope_id), _MISSING)
            if v is not _MISSING and _valid(p.value_type, p.enum_options, v):
                return v
        if _valid(p.value_type, p.enum_options, p.default_value):
            return p.default_value
        return _MISSING

    companies = {_id(r.id): _id(r.company_id) for r in bind.execute(sa.select(_shops))}
    by_shop: Dict[str, List[dict]] = {}
    for r in bind.execute(sa.select(_machines).where(_machines.c.shop_id.isnot(None))):
        if not r.is_active or r.independent_till or r.is_fiscal is False:
            continue
        by_shop.setdefault(_id(r.shop_id), []).append({
            "id": _id(r.id), "area_id": _id(r.area_id), "pos_number": r.pos_number,
        })
    out: Set[str] = set()
    for shop_id, members in by_shop.items():
        company_id = companies.get(shop_id)

        def chain(m: dict):
            return (("machine", m["id"]), ("area", m["area_id"]), ("shop", shop_id), ("company", company_id))

        marked = [m for m in members if resolve("mainTill", chain(m)) is True]
        if not marked:
            continue
        main = sorted(marked, key=_till_order)[0]
        tables = resolve("tablesMode", (("shop", shop_id), ("company", company_id)))
        if isinstance(tables, str) and tables.strip() in _LAN_VALUES:
            out.add(shop_id)
            continue
        hosts = [m for m in members if resolve("printHostTill", chain(m)) is True]
        host = sorted(hosts, key=_till_order)[0] if hosts else main
        if host["id"] == main["id"]:
            out.add(shop_id)
    return out


def upgrade() -> None:
    insp = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    machine_cols = set() if insp is None else {c["name"] for c in insp.get_columns("pos_machines")}
    if "lan_server_excluded" not in machine_cols:
        op.add_column(
            "pos_machines",
            sa.Column("lan_server_excluded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "lan_server_excluded_at" not in machine_cols:
        op.add_column("pos_machines", sa.Column("lan_server_excluded_at", sa.DateTime(timezone=True), nullable=True))
    if "lan_sync" not in machine_cols:
        op.add_column("pos_machines", sa.Column("lan_sync", postgresql.JSONB(), nullable=True))
    if "lan_sync_reported_at" not in machine_cols:
        op.add_column("pos_machines", sa.Column("lan_sync_reported_at", sa.DateTime(timezone=True), nullable=True))
    shop_cols = set() if insp is None else {c["name"] for c in insp.get_columns("shops")}
    if "local_network" not in shop_cols:
        op.add_column(
            "shops",
            sa.Column("local_network", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "local_network_changed_at" not in shop_cols:
        op.add_column("shops", sa.Column("local_network_changed_at", sa.DateTime(timezone=True), nullable=True))
    if context.is_offline_mode():
        return
    bind = op.get_bind()
    local = shops_in_local_mode(bind)
    if local:
        shops = sa.table(
            "shops", sa.column("id", sa.Uuid()), sa.column("local_network", sa.Boolean()),
            sa.column("local_network_changed_at", sa.DateTime(timezone=True)),
        )
        bind.execute(
            sa.update(shops)
            .where(shops.c.id.in_([uuid.UUID(s) for s in sorted(local)]))
            .where(shops.c.local_network_changed_at.is_(None))
            .values(local_network=True)
        )


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_column("shops", "local_network_changed_at")
    op.drop_column("shops", "local_network")
    op.drop_column("pos_machines", "lan_sync_reported_at")
    op.drop_column("pos_machines", "lan_sync")
    op.drop_column("pos_machines", "lan_server_excluded_at")
    op.drop_column("pos_machines", "lan_server_excluded")
