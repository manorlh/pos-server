"""
Prepaid voucher kinds (docs/SPEC_VOUCHER_PRODUCTION.md §7): goods (`items`, a tender, as
before), a discount on the whole sale (`order_discount`) and on chosen items
(`item_discount`) — a discount on the document, never a tender.

What each class pins:

* **Rules** — the shared fixture (tests/fixtures/prepaid_voucher_rules.json, the same bytes
  as the till's copy): stacking, the discount per promotion policy, the uses one sale
  takes, the words printed on the voucher.
* **Batches** — the form per kind, defaults (one voucher per sale, no double benefit with
  a promotion, one use), what may change later.
* **Lookup** — a discount voucher's terms and uses to a till that supports the kind; to
  one that does not (the web / Windows kiosks today), not redeemable, with a message.
* **Reserve** — under the shared rules and the uses (left, held elsewhere, per sale, per
  day); idempotent and renewed by the request id; released; expired.
* **Confirm** — the explicit call and the document through the outbox, both idempotent;
  a late or over-the-rules confirm is recorded and flagged, never refused.
* **Accounting** — the Z's discounts (never a tender), the discounts report, the
  document copy, the batch's usage report, the PDF.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.category import Category
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
    TransactionVoucherDiscount,
)
from app.models.product import CatalogLevel, Product
from app.models.shift import ShiftStatus
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherConfirmIn,
    PrepaidVoucherLookupIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherReserveIn,
)
from app.schemas.transaction import TransactionIn
from app.services import prepaid_voucher_rules as RULES
from app.services import prepaid_vouchers as PV
from app.services.shift_totals import compute_totals
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world

FIXTURE = Path(__file__).parent / "fixtures" / "prepaid_voucher_rules.json"
#: The fixture's SHA-256 with line endings as LF — the till's test pins the same value.
FIXTURE_SHA256 = "2576f9361a559d34e9d8c472307cebb16de4404ed4a8c52f7f6bca54ae4f5bdb"
KINDS = ["items", "order_discount", "item_discount"]


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    world.drinks = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="שתייה חמה")
    world.food = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="אוכל")
    db.add_all([world.drinks, world.food])
    db.flush()
    world.espresso = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="אספרסו", parent_id=world.drinks.id)
    db.add(world.espresso)
    db.flush()

    def product(name, price, cat):
        p = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
            category_id=cat.id, catalog_level=CatalogLevel.GLOBAL, name=name, price=price, sku=f"sku-{name}",
        )
        db.add(p)
        return p

    world.coffee = product("קפה", 12, world.espresso)
    world.sandwich = product("כריך", 40, world.food)
    world.hotdog = product("נקניקייה", 25, world.food)
    db.flush()
    for p in (world.coffee, world.sandwich, world.hotdog):
        db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=p.id, is_listed=True))
    db.commit()
    return world


def _ctx(w):
    return dict(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def make(w, kind="order_discount", count=2, **terms):
    body = {
        "name": terms.pop("name", "שובר הנחה"), "companyId": w.company.id, "count": count, "kind": kind,
        **terms,
    }
    if kind == "order_discount":
        body.setdefault("discountType", "fixed")
        body.setdefault("discountValue", 30)
    elif kind == "item_discount":
        body.setdefault("discountType", "percent")
        body.setdefault("discountValue", 20)
        body.setdefault("targets", {"productIds": [w.coffee.id]})
    else:
        body.setdefault("items", [{"productId": w.hotdog.id, "quantity": 1}])
    return R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(**body), **_ctx(w))


def codes(w, batch):
    return [v["code"] for v in R.list_prepaid_vouchers(
        batch["id"], status_filter=None, serial=None, limit=5000, offset=0, **_ctx(w))["items"]]


def lookup(w, code, kinds=KINDS, till=None):
    till = till or w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, supportedKinds=kinds), machine=till, db=w.db)


def basket(*lines):
    """Lines as (id, product, quantity, gross ₪, promotion ₪)."""
    out = []
    for line in lines:
        lid, product, qty, gross = line[:4]
        promo = line[4] if len(line) > 4 else 0
        out.append({
            "id": lid, "productIds": [str(product.id)], "categoryIds": [str(product.category_id)],
            "quantity": qty, "grossAgorot": int(gross * 100), "promotionAgorot": int(promo * 100),
        })
    return out


def reserve(w, code, lines, *, sale="sale-1", till=None, request_id=None, uses=1, kinds=KINDS, others=()):
    till = till or w.tills[0]
    body = PrepaidVoucherReserveIn(
        code=code, clientRequestId=request_id or str(uuid.uuid4()), saleRef=sale, uses=uses,
        supportedKinds=kinds, lines=lines, otherVouchers=list(others), posUserId=7, posUserName="דנה",
    )
    return R.reserve_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def confirm(w, reservation_id, tx="tx-1", amount=3000, till=None, uses=None):
    till = till or w.tills[0]
    body = PrepaidVoucherConfirmIn(transactionId=tx, amountAgorot=amount, uses=uses)
    return R.confirm_prepaid_reservation(str(till.id), reservation_id, body, machine=till, db=w.db)


def release(w, reservation_id, till=None):
    till = till or w.tills[0]
    return R.release_prepaid_reservation(str(till.id), reservation_id, machine=till, db=w.db)


def voucher_row(w, code) -> PrepaidVoucher:
    w.db.expire_all()
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()


# ── Rules (the shared fixture) ────────────────────────────────────────────────


def _rules_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _benefit(b) -> RULES.Benefit:
    return RULES.Benefit(
        kind=b["kind"], discount_type=b["discountType"], value=b["value"], min_purchase=b["minPurchaseAgorot"],
        max_discount=b["maxDiscountAgorot"], max_units=b["maxUnits"], product_ids=frozenset(b["productIds"]),
        category_ids=frozenset(b["categoryIds"]), promotion_policy=b["promotionPolicy"],
    )


def _lines(ls):
    return [
        RULES.BasketLine(
            id=l["id"], product_ids=tuple(l["productIds"]), category_ids=tuple(l["categoryIds"]),
            quantity=l["quantity"], gross=l["grossAgorot"], line_discount=l["lineDiscountAgorot"],
            promotion=l["promotionAgorot"], voucher=l["voucherAgorot"], discountable=l["discountable"],
            # Every product type (§7.14): absent on the older cases — a line sold by the piece.
            weighed=l.get("weighed", False), general=l.get("general", False),
        )
        for l in ls
    ]


class TestRules:
    def test_the_fixture_is_the_one_the_till_pins(self):
        text = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
        assert hashlib.sha256(text).hexdigest() == FIXTURE_SHA256

    @pytest.mark.parametrize("case", _rules_fixture()["stacking"], ids=lambda c: c["name"])
    def test_stacking(self, case):
        def v(d):
            return RULES.VoucherInSale(d["voucherId"], d["batchId"], d["kind"], d["stacking"], d.get("maxVouchersPerSale"))

        existing, incoming = [v(e) for e in case["existing"]], v(case["incoming"])
        refusal = RULES.stacking_refusal(existing, incoming)
        assert refusal == case["refusal"]
        # "הגעת למספר השוברים המקסימלי בעסקה (N)": the N, and the words the cashier reads.
        others = [e for e in existing if e.voucher_id != incoming.voucher_id]
        limit = RULES.sale_limit(others, incoming) if refusal == RULES.MAX_PER_SALE else None
        assert limit == case["limit"]
        assert RULES.stacking_text(refusal, limit) == case["text"]

    @pytest.mark.parametrize("case", _rules_fixture()["discount"], ids=lambda c: c["name"])
    def test_discount(self, case):
        got = RULES.discount_for(_benefit(case["benefit"]), _lines(case["lines"]), case["uses"])
        want = case["expect"]
        assert got.amount == want["amountAgorot"]
        assert got.shares == want["shares"]
        assert got.drop_promotion == want["dropPromotion"]
        assert [{"lineId": a, "reason": b} for a, b in got.skipped] == want["skipped"]
        assert got.refusal == want["refusal"]
        assert sum(got.shares.values()) == got.amount

    @pytest.mark.parametrize("case", _rules_fixture()["usesWanted"], ids=lambda c: c["name"])
    def test_uses_wanted(self, case):
        assert RULES.uses_wanted(_benefit(case["benefit"]), _lines(case["lines"]), case["allowed"]) == case["uses"]

    @pytest.mark.parametrize("case", _rules_fixture()["benefitText"], ids=lambda c: c["name"])
    def test_benefit_text(self, case):
        got = RULES.benefit_text(
            case["kind"], case.get("discountType"), case.get("value"), min_purchase=case.get("minPurchaseAgorot"),
            max_discount=case.get("maxDiscountAgorot"), max_units=case.get("maxUnits"), target_names=case.get("names", []),
        )
        assert got == case["text"]


# ── Batches ───────────────────────────────────────────────────────────────────


class TestBatches:
    def test_an_order_discount_batch(self, w):
        b = make(w, discountType="percent", discountValue=20, minPurchase=100, maxDiscount=50, usesPerVoucher=3, maxUsesPerSale=2)
        assert b["kind"] == "order_discount" and b["items"] == []
        assert (b["discountType"], b["discountValue"], b["minPurchase"], b["maxDiscount"]) == ("percent", 20.0, 100.0, 50.0)
        assert b["benefitText"] == "20% הנחה על כל ההזמנה (עד ₪50) בקנייה מעל ₪100"
        assert (b["usesPerVoucher"], b["maxUsesPerSale"], b["maxUsesPerDay"]) == (3, 2, None)
        row = w.db.query(PrepaidVoucherBatch).one()
        # Agorot and basis points: ₪ / % × 100.
        assert (row.discount_value, row.min_purchase, row.max_discount) == (2000, 10000, 5000)
        assert all(v.uses_left == 3 and v.remaining == {} for v in w.db.query(PrepaidVoucher))

    def test_defaults_many_vouchers_a_sale_no_double_benefit_one_use(self, w):
        # The owner: a new type is "כמה שוברים בעסקה", with no maximum.
        b = make(w)
        assert (b["stacking"], b["maxVouchersPerSale"], b["promotionPolicy"], b["usesPerVoucher"], b["maxUsesPerSale"]) == (
            "unlimited", None, "exclude", 1, 1)
        goods = make(w, kind="items")
        assert goods["stacking"] == "unlimited" and goods["kind"] == "items" and goods["benefitText"] is None

    def test_an_item_discount_names_products_and_categories(self, w):
        b = make(w, kind="item_discount", targets={"productIds": [w.coffee.id], "categoryIds": [w.drinks.id]}, maxUnits=2)
        assert b["targets"]["names"] == ["קפה", "שתייה חמה"]
        assert b["benefitText"] == "20% הנחה על קפה, שתייה חמה (עד 2 יחידות)"
        assert b["maxUnits"] == 2 and b["minPurchase"] is None

    def test_the_form_per_kind(self, w):
        base = {"name": "x", "companyId": w.company.id, "count": 1}
        bad = [
            {"kind": "order_discount"},  # no value
            {"kind": "order_discount", "discountType": "percent", "discountValue": 120},
            {"kind": "order_discount", "discountType": "fixed", "discountValue": 0},
            {"kind": "item_discount", "discountType": "fixed", "discountValue": 5},  # no targets
            {"kind": "order_discount", "discountType": "fixed", "discountValue": 5,
             "items": [{"productId": w.hotdog.id, "quantity": 1}]},
            {"kind": "voucher"},
            {"kind": "order_discount", "discountType": "fixed", "discountValue": 5, "stacking": "two"},
            {"kind": "order_discount", "discountType": "fixed", "discountValue": 5, "promotionPolicy": "both"},
        ]
        for extra in bad:
            with pytest.raises(ValidationError):
                PrepaidVoucherBatchCreate(**base, **extra)
        # A fixed discount has no cap; a goods voucher no discount terms.
        ok = PrepaidVoucherBatchCreate(**base, kind="order_discount", discountType="fixed", discountValue=5, maxDiscount=3)
        assert ok.max_discount is None
        goods = PrepaidVoucherBatchCreate(**base, items=[{"productId": w.hotdog.id, "quantity": 1}], discountValue=5)
        assert goods.discount_value is None

    def test_a_target_of_another_tenant_is_refused(self, w):
        from app.models.tenant import Tenant

        stranger = Tenant(id=uuid.uuid4(), name="S", slug="s", timezone="Asia/Jerusalem")
        w.db.add(stranger)
        w.db.flush()
        other = Category(id=uuid.uuid4(), tenant_id=stranger.id, name="x")
        w.db.add(other)
        w.db.flush()
        assert refused(make, w, kind="item_discount", targets={"categoryIds": [other.id]}).detail == PV.TARGET_INVALID

    def test_the_target_pickers_offer_what_the_save_accepts(self, w):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="אחרת", vat_number="9")
        w.db.add(other)
        w.db.flush()
        theirs = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="שלהם")
        w.db.add(theirs)
        alien = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, category_id=theirs.id,
            catalog_level=CatalogLevel.GLOBAL, name="מוצר זר", price=5, sku="alien",
        )
        w.db.add(alien)
        w.db.commit()
        cats = R.list_prepaid_voucher_categories(str(w.company.id), **_ctx(w))["items"]
        assert {c["name"] for c in cats} == {"שתייה חמה", "אוכל", "אספרסו"}
        assert next(c for c in cats if c["name"] == "אספרסו")["parentId"] == str(w.drinks.id)
        products = R.list_prepaid_voucher_products(str(w.company.id), search=None, limit=50, **_ctx(w))["items"]
        assert "מוצר זר" not in {p["name"] for p in products}
        # Searched for, it is shown — marked as another company's (§7.14)…
        found = R.list_prepaid_voucher_products(str(w.company.id), search="זר", limit=50, **_ctx(w))["items"]
        assert [(p["name"], p["blocked"]["itemDiscount"]) for p in found] == [("מוצר זר", "other_company")]
        # …and the save refuses exactly what the pickers leave out or mark.
        assert refused(make, w, kind="item_discount", targets={"categoryIds": [theirs.id]}).detail == PV.TARGET_INVALID
        assert refused(make, w, kind="item_discount", targets={"productIds": [alien.id]}).detail == \
            PV.product_refusal(PV.BLOCK_OTHER_COMPANY)

    def test_the_rules_of_use_change_the_terms_do_not(self, w):
        b = make(w, usesPerVoucher=5)
        out = R.update_prepaid_voucher_batch(
            b["id"], PrepaidVoucherBatchUpdate(stacking="distinct_batches", promotionPolicy="best", maxUsesPerSale=9, maxUsesPerDay=2),
            **_ctx(w),
        )
        # Per sale never more than the voucher has.
        assert (out["stacking"], out["promotionPolicy"], out["maxUsesPerSale"], out["maxUsesPerDay"]) == ("distinct_batches", "best", 5, 2)
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(maxUsesPerDay=None), **_ctx(w))
        assert out["maxUsesPerDay"] is None
        assert "discount_value" not in PrepaidVoucherBatchUpdate.model_fields
        events = [e.details for e in w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "update")]
        assert any("stacking" in (d or {}).get("fields", []) for d in events)

    def test_a_goods_batch_has_only_its_stacking(self, w):
        b = make(w, kind="items")
        out = R.update_prepaid_voucher_batch(
            b["id"], PrepaidVoucherBatchUpdate(stacking="unlimited", promotionPolicy="combine"), **_ctx(w)
        )
        assert out["stacking"] == "unlimited" and out["promotionPolicy"] == "exclude"


# ── Lookup ────────────────────────────────────────────────────────────────────


class TestLookup:
    def test_a_discount_voucher_with_its_terms_and_uses(self, w):
        b = make(w, kind="item_discount", targets={"categoryIds": [w.drinks.id]}, maxUnits=2, usesPerVoucher=4, maxUsesPerSale=2)
        out = lookup(w, codes(w, b)[0])
        assert out["redeemable"] and out["kind"] == "item_discount"
        assert out["benefit"]["value"] == 2000 and out["benefit"]["maxUnits"] == 2
        # A category means it and its sub-categories.
        assert set(out["benefit"]["categoryIds"]) == {str(w.drinks.id), str(w.espresso.id)}
        assert (out["usesLeft"], out["usesAvailable"], out["maxUsesPerSale"]) == (4, 4, 2)
        assert out["stacking"] == "unlimited" and out["maxVouchersPerSale"] is None and out["batchId"] == b["id"]

    def test_a_client_that_cannot_apply_a_discount_is_told_so(self, w):
        b = make(w)
        out = R.lookup_prepaid_voucher(
            str(w.tills[0].id), PrepaidVoucherLookupIn(code=codes(w, b)[0]), machine=w.tills[0], db=w.db
        )
        assert out["redeemable"] is False and out["reason"] == PV.KIND_UNSUPPORTED
        assert "שובר הנחה" in out["message"]
        # …and its redemption is refused the same way.
        body = PrepaidVoucherRedeemIn(
            code=codes(w, b)[0], items=[{"productId": str(w.hotdog.id), "quantity": 1}], clientRequestId="r1"
        )
        e = refused(R.redeem_prepaid_voucher, str(w.tills[0].id), body, machine=w.tills[0], db=w.db)
        assert (e.status_code, e.detail) == (409, PV.KIND_UNSUPPORTED)

    def test_goods_stay_redeemable_for_an_older_client(self, w):
        b = make(w, kind="items")
        out = R.lookup_prepaid_voucher(
            str(w.tills[0].id), PrepaidVoucherLookupIn(code=codes(w, b)[0]), machine=w.tills[0], db=w.db
        )
        assert out["redeemable"] and out["kind"] == "items" and out["benefit"] is None


# ── Reserve / release ─────────────────────────────────────────────────────────


class TestReserve:
    def test_held_for_the_sale_with_the_discount_computed(self, w):
        code = codes(w, make(w))[0]
        out = reserve(w, code, basket(("L1", w.coffee, 2, 24), ("L2", w.sandwich, 1, 40)))
        assert out["amountAgorot"] == 3000 and out["shares"] == {"L1": 1125, "L2": 1875}
        assert out["status"] == "held" and out["uses"] == 1
        expires = datetime.fromisoformat(out["expiresAt"])
        assert timedelta(minutes=14) < expires - datetime.now(timezone.utc) <= PV.RESERVATION_TTL
        # Held, not taken: the voucher still has its use, and the till's own view is redeemable.
        assert voucher_row(w, code).uses_left == 1 and out["voucher"]["redeemable"]

    def test_idempotent_and_renewed_by_its_request_id(self, w):
        code = codes(w, make(w))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        first = reserve(w, code, lines, request_id="req-1")
        w.db.query(PrepaidVoucherReservation).update({"expires_at": datetime.now(timezone.utc) + timedelta(minutes=1)})
        again = reserve(w, code, lines, request_id="req-1")
        assert again["reservationId"] == first["reservationId"] and again["replayed"]
        assert datetime.fromisoformat(again["expiresAt"]) > datetime.now(timezone.utc) + timedelta(minutes=14)
        assert w.db.query(PrepaidVoucherReservation).count() == 1
        other = codes(w, make(w, name="אחר"))[0]
        assert refused(reserve, w, other, lines, request_id="req-1").detail == PV.REQUEST_CONFLICT

    def test_goods_are_redeemed_not_reserved(self, w):
        code = codes(w, make(w, kind="items"))[0]
        assert refused(reserve, w, code, basket(("L1", w.hotdog, 1, 25))).detail == PV.KIND_UNSUPPORTED

    def test_a_kind_the_client_did_not_declare(self, w):
        code = codes(w, make(w))[0]
        e = refused(reserve, w, code, basket(("L1", w.sandwich, 1, 40)), kinds=["items", "item_discount"])
        assert e.detail == PV.KIND_UNSUPPORTED

    def test_held_by_another_sale_then_released(self, w):
        code = codes(w, make(w))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        held = reserve(w, code, lines, sale="a")
        assert refused(reserve, w, code, lines, sale="b", till=w.tills[1]).detail == PV.IN_USE
        assert lookup(w, code, till=w.tills[1])["reason"] == PV.IN_USE
        # Only its own till can release it.
        assert refused(release, w, held["reservationId"], till=w.tills[1]).status_code == 404
        assert release(w, held["reservationId"])["status"] == "released"
        assert release(w, held["reservationId"])["status"] == "released"  # idempotent
        assert reserve(w, code, lines, sale="b", till=w.tills[1])["status"] == "held"
        # A released reservation is not renewed by its request id.
        assert refused(reserve, w, code, lines, sale="a", request_id="x") .status_code == 409

    def test_an_expired_hold_frees_the_voucher(self, w):
        code = codes(w, make(w))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        reserve(w, code, lines, sale="a")
        w.db.query(PrepaidVoucherReservation).update({"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
        assert reserve(w, code, lines, sale="b", till=w.tills[1])["status"] == "held"

    def test_stacking_single(self, w):
        a, b = codes(w, make(w, name="א", stacking="single"))[0], codes(w, make(w, name="ב", stacking="single"))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        reserve(w, a, lines)
        assert refused(reserve, w, b, lines).detail == RULES.NOT_STACKABLE
        # Another sale is another sale.
        assert reserve(w, b, lines, sale="sale-2")["status"] == "held"

    def test_one_discount_voucher_of_a_batch_per_sale_and_the_same_one_once(self, w):
        two = codes(w, make(w, stacking="unlimited"))
        lines = basket(("L1", w.sandwich, 1, 40))
        reserve(w, two[0], lines)
        assert refused(reserve, w, two[1], lines).detail == RULES.SAME_BATCH
        assert refused(reserve, w, two[0], lines).detail == RULES.ALREADY_APPLIED

    def test_a_goods_voucher_already_in_the_sale(self, w):
        goods = codes(w, make(w, kind="items", stacking="single"))[0]
        body = PrepaidVoucherRedeemIn(
            code=goods, items=[{"productId": str(w.hotdog.id), "quantity": 1}], clientRequestId="g1", saleRef="sale-1",
        )
        R.redeem_prepaid_voucher(str(w.tills[0].id), body, machine=w.tills[0], db=w.db)
        discount = codes(w, make(w, stacking="unlimited"))[0]
        e = refused(reserve, w, discount, basket(("L1", w.sandwich, 1, 40)))
        assert e.detail == RULES.OTHER_NOT_STACKABLE
        # …and what the till says it holds counts too (a kiosk order's vouchers).
        free = codes(w, make(w, stacking="unlimited", name="ג"))[0]
        other = {"voucherId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()), "kind": "items", "stacking": "single"}
        assert refused(reserve, w, free, basket(("L1", w.sandwich, 1, 40)), sale="s9", others=[other]).detail == RULES.OTHER_NOT_STACKABLE

    def test_goods_vouchers_of_one_sale_follow_their_stacking(self, w):
        one = codes(w, make(w, kind="items", stacking="single", count=2))
        body = lambda code, rid, sale="s1": PrepaidVoucherRedeemIn(  # noqa: E731
            code=code, items=[{"productId": str(w.hotdog.id), "quantity": 1}], clientRequestId=rid, saleRef=sale,
        )
        R.redeem_prepaid_voucher(str(w.tills[0].id), body(one[0], "1"), machine=w.tills[0], db=w.db)
        e = refused(R.redeem_prepaid_voucher, str(w.tills[0].id), body(one[1], "2"), machine=w.tills[0], db=w.db)
        assert e.detail == RULES.NOT_STACKABLE
        # A batch printed before kinds (the migration made it "unlimited") works as before.
        legacy = make(w, kind="items", stacking="unlimited", count=2)
        two = codes(w, legacy)
        R.redeem_prepaid_voucher(str(w.tills[0].id), body(two[0], "3", "s2"), machine=w.tills[0], db=w.db)
        R.redeem_prepaid_voucher(str(w.tills[0].id), body(two[1], "4", "s2"), machine=w.tills[0], db=w.db)

    def test_one_voucher_a_sale_whatever_the_kind(self, w):
        # "שובר אחד בעסקה" on a goods voucher refuses a discount voucher after it, and the other way round.
        goods = codes(w, make(w, kind="items", stacking="single"))[0]
        redeem_goods(w, goods, "g1", "s1")
        discount = codes(w, make(w, name="ב"))[0]
        assert refused(reserve, w, discount, basket(("L1", w.sandwich, 1, 40)), sale="s1").detail == RULES.OTHER_NOT_STACKABLE

    def test_promotions_per_line_and_the_minimum_on_the_same_base(self, w):
        code = codes(w, make(w, discountType="percent", discountValue=20, minPurchase=50))[0]
        # Without the promoted coffee the base is ₪40: under the ₪50 minimum.
        lines = basket(("L1", w.coffee, 3, 36, 12), ("L2", w.sandwich, 1, 40))
        assert refused(reserve, w, code, lines).detail == RULES.MIN_PURCHASE
        out = reserve(w, code, basket(("L1", w.coffee, 3, 36, 12), ("L2", w.sandwich, 1, 40), ("L3", w.hotdog, 1, 25)))
        assert out["amountAgorot"] == 1300 and "L1" not in out["shares"]
        assert out["skipped"] == [{"lineId": "L1", "reason": "promoted"}]

    def test_item_discount_on_a_sub_category_by_the_cloud_too(self, w):
        code = codes(w, make(w, kind="item_discount", targets={"categoryIds": [w.drinks.id]}, discountType="fixed", discountValue=5))[0]
        out = reserve(w, code, basket(("L1", w.coffee, 2, 24), ("L2", w.sandwich, 1, 40)))
        assert out["amountAgorot"] == 500 and out["shares"] == {"L1": 500}
        assert refused(reserve, w, codes(w, make(w, kind="item_discount", name="z"))[0],
                       basket(("L2", w.sandwich, 1, 40)), sale="s2").detail == RULES.NO_ELIGIBLE

    def test_uses_per_sale_and_per_day(self, w):
        code = codes(w, make(w, discountValue=10, usesPerVoucher=5, maxUsesPerSale=2, maxUsesPerDay=3))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        out = reserve(w, code, lines, uses=4)
        assert out["uses"] == 2 and out["amountAgorot"] == 2000
        confirm(w, out["reservationId"], amount=2000, uses=2)
        # One more today, then the day's limit.
        out = reserve(w, code, lines, sale="s2", uses=2)
        assert out["uses"] == 1
        confirm(w, out["reservationId"], tx="tx-2", amount=1000)
        assert refused(reserve, w, code, lines, sale="s3").detail == PV.DAILY_LIMIT
        assert lookup(w, code)["reason"] == PV.DAILY_LIMIT

    def test_a_used_voucher(self, w):
        code = codes(w, make(w))[0]
        out = reserve(w, code, basket(("L1", w.sandwich, 1, 40)))
        confirm(w, out["reservationId"])
        assert refused(reserve, w, code, basket(("L1", w.sandwich, 1, 40)), sale="s2").detail == PV.USED

    def test_the_hold_is_taken_under_the_voucher_lock(self, w, monkeypatch):
        locks = []
        original = PV._locate

        def spy(db, machine, raw_code, *, lock):
            locks.append(lock)
            return original(db, machine, raw_code, lock=lock)

        monkeypatch.setattr(PV, "_locate", spy)
        reserve(w, codes(w, make(w))[0], basket(("L1", w.sandwich, 1, 40)))
        assert locks == [True]


# ── Confirm ───────────────────────────────────────────────────────────────────


class TestConfirm:
    def test_takes_the_use_and_records_it(self, w):
        code = codes(w, make(w, usesPerVoucher=2))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 40)))
        out = confirm(w, held["reservationId"], tx="tx-9", amount=3000)
        assert out["status"] == "confirmed" and out["flags"] == []
        v = voucher_row(w, code)
        assert (v.uses_left, v.status) == (1, "partially_used")
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.uses, r.discount_amount, r.transaction_id, r.items) == (1, 3000, "tx-9", [])
        # Idempotent; another document for the same reservation is refused.
        assert confirm(w, held["reservationId"], tx="tx-9", amount=3000)["replayed"]
        assert w.db.query(PrepaidVoucherRedemption).count() == 1
        assert refused(confirm, w, held["reservationId"], tx="tx-10").detail == PV.RESERVATION_CONFLICT
        # A confirmed one is not released.
        assert release(w, held["reservationId"])["status"] == "confirmed"

    def test_late_and_over_the_last_use_is_recorded_and_flagged(self, w):
        code = codes(w, make(w))[0]
        lines = basket(("L1", w.sandwich, 1, 40))
        first = reserve(w, code, lines, sale="a")
        # The till lost the cloud; the hold expired; another till took the voucher.
        w.db.query(PrepaidVoucherReservation).update({"expires_at": datetime.now(timezone.utc) - timedelta(minutes=1)})
        second = reserve(w, code, lines, sale="b", till=w.tills[1])
        confirm(w, second["reservationId"], tx="tx-b", till=w.tills[1])
        # The first till's sale was written offline: it still confirms, flagged.
        out = confirm(w, first["reservationId"], tx="tx-a")
        assert out["status"] == "confirmed" and set(out["flags"]) == {"late", "over_use"}
        assert voucher_row(w, code).uses_left == 0
        flagged = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "use_flagged").one()
        assert set(flagged.details["flags"]) == {"late", "over_use"}

    def test_a_released_one_confirmed_by_its_sale_is_late(self, w):
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 40)))
        release(w, held["reservationId"])
        assert confirm(w, held["reservationId"])["flags"] == ["late"]


# ── The document (the outbox path) and the accounting ────────────────────────


def _doc(w, shift, *, reservation, voucher_share="30.00", promo="0", number="7001", doc_type=320, refund_of=None):
    item_id = str(uuid.uuid4())
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": doc_type,
        "totalAmount": "64.00", "documentDiscount": str(Decimal(voucher_share) + Decimal(promo)),
        "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash",
                      "amount": str(Decimal("64.00") - Decimal(voucher_share) - Decimal(promo))}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        **({"refundOfTransactionId": refund_of} if refund_of else {}),
        "items": [{
            "id": item_id, "productName": "כריך", "quantity": 1, "unitPrice": "64.00", "totalPrice": "64.00",
            "voucherDiscount": voucher_share, "promotionDiscount": promo,
        }],
        "voucherDiscounts": [{
            "reservationId": reservation, "voucherId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()),
            "serial": 12, "batchName": "פסטיבל הקיץ", "kind": "order_discount", "uses": 1,
            "amount": voucher_share, "lines": [{"itemId": item_id, "amount": voucher_share}],
        }],
    })


class TestDocument:
    def test_the_document_confirms_through_the_outbox(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 64)))
        doc = _doc(w, shift, reservation=held["reservationId"])
        assert [r.status for r in upsert_transactions(w.db, till, [doc])] == ["accepted"]
        upsert_transactions(w.db, till, [doc])  # a re-push replaces, never doubles
        w.db.commit()
        assert w.db.query(TransactionVoucherDiscount).count() == 1
        assert w.db.query(PrepaidVoucherRedemption).count() == 1
        r = w.db.query(PrepaidVoucherReservation).one()
        assert (r.status, r.transaction_id) == ("confirmed", str(doc.id))
        assert voucher_row(w, code).status == "used"
        assert w.db.query(TransactionItem).one().voucher_discount == Decimal("30.00")

    def test_the_explicit_confirm_then_the_document(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 64)))
        doc = _doc(w, shift, reservation=held["reservationId"], voucher_share="25.00")
        confirm(w, held["reservationId"], tx=str(doc.id), amount=3000)
        upsert_transactions(w.db, till, [doc])
        w.db.commit()
        # One use, the amount as the document says.
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.uses, r.discount_amount) == (1, 2500)

    def test_a_promotion_on_the_discounted_line_is_flagged(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 64)))
        upsert_transactions(w.db, till, [_doc(w, shift, reservation=held["reservationId"], promo="5.00")])
        w.db.commit()
        assert w.db.query(PrepaidVoucherRedemption).one().flags == ["promotion"]

    def test_an_unknown_reservation_never_refuses_the_document(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        out = upsert_transactions(w.db, till, [_doc(w, shift, reservation=str(uuid.uuid4()))])
        assert out[0].status == "accepted"
        assert any("voucherDiscounts[0]" in x for x in (out[0].warnings or []))

    def test_a_credit_note_gives_no_use_back_and_confirms_nothing(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 64)))
        upsert_transactions(w.db, till, [_doc(w, shift, reservation=held["reservationId"], doc_type=330, number="9001")])
        w.db.commit()
        assert w.db.query(PrepaidVoucherRedemption).count() == 0

    def test_a_card_still_waiting_or_declined_confirms_nothing_until_it_is_a_sale(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        code = codes(w, make(w))[0]
        held = reserve(w, code, basket(("L1", w.sandwich, 1, 64)))
        doc = _doc(w, shift, reservation=held["reservationId"])
        for status in ("pending", "cancelled"):
            doc.status = status
            upsert_transactions(w.db, till, [doc])
            w.db.commit()
            assert w.db.query(PrepaidVoucherRedemption).count() == 0
        # The card approved: the re-push as completed confirms it.
        doc.status = "completed"
        upsert_transactions(w.db, till, [doc])
        w.db.commit()
        assert w.db.query(PrepaidVoucherRedemption).count() == 1

    def test_the_z_counts_a_discount_never_a_tender(self, w):
        from app.models.z_report import ZReport
        from app.services.z_print import _sales_rows

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        held = reserve(w, codes(w, make(w))[0], basket(("L1", w.sandwich, 1, 64)))
        upsert_transactions(w.db, till, [_doc(w, shift, reservation=held["reservationId"])])
        w.db.commit()
        totals = compute_totals(w.db, [shift.id])
        assert totals.voucher_discounts_total == Decimal("30.00")
        assert totals.discounts_total == Decimal("30.00")
        assert totals.total_sales == Decimal("34.00")
        assert set(totals.payment_breakdown) == {"cash"}
        z = ZReport(total_sales=Decimal("34.00"), total_refunds=Decimal("0"), discounts_total=Decimal("30.00"),
                    transactions_count=1, header={"voucherDiscountsTotal": "30.00"})
        assert "הנחות שוברים (כלולות)" in [r["label"] for r in _sales_rows(z) if r]

    def test_the_document_copy_names_the_voucher(self, w):
        from app.services.print_documents import build_invoice_copy

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        held = reserve(w, codes(w, make(w))[0], basket(("L1", w.sandwich, 1, 64)))
        upsert_transactions(w.db, till, [_doc(w, shift, reservation=held["reservationId"])])
        w.db.commit()
        printed = build_invoice_copy(w.db, w.db.query(Transaction).one()).model_dump_json()
        assert "שובר #12 — פסטיבל הקיץ" in printed

    def test_the_discounts_report_and_no_cashier_exception(self, w):
        from app.services import exceptions as E
        from app.services.discounts_report import build_discounts_report
        from app.services.reports import resolve_report_window

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        held = reserve(w, codes(w, make(w))[0], basket(("L1", w.sandwich, 1, 64)))
        upsert_transactions(w.db, till, [_doc(w, shift, reservation=held["reservationId"])])
        w.db.commit()
        window = resolve_report_window(w.db, w.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1))
        out = build_discounts_report(w.db, w.admin, w.tenant.id, window)["vouchers"]
        assert out["totals"] == {"count": 1, "uses": 1, "amount": 30.0, "documents": 1}
        assert [(r["name"], r["amount"]) for r in out["byBatch"]] == [("פסטיבל הקיץ", 30.0)]
        assert [r["name"] for r in out["byTill"]] == [till.name] and len(out["byDay"]) == 1
        tx = w.db.query(Transaction).one()
        rules = {"discount": E.EffectiveRule(type="discount", enabled=True, params={"minPercent": 0, "minAmount": 0})}
        assert not [f for f in E.detect_transaction(tx, rules) if f.type == "discount"]


# ── The batch's usage, the PDF ────────────────────────────────────────────────


class TestUsageAndPaper:
    def test_issued_used_remaining_void_and_the_benefit(self, w):
        from app.services import prepaid_voucher_reports as PVR

        b = make(w, usesPerVoucher=2, maxUsesPerSale=2, count=3)
        c = codes(w, b)
        held = reserve(w, c[0], basket(("L1", w.sandwich, 1, 80)), uses=2)
        confirm(w, held["reservationId"], amount=6000, uses=2)
        reserve(w, c[1], basket(("L1", w.sandwich, 1, 80)), sale="s2")
        R.cancel_prepaid_voucher(R.list_prepaid_vouchers(b["id"], status_filter=None, serial=3, limit=1, offset=0, **_ctx(w))["items"][0]["id"], **_ctx(w))
        out = PVR.batch_report(w.db, w.admin, w.tenant.id, b["id"])
        assert out["usage"] == {
            "unit": "uses", "issued": 6, "used": 2, "remaining": 2, "void": 2, "benefit": 60.0, "flagged": 0, "held": 1,
        }
        assert out["totals"] == {"redemptions": 1, "vouchers": 1, "units": 2, "amount": 60.0}

    def test_the_paper_says_what_it_gives(self, w):
        from app.services import prepaid_voucher_pdf as PDF

        b = make(w, kind="item_discount", usesPerVoucher=3)
        batch = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        vouchers = w.db.query(PrepaidVoucher).all()
        assert PDF.terms_line(batch) == "3 שימושים"
        per, total = PDF.cover_contents(batch, 2)
        assert (per, total) == ("20% הנחה על קפה", "2 שוברי הנחה")
        data = PDF.render_pdf(batch, vouchers, PDF.geometry("ticket80x50"), logo=None, opts=PDF.options_for(batch))
        assert data[:4] == b"%PDF"
        csv_text = PDF.manifest_csv(batch, vouchers).decode("utf-8")
        assert "3/3 שימושים" in csv_text


def test_the_migration_is_the_single_head_on_the_till_design_merge():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    # absolute(), not resolve(): a subst'ed drive resolves to a path past MAX_PATH on the dev box.
    root = pathlib.Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    # One head, with this migration on the line to it (later ones chain on top — e9a3c7f1b5d2).
    heads = script.get_heads()
    assert len(heads) == 1
    assert "c7e2f4a9d1b6" in {r.revision for r in script.iterate_revisions(heads[0], "base")}
    assert script.get_revision("c7e2f4a9d1b6").down_revision == "b4a16fe43e9d"


# ── "מספר שוברים מקסימלי בעסקה" ──────────────────────────────────────────────


def redeem_goods(w, code, request_id, sale, till=None):
    till = till or w.tills[0]
    body = PrepaidVoucherRedeemIn(
        code=code, items=[{"productId": str(w.hotdog.id), "quantity": 1}], clientRequestId=request_id, saleRef=sale,
    )
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


class TestVouchersPerSale:
    """The owner: "שובר אחד בעסקה" / "כמה שוברים בעסקה", and with many an optional maximum."""

    def test_the_maximum_is_stored_and_reaches_the_till(self, w):
        b = make(w, kind="items", count=3, maxVouchersPerSale=2)
        assert (b["stacking"], b["maxVouchersPerSale"]) == ("unlimited", 2)
        assert lookup(w, codes(w, b)[0])["maxVouchersPerSale"] == 2
        assert w.db.query(PrepaidVoucherBatch).one().max_vouchers_per_sale == 2

    def test_one_voucher_a_sale_has_no_maximum(self, w):
        b = make(w, kind="items", stacking="single", maxVouchersPerSale=4)
        assert (b["stacking"], b["maxVouchersPerSale"]) == ("single", None)
        assert lookup(w, codes(w, b)[0])["maxVouchersPerSale"] is None

    @pytest.mark.parametrize("n", [0, -1, 51])
    def test_a_maximum_out_of_range_is_refused(self, w, n):
        with pytest.raises(ValueError):
            PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, kind="items",
                                      items=[{"productId": w.hotdog.id, "quantity": 1}], maxVouchersPerSale=n)

    def test_the_goods_vouchers_of_one_sale_up_to_the_maximum(self, w):
        three = codes(w, make(w, kind="items", count=4, maxVouchersPerSale=2, splitAllowed=True,
                             items=[{"productId": w.hotdog.id, "quantity": 2}]))
        redeem_goods(w, three[0], "1", "s1")
        redeem_goods(w, three[1], "2", "s1")
        e = refused(redeem_goods, w, three[2], "3", "s1")
        assert e.detail == RULES.MAX_PER_SALE
        assert RULES.stacking_text(e.detail, 2) == "הגעת למספר השוברים המקסימלי בעסקה (2)"
        # The rest of a voucher already in the sale is not another voucher …
        redeem_goods(w, three[0], "1b", "s1")
        # … and another sale is another sale.
        redeem_goods(w, three[2], "4", "s2")

    def test_another_vouchers_maximum_counts_too(self, w):
        capped = codes(w, make(w, kind="items", name="א", maxVouchersPerSale=2))[0]
        free = codes(w, make(w, kind="items", name="ב", count=3))
        redeem_goods(w, capped, "1", "s1")
        redeem_goods(w, free[0], "2", "s1")
        assert refused(redeem_goods, w, free[1], "3", "s1").detail == RULES.MAX_PER_SALE

    def test_a_discount_voucher_counts_against_the_maximum(self, w):
        goods = codes(w, make(w, kind="items", name="א", count=2, maxVouchersPerSale=2))
        redeem_goods(w, goods[0], "1", "s1")
        redeem_goods(w, goods[1], "2", "s1")
        discount = codes(w, make(w, name="ב"))[0]
        assert refused(reserve, w, discount, basket(("L1", w.sandwich, 1, 40)), sale="s1").detail == RULES.MAX_PER_SALE

    def test_what_the_till_says_it_holds_counts(self, w):
        discount = codes(w, make(w))[0]
        held = [{"voucherId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()), "kind": "items", "stacking": "unlimited",
                 "maxVouchersPerSale": 1}]
        e = refused(reserve, w, discount, basket(("L1", w.sandwich, 1, 40)), sale="s9", others=held)
        assert e.detail == RULES.MAX_PER_SALE
        # An older till sends no maximum: nothing to honour.
        held[0].pop("maxVouchersPerSale")
        assert reserve(w, discount, basket(("L1", w.sandwich, 1, 40)), sale="s9", others=held)["status"] == "held"

    def test_it_changes_after_issue_and_one_a_sale_clears_it(self, w):
        b = make(w, kind="items")
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(maxVouchersPerSale=3), **_ctx(w))
        assert out["maxVouchersPerSale"] == 3
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(stacking="single"), **_ctx(w))
        assert (out["stacking"], out["maxVouchersPerSale"]) == ("single", None)
        assert w.db.query(PrepaidVoucherBatch).one().max_vouchers_per_sale is None
        R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(stacking="unlimited", maxVouchersPerSale=2), **_ctx(w))
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(maxVouchersPerSale=None), **_ctx(w))
        assert (out["stacking"], out["maxVouchersPerSale"]) == ("unlimited", None)

    def test_the_sale_is_locked_before_the_voucher(self, w, monkeypatch):
        """Atomic per sale: on Postgres a transaction lock keyed by the till and the sale."""
        calls = []

        class Bind:
            class dialect:
                name = "postgresql"

        class Db:
            def get_bind(self):
                return Bind()

            def execute(self, stmt, params):
                calls.append((str(stmt), params))

        PV._lock_sale(Db(), w.tills[0], "sale-1")
        PV._lock_sale(Db(), w.tills[0], "sale-1")
        PV._lock_sale(Db(), w.tills[0], "sale-2")
        PV._lock_sale(Db(), w.tills[0], "  ")
        assert [c[0] for c in calls] == ["SELECT pg_advisory_xact_lock(:key)"] * 3
        assert calls[0][1] == calls[1][1] != calls[2][1]
        # SQLite (the tests' world): nothing to lock.
        PV._lock_sale(w.db, w.tills[0], "sale-1")
