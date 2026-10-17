"""
"מזומן במכשיר" — cash paid into a cash DEVICE (a CashMag recycler or a PayLink station, the leg's
`nayax_meta.cashDevice`) is cash takings but never in the till's drawer (the Windows till's rule,
kiosk-desktop src/core/till/deviceCash.ts; pos-android XReport):

* the cloud counts it per shift and per device kind (`shift_totals.device_cash`, `shifts.total_device_cash`);
* every expected cash leaves it out — the shift's, a till Z's, a shop Z's, the shop X's — and the "מזומן במגירה"
  block shows it on its own line ("מזומן במכשיר"), its total still the Z's expected cash;
* the fiscal figures do not move (cash takings, payment breakdown, sales, VAT);
* the Z's paper and the v2 drawer reconciliation carry the line; a shift from before the column reads its
  till's frozen `totalDeviceCash`;
* a TILL may report its cash device's alerts too (kind "cash" on its kiosk/sync), like a kiosk.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.models.transaction_payment import TransactionPayment
from app.routers import z_reports as zr_router
from app.schemas.shift import ShiftCloseIn
from app.services import shift_totals as ST
from app.services import shop_x as SX
from app.services import till_parameters as TP
from app.services import z_print
from app.services import z_sections
from app.services.shifts import apply_shift_close
from app.services.z_builder import build_z, device_cash_of, till_cash_summary
from shift_world import NOW, accept_str_uuids, make_world

D = Decimal


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


def _device(w, doc, host_id="cashmag"):
    """The document's (only) cash leg was taken by a cash device."""
    (leg,) = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == doc.id).all()
    leg.nayax_meta = {"cashDevice": {"txId": f"tx-{doc.id}", "stationId": "st-1", "hostId": host_id,
                                     "receivedAgorot": int(leg.amount * 100), "changeAgorot": 0,
                                     "changeOwedAgorot": 0, "roundingAgorot": 0}}
    w.db.flush()
    return leg


def _day(w, till, seq, *, device=True, opening="100.00", till_figures=None, counted=None):
    """100 at the counter, 300 into CashMag, 50 into a PayLink station, a 20 CashMag refund, a 40 card sale."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    w.doc(till, shift, "100.00")
    cashmag = w.doc(till, shift, "300.00")
    paylink = w.doc(till, shift, "50.00")
    refund = w.doc(till, shift, "20.00", credit_note=True)
    w.doc(till, shift, "40.00", method="card")
    if device:
        _device(w, cashmag)
        _device(w, paylink, host_id=str(w.tills[-1].id))
        _device(w, refund)
    body = {"closedAt": NOW.isoformat()}
    if counted is not None:
        body["countedCash"] = counted
    if till_figures is not None:
        body["till"] = till_figures
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return shift


def _z(w, *pairs):
    return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=list(pairs))


class TestCounted:
    def test_per_kind_refunds_negative_the_cash_unchanged(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1)
        totals = ST.compute_totals(w.db, [shift.id])
        assert totals.device_cash == {"cashmag": D("280.00"), "paylink": D("50.00")}
        assert totals.total_device_cash == D("330.00")
        assert totals.total_cash == D("430.00")  # 100 + 300 + 50 − 20: every cash taking
        assert shift.total_device_cash == D("330.00") and shift.total_cash == D("430.00")
        assert totals.device_cash_json() == {"cashmag": "280.00", "paylink": "50.00"}

    def test_a_leg_without_a_transaction_is_notes_at_the_counter(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = w.doc(till, shift, "10.00")
        (leg,) = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == doc.id).all()
        leg.nayax_meta = {"cashDevice": {"hostId": "cashmag"}}
        w.db.flush()
        assert ST.compute_totals(w.db, [shift.id]).device_cash == {}

    def test_a_delta_carries_it(self):
        t = ST.DocumentTotals()
        t.device_cash = {"cashmag": D("12.50")}
        back = ST.DocumentTotals.from_delta_json(t.delta_json())
        assert back.device_cash == {"cashmag": D("12.50")}
        assert ST.DocumentTotals().add(back).add(back, -1).device_cash == {}


class TestTheDrawer:
    def test_the_z_expects_only_the_drawers_cash(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1, counted="200.00")
        z = _z(w, (till, shift.id))
        # 100 float + 430 cash − 330 in the devices = 200 in the drawer: counted 200, no variance.
        assert (z.expected_cash, z.discrepancy) == (D("200.00"), D("0.00"))
        assert z.total_cash_sales == D("430.00")
        section = z.per_machine[0]
        assert (section["totalCash"], section["cashSalesNet"]) == ("430.00", "430.00")
        assert section["deviceCash"] == "330.00"
        assert section["deviceCashByKind"] == {"cashmag": "280.00", "paylink": "50.00"}
        assert (z.header["deviceCash"], z.header["deviceCashByKind"]) == ("330.00", {"cashmag": "280.00", "paylink": "50.00"})
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert D(out["deviceCash"]) == D("330") and out["deviceCashByKind"] == {"cashmag": "280.00", "paylink": "50.00"}

    def test_the_block_shows_the_line_and_adds_up_to_the_expected(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1)
        z = _z(w, (till, shift.id))
        block = z_print.cash_with_tips_of(z)
        lines = {l["key"]: l["amount"] for l in block["lines"]}
        assert lines["cashSales"] == "430.00" and lines["deviceCash"] == "-330.00"
        assert [l["label"] for l in block["lines"] if l["key"] == "deviceCash"] == ["מזומן במכשיר"]
        assert D(block["total"]) == z.expected_cash == D("200.00")

    def test_the_paper_and_the_v2_reconciliation(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1)
        z = _z(w, (till, shift.id))
        doc = z_print.build_print_document(z, None)
        labels = [r["label"] for s in doc["sections"] for r in s["rows"] if isinstance(r, dict)]
        assert "מזומן במכשיר" in labels
        assert "מזומן במכשיר · CashMag" in labels and "מזומן במכשיר · PayLink" in labels
        drawer = z.header["reportSections"]["drawer"]
        assert drawer["deviceCash"] == "330.00" and drawer["expected"] == "200.00"
        rows = dict((label, value) for title, block in z_sections.lines(z.header["reportSections"]) for label, value, _b in block
                    if title == z_sections.LABELS_HE["drawer"])
        assert rows["מזומן במכשיר"] == "-330.00"

    def test_the_fiscal_figures_do_not_move(self, w):
        a, b = w.tills
        with_device = _z(w, (a, _day(w, a, 1).id))
        without = _z(w, (b, _day(w, b, 1, device=False).id))
        for key in ("total_sales", "total_refunds", "total_cash_sales", "total_card_sales", "vat_total",
                    "transactions_count", "payment_breakdown"):
            assert getattr(with_device, key) == getattr(without, key), key
        assert without.expected_cash - with_device.expected_cash == D("330.00")
        assert "deviceCash" not in without.per_machine[0] and "deviceCash" not in (without.header or {})

    def test_a_shop_z_per_drawer(self, w):
        a, b = w.tills
        z = _z(w, (a, _day(w, a, 1).id), (b, _day(w, b, 1, device=False).id))
        assert z.expected_cash == D("200.00") + D("530.00")
        table = z_print.cash_with_tips_of(z)["table"]
        assert [r["drawerCash"] for r in table["rows"]] == ["200.00", "530.00"]
        assert z.header["deviceCash"] == "330.00"

    def test_card_tips_are_never_paid_from_the_devices_cash(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1, opening="0.00", till_figures={"cardTipsFromDrawer": 100, "cardTipsUnpaid": 0})
        z = _z(w, (till, shift.id))
        # 430 cash − 330 device − 100 paid = 0
        assert z.expected_cash == D("0.00")
        assert z.per_machine[0]["drawerCash"] == "0.00"

    def test_an_older_shift_reads_the_tills_frozen_figure(self, w):
        till = w.tills[0]
        shift = _day(w, till, 1, device=False, till_figures={"totalDeviceCash": 30})
        shift.total_device_cash = None
        assert device_cash_of(shift) == D("30.00")
        assert till_cash_summary([shift])["expected"] == D("100.00") + D("430.00") - D("30.00")
        shift.till_totals = {"totalDeviceCash": "x"}
        assert device_cash_of(shift) == D("0")


class TestShopX:
    def test_the_open_shifts_drawer(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="100.00")
        _device(w, w.doc(till, shift, "300.00"))
        w.doc(till, shift, "50.00")
        w.db.commit()
        report = SX.build(w.db, w.shop, settings=SX.Settings(), now=NOW)
        drawer = report["summary"]["drawer"]
        assert (drawer["cashSales"], drawer["deviceCash"], drawer["expected"]) == ("350.00", "300.00", "150.00")
        assert D(report["summary"]["cashWithTips"]["total"]) == D("150.00")
