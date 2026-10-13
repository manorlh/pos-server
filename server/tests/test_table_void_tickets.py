"""
"בון ביטול" for a table cancelled from the dashboard (app/services/table_void_tickets.py; the open
item of the reliability audit of tables and kitchen tickets, PR #80).

What each test pins, and how it could look fine while doing damage:

* **One void per printer route** — the kitchen gets one ticket per printer, each with only its
  lines, worded as the till words a void ("ביטול: …", "בוטל"), routed by the till's rule (the
  product's current category, "ללא בון", the zone's redirect). A ticket per line, or every line on
  every printer, would look like a void and flood the kitchen.
* **Nothing sent, nothing printed** — a table the kitchen never got (or got nothing of) is cancelled
  without a ticket: a void of a dish nobody ordered sends a cook looking for it.
* **Once** — the jobs carry the till's own ids for the same cancel (pinned against Java's
  `UUID.nameUUIDFromBytes`): a retry, a second click, a till uploading the same cancel's void —
  one job, printed once.
* **KDS** — the kitchen screens drop the order; a KDS-only shop gets no paper.
* **The relay** — the void goes to the print server of the moment, follows it when it moves, waits
  while no till takes it ("בון ביטול ממתין למדפסת" on the dashboard) and says so once it gave up.
* **The LAN mode** — an order the LAN host serves while it is online is refused (the cancel would
  never reach its floor while the kitchen stopped cooking); a silent host's is cancelled and voided.

Runs on the world of tests/test_kitchen_printers.py (SQLite).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks

from app.models.kds import KitchenTask
from app.models.printers import KitchenPrintJob
from app.models.tables import TableOrder
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import tables as TR
from app.schemas.printer_discovery import ZoneRedirectsIn
from app.schemas.tables import DashboardCancelIn, TableCreate, ZoneCreate
from app.services import ably_notify
from app.services import printer_zones as PZ
from app.services import printers as K
from app.services import table_void_tickets as VT
from app.services import tables as T
from app.services import tables_state as TS
from app.services.till_parameters import ensure_builtin_parameters
from test_kds import configure, item, kd, release  # noqa: F401 - fixtures
from test_kitchen_printers import (  # noqa: F401 - fixtures
    _run,
    ack,
    create,
    k,
    make_print_host,
    no_ticket,
    pending,
    refused,
    route_categories,
    send_job,
    statuses,
    w,
)

LAN = "רשת מקומית (קופה ראשית)"


# ── The floor ─────────────────────────────────────────────────────────────────


def _now():
    return datetime.now(timezone.utc)


def heard(till, ago=timedelta(seconds=10)):
    till.last_heartbeat_at = _now() - ago


def floor(k, monkeypatch, *, print_host=True):
    """Kitchen (Food, so Mains) and Bar (Drinks) network printers; till 2 the print server; table 12."""
    monkeypatch.setattr(TS, "NOTIFY_WINDOW_S", 0.0)
    monkeypatch.setattr(ably_notify, "publish_batch", lambda channels, event, body: None)
    k.p_kitchen = create(k, name="Kitchen")["id"]
    k.p_bar = create(k, name="Bar", host="10.0.0.9")["id"]
    route_categories(k, {k.food: [k.p_kitchen], k.drinks: [k.p_bar]})
    k.t1, k.t2 = k.tills[0], k.tills[1]
    if print_host:
        make_print_host(k, k.t2)
    heard(k.t1)
    heard(k.t2)
    k.hall = T.create_zone(k.db, k.shop, ZoneCreate(shopId=k.shop.id, name="אולם", layout="map"))
    k.table = T.create_table(k.db, k.hall, TableCreate(zoneId=k.hall.id, number=12))
    k.db.commit()
    return k


@pytest.fixture
def v(k, monkeypatch):
    return floor(k, monkeypatch)


def sent(*lines):
    """The till's kitchen bookkeeping (TableExtras): (line id, product, quantity[, snapshot])."""
    out = {}
    for line in lines:
        line_id, product, quantity = line[:3]
        entry = {"q": quantity, "n": product.name, "p": str(product.id), "c": str(product.category_id), "t": None}
        if len(line) > 3:
            entry["k"] = line[3]
        out[line_id] = entry
    return json.dumps({"sent": out, "notes": {}})


def order_on(k, extras, *, table=None, send_count=1, source="synced", cart='{"lines": []}', worked_by=None):
    order = TableOrder(
        id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, table_id=(table or k.table).id,
        zone_id=k.hall.id, table_number=(table or k.table).number, status="open", source=source, version=3,
        guests=4, cart_json=cart, extras_json=extras, item_count=Decimal("3"), total=Decimal("120"),
        opened_machine_id=k.t1.id, updated_machine_id=(worked_by or k.t1).id, opened_by_pos_user_name="דנה",
        send_count=send_count,
    )
    k.db.add(order)
    k.db.commit()
    return order


def reason(k):
    return next(r for r in T.reasons_for(k.db, k.tenant.id) if r.name == "לקוח עזב")


def cancel(k, table=None):
    tasks = BackgroundTasks()
    out = TR.dashboard_cancel_table(
        (table or k.table).id, DashboardCancelIn(reasonId=reason(k).id), tasks,
        current_user=k.admin, active_tenant_id=k.tenant.id, db=k.db,
    )
    _run(tasks)
    return out


def jobs_of(k):
    return k.db.query(KitchenPrintJob).filter(KitchenPrintJob.kind == "ticket").order_by(KitchenPrintJob.printer_name).all()


def by_printer(k):
    return {j.printer_name: j for j in jobs_of(k)}


def live(k):
    return TR.live_tables(shop_id=k.shop.id, current_user=k.admin, active_tenant_id=k.tenant.id, db=k.db)


def set_param(k, key, scope_type, scope_id, value):
    ensure_builtin_parameters(k.db)
    parameter = k.db.query(TillParameter).filter(TillParameter.key == key).one()
    k.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    k.db.commit()


# ── The till's ids ────────────────────────────────────────────────────────────


def test_the_ids_are_the_tills_own():
    """Pinned against Java's UUID.nameUUIDFromBytes (SendIntents.cancelRequestIdOf / jobIdOf)."""
    assert str(VT.java_name_uuid("")) == "d41d8cd9-8f00-3204-a980-0998ecf8427e"
    order, printer = "6f1c2b9e-4d3a-4e8f-9b7c-1a2b3c4d5e6f", "0b8f7a1e-4f3c-4d5e-9a2b-7c1d2e3f4a5b"
    seed = VT.cancel_seed(order)
    assert seed == "aadf7550-b1de-3b5a-934d-5fc3d12d9b8d"
    assert str(VT.job_id_of(seed, printer)) == "6f23212c-bb04-38e5-b96d-8eccea4835d9"


# ── One void per printer route ────────────────────────────────────────────────


def test_one_void_ticket_per_printer_route(v):
    order = order_on(v, sent(("l1", v.steak, 2), ("l2", v.salad, 1), ("l3", v.cola, 3)))
    out = cancel(v)
    assert out["status"] == "cancelled" and out["kdsCancelled"] is None
    jobs = by_printer(v)
    assert set(jobs) == {"Kitchen", "Bar"}
    kitchen, bar = jobs["Kitchen"].payload, jobs["Bar"].payload
    # Each printer its own lines, worded as the till's void.
    assert [(x["name"], x["quantity"], x["notes"]) for x in kitchen["lines"]] == [
        ("ביטול: steak", 2.0, "בוטל"), ("ביטול: salad", 1.0, "בוטל"),
    ]
    assert [(x["name"], x["quantity"]) for x in bar["lines"]] == [("ביטול: cola", 3.0)]
    # The head of the till's table ticket.
    assert kitchen["source"] == "table" and kitchen["tableName"] == "12" and kitchen["zoneName"] == "אולם"
    assert kitchen["guests"] == 4 and kitchen["waiterName"] == "admin" and kitchen["isAddition"] is True
    assert kitchen["orderRef"] == str(order.id)[:8] and kitchen["sourceName"] == "דשבורד"
    # Through the relay, to the print server, under the till's own ids for this cancel.
    seed = VT.cancel_seed(order.id)
    for job in jobs.values():
        assert job.target_machine_id == v.t2.id and job.source_machine_id is None
        assert job.created_by_user_id == v.admin.id and job.status == "pending"
        assert job.id == VT.job_id_of(seed, job.printer_id)
    assert {t["printerName"]: t["state"] for t in out["voidTickets"]} == {"Kitchen": "waiting", "Bar": "waiting"}
    # The print server is woken, and takes both.
    assert (str(v.t2.id), K.PRINT_JOB_EVENT) in v.jobs_notified
    assert sorted(j["printer"]["name"] for j in pending(v, v.t2)) == ["Bar", "Kitchen"]


def test_a_menu_dish_is_voided_at_every_station_its_parts_went_to(v):
    """A meal's components by what the kitchen got (its kept snapshot), each to its own printer."""
    snapshot = json.dumps([
        {"p": str(v.steak.id), "n": "סטייק", "q": 1, "c": str(v.mains.id), "m": ["מדיום"], "r": ["בלי בצל"],
         "s": "סועד 2", "ml": "ארוחה עסקית"},
        {"p": str(v.cola.id), "n": "קולה", "q": 1, "c": str(v.drinks.id), "ml": "ארוחה עסקית"},
    ])
    order_on(v, sent(("meal", v.salad, 2, snapshot)))
    cancel(v)
    jobs = by_printer(v)
    [steak] = jobs["Kitchen"].payload["lines"]
    assert (steak["name"], steak["quantity"], steak["notes"]) == ("ביטול: סטייק", 2.0, "בוטל")
    assert steak["mods"] == ["מדיום"] and steak["removals"] == ["בלי בצל"]
    assert steak["seat"] == "סועד 2" and steak["mealName"] == "ארוחה עסקית"
    assert not steak["important"] and not steak["allergies"]
    [cola] = jobs["Bar"].payload["lines"]
    assert (cola["name"], cola["quantity"], cola["mods"]) == ("ביטול: קולה", 2.0, None)


def test_routed_as_the_till_routes_it(v):
    """The product's category NOW, "ללא בון" left out, the zone's redirect after the routing."""
    order_on(v, sent(("l1", v.steak, 1), ("l2", v.cola, 1), ("l3", v.salad, 1)))
    # The steak moved to Drinks since it was sent; the salad is "ללא בון" now.
    v.steak.category_id = v.drinks.id
    no_ticket(v, v.salad, True)
    v.db.commit()
    cancel(v)
    jobs = by_printer(v)
    assert set(jobs) == {"Bar"}
    assert [x["name"] for x in jobs["Bar"].payload["lines"]] == ["ביטול: steak", "ביטול: cola"]


def test_the_zones_redirect_applies(v):
    PZ.set_zone_redirects(v.db, v.shop, v.hall, ZoneRedirectsIn(redirects={v.p_kitchen: v.p_bar}))
    v.db.commit()
    order_on(v, sent(("l1", v.steak, 1), ("l2", v.cola, 1)))
    cancel(v)
    jobs = by_printer(v)
    # Both end on the bar: one ticket there, with both lines.
    assert set(jobs) == {"Bar"} and len(jobs["Bar"].payload["lines"]) == 2


# ── Nothing sent, nothing printed ─────────────────────────────────────────────


@pytest.mark.parametrize("extras", [
    None,
    "",
    "not json",
    json.dumps({"sent": {}, "notes": {"l1": "בלי בצל"}}),
    # Lines the kitchen got none of (taken back to zero before a send).
    json.dumps({"sent": {"l1": {"q": 0, "n": "steak", "p": "x", "c": None}}}),
])
def test_no_void_when_nothing_was_sent(v, extras):
    order_on(v, extras, send_count=0)
    out = cancel(v)
    assert out["status"] == "cancelled" and out["voidTickets"] == []
    assert jobs_of(v) == [] and not v.jobs_notified


def test_a_kitchen_part_that_fails_never_fails_the_cancel(v, monkeypatch):
    """The manager's cancel stands; the dashboard is told the kitchen was not (a person tells it)."""
    def broken(*args, **kwargs):
        raise RuntimeError("relay down")

    monkeypatch.setattr(VT, "queue_cancel_voids", broken)
    order = order_on(v, sent(("l1", v.steak, 2)))
    out = cancel(v)
    assert out["status"] == "cancelled" and out["voidTicketsError"] is True and out["voidTickets"] == []
    v.db.refresh(order)
    assert order.status == "cancelled" and jobs_of(v) == []


def test_a_line_no_printer_takes_makes_no_ticket(v):
    no_ticket(v, v.cola, True)
    v.db.commit()
    order_on(v, sent(("l1", v.cola, 2)))
    assert cancel(v)["voidTickets"] == [] and jobs_of(v) == []


# ── Once ──────────────────────────────────────────────────────────────────────


def test_a_retry_never_prints_twice(v):
    order = order_on(v, sent(("l1", v.steak, 2), ("l2", v.cola, 1)))
    first = cancel(v)
    ids = sorted(t["id"] for t in first["voidTickets"])
    assert len(ids) == 2
    # The same request again: the order is no longer open — refused, nothing new.
    assert refused(cancel, v).detail["code"] == "table_order_not_open"
    # The kitchen part run again (a retried request that got this far): the same jobs.
    again = VT.queue_cancel_voids(
        v.db, order, v.table, routing=v.t1, user_id=v.admin.id, by_name="admin", now=_now(),
    )
    assert sorted(str(j.id) for j in again) == ids
    assert len(jobs_of(v)) == 2
    # Printed once.
    handed = pending(v, v.t2)
    assert sorted(j["id"] for j in handed) == ids
    for job_id in ids:
        ack(v, v.t2, job_id)
    assert pending(v, v.t2) == []


def test_a_tills_upload_of_the_same_cancels_void_is_the_same_job(v):
    """
    The LAN mode: the floor's host never learnt of the dashboard's cancel (it was silent), a till
    there cancels the table too — its void goes under the till's id for that cancel, the dashboard's
    own: the relay keeps one job, and the till follows it as its own.
    """
    order = order_on(v, sent(("l1", v.steak, 2)))
    cancel(v)
    job_id = str(VT.job_id_of(VT.cancel_seed(order.id), v.p_kitchen))
    out = send_job(v, v.t1, v.p_kitchen, job_id=job_id)
    assert out["id"] == job_id and len(jobs_of(v)) == 1
    assert statuses(v, v.t1, job_id)[job_id]["status"] == "pending"
    assert [j["id"] for j in pending(v, v.t2)] == [job_id]
    ack(v, v.t2, job_id)
    assert statuses(v, v.t1, job_id)[job_id]["status"] == "done"
    # Any other job's id stays refused to another till.
    other = str(uuid.uuid4())
    send_job(v, v.t1, v.p_kitchen, job_id=other)
    assert refused(send_job, v, v.t2, v.p_kitchen, job_id=other).detail == "print_job_id_taken"


# ── KDS ───────────────────────────────────────────────────────────────────────


@pytest.fixture
def kv(kd, monkeypatch):
    return floor(kd, monkeypatch)


def test_the_kitchen_screens_drop_the_order(kv):
    order = order_on(kv, sent(("l1", kv.steak, 2)))
    release(kv, till=kv.t1, ref=str(order.id), items=[item("l1", kv.steak, 2)])
    tasks = kv.db.query(KitchenTask).all()
    assert tasks and all(t.ordered_qty == 2 for t in tasks)
    out = cancel(kv)
    assert out["kdsCancelled"] >= 1
    kv.db.expire_all()
    assert all(t.ordered_qty - t.cancelled_qty == 0 for t in kv.db.query(KitchenTask).all())
    # The printer is a target too: the paper void as well.
    assert set(by_printer(kv)) == {"Kitchen"}


def test_kds_only_prints_no_void_ticket(kv):
    configure(kv, enabled=True, defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds"])
    order = order_on(kv, sent(("l1", kv.steak, 2)))
    release(kv, till=kv.t1, ref=str(order.id), items=[item("l1", kv.steak, 2)])
    out = cancel(kv)
    assert out["kdsCancelled"] >= 1 and out["voidTickets"] == [] and jobs_of(kv) == []


def test_an_order_the_kds_never_had_is_left_alone(kv):
    order_on(kv, sent(("l1", kv.steak, 2)))
    assert cancel(kv)["kdsCancelled"] is None


# ── The relay ─────────────────────────────────────────────────────────────────


def test_the_void_goes_to_the_print_server_of_the_moment_and_follows_it(v):
    order_on(v, sent(("l1", v.steak, 1)))
    # The print server moved to till 1 before the cancel.
    make_print_host(v, v.t1)
    assert K.print_host_of_shop(v.db, v.shop.id).id == v.t1.id
    cancel(v)
    [job] = jobs_of(v)
    assert job.target_machine_id == v.t1.id
    # It moves again (back to till 2) while the void waits, and till 1 falls silent: it follows.
    parameter = v.db.query(TillParameter).filter(TillParameter.key == "printHostTill").one()
    v.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id, TillParameterValue.scope_id == v.t1.id,
    ).delete(synchronize_session=False)
    heard(v.t1, timedelta(minutes=10))
    v.db.commit()
    assert [j["id"] for j in pending(v, v.t2)] == [str(job.id)]
    assert ack(v, v.t2, str(job.id))["status"] == "done"


def test_retargeted_with_the_shops_relayed_tickets(v):
    order_on(v, sent(("l1", v.steak, 1)))
    cancel(v)
    [job] = jobs_of(v)
    make_print_host(v, v.t1)
    assert K.retarget_relay_jobs(v.db, v.shop.id) == 1
    assert job.target_machine_id == v.t1.id


def test_without_a_print_server_the_till_that_worked_the_table_prints_it(k, monkeypatch):
    v = floor(k, monkeypatch, print_host=False)
    assert K.print_host_of_shop(v.db, v.shop.id) is None
    order_on(v, sent(("l1", v.steak, 1)), worked_by=v.t2)
    cancel(v)
    [job] = jobs_of(v)
    assert job.target_machine_id == v.t2.id
    assert [j["id"] for j in pending(v, v.t2)] == [str(job.id)]


def test_a_cloud_printer_goes_to_its_host(v):
    cloud = create(v, name="Pass", connectionType="cloud", hostMachineId=str(v.t1.id))["id"]
    route_categories(v, {v.food: [cloud], v.drinks: [v.p_bar]})
    order_on(v, sent(("l1", v.steak, 1)))
    cancel(v)
    assert by_printer(v)["Pass"].target_machine_id == v.t1.id


def test_the_dashboard_says_while_it_waits_and_when_it_gave_up(v):
    order_on(v, sent(("l1", v.steak, 1), ("l2", v.cola, 1)))
    cancel(v)
    waiting = live(v)["voidTickets"]
    assert {(t["printerName"], t["state"], t["tableName"]) for t in waiting} == {
        ("Kitchen", "waiting", "12"), ("Bar", "waiting", "12"),
    }
    jobs = by_printer(v)
    # The kitchen's printed; no till took the bar's within the relay's minutes.
    assert ack(v, v.t2, str(jobs["Kitchen"].id))["status"] == "done"
    jobs["Bar"].expires_at = _now() - timedelta(seconds=1)
    v.db.commit()
    assert [(t["printerName"], t["state"]) for t in live(v)["voidTickets"]] == [("Bar", "failed")]


# ── The LAN mode ──────────────────────────────────────────────────────────────


def lan_floor(v):
    set_param(v, "tablesMode", "shop", v.shop.id, LAN)
    set_param(v, "tablesHostTill", "machine", v.t1.id, True)
    assert T.tables_host_of_shop(v.db, v.shop.id).id == v.t1.id


def test_an_order_the_live_lan_host_serves_is_refused(v):
    lan_floor(v)
    order = order_on(v, sent(("l1", v.steak, 1)), source="local")
    e = refused(cancel, v)
    assert e.status_code == 409 and e.detail["code"] == "table_on_live_host"
    v.db.refresh(order)
    assert order.status == "open" and jobs_of(v) == []


def test_a_silent_lan_hosts_order_is_cancelled_and_voided(v):
    lan_floor(v)
    heard(v.t1, timedelta(minutes=10))
    v.db.commit()
    order_on(v, sent(("l1", v.steak, 1)), source="local")
    assert cancel(v)["status"] == "cancelled"
    [job] = jobs_of(v)
    assert job.target_machine_id == v.t2.id


def test_a_single_tills_report_is_not_the_hosts(v):
    """«קופה אחת» beside the LAN group: its report carries no dishes — never the host's, never voided."""
    lan_floor(v)
    order_on(v, None, source="local", cart=None)
    assert cancel(v)["voidTickets"] == []
