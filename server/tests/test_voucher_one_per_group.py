"""
"פריט אחד מכל קבוצה" (the owner, 13.10.2026, P:/specs/voucher-one-per-group.md): "שובר עם עד 2 פריטים,
אבל מקבוצה 1 (מזון) עד 1, ומקבוצה 2 (שתייה …) עד 1". No new contract: a goods voucher of selection
`groups` — מזון (products) and שתייה (a whole department), each 0–1, a total of 2.

What this pins on the cloud:

* the reserve under the shared rules: one of each is held, only a drink is held (no group is a
  must), two drinks chosen by hand are refused with the group and what is left of it;
* the lookup gives the till what the "מה מגיע ללקוח" card needs per group (its departments with
  their names, quota / used / remaining) and the voucher's `splitAllowed`;
* after a drink, the lookup's numbers make the till's "הלקוח זכאי לעוד פריט" (the shared rule);
* POST /prepaid-vouchers/groups/check — the dashboard's warnings: a product in two groups (a
  department expanded, exclusions applied) and a department with no active products. Read only.
"""
from __future__ import annotations

import uuid

from app.models.category import Category
from app.models.prepaid_voucher import PrepaidVoucherType
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidGroupsCheckIn, PrepaidVoucherTypeCreate
from app.services import dashboard_sections as DS
from app.services import production_voucher_rules as PR
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_groups import look
from test_production_voucher_reserve import code_of, confirm, issue, refused, reserve, unit


def per_group_type(w, *, split=False):
    """The preset: מזון = נקניקייה and כריך, שתייה = the "שתייה חמה" department (קפה, in its sub-department)."""
    body = {
        "companyId": w.company.id, "name": "פריט אחד מכל קבוצה", "kind": "items", "selection": "groups", "totalQty": 2,
        "splitAllowed": split, "pricing": "cover", "redemptionAccounting": "payment",
        "groups": [
            {"name": "מזון", "minQty": 0, "maxQty": 1, "productIds": [w.hotdog.id, w.sandwich.id]},
            {"name": "שתייה", "minQty": 0, "maxQty": 1, "categoryIds": [w.drinks.id]},
        ],
    }
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w))


def voucher_code(w, **kw):
    return codes(w, issue(w, per_group_type(w, **kw)["id"]))[0]


def keys(w, code):
    return {g["name"]: g["key"] for g in look(w, code)["groups"]}


class TestTheVoucherAtTheTill:
    def test_a_hot_dog_and_a_coffee_are_both_held(self, w):
        code = voucher_code(w)
        out = reserve(w, code, [unit(w.hotdog, 2500, "a"), unit(w.coffee, 1200, "b")])
        assert out["status"] == "held"
        assert sorted(u["groupName"] for u in out["units"]) == ["מזון", "שתייה"]

    def test_only_a_drink_is_held_no_group_is_a_must(self, w):
        code = voucher_code(w)
        out = reserve(w, code, [unit(w.coffee, 1200, "b")])
        assert out["status"] == "held" and [u["groupName"] for u in out["units"]] == ["שתייה"]

    def test_two_drinks_chosen_by_hand_are_refused_with_the_group_and_its_limit(self, w):
        code = voucher_code(w)
        drink = keys(w, code)["שתייה"]
        e = refused(reserve, w, code, [unit(w.coffee, 1200, "b1", group=drink), unit(w.coffee, 1200, "b2", group=drink)])
        assert code_of(e) == PR.GROUP_OVER
        assert e.detail["message"] == 'מקבוצת "שתייה" אפשר לממש עוד פריט אחד בשובר זה'
        assert e.detail["groupKey"] == drink

    def test_a_drink_after_the_drink_was_redeemed_in_parts(self, w):
        code = voucher_code(w, split=True)
        confirm(w, reserve(w, code, [unit(w.coffee, 1200, "b")])["reservationId"])
        drink = keys(w, code)["שתייה"]
        e = refused(reserve, w, code, [unit(w.coffee, 1200, "c", group=drink)], sale="s2")
        assert e.detail["message"] == 'מקבוצת "שתייה" כבר מומש כל מה שבשובר זה'


class TestTheLookupForTheCashiersCard:
    def test_each_group_with_its_departments_and_numbers(self, w):
        code = voucher_code(w)
        out = look(w, code)
        assert out["splitAllowed"] is False and (out["totalMax"], out["totalRemaining"]) == (2, 2)
        food, drink = out["groups"]
        assert (food["name"], food["quota"], food["used"], food["remaining"]) == ("מזון", 1, 0, 1)
        assert (food["allItems"], food["categoryIds"], food["categories"]) == (False, [], [])
        assert drink["categoryIds"] == [str(w.drinks.id)]
        assert drink["categories"] == [{"id": str(w.drinks.id), "name": "שתייה חמה"}]
        assert drink["includeSubcategories"] is True and drink["allItems"] is False
        assert str(w.coffee.id) in drink["eligibleProductIds"]

    def test_after_a_drink_the_customer_is_entitled_to_the_food(self, w):
        code = voucher_code(w, split=True)
        confirm(w, reserve(w, code, [unit(w.coffee, 1200, "b")])["reservationId"])
        out = look(w, code)
        assert out["splitAllowed"] is True
        groups = [PR.GroupLeft(g["key"], g["name"], g["remaining"]) for g in out["groups"]]
        e = PR.entitlement_left(groups, out["totalRemaining"], out["splitAllowed"])
        assert e.till_text == "הלקוח זכאי לעוד פריט מהשובר: מזון ×1 — הציעו לו"
        assert (e.close_confirm, e.close_note) == (None, "מה שלא מומש יישאר בשובר לפעם הבאה (מזון ×1)")
        food, drink = out["groups"]
        assert (drink["quota"], drink["used"], drink["remaining"]) == (1, 1, 0)


# ── The dashboard's check: overlaps and empty departments ─────────────────────


def check(w, groups, **extra):
    body = PrepaidGroupsCheckIn(companyId=w.company.id, groups=groups, **extra)
    return R.check_prepaid_voucher_groups(body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def food(w, **kw):
    return {"name": "מזון", "minQty": 0, "maxQty": 1, "productIds": [w.hotdog.id, w.coffee.id], **kw}


def drinks(w, **kw):
    return {"name": "שתייה", "minQty": 0, "maxQty": 1, "categoryIds": [w.drinks.id], **kw}


class TestTheGroupsCheck:
    def test_a_product_in_both_groups_through_a_sub_department(self, w):
        out = check(w, [food(w), drinks(w)])
        assert out["overlaps"] == [
            {"productId": str(w.coffee.id), "name": "קפה", "groups": ["מזון", "שתייה"], "groupIndexes": [0, 1]}
        ]
        assert (out["overlapCount"], out["emptyGroups"]) == (1, [])

    def test_no_overlap_once_excluded_and_the_department_is_then_empty(self, w):
        out = check(w, [food(w), drinks(w, excludeProductIds=[w.coffee.id])])
        assert out["overlaps"] == [] and out["overlapCount"] == 0
        assert out["emptyGroups"] == [{
            "group": "שתייה", "groupIndex": 1, "reason": "empty_department",
            "categoryId": str(w.drinks.id), "categoryName": "שתייה חמה",
        }]

    def test_without_sub_departments_the_sub_departments_product_is_not_in_it(self, w):
        out = check(w, [food(w), drinks(w, includeSubcategories=False)])
        assert out["overlaps"] == []
        assert [(e["reason"], e["categoryName"]) for e in out["emptyGroups"]] == [("empty_department", "שתייה חמה")]

    def test_a_department_with_no_products_and_a_group_with_none_active(self, w):
        cold = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="משקאות")
        w.db.add(cold)
        w.hotdog.is_available = False
        w.db.commit()
        out = check(w, [
            {"name": "מזון", "minQty": 0, "maxQty": 1, "productIds": [w.hotdog.id]},
            {"name": "שתייה", "minQty": 0, "maxQty": 1, "categoryIds": [cold.id, w.drinks.id]},
        ])
        assert out["emptyGroups"] == [
            {"group": "מזון", "groupIndex": 0, "reason": "empty_group"},
            {"group": "שתייה", "groupIndex": 1, "reason": "empty_department", "categoryId": str(cold.id),
             "categoryName": "משקאות"},
        ]

    def test_everything_twice_overlaps_on_the_whole_catalog(self, w):
        out = check(w, [{"name": "א", "allItems": True}, {"name": "ב", "allItems": True}])
        assert out["overlapCount"] == 3 and {o["name"] for o in out["overlaps"]} == {"קפה", "כריך", "נקניקייה"}
        assert out["emptyGroups"] == []

    def test_read_only_and_never_a_refusal(self, w):
        before = w.db.query(PrepaidVoucherType).count()
        check(w, [food(w), drinks(w)])
        assert not w.db.new and not w.db.dirty
        assert w.db.query(PrepaidVoucherType).count() == before

    def test_another_tenants_company_is_not_found(self, w):
        body = PrepaidGroupsCheckIn(companyId=uuid.uuid4(), groups=[food(w)])
        e = refused(R.check_prepaid_voucher_groups, body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 404

    def test_the_dashboard_section_is_the_vouchers_view(self):
        rule = DS.rule_for("POST", "/prepaid-vouchers/groups/check")
        assert (rule.kind, rule.sections, rule.needed_level("POST")) == ("section", ("prepaid_vouchers",), "view")
