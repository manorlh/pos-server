"""
Zs by the date they were produced ("תאריך הפקת Z") — app/services/z_by_date.py,
app/routers/z_by_date.py, and the same choice on the accountant's Z list and the all-in-one report.

The owner: a Z produced on 1.10 is seen on 1.10, whatever its business date — the night of 30.9
closed by a Z at 02:00 on 1.10 is a Z of 1.10. How each part could look right while being wrong:

* **The day** — grouped by the UTC date, or by a fixed offset, a Z produced after local midnight
  lands on the wrong day; on a DST day (23 or 25 hours) a fixed offset moves the edge by an hour.
* **Both ways** — the same Zs must group by business date exactly as before, and by production
  date the new way; every Z appears once in each grouping.
* **The totals** — the day's grand totals, by shop, by area (an area's Z, a till Z by its shifts'
  area) and by kind (shop / area / till / independent / kiosk) must add up to the Zs listed.
* **The month** — a Z produced in October after midnight holds September documents: its split by
  document month says so, cut on the shop's clock (a document at 01:00 on 1.10 is October's even
  though its UTC date is 30.9).
* **Nothing fiscal moves** — reading by date writes nothing: no Z figure, document or number.

Runs on the in-memory SQLite world of tests/shift_world.py (Israel unless a zone is given).
"""
from __future__ import annotations

import itertools
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.z_report import ZOrigin, ZReport
from app.routers import accounting as acc_router
from app.routers import z_by_date as R
from app.services import all_in_one as AIO
from app.services import z_by_date as S
from app.services import z_table
from app.services.reports import resolve_report_window
from app.services.z_builder import build_z
from shift_world import accept_str_uuids, make_world

ISRAEL = ZoneInfo("Asia/Jerusalem")
NEW_YORK = ZoneInfo("America/New_York")


def utc(*parts) -> datetime:
    return datetime(*parts, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


_seq = itertools.count(1)


def make_z(w, till, *, business, produced, docs, origin=ZOrigin.CLOUD, area_id=None, shift_area_id=None):
    """A Z built the real way (`build_z`) over one shift of `till` holding `docs` = [(when, total, kw)]."""
    s = w.shift(till, next(_seq), business_date=business)
    if shift_area_id is not None:
        s.area_id = shift_area_id
    for when, total, kw in docs:
        tx = w.doc(till, s, total, **kw)
        tx.created_at = when
        tx.document_production_date = when
    w.db.flush()
    return build_z(
        w.db, tenant_id=w.tenant.id, shop_id=till.shop_id, selections=[(till, s.id)],
        now=produced, origin=origin, area_id=area_id,
    )


def _kiosk(w):
    k = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="Kiosk",
        machine_code="M-K", pos_number="9", is_active=True, pairing_status=PairingStatus.ASSIGNED, z_mode="till",
    )
    w.db.add(k)
    w.db.flush()
    w.db.add(KioskDevice(machine_id=k.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="Kiosk"))
    w.db.flush()
    return k


def _area(w, name):
    a = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name=name)
    w.db.add(a)
    w.db.flush()
    return a


@pytest.fixture
def night(w):
    """
    Three Zs around the night of 30.9 → 1.10 (Israel, UTC+3 in both):

    * `after_midnight` — business day 30.9, produced 02:00 on 1.10 (23:00 UTC on 30.9). Its documents:
      one at 23:30 on 30.9 and one at 01:00 on 1.10 — both on 30.9 in UTC.
    * `same_night` — business day 30.9, produced 23:50 on 30.9.
    * `next_evening` — business day 1.10, produced 23:30 on 1.10, at the other shop.
    """
    t1, t2 = w.tills
    after_midnight = make_z(
        w, t1, business=date(2026, 9, 30), produced=utc(2026, 9, 30, 23, 0),
        docs=[
            (utc(2026, 9, 30, 20, 30), "100.00", {"vat": "14.53"}),
            (utc(2026, 9, 30, 22, 0), "50.00", {"vat": "7.26", "method": "card", "tip": "5.00"}),
        ],
    )
    same_night = make_z(
        w, t2, business=date(2026, 9, 30), produced=utc(2026, 9, 30, 20, 50),
        docs=[(utc(2026, 9, 30, 15, 0), "30.00", {"vat": "4.36"})],
    )
    next_evening = make_z(
        w, w.other_till, business=date(2026, 10, 1), produced=utc(2026, 10, 1, 20, 30),
        docs=[(utc(2026, 10, 1, 12, 0), "70.00", {"vat": "10.17", "method": "card"})],
    )
    return {"after_midnight": after_midnight, "same_night": same_night, "next_evening": next_evening}


def summary(w, **kw):
    args = dict(
        from_date=None, to_date=None, date_basis="production", tz=None, shop_id=None, shop_ids=None,
        machine_id=None, machine_ids=None, area_id=None, z_types=None, origin=None,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    args.update(kw)
    return R.get_z_summary_by_date(**args)


def month(w, m, **kw):
    args = dict(
        month=m, date_basis="production", tz=None, shop_id=None, shop_ids=None, machine_id=None,
        machine_ids=None, area_id=None, z_types=None, origin=None,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    args.update(kw)
    return R.get_z_month_by_date(**args)


def ids(out):
    return [z["id"] for z in out["zs"]]


def day(d):
    return dict(from_date=d, to_date=d)


# ── The day: the same Zs, both ways ──────────────────────────────────────────


class TestTheSameZsGroupedBothWays:
    def test_by_production_date_the_z_after_midnight_is_on_the_new_day(self, w, night):
        out = summary(w, **day(date(2026, 10, 1)))
        # Newest production first.
        assert ids(out) == [str(night["next_evening"].id), str(night["after_midnight"].id)]
        assert out["window"] == {
            "from": "2026-10-01", "to": "2026-10-01", "dateBasis": "production", "timezone": "Asia/Jerusalem",
        }

    def test_by_production_date_30_9_keeps_only_the_z_produced_that_night_before_midnight(self, w, night):
        out = summary(w, **day(date(2026, 9, 30)))
        assert ids(out) == [str(night["same_night"].id)]

    def test_by_business_date_the_z_after_midnight_stays_on_30_9(self, w, night):
        out = summary(w, date_basis="business", **day(date(2026, 9, 30)))
        assert set(ids(out)) == {str(night["after_midnight"].id), str(night["same_night"].id)}
        out = summary(w, date_basis="business", **day(date(2026, 10, 1)))
        assert ids(out) == [str(night["next_evening"].id)]

    @pytest.mark.parametrize("basis", ["production", "business"])
    def test_every_z_is_in_exactly_one_day_either_way(self, w, night, basis):
        out = summary(w, date_basis=basis, from_date=date(2026, 9, 1), to_date=date(2026, 10, 31))
        per_day = {d["date"]: d["count"] for d in out["byDay"]}
        assert sum(per_day.values()) == 3 == out["count"]
        if basis == "production":
            assert per_day == {"2026-09-30": 1, "2026-10-01": 2}
        else:
            assert per_day == {"2026-09-30": 2, "2026-10-01": 1}

    def test_each_line_says_when_it_was_produced_and_which_business_day_it_covers(self, w, night):
        out = summary(w, **day(date(2026, 10, 1)))
        line = next(z for z in out["zs"] if z["id"] == str(night["after_midnight"].id))
        assert (line["productionDate"], line["productionTime"], line["businessDate"]) == ("2026-10-01", "02:00", "2026-09-30")
        assert line["producedAt"] == "2026-09-30T23:00:00+00:00"
        assert line["kind"] == "shop" and line["zNumber"] == night["after_midnight"].z_number
        assert line["tills"] == [{"posNumber": "1", "machineName": "Till 1"}]
        assert (line["totalSales"], line["vatTotal"], line["cashSales"], line["cardSales"], line["totalTips"]) == (
            "150.00", "21.79", "100.00", "50.00", "5.00",
        )
        assert line["documents"] == 2

    def test_an_explicit_timezone_moves_the_day(self, w, night):
        # In UTC the Z after midnight was produced on 30.9.
        out = summary(w, tz="UTC", **day(date(2026, 9, 30)))
        assert str(night["after_midnight"].id) in ids(out)
        assert out["window"]["timezone"] == "UTC"

    def test_no_date_is_today_on_the_shops_clock(self, w, night):
        out = summary(w)
        today = datetime.now(timezone.utc).astimezone(ISRAEL).date().isoformat()
        assert out["window"]["from"] == out["window"]["to"] == today

    def test_the_lists_closed_from_and_to_narrow_it_as_the_list(self, w, night):
        out = summary(w, closed_from=utc(2026, 10, 1, 0, 0), **day(date(2026, 10, 1)))
        assert ids(out) == [str(night["next_evening"].id)]
        out = summary(w, closed_to=utc(2026, 9, 30, 23, 0), **day(date(2026, 10, 1)))
        assert ids(out) == [str(night["after_midnight"].id)]

    def test_to_before_from_is_refused(self, w):
        with pytest.raises(HTTPException) as e:
            summary(w, from_date=date(2026, 10, 2), to_date=date(2026, 10, 1))
        assert e.value.status_code == 400


# ── The day's summary card ───────────────────────────────────────────────────


class TestTheDaySummary:
    def test_grand_totals_add_up_the_days_zs(self, w, night):
        out = summary(w, **day(date(2026, 10, 1)))
        assert out["count"] == 2
        t = out["totals"]
        assert (t["count"], t["totalSales"], t["netSales"], t["vatTotal"]) == (2, "220.00", "220.00", "31.96")
        assert (t["cashSales"], t["cardSales"], t["totalTips"], t["documents"]) == ("100.00", "120.00", "5.00", 3)
        assert t["vatUnknownCount"] == 0

    def test_by_shop(self, w, night):
        out = summary(w, **day(date(2026, 10, 1)))
        by = {s["shopName"]: (s["count"], s["totalSales"]) for s in out["byShop"]}
        assert by == {"Center": (1, "150.00"), "North": (1, "70.00")}

    def test_a_refund_counts_against_the_net(self, w):
        t1 = w.tills[0]
        make_z(
            w, t1, business=date(2026, 10, 1), produced=utc(2026, 10, 1, 18, 0),
            docs=[(utc(2026, 10, 1, 10, 0), "80.00", {"vat": "11.62"}),
                  (utc(2026, 10, 1, 11, 0), "20.00", {"vat": "2.91", "credit_note": True})],
        )
        t = summary(w, **day(date(2026, 10, 1)))["totals"]
        assert (t["totalSales"], t["totalRefunds"], t["netSales"], t["documents"]) == ("80.00", "20.00", "60.00", 2)

    def test_unknown_vat_is_counted_not_summed_as_zero(self, w):
        make_z(w, w.tills[0], business=date(2026, 10, 1), produced=utc(2026, 10, 1, 18, 0),
               docs=[(utc(2026, 10, 1, 10, 0), "80.00", {})])
        t = summary(w, **day(date(2026, 10, 1)))["totals"]
        assert t["vatTotal"] is None and t["vatUnknownCount"] == 1


class TestEveryKindAndArea:
    @pytest.fixture
    def kinds(self, w):
        t1, t2 = w.tills
        terrace, bar = _area(w, "Terrace"), _area(w, "Bar")
        produced = utc(2026, 10, 1, 9, 0)
        doc = lambda total: [(utc(2026, 10, 1, 8, 0), total, {"vat": "1.00"})]  # noqa: E731
        area_z = make_z(w, t1, business=date(2026, 10, 1), produced=produced, docs=doc("10.00"), area_id=terrace.id)
        t2.z_mode = "till"
        till_z = make_z(w, t2, business=date(2026, 10, 1), produced=produced, docs=doc("20.00"),
                        origin=ZOrigin.TILL, shift_area_id=bar.id)
        kiosk = _kiosk(w)
        kiosk_z = make_z(w, kiosk, business=date(2026, 10, 1), produced=produced, docs=doc("30.00"),
                         origin=ZOrigin.TILL)
        ind = w.other_till
        ind.z_mode, ind.independent_till = "till", True
        independent_z = make_z(w, ind, business=date(2026, 10, 1), produced=produced, docs=doc("40.00"),
                               origin=ZOrigin.TILL)
        t1b = w.tills[0]
        shop_z = make_z(w, t1b, business=date(2026, 10, 1), produced=produced, docs=doc("50.00"))
        return {"area": area_z, "till": till_z, "kiosk": kiosk_z, "independent": independent_z, "shop": shop_z,
                "terrace": terrace, "bar": bar}

    def test_every_kind_of_z_appears_with_its_kind(self, w, kinds):
        out = summary(w, **day(date(2026, 10, 1)))
        got = {z["id"]: z["kind"] for z in out["zs"]}
        for kind in ("area", "till", "kiosk", "independent", "shop"):
            assert got[str(kinds[kind].id)] == kind
        assert {k["kind"]: k["count"] for k in out["byKind"]} == {
            "shop": 1, "area": 1, "till": 1, "independent": 1, "kiosk": 1,
        }
        # The order of the kinds is fixed: the shop's first, then area, till, independent, kiosk.
        assert [k["kind"] for k in out["byKind"]] == ["shop", "area", "till", "independent", "kiosk"]

    def test_by_area_an_areas_z_and_a_till_z_by_its_shifts_area(self, w, kinds):
        out = summary(w, **day(date(2026, 10, 1)))
        line = {z["id"]: z for z in out["zs"]}
        assert (line[str(kinds["area"].id)]["areaName"], line[str(kinds["area"].id)]["areaSource"]) == ("Terrace", "z")
        assert (line[str(kinds["till"].id)]["areaName"], line[str(kinds["till"].id)]["areaSource"]) == ("Bar", "shifts")
        assert line[str(kinds["shop"].id)]["areaId"] is None
        by_area = {(a["shopName"], a["areaName"]): (a["count"], a["totalSales"]) for a in out["byArea"]}
        assert by_area[("Center", "Terrace")] == (1, "10.00")
        assert by_area[("Center", "Bar")] == (1, "20.00")
        # Whole-shop and kiosk Zs of Center: no area. The independent till is North's.
        assert by_area[("Center", None)] == (2, "80.00")
        assert by_area[("North", None)] == (1, "40.00")
        assert sum(a["count"] for a in out["byArea"]) == out["count"] == 5

    def test_the_type_filter_is_the_lists(self, w, kinds):
        out = summary(w, z_types=["kiosk", "independent"], **day(date(2026, 10, 1)))
        assert set(ids(out)) == {str(kinds["kiosk"].id), str(kinds["independent"].id)}

    def test_the_shop_filter(self, w, kinds):
        out = summary(w, shop_id=w.other_shop.id, **day(date(2026, 10, 1)))
        assert ids(out) == [str(kinds["independent"].id)]


# ── The month ────────────────────────────────────────────────────────────────


class TestTheMonth:
    def test_zs_produced_in_october_include_the_one_after_midnight_on_1_10(self, w, night):
        out = month(w, "2026-10")
        assert set(ids(out)) == {str(night["after_midnight"].id), str(night["next_evening"].id)}
        assert out["window"]["from"] == "2026-10-01" and out["window"]["to"] == "2026-10-31"
        assert out["note"] == "דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך"
        assert out["totals"]["totalSales"] == "220.00"

    def test_by_business_month_it_is_septembers(self, w, night):
        out = month(w, "2026-09", date_basis="business")
        assert set(ids(out)) == {str(night["after_midnight"].id), str(night["same_night"].id)}
        assert ids(month(w, "2026-09")) == [str(night["same_night"].id)]

    def test_the_split_by_document_month_on_the_z_after_midnight(self, w, night):
        out = month(w, "2026-10")
        line = next(z for z in out["zs"] if z["id"] == str(night["after_midnight"].id))
        # 23:30 on 30.9 is September's; 01:00 on 1.10 is October's — though both are 30.9 in UTC.
        assert line["documentMonths"] == [
            {"month": "2026-09", "netSales": "100.00", "vatTotal": "14.53", "documents": 1},
            {"month": "2026-10", "netSales": "50.00", "vatTotal": "7.26", "documents": 1},
        ]
        assert line["otherMonthDocuments"] is True and line["documentsMatchZ"] is True

    def test_a_z_whose_documents_are_all_of_its_month_has_one_month(self, w, night):
        out = month(w, "2026-10")
        line = next(z for z in out["zs"] if z["id"] == str(night["next_evening"].id))
        assert line["documentMonths"] == [{"month": "2026-10", "netSales": "70.00", "vatTotal": "10.17", "documents": 1}]
        assert line["otherMonthDocuments"] is False

    def test_the_months_documents_by_document_month(self, w, night):
        out = month(w, "2026-10")
        assert out["documentMonths"] == [
            {"month": "2026-09", "netSales": "100.00", "vatTotal": "14.53", "documents": 1},
            {"month": "2026-10", "netSales": "120.00", "vatTotal": "17.43", "documents": 2},
        ]
        # The split adds up to the Zs' own net.
        assert sum(Decimal(m["netSales"]) for m in out["documentMonths"]) == Decimal(out["totals"]["netSales"])

    def test_a_credit_note_is_negative_in_its_month(self, w):
        make_z(
            w, w.tills[0], business=date(2026, 9, 30), produced=utc(2026, 9, 30, 22, 30),
            docs=[(utc(2026, 9, 30, 10, 0), "80.00", {"vat": "11.62"}),
                  (utc(2026, 9, 30, 21, 15), "20.00", {"vat": "2.91", "credit_note": True})],
        )
        line = month(w, "2026-10")["zs"][0]
        assert line["documentMonths"] == [
            {"month": "2026-09", "netSales": "80.00", "vatTotal": "11.62", "documents": 1},
            {"month": "2026-10", "netSales": "-20.00", "vatTotal": "-2.91", "documents": 1},
        ]

    def test_a_cancelled_document_is_in_no_month(self, w):
        from app.models.transaction import TransactionStatus

        make_z(
            w, w.tills[0], business=date(2026, 10, 1), produced=utc(2026, 10, 1, 18, 0),
            docs=[(utc(2026, 10, 1, 10, 0), "80.00", {"vat": "11.62"}),
                  (utc(2026, 9, 30, 10, 0), "99.00", {"status": TransactionStatus.CANCELLED})],
        )
        line = month(w, "2026-10")["zs"][0]
        assert line["documentMonths"] == [{"month": "2026-10", "netSales": "80.00", "vatTotal": "11.62", "documents": 1}]

    def test_a_legacy_z_without_shifts_has_no_split(self, w):
        legacy = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.tills[0].id,
                         business_date=date(2026, 10, 1), closed_at=utc(2026, 10, 1, 18, 0),
                         total_sales=Decimal("5.00"), per_machine=None)
        w.db.add(legacy)
        w.db.flush()
        line = month(w, "2026-10")["zs"][0]
        assert (line["kind"], line["documentMonths"], line["otherMonthDocuments"]) == ("legacy", [], False)

    def test_more_zs_than_the_cap_is_refused_not_cut(self, w, night, monkeypatch):
        monkeypatch.setattr(z_table, "Z_TABLE_MAX", 1)
        with pytest.raises(HTTPException) as e:
            month(w, "2026-10")
        assert e.value.status_code == 400


# ── DST and the edges of the day ─────────────────────────────────────────────


class TestTimezoneEdges:
    def _at(self, w, produced):
        return make_z(w, w.tills[0], business=date(2026, 10, 24), produced=produced,
                      docs=[(produced, "10.00", {"vat": "1.45"})])

    def test_israels_25_hour_day_when_dst_ends(self, w):
        # 25.10.2026: 02:00 IDT → 01:00 IST. The local day runs 21:00 UTC on 24.10 → 22:00 UTC on 25.10.
        first_0130 = self._at(w, utc(2026, 10, 24, 22, 30))   # 01:30 IDT
        second_0130 = self._at(w, utc(2026, 10, 24, 23, 30))  # 01:30 IST, an hour later
        late = self._at(w, utc(2026, 10, 25, 21, 30))         # 23:30 IST — 00:30 on 26.10 at a fixed +3
        before = self._at(w, utc(2026, 10, 24, 20, 59))       # 23:59 IDT on 24.10
        out = summary(w, **day(date(2026, 10, 25)))
        assert set(ids(out)) == {str(first_0130.id), str(second_0130.id), str(late.id)}
        times = {z["id"]: z["productionTime"] for z in out["zs"]}
        assert times[str(first_0130.id)] == times[str(second_0130.id)] == "01:30"
        assert times[str(late.id)] == "23:30"
        assert ids(summary(w, **day(date(2026, 10, 24)))) == [str(before.id)]
        assert ids(summary(w, **day(date(2026, 10, 26)))) == []

    def test_israels_23_hour_day_when_dst_starts(self, w):
        # 26.3.2027: 02:00 IST → 03:00 IDT. 00:30 on 27.3 (IDT) is 21:30 UTC on 26.3 — at a fixed +2 it
        # would read 23:30 on 26.3.
        after = self._at(w, utc(2027, 3, 26, 21, 30))
        before = self._at(w, utc(2027, 3, 26, 20, 50))  # 23:50 IDT on 26.3
        assert ids(summary(w, **day(date(2027, 3, 26)))) == [str(before.id)]
        assert ids(summary(w, **day(date(2027, 3, 27)))) == [str(after.id)]

    def test_a_month_edge_on_a_dst_day_in_another_zone(self, w):
        # New York, 1.11.2026: DST ends at 02:00 EDT (a 25-hour day that starts the month).
        october = self._at(w, utc(2026, 11, 1, 3, 30))   # 23:30 EDT on 31.10
        november = self._at(w, utc(2026, 11, 1, 4, 30))  # 00:30 EDT on 1.11
        repeated = self._at(w, utc(2026, 11, 1, 6, 30))  # 01:30 EST, the second 01:30
        assert ids(month(w, "2026-10", tz="America/New_York")) == [str(october.id)]
        assert set(ids(month(w, "2026-11", tz="America/New_York"))) == {str(november.id), str(repeated.id)}
        # Each Z's document is dated when it was produced: the split agrees with the Z's month.
        line = month(w, "2026-10", tz="America/New_York")["zs"][0]
        assert [m["month"] for m in line["documentMonths"]] == ["2026-10"]
        # In Israel all three are November's (06:30 / 07:30 / 08:30 on 1.11).
        assert len(ids(month(w, "2026-11"))) == 3

    @pytest.mark.parametrize(
        "moment, zone, expected",
        [
            (utc(2026, 9, 30, 21, 0), ISRAEL, "2026-10"),      # 00:00 IDT on 1.10 — the first instant of October
            (utc(2026, 9, 30, 20, 59, 59), ISRAEL, "2026-09"),
            (utc(2026, 11, 1, 3, 59), NEW_YORK, "2026-10"),     # 23:59 EDT on 31.10
            (utc(2026, 11, 1, 4, 0), NEW_YORK, "2026-11"),
            (datetime(2026, 9, 30, 21, 30), ISRAEL, "2026-10"),  # naive = UTC, as stored
        ],
    )
    def test_month_key(self, moment, zone, expected):
        assert S.month_key(moment, zone) == expected


# ── Nothing fiscal moves ─────────────────────────────────────────────────────


FISCAL = (
    "business_date", "closed_at", "shop_sequence_number", "machine_sequence_number", "total_sales",
    "total_refunds", "vat_total", "total_cash_sales", "total_card_sales", "total_tips", "transactions_count",
    "payment_breakdown", "per_machine",
)


def _snapshot(w):
    zs = {z.id: tuple(getattr(z, c) for c in FISCAL) for z in w.db.query(ZReport).all()}
    docs = {
        t.id: (t.transaction_number, t.total_amount, t.vat_amount, t.created_at, t.document_production_date, t.shift_id)
        for t in w.db.query(Transaction).all()
    }
    return zs, docs


class TestNothingFiscalMoves:
    def test_reading_by_date_writes_nothing(self, w, night):
        w.db.commit()
        before = _snapshot(w)
        summary(w, **day(date(2026, 10, 1)))
        summary(w, date_basis="business", from_date=date(2026, 9, 1), to_date=date(2026, 10, 31))
        month(w, "2026-10")
        month(w, "2026-09", date_basis="business")
        assert not (w.db.new or w.db.dirty or w.db.deleted)
        w.db.expire_all()
        assert _snapshot(w) == before


# ── The accountant's Z list and the all-in-one report ────────────────────────


def _acc(w, **kw):
    args = dict(company_id=w.company.id, shop_id=None, from_date=None, to_date=None, only_unexported=False,
                current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    args.update(kw)
    return acc_router.list_accounting_z_reports(**args)


class TestAccountantZList:
    def test_business_date_stays_the_default(self, w, night):
        out = _acc(w, from_date=date(2026, 9, 30), to_date=date(2026, 9, 30))
        assert {r.id for r in out.items} == {night["after_midnight"].id, night["same_night"].id}

    def test_by_production_date(self, w, night):
        out = _acc(w, from_date=date(2026, 10, 1), to_date=date(2026, 10, 1), date_basis="production")
        # Oldest first, as the list always was.
        assert [r.id for r in out.items] == [night["after_midnight"].id, night["next_evening"].id]
        row = out.items[0]
        assert (row.business_date, row.production_date) == (date(2026, 9, 30), date(2026, 10, 1))

    def test_every_row_has_both_dates(self, w, night):
        out = _acc(w, from_date=date(2026, 9, 1), to_date=date(2026, 10, 31))
        dates = {r.id: (r.business_date, r.production_date) for r in out.items}
        assert dates[night["after_midnight"].id] == (date(2026, 9, 30), date(2026, 10, 1))
        assert dates[night["same_night"].id] == (date(2026, 9, 30), date(2026, 9, 30))


class TestAllInOneZSection:
    def _window(self, w, d):
        return resolve_report_window(w.db, w.tenant.id, from_date=d, to_date=d, tz="Asia/Jerusalem")

    def test_the_z_section_by_production_date(self, w, night):
        out = AIO.build_all_in_one(w.db, w.admin, w.tenant.id, self._window(w, date(2026, 10, 1)),
                                   z_date_basis="production")
        assert {z["id"] for z in out["zs"]["zs"]} == {str(night["after_midnight"].id), str(night["next_evening"].id)}
        assert out["zDateBasis"] == "production"

    def test_by_business_date_by_default(self, w, night):
        out = AIO.build_all_in_one(w.db, w.admin, w.tenant.id, self._window(w, date(2026, 10, 1)))
        assert [z["id"] for z in out["zs"]["zs"]] == [str(night["next_evening"].id)]
        assert out["zDateBasis"] == "business"
