"""
"No Z on 0" (`empty_z`) is a rule of the cloud Z only.

A till in `zMode = till` asks for its own Z (`POST /sync/{m}/till-z`, docs/SHIFTS_API.md
§5.2), and §5.2 has no such refusal: a till Z over shifts with no activity at all is
still produced, numbered in the till's own run. Only "no shift at all" is refused, with
§5's own `nothing_to_report`. A cloud Z over the same nothing is still refused.

Runs on the world of tests/test_till_z.py.
"""
from __future__ import annotations

import pytest

from app.models.z_report import ZReport
from app.services import z_runs as ZR
from app.services.z_builder import EMPTY_Z, ZBuildRefused, build_z
from test_till_z import ask, closed_shift, created, w, zs  # noqa: F401


def test_a_till_z_over_shifts_with_nothing_in_them_is_produced(w):
    closed_shift(w, w.till, 1)  # no documents, nothing counted
    closed_shift(w, w.till, 2)

    body = created(w)

    z = body["zReport"]
    assert (z["origin"], z["machineSequenceNumber"], z["shopSequenceNumber"]) == ("till", 1, None)
    assert z["transactionsCount"] == 0 and float(z["totalSales"]) == 0
    assert len(body["shiftIds"]) == 2
    assert [r.machine_sequence_number for r in zs(w)] == [1]


def test_a_till_z_with_no_shift_at_all_is_still_nothing_to_report(w):
    code, body, _cid = ask(w)

    assert code == 409
    assert body["detail"] == "nothing_to_report"
    assert w.db.query(ZReport).count() == 0


def test_a_cloud_z_over_the_same_nothing_is_still_refused(w):
    other = w.tills[1]  # zMode = cloud
    shift = closed_shift(w, other, 1)

    with pytest.raises(ZBuildRefused) as refused:
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(other, shift.id)])

    assert refused.value.code == EMPTY_Z
    assert w.db.query(ZReport).count() == 0
    assert ZR.issues_own_z(other) is False and ZR.issues_own_z(w.till) is True
