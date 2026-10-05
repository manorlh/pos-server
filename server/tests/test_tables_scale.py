"""
200 tables (spec: "the system holds 200 tables"): the tills' state, a save and the report at
that size — bounded queries (no query per table), and well within a till's poll.
"""
from __future__ import annotations

import json
import time
import uuid
from decimal import Decimal

from fastapi import BackgroundTasks
from sqlalchemy import event

from app.models.tables import TableOrder
from app.routers import tables as R
from app.schemas.tables import TableCreate, ZoneCreate
from app.services import tables as T
from test_tables import cart, ctx, enter, save, w  # noqa: F401  (the fixture)


def _count_queries(db):
    counter = {"n": 0}

    def before(*_a, **_k):
        counter["n"] += 1

    event.listen(db.get_bind(), "before_cursor_execute", before)
    return counter, lambda: event.remove(db.get_bind(), "before_cursor_execute", before)


def test_two_hundred_tables_one_hundred_fifty_open(w):
    zones = [T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name=f"Z{i}", layout="map")) for i in range(4)]
    tables = []
    for n in range(100, 300):
        tables.append(T.create_table(w.db, zones[n % 4], TableCreate(zoneId=zones[n % 4].id, number=n)))
    w.db.commit()
    lines = tuple(f"l{i}" for i in range(12))
    for t in tables[:150]:
        enter(w, w.a, t)
        save(w, w.a, t, uuid.uuid4(), None, lines=lines, total="250", action="leave")
    w.db.commit()

    counter, stop = _count_queries(w.db)
    started = time.perf_counter()
    state = R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)
    took = time.perf_counter() - started
    stop()
    assert len(state["tables"]) == 204  # the fixture's 4 and these 200
    assert sum(1 for t in state["tables"] if t["order"]) == 150
    # No query per table: a fixed handful, whatever the size.
    assert counter["n"] < 25, counter["n"]
    size = len(json.dumps(state, ensure_ascii=False).encode("utf-8"))
    print(f"\ntill state: {took * 1000:.0f} ms, {counter['n']} queries, {size / 1024:.0f} KB")
    assert took < 2.0
    # What a till pulls every few seconds stays small: summaries, never the carts.
    assert size < 400 * 1024
    assert "cartJson" not in json.dumps(state["tables"][0])

    # One save at that size: bounded too.
    t = tables[0]
    order = w.db.query(TableOrder).filter(TableOrder.table_id == t.id, TableOrder.status == "open").first()
    enter(w, w.b, t)
    counter, stop = _count_queries(w.db)
    started = time.perf_counter()
    save(w, w.b, t, order.id, order.version, lines=lines + ("l99",), total="260")
    took = time.perf_counter() - started
    stop()
    print(f"save: {took * 1000:.0f} ms, {counter['n']} queries")
    assert counter["n"] < 40

    # The report over them.
    day = w.clock.now.date()
    started = time.perf_counter()
    R.tables_report(w.shop.id, day, day, **ctx(w))
    print(f"report: {(time.perf_counter() - started) * 1000:.0f} ms")
