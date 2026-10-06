"""
A Z for one area of a shop (docs/AREAS_API.md §2.3).

An ordinary shop Z whose till list is the area's: the one shop number sequence, the same
through-shift rules. What could go wrong quietly: a till outside the area slipping into
the area's Z, an area Z starting its own numbering, a rename rewriting a Z already
filed, or a till moved mid-cycle leaving shifts behind that no Z can then take.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import date

from app.models.shift import Shift
from app.models.z_report import ZReport
from app.routers import areas as areas_router
from app.routers import z_reports as z_reports_router
from app.routers import z_runs as z_runs_router
from app.schemas.area import AreaUpdate
from app.schemas.z_run import ZRunCreateIn
from app.services import z_runs as ZR
from test_shop_areas import _ctx, closed_shift, create, members, refused, w  # noqa: F401


# ── Z for an area ─────────────────────────────────────────────────────────────


def post_run(w, *tills, area_id=None, shop=None):
    return z_runs_router.post_z_run(
        ZRunCreateIn(
            shopId=(shop or w.shop).id,
            areaId=area_id,
            machines=[{"machineId": str(t.id)} for t in tills],
            # The tills here are not seen "now": the state is confirmed (offline till Z §4.6.1).
            confirmCloudData=True,
        ),
        **_ctx(w),
    )


class TestZForAnArea:
    def test_an_area_z_is_a_shop_z_that_records_the_area_and_freezes_its_name(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1, t2)
        closed_shift(w, t1, 1, [dict(total="10.00")])
        closed_shift(w, t2, 1, [dict(total="5.00")])
        w.db.commit()

        out = post_run(w, t1, area_id=bar["id"])  # t2 left off: allowed

        assert out["status"] == "completed"
        assert (out["areaId"], out["areaName"]) == (bar["id"], "Bar")
        z = w.db.get(ZReport, out["zReportId"])
        assert str(z.area_id) == str(bar["id"])
        assert z.header["areaId"] == str(bar["id"]) and z.header["areaName"] == "Bar"
        assert z.shop_sequence_number == 1 and z.machine_count == 1

        # Renamed later: the Z keeps the name it was filed under.
        areas_router.update_shop_area(bar["id"], AreaUpdate(name="Pub"), **_ctx(w))
        detail = z_reports_router.get_z_report(z.id, **_ctx(w)).model_dump(by_alias=True)
        assert (detail["areaId"], detail["areaName"]) == (z.area_id, "Bar")
        assert detail["business"]["areaName"] == "Bar"
        run = ZR.get_run(w.db, out["id"], w.tenant.id)
        assert ZR.run_to_out(w.db, run)["areaName"] == "Bar"

        # The next Z of the shop, area or not, continues the one shop sequence.
        second = post_run(w, t2)
        z2 = w.db.get(ZReport, second["zReportId"])
        assert z2.shop_sequence_number == 2
        assert z2.area_id is None and z2.header["areaId"] is None and z2.header["areaName"] is None

    def test_an_area_of_another_shop_is_refused(self, w):
        north_bar = create(w, "Bar", shop=w.other_shop)
        closed_shift(w, w.tills[0], 1)

        e = refused(post_run, w, w.tills[0], area_id=north_bar["id"])
        assert (e.status_code, e.detail) == (400, "area_not_in_shop")
        assert refused(post_run, w, w.tills[0], area_id=uuid.uuid4()).detail == "area_not_in_shop"
        assert refused(post_run, w, w.tills[0], area_id=w.foreign_area.id).detail == "area_not_in_shop"

    def test_an_archived_area_is_refused(self, w):
        bar = create(w, "Bar")
        areas_router.archive_shop_area(bar["id"], **_ctx(w))
        closed_shift(w, w.tills[0], 1)

        assert refused(post_run, w, w.tills[0], area_id=bar["id"]).detail == "area_archived"

    def test_every_listed_till_must_be_in_the_area_now(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)
        closed_shift(w, t1, 1)
        closed_shift(w, t2, 1)

        e = refused(post_run, w, t1, t2, area_id=bar["id"])

        assert (e.status_code, e.detail) == (400, f"machine_not_in_area:{t2.id}")

    def test_a_till_moved_mid_cycle_brings_every_shift_whatever_its_stamp(self, w):
        till = w.tills[0]
        bar = create(w, "Bar")
        terrace = create(w, "Terrace")
        members(w, bar["id"], till)
        old = closed_shift(w, till, 1, [dict(total="10.00")])
        members(w, terrace["id"], till)
        new = closed_shift(w, till, 2, [dict(total="7.00")])
        w.db.commit()

        out = post_run(w, till, area_id=terrace["id"])

        z = w.db.get(ZReport, out["zReportId"])
        assert {s.id for s in z.shifts} == {old.id, new.id}
        assert str(w.db.get(Shift, old.id).area_id) == str(bar["id"])  # the stamp stays

    def test_the_candidates_list_only_the_areas_tills_now(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t2)
        w.db.commit()

        out = z_runs_router.get_z_candidates(w.shop.id, area_id=uuid.UUID(str(bar["id"])), **_ctx(w))

        assert [m.machine_id for m in out.machines] == [t2.id]
        assert (out.area_id, out.area_name) == (t2.area_id, "Bar")
        assert out.machines[0].area_name == "Bar"
        everyone = z_runs_router.get_z_candidates(w.shop.id, area_id=None, **_ctx(w))
        assert {m.machine_id for m in everyone.machines} == {t1.id, t2.id}
        assert refused(
            z_runs_router.get_z_candidates, w.shop.id, area_id=w.foreign_area.id, **_ctx(w)
        ).detail == "area_not_in_shop"

    def test_the_z_report_list_filters_on_the_area(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)
        closed_shift(w, t1, 1, [dict(total="10.00")])
        closed_shift(w, t2, 1, [dict(total="5.00")])
        w.db.commit()
        in_bar = post_run(w, t1, area_id=bar["id"])["zReportId"]
        whole = post_run(w, t2)["zReportId"]

        def ids(area_id):
            out = z_reports_router.list_z_reports(
                machine_id=None, machine_ids=None, shop_id=None, from_date=date(2026, 1, 1),
                to_date=None, closed_from=None, closed_to=None, area_id=area_id,
                date_basis="business", tz=None, page=1, page_size=50, **_ctx(w),
            )
            return [(i.id, i.area_name) for i in out.items]

        assert ids(str(bar["id"])) == [(in_bar, "Bar")]
        assert ids("none") == [(whole, None)]
        assert {i for i, _ in ids(None)} == {in_bar, whole}
