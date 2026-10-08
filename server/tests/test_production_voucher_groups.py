"""
Groups on production voucher types and batches (the production vouchers contract §1/§2): a package
and "one of several", the catalog selection (categories with their sub-categories, every item,
exclusions that win), frozen at issue or live, what a voucher has left per group, the lookup's
groups block — and groups never go through the immediate `/redeem` (reserve → confirm, §3).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.models.product import CatalogLevel, Product
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherBatchCreate,
    PrepaidVoucherLookupIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherTypeCreate,
)
from app.services import prepaid_vouchers as PV
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture

FEATURES = ["accounting", "groups", "reserve_goods", "override"]


def meal_type(w, **extra):
    body = {
        "companyId": w.company.id, "name": "שובר ארוחה", "selection": "groups", "tillValue": 60, "totalQty": 2,
        "groups": [
            {"name": "מנה", "minQty": 1, "maxQty": 1, "categoryIds": [w.food.id], "value": 45},
            {"name": "שתייה", "minQty": 1, "maxQty": 1, "categoryIds": [w.drinks.id], "value": 15},
        ],
        **extra,
    }
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w))


def issue(w, type_id, count=2):
    return R.create_prepaid_voucher_batch(
        PrepaidVoucherBatchCreate(name="פסטיבל", companyId=w.company.id, typeId=type_id, count=count), **_ctx(w))


def look(w, code, features=FEATURES):
    till = w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, features=features), machine=till, db=w.db)


class TestTypes:
    def test_stored_with_keys_and_shown_in_shekels(self, w):
        t = meal_type(w)
        assert (t["selection"], t["totalQty"], t["catalogMode"]) == ("groups", 2, "frozen")
        assert [(g["name"], g["minQty"], g["maxQty"], g["value"]) for g in t["groups"]] == [
            ("מנה", 1, 1, 45.0), ("שתייה", 1, 1, 15.0)]
        assert all(g["key"] for g in t["groups"]) and t["items"] == []

    @pytest.mark.parametrize("groups, total", [
        ([{"name": "x", "minQty": 2, "maxQty": 1, "allItems": True}], None),
        ([{"name": "x", "minQty": 0, "maxQty": 1}], None),
        ([{"name": "x", "minQty": 1, "maxQty": 2, "allItems": True}], 5),
        ([], None),
    ])
    def test_refused_when_it_cannot_be_redeemed(self, w, groups, total):
        with pytest.raises(ValueError):
            PrepaidVoucherTypeCreate(companyId=w.company.id, name="x", selection="groups", groups=groups, totalQty=total)

    def test_another_tenants_product_is_refused(self, w):
        with pytest.raises(HTTPException) as e:
            meal_type(w, totalQty=None, groups=[{"name": "x", "maxQty": 1, "productIds": [uuid.uuid4()]}])
        assert e.value.status_code == 422


class TestBatches:
    def test_the_catalog_is_frozen_at_issue_with_sub_categories(self, w):
        b = issue(w, meal_type(w)["id"])
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        frozen = {g["name"]: set(g["frozenProductIds"]) for g in row.groups}
        assert frozen["מנה"] == {str(w.sandwich.id), str(w.hotdog.id)}
        assert frozen["שתייה"] == {str(w.coffee.id)}  # via its sub-category "אספרסו"
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == row.id).first()
        keys = {g["name"]: g["key"] for g in row.groups}
        assert v.remaining == {f"g:{keys['מנה']}": 1, f"g:{keys['שתייה']}": 1, "total": 2}

    def test_the_lookup_shows_the_groups(self, w):
        b = issue(w, meal_type(w)["id"])
        out = look(w, codes(w, b)[0])
        assert (out["redeemable"], out["selection"], out["totalMax"], out["totalRemaining"]) == (True, "groups", 2, 2)
        meal = next(g for g in out["groups"] if g["name"] == "מנה")
        assert (meal["remaining"], meal["valueAgorot"], meal["minQty"]) == (1, 4500, 1)
        assert set(meal["productIds"]) >= {str(w.sandwich.id), str(w.hotdog.id)}

    def test_frozen_keeps_live_follows(self, w):
        frozen = issue(w, meal_type(w)["id"])
        live = issue(w, meal_type(w, code="LIVE", name="חי", catalogMode="live")["id"])
        later = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=w.food.id,
                        catalog_level=CatalogLevel.GLOBAL, name="פיצה", price=30, sku="sku-pizza")
        w.db.add(later)
        w.db.commit()
        meal = lambda out: next(g for g in out["groups"] if g["name"] == "מנה")  # noqa: E731
        assert str(later.id) not in meal(look(w, codes(w, frozen)[0]))["productIds"]
        assert str(later.id) in meal(look(w, codes(w, live)[0]))["productIds"]

    def test_exclusions_win(self, w):
        t = meal_type(w, code="X", name="הכול חוץ משתייה", totalQty=None, groups=[
            {"name": "הכול", "maxQty": 1, "allItems": True, "excludeCategoryIds": [w.drinks.id]},
        ])
        out = look(w, codes(w, issue(w, t["id"]))[0])
        ids = set(out["groups"][0]["productIds"])
        assert str(w.coffee.id) not in ids and {str(w.sandwich.id), str(w.hotdog.id)} <= ids

    def test_groups_never_go_through_the_immediate_redeem(self, w):
        b = issue(w, meal_type(w)["id"])
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        assert {"groups", "reserve_goods"} <= set(PV.required_features(w.db, row))
        assert look(w, codes(w, b)[0], features=["accounting"])["reason"] == PV.UPDATE_REQUIRED
        till = w.tills[0]
        body = PrepaidVoucherRedeemIn(code=codes(w, b)[0], items=[{"productId": str(w.hotdog.id), "quantity": 1}],
                                      clientRequestId="r1", features=FEATURES)
        with pytest.raises(HTTPException) as e:
            R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)
        assert e.value.detail == PV.UPDATE_REQUIRED
