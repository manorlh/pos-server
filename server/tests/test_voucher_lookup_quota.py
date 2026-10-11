"""
The lookup a voucher-first till reads (the owner's spec of 11.10.2026 §3, §5): per group the eligible
products (`eligibleProductIds` — the same list, by the same rule, the reserve redeems: frozen or live
by `catalogMode`, the till's own ids included) and the group's `quota` / `used`; for the voucher
`quota` / `used` / `remaining` — "מכסה 5 | מומשו 2 | נותרו 3".
"""
from __future__ import annotations

import uuid

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.models.product import CatalogLevel, Product
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherTypeCreate
from test_prepaid_voucher_kinds import _ctx, codes, lookup, make, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_groups import issue, look, meal_type


def _quota_type(w, **extra):
    """Five units from everything to eat — "a choice of several products, a quota of five"."""
    body = {
        "companyId": w.company.id, "name": "שובר צוות הפקה", "selection": "groups", "tillValue": 100, "totalQty": 5,
        "groups": [{"name": "אוכל", "minQty": 1, "maxQty": 5, "categoryIds": [w.food.id], "allowRepeat": True}],
        **extra,
    }
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w))


def _take(w, code, units):
    """[units] taken off the voucher earlier (as a confirmed redemption leaves it)."""
    v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
    v.remaining = {k: (val - units) for k, val in (v.remaining or {}).items()}
    w.db.commit()


def test_a_quota_voucher_reads_quota_used_remaining(w):
    code = codes(w, issue(w, _quota_type(w)["id"]))[0]
    out = look(w, code)
    assert (out["quotaUnit"], out["quota"], out["used"], out["remaining"]) == ("units", 5, 0, 5)
    _take(w, code, 2)
    out = look(w, code)
    assert (out["quota"], out["used"], out["remaining"]) == (5, 2, 3)
    (group,) = out["groups"]
    assert (group["quota"], group["used"], group["remaining"]) == (5, 2, 3)
    assert (out["totalMax"], out["totalRemaining"]) == (5, 3)


def test_each_group_lists_its_eligible_products_as_the_reserve_reads_them(w):
    b = issue(w, meal_type(w)["id"])
    out = look(w, codes(w, b)[0])
    meal = next(g for g in out["groups"] if g["name"] == "מנה")
    drink = next(g for g in out["groups"] if g["name"] == "שתייה")
    assert set(meal["eligibleProductIds"]) == {str(w.sandwich.id), str(w.hotdog.id)}
    assert set(drink["eligibleProductIds"]) == {str(w.coffee.id)}  # via its sub-category
    assert meal["eligibleProductIds"] == meal["productIds"]
    assert (meal["quota"], meal["used"], out["quota"], out["remaining"]) == (1, 0, 2, 2)
    # The rule the reserve uses: the batch's groups, frozen at issue.
    from app.services import production_voucher_groups as PG

    row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
    by_name = {g["name"]: g for g in row.groups}
    assert set(PG.eligible(w.db, row, by_name["מנה"])) == set(meal["eligibleProductIds"])


def test_frozen_and_live_catalogs_are_honoured(w):
    frozen = issue(w, meal_type(w)["id"])
    live = issue(w, meal_type(w, code="LIVE", name="חי", catalogMode="live")["id"])
    later = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=w.food.id,
                    catalog_level=CatalogLevel.GLOBAL, name="פיצה", price=30, sku="sku-pizza-q")
    w.db.add(later)
    w.db.commit()
    meal = lambda out: next(g for g in out["groups"] if g["name"] == "מנה")  # noqa: E731
    assert str(later.id) not in meal(look(w, codes(w, frozen)[0]))["eligibleProductIds"]
    assert str(later.id) in meal(look(w, codes(w, live)[0]))["eligibleProductIds"]


def test_a_discount_voucher_counts_its_uses(w):
    b = make(w, "order_discount", count=1, usesPerVoucher=3)
    out = lookup(w, codes(w, b)[0])
    assert (out["quotaUnit"], out["quota"], out["used"], out["remaining"]) == ("uses", 3, 0, 3)
