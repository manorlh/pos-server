"""
`GET /z-reports?dateBasis=production`: Z reports by the date they were produced.

The production date is the Z's `closed_at` on the tenant's local calendar (Israel here),
so a Z produced at 00:30 belongs to that new day, whatever its business date and
whatever the UTC date. `from`/`to` and the order follow the chosen basis; every row
carries both dates. The default stays the business date.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest

from app.models.z_report import ZReport
from app.routers import z_reports as zr_router
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _z(w, seq, business, closed_utc) -> ZReport:
    z = ZReport(
        id=uuid.uuid4(),
        tenant_id=w.tenant.id,
        shop_id=w.shop.id,
        shop_sequence_number=seq,
        business_date=business,
        closed_at=closed_utc,
    )
    w.db.add(z)
    w.db.flush()
    return z


@pytest.fixture
def zs(w):
    # Israel is UTC+3 in September.
    return {
        # Business day 26 Sep, produced 00:30 local on 27 Sep (21:30 UTC on the 26th).
        "after_midnight": _z(w, 1, date(2026, 9, 26), datetime(2026, 9, 26, 21, 30, tzinfo=timezone.utc)),
        # Business day 27 Sep, produced 18:00 local the same day.
        "evening": _z(w, 2, date(2026, 9, 27), datetime(2026, 9, 27, 15, 0, tzinfo=timezone.utc)),
        # Business day 25 Sep, produced 23:00 local the same day.
        "late": _z(w, 3, date(2026, 9, 25), datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc)),
    }


def _list(w, **kw):
    args = dict(
        machine_id=None, machine_ids=None, shop_id=None, from_date=None, to_date=None,
        closed_from=None, closed_to=None, area_id=None, date_basis="business", tz=None,
        page=1, page_size=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    args.update(kw)
    return zr_router.list_z_reports(**args)


def _ids(out):
    return [i.id for i in out.items]


class TestBusinessBasis:
    def test_it_is_the_default_and_unchanged(self, w, zs):
        out = _list(w, from_date=date(2026, 9, 26), to_date=date(2026, 9, 26))
        assert _ids(out) == [zs["after_midnight"].id]
        assert out.window.date_basis == "business"

    def test_ordered_by_business_date(self, w, zs):
        out = _list(w, from_date=date(2026, 9, 1), to_date=date(2026, 9, 30))
        assert _ids(out) == [zs["evening"].id, zs["after_midnight"].id, zs["late"].id]


class TestProductionBasis:
    def test_a_z_produced_after_midnight_belongs_to_the_new_local_day(self, w, zs):
        out = _list(w, date_basis="production", from_date=date(2026, 9, 27), to_date=date(2026, 9, 27))
        # Newest production first.
        assert _ids(out) == [zs["evening"].id, zs["after_midnight"].id]

    def test_not_to_the_utc_day_nor_its_business_day(self, w, zs):
        out = _list(w, date_basis="production", from_date=date(2026, 9, 26), to_date=date(2026, 9, 26))
        assert _ids(out) == []

    def test_a_late_evening_z_stays_on_its_own_day(self, w, zs):
        out = _list(w, date_basis="production", from_date=date(2026, 9, 25), to_date=date(2026, 9, 25))
        assert _ids(out) == [zs["late"].id]

    def test_ordered_by_production(self, w, zs):
        out = _list(w, date_basis="production", from_date=date(2026, 9, 1), to_date=date(2026, 9, 30))
        assert _ids(out) == [zs["evening"].id, zs["after_midnight"].id, zs["late"].id]

    def test_an_explicit_timezone_moves_the_day(self, w, zs):
        out = _list(
            w, date_basis="production", tz="UTC",
            from_date=date(2026, 9, 26), to_date=date(2026, 9, 26),
        )
        assert _ids(out) == [zs["after_midnight"].id]
        assert out.items[0].production_date == date(2026, 9, 26)

    def test_the_window_says_which_basis_and_timezone(self, w, zs):
        out = _list(w, date_basis="production", from_date=date(2026, 9, 27), to_date=date(2026, 9, 27))
        assert out.model_dump(by_alias=True, mode="json")["window"] == {
            "from": "2026-09-27", "to": "2026-09-27", "defaulted": False,
            "dateBasis": "production", "timezone": "Asia/Jerusalem",
        }


class TestBothDatesOnEveryRow:
    @pytest.mark.parametrize("basis", ["business", "production"])
    def test_each_row_has_its_business_and_production_date(self, w, zs, basis):
        out = _list(w, date_basis=basis, from_date=date(2026, 9, 1), to_date=date(2026, 9, 30))
        rows = {r["id"]: r for r in out.model_dump(by_alias=True, mode="json")["items"]}
        row = rows[str(zs["after_midnight"].id)]
        assert (row["businessDate"], row["productionDate"]) == ("2026-09-26", "2026-09-27")
        row = rows[str(zs["evening"].id)]
        assert (row["businessDate"], row["productionDate"]) == ("2026-09-27", "2026-09-27")
