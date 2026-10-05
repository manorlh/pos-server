"""
The lifecycle of a Z run around its edges (review L1, L2, L3, UI-3).

* **L1** — cancel, proceed and expiry write the run's state: each locks the run and
  re-checks its status first, as the till-side completion already did.
* **L2** — a run that expires with a ready till is built with the ready ones (the
  expired and failed tills left out, their shifts kept for the next Z); it used to
  stay `waiting` forever. Nothing ready → the run expires.
* **L3** — every road to a closed shift completes what waits on it: an administrative
  close, and a till's later duplicate close.
* **UI-3** — `proceed` never excludes a ready till.
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.shift_close_request import ShiftCloseRequestStatus as S
from app.models.z_report import ZReport
from app.models.z_run import ZRunItemStatus, ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from app.services.administrative_close import close_shift_administratively
from app.services.shifts import apply_shift_close
from shift_world import NOW, accept_str_uuids, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _run(w, *tills):
    return ZR.create_z_run(
        w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=t.id) for t in tills], now=NOW
    )


def _item(r, till):
    return next(i for i in r.items if i.machine_id == till.id)


class TestStateWritesLockTheRun:
    @pytest.fixture
    def locked(self, monkeypatch):
        seen = []
        original = ZR.lock_run
        monkeypatch.setattr(ZR, "lock_run", lambda db, r: seen.append(r.id) or original(db, r))
        return seen

    def test_cancel(self, w, locked):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        r = _run(w, w.tills[0])
        locked.clear()
        ZR.cancel_run(w.db, r)
        assert locked and locked[0] == r.id and r.status == ZRunStatus.CANCELLED

    def test_proceed(self, w, locked):
        w.shift(w.tills[0], 1)
        w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
        r = _run(w, *w.tills)
        locked.clear()
        ZR.proceed_without(w.db, r, [w.tills[1].id], now=NOW)
        assert locked and locked[0] == r.id and r.status == ZRunStatus.COMPLETED

    def test_expiry(self, w, locked):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        r = _run(w, w.tills[0])
        locked.clear()
        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=37))
        assert locked and locked[0] == r.id and r.status == ZRunStatus.EXPIRED

    def test_a_run_finished_meanwhile_is_not_cancelled(self, w):
        w.shift(w.tills[0], 1)
        r = _run(w, w.tills[0])
        assert r.status == ZRunStatus.COMPLETED
        with pytest.raises(Exception) as e:
            ZR.cancel_run(w.db, r)
        assert getattr(e.value, "detail", None) == "run_not_waiting"


class TestExpiryFinalisesWithTheReadyTills:
    def test_expired_and_failed_tills_are_left_out(self, w):
        t1, t2 = w.tills
        ready = w.shift(t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        r = _run(w, t1, t2)
        ZR.apply_close_shift_ack(w.db, t2, request_id=_item(r, t2).id, phase="failed", error_code="printer")
        assert r.status == ZRunStatus.WAITING  # a failed till still needs the operator …

        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=37))

        # … until the TTL: then the Z is built with what is ready.
        assert r.status == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, r.z_report_id)
        assert {s.id for s in z.shifts} == {ready.id}
        assert _item(r, t2).status == ZRunItemStatus.FAILED

    def test_nothing_ready_expires_the_run(self, w):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        r = _run(w, w.tills[0])
        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=37))
        assert r.status == ZRunStatus.EXPIRED
        assert _item(r, w.tills[0]).status == ZRunItemStatus.EXPIRED

    def test_not_yet_due_changes_nothing(self, w):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        r = _run(w, w.tills[0])
        assert ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=1)) == 0
        assert r.status == ZRunStatus.WAITING


class TestARunNothingCanMoveEnds:
    """The till stuck on "מפיק את ה-Z…": its only till refused (open tables), so nothing
    was on its way and nothing ready, yet the run waited 36 hours for its TTL."""

    def test_the_last_till_refusing_ends_the_run_with_its_reason(self, w):
        t1 = w.tills[0]
        w.shift(t1, 1, status=ShiftStatus.OPEN)
        r = _run(w, t1)
        ZR.apply_close_shift_ack(
            w.db, t1, request_id=_item(r, t1).id, phase="failed",
            error_code="open_tables", error_message="open tables: 3, מנור",
        )
        assert r.status == ZRunStatus.FAILED
        assert r.error_code == ZR.TILLS_FAILED
        assert "שולחנות פתוחים (3, מנור)" in r.error_message
        # The shop is free for a new Z once the tables are closed.
        assert ZR.expire_overdue_runs(w.db, now=NOW + timedelta(minutes=5)) == 0

    def test_a_till_still_closing_keeps_it_waiting(self, w):
        t1, t2 = w.tills
        w.shift(t1, 1, status=ShiftStatus.OPEN)
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        r = _run(w, t1, t2)
        ZR.apply_close_shift_ack(w.db, t1, request_id=_item(r, t1).id, phase="failed", error_code="open_tables")
        assert r.status == ZRunStatus.WAITING
        ZR.apply_close_shift_ack(w.db, t2, request_id=_item(r, t2).id, phase="failed", error_code="no_open_shift")
        assert r.status == ZRunStatus.FAILED
        assert "יש בה שולחנות פתוחים" in r.error_message and "אין בה משמרת פתוחה" in r.error_message

    def test_a_run_already_stalled_ends_on_the_next_read(self, w):
        t1 = w.tills[0]
        w.shift(t1, 1, status=ShiftStatus.OPEN)
        r = _run(w, t1)
        item = _item(r, t1)
        item.status = ZRunItemStatus.FAILED  # as a run stalled before this fix
        item.error_code = "open_tables"
        w.db.flush()
        assert ZR.expire_overdue_runs(w.db, now=NOW + timedelta(minutes=5)) == 1
        assert r.status == ZRunStatus.FAILED


class TestEveryRoadToAClosedShiftCompletesTheWait:
    def test_an_administrative_close_makes_the_item_ready_and_builds(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=5)
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        till.reported_open_shift_id = open_shift.id
        r = _run(w, till)
        assert r.status == ZRunStatus.WAITING

        close_shift_administratively(w.db, till, open_shift, w.admin, now=NOW)

        assert r.status == ZRunStatus.COMPLETED
        assert w.db.get(Shift, open_shift.id).z_report_id == r.z_report_id
        # The heartbeat claim is dropped, as on the till's own close.
        assert till.reported_open_shift_id is None

    def test_an_administrative_close_completes_a_close_request(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=5)
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        req, _ = SCR.request_close(w.db, w.admin, till, now=NOW)

        close_shift_administratively(w.db, till, open_shift, w.admin, now=NOW)

        assert req.status == S.COMPLETED

    def test_a_duplicate_till_close_makes_a_waiting_item_ready(self, w):
        till = w.tills[0]
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        r = _run(w, till)
        # Closed by a road that did not complete the wait (as before this was wired).
        apply_shift_close(w.db, till, open_shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
        assert r.status == ZRunStatus.WAITING

        out = sync_router.post_shift_close(
            machine_id=str(till.id), shift_id=open_shift.id,
            body=ShiftCloseIn.model_validate({"closedAt": NOW.isoformat(), "closeRequestId": str(r.items[0].id)}),
            machine=till, approval=None, db=w.db,
        )

        assert out.status == "duplicate"
        assert r.status == ZRunStatus.COMPLETED
        assert out.z_report_id == r.z_report_id

    def test_the_basis_reads_the_outbox_depth_when_the_till_predates_the_split(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=5)
        till.pending_documents = None
        till.pending_count = 4
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        shift, _ = close_shift_administratively(w.db, till, open_shift, w.admin, now=NOW)

        assert shift.reconstruction_basis["lastReportedPendingDocuments"] == 4
