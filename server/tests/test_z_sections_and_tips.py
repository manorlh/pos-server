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


# ── "טיפ באשראי משולם מהמזומן": card tips paid to staff out of the drawer ──────────

# The owner's example: 50 sold in cash, 50 on a card with a 10 card tip (the card took 60).
OWNER_DAY = [
    dict(total="50.00", method="cash"),
    dict(total="50.00", method="card", tip="10.00", tip_method="card"),
]


def _closed_by_till(w, till, seq, docs, *, till_figures=None, counted=None, expected=None, opening="0.00"):
    """A shift closed the way a till closes it: its count, its expected, its own X figures."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    for spec in docs:
        w.doc(till, shift, **spec)
    body = {"closedAt": NOW.isoformat()}
    if counted is not None:
        body["countedCash"] = counted
    if expected is not None:
        body["expectedCash"] = expected
    if till_figures is not None:
        body["till"] = till_figures
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return shift


def _z_of(w, till, shift):
    return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])


FISCAL = (
    "total_sales", "total_refunds", "discounts_total", "total_cash_sales", "total_card_sales", "total_tips",
    "total_cash_tips", "total_card_tips", "vat_total", "transactions_count",
)


class TestCardTipsPaidFromTheDrawer:
    def test_the_owners_example_the_drawer_holds_40(self, w):
        till = w.tills[0]
        shift = _closed_by_till(
            w, till, 1, OWNER_DAY, counted=40, expected=40,
            till_figures={"totalSales": 100.0, "totalCash": 50.0, "totalCard": 50.0, "totalTips": 10.0,
                          "cardTipsFromDrawer": 10},
        )
        # Stored with the close's own figures, and not a mismatch: it is not compared.
        assert shift.till_totals["cardTipsFromDrawer"] == 10
        assert shift.totals_mismatch is False

        z = _z_of(w, till, shift)

        # The drawer: 0 float + 50 cash + 0 cash tips − 10 card tips paid out = 40.
        assert (z.expected_cash, z.actual_cash, z.discrepancy) == (Decimal("40.00"), Decimal("40.00"), Decimal("0.00"))
        section = z.per_machine[0]
        assert (section["expectedCash"], section["countedCash"], section["overShort"]) == ("40.00", "40.00", "0.00")
        assert (section["cardTipsFromDrawer"], section["drawerCash"]) == ("10.00", "40.00")
        assert (z.header["cardTipsFromDrawer"], z.header["drawerCash"]) == ("10.00", "40.00")
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert (Decimal(out["cardTipsFromDrawer"]), Decimal(out["drawerCash"])) == (Decimal("10"), Decimal("40"))
        assert Decimal(out["expectedCash"]) == Decimal("40")
        # Tips are no revenue, and nothing fiscal moves: cash takings 50, card 50, card tip 10.
        assert (z.total_cash_sales, z.total_card_sales) == (Decimal("50.00"), Decimal("50.00"))
        assert (z.total_tips, z.total_cash_tips, z.total_card_tips) == (Decimal("10.00"), Decimal("0.00"), Decimal("10.00"))
        assert section["cashSalesNet"] == "50.00" and section["totalCardTips"] == "10.00"

    def test_without_the_figure_nothing_changes(self, w):
        till = w.tills[0]
        shift = _closed_by_till(w, till, 1, OWNER_DAY, counted=50, expected=50)

        z = _z_of(w, till, shift)

        assert (z.expected_cash, z.discrepancy) == (Decimal("50.00"), Decimal("0.00"))
        section = z.per_machine[0]
        assert section["expectedCash"] == "50.00"
        assert "cardTipsFromDrawer" not in section and "drawerCash" not in section
        assert "cardTipsFromDrawer" not in z.header and "drawerCash" not in z.header
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert out["cardTipsFromDrawer"] is None and out["drawerCash"] is None

    def test_the_fiscal_figures_are_the_same_with_and_without(self, w):
        on = _closed_by_till(w, w.tills[0], 1, OWNER_DAY, counted=40, till_figures={"cardTipsFromDrawer": 10})
        off = _closed_by_till(w, w.tills[1], 1, OWNER_DAY, counted=50)
        z_on, z_off = _z_of(w, w.tills[0], on), _z_of(w, w.tills[1], off)
        assert [getattr(z_on, k) for k in FISCAL] == [getattr(z_off, k) for k in FISCAL]
        assert z_on.payment_breakdown == z_off.payment_breakdown
        assert z_on.shop_sequence_number == z_off.shop_sequence_number - 1  # numbered as ever

    def test_zero_is_a_claim_absent_is_not(self, w):
        till = w.tills[0]
        shift = _closed_by_till(w, till, 1, [dict(total="20.00")], counted=20, till_figures={"cardTipsFromDrawer": 0})
        section = _z_of(w, till, shift).per_machine[0]
        assert (section["cardTipsFromDrawer"], section["drawerCash"], section["expectedCash"]) == ("0.00", "20.00", "20.00")

    @pytest.mark.parametrize("junk", ["ten", True, -5, None, "NaN"])
    def test_what_is_not_an_amount_is_no_claim(self, w, junk):
        till = w.tills[0]
        shift = _closed_by_till(w, till, 1, OWNER_DAY, counted=50, till_figures={"cardTipsFromDrawer": junk})
        z = _z_of(w, till, shift)
        assert z.expected_cash == Decimal("50.00")
        assert "cardTipsFromDrawer" not in z.per_machine[0]

    def test_over_back_to_back_shifts_it_still_reconciles(self, w):
        till = w.tills[0]
        # Shift 1 leaves 40 (50 cash − 10 card tips paid out); shift 2 opens on it, takes 30 cash.
        one = _closed_by_till(w, till, 1, OWNER_DAY, counted=40, till_figures={"cardTipsFromDrawer": 10})
        two = _closed_by_till(w, till, 2, [dict(total="30.00")], counted=69, opening="40.00",
                              till_figures={"cardTipsFromDrawer": 0})
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, two.id)])
        section = z.per_machine[0]
        assert section["betweenShiftAdjustments"] == "0.00"
        assert section["expectedCash"] == "70.00"  # 0 + 80 cash − 10
        assert (section["cardTipsFromDrawer"], section["drawerCash"]) == ("10.00", "70.00")
        assert section["overShort"] == "-1.00"
        assert z.discrepancy == z.actual_cash - z.expected_cash
        assert one.z_report_id == z.id

    def test_a_shop_z_sums_the_tills_and_counts_a_till_without_it_whole(self, w):
        on = _closed_by_till(w, w.tills[0], 1, OWNER_DAY, counted=40, till_figures={"cardTipsFromDrawer": 10})
        off = _closed_by_till(w, w.tills[1], 1, [dict(total="25.00")], counted=25)
        z = build_z(
            w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
            selections=[(w.tills[0], on.id), (w.tills[1], off.id)],
        )
        assert z.expected_cash == Decimal("65.00")  # 40 + 25
        assert (z.header["cardTipsFromDrawer"], z.header["drawerCash"]) == ("10.00", "65.00")
        sections = {s["machineId"]: s for s in z.per_machine}
        assert "cardTipsFromDrawer" not in sections[str(w.tills[1].id)]

    def test_a_kiosk_close_never_carries_it_and_the_live_parameter_is_never_read(self, w):
        from app.models.pos_machine import set_kiosk_cache
        from app.models.till_parameter import TillParameter, TillParameterValue
        from app.services.cash_drawer import CARD_TIPS_FROM_DRAWER_KEY
        from app.services.till_parameters import ensure_builtin_parameters

        kiosk = w.tills[0]
        set_kiosk_cache(kiosk, True)
        ensure_builtin_parameters(w.db)
        param = w.db.query(TillParameter).filter(TillParameter.key == CARD_TIPS_FROM_DRAWER_KEY).one()
        w.db.add(TillParameterValue(parameter_id=param.id, scope_type="company", scope_id=w.company.id, value=True))
        w.db.flush()
        shift = _closed_by_till(w, kiosk, 1, OWNER_DAY, counted=50)

        z = _z_of(w, kiosk, shift)

        assert z.expected_cash == Decimal("50.00") and z.discrepancy == Decimal("0.00")
        assert z.total_card_tips == Decimal("10.00")
        assert "cardTipsFromDrawer" not in z.per_machine[0]


class TestTheParameter:
    def test_built_in_off_by_default_on_the_drawer_card(self):
        from app.services import cash_drawer as CD
        from app.services.till_parameters import BUILTIN_PARAMETERS

        spec = next(p for p in BUILTIN_PARAMETERS if p.key == "cashDrawer.cardTipsFromDrawer")
        assert spec.value_type == "boolean" and spec.default_value is False
        assert spec.label == "טיפ באשראי משולם מהמזומן"
        assert "מזומן במגירה" in spec.description and "קיוסק" in spec.description
        assert CD.CARD_TIPS_FROM_DRAWER_KEY in CD.LEVEL_KEYS


class TestALocalShopZKeptAsPrinted:
    """The main till's paper becomes the Z (`local_shop_z.apply_printed`): its drawer stays one story."""

    DRAWER = {"openingCash": "0.00", "expectedCash": "40.00", "countedCash": "40.00", "overShort": "0.00"}

    def _apply(self, w, report):
        from app.services import local_shop_z as LZ

        till = w.tills[0]
        shift = _closed_by_till(w, till, 1, OWNER_DAY, counted=40, till_figures={"cardTipsFromDrawer": 10})
        z = _z_of(w, till, shift)
        body = LZ.LocalShopZIn.model_validate({
            "id": str(uuid.uuid4()), "clientRequestId": str(uuid.uuid4()), "shopSequenceNumber": 1,
            "closedAt": NOW.isoformat(),
            "tills": [{"machineId": str(till.id), "shiftIds": [str(shift.id)], "report": report}],
        })
        LZ.apply_printed(z, body, till)
        return z, zr_router.z_to_out(z)

    def test_a_paper_without_a_drawer_keeps_the_clouds_drawer_and_its_tips(self, w):
        z, out = self._apply(w, {"totalCash": "50.00"})
        assert z.expected_cash == Decimal("40.00")
        assert (out.card_tips_from_drawer, out.drawer_cash) == (Decimal("10.00"), Decimal("40.00"))

    def test_a_paper_with_a_drawer_is_read_as_printed(self, w):
        z, out = self._apply(w, {**self.DRAWER, "cardTipsFromDrawer": "10.00", "drawerCash": "40.00"})
        assert "cardTipsFromDrawer" not in z.header
        assert (z.expected_cash, out.card_tips_from_drawer, out.drawer_cash) == (
            Decimal("40.00"), Decimal("10.00"), Decimal("40.00"),
        )

    def test_a_printed_drawer_without_them_claims_nothing(self, w):
        z, out = self._apply(w, self.DRAWER)
        assert z.expected_cash == Decimal("40.00")
        assert out.card_tips_from_drawer is None and out.drawer_cash is None
