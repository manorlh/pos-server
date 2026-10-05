"""
The owner's rules for a till's Z mode (app/services/z_mode_policy.py), and "מצב דו״ח Z" on a
shop page (app/routers/z_mode.py):

* Only the super admin switches a till's `zMode` — on its own page or for a whole shop or
  point of sale.
* Only over a clean break: a till with an open shift refuses the switch (`till_open`), on
  top of `set_z_mode`'s own rules (shifts waiting for a Z, a Z under way).
* A shop or point of sale switches all or nothing: one till that may not switch stops it,
  named, and no till changes.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import z_mode as R
from app.schemas.pos_machine import POSMachineUpdate
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for till in world.tills:
        till.z_mode = "cloud"
    world.db.commit()
    return world


def put(w, mode, area_id=None, user=None):
    return R.put_z_mode(
        w.shop.id, R.ZModeIn(zMode=mode, areaId=area_id),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def distributor(w):
    u = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=w.tenant.id, email="d@x", username="dist")
    w.db.add(u)
    w.db.flush()
    for till in w.tills:
        till.distributor_id = u.id
    w.db.flush()
    return u


def test_a_shop_switches_as_a_whole(w):
    out = put(w, "till")
    assert {t["zMode"] for t in out["tills"]} == {"till"}
    assert all(t.z_mode == "till" for t in w.tills)
    back = put(w, "cloud")
    assert {t["zMode"] for t in back["tills"]} == {"cloud"}
    assert out["canEdit"] is True


def test_a_point_of_sale_alone(w):
    bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
    w.db.add(bar)
    w.db.flush()
    w.tills[1].area_id = bar.id
    w.db.flush()
    put(w, "till", area_id=bar.id)
    assert (w.tills[0].z_mode, w.tills[1].z_mode) == ("cloud", "till")


def test_one_open_till_stops_the_shop_and_nothing_changes(w):
    shift = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
    out = put(w, "till")
    assert out.status_code == 409
    body = json.loads(out.body)
    assert body["detail"] == "till_open"
    assert (body["machineId"], body["shiftId"]) == (str(w.tills[1].id), str(shift.id))
    assert [t.z_mode for t in w.tills] == ["cloud", "cloud"]


def test_the_super_admin_alone(w):
    d = distributor(w)
    with pytest.raises(HTTPException) as e:
        put(w, "till", user=d)
    assert e.value.status_code == 403
    # On a till's own page too.
    with pytest.raises(HTTPException) as e:
        machines_router.update_machine(
            str(w.tills[0].id), POSMachineUpdate.model_validate({"zMode": "till"}), d, w.tenant.id, w.db
        )
    assert (e.value.status_code, e.value.detail) == (403, "super_admin_only")
    # The same mode again is no change, so no refusal.
    machines_router.update_machine(
        str(w.tills[0].id), POSMachineUpdate.model_validate({"zMode": "cloud"}), d, w.tenant.id, w.db
    )
