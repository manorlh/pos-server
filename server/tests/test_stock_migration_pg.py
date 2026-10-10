"""
The stock-locations migration (7c4e2a9d1f63) on a real Postgres, end to end: old-shape rows upgraded
(the batched backfill over more than two batches of movements), the previous build's insert made
whole by the trigger, the new unique index usable by the atomic write's ON CONFLICT, no invalid index
left, the downgrade folding a point of sale back into its shop (nothing deleted), and a re-upgrade.

Slow (every migration from empty) and needs Postgres: runs with RUN_PG_MIGRATION_CHECK=1, against a
scratch database `lc_mig_check` next to DATABASE_URL's.
"""
import os
import pathlib
import subprocess
import sys
import uuid

import pytest
import sqlalchemy as sa

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_PG_MIGRATION_CHECK") != "1" or not os.environ.get("DATABASE_URL", "").startswith("postgresql"),
    reason="Postgres migration check: set RUN_PG_MIGRATION_CHECK=1",
)

ROOT = str(pathlib.Path(__file__).resolve().parents[1])


def _fill(conn, table, values):
    """Insert a row giving every NOT NULL column without a default a dummy value."""
    cols = conn.execute(sa.text(
        "SELECT column_name, data_type, udt_name FROM information_schema.columns "
        "WHERE table_name = :t AND is_nullable = 'NO' AND column_default IS NULL"), {"t": table}).all()
    row = dict(values)
    for name, dtype, udt in cols:
        if name in row:
            continue
        if dtype == "uuid":
            row[name] = str(uuid.uuid4())
        elif dtype in ("integer", "bigint", "smallint", "numeric", "double precision", "real"):
            row[name] = 0
        elif dtype == "boolean":
            row[name] = False
        elif dtype.startswith("timestamp") or dtype == "date":
            row[name] = "2026-10-09"
        elif dtype in ("json", "jsonb"):
            row[name] = "{}"
        elif dtype == "USER-DEFINED":
            row[name] = conn.execute(sa.text(f"SELECT unnest(enum_range(NULL::{udt}))::text LIMIT 1")).scalar()
        else:
            row[name] = f"x{uuid.uuid4().hex[:8]}"
    names = ", ".join(row)
    params = ", ".join(f":{k}" for k in row)
    conn.execute(sa.text(f"INSERT INTO {table} ({names}) VALUES ({params})"), row)
    return row


def test_the_stock_locations_migration_upgrades_safely_and_downgrades_without_losing_stock():
    base = os.environ["DATABASE_URL"].rsplit("/", 1)[0]
    admin = sa.create_engine(base + "/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(sa.text("DROP DATABASE IF EXISTS lc_mig_check WITH (FORCE)"))
        c.execute(sa.text("CREATE DATABASE lc_mig_check"))
    url = base + "/lc_mig_check"
    env = dict(os.environ, DATABASE_URL=url, PYTHONPATH=ROOT, PYTHONUTF8="1")

    def alembic(*args):
        r = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, capture_output=True, text=True)
        assert r.returncode == 0, (args, r.stdout[-3000:], r.stderr[-6000:])

    alembic("upgrade", "9e6a4c1f3b85")
    eng = sa.create_engine(url)
    with eng.begin() as c:
        t = _fill(c, "tenants", {"id": str(uuid.uuid4())})
        co = _fill(c, "companies", {"id": str(uuid.uuid4()), "tenant_id": t["id"]})
        sh = _fill(c, "shops", {"id": str(uuid.uuid4()), "tenant_id": t["id"], "company_id": co["id"]})
        cat = _fill(c, "categories", {"id": str(uuid.uuid4()), "tenant_id": t["id"]})
        p1 = _fill(c, "products", {"id": str(uuid.uuid4()), "tenant_id": t["id"], "category_id": cat["id"]})
        p2 = _fill(c, "products", {"id": str(uuid.uuid4()), "tenant_id": t["id"], "category_id": cat["id"]})
        # The old shape: one row per (shop, product), no location columns.
        _fill(c, "stock_levels", {"id": str(uuid.uuid4()), "tenant_id": t["id"], "shop_id": sh["id"], "product_id": p1["id"], "quantity": 7})
        for _ in range(12000):  # more than two batches of the backfill
            c.execute(sa.text(
                "INSERT INTO stock_movements (id, tenant_id, shop_id, product_id, delta, reason, occurred_at, created_at) "
                "VALUES (:id, :t, :s, :p, 1, 'sale', now(), now())"),
                {"id": str(uuid.uuid4()), "t": t["id"], "s": sh["id"], "p": p1["id"]})

    alembic("upgrade", "head")
    with eng.begin() as c:
        assert c.execute(sa.text("SELECT count(*) FROM stock_movements WHERE target_id IS NULL OR company_id IS NULL")).scalar() == 0
        assert c.execute(sa.text("SELECT level, target_id::text, company_id::text FROM stock_levels")).one() == ("shop", sh["id"], co["id"])
        assert c.execute(sa.text("SELECT count(*) FROM pg_index WHERE NOT indisvalid")).scalar() == 0
        # The previous build's insert (no location): the trigger makes it its shop's.
        c.execute(sa.text("INSERT INTO stock_levels (id, tenant_id, shop_id, product_id, quantity) VALUES (:id, :t, :s, :p, 3)"),
                  {"id": str(uuid.uuid4()), "t": t["id"], "s": sh["id"], "p": p2["id"]})
        assert c.execute(sa.text("SELECT level, target_id::text, company_id::text FROM stock_levels WHERE product_id = :p"),
                         {"p": p2["id"]}).one() == ("shop", sh["id"], co["id"])
        # The atomic write's ON CONFLICT on the new unique index.
        q = c.execute(sa.text(
            "INSERT INTO stock_levels (id, tenant_id, shop_id, level, target_id, product_id, quantity) "
            "VALUES (:id, :t, :s, 'shop', :s, :p, -1) ON CONFLICT (level, target_id, product_id) "
            "DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity RETURNING quantity"),
            {"id": str(uuid.uuid4()), "t": t["id"], "s": sh["id"], "p": p1["id"]}).scalar()
        assert q == 6
        # A point of sale's stock (as with the flag on), to fold back on the downgrade.
        c.execute(sa.text(
            "INSERT INTO stock_levels (id, tenant_id, company_id, shop_id, level, target_id, product_id, quantity) "
            "VALUES (:id, :t, :co, :s, 'area', :a, :p, 4)"),
            {"id": str(uuid.uuid4()), "t": t["id"], "co": co["id"], "s": sh["id"], "a": str(uuid.uuid4()), "p": p1["id"]})

    alembic("downgrade", "9e6a4c1f3b85")
    with eng.begin() as c:
        q = c.execute(sa.text("SELECT quantity FROM stock_levels WHERE shop_id = :s AND product_id = :p"),
                      {"s": sh["id"], "p": p1["id"]}).scalar()
        assert q == 10, "6 at the shop + 4 at the point of sale, folded — nothing deleted"
        assert c.execute(sa.text("SELECT count(*) FROM stock_movements")).scalar() == 12000
    alembic("upgrade", "head")
    eng.dispose()
