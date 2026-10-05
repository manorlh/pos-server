"""
Shop Z from a master till (app/routers/till_shop_z.py).

* Only a till marked `shopZMasterTill` may drive it; any other gets 403.
* The status lists every till of the shop with its open shift.
* Starting closes every till (each open one is sent the close) and waits.
* "סגור" (proceed) builds without the tills that did not close; their shift stays open
  for the next Z, and the decision names the till user.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.z_run import ZRunStatus
from app.routers import till_shop_z as R
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import till_parameters as TP
from app.services.shifts import apply_shift_close
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a))
    TP.ensure_builtin_parameters(world.db)
    master = world.db.query(TillParameter).filter(TillParameter.key == R.MASTER_PARAM).one()
    world.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=master.id, scope_type="machine", scope_id=world.tills[0].id, value=True,
    ))
    world.db.flush()
    return world


def closed_shift(w, till, seq):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    doc = w.doc(till, shift, "10.00")
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(doc.id)],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def status(w, till):
    return R.till_shop_z_status(str(till.id), machine=till, db=w.db)


def start(w, till, confirm=False, who="דנה"):
    return R.till_shop_z_start(
        str(till.id), R.ShopZStartIn(confirmOpenTills=confirm, posUserName=who), machine=till, db=w.db
    )


def test_only_the_master_till_may_drive_it(w):
    with pytest.raises(HTTPException) as e:
        status(w, w.tills[1])
    assert e.value.status_code == 403
    assert e.value.detail == "not_master_till"


def test_the_status_lists_every_till_and_its_open_shift(w):
    t1, t2 = w.tills
    open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)
    out = status(w, t1)
    by_id = {t["id"]: t for t in out["tills"]}
    assert set(by_id) == {str(t1.id), str(t2.id)}
    assert by_id[str(t1.id)]["self"] is True
    assert by_id[str(t2.id)]["openShift"]["id"] == str(open_shift.id)
    assert by_id[str(t1.id)]["openShift"] is None
    assert out["run"] is None


def test_start_closes_every_open_till_and_waits(w):
    t1, t2 = w.tills
    closed_shift(w, t1, 1)
    w.shift(t2, 1, status=ShiftStatus.OPEN)
    run = start(w, t1)
    assert run["status"] == ZRunStatus.WAITING
    # The open till was sent the close; the till with only a closed shift is ready.
    assert [a[1] for a in w.sent] == [str(t2.id)]
    # The status now shows the run under way.
    assert status(w, t1)["run"]["id"] == run["id"]


def test_proceed_builds_without_the_till_that_did_not_close(w):
    t1, t2 = w.tills
    closed_shift(w, t1, 1)
    open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)
    run = start(w, t1)
    out = R.till_shop_z_proceed(
        str(t1.id), uuid.UUID(run["id"]), R.ShopZProceedIn(posUserName="דנה"), machine=t1, db=w.db
    )
    assert out["status"] == ZRunStatus.COMPLETED
    assert out["zReportId"]
    left = next(i for i in out["items"] if i["machineId"] == str(t2.id))
    assert left["status"] == "excluded"
    assert "דנה" in left["errorMessage"] and "ל-Z הבא" in left["errorMessage"]
    # Its shift is still open — it moves to the next Z.
    w.db.refresh(open_shift)
    assert open_shift.status == ShiftStatus.OPEN


def test_another_shops_run_is_not_reachable(w):
    t1, _ = w.tills
    with pytest.raises(HTTPException) as e:
        R.till_shop_z_run(str(t1.id), uuid.uuid4(), machine=t1, db=w.db)
    assert e.value.status_code == 404
