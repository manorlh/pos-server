"""
"שיוך קופות מהיר לאירוע" under concurrency, on a real Postgres: two sessions racing, as the review
reproduced them (one transaction holds its locks open while the other runs in a thread).

1. A confirmed event never changes: an add, or a move out of it, waits for the confirmation and
   then sees it (409 / nothing taken from it).
2. A till never ends up in two overlapping drafts: a window edit and an add serialise.
3. A crossed move + add never deadlocks into a 500: every loser is a 409.
4. Locks first, then the event's tills re-read: two identical adds are one row, both succeed; a
   duplicate the database still catches, and a deadlock, are a 409.
5. The history shows no email.

Needs Postgres: runs with RUN_PG_EVENT_RACES=1 and a scratch DATABASE_URL (its database name must
end in "_test"). Every test seeds its own tenant; nothing is cleaned up.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

URL = os.environ.get("DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_PG_EVENT_RACES") != "1" or not URL.startswith("postgresql") or not URL.endswith("_test"),
    reason="opt-in: RUN_PG_EVENT_RACES=1 with a scratch Postgres DATABASE_URL (…_test)",
)

from fastapi import HTTPException  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

HOLD_SECONDS = 1.5


@pytest.fixture(scope="module")
def S():
    from app.database import Base
    import app.models  # noqa: F401

    engine = create_engine(URL, pool_size=10)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine)
    engine.dispose()


def seed(S, tills=4):
    from app.models.company import Company
    from app.models.pos_machine import PairingStatus, POSMachine
    from app.models.shop import Shop
    from app.models.tenant import Tenant
    from app.models.user import User, UserRole

    db = S()
    tag = uuid.uuid4().hex[:8]
    tenant = Tenant(id=uuid.uuid4(), name="T" + tag, slug="t" + tag, timezone="Asia/Jerusalem")
    db.add(tenant)
    db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="Acme", vat_number="515151515")
    db.add(company)
    db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="Center", settings={})
    db.add(shop)
    db.flush()
    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email=f"a{tag}@example.test",
                 username="adm" + tag)
    db.add(admin)
    db.flush()
    ids = []
    for i in range(tills):
        m = POSMachine(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, distributor_id=admin.id,
                       name=f"Till {i}", machine_code=f"M-{tag}-{i}", pos_number=str(i + 1), is_active=True,
                       pairing_status=PairingStatus.ASSIGNED)
        db.add(m)
        ids.append(m.id)
    db.commit()
    out = {"tenant": tenant.id, "shop": shop.id, "admin": admin.id, "admin_name": admin.username, "tills": ids}
    db.close()
    return out


def make_event(S, ids, name, starts, ends, machine_ids):
    from app.models.report_event import EVENT_DRAFT, ReportEvent, ReportEventMachine

    db = S()
    e = ReportEvent(id=uuid.uuid4(), tenant_id=ids["tenant"], shop_id=ids["shop"], name=name, starts_at=starts,
                    ends_at=ends, timezone="Asia/Jerusalem", status=EVENT_DRAFT)
    db.add(e)
    db.flush()
    for mid in machine_ids:
        db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=mid))
    db.commit()
    eid = e.id
    db.close()
    return eid


def state(S, event_id):
    """(status, {machine_id: released?})"""
    from app.models.report_event import ReportEvent

    db = S()
    ev = db.get(ReportEvent, event_id)
    out = (ev.status, {r.machine_id: r.released_at is not None for r in ev.machines})
    db.close()
    return out


def admin(db, ids):
    from app.models.user import User

    return db.get(User, ids["admin"])


def bulk(S, ids, event_id, *, add=(), remove=(), move=()):
    """The router, in its own session (it commits or rolls back itself)."""
    from app.routers import report_events as R
    from app.schemas.report_event import ReportEventTillsChange

    db = S()
    try:
        return R.change_report_event_tills(
            event_id, ReportEventTillsChange(add=list(add), remove=list(remove), move=list(move)),
            current_user=admin(db, ids), active_tenant_id=ids["tenant"], db=db,
        )
    finally:
        db.close()


def race(S, hold, other):
    """
    `hold(db)` runs and keeps its transaction open (its locks held); `other()` runs in a thread
    meanwhile. Returns whether `other` was still blocked when `hold` committed, and its outcome.
    """
    db_b = S()
    hold(db_b)
    result = {}

    def worker():
        try:
            result["ok"] = other()
        except HTTPException as exc:
            result["http"] = (exc.status_code, exc.detail.get("code") if isinstance(exc.detail, dict) else exc.detail)
        except Exception as exc:  # noqa: BLE001 — a 500 is what we are looking for
            result["error"] = repr(exc)[:300]

    t = threading.Thread(target=worker)
    t.start()
    time.sleep(HOLD_SECONDS)
    blocked = t.is_alive()
    db_b.commit()
    db_b.close()
    t.join(30)
    assert not t.is_alive(), "the waiting request never finished"
    return blocked, result


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


# ── 1. A confirmed event never changes ────────────────────────────────────────


def test_an_add_waits_for_the_confirmation_and_is_refused(S):
    from app.services.report_events import crud as C

    ids = seed(S)
    t0, t1 = ids["tills"][:2]
    now = now_utc()
    e1 = make_event(S, ids, "R1", now - timedelta(hours=5), now - timedelta(hours=4), [t0])

    def confirm(db):
        ev = C.load_event(db, admin(db, ids), ids["tenant"], e1, write=True, draft=True)
        C.confirm_event(db, admin(db, ids), ids["tenant"], ev, force=True, note=None)

    blocked, result = race(S, confirm, lambda: bulk(S, ids, e1, add=[t1]))
    assert blocked
    assert result == {"http": (409, "event_confirmed")}
    assert state(S, e1) == ("confirmed", {t0: True})


def test_a_move_out_of_an_event_being_confirmed_takes_nothing_from_it(S):
    from app.services.report_events import crud as C

    ids = seed(S)
    t1 = ids["tills"][1]
    base = now_utc() - timedelta(days=3)
    e4 = make_event(S, ids, "R3-E4", base, base + timedelta(hours=3), [t1])
    e5 = make_event(S, ids, "R3-E5", base + timedelta(hours=1), base + timedelta(hours=2), [])

    def confirm(db):
        ev = C.load_event(db, admin(db, ids), ids["tenant"], e4, write=True, draft=True)
        C.confirm_event(db, admin(db, ids), ids["tenant"], ev, force=True, note=None)

    blocked, result = race(S, confirm, lambda: bulk(S, ids, e5, move=[t1]))
    assert blocked
    assert "ok" in result, result
    # The confirmed event keeps its (released) till; the draft takes it as a free till, no move.
    assert state(S, e4) == ("confirmed", {t1: True})
    assert state(S, e5) == ("draft", {t1: False})
    assert result["ok"]["changes"]["moved"] == [] and result["ok"]["changes"]["added"] == [str(t1)]


def test_the_confirmation_waits_for_an_assignment_in_flight(S):
    from app.services.report_events import crud as C

    ids = seed(S)
    t0, t1 = ids["tills"][:2]
    now = now_utc()
    e1 = make_event(S, ids, "R1b", now - timedelta(hours=5), now - timedelta(hours=4), [t0])

    def add(db):
        ev = C.load_event(db, admin(db, ids), ids["tenant"], e1, write=True, draft=True)
        C.change_tills(db, admin(db, ids), ids["tenant"], ev, add=[t1])

    def confirm():
        from app.routers import report_events as R
        from app.schemas.report_event import ReportEventConfirm

        db = S()
        try:
            return R.confirm_report_event(e1, ReportEventConfirm(force=True), current_user=admin(db, ids),
                                          active_tenant_id=ids["tenant"], db=db)
        finally:
            db.close()

    blocked, result = race(S, add, confirm)
    assert blocked and "ok" in result, result
    # Confirmed with both tills, both released: the till added first is in the frozen event.
    assert state(S, e1) == ("confirmed", {t0: True, t1: True})


# ── 2. Never one till in two overlapping drafts ───────────────────────────────


def test_a_window_edit_and_an_add_serialise(S):
    from app.schemas.report_event import ReportEventUpdate
    from app.services.report_events import crud as C

    ids = seed(S)
    t0, _t1, t2 = ids["tills"][:3]
    base = now_utc() + timedelta(days=30)
    e2 = make_event(S, ids, "R2-E2", base, base + timedelta(hours=2), [t0])
    e3 = make_event(S, ids, "R2-E3", base + timedelta(hours=5), base + timedelta(hours=7), [t2])
    tz = C.zone("Asia/Jerusalem")
    s, e = (base + timedelta(hours=4)).astimezone(tz), (base + timedelta(hours=6)).astimezone(tz)

    def move_window(db):
        ev = C.load_event(db, admin(db, ids), ids["tenant"], e2, write=True, draft=True)
        C.update_event(db, admin(db, ids), ids["tenant"], ev, ReportEventUpdate(
            startDate=s.date().isoformat(), startTime=s.strftime("%H:%M"),
            endDate=e.date().isoformat(), endTime=e.strftime("%H:%M"),
        ))

    blocked, result = race(S, move_window, lambda: bulk(S, ids, e2, add=[t2]))
    assert blocked
    assert result == {"http": (409, "till_in_overlapping_event")}
    assert state(S, e2)[1] == {t0: False}
    assert state(S, e3)[1] == {t2: False}


def test_another_events_window_edit_and_an_add_serialise_on_the_till(S):
    from app.schemas.report_event import ReportEventUpdate
    from app.services.report_events import crud as C

    ids = seed(S)
    t0, _t1, t2 = ids["tills"][:3]
    base = now_utc() + timedelta(days=31)
    e2 = make_event(S, ids, "R2b-E2", base, base + timedelta(hours=2), [t0])
    e3 = make_event(S, ids, "R2b-E3", base + timedelta(hours=5), base + timedelta(hours=7), [t2])
    tz = C.zone("Asia/Jerusalem")
    s, e = (base + timedelta(hours=1)).astimezone(tz), (base + timedelta(hours=6)).astimezone(tz)

    def widen_e3(db):
        # E3 (holding Till 2) grows back over E2's window, its tills locked while it does.
        ev = C.load_event(db, admin(db, ids), ids["tenant"], e3, write=True, draft=True)
        C.update_event(db, admin(db, ids), ids["tenant"], ev, ReportEventUpdate(
            startDate=s.date().isoformat(), startTime=s.strftime("%H:%M"),
            endDate=e.date().isoformat(), endTime=e.strftime("%H:%M"),
        ))

    blocked, result = race(S, widen_e3, lambda: bulk(S, ids, e2, add=[t2]))
    assert blocked
    assert result == {"http": (409, "till_in_overlapping_event")}
    assert t2 not in state(S, e2)[1]


# ── 3. Crossed moves: a 409, never a 500 ──────────────────────────────────────


def _crossed(S, ids, sides, monkeypatch):
    """Run the bulk calls together, each paused after taking its own event's lock."""
    from app.services.report_events import crud as C

    barrier = threading.Barrier(len(sides))
    original = C.lock_assignment

    def paused(*a, **k):
        try:
            barrier.wait(2)
        except threading.BrokenBarrierError:
            pass
        return original(*a, **k)

    monkeypatch.setattr(C, "lock_assignment", paused)
    results = {}

    def side(key, event_id, kwargs):
        try:
            results[key] = ("ok", bulk(S, ids, event_id, **kwargs)["changes"])
        except HTTPException as exc:
            results[key] = ("http", exc.status_code, exc.detail.get("code"))
        except Exception as exc:  # noqa: BLE001
            results[key] = ("error", repr(exc)[:300])

    threads = [threading.Thread(target=side, args=(k, e, kw)) for k, (e, kw) in sides.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(40)
    return results


def no_till_twice(S, ids, events):
    seen = {}
    for e in events:
        st, tills = state(S, e)
        if st != "draft":
            continue
        for m, released in tills.items():
            if not released:
                assert m not in seen, f"till {m} in {seen[m]} and {e}"
                seen[m] = e


def test_crossed_move_and_add_are_409s_not_a_500(S, monkeypatch):
    ids = seed(S)
    t0, t1 = ids["tills"][:2]
    base = now_utc() + timedelta(days=60)
    e6 = make_event(S, ids, "R4-E6", base, base + timedelta(hours=2), [])
    e7 = make_event(S, ids, "R4-E7", base, base + timedelta(hours=2), [])
    e8 = make_event(S, ids, "R4-E8", base, base + timedelta(hours=2), [t0, t1])
    results = _crossed(S, ids, {
        "A": (e6, {"move": [t0], "add": [t1]}),
        "B": (e7, {"move": [t1], "add": [t0]}),
    }, monkeypatch)
    assert all(r[0] != "error" for r in results.values()), results
    # Each adds a till the other event (E8) still holds without asking to move it: both refused.
    assert results["A"][:2] == ("http", 409) and results["B"][:2] == ("http", 409)
    assert state(S, e8)[1] == {t0: False, t1: False}
    no_till_twice(S, ids, [e6, e7, e8])


def test_two_moves_of_one_till_one_wins_the_other_is_a_409(S, monkeypatch):
    ids = seed(S)
    t0 = ids["tills"][0]
    base = now_utc() + timedelta(days=61)
    e6 = make_event(S, ids, "R5-E6", base, base + timedelta(hours=2), [])
    e7 = make_event(S, ids, "R5-E7", base, base + timedelta(hours=2), [])
    e8 = make_event(S, ids, "R5-E8", base, base + timedelta(hours=2), [t0])
    results = _crossed(S, ids, {"A": (e6, {"move": [t0]}), "B": (e7, {"move": [t0]})}, monkeypatch)
    outcomes = sorted(r[0] for r in results.values())
    assert outcomes == ["http", "ok"], results
    loser = next(r for r in results.values() if r[0] == "http")
    # The loser saw the till in E8; it is not taken from the winner behind the user's back.
    assert loser[1:] in ((409, "concurrent_change"), (409, "till_in_overlapping_event"))
    assert state(S, e8)[1] == {}
    no_till_twice(S, ids, [e6, e7, e8])


def test_moves_in_opposite_directions_never_end_in_a_500(S, monkeypatch):
    ids = seed(S)
    t0, t1 = ids["tills"][:2]
    base = now_utc() + timedelta(days=62)
    e6 = make_event(S, ids, "R6-E6", base, base + timedelta(hours=2), [t0])
    e7 = make_event(S, ids, "R6-E7", base, base + timedelta(hours=2), [t1])
    # E6 takes Till 1 from E7 while E7 takes Till 0 from E6: the events' locks cross.
    results = _crossed(S, ids, {"A": (e6, {"move": [t1]}), "B": (e7, {"move": [t0]})}, monkeypatch)
    assert all(r[0] != "error" for r in results.values()), results
    assert any(r[0] == "ok" for r in results.values()) or all(r[1] == 409 for r in results.values())
    no_till_twice(S, ids, [e6, e7])


# ── 4. Re-read under the locks; duplicates and deadlocks are 409s ─────────────


def test_two_identical_adds_are_one_row_and_both_succeed(S):
    from app.models.report_event import ReportEventMachine, ReportEventMachineChange

    ids = seed(S)
    t3 = ids["tills"][3]
    base = now_utc() + timedelta(days=90)
    e9 = make_event(S, ids, "R7", base, base + timedelta(hours=2), [])
    barrier = threading.Barrier(2)
    results = []

    def side():
        barrier.wait(5)
        try:
            results.append(("ok", bulk(S, ids, e9, add=[t3])["changes"]["added"]))
        except Exception as exc:  # noqa: BLE001
            results.append(("error", repr(exc)[:300]))

    threads = [threading.Thread(target=side) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert sorted(results) == [("ok", []), ("ok", [str(t3)])], results
    db = S()
    assert db.query(ReportEventMachine).filter(ReportEventMachine.event_id == e9).count() == 1
    assert db.query(ReportEventMachineChange).filter(ReportEventMachineChange.event_id == e9).count() == 1
    db.close()


def test_a_duplicate_the_database_catches_is_a_409(S):
    from app.models.report_event import ReportEventMachine
    from app.services.report_events import crud as C

    ids = seed(S)
    t0 = ids["tills"][0]
    base = now_utc() + timedelta(days=91)
    e = make_event(S, ids, "R8", base, base + timedelta(hours=2), [t0])
    db = S()
    with pytest.raises(HTTPException) as exc:
        with C.atomic(db):
            db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e, machine_id=t0))
            db.flush()
    db.close()
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "till_already_assigned"
    assert state(S, e)[1] == {t0: False}


def test_a_deadlock_is_a_409(S):
    from app.models.report_event import ReportEvent
    from app.services.report_events import crud as C

    ids = seed(S)
    base = now_utc() + timedelta(days=92)
    a = make_event(S, ids, "R9-a", base, base + timedelta(hours=1), [])
    b = make_event(S, ids, "R9-b", base, base + timedelta(hours=1), [])
    barrier = threading.Barrier(2)
    results = []

    def side(first, second):
        db = S()
        try:
            with C.atomic(db):
                db.query(ReportEvent).filter(ReportEvent.id == first).with_for_update().one()
                barrier.wait(5)
                db.query(ReportEvent).filter(ReportEvent.id == second).with_for_update().one()
            results.append("ok")
        except HTTPException as exc:
            results.append((exc.status_code, exc.detail.get("code")))
        except Exception as exc:  # noqa: BLE001
            results.append(repr(exc)[:200])
        finally:
            db.close()

    threads = [threading.Thread(target=side, args=(a, b)), threading.Thread(target=side, args=(b, a))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert sorted(results, key=str) == sorted(["ok", (409, "concurrent_change")], key=str), results


# ── 5. No email in the history ────────────────────────────────────────────────


def test_the_history_shows_usernames_never_emails(S):
    from app.models.user import User, UserRole
    from app.routers import report_events as R

    ids = seed(S)
    t0 = ids["tills"][0]
    base = now_utc() + timedelta(days=93)
    e = make_event(S, ids, "R10", base, base + timedelta(hours=2), [])
    db = S()
    tag = uuid.uuid4().hex[:6]
    mailer = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=ids["tenant"],
                  email=f"m{tag}@example.test", username=f"m{tag}@example.test")
    db.add(mailer)
    db.commit()
    from app.schemas.report_event import ReportEventTillsChange

    R.change_report_event_tills(e, ReportEventTillsChange(add=[t0]), current_user=mailer,
                                active_tenant_id=ids["tenant"], db=db)
    bulk(S, ids, e, remove=[t0])
    out = R.get_report_event_till_changes(e, current_user=admin(db, ids), active_tenant_id=ids["tenant"], db=db)
    db.close()
    assert sorted((c["action"], c["by"]) for c in out["changes"]) == [("added", None), ("removed", ids["admin_name"])]
    assert "@" not in repr([c["by"] for c in out["changes"]])
