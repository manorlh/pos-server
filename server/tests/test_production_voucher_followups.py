"""
The verification review's follow-ups (09.10), each as the reviewer put it:

1. The insights' hour cells counted a production voucher's deduction as a discount (discountPct, the
   `discounts_up` card).
3. A deduction line with a non-numeric amount refused the whole fiscal document.
6. A priced line naming a hold confirmed it; one hold named twice was confirmed twice.
7. Another till's confirm checked stacking against its own sale.
Nits: an invalid approval refused even when no override was needed; groups at `/redeem` said
"update"; the batch edit recounted what was used without `takenQuantity`.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption, PrepaidVoucherReservation
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherRedeemIn, PrepaidVoucherTypeCreate
from app.services import prepaid_vouchers as PV
from app.services.transactions import upsert_transactions
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_reserve import confirm, goods_type, issue, no_discount, pos_user, reserve, unit
from test_production_voucher_review import document, held_goods


def booked_deduction(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    out = held_goods(w, "discount")
    item = str(uuid.uuid4())
    doc = document(w, shift, total="65.00", legs=[{"method": "cash", "amount": "25.00"}],
                   items=[{"id": item, "productName": "כריך", "quantity": 1, "unitPrice": "65.00", "totalPrice": "65.00"}],
                   deductions=[{"reservationId": out["reservationId"], "kind": "production_voucher", "uses": 1,
                                "amount": "40.00", "lines": [{"itemId": item, "amount": "40.00"}]}])
    upsert_transactions(w.db, till, [doc])
    w.db.commit()
    return till, shift


def test_1_the_insights_hour_cells_leave_the_deduction_out(w):
    from app.services.insights import data as D
    from app.services.insights.analytics import BusinessClock

    booked_deduction(w)
    tx = w.db.query(Transaction).one()
    clock = BusinessClock(tz_name="UTC", day_start_hour=0, now=datetime.now(timezone.utc))
    scope = D.InsightScope(user=w.admin, tenant_id=w.tenant.id)
    day = tx.created_at.date() if tx.created_at else date.today()
    cells = D.load_hour_cells(w.db, scope, clock, day - timedelta(days=1), day + timedelta(days=1))
    (cell,) = cells.values()
    # The till's X: gross ₪25, discounts ₪0 — the ₪40 voucher is no discount; the net as before.
    assert (cell.gross, cell.discounts, cell.net) == (2500, 0, 2500)


def test_3_a_non_numeric_line_amount_never_refuses_the_document(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    out = held_goods(w, "discount")
    item = str(uuid.uuid4())
    doc = document(w, shift, total="65.00", legs=[{"method": "cash", "amount": "25.00"}],
                   items=[{"id": item, "productName": "כריך", "quantity": 1, "unitPrice": "65.00", "totalPrice": "65.00"}],
                   deductions=[{"reservationId": out["reservationId"], "kind": "production_voucher", "uses": 1,
                                "amount": "40.00", "lines": [{"itemId": item, "amount": "not-a-number"}]}])
    assert [r.status for r in upsert_transactions(w.db, till, [doc])] == ["accepted"]
    # The hold is confirmed by the deduction's own amount.
    r = w.db.query(PrepaidVoucherRedemption).one()
    assert r.covered_agorot == 4000


def test_6_only_memo_lines_name_a_hold_and_each_hold_once(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    priced = held_goods(w, "zero")
    # A priced line naming a hold confirms nothing.
    line = {"id": str(uuid.uuid4()), "productName": "כריך", "quantity": 1, "unitPrice": "40.00", "totalPrice": "40.00",
            "voucherReservationId": priced["reservationId"]}
    upsert_transactions(w.db, till, [document(w, shift, total="40.00", items=[line], legs=[{"method": "cash", "amount": "40.00"}])])
    assert w.db.query(PrepaidVoucherRedemption).count() == 0
    # A payment leg and memo lines naming the same hold: one redemption, confirmed once.
    memo = [{"id": str(uuid.uuid4()), "productName": "נקניקייה", "quantity": 1, "unitPrice": "0", "totalPrice": "0",
             "voucherMemoValueAgorot": 2500, "voucherReservationId": priced["reservationId"]}]
    upsert_transactions(w.db, till, [document(w, shift, total="0.00", items=memo, number="9002", legs=[
        {"method": "production_voucher", "amount": "0.00", "reservationId": priced["reservationId"]}])])
    assert w.db.query(PrepaidVoucherRedemption).count() == 1


def test_7_another_tills_confirm_checks_stacking_against_the_holding_tills_sale(w, monkeypatch):
    from test_prepaid_voucher_kinds import basket, make
    from test_prepaid_voucher_kinds import reserve as reserve_discount

    b = make(w, usesPerVoucher=1)
    code = codes(w, b)[0]
    held = reserve_discount(w, code, basket(("L1", w.sandwich, 1, 40)), till=w.tills[0], sale="sale-A")
    seen = []
    real = PV._vouchers_in_sale

    def spy(db, machine, sale_ref, **kw):
        seen.append((machine.id, sale_ref))
        return real(db, machine, sale_ref, **kw)

    monkeypatch.setattr(PV, "_vouchers_in_sale", spy)
    PV.confirm(w.db, w.tills[1], held["reservationId"], "tx-doc", 3000, any_till=True)
    assert seen and seen[-1] == (w.tills[0].id, "sale-A")


class TestNits:
    def test_an_invalid_approval_is_ignored_when_none_is_needed(self, w):
        b = issue(w, goods_type(w, tillValue=80, discountBlockPolicy={"mode": "manager"})["id"])  # nothing to force
        cashier = pos_user(w, role="cashier")
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")],
                      approval={"posUserId": str(cashier.id), "posUserName": "x"})
        assert out["status"] == "held"
        # … and refused when one is needed.
        no_discount(w, w.hotdog)
        b2 = issue(w, goods_type(w, code="M2", tillValue=50, discountBlockPolicy={"mode": "manager"})["id"])
        with pytest.raises(HTTPException) as e:
            reserve(w, codes(w, b2)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")],
                    approval={"posUserId": str(cashier.id), "posUserName": "x"})
        assert e.value.detail["code"] == PV.APPROVAL_INVALID

    def test_groups_at_redeem_say_reserve(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="ארוחה", selection="groups", tillValue=60, redemptionAccounting="payment",
            groups=[{"name": "מנה", "minQty": 1, "maxQty": 1, "categoryIds": [w.food.id]}]), **_ctx(w))
        b = issue(w, t["id"])
        till = w.tills[0]
        body = PrepaidVoucherRedeemIn(code=codes(w, b)[0], items=[{"productId": str(w.hotdog.id), "quantity": 1}],
                                      clientRequestId="r1", features=["accounting", "groups", "reserve_goods"])
        with pytest.raises(HTTPException) as e:
            R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)
        assert e.value.detail == PV.RESERVE_REQUIRED

    def test_the_edit_recounts_what_was_really_taken(self, w):
        from app.services import prepaid_voucher_edit as PVE

        b = issue(w, goods_type(w, tillValue=80, redemptionAccounting="payment", splitAllowed=True)["id"])
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == codes(w, b)[0]).one()
        # An over-use that took nothing (`takenQuantity` 0): nothing counted as used.
        w.db.add(PrepaidVoucherRedemption(
            id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=v.id, batch_id=v.batch_id, client_request_id="o1",
            items=[{"productId": str(w.hotdog.id), "quantity": 1}],
            units=[{"productId": str(w.hotdog.id), "quantity": 1, "takenQuantity": 0}]))
        w.db.commit()
        used = PVE._used(w.db, [v], groups=False)[str(v.id)]
        assert used.get(str(w.hotdog.id), Decimal(0)) == 0
