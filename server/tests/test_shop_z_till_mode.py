"""
The shop Z (master till, dashboard) beside a till that produces its own Z.

A till in `zMode = till` (docs/SHIFTS_API.md §5) is never part of a cloud Z: the master
till's shop Z does not list it, select it, count its activity or wait for it; the
open-tills rule (`shopZOpenTills`) never counts it as left behind; and the master's start
never hands it to `create_z_run`, which would refuse it (`machine_issues_its_own_z`).

Runs on the in-memory SQLite world of tests/shift_world.py, with the shop Z helpers.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import Shift, ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.routers import till_shop_z as R
from app.services import till_parameters as TP
from app.services import z_runs as ZR
from test_shop_z_strict import close, figures, item_of, open_shift_with_sales, poll, start, w  # noqa: F401


def status(w):
    master = w.tills[0]
    return R.till_shop_z_status(str(master.id), machine=master, db=w.db)


@pytest.fixture
def own(w):
    """The second till produces its own Z; it has an open shift with a sale."""
    till = w.tills[1]
    till.z_mode = "till"
    shift, docs = open_shift_with_sales(w, till, 1, "40.00")
    w.db.flush()
    return till, shift


class TestMasterShopZ:
    def test_the_status_neither_lists_nor_counts_a_till_mode_till(self, w, own):
        till, _shift = own

        seen = status(w)

        assert str(till.id) not in {t["id"] for t in seen["tills"]}
        assert str(till.id) not in seen["activity"]["tills"]
        # Its sale is its own Z's business: the shop Z has nothing to report.
        assert seen["activity"]["hasActivity"] is False

    def test_the_start_takes_only_the_cloud_tills_and_leaves_nobody_behind(self, w, own):
        till, own_shift = own
        t1 = w.tills[0]
        s1, d1 = open_shift_with_sales(w, t1, 1, "10.00")
        # The rule would ask for a confirmation if the till-mode till counted as left behind.
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "confirm"

        run = start(w)

        assert [i["machineId"] for i in run["items"]] == [str(t1.id)]
        assert run["openTillsLeftOut"] is None
        assert w.sent and all(str(till.id) not in map(str, sent) for sent in w.sent)

        close(w, t1, s1, d1, till_figures=figures("10.00"), request_id=item_of(run, t1)["id"])
        done = poll(w, run)
        assert done["status"] == ZRunStatus.COMPLETED
        z = w.db.query(ZReport).one()
        assert z.origin == "cloud" and z.machine_count == 1
        assert [s["machineId"] for s in z.per_machine] == [str(t1.id)]
        # The till-mode till's shift is untouched: still open, in no Z.
        w.db.refresh(own_shift)
        assert (own_shift.status, own_shift.z_report_id) == (ShiftStatus.OPEN, None)

    def test_a_shop_whose_every_till_makes_its_own_z_has_no_shop_z(self, w, own):
        w.tills[0].z_mode = "till"
        w.db.flush()

        with pytest.raises(HTTPException) as refused:
            start(w)

        assert (refused.value.status_code, refused.value.detail) == (409, "nothing_to_report")


class TestOpenTillsRuleAndActivity:
    def test_a_till_mode_till_is_never_left_out(self, w, own):
        t1 = w.tills[0]
        tills = {m.id: m for m in ZR.shop_tills(w.db, w.shop.id)}

        left = ZR.tills_left_out(
            w.db, w.admin, w.shop, tills, {t1.id: ZR.MachineSelection(machine_id=t1.id)}
        )

        assert left == []

    def test_block_does_not_refuse_a_dashboard_z_over_a_till_mode_till(self, w, own):
        rule = w.db.query(TillParameter).filter(TillParameter.key == TP.SHOP_Z_OPEN_TILLS_KEY).one()
        w.db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=rule.id, scope_type="shop", scope_id=w.shop.id,
            value=TP.SHOP_Z_OPEN_TILLS_BLOCK,
        ))
        w.db.flush()
        t1 = w.tills[0]
        open_shift_with_sales(w, t1, 1, "10.00")

        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=t1.id)])

        assert run.status == ZRunStatus.WAITING
        assert [i.machine_id for i in run.items] == [t1.id]

    def test_shop_activity_skips_a_till_mode_till(self, w, own):
        till, _shift = own

        out = ZR.shop_activity(w.db, w.shop.id, ZR.shop_tills(w.db, w.shop.id))

        assert out["hasActivity"] is False and str(till.id) not in out["tills"]

    def test_a_dashboard_z_of_a_till_mode_till_is_refused_as_on_main(self, w, own):
        till, _shift = own
        from app.services.till_z import TillZRefused

        with pytest.raises(TillZRefused) as refused:
            ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])

        assert refused.value.status_code == 422
        assert refused.value.body["detail"] == "machine_issues_its_own_z"
        assert w.db.query(Shift).filter(Shift.z_report_id.isnot(None)).count() == 0
