"""
The heartbeat's `closedOpenShift` (docs/SHIFTS_API.md §1.6, 2026-10-07).

"אם קופה נסגרה תחזיר אותה באופן מיידי למסך ראשי קופה סגורה": a shift closed from the cloud
by no close of the till's — administratively (§2.9, dead-till recovery forced on a till that
came back) or by support — stays open on the till until the till hears of it. The beat that
still reports it open is told, so the till closes it on its side too and shows "קופה סגורה".

Only this till's own shift, only one the cloud holds closed: an unknown shift (its open has not
arrived), an open one, or another till's (§1.1) is never named.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.shift import ShiftStatus
from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody
from shift_world import NOW, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _beat(w, till, shift_id=None):
    data = {}
    if shift_id is not None:
        data = {"openShiftId": str(shift_id), "openShiftOpenedAt": NOW.isoformat()}
    body = MachineHeartbeatBody.model_validate(data)
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)


class TestClosedOpenShift:
    def test_a_shift_the_cloud_closed_is_named_to_the_till_that_still_reports_it_open(self, w):
        till = w.tills[0]
        shift = w.shift(till, 4, status=ShiftStatus.CLOSED)
        shift.reconstructed = True
        w.db.flush()

        response = _beat(w, till, shift.id)

        block = response["closedOpenShift"]
        assert block["shiftId"] == str(shift.id)
        assert block["reconstructed"] is True
        assert block["closedAt"] is not None

    def test_said_again_on_every_beat_while_the_till_reports_it(self, w):
        till = w.tills[0]
        shift = w.shift(till, 4, status=ShiftStatus.CLOSED)
        assert "closedOpenShift" in _beat(w, till, shift.id)
        assert "closedOpenShift" in _beat(w, till, shift.id)
        # Closed on the till: it reports none open, and hears nothing more.
        assert "closedOpenShift" not in _beat(w, till, None)

    def test_an_open_shift_is_never_named(self, w):
        till = w.tills[0]
        shift = w.shift(till, 4, status=ShiftStatus.OPEN, close_now=False)
        assert "closedOpenShift" not in _beat(w, till, shift.id)

    def test_an_unknown_shift_is_never_named(self, w):
        assert "closedOpenShift" not in _beat(w, w.tills[0], uuid.uuid4())

    def test_another_tills_closed_shift_is_never_named(self, w):
        theirs = w.shift(w.tills[1], 4, status=ShiftStatus.CLOSED)
        assert "closedOpenShift" not in _beat(w, w.tills[0], theirs.id)

    def test_no_shift_reported_names_nothing(self, w):
        w.shift(w.tills[0], 4, status=ShiftStatus.CLOSED)
        assert "closedOpenShift" not in _beat(w, w.tills[0], None)
