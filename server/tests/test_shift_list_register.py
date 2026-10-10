"""
The dashboard's shifts list names each shift's till by its register number and its shop.

The owner (07.10.2026): "במשמרת תוסיף מספר קופה בשדה נוסף / תוסיף סניף" — the shifts page
shows "מספר קופה" and "סניף" beside the till's name, and filters on them. `GET /shifts`
(list and detail) carries `posNumber` beside the `machineName` and `shopName` it always had:

* the till's register number in the shift's shop ("1", "2" …);
* none once the till has moved to another shop — its number there is not the one it took
  the shift under (a register number belongs to one shop's run);
* every field the list answered before is still there, under the same name.
"""
from __future__ import annotations

import pytest

from app.models.shift import ShiftStatus
from app.routers import shifts as shifts_router
from app.services.shifts import register_number_of
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _list(w, **kw):
    args = dict(
        shop_id=None, machine_id=None, status_=None, awaiting_z=None, from_date=None,
        to_date=None, area_id=None, page=1, page_size=50, current_user=w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )
    args.update(kw)
    return shifts_router.list_shifts(**args)


class TestTheListNamesTheRegister:
    def test_each_row_carries_its_till_s_number_and_shop(self, w):
        one, two = w.tills
        s1 = w.shift(one, 1, status=ShiftStatus.OPEN)
        s2 = w.shift(two, 1)
        s3 = w.shift(w.other_till, 1)

        rows = {i.id: i for i in _list(w).items}

        assert (rows[s1.id].pos_number, rows[s1.id].shop_name, rows[s1.id].machine_name) == ("1", "Center", "Till 1")
        assert (rows[s2.id].pos_number, rows[s2.id].shop_name, rows[s2.id].machine_name) == ("2", "Center", "Till 2")
        assert (rows[s3.id].pos_number, rows[s3.id].shop_name, rows[s3.id].machine_name) == ("3", "North", "North 1")

    def test_the_json_adds_pos_number_and_keeps_every_field_it_had(self, w):
        shift = w.shift(w.tills[1], 4, status=ShiftStatus.OPEN)

        item = _list(w, status_="open").items[0].model_dump(by_alias=True, mode="json")

        assert item["id"] == str(shift.id)
        assert (item["posNumber"], item["shopName"], item["machineName"]) == ("2", "Center", "Till 2")
        for key in (
            "id", "tenantId", "machineId", "shopId", "businessDate", "sequenceNumber", "status",
            "openedAt", "openingCash", "openedByName", "closedAt", "closedByName", "unattended",
            "countedCash", "expectedCash", "discrepancy", "serverTotals", "totalsMismatch",
            "lateDocuments", "reconstructed", "zReportId", "zNumber", "machineName", "shopName",
            "areaId", "areaName", "offlineDeclinedCount", "offlineDeclinedAmount",
        ):
            assert key in item, key

    def test_a_till_moved_to_another_shop_has_no_number_on_its_old_shifts(self, w):
        till = w.tills[0]
        old = w.shift(till, 1)
        till.shop_id = w.other_shop.id
        till.pos_number = "7"
        w.db.flush()

        assert register_number_of(old) is None
        row = _list(w).items[0]
        assert row.id == old.id
        # Its shop is still the one it was taken in; only the number is withheld.
        assert (row.pos_number, row.shop_name) == (None, "Center")
        new = w.shift(till, 2)
        assert register_number_of(new) == "7"

    def test_a_till_without_a_number_or_a_machine_has_none(self, w):
        till = w.tills[0]
        till.pos_number = "  "
        w.db.flush()
        assert register_number_of(w.shift(till, 1)) is None

    def test_the_detail_carries_it_too(self, w):
        shift = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)

        out = shifts_router.get_shift(shift.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert (out.pos_number, out.shop_name, out.machine_name) == ("2", "Center", "Till 2")
