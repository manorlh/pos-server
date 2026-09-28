"""
What the machines page and the Z list tell the dashboard (contract review follow-ups).

* `GET /machines`: `reportedOpenShiftId` only while a close could still answer it (not a
  shift the cloud holds closed), and the pending close's source — `pendingCloseSource`
  `"z_run"` (with `pendingZRunId`) or `"request"`.
* `GET /z-reports`: the effective business-date window, the 90-day default included.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.models.shift import ShiftStatus
from app.routers import machines as machines_router
from app.routers import z_reports as zr_router
from app.services import ably_notify
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from shift_world import NOW, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _rows(w):
    return {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}


class TestTheMachinesPage:
    def test_a_stale_claim_is_not_shown(self, w):
        till = w.tills[0]
        done = w.shift(till, 1)
        till.reported_open_shift_id = done.id
        assert _rows(w)[till.id]["reportedOpenShiftId"] is None

    def test_a_live_claim_is_shown(self, w):
        till = w.tills[0]
        claim = uuid.uuid4()
        till.reported_open_shift_id = claim
        assert _rows(w)[till.id]["reportedOpenShiftId"] == claim

    def test_the_source_of_a_pending_close(self, w):
        by_run, by_request = w.tills
        w.shift(by_run, 1, status=ShiftStatus.OPEN)
        w.shift(by_request, 1, status=ShiftStatus.OPEN)
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=by_run.id)], now=NOW)
        SCR.request_close(w.db, w.admin, by_request, now=NOW)

        rows = _rows(w)

        assert (rows[by_run.id]["pendingCloseSource"], rows[by_run.id]["pendingZRunId"]) == ("z_run", r.id)
        assert (rows[by_request.id]["pendingCloseSource"], rows[by_request.id]["pendingZRunId"]) == ("request", None)
        assert rows[by_run.id]["closeShiftPending"] and rows[by_request.id]["closeShiftPending"]

    def test_nothing_pending(self, w):
        row = _rows(w)[w.tills[0].id]
        assert (row["pendingCloseSource"], row["pendingZRunId"], row["closeShiftPending"]) == (None, None, False)

    def test_the_response_model_carries_them(self):
        from app.schemas.pos_machine import POSMachineResponse

        fields = POSMachineResponse.model_fields
        assert fields["pending_close_source"].alias == "pendingCloseSource"
        assert fields["pending_z_run_id"].alias == "pendingZRunId"


class TestTheZListWindow:
    def _list(self, w, **kw):
        args = dict(
            machine_id=None, machine_ids=None, shop_id=None, from_date=None, to_date=None,
            closed_from=None, closed_to=None, page=1, page_size=50,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        args.update(kw)
        return zr_router.list_z_reports(**args)

    def test_the_default_is_the_last_90_days_and_says_so(self, w):
        out = self._list(w).model_dump(by_alias=True, mode="json")
        expected = (datetime.now(timezone.utc) - timedelta(days=90)).date().isoformat()
        assert out["window"] == {"from": expected, "to": None, "defaulted": True}

    def test_a_given_range_is_echoed(self, w):
        out = self._list(w, from_date=date(2026, 9, 1), to_date=date(2026, 9, 30)).model_dump(by_alias=True, mode="json")
        assert out["window"] == {"from": "2026-09-01", "to": "2026-09-30", "defaulted": False}
