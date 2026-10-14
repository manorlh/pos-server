"""
"הוצאה אוטומטית של השלב הבא" in the cloud's tables (app/services/course_auto_fire.py,
P:/specs/courses-fire-v2.md §1 "שולחנות בענן", the contract in §5).

What each test pins, and how it could look fine while doing damage:

* **The till's ids** — the fire's seed, its jobs and its KDS release are the till's (pinned against
  Java's `UUID.nameUUIDFromBytes`, run on a JDK): a till firing the same course at the same moment, or a
  retry, is the same job — never a second bon in the kitchen.
* **When** — the next held course goes N minutes after the course before it last went out (the course's
  minutes, or the level's override), never before; "השהה" holds it however long; nothing before it sent —
  no countdown; `after_ready` waits for the KDS and nothing else, and without a KDS counts minutes.
* **What** — the order says the course went (fired, its lines sent with the time, a round in the log),
  the kitchen gets one ticket per printer route with "הוצא: עיקריות (אוטומטי)", the screens get the
  round; an item that goes without a bon is marked sent and printed nowhere.
* **Once** — a second pass, a till's upload of the same fire, a till inside the table (it fires after
  the till leaves): one fire, one job per printer.
* **Not the cloud's** — a closed order, a LAN host's copy, a single till's report: never touched.

Runs on the world of tests/test_kitchen_printers.py and tests/test_kds.py (SQLite).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.audit_exception import TillEvent
from app.models.kds import KitchenDispatch, KitchenTask
from app.models.menu import MenuCourse
from app.models.printers import KitchenPrintJob
from app.models.product import Product
from app.models.tables import TableEvent, TableOrder
from app.services import course_auto_fire as F
from app.services import course_auto_fire_worker as W
from app.services import table_void_tickets as VT
from test_kds import act, configure, item, kd, release  # noqa: F401 - fixtures
from test_kitchen_printers import k, send_job, w  # noqa: F401 - fixtures
from test_table_void_tickets import floor, set_param

NOW = datetime(2026, 10, 14, 18, 30, tzinfo=timezone.utc)


# ── The till's ids ────────────────────────────────────────────────────────────


def test_the_ids_are_the_tills_own():
    """
    Pinned against Java (temurin 17, `UUID.nameUUIDFromBytes`) — the till's
    `SendIntents.fireRequestIdOf` / `jobIdOf(seed, printer, "ticket")` / `releaseIdOf` (§5).
    """
    order, course, printer = (
        "6f1c2b9e-4d3a-4e8f-9b7c-1a2b3c4d5e6f", "3c9e2d4b-8a1f-4b6c-9d7e-5f0a1b2c3d4e",
        "0b8f7a1e-4f3c-4d5e-9a2b-7c1d2e3f4a5b",
    )
    seed = F.fire_seed(order, course)
    assert seed == "76188f32-695d-3e28-832f-e08b6afdddaa"
    assert str(F.fire_job_id(seed, printer)) == "19dab848-abba-38e3-a4e2-36b58a3c0c25"
    assert F.fire_release_id(seed) == "be624381-ca75-3404-b34f-3784ea23f5da"
    # The same derivation as the void of a dashboard cancel (#85), with the fire's seed.
    assert F.fire_job_id(seed, printer) == VT.job_id_of(seed, printer)


# ── The floor ─────────────────────────────────────────────────────────────────


def course(w, name, order, minutes=15):
    row = MenuCourse(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name, sort_order=order,
        auto_fire_minutes=minutes,
    )
    w.db.add(row)
    w.db.flush()
    return row


def world(k, monkeypatch):
    """Table 12 of tests/test_table_void_tickets.py; starters, mains, desserts; a burger and bread (Mains)."""
    floor(k, monkeypatch)
    k.starters = course(k, "ראשונות", 0)
    k.main_c = course(k, "עיקריות", 1)
    k.desserts = course(k, "קינוחים", 2, minutes=25)

    def product(name, category):
        p = Product(
            id=uuid.uuid4(), tenant_id=k.tenant.id, company_id=k.company.id, category_id=category.id,
            name=name, price=Decimal("10.00"), sku=f"sku-{name}",
        )
        k.db.add(p)
        return p

    k.burger = product("burger", k.mains)
    k.bread = product("bread", k.mains)
    k.cake = product("cake", k.food)
    k.db.commit()
    return k


@pytest.fixture
def f(k, monkeypatch):
    return world(k, monkeypatch)


@pytest.fixture
def fk(kd, monkeypatch):
    return world(kd, monkeypatch)


def ref(c):
    return {"id": str(c.id), "name": c.name, "order": c.sort_order}


def line(line_id, product, qty=1, c=None, **details):
    """A cart line as the till's HeldSaleCodec writes it (the product a JSON string)."""
    body = None
    if c is not None or details:
        body = {"v": 1, "basePrice": 10.0, "modifiers": [], **details}
        if c is not None:
            body["course"] = ref(c)
    return {
        "id": line_id, "quantity": qty, "unitPrice": 1000, "discount": 0, "discountType": None, "notes": None,
        "product": json.dumps({
            "id": str(product.id), "name": product.name, "categoryId": str(product.category_id), "price": 1000,
            "courseId": None,
        }),
        "details": body,
    }


def sent_row(product, qty=1, at=None):
    return {"q": qty, "n": product.name, "p": str(product.id), "c": str(product.category_id), "t": None,
            **({"a": F.till_time(at)} if at is not None else {})}


def order(w, lines, sent, *, sent_at=NOW - timedelta(minutes=16), status="open", source="synced", **extras):
    row = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=w.table.id, zone_id=w.hall.id,
        table_number=w.table.number, status=status, source=source, version=3, guests=4,
        cart_json=json.dumps({"cartId": "c1", "lines": lines}),
        extras_json=json.dumps({"sent": sent, "notes": {}, **extras}, ensure_ascii=False),
        item_count=Decimal(len(lines)), total=Decimal("100"), opened_machine_id=w.t1.id, updated_machine_id=w.t1.id,
        opened_by_pos_user_name="דנה", send_count=1, sent_at=sent_at,
    )
    w.db.add(row)
    w.db.commit()
    return row


def starter_and_main(w, *, went_out=NOW - timedelta(minutes=16), **kw):
    """The salad (starters) went out; the burger (mains) is held; the cola (no course) went out too."""
    return order(w, [
        line("l1", w.salad, 1, w.starters), line("l2", w.burger, 2, w.main_c), line("l3", w.cola, 1),
    ], {"l1": sent_row(w.salad, 1, went_out), "l3": sent_row(w.cola, 1, went_out)}, **kw)


def auto(w, mode="after_minutes"):
    set_param(w, "autoFire", "shop", w.shop.id, mode)


def tickets(w):
    return w.db.query(KitchenPrintJob).filter(KitchenPrintJob.kind == "ticket").all()


def reread(w, row):
    w.db.expire_all()
    return w.db.get(TableOrder, row.id)


def extras(row):
    return json.loads(row.extras_json)


# ── When ──────────────────────────────────────────────────────────────────────


def test_after_minutes_fires_once_with_the_tills_ids(f):
    auto(f)
    o = starter_and_main(f)
    assert F.run_pass(f.db, now=NOW - timedelta(minutes=2)) == []  # 14 of its 15 minutes
    fired = F.run_pass(f.db, now=NOW)
    assert [(x["courseName"], x["trigger"], x["printedLines"]) for x in fired] == [("עיקריות", "after_minutes", ["l2"])]
    seed = F.fire_seed(o.id, f.main_c.id)
    # The order says the course went: fired, its line sent (with the time), a round in the log.
    o = reread(f, o)
    x = extras(o)
    assert str(f.main_c.id) in x["fired"] and "hold" not in x
    assert x["sent"]["l2"]["q"] == 2 and x["sent"]["l2"]["a"] == F.till_time(NOW) and "s" not in x["sent"]["l2"]
    assert x["sent"]["l1"]["a"] == F.till_time(NOW - timedelta(minutes=16))  # the starter as it was
    assert x["log"][-1] == {"i": seed, "a": F.till_time(NOW), "l": {"l2": 2}, "auto": True}
    assert "rounds" not in x
    assert (o.version, o.send_count, o.last_request_id) == (4, 2, None)
    # One ticket, for the kitchen, under the till's id for this fire, to the print server.
    jobs = tickets(f)
    assert [(j.printer_name, j.id, j.target_machine_id) for j in jobs] == [
        ("Kitchen", F.fire_job_id(seed, f.p_kitchen), f.t2.id),
    ]
    payload = jobs[0].payload
    assert payload["fire"] == "עיקריות (אוטומטי)" and payload["sourceName"] == "אוטומטי"
    assert payload["tableName"] == "12" and payload["isAddition"] is True and payload["waiterName"] == "דנה"
    assert [(x["name"], x["quantity"], x["course"]) for x in payload["lines"]] == [("burger", 2.0, "עיקריות")]
    # Logged: the table's history and the till event.
    sends = f.db.query(TableEvent).filter(TableEvent.order_id == o.id, TableEvent.kind == "send").all()
    assert [e.details["autoFire"] for e in sends] == [True]
    event = f.db.get(TillEvent, F.event_id(o.id, f.main_c.id))
    assert event.event_type == "course_auto_fired" and event.machine_id == f.t1.id
    assert (event.details["courseName"], event.details["trigger"], event.details["minutes"]) == ("עיקריות", "after_minutes", 15)
    # Once: the next pass, and the one after, fire nothing.
    assert F.run_pass(f.db, now=NOW + timedelta(minutes=1)) == []
    assert F.fire_if_due(f.db, o.id, now=NOW + timedelta(hours=1)) is None
    assert len(tickets(f)) == 1 and reread(f, o).version == 4


def test_the_course_minutes_and_the_levels_override(f):
    auto(f)
    f.main_c.auto_fire_minutes = 10
    f.db.commit()
    o = starter_and_main(f, went_out=NOW - timedelta(minutes=9))
    assert F.run_pass(f.db, now=NOW) == []
    assert len(F.run_pass(f.db, now=NOW + timedelta(minutes=1))) == 1
    f.db.query(TableOrder).filter(TableOrder.id == o.id).update({"status": "paid"})
    f.db.commit()
    # The level's override replaces every course's minutes.
    set_param(f, "autoFireMinutesOverride", "shop", f.shop.id, 30)
    o2 = starter_and_main(f, went_out=NOW - timedelta(minutes=16))
    assert F.run_pass(f.db, now=NOW) == []
    assert [x["orderId"] for x in F.run_pass(f.db, now=NOW + timedelta(minutes=14))] == [str(o2.id)]


def test_counted_from_the_last_time_the_course_before_went_out(f):
    auto(f)
    o = order(f, [
        line("l1", f.salad, 1, f.starters), line("l4", f.steak, 1, f.starters), line("l2", f.burger, 1, f.main_c),
    ], {
        "l1": sent_row(f.salad, 1, NOW - timedelta(minutes=20)),
        "l4": sent_row(f.steak, 1, NOW - timedelta(minutes=5)),  # a starter added later
    })
    assert F.run_pass(f.db, now=NOW) == []
    assert len(F.run_pass(f.db, now=NOW + timedelta(minutes=10))) == 1
    # Without a time on any of its lines (a till before `a`): the order's last send.
    lines = F.cart_lines(o.cart_json)
    bare = {"sent": {"l1": {"q": 1}}}
    assert F.went_out_at(lines, bare, str(f.starters.id), NOW) == NOW


def test_paused_never_goes(f):
    auto(f)
    o = starter_and_main(f, hold=[str(f.main_c.id)])
    assert F.run_pass(f.db, now=NOW + timedelta(hours=3)) == []
    assert tickets(f) == [] and reread(f, o).version == 3


def test_nothing_before_it_sent_no_countdown(f):
    auto(f)
    # The starter is fired (the first course) but the waiter has not pressed "שלח" yet.
    order(f, [line("l1", f.salad, 1, f.starters), line("l2", f.burger, 1, f.main_c)], {})
    assert F.run_pass(f.db, now=NOW + timedelta(hours=1)) == []


def test_off_by_default(f):
    starter_and_main(f)
    assert F.run_pass(f.db, now=NOW + timedelta(hours=1)) == []
    assert tickets(f) == []


def test_an_empty_course_is_skipped(f):
    """The mains were all cancelled: the desserts come next, after the starters, by their own minutes."""
    auto(f)
    o = order(f, [line("l1", f.salad, 1, f.starters), line("l9", f.cake, 1, f.desserts), line("l2", f.burger, 0, f.main_c)],
              {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=16))})
    assert F.run_pass(f.db, now=NOW) == []  # desserts: 25 minutes
    fired = F.run_pass(f.db, now=NOW + timedelta(minutes=10))
    assert [(x["courseName"], x["printedLines"]) for x in fired] == [("קינוחים", ["l9"])]
    assert "l2" not in extras(reread(f, o))["sent"]


def test_the_next_course_after_the_last_fired_one(f):
    """Mains fired (by the cloud), then the desserts count from the mains."""
    auto(f)
    order(f, [line("l1", f.salad, 1, f.starters), line("l2", f.burger, 1, f.main_c), line("l9", f.cake, 1, f.desserts)],
          {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=16))})
    assert [x["courseName"] for x in F.run_pass(f.db, now=NOW)] == ["עיקריות"]
    assert F.run_pass(f.db, now=NOW + timedelta(minutes=24)) == []
    assert [x["courseName"] for x in F.run_pass(f.db, now=NOW + timedelta(minutes=25))] == ["קינוחים"]


# ── after_ready ───────────────────────────────────────────────────────────────


def test_after_ready_waits_for_the_kds_then_fires(fk):
    auto(fk, "after_ready")
    # The starter is the steak (the grill prepares it); the burger is held at the table.
    o = order(fk, [line("l1", fk.steak, 1, fk.starters), line("l2", fk.burger, 1, fk.main_c)],
              {"l1": sent_row(fk.steak, 1, NOW - timedelta(minutes=16))})
    out = release(fk, till=fk.t1, ref=str(o.id), items=[item("l1:0", fk.steak, 1)], held=[item("l2:0", fk.burger, 1)])
    # Minutes do not count with a KDS: an hour later, still waiting for the grill.
    assert F.run_pass(fk.db, now=NOW + timedelta(hours=1)) == []
    act(fk, fk.grill_screen, "station_ready", orderId=out["orderId"])
    fired = F.run_pass(fk.db, now=datetime.now(timezone.utc) + timedelta(seconds=1))
    assert [(x["courseName"], x["trigger"]) for x in fired] == [("עיקריות", "after_ready")]
    # The screens got the round under the till's release id: the held burger is released, once.
    seed = F.fire_seed(o.id, fk.main_c.id)
    assert fk.db.get(KitchenDispatch, F.fire_release_id(seed)) is not None
    burgers = [t for t in fk.db.query(KitchenTask).all() if t.line_key == "l2:0"]
    assert [t.release_state for t in burgers] == ["released"]
    assert fired[0]["kds"] and not fired[0]["kdsError"]
    # Paper too (the printer is a target of this shop's KDS configuration).
    assert [j.printer_name for j in tickets(fk)] == ["Kitchen"]


def test_after_ready_without_a_kds_counts_minutes(f):
    auto(f, "after_ready")
    starter_and_main(f)
    fired = F.run_pass(f.db, now=NOW)
    assert [(x["courseName"], x["trigger"]) for x in fired] == [("עיקריות", "after_minutes")]


def test_kds_only_prints_nothing(fk):
    configure(fk, enabled=True, defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds"])
    auto(fk)
    o = starter_and_main(fk)
    fired = F.run_pass(fk.db, now=NOW)
    assert len(fired) == 1 and tickets(fk) == []
    seed = F.fire_seed(o.id, fk.main_c.id)
    assert fk.db.get(KitchenDispatch, F.fire_release_id(seed)) is not None


# ── Once ──────────────────────────────────────────────────────────────────────


def test_a_tills_upload_of_the_same_fire_is_the_same_job(f):
    """A till fired the mains at the same moment and uploaded its ticket: the cloud's is that job."""
    auto(f)
    o = starter_and_main(f)
    seed = F.fire_seed(o.id, f.main_c.id)
    job_id = F.fire_job_id(seed, f.p_kitchen)
    send_job(f, f.t1, f.p_kitchen, job_id=job_id)
    fired = F.run_pass(f.db, now=NOW)
    assert fired[0]["jobs"] == [str(job_id)]
    assert [j.id for j in tickets(f)] == [job_id]


def test_a_till_inside_the_table_is_never_disturbed(f):
    auto(f)
    o = starter_and_main(f)
    f.table.lock_machine_id = f.t1.id
    f.table.lock_expires_at = NOW + timedelta(minutes=1)
    f.db.commit()
    assert F.run_pass(f.db, now=NOW) == []
    assert reread(f, o).version == 3 and tickets(f) == []
    # It left (its lock ran out): the first pass after fires it.
    assert len(F.run_pass(f.db, now=NOW + timedelta(minutes=2))) == 1


def test_a_till_that_fired_it_first_wins(f):
    """The waiter pressed "הוצא עכשיו" (the till's save marked it fired and sent): nothing more here."""
    auto(f)
    o = starter_and_main(f)
    x = extras(o)
    x["fired"] = [str(f.main_c.id)]
    x["sent"]["l2"] = sent_row(f.burger, 2, NOW - timedelta(minutes=1))
    o.extras_json = json.dumps(x)
    o.version = 4
    f.db.commit()
    assert F.run_pass(f.db, now=NOW) == [] and tickets(f) == []


def test_two_passes_at_once_fire_once(f):
    auto(f)
    o = starter_and_main(f)
    first = F.fire_if_due(f.db, o.id, now=NOW)
    second = F.fire_if_due(f.db, o.id, now=NOW)
    assert first is not None and second is None
    assert len(tickets(f)) == 1


# ── What ──────────────────────────────────────────────────────────────────────


def test_an_item_that_goes_without_a_bon_is_marked_sent_and_printed_nowhere(f):
    auto(f)
    f.bread.send_silently = True
    f.db.commit()
    o = order(f, [line("l1", f.salad, 1, f.starters), line("l2", f.burger, 1, f.main_c), line("l5", f.bread, 2, f.main_c)],
              {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=16))})
    fired = F.run_pass(f.db, now=NOW)
    assert (fired[0]["printedLines"], fired[0]["silentLines"]) == (["l2"], ["l5"])
    x = extras(reread(f, o))
    assert x["sent"]["l5"]["s"] is True and x["sent"]["l5"]["q"] == 2
    assert x["log"][-1]["l"] == {"l2": 1}
    assert [ln["name"] for ln in tickets(f)[0].payload["lines"]] == ["burger"]


def test_a_dish_made_through_the_menu_reads_as_the_till_prints_it(f):
    auto(f)
    mods = [
        {"groupId": "g", "groupName": "עשייה", "kind": "choice", "optionId": "o1", "name": "Medium", "qty": 1},
        {"groupId": "g2", "groupName": "תוספות", "kind": "addon", "optionId": "o2", "name": "cheese", "kitchenName": "גבינה", "qty": 2, "pre": "extra"},
        {"groupId": "g3", "groupName": "הסרות", "kind": "removal", "optionId": "o3", "name": "onion", "kitchenName": "בצל", "qty": 1},
    ]
    o = order(f, [
        line("l1", f.salad, 1, f.starters),
        line("l2", f.burger, 1, f.main_c, modifiers=mods, notes=["חתוך לחצי"], seat=2, allergies=["milk", "gluten"]),
    ], {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=16))}, seats={"2": "דנה"})
    F.run_pass(f.db, now=NOW)
    (ticket_line,) = tickets(f)[0].payload["lines"]
    assert ticket_line["mods"] == ["Medium", "+ הרבה גבינה ×2"] and ticket_line["removals"] == ["בלי בצל"]
    assert ticket_line["notes"] == "חתוך לחצי" and ticket_line["seat"] == "סועד 2 · דנה"
    assert ticket_line["allergies"] == ["גלוטן", "חלב"] and ticket_line["course"] == "עיקריות"
    # The bookkeeping keeps what the kitchen got of one unit (`k`), for a later void.
    k = json.loads(extras(reread(f, o))["sent"]["l2"]["k"])
    assert k == [{"p": str(f.burger.id), "n": "burger", "q": 1, "c": str(f.mains.id), "m": ["Medium", "+ הרבה גבינה ×2"],
                  "r": ["בלי בצל"], "s": "סועד 2 · דנה", "o": "עיקריות"}]


# ── Not the cloud's ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", ["paid", "cancelled", "merged"])
def test_a_closed_order_is_left_alone(f, status):
    auto(f)
    starter_and_main(f, status=status)
    assert F.run_pass(f.db, now=NOW + timedelta(hours=1)) == []
    assert tickets(f) == []


def test_lan_and_single_till_orders_are_their_tills(f):
    auto(f)
    lan = starter_and_main(f, source="local")
    single = starter_and_main(f, source="local")
    single.cart_json = None
    f.db.commit()
    assert F.candidates(f.db) == []
    assert F.run_pass(f.db, now=NOW + timedelta(hours=1)) == []
    assert F.fire_if_due(f.db, lan.id, now=NOW + timedelta(hours=1)) is None
    assert tickets(f) == []


def test_the_worker_runs_a_pass(f):
    auto(f)
    starter_and_main(f, went_out=datetime.now(timezone.utc) - timedelta(minutes=20))
    factory = lambda: f.db  # noqa: E731 - the world's session (closed by the pass, reopened by SQLAlchemy)
    fired = W.run_once(factory)
    assert fired is not None and [x["courseName"] for x in fired] == ["עיקריות"]
    assert W.run_once(factory) == []


# ── Pure ──────────────────────────────────────────────────────────────────────


def _l(line_id, c, qty=1.0):
    return F.Line(line_id, "p", None, "x", qty, None, {"course": {"id": c[0], "name": c[0], "order": c[1]}} if c else None)


S, M_, D = ("s", 0), ("m", 1), ("d", 2)


def test_which_course_is_next():
    lines = [_l("a", S), _l("b", M_), _l("c", D), _l("z", None)]
    assert F.fired_courses(lines, {}) == {"s"}  # the first course
    assert [c.id for c in F.held_courses(lines, {})] == ["m", "d"]
    # Nothing of the starters sent: no countdown.
    assert F.next_pending(lines, {}) is None
    sent = {"sent": {"a": {"q": 1}}}
    pending = F.next_pending(lines, sent)
    assert (pending.course.id, pending.previous.id, pending.previous_line_ids) == ("m", "s", ("a",))
    # A course the kitchen has lines of is fired whatever: mains sent before a starter was added.
    assert F.fired_courses(lines, {"sent": {"b": {"q": 1}}}) == {"s", "m"}
    # "השהה" on the first course: held too.
    assert F.fired_courses(lines, {"hold": ["s"]}) == set()
    assert F.next_pending(lines, {"sent": {"a": {"q": 1}}, "hold": ["m"]}) is None


def test_the_plan():
    pending = F.next_pending([_l("a", S), _l("b", M_)], {"sent": {"a": {"q": 1}}})
    went = NOW - timedelta(minutes=3)
    plan = F.plan_of(pending, mode="after_minutes", minutes=5, went_out=went, now=NOW)
    assert plan.due_at == went + timedelta(minutes=5) and not plan.due(NOW) and plan.due(NOW + timedelta(minutes=2))
    assert F.plan_of(pending, mode="off", minutes=5, went_out=went, now=NOW) is None
    ready = F.plan_of(pending, mode="after_ready", minutes=5, went_out=went, now=NOW, kds=lambda ids: (True, None))
    assert (ready.trigger, ready.due(NOW)) == ("after_ready", True)
    waiting = F.plan_of(pending, mode="after_ready", minutes=5, went_out=went, now=NOW, kds=lambda ids: (False, None))
    assert waiting.due_at is None
    no_kds = F.plan_of(pending, mode="after_ready", minutes=5, went_out=went, now=NOW, kds=lambda ids: None)
    assert no_kds.trigger == "after_minutes"


def test_a_retried_write_keeps_one_round():
    lines = [_l("a", S), _l("b", M_)]
    first = F.write_fire("o", lines, {"sent": {"a": {"q": 1}}}, F.Course("m", "m", 1), NOW)
    again = F.write_fire("o", lines, first.extras, F.Course("m", "m", 1), NOW)
    assert [r["i"] for r in again.extras["log"]] == [first.seed]
    assert again.printed == []  # nothing more to send


# ── "נשלח (בלי בון)" (§2, the till's rules in §6) ─────────────────────────────


def test_a_line_sent_without_a_bon_never_fires_its_course():
    """The bread of the mains went with the first "שלח" (no ticket): the mains still wait, then go."""
    lines = [_l("a", S), _l("b", M_), _l("bread", M_)]
    x = {"sent": {"a": {"q": 1}, "bread": {"q": 1, "s": True}}}
    assert F.fired_courses(lines, x) == {"s"}
    pending = F.next_pending(lines, x)
    assert pending.course.id == "m"
    write = F.write_fire("o", lines, x, F.Course("m", "m", 1), NOW)
    # The bread is not printed again, and stays "בלי בון"; the burger goes.
    assert [ln.id for ln, _q, _n in write.printed] == ["b"] and write.extras["sent"]["bread"]["s"] is True


def test_a_course_all_sent_without_a_bon_is_skipped():
    """Mains of bread only, all marked sent: nothing to fire there — the desserts are next, after them."""
    lines = [_l("a", S), _l("bread", M_), _l("c", D)]
    x = {"sent": {"a": {"q": 1}, "bread": {"q": 1, "s": True, "a": F.till_time(NOW)}}}
    assert [c.id for c in F.held_courses(lines, x)] == ["d"]
    pending = F.next_pending(lines, x)
    # The mains went out (silently) — the count runs from them; there is nothing of them for a KDS.
    assert (pending.course.id, pending.previous.id, pending.previous_line_ids) == ("d", "m", ())
    assert F.went_out_at(lines, x, "m", None) == NOW


def test_after_ready_waits_only_for_lines_on_paper():
    lines = [_l("a", S), _l("bread", S), _l("b", M_)]
    x = {"sent": {"a": {"q": 1}, "bread": {"q": 1, "s": True}}}
    assert F.next_pending(lines, x).previous_line_ids == ("a",)
