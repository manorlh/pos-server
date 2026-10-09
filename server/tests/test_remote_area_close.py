"""
"סגירה לפי נקודת מכירה / אזור" from remote control (app/services/remote_till_z.py, the area Z of
z_runs): "סגירת יום לנקודת מכירה" — the existing area run, through the shop day close's own flow and
rules — and "סגירת משמרות לנקודת מכירה" — each till of the area its own remote shift close.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.shop_area import ShopArea
from app.models.z_run import ZRun, ZRunStatus
from app.routers import device_commands as R
from app.services import remote_till_z as svc
from app.services import z_shift_guard as G
from app.services.z_sequence import last_shop_z_number
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, selling, till_closes, z  # noqa: F401


def area(z, name, *tills):
    a = ShopArea(id=uuid.uuid4(), tenant_id=z.tenant.id, shop_id=z.shop.id, name=name)
    z.db.add(a)
    z.db.flush()
    for t in tills:
        t.area_id = a.id
    z.db.flush()
    return a


def area_preview(z, a, user=None):
    return svc.shop_preview(z.db, z.shop, now=NOW, user=user or z.admin, area_id=a.id)


def start_area(z, a):
    key = area_preview(z, a)["totalsKey"]
    run = svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=key, confirm_cloud_data=True,
                           area_id=a.id, now=NOW)
    assert isinstance(run, ZRun), run
    z.db.commit()
    return run


def test_the_shop_lists_its_points_of_sale_that_can_be_closed_on_their_own(z):
    bar = area(z, "Bar", z.t1)
    area(z, "Empty")
    z.t2.z_mode = "till"
    kitchen = area(z, "Kitchen", z.t2)  # only an own-Z till: nothing of the shop Z to close there
    selling(z, z.t1, 1, "10.00")
    areas = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)["areas"]
    assert [a["areaId"] for a in areas] == [str(bar.id)] and areas[0]["name"] == "Bar"
    assert str(kitchen.id) not in [a["areaId"] for a in areas]


def test_an_area_day_close_is_the_area_run_with_the_shops_numbering(z):
    bar = area(z, "Bar", z.t1)
    area(z, "Kitchen", z.t2)
    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "20.00")
    p = area_preview(z, bar)
    assert p["shopClose"]["label"] == "סגירת יום לנקודת מכירה" and p["shopClose"]["available"] is True
    assert [r["machineId"] for r in p["inShopZ"]] == [str(z.t1.id)] and p["areaName"] == "Bar"
    assert p["totals"]["totalSales"] == 10.0
    before = last_shop_z_number(z.db, z.shop.id)
    run = start_area(z, bar)
    assert run.area_id == bar.id and run.wait_for_rest is True and [i.machine_id for i in run.items] == [z.t1.id]
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    assert svc.run_progress(z.db, run)["zNumber"] == before + 1  # the shop's own sequence
    # The kitchen's open shift was never touched.
    from app.models.shift import Shift, ShiftStatus

    assert z.db.get(Shift, s2.id).status == ShiftStatus.OPEN


def test_area_and_shop_day_closes_exclude_each_other_both_ways(z):
    bar = area(z, "Bar", z.t1)
    kitchen = area(z, "Kitchen", z.t2)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start_area(z, bar)
    # The shop day close is refused while the bar's runs (its till is in that run).
    p = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)
    assert p["shopClose"]["available"] is False and p["shopClose"]["whyNot"].startswith("סגירת יום כבר בתהליך")
    with pytest.raises(HTTPException):
        svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=p["totalsKey"], confirm_cloud_data=True, now=NOW)
    z.db.rollback()
    # Another area is not concerned.
    assert area_preview(z, kitchen)["shopClose"]["available"] is True
    R.post_shop_close_cancel(run.id, **_ctx(z))
    # The reverse: a shop day close running — no area close for any of its areas.
    p = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)
    svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=p["totalsKey"], confirm_cloud_data=True, now=NOW)
    z.db.commit()
    a = area_preview(z, bar)
    assert a["shopClose"]["available"] is False and a["shopClose"]["whyNot"] == "סגירת יום כבר בתהליך (של כל הסניף)"
    with pytest.raises(HTTPException) as e:
        svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=a["totalsKey"], area_id=bar.id, now=NOW)
    assert e.value.status_code == 409


def test_a_mixed_area_takes_only_its_shop_z_tills(z):
    z.t2.z_mode = "till"  # an independent / own-Z till in the same area
    bar = area(z, "Bar", z.t1, z.t2)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "99.00")
    p = area_preview(z, bar)
    assert [r["machineId"] for r in p["inShopZ"]] == [str(z.t1.id)]
    assert [r["machineId"] for r in p["ownZ"]] == [str(z.t2.id)] and p["totals"]["totalSales"] == 10.0
    run = start_area(z, bar)
    assert [i.machine_id for i in run.items] == [z.t1.id]


def test_an_area_with_a_kiosk_in_the_shop_z(z):
    bar = area(z, "Bar", z.t1, z.t2)
    z.t2.capabilities = None  # a Windows kiosk: never "needs update"
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.db.flush()
    p = area_preview(z, bar)
    assert p["shopClose"]["available"] is True
    kiosk = next(r for r in p["inShopZ"] if r["machineId"] == str(z.t2.id))
    assert kiosk["isKiosk"] is True and kiosk["action"]["whyNot"] == "קיוסק — מלשונית הקיוסקים"
    run = start_area(z, bar)
    assert {i.machine_id for i in run.items} == {z.t1.id, z.t2.id}


def test_an_area_level_override_of_the_open_shifts_rule(z):
    bar = area(z, "Bar", z.t1)
    kitchen = area(z, "Kitchen", z.t2)
    set_param(z, G.KEY, "area", bar.id, True)
    set_param(z, G.KEY, "area", kitchen.id, False)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    assert area_preview(z, bar)["shiftGuard"]["required"] is True
    assert [b["machineId"] for b in area_preview(z, bar)["shiftGuard"]["blockers"]] == [str(z.t1.id)]
    assert area_preview(z, kitchen)["shiftGuard"] == {"label": G.LABEL, "required": False, "blockers": [], "offlineClosed": []}


def test_local_mode_has_no_area_day_close_either(z):
    from test_main_till import make_main

    bar = area(z, "Bar", z.t1)
    selling(z, z.t1, 1, "10.00")
    make_main(z, z.t1)
    z.shop.local_network = True
    z.db.flush()
    assert svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)["areas"] == []
    assert area_preview(z, bar)["shopClose"]["whyNot"].startswith("לא זמין עדיין")


def test_the_routes_and_a_manager_of_one_point_of_sale(z, monkeypatch):
    bar = area(z, "Bar", z.t1)
    kitchen = area(z, "Kitchen", z.t2)
    selling(z, z.t1, 1, "10.00")
    out = R.get_shop_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))
    assert out["areaId"] == str(bar.id)
    monkeypatch.setattr(R, "_narrowing", lambda db, user: SimpleNamespace(area_ids={bar.id}, machine_ids=set(),
                                                                           covers_path=lambda path: True))
    assert R.get_shop_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))["areaId"] == str(bar.id)
    with pytest.raises(HTTPException) as e:
        R.get_shop_close_preview(shop_id=z.shop.id, area_id=kitchen.id, **_ctx(z))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:  # the whole shop stays the whole shop's manager's
        R.get_shop_close_preview(shop_id=z.shop.id, **_ctx(z))
    assert e.value.status_code == 403


# ── "סגירת משמרות לנקודת מכירה" ──────────────────────────────────────────────────────────


def test_an_areas_shift_close_asks_each_till_on_its_own(z):
    from app.services import remote_close

    z.t2.z_mode = "till"
    bar = area(z, "Bar", z.t1, z.t2)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    p = R.get_area_shift_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))
    rows = {r["machineId"]: r for r in p["tills"]}
    assert p["label"] == "סגירת משמרות לנקודת מכירה" and p["available"] is True
    assert rows[str(z.t1.id)]["canRequest"] is True and rows[str(z.t1.id)]["kind"] == "close_shift"
    assert rows[str(z.t2.id)]["canRequest"] is False  # its own Z — from its own row
    out = R.post_area_shift_close(R.AreaShiftCloseIn(shopId=z.shop.id, areaId=bar.id, totalsKeys={
        str(z.t1.id): rows[str(z.t1.id)]["totalsKey"], str(z.t2.id): "x"}), **_ctx(z))
    res = {r["machineId"]: r for r in out["results"]}
    assert res[str(z.t1.id)]["ok"] is True and res[str(z.t1.id)]["command"]["action"] == "close_shift"
    assert res[str(z.t2.id)]["ok"] is False and res[str(z.t2.id)]["code"] == "own_z"
    assert remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)["waitForRest"] is True


def test_one_tills_changed_totals_never_stop_the_others(z):
    bar = area(z, "Bar", z.t1, z.t2)
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    p = R.get_area_shift_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))
    keys = {r["machineId"]: r["totalsKey"] for r in p["tills"]}
    z.doc(z.t1, s1, "5.00", number="10002")  # a sale since, on till 1
    z.db.flush()
    out = R.post_area_shift_close(R.AreaShiftCloseIn(shopId=z.shop.id, areaId=bar.id, totalsKeys=keys), **_ctx(z))
    res = {r["machineId"]: r for r in out["results"]}
    assert res[str(z.t1.id)]["ok"] is False and res[str(z.t1.id)]["code"] == "totals_changed"
    assert res[str(z.t2.id)]["ok"] is True


# ── Follow-ups after the final verification ───────────────────────────────────────────────


def test_a_manager_of_some_points_of_sale_reaches_their_own_areas_close(z, monkeypatch):
    bar = area(z, "Bar", z.t1)
    kitchen = area(z, "Kitchen", z.t2)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    # The shop's manager: every point of sale.
    out = R.get_area_close_list(shop_id=z.shop.id, **_ctx(z))
    assert out["wholeShop"] is True and [a["areaId"] for a in out["areas"]] == [str(bar.id), str(kitchen.id)]
    # A manager of the bar only: the bar alone; no shop-wide close (it says to use the areas).
    monkeypatch.setattr(R, "_narrowing", lambda db, user: SimpleNamespace(area_ids={bar.id}, machine_ids=set(),
                                                                           covers_path=lambda path: True))
    out = R.get_area_close_list(shop_id=z.shop.id, **_ctx(z))
    assert out["wholeShop"] is False and [a["areaId"] for a in out["areas"]] == [str(bar.id)]
    with pytest.raises(HTTPException) as e:
        R.get_shop_close_preview(shop_id=z.shop.id, **_ctx(z))
    assert e.value.status_code == 403 and e.value.detail["areasOnly"] is True
    # Their own area's day close and shift close both reachable.
    assert R.get_shop_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))["shopClose"]["available"] is True
    assert R.get_area_shift_close_preview(shop_id=z.shop.id, area_id=bar.id, **_ctx(z))["available"] is True


def test_a_non_uuid_till_key_is_refused_as_invalid_never_a_crash(z):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        R.AreaShiftCloseIn.model_validate({"shopId": str(z.shop.id), "areaId": str(uuid.uuid4()), "totalsKeys": {"not-a-uuid": "k"}})
    ok = R.AreaShiftCloseIn.model_validate({"shopId": str(z.shop.id), "areaId": str(uuid.uuid4()), "totalsKeys": {str(z.t1.id): "k"}})
    assert list(ok.totals_keys) == [z.t1.id]


def test_the_heartbeats_close_instruction_says_who_asked(z):
    from app.services import remote_close

    bar = area(z, "Bar", z.t1)
    selling(z, z.t1, 1, "10.00")
    start_area(z, bar)
    assert remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)["initiatedBy"] == "admin"
    # A till's own remote shift close too.
    selling(z, z.t2, 1, "20.00")
    p = svc.preview(z.db, z.t2, now=NOW)
    svc.request(z.db, z.admin, z.t2, totals_key=p["totalsKey"], now=NOW)
    assert remote_close.take_pending_close_shift(z.db, z.t2, now=NOW)["initiatedBy"] == "admin"
