"""
Table management ("ניהול שולחנות", app/services/tables.py).

What each class pins, and how it could look fine while doing damage:

* **Locks** — a table entered on one till is refused to another with who holds it; the
  lock is re-entrant for its own till, extended by the heartbeat, expires on its own
  after `tablesLockMinutes`, is released on leave / send / pay, and only a manager can
  release another till's by force.
* **Versions** — every write names the version it is based on; a stale one is refused
  with the current order (no silent overwrite), and a retried write that already went
  through is answered, not refused.
* **The order's life** — open, send (kitchen), bill (awaiting payment, reset by a
  change), pay (never refused: the money moved; a stale version is flagged), cancel
  (reason, approval, items, an exception), move (to a free table only), void (left empty).
* **Scope** — a till sees its shop's shop-wide zones and its own point of sale's; the
  synced writes refuse a till in another mode; single-till reports are upserted by
  version.
* **The close of the day** — a Z is refused while synced tables are open, unless
  `blockCloseWithOpenTables` is off.
* **Dashboard** — numbers unique per shop, bulk add skips taken numbers, archive refused
  while open, the live view and the report's figures.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.audit_exception import AuditException
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop_area import ShopArea
from app.models.tables import DiningTable, TableEvent, TableOrder, TableZone
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import tables as R
from app.schemas.tables import (
    BulkTablesIn,
    DashboardCancelIn,
    LocalOrderIn,
    MergePrepareIn,
    TableMergeIn,
    TableRenameIn,
    ZoneUpdate,
    TableCancelIn,
    TableCreate,
    TableEnterIn,
    TableMoveIn,
    TablePayIn,
    TablePositionsIn,
    TableSaveIn,
    TablesReportIn,
    TableUpdate,
    TillLayoutIn,
    ZoneCreate,
)
from app.services import ably_notify
from app.services import tables as T
from app.services import till_parameters as TP
from app.services import z_runs as ZR
from app.services.permissions import Scope
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world

SYNCED = "מסונכרן בין הקופות"


# ── World ─────────────────────────────────────────────────────────────────────


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now = self.now + timedelta(**kw)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    db = world.db
    TP.ensure_builtin_parameters(db)
    world.params = {p.key: p for p in db.query(TillParameter).all()}
    set_param(world, "tablesMode", "shop", world.shop.id, SYNCED)

    world.clock = Clock()
    monkeypatch.setattr(T, "_now", world.clock)
    world.woken = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant_id, machine_id, event, body: world.woken.append((machine_id, event)),
    )

    world.hall = T.create_zone(db, world.shop, ZoneCreate(shopId=world.shop.id, name="אולם", layout="map"))
    world.t = {}
    for n in (1, 2, 3, 12):
        world.t[n] = T.create_table(db, world.hall, TableCreate(zoneId=world.hall.id, number=n))
    world.manager = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="mgr",
        first_name="מנהלת", last_name="רותי", pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
    )
    world.cashier = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="dana",
        first_name="דנה", pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
    )
    db.add_all([world.manager, world.cashier])
    db.commit()
    world.a, world.b = world.tills
    return world


def set_param(w, key, scope_type, scope_id, value):
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=w.params[key].id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


def run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def enter(w, till, table, name="דנה"):
    tasks = BackgroundTasks()
    out = R.enter_table(str(till.id), table.id, tasks, TableEnterIn(posUserId="pu-" + name, posUserName=name),
                        machine=till, db=w.db)
    run(tasks)
    return out


def cart(*lines):
    return json.dumps({"cartId": "c1", "lines": [{"id": l, "quantity": 1} for l in lines]})


def save(w, till, table, order_id, expected, *, action="save", lines=("l1",), total="50", request_id=None,
         guests=2, name="דנה"):
    tasks = BackgroundTasks()
    body = TableSaveIn(
        orderId=order_id, expectedVersion=expected, requestId=request_id or uuid.uuid4().hex, action=action,
        guests=guests, cartJson=cart(*lines), extrasJson=None, itemCount=len(lines), total=Decimal(total),
        posUserId="pu-" + name, posUserName=name,
    )
    out = R.save_table(str(till.id), table.id, body, tasks, machine=till, db=w.db)
    run(tasks)
    return out


def pay(w, till, table, order_id, expected, tx="tx-1", total="50", request_id=None):
    body = TablePayIn(orderId=order_id, expectedVersion=expected, requestId=request_id or uuid.uuid4().hex,
                      transactionId=tx, transactionNumber="1001", paidTotal=Decimal(total),
                      posUserId="pu-dana", posUserName="דנה")
    return R.pay_table(str(till.id), table.id, body, BackgroundTasks(), machine=till, db=w.db)


T_SCOPE_CANCEL = Scope.TABLE_CANCEL
T_SCOPE_UNLOCK = Scope.TABLE_UNLOCK


def reason(w, name="לקוח עזב"):
    return next(r for r in T.reasons_for(w.db, w.tenant.id) if r.name == name)


def cancel(w, till, table, order_id, expected, *, by=None, reason_name="לקוח עזב", text=None, request_id=None):
    auth = R._table_authority(T_SCOPE_CANCEL)(
        machine=till, elevation_token=None, operator_id=str((by or w.manager).id), db=w.db,
    )
    body = TableCancelIn(
        orderId=order_id, expectedVersion=expected, requestId=request_id or uuid.uuid4().hex,
        reasonId=reason(w, reason_name).id, reasonText=text,
        items=[{"name": "המבורגר", "quantity": 2, "total": 98}], total=Decimal("98"),
        posUserId="pu-dana", posUserName="דנה",
    )
    return R.cancel_table(str(till.id), table.id, body, BackgroundTasks(), machine=till, auth=auth, db=w.db)


# ── Locks ─────────────────────────────────────────────────────────────────────


class TestLocks:
    def test_another_till_is_refused_with_who_holds_it(self, w):
        enter(w, w.a, w.t[12], name="דנה")
        e = refused(enter, w, w.b, w.t[12], name="יוסי")
        assert e.status_code == 409
        assert e.detail["code"] == "table_locked"
        assert e.detail["table"]["number"] == 12
        lock = e.detail["lock"]
        assert (lock["posNumber"], lock["posUserName"], lock["machineName"]) == ("1", "דנה", "Till 1")

    def test_the_lock_is_reentrant_for_its_own_till(self, w):
        enter(w, w.a, w.t[12])
        assert enter(w, w.a, w.t[12], name="רון")["lock"]["mine"] is True
        assert w.db.get(DiningTable, w.t[12].id).lock_pos_user_name == "רון"

    def test_a_lock_expires_after_the_lock_minutes(self, w):
        enter(w, w.a, w.t[12])
        w.clock.advance(minutes=1, seconds=59)
        assert refused(enter, w, w.b, w.t[12]).detail["code"] == "table_locked"
        w.clock.advance(seconds=2)
        assert enter(w, w.b, w.t[12])["lock"]["machineId"] == str(w.b.id)

    def test_the_lock_minutes_come_from_the_parameter(self, w):
        set_param(w, "tablesLockMinutes", "shop", w.shop.id, 5)
        enter(w, w.a, w.t[12])
        w.clock.advance(minutes=4)
        assert refused(enter, w, w.b, w.t[12]).detail["code"] == "table_locked"
        w.clock.advance(minutes=2)
        enter(w, w.b, w.t[12])

    def test_the_heartbeat_keeps_it(self, w):
        enter(w, w.a, w.t[12])
        for _ in range(3):
            w.clock.advance(minutes=1, seconds=30)
            R.table_heartbeat(str(w.a.id), w.t[12].id, None, machine=w.a, db=w.db)
        assert refused(enter, w, w.b, w.t[12]).detail["code"] == "table_locked"

    def test_a_heartbeat_after_another_till_took_it_is_lock_lost(self, w):
        enter(w, w.a, w.t[12])
        w.clock.advance(minutes=3)
        enter(w, w.b, w.t[12])
        e = refused(R.table_heartbeat, str(w.a.id), w.t[12].id, None, machine=w.a, db=w.db)
        assert e.detail["code"] == "table_lock_lost"
        assert e.detail["lock"]["machineId"] == str(w.b.id)

    def test_release_frees_it_and_never_touches_another_tills(self, w):
        enter(w, w.a, w.t[12])
        assert R.release_table(str(w.b.id), w.t[12].id, BackgroundTasks(), None, machine=w.b, db=w.db) == {
            "released": False
        }
        assert refused(enter, w, w.b, w.t[12]).detail["code"] == "table_locked"
        R.release_table(str(w.a.id), w.t[12].id, BackgroundTasks(), None, machine=w.a, db=w.db)
        enter(w, w.b, w.t[12])

    def test_a_manager_releases_by_force_and_it_is_recorded(self, w):
        enter(w, w.a, w.t[12])
        auth = R._table_authority(T_SCOPE_UNLOCK)(
            machine=w.b, elevation_token=None, operator_id=str(w.manager.id), db=w.db,
        )
        R.force_release_table(str(w.b.id), w.t[12].id, BackgroundTasks(), None, machine=w.b, auth=auth, db=w.db)
        enter(w, w.b, w.t[12])
        event = w.db.query(TableEvent).filter(TableEvent.kind == "force_release").one()
        assert event.details["approvedBy"] == "מנהלת רותי"
        assert event.details["heldBy"]["machineId"] == str(w.a.id)

    def test_a_cashier_cannot_force_release(self, w):
        with pytest.raises(HTTPException) as caught:
            R._table_authority(T_SCOPE_UNLOCK)(
                machine=w.b, elevation_token=None, operator_id=str(w.cashier.id), db=w.db,
            )
        assert caught.value.status_code == 401
        assert caught.value.detail == "elevation_required"

    def test_other_tills_are_woken_not_the_one_acting(self, w):
        enter(w, w.a, w.t[12])
        assert ("%s" % w.b.id, "tables") in w.woken
        assert all(m != str(w.a.id) for m, _ in w.woken)
        assert all(m != str(w.other_till.id) for m, _ in w.woken)


# ── Versions ──────────────────────────────────────────────────────────────────


class TestVersions:
    def test_each_save_bumps_the_version(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        assert save(w, w.a, w.t[1], oid, None)["order"]["version"] == 1
        assert save(w, w.a, w.t[1], oid, 1, lines=("l1", "l2"))["order"]["version"] == 2

    def test_a_stale_write_is_refused_with_the_current_order(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        save(w, w.a, w.t[1], oid, 1, lines=("l1", "l2"), total="80")
        e = refused(save, w, w.a, w.t[1], oid, 1, lines=("l9",))
        assert e.status_code == 409 and e.detail["code"] == "table_version_conflict"
        assert e.detail["order"]["version"] == 2
        assert e.detail["order"]["total"] == 80.0
        # Nothing was overwritten.
        assert json.loads(w.db.get(TableOrder, oid).cart_json)["lines"][1]["id"] == "l2"

    def test_opening_a_table_someone_else_opened_meanwhile_is_refused(self, w):
        enter(w, w.a, w.t[1])
        save(w, w.a, w.t[1], uuid.uuid4(), None, action="leave")
        enter(w, w.b, w.t[1])
        e = refused(save, w, w.b, w.t[1], uuid.uuid4(), None)
        assert e.detail["code"] == "table_version_conflict"
        assert e.detail["order"] is not None

    def test_a_retry_of_a_write_that_went_through_is_answered(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        first = save(w, w.a, w.t[1], oid, 1, lines=("l1", "l2"), request_id="req-7")
        again = save(w, w.a, w.t[1], oid, 1, lines=("l1", "l2"), request_id="req-7")
        assert again["replayed"] is True
        assert again["order"]["version"] == first["order"]["version"] == 2

    def test_a_write_without_the_lock_is_refused(self, w):
        enter(w, w.b, w.t[1])
        e = refused(save, w, w.a, w.t[1], uuid.uuid4(), None)
        assert e.detail["code"] == "table_locked"
        assert w.db.query(TableOrder).count() == 0

    def test_a_write_on_an_order_closed_elsewhere_is_refused(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        pay(w, w.a, w.t[1], oid, 1)
        enter(w, w.a, w.t[1])
        assert refused(save, w, w.a, w.t[1], oid, 1).detail == {"code": "table_version_conflict", "order": None}
        assert refused(save, w, w.a, w.t[1], oid, None).detail["code"] == "table_version_conflict"

    def test_the_till_in_another_mode_is_refused(self, w):
        set_param(w, "tablesMode", "machine", w.a.id, "קופה אחת")
        assert refused(enter, w, w.a, w.t[1]).detail["code"] == "tables_not_synced"
        enter(w, w.b, w.t[1])


# ── The order's life ──────────────────────────────────────────────────────────


class TestLifecycle:
    def test_send_marks_the_kitchen_and_lets_go(self, w):
        enter(w, w.a, w.t[2])
        oid = uuid.uuid4()
        out = save(w, w.a, w.t[2], oid, None, action="send")
        assert out["order"]["sendCount"] == 1 and out["order"]["sentAt"]
        enter(w, w.b, w.t[2])  # free for the next till
        out = save(w, w.b, w.t[2], oid, 1, action="send", lines=("l1", "l2"))
        assert out["order"]["sendCount"] == 2
        state = R.get_tables_state(str(w.a.id), machine=w.a, db=w.db)
        row = next(t for t in state["tables"] if t["number"] == 2)
        assert row["state"] == "sent" and row["lock"] is None

    def test_the_bill_waits_for_payment_until_something_changes(self, w):
        enter(w, w.a, w.t[2])
        oid = uuid.uuid4()
        save(w, w.a, w.t[2], oid, None)
        assert save(w, w.a, w.t[2], oid, 1, action="bill")["order"]["billPrintedAt"]
        assert T.table_state(w.db.get(TableOrder, oid), None) == "awaiting_payment"
        # The same cart saved again keeps it; a changed one does not.
        assert save(w, w.a, w.t[2], oid, 2)["order"]["billPrintedAt"]
        assert save(w, w.a, w.t[2], oid, 3, lines=("l1", "l2"))["order"]["billPrintedAt"] is None

    def test_a_table_left_empty_is_freed(self, w):
        enter(w, w.a, w.t[2])
        oid = uuid.uuid4()
        assert save(w, w.a, w.t[2], oid, None, action="leave", lines=())["order"] is None
        assert w.db.query(TableOrder).count() == 0
        enter(w, w.a, w.t[2])
        save(w, w.a, w.t[2], oid, None)
        out = save(w, w.a, w.t[2], oid, 1, action="leave", lines=())
        assert out["order"]["status"] == "void"
        assert T.open_order(w.db, w.t[2].id) is None

    def test_a_table_that_sent_something_is_not_voided_by_emptying_it(self, w):
        enter(w, w.a, w.t[2])
        oid = uuid.uuid4()
        save(w, w.a, w.t[2], oid, None, action="send")
        enter(w, w.a, w.t[2])
        assert save(w, w.a, w.t[2], oid, 1, action="leave", lines=())["order"]["status"] == "open"

    def test_pay_closes_frees_and_is_idempotent(self, w):
        enter(w, w.a, w.t[3])
        oid = uuid.uuid4()
        save(w, w.a, w.t[3], oid, None)
        out = pay(w, w.a, w.t[3], oid, 1, tx="tx-9", total="45")
        assert out["conflict"] is False and out["order"]["status"] == "paid"
        assert out["order"]["transactionId"] == "tx-9"
        assert pay(w, w.a, w.t[3], oid, 1, tx="tx-9")["replayed"] is True
        enter(w, w.b, w.t[3])
        assert T.open_order(w.db, w.t[3].id) is None
        assert float(w.db.get(TableOrder, oid).paid_total) == 45.0

    def test_pay_on_a_stale_version_is_kept_and_flagged(self, w):
        enter(w, w.a, w.t[3])
        oid = uuid.uuid4()
        save(w, w.a, w.t[3], oid, None)
        w.clock.advance(minutes=5)  # A went quiet; B took the table and added to it
        enter(w, w.b, w.t[3])
        save(w, w.b, w.t[3], oid, 1, lines=("l1", "l2"))
        out = pay(w, w.a, w.t[3], oid, 1, tx="tx-a")
        assert out["conflict"] is True
        order = w.db.get(TableOrder, oid)
        assert order.status == "paid" and order.pay_conflict is True
        # A's payment does not take B's lock away.
        assert w.db.get(DiningTable, w.t[3].id).lock_machine_id == w.b.id

    def test_a_second_sale_for_a_paid_order_is_recorded_not_merged(self, w):
        enter(w, w.a, w.t[3])
        oid = uuid.uuid4()
        save(w, w.a, w.t[3], oid, None)
        pay(w, w.a, w.t[3], oid, 1, tx="tx-1")
        out = pay(w, w.a, w.t[3], oid, 1, tx="tx-2")
        assert out["conflict"] is True
        assert w.db.get(TableOrder, oid).transaction_id == "tx-1"
        assert w.db.query(TableEvent).filter(TableEvent.kind == "pay_duplicate").count() == 1

    def test_pay_is_taken_even_after_the_mode_was_switched_off(self, w):
        enter(w, w.a, w.t[3])
        oid = uuid.uuid4()
        save(w, w.a, w.t[3], oid, None)
        set_param(w, "tablesMode", "machine", w.a.id, "כבוי")
        assert pay(w, w.a, w.t[3], oid, 1)["order"]["status"] == "paid"


class TestCancel:
    def _open(self, w, table):
        enter(w, w.a, table)
        oid = uuid.uuid4()
        save(w, w.a, table, oid, None, total="98")
        return oid

    def test_cancelled_with_reason_approver_items_and_an_exception(self, w):
        oid = self._open(w, w.t[12])
        out = cancel(w, w.a, w.t[12], oid, 1)
        assert out["order"]["status"] == "cancelled"
        order = w.db.get(TableOrder, oid)
        assert order.cancel_reason_id == reason(w).id
        assert order.cancel_approved_by_name == "מנהלת רותי"
        assert order.cancel_approved_by_pos_user_id == str(w.manager.id)
        assert order.closed_by_pos_user_name == "דנה"
        assert order.cancelled_items == [{"name": "המבורגר", "quantity": 2.0, "total": 98.0}]
        exc = w.db.query(AuditException).filter(AuditException.exception_type == "table_cancelled").one()
        assert float(exc.amount) == 98.0 and exc.machine_id == w.a.id
        assert exc.details["tableNumber"] == 12 and exc.details["reason"] == "לקוח עזב"
        enter(w, w.b, w.t[12])  # free again

    def test_a_reason_that_asks_for_text_needs_it(self, w):
        oid = self._open(w, w.t[12])
        e = refused(cancel, w, w.a, w.t[12], oid, 1, reason_name="אחר")
        assert e.status_code == 400 and e.detail == "reason_note_required"
        assert cancel(w, w.a, w.t[12], oid, 1, reason_name="אחר", text="ריב")["order"]["status"] == "cancelled"
        assert w.db.get(TableOrder, oid).cancel_reason_text == "ריב"

    def test_cancel_is_strict_on_the_version(self, w):
        oid = self._open(w, w.t[12])
        save(w, w.a, w.t[12], oid, 1, lines=("l1", "l2"))
        assert refused(cancel, w, w.a, w.t[12], oid, 1).detail["code"] == "table_version_conflict"
        assert w.db.get(TableOrder, oid).status == "open"

    def test_a_cashier_alone_cannot_cancel(self, w):
        with pytest.raises(HTTPException) as caught:
            R._table_authority(T_SCOPE_CANCEL)(
                machine=w.a, elevation_token=None, operator_id=str(w.cashier.id), db=w.db,
            )
        assert caught.value.status_code == 401

    def test_an_inactive_reason_is_refused(self, w):
        oid = self._open(w, w.t[12])
        r = reason(w)
        r.is_active = False
        w.db.commit()
        auth = R._table_authority(T_SCOPE_CANCEL)(
            machine=w.a, elevation_token=None, operator_id=str(w.manager.id), db=w.db,
        )
        body = TableCancelIn(orderId=oid, expectedVersion=1, reasonId=r.id)
        e = refused(R.cancel_table, str(w.a.id), w.t[12].id, body, BackgroundTasks(), machine=w.a, auth=auth, db=w.db)
        assert e.status_code == 404 and e.detail == "reason_not_found"
        assert r.name not in [x.name for x in T.reasons_for(w.db, w.tenant.id)]


class TestMove:
    def test_the_order_moves_to_a_free_table_and_both_are_free(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        body = TableMoveIn(orderId=oid, expectedVersion=1, requestId="m1", targetTableId=w.t[2].id)
        out = R.move_table(str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)
        assert out["order"]["tableId"] == str(w.t[2].id) and out["order"]["version"] == 2
        assert T.open_order(w.db, w.t[1].id) is None
        assert T.open_order(w.db, w.t[2].id).id == oid
        enter(w, w.b, w.t[1])
        enter(w, w.b, w.t[2])
        assert w.db.query(TableEvent).filter(TableEvent.kind == "move").one().details["fromNumber"] == 1

    def test_never_onto_an_occupied_table(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        enter(w, w.a, w.t[2])
        save(w, w.a, w.t[2], uuid.uuid4(), None, action="leave")
        body = TableMoveIn(orderId=oid, expectedVersion=1, requestId="m1", targetTableId=w.t[2].id)
        e = refused(R.move_table, str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)
        assert e.detail["code"] == "table_target_occupied"
        assert w.db.get(DiningTable, w.t[2].id).lock_machine_id is None

    def test_never_onto_a_table_another_till_is_in(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        enter(w, w.b, w.t[2])
        body = TableMoveIn(orderId=oid, expectedVersion=1, requestId="m1", targetTableId=w.t[2].id)
        e = refused(R.move_table, str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)
        assert e.detail["code"] == "table_target_locked"
        assert T.open_order(w.db, w.t[1].id).id == oid

    def test_not_onto_itself(self, w):
        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None)
        body = TableMoveIn(orderId=oid, expectedVersion=1, targetTableId=w.t[1].id)
        e = refused(R.move_table, str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)
        assert e.status_code == 400


# ── Scope ─────────────────────────────────────────────────────────────────────


class TestScope:
    def test_a_till_sees_shop_wide_zones_and_its_own_area(self, w):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        w.b.area_id = bar.id
        zone = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        stool = T.create_table(w.db, zone, TableCreate(zoneId=zone.id, number=50))
        w.db.commit()
        numbers = lambda till: {t["number"] for t in R.get_tables_state(str(till.id), machine=till, db=w.db)["tables"]}  # noqa: E731
        assert 50 in numbers(w.b) and 12 in numbers(w.b)
        assert 50 not in numbers(w.a)
        assert refused(enter, w, w.a, stool).detail == "table_not_found"

    def test_another_shops_table_is_not_found(self, w):
        set_param(w, "tablesMode", "shop", w.other_shop.id, SYNCED)
        e = refused(enter, w, w.other_till, w.t[1])
        assert (e.status_code, e.detail) == (404, "table_not_found")

    def test_the_state_carries_the_reasons_and_lock_minutes(self, w):
        out = R.get_tables_state(str(w.a.id), machine=w.a, db=w.db)
        assert out["mode"] == "synced" and out["lockMinutes"] == 2
        assert [r["name"] for r in out["cancelReasons"]] == [n for n, _ in T.DEFAULT_REASONS]
        assert out["blockCloseWithOpenTables"] is True


class TestSingleTillReport:
    def order(self, w, table, *, status="open", version=1, **extra):
        return LocalOrderIn.model_validate({
            "id": extra.pop("id", str(uuid.uuid4())), "tableId": str(table.id), "status": status,
            "version": version, "total": 120, "itemCount": 3, "guests": 2,
            "openedAt": NOW.isoformat(), "openedByPosUserName": "דנה", **extra,
        })

    def test_upserted_newest_version_wins(self, w):
        o = self.order(w, w.t[1])
        R.report_local_tables(str(w.a.id), TablesReportIn(orders=[o]), machine=w.a, db=w.db)
        paid = self.order(w, w.t[1], id=str(o.id), status="paid", version=3, closedAt=NOW.isoformat(),
                          transactionId="tx-5", paidTotal=120)
        R.report_local_tables(str(w.a.id), TablesReportIn(orders=[paid]), machine=w.a, db=w.db)
        stale = self.order(w, w.t[1], id=str(o.id), status="open", version=2)
        out = R.report_local_tables(str(w.a.id), TablesReportIn(orders=[stale]), machine=w.a, db=w.db)
        assert out["accepted"] == [str(o.id)]
        row = w.db.get(TableOrder, o.id)
        assert (row.status, row.version, row.source, row.transaction_id) == ("paid", 3, "local", "tx-5")

    def test_a_local_order_never_blocks_a_synced_one(self, w):
        R.report_local_tables(str(w.a.id), TablesReportIn(orders=[self.order(w, w.t[1])]), machine=w.a, db=w.db)
        enter(w, w.b, w.t[1])
        save(w, w.b, w.t[1], uuid.uuid4(), None)

    def test_another_shops_table_is_skipped(self, w):
        out = R.report_local_tables(
            str(w.other_till.id), TablesReportIn(orders=[self.order(w, w.t[1])]), machine=w.other_till, db=w.db,
        )
        assert out["accepted"] == [] and len(out["skipped"]) == 1

    def test_a_cancelled_one_is_an_exception(self, w):
        o = self.order(w, w.t[1], status="cancelled", closedAt=NOW.isoformat(),
                       cancelReasonId=str(reason(w).id), cancelApprovedByName="רותי",
                       cancelledItems=[{"name": "פיצה", "quantity": 1, "total": 120}])
        R.report_local_tables(str(w.a.id), TablesReportIn(orders=[o]), machine=w.a, db=w.db)
        R.report_local_tables(str(w.a.id), TablesReportIn(orders=[o]), machine=w.a, db=w.db)
        assert w.db.query(AuditException).filter(AuditException.exception_type == "table_cancelled").count() == 1


# ── The close of the day ──────────────────────────────────────────────────────


class TestZBlockedByOpenTables:
    def _closed_shift(self, w):
        from app.models.shift import ShiftStatus

        s = w.shift(w.a, 1, status=ShiftStatus.CLOSED)
        w.doc(w.a, s, "10.00")
        w.db.commit()

    def _z(self, w):
        return ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=w.a.id)], now=NOW)

    def test_refused_while_a_synced_table_is_open(self, w):
        self._closed_shift(w)
        enter(w, w.a, w.t[12])
        save(w, w.a, w.t[12], uuid.uuid4(), None, total="77")
        e = refused(self._z, w)
        assert e.status_code == 409 and e.detail["code"] == "open_tables_block_z"
        assert [(t["number"], t["total"]) for t in e.detail["tables"]] == [(12, 77.0)]

    def test_goes_ahead_when_the_parameter_is_off(self, w):
        self._closed_shift(w)
        set_param(w, "blockCloseWithOpenTables", "shop", w.shop.id, False)
        enter(w, w.a, w.t[12])
        save(w, w.a, w.t[12], uuid.uuid4(), None)
        assert self._z(w) is not None

    def test_goes_ahead_once_the_tables_are_paid(self, w):
        self._closed_shift(w)
        enter(w, w.a, w.t[12])
        oid = uuid.uuid4()
        save(w, w.a, w.t[12], oid, None)
        pay(w, w.a, w.t[12], oid, 1)
        assert self._z(w) is not None

    def test_an_area_z_counts_its_zones_and_the_shop_wide_ones_only(self, w):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        zone = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        stool = T.create_table(w.db, zone, TableCreate(zoneId=zone.id, number=50))
        w.b.area_id = bar.id
        w.db.commit()
        enter(w, w.b, stool)
        save(w, w.b, stool, uuid.uuid4(), None)
        other = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Terrace")
        w.db.add(other)
        w.db.flush()
        assert T.open_tables_blocking(w.db, w.shop, other.id) == []
        assert [t["number"] for t in T.open_tables_blocking(w.db, w.shop, bar.id)] == [50]
        assert [t["number"] for t in T.open_tables_blocking(w.db, w.shop)] == [50]


# ── Dashboard ─────────────────────────────────────────────────────────────────


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


class TestDashboard:
    def test_numbers_are_unique_per_shop(self, w):
        body = TableCreate(zoneId=w.hall.id, number=12)
        e = refused(R.create_table, body, BackgroundTasks(), **ctx(w))
        assert e.detail == {"code": "table_number_taken", "number": 12}
        e = refused(R.update_table, w.t[1].id, TableUpdate(number=2), BackgroundTasks(), **ctx(w))
        assert e.detail["code"] == "table_number_taken"

    def test_bulk_add_skips_taken_numbers(self, w):
        out = R.bulk_tables(w.hall.id, BulkTablesIn(**{"from": 1, "to": 15}), BackgroundTasks(), **ctx(w))
        assert out["skipped"] == [1, 2, 3, 12]
        assert out["created"] == [4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15]
        layout = R.get_layout(w.shop.id, **ctx(w))
        tables = [t for t in layout["tables"] if t["zoneId"] == str(w.hall.id)]
        assert len(tables) == 15
        assert all(0 <= t["x"] <= 1000 and 0 <= t["y"] <= 700 for t in tables)

    def test_positions_are_saved_in_one_write(self, w):
        items = [{"id": str(w.t[1].id), "x": 300, "y": 200, "rotation": 45}]
        R.save_positions(w.hall.id, TablePositionsIn(items=items), BackgroundTasks(), **ctx(w))
        t = w.db.get(DiningTable, w.t[1].id)
        assert (t.x, t.y, t.rotation) == (300, 200, 45)
        foreign = [{"id": str(uuid.uuid4()), "x": 1, "y": 1}]
        assert refused(R.save_positions, w.hall.id, TablePositionsIn(items=foreign), BackgroundTasks(),
                       **ctx(w)).status_code == 400

    def test_an_open_table_cannot_be_archived(self, w):
        enter(w, w.a, w.t[1])
        save(w, w.a, w.t[1], uuid.uuid4(), None)
        e = refused(R.archive_table, w.t[1].id, BackgroundTasks(), **ctx(w))
        assert e.detail["code"] == "table_has_open_order"
        assert refused(R.archive_zone, w.hall.id, BackgroundTasks(), **ctx(w)).detail["code"] == "table_has_open_order"
        R.archive_table(w.t[2].id, BackgroundTasks(), **ctx(w))
        assert w.db.get(DiningTable, w.t[2].id).archived_at is not None

    def test_a_table_a_single_till_has_open_cannot_be_archived_either(self, w):
        """Removed, it would vanish from the till with its order still open there."""
        from datetime import timedelta
        from decimal import Decimal

        w.db.add(TableOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=w.t[3].id, zone_id=w.hall.id,
            table_number=w.t[3].number, status="open", source="local", total=Decimal("10.00"),
            opened_at=NOW - timedelta(minutes=5), updated_at=NOW,
        ))
        w.db.flush()
        e = refused(R.archive_table, w.t[3].id, BackgroundTasks(), **ctx(w))
        assert e.detail["code"] == "table_has_open_order"

    def test_a_shop_manager_of_another_shop_is_refused(self, w):
        from app.models.user import User, UserRole

        north = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="n@x",
                     username="north", shop_id=w.other_shop.id)
        w.db.add(north)
        w.db.commit()
        assert refused(R.get_layout, w.shop.id, **ctx(w, north)).status_code == 403

    def test_the_live_view(self, w):
        enter(w, w.a, w.t[12])
        save(w, w.a, w.t[12], uuid.uuid4(), None, total="64", guests=4)
        w.clock.advance(minutes=25)
        out = R.live_tables(w.shop.id, **ctx(w))
        row = next(t for t in out["tables"] if t["number"] == 12)
        assert row["order"]["total"] == 64.0 and row["minutesOpen"] == 25
        assert out["summary"] == {"openTables": 1, "openTotal": 64.0, "guests": 4}

    def test_a_stuck_table_cancelled_from_the_dashboard(self, w):
        enter(w, w.a, w.t[12])
        oid = uuid.uuid4()
        save(w, w.a, w.t[12], oid, None, action="leave")
        R.dashboard_cancel_table(w.t[12].id, DashboardCancelIn(reasonId=reason(w).id), BackgroundTasks(), **ctx(w))
        order = w.db.get(TableOrder, oid)
        assert order.status == "cancelled" and order.cancel_approved_by_user_id == w.admin.id

    def test_the_report(self, w):
        for number, total, minutes in ((1, "100", 30), (1, "60", 50), (2, "40", 20)):
            enter(w, w.a, w.t[number])
            oid = uuid.uuid4()
            save(w, w.a, w.t[number], oid, None, total=total, guests=2)
            w.clock.advance(minutes=minutes)
            pay(w, w.a, w.t[number], oid, 1, tx=f"tx-{oid}", total=total)
        enter(w, w.a, w.t[3])
        oid = uuid.uuid4()
        save(w, w.a, w.t[3], oid, None, total="98")
        cancel(w, w.a, w.t[3], oid, 1)
        day = w.clock.now.date()
        out = R.tables_report(w.shop.id, day - timedelta(days=1), day + timedelta(days=1), **ctx(w))
        s = out["summary"]
        assert (s["paidOrders"], s["revenue"], s["cancelledOrders"], s["cancelledTotal"]) == (3, 200.0, 1, 98.0)
        assert s["avgSeatingMinutes"] == pytest.approx((30 + 50 + 20) / 3, abs=0.1)
        t1 = next(r for r in out["byTable"] if r["number"] == 1)
        assert (t1["orders"], t1["revenue"], t1["avgMinutes"]) == (2, 160.0, 40.0)
        assert out["byZone"][0]["zoneName"] == "אולם" and out["byZone"][0]["revenue"] == 200.0
        assert out["cancellations"]["byReason"] == [{"reason": "לקוח עזב", "count": 1, "total": 98.0}]
        assert out["cancellations"]["byEmployee"][0]["employee"] == "דנה"
        assert out["cancellations"]["rows"][0]["approvedBy"] == "מנהלת רותי"
        # The till reads the same report for its own shop ("דוחות שולחנות" on the till).
        till = R.get_tables_reports(str(w.a.id), day - timedelta(days=1), day + timedelta(days=1), machine=w.a, db=w.db)
        assert till == out

    def test_the_waiters_report_and_handing_a_table_to_another_waiter(self, w):
        # Dana opens and serves table 1; Avi opens table 2, then hands it to Dana's colleague Yossi.
        enter(w, w.a, w.t[1], name="דנה")
        o1 = uuid.uuid4()
        save(w, w.a, w.t[1], o1, None, total="100", guests=4, name="דנה")
        w.clock.advance(minutes=40)
        pay(w, w.a, w.t[1], o1, 1, tx=f"tx-{o1}", total="100")

        enter(w, w.a, w.t[2], name="אבי")
        o2 = uuid.uuid4()
        save(w, w.a, w.t[2], o2, None, total="60", guests=2, name="אבי")
        tasks = BackgroundTasks()
        body = TableSaveIn(
            orderId=o2, expectedVersion=1, requestId=uuid.uuid4().hex, action="save", guests=2,
            cartJson=cart("l1"), extrasJson=None, itemCount=1, total=Decimal("60"),
            posUserId="pu-אבי", posUserName="אבי", waiterPosUserId="pu-יוסי", waiterPosUserName="יוסי",
        )
        out = R.save_table(str(w.a.id), w.t[2].id, body, tasks, machine=w.a, db=w.db)
        assert (out["order"]["waiterPosUserId"], out["order"]["waiterName"]) == ("pu-יוסי", "יוסי")
        pay(w, w.a, w.t[2], o2, 2, tx=f"tx-{o2}", total="60")

        day = w.clock.now.date()
        rep = R.tables_report(w.shop.id, day - timedelta(days=1), day + timedelta(days=1), **ctx(w))
        by = {r["waiter"]: r for r in rep["byWaiter"]}
        assert set(by) == {"דנה", "יוסי"}
        assert (by["דנה"]["tables"], by["דנה"]["guests"], by["דנה"]["revenue"]) == (1, 4, 100.0)
        assert (by["דנה"]["avgCheck"], by["דנה"]["avgPerGuest"], by["דנה"]["avgMinutes"]) == (100.0, 25.0, 40.0)
        assert by["יוסי"]["revenue"] == 60.0
        rows = [r for r in rep["waiterTables"] if r["waiter"] == "יוסי"]
        assert [(r["tableNumber"], r["total"], r["status"]) for r in rows] == [(2, 60.0, "paid")]

    def test_a_table_opened_by_a_number_on_no_map(self, w):
        from app.schemas.tables import TableAdhocIn

        def adhoc(n):
            return R.adhoc_table(str(w.a.id), TableAdhocIn(number=n, posUserName="דנה"), BackgroundTasks(),
                                 machine=w.a, db=w.db)

        # A number on the map: that table.
        out = adhoc(2)
        assert (out["created"], out["table"]["id"]) == (False, str(w.t[2].id))
        # A number on no map: made in "שולחנות מזדמנים", and every till sees it from then on.
        out = adhoc(77)
        assert out["created"] is True and out["table"]["number"] == 77
        zone = w.db.get(TableZone, uuid.UUID(out["table"]["zoneId"]))
        assert zone.name == T.ADHOC_ZONE_NAME and zone.layout == "grid"
        assert any(t["number"] == 77 for t in R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)["tables"])
        # Again: the same table, and one zone for them all.
        assert adhoc(77)["table"]["id"] == out["table"]["id"]
        assert adhoc(78)["table"]["zoneId"] == out["table"]["zoneId"]
        # It is a table like any other: opened and saved.
        tid = uuid.UUID(out["table"]["id"])
        table = w.db.get(DiningTable, tid)
        enter(w, w.a, table)
        save(w, w.a, table, uuid.uuid4(), None)

    def test_items_moved_to_another_table_both_or_neither(self, w):
        from app.schemas.tables import TableTransferIn

        enter(w, w.a, w.t[1])
        src = uuid.uuid4()
        save(w, w.a, w.t[1], src, None, lines=("l1", "l2"), total="80")
        # The till enters the target to read it (free), then moves l2 there.
        enter(w, w.a, w.t[2])
        dst = uuid.uuid4()

        def transfer(src_version, target_version, src_lines, request=None):
            body = TableTransferIn(
                orderId=src, expectedVersion=src_version, requestId=request or uuid.uuid4().hex,
                cartJson=cart(*src_lines), extrasJson=None, itemCount=len(src_lines), total=Decimal("30"),
                targetTableId=w.t[2].id, targetOrderId=dst, targetExpectedVersion=target_version,
                targetCartJson=cart("l2"), targetExtrasJson=None, targetItemCount=1, targetTotal=Decimal("50"),
                posUserId="pu-דנה", posUserName="דנה",
            )
            return R.transfer_items(str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)

        out = transfer(1, None, ("l1",))
        assert out["order"]["version"] == 2 and out["target"]["total"] == 50.0
        there = w.db.get(TableOrder, dst)
        assert there.status == "open" and there.table_id == w.t[2].id
        # The target is let go; the source stays this till's.
        assert w.db.get(DiningTable, w.t[2].id).lock_machine_id is None
        assert w.db.get(DiningTable, w.t[1].id).lock_machine_id == w.a.id
        # A stale target is refused, and nothing is written.
        enter(w, w.a, w.t[2])
        e = refused(transfer, 2, None, ("l1",))
        assert e.detail["code"] == "table_target_changed"
        assert w.db.get(TableOrder, src).version == 2
        # Everything moved: the source closes as merged into the target.
        enter(w, w.a, w.t[2])
        transfer(2, 1, ())
        gone = w.db.get(TableOrder, src)
        assert (gone.status, gone.merged_into_id) == ("merged", dst)

    def test_reservations_from_the_dashboard_and_the_till(self, w):
        from app.schemas.tables import ReservationIn, ReservationStatusIn, ReservationUpdate

        at = w.clock.now + timedelta(hours=2)
        made = R.create_reservation(
            ReservationIn(shopId=w.shop.id, tableId=w.t[3].id, reservedAt=at, guests=4, customerName="כהן",
                          phone="050-1234567"),
            BackgroundTasks(), **ctx(w),
        )
        assert (made["tableId"], made["status"], made["guests"]) == (str(w.t[3].id), "booked", 4)
        # The same table over the same time: refused.
        e = refused(
            R.create_reservation,
            ReservationIn(shopId=w.shop.id, tableId=w.t[3].id, reservedAt=at + timedelta(minutes=30), customerName="לוי"),
            BackgroundTasks(), **ctx(w),
        )
        assert e.detail["code"] == "reservation_overlap"
        # A till takes one with no table; both show on the tills.
        R.till_create_reservation(
            str(w.a.id), ReservationIn(reservedAt=at + timedelta(minutes=20), customerName="ישראלי", guests=2),
            BackgroundTasks(), machine=w.a, db=w.db,
        )
        state = R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)
        assert [r["customerName"] for r in state["reservations"]] == ["כהן", "ישראלי"]
        # The day's list in the dashboard, and moving one.
        from zoneinfo import ZoneInfo

        day = R.list_reservations(w.shop.id, at.astimezone(ZoneInfo("Asia/Jerusalem")).date(), **ctx(w))
        assert len(day) == 2 and day[0]["tableNumber"] == 3
        R.update_reservation(uuid.UUID(made["id"]), ReservationUpdate(guests=6), BackgroundTasks(),
                             shop_id=w.shop.id, **ctx(w))
        # They came: seated, and off the tills' list.
        R.till_reservation_status(str(w.a.id), uuid.UUID(made["id"]), ReservationStatusIn(status="seated"),
                                  BackgroundTasks(), machine=w.a, db=w.db)
        state = R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)
        assert [r["customerName"] for r in state["reservations"]] == ["ישראלי"]

    def test_a_part_paid_is_never_refused_and_always_recorded(self, w):
        from app.schemas.tables import TablePartPayIn

        enter(w, w.a, w.t[1])
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None, lines=("l1", "l2"), total="80")

        def part(version, tx, lines=("l2",)):
            body = TablePartPayIn(
                orderId=oid, expectedVersion=version, requestId=uuid.uuid4().hex, transactionId=tx,
                transactionNumber="9", amount=Decimal("30"), cartJson=cart(*lines),
                extrasJson=json.dumps({"partials": [{"tx": tx, "no": "9", "amount": 3000}]}),
                itemCount=len(lines), total=Decimal("50"), posUserId="pu-דנה", posUserName="דנה",
            )
            return R.pay_part(str(w.a.id), w.t[1].id, body, BackgroundTasks(), machine=w.a, db=w.db)

        out = part(1, "tx-a")
        assert out["conflict"] is False and out["order"]["version"] == 2 and out["order"]["total"] == 50.0
        # The same sale again: answered, nothing changes.
        assert part(2, "tx-a")["replayed"] is True
        # On a stale version: still recorded, flagged for a manager.
        out = part(1, "tx-b")
        assert out["conflict"] is True
        order = w.db.get(TableOrder, oid)
        assert order.pay_conflict is True
        assert [p["tx"] for p in json.loads(order.extras_json)["partials"]] == ["tx-a", "tx-b"]

    def test_the_report_range_is_checked(self, w):
        assert refused(R.tables_report, w.shop.id, date(2026, 9, 2), date(2026, 9, 1), **ctx(w)).status_code == 400


# ── Merge ("איחוד שולחנות") ────────────────────────────────────────────────────


def opened(w, till, table, lines, *, guests=2, total="50", send=False):
    """An open table with an order, left by its till (lock released)."""
    enter(w, till, table)
    oid = uuid.uuid4()
    save(w, till, table, oid, None, lines=lines, guests=guests, total=total, action="send" if send else "leave")
    return oid


def prepare(w, till, target, *sources):
    body = MergePrepareIn(sourceTableIds=[s.id for s in sources], posUserId="pu-dana", posUserName="דנה")
    return R.prepare_merge(str(till.id), target.id, body, BackgroundTasks(), machine=till, db=w.db)


def merge_body(prep, *, lines, guests, total="0", request_id=None, order_id=None):
    target = prep["target"]["order"]
    return TableMergeIn(
        orderId=order_id or (target["id"] if target else uuid.uuid4()),
        expectedVersion=target["version"] if target else None,
        requestId=request_id or uuid.uuid4().hex,
        cartJson=cart(*lines), extrasJson='{"sent":{"a":{"q":1}}}', itemCount=len(lines),
        total=Decimal(total), guests=guests,
        sources=[
            {"tableId": s["table"]["id"], "orderId": s["order"]["id"], "expectedVersion": s["order"]["version"]}
            for s in prep["sources"]
        ],
        posUserId="pu-dana", posUserName="דנה",
    )


def do_merge(w, till, target, body):
    return R.merge_tables(str(till.id), target.id, body, BackgroundTasks(), machine=till, db=w.db)


class TestMerge:
    def test_sources_merge_into_the_target_and_are_freed(self, w):
        target = opened(w, w.a, w.t[1], ("a",), guests=2, total="40")
        s1 = opened(w, w.a, w.t[2], ("b",), guests=3, total="30", send=True)
        s2 = opened(w, w.a, w.t[3], ("c", "d"), guests=1, total="25")
        prep = prepare(w, w.a, w.t[1], w.t[2], w.t[3])
        assert prep["target"]["order"]["id"] == str(target)
        assert {s["order"]["id"] for s in prep["sources"]} == {str(s1), str(s2)}
        out = do_merge(w, w.a, w.t[1], merge_body(prep, lines=("a", "b", "c", "d"), guests=6, total="95"))
        order = out["order"]
        assert order["id"] == str(target) and order["version"] == 2
        assert (order["guests"], order["total"], order["itemCount"]) == (6, 95.0, 4.0)
        # Table 2 had been sent: the merged order has what the kitchen has.
        assert order["sendCount"] == 1 and order["sentAt"]
        assert json.loads(order["cartJson"])["lines"][3]["id"] == "d"
        for oid, table in ((s1, w.t[2]), (s2, w.t[3])):
            src = w.db.get(TableOrder, oid)
            assert (src.status, src.merged_into_id) == ("merged", target)
            assert T.open_order(w.db, table.id) is None
        # Every table is free for anyone now.
        for table in (w.t[1], w.t[2], w.t[3]):
            assert w.db.get(DiningTable, table.id).lock_machine_id is None
        kinds = sorted(e.kind for e in w.db.query(TableEvent).filter(TableEvent.kind.in_(("merge", "merged"))))
        assert kinds == ["merge", "merged", "merged"]

    def test_into_a_free_table(self, w):
        s1 = opened(w, w.a, w.t[2], ("b",), guests=3)
        prep = prepare(w, w.a, w.t[1], w.t[2])
        assert prep["target"]["order"] is None
        new_id = uuid.uuid4()
        out = do_merge(w, w.a, w.t[1], merge_body(prep, lines=("b",), guests=3, order_id=new_id))
        assert out["order"]["id"] == str(new_id) and out["order"]["version"] == 1
        assert w.db.get(TableOrder, s1).status == "merged"
        # Seated since the source was.
        assert w.db.get(TableOrder, new_id).opened_at == w.db.get(TableOrder, s1).opened_at

    def test_refused_whole_when_another_till_holds_any(self, w):
        opened(w, w.a, w.t[1], ("a",))
        opened(w, w.a, w.t[2], ("b",))
        opened(w, w.a, w.t[3], ("c",))
        enter(w, w.b, w.t[3], name="יוסי")
        e = refused(prepare, w, w.a, w.t[1], w.t[2], w.t[3])
        assert e.status_code == 409 and e.detail["code"] == "table_locked"
        assert [(x["table"]["number"], x["lock"]["posUserName"]) for x in e.detail["tables"]] == [(3, "יוסי")]
        # None of them stayed locked by the refused till.
        assert w.db.get(DiningTable, w.t[1].id).lock_machine_id is None
        assert w.db.get(DiningTable, w.t[2].id).lock_machine_id is None

    def test_a_source_without_an_order_is_refused(self, w):
        opened(w, w.a, w.t[1], ("a",))
        e = refused(prepare, w, w.a, w.t[1], w.t[2])
        assert e.detail["code"] == "table_order_not_open"
        assert w.db.get(DiningTable, w.t[1].id).lock_machine_id is None

    def test_a_source_changed_since_it_was_read_refuses_everything(self, w):
        target = opened(w, w.a, w.t[1], ("a",))
        s1 = opened(w, w.a, w.t[2], ("b",))
        prep = prepare(w, w.a, w.t[1], w.t[2])
        # The same till saves table 2 again in between (it holds the lock).
        save(w, w.a, w.t[2], s1, 1, lines=("b", "b2"))
        enter(w, w.a, w.t[2])
        e = refused(do_merge, w, w.a, w.t[1], merge_body(prep, lines=("a", "b"), guests=4))
        assert e.detail["code"] == "table_version_conflict" and e.detail["table"]["number"] == 2
        assert w.db.get(TableOrder, s1).status == "open"
        assert w.db.get(TableOrder, target).version == 1

    def test_a_stale_target_refuses_everything(self, w):
        target = opened(w, w.a, w.t[1], ("a",))
        s1 = opened(w, w.a, w.t[2], ("b",))
        prep = prepare(w, w.a, w.t[1], w.t[2])
        save(w, w.a, w.t[1], target, 1, lines=("a", "a2"))
        enter(w, w.a, w.t[1])
        e = refused(do_merge, w, w.a, w.t[1], merge_body(prep, lines=("a", "b"), guests=4))
        assert e.detail["code"] == "table_version_conflict"
        assert w.db.get(TableOrder, s1).status == "open"

    def test_without_the_locks_it_is_refused(self, w):
        opened(w, w.a, w.t[1], ("a",))
        opened(w, w.a, w.t[2], ("b",))
        prep = prepare(w, w.a, w.t[1], w.t[2])
        w.clock.advance(minutes=3)  # the locks expired; another till took table 2
        enter(w, w.b, w.t[2])
        e = refused(do_merge, w, w.a, w.t[1], merge_body(prep, lines=("a", "b"), guests=4))
        assert e.detail["code"] == "table_locked"

    def test_a_retry_is_answered(self, w):
        opened(w, w.a, w.t[1], ("a",))
        opened(w, w.a, w.t[2], ("b",))
        prep = prepare(w, w.a, w.t[1], w.t[2])
        body = merge_body(prep, lines=("a", "b"), guests=4, request_id="merge-1")
        first = do_merge(w, w.a, w.t[1], body)
        again = do_merge(w, w.a, w.t[1], body)
        assert again["replayed"] is True and again["order"]["version"] == first["order"]["version"]

    def test_a_table_is_not_merged_into_itself(self, w):
        opened(w, w.a, w.t[1], ("a",))
        assert refused(prepare, w, w.a, w.t[1], w.t[1]).detail == "merge_duplicate_table"

    def test_merged_orders_are_not_in_the_report_and_the_target_pays_once(self, w):
        target = opened(w, w.a, w.t[1], ("a",), total="40")
        opened(w, w.a, w.t[2], ("b",), total="30")
        prep = prepare(w, w.a, w.t[1], w.t[2])
        do_merge(w, w.a, w.t[1], merge_body(prep, lines=("a", "b"), guests=4, total="70"))
        enter(w, w.a, w.t[1])
        pay(w, w.a, w.t[1], target, 2, total="70")
        day = w.clock.now.date()
        s = R.tables_report(w.shop.id, day, day, **ctx(w))["summary"]
        assert (s["paidOrders"], s["revenue"], s["cancelledOrders"]) == (1, 70.0, 0)


# ── Rename ─────────────────────────────────────────────────────────────────────


class TestRename:
    def rename(self, w, till, table, name, operator):
        actor = R.require_catalog_authority(Scope.CATALOG_WRITE)(
            machine=till, elevation_token=None, operator_id=str(operator.id), db=w.db,
        )
        body = TableRenameIn(name=name, posUserId=str(operator.id), posUserName="x")
        return R.rename_table(str(till.id), table.id, body, BackgroundTasks(), machine=till, actor=actor, db=w.db)

    def test_a_manager_renames_and_the_open_order_follows(self, w):
        oid = opened(w, w.a, w.t[12], ("a",))
        out = self.rename(w, w.a, w.t[12], "  VIP 1 ", w.manager)
        assert out["name"] == "VIP 1"
        assert w.db.get(TableOrder, oid).table_name == "VIP 1"
        state = R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)
        assert next(t for t in state["tables"] if t["number"] == 12)["name"] == "VIP 1"
        assert w.db.query(TableEvent).filter(TableEvent.kind == "rename").one().details == {"from": None, "to": "VIP 1"}
        assert self.rename(w, w.a, w.t[12], " ", w.manager)["name"] is None

    def test_a_cashier_cannot(self, w):
        with pytest.raises(HTTPException) as e:
            self.rename(w, w.a, w.t[12], "VIP", w.cashier)
        assert e.value.status_code == 401 and e.value.detail == "elevation_required"
        assert w.db.get(DiningTable, w.t[12].id).name is None

    def test_not_another_shops_table(self, w):
        north = PosUser(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id, username="n",
            pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
        )
        w.db.add(north)
        w.db.commit()
        assert refused(self.rename, w, w.other_till, w.t[12], "X", north).status_code == 404


# ── The cancel is an exception ("חריגה") ───────────────────────────────────────


class TestCancelException:
    def test_exactly_one_with_who_why_and_what_also_on_a_retry(self, w):
        enter(w, w.a, w.t[12])
        oid = uuid.uuid4()
        save(w, w.a, w.t[12], oid, None, total="98", lines=("l1", "l2"))
        w.clock.advance(minutes=42)
        cancel(w, w.a, w.t[12], oid, 1, request_id="c-1")
        cancel(w, w.a, w.t[12], oid, 1, request_id="c-1")  # the till retried
        rows = w.db.query(AuditException).filter(AuditException.exception_type == "table_cancelled").all()
        assert len(rows) == 1
        exc = rows[0]
        assert (exc.shop_id, exc.machine_id) == (w.shop.id, w.a.id)
        assert exc.pos_user_id == "pu-dana"
        d = exc.details
        assert (d["reason"], d["approvedBy"], d["cancelledBy"]) == ("לקוח עזב", "מנהלת רותי", "דנה")
        assert (d["tableNumber"], d["lineCount"], d["total"], d["openMinutes"]) == (12, 1, 98.0, 42)
        assert float(exc.amount) == 98.0

    def test_an_offline_cancellation_lands_with_the_report_once(self, w):
        item = LocalOrderIn.model_validate({
            "id": str(uuid.uuid4()), "tableId": str(w.t[1].id), "status": "cancelled", "version": 4,
            "total": 55, "itemCount": 2, "openedAt": NOW.isoformat(),
            "closedAt": (NOW + timedelta(minutes=15)).isoformat(),
            "closedByPosUserId": "pu-dana", "closedByPosUserName": "דנה",
            "cancelReasonId": str(reason(w).id), "cancelApprovedByName": "רותי",
            "cancelledItems": [{"name": "פיצה", "quantity": 1, "total": 40}, {"name": "קולה", "quantity": 1, "total": 15}],
        })
        for _ in range(2):
            R.report_local_tables(str(w.a.id), TablesReportIn(orders=[item]), machine=w.a, db=w.db)
        exc = w.db.query(AuditException).filter(AuditException.exception_type == "table_cancelled").one()
        assert (exc.details["approvedBy"], exc.details["reason"], exc.details["lineCount"]) == ("רותי", "לקוח עזב", 2)
        assert exc.details["openMinutes"] == 15


# ── The zone's sketch ──────────────────────────────────────────────────────────


class TestSketch:
    def test_saved_with_the_zone_and_sent_to_the_till(self, w):
        sketch = {"template": "cafe", "background": "tiles", "elements": [
            {"id": "w1", "kind": "wall", "x": 0, "y": 0, "w": 1000, "h": 12},
            {"id": "b1", "kind": "bar", "x": 600, "y": 40, "w": 300, "h": 60, "text": "בר"},
            {"id": "c1", "kind": "counter", "x": 100, "y": 500, "w": 500, "h": 150, "variant": "L", "stools": 6},
        ]}
        R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
        state = R.get_tables_state(str(w.a.id), machine=w.a, db=w.db)
        got = state["zones"][0]["sketch"]
        assert (got["template"], got["background"]) == ("cafe", "tiles")
        assert [(e["kind"], e["text"]) for e in got["elements"]] == [("wall", None), ("bar", "בר"), ("counter", None)]
        assert (got["elements"][2]["variant"], got["elements"][2]["stools"]) == ("L", 6)
        assert "stools" not in got["elements"][0]
        # Untouched by an edit that does not name it; cleared by null.
        R.update_zone(w.hall.id, ZoneUpdate(name="אולם גדול"), BackgroundTasks(), **ctx(w))
        assert w.db.get(type(w.hall), w.hall.id).sketch["template"] == "cafe"
        R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": None}), BackgroundTasks(), **ctx(w))
        assert w.db.get(type(w.hall), w.hall.id).sketch is None

    def test_drawn_lines_and_rectangles_are_kept(self, w):
        sketch = {"background": "wood", "elements": [
            {"id": "l1", "kind": "line", "x": 10, "y": 10, "w": 300, "h": 0, "points": [10, 10, 310, 10],
             "color": "#6B4423", "stroke": 6},
            {"id": "p1", "kind": "polyline", "x": 0, "y": 0, "w": 100, "h": 100,
             "points": [0, 0, 100, 0, 100, 100], "color": "#111827", "stroke": 12},
            {"id": "f1", "kind": "freehand", "x": 0, "y": 0, "w": 20, "h": 20, "points": [0, 0, 5.04, 7.96, 20, 20]},
            {"id": "r1", "kind": "rect", "x": 50, "y": 60, "w": 200, "h": 80, "color": "#ffffff", "filled": True},
        ]}
        R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": sketch}), BackgroundTasks(), **ctx(w))
        got = R.get_tables_state(str(w.a.id), machine=w.a, db=w.db)["zones"][0]["sketch"]["elements"]
        assert got[0]["points"] == [10, 10, 310, 10] and got[0]["color"] == "#6b4423" and got[0]["stroke"] == 6
        assert got[2]["points"] == [0, 0, 5.0, 8.0, 20, 20]
        assert got[3]["filled"] is True and "points" not in got[3]

    def test_a_drawn_shape_must_be_well_formed(self):
        from pydantic import ValidationError

        bad = [
            {"id": "x", "kind": "line", "x": 0, "y": 0, "w": 1, "h": 1},  # no points
            {"id": "x", "kind": "line", "x": 0, "y": 0, "w": 1, "h": 1, "points": [0, 0, 1]},  # odd
            {"id": "x", "kind": "line", "x": 0, "y": 0, "w": 1, "h": 1, "points": [0, 0, 9000, 0]},  # off canvas
            {"id": "x", "kind": "rect", "x": 0, "y": 0, "w": 1, "h": 1, "color": "red"},  # not #rrggbb
        ]
        for element in bad:
            with pytest.raises(ValidationError):
                ZoneUpdate.model_validate({"sketch": {"elements": [element]}})

    def test_an_unknown_shape_is_refused(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            ZoneUpdate.model_validate({"sketch": {"elements": [{"id": "x", "kind": "pool", "x": 0, "y": 0, "w": 1, "h": 1}]}})

    def test_new_tables_are_sized_from_the_canvas(self, w):
        out = R.bulk_tables(w.hall.id, BulkTablesIn(**{"from": 40, "to": 41}), BackgroundTasks(), **ctx(w))
        assert out["created"] == [40, 41]
        t = w.db.query(DiningTable).filter(DiningTable.number == 40).one()
        assert (t.width, t.height) == (84, 84)  # 12% of the 700-unit side


# ── The till's edit mode ("עריכה") ─────────────────────────────────────────────


class TestTillLayout:
    def save(self, w, till, body, operator=None):
        actor = R.require_catalog_authority(Scope.CATALOG_WRITE)(
            machine=till, elevation_token=None, operator_id=str((operator or w.manager).id), db=w.db,
        )
        tasks = BackgroundTasks()
        out = R.save_till_layout(str(till.id), TillLayoutIn.model_validate(body), tasks, machine=till, actor=actor, db=w.db)
        run(tasks)
        return out

    def refused(self, w, till, body, operator=None) -> HTTPException:
        e = refused(self.save, w, till, body, operator)
        w.db.rollback()
        return e

    def live(self, w):
        return {t.number: t for t in w.db.query(DiningTable).filter(DiningTable.archived_at.is_(None)).all()}

    def test_a_manager_adds_moves_edits_and_removes_in_one_save(self, w):
        R.update_zone(w.hall.id, ZoneUpdate.model_validate({"sketch": {"template": "cafe", "background": "wood", "elements": [
            {"id": "w1", "kind": "wall", "x": 0, "y": 0, "w": 1000, "h": 12}]}}), BackgroundTasks(), **ctx(w))
        w.woken.clear()
        out = self.save(w, w.a, {
            "zones": [
                {"clientId": "new-1", "name": " גינה ", "background": "tiles"},
                {"id": str(w.hall.id), "background": "dark"},
            ],
            "tables": [
                {"zoneClientId": "new-1", "number": 20, "x": 100, "y": 120, "shape": "round"},
                {"zoneId": str(w.hall.id), "number": 21},
                {"id": str(w.t[1].id), "x": 300, "y": 200},
                {"id": str(w.t[2].id), "name": "חלון", "seats": 6, "shape": "rect", "width": 120, "height": 70},
                {"id": str(w.t[3].id), "archive": True},
            ],
        })
        live = self.live(w)
        garden = next(z for z in out["zones"] if z["name"] == "גינה")
        assert garden["sketch"]["background"] == "tiles" and garden["layout"] == "map"
        assert (str(live[20].zone_id), live[20].x, live[20].y) == (garden["id"], 100, 120)
        assert live[20].width == 84 and live[20].shape == "round"  # 12% of the 700 side
        assert live[21].zone_id == w.hall.id
        assert (live[1].x, live[1].y) == (300, 200)
        assert (live[2].name, live[2].seats, live[2].shape, live[2].width) == ("חלון", 6, "rect", 120)
        assert 3 not in live
        hall = w.db.get(type(w.hall), w.hall.id)
        # Another floor; the drawn shapes stay.
        assert hall.sketch["background"] == "dark" and hall.sketch["elements"][0]["id"] == "w1"
        assert hall.sketch["template"] == "cafe"
        # Every till hears of it; the state answered is the saving till's.
        assert {str(m) for m, _ in w.woken} >= {str(w.b.id)}
        assert {t["number"] for t in out["tables"]} == {1, 2, 12, 20, 21}

    def test_two_tables_may_swap_numbers(self, w):
        self.save(w, w.a, {"tables": [
            {"id": str(w.t[1].id), "number": 2},
            {"id": str(w.t[2].id), "number": 1},
        ]})
        live = self.live(w)
        assert (live[1].id, live[2].id) == (w.t[2].id, w.t[1].id)

    def test_a_number_taken_refuses_the_whole_save(self, w):
        e = self.refused(w, w.a, {"tables": [
            {"id": str(w.t[1].id), "x": 400, "y": 400},
            {"id": str(w.t[3].id), "number": 12},
        ]})
        assert (e.status_code, e.detail["code"], e.detail["number"]) == (409, "table_number_taken", 12)
        # All or nothing: the move in the same save did not happen either.
        assert w.db.get(DiningTable, w.t[1].id).x != 400
        assert w.db.get(DiningTable, w.t[3].id).number == 3
        e = self.refused(w, w.a, {"tables": [{"zoneId": str(w.hall.id), "number": 2}]})
        assert e.detail["code"] == "table_number_taken"

    def test_numbers_are_unique_across_the_shop_not_only_what_the_till_sees(self, w):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        zone = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        T.create_table(w.db, zone, TableCreate(zoneId=zone.id, number=50))
        w.db.commit()
        e = self.refused(w, w.a, {"tables": [{"zoneId": str(w.hall.id), "number": 50}]})
        assert (e.detail["code"], e.detail["number"]) == ("table_number_taken", 50)
        # And a zone of another point of sale is not this till's to edit.
        e = self.refused(w, w.a, {"zones": [{"id": str(zone.id), "name": "X"}]})
        assert (e.status_code, e.detail) == (404, "zone_not_found")

    def test_a_table_in_use_cannot_move_change_number_or_go_but_can_be_named(self, w):
        opened(w, w.a, w.t[12], ("a",))
        for change in ({"x": 500, "y": 500}, {"number": 99}, {"archive": True}):
            e = self.refused(w, w.a, {"tables": [{"id": str(w.t[12].id), **change}]})
            assert (e.status_code, e.detail["code"], e.detail["table"]["number"]) == (409, "table_in_use", 12)
        self.save(w, w.a, {"tables": [{"id": str(w.t[12].id), "name": "VIP", "seats": 8}]})
        assert w.db.get(DiningTable, w.t[12].id).name == "VIP"

    def test_a_table_another_till_is_inside_is_in_use(self, w):
        enter(w, w.b, w.t[2])
        e = self.refused(w, w.a, {"tables": [{"id": str(w.t[2].id), "x": 10, "y": 10}]})
        assert e.detail["code"] == "table_in_use"
        # The same place (the till's rounding) is not a move.
        self.save(w, w.a, {"tables": [{"id": str(w.t[2].id), "x": w.t[2].x + 0.2, "y": w.t[2].y}]})

    def test_a_zone_goes_only_once_it_is_empty(self, w):
        e = self.refused(w, w.a, {"zones": [{"id": str(w.hall.id), "archive": True}]})
        assert (e.detail["code"], e.detail["tables"]) == ("zone_not_empty", [1, 2, 3, 12])
        self.save(w, w.a, {
            "zones": [{"clientId": "n", "name": "חדש"}, {"id": str(w.hall.id), "archive": True}],
            "tables": [{"id": str(t.id), "zoneClientId": "n"} for t in w.t.values()],
        })
        assert w.db.get(type(w.hall), w.hall.id).archived_at is not None
        assert len(self.live(w)) == 4

    def test_only_a_manager(self, w):
        e = self.refused(w, w.a, {"tables": [{"id": str(w.t[1].id), "x": 5, "y": 5}]}, operator=w.cashier)
        assert (e.status_code, e.detail) == (401, "elevation_required")

    def test_a_new_zone_needs_a_name_and_a_table_a_zone(self, w):
        assert self.refused(w, w.a, {"zones": [{"clientId": "n", "name": "  "}]}).detail == "zone_name_required"
        assert self.refused(w, w.a, {"tables": [{"number": 70}]}).detail == "table_zone_required"
        assert self.refused(w, w.a, {"tables": [{"zoneClientId": "nope", "number": 70}]}).detail == "zone_not_found"


# ── The LAN mode ("רשת מקומית (קופה ראשית)") ───────────────────────────────────

LAN = "רשת מקומית (קופה ראשית)"


def put_param(w, key, scope_type, scope_id, value):
    """Set a parameter at a scope, replacing what was there."""
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == w.params[key].id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete()
    w.db.commit()
    set_param(w, key, scope_type, scope_id, value)


class TestLanMode:
    def lan(self, w):
        put_param(w, "tablesMode", "shop", w.shop.id, LAN)

    def state(self, w, till):
        return R.get_tables_state(str(till.id), machine=till, db=w.db)

    def test_the_option_reads_as_lan(self):
        assert T.mode_of(LAN) == "lan" and T.mode_of("lan") == "lan"

    def test_the_state_names_the_tables_host_where_it_listens_and_the_secret(self, w):
        from app.services import printers as K

        self.lan(w)
        put_param(w, "tablesHostTill", "machine", w.b.id, True)
        K.report_print_host(w.db, w.b, "192.168.1.30", 8399)
        w.db.commit()
        a, b = self.state(w, w.a), self.state(w, w.b)
        assert a["mode"] == "lan"
        assert (a["lanHost"]["machineId"], a["lanHost"]["isSelf"]) == (str(w.b.id), False)
        assert (a["lanHost"]["lanAddress"], a["lanHost"]["port"]) == ("192.168.1.30", 8399)
        assert b["lanHost"]["isSelf"] is True
        # The shop's secret, the print server's: the same for its tills, not another shop's.
        assert a["lanSecret"] == b["lanSecret"] == K.print_secret(w.shop.id) != K.print_secret(w.other_shop.id)
        # The tables themselves are as ever.
        assert {t["number"] for t in a["tables"]} == {1, 2, 3, 12}

    def test_the_lowest_numbered_of_several_hosts_and_else_the_print_server(self, w):
        self.lan(w)
        assert self.state(w, w.a)["lanHost"] is None
        put_param(w, "printHostTill", "machine", w.b.id, True)
        assert self.state(w, w.a)["lanHost"]["machineId"] == str(w.b.id)
        put_param(w, "tablesHostTill", "machine", w.b.id, True)
        put_param(w, "tablesHostTill", "machine", w.a.id, True)
        assert self.state(w, w.b)["lanHost"]["machineId"] == str(w.a.id)  # register 1 before 2

    def test_no_secret_or_host_outside_the_lan_mode(self, w):
        out = self.state(w, w.a)
        assert "lanHost" not in out and "lanSecret" not in out

    def test_the_cloud_takes_no_synced_writes_from_a_lan_till(self, w):
        self.lan(w)
        e = refused(enter, w, w.a, w.t[12])
        assert (e.status_code, e.detail["code"]) == (409, "tables_not_synced")

    def test_the_host_reports_the_shops_orders_like_a_single_till(self, w):
        self.lan(w)
        item = LocalOrderIn.model_validate({
            "id": str(uuid.uuid4()), "tableId": str(w.t[2].id), "status": "open", "version": 3,
            "total": 120, "itemCount": 4, "openedAt": NOW.isoformat(),
        })
        R.report_local_tables(str(w.b.id), TablesReportIn(orders=[item]), machine=w.b, db=w.db)
        row = w.db.get(TableOrder, item.id)
        assert (row.source, row.status, row.version, float(row.total)) == ("local", "open", 3, 120.0)


def test_the_migration_is_a_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    import os

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert len(heads) == 1
