"""
The machines list's fields for the devices page's filters (client/src/lib/devicesView.ts):
`trainingMode` (its shop in "מצב הדרכה"), `shopActive` (its shop switched off) and
`remoteLocked` ("נעולה" from "שליטה מרחוק", app/services/device_commands.py).

What each test pins, and how it could look fine while doing damage:

* **The list carries them, through the response model** — a field the router computes but
  `POSMachineResponse` lacks is dropped on the way out (it happened to `status` once), so every
  assertion reads the serialized answer, not the router's dict.
* **Per machine, from one query** — the lock comes from `device_remote_states` in a batch; a
  lock of one till must never show on its neighbour, and an unlocked state row is not a lock.
* **Additive** — a machine without a shop answers `shopActive: null` (unknown, not "off"), and
  an answer that never computed the flags (a plain ORM row) reads false / null, not an error.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import pytest

from app.models.device_command import DeviceRemoteState
from app.routers import machines as machines_router
from app.schemas.pos_machine import POSMachineResponse
from app.services import device_commands
from shift_world import NOW, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def listed(w):
    rows = machines_router.list_machines(
        skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
        include_inactive=False, area_id=None, current_user=w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )
    return {
        str(r["id"]): POSMachineResponse.model_validate(r).model_dump(by_alias=True)
        for r in rows
    }


class TestListFilterFields:
    def test_defaults_on_a_plain_world(self, w):
        out = listed(w)
        for till in [*w.tills, w.other_till]:
            row = out[str(till.id)]
            assert row["trainingMode"] is False
            assert row["shopActive"] is True
            assert row["remoteLocked"] is False

    def test_training_and_an_inactive_shop_are_the_shops(self, w):
        w.shop.training_mode = True
        w.other_shop.is_active = False
        w.db.flush()
        out = listed(w)
        assert [out[str(t.id)]["trainingMode"] for t in w.tills] == [True, True]
        assert out[str(w.other_till.id)]["trainingMode"] is False
        assert [out[str(t.id)]["shopActive"] for t in w.tills] == [True, True]
        assert out[str(w.other_till.id)]["shopActive"] is False

    def test_the_lock_is_per_machine_and_an_unlocked_row_is_no_lock(self, w):
        locked, unlocked = w.tills
        w.db.add_all([
            DeviceRemoteState(machine_id=locked.id, tenant_id=w.tenant.id, locked=True, locked_at=NOW),
            DeviceRemoteState(machine_id=unlocked.id, tenant_id=w.tenant.id, locked=False),
        ])
        w.db.flush()
        out = listed(w)
        assert out[str(locked.id)]["remoteLocked"] is True
        assert out[str(unlocked.id)]["remoteLocked"] is False
        assert out[str(w.other_till.id)]["remoteLocked"] is False
        assert device_commands.locked_machine_ids(w.db, [locked.id, unlocked.id, w.other_till.id]) == {locked.id}
        assert device_commands.locked_machine_ids(w.db, []) == set()

    def test_one_machine_alone_reads_its_own_lock(self, w):
        till = w.tills[0]
        w.db.add(DeviceRemoteState(machine_id=till.id, tenant_id=w.tenant.id, locked=True, locked_at=NOW))
        w.db.flush()
        row = machines_router._enrich_machine_status(till, w.db)
        assert row["remoteLocked"] is True
        assert row["trainingMode"] is False and row["shopActive"] is True

    def test_no_shop_is_unknown_not_off(self, w):
        till = w.tills[1]
        till.shop_id = None
        till.pos_number = None
        w.db.flush()
        w.db.refresh(till)
        row = machines_router._enrich_machine_status(till, w.db)
        out = POSMachineResponse.model_validate(row).model_dump(by_alias=True)
        assert out["shopActive"] is None
        assert out["trainingMode"] is False

    def test_a_plain_orm_row_reads_the_defaults(self, w):
        out = POSMachineResponse.model_validate(w.tills[0]).model_dump(by_alias=True)
        assert out["trainingMode"] is False
        assert out["shopActive"] is None
        assert out["remoteLocked"] is False
