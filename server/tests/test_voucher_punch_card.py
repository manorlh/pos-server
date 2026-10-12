"""
"כרטיסייה — מכסת שימושים" (the owner, 12.10.2026): "הלקוח יקבל שובר עם שימושים של 50 פעמים לפריט
אחד. אם באותה עסקה היו לו 6 פריטים מאושרים — הניצול יהיה 6 פעמים בסריקה אחת."

No new rule: a goods voucher (`items`) of selection `groups` with ONE group ("פריטים") whose products /
categories are the approved items, minQty 1, maxQty N, `allowRepeat` on, `totalQty` N and "מימוש
בחלקים" on. Each unit handed over is one use. The till matches the basket's units to the group by the
shared rule (`assign_units`, golden-pinned with pos-android) up to what is left, and sends only those;
the cloud checks the same rules (`check_selection`), takes the units off at the confirm and the
lookup says "מכסה 50 | מומשו 6 | נותרו 44". P:\\specs\\voucher-punch-card.md describes it for the owner.
"""
from __future__ import annotations

import uuid

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherTypeCreate
from app.services import production_voucher_rules as PR
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_groups import issue, look
from test_production_voucher_reserve import code_of, confirm, refused, reserve, unit

N = 50


def punch_type(w, *, split=True, min_qty=1, allow_repeat=True, n=N, **extra):
    """The preset: one group "פריטים" of the food category (נקניקייה ₪25, כריך ₪40) — coffee is not approved."""
    body = {
        "companyId": w.company.id, "name": "כרטיסייה 50", "kind": "items", "selection": "groups", "totalQty": n,
        "splitAllowed": split, "pricing": "cover", "redemptionAccounting": "payment",
        "groups": [{"name": "פריטים", "minQty": min_qty, "maxQty": n, "allowRepeat": allow_repeat,
                    "categoryIds": [w.food.id]}],
        **extra,
    }
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w))


def card(w, **kw):
    return codes(w, issue(w, punch_type(w, **kw)["id"]))


def units(product, price, n, prefix):
    return [unit(product, price, f"{prefix}{i}") for i in range(n)]


def voucher(w, code) -> PrepaidVoucher:
    v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
    w.db.refresh(v)
    return v


def left(w, code) -> int:
    return int(voucher(w, code).remaining["total"])


def till_assign(w, code, basket):
    """What the till does before the reserve: the basket's units to the group, as the cloud's rule does it."""
    out = look(w, code)
    (g,) = out["groups"]
    return PR.assign_units([PR.GroupCap(g["key"], tuple(g["eligibleProductIds"]), g["remaining"])],
                           [(u["ref"], u["productId"]) for u in basket], out["totalRemaining"])


class TestOneScanTakesEveryApprovedUnit:
    def test_a_six_approved_units_one_redemption_of_six_44_left(self, w):
        code = card(w)[0]
        basket = units(w.hotdog, 2500, 3, "h") + units(w.sandwich, 4000, 3, "s")
        out = reserve(w, code, basket)
        assert (out["status"], len(out["units"]), out["coveredAgorot"], out["topUpAgorot"]) == ("held", 6, 19500, 0)
        assert {u["groupName"] for u in out["units"]} == {"פריטים"}
        confirm(w, out["reservationId"])
        assert w.db.query(PrepaidVoucherRedemption).count() == 1  # one scan, one redemption
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (len(r.units), r.covered_agorot) == (6, 19500)
        v = voucher(w, code)
        assert (v.status, left(w, code)) == ("partially_used", 44)
        assert {k: int(q) for k, q in v.remaining.items() if k != "total"} == {next(k for k in v.remaining if k != "total"): 44}

    def test_b_the_same_product_six_times_counts_six(self, w):
        code = card(w)[0]
        out = reserve(w, code, units(w.hotdog, 2500, 6, "h"))
        assert len(out["units"]) == 6
        confirm(w, out["reservationId"])
        assert left(w, code) == 44

    def test_b_one_line_of_six_counts_six(self, w):
        code = card(w)[0]
        line = unit(w.hotdog, 2500, "L1")
        line["quantity"] = 6
        out = reserve(w, code, [line])
        confirm(w, out["reservationId"])
        assert left(w, code) == 44

    def test_b_without_allow_repeat_the_same_product_twice_is_refused(self, w):
        code = card(w, allow_repeat=False)[0]
        e = refused(reserve, w, code, units(w.hotdog, 2500, 2, "h"))
        assert code_of(e) == PR.REPEAT and e.detail["message"] == "אי אפשר לבחור את אותו פריט פעמיים בפריטים"

    def test_c_a_mixed_basket_covers_only_the_approved_units(self, w):
        code = card(w)[0]
        basket = units(w.hotdog, 2500, 3, "h") + units(w.coffee, 1200, 2, "c") + units(w.sandwich, 4000, 1, "s")
        a = till_assign(w, code, basket)
        assert sorted(a.assigned) == ["h0", "h1", "h2", "s0"]
        assert sorted(a.unassigned) == [("c0", PR.UNIT_NOT_ELIGIBLE), ("c1", PR.UNIT_NOT_ELIGIBLE)]
        out = reserve(w, code, [u for u in basket if u["ref"] in a.assigned])
        assert (len(out["units"]), out["coveredAgorot"]) == (4, 11500)
        confirm(w, out["reservationId"])
        assert left(w, code) == 46
        # The cloud never covers an item that is not approved, whatever a till sends.
        code2 = card(w)[1]
        assert code_of(refused(reserve, w, code2, units(w.coffee, 1200, 1, "c"), sale="s2")) == PR.NOT_IN_GROUP

    def test_d_sixty_units_with_fifty_left_fifty_covered(self, w):
        code = card(w)[0]
        basket = units(w.hotdog, 2500, 60, "h")
        a = till_assign(w, code, basket)
        assert len(a.assigned) == 50 and len(a.unassigned) == 10
        assert {why for _, why in a.unassigned} == {PR.UNIT_TOTAL_FULL}
        # Sent as they are, all 60: refused with the remainder named — the till sends what fits.
        e = refused(reserve, w, code, basket)
        assert code_of(e) == PR.TOTAL_OVER and e.detail["message"] == "ניתן לבחור עד 50 פריטים בשובר זה"
        out = reserve(w, code, [u for u in basket if u["ref"] in a.assigned])
        assert (len(out["units"]), out["coveredAgorot"]) == (50, 125000)
        confirm(w, out["reservationId"])
        assert (voucher(w, code).status, left(w, code)) == ("used", 0)

    def test_d_with_44_left_a_basket_of_50_takes_44(self, w):
        code = card(w)[0]
        confirm(w, reserve(w, code, units(w.hotdog, 2500, 6, "a"))["reservationId"])
        basket = units(w.sandwich, 4000, 50, "b")
        a = till_assign(w, code, basket)
        assert len(a.assigned) == 44
        out = reserve(w, code, [u for u in basket if u["ref"] in a.assigned], sale="s2")
        confirm(w, out["reservationId"], tx="tx-2")
        assert (voucher(w, code).status, left(w, code)) == ("used", 0)

    def test_e_the_next_sale_continues_from_44(self, w):
        code = card(w)[0]
        confirm(w, reserve(w, code, units(w.hotdog, 2500, 6, "a"))["reservationId"])
        out = reserve(w, code, units(w.sandwich, 4000, 10, "b"), sale="s2")
        confirm(w, out["reservationId"], tx="tx-2")
        assert left(w, code) == 34
        assert w.db.query(PrepaidVoucherRedemption).count() == 2
        got = look(w, code)
        assert (got["quota"], got["used"], got["remaining"]) == (50, 16, 34)

    def test_a_partial_line_eight_on_the_line_five_left(self, w):
        code = card(w, n=5)[0]
        line = units(w.hotdog, 2500, 8, "L1#")
        a = till_assign(w, code, line)
        assert len(a.assigned) == 5  # 5 of the line on the voucher, 3 paid at the till
        out = reserve(w, code, [u for u in line if u["ref"] in a.assigned])
        confirm(w, out["reservationId"])
        assert (voucher(w, code).status, left(w, code)) == ("used", 0)

    def test_two_such_vouchers_in_one_sale(self, w):
        first, second = card(w)
        basket = units(w.hotdog, 2500, 60, "h")
        a = till_assign(w, first, basket)
        ra = reserve(w, first, [u for u in basket if u["ref"] in a.assigned], sale="s9")
        rest = [u for u in basket if u["ref"] not in a.assigned]
        rb = reserve(w, second, rest, sale="s9")
        assert (len(ra["units"]), len(rb["units"])) == (50, 10)
        confirm(w, ra["reservationId"], tx="tx-9")
        confirm(w, rb["reservationId"], tx="tx-9")
        assert (left(w, first), left(w, second)) == (0, 40)

    def test_a_fixed_value_shares_the_value_by_units(self, w):
        """₪1,500 for 50 uses (₪30 a use), fixed: 6 units are 6/50 of what is left — ₪180."""
        t = punch_type(w, pricing="fixed", tillValue=1500, redemptionAccounting="discount")
        code = codes(w, issue(w, t["id"]))[0]
        out = reserve(w, code, units(w.hotdog, 2500, 6, "h"))
        assert sum(u["valueAgorot"] for u in out["units"]) == 18000
        confirm(w, out["reservationId"])
        assert left(w, code) == 44


class TestSplitOff:
    """f: "מימוש בעסקה אחת" on a group voucher = every group's minimum in each redemption — no forfeit."""

    def test_f_min_one_six_of_fifty_taken_and_the_rest_stays(self, w):
        code = card(w, split=False)[0]
        assert look(w, code)["wholeAtOnce"] is True
        out = reserve(w, code, units(w.hotdog, 2500, 6, "h"))
        confirm(w, out["reservationId"])
        assert (voucher(w, code).status, left(w, code)) == ("partially_used", 44)
        out = reserve(w, code, units(w.hotdog, 2500, 4, "x"), sale="s2")  # nothing was given up
        confirm(w, out["reservationId"], tx="tx-2")
        assert left(w, code) == 40

    def test_f_min_equal_max_means_all_fifty_in_one_sale(self, w):
        code = card(w, split=False, min_qty=N)[0]
        e = refused(reserve, w, code, units(w.hotdog, 2500, 6, "h"))
        assert code_of(e) == PR.PACKAGE_INCOMPLETE and e.detail["message"] == "חסר פריטים להשלמת כרטיסייה 50"
        out = reserve(w, code, units(w.hotdog, 2500, N, "h"))
        confirm(w, out["reservationId"])
        assert (voucher(w, code).status, left(w, code)) == ("used", 0)


class TestLookup:
    def test_g_quota_50_used_6_remaining_44(self, w):
        code = card(w)[0]
        before = look(w, code)
        assert (before["quotaUnit"], before["quota"], before["used"], before["remaining"]) == ("units", 50, 0, 50)
        assert (before["splitAllowed"], before["wholeAtOnce"], before["selection"]) == (True, False, "groups")
        confirm(w, reserve(w, code, units(w.hotdog, 2500, 6, "h"))["reservationId"])
        out = look(w, code)
        assert (out["quota"], out["used"], out["remaining"]) == (50, 6, 44)
        assert (out["totalMax"], out["totalRemaining"], out["status"]) == (50, 44, "partially_used")
        (g,) = out["groups"]
        assert (g["name"], g["quota"], g["used"], g["remaining"], g["allowRepeat"]) == ("פריטים", 50, 6, 44, True)
        assert set(g["eligibleProductIds"]) == {str(w.hotdog.id), str(w.sandwich.id)}
        assert len(out["redemptions"]) == 1

    def test_the_type_reads_back_as_the_preset_wrote_it(self, w):
        t = punch_type(w)
        assert (t["kind"], t["selection"], t["totalQty"], t["splitAllowed"]) == ("items", "groups", 50, True)
        (g,) = t["groups"]
        assert (g["name"], g["minQty"], g["maxQty"], g["allowRepeat"]) == ("פריטים", 1, 50, True)
        assert uuid.UUID(g["categoryIds"][0]) == w.food.id
        # The dashboard's chips and "סיכום השובר" read the names (read only, never on a till).
        assert t["groupNames"] == {"products": {}, "categories": {str(w.food.id): "אוכל"}}
        b = issue(w, t["id"])
        assert b["groupNames"]["categories"] == {str(w.food.id): "אוכל"}

    def test_the_dashboard_lists_say_how_many_of_how_many(self, w):
        b = issue(w, punch_type(w)["id"])
        code = codes(w, b)[0]
        confirm(w, reserve(w, code, units(w.hotdog, 2500, 6, "h"))["reservationId"])
        rows = R.list_prepaid_vouchers(b["id"], status_filter=None, serial=None, limit=10, offset=0, **_ctx(w))["items"]
        first = next(r for r in rows if r["code"] == code)
        assert (first["quotaUnit"], first["quota"], first["used"], first["remaining"]) == ("units", 50, 6, 44)
        other = next(r for r in rows if r["code"] != code)
        assert (other["quota"], other["used"], other["remaining"]) == (50, 0, 50)

    def test_the_batch_report_counts_the_quota_in_items(self, w):
        """"ניצול המכסה": 2 vouchers × 50 = 100 items; 6 taken, 94 left; a cancelled voucher's rest is void."""
        from app.services.prepaid_voucher_reports import batch_report

        b = issue(w, punch_type(w)["id"])
        first, second = codes(w, b)
        confirm(w, reserve(w, first, units(w.hotdog, 2500, 6, "h"))["reservationId"])
        usage = batch_report(w.db, w.admin, w.tenant.id, b["id"])["usage"]
        assert (usage["unit"], usage["issued"], usage["used"], usage["remaining"], usage["void"]) == ("units", 100, 6, 94, 0)
        from app.services import prepaid_vouchers as PV

        PV.cancel_voucher(w.db, w.admin, w.tenant.id, voucher(w, second).id, "אבד")
        w.db.commit()
        usage = batch_report(w.db, w.admin, w.tenant.id, b["id"])["usage"]
        assert (usage["used"], usage["remaining"], usage["void"]) == (6, 44, 50)

    def test_a_list_voucher_has_no_group_names(self, w):
        from test_production_voucher_reserve import goods_type

        assert goods_type(w, tillValue=60)["groupNames"] is None
