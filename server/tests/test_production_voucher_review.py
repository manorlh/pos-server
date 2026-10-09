"""
The independent review of `fix/voucher-print` (09.10), each finding as the reviewer put it:

1. `/redeem` took a valued voucher at list prices — no cap, no top-up, no override (blocker).
2. Reversing a grouped redemption gave nothing back to its groups.
3. Two confirms of one hold could both write; a document of another till filed it there.
4. A confirm revived a cancelled voucher.
5. A document's confirm never compared what it booked with the hold.
16. The till's word was taken for a manager's approval and for the "no discount" flag.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption, PrepaidVoucherReservation
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
