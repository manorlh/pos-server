"""
Table orders when the LAN server moves, and "שחזור שולחן" (app/services/tables_handover.py; the
reliability audit of tables and kitchen tickets, 13.10.2026: "פדיחות שקשורות להיעלמות שולחן").

What each test pins — an open order never vanishes, never splits into two, and no change is lost
silently:

* **Never two open orders on one table.** The old server comes back with a table it seated while
  cut off — on a table the new server seated meanwhile: kept as a conflict for the dashboard, not
  applied. A table it paid and seated again in the same report is one open order (closures first).
* **A server that does not know it is one no more** (cut off when the server moved) and pushes its
  plain mirror: judged as the former server's — the new server's changes stand; what nobody touched
  is taken; a new table it seated is taken. The host's own mirror, and a single till's, as always.
* **"שחזור שולחן" once, never stranded.** Two tills racing for one closed order: one wins (the claim
  is one conditional UPDATE). The till that claimed it may finish its restore (its answer lost, the
  table not opened) when it says it can (`finish`), and sees it in its list (`includeMine`); another
  till never; an older till (no `finish`) once is once.

Runs on the in-memory SQLite world of tests/shift_world.py, as tests/test_local_server_switch.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import BackgroundTasks

from app.models.tables import TableOrder
from app.routers import tables as TR
from app.schemas.tables import TableRestoreIn
from app.services import local_server_switch as LSS
from app.services import main_till as MT
from app.services import tables as T
from app.services import tables_handover as TH
from test_local_server_switch import (  # noqa: F401 - fixtures and helpers
    LAN,
    a_table,
    heard,
    order,
    refused,
    report,
    set_param,
    switch,
    w,
)


def lan_shop(w):
    """The LAN mode, till 1 the server; till 2 another till of the shop."""
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    MT.set_main_till(w.db, w.shop, w.tills[0].id)
    w.db.commit()
    return w.tills


def open_on(w, table):
    return w.db.query(TableOrder).filter(TableOrder.table_id == table.id, TableOrder.status == "open").all()


# ── Never two open orders on one table ───────────────────────────────────────


def test_the_old_server_s_new_order_on_a_table_the_new_one_seated_is_a_conflict(w):
    t1, t2 = lan_shop(w)
    table = a_table(w, 5)
    heard(t1, 3600)
    switch(w, t2)
    # The new server seats table 5.
    seated = uuid.uuid4()
    report(w, t2, [order(table, seated, 1, 80)])
    # The old one comes back with table 5 seated by itself while it was cut off.
    mine = uuid.uuid4()
    out = report(w, t1, [order(table, mine, 2, 55)], former_host=True)
    assert out["conflict"] == [str(mine)] and out["applied"] == []
    assert {r["orderId"]: r["status"] for r in out["results"]} == {str(mine): "conflict"}
    # One open order on the table — the new server's; the other kept for the dashboard.
    assert [o.id for o in open_on(w, table)] == [seated]
    assert w.db.get(TableOrder, mine) is None
    [entry] = LSS.former_host_changes_out(w.shop)["items"]
    assert entry["orderId"] == str(mine) and entry["till"]["total"] == 55.0 and entry["cloud"]["total"] == 80.0
    assert entry["tableNumber"] == 5


def test_a_table_paid_and_seated_again_in_one_report_is_one_open_order(w):
    t1, t2 = lan_shop(w)
    table = a_table(w, 5)
    first = uuid.uuid4()
    report(w, t1, [order(table, first, 1, 40)])
    heard(t1, 3600)
    switch(w, t2)
    # Cut off, the old server took table 5's payment and seated new guests there; its report lists
    # the new guests first — the payment is still taken first.
    again = uuid.uuid4()
    paid = {**order(table, first, 2, 40, status="paid"), "closedAt": datetime.now(timezone.utc).isoformat()}
    out = report(w, t1, [order(table, again, 1, 25), paid], former_host=True)
    assert set(out["applied"]) == {str(first), str(again)} and out["conflict"] == []
    assert [o.id for o in open_on(w, table)] == [again]
    assert w.db.get(TableOrder, first).status == "paid"


def test_the_new_server_s_own_mirror_is_never_judged(w):
    t1, t2 = lan_shop(w)
    table = a_table(w, 5)
    a = uuid.uuid4()
    report(w, t1, [order(table, a, 1, 30)])
    heard(t1, 3600)
    switch(w, t2)
    # The host's mirror: newest version wins, as always — no conflict key in its answer.
    out = report(w, t2, [order(table, a, 2, 45)])
    assert out == {"accepted": [str(a)], "skipped": []}
    assert w.db.get(TableOrder, a).total == Decimal("45.00")


# ── A server that does not know it is one no more ────────────────────────────


def test_a_stale_server_s_plain_mirror_never_overwrites_the_new_server(w):
    t1, t2 = lan_shop(w)
    table, other, free = a_table(w, 5), a_table(w, 6), a_table(w, 7)
    a, b = uuid.uuid4(), uuid.uuid4()
    report(w, t1, [order(table, a, 3, 50), order(other, b, 2, 40)])
    heard(t1, 3600)
    switch(w, t2)
    report(w, t2, [order(table, a, 4, 80)])
    assert TH.judged_report(w.db, t1) is True and TH.judged_report(w.db, t2) is False
    # Till 1, cut off when the server moved, still pushes as the host: version 5 of table 5 (higher
    # than the new server's 4) — never taken over the new server's edit.
    c = uuid.uuid4()
    out = report(w, t1, [order(table, a, 5, 55), order(other, b, 3, 45), order(free, c, 1, 15)])
    assert out["conflict"] == [str(a)]
    assert set(out["accepted"]) == {str(b), str(c)}
    assert w.db.get(TableOrder, a).total == Decimal("80.00") and w.db.get(TableOrder, a).version == 4
    assert w.db.get(TableOrder, b).version == 3 and w.db.get(TableOrder, c) is not None
    assert LSS.former_host_changes_out(w.shop)["count"] == 1


def test_a_till_that_never_hosted_is_judged_too_and_a_new_table_of_it_is_taken(w):
    """A till that hosts by the technician's override while the cloud names another: what it seats
    on a free table is taken; it never writes over the host's orders."""
    t1, t2 = lan_shop(w)
    table, free = a_table(w, 5), a_table(w, 6)
    a = uuid.uuid4()
    report(w, t1, [order(table, a, 2, 30)])
    c = uuid.uuid4()
    out = report(w, t2, [order(table, a, 3, 99), order(free, c, 1, 15)])
    assert out["conflict"] == [str(a)] and out["accepted"] == [str(c)]
    assert w.db.get(TableOrder, a).total == Decimal("30.00")


def test_a_single_till_report_is_taken_as_always(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, "קופה אחת")
    MT.set_main_till(w.db, w.shop, t1.id)
    w.db.commit()
    table = a_table(w, 5)
    assert TH.judged_report(w.db, t2) is False
    a = uuid.uuid4()
    out = report(w, t2, [order(table, a, 1, 30)])
    assert out == {"accepted": [str(a)], "skipped": []}


def test_closures_first_keeps_the_order_otherwise():
    class Item:
        def __init__(self, i, status):
            self.id, self.status = i, status

    items = [Item(1, "open"), Item(2, "paid"), Item(3, "open"), Item(4, "cancelled")]
    assert [i.id for i in TH.closures_first(items)] == [2, 4, 1, 3]


# ── "שחזור שולחן" ─────────────────────────────────────────────────────────────


def closed_order(w, table, status="paid", minutes_ago=5):
    now = datetime.now(timezone.utc)
    o = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=table.zone_id,
        table_number=table.number, status=status, source="local", version=3, total=Decimal("60.00"),
        opened_at=now - timedelta(hours=1), closed_at=now - timedelta(minutes=minutes_ago),
        cart_json="{}", extras_json=None,
    )
    w.db.add(o)
    w.db.commit()
    return o


def restore(w, till, o, *, finish=True):
    body = TableRestoreIn(posUserName="דנה", approvedBy="מנהלת", finish=finish)
    return TR.restore_closed_table(str(till.id), str(o.id), body, BackgroundTasks(), machine=till, db=w.db)


def listed(w, till, mine=True):
    return {r["orderId"]: r for r in TR.get_closed_tables(str(till.id), include_mine=mine, machine=till, db=w.db)["orders"]}


def test_two_tills_racing_for_one_closed_order_one_wins(w):
    t1, t2 = lan_shop(w)
    o = closed_order(w, a_table(w, 5))
    # Till 2 read the order as not restored yet; till 1 claims it meanwhile (another session).
    seen = w.db.get(TableOrder, o.id)
    assert seen.restored_at is None
    w.db.execute(
        TableOrder.__table__.update().where(TableOrder.__table__.c.id == o.id).values(
            restored_at=datetime.now(timezone.utc), restored_by_pos_user_name="רון",
        )
    )
    # Till 2's claim, on its stale read: the conditional UPDATE takes nothing — refused, never twice.
    e = refused(T.mark_restored, w.db, t2, o.id, T.Actor(machine=t2, pos_user_name="דנה"), finish=True)
    assert e.status_code == 409 and e.detail["code"] == "already_restored"


def test_the_till_that_claimed_it_may_finish_its_restore_and_nobody_else(w):
    t1, t2 = lan_shop(w)
    o = closed_order(w, a_table(w, 5))
    assert restore(w, t1, o)["orderId"] == str(o.id)
    # Its answer was lost (or the table could not be opened): it claims it again — the same.
    assert restore(w, t1, o)["orderId"] == str(o.id)
    # Its list still has it, marked; the other till's does not, and its claim is refused.
    assert listed(w, t1)[str(o.id)]["restoredByThisTill"] is True
    assert str(o.id) not in listed(w, t2)
    e = refused(restore, w, t2, o)
    assert e.status_code == 409 and e.detail["code"] == "already_restored"
    # An older till (no `finish`): once is once, and the list as before.
    e = refused(restore, w, t1, o, finish=False)
    assert e.detail["code"] == "already_restored"
    assert str(o.id) not in listed(w, t1, mine=False)


def test_past_the_window_a_restore_is_never_claimed_again(w):
    t1, _ = lan_shop(w)
    o = closed_order(w, a_table(w, 5))
    restore(w, t1, o)
    row = w.db.get(TableOrder, o.id)
    row.restored_at = datetime.now(timezone.utc) - TH.RESTORE_RETRY_WINDOW - timedelta(minutes=1)
    w.db.commit()
    assert refused(restore, w, t1, o).detail["code"] == "already_restored"
    assert str(o.id) not in listed(w, t1)


def test_an_unclaimed_closed_order_is_listed_unmarked(w):
    t1, t2 = lan_shop(w)
    o = closed_order(w, a_table(w, 5), status="cancelled")
    assert listed(w, t2)[str(o.id)]["restoredByThisTill"] is False
    assert listed(w, t2, mine=False)[str(o.id)]["restoredByThisTill"] is False
