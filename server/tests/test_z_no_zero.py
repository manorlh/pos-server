"""
No Z on nothing — the user's rule "אל תאפשר לסגור Z על 0".

A Z over shifts with no activity at all (no document of any kind, no money, no cash moved
between shifts — the opening float is not activity) is refused before a Z number is drawn:
the master till's shop Z is not started, the status it polls says so, and the builder
itself refuses whatever reaches it. A refund alone, or a single small sale, is activity.

Runs on the in-memory SQLite world of tests/shift_world.py, with the shop Z helpers.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunStatus
from app.routers import till_shop_z as R
from app.services.z_builder import EMPTY_Z, EMPTY_Z_MESSAGE, figures_show_activity
from app.services.shift_totals import compute_totals
from test_shop_z_strict import close, figures, item_of, open_shift_with_sales, poll, start, w  # noqa: F401


def status(w):
    master = w.tills[0]
    return R.till_shop_z_status(str(master.id), machine=master, db=w.db)


class TestNoZOnZero:
    def test_open_shifts_with_no_documents_cannot_start_a_shop_z(self, w):
        t1, t2 = w.tills
        w.shift(t1, 1, status=ShiftStatus.OPEN)
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        seen = status(w)
        assert seen["activity"]["hasActivity"] is False
        assert seen["activity"]["message"] == EMPTY_Z_MESSAGE

        with pytest.raises(HTTPException) as refused:
            start(w)
        assert refused.value.status_code == 409
        assert refused.value.detail == {"code": EMPTY_Z, "message": EMPTY_Z_MESSAGE}
        # Nothing written: no run, no Z, no number drawn.
        assert w.db.query(ZRun).count() == 0
        assert w.db.query(ZReport).count() == 0

    def test_a_closed_shift_with_nothing_in_it_is_refused_too(self, w):
        t1, t2 = w.tills
        w.shift(t1, 1)  # closed, accepted, no documents
        w.shift(t2, 1)
        with pytest.raises(HTTPException) as refused:
            start(w)
        assert refused.value.status_code == 409
        assert w.db.query(ZReport).count() == 0

    def test_one_small_sale_is_activity_and_the_z_is_made(self, w):
        t1, t2 = w.tills
        s1, d1 = open_shift_with_sales(w, t1, 1, "0.10")
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        assert status(w)["activity"]["hasActivity"] is True
        run = start(w)
        close(w, t1, s1, d1, till_figures=figures("0.10"), request_id=item_of(run, t1)["id"])
        s2 = w.db.query(type(s1)).filter_by(machine_id=t2.id).one()
        close(w, t2, s2, [], till_figures=figures(), request_id=item_of(run, t2)["id"])
        done = poll(w, run)
        assert done["status"] == ZRunStatus.COMPLETED
        assert w.db.query(ZReport).count() == 1

    def test_a_refund_alone_is_activity(self, w):
        t1, _t2 = w.tills
        shift = w.shift(t1, 1)
        w.doc(t1, shift, "-25.00", credit_note=True)
        totals = compute_totals(w.db, [shift.id])
        assert figures_show_activity(totals) is True

    def test_the_float_alone_is_not_activity(self, w):
        t1, _t2 = w.tills
        shift = w.shift(t1, 1, opening_cash="500.00", counted_cash="480.00")
        totals = compute_totals(w.db, [shift.id])
        assert figures_show_activity(totals) is False
