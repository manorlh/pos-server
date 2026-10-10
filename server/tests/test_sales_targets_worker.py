"""
"יעד הושג" never depends on stock (app/services/sales_targets_worker.py): the sales targets' pass is a
job of its own, started whatever `STOCK_LOCATIONS_ENABLED` and `STOCK_RESET_WORKER_ENABLED` say, and
a target's hit is recorded once however many instances run it.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.sales_target import SalesTarget, SalesTargetHit
from app.services import sales_targets_worker as W
from event_live_world import at, make_event, sale
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    # Stock is off, its daily reset worker too — the state the release is in today.
    monkeypatch.setenv("STOCK_LOCATIONS_ENABLED", "false")
    monkeypatch.setenv("STOCK_RESET_WORKER_ENABLED", "false")
    return world


def _event_target(w, amount="250"):
    event = make_event(w)
    w.db.add(SalesTarget(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                         scope="shop", period="event", event_id=event.id, amount=Decimal(amount)))
    w.db.flush()
    return event


def _sessions(w):
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=w.db.get_bind())


def test_a_target_hit_is_recorded_with_stock_and_its_reset_worker_off(w):
    from app.services.stock_locations import locations_enabled

    assert locations_enabled() is False
    event_id = str(_event_target(w).id)
    sale(w, w.tills[0], 10, "300")
    w.db.commit()
    assert W.run_once(_sessions(w), now=at(30)) == 1           # a session of its own, as in the API
    hits = w.db.query(SalesTargetHit).all()
    assert len(hits) == 1 and hits[0].period_key == event_id and hits[0].actual == Decimal("300.00")


def test_its_own_job_starts_when_the_stock_worker_does_not(w, monkeypatch):
    from app import main
    from app.services import stock_reset

    started = {}
    monkeypatch.setattr(stock_reset, "start_background_worker", lambda *a, **k: started.setdefault("stock", True))
    monkeypatch.setattr(W, "start_background_worker", lambda *a, **k: started.setdefault("targets", True))
    main.start_stock_reset_worker()
    main.start_sales_targets_worker()
    assert started == {"targets": True}                       # the stock worker is off; the targets' pass runs

    monkeypatch.setenv(W.ENV_SWITCH, "false")
    assert W.enabled() is False                               # its own switch only


def test_the_pass_is_idempotent_across_instances(w):
    _event_target(w)
    sale(w, w.tills[0], 10, "300")
    w.db.commit()
    for minute in (30, 30, 31):                               # two instances in one minute, then the next
        W.run_once(_sessions(w), now=at(minute))
    assert w.db.query(SalesTargetHit).count() == 1


def test_one_instance_takes_the_pass_on_postgres():
    class Conn:
        def __init__(self, free):
            self.dialect = SimpleNamespace(name="postgresql")
            self.free = free
            self.sql = []

        def execute(self, statement, params):
            self.sql.append((str(statement), params["k"]))
            return SimpleNamespace(scalar=lambda: self.free)

    mine, other = Conn(True), Conn(False)
    assert W.try_lock(mine) is True and W.try_lock(other) is False
    assert mine.sql[0] == ("SELECT pg_try_advisory_lock(:k)", W.LOCK_KEY)
    W.unlock(mine)
    assert mine.sql[-1] == ("SELECT pg_advisory_unlock(:k)", W.LOCK_KEY)
    assert W.try_lock(SimpleNamespace(dialect=SimpleNamespace(name="sqlite"))) is True


def test_the_stock_loop_no_longer_runs_the_targets_pass():
    import inspect

    from app.services import stock_reset

    assert "evaluate_due" not in inspect.getsource(stock_reset.start_background_worker)
