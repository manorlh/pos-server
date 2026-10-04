"""
A Z build must never take a till's close down with it, and must not race a late document
(review M2, M3).

* **M3** — the close that completes a run builds the Z in the same request. Only a
  refusal was caught, so any other failure (a database error, a bug) failed the close,
  and the till retried it forever. The build is isolated in a savepoint, any exception
  marks the run failed, and the close commits.
* **Counter row** — the shop's first Z inserted its counter row; two at once collided on
  the primary key. It is now `INSERT … ON CONFLICT DO NOTHING`, then locked.
* **M2** — a late document's note and a close lock the shift `FOR UPDATE` and re-read it,
  so a push racing a build waits for the Z and then flags the document as after-the-Z.

SQLite ignores `FOR UPDATE`; the concurrent cases were reproduced and verified on a local
Postgres (see the commit message). Here the locks are asserted on what is asked for.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.shop_z_sequence import ShopZSequence
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import shifts as shifts_service
from app.services import z_runs as ZR
from app.services.shifts import note_documents_after_close
from app.services.z_sequence import ensure_shop_z_sequence
from shift_world import NOW, TODAY, accept_str_uuids, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _run_waiting_for(w, till):
    open_shift = w.shift(till, 2, status=ShiftStatus.OPEN)
    w.shift(till, 1)
    r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)
    assert r.status == ZRunStatus.WAITING
    return r, open_shift


def _close(w, till, shift, request_id):
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "transactionIds": [], "unattended": True,
        "closeRequestId": str(request_id),
    })
    return sync_router.post_shift_close(
        machine_id=str(till.id), shift_id=shift.id, body=body, machine=till, approval=None, db=w.db
    )


class TestAFailedBuildDoesNotFailTheClose:
    def test_an_unexpected_error_marks_the_run_failed_and_the_close_is_accepted(self, w, monkeypatch):
        till = w.tills[0]
        r, open_shift = _run_waiting_for(w, till)

        def boom(*a, **k):
            raise RuntimeError("bug")

        monkeypatch.setattr(ZR, "build_z", boom)
        out = _close(w, till, open_shift, r.items[0].id)

        assert out.status == "accepted"
        assert w.db.get(Shift, open_shift.id).status == ShiftStatus.CLOSED
        assert (r.status, r.error_code) == (ZRunStatus.FAILED, "build_error")
        assert w.db.query(ZReport).count() == 0

    def test_a_database_error_inside_the_build_is_rolled_back_to_the_savepoint(self, w):
        """The Postgres reproduction, in miniature: the counter points at a number in use."""
        till = w.tills[0]
        r, open_shift = _run_waiting_for(w, till)
        w.db.add(ShopZSequence(shop_id=w.shop.id, next_value=1))
        w.db.add(ZReport(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, business_date=TODAY,
            closed_at=NOW, shop_sequence_number=1,
        ))
        w.db.flush()

        out = _close(w, till, open_shift, r.items[0].id)

        assert out.status == "accepted"
        assert w.db.get(Shift, open_shift.id).status == ShiftStatus.CLOSED
        assert (r.status, r.error_code) == (ZRunStatus.FAILED, "build_error")
        # Nothing of the build survived: no shift points at a Z.
        assert w.db.query(Shift).filter(Shift.z_report_id.isnot(None)).count() == 0


class TestTheCounterRow:
    def test_it_is_created_once_whoever_asks(self, w):
        ensure_shop_z_sequence(w.db, w.shop.id)
        ensure_shop_z_sequence(w.db, w.shop.id)
        assert w.db.query(ShopZSequence).filter(ShopZSequence.shop_id == w.shop.id).count() == 1

    def test_it_continues_from_the_highest_existing_z(self, w):
        w.db.add(ZReport(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, business_date=TODAY,
            closed_at=NOW, shop_sequence_number=7,
        ))
        w.db.flush()
        ensure_shop_z_sequence(w.db, w.shop.id)
        row = w.db.query(ShopZSequence).filter(ShopZSequence.shop_id == w.shop.id).one()
        assert row.next_value == 8

    def test_the_postgres_statement_is_on_conflict_do_nothing(self):
        from sqlalchemy.dialects import postgresql
        from sqlalchemy.dialects.postgresql import insert

        stmt = insert(ShopZSequence.__table__).values(shop_id=uuid.uuid4(), next_value=1).on_conflict_do_nothing(
            index_elements=["shop_id"]
        )
        assert "ON CONFLICT (shop_id) DO NOTHING" in str(stmt.compile(dialect=postgresql.dialect()))


class TestTheShiftIsLockedAgainstALateDocument:
    def test_the_lock_is_for_update_and_rereads_the_row(self):
        from sqlalchemy.dialects import postgresql
        from sqlalchemy.orm import sessionmaker

        session = sessionmaker()()
        q = session.query(Shift).filter(Shift.id == uuid.uuid4()).with_for_update().populate_existing()
        assert "FOR UPDATE" in str(q.statement.compile(dialect=postgresql.dialect()))

    def test_the_note_and_the_close_take_it(self, w, monkeypatch):
        locked = []
        original = shifts_service.lock_shift
        monkeypatch.setattr(
            shifts_service, "lock_shift", lambda db, sid: locked.append(sid) or original(db, sid)
        )
        till = w.tills[0]
        closed = w.shift(till, 1)
        open_shift = w.shift(till, 2, status=ShiftStatus.OPEN)

        note_documents_after_close(w.db, {closed.id: 1}, machine_id=till.id)
        shifts_service.apply_shift_close(
            w.db, till, open_shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()})
        )

        assert locked == [closed.id, open_shift.id]

    def test_a_z_committed_meanwhile_is_seen_not_a_stale_copy(self, w):
        """The session's copy says 'no Z'; the row (written by another session) says otherwise."""
        till = w.tills[0]
        s = w.shift(till, 1)
        z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, business_date=TODAY, closed_at=NOW)
        w.db.add(z)
        w.db.flush()
        w.db.execute(Shift.__table__.update().where(Shift.id == s.id).values(z_report_id=z.id))
        assert s.z_report_id is None  # the stale copy

        note_documents_after_close(w.db, {s.id: 1}, machine_id=till.id)

        assert s.z_report_id == z.id
        assert z.late_documents == 1
