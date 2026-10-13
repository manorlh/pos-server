"""
"מימוש ידני מהענן" (app/services/prepaid_voucher_manual.py): the scanner failed at an event, the customers
were served, a manager records the redemptions from the dashboard — by kind, the till's rules and the
till's write, marked manual; one click ("סמן כמומש") with a super admin's override; bulk; undo; who may.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.dashboard_access import DashboardAccessProfile
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
)
from app.models.user import User, UserRole
from app.routers import prepaid_voucher_manual as RM
from app.routers import prepaid_vouchers as R
from app.routers import reports as reports_router
from app.schemas.prepaid_voucher import PrepaidVoucherBatchUpdate
from app.schemas.prepaid_voucher_manual import (
    ManualRedeemBulkIn,
    ManualRedeemIn,
    ManualRedeemPreviewIn,
    ManualReverseIn,
)
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import prepaid_voucher_manual as PVM
from app.services import prepaid_vouchers as PV
from test_prepaid_voucher_kinds import _ctx, codes, make, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_groups import issue, meal_type
from test_voucher_punch_card import punch_type

REASON = "הסורק לא עבד באירוע"


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def redeem(w, code=None, *, user=None, shop=None, key=None, **body):
    data = {"code": code, "shopId": str((shop or w.shop).id), "reason": body.pop("reason", REASON),
            "clientRequestId": key or str(uuid.uuid4()), **body}
    return RM.manual_redeem_prepaid_voucher(ManualRedeemIn(**data), idempotency_key=None, **ctx(w, user))


def one_click(w, code, *, user=None, shop=None, **body):
    data = {"code": code, "oneClick": True, "clientRequestId": str(uuid.uuid4()), **body}
    if shop is not None:
        data["shopId"] = str(shop.id)
    return RM.manual_redeem_prepaid_voucher(ManualRedeemIn(**data), idempotency_key=None, **ctx(w, user))


def bulk(w, *, user=None, key=None, **body):
    data = {"shopId": str(w.shop.id), "reason": REASON, "clientRequestId": key or str(uuid.uuid4()), **body}
    return RM.manual_redeem_prepaid_vouchers_bulk(ManualRedeemBulkIn(**data), idempotency_key=None, **ctx(w, user))


def reverse(w, redemption_id, *, user=None, reason="הוזן בטעות"):
    return RM.reverse_manual_prepaid_redemption(redemption_id, ManualReverseIn(reason=reason), **ctx(w, user))


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def code_of(e: HTTPException) -> str:
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


def row(w, code) -> PrepaidVoucher:
    w.db.expire_all()
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()


def goods(w, count=3, **terms):
    """A fixed list: 2 נקניקייה + 1 כריך, in parts unless said otherwise."""
    terms.setdefault("splitAllowed", True)
    terms.setdefault("items", [{"productId": w.hotdog.id, "quantity": 2}, {"productId": w.sandwich.id, "quantity": 1}])
    return make(w, "items", count=count, **terms)


def set_batch(w, batch_id, **cols):
    b = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(str(batch_id))).one()
    for k, v in cols.items():
        setattr(b, k, v)
    w.db.commit()


def manager(w, sections=None, *, full=False, org_wide=True):
    """A company manager; with a dashboard profile of [sections] (None: no profile row — the default)."""
    u = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, company_id=w.company.id,
             email=f"m{uuid.uuid4().hex[:6]}@x", username="מנהלת")
    w.db.add(u)
    w.db.flush()
    if sections is not None or full:
        w.db.add(DashboardAccessProfile(user_id=u.id, sections=sections or {}, full_access=full, org_wide=org_wide))
    w.db.commit()
    DA.forget(w.db)
    return u


# ── Goods ─────────────────────────────────────────────────────────────────────


class TestGoods:
    def test_full_takes_everything_and_is_marked_manual(self, w):
        b = goods(w)
        code = codes(w, b)[0]
        out = redeem(w, code, full=True)
        assert out["ok"] and not out["replayed"] and out["leftText"] == "לא נותר דבר"
        v = row(w, code)
        assert v.status == "used" and {k: int(q) for k, q in v.remaining.items()} == {str(w.hotdog.id): 0, str(w.sandwich.id): 0}
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.source, r.manual, r.manual_reason, r.manual_by_user_name) == ("dashboard", True, REASON, "admin")
        assert r.shop_id == w.shop.id and r.machine_id is None and r.reversed_at is None
        assert sorted((i["name"], int(i["quantity"])) for i in r.items) == [("כריך", 1), ("נקניקייה", 2)]
        # The till's record: list prices from the shop (25 × 2 + 40).
        assert r.list_value_agorot == 9000
        hist = out["voucher"]["redemptions"][0]
        assert (hist["manual"], hist["manualReason"], hist["source"], hist["shopName"]) == (True, REASON, "dashboard", "Center")
        ev = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == PVM.EVENT_REDEEM).one()
        assert ev.reason == REASON and ev.details["summary"] == f"מימוש ידני מהענן · admin · {REASON}"

    def test_partial_leaves_the_rest_and_says_what_is_left(self, w):
        code = codes(w, goods(w))[0]
        out = redeem(w, code, items=[{"productId": str(w.hotdog.id), "quantity": 1}])
        assert out["leftText"] == "נותרו: נקניקייה ×1, כריך ×1"
        v = row(w, code)
        assert v.status == "partially_used" and int(v.remaining[str(w.hotdog.id)]) == 1
        assert out["voucher"]["quota"] == 3 and out["voucher"]["remaining"] == 2

    def test_more_than_is_left_is_refused_with_what_is_left(self, w):
        code = codes(w, goods(w))[0]
        e = refused(redeem, w, code, items=[{"productId": str(w.hotdog.id), "quantity": 3}])
        assert e.status_code == 409 and code_of(e) == PV.INSUFFICIENT
        assert e.detail["message"] == "אין מספיק יתרה בשובר — נותרו: נקניקייה ×2, כריך ×1"

    def test_a_one_time_voucher_in_part_needs_the_rest_forfeited(self, w):
        code = codes(w, goods(w, splitAllowed=False))[0]
        e = refused(redeem, w, code, items=[{"productId": str(w.hotdog.id), "quantity": 1}])
        assert code_of(e) == PV.PARTIAL_NOT_ALLOWED and "בעסקה אחת" in e.detail["message"]
        redeem(w, code, items=[{"productId": str(w.hotdog.id), "quantity": 1}], forfeitRest=True)
        assert row(w, code).status == "used"


class TestGroups:
    def test_a_group_quota_per_group_and_the_meal_full(self, w):
        b = issue(w, meal_type(w, splitAllowed=True, tillValue=None, pricing="cover", groups=[
            {"name": "מנה", "minQty": 1, "maxQty": 1, "categoryIds": [w.food.id]},
            {"name": "שתייה", "minQty": 1, "maxQty": 1, "categoryIds": [w.drinks.id]},
        ])["id"])
        code, other = codes(w, b)
        g = {x["name"]: x["key"] for x in w.db.query(PrepaidVoucherBatch).filter(
            PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one().groups}
        # Two from "מנה" (one left of it): refused with the group's words.
        e = refused(redeem, w, code, items=[{"groupKey": g["מנה"], "quantity": 2}])
        assert code_of(e) == "prepaid_voucher_group_over" and "מנה" in e.detail["message"]
        out = redeem(w, code, items=[{"groupKey": g["מנה"], "quantity": 1}])
        assert out["leftText"] == "נותרו: שתייה ×1"
        assert int(row(w, code).remaining["total"]) == 1
        # A product named (the till's own assignment to its group).
        redeem(w, code, items=[{"productId": str(w.coffee.id), "quantity": 1}])
        assert row(w, code).status == "used"
        # Everything left at once.
        redeem(w, other, full=True)
        v = row(w, other)
        assert v.status == "used" and int(v.remaining["total"]) == 0

    def test_a_punch_card_by_units_and_full(self, w):
        code = codes(w, issue(w, punch_type(w)["id"]))[0]
        out = redeem(w, code, units=6)
        assert out["voucher"]["remaining"] == 44 and out["leftText"] == "נותרו: פריטים ×44"
        e = refused(redeem, w, code, units=45)
        assert code_of(e) == "prepaid_voucher_total_over" and e.detail["message"] == "ניתן לבחור עד 44 פריטים בשובר זה"
        redeem(w, code, full=True)
        v = row(w, code)
        assert (v.status, int(v.remaining["total"])) == ("used", 0)
        assert sum(len(r.units) for r in w.db.query(PrepaidVoucherRedemption)) == 50


class TestDiscounts:
    def test_an_item_discount_one_use_by_default_then_full(self, w):
        code = codes(w, make(w, "item_discount", usesPerVoucher=3))[0]
        out = redeem(w, code)
        assert out["leftText"] == "נותרו 2 מתוך 3 שימושים"
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.uses, r.manual, r.items) == (1, True, [])
        redeem(w, code, full=True)
        v = row(w, code)
        assert (v.status, v.uses_left) == ("used", 0)

    def test_an_order_discount_full(self, w):
        code = codes(w, make(w, "order_discount"))[0]
        redeem(w, code, full=True)
        assert row(w, code).status == "used"


# ── Refusals ──────────────────────────────────────────────────────────────────


class TestRefusals:
    def test_used(self, w):
        code = codes(w, goods(w))[0]
        redeem(w, code, full=True)
        e = refused(redeem, w, code, full=True)
        assert code_of(e) == PV.USED and e.detail["message"] == "השובר מומש כבר במלואו"

    def test_expired_and_occurred_while_valid(self, w):
        b = goods(w)
        code = codes(w, b)[0]
        ended = datetime.now(timezone.utc) - timedelta(days=1)
        set_batch(w, b["id"], valid_until=ended)
        e = refused(redeem, w, code, full=True)
        assert code_of(e) == PV.EXPIRED and e.detail["message"].startswith("תוקף השובר הסתיים ב-")
        # It happened while the voucher was valid: recorded at that time.
        at = ended - timedelta(hours=2)
        out = redeem(w, code, full=True, occurredAt=at.isoformat())
        assert out["redeemedAt"].startswith(at.strftime("%Y-%m-%dT%H:%M"))

    def test_never_in_the_future(self, w):
        code = codes(w, goods(w))[0]
        e = refused(redeem, w, code, full=True, occurredAt=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
        assert e.status_code == 400 and code_of(e) == PVM.FUTURE

    def test_another_shop(self, w):
        code = codes(w, goods(w, shopIds=[w.shop.id]))[0]
        e = refused(redeem, w, code, full=True, shop=w.other_shop)
        assert code_of(e) == PV.WRONG_SHOP and e.detail["message"] == "השובר אינו תקף בנקודת המכירה הזאת"

    def test_test_mode(self, w):
        b = goods(w)
        code = codes(w, b)[0]
        R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(testMode=True), **_ctx(w))
        e = refused(redeem, w, code, full=True)
        assert code_of(e) == PVM.TEST_MODE and e.detail["message"] == "הסדרה במצב בדיקה — מימוש ידני לא נרשם"
        assert w.db.query(PrepaidVoucherRedemption).count() == 0

    def test_a_reason_is_required(self, w):
        code = codes(w, goods(w))[0]
        assert code_of(refused(redeem, w, code, full=True, reason="  ")) == PVM.REASON_INVALID
        assert code_of(refused(redeem, w, code, full=True, reason="ab")) == PVM.REASON_INVALID

    def test_a_till_of_another_shop(self, w):
        code = codes(w, goods(w))[0]
        e = refused(redeem, w, code, full=True, machineId=str(w.other_till.id))
        assert code_of(e) == PVM.MACHINE_INVALID
        out = redeem(w, code, full=True, machineId=str(w.tills[0].id))
        assert out["voucher"]["redemptions"][0]["machineName"] == "Till 1"


class TestIdempotency:
    def test_the_same_request_id_answers_the_first_redemption(self, w):
        code = codes(w, goods(w))[0]
        first = redeem(w, code, key="req-1", items=[{"productId": str(w.hotdog.id), "quantity": 1}])
        again = redeem(w, code, key="req-1", items=[{"productId": str(w.hotdog.id), "quantity": 1}])
        assert again["replayed"] and again["redemptionId"] == first["redemptionId"]
        assert w.db.query(PrepaidVoucherRedemption).count() == 1
        assert int(row(w, code).remaining[str(w.hotdog.id)]) == 1

    def test_the_header_key_and_another_voucher_conflicts(self, w):
        a, b = codes(w, goods(w))[:2]
        body = ManualRedeemIn(code=a, shopId=str(w.shop.id), reason=REASON, full=True)
        first = RM.manual_redeem_prepaid_voucher(body, idempotency_key="hdr-1", **ctx(w))
        again = RM.manual_redeem_prepaid_voucher(body, idempotency_key="hdr-1", **ctx(w))
        assert again["replayed"] and again["redemptionId"] == first["redemptionId"]
        other = ManualRedeemIn(code=b, shopId=str(w.shop.id), reason=REASON, full=True)
        e = refused(RM.manual_redeem_prepaid_voucher, other, idempotency_key="hdr-1", **ctx(w))
        assert code_of(e) == PV.REQUEST_CONFLICT


# ── Bulk ──────────────────────────────────────────────────────────────────────


class TestBulk:
    def test_mixed_results_per_code_and_idempotent(self, w):
        cs = codes(w, goods(w, count=4))
        redeem(w, cs[1], full=True)  # already used
        out = bulk(w, key="bulk-1", codes=[cs[0], cs[1], "NOPE-NOPE", cs[2], cs[0]])
        assert (out["total"], out["redeemed"], out["refused"]) == (4, 2, 2)
        by = {r["input"]: r for r in out["results"]}
        assert by[cs[0]]["status"] == "redeemed" and by[cs[2]]["status"] == "redeemed"
        assert by[cs[1]]["status"] == "refused" and by[cs[1]]["reason"] == PV.USED and by[cs[1]]["message"]
        assert by["NOPE-NOPE"]["status"] == "refused" and by["NOPE-NOPE"]["message"] == "השובר לא נמצא"
        assert row(w, cs[0]).status == row(w, cs[2]).status == "used"
        again = bulk(w, key="bulk-1", codes=[cs[0], cs[2], cs[3]])
        assert (again["replayed"], again["redeemed"]) == (2, 1)
        assert w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.manual.is_(True)).count() == 4

    def test_the_batch_list_selection_by_voucher_ids(self, w):
        b = goods(w, count=3)
        ids = [v["id"] for v in R.list_prepaid_vouchers(b["id"], status_filter=None, serial=None, limit=10, offset=0,
                                                         **_ctx(w))["items"]]
        out = bulk(w, voucherIds=ids[:2], reason=None, oneClick=True)
        assert out["redeemed"] == 2
        reasons = {r.manual_reason for r in w.db.query(PrepaidVoucherRedemption)}
        assert reasons == {PVM.DEFAULT_REASON}

    def test_the_preview_counts(self, w):
        cs = codes(w, goods(w, count=3))
        redeem(w, cs[0], full=True)
        out = RM.manual_redeem_prepaid_vouchers_preview(ManualRedeemPreviewIn(codes=cs + ["XX"], shopId=str(w.shop.id)), **ctx(w))
        assert (out["total"], out["ok"], out["refused"], out["notFound"]) == (4, 2, 1, 1)
        ok = next(v for v in out["vouchers"] if v.get("code") == cs[1])
        assert ok["leftText"] == "נותרו: נקניקייה ×2, כריך ×1" and {s["name"] for s in ok["validShops"]} == {"Center", "North"}

    def test_more_than_500_is_refused(self, w):
        with pytest.raises(ValueError):
            ManualRedeemBulkIn(codes=[f"C{i}" for i in range(501)], shopId=str(w.shop.id), reason=REASON)


# ── Undo ──────────────────────────────────────────────────────────────────────


class TestUndo:
    def test_reverse_gives_everything_back_and_is_audited(self, w):
        code = codes(w, goods(w))[0]
        out = redeem(w, code, full=True)
        back = reverse(w, out["redemptionId"])
        assert back["reversedAt"] and back["leftText"] == "נותרו: נקניקייה ×2, כריך ×1"
        v = row(w, code)
        assert v.status == "active" and v.last_redeemed_at is None
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.reverse_reason, r.reversed_by_user_name) == ("הוזן בטעות", "admin")
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == PVM.EVENT_REVERSE).count() == 1
        # Idempotent; and the voucher can be redeemed again.
        reverse(w, out["redemptionId"])
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == PVM.EVENT_REVERSE).count() == 1
        redeem(w, code, full=True)
        assert row(w, code).status == "used"

    def test_reverse_a_punch_card_and_a_discount(self, w):
        card = codes(w, issue(w, punch_type(w)["id"]))[0]
        r1 = redeem(w, card, units=6)
        reverse(w, r1["redemptionId"])
        assert int(row(w, card).remaining["total"]) == 50
        disc = codes(w, make(w, "item_discount", usesPerVoucher=2))[0]
        r2 = redeem(w, disc, full=True)
        reverse(w, r2["redemptionId"])
        assert row(w, disc).uses_left == 2

    def test_a_till_redemption_is_not_reversed_from_the_cloud(self, w):
        code = codes(w, goods(w))[0]
        out = redeem(w, code, full=True)
        r = w.db.query(PrepaidVoucherRedemption).one()
        r.manual = False
        w.db.commit()
        assert code_of(refused(reverse, w, out["redemptionId"])) == PVM.NOT_MANUAL


# ── One click and the super admin's override ─────────────────────────────────


class TestOneClick:
    @pytest.mark.parametrize("kind", ["items", "groups", "punch", "order_discount", "item_discount"])
    def test_everything_left_for_each_kind(self, w, kind):
        if kind == "items":
            code = codes(w, goods(w, shopIds=[w.shop.id]))[0]
        elif kind == "groups":
            code = codes(w, issue(w, meal_type(w)["id"]))[0]
        elif kind == "punch":
            code = codes(w, issue(w, punch_type(w)["id"]))[0]
        else:
            code = codes(w, make(w, kind, usesPerVoucher=2))[0]
        # The batch for one shop: no shop needed; else the user picks it.
        out = one_click(w, code, shop=None if kind == "items" else w.shop)
        assert row(w, code).status == "used" and out["leftText"] in ("לא נותר דבר", "נותרו 0 מתוך 2 שימושים")
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.manual, r.manual_reason, r.shop_id) == (True, PVM.DEFAULT_REASON, w.shop.id)

    def test_a_shop_must_be_picked_when_more_than_one_is_valid(self, w):
        code = codes(w, goods(w))[0]
        assert code_of(refused(one_click, w, code)) == PVM.SHOP_REQUIRED

    def test_a_super_admin_forces_an_expired_voucher_audited(self, w):
        b = goods(w, shopIds=[w.shop.id])
        code = codes(w, b)[0]
        set_batch(w, b["id"], valid_until=datetime.now(timezone.utc) - timedelta(days=2))
        e = refused(one_click, w, code)
        assert code_of(e) == PV.EXPIRED and e.detail["overridable"] is True
        prev = RM.manual_redeem_prepaid_vouchers_preview(ManualRedeemPreviewIn(codes=[code]), **ctx(w))["vouchers"][0]
        assert prev["refusal"] is None and [o["code"] for o in prev["overridable"]] == [PV.EXPIRED]
        out = one_click(w, code, force=True)
        assert out["override"] == [PV.EXPIRED] and row(w, code).status == "used"
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert r.manual_override == [PV.EXPIRED]
        assert out["voucher"]["redemptions"][0]["manualOverride"] == [PV.EXPIRED]
        ev = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == PVM.EVENT_REDEEM).one()
        assert ev.details["override"] == [PV.EXPIRED] and ev.details["overrideText"] == ["תוקף השובר הסתיים"]

    def test_a_super_admin_forces_another_shop_and_not_yet_valid(self, w):
        b = goods(w, shopIds=[w.shop.id])
        code = codes(w, b)[0]
        set_batch(w, b["id"], valid_from=datetime.now(timezone.utc) + timedelta(days=2))
        out = one_click(w, code, shop=w.other_shop, force=True)
        assert sorted(out["override"]) == sorted([PV.NOT_YET_VALID, PV.WRONG_SHOP])

    def test_anyone_else_is_refused_even_with_force(self, w):
        b = goods(w, shopIds=[w.shop.id])
        code = codes(w, b)[0]
        set_batch(w, b["id"], valid_until=datetime.now(timezone.utc) - timedelta(days=2))
        m = manager(w, {"prepaid_voucher_redeem": "edit", "prepaid_vouchers": "view"})
        e = refused(one_click, w, code, user=m, force=True)
        assert code_of(e) == PV.EXPIRED and e.detail["overridable"] is False
        assert w.db.query(PrepaidVoucherRedemption).count() == 0

    def test_never_past_a_used_voucher_or_test_mode(self, w):
        b = goods(w, shopIds=[w.shop.id])
        used, tested = codes(w, b)[:2]
        one_click(w, used)
        assert code_of(refused(one_click, w, used, force=True)) == PV.USED
        R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(testMode=True), **_ctx(w))
        assert code_of(refused(one_click, w, tested, force=True)) == PVM.TEST_MODE


# ── Who may ───────────────────────────────────────────────────────────────────


class TestPermission:
    def test_the_section_is_in_the_catalogue_and_the_routes_need_it(self):
        assert "prepaid_voucher_redeem" in DS.SECTION_IDS
        for method, path in [("POST", "/prepaid-vouchers/manual-redeem"), ("POST", "/prepaid-vouchers/manual-redeem/bulk"),
                             ("POST", "/prepaid-vouchers/manual-redeem/preview"),
                             ("POST", "/prepaid-vouchers/redemptions/{redemption_id}/reverse")]:
            rule = DS.rule_for(method, path)
            assert rule.sections == ("prepaid_voucher_redeem", "prepaid_vouchers") and rule.needed_level(method) == DS.EDIT
            granted = DA.EffectiveAccess(restricted=True, sections={"prepaid_voucher_redeem": "edit"}, has_profile=True)
            view_only = DA.EffectiveAccess(restricted=True, sections={"prepaid_vouchers": "view"}, has_profile=True)
            assert DA.check_rule(granted, rule, method) is None
            assert DA.check_rule(view_only, rule, method).status_code == 403
            assert DA.check_rule(DA.UNRESTRICTED, rule, method) is None

    def test_granted_the_section_redeems(self, w):
        code = codes(w, goods(w))[0]
        m = manager(w, {"prepaid_voucher_redeem": "edit", "prepaid_vouchers": "view"})
        redeem(w, code, full=True, user=m)
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert r.manual_by_user_name == "מנהלת" and r.manual_by_user_id == m.id

    def test_edit_on_the_vouchers_is_enough(self, w):
        code = codes(w, goods(w))[0]
        m = manager(w, {"prepaid_vouchers": "edit"})
        redeem(w, code, full=True, user=m)

    def test_denied_without_it(self, w):
        code = codes(w, goods(w))[0]
        m = manager(w, {"prepaid_vouchers": "view"})
        e = refused(redeem, w, code, full=True, user=m)
        assert e.status_code == 403 and code_of(e) == PVM.FORBIDDEN
        assert refused(bulk, w, codes=[code], user=m).status_code == 403
        assert w.db.query(PrepaidVoucherRedemption).count() == 0

    def test_another_company_manager_is_refused(self, w):
        from app.models.company import Company

        code = codes(w, goods(w))[0]
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="999999999")
        w.db.add(other)
        w.db.flush()
        m = manager(w, {"prepaid_vouchers": "edit"}, org_wide=False)
        m.company_id = other.id
        w.db.commit()
        assert refused(redeem, w, code, full=True, user=m).status_code == 403


# ── Counted like a till's ─────────────────────────────────────────────────────


class TestCounted:
    def test_in_the_board_and_the_batch_report(self, w):
        b = goods(w, count=2)
        code = codes(w, b)[0]
        redeem(w, code, items=[{"productId": str(w.hotdog.id), "quantity": 2}])
        report = R.prepaid_voucher_batch_report(b["id"], tz=None, **_ctx(w))
        assert report["usage"]["used"] == 2 and report["usage"]["remaining"] == 4
        assert [(x["name"], x["redemptions"]) for x in report["byShop"]] == [("Center", 1)]
        today = datetime.now(ZoneInfo("Asia/Jerusalem")).date()
        out = reports_router.get_voucher_board_report(
            from_date=today, to_date=today, cmp_from=None, cmp_to=None, tz="Asia/Jerusalem", company_id=None,
            shop_id=None, area_id=None, machine_id=None, event_id=None, cmp_event_id=None, **_ctx(w),
        )
        assert (out.totals.vouchers, out.totals.redemptions) == (1, 1)
        assert out.rows[0].current.units == 2.0


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def test_the_single_head_on_test_mode(self):
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        # The release of 13.10.2026 joins this head with its sibling PRs' in one merge revision
        # (78c88a7afc4f); this migration stays on test mode, on that single head's line.
        assert script.get_heads() == ["78c88a7afc4f"]
        assert "d1a5c3e7f902" in script.get_revision("78c88a7afc4f").down_revision
        assert script.get_revision("d1a5c3e7f902").down_revision == "c7e4a2f9d1b6"

    def test_offline_sql_adds_the_columns_and_the_partial_index(self):
        import importlib.util
        import io
        from pathlib import Path

        from alembic.migration import MigrationContext
        from alembic.operations import Operations

        path = Path(__file__).absolute().parents[1] / "alembic" / "versions" / "d1a5c3e7f902_prepaid_voucher_manual_redeem.py"
        spec = importlib.util.spec_from_file_location("m_manual", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert sql.count("ALTER TABLE prepaid_voucher_redemptions ADD COLUMN") == 8
        assert "CREATE UNIQUE INDEX ux_prepaid_voucher_redemptions_manual_request" in sql and "WHERE source = 'dashboard'" in sql
