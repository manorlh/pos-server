"""
What a Z says about tips, net and gross, and the register (review: Z tips split, Z net
sales, posNumber).

* A tip with no `tipPaymentMethod` was counted in `totalTips` but in neither the cash nor
  the card split — and a cash one was missing from the drawer the Z expected. It now takes
  the sale's own tender, as the tips report does.
* The Z and each till's section carry `grossSales` and `netSales` (sales − refunds); a Z
  stored before they existed gets them derived from its own stored figures on read.
* A section's `posNumber` is the register number or null — never the machine code, which
  has `machineCode` of its own. Stored sections are served as stored.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.models.z_report import ZReport
from app.routers import z_reports as zr_router
from app.schemas.shift import ShiftCloseIn
from app.services.shift_totals import compute_totals, tip_goes_to_cash
from app.services.shifts import apply_shift_close
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _closed(w, till, seq, docs, opening="100.00"):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    for spec in docs:
        w.doc(till, shift, **spec)
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
    return shift


class TestATipWithNoMethodTakesTheSalesTender:
    @pytest.mark.parametrize(
        "tip_method,sale_method,cash",
        [("cash", "card", True), ("card", "cash", False), (None, "cash", True), (None, "card", False),
         (None, "mixed", False), (None, None, False), ("CASH", None, True)],
    )
    def test_the_rule(self, tip_method, sale_method, cash):
        assert tip_goes_to_cash(tip_method, sale_method) is cash

    def test_the_split_adds_up_and_the_drawer_expects_the_cash_tip(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, [
            dict(total="20.00", tip="3.00", tip_method=None, method="cash"),
            dict(total="30.00", tip="4.00", tip_method=None, method="card"),
            dict(total="10.00", tip="1.00", tip_method="card", method="cash"),
        ])
        totals = compute_totals(w.db, [shift.id])
        assert totals.total_tips == Decimal("8.00")
        assert (totals.total_cash_tips, totals.total_card_tips) == (Decimal("3.00"), Decimal("5.00"))

        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert z.total_cash_tips + z.total_card_tips == z.total_tips
        # opening 100 + cash takings 30 + cash tip 3
        assert z.expected_cash == Decimal("133.00")


class TestNetAndGross:
    def _z(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, [
            dict(total="100.00", discount="10.00"),
            dict(total="20.00", credit_note=True),
        ])
        return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])

    def test_the_z_and_its_section_carry_them(self, w):
        z = self._z(w)
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert (out["totalSales"], out["grossSales"], out["netSales"]) == ("90.00", "100.00", "70.00")
        section = z.per_machine[0]
        assert (section["grossSales"], section["netSales"]) == ("100.00", "70.00")

    def test_an_older_section_gets_them_derived_on_read(self, w):
        z = self._z(w)
        legacy = {k: v for k, v in z.per_machine[0].items() if k not in ("grossSales", "netSales")}
        derived = zr_router._with_derived_sales(legacy)
        assert (derived["grossSales"], derived["netSales"]) == ("100.00", "70.00")
        assert "grossSales" not in legacy  # the stored section itself is not rewritten


class TestTheRegisterNumber:
    def test_null_without_a_register_number_and_the_code_beside_it(self, w):
        till = w.tills[0]
        till.pos_number = None
        shift = _closed(w, till, 1, [dict(total="5.00")])
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        section = z.per_machine[0]
        assert section["posNumber"] is None
        assert section["machineCode"] == till.machine_code

    def test_the_register_number_when_there_is_one(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, [dict(total="5.00")])
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert z.per_machine[0]["posNumber"] == till.pos_number

    def test_a_stored_section_is_served_as_stored(self, w):
        section = {"machineId": str(uuid.uuid4()), "posNumber": "M-7", "totalSales": "1.00", "totalRefunds": "0.00"}
        assert zr_router._with_derived_sales(section)["posNumber"] == "M-7"
