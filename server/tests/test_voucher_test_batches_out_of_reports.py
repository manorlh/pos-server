"""
Staff test batches ("שוברי בדיקה", the helper's §18.5) out of the core's commercial reports and the
cloud Z — the follow-up of 09.10 to the helper's controls:

* **"מימושים לפי קופה"** — the report and its drill-down leave the test batches out, and say how many
  of the scope's were left out (`testBatchesExcluded`);
* **the board's "שוברים" card** — never counts a test batch's redemption;
* **the batch report** — a test batch's own report still shows it (it is the batch asked for), marked
  `isTest`;
* **the Z and the daily reports** — a test voucher's deduction that reached a real sale anyway (flagged
  `test_real`) is no production voucher's: no production pays it and no settlement counts it. It leaves
  "קיזוז שוברי הפקה" and counts as an ordinary discount (the net is the same), shown apart on the Z
  ("שוברי בדיקה (כלולים)"); the till's X, which books every voucher alike, is compared without it;
  the discounts report counts it with the discount vouchers (`vouchers.testDeductions`, the
  integration's follow-up of 09.10);
* a database without the controls' tables (the migration not run yet) reads as before.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.routers import promotions as promotions_router
from app.routers import reports as reports_router
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionIn
from app.services import prepaid_voucher_analytics as PVA
from app.services import prepaid_voucher_controls as CTL
from app.services import prepaid_voucher_reports as PVR
from app.services import shift_totals as ST
from app.services import voucher_board as VB
from app.services import z_builder, z_print
from app.services.reports import resolve_report_window
from app.services.shift_totals import compute_totals, production_deductions_of, till_totals_mismatch
from app.services.shifts import apply_shift_close
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_prepaid_voucher_controls import TRAINING, batch, codes, staff_batch, take, training
from test_prepaid_vouchers import _ctx, w  # noqa: F401 — `w` is the fixture


@pytest.fixture
def redeemed(w):
    """A real batch redeemed at the other shop's till; a test batch redeemed at a till in training."""
    real = batch(w, count=2)
    test = staff_batch(w)
    training(w)
    assert take(w, codes(w, test)[0], features=TRAINING)["ok"]
    assert take(w, codes(w, real)[0], till=w.other_till)["ok"]
    w.real, w.test = real, test
    return w


class TestTillsReport:
    def test_the_report_and_its_drill_down_leave_the_test_batches_out(self, redeemed):
        w = redeemed
        out = PVA.tills_report(w.db, w.admin, w.tenant.id, PVA.make_scope())
        assert [r["machineId"] for r in out["items"]] == [str(w.other_till.id)]
        assert (out["totals"]["redemptions"], out["testBatchesExcluded"]) == (1, 1)
        rows = PVA.redemptions_list(w.db, w.admin, w.tenant.id, PVA.make_scope())["items"]
        assert [r["batch"]["id"] for r in rows] == [w.real["id"]]
        # Asked for the test batch by name: nothing (and it says one was left out).
        only = PVA.tills_report(w.db, w.admin, w.tenant.id, PVA.make_scope(batch_id=[w.test["id"]]))
        assert (only["items"], only["testBatchesExcluded"]) == ([], 1)
        assert PVA.redemptions_list(w.db, w.admin, w.tenant.id, PVA.make_scope(batch_id=[w.test["id"]]))["items"] == []

    def test_no_test_batch_nothing_left_out(self, w):
        real = batch(w, count=1)
        take(w, codes(w, real)[0])
        out = PVA.tills_report(w.db, w.admin, w.tenant.id, PVA.make_scope())
        assert (out["totals"]["redemptions"], out["testBatchesExcluded"]) == (1, 0)

    def test_the_management_lists_still_show_the_test_batch(self, redeemed):
        # Out of the reports only: the batch list and the exceptions report (the helper's) still have it.
        w = redeemed
        listed = {b["id"] for b in PVA.list_batches(w.db, w.admin, w.tenant.id, PVA.make_scope())["items"]}
        assert {w.real["id"], w.test["id"]} <= listed


class TestBoardCard:
    def test_a_test_batch_counts_nowhere(self, redeemed):
        w = redeemed
        today = date.today()
        window = resolve_report_window(w.db, w.tenant.id, from_date=today - timedelta(days=1),
                                       to_date=today + timedelta(days=1), tz="Asia/Jerusalem")
        out = VB.build_voucher_board(w.db, w.admin, w.tenant.id, window)
        assert [r.batch_id for r in out.rows] == [w.real["id"]]
        assert (out.totals.vouchers, out.totals.redemptions) == (1, 1)

    def test_without_the_controls_tables_as_before(self, redeemed, monkeypatch):
        w = redeemed
        monkeypatch.setattr(CTL, "tables_ready", lambda db: False)
        today = date.today()
        window = resolve_report_window(w.db, w.tenant.id, from_date=today - timedelta(days=1),
                                       to_date=today + timedelta(days=1), tz="Asia/Jerusalem")
        assert VB.build_voucher_board(w.db, w.admin, w.tenant.id, window).totals.redemptions == 2


class TestBatchReport:
    def test_marked_on_the_test_batch_only(self, redeemed):
        w = redeemed
        test = PVR.batch_report(w.db, w.admin, w.tenant.id, w.test["id"])
        assert test["isTest"] is True
        assert test["totals"]["redemptions"] == 1  # its own report still shows it
        assert PVR.batch_report(w.db, w.admin, w.tenant.id, w.real["id"])["isTest"] is False


# ── The Z and the daily reports ───────────────────────────────────────────────


def sale(shift, *, batch_id, voucher, number, regular="5.00"):
    """₪50 of goods: a regular discount and a production voucher's deduction of [batch_id], the rest cash."""
    item_id = str(uuid.uuid4())
    paid = Decimal("50.00") - Decimal(regular) - Decimal(voucher)
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": "50.00", "documentDiscount": str(Decimal(regular) + Decimal(voucher)), "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": str(paid)}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": [{"id": item_id, "productName": "המבורגר", "quantity": 1, "unitPrice": "50.00", "totalPrice": "50.00"}],
        "voucherDiscounts": [{
            "kind": "production_voucher", "voucherId": str(uuid.uuid4()), "batchId": batch_id,
            "serial": 1, "batchName": "סדרה", "typeName": "שובר ארוחה", "uses": 1, "amount": voucher,
            "lines": [{"itemId": item_id, "amount": voucher}],
        }],
    })


@pytest.fixture
def booked(w):
    """One shift: a real production voucher's ₪40 deduction and a test voucher's ₪30 (a `test_real` sale)."""
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    test = staff_batch(w)
    docs = [sale(shift, batch_id=str(uuid.uuid4()), voucher="40.00", number="8001"),
            sale(shift, batch_id=test["id"], voucher="30.00", number="8002")]
    assert [r.status for r in upsert_transactions(w.db, till, docs)] == ["accepted", "accepted"]
    w.db.commit()
    w.booked_shift, w.booked_ids, w.booked_till = shift, [d.id for d in docs], till
    return w


class TestZ:
    def test_the_test_vouchers_deduction_is_a_discount(self, booked):
        w = booked
        t = compute_totals(w.db, [w.booked_shift.id])
        # Collected ₪5 + ₪15; the real voucher's ₪40 apart; the test voucher's ₪30 a discount like the ₪5 + ₪5.
        assert t.production_voucher_deductions_total == Decimal("40.00")
        assert t.test_voucher_deductions_total == Decimal("30.00")
        assert (t.discounts_total, t.gross_sales, t.net_sales) == (Decimal("40.00"), Decimal("60.00"), Decimal("20.00"))
        assert t.gross_sales - t.discounts_total == t.net_sales
        assert sorted(production_deductions_of(w.db, w.booked_ids).values()) == [Decimal("40.00")]

    def test_the_tills_x_books_every_voucher_alike_and_still_agrees(self, booked):
        w = booked
        t = compute_totals(w.db, [w.booked_shift.id])
        # The till's X: both vouchers apart — gross ₪30, discounts ₪10.
        assert till_totals_mismatch({"totalSales": "30.00", "discountsTotal": "10.00", "totalCash": "20.00"}, t) is False
        assert till_totals_mismatch({"totalSales": "60.00"}, t) is True

    def test_the_z_header_and_paper(self, booked):
        w = booked
        apply_shift_close(w.db, w.booked_till, w.booked_shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
        z = z_builder.build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.booked_till, w.booked_shift.id)])
        w.db.commit()
        assert z.header["productionVoucherDeductionsTotal"] == "40.00"
        assert z.header["testVoucherDeductionsTotal"] == "30.00"
        assert (Decimal(str(z.discounts_total)), z.totals_mismatch) == (Decimal("40.00"), False)
        (section,) = [s for s in z.per_machine if s["machineId"] == str(w.booked_till.id)]
        assert (section["productionVoucherDeductionsTotal"], section["testVoucherDeductionsTotal"]) == ("40.00", "30.00")
        rows = {r["label"]: r["value"] for r in z_print._sales_rows(z) if r}
        assert (rows["מכירות ברוטו"], rows["הנחות"], rows["שוברי בדיקה (כלולים)"]) == ("₪60.00", "-₪40.00", "-₪30.00")
        (vouchers,) = z_print._voucher_sections(z)
        assert vouchers["rows"] == [{"label": "קיזוז שוברי הפקה", "value": "-₪40.00", "emphasis": False}]

    def test_no_test_voucher_no_line(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(w.db, till, [sale(shift, batch_id=str(uuid.uuid4()), voucher="40.00", number="8001")])
        w.db.commit()
        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
        z = z_builder.build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert "testVoucherDeductionsTotal" not in z.header
        assert not any(r and r["label"].startswith("שוברי בדיקה") for r in z_print._sales_rows(z))

    def test_the_daily_reports_count_it_as_a_discount(self, booked):
        out = reports_router.get_cashier_sales_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
            machine_id=None, area_id=None, **_ctx(booked),
        ).totals
        assert (out.gross, out.discounts, out.production_voucher_deductions, out.net) == (60.0, 40.0, 40.0, 20.0)

    def test_the_discounts_report_counts_it_as_a_discount_too(self, booked):
        """The discounts report follows the same rule (production_deduction_conditions): the real
        voucher's ₪40 under "שוברי הפקה", the test voucher's ₪30 with the discount vouchers."""
        out = promotions_router.get_discounts_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
            machine_id=None, **_ctx(booked),
        )
        assert out["productionVouchers"]["totals"] == {"count": 1, "uses": 1, "amount": 40.0, "documents": 1}
        assert out["vouchers"]["totals"] == {"count": 1, "uses": 1, "amount": 30.0, "documents": 1}
        assert out["vouchers"]["testDeductions"] == {"count": 1, "uses": 1, "amount": 30.0, "documents": 1}
        assert [(b["name"], b["amount"]) for b in out["vouchers"]["byBatch"]] == [("סדרה", 30.0)]

    def test_the_discounts_report_without_the_controls_tables_as_before(self, booked, monkeypatch):
        monkeypatch.setattr(ST, "_test_batches_ready", lambda db: False)
        out = promotions_router.get_discounts_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
            machine_id=None, **_ctx(booked),
        )
        assert out["productionVouchers"]["totals"]["amount"] == 70.0
        assert out["vouchers"]["totals"]["amount"] == 0.0 and out["vouchers"]["testDeductions"]["count"] == 0

    def test_without_the_controls_tables_as_before(self, booked, monkeypatch):
        w = booked
        monkeypatch.setattr(ST, "_test_batches_ready", lambda db: False)
        t = compute_totals(w.db, [w.booked_shift.id])
        assert (t.production_voucher_deductions_total, t.test_voucher_deductions_total) == (Decimal("70.00"), Decimal("0"))
        assert (t.discounts_total, t.gross_sales) == (Decimal("10.00"), Decimal("30.00"))


class TestReadiness:
    """The condition costs no query once the table is known — a report's query count never depends on being first."""

    def test_known_from_its_creation_without_a_query(self):
        from sqlalchemy import create_engine, event
        from sqlalchemy.orm import sessionmaker

        from app.models.prepaid_voucher_extras import PrepaidVoucherTestBatch

        engine = create_engine("sqlite://")
        db = sessionmaker(bind=engine)()
        assert ST._test_batches_ready(db) is False  # no table: no condition, the reports as before
        assert ST.staff_test_deduction(db) is None
        PrepaidVoucherTestBatch.__table__.create(engine)
        seen = []
        listener = lambda *a, **k: seen.append(1)  # noqa: E731
        event.listen(engine, "before_cursor_execute", listener)
        try:
            assert ST._test_batches_ready(db) is True
            assert ST.staff_test_deduction(db) is not None
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        assert seen == []
        db.close()

    def test_found_once_by_the_controls_check(self, w, monkeypatch):
        calls = []
        monkeypatch.setattr(ST, "_TEST_BATCHES_TABLE", __import__("weakref").WeakKeyDictionary())
        monkeypatch.setattr(CTL, "tables_ready", lambda db: calls.append(1) or True)
        assert ST._test_batches_ready(w.db) and ST._test_batches_ready(w.db)
        assert calls == [1]
        assert ST.staff_test_deduction(None) is None
