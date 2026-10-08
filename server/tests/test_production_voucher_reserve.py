"""
Reserve → confirm for goods vouchers (the production vouchers contract §3):

* a fixed list or groups (assigned by the shared rules; an ambiguous unit comes back with its
  choices); whole at once unless the rest is forfeited;
* `cover`: the list prices up to the value, the rest a top-up (refused when not allowed);
  `fixed`: the value split between the units — what the document covers per accounting mode;
* the discount-block policy: honour refuses a reduction on a "לא מקבל הנחות" product, auto forces
  it, manager forces it only with an approval — every forced unit in the override audit;
* held by one sale it is in use for every other; the same request renews, the same reservation
  confirms once; the confirm takes the units off the voucher and records the redemption (§5).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherOverrideAudit, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherBatchCreate,
    PrepaidVoucherConfirmIn,
    PrepaidVoucherReserveIn,
    PrepaidVoucherTypeCreate,
)
from app.services import prepaid_vouchers as PV
from app.services import production_voucher_rules as PR
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture

FEATURES = ["accounting", "groups", "reserve_goods", "override"]


def goods_type(w, name="סוג", code=None, **extra):
    body = {"companyId": w.company.id, "name": name, "code": code,
            "items": [{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.sandwich.id, "quantity": 1}], **extra}
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w))


def issue(w, type_id, count=2, **extra):
    return R.create_prepaid_voucher_batch(
        PrepaidVoucherBatchCreate(name="פסטיבל", companyId=w.company.id, typeId=type_id, count=count, **extra), **_ctx(w))


def unit(product, price, ref=None, group=None, no_discount=False):
    return {"ref": ref, "productId": str(product.id), "productName": product.name, "groupKey": group, "quantity": 1,
            "listPriceAgorot": price, "listValueAgorot": price, "categoryIds": [str(product.category_id)],
            "noDiscount": no_discount}


def reserve(w, code, units, *, sale="s1", request_id=None, till=None, approval=None, forfeit=False, features=FEATURES):
    till = till or w.tills[0]
    body = PrepaidVoucherReserveIn(code=code, clientRequestId=request_id or str(uuid.uuid4()), saleRef=sale,
                                   units=units, approval=approval, forfeitRest=forfeit, features=features,
                                   posUserId=7, posUserName="דנה")
    return R.reserve_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def confirm(w, rid, tx="tx-1", till=None):
    till = till or w.tills[0]
    return R.confirm_prepaid_reservation(str(till.id), rid, PrepaidVoucherConfirmIn(transactionId=tx, amountAgorot=0),
                                         machine=till, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def code_of(e: HTTPException) -> str:
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


class TestCover:
    def test_list_prices_as_a_payment_then_the_record(self, w):
        b = issue(w, goods_type(w, redemptionAccounting="payment", pricing="cover")["id"])
        code = codes(w, b)[0]
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        assert (out["status"], out["redemptionAccounting"], out["pricing"], out["tender"]) == ("held", "payment", "cover", "production_voucher")
        assert (out["coveredAgorot"], out["topUpAgorot"], out["listValueAgorot"]) == (6500, 0, 6500)
        assert [u["coveredAgorot"] for u in out["units"]] == [2500, 4000]
        done = confirm(w, out["reservationId"])
        assert (done["status"], done["coveredAgorot"]) == ("confirmed", 6500)
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.redemption_accounting, r.value_agorot, r.covered_agorot, r.serial, r.transaction_id) == ("payment", 6500, 6500, 1, "tx-1")
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
        assert v.status == "used"
        assert confirm(w, out["reservationId"])["replayed"] is True  # once
        assert w.db.query(PrepaidVoucherRedemption).count() == 1

    def test_up_to_the_value_with_a_top_up(self, w):
        b = issue(w, goods_type(w, pricing="cover", tillValue=30, allowTopUp=True)["id"])
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        assert (out["coveredAgorot"], out["topUpAgorot"], out["deduction"]) == (3000, 3500, {"kind": "production_voucher"})
        assert out["note"] == "נדרשת השלמה של ₪35"

    def test_no_top_up_when_the_type_allows_none(self, w):
        b = issue(w, goods_type(w, pricing="cover", tillValue=30, allowTopUp=False)["id"])
        e = refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        assert code_of(e) == PR.TOP_UP_NOT_ALLOWED


class TestFixed:
    def test_the_value_split_and_a_deduction_covers_whole(self, w):
        b = issue(w, goods_type(w, tillValue=60)["id"])  # fixed, a deduction (the default)
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        assert [u["valueAgorot"] for u in out["units"]] == [2308, 3692]
        assert (out["redemptionAccounting"], out["coveredAgorot"]) == ("discount", 6500)
        confirm(w, out["reservationId"])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.value_agorot, r.covered_agorot, r.list_value_agorot) == (6000, 6500, 6500)

    def test_payment_reprices_to_the_value(self, w):
        b = issue(w, goods_type(w, tillValue=80, redemptionAccounting="payment")["id"])
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        assert (out["coveredAgorot"], [u["coveredAgorot"] for u in out["units"]]) == (8000, [3077, 4923])

    def test_whole_at_once_unless_forfeited(self, w):
        b = issue(w, goods_type(w, tillValue=60)["id"])
        assert code_of(refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a")])) == PV.PARTIAL_NOT_ALLOWED
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a")], forfeit=True)
        assert out["units"][0]["valueAgorot"] == 6000


class TestOverride:
    def test_honour_refuses_a_reduction_on_a_no_discount_product(self, w):
        b = issue(w, goods_type(w, tillValue=50)["id"])
        e = refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a", no_discount=True), unit(w.sandwich, 4000, "b")])
        assert code_of(e) == PR.DISCOUNT_BLOCKED

    def test_auto_forces_it_and_the_audit_has_it(self, w):
        b = issue(w, goods_type(w, tillValue=50, discountBlockPolicy={"mode": "auto"})["id"])
        out = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a", no_discount=True), unit(w.sandwich, 4000, "b")])
        forced = next(u for u in out["units"] if u["ref"] == "a")
        assert (forced["forced"], forced["reductionAgorot"]) == (True, 2500 - forced["valueAgorot"])
        confirm(w, out["reservationId"])
        audit = w.db.query(PrepaidVoucherOverrideAudit).one()
        assert (audit.policy, audit.list_price_agorot, audit.reduction_agorot) == ("auto", 2500, forced["reductionAgorot"])

    def test_manager_needs_an_approval_and_records_who(self, w):
        b = issue(w, goods_type(w, tillValue=50, discountBlockPolicy={"mode": "manager"})["id"])
        units = [unit(w.hotdog, 2500, "a", no_discount=True), unit(w.sandwich, 4000, "b")]
        e = refused(reserve, w, codes(w, b)[0], units)
        assert (code_of(e), e.detail["needsApproval"]) == (PR.APPROVAL_NEEDED, True)
        out = reserve(w, codes(w, b)[0], units, approval={"posUserId": "9", "posUserName": "רון", "method": "pin"})
        confirm(w, out["reservationId"])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert r.approved_by_pos_user_name == "רון"
        assert w.db.query(PrepaidVoucherOverrideAudit).one().approved_by_pos_user_name == "רון"


class TestGroups:
    def meal(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="שובר ארוחה", selection="groups", tillValue=60, redemptionAccounting="payment",
            groups=[{"name": "מנה", "minQty": 1, "maxQty": 1, "categoryIds": [w.food.id]},
                    {"name": "שתייה", "minQty": 1, "maxQty": 1, "categoryIds": [w.drinks.id]}],
        ), **_ctx(w))
        return issue(w, t["id"])

    def test_assigned_by_the_rules_and_taken_per_group(self, w):
        b = self.meal(w)
        code = codes(w, b)[0]
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.coffee, 1200, "b")])
        assert sorted(u["groupName"] for u in out["units"]) == ["מנה", "שתייה"]
        assert out["coveredAgorot"] == 6000
        confirm(w, out["reservationId"])
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
        assert v.status == "used" and v.remaining["total"] == 0

    def test_an_incomplete_package_is_refused(self, w):
        b = self.meal(w)
        e = refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a")])
        assert code_of(e) == PR.PACKAGE_INCOMPLETE and e.detail["message"] == "חסר שתייה להשלמת שובר ארוחה"

    def test_an_ambiguous_unit_comes_back_with_its_choices(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="אחד מכמה", selection="groups", totalQty=1, pricing="cover", groups=[
                {"name": "א", "minQty": 0, "maxQty": 1, "categoryIds": [w.food.id]},
                {"name": "ב", "minQty": 0, "maxQty": 1, "productIds": [w.hotdog.id]},
            ]), **_ctx(w))
        b = issue(w, t["id"])
        e = refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500, "a")])
        assert code_of(e) == "prepaid_voucher_group_ambiguous"
        assert e.detail["units"][0]["ref"] == "a" and sorted(e.detail["units"][0]["groupNames"]) == ["א", "ב"]
        key = e.detail["units"][0]["groupKeys"][1]
        assert reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a", group=key)])["status"] == "held"


class TestHolding:
    def test_in_use_elsewhere_renewed_here(self, w):
        b = issue(w, goods_type(w, pricing="cover", redemptionAccounting="payment")["id"])
        code = codes(w, b)[0]
        units = [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")]
        first = reserve(w, code, units, request_id="r1")
        assert code_of(refused(reserve, w, code, units, sale="s2", till=w.tills[1])) == PV.IN_USE
        again = reserve(w, code, units, request_id="r1")
        assert (again["replayed"], again["reservationId"]) == (True, first["reservationId"])

    def test_an_older_client_is_told_to_update(self, w):
        b = issue(w, goods_type(w, tillValue=60)["id"])  # a deduction needs `accounting`
        assert code_of(refused(reserve, w, codes(w, b)[0], [unit(w.hotdog, 2500)], features=[])) == PV.UPDATE_REQUIRED


class TestTheDocumentConfirms:
    def test_a_deduction_naming_its_hold(self, w):
        from app.models.prepaid_voucher import PrepaidVoucherReservation
        from app.models.shift import ShiftStatus
        from app.schemas.transaction import TransactionIn
        from app.services.transactions import upsert_transactions
        from shift_world import NOW, TODAY

        b = issue(w, goods_type(w, tillValue=60)["id"])
        held = reserve(w, codes(w, b)[0], [unit(w.hotdog, 2500, "a"), unit(w.sandwich, 4000, "b")])
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "9001", "status": "completed", "documentType": 320,
            "totalAmount": "65.00", "documentDiscount": "65.00", "paymentMethod": "cash", "payments": [],
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(shift.id), "businessDate": str(TODAY),
            "items": [{"id": str(uuid.uuid4()), "productName": "נקניקייה", "quantity": 1, "unitPrice": "25.00", "totalPrice": "25.00"},
                      {"id": str(uuid.uuid4()), "productName": "כריך", "quantity": 1, "unitPrice": "40.00", "totalPrice": "40.00"}],
            "voucherDiscounts": [{"kind": "production_voucher", "reservationId": held["reservationId"], "serial": 1,
                                  "typeName": "סוג", "amount": "65.00"}],
        })
        assert [r.status for r in upsert_transactions(w.db, till, [doc])] == ["accepted"]
        w.db.commit()
        r = w.db.query(PrepaidVoucherReservation).one()
        assert (r.status, r.transaction_id) == ("confirmed", str(doc.id))
        assert w.db.query(PrepaidVoucherRedemption).one().covered_agorot == 6500
