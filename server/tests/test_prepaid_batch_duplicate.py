"""
"שכפול סדרה" and "שינוי שם" (P:/specs/voucher-batch-duplicate.md) — POST
/prepaid-vouchers/batches/{id}/duplicate (app/services/prepaid_batch_duplicate.py) and PATCH `name`.

The spec's acceptance items, by number:

1. A "פריט אחד מכל קבוצה" batch duplicated to 100 vouchers: the same groups, limits and rules, 100 new
   codes none of which is the source's, the new name — and the groups frozen again by today's catalog.
2. A batch with redemptions: the new one has none, and its "כמה מתוך כמה" does not count the source's.
3. The same `clientRequestId` (or `Idempotency-Key`) twice makes one batch.
4. An empty name or a count of 0 is refused with the value, the reason and the limit.
5. A past validity is copied as it is, and the dialog may send a new one.
6. A rename shows in the list, is on the batch's log, and changes nothing else.
7. A batch in test mode: the new one is not, unless `startInTestMode`.

And: who may (as batch create), what is copied and what never is, the voucher type, both audit
lines, the distribution's texts.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError

from app.models.dashboard_access import DashboardAccessProfile
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
)
from app.models.product import CatalogLevel, Product
from app.models.user import User, UserRole
from app.models.voucher_distribution import VoucherDistribution, VoucherDistributionRecipient
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    COUNT_OUT_OF_RANGE,
    NAME_EMPTY,
    NAME_TOO_LONG,
    PrepaidBatchDuplicateIn,
    PrepaidVoucherAddIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherCancelIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherTypeCreate,
)
from app.services import command_idempotency as idem
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import prepaid_batch_duplicate as PBD
from app.services import prepaid_voucher_analytics as PVA
from app.services import prepaid_voucher_types as PVT
from app.services import prepaid_vouchers as PV
from test_prepaid_voucher_kinds import _ctx, codes, w  # noqa: F401 — `w` is the fixture

#: What a batch says about itself that a duplicate copies (the batch's answer, by its wire names).
COPIED = (
    "kind", "selection", "groups", "totalQty", "catalogMode", "items", "splitAllowed", "includeExtras",
    "discountType", "discountValue", "minPurchase", "maxDiscount", "maxUnits", "targets",
    "stacking", "maxVouchersPerSale", "promotionPolicy", "usesPerVoucher", "maxUsesPerSale", "maxUsesPerDay",
    "shopIds", "tillValue", "productionPrice", "pricing", "allowTopUp", "redemptionAccounting",
    "discountBlockPolicy", "offlineAllowed", "showValidity", "printTillValue", "showCode", "showItems",
    "showCredit", "barcodeType", "freeText", "logoUrl", "groupSize", "orderRef", "customerName", "eventName",
    "validFrom", "validUntil", "companyId",
)


def make(w, user=None, **body):
    data = {
        "name": "פסטיבל הקיץ", "companyId": w.company.id, "count": 3,
        "items": [{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.coffee.id, "quantity": 2}],
        "redemptionAccounting": "payment", **body,
    }
    return R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(**data), **_ctx_of(w, user))


def _ctx_of(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def per_group(w, **extra):
    """"פריט אחד מכל קבוצה": "מזון" and "שתייה", each 0–1, two items in all, in one sale."""
    return make(
        w, name="מזון ושתייה", items=[], selection="groups", totalQty=2, splitAllowed=False,
        groups=[
            {"name": "מזון", "minQty": 0, "maxQty": 1, "categoryIds": [w.food.id]},
            {"name": "שתייה", "minQty": 0, "maxQty": 1, "categoryIds": [w.drinks.id]},
        ],
        shopIds=[w.shop.id], stacking="unlimited", maxVouchersPerSale=3, tillValue=40, pricing="cover",
        showCode=True, barcodeType="code128", showCredit=False, freeText="בתיאבון", groupSize=10,
        customerName="קייטרינג אלון", eventName="ערב גאלה", orderRef="ORD-7",
        validFrom=datetime(2026, 10, 1, tzinfo=timezone.utc), validUntil=datetime(2027, 1, 1, tzinfo=timezone.utc),
        **extra,
    )


def dup(w, source, *, user=None, key=None, **body):
    response = Response()
    response.status_code = None
    body.setdefault("name", "עותק")
    body.setdefault("count", 5)
    out = R.duplicate_prepaid_voucher_batch(
        source["id"], PrepaidBatchDuplicateIn(**body), response=response, idempotency_key=key, **_ctx_of(w, user),
    )
    return out, response


def row(w, b) -> PrepaidVoucherBatch:
    w.db.expire_all()
    return w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(str(b["id"]))).one()


def events(w, b, action=None):
    q = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.batch_id == uuid.UUID(str(b["id"])))
    if action:
        q = q.filter(PrepaidVoucherEvent.action == action)
    return q.all()


def get(w, b):
    return R.get_prepaid_voucher_batch(b["id"], **_ctx(w))


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def redeem(w, code, items, request_id):
    till = w.tills[0]
    body = PrepaidVoucherRedeemIn(
        code=code, items=[{"productId": str(p.id), "quantity": q} for p, q in items], clientRequestId=request_id,
    )
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def batches_list(w, user=None):
    return R.list_prepaid_voucher_batches(include_cancelled=True, sort="newest", scope=PVA.make_scope(), **_ctx_of(w, user))


# ── 1. Same terms, new vouchers ───────────────────────────────────────────────


class TestSameTermsNewVouchers:
    def test_one_per_group_to_100_vouchers(self, w):
        source = per_group(w)
        new, response = dup(w, source, name="מזון ושתייה — יום ב", count=100)
        assert response.status_code is None  # 201, the route's own
        assert new["name"] == "מזון ושתייה — יום ב" and new["id"] != source["id"]
        assert {k: new[k] for k in COPIED} == {k: get(w, source)[k] for k in COPIED}
        assert [(g["name"], g["minQty"], g["maxQty"]) for g in new["groups"]] == [("מזון", 0, 1), ("שתייה", 0, 1)]
        assert (new["totalQty"], new["splitAllowed"], new["stacking"], new["maxVouchersPerSale"]) == (2, False, "unlimited", 3)
        mine, theirs = codes(w, new), codes(w, source)
        assert len(mine) == len(set(mine)) == 100 and not set(mine) & set(theirs)
        assert (new["stats"]["total"], new["issuedCount"], new["groupCount"]) == (100, 100, 10)
        assert new["duplicatedFrom"] == {"id": source["id"], "name": "מזון ושתייה"}
        # The source is as it was.
        assert len(codes(w, source)) == 3 and get(w, source)["name"] == "מזון ושתייה"

    def test_groups_are_frozen_again_by_todays_catalog(self, w):
        source = per_group(w)
        pizza = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=w.food.id,
                        catalog_level=CatalogLevel.GLOBAL, name="פיצה", price=30, sku="sku-pizza")
        w.db.add(pizza)
        w.db.commit()
        new, _ = dup(w, source)
        frozen = lambda b: {g["name"]: set(g["frozenProductIds"]) for g in row(w, b).groups}  # noqa: E731
        assert str(pizza.id) not in frozen(source)["מזון"]
        assert str(pizza.id) in frozen(new)["מזון"]
        # The voucher's quota is the groups' as at any issue.
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(new["id"])).first()
        keys = {g["name"]: g["key"] for g in row(w, new).groups}
        assert v.remaining == {f"g:{keys['מזון']}": 1, f"g:{keys['שתייה']}": 1, "total": 2}

    @pytest.mark.parametrize("kind, terms", [
        ("order_discount", {"discountType": "percent", "discountValue": 15, "maxDiscount": 40, "minPurchase": 100,
                            "usesPerVoucher": 5, "maxUsesPerSale": 2, "maxUsesPerDay": 3, "promotionPolicy": "best"}),
        ("item_discount", {"discountType": "fixed", "discountValue": 4, "maxUnits": 2,
                           "targets": {"productIds": [], "categoryIds": []}}),
    ])
    def test_a_discount_keeps_its_terms(self, w, kind, terms):
        if kind == "item_discount":
            terms["targets"] = {"productIds": [w.coffee.id], "categoryIds": [w.food.id]}
        source = make(w, name="הנחה", kind=kind, items=[], stacking="distinct_batches", **terms)
        new, _ = dup(w, source)
        assert {k: new[k] for k in COPIED} == {k: get(w, source)[k] for k in COPIED}
        assert new["benefitText"] == source["benefitText"]
        assert {v.uses_left for v in w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(new["id"]))} == {
            source["usesPerVoucher"]}

    def test_a_batch_of_a_type_is_issued_from_the_same_type(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="שובר ארוחה", code="MEAL", tillValue=60, productionPrice=45,
            items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.coffee.id, "quantity": 1}],
        ), **_ctx(w))
        source = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="פסטיבל", companyId=w.company.id, typeId=t["id"], count=2), **_ctx(w))
        new, _ = dup(w, source)
        assert new["type"]["id"] == t["id"] and new["type"]["version"] == source["type"]["version"]
        assert new["typeName"] == "שובר ארוחה"  # printed above the title, as on the source
        assert {k: new[k] for k in COPIED} == {k: get(w, source)[k] for k in COPIED}
        assert events(w, new, "duplicated_from")[0].details["sameType"] is True

    def test_a_batch_edited_after_issue_keeps_its_own_terms(self, w):
        t = R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(
            companyId=w.company.id, name="שובר ארוחה", code="MEAL", tillValue=60,
            items=[{"productId": w.hotdog.id, "quantity": 1}],
        ), **_ctx(w))
        source = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="פסטיבל", companyId=w.company.id, typeId=t["id"], count=2), **_ctx(w))
        R.update_prepaid_voucher_batch(source["id"], PrepaidVoucherBatchUpdate(tillValue=70), **_ctx(w))
        new, _ = dup(w, source)
        assert new["tillValue"] == 70.0 and new["type"]["id"] != t["id"] and new["type"]["origin"] == "batch"
        assert {k: new[k] for k in COPIED} == {k: get(w, source)[k] for k in COPIED}
        assert events(w, new, "duplicated_from")[0].details["sameType"] is False

    def test_the_dialog_fields_replace_the_sources(self, w):
        source = per_group(w)
        until = datetime(2027, 6, 30, 20, 59, 59, tzinfo=timezone.utc)
        new, _ = dup(w, source, customerName="הפקות כהן", eventName="ערב ב", validFrom=None, validUntil=until)
        assert (new["customerName"], new["eventName"], new["validFrom"]) == ("הפקות כהן", "ערב ב", None)
        assert new["validUntil"] == until.isoformat()
        # Absent fields stay the source's.
        same, _ = dup(w, source, name="עוד עותק")
        assert (same["customerName"], same["eventName"], same["validFrom"]) == ("קייטרינג אלון", "ערב גאלה", source["validFrom"])

    def test_the_distribution_texts_but_never_its_recipients(self, w):
        source = per_group(w)
        w.db.add(VoucherDistribution(id=uuid.uuid4(), tenant_id=w.tenant.id, batch_id=uuid.UUID(source["id"]),
                                     message_template="שלום {שם}, {קישור}", group_message_template="קבוצה {קבוצה}",
                                     layout="card86x54"))
        w.db.add(VoucherDistributionRecipient(id=uuid.uuid4(), tenant_id=w.tenant.id, batch_id=uuid.UUID(source["id"]),
                                              name="דנה", status="sent"))
        w.db.commit()
        new, _ = dup(w, source)
        dist = w.db.query(VoucherDistribution).filter(VoucherDistribution.batch_id == uuid.UUID(new["id"])).one()
        assert (dist.message_template, dist.group_message_template, dist.layout) == (
            "שלום {שם}, {קישור}", "קבוצה {קבוצה}", "card86x54")
        assert dist.link_expires_at is None
        assert w.db.query(VoucherDistributionRecipient).filter(
            VoucherDistributionRecipient.batch_id == uuid.UUID(new["id"])).count() == 0

    def test_a_cancelled_batch_gives_an_active_one(self, w):
        source = per_group(w)
        R.cancel_prepaid_voucher_batch(source["id"], PrepaidVoucherCancelIn(reason="בוטל"), **_ctx(w))
        new, _ = dup(w, source)
        assert new["status"] == "active" and new["stats"]["active"] == 5 and new["stats"]["cancelled"] == 0


# ── The audit trail ───────────────────────────────────────────────────────────


class TestAudit:
    def test_a_line_on_each_batch_with_the_other(self, w):
        source = per_group(w)
        new, _ = dup(w, source, name="יום ב", count=7)
        (frm,) = events(w, new, "duplicated_from")
        (to,) = events(w, source, "duplicated_to")
        assert (frm.details["batchId"], frm.details["batchName"], frm.count) == (source["id"], "מזון ושתייה", 7)
        assert (to.details["batchId"], to.details["batchName"], to.count) == (new["id"], "יום ב", 7)
        assert frm.user_name == to.user_name == "admin"
        # The new batch's own trail: made, then where from — nothing of the source's.
        assert sorted(e.action for e in events(w, new)) == ["create", "duplicated_from"]
        shown = R.prepaid_voucher_events(source["id"], **_ctx(w))["items"]
        assert any(e["action"] == "duplicated_to" and e["details"]["batchName"] == "יום ב" for e in shown)


# ── 2. Nothing of the source's history ────────────────────────────────────────


class TestNoHistory:
    def test_the_redemptions_stay_with_the_source(self, w):
        source = make(w, count=4)
        first, second = codes(w, source)[:2]
        redeem(w, first, [(w.hotdog, 1), (w.coffee, 2)], "r-1")
        redeem(w, second, [(w.hotdog, 1), (w.coffee, 2)], "r-2")
        new, _ = dup(w, source, count=10)
        assert new["stats"] == {**new["stats"], "total": 10, "active": 10, "partiallyUsed": 0, "used": 0}
        assert w.db.query(PrepaidVoucherRedemption).filter(
            PrepaidVoucherRedemption.batch_id == uuid.UUID(new["id"])).count() == 0
        listed = {b["id"]: b["figures"] for b in batches_list(w)["items"]}
        assert (listed[new["id"]]["issued"], listed[new["id"]]["redeemed"]) == (10, 0)
        assert (listed[source["id"]]["issued"], listed[source["id"]]["redeemed"]) == (4, 2)
        fresh = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(new["id"])).all()
        assert {str(v.status) for v in fresh} == {"active"}
        assert all(v.remaining == {str(w.hotdog.id): 1, str(w.coffee.id): 2} for v in fresh)
        assert sorted(v.serial for v in fresh) == list(range(1, 11))


# ── 3. Exactly once ───────────────────────────────────────────────────────────


class TestOnce:
    def test_the_same_client_request_id_twice_makes_one_batch(self, w):
        source = per_group(w)
        first, r1 = dup(w, source, clientRequestId="dup-request-0001")
        again, r2 = dup(w, source, clientRequestId="dup-request-0001")
        assert again["id"] == first["id"] and codes(w, again) == codes(w, first)
        assert (r1.status_code, r2.status_code, r2.headers.get(idem.REPLAY_HEADER)) == (None, 200, "true")
        assert w.db.query(PrepaidVoucherBatch).count() == 2
        assert len(events(w, source, "duplicated_to")) == 1
        assert again["duplicatedFrom"] == {"id": source["id"], "name": "מזון ושתייה"}

    def test_the_header_key_too_and_it_wins(self, w):
        source = per_group(w)
        first, _ = dup(w, source, key="dup-header-key-01", clientRequestId="dup-body-id-01")
        again, r2 = dup(w, source, key="dup-header-key-01", clientRequestId="dup-body-id-02")
        assert again["id"] == first["id"] and r2.status_code == 200
        assert w.db.query(PrepaidVoucherBatch).count() == 2

    def test_the_same_key_for_another_body_or_source_is_refused(self, w):
        source, other = per_group(w), make(w)
        dup(w, source, clientRequestId="dup-request-0002", count=5)
        assert refused(dup, w, source, clientRequestId="dup-request-0002", count=6).status_code == 422
        assert refused(dup, w, other, clientRequestId="dup-request-0002", count=5).status_code == 422
        assert w.db.query(PrepaidVoucherBatch).count() == 3

    def test_a_failure_leaves_nothing(self, w, monkeypatch):
        source = per_group(w)
        before = w.db.query(PrepaidVoucherEvent).count()

        def boom(*_a, **_k):
            raise RuntimeError("forced failure after the batch was flushed")

        monkeypatch.setattr(PBD, "copy_distribution_texts", boom)
        with pytest.raises(RuntimeError):
            dup(w, source, clientRequestId="dup-request-0003")
        assert w.db.query(PrepaidVoucherBatch).count() == 1
        assert w.db.query(PrepaidVoucherEvent).count() == before
        monkeypatch.undo()
        new, _ = dup(w, source, clientRequestId="dup-request-0003")
        assert w.db.query(PrepaidVoucherBatch).count() == 2 and new["stats"]["total"] == 5


# ── 4. Refusals ───────────────────────────────────────────────────────────────


def _error(exc: ValidationError):
    (e,) = exc.errors()
    return e["type"], e["msg"]


class TestRefusals:
    @pytest.mark.parametrize("name", ["", "   ", None])
    def test_an_empty_name(self, name):
        with pytest.raises(ValidationError) as e:
            PrepaidBatchDuplicateIn(name=name, count=10)
        kind, msg = _error(e.value)
        assert kind == NAME_EMPTY and "שם ריק" in msg and "200" in msg

    def test_a_name_without_one(self):
        with pytest.raises(ValidationError) as e:
            PrepaidBatchDuplicateIn(count=10)
        assert _error(e.value)[0] == NAME_EMPTY

    def test_a_name_too_long(self):
        with pytest.raises(ValidationError) as e:
            PrepaidBatchDuplicateIn(name="א" * 201, count=10)
        kind, msg = _error(e.value)
        assert kind == NAME_TOO_LONG and "201" in msg and "200" in msg

    @pytest.mark.parametrize("count, shown", [(0, "0"), (5001, "5001"), (-3, "-3"), (2.5, "2.5"), ("abc", "abc")])
    def test_a_count_outside_the_create_limits(self, count, shown):
        with pytest.raises(ValidationError) as e:
            PrepaidBatchDuplicateIn(name="x", count=count)
        kind, msg = _error(e.value)
        assert kind == COUNT_OUT_OF_RANGE and f"לא ניתן להנפיק {shown} שוברים" in msg and "5,000" in msg

    def test_no_count(self):
        with pytest.raises(ValidationError) as e:
            PrepaidBatchDuplicateIn(name="x")
        kind, msg = _error(e.value)
        assert kind == COUNT_OUT_OF_RANGE and msg.startswith("חסר מספר השוברים")

    @pytest.mark.parametrize("count", [1, 5000, "40"])
    def test_the_limits_themselves_are_fine(self, count):
        assert PrepaidBatchDuplicateIn(name=" חדש ", count=count).model_dump()["name"] == "חדש"

    def test_dates_the_wrong_way_round(self, w):
        source = per_group(w)
        e = refused(dup, w, source, validFrom=datetime(2027, 2, 1, tzinfo=timezone.utc),
                    validUntil=datetime(2027, 1, 1, tzinfo=timezone.utc))
        assert e.status_code == 422 and "validUntil must be after validFrom" in str(e.detail)
        assert w.db.query(PrepaidVoucherBatch).count() == 1

    def test_a_product_no_longer_usable_is_refused_as_at_create(self, w):
        source = make(w)
        w.db.query(Product).filter(Product.id == w.coffee.id).update({"is_general": True})
        w.db.commit()
        e = refused(dup, w, source)
        assert (e.status_code, e.detail) == (400, PV.product_refusal(PV.BLOCK_GENERAL))
        assert w.db.query(PrepaidVoucherBatch).count() == 1


# ── 5. A past validity ────────────────────────────────────────────────────────


class TestPastValidity:
    def test_copied_as_it_is_or_replaced_by_the_dialog(self, w):
        past = datetime.now(timezone.utc) - timedelta(days=3)
        source = make(w, validUntil=past)
        assert dup(w, source, name="כמו המקור")[0]["validUntil"] == PV._iso(past)
        later = datetime.now(timezone.utc) + timedelta(days=30)
        new, _ = dup(w, source, name="עודכן", validUntil=later)
        assert new["validUntil"] == PV._iso(later)
        # In force again: more vouchers may be added to it (a batch past its validity refuses them).
        more = R.add_prepaid_vouchers(new["id"], PrepaidVoucherAddIn(count=1), response=Response(),
                                      idempotency_key=None, **_ctx(w))
        assert more["stats"]["total"] == 6
        assert refused(R.add_prepaid_vouchers, source["id"], PrepaidVoucherAddIn(count=1), response=Response(),
                       idempotency_key=None, **_ctx(w)).detail == PV.BATCH_EXPIRED


# ── 6. Renaming ───────────────────────────────────────────────────────────────


class TestRename:
    def test_the_new_name_in_the_list_and_on_the_log(self, w):
        source = make(w, count=3)
        before = {v.serial: (v.code, dict(v.remaining), v.status) for v in row(w, source).vouchers}
        redeem(w, codes(w, source)[0], [(w.hotdog, 1), (w.coffee, 2)], "r-ren")
        snap = row(w, source)
        prev_next, prev_shops = snap.next_serial, snap.shop_ids
        out = R.update_prepaid_voucher_batch(source["id"], PrepaidVoucherBatchUpdate(name="  הפקת חורף  "), **_ctx(w))
        assert out["name"] == "הפקת חורף"
        assert [b["name"] for b in batches_list(w)["items"] if b["id"] == source["id"]] == ["הפקת חורף"]
        (line,) = events(w, source, "update")
        assert line.details["fields"] == ["name"]
        assert [(c["field"], c["before"], c["after"]) for c in line.details["changes"]] == [
            ("name", "פסטיבל הקיץ", "הפקת חורף")]
        # Nothing else: the codes, the serials, what each voucher has left, the past redemption as recorded.
        after = {v.serial: (v.code, dict(v.remaining), v.status) for v in row(w, source).vouchers}
        assert {s: c for s, (c, _r, _st) in after.items()} == {s: c for s, (c, _r, _st) in before.items()}
        assert row(w, source).next_serial == prev_next and row(w, source).shop_ids == prev_shops
        (r,) = w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.batch_id == uuid.UUID(source["id"])).all()
        assert r.batch_name == "פסטיבל הקיץ"
        assert {k: out[k] for k in COPIED} == {k: source[k] for k in COPIED}

    @pytest.mark.parametrize("name", ["", "   ", None])
    def test_an_empty_name_is_refused_not_ignored(self, w, name):
        with pytest.raises(ValidationError) as e:
            PrepaidVoucherBatchUpdate(name=name)
        kind, msg = _error(e.value)
        assert kind == NAME_EMPTY and "לא ניתן לשמור שם ריק" in msg and "200" in msg

    def test_a_name_too_long_is_refused_with_its_length(self):
        with pytest.raises(ValidationError) as e:
            PrepaidVoucherBatchUpdate(name="ב" * 250)
        assert _error(e.value) == (NAME_TOO_LONG, "לא ניתן לשמור שם של 250 תווים: שם הסדרה יכול להיות עד 200 תווים.")

    def test_other_edits_are_as_before(self):
        assert "name" not in PrepaidVoucherBatchUpdate(freeText="x").model_fields_set
        assert PrepaidVoucherBatchUpdate(name="שם", eventName="").event_name is None

    def test_a_cancelled_batch_may_be_renamed(self, w):
        source = make(w)
        R.cancel_prepaid_voucher_batch(source["id"], PrepaidVoucherCancelIn(reason="x"), **_ctx(w))
        assert R.update_prepaid_voucher_batch(source["id"], PrepaidVoucherBatchUpdate(name="ישן"), **_ctx(w))["name"] == "ישן"


# ── 7. Test mode ──────────────────────────────────────────────────────────────


class TestTestMode:
    def test_not_copied_unless_asked(self, w):
        source = make(w, startInTestMode=True)
        assert get(w, source)["testMode"] is True
        plain, _ = dup(w, source)
        assert plain["testMode"] is False and not events(w, plain, "test_mode_on")
        asked, _ = dup(w, source, name="בבדיקה", startInTestMode=True)
        assert asked["testMode"] is True and len(events(w, asked, "test_mode_on")) == 1


# ── Who may ───────────────────────────────────────────────────────────────────


def _user(w, role, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
             username=f"u-{uuid.uuid4().hex[:6]}", **kw)
    w.db.add(u)
    w.db.commit()
    return u


class TestWho:
    def test_whoever_cannot_create_a_batch_cannot_duplicate(self, w):
        source = make(w)
        cashier = _user(w, UserRole.CASHIER, shop_id=w.shop.id)
        assert refused(make, w, cashier, shopIds=[w.shop.id]).status_code == 403
        assert refused(dup, w, source, user=cashier).status_code == 403
        assert w.db.query(PrepaidVoucherBatch).count() == 1

    def test_a_shop_manager_their_own_shops_only(self, w):
        manager = _user(w, UserRole.SHOP_MANAGER, shop_id=w.shop.id)
        company_wide = make(w)
        assert refused(make, w, manager).status_code == 403
        assert refused(dup, w, company_wide, user=manager).status_code == 403
        own = make(w, shopIds=[w.shop.id])
        new, _ = dup(w, own, user=manager)
        assert new["shopIds"] == [str(w.shop.id)]

    def test_another_tenants_batch_is_not_found(self, w):
        source = make(w)
        e = refused(R.duplicate_prepaid_voucher_batch, source["id"], PrepaidBatchDuplicateIn(name="x", count=1),
                    current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db, response=Response(),
                    idempotency_key=None)
        assert (e.status_code, e.detail) == (404, PV.BATCH_NOT_FOUND)

    def test_a_production_price_needs_the_prices_section_as_at_create(self, w):
        source = make(w, productionPrice=20)
        cm = _user(w, UserRole.COMPANY_MANAGER, company_id=w.company.id)
        w.db.add(DashboardAccessProfile(user_id=cm.id, full_access=False, sections={"prepaid_vouchers": "edit"}))
        w.db.commit()
        assert refused(make, w, cm, productionPrice=20).detail == PVT.PRICES_FORBIDDEN
        assert refused(dup, w, source, user=cm).detail == PVT.PRICES_FORBIDDEN

    def test_the_dashboard_section_is_batch_creates(self, w):
        create = DS.rule_for("POST", "/prepaid-vouchers/batches")
        rule = DS.rule_for("POST", "/prepaid-vouchers/batches/{batch_id}/duplicate")
        assert (rule.kind, rule.sections, rule.needed_level("POST")) == (create.kind, create.sections, "edit")
        viewer = _user(w, UserRole.COMPANY_MANAGER, company_id=w.company.id)
        editor = _user(w, UserRole.COMPANY_MANAGER, company_id=w.company.id)
        w.db.add_all([
            DashboardAccessProfile(user_id=viewer.id, full_access=False, sections={"prepaid_vouchers": "view"}),
            DashboardAccessProfile(user_id=editor.id, full_access=False, sections={"prepaid_vouchers": "edit"}),
        ])
        w.db.commit()
        for r in (create, rule):
            assert DA.check_rule(DA.effective_access(w.db, viewer), r, "POST").status_code == 403
            assert DA.check_rule(DA.effective_access(w.db, editor), r, "POST") is None
