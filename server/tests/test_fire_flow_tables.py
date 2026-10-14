"""
"FIRE כמו במסעדות" + "שיגור מתוזמן של פריט" in the cloud's tables (P:/specs/fire-restaurant-flow.md §8.3–§8.5,
app/services/course_auto_fire.py, app/services/fire_flow.py).

What each test pins, and how it could look fine while doing damage:

* **A scheduled line** goes by itself at its time, once (a second pass, or two at once, never a second bon),
  under `sched|<order>|<scheduleId>`; it never goes with its course's fire, never early, never while a till is
  inside the table, never on a closed table — and going out it does not make its course "fired" (`sch`).
* **"אחרי שמוכן"** waits for the target's KDS tasks; without a KDS, the target's send + the minutes.
* **The table's choice** ("מתי עיקריות?", `fireWhen`) wins over the shop's `autoFire`: "ידנית" never goes,
  "בעוד X דק'" goes X minutes after the choice even with `autoFire` off.
* **The KDS** shows a scheduled line greyed (a hold task with `scheduledAt`), and not at all with
  `kdsShowScheduled` off; when the line goes, the hold task is released and the mark cleared.
* **Hints** — "אל תציג שוב" per employee: merged, idempotent, in the roster, never across shops.

Runs on the world of tests/test_course_auto_fire.py (SQLite).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.kds import KitchenTask
from app.models.pos_user import PosUser, PosUserRole
from app.models.tables import TableEvent
from app.routers import sync as S
from app.services import course_auto_fire as F
from app.services import fire_flow as FF
from app.services import kds as KDS
from test_course_auto_fire import (  # noqa: F401 - fixtures
    NOW, auto, extras, f, fk, line, order, reread, sent_row, starter_and_main, tickets,
)
from test_kds import act, item, kd, release  # noqa: F401 - fixtures
from test_kitchen_printers import k, w  # noqa: F401 - fixtures
from test_table_void_tickets import set_param

SID = "5b0f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b"


def sched(**kw):
    return {"scheduleId": SID, "by": "manual", "setAt": F.till_time(NOW - timedelta(minutes=20)), **kw}


def dessert_later(w, at, **extra):
    """Starter and main went out; the cake (desserts) is scheduled for `at`."""
    return order(w, [
        line("l1", w.salad, 1, w.starters), line("l2", w.burger, 1, w.main_c), line("l3", w.cake, 1, w.desserts),
    ], {
        "l1": sent_row(w.salad, 1, NOW - timedelta(minutes=30)), "l2": sent_row(w.burger, 1, NOW - timedelta(minutes=20)),
    }, fired=[str(w.starters.id), str(w.main_c.id)], schedule={"l3": sched(scheduledAt=F.till_time(at))}, **extra)


# ── The ids ───────────────────────────────────────────────────────────────────


def test_the_seed_of_a_scheduled_round():
    """Pinned against Java (temurin 17): UUID.nameUUIDFromBytes("sched|<order>|<scheduleId>")."""
    seed = FF.schedule_seed("6f1c2b9e-4d3a-4e8f-9b7c-1a2b3c4d5e6f", SID)
    from app.services.table_void_tickets import java_name_uuid

    assert seed == str(java_name_uuid(f"sched|6f1c2b9e-4d3a-4e8f-9b7c-1a2b3c4d5e6f|{SID}"))
    assert uuid.UUID(seed).version == 3


# ── A scheduled line ──────────────────────────────────────────────────────────


def test_a_scheduled_line_goes_at_its_time_once(f):
    o = dessert_later(f, NOW)
    assert F.run_pass(f.db, now=NOW - timedelta(seconds=30)) == []  # not before
    fired = F.run_pass(f.db, now=NOW)
    assert [(x["scheduleId"], x["printedLines"]) for x in fired] == [(SID, ["l3"])]
    seed = FF.schedule_seed(o.id, SID)
    x = extras(reread(f, o))
    assert x["sent"]["l3"]["sch"] is True and x["sent"]["l3"]["a"] == F.till_time(NOW)
    assert "schedule" not in x
    assert x["log"][-1] == {"i": seed, "a": F.till_time(NOW), "l": {"l3": 1}, "auto": True, "sched": SID}
    # Desserts did not become "fired" by it.
    assert str(f.desserts.id) not in x["fired"]
    jobs = tickets(f)
    assert [j.id for j in jobs] == [F.fire_job_id(seed, f.p_kitchen)]
    assert jobs[0].payload["notice"] == "מתוזמן" and jobs[0].payload["fire"] == "קינוחים (מתוזמן)"
    # Never again: a second pass, later.
    assert F.run_pass(f.db, now=NOW + timedelta(minutes=5)) == []
    assert len(tickets(f)) == 1
    ev = f.db.query(TableEvent).filter(TableEvent.kind == "send").all()
    assert [e.details.get("scheduleId") for e in ev] == [SID]


def test_the_same_schedule_raced_is_one_job(f):
    """Two passes at once (two instances): the job of the round exists — the second is the same job."""
    o = dessert_later(f, NOW)
    found = F.scheduled_due(o.id, F.cart_lines(o.cart_json), F.extras_of(o.extras_json), NOW)
    assert [d.line_ids for d in found] == [("l3",)]
    F.run_pass(f.db, now=NOW)
    # A till that sent the same round meanwhile uploaded under the same id: still one.
    assert len({j.id for j in tickets(f)}) == 1


def test_a_course_fire_leaves_a_scheduled_line_alone(f):
    auto(f)
    o = order(f, [
        line("l1", f.salad, 1, f.starters), line("l2", f.burger, 1, f.main_c), line("l4", f.bread, 1, f.main_c),
    ], {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=16))},
        schedule={"l4": sched(scheduledAt=F.till_time(NOW + timedelta(minutes=10)))})
    fired = F.run_pass(f.db, now=NOW)
    assert [(x.get("courseName"), x["printedLines"]) for x in fired] == [("עיקריות", ["l2"])]
    x = extras(reread(f, o))
    assert "l4" not in x["sent"] and "l4" in x["schedule"]
    # Its time: it goes alone.
    later = F.run_pass(f.db, now=NOW + timedelta(minutes=10))
    assert [(x.get("scheduleId"), x["printedLines"]) for x in later] == [(SID, ["l4"])]


def test_a_course_whose_waiting_lines_are_all_scheduled_is_not_held(f):
    lines = [F.Line("l1", "p", None, "salad", 1.0, None, {"course": {"id": "s", "name": "ראשונות", "order": 0}}),
             F.Line("l3", "p", None, "cake", 1.0, None, {"course": {"id": "d", "name": "קינוחים", "order": 2}})]
    ex = {"sent": {"l1": {"q": 1}}, "schedule": {"l3": sched(scheduledAt=F.till_time(NOW))}}
    assert F.held_courses(lines, ex) == [] and F.held_after(lines, ex) == []


def test_never_while_a_till_is_inside_never_on_a_closed_table(f):
    o = dessert_later(f, NOW)
    f.table.lock_machine_id = f.t1.id
    f.table.lock_expires_at = NOW + timedelta(minutes=1)
    f.db.commit()
    assert F.run_pass(f.db, now=NOW) == []
    f.table.lock_expires_at = NOW - timedelta(seconds=1)
    f.db.commit()
    assert len(F.run_pass(f.db, now=NOW)) == 1
    closed = dessert_later(f, NOW, status="paid")
    assert F.fire_scheduled_if_due(f.db, closed.id, now=NOW) == []
    assert o.id != closed.id


def test_after_ready_without_a_kds_counts_from_the_targets_send(f):
    o = order(f, [line("l1", f.salad, 1, f.starters), line("l2", f.burger, 1, f.main_c), line("l5", f.cola, 1)],
              {"l1": sent_row(f.salad, 1, NOW - timedelta(minutes=30)),
               "l2": sent_row(f.burger, 1, NOW - timedelta(minutes=10))},
              fired=[str(f.main_c.id)],
              schedule={"l5": sched(scheduleAfterReady={"course": str(f.main_c.id)}, afterMinutes=10)})
    assert F.run_pass(f.db, now=NOW - timedelta(seconds=1)) == []  # 10 minutes after the mains: now
    fired = F.run_pass(f.db, now=NOW)
    assert [x["printedLines"] for x in fired] == [["l5"]]
    assert o is not None


def test_after_ready_waits_for_the_kds(fk):
    o = order(fk, [line("l1", fk.steak, 1, fk.starters), line("l5", fk.cola, 1)],
              {"l1": sent_row(fk.steak, 1, NOW - timedelta(minutes=16))},
              schedule={"l5": sched(scheduleAfterReady={"course": str(fk.starters.id)})})
    out = release(fk, till=fk.t1, ref=str(o.id), items=[item("l1:0", fk.steak, 1)])
    assert F.run_pass(fk.db, now=NOW + timedelta(hours=1)) == []
    act(fk, fk.grill_screen, "station_ready", orderId=out["orderId"])
    fired = F.run_pass(fk.db, now=datetime.now(timezone.utc) + timedelta(seconds=1))
    assert [x["printedLines"] for x in fired] == [["l5"]]


# ── The table's choice ("מתי עיקריות?") ───────────────────────────────────────


def choose(mode, minutes=None, at=NOW - timedelta(minutes=5)):
    return {"mode": mode, **({"minutes": minutes} if minutes is not None else {}), "setAt": F.till_time(at)}


def test_in_x_minutes_goes_with_autofire_off(f):
    o = starter_and_main(f, fireWhen={})
    x = extras(o)
    x["fireWhen"] = {str(f.main_c.id): choose("minutes", 10)}
    o.extras_json = json.dumps(x)
    f.db.commit()
    assert F.run_pass(f.db, now=NOW) == []  # chosen 5 minutes ago: 5 more
    fired = F.run_pass(f.db, now=NOW + timedelta(minutes=5))
    assert [(x["courseName"], x["printedLines"]) for x in fired] == [("עיקריות", ["l2"])]
    ev = [e for e in f.db.query(TableEvent).all() if e.kind == "send"]
    assert ev[-1].details.get("byTable") is True


def test_manual_wins_over_the_shops_autofire(f):
    auto(f)
    o = starter_and_main(f)
    x = extras(o)
    x["fireWhen"] = {str(f.main_c.id): choose("manual")}
    o.extras_json = json.dumps(x)
    f.db.commit()
    assert F.run_pass(f.db, now=NOW + timedelta(hours=2)) == []


def test_a_choice_for_another_course_leaves_the_shops_autofire(f):
    auto(f)
    o = starter_and_main(f)
    x = extras(o)
    x["fireWhen"] = {str(f.desserts.id): choose("manual")}
    o.extras_json = json.dumps(x)
    f.db.commit()
    assert len(F.run_pass(f.db, now=NOW)) == 1


def test_pause_wins_over_the_tables_choice(f):
    o = starter_and_main(f, hold=None)
    x = extras(o)
    x["fireWhen"] = {str(f.main_c.id): choose("minutes", 1)}
    x["hold"] = [str(f.main_c.id)]
    o.extras_json = json.dumps(x)
    f.db.commit()
    assert F.run_pass(f.db, now=NOW + timedelta(hours=1)) == []


# ── The KDS ───────────────────────────────────────────────────────────────────


def test_the_kds_shows_a_scheduled_line_greyed_then_releases_it(fk):
    at = NOW + timedelta(minutes=25)
    o = order(fk, [line("l1", fk.steak, 1, fk.starters), line("l2", fk.burger, 1, fk.main_c)],
              {"l1": sent_row(fk.steak, 1, NOW - timedelta(minutes=16))},
              schedule={"l2": sched(scheduledAt=F.till_time(at))})
    held = F.scheduled_held(fk.db, fk.t1, F.cart_lines(o.cart_json), F.extras_of(o.extras_json))
    assert [(h["lineKey"], h["scheduledAt"]) for h in held] == [("l2:0", F.till_time(at))]
    release(fk, till=fk.t1, ref=str(o.id), items=[item("l1:0", fk.steak, 1)], held=held)
    task = next(t for t in fk.db.query(KitchenTask).all() if t.line_key == "l2:0")
    assert task.release_state == "hold" and task.scheduled_at is not None
    out = KDS.task_out(task)
    assert out["scheduledAt"] and out["release"] == "hold"
    # Its time: the cloud sends it — the hold task released, the mark gone.
    fired = F.run_pass(fk.db, now=at)
    assert [x["printedLines"] for x in fired] == [["l2"]]
    fk.db.expire_all()
    burgers = [t for t in fk.db.query(KitchenTask).all() if t.line_key == "l2:0"]
    assert [(t.release_state, t.scheduled_at) for t in burgers] == [("released", None)]


def test_kds_show_scheduled_off_sends_none(fk):
    set_param(fk, "kdsShowScheduled", "shop", fk.shop.id, False)
    o = order(fk, [line("l2", fk.burger, 1, fk.main_c)], {},
              schedule={"l2": sched(scheduledAt=F.till_time(NOW + timedelta(minutes=5)))})
    assert F.scheduled_held(fk.db, fk.t1, F.cart_lines(o.cart_json), F.extras_of(o.extras_json)) == []


# ── Hints ─────────────────────────────────────────────────────────────────────


def employee(w, shop_id=None):
    u = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop_id or w.shop.id, username=f"u{uuid.uuid4().hex[:6]}",
        first_name="דנה", pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
    )
    w.db.add(u)
    w.db.commit()
    return u


def hints(w, till, user, **body):
    return S.post_pos_user_hints(str(till.id), str(user.id), S.PosUserHintsIn(**body), machine=till, db=w.db)


def test_hints_dismissed_per_employee(f):
    u = employee(f)
    assert hints(f, f.t1, u, dismiss=["fire.intro"])["hintsDismissed"] == ["fire.intro"]
    # Idempotent, merged: another till adds its own.
    assert hints(f, f.t1, u, dismiss=["fire.intro"])["hintsDismissed"] == ["fire.intro"]
    assert hints(f, f.t2, u, dismiss=["fire.held"])["hintsDismissed"] == ["fire.intro", "fire.held"]
    # In the roster.
    roster = S.get_pos_users_sync(str(f.t1.id), since=None, machine=f.t1, db=f.db, response=None)
    row = next(r for r in roster.users if r.id == u.id)
    assert row.hints_dismissed == ["fire.intro", "fire.held"]
    assert row.model_dump(by_alias=True)["hintsDismissed"] == ["fire.intro", "fire.held"]
    # "הצג שוב את ההסבר".
    assert hints(f, f.t1, u, restore=["fire.intro", "fire.held", "fire.ask"])["hintsDismissed"] == []
    f.db.expire_all()
    assert f.db.get(PosUser, u.id).hints_dismissed is None


def test_hints_never_across_shops_nor_odd_keys(f):
    from app.models.shop import Shop

    other = Shop(id=uuid.uuid4(), tenant_id=f.tenant.id, company_id=f.company.id, name="אחר")
    f.db.add(other)
    f.db.commit()
    stranger = employee(f, other.id)
    with pytest.raises(HTTPException) as e:
        hints(f, f.t1, stranger, dismiss=["fire.intro"])
    assert e.value.status_code == 404
    u = employee(f)
    with pytest.raises(HTTPException) as e:
        hints(f, f.t1, u, dismiss=["Fire Intro!"])
    assert e.value.status_code == 422
