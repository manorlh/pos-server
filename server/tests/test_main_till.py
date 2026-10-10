"""
The shop's main till ("קופה ראשית", app/services/main_till.py) and the Z's waiters
(app/services/z_waiters.py).

* One till marked `mainTill` is the shop's tables host and print server unless another is
  named for that job, and the master of the shop Z.
* "Z only from the main till" (`shopZFrom`, default): the dashboard's wizard and every
  other till are refused the shop Z; «הקופה הראשית והדשבורד» lets the dashboard back in,
  «כל קופה» every till. A shop without a main till keeps the master-till rule.
* The card's PUT is the super admin's, sets the till and the rule, and waits for a run.
* The Z built from the main till is one Z for the shop: a section per till and, frozen on
  its header, a row per waiter — a table's sale (and its parts, and its credit note) by
  the table's waiter, any other sale by its cashier — that adds up to the Z.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.pos_user import PosUser
from app.models.shift import ShiftStatus
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.routers import main_till as main_router
from app.routers import till_shop_z as R
from app.routers import z_reports as z_reports_router
from app.routers import z_runs as z_runs_router
from app.schemas.shift import ShiftCloseIn
from app.schemas.z_run import ZRunCreateIn
from app.services import ably_notify
from app.services import main_till as MT
from app.services import till_parameters as TP
from app.services import z_print
from app.services.printers import print_host_of_shop
from app.services.shifts import apply_shift_close
from app.services.tables import tables_host_of_shop
from app.services.z_waiters import waiter_breakdown
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.flush()


def make_main(w, till):
    set_param(w, MT.MAIN_TILL_KEY, "machine", till.id, True)


def outside_local_mode(w, other):
    """
    Another till prints for the shop and the tables are not on the LAN: the main till is no
    LAN host, so the shop is not in local mode — where the dashboard and `shopZFrom` keep
    the rules below (in local mode the main till alone makes the shop Z,
    docs/SPEC_INDEPENDENT_TILL.md §8; tests/test_independent_till.py).
    """
    set_param(w, "printHostTill", "machine", other.id, True)


def closed_shift(w, till, seq, *docs):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    made = list(docs) or [lambda s: w.doc(till, s, "10.00")]
    txs = [make(shift) for make in made]
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(t.id) for t in txs],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift, txs


def start(w, till):
    return R.till_shop_z_start(
        str(till.id), R.ShopZStartIn(confirmOpenTills=False, posUserName="דנה"), machine=till, db=w.db
    )


def dashboard_run(w, *tills, user=None):
    return z_runs_router.post_z_run(
        # The tills here are not seen "now": the state is confirmed (offline till Z §4.6.1).
        ZRunCreateIn(shopId=w.shop.id, machines=[{"machineId": str(t.id)} for t in tills], confirmCloudData=True),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def put(w, machine_id, z_from=None, user=None):
    return main_router.put_main_till(
        w.shop.id,
        main_router.MainTillIn(machineId=machine_id, zFrom=z_from),
        BackgroundTasks(),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


# ── Which till is it, and what leans on it ────────────────────────────────────


def test_the_main_till_hosts_the_tables_and_the_printing_unless_another_is_named(w):
    t1, t2 = w.tills
    assert MT.main_till_of_shop(w.db, w.shop.id) is None
    assert tables_host_of_shop(w.db, w.shop.id) is None
    make_main(w, t2)
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t2.id
    assert tables_host_of_shop(w.db, w.shop.id).id == t2.id
    assert print_host_of_shop(w.db, w.shop.id).id == t2.id
    # A till named for one job keeps it.
    set_param(w, "printHostTill", "machine", t1.id, True)
    assert print_host_of_shop(w.db, w.shop.id).id == t1.id
    assert tables_host_of_shop(w.db, w.shop.id).id == t2.id
    set_param(w, "tablesHostTill", "machine", t1.id, True)
    assert tables_host_of_shop(w.db, w.shop.id).id == t1.id


def test_a_shop_with_one_till_has_it_host_the_tables(w):
    t1, t2 = w.tills
    # Two tills and none named: nobody is guessed.
    assert tables_host_of_shop(w.db, w.shop.id) is None
    t2.is_active = False
    w.db.flush()
    assert tables_host_of_shop(w.db, w.shop.id).id == t1.id
    # Not the shop's main till for the rest (the shop Z keeps its rules).
    assert MT.main_till_of_shop(w.db, w.shop.id) is None


def test_several_marked_the_lowest_number_wins(w):
    t1, t2 = w.tills
    make_main(w, t2)
    make_main(w, t1)
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t1.id


# ── Where the shop Z comes from ──────────────────────────────────────────────


def test_only_the_main_till_runs_the_shop_z(w):
    t1, t2 = w.tills
    make_main(w, t1)
    # Even a till still marked master the old way is refused: the main till is the one.
    set_param(w, MT.SHOP_Z_MASTER_KEY, "machine", t2.id, True)
    with pytest.raises(HTTPException) as e:
        R.till_shop_z_status(str(t2.id), machine=t2, db=w.db)
    assert e.value.status_code == 403
    assert e.value.detail == MT.ONLY_FROM_MAIN
    out = R.till_shop_z_status(str(t1.id), machine=t1, db=w.db)
    assert out["mainTill"]["machineId"] == str(t1.id)
    assert {t["id"] for t in out["tills"]} == {str(t1.id), str(t2.id)}


def test_every_till_when_the_shop_says_so(w):
    t1, t2 = w.tills
    make_main(w, t1)
    outside_local_mode(w, t2)
    set_param(w, MT.SHOP_Z_FROM_KEY, "shop", w.shop.id, MT.Z_FROM_ANY)
    assert R.till_shop_z_status(str(t2.id), machine=t2, db=w.db)["zScope"] == "shop"
    assert MT.dashboard_z_refusal(w.db, w.shop) is None


def test_without_a_main_till_the_master_rule_stands(w):
    t1, t2 = w.tills
    set_param(w, MT.SHOP_Z_MASTER_KEY, "machine", t2.id, True)
    assert MT.till_shop_z_refusal(w.db, t2) is None
    assert MT.till_shop_z_refusal(w.db, t1) == MT.NOT_MASTER
    assert MT.dashboard_z_refusal(w.db, w.shop) is None


def test_the_dashboard_is_refused_the_shop_z_of_a_main_till_shop(w):
    t1, t2 = w.tills
    closed_shift(w, t1, 1)
    closed_shift(w, t2, 1)
    make_main(w, t1)
    outside_local_mode(w, t2)
    _heard(t1, 5)
    with pytest.raises(HTTPException) as e:
        dashboard_run(w, t1, t2)
    assert e.value.status_code == 409
    assert e.value.detail["code"] == MT.ONLY_FROM_MAIN
    assert e.value.detail["mainTill"]["posNumber"] == t1.pos_number
    # The wizard is told before it tries.
    cand = z_runs_router.get_z_candidates(
        w.shop.id, area_id=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )
    assert cand.dashboard_z_blocked is True and cand.main_till["machineId"] == str(t1.id)
    # «הקופה הראשית והדשבורד»: the dashboard may again.
    set_param(w, MT.SHOP_Z_FROM_KEY, "shop", w.shop.id, MT.Z_FROM_MAIN_AND_DASHBOARD)
    run = dashboard_run(w, t1, t2)
    assert run["status"] == ZRunStatus.COMPLETED


# ── The card ─────────────────────────────────────────────────────────────────


def test_a_main_till_the_cloud_lost_does_not_hold_the_z(w):
    t1, t2 = w.tills
    make_main(w, t1)
    outside_local_mode(w, t2)
    _heard(t1, 5)
    assert MT.dashboard_z_refusal(w.db, w.shop) is not None
    # Down for a while (crashed, off, will not start): the dashboard may produce the Z.
    _heard(t1, 3600)
    assert MT.dashboard_z_refusal(w.db, w.shop) is None


def test_the_card_sets_one_main_till_and_the_rule(w):
    t1, t2 = w.tills
    out = put(w, t2.id, MT.Z_FROM_MAIN_AND_DASHBOARD)
    assert out["mainTill"]["machineId"] == str(t2.id)
    assert out["zFrom"] == MT.Z_FROM_MAIN_AND_DASHBOARD
    assert out["printHost"]["machineId"] == str(t2.id)
    assert out["canEdit"] is True
    # Moving it leaves exactly one marked.
    out = put(w, t1.id)
    assert out["mainTill"]["machineId"] == str(t1.id)
    assert MT.is_on(TP.till_parameters_for_machine(w.db, t2).parameters.get(MT.MAIN_TILL_KEY)) is False
    assert out["zFrom"] == MT.Z_FROM_MAIN_AND_DASHBOARD  # untouched when not sent
    # None: no main till.
    assert put(w, None)["mainTill"] is None


def test_the_card_is_the_super_admins_and_waits_for_a_run(w):
    t1, t2 = w.tills
    manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id,
                   shop_id=w.shop.id, email="m@x", username="manager")
    w.db.add(manager)
    w.db.flush()
    seen = main_router.get_main_till(w.shop.id, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert seen["canEdit"] is False
    with pytest.raises(HTTPException) as e:
        put(w, t1.id, user=manager)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        put(w, t1.id, "something else")
    assert e.value.status_code == 422
    # A run under way: its master was chosen when it started.
    make_main(w, t1)
    outside_local_mode(w, t2)
    closed_shift(w, t1, 1)
    w.shift(t2, 1, status=ShiftStatus.OPEN)
    assert start(w, t1)["status"] == ZRunStatus.WAITING
    with pytest.raises(HTTPException) as e:
        put(w, t2.id)
    assert e.value.status_code == 409 and e.value.detail == "z_run_in_progress"


# ── One Z, by till and by waiter ─────────────────────────────────────────────


def _table_order(w, *, waiter, waiter_id, tx=None, parts=(), guests=2, number=5):
    zone = w.db.query(TableZone).filter(TableZone.shop_id == w.shop.id).first()
    if zone is None:
        zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
        w.db.add(zone)
        w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number)
    w.db.add(table)
    w.db.flush()
    order = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, table_number=number,
        status="paid", guests=guests, opened_at=NOW, closed_at=NOW,
        opened_by_pos_user_id=waiter_id, opened_by_pos_user_name=waiter,
        transaction_id=str(tx.id) if tx is not None else None,
        extras_json=json.dumps({"partials": [{"tx": str(p.id), "amount": 1} for p in parts]}) if parts else None,
    )
    w.db.add(order)
    w.db.flush()
    return order


def test_one_z_from_the_main_till_with_each_till_and_each_waiter(w):
    t1, t2 = w.tills
    make_main(w, t1)
    outside_local_mode(w, t2)
    cashier = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="yossi",
                      first_name="יוסי", last_name="כהן", pin_hash="x")
    w.db.add(cashier)
    w.db.flush()

    def counter_sale(s):
        tx = w.doc(t2, s, "30.00", method="card")
        tx.cashier_id = str(cashier.id)
        return tx

    # Till 1: table 5 (דנה), paid in two parts — one apart, then the rest — with a tip.
    _, (part, rest) = closed_shift(
        w, t1, 1,
        lambda s: w.doc(t1, s, "40.00"),
        lambda s: w.doc(t1, s, "60.00", method="card", tip="6.00", tip_method="card"),
    )
    _table_order(w, waiter="דנה", waiter_id="pu-dana", tx=rest, parts=[part], guests=3)
    # Till 2: a counter sale by יוסי, and a credit note for part of the table's bill.
    _, (sale, refund) = closed_shift(
        w, t2, 1,
        counter_sale,
        lambda s: w.doc(t2, s, "10.00", credit_note=True),
    )
    refund.refund_of_transaction_id = rest.id
    w.db.flush()

    run = start(w, t1)
    assert run["status"] == ZRunStatus.COMPLETED
    z = w.db.get(ZReport, uuid.UUID(run["zReportId"]))
    # One Z for the shop: numbered once, a section for each till.
    assert z.machine_id is None and z.z_number == 1
    assert {s["posNumber"] for s in z.per_machine} == {t1.pos_number, t2.pos_number}

    rows = {r["waiter"]: r for r in z.header["byWaiter"]}
    assert set(rows) == {"דנה", "יוסי כהן"}
    dana = rows["דנה"]
    assert (dana["salesCount"], dana["sales"], dana["refundsCount"], dana["refunds"]) == (2, "100.00", 1, "10.00")
    assert dana["net"] == "90.00" and dana["tips"] == "6.00"
    assert (dana["tables"], dana["guests"]) == (1, 3)
    assert (dana["cash"], dana["card"]) == ("30.00", "60.00")  # 40 cash − 10 cash refund; 60 card
    yossi = rows["יוסי כהן"]
    assert (yossi["salesCount"], yossi["net"], yossi["card"], yossi["tables"]) == (1, "30.00", "30.00", 0)
    # The rows add up to the Z.
    assert sum(Decimal(r["net"]) for r in rows.values()) == z.total_sales - z.total_refunds
    assert z.header["byWaiter"][0]["waiter"] == "דנה"  # the largest first

    # The paper: the till's summary and the full Z both carry it.
    for doc in (z_print.build_summary_document(z, None), z_print.build_print_document(z, None)):
        waiters = next(s for s in doc["sections"] if s["title"] == "מלצרים")
        labels = [r["label"] for r in waiters["rows"]]
        assert labels[0] == "דנה" and "יוסי כהן" in labels
        assert waiters["rows"][0]["value"].startswith("₪90.00") or "90.00" in waiters["rows"][0]["value"]

    # The dashboard's Z: as stored.
    detail = z_reports_router.get_z_report(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert detail.by_waiter_source == "stored"
    assert [r["waiter"] for r in detail.by_waiter] == ["דנה", "יוסי כהן"]


def test_a_z_built_before_the_breakdown_reads_it_from_its_documents(w):
    t1, t2 = w.tills
    closed_shift(w, t1, 1)
    closed_shift(w, t2, 1)
    run = dashboard_run(w, t1, t2)
    z = w.db.get(ZReport, uuid.UUID(str(run["zReportId"])))
    z.header = {k: v for k, v in z.header.items() if k != "byWaiter"}
    w.db.flush()
    detail = z_reports_router.get_z_report(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert detail.by_waiter_source == "documents"
    assert [(r["waiter"], r["net"]) for r in detail.by_waiter] == [(None, "20.00")]


def test_no_shifts_no_rows(w):
    assert waiter_breakdown(w.db, [], w.shop.id) == []


# ── The main till is down: another takes over ────────────────────────────────

LAN = "רשת מקומית (קופה ראשית)"


def _a_table(w, number=7):
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="גן")
    w.db.add(zone)
    w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number)
    w.db.add(table)
    w.db.flush()
    return table


def _heard(till, ago_seconds):
    from datetime import datetime, timedelta, timezone

    till.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=ago_seconds)


def test_a_till_takes_over_from_a_dead_main_till_with_its_tables(w):
    from app.schemas.tables import TablesReportIn
    from app.services import tables as T

    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    make_main(w, t1)
    table = _a_table(w)
    # The host mirrors an open table — the dishes too.
    cart = '{"lines":[{"name":"שניצל","qty":2}]}'
    order_id = uuid.uuid4()
    T.apply_local_report(w.db, t1, TablesReportIn.model_validate({"orders": [{
        "id": str(order_id), "tableId": str(table.id), "status": "open", "version": 3, "guests": 2,
        "itemCount": 2, "total": 96, "openedAt": NOW.isoformat(), "openedByPosUserName": "דנה",
        "cartJson": cart,
    }]}).orders)
    with pytest.raises(HTTPException) as e:
        T.host_seed(w.db, t2)
    assert e.value.detail == "not_the_tables_host"

    # The cloud still hears till 1: a network fault between the tills, not a dead host.
    _heard(t1, 5)
    with pytest.raises(HTTPException) as e:
        MT.take_over(w.db, t2, "מנהל")
    assert e.value.status_code == 409 and e.value.detail["code"] == "host_online"

    # Till 1 is gone: till 2 becomes the main till — tables, printing and the Z.
    _heard(t1, 3600)
    out = MT.take_over(w.db, t2, "מנהל")
    assert out["mainTill"]["machineId"] == str(t2.id) and out["previous"]["machineId"] == str(t1.id)
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t2.id
    assert tables_host_of_shop(w.db, w.shop.id).id == t2.id
    assert print_host_of_shop(w.db, w.shop.id).id == t2.id
    assert MT.till_shop_z_refusal(w.db, t2) is None
    assert MT.till_shop_z_refusal(w.db, t1) == MT.ONLY_FROM_MAIN
    # It starts from the cloud's copy, dishes and version included.
    seeded = {o["id"]: o for o in T.host_seed(w.db, t2)["orders"]}
    assert seeded[str(order_id)]["cartJson"] == cart
    assert seeded[str(order_id)]["version"] == 3 and seeded[str(order_id)]["status"] == "open"
    # Again: nothing to move.
    assert MT.take_over(w.db, t2)["previous"] is None


def test_a_named_tables_host_moves_too(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    set_param(w, "tablesHostTill", "machine", t1.id, True)
    set_param(w, "printHostTill", "machine", t1.id, True)
    _heard(t1, 3600)
    out = MT.take_over(w.db, t2)
    assert set(out["moved"]) == {"tablesHostTill", "printHostTill"}
    assert tables_host_of_shop(w.db, w.shop.id).id == t2.id
    assert print_host_of_shop(w.db, w.shop.id).id == t2.id


def test_no_takeover_outside_the_lan_mode(w):
    _, t2 = w.tills
    with pytest.raises(HTTPException) as e:
        MT.take_over(w.db, t2)
    assert e.value.detail == "tables_not_lan"


# ── "השרת הוחלף — יש לבדוק תקינות נתונים" (the owner, 08.10.2026) ────────────


def _switch_notices(w):
    from app.models.till_message import TillMessage, TillMessageReceipt
    from app.services.till_messages import SERVER_SWITCH_TITLE

    out = []
    for m in w.db.query(TillMessage).filter(TillMessage.title == SERVER_SWITCH_TITLE).all():
        tills = {str(r.machine_id) for r in w.db.query(TillMessageReceipt).filter(TillMessageReceipt.message_id == m.id)}
        out.append((m, tills))
    return out


def test_moving_the_main_till_on_the_card_tells_every_till_to_check_the_data(w):
    t1, t2 = w.tills
    put(w, t1.id)
    assert _switch_notices(w) == [], "naming the first main till is no switch"
    put(w, t1.id)
    assert _switch_notices(w) == [], "the same till again is no switch"
    put(w, t2.id)
    [(message, tills)] = _switch_notices(w)
    assert tills == {str(t1.id), str(t2.id)}
    assert message.display == "fullscreen" and message.created_by is None and message.expires_at is not None
    assert t1.name in message.body and t2.name in message.body and "תקינות נתונים" in message.body


def test_a_till_taking_over_tells_every_till_to_check_the_data(w):
    from app.routers import tables as tables_router
    from app.schemas.tables import TakeOverIn

    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    make_main(w, t1)
    _heard(t1, 3600)
    tables_router.take_over_host(str(t2.id), TakeOverIn(posUserName="מנהל"), BackgroundTasks(), machine=t2, db=w.db)
    [(message, tills)] = _switch_notices(w)
    assert tills == {str(t1.id), str(t2.id)}
    assert "מנהל" in message.body
    # Nothing moved (already the main till): no second notice.
    tables_router.take_over_host(str(t2.id), TakeOverIn(posUserName="מנהל"), BackgroundTasks(), machine=t2, db=w.db)
    assert len(_switch_notices(w)) == 1


def test_the_notice_says_what_moved_who_moved_it_and_what_to_check():
    from app.services.till_messages import server_switch_body

    body = server_switch_body({"name": "קופה 2", "posNumber": "2"}, {"name": "קופה 1", "posNumber": "1"}, "דנה")
    assert body.startswith("הקופה הראשית (שרת הסניף) הוחלפה מקופה 1 (#1) לקופה 2 (#2) על ידי דנה.")
    assert "סנכרון רשת מקומית" in body
