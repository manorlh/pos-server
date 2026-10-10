"""display orderings: one ordering model for the four channels (linked / independent / copied once)

specs/digital-menu-ordering-cards-plan.md §5, app/services/display_ordering.py.

* `display_orderings` — an ordering (categories, each category's products, pinned, where new items
  go, an optimistic version, and the tills' flat list it was read from: `legacy_flat`);
* `display_ordering_bindings` — which ordering a channel uses at a level.

**The data step writes nothing a till or a kiosk reads.** For every level that holds today's keys —
the tills' `productOrder` / `categoryOrder` in the settings of a tenant, company, shop, point of sale
or till, the kiosks' `catalog.categoryOrder` / `catalog.productOrder` in a kiosk layer — it records an
independent ordering read from those keys and binds that level's channel to it. Nothing is linked.
The tills' flat list becomes a list per category (the order inside each kept) and is kept as it was
in `legacy_flat`, so writing back later keeps its interleaving. Self-contained (frozen here, no app
import); skipped in offline mode. Add-only and idempotent: tables looked at first, a level already
bound is left as it is.

Revision ID: 701a25694d3c
Revises: 7c3a9d2e5b14
Create Date: 2026-10-10
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "701a25694d3c"
down_revision: Union[str, Sequence[str], None] = "7c3a9d2e5b14"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORDERINGS = "display_orderings"
BINDINGS = "display_ordering_bindings"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid_t = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(ORDERINGS):
        op.create_table(
            ORDERINGS,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", uuid_t, sa.ForeignKey("companies.id", ondelete="SET NULL"), nullable=True),
            sa.Column("name", sa.String(120), nullable=True),
            sa.Column("categories", sa.JSON(), nullable=False),
            sa.Column("products", sa.JSON(), nullable=False),
            sa.Column("pinned", sa.JSON(), nullable=False),
            sa.Column("new_items", sa.String(16), nullable=False, server_default="end"),
            sa.Column("legacy_flat", sa.JSON(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("updated_by_user_id", uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("updated_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    o_indexes = set() if insp is None or not insp.has_table(ORDERINGS) else {i["name"] for i in insp.get_indexes(ORDERINGS)}
    if "ix_display_orderings_tenant" not in o_indexes:
        op.create_index("ix_display_orderings_tenant", ORDERINGS, ["tenant_id"])

    if insp is None or not insp.has_table(BINDINGS):
        op.create_table(
            BINDINGS,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("target_id", uuid_t, nullable=False),
            sa.Column("channel", sa.String(8), nullable=False),
            sa.Column("ordering_id", uuid_t, sa.ForeignKey("display_orderings.id", ondelete="CASCADE"), nullable=False),
            sa.Column("copied_from_ordering_id", uuid_t, nullable=True),
            sa.Column("copied_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("legacy_hash", sa.String(64), nullable=True),
            sa.Column("updated_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint(
                "level IN ('tenant', 'company', 'shop', 'area', 'machine', 'profile')",
                name="ck_display_ordering_bindings_level",
            ),
            sa.CheckConstraint(
                "channel IN ('pos', 'kiosk', 'online', 'menu')", name="ck_display_ordering_bindings_channel",
            ),
            sa.UniqueConstraint("tenant_id", "level", "target_id", "channel", name="uq_display_ordering_bindings"),
        )
    b_indexes = set() if insp is None or not insp.has_table(BINDINGS) else {i["name"] for i in insp.get_indexes(BINDINGS)}
    if "ix_display_ordering_bindings_ordering" not in b_indexes:
        op.create_index("ix_display_ordering_bindings_ordering", BINDINGS, ["ordering_id"])

    if not context.is_offline_mode():
        materialize(op.get_bind())


def downgrade() -> None:
    op.drop_index("ix_display_ordering_bindings_ordering", table_name=BINDINGS)
    op.drop_table(BINDINGS)
    op.drop_index("ix_display_orderings_tenant", table_name=ORDERINGS)
    op.drop_table(ORDERINGS)


# ── The data step (frozen: today's keys → independent orderings, nothing written back) ──


def _ids(raw: Any) -> List[str]:
    out: List[str] = []
    seen = set()
    if isinstance(raw, (list, tuple)):
        for v in raw:
            if v is None or isinstance(v, (bool, dict, list)):
                continue
            s = str(v).strip()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
    return out


def _map(raw: Any) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            ids = _ids(v)
            if str(k).strip() and ids:
                out[str(k).strip()] = ids
    return out


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _norm(value: Any) -> str:
    """An id as the settings write it (a uuid's dashed text)."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return str(value)


def _hash(keys: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(keys, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def materialize(bind) -> int:
    """Record an independent ordering for each level holding today's keys. Returns how many were made."""
    insp = sa.inspect(bind)
    if not insp.has_table(BINDINGS) or not insp.has_table(ORDERINGS):
        return 0
    now = datetime.now(timezone.utc)
    meta = sa.MetaData()

    def table(name: str) -> sa.Table:
        return meta.tables[name] if name in meta.tables else sa.Table(name, meta, autoload_with=bind, resolve_fks=False)

    orderings = table(ORDERINGS)

    def new_id():
        # A uuid as the dialect binds it (Postgres: UUID; SQLite in the tests: its hex text).
        value = uuid.uuid4()
        return value.hex if bind.dialect.name == "sqlite" else value
    bindings = table(BINDINGS)
    bound = {
        (str(r.tenant_id), r.level, str(r.target_id), r.channel)
        for r in bind.execute(sa.select(bindings.c.tenant_id, bindings.c.level, bindings.c.target_id, bindings.c.channel))
    }
    made = 0

    def add(tenant_id, level, target_id, channel, content, legacy_flat, keys) -> None:
        nonlocal made
        if tenant_id is None or target_id is None:
            return
        key = (str(tenant_id), level, str(target_id), channel)
        if key in bound:
            return
        oid = new_id()
        bind.execute(orderings.insert().values(
            id=oid, tenant_id=tenant_id, company_id=None, name=None,
            categories=content["categories"], products=content["products"],
            pinned={"categories": [], "products": {}}, new_items="end",
            legacy_flat=legacy_flat, version=1, updated_by_name="migration", created_at=now, updated_at=now,
        ))
        bind.execute(bindings.insert().values(
            id=new_id(), tenant_id=tenant_id, level=level, target_id=target_id, channel=channel,
            ordering_id=oid, legacy_hash=_hash(keys), updated_by_name="migration", created_at=now, updated_at=now,
        ))
        bound.add(key)
        made += 1

    # The tills: productOrder / categoryOrder in each settings layer.
    layers = [
        ("tenant", "tenants", "id"),
        ("company", "companies", "tenant_id"),
        ("shop", "shops", "tenant_id"),
        ("area", "shop_areas", "tenant_id"),
        ("machine", "pos_machines", "tenant_id"),
    ]
    pending = []
    for level, table_name, tenant_col in layers:
        if not insp.has_table(table_name) or "settings" not in {c["name"] for c in insp.get_columns(table_name)}:
            continue
        t = table(table_name)
        for row in bind.execute(sa.select(t.c.id, t.c[tenant_col], t.c.settings)):
            settings = _json(row.settings)
            if not isinstance(settings, dict):
                continue
            keys = {k: settings[k] for k in ("productOrder", "categoryOrder") if settings.get(k) is not None}
            if keys:
                pending.append((level, row[1], row.id, keys))
    wanted = {pid for _l, _t, _i, keys in pending for pid in _ids(keys.get("productOrder"))}
    category_of: Dict[str, str] = {}
    if wanted:
        products = table("products")
        ids = []
        for w in wanted:
            try:
                u = uuid.UUID(w)
            except ValueError:
                continue
            ids.append(u.hex if bind.dialect.name == "sqlite" else u)
        for start in range(0, len(ids), 500):
            for pid, cid in bind.execute(
                sa.select(products.c.id, products.c.category_id).where(products.c.id.in_(ids[start:start + 500]))
            ):
                if cid is not None:
                    category_of[_norm(pid)] = _norm(cid)
    for level, tenant_id, target_id, keys in pending:
        flat = _ids(keys.get("productOrder"))
        per_category: Dict[str, List[str]] = {}
        for pid in flat:
            cid = category_of.get(pid)
            if cid:
                per_category.setdefault(cid, []).append(pid)
        content = {"categories": _ids(keys.get("categoryOrder")), "products": per_category}
        add(tenant_id, level, target_id, "pos", content, flat or None, keys)

    # The kiosks: catalog.categoryOrder / catalog.productOrder in each kiosk layer.
    if insp.has_table("kiosk_settings"):
        ks = table("kiosk_settings")
        for row in bind.execute(sa.select(
            ks.c.tenant_id, ks.c.level, ks.c.company_id, ks.c.shop_id, ks.c.machine_id, ks.c.overrides,
        )):
            overrides = _json(row.overrides)
            catalog = overrides.get("catalog") if isinstance(overrides, dict) else None
            if not isinstance(catalog, dict):
                continue
            keys = {k: catalog[k] for k in ("categoryOrder", "productOrder") if catalog.get(k) is not None}
            if not keys:
                continue
            target_id = {"company": row.company_id, "shop": row.shop_id, "machine": row.machine_id}.get(row.level)
            tenant_id = row.tenant_id
            if tenant_id is None and target_id is not None:
                owner = {"company": "companies", "shop": "shops", "machine": "pos_machines"}.get(row.level)
                if owner and insp.has_table(owner):
                    t = table(owner)
                    tenant_id = bind.execute(sa.select(t.c.tenant_id).where(t.c.id == target_id)).scalar()
            content = {"categories": _ids(keys.get("categoryOrder")), "products": _map(keys.get("productOrder"))}
            add(tenant_id, row.level, target_id, "kiosk", content, None, keys)
    return made
