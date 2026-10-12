"""
Production vouchers — the shared rules (app/services/production_voucher_rules.py), pinned by the
golden fixture tests/fixtures/prepaid_voucher_rules.json: sections `eligibility`, `assignment`,
`selection`, `entitlementLeft`, `entitlementLeftMany`, `splitValue`, `fixedShare`, `cover`, `override` (the till runs the same cases from
its copy; the file's SHA-256 is pinned in tests/test_prepaid_voucher_kinds.py and in pos-android).

The inputs live here; `UPDATE_PREPAID_VOUCHER_RULES=1` writes their answers into the fixture (the
older sections are kept as they are). Besides the fixture, a few answers are checked by hand, so
the fixture never just agrees with itself.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.services import production_voucher_rules as P

FIXTURE = Path(__file__).parent / "fixtures" / "prepaid_voucher_rules.json"

CATEGORIES = [
    ["drinks", None], ["soft", "drinks"], ["beer", "drinks"], ["food", None], ["burgers", "food"], ["sides", "food"],
]
PRODUCTS = [
    ["cola", "soft"], ["water", "soft"], ["sprite", "soft"], ["lager", "beer"], ["ipa", "beer"],
    ["burger", "burgers"], ["schnitzel", "burgers"], ["fries", "sides"], ["rings", "sides"], ["cake", None],
]
CATALOG = {"categories": CATEGORIES, "products": PRODUCTS}
CATALOG_LATER = {
    "categories": CATEGORIES,
    # A new soft drink; sprite moved to the sides; rings gone.
    "products": [p for p in PRODUCTS if p[0] not in ("sprite", "rings")] + [["sprite", "sides"], ["zero", "soft"]],
}


def sel(**kw):
    base = {"allItems": False, "productIds": [], "categoryIds": [], "includeSubcategories": True,
            "excludeProductIds": [], "excludeCategoryIds": []}
    base.update(kw)
    return base


ELIGIBILITY = [
    {"name": "a category with its sub-categories", "mode": "live", "selection": sel(categoryIds=["drinks"]), "catalogNow": CATALOG},
    {"name": "without sub-categories a parent takes only its own products", "mode": "live",
     "selection": sel(categoryIds=["drinks"], includeSubcategories=False), "catalogNow": CATALOG},
    {"name": "categories and products together, each product once", "mode": "live",
     "selection": sel(categoryIds=["soft"], productIds=["water", "burger"]), "catalogNow": CATALOG},
    {"name": "an exclusion wins over a product chosen by name", "mode": "live",
     "selection": sel(categoryIds=["soft"], productIds=["cola"], excludeProductIds=["cola"]), "catalogNow": CATALOG},
    {"name": "an excluded category takes its sub-categories", "mode": "live",
     "selection": sel(allItems=True, excludeCategoryIds=["drinks"]), "catalogNow": CATALOG},
    {"name": "everything but one", "mode": "live", "selection": sel(allItems=True, excludeProductIds=["cake"]), "catalogNow": CATALOG},
    {"name": "a product the catalog does not have is not taken", "mode": "live",
     "selection": sel(productIds=["nope", "fries"]), "catalogNow": CATALOG},
    {"name": "frozen at issue: a new product does not join, a moved one stays, a deleted one goes", "mode": "frozen",
     "selection": sel(categoryIds=["soft"], productIds=["rings"]), "catalogAtIssue": CATALOG, "catalogNow": CATALOG_LATER},
    {"name": "updating: the categories as they are now", "mode": "live",
     "selection": sel(categoryIds=["soft"], productIds=["rings"]), "catalogAtIssue": CATALOG, "catalogNow": CATALOG_LATER},
]

# "פריט אחד מכל קבוצה" — the example of P:/specs/voucher-one-per-group.md §9: food = hot dog and burger;
# drinks = the "משקאות" department (cola, water, beer) with its sub-department "מיצים" (juice), less the beer.
# The case names carry the scenario's number.
PER_GROUP_CATALOG = {
    "categories": [["drinks", None], ["juices", "drinks"], ["food", None]],
    "products": [["cola", "drinks"], ["water", "drinks"], ["beer", "drinks"], ["juice", "juices"],
                 ["hotdog", "food"], ["burger", "food"]],
}
ELIGIBILITY += [
    {"name": "one per group 9.7: the drinks department with its sub-department, less the beer (9.8)", "mode": "live",
     "selection": sel(categoryIds=["drinks"], excludeProductIds=["beer"]), "catalogNow": PER_GROUP_CATALOG},
    {"name": "one per group 9.7: without its sub-departments the juice is not in it", "mode": "live",
     "selection": sel(categoryIds=["drinks"], includeSubcategories=False, excludeProductIds=["beer"]),
     "catalogNow": PER_GROUP_CATALOG},
    {"name": "one per group 9.8: without the exclusion the beer is in it", "mode": "live",
     "selection": sel(categoryIds=["drinks"]), "catalogNow": PER_GROUP_CATALOG},
]

MEAL = [
    {"key": "main", "productIds": ["burger", "schnitzel"], "remaining": 1},
    {"key": "side", "productIds": ["fries", "rings"], "remaining": 1},
    {"key": "drink", "productIds": ["cola", "water", "sprite"], "remaining": 1},
]
ASSIGNMENT = [
    {"name": "one of each: every match is clear", "groups": MEAL, "totalRemaining": 3,
     "units": [["u1", "burger"], ["u2", "fries"], ["u3", "cola"]]},
    {"name": "three drinks: one is the drink, two have no room", "groups": MEAL, "totalRemaining": 3,
     "units": [["u1", "cola"], ["u2", "water"], ["u3", "sprite"]]},
    {"name": "a line of three is three units", "groups": MEAL, "totalRemaining": 3,
     "units": [["u1", "burger"], ["u2", "burger"], ["u3", "burger"]]},
    {"name": "not on the voucher", "groups": MEAL, "totalRemaining": 3, "units": [["u1", "cake"]]},
    {"name": "a product two groups take is the cashier's choice", "totalRemaining": 3,
     "groups": [{"key": "a", "productIds": ["cola", "water"], "remaining": 1}, {"key": "b", "productIds": ["water", "cake"], "remaining": 1}],
     "units": [["u1", "water"], ["u2", "cola"], ["u3", "cake"]]},
    {"name": "one of several: the first takes the voucher", "totalRemaining": 1,
     "groups": [{"key": "drink", "productIds": ["cola", "water"], "remaining": 1}, {"key": "dessert", "productIds": ["cake"], "remaining": 1}],
     "units": [["u1", "cola"], ["u2", "cake"]]},
]

# The §9 example's groups, the drinks expanded as above (cola, water, juice; no beer).
PER_GROUP = [
    {"key": "food", "productIds": ["hotdog", "burger"], "remaining": 1},
    {"key": "drink", "productIds": ["cola", "water", "juice"], "remaining": 1},
]
ASSIGNMENT += [
    {"name": "one per group 9.1: two hot dogs and a cola", "groups": PER_GROUP, "totalRemaining": 2,
     "units": [["u1", "hotdog"], ["u2", "hotdog"], ["u3", "cola"]]},
    {"name": "one per group 9.2: two colas", "groups": PER_GROUP, "totalRemaining": 2,
     "units": [["u1", "cola"], ["u2", "cola"]]},
    {"name": "one per group 9.7: a juice of the sub-department", "groups": PER_GROUP, "totalRemaining": 2,
     "units": [["u1", "juice"]]},
    {"name": "one per group 9.8: the beer is not on the voucher", "groups": PER_GROUP, "totalRemaining": 2,
     "units": [["u1", "beer"], ["u2", "hotdog"]]},
    {"name": "one per group 9.9: a product in both groups is the cashier's choice", "totalRemaining": 2,
     "groups": [{"key": "food", "productIds": ["hotdog", "burger", "water"], "remaining": 1},
                {"key": "drink", "productIds": ["cola", "water", "juice"], "remaining": 1}],
     "units": [["u1", "water"], ["u2", "hotdog"]]},
    {"name": "one per group 9.10: a third item after the total of 2", "groups": PER_GROUP, "totalRemaining": 2,
     "units": [["u1", "hotdog"], ["u2", "cola"], ["u3", "burger"]]},
]


def grp(key, name, min_qty, max_qty, remaining, ids, allow_repeat=True, excluded=()):
    return {"key": key, "name": name, "minQty": min_qty, "maxQty": max_qty, "remaining": remaining,
            "productIds": ids, "allowRepeat": allow_repeat, "excludedIds": list(excluded)}


MEAL_GROUPS = [
    grp("main", "מנה", 1, 1, 1, ["burger", "schnitzel"]),
    grp("side", "תוספת", 1, 1, 1, ["fries", "rings"]),
    grp("drink", "משקה", 1, 1, 1, ["cola", "water", "sprite"], excluded=["ipa"]),
]
CHOICE_GROUPS = [grp("drink", "משקה", 0, 1, 1, ["cola", "water"]), grp("dessert", "קינוח", 0, 1, 1, ["cake"])]
SELECTION = [
    {"name": "a whole meal", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True, "typeName": "שובר ארוחה",
     "chosen": [["burger", "main", 1], ["fries", "side", 1], ["cola", "drink", 1]]},
    {"name": "three drinks instead of a meal", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True,
     "typeName": "שובר ארוחה", "chosen": [["cola", "drink", 1], ["water", "drink", 1], ["sprite", "drink", 1]]},
    {"name": "a meal without its drink", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True,
     "typeName": "שובר ארוחה", "chosen": [["burger", "main", 1], ["fries", "side", 1]]},
    {"name": "part of a meal when the type allows parts", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": False,
     "typeName": "שובר ארוחה", "chosen": [["burger", "main", 1]]},
    {"name": "a side as the drink", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True,
     "typeName": "שובר ארוחה", "chosen": [["burger", "main", 1], ["fries", "side", 1], ["rings", "drink", 1]]},
    {"name": "an excluded product", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True,
     "typeName": "שובר ארוחה", "chosen": [["burger", "main", 1], ["fries", "side", 1], ["ipa", "drink", 1]]},
    {"name": "one of several: two chosen", "groups": CHOICE_GROUPS, "totalMax": 1, "totalRemaining": 1, "wholeAtOnce": False,
     "typeName": "שובר משקה או קינוח", "chosen": [["cola", "drink", 1], ["cake", "dessert", 1]]},
    {"name": "one of several: one chosen", "groups": CHOICE_GROUPS, "totalMax": 1, "totalRemaining": 1, "wholeAtOnce": True,
     "typeName": "שובר משקה או קינוח", "chosen": [["cake", "dessert", 1]]},
    {"name": "the same drink twice where it is not allowed", "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": False, "typeName": None,
     "groups": [grp("drinks", "שתייה", 0, 3, 3, ["cola", "water"], allow_repeat=False)], "chosen": [["cola", "drinks", 2]]},
    {"name": "two of a group with room for two", "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": False, "typeName": None,
     "groups": [grp("drinks", "שתייה", 0, 3, 2, ["cola", "water"])], "chosen": [["cola", "drinks", 3]]},
    {"name": "nothing chosen", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True, "typeName": None,
     "chosen": []},
    {"name": "a package without a type name", "groups": MEAL_GROUPS, "totalMax": 3, "totalRemaining": 3, "wholeAtOnce": True,
     "typeName": None, "chosen": [["burger", "main", 1]]},
]

PER_GROUP_DRINKS = ["cola", "water", "juice"]
PER_GROUP_GROUPS = [
    grp("food", "מזון", 0, 1, 1, ["hotdog", "burger"]),
    grp("drink", "שתייה", 0, 1, 1, PER_GROUP_DRINKS, excluded=["beer"]),
]
SELECTION += [
    {"name": "one per group 9.1: a hot dog and a cola", "groups": PER_GROUP_GROUPS, "totalMax": 2, "totalRemaining": 2,
     "wholeAtOnce": True, "typeName": "פריט אחד מכל קבוצה", "chosen": [["hotdog", "food", 1], ["cola", "drink", 1]]},
    {"name": "one per group 9.1: a second hot dog is the food group's over", "groups": PER_GROUP_GROUPS, "totalMax": 2,
     "totalRemaining": 2, "wholeAtOnce": True, "typeName": "פריט אחד מכל קבוצה",
     "chosen": [["hotdog", "food", 2], ["cola", "drink", 1]]},
    {"name": "one per group 9.2: only a drink, in one sale", "groups": PER_GROUP_GROUPS, "totalMax": 2, "totalRemaining": 2,
     "wholeAtOnce": True, "typeName": "פריט אחד מכל קבוצה", "chosen": [["cola", "drink", 1]]},
    {"name": "one per group 9.6: two drinks chosen by hand", "groups": PER_GROUP_GROUPS, "totalMax": 2, "totalRemaining": 2,
     "wholeAtOnce": True, "typeName": "פריט אחד מכל קבוצה", "chosen": [["cola", "drink", 1], ["water", "drink", 1]]},
    {"name": "one per group 9.8: the beer chosen as the drink", "groups": PER_GROUP_GROUPS, "totalMax": 2, "totalRemaining": 2,
     "wholeAtOnce": True, "typeName": "פריט אחד מכל קבוצה", "chosen": [["beer", "drink", 1]]},
    {"name": "one per group 9.1: a hot dog once the food is taken", "totalMax": 2, "totalRemaining": 1,
     "wholeAtOnce": False, "typeName": "פריט אחד מכל קבוצה", "chosen": [["hotdog", "food", 1]],
     "groups": [grp("food", "מזון", 0, 1, 0, ["hotdog", "burger"]), grp("drink", "שתייה", 0, 1, 1, PER_GROUP_DRINKS)]},
    {"name": "two groups: three of a group with two left", "totalMax": 4, "totalRemaining": 4, "wholeAtOnce": False,
     "typeName": None, "chosen": [["hotdog", "food", 3]],
     "groups": [grp("food", "מזון", 0, 3, 2, ["hotdog", "burger"]), grp("drink", "שתייה", 0, 1, 1, PER_GROUP_DRINKS)]},
]


def left(key, name, remaining):
    return {"key": key, "name": name, "remainingAfterThisSale": remaining}


# "הלקוח זכאי לעוד פריט" (the owner, 13.10.2026): what is left after this sale, and what the till,
# the kiosk and the closing say about it.
ENTITLEMENT_LEFT = [
    {"name": "9.2 and 9.4: only a drink, in one sale — the food is offered, and given up on closing",
     "groups": [left("food", "מזון", 1), left("drink", "שתייה", 0)], "totalRemainingAfterThisSale": 1, "splitAllowed": False},
    {"name": "9.5: only a drink, in parts — the food stays for next time",
     "groups": [left("food", "מזון", 1), left("drink", "שתייה", 0)], "totalRemainingAfterThisSale": 1, "splitAllowed": True},
    {"name": "two groups open within the total: each of them",
     "groups": [left("food", "מזון", 1), left("drink", "שתייה", 0), left("dessert", "קינוח", 1)],
     "totalRemainingAfterThisSale": 2, "splitAllowed": False},
    {"name": "two of a group and one of another: plural",
     "groups": [left("food", "מזון", 2), left("drink", "שתייה", 1)], "totalRemainingAfterThisSale": 3, "splitAllowed": True},
    {"name": "the open groups depend on the total: one more",
     "groups": [left("food", "מזון", 1), left("drink", "שתייה", 0), left("dessert", "קינוח", 1)],
     "totalRemainingAfterThisSale": 1, "splitAllowed": False},
    {"name": "the open groups depend on the total: two more, in parts",
     "groups": [left("food", "מזון", 2), left("drink", "שתייה", 1), left("dessert", "קינוח", 2)],
     "totalRemainingAfterThisSale": 2, "splitAllowed": True},
    {"name": "a single open group above the total: up to the total",
     "groups": [left("food", "מזון", 3), left("drink", "שתייה", 0)], "totalRemainingAfterThisSale": 2, "splitAllowed": False},
    {"name": "9.1: a hot dog and a cola — everything taken",
     "groups": [left("food", "מזון", 0), left("drink", "שתייה", 0)], "totalRemainingAfterThisSale": 0, "splitAllowed": False},
    {"name": "the total used up with groups still open",
     "groups": [left("drink", "משקה", 1), left("dessert", "קינוח", 1)], "totalRemainingAfterThisSale": 0, "splitAllowed": False},
    {"name": "no group open with the total left",
     "groups": [left("food", "מזון", 0), left("drink", "שתייה", 0)], "totalRemainingAfterThisSale": 1, "splitAllowed": True},
    {"name": "9.15: a punch card of 50 in parts — nothing to offer",
     "groups": [left("items", "פריטים", 44)], "totalRemainingAfterThisSale": 44, "splitAllowed": True},
    {"name": "one group in one sale: what would be given up",
     "groups": [left("items", "פריטים", 3)], "totalRemainingAfterThisSale": 3, "splitAllowed": False},
]


def three(food, drink, dessert, total, split=False):
    """A voucher of "פריט אחד מכל קבוצה" with three groups, as it stands after this sale."""
    return {"groups": [left("food", "מזון", food), left("drink", "שתייה", drink), left("dessert", "קינוח", dessert)],
            "totalRemainingAfterThisSale": total, "splitAllowed": split}


# Several vouchers in one sale (the spec's §6.6): each voucher's entitlement_left, in scan order, said once.
ENTITLEMENT_LEFT_MANY = [
    {"name": "6.6: 3 hot dogs, 2 colas and a dessert on two vouchers — only B is owed the dessert",
     "vouchers": [three(0, 0, 0, 0), three(0, 0, 1, 1)]},
    {"name": "6.6: both vouchers without their dessert — dessert ×2 from the vouchers",
     "vouchers": [three(0, 0, 1, 1), three(0, 0, 1, 1)]},
    {"name": "6.6: A is owed the dessert and B the drink",
     "vouchers": [three(0, 0, 1, 1), three(0, 1, 0, 1, split=True)]},
    {"name": "6.6: one each and one up to the total — up to",
     "vouchers": [three(1, 0, 0, 1), three(1, 0, 1, 1)]},
    {"name": "6.6: a punch card in parts and a voucher owed the food — only the food",
     "vouchers": [{"groups": [left("items", "פריטים", 44)], "totalRemainingAfterThisSale": 44, "splitAllowed": True},
                  three(1, 0, 0, 1, split=True)]},
    {"name": "6.6: both vouchers taken in full — nothing",
     "vouchers": [three(0, 0, 0, 0), three(0, 0, 0, 0)]},
]

SPLIT_VALUE = [
    {"name": "by list price, exactly", "totalAgorot": 8000, "units": [[5000, None], [1500, None], [1500, None]]},
    {"name": "by list price, rounded to the agora", "totalAgorot": 8000, "units": [[4590, None], [1290, None], [1190, None]]},
    {"name": "every component with its value", "totalAgorot": 8000, "units": [[4590, 5000], [1290, 1500], [1190, 1500]]},
    {"name": "one component fixed, the rest by price", "totalAgorot": 8000, "units": [[4590, 5000], [1290, None], [1190, None]]},
    {"name": "a ₪0 unit beside priced ones takes nothing", "totalAgorot": 1000, "units": [[0, None], [500, None]]},
    {"name": "all ₪0: equally", "totalAgorot": 1000, "units": [[0, None], [0, None], [0, None]]},
    {"name": "components above the value", "totalAgorot": 1000, "units": [[500, 800], [500, 800]]},
    {"name": "every unit fixed below the value: the rest by the fixed values", "totalAgorot": 1000, "units": [[0, 300], [0, 200]]},
    {"name": "ties go to the first", "totalAgorot": 100, "units": [[100, None], [100, None], [100, None]]},
    {"name": "nothing to split", "totalAgorot": 500, "units": []},
]
FIXED_SHARE = [
    {"name": "a third of a meal", "valueLeftAgorot": 8000, "unitsNow": 1, "unitsLeft": 3},
    {"name": "the last part takes the rest", "valueLeftAgorot": 8000, "unitsNow": 3, "unitsLeft": 3},
    {"name": "half up", "valueLeftAgorot": 1001, "unitsNow": 1, "unitsLeft": 2},
    {"name": "small", "valueLeftAgorot": 5, "unitsNow": 1, "unitsLeft": 3},
]
COVER = [
    {"name": "up to the value, the rest a top-up", "valueLeftAgorot": 8000, "unitsNetAgorot": [4590, 4590], "allowTopUp": True},
    {"name": "a top-up the type does not allow", "valueLeftAgorot": 8000, "unitsNetAgorot": [4590, 4590], "allowTopUp": False},
    {"name": "less than the value: nothing left for later", "valueLeftAgorot": 8000, "unitsNetAgorot": [3000, 2000], "allowTopUp": True},
    {"name": "no value: the goods whatever they cost", "valueLeftAgorot": None, "unitsNetAgorot": [3000, 2000], "allowTopUp": False},
    {"name": "covered by price, to the agora", "valueLeftAgorot": 999, "unitsNetAgorot": [500, 500, 500], "allowTopUp": True},
]


def unit(ref, product, cats, no_discount, list_price, value):
    return {"ref": ref, "productId": product, "categoryIds": cats, "noDiscount": no_discount,
            "listPriceAgorot": list_price, "valueAgorot": value}


def pol(mode, **kw):
    return {"mode": mode, "maxAmountAgorot": kw.get("max_amount"), "maxPercentBp": kw.get("max_percent"),
            "maxTotalAgorot": kw.get("max_total"), "scope": kw.get("scope")}


BURGER = ["burgers", "food"]
OVERRIDE = [
    {"name": "a product that takes discounts is no override", "policy": pol("honour"), "approved": False,
     "units": [unit("u1", "burger", BURGER, False, 4000, 3000)]},
    {"name": "honour: a product that takes no discounts is not lowered", "policy": pol("honour"), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "at its list price: nothing to override", "policy": pol("honour"), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 3000, 3000)]},
    {"name": "above its list price: nothing to override", "policy": pol("honour"), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 3000, 3500)]},
    {"name": "auto: forced", "policy": pol("auto"), "approved": False, "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "auto: over the per-unit amount", "policy": pol("auto", max_amount=500), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "auto: over the per-unit percent", "policy": pol("auto", max_percent=2000), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "auto: at the per-unit percent", "policy": pol("auto", max_percent=2500), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "auto: over the voucher's total", "policy": pol("auto", max_total=1500), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000), unit("u2", "schnitzel", BURGER, True, 4000, 3000)]},
    {"name": "auto: outside its scope", "policy": pol("auto", scope={"productIds": [], "categoryIds": ["beer"]}), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "auto: in its scope by a parent category", "policy": pol("auto", scope={"productIds": [], "categoryIds": ["food"]}),
     "approved": False, "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "manager: asked for", "policy": pol("manager"), "approved": False, "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "manager: approved", "policy": pol("manager"), "approved": True, "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "manager: a cap before the approval", "policy": pol("manager", max_amount=100), "approved": False,
     "units": [unit("u1", "burger", BURGER, True, 4000, 3000)]},
    {"name": "a free product", "policy": pol("honour"), "approved": False, "units": [unit("u1", "cake", [], True, 0, 0)]},
]


# ── Running a case ────────────────────────────────────────────────────────────


def _catalog(c):
    return P.Catalog(tuple((p, cat) for p, cat in c["products"]), tuple((k, parent) for k, parent in c.get("categories", [])))


def _selection(s):
    return P.Selection(
        all_items=s["allItems"], product_ids=tuple(s["productIds"]), category_ids=tuple(s["categoryIds"]),
        include_subcategories=s["includeSubcategories"], exclude_product_ids=tuple(s["excludeProductIds"]),
        exclude_category_ids=tuple(s["excludeCategoryIds"]),
    )


def _refusal(r):
    return None if r is None else {"code": r.code, "text": r.text, "groupKey": r.group_key}


def run_eligibility(c):
    s = _selection(c["selection"])
    frozen = P.eligible_products(s, _catalog(c["catalogAtIssue"])) if "catalogAtIssue" in c else []
    return {"productIds": P.eligible_now(c["mode"], frozen, s, _catalog(c["catalogNow"]))}


def run_assignment(c):
    groups = [P.GroupCap(g["key"], tuple(g["productIds"]), g["remaining"]) for g in c["groups"]]
    a = P.assign_units(groups, [tuple(u) for u in c["units"]], c["totalRemaining"])
    return {
        "assigned": a.assigned,
        "unassigned": [{"ref": r, "reason": why} for r, why in a.unassigned],
        "ambiguous": [{"ref": r, "groupKeys": list(keys)} for r, keys in a.ambiguous],
    }


def run_selection(c):
    groups = [
        P.Group(g["key"], g["name"], g["minQty"], g["maxQty"], g["remaining"], tuple(g["productIds"]),
                g["allowRepeat"], tuple(g["excludedIds"]))
        for g in c["groups"]
    ]
    r = P.check_selection(
        groups, [tuple(x) for x in c["chosen"]], total_max=c["totalMax"], total_remaining=c["totalRemaining"],
        whole_at_once=c["wholeAtOnce"], type_name=c["typeName"],
    )
    return {"refusal": _refusal(r)}


def _entitlement_of(v):
    groups = [P.GroupLeft(g["key"], g["name"], g["remainingAfterThisSale"]) for g in v["groups"]]
    return P.entitlement_left(groups, v["totalRemainingAfterThisSale"], v["splitAllowed"])


def _entitlement_out(e):
    if e is None:
        return {"entitlement": None}
    return {"entitlement": {
        "kind": e.kind,
        "count": e.count,
        "groups": [{"key": k, "name": name, "count": n} for k, name, n in e.groups],
        "tillText": e.till_text,
        "kioskText": e.kiosk_text,
        "closeConfirm": e.close_confirm,
        "closeNote": e.close_note,
    }}


def run_entitlement_left(c):
    return _entitlement_out(_entitlement_of(c))


def run_entitlement_left_many(c):
    return _entitlement_out(P.entitlement_left_many([_entitlement_of(v) for v in c["vouchers"]]))


def run_split_value(c):
    out = P.split_value(c["totalAgorot"], [tuple(u) for u in c["units"]])
    return {"valuesAgorot": out, "refusal": None if out is not None else P.VALUE_MISMATCH}


def run_fixed_share(c):
    return {"shareAgorot": P.fixed_share(c["valueLeftAgorot"], c["unitsNow"], c["unitsLeft"])}


def run_cover(c):
    r = P.cover(c["valueLeftAgorot"], c["unitsNetAgorot"], c["allowTopUp"])
    return {"coveredAgorot": r.covered, "topUpAgorot": r.top_up, "perUnitAgorot": list(r.per_unit),
            "note": r.note, "refusal": _refusal(r.refusal)}


def run_override(c):
    p = c["policy"]
    scope = p.get("scope")
    policy = P.OverridePolicy(
        mode=p["mode"], max_amount=p["maxAmountAgorot"], max_percent=p["maxPercentBp"], max_total=p["maxTotalAgorot"],
        scope_product_ids=None if scope is None else tuple(scope["productIds"]),
        scope_category_ids=None if scope is None else tuple(scope["categoryIds"]),
    )
    units = [P.PricedUnit(u["ref"], u["productId"], tuple(u["categoryIds"]), u["noDiscount"], u["listPriceAgorot"], u["valueAgorot"])
             for u in c["units"]]
    r = P.override_check(policy, units, c["approved"])
    return {
        "units": [{"ref": ref, "reductionAgorot": red, "forced": forced} for ref, red, forced in r.units],
        "needsApproval": r.needs_approval,
        "refusal": _refusal(r.refusal),
    }


SECTIONS = {
    "eligibility": (ELIGIBILITY, run_eligibility),
    "assignment": (ASSIGNMENT, run_assignment),
    "selection": (SELECTION, run_selection),
    "entitlementLeft": (ENTITLEMENT_LEFT, run_entitlement_left),
    "entitlementLeftMany": (ENTITLEMENT_LEFT_MANY, run_entitlement_left_many),
    "splitValue": (SPLIT_VALUE, run_split_value),
    "fixedShare": (FIXED_SHARE, run_fixed_share),
    "cover": (COVER, run_cover),
    "override": (OVERRIDE, run_override),
}


def _fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


if os.environ.get("UPDATE_PREPAID_VOUCHER_RULES"):
    data = _fixture()
    for section, (cases, run) in SECTIONS.items():
        data[section] = [{**c, "expect": run(c)} for c in cases]
    FIXTURE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.mark.parametrize(
    "section,case",
    [(s, c) for s in SECTIONS for c in _fixture().get(s, [])],
    ids=lambda v: v if isinstance(v, str) else v["name"],
)
def test_the_golden_case(section, case):
    run = SECTIONS[section][1]
    inputs = {k: v for k, v in case.items() if k != "expect"}
    assert run(inputs) == case["expect"]


def test_every_case_is_in_the_fixture():
    data = _fixture()
    for section, (cases, _) in SECTIONS.items():
        assert [c["name"] for c in data[section]] == [c["name"] for c in cases], section


# ── By hand: the answers that matter, independent of the fixture ─────────────


def test_eligibility_by_hand():
    s = P.Selection(category_ids=("soft",), product_ids=("water", "burger"))
    assert P.eligible_products(s, _catalog(CATALOG)) == ["cola", "water", "sprite", "burger"]
    s = P.Selection(all_items=True, exclude_category_ids=("drinks",))
    assert P.eligible_products(s, _catalog(CATALOG)) == ["burger", "schnitzel", "fries", "rings", "cake"]
    s = P.Selection(category_ids=("soft",), product_ids=("rings",))
    frozen = P.eligible_products(s, _catalog(CATALOG))
    assert P.eligible_now("frozen", frozen, s, _catalog(CATALOG_LATER)) == ["cola", "water", "sprite"]
    assert P.eligible_now("live", frozen, s, _catalog(CATALOG_LATER)) == ["cola", "water", "zero"]


def test_three_drinks_never_make_a_meal():
    groups = [P.Group(g["key"], g["name"], g["minQty"], g["maxQty"], g["remaining"], tuple(g["productIds"])) for g in MEAL_GROUPS]
    r = P.check_selection(groups, [("cola", "drink", 1), ("water", "drink", 1), ("sprite", "drink", 1)],
                          total_max=3, total_remaining=3, whole_at_once=True, type_name="שובר ארוחה")
    assert r.code == P.GROUP_OVER and r.text == 'מקבוצת "משקה" אפשר לממש עוד פריט אחד בשובר זה'
    r = P.check_selection(groups, [("burger", "main", 1), ("fries", "side", 1)],
                          total_max=3, total_remaining=3, whole_at_once=True, type_name="שובר ארוחה")
    assert r.text == "חסר משקה להשלמת שובר ארוחה"


def test_one_item_of_each_group_by_hand():
    def g(key, name, max_qty, remaining, ids):
        return P.Group(key, name, 0, max_qty, remaining, tuple(ids))

    food, drink = g("food", "מזון", 1, 1, ["hotdog"]), g("drink", "שתייה", 1, 1, ["cola", "water"])
    r = P.check_selection([food, drink], [("cola", "drink", 1), ("water", "drink", 1)],
                          total_max=2, total_remaining=2, whole_at_once=True)
    assert (r.code, r.text, r.group_key) == (P.GROUP_OVER, 'מקבוצת "שתייה" אפשר לממש עוד פריט אחד בשובר זה', "drink")
    r = P.check_selection([food, g("drink", "שתייה", 1, 0, ["cola"])], [("cola", "drink", 1)],
                          total_max=2, total_remaining=1, whole_at_once=False)
    assert r.text == 'מקבוצת "שתייה" כבר מומש כל מה שבשובר זה'
    r = P.check_selection([g("food", "מזון", 3, 2, ["hotdog"]), drink], [("hotdog", "food", 3)],
                          total_max=4, total_remaining=4, whole_at_once=False)
    assert r.text == 'מקבוצת "מזון" אפשר לממש עוד 2 פריטים בשובר זה'
    # One group keeps its words; a one-of-N voucher too.
    r = P.check_selection([g("drink", "שתייה", 1, 1, ["cola"])], [("cola", "drink", 2)],
                          total_max=2, total_remaining=2, whole_at_once=False)
    assert r.text == 'ניתן לבחור פריט אחד בלבד מ"שתייה"'
    r = P.check_selection([food, drink], [("cola", "drink", 2)], total_max=1, total_remaining=1, whole_at_once=False)
    assert r.text == "ניתן לבחור פריט אחד בלבד בשובר זה"
    assert P.check_selection([food, drink], [("cola", "drink", 1)], total_max=2, total_remaining=2, whole_at_once=True) is None


def test_the_entitlement_left_by_hand():
    L = P.GroupLeft
    e = P.entitlement_left([L("food", "מזון", 1), L("drink", "שתייה", 0)], 1, False)
    assert (e.kind, e.count, e.groups) == ("each", 1, (("food", "מזון", 1),))
    assert e.till_text == "הלקוח זכאי לעוד פריט מהשובר: מזון ×1 — הציעו לו"
    assert e.kiosk_text == "מגיע לך עוד פריט מהשובר: מזון ×1 — להוסיף?"
    assert (e.close_confirm, e.close_note) == ("סגירה עכשיו — מה שלא מומש מהשובר יאבד (מזון ×1)", None)
    e = P.entitlement_left([L("food", "מזון", 1), L("drink", "שתייה", 0)], 1, True)
    assert (e.close_confirm, e.close_note) == (None, "מה שלא מומש יישאר בשובר לפעם הבאה (מזון ×1)")
    e = P.entitlement_left([L("food", "מזון", 1), L("dessert", "קינוח", 1)], 2, False)
    assert e.till_text == "הלקוח זכאי לעוד 2 פריטים מהשובר: מזון ×1 · קינוח ×1 — הציעו לו"
    e = P.entitlement_left([L("food", "מזון", 1), L("dessert", "קינוח", 1)], 1, False)
    assert (e.kind, e.count) == ("upTo", 1)
    assert e.till_text == "הלקוח זכאי לעוד פריט מהשובר, מתוך: מזון / קינוח — הציעו לו"
    assert e.kiosk_text == "מגיע לך עוד פריט מהשובר, מתוך: מזון / קינוח — להוסיף?"
    assert e.close_confirm == "סגירה עכשיו — מה שלא מומש מהשובר יאבד (פריט אחד מתוך: מזון / קינוח)"
    e = P.entitlement_left([L("food", "מזון", 2), L("dessert", "קינוח", 2)], 3, True)
    assert e.till_text == "הלקוח זכאי לעוד 3 פריטים מהשובר, מתוך: מזון / קינוח — הציעו לו"
    assert e.close_note == "מה שלא מומש יישאר בשובר לפעם הבאה (3 פריטים מתוך: מזון / קינוח)"
    assert P.entitlement_left([L("food", "מזון", 1)], 0, False) is None
    assert P.entitlement_left([L("food", "מזון", 0), L("drink", "שתייה", 0)], 1, False) is None
    assert P.entitlement_left([L("items", "פריטים", 44)], 44, True) is None


def test_the_entitlement_of_several_vouchers_by_hand():
    L = P.GroupLeft

    def voucher(food, drink, dessert, split=False):
        return P.entitlement_left([L("f", "מזון", food), L("d", "שתייה", drink), L("k", "קינוח", dessert)],
                                  food + drink + dessert, split)

    only_b = P.entitlement_left_many([voucher(0, 0, 0), voucher(0, 0, 1)])
    assert only_b == voucher(0, 0, 1)  # one contributor: exactly its own, closing words included
    assert only_b.till_text == "הלקוח זכאי לעוד פריט מהשובר: קינוח ×1 — הציעו לו"
    both = P.entitlement_left_many([voucher(0, 0, 1), voucher(0, 0, 1)])
    assert (both.kind, both.count, both.groups) == ("each", 2, (("k", "קינוח", 2),))
    assert both.till_text == "הלקוח זכאי לעוד 2 פריטים מהשוברים: קינוח ×2 — הציעו לו"
    assert both.kiosk_text == "מגיע לך עוד 2 פריטים מהשוברים: קינוח ×2 — להוסיף?"
    assert (both.close_confirm, both.close_note) == (None, None)  # each voucher's own, composed by the till
    two = P.entitlement_left_many([voucher(0, 0, 1), voucher(0, 1, 0, split=True)])
    assert two.till_text == "הלקוח זכאי לעוד 2 פריטים מהשוברים: קינוח ×1 · שתייה ×1 — הציעו לו"
    up_to = P.entitlement_left([L("f", "מזון", 1), L("k", "קינוח", 1)], 1, False)
    mixed = P.entitlement_left_many([voucher(1, 0, 0), up_to])
    assert (mixed.kind, mixed.count) == ("upTo", 2)
    assert mixed.till_text == "הלקוח זכאי לעוד 2 פריטים מהשוברים, מתוך: מזון / קינוח — הציעו לו"
    assert P.entitlement_left_many([None, None]) is None and P.entitlement_left_many([]) is None


def test_a_fixed_value_sums_exactly():
    values = P.split_value(8000, [(4590, None), (1290, None), (1190, None)])
    assert sum(values) == 8000 and values == [5194, 1460, 1346]
    assert P.split_value(1000, [(0, None)] * 3) == [334, 333, 333]
    assert P.split_value(1000, [(500, 800), (500, 800)]) is None


def test_cover_and_top_up():
    r = P.cover(8000, [4590, 4590], True)
    assert (r.covered, r.top_up, r.note) == (8000, 1180, "נדרשת השלמה של ₪11.80")
    assert P.cover(8000, [4590, 4590], False).refusal.code == P.TOP_UP_NOT_ALLOWED
    assert P.cover(None, [3000, 2000], False).covered == 5000


def test_the_discount_block():
    u = P.PricedUnit("u1", "burger", ("burgers", "food"), True, 4000, 3000)
    assert P.override_check(P.OverridePolicy(), [u], False).refusal.code == P.DISCOUNT_BLOCKED
    assert P.override_check(P.OverridePolicy("auto"), [u], False).units == (("u1", 1000, True),)
    r = P.override_check(P.OverridePolicy("manager"), [u], False)
    assert r.needs_approval and r.refusal.code == P.APPROVAL_NEEDED
    assert P.override_check(P.OverridePolicy("manager"), [u], True).refusal is None
    assert P.override_check(P.OverridePolicy("auto", max_percent=2000), [u], False).refusal.code == P.OVERRIDE_CAP
