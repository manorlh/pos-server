"""
"Z לנקודת מכירה" in every work configuration (P:/specs/area-z-configs.md).

Local mode (LAN, "קופה ראשית (שרת מקומי)"): the cloud never makes a Z there (409
`shop_z_producer_local`, unchanged) — the shop's producer, the main till, makes the point of sale's Z
over the LAN, numbered from the shop's one sequence, and uploads it with `areaId`:

* the history tells the main till each participant's point of sale, the live areas with
  participants, and whether it may produce one (`areaZ`); a till that is not the producer may not;
* the upload files it as an area Z (`z_reports.area_id`), refuses a till of another point of sale,
  and never reports another point of sale's waiting shifts as missing;
* the next Z (area or the whole shop) continues the shop's sequence — no second numbering;
* the dashboard asks the main till for an area's Z (`POST /shops/{id}/local-shop-z-request
  {areaId}`) — only a build that says `lan_area_z_v1` gets it (an older one would close the whole
  shop); one request at a time; a Z of another scope never answers it;
* the main till's guards (open shifts, cloud card refunds) look at that point of sale only;
* independent tills ("קופה עצמאית", "קיוסק עם Z משלו") and "Z בקופה, בתוך הסניף" are never in it;
  a "קופה מרוחקת בזד הסניפי" in the point of sale is (its part through the cloud).

Runs on the world of tests/test_independent_till.py (SQLite).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.z_report import ZReport
from app.routers import machines as machines_router
from app.routers import till_shop_z_local as LR
from app.routers import z_participation as ZP
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services.z_sequence import last_shop_z_number
from test_independent_till import (  # noqa: F401
    closed_shift,
    local_body,
    make_independent,
    owner_setup,
    set_param,
    run_z,
    upload,
    w,
)


def _areas(w):
    """Tills 1–3 at the bar (till 1 the main till), 4–5 on the terrace; 6 independent."""
    owner_setup(w)
    bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
    terrace = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="מרפסת")
    w.db.add_all([bar, terrace])
    w.db.flush()
    for m in w.six[:3]:
        m.area_id = bar.id
    for m in w.six[3:5]:
        m.area_id = terrace.id
    w.six[5].area_id = bar.id  # independent, in the bar: never in its Z
    w.db.commit()
    return bar, terrace


def _capable(machine):
    machine.capabilities = [LZ.LAN_AREA_Z_CAPABILITY]


def _area_body(w, number, tills, area):
    body = local_body(w, number, tills)
    body.area_id = area.id
    return body


class TestHistory:
    def test_the_main_till_learns_each_participants_point_of_sale_and_may_produce_one(self, w):
        bar, terrace = _areas(w)
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        by_pos = {p["posNumber"]: p["areaId"] for p in out["participants"]}
        assert by_pos == {"1": str(bar.id), "2": str(bar.id), "3": str(bar.id), "4": str(terrace.id), "5": str(terrace.id)}
        areas = {a["name"]: len(a["tills"]) for a in out["areas"]}
        # The independent till 6 stands in the bar but is no participant.
        assert areas == {"בר": 3, "מרפסת": 2}
        assert out["areaZ"] == {"available": True, "reason": None, "message": None}

    def test_a_till_that_is_not_the_producer_may_not(self, w):
        _areas(w)
        out = LR.till_shop_z_history(str(w.six[1].id), days=31, machine=w.six[1], db=w.db)
        assert out["areaZ"]["available"] is False and out["areaZ"]["reason"] == LZ.LAN_AREA_NOT_PRODUCER
        assert "בקופה הראשית" in out["areaZ"]["message"]

    def test_no_points_of_sale_no_area_z(self, w):
        owner_setup(w)
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        assert out["areas"] == [] and out["areaZ"]["reason"] == LZ.LAN_AREA_NO_AREAS

    def test_the_cloud_still_never_makes_one_in_local_mode(self, w, z_activity_unchecked):
        bar, _ = _areas(w)
        closed_shift(w, w.six[1], 1, "10.00")
        with pytest.raises(HTTPException) as e:
            from app.services import z_runs as ZR

            ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=w.six[1].id)], area_id=bar.id)
        assert e.value.detail["code"] == "shop_z_producer_local"
        assert MT.AREA_REFUSAL_TEXT[MT.AREA_LOCAL] == "במצב מקומי Z לנקודת מכירה מופק בקופה הראשית של הסניף"


class TestUpload:
    def test_an_area_z_is_filed_in_the_shops_sequence_and_the_others_wait(self, w):
        bar, terrace = _areas(w)
        bar_shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:3]}
        terrace_shift = closed_shift(w, w.six[3], 1, "7.00")
        code, out = upload(w, w.six[0], _area_body(w, 1, [(m, [bar_shifts[m.id]], None) for m in w.six[:3]], bar))
        assert code == 201, out
        z = w.db.query(ZReport).one()
        assert str(z.area_id) == str(bar.id) and z.shop_sequence_number == 1
        assert z.offline_report["areaId"] == str(bar.id) and z.offline_report["areaName"] == "בר"
        # The terrace's closed shift waits for its own Z: not "missing" from the bar's.
        assert not z.offline_discrepancies
        w.db.refresh(terrace_shift)
        assert terrace_shift.z_report_id is None
        # The terrace's Z next: the shop's number 2 — one sequence for every scope.
        code, out = upload(w, w.six[0], _area_body(w, 2, [(w.six[3], [terrace_shift], None)], terrace))
        assert code == 201, out
        assert last_shop_z_number(w.db, w.shop.id) == 2
        w.db.refresh(terrace_shift)
        assert terrace_shift.z_report_id is not None

    def test_a_whole_shop_z_after_an_area_z_continues_the_number(self, w):
        bar, _ = _areas(w)
        s1 = closed_shift(w, w.six[1], 1, "10.00")
        assert upload(w, w.six[0], _area_body(w, 1, [(w.six[1], [s1], None)], bar))[0] == 201
        shifts = {m.id: closed_shift(w, m, 2 if m.id == w.six[1].id else 1, "5.00") for m in w.six[:5]}
        code, out = upload(w, w.six[0], local_body(w, 2, [(m, [shifts[m.id]], None) for m in w.six[:5]]))
        assert code == 201, out
        z2 = w.db.query(ZReport).filter(ZReport.shop_sequence_number == 2).one()
        assert z2.area_id is None

    def test_a_till_of_another_point_of_sale_is_refused(self, w):
        bar, _ = _areas(w)
        s = closed_shift(w, w.six[4], 1, "10.00")
        code, out = upload(w, w.six[0], _area_body(w, 1, [(w.six[4], [s], None)], bar))
        assert code == 409 and out["detail"] == "machine_not_in_area"
        assert w.db.query(ZReport).count() == 0

    def test_an_area_of_another_shop_is_refused(self, w):
        _areas(w)
        stranger = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id, name="זר")
        w.db.add(stranger)
        w.db.flush()
        s = closed_shift(w, w.six[1], 1, "10.00")
        code, out = upload(w, w.six[0], _area_body(w, 1, [(w.six[1], [s], None)], stranger))
        assert code == 409 and out["detail"] == "area_not_in_shop"

    def test_the_independent_till_in_the_area_is_never_part_of_it(self, w):
        bar, _ = _areas(w)
        s = w.shift(w.six[5], 1, status=ShiftStatus.CLOSED)
        code, out = upload(w, w.six[0], _area_body(w, 1, [(w.six[5], [s], None)], bar))
        assert code == 409 and out["detail"] == "machine_issues_its_own_z"


class TestGuards:
    def test_open_shifts_block_only_their_own_point_of_sale(self, w, monkeypatch):
        from app.services import z_shift_guard as G

        monkeypatch.setattr(G, "flag_on", lambda: True)
        bar, terrace = _areas(w)
        set_param(w, "zRequireAllShiftsClosed", "shop", w.shop.id, True)
        w.shift(w.six[4], 1, status=ShiftStatus.OPEN)  # the terrace
        whole = LR.till_shop_z_shift_guard(str(w.six[0].id), area_id=None, machine=w.six[0], db=w.db)
        bar_only = LR.till_shop_z_shift_guard(str(w.six[0].id), area_id=bar.id, machine=w.six[0], db=w.db)
        terrace_only = LR.till_shop_z_shift_guard(str(w.six[0].id), area_id=terrace.id, machine=w.six[0], db=w.db)
        assert str(w.six[4].id) in {b["machineId"] for b in whole["blockers"]}
        assert bar_only["blockers"] == []
        assert str(w.six[4].id) in {b["machineId"] for b in terrace_only["blockers"]}

    def test_cloud_refund_guard_takes_the_area(self, w):
        bar, _ = _areas(w)
        out = LR.till_shop_z_cloud_refund_guard(str(w.six[0].id), area_id=bar.id, machine=w.six[0], db=w.db)
        assert out["hold"] is False


class TestDashboardAsks:
    def test_an_older_main_till_never_gets_an_areas_request(self, w):
        bar, _ = _areas(w)
        with pytest.raises(LZ.LocalShopZRefused) as e:
            LZ.request_from_dashboard(w.db, w.admin, w.shop, area_id=bar.id)
        assert e.value.body["detail"] == "main_till_needs_update"

    def test_the_main_till_gets_the_area_and_its_area_z_completes_it(self, w):
        bar, _ = _areas(w)
        main = w.six[0]
        _capable(main)
        req = LZ.request_from_dashboard(w.db, w.admin, w.shop, area_id=bar.id)
        assert (req["areaId"], req["areaName"]) == (str(bar.id), "בר")
        # The same scope again: the same request; another scope: refused while it is open.
        assert LZ.request_from_dashboard(w.db, w.admin, w.shop, area_id=bar.id)["id"] == req["id"]
        with pytest.raises(LZ.LocalShopZRefused) as e:
            LZ.request_from_dashboard(w.db, w.admin, w.shop)
        assert e.value.body["detail"] == "request_pending_other_scope" and "בר" in e.value.body["message"]
        w.db.commit()
        beat = machines_router.post_my_heartbeat(None, machine=main, db=w.db)
        assert beat["pendingShopZ"]["scope"] == "area" and beat["pendingShopZ"]["areaId"] == str(bar.id)
        # A whole-shop Z does not answer an area's request.
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        body = local_body(w, 1, [(m, [shifts[m.id]], None) for m in w.six[3:5]])
        body.shop_z_request_id = req["id"]
        assert upload(w, main, body)[0] == 201
        assert LZ.request_state(w.db, w.shop)["request"]["status"] == "waiting"
        body = _area_body(w, 2, [(m, [shifts[m.id]], None) for m in w.six[:3]], bar)
        body.shop_z_request_id = req["id"]
        assert upload(w, main, body)[0] == 201
        done = LZ.request_state(w.db, w.shop)["request"]
        assert done["status"] == "completed" and done["shopSequenceNumber"] == 2

    def test_a_capability_lost_later_holds_the_request_back(self, w):
        bar, _ = _areas(w)
        main = w.six[0]
        _capable(main)
        LZ.request_from_dashboard(w.db, w.admin, w.shop, area_id=bar.id)
        main.capabilities = []  # downgraded build
        w.db.commit()
        assert "pendingShopZ" not in machines_router.post_my_heartbeat(None, machine=main, db=w.db)

    def test_the_route_takes_the_area(self, w):
        bar, _ = _areas(w)
        _capable(w.six[0])
        w.db.commit()
        out = ZP.post_local_shop_z_request(
            w.shop.id, ZP.LocalShopZRequestIn(areaId=bar.id),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["request"]["areaId"] == str(bar.id)
        # No body (the dashboard as before): the whole shop — refused while the area's is open.
        resp = ZP.post_local_shop_z_request(w.shop.id, None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert resp.status_code == 409


class TestConfigurations:
    def test_a_remote_till_in_the_area_is_in_its_list_and_closes_through_the_cloud(self, w):
        bar, _ = _areas(w)
        settings = dict(w.shop.settings or {})
        settings["shopZRemoteTills"] = [str(w.six[2].id)]
        w.shop.settings = settings
        w.db.commit()
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        p = next(x for x in out["participants"] if x["posNumber"] == "3")
        assert p["areaId"] == str(bar.id)
        assert str(w.six[2].id) in next(a for a in out["areas"] if a["name"] == "בר")["tills"]

    def test_own_z_tills_are_never_in_any_area_list(self, w):
        bar, _ = _areas(w)
        w.six[2].z_mode = "till"  # "Z בקופה, בתוך הסניף"
        w.db.commit()
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        assert str(w.six[2].id) not in next(a for a in out["areas"] if a["name"] == "בר")["tills"]

