"""
"כרטיס שולחן" actions from the dashboard (app/services/table_actions.py; P:/specs/live-tables-cloud.md §2–§4,
the contract in §6).

What each test pins, and how it could look fine while doing damage:

* **The cloud's tables, done here** — each action writes the order as the till does, with a version check
  (a dashboard that showed another version is refused, never a silent overwrite), under the till's id
  derivations for its tickets: a second click is the same job, printed once. A fire is the till's fire
  (its seed, its KDS release); a rush and a reprint print what the kitchen has, by its rounds.
* **A till inside the table** (§4) — every action that changes it is refused with the till's name, and
  nothing is written; the bill and a kitchen reprint still go.
* **The LAN mode and the single till** — a command for the host (or that till) with the contract's params,
  202; nothing is changed here. Its answer, a refusal with who is inside, `not_host` sent on once, the
  timeout (expired: a late pull never gets it), the capability gate.
* **The bill** — always a till's: a command to the till that prints on the chosen printer.
* **Permissions** — the cancel and "החלף מלצר" need `tables_manage` besides `tables`.

Runs on the world of tests/test_course_auto_fire.py (SQLite).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException, Response

from app.database import Base
from app.models.device_command import DeviceCommand
from app.models.kds import KitchenDispatch
from app.models.pos_user import PosUser
from app.models.printers import KitchenPrinter
from app.models.tables import TableEvent, TableOrder
from app.routers import device_commands as DCR
from app.routers import tables as TR
from app.schemas.tables import DashboardCancelIn, TableActionIn, TableCreate
from app.services import course_auto_fire as F
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import device_commands as DC
from app.services import remote_table_cancel as RTC
from app.services import table_actions as TA
from app.services import table_card as TC
from app.services import table_void_tickets as VT
from app.services import tables as T
from test_course_auto_fire import (  # noqa: F401 - fixtures
    NOW,
    act,
    auto,
    configure,
    course,
    extras,
    f,
    fk,
    item,
    k,
    kd,
    line,
    order,
    release,
    reread,
    sent_row,
    starter_and_main,
    tickets,
    w,
    world,
)
from test_kitchen_printers import _run
from test_table_void_tickets import LAN, set_param


def put_param(w, key, scope_type, scope_id, value):
    """A till parameter's value at one level, replacing the one there."""
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one_or_none()
    if parameter is not None:
        w.db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == parameter.id, TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == scope_id,
        ).delete(synchronize_session=False)
        w.db.commit()
    set_param(w, key, scope_type, scope_id, value)


def _tables(db):
    for name in ("device_commands", "device_remote_states"):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())


def act_on(w, action, *, table=None, user=None, o=None, **body):
    """`POST /tables/tables/{id}/actions/{action}` as the dashboard sends it; (answer, status)."""
    tasks, response = BackgroundTasks(), Response()
    o = o or w.order
    payload = {"orderId": o.id, "expectedVersion": o.version, "requestId": body.pop("requestId", uuid.uuid4())}
    payload.update(body)
    out = TR.post_table_action(
        (table or w.table).id, action, TableActionIn(**payload), tasks,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db, response=response,
    )
    _run(tasks)
    return out, response.status_code or 200


def refused_by(w, action, **kw) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        act_on(w, action, **kw)
    return e.value


def held_by_till(w, table=None, *, till=None, name="דנה"):
    """A till inside the table: its lock live."""
    t = table or w.table
    t.lock_machine_id = (till or w.t1).id
    t.lock_pos_user_name = name
    t.lock_acquired_at = datetime.now(timezone.utc)
    t.lock_expires_at = datetime.now(timezone.utc) + timedelta(minutes=2)
    w.db.commit()


def order_at(w, table, lines, sent, **kw):
    """An open order on another table (the helper's own is always on table 12)."""
    row = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=table.zone_id,
        table_number=table.number, status="open", source=kw.pop("source", "synced"), version=3, guests=kw.pop("guests", 2),
        cart_json=json.dumps({"cartId": "c2", "lines": lines, **kw.pop("cart", {})}),
        extras_json=json.dumps({"sent": sent, "notes": {}}, ensure_ascii=False),
        item_count=Decimal(len(lines)), total=kw.pop("total", Decimal("40")), opened_machine_id=w.t1.id,
        updated_machine_id=w.t1.id, opened_by_pos_user_name="רון", send_count=1, sent_at=NOW - timedelta(minutes=3),
    )
    w.db.add(row)
    w.db.commit()
    return row


def nothing_written(w, o, version):
    assert reread(w, o).version == version
    assert tickets(w) == []


def events(w, o, kind):
    w.db.expire_all()
    return w.db.query(TableEvent).filter(TableEvent.order_id == o.id, TableEvent.kind == kind).all()


@pytest.fixture
def c(f):
    """Table 12 of the cloud's tables: the salad (starters) and the cola went out; the burger (mains) is held."""
    f.order = starter_and_main(f)
    return f


# ── The cloud's tables: done here ─────────────────────────────────────────────


def test_fire_is_the_tills_fire_once(c):
    out, code = act_on(c, "fire", courseId=str(c.main_c.id))
    assert code == 200 and out["mode"] == "direct" and out["action"] == "fire"
    seed = F.fire_seed(c.order.id, c.main_c.id)
    o = reread(c, c.order)
    x = extras(o)
    assert str(c.main_c.id) in x["fired"] and x["sent"]["l2"]["q"] == 2
    # A plain round in the log (not "auto"), under the till's seed for "הוצא עיקריות".
    assert x["log"][-1]["i"] == seed and "auto" not in x["log"][-1]
    assert (o.version, o.send_count, o.last_request_id) == (4, 2, None)
    jobs = tickets(c)
    assert [(j.id, j.printer_name, j.target_machine_id) for j in jobs] == [
        (F.fire_job_id(seed, c.p_kitchen), "Kitchen", c.t2.id),
    ]
    assert jobs[0].payload["fire"] == "עיקריות" and jobs[0].payload["sourceName"] == "דשבורד"
    assert out["printers"] == ["Kitchen"] and out["jobIds"] == [str(jobs[0].id)]
    send = events(c, o, "send")
    assert [(e.details["fire"], e.details["from"], e.details["courseName"]) for e in send] == [(True, "dashboard", "עיקריות")]
    # A second click: the course went already — the same fire, nothing new.
    again, _ = act_on(c, "fire", courseId=str(c.main_c.id), o=o)
    assert again["replayed"] is True and len(tickets(c)) == 1 and reread(c, o).version == 4


def test_fire_releases_the_course_on_the_kds(fk):
    fk.order = o = order(fk, [line("l1", fk.steak, 1, fk.starters), line("l2", fk.burger, 1, fk.main_c)],
                         {"l1": sent_row(fk.steak, 1, NOW - timedelta(minutes=16))})
    release(fk, till=fk.t1, ref=str(o.id), items=[item("l1:0", fk.steak, 1)], held=[item("l2:0", fk.burger, 1)])
    out, _ = act_on(fk, "fire", courseId=str(fk.main_c.id))
    assert out["kds"] is True
    assert fk.db.get(KitchenDispatch, F.fire_release_id(F.fire_seed(o.id, fk.main_c.id))) is not None


def test_a_course_not_held_is_refused(c):
    e = refused_by(c, "fire", courseId=str(c.starters.id))
    assert e.status_code == 409 and e.detail["code"] == "course_not_held"
    nothing_written(c, c.order, 3)


def test_the_version_the_dashboard_showed(c):
    e = refused_by(c, "fire", courseId=str(c.main_c.id), expectedVersion=2)
    assert e.status_code == 409 and e.detail["code"] == "order_changed" and e.detail["order"]["version"] == 3
    nothing_written(c, c.order, 3)
    e = refused_by(c, "note", orderId=uuid.uuid4(), text="x")
    assert e.detail["code"] == "order_changed"


@pytest.mark.parametrize("action,body", [
    ("fire", {"courseId": "MAIN"}),
    ("hold", {"courseId": "MAIN"}),
    ("rush", {}),
    ("note", {"text": "בלי גלוטן"}),
    ("set-waiter", {"waiterPosUserId": "WAITER"}),
    ("move", {"targetTableId": "FREE"}),
])
def test_a_till_inside_the_table_refuses_every_change(c, action, body):
    """§4: "פתוח כעת בקופה 1 (דנה)" — refused with who is inside; nothing written, nothing printed."""
    waiter = staff(c, "יוסי")
    free = T.create_table(c.db, c.hall, TableCreate(zoneId=c.hall.id, number=14))
    c.db.commit()
    body = {k: {"MAIN": str(c.main_c.id), "WAITER": waiter.id, "FREE": free.id}.get(v, v) for k, v in body.items()}
    held_by_till(c)
    e = refused_by(c, action, **body)
    assert e.status_code == 409 and e.detail["code"] == "table_in_use"
    assert e.detail["till"] == f"{c.t1.pos_number} (דנה)" and e.detail["lock"]["posUserName"] == "דנה"
    nothing_written(c, c.order, 3)


def test_the_bill_and_a_reprint_still_go_while_a_till_is_inside(c):
    _tables(c.db)
    held_by_till(c)
    out, code = act_on(c, "reprint")
    assert code == 200 and sorted(out["printers"]) == ["Bar", "Kitchen"]
    c.t2.capabilities = [TA.CAPABILITY]
    c.db.commit()
    out, code = act_on(c, "print-bill", machineId=c.t2.id)
    assert code == 202 and out["mode"] == "via_till" and out["action"] == "print-bill"


def test_rush_prints_what_the_kitchen_has_by_its_rounds_once(c):
    request = uuid.uuid4()
    out, _ = act_on(c, "rush", requestId=request)
    seed = TC.rush_seed(c.order.id, request)
    jobs = tickets(c)
    assert sorted(j.id for j in jobs) == sorted(VT.job_id_of(seed, p) for p in (c.p_kitchen, c.p_bar))
    lines = {j.printer_name: [(x["name"], x["quantity"]) for x in j.payload["lines"]] for j in jobs}
    # The salad and the cola went out; the held burger never did.
    assert lines == {"Kitchen": [("salad", 1.0)], "Bar": [("cola", 1.0)]}
    assert {j.payload["notice"] for j in jobs} == {"זרז!"} and {j.payload["isAddition"] for j in jobs} == {False}
    # A rush changes nothing of the order; it is in the history.
    assert reread(c, c.order).version == 3 and len(events(c, c.order, "rush")) == 1
    # The same click again: the same jobs.
    act_on(c, "rush", requestId=request)
    assert len(tickets(c)) == 2


def test_nothing_sent_nothing_to_rush(f):
    f.order = order(f, [line("l1", f.salad, 1, f.starters)], {})
    assert refused_by(f, "rush").detail["code"] == "nothing_sent"
    assert refused_by(f, "reprint").detail["code"] == "nothing_sent"


def test_reprint_a_round_or_lines_of_rounds(c):
    o = c.order
    x = extras(o)
    first = NOW - timedelta(minutes=16)
    x["log"] = [{"i": "r1", "a": F.till_time(first), "l": {"l1": 1}}, {"i": "r2", "a": F.till_time(first + timedelta(minutes=1)), "l": {"l3": 1}}]
    o.extras_json = json.dumps(x)
    c.db.commit()
    rounds = TC.reprint_rounds(F.cart_lines(o.cart_json), x)
    assert [(r.id, r.number, [rl.line_id for rl in r.lines]) for r in rounds] == [("r1", 1, ["l1"]), ("r2", 2, ["l3"])]
    request = uuid.uuid4()
    act_on(c, "reprint", requestId=request, scope="round", roundId="r2")
    jobs = tickets(c)
    assert [(j.printer_name, j.payload["notice"], [x["name"] for x in j.payload["lines"]]) for j in jobs] == [
        ("Bar", "הדפסה חוזרת", ["cola"]),
    ]
    assert jobs[0].id == VT.job_id_of(TC.reprint_seed(o.id, request), c.p_bar)
    act_on(c, "reprint", scope="lines", picks=[{"roundId": "r1", "lineId": "l1"}, {"roundId": "r1", "lineId": "nope"}])
    assert sorted(j.printer_name for j in tickets(c)) == ["Bar", "Kitchen"]


def test_hold_and_unhold_a_course(c):
    out, _ = act_on(c, "hold", courseId=str(c.main_c.id))
    o = reread(c, c.order)
    assert extras(o)["hold"] == [str(c.main_c.id)] and o.version == 4 and out["hold"] is True
    # A held course never goes by itself; the card says it is paused.
    assert TC.courses_of(o.cart_json, extras(o))[1]["paused"] is True
    out, _ = act_on(c, "hold", courseId=str(c.main_c.id), hold=False, o=o)
    o = reread(c, o)
    assert "hold" not in extras(o) and o.version == 5
    # The starters went to the kitchen: too late to hold them.
    assert refused_by(c, "hold", courseId=str(c.starters.id), o=o).detail["code"] == "course_already_out"


def staff(w, name, shop=None):
    pu = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, username=name,
                 first_name=name, pin_hash="x", is_active=True)
    w.db.add(pu)
    w.db.commit()
    return pu


def test_set_waiter(c):
    pu = staff(c, "יוסי")
    out, _ = act_on(c, "set-waiter", waiterPosUserId=pu.id)
    o = reread(c, c.order)
    assert (o.waiter_pos_user_id, o.waiter_pos_user_name, out["waiterName"]) == (str(pu.id), "יוסי", "יוסי")
    assert extras(o)["waiter"] == {"id": str(pu.id), "name": "יוסי"} and o.version == 4
    assert events(c, o, "waiter")[0].details["toName"] == "יוסי"
    other_shop = staff(c, "זר", shop=c.other_shop)
    assert refused_by(c, "set-waiter", waiterPosUserId=other_shop.id, o=o).detail["code"] == "waiter_not_found"
    # The waiters on shift: nobody clocked in — everyone active.
    names = [r["name"] for r in TR.get_table_waiters(shop_id=c.shop.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)["waiters"]]
    assert "יוסי" in names and "זר" not in names


def test_move_to_a_free_table(c):
    free = T.create_table(c.db, c.hall, TableCreate(zoneId=c.hall.id, number=14))
    taken = T.create_table(c.db, c.hall, TableCreate(zoneId=c.hall.id, number=15))
    c.db.commit()
    order_at(c, taken, [line("x", c.cola, 1)], {})
    assert refused_by(c, "move", targetTableId=taken.id).detail["code"] == "target_not_free"
    held_by_till(c, free, till=c.t2, name="רון")
    e = refused_by(c, "move", targetTableId=free.id)
    assert e.detail["code"] == "table_in_use" and e.detail["table"]["number"] == 14
    free.lock_machine_id = None
    c.db.commit()
    out, _ = act_on(c, "move", targetTableId=free.id)
    o = reread(c, c.order)
    assert (o.table_id, o.table_number, o.version, out["toLabel"]) == (free.id, 14, 4, "14")
    assert events(c, o, "move")[0].details["fromNumber"] == 12


def test_merge_another_open_table_into_this_one(c):
    t13 = T.create_table(c.db, c.hall, TableCreate(zoneId=c.hall.id, number=13))
    c.db.commit()
    src = order_at(c, t13, [line("l1", c.steak, 1, c.starters)], {"l1": sent_row(c.steak, 1, NOW - timedelta(minutes=3))})
    stale = {"tableId": t13.id, "orderId": src.id, "expectedVersion": 2}
    assert refused_by(c, "merge", sources=[stale]).detail["code"] == "source_not_open"
    held_by_till(c, t13, till=c.t2)
    assert refused_by(c, "merge", sources=[{**stale, "expectedVersion": 3}]).detail["code"] == "table_in_use"
    t13.lock_machine_id = None
    c.db.commit()
    out, _ = act_on(c, "merge", sources=[{**stale, "expectedVersion": 3}])
    o, s = reread(c, c.order), c.db.get(TableOrder, src.id)
    assert out["mergedOrderIds"] == [str(src.id)]
    assert (s.status, s.merged_into_id, s.version) == ("merged", o.id, 4)
    ids = [ln["id"] for ln in json.loads(o.cart_json)["lines"]]
    # The source's "l1" took a new id (the target has an l1): its kitchen bookkeeping went with it.
    assert len(ids) == 4 and len(set(ids)) == 4
    renamed = ids[-1]
    assert extras(o)["sent"][renamed]["n"] == "steak"
    assert (o.total, o.guests, o.version) == (Decimal("140.00"), 6, 4)


def test_basket_discount_is_refused_for_a_merge(c):
    t13 = T.create_table(c.db, c.hall, TableCreate(zoneId=c.hall.id, number=13))
    c.db.commit()
    src = order_at(c, t13, [line("l9", c.steak, 1)], {}, cart={"documentDiscountType": "PERCENTAGE", "documentDiscount": 1000})
    e = refused_by(c, "merge", sources=[{"tableId": t13.id, "orderId": src.id, "expectedVersion": 3}])
    assert e.detail["code"] == "merge_basket_discount"


def test_a_table_note_goes_with_the_next_round_once(c):
    act_on(c, "note", text="  בלי   גלוטן בכל המנות ")
    o = reread(c, c.order)
    note = extras(o)["tableNote"]
    assert note["t"] == "בלי גלוטן בכל המנות" and note["by"] == "admin" and "p" not in note and o.version == 4
    assert TC.table_note_of(extras(o))["printed"] is False
    # The next round to the kitchen (here the cloud's fire) prints it, and marks it printed.
    act_on(c, "fire", courseId=str(c.main_c.id), o=o)
    o = reread(c, o)
    [job] = tickets(c)
    assert job.payload["notice"] == "הערה לשולחן: בלי גלוטן בכל המנות"
    assert extras(o)["tableNote"]["p"] == F.fire_seed(o.id, c.main_c.id)
    # A rush never takes it: a reprint is not a round.
    act_on(c, "rush", o=o)
    assert {j.payload.get("notice") for j in tickets(c)} == {"הערה לשולחן: בלי גלוטן בכל המנות", "זרז!"}


def test_the_auto_fire_prints_the_note_too(c):
    auto(c)
    x = extras(c.order)
    x["tableNote"] = {"t": "אלרגיה לבוטנים", "by": "רון", "a": F.till_time(NOW)}
    c.order.extras_json = json.dumps(x, ensure_ascii=False)
    c.db.commit()
    assert len(F.run_pass(c.db, now=NOW)) == 1
    [job] = tickets(c)
    assert job.payload["notice"] == "הערה לשולחן: אלרגיה לבוטנים" and job.payload["fire"] == "עיקריות (אוטומטי)"


# ── The bill (§6.4) ───────────────────────────────────────────────────────────


def test_the_bill_is_a_command_to_the_till_that_prints(c):
    _tables(c.db)
    receipt = KitchenPrinter(
        id=uuid.uuid4(), tenant_id=c.tenant.id, shop_id=c.shop.id, name="קבלות", purpose="receipt",
        connection_type="usb", machine_id=c.t1.id,
    )
    c.db.add(receipt)
    c.db.commit()
    # No till said it takes the commands: nothing to choose.
    assert TR.get_bill_printers(c.table.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)["printers"] == []
    c.t1.capabilities = [TA.CAPABILITY]
    c.db.commit()
    choices = TR.get_bill_printers(c.table.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)["printers"]
    assert [(x["machineId"], x["printerId"], x["name"]) for x in choices] == [
        (str(c.t1.id), None, None), (str(c.t1.id), str(receipt.id), "קבלות"),
    ]
    out, code = act_on(c, "print-bill", printerId=receipt.id)
    assert code == 202 and out["hostMachineId"] == str(c.t1.id)
    row = c.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    assert row.action == "table_print_bill" and row.params["printerId"] == str(receipt.id)
    assert row.params["mode"] == "cloud" and row.params["orderVersion"] == 3
    assert refused_by(c, "print-bill", printerId=uuid.uuid4()).detail["code"] == "printer_not_found"


# ── The LAN mode: a command for the host ──────────────────────────────────────


@pytest.fixture
def lan(f):
    """The LAN mode, till 1 the tables host (its build takes the table commands); the host's copy of table 12."""
    _tables(f.db)
    set_param(f, "tablesMode", "shop", f.shop.id, LAN)
    set_param(f, "tablesHostTill", "machine", f.t1.id, True)
    f.t1.capabilities = [TA.CAPABILITY, RTC.CAPABILITY]
    f.t2.capabilities = [TA.CAPABILITY]
    f.db.commit()
    assert T.tables_host_of_shop(f.db, f.shop.id).id == f.t1.id
    f.order = starter_and_main(f, source="local")
    return f


def pull(w, till):
    return DCR.till_pull(str(till.id), machine=till, db=w.db)["commands"]


def answer(w, till, ident, status_, detail=None, result=None):
    return DCR.till_ack(str(till.id), str(ident), DCR.AckIn(status=status_, detail=detail, result=result), machine=till, db=w.db)


def follow(w, ident):
    return DCR.get_command(uuid.UUID(str(ident)), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def test_lan_fire_is_a_command_with_the_contracts_params(lan):
    request = uuid.uuid4()
    out, code = act_on(lan, "fire", courseId=str(lan.main_c.id), requestId=request)
    assert code == 202 and out["mode"] == "via_till" and out["timeoutSeconds"] == 20 and out["hostMachineId"] == str(lan.t1.id)
    row = lan.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    assert (row.action, row.machine_id) == ("table_fire", lan.t1.id)
    assert row.params == {
        "orderId": str(lan.order.id), "tableId": str(lan.table.id), "tableLabel": "12", "orderVersion": 3,
        "requestId": str(request), "requestedBy": {"userId": str(lan.admin.id), "name": "admin"}, "mode": "lan",
        "courseId": str(lan.main_c.id), "courseName": "עיקריות", "seed": F.fire_seed(lan.order.id, lan.main_c.id),
    }
    assert DC._aware(row.expires_at) - DC._aware(row.created_at) == timedelta(seconds=20)
    # Woken, and found on its pull; nothing was fired here.
    assert (str(lan.t1.id), DC.NOTIFY_EVENT) in lan.jobs_notified
    assert [c["action"] for c in pull(lan, lan.t1)] == ["table_fire"]
    nothing_written(lan, lan.order, 3)
    # The same click again is the same command.
    again, _ = act_on(lan, "fire", courseId=str(lan.main_c.id), requestId=request)
    assert again["commandId"] == out["commandId"]
    answer(lan, lan.t1, out["commandId"], "done", result={"printers": ["Kitchen"], "jobIds": ["j1"], "lines": 1, "kds": False, "junk": "x"})
    seen = follow(lan, out["commandId"])
    assert seen["outcome"] == "done" and seen["action"] == "fire"
    assert seen["result"] == {"printers": ["Kitchen"], "jobIds": ["j1"], "lines": 1, "kds": False}


@pytest.mark.parametrize("action,body,extra", [
    ("hold", {"courseId": "MAIN"}, {"courseId": "MAIN", "courseName": "עיקריות", "hold": True}),
    ("rush", {}, {"seed": "RUSH"}),
    ("reprint", {"scope": "round", "roundId": "r1"}, {"scope": "round", "roundId": "r1", "picks": [], "seed": "REPRINT"}),
    ("set-waiter", {"waiterPosUserId": "WAITER"}, {"waiter": {"posUserId": "WAITER", "name": "יוסי"}}),
    ("move", {"targetTableId": "T14"}, {"targetTableId": "T14", "targetLabel": "14"}),
    ("merge", {"sources": [{"tableId": "T14"}]}, {"sources": [{"tableId": "T14", "orderId": None, "orderVersion": None, "tableLabel": "14"}]}),
    ("note", {"text": "שולחן יום הולדת"}, {"text": "שולחן יום הולדת"}),
])
def test_every_lan_action_is_its_command(lan, action, body, extra):
    pu = staff(lan, "יוסי")
    t14 = T.create_table(lan.db, lan.hall, TableCreate(zoneId=lan.hall.id, number=14))
    lan.db.commit()
    request = uuid.uuid4()
    words = {"MAIN": str(lan.main_c.id), "WAITER": str(pu.id), "T14": str(t14.id),
             "RUSH": TC.rush_seed(lan.order.id, request), "REPRINT": TC.reprint_seed(lan.order.id, request)}

    def put(v):
        if isinstance(v, dict):
            return {k: put(x) for k, x in v.items()}
        if isinstance(v, list):
            return [put(x) for x in v]
        return words.get(v, v) if isinstance(v, str) else v

    out, code = act_on(lan, action, requestId=request, **put(body))
    row = lan.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    assert code == 202 and row.action == TA.ACTION_COMMANDS[action]
    shared = {"orderId", "tableId", "tableLabel", "orderVersion", "requestId", "requestedBy", "mode"}
    assert {k: v for k, v in row.params.items() if k not in shared} == put(extra)
    assert row.action in DC.DEADLINE_ACTIONS
    nothing_written(lan, lan.order, 3)


def test_one_request_id_two_courses_are_two_commands(lan):
    """A retry is the same command — never another course's that went with the same click id."""
    t9 = course(lan, "קינוחים", 2)
    request = uuid.uuid4()
    a, _ = act_on(lan, "hold", courseId=str(lan.main_c.id), requestId=request)
    b, _ = act_on(lan, "hold", courseId=str(t9.id), requestId=request)
    again, _ = act_on(lan, "hold", courseId=str(lan.main_c.id), requestId=request)
    assert a["commandId"] != b["commandId"] and again["commandId"] == a["commandId"]


def test_a_till_inside_on_the_lan_is_the_hosts_refusal(lan):
    out, _ = act_on(lan, "note", text="x")
    pull(lan, lan.t1)
    answer(lan, lan.t1, out["commandId"], "refused", detail="table_in_use", result={"reason": "table_in_use", "heldBy": "קופה 2 · בר (דנה)"})
    seen = follow(lan, out["commandId"])
    assert (seen["outcome"], seen["reason"], seen["heldBy"]) == ("refused", "table_in_use", "קופה 2 · בר (דנה)")


def test_not_host_goes_on_to_the_new_host_once(lan):
    out, _ = act_on(lan, "rush")
    put_param(lan, "tablesHostTill", "machine", lan.t1.id, False)
    put_param(lan, "tablesHostTill", "machine", lan.t2.id, True)
    pull(lan, lan.t1)
    answer(lan, lan.t1, out["commandId"], "refused", detail="not_host")
    first = lan.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    onward = lan.db.get(DeviceCommand, uuid.UUID(first.result["retargetedTo"]))
    assert (onward.machine_id, onward.action, onward.params[TA.RETARGET_OF]) == (lan.t2.id, "table_rush", str(first.id))
    assert follow(lan, out["commandId"])["retargeted"] is True
    # Refused there too: never sent on again.
    pull(lan, lan.t2)
    answer(lan, lan.t2, onward.id, "refused", detail="not_host")
    assert lan.db.query(DeviceCommand).filter(DeviceCommand.action == "table_rush").count() == 2


def test_past_the_timeout_it_is_expired_and_a_late_pull_never_gets_it(lan):
    out, _ = act_on(lan, "rush")
    row = lan.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    later = DC._aware(row.created_at) + timedelta(seconds=21)
    assert DC.as_of(row, later)["status"] == "expired"
    DC.expire_old(lan.db, now=later)
    lan.db.commit()
    assert DC.pull(lan.db, lan.t1, now=later)["commands"] == []
    # Delivered but never answered: expired at its own deadline too.
    out, _ = act_on(lan, "note", text="y")
    pull(lan, lan.t1)
    row = lan.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    assert DC.as_of(row, DC._aware(row.created_at) + timedelta(seconds=21))["status"] == "expired"


def test_a_host_without_the_capability_or_no_host_is_blocked(lan):
    lan.t1.capabilities = [RTC.CAPABILITY]
    lan.db.commit()
    e = refused_by(lan, "rush")
    assert e.detail["code"] == "remote_action_blocked" and e.detail["why"] == "no_capability"
    put_param(lan, "tablesMode", "shop", lan.shop.id, "כבוי")
    e = refused_by(lan, "rush")
    assert e.detail["why"] == "hostless"


# ── The single till ───────────────────────────────────────────────────────────


def test_a_single_tills_order_is_a_command_for_that_till(f):
    _tables(f.db)
    f.order = o = starter_and_main(f, source="local")
    o.cart_json = None  # a single till's report has no dishes in the cloud
    o.updated_machine_id = f.t2.id
    f.db.commit()
    assert refused_by(f, "note", text="x").detail["why"] == "no_capability"
    f.t2.capabilities = [TA.CAPABILITY]
    f.db.commit()
    out, code = act_on(f, "note", text="x")
    row = f.db.get(DeviceCommand, uuid.UUID(out["commandId"]))
    assert code == 202 and row.machine_id == f.t2.id and row.params["mode"] == "single"
    pull(f, f.t2)
    answer(f, f.t2, out["commandId"], "refused", detail="not_host")
    # "not_host" is the LAN's: a single till's command is never sent on.
    assert f.db.query(DeviceCommand).filter(DeviceCommand.action == "table_note").count() == 1


# ── Permissions ───────────────────────────────────────────────────────────────


def restricted(monkeypatch, w, sections):
    access = DA.EffectiveAccess(restricted=True, sections=sections, has_profile=True, full_access=False)
    monkeypatch.setattr(DA, "effective_access", lambda db, user: access)


def test_cancel_and_set_waiter_need_tables_manage(c, monkeypatch):
    pu = staff(c, "יוסי")
    restricted(monkeypatch, c, {"tables": DS.EDIT})
    e = refused_by(c, "set-waiter", waiterPosUserId=pu.id, user=c.manager)
    assert e.status_code == 403 and e.detail == {"code": "section_forbidden", "section": "tables_manage", "level": "edit"}
    reason = next(r for r in T.reasons_for(c.db, c.tenant.id) if r.name == "לקוח עזב")
    with pytest.raises(HTTPException) as ex:
        TR.dashboard_cancel_table(c.table.id, DashboardCancelIn(reasonId=reason.id), BackgroundTasks(),
                                  current_user=c.manager, active_tenant_id=c.tenant.id, db=c.db, response=Response())
    assert ex.value.status_code == 403 and ex.value.detail["section"] == "tables_manage"
    # Every other action with `tables` at edit alone.
    out, _ = act_on(c, "note", text="ok", user=c.manager)
    assert out["text"] == "ok"
    card = TR.get_table_card(c.table.id, current_user=c.manager, active_tenant_id=c.tenant.id, db=c.db)
    assert card["permissions"] == {"view": True, "edit": True, "manage": False}
    assert card["actions"]["set-waiter"] == {"allowed": False, "why": "manage_forbidden"}
    assert card["actions"]["cancel"] == {"allowed": False, "why": "manage_forbidden"}
    restricted(monkeypatch, c, {"tables": DS.EDIT, "tables_manage": DS.EDIT})
    out, _ = act_on(c, "set-waiter", waiterPosUserId=pu.id, user=c.manager, o=reread(c, c.order))
    assert out["waiterName"] == "יוסי"


def test_the_cancel_while_a_till_is_inside_names_it(c):
    held_by_till(c)
    reason = next(r for r in T.reasons_for(c.db, c.tenant.id) if r.name == "לקוח עזב")
    with pytest.raises(HTTPException) as ex:
        TR.dashboard_cancel_table(c.table.id, DashboardCancelIn(reasonId=reason.id), BackgroundTasks(),
                                  current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db, response=Response())
    assert ex.value.detail["code"] == "table_in_use" and ex.value.detail["till"] == f"{c.t1.pos_number} (דנה)"


def test_the_section_and_its_routes():
    assert "tables_manage" in DS.SECTION_IDS
    assert DS.BRANCH_MANAGER_SECTIONS["tables"] == DS.EDIT and DS.BRANCH_MANAGER_SECTIONS["tables_manage"] == DS.EDIT
    assert DS.rule_for("POST", "/tables/tables/x/actions/fire").sections == ("tables",)
    assert DS.rule_for("POST", "/tables/tables/x/actions/fire").needed_level("POST") == DS.EDIT
    assert DS.rule_for("GET", "/tables/tables/x/card").needed_level("GET") == DS.VIEW
    assert set(DS.rule_for("GET", "/tables/live/push").sections) == {"tables", "reports"}


# ── The card and the live view ────────────────────────────────────────────────


def test_the_card(c):
    x = extras(c.order)
    x["seats"] = {"2": "דנה"}
    x["partials"] = [{"tx": "t1", "no": "17", "amount": 3000}]
    x["reversals"] = [{"tx": "t1", "credit": "c1", "no": "18", "method": "cash", "kind": "full", "amount": 1000}]
    c.order.extras_json = json.dumps(x, ensure_ascii=False)
    cart = json.loads(c.order.cart_json)
    cart["lines"][1]["details"]["seat"] = 2
    c.order.cart_json = json.dumps(cart)
    c.db.commit()
    act_on(c, "note", text="יום הולדת")
    card = TR.get_table_card(c.table.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)
    assert card["route"]["mode"] == "cloud" and card["order"]["version"] == 4
    by = {ln["id"]: ln for ln in card["lines"]}
    assert (by["l1"]["state"], by["l1"]["course"]["name"], by["l1"]["rounds"]) == ("sent", "ראשונות", [1])
    assert (by["l2"]["state"], by["l2"]["seat"], by["l2"]["seatName"], by["l2"]["amount"]) == ("held", 2, "דנה", 20.0)
    assert card["payments"]["paid"] == 30.0 and card["payments"]["reversed"] == 10.0 and card["balance"] == 100.0
    assert [co["name"] for co in card["courses"]] == ["ראשונות", "עיקריות"]
    assert card["nextCourse"]["name"] == "עיקריות" and card["note"]["text"] == "יום הולדת"
    assert card["history"][0]["kind"] == "note" and card["history"][0]["fromDashboard"] is True
    assert card["actions"]["fire"]["allowed"] is True and card["actions"]["release"]["allowed"] is False
    held_by_till(c)
    card = TR.get_table_card(c.table.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)
    assert card["heldBy"] == f"{c.t1.pos_number} (דנה)"
    assert card["actions"]["fire"] == {"allowed": False, "why": "table_in_use"}
    assert card["actions"]["print-bill"]["allowed"] is True and card["actions"]["reprint"]["allowed"] is True
    assert card["actions"]["release"]["allowed"] is True


def test_the_live_view_carries_the_next_course_the_route_and_the_marks(c):
    auto(c)
    out = TR.live_tables(shop_id=c.shop.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)
    row = next(t for t in out["tables"] if t["number"] == 12)
    assert row["actions"]["mode"] == "cloud" and row["heldBy"] is None
    assert row["nextCourse"]["name"] == "עיקריות" and row["nextCourse"]["dueAt"] == (NOW - timedelta(minutes=1)).isoformat()
    assert out["thresholds"] == {"warnMinutes": 60, "alertMinutes": 90}
    held_by_till(c)
    out = TR.live_tables(shop_id=c.shop.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)
    row = next(t for t in out["tables"] if t["number"] == 12)
    assert row["state"] == "locked" and row["heldBy"] == f"{c.t1.pos_number} (דנה)"


def test_the_live_push_without_ably_says_poll(c):
    out = TR.live_tables_push(shop_id=c.shop.id, current_user=c.admin, active_tenant_id=c.tenant.id, db=c.db)
    assert out == {"enabled": False, "channel": f"pos:{c.tenant.id}:shop:{c.shop.id}"}


# ── The pure pieces ───────────────────────────────────────────────────────────


def L(ident, qty, name="x", course=None):
    details = {"course": {"id": course, "name": course, "order": 0}} if course else None
    return F.Line(ident, "p", None, name, qty, None, details)


def test_rounds_as_the_tills_picker_lists_them():
    """TableReprint.rounds: unlogged by when it went, else "earlier"; logged rounds get what the kitchen still has."""
    lines = [L("a", 2), L("b", 1), L("c", 1), L("d", 1), L("s", 1)]
    extras_ = {
        "sent": {
            "a": {"q": 2, "a": "2026-10-14T18:00:00.000Z"},
            "b": {"q": 1},
            "c": {"q": 1, "a": "2026-10-14T18:10:00.000Z"},
            "d": {"q": 1, "a": "2026-10-14T18:05:00.000Z"},
            "s": {"q": 1, "s": True},  # "נשלח (בלי בון)": never offered
        },
        "log": [{"i": "r1", "a": "2026-10-14T18:10:00.000Z", "l": {"a": 1, "c": 1}}],
    }
    rounds = TC.reprint_rounds(lines, extras_)
    assert [(r.id, r.number, {rl.line_id: rl.quantity for rl in r.lines}) for r in rounds] == [
        # "a" has a logged round too, so when its other unit went is not known; "b" has no time.
        ("earlier", 1, {"a": 1.0, "b": 1.0}),
        # Not in the log, and its time known: a round of its own, by when it went.
        ("at:2026-10-14T18:05:00.000Z", 2, {"d": 1.0}),
        ("r1", 3, {"a": 1.0, "c": 1.0}),
    ]
    assert TC.quantities(rounds, TC.every_pick(rounds)) == {"a": 2.0, "b": 1.0, "d": 1.0, "c": 1.0}
    assert TC.round_picks(rounds, "r1") == {("r1", "a"), ("r1", "c")}
    # A line cut down since: never more than the table holds.
    fewer = TC.reprint_rounds([L("a", 1), L("c", 1)], extras_)
    assert TC.quantities(fewer, TC.every_pick(fewer)) == {"a": 1.0, "c": 1.0}


def test_a_merge_keeps_every_lines_bookkeeping():
    target = ({"lines": [{"id": "a"}], "cartId": "t"}, {"sent": {"a": {"q": 1}}, "notes": {}, "fired": ["c1"], "waiter": {"id": "w1", "name": "דנה"}})
    source = ({"lines": [{"id": "a"}, {"id": "b"}]}, {
        "sent": {"a": {"q": 2}}, "notes": {"b": "בלי בצל"}, "fired": ["c2"], "hold": ["c1", "c3"],
        "log": [{"i": "r9", "a": "2026-10-14T18:00:00.000Z", "l": {"a": 2}}],
        "partials": [{"tx": "p1", "amount": 500}], "waiter": {"id": "w2", "name": "רון"},
    })
    cart, extras_ = TC.merged(target[0], target[1], [source], new_id=lambda: "a2")
    assert [ln["id"] for ln in cart["lines"]] == ["a", "a2", "b"] and cart["cartId"] == "t"
    assert extras_["sent"] == {"a": {"q": 1}, "a2": {"q": 2}} and extras_["notes"] == {"b": "בלי בצל"}
    assert extras_["fired"] == ["c1", "c2"] and extras_["hold"] == ["c3"]
    assert extras_["log"] == [{"i": "r9", "a": "2026-10-14T18:00:00.000Z", "l": {"a2": 2}}]
    assert extras_["partials"] == [{"tx": "p1", "amount": 500}] and extras_["waiter"]["id"] == "w1"


def test_the_answer_keeps_only_the_contracts_fields():
    detail, result = TA.clean_answer("table_fire", "done", None, {"printers": ["K", 3], "kds": True, "lines": 2.0, "x": 1})
    assert result == {"printers": ["K", "3"], "kds": True, "lines": 2}
    detail, result = TA.clean_answer("table_move", "refused", None, {"reason": "target_not_free"})
    assert detail == "target_not_free" and result == {"reason": "target_not_free"}
    assert set(TA.REFUSALS) <= set(DC.REFUSAL_REASONS) | {"payment_in_progress"}
