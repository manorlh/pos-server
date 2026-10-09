"""
The independent review of `fix/voucher-print` (09.10), each finding as the reviewer put it:

1. `/redeem` took a valued voucher at list prices — no cap, no top-up, no override (blocker).
2. Reversing a grouped redemption gave nothing back to its groups.
3. Two confirms of one hold could both write; a document of another till filed it there.
4. A confirm revived a cancelled voucher.
5. A document's confirm never compared what it booked with the hold.
6. Only a deduction named its hold; a payment leg or memo lines could not.
7. `voucherMemo` dropped a sale with money out of the Z.
8. The deduction still counted as a discount (exceptions, events, insights); waiters filed it as "other".
9. A legacy redemption (no mode recorded) was re-filed when the batch's mode changed.
10. `zero` + a cover value + a top-up was accepted.
16. The till's word was taken for a manager's approval and for the "no discount" flag.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from decimal import Decimal

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption, PrepaidVoucherReservation
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.schemas.transaction import TransactionIn
from app.services.shift_totals import compute_totals, production_deductions_of
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherLookupIn, PrepaidVoucherRedeemIn, PrepaidVoucherTypeCreate
from app.services import prepaid_vouchers as PV
from app.services import production_voucher_rules as PR
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_reserve import code_of, confirm, goods_type, issue, no_discount, pos_user, refused, reserve, unit


def voucher(w, code) -> PrepaidVoucher:
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()


def immediate(w, code, items, features=("accounting", "reserve_goods", "override"), till=None):
    till = till or w.tills[0]
    body = PrepaidVoucherRedeemIn(code=code, items=[{"productId": str(p.id), "quantity": q} for p, q in items],
                                  clientRequestId=str(uuid.uuid4()), features=list(features))
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def look(w, code, features):
    till = w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, features=features), machine=till, db=w.db)


class TestRedeemIsForPlainBatchesOnly:
    """1 (blocker): a fixed ₪30 voucher took ₪65 of goods through /redeem, recorded as covering ₪65."""

    @pytest.mark.parametrize("terms", [
        {"tillValue": 30, "pricing": "fixed", "redemptionAccounting": "payment"},
        {"tillValue": 30, "pricing": "cover", "allowTopUp": True, "redemptionAccounting": "payment"},
        {"redemptionAccounting": "payment", "pricing": "cover", "discountBlockPolicy": {"mode": "auto"}},
    ])
    def test_a_value_a_cap_or_a_policy_is_refused_and_nothing_is_taken(self, w, terms):
        b = issue(w, goods_type(w, **terms)["id"])
        code = codes(w, b)[0]
        before = dict(voucher(w, code).remaining)
        with pytest.raises(HTTPException) as e:
            immediate(w, code, [(w.hotdog, 1), (w.sandwich, 1)])
        assert (e.value.status_code, e.value.detail) == (409, PV.RESERVE_REQUIRED)
        assert voucher(w, code).remaining == before and w.db.query(PrepaidVoucherRedemption).count() == 0
        # Lookup tells a till that cannot hold it to update, before any sale.
        assert look(w, code, ["accounting", "override"])["reason"] == PV.UPDATE_REQUIRED
        assert look(w, code, ["accounting", "override", "reserve_goods"])["redeemable"] is True

    def test_a_plain_batch_still_redeems_at_list_prices(self, w):
        b = issue(w, goods_type(w, redemptionAccounting="payment", pricing="cover")["id"])
        immediate(w, codes(w, b)[0], [(w.hotdog, 1), (w.sandwich, 1)], features=())
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.redemption_accounting, r.covered_agorot, r.list_value_agorot) == ("payment", 6500, 6500)

    def test_the_snapshot_of_a_fixed_value_covers_its_share(self, w):
        b = issue(w, goods_type(w, tillValue=30, pricing="fixed", redemptionAccounting="payment", splitAllowed=True)["id"])
        v = voucher(w, codes(w, b)[0])
        snap = PV.record_snapshot(w.db, w.tills[0], v.batch, v, {str(w.hotdog.id): PV.qty(1)}, features=["accounting"])
        assert (snap["value_agorot"], snap["covered_agorot"], snap["list_value_agorot"]) == (1500, 1500, 2500)


class TestGroupedReversal:
    """2: a meal (one dish + one drink) redeemed then reversed stayed used, its groups empty."""

    def meal(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="שובר ארוחה", selection="groups", tillValue=60, redemptionAccounting="payment",
            groups=[{"name": "מנה", "minQty": 1, "maxQty": 1, "categoryIds": [w.food.id]},
                    {"name": "שתייה", "minQty": 1, "maxQty": 1, "categoryIds": [w.drinks.id]}],
        ), **_ctx(w))
        return issue(w, t["id"])

    def test_the_groups_and_the_total_come_back_and_it_is_redeemable_again(self, w):
        b = self.meal(w)
        code = codes(w, b)[0]
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.coffee, 1200, "b")])
        done = confirm(w, out["reservationId"])
        v = voucher(w, code)
        assert v.status == "used" and v.remaining["total"] == 0
        R.reverse_prepaid_redemption(str(w.tills[0].id), done["redemptionId"], machine=w.tills[0], db=w.db)
        w.db.refresh(v)
        keys = {g["name"]: g["key"] for g in b["groups"]}
        assert v.status == "active"
        assert v.remaining == {f"g:{keys['מנה']}": 1, f"g:{keys['שתייה']}": 1, "total": 2}
        again = reserve(w, code, [unit(w.sandwich, 4000, "a"), unit(w.coffee, 1200, "b")], sale="s2")
        assert again["status"] == "held"


class TestConfirm:
    """3: the till's confirm and the document's raced; the document of another till filed it there."""

    def test_a_document_of_another_till_files_it_on_the_till_that_held_it(self, w):
        b = issue(w, goods_type(w, tillValue=80, redemptionAccounting="payment")["id"])
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        PV.confirm(w.db, w.tills[1], out["reservationId"], "tx-doc", out["coveredAgorot"], any_till=True)
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.machine_id, r.shop_id) == (w.tills[0].id, w.tills[0].shop_id)

    def test_a_duplicate_confirm_answers_the_first_never_twice(self, w):
        b = issue(w, goods_type(w, tillValue=80, redemptionAccounting="payment")["id"])
        code = codes(w, b)[0]
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        first = confirm(w, out["reservationId"])
        # A confirm that wrote its redemption but died before marking the hold: the next one replays.
        hold = w.db.get(PrepaidVoucherReservation, uuid.UUID(out["reservationId"]))
        hold.status, hold.redemption_id = "held", None
        w.db.commit()
        again = confirm(w, out["reservationId"])
        assert (again["replayed"], again["redemptionId"]) == (True, first["redemptionId"])
        assert w.db.query(PrepaidVoucherRedemption).count() == 1
        assert voucher(w, code).status == "used"


class TestCancelledStaysCancelled:
    """4: a voucher cancelled while held came back `used` / `partially_used` on the confirm."""

    def test_goods(self, w):
        b = issue(w, goods_type(w, tillValue=80, redemptionAccounting="payment")["id"])
        code = codes(w, b)[0]
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        R.cancel_prepaid_voucher(str(voucher(w, code).id), None, **_ctx(w))
        confirm(w, out["reservationId"])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert voucher(w, code).status == "cancelled" and "cancelled" in (r.flags or [])

    def test_a_discount(self, w):
        from test_prepaid_voucher_kinds import basket, make
        from test_prepaid_voucher_kinds import confirm as confirm_discount
        from test_prepaid_voucher_kinds import reserve as reserve_discount

        b = make(w, usesPerVoucher=2)
        code = codes(w, b)[0]
        held = reserve_discount(w, code, basket(("L1", w.sandwich, 1, 40)))
        R.cancel_prepaid_voucher(str(voucher(w, code).id), None, **_ctx(w))
        confirm_discount(w, held["reservationId"])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert voucher(w, code).status == "cancelled" and "cancelled" in (r.flags or [])


class TestApprovalAndCatalogFlags:
    """16: any `approval` object passed; `noDiscount: false` from the till lifted a catalog block."""

    def manager_batch(self, w):
        no_discount(w, w.hotdog)
        return issue(w, goods_type(w, tillValue=50, discountBlockPolicy={"mode": "manager"})["id"])

    def units(self, w):
        return [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")]

    def test_only_an_active_manager_of_the_shop_approves(self, w):
        b = self.manager_batch(w)
        code = codes(w, b)[0]
        for who in (pos_user(w, role="cashier"), pos_user(w, shop=w.other_shop), pos_user(w, active=False)):
            e = refused(reserve, w, code, self.units(w), approval={"posUserId": str(who.id), "posUserName": "x"})
            assert (code_of(e), e.detail["needsApproval"]) == (PV.APPROVAL_INVALID, True)
        e = refused(reserve, w, code, self.units(w), approval={"posUserName": "רון"})  # no id at all
        assert code_of(e) == PV.APPROVAL_INVALID
        ok = reserve(w, code, self.units(w), approval={"posUserId": str(pos_user(w).id), "posUserName": "רון"})
        assert ok["status"] == "held"

    def test_the_no_discount_flag_is_the_catalogs(self, w):
        no_discount(w, w.hotdog)
        b = issue(w, goods_type(w, tillValue=50)["id"])  # honour
        # The till says "discountable": the catalog says no — refused.
        e = refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a", no_discount=False), unit(w.sandwich, 4000, "b")])
        assert code_of(e) == PR.DISCOUNT_BLOCKED
        # The till says "no discount" for a product the catalog lets through — allowed.
        w.hotdog.no_discount = False
        w.db.commit()
        out = reserve(w, codes(w, b)[1], [unit(w.hotdog, 2500, "a", no_discount=True), unit(w.sandwich, 4000, "b")])
        assert out["status"] == "held"


def document(w, shift, *, total="65.00", legs=(), items=None, deductions=(), memo=False, tip="0", number="9001"):
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": total, "documentDiscount": str(sum((Decimal(d["amount"]) for d in deductions), Decimal(0))),
        "paymentMethod": legs[0]["method"] if legs else "cash",
        "payments": [{"id": str(uuid.uuid4()), **leg} for leg in legs], "tipAmount": tip,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": items or [{"id": str(uuid.uuid4()), "productName": "כריך", "quantity": 1, "unitPrice": total, "totalPrice": total}],
        "voucherDiscounts": list(deductions), "voucherMemo": memo,
    })


def held_goods(w, accounting, till=None):
    b = issue(w, goods_type(w, tillValue=50, pricing="fixed", redemptionAccounting=accounting)["id"])
    return reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")], till=till)


class TestTheDocumentNamesItsHold:
    """5 + 6: the document confirms its hold in every mode and says what it booked."""

    def test_a_payment_leg(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        out = held_goods(w, "payment")
        doc = document(w, shift, total="65.00", legs=[
            {"method": "production_voucher", "amount": "50.00", "reservationId": out["reservationId"]},
            {"method": "cash", "amount": "15.00"}])
        assert [r.status for r in upsert_transactions(w.db, till, [doc])] == ["accepted"]
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.transaction_id, r.covered_agorot, r.flags) == (str(doc.id), 5000, None)

    def test_memo_lines(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        out = held_goods(w, "zero")
        items = [{"id": str(uuid.uuid4()), "productName": p.name, "quantity": 1, "unitPrice": "0", "totalPrice": "0",
                  "voucherMemoValueAgorot": v, "voucherReservationId": out["reservationId"]}
                 for p, v in ((w.hotdog, 2500), (w.sandwich, 4000))]
        upsert_transactions(w.db, till, [document(w, shift, total="0.00", items=items, memo=True)])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.redemption_accounting, r.covered_agorot) == ("zero", 0)

    def test_a_deduction_that_differs_from_the_hold_is_flagged_and_recorded_as_the_document_says(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        out = held_goods(w, "discount")
        item = str(uuid.uuid4())
        doc = document(w, shift, total="65.00", legs=[{"method": "cash", "amount": "20.00"}],
                       items=[{"id": item, "productName": "כריך", "quantity": 1, "unitPrice": "65.00", "totalPrice": "65.00"}],
                       deductions=[{"reservationId": out["reservationId"], "kind": "production_voucher", "uses": 1,
                                    "amount": "40.00", "lines": [{"itemId": item, "amount": "45.00"}]}])
        upsert_transactions(w.db, till, [doc])
        r = w.db.query(PrepaidVoucherRedemption).one()
        # The hold covered ₪65 (a fixed deduction takes the lines whole); the document's lines say ₪45.
        assert r.covered_agorot == 4500 and "amount_mismatch" in (r.flags or [])


class TestVoucherMemoOnlyWhenSafe:
    """7: a document with money and `voucherMemo: true` vanished from the Z."""

    def test_money_is_never_out_of_the_z(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = document(w, shift, total="30.00", legs=[{"method": "cash", "amount": "30.00"}], memo=True)
        results = upsert_transactions(w.db, till, [doc])
        assert any("voucherMemo ignored" in str(x) for x in (results[0].warnings or []))
        w.db.commit()
        assert w.db.query(Transaction).one().voucher_memo is False
        totals = compute_totals(w.db, [shift.id])
        assert (totals.transactions_count, totals.voucher_memo_documents, totals.total_sales) == (1, 0, Decimal("30.00"))


class TestTheDeductionIsNoDiscount:
    """8: a ₪40 deduction raised a "large discount" exception and counted in events' discounts; waiters filed it as other."""

    def booked(self, w):
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
        return till, shift, w.db.query(Transaction).one()

    def test_no_discount_exception(self, w):
        from app.services import exceptions as EX

        _till, _shift, tx = self.booked(w)
        deduction = production_deductions_of(w.db, [tx.id])[tx.id]
        assert deduction == Decimal("40.00")
        rule = EX.EffectiveRule(type="discount", enabled=True, params={"minPercent": 10})
        assert [f.type for f in EX.detect_transaction(tx, {"discount": rule}, None)] == ["discount"]  # as before
        assert [f.type for f in EX.detect_transaction(tx, {"discount": rule}, None, deduction)] == []

    def test_events_gross_and_discount(self, w):
        from app.services.report_events.common import make_doc

        _till, _shift, tx = self.booked(w)
        d = make_doc(tx, [], production_deductions_of(w.db, [tx.id])[tx.id])
        assert (d.gross, d.discount) == (Decimal("25.00"), Decimal("0"))

    def test_waiters_file_the_voucher_tender_apart(self, w):
        from app.services.z_waiters import waiter_breakdown

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(w.db, till, [document(w, shift, total="65.00", legs=[
            {"method": "production_voucher", "amount": "50.00"}, {"method": "cash", "amount": "15.00"}])])
        w.db.commit()
        (row,) = waiter_breakdown(w.db, [shift.id], till.shop_id)
        assert (row["productionVoucher"], row["other"], row["cash"]) == ("50.00", "0.00", "15.00")


class TestLegacyAndTerms:
    def test_9_a_legacy_redemption_is_payment_whatever_the_batch_says_later(self, w):
        from app.services import prepaid_voucher_analytics as A

        b = issue(w, goods_type(w, redemptionAccounting="payment", pricing="cover")["id"])
        immediate(w, codes(w, b)[0], [(w.hotdog, 1), (w.sandwich, 1)], features=())
        w.db.query(PrepaidVoucherRedemption).update({"redemption_accounting": None})
        w.db.query(PrepaidVoucherBatch).update({"redemption_accounting": "zero"})
        w.db.commit()
        (row,) = A.redemptions_list(w.db, w.admin, w.tenant.id, A.make_scope())["items"]
        assert row["accounting"] == "payment"

    def test_10_zero_with_a_cover_value_and_a_top_up_is_refused(self, w):
        with pytest.raises(Exception) as e:
            goods_type(w, redemptionAccounting="zero", pricing="cover", tillValue=30, allowTopUp=True)
        assert "top-up" in str(e.value)
        assert goods_type(w, code="Z2", redemptionAccounting="zero", pricing="cover", tillValue=30, allowTopUp=False)["id"]

