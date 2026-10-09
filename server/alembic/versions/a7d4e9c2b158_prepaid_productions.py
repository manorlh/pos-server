"""prepaid vouchers: productions ("הפקות") and a batch's production and event (the contract's §13)

Revision ID: a7d4e9c2b158
Revises: f3a9c1d7e520
Create Date: 2026-10-09

* `prepaid_productions` — a company's production (the customer vouchers are made for): its name,
  contact, billing basis (`redemption` by default, or `delivery`), notes, active. One name per
  company, whatever its case: a unique index on `(tenant_id, company_id, lower(name))`.
* `prepaid_voucher_batches.production_id` (FK, null) and `report_event_id` (FK to the existing
  `report_events`, null, `ON DELETE SET NULL` — deleting an event never fails over a batch);
  `customer_name` / `event_name` stay (the printed text, the legacy filter).
* Data: every distinct customer name of a company's batches — compared as `lower(btrim(name))`, so
  "הפקות כהן" and "הפקות כהן " and "HAFAKOT" / "hafakot" are one — becomes a production (named as
  first written, trimmed), and those batches name it (their `customer_name` becomes its name). A
  production's id is derived from (tenant, company, the lowered name), so a second run adds nothing.

Fixed in place before it was applied anywhere (review 09.10): the case-insensitive grouping and
index, and the event's `ON DELETE SET NULL`. A database where a `create_all` already made
`prepaid_productions` from the earlier model (a case-sensitive `ux_prepaid_productions_name`
unique constraint, maybe rows differing only in case) is brought to the same end: the old index /
constraint replaced, rows differing only in case merged into the first (their batches follow), then
the `lower(name)` index and the backfill. An FK on the batches' columns made by `create_all` under
another name is kept for `production_id`, and replaced for `report_event_id` when it is not
`ON DELETE SET NULL`.

Idempotent (the table, columns and indexes only when missing; the data by name); offline
(`--sql`) the plain statements, the data as one INSERT … SELECT and one UPDATE (Postgres).
"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a7d4e9c2b158'
down_revision: Union[str, Sequence[str], None] = 'f3a9c1d7e520'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'prepaid_productions'
BATCHES = 'prepaid_voucher_batches'
NAMESPACE = uuid.UUID('6f1c8a52-9d3e-4b7a-a0c5-2e8f4d6b1a93')


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_table(name: str) -> bool:
    return False if _offline() else sa.inspect(op.get_bind()).has_table(name)


def _columns(table: str) -> set:
    return set() if _offline() else {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _index_names(table: str) -> set:
    """Every index of [table] by name — an expression index included (the inspector skips those on SQLite)."""
    if _offline():
        return set()
    bind = op.get_bind()
    if bind.dialect.name == 'sqlite':
        rows = bind.execute(sa.text("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = :t"), {"t": table})
    else:
        rows = bind.execute(sa.text("SELECT indexname FROM pg_indexes WHERE tablename = :t"), {"t": table})
    return {r[0] for r in rows}


def _index_defs(table: str) -> dict:
    """{index name: its definition} (Postgres; SQLite: the stored SQL) — to tell `lower(name)` from the old one."""
    if _offline():
        return {}
    bind = op.get_bind()
    if bind.dialect.name == 'sqlite':
        rows = bind.execute(sa.text("SELECT name, coalesce(sql, '') FROM sqlite_master WHERE type = 'index' AND tbl_name = :t"),
                            {"t": table})
    else:
        rows = bind.execute(sa.text("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = :t"), {"t": table})
    return {r[0]: r[1] for r in rows}


def _replace_case_sensitive_name_index() -> None:
    """The earlier model's case-sensitive unique name (a `create_all` made it): dropped, its duplicates merged."""
    defs = _index_defs(TABLE)
    old = defs.get('ux_prepaid_productions_name')
    if old is None or 'lower(' in old.lower():
        return
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute(sa.text(f"ALTER TABLE {TABLE} DROP CONSTRAINT IF EXISTS ux_prepaid_productions_name"))
        op.execute(sa.text("DROP INDEX IF EXISTS ux_prepaid_productions_name"))
    else:
        op.drop_index('ux_prepaid_productions_name', table_name=TABLE)
    # Rows differing only in case or spaces: the first one stays, the batches of the others follow it.
    rows = bind.execute(sa.text(
        f"SELECT id, tenant_id, company_id, name FROM {TABLE} ORDER BY created_at, id")).all()
    keep: dict = {}
    for pid, tenant_id, company_id, name in rows:
        key = (str(tenant_id), str(company_id), (name or '').strip().lower())
        if key not in keep:
            keep[key] = pid
            continue
        if 'production_id' in _columns(BATCHES):
            bind.execute(sa.text(f"UPDATE {BATCHES} SET production_id = :k WHERE production_id = :p"),
                         {"k": keep[key], "p": pid})
        bind.execute(sa.text(f"DELETE FROM {TABLE} WHERE id = :p"), {"p": pid})


def _indexes(table: str) -> set:
    return set() if _offline() else {i['name'] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _move_customers() -> None:
    """Each distinct customer name (by `lower(btrim(name))`) of a company's batches → a production; the batches name it."""
    if op.get_context().dialect.name == 'postgresql':
        op.execute(sa.text(f"""
            INSERT INTO {TABLE} (id, tenant_id, company_id, name, billing_basis, active, created_at, updated_at)
            SELECT DISTINCT ON (b.tenant_id, b.company_id, lower(btrim(b.customer_name)))
                   md5(b.tenant_id::text || ':' || b.company_id::text || ':' || lower(btrim(b.customer_name)))::uuid,
                   b.tenant_id, b.company_id, btrim(b.customer_name), 'redemption', true, now(), now()
            FROM {BATCHES} b
            WHERE b.customer_name IS NOT NULL AND btrim(b.customer_name) <> ''
            ORDER BY b.tenant_id, b.company_id, lower(btrim(b.customer_name)), b.created_at
            ON CONFLICT (tenant_id, company_id, lower(name)) DO NOTHING
        """))
        op.execute(sa.text(f"""
            UPDATE {BATCHES} b SET production_id = p.id, customer_name = p.name
            FROM {TABLE} p
            WHERE b.production_id IS NULL AND p.tenant_id = b.tenant_id AND p.company_id = b.company_id
              AND lower(p.name) = lower(btrim(b.customer_name))
        """))
        # Batches already naming a production (a `create_all`-era link): their name follows it.
        op.execute(sa.text(f"""
            UPDATE {BATCHES} b SET customer_name = p.name
            FROM {TABLE} p
            WHERE b.production_id = p.id AND b.customer_name IS DISTINCT FROM p.name
        """))
        return
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        f"SELECT id, tenant_id, company_id, customer_name FROM {BATCHES} "
        "WHERE customer_name IS NOT NULL AND trim(customer_name) <> '' AND production_id IS NULL ORDER BY id"
    )).all()
    for batch_id, tenant_id, company_id, raw in rows:
        name = raw.strip()
        key = name.lower()
        found = bind.execute(sa.text(
            f"SELECT id, name FROM {TABLE} WHERE tenant_id = :t AND company_id = :c AND lower(name) = :k"
        ), {"t": tenant_id, "c": company_id, "k": key}).first()
        if found is None:
            pid = uuid.uuid5(NAMESPACE, f"{tenant_id}:{company_id}:{key}").hex
            bind.execute(sa.text(
                f"INSERT INTO {TABLE} (id, tenant_id, company_id, name, billing_basis, active) "
                "VALUES (:id, :t, :c, :n, 'redemption', 1)"
            ), {"id": pid, "t": tenant_id, "c": company_id, "n": name})
            pname = name
        else:
            pid, pname = found[0], found[1]
        bind.execute(sa.text(f"UPDATE {BATCHES} SET production_id = :p, customer_name = :n WHERE id = :b"),
                     {"p": pid, "n": pname, "b": batch_id})


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    if not _has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', _uuid(), sa.ForeignKey('companies.id'), nullable=False),
            sa.Column('name', sa.String(200), nullable=False),
            sa.Column('contact_name', sa.String(200), nullable=True),
            sa.Column('contact_phone', sa.String(50), nullable=True),
            sa.Column('contact_email', sa.String(200), nullable=True),
            sa.Column('billing_basis', sa.String(16), nullable=False, server_default='redemption'),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id'), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("billing_basis IN ('redemption', 'delivery')", name='ck_prepaid_productions_billing'),
        )
        op.create_index('ix_prepaid_productions_tenant_id', TABLE, ['tenant_id'])
        op.create_index('ix_prepaid_productions_company_id', TABLE, ['company_id'])
    if not _offline():
        _replace_case_sensitive_name_index()
    if 'ux_prepaid_productions_name' not in _index_names(TABLE):
        # One name per company whatever its case ("הפקות כהן" / "HAFAKOT" vs "hafakot").
        op.create_index('ux_prepaid_productions_name', TABLE, ['tenant_id', 'company_id', sa.text('lower(name)')], unique=True)
    have = _columns(BATCHES)
    if 'production_id' not in have:
        op.add_column(BATCHES, sa.Column('production_id', _uuid(), nullable=True))
    if 'report_event_id' not in have:
        op.add_column(BATCHES, sa.Column('report_event_id', _uuid(), nullable=True))
    # The foreign keys (SQLite — the tests — cannot add a constraint to a table in place).
    if op.get_context().dialect.name == 'postgresql':
        # By column, not by name: a `create_all` may have made one under its own name.
        fks = [] if _offline() else sa.inspect(op.get_bind()).get_foreign_keys(BATCHES)
        for name, column, target in (
            ('fk_prepaid_voucher_batches_production', 'production_id', TABLE),
            ('fk_prepaid_voucher_batches_report_event', 'report_event_id', 'report_events'),
        ):
            on_column = [fk for fk in fks if fk.get('constrained_columns') == [column]]
            want_set_null = column == 'report_event_id'
            for fk in on_column:
                if want_set_null and (fk.get('options') or {}).get('ondelete', '').upper() != 'SET NULL':
                    op.drop_constraint(fk['name'], BATCHES, type_='foreignkey')
                    on_column = []
            if not on_column:
                # An event deleted: its batches lose the link (their printed event name stays).
                op.create_foreign_key(name, BATCHES, target, [column], ['id'],
                                      ondelete='SET NULL' if want_set_null else None)
    indexes = _indexes(BATCHES)
    if 'ix_prepaid_voucher_batches_production_id' not in indexes:
        op.create_index('ix_prepaid_voucher_batches_production_id', BATCHES, ['production_id'])
    if 'ix_prepaid_voucher_batches_report_event_id' not in indexes:
        op.create_index('ix_prepaid_voucher_batches_report_event_id', BATCHES, ['report_event_id'])
    _move_customers()


def downgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        fks = None if _offline() else {fk['name'] for fk in sa.inspect(op.get_bind()).get_foreign_keys(BATCHES)}
        for name in ('fk_prepaid_voucher_batches_report_event', 'fk_prepaid_voucher_batches_production'):
            if fks is None or name in fks:
                op.drop_constraint(name, BATCHES, type_='foreignkey')
    indexes = None if _offline() else _indexes(BATCHES)
    for name in ('ix_prepaid_voucher_batches_report_event_id', 'ix_prepaid_voucher_batches_production_id'):
        if indexes is None or name in indexes:
            op.drop_index(name, table_name=BATCHES)
    have = None if _offline() else _columns(BATCHES)
    for name in ('report_event_id', 'production_id'):
        if have is None or name in have:
            op.drop_column(BATCHES, name)
    if _offline() or _has_table(TABLE):
        op.drop_table(TABLE)
