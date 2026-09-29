"""
A Z is one shop's, shift by shift (review H2, M4, UI-4 and the candidates' status light).

* **H2** — a till moved to another shop carried its un-Z'd shifts into the new shop's Z:
  the builder filtered by till only. It now takes a till's shifts of *this* shop
  (`shifts.shop_id`), and moving a till with an open shift or shifts awaiting a Z is
  refused (409).
* **M4** — the same refusal for retiring (`isActive: false`) and deleting a till, and a
  till that is already retired, unpaired or moved away with closed shifts of this shop
  still awaiting a Z is listed as a candidate here, and its shifts can be taken.
* **UI-4** — the candidates show the till's heartbeat claim only when a close could
  still answer it; the status light reads the real pairing and close-pending state.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.pos_machine import PairingStatus
from app.models.shift import Shift, ShiftStatus
from app.models.z_report import ZReport
from app.models.z_run import ZRunItemStatus, ZRunStatus
from app.routers import machines as machines_router
from app.routers import z_runs as z_router
from app.schemas.pos_machine import POSMachineUpdate
from app.services import ably_notify
from app.services import z_runs as ZR
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "shop_belongs_to_company", lambda *a: True)
    return world


def _run(w, shop, *tills):
    return ZR.create_z_run(
        w.db, w.admin, w.tenant, shop, [ZR.MachineSelection(machine_id=t.id) for t in tills], now=NOW
    )


def _candidates(w, shop):
    w.db.commit()
    out = z_router.get_z_candidates(shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    return {m.machine_id: m for m in out.machines}


def _moved(w, till, to_shop):
    """A till moved before the refusal existed: its old shifts stay in the old shop."""
    till.shop_id = to_shop.id


class TestAMovedTillsShiftsStayInTheirShop:
    def test_the_new_shops_z_does_not_take_the_old_shops_shift(self, w):
        till = w.tills[0]
        old = w.shift(till, 1)  # worked in w.shop
        _moved(w, till, w.other_shop)
        new = w.shift(till, 2)  # worked in w.other_shop

        r = _run(w, w.other_shop, till)

        z = w.db.get(ZReport, r.z_report_id)
        assert {s.id for s in z.shifts} == {new.id}
        assert w.db.get(Shift, old.id).z_report_id is None

    def test_the_old_shop_lists_it_and_its_z_takes_it(self, w):
        till = w.tills[0]
        old = w.shift(till, 1)
        _moved(w, till, w.other_shop)
        w.shift(till, 2)

        cands = _candidates(w, w.shop)
        assert [s.id for s in cands[till.id].closed_shifts] == [old.id]
        assert cands[till.id].in_shop is False

        r = _run(w, w.shop, till)
        assert {s.id for s in w.db.get(ZReport, r.z_report_id).shifts} == {old.id}

    def test_an_explicit_through_shift_of_another_shop_is_not_a_candidate(self, w):
        till = w.tills[0]
        w.shift(till, 1)
        _moved(w, till, w.other_shop)
        foreign = w.shift(till, 2)

        with pytest.raises(HTTPException) as e:
            ZR.create_z_run(
                w.db, w.admin, w.tenant, w.shop,
                [ZR.MachineSelection(machine_id=till.id, through_shift_id=foreign.id)], now=NOW,
            )
        assert e.value.detail == f"through_shift_not_candidate:{till.id}"


class TestATillWithShiftsKeepsItsShop:
    @pytest.mark.parametrize("state", ["open", "awaiting_z"])
    def test_a_shop_change_is_refused(self, w, state):
        till = w.tills[0]
        if state == "open":
            w.shift(till, 1, status=ShiftStatus.OPEN)
        else:
            w.shift(till, 1)

        with pytest.raises(HTTPException) as e:
            machines_router.update_machine(
                str(till.id), POSMachineUpdate(shopId=w.other_shop.id), w.admin, w.tenant.id, w.db
            )

        assert e.value.status_code == 409
        assert e.value.detail == ("machine_has_open_shift" if state == "open" else "machine_has_shifts_awaiting_z")
        assert till.shop_id == w.shop.id

    def test_clearing_the_shop_and_retiring_are_refused_too(self, w):
        till = w.tills[0]
        w.shift(till, 1)
        for update in (POSMachineUpdate(shopId=None), POSMachineUpdate(isActive=False)):
            with pytest.raises(HTTPException) as e:
                machines_router.update_machine(str(till.id), update, w.admin, w.tenant.id, w.db)
            assert e.value.status_code == 409

    def test_deleting_is_refused(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        with pytest.raises(HTTPException) as e:
            machines_router.delete_machine(str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (e.value.status_code, e.value.detail) == (409, "machine_has_open_shift")
        assert till.is_active

    def test_once_every_shift_is_in_a_z_it_may_move(self, w, monkeypatch):
        # The register-number allocator uses a Postgres regex; not what is tested here.
        monkeypatch.setattr(machines_router, "set_machine_shop", lambda db, m, sid: setattr(m, "shop_id", sid))
        till = w.tills[0]
        w.shift(till, 1)
        _run(w, w.shop, till)

        machines_router.update_machine(
            str(till.id), POSMachineUpdate(shopId=w.other_shop.id), w.admin, w.tenant.id, w.db
        )

        assert till.shop_id == w.other_shop.id

    def test_renaming_is_not_leaving(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        machines_router.update_machine(str(till.id), POSMachineUpdate(name="door"), w.admin, w.tenant.id, w.db)
        assert till.name == "door"


class TestARetiredTillsShiftsStillReachAZ:
    def _retire(self, till):
        till.is_active = False
        till.pairing_status = PairingStatus.UNPAIRED
        till.shop_id = None

    def test_it_is_a_candidate_with_its_orphans_counted(self, w):
        till = w.tills[0]
        s = w.shift(till, 1)
        w.doc(till, None, "5.00")  # an orphan: no shift
        self._retire(till)

        cands = _candidates(w, w.shop)

        row = cands[till.id]
        assert [x.id for x in row.closed_shifts] == [s.id]
        assert row.in_shop is False and row.is_active is False
        assert row.status == "retired"
        assert row.orphan_documents == 1

    def test_its_shifts_are_taken_and_it_is_never_asked_to_close(self, w):
        till = w.tills[0]
        s = w.shift(till, 1)
        till.reported_open_shift_id = uuid.uuid4()  # a stale claim from its last beat
        self._retire(till)

        r = _run(w, w.shop, till)

        assert r.status == ZRunStatus.COMPLETED
        assert r.items[0].status == ZRunItemStatus.READY
        assert w.db.get(Shift, s.id).z_report_id == r.z_report_id

    def test_a_retired_till_with_nothing_awaiting_is_not_listed(self, w):
        till = w.tills[0]
        self._retire(till)
        assert till.id not in _candidates(w, w.shop)


class TestTheCandidatesReadTheRealState:
    def test_a_claim_for_a_shift_the_cloud_holds_closed_is_not_shown(self, w):
        till = w.tills[0]
        done = w.shift(till, 1)
        till.reported_open_shift_id = done.id
        assert _candidates(w, w.shop)[till.id].till_reported_open_shift_id is None

    def test_a_live_claim_is_shown(self, w):
        till = w.tills[0]
        claimed = uuid.uuid4()
        till.reported_open_shift_id = claimed
        assert _candidates(w, w.shop)[till.id].till_reported_open_shift_id == claimed

    def test_the_light_shows_a_pending_close(self, w, monkeypatch):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        till.last_heartbeat_at = None  # the light reads the real clock; keep it deterministic
        _run(w, w.shop, till)
        from app.services import machine_status

        till.last_heartbeat_at = machine_status.datetime.now(machine_status.timezone.utc) - timedelta(seconds=5)

        assert _candidates(w, w.shop)[till.id].status == "shift_close_pending"
