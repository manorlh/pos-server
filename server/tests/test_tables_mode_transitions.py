"""
Changing how a shop's tills share their tables while tables are open (app/services/tables_mode_guard.py;
the reliability audit of tables and kitchen tickets, 13.10.2026 — the owner's transitions: the local
server → the cloud, the cloud → the local server, an independent till joining the server and back).

The three properties hold over every transition: an open order never disappears from every floor,
never ends up served twice, and no change it holds is lost. Where the cloud cannot carry an open
order across safely, the change is refused — in Hebrew, the tables named — and nothing changes:

* «רשת מקומית» → «מסונכרן»: refused while the server holds open tables, while its copy in the cloud
  is incomplete (changes on their way), or while it is silent having served a moment ago.
* «מסונכרן» → «רשת מקומית»: refused while the cloud holds open synced tables (the new server starts
  from the server's copy, which has none of them).
* «קופה אחת» → the server's group (an independent till joining): refused while the till has its own
  tables open — with the table named as open on both sides when the server has it open too.
* A member leaving the group for its own tables: allowed — its orders stay on the server.
* The new server's start (`host-seed`) never takes an independent till's own open order (the table
  would be open in both places).
* The card "סוגי עבודה" is guarded the same way; the shop Z's clean break is the same guard
  (tests/test_independent_till.py::TestOneProducer pins it on every road).

Runs on the in-memory SQLite world of tests/shift_world.py, as tests/test_local_server_switch.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.tables import TableOrder
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import till_parameters as PR
from app.schemas.till_parameter import TillParameterValueIn
from app.services import main_till as MT
from app.services import menu_broadcast as B
from app.services import tables as T
from app.services import tables_mode_guard as G
from test_local_server_switch import LAN, a_table, heard, order, report, set_param, w  # noqa: F401

SYNCED = "מסונכרן בין הקופות"
SINGLE = "קופה אחת"


def set_value(w, key, scope_type, scope_id, value):
    """The till parameters page's write (the super admin), as the dashboard sends it."""
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    resp = PR.set_till_parameter_value(
        parameter.id, TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        BackgroundTasks(), _admin=w.admin, db=w.db,
    )
    if hasattr(resp, "status_code") and hasattr(resp, "body"):
        return resp.status_code, json.loads(resp.body)
    return 200, resp


def lan_order(table, oid, version=1, total=50, status="open"):
    """As the server mirrors it: with its dishes."""
    return {**order(table, oid, version, total, status=status), "cartJson": json.dumps({"lines": []})}


def lan_shop(w):
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    MT.set_main_till(w.db, w.shop, w.tills[0].id)
    w.db.commit()
    return w.tills


def shop_mode(w):
    return T.mode_of(T.machine_params(w.db, w.tills[0]).get(T.TABLES_MODE_KEY))


def synced_order(w, table):
    o = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=table.zone_id,
        table_number=table.number, status="open", source="synced", version=1, total=Decimal("20.00"),
        opened_at=datetime.now(timezone.utc),
    )
    w.db.add(o)
    w.db.commit()
    return o


# ── The local server → the cloud ─────────────────────────────────────────────


def test_lan_to_cloud_is_refused_while_the_server_holds_open_tables(w):
    t1, _ = lan_shop(w)
    table = a_table(w, 5)
    a = uuid.uuid4()
    report(w, t1, [lan_order(table, a)])
    code, out = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 409 and out["detail"] == G.REFUSED
    assert "שולחן 5 פתוח בשרת המקומי" in out["message"] and G.CLOSE_FIRST in out["message"]
    assert out["tables"] == [{
        "orderId": str(a), "tableId": str(table.id), "tableNumber": 5, "tableName": None, "pool": "lan", "machineId": None,
    }]
    assert out["canForce"] is False
    # Nothing changed: still the local server's.
    assert shop_mode(w) == T.MODE_LAN
    # Paid there (the server's mirror): the change goes through.
    report(w, t1, [{**lan_order(table, a, 2, status="paid"), "closedAt": datetime.now(timezone.utc).isoformat()}])
    code, _ = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 200 and shop_mode(w) == T.MODE_SYNCED


def test_lan_to_cloud_waits_for_the_server_s_copy_to_be_complete(w):
    t1, _ = lan_shop(w)
    t1.lan_sync = {"pending": 3, "oldestAt": datetime.now(timezone.utc).isoformat()}
    t1.lan_sync_reported_at = datetime.now(timezone.utc)
    w.db.commit()
    code, out = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 409 and "עוד לא העביר לענן 3 שינויים" in out["message"]
    t1.lan_sync = {"pending": 0, "oldestAt": None}
    w.db.commit()
    code, _ = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 200


def test_lan_to_cloud_waits_for_a_server_that_went_silent_a_moment_ago(w):
    t1, _ = lan_shop(w)
    heard(t1, 3600)
    w.db.commit()
    code, out = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 409 and "לא מחובר" in out["message"]
    # Silent for days: gone, not cut off — what it held is judged when it comes back.
    heard(t1, 3 * 24 * 3600)
    w.db.commit()
    code, _ = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 200


def test_the_server_alone_leaving_the_group_needs_its_copy_complete_not_its_tables_closed(w):
    """Another device serves the group after the change: it starts from the cloud's copy."""
    t1, t2 = lan_shop(w)
    table = a_table(w, 5)
    report(w, t1, [lan_order(table, uuid.uuid4())])
    t1.lan_sync = {"pending": 1, "oldestAt": datetime.now(timezone.utc).isoformat()}
    w.db.commit()

    def move():
        # One change, as the work profile makes it: the server (till 1) to its own tables, and the
        # main till — the server — to till 2.
        guard = G.TablesModeGuard(w.db, [w.shop])
        set_param(w, "tablesMode", "machine", t1.id, SINGLE)
        MT.set_main_till(w.db, w.shop, t2.id)
        guard.check()

    from app.services.local_shop_z import LocalShopZRefused

    with pytest.raises(LocalShopZRefused) as e:
        move()
    assert e.value.body["detail"] == G.REFUSED and "עוד לא העביר לענן 1" in e.value.body["message"]
    # The open table alone is no reason: the new server starts from the cloud's copy.
    assert "שולחן 5" not in e.value.body["message"]
    w.db.rollback()
    t1 = w.db.get(type(t1), t1.id)
    t1.lan_sync = {"pending": 0}
    w.db.commit()
    move()
    w.db.commit()
    assert T.tables_host_of_shop(w.db, w.shop.id).id == t2.id
    # The new server starts with the open table.
    assert [o["tableId"] for o in T.host_seed(w.db, t2)["orders"]] == [str(table.id)]


# ── The cloud → the local server ─────────────────────────────────────────────


def test_cloud_to_lan_is_refused_while_the_cloud_holds_open_synced_tables(w):
    set_param(w, "tablesMode", "shop", w.shop.id, SYNCED)
    MT.set_main_till(w.db, w.shop, w.tills[0].id)
    w.db.commit()
    table = a_table(w, 7)
    o = synced_order(w, table)
    code, out = set_value(w, "tablesMode", "shop", w.shop.id, LAN)
    assert code == 409 and "שולחן 7 פתוח במצב «מסונכרן בין הקופות»" in out["message"]
    assert out["tables"][0]["pool"] == "synced"
    assert shop_mode(w) == T.MODE_SYNCED
    o.status = "paid"
    w.db.commit()
    code, _ = set_value(w, "tablesMode", "shop", w.shop.id, LAN)
    assert code == 200 and shop_mode(w) == T.MODE_LAN


# ── An independent till («קופה אחת») joining the server, and back ─────────────


def test_a_till_joining_the_server_with_its_own_tables_open_is_refused_naming_them(w):
    t1, t2 = lan_shop(w)
    set_param(w, "tablesMode", "machine", t2.id, SINGLE)
    w.db.commit()
    nine, five = a_table(w, 9), a_table(w, 5)
    # Till 2 kept its own table 9 open (its report: no dishes); table 5 is open on both sides.
    mine, clash = uuid.uuid4(), uuid.uuid4()
    report(w, t2, [order(nine, mine, 2, 30), order(five, clash, 1, 10)])
    report(w, t1, [lan_order(five, uuid.uuid4())])
    code, out = set_value(w, "tablesMode", "machine", t2.id, LAN)
    assert code == 409
    assert "שולחן 9 פתוח בקופה 2 · Till 2." in out["message"]
    assert "שולחן 5 פתוח גם בקופה 2 · Till 2 וגם בשרת המקומי." in out["message"]
    assert {t["pool"] for t in out["tables"]} == {"single"} and {t["machineId"] for t in out["tables"]} == {str(t2.id)}
    # Never merged, never dropped: both orders as they were.
    assert w.db.get(TableOrder, mine).status == "open" and w.db.get(TableOrder, clash).status == "open"
    # Its tables closed: it joins.
    report(w, t2, [{**order(nine, mine, 3, 30, status="paid"), "closedAt": datetime.now(timezone.utc).isoformat()},
                   {**order(five, clash, 2, 10, status="cancelled"), "closedAt": datetime.now(timezone.utc).isoformat()}])
    code, _ = set_value(w, "tablesMode", "machine", t2.id, LAN)
    assert code == 200


def test_a_member_leaving_the_server_for_its_own_tables_leaves_its_orders_on_the_server(w):
    t1, t2 = lan_shop(w)
    table = a_table(w, 5)
    a = uuid.uuid4()
    report(w, t1, [lan_order(table, a)])
    code, _ = set_value(w, "tablesMode", "machine", t2.id, SINGLE)
    assert code == 200
    # The order stays on the server, once.
    assert w.db.get(TableOrder, a).status == "open"
    assert [o["id"] for o in T.host_seed(w.db, t1)["orders"]] == [str(a)]


def test_the_new_server_never_starts_with_an_independent_till_s_own_table(w):
    t1, t2 = lan_shop(w)
    set_param(w, "tablesMode", "machine", t2.id, SINGLE)
    w.db.commit()
    lan_table, own_table = a_table(w, 5), a_table(w, 9)
    served, own = uuid.uuid4(), uuid.uuid4()
    report(w, t1, [lan_order(lan_table, served)])
    report(w, t2, [order(own_table, own, 1, 30)])
    ids = [o["id"] for o in T.host_seed(w.db, t1)["orders"]]
    assert ids == [str(served)]


def test_an_independent_till_joining_the_shop_through_its_card_is_refused_the_same_way(w):
    """"קופה עצמאית" → a member of the shop (app/services/independent_till.py `apply_shop`)."""
    from app.services import independent_till as IT
    from app.services.local_shop_z import LocalShopZRefused

    t1, t2 = lan_shop(w)
    IT.check_switch(w.db, w.admin, t2, True)
    assert IT.set_independent(w.db, t2, True)
    # Its tables on at its own level: «קופה אחת» while independent, the shop's once it joins.
    set_param(w, "tablesMode", "machine", t2.id, LAN)
    w.db.commit()
    assert T.mode_of(T.machine_params(w.db, t2).get(T.TABLES_MODE_KEY)) == T.MODE_SINGLE
    nine = a_table(w, 9)
    own = uuid.uuid4()
    report(w, t2, [order(nine, own, 1, 30)])
    with pytest.raises(LocalShopZRefused) as e:
        IT.apply_shop(w.db, w.admin, w.shop, participants=[t2.id])
    assert e.value.body["detail"] == G.REFUSED and "שולחן 9 פתוח בקופה" in e.value.body["message"]
    w.db.rollback()
    assert w.db.get(type(t2), t2.id).independent_till is True
    # Back the other way, a member leaving with the server's tables open: they stay on the server.
    report(w, t2, [{**order(nine, own, 2, 30, status="paid"), "closedAt": datetime.now(timezone.utc).isoformat()}])
    IT.apply_shop(w.db, w.admin, w.shop, participants=[t2.id])
    w.db.commit()
    lan = uuid.uuid4()
    report(w, t1, [lan_order(a_table(w, 5), lan)])
    IT.apply_shop(w.db, w.admin, w.shop, independent=[t2.id])
    w.db.commit()
    assert w.db.get(TableOrder, lan).status == "open"
    assert [o["id"] for o in T.host_seed(w.db, t1)["orders"] if o["status"] == "open"] == [str(lan)]


# ── Other roads ──────────────────────────────────────────────────────────────


def test_the_card_work_types_is_guarded_the_same_way(w):
    t1, _ = lan_shop(w)
    table = a_table(w, 5)
    report(w, t1, [lan_order(table, uuid.uuid4())])
    with pytest.raises(HTTPException) as e:
        B.set_work_types(w.db, w.shop, w.admin, tables=True, tables_mode=SYNCED)
    assert e.value.status_code == 409 and e.value.detail["code"] == G.REFUSED
    assert "שולחן 5 פתוח בשרת המקומי" in e.value.detail["message"]
    assert shop_mode(w) == T.MODE_LAN


def test_a_change_that_moves_no_table_is_never_refused_for_open_tables(w):
    t1, t2 = lan_shop(w)
    report(w, t1, [lan_order(a_table(w, 5), uuid.uuid4())])
    # The print server to till 2 (a guarded key): no till's tables mode moves.
    code, _ = set_value(w, "printHostTill", "machine", t2.id, True)
    assert code == 200
    # The same mode written again at another level: nothing moves either.
    code, _ = set_value(w, "tablesMode", "machine", t2.id, LAN)
    assert code == 200


def test_many_tables_are_counted_not_all_named(w):
    t1, _ = lan_shop(w)
    rows = [lan_order(a_table(w, n), uuid.uuid4()) for n in range(1, 12)]
    report(w, t1, rows)
    code, out = set_value(w, "tablesMode", "shop", w.shop.id, SYNCED)
    assert code == 409 and len(out["tables"]) == 11 and "ועוד 3." in out["message"]
