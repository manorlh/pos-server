"""
"Z סניפי / Z לכל קופה" set on a shop or a point of sale, and a till's own Z.

What is pinned:

* **Where the mode comes from** — the point of sale's, else its shop's, else the
  organization's default; "shop" when nobody says.
* **A till's own Z** — under "Z לכל קופה" a run is for one till alone, its Z belongs to
  that till and is numbered by the till's own counter from 1, and draws no shop number.
* **Mixed shops** — a shop Z neither takes nor waits for the tills on their own Z.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.services import ably_notify
from app.services import z_runs as ZR
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world
from test_z_run import closed_shift, sel

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _area(w, name="Bar", settings=None):
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name=name, settings=settings or {})
    w.db.add(area)
    w.db.flush()
    return area


def _run(w, *selections):
    return ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, list(selections), now=NOW)


def _z(w, r) -> ZReport:
    assert r.status == ZRunStatus.COMPLETED, (r.status, r.error_code, r.error_message)
    return w.db.get(ZReport, r.z_report_id)


class TestWhereTheModeComesFrom:
    def test_shop_by_default(self, w):
        assert ZR.z_scope_of_machine(w.db, w.tills[0]) == "shop"

    def test_the_organizations_default(self, w):
        w.tenant.settings = {"zScope": "machine"}
        assert ZR.z_scope_of_machine(w.db, w.tills[0]) == "machine"

    def test_the_shop_overrides_the_organization(self, w):
        w.tenant.settings = {"zScope": "machine"}
        w.shop.settings = {"zScope": "shop"}
        assert ZR.z_scope_of_machine(w.db, w.tills[0]) == "shop"

    def test_the_point_of_sale_overrides_its_shop(self, w):
        area = _area(w, settings={"zScope": "machine"})
        w.tills[0].area_id = area.id
        w.db.flush()
        assert ZR.z_scope_of_machine(w.db, w.tills[0]) == "machine"
        assert ZR.z_scope_of_machine(w.db, w.tills[1]) == "shop"


class TestATillsOwnZ:
    def test_numbered_from_one_per_till_and_no_shop_number(self, w):
        w.shop.settings = {"zScope": "machine"}
        t1, t2 = w.tills
        closed_shift(w, t1, 1, [dict(total="10.00")])
        closed_shift(w, t2, 1, [dict(total="20.00")])

        z1 = _z(w, _run(w, sel(t1)))
        z2 = _z(w, _run(w, sel(t2)))

        assert (z1.machine_id, z1.machine_sequence_number, z1.shop_sequence_number) == (t1.id, 1, None)
        assert (z2.machine_id, z2.machine_sequence_number) == (t2.id, 1)
        assert z1.per_till and z1.z_number == 1
        assert (z1.header or {}).get("zScope") == "machine"

        closed_shift(w, t1, 2, [dict(total="5.00")])
        assert _z(w, _run(w, sel(t1))).machine_sequence_number == 2

    def test_never_two_tills_in_one(self, w):
        w.shop.settings = {"zScope": "machine"}
        with pytest.raises(HTTPException) as e:
            _run(w, sel(w.tills[0]), sel(w.tills[1]))
        assert e.value.detail == "z_scope_machine_one_till"

    def test_another_tills_open_shift_does_not_hold_it(self, w):
        """A till's own Z waits for nobody else: the other till is not part of it."""
        w.shop.settings = {"zScope": "machine", "shopZOpenTills": "block"}
        t1, t2 = w.tills
        closed_shift(w, t1, 1, [dict(total="10.00")])
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        r = _run(w, sel(t1))
        assert r.z_scope == "machine"
        assert _z(w, r).machine_id == t1.id


class TestMixedShop:
    def test_a_shop_z_neither_takes_nor_waits_for_the_tills_on_their_own(self, w):
        area = _area(w, settings={"zScope": "machine"})
        t1, t2 = w.tills
        t2.area_id = area.id
        w.db.flush()
        closed_shift(w, t1, 1, [dict(total="10.00")])
        closed_shift(w, t2, 1, [dict(total="20.00")])

        # The shop Z of the shop-mode till: t2's closed shift does not count as left behind.
        z = _z(w, _run(w, sel(t1)))
        assert z.shop_sequence_number == 1 and z.machine_sequence_number is None

        # t2 makes its own.
        own = _z(w, _run(w, sel(t2)))
        assert (own.machine_id, own.machine_sequence_number) == (t2.id, 1)

    def test_tills_not_closed_names_an_open_till_and_one_awaiting_a_z(self, w):
        t1, t2 = w.tills
        w.shift(t1, 1, status=ShiftStatus.OPEN)
        closed_shift(w, t2, 1, [dict(total="10.00")])

        blocking = {b["machineId"]: b for b in ZR.tills_not_closed(w.db, [t1, t2, w.other_till])}
        assert blocking[str(t1.id)]["openShift"] is True
        assert blocking[str(t2.id)]["awaitingZ"] == 1
        assert str(w.other_till.id) not in blocking


class TestTheShiftIsTheZ:
    def test_an_accepted_close_under_per_till_produces_its_z(self, w):
        w.shop.settings = {"zScope": "machine"}
        t1 = w.tills[0]
        shift = closed_shift(w, t1, 1, [dict(total="10.00")])

        r = ZR.z_on_own_close(w.db, t1, shift)

        z = _z(w, r)
        assert (z.machine_id, z.machine_sequence_number) == (t1.id, 1)
        assert w.db.get(type(shift), shift.id).z_report_id == z.id

    def test_nothing_under_shop_z(self, w):
        shift = closed_shift(w, w.tills[0], 1, [dict(total="10.00")])
        assert ZR.z_on_own_close(w.db, w.tills[0], shift) is None
        assert shift.z_report_id is None
