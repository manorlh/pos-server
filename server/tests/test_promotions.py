"""
Promotions ("מבצעים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1): defined in the cloud,
pulled by the tills, computed on the till.

What each class pins:

* **Config** — every type's parameters are validated and normalized; a group must name
  something; the threshold types count the whole basket unless told otherwise.
* **Writes and scope** — the catalog roles write; every scope entry must be one the
  writer manages, and only an admin writes for the whole organization; references are
  the tenant's own.
* **List** — a promotion is listed to whoever sees a shop it reaches, with its status
  and whether they may edit it; duplicate makes a paused copy; pause is idempotent.
* **The till's pull** — what reaches the till (its own id, area, shop, company group),
  paused and ended left out, categories expanded to sub-categories, the ETag answer.
* **Documents** — a document's promotions and its lines' shares are stored, a re-push
  replaces them, and the shift totals, the Z, the report and the exceptions read them.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.category import Category
from app.models.product import Product
from app.models.promotion import Promotion, TransactionPromotion
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.transaction_item import TransactionItem
from app.models.z_report import ZReport
from app.routers import promotions as R
from app.schemas.promotion import PromotionConfigError, PromotionIn, clean_config
from app.schemas.transaction import TransactionIn
from app.services import promotions as P
from app.services.reports import resolve_report_window
from app.services.shift_totals import compute_totals
from app.services.transactions import upsert_transactions
from app.services.z_print import _sales_rows
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


@pytest.fixture
def cat(w):
    """Drinks › Soft drinks, and a product in each."""
    drinks = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Drinks")
    w.db.add(drinks)
    w.db.flush()
    soft = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Soft", parent_id=drinks.id)
    w.db.add(soft)
    w.db.flush()

    def product(name, category, price):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=category.id,
            name=name, price=Decimal(price), sku=f"sku-{name}",
        )
        w.db.add(p)
        return p

    w.cola = product("cola", soft, "12.00")
    w.beer = product("beer", drinks, "20.00")
    w.drinks, w.soft = drinks, soft
    w.db.commit()
    return w


def body(**over):
    base = {
        "name": "1+1 שתייה",
        "type": "buy_x_get_y",
        "config": {"target": {"all": True}, "buyQuantity": 1, "getQuantity": 1},
        "scopes": [],
    }
    base.update(over)
    return PromotionIn.model_validate(base)


def drinks_body(w, **over):
    return body(config={"target": {"categoryIds": [str(w.drinks.id)]}, "buyQuantity": 1, "getQuantity": 1}, **over)


def create(w, b, user=None):
    tasks = BackgroundTasks()
    out = R.create_promotion(b, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def pull(w, till, etag=None):
    return R.get_own_promotions(str(till.id), etag=etag, machine=till, db=w.db)


class TestConfig:
    def test_buy_x_get_y_defaults_to_free(self):
        out = clean_config("buy_x_get_y", {"target": {"productIds": [str(uuid.uuid4())]}, "buyQuantity": 2, "getQuantity": 1})
        assert out["getDiscountPercent"] == 100.0
        assert out["target"]["all"] is False

    def test_a_group_must_name_something(self):
        with pytest.raises(PromotionConfigError):
            clean_config("discount", {"target": {}, "discountKind": "percent", "discountValue": 10})

    def test_every_type_validates(self):
        pid = str(uuid.uuid4())
        group = {"productIds": [pid]}
        assert clean_config("bundle_price", {"target": group, "quantity": 3, "price": "20"})["price"] == 20.0
        assert clean_config("discount", {"target": group, "discountKind": "amount", "discountValue": 5})["discountValue"] == 5.0
        gift = clean_config("threshold_gift", {"threshold": 100, "giftProductId": pid})
        assert gift["counted"]["all"] is True and gift["giftQuantity"] == 1
        item = clean_config("threshold_item_price", {"threshold": 100, "reward": group, "specialPrice": 5})
        assert item["counted"]["all"] is True
        basket = clean_config("threshold_basket_discount", {"threshold": 200, "discountKind": "percent", "discountValue": 10})
        assert basket["discountKind"] == "percent"
        combo = clean_config("combo", {"components": [{"group": group}, {"group": {"categoryIds": [pid]}, "quantity": 2}], "price": 30})
        assert [c["quantity"] for c in combo["components"]] == [1, 2]

    @pytest.mark.parametrize("promo_type, config", [
        ("bundle_price", {"target": {"all": True}, "quantity": 1, "price": 10}),
        ("discount", {"target": {"all": True}, "discountKind": "percent", "discountValue": 120}),
        ("discount", {"target": {"all": True}, "discountKind": "x", "discountValue": 1}),
        ("threshold_gift", {"threshold": 0, "giftProductId": str(uuid.uuid4())}),
        ("threshold_gift", {"threshold": 100}),
        ("combo", {"components": [{"group": {"all": True}}], "price": 10}),
        ("buy_x_get_y", {"target": {"productIds": ["nope"]}, "buyQuantity": 1, "getQuantity": 1}),
    ])
    def test_bad_configs_are_refused(self, promo_type, config):
        with pytest.raises(PromotionConfigError):
            clean_config(promo_type, config)

    def test_the_body(self):
        with pytest.raises(ValidationError):
            body(startTime="10:00")
        with pytest.raises(ValidationError):
            body(validFrom="2026-10-10", validTo="2026-10-01")
        assert body(weekdays=[0, 1, 2, 3, 4, 5, 6]).weekdays is None
        assert body(weekdays=[5, 4, 4]).weekdays == [4, 5]
        # A window may cross midnight.
        assert body(startTime="22:00", endTime="02:00").end_time == "02:00"


class TestWritesAndScope:
    def test_an_admin_writes_for_the_whole_organization(self, cat):
        out = create(cat, drinks_body(cat))
        assert out["status"] == "active" and out["canEdit"] is True and out["scopes"] == []
        assert ("%s" % cat.tills[0].id, P.NOTIFY_REASON) in cat.notified

    def test_a_shop_manager_writes_for_their_shop_only(self, cat):
        assert refused(create, cat, drinks_body(cat), cat.manager).detail == P.WHOLE_ORG_FORBIDDEN
        foreign = drinks_body(cat, scopes=[{"type": "shop", "id": str(cat.other_shop.id)}])
        assert refused(create, cat, foreign, cat.manager).detail == P.SCOPE_FORBIDDEN
        own = create(cat, drinks_body(cat, scopes=[{"type": "shop", "id": str(cat.shop.id)}]), cat.manager)
        assert own["scopes"][0]["name"] == "Center"

    def test_a_cashier_writes_nothing(self, cat):
        mine = drinks_body(cat, scopes=[{"type": "shop", "id": str(cat.shop.id)}])
        assert refused(create, cat, mine, cat.cashier).detail == P.FORBIDDEN

    def test_references_are_the_tenants(self, cat):
        stranger = body(config={"target": {"productIds": [str(uuid.uuid4())]}, "buyQuantity": 1, "getQuantity": 1})
        assert refused(create, cat, stranger).detail == P.UNKNOWN_PRODUCT
        nowhere = body(config={"target": {"categoryIds": [str(uuid.uuid4())]}, "buyQuantity": 1, "getQuantity": 1})
        assert refused(create, cat, nowhere).detail == P.UNKNOWN_CATEGORY

    def test_an_unknown_scope_is_refused(self, cat):
        b = drinks_body(cat, scopes=[{"type": "shop", "id": str(uuid.uuid4())}])
        assert refused(create, cat, b).detail == P.SCOPE_NOT_FOUND

    def test_update_pause_duplicate_delete(self, cat):
        out = create(cat, drinks_body(cat))
        tasks = BackgroundTasks()
        upd = R.update_promotion(out["id"], drinks_body(cat, name="2+1", priority=5), tasks, **_ctx(cat))
        assert (upd["name"], upd["priority"]) == ("2+1", 5)
        paused = R.pause_promotion(out["id"], R.PromotionPauseIn(paused=True), BackgroundTasks(), **_ctx(cat))
        assert paused["status"] == "paused"
        again = R.pause_promotion(out["id"], R.PromotionPauseIn(paused=True), BackgroundTasks(), **_ctx(cat))
        assert again["status"] == "paused"
        copy = R.duplicate_promotion(out["id"], **_ctx(cat))
        assert copy["name"] == "2+1 (עותק)" and copy["isPaused"] is True and copy["id"] != out["id"]
        R.delete_promotion(out["id"], BackgroundTasks(), **_ctx(cat))
        assert cat.db.get(Promotion, uuid.UUID(out["id"])) is None


class TestList:
    def test_status(self, cat):
        today = P.tenant_today(cat.db, cat.tenant.id)
        create(cat, drinks_body(cat, name="later", validFrom=str(today + timedelta(days=3))))
        create(cat, drinks_body(cat, name="over", validTo=str(today - timedelta(days=3))))
        create(cat, drinks_body(cat, name="now"))
        create(cat, drinks_body(cat, name="held", isPaused=True))
        out = R.list_promotions(search=None, status_filter=None, **_ctx(cat))
        assert {i["name"]: i["status"] for i in out["items"]} == {
            "later": "scheduled", "over": "ended", "now": "active", "held": "paused",
        }
        assert out["counts"] == {"active": 1, "scheduled": 1, "ended": 1, "paused": 1}
        only = R.list_promotions(search="ov", status_filter=None, **_ctx(cat))
        assert [i["name"] for i in only["items"]] == ["over"]
        assert [i["name"] for i in R.list_promotions(search=None, status_filter="paused", **_ctx(cat))["items"]] == ["held"]

    def test_listed_to_whoever_sees_a_shop_it_reaches(self, cat):
        create(cat, drinks_body(cat, name="center", scopes=[{"type": "shop", "id": str(cat.shop.id)}]))
        create(cat, drinks_body(cat, name="everywhere"))
        north = R.list_promotions(search=None, status_filter=None, **_ctx(cat, cat.north_manager))
        assert {i["name"]: i["canEdit"] for i in north["items"]} == {"everywhere": False}
        center = R.list_promotions(search=None, status_filter=None, **_ctx(cat, cat.manager))
        assert {i["name"]: i["canEdit"] for i in center["items"]} == {"center": True, "everywhere": False}


class TestTheTillsPull:
    def test_what_reaches_a_till(self, cat):
        area = ShopArea(id=uuid.uuid4(), tenant_id=cat.tenant.id, shop_id=cat.shop.id, name="Bar")
        cat.db.add(area)
        cat.db.flush()
        cat.tills[0].area_id = area.id
        cat.db.commit()
        create(cat, drinks_body(cat, name="org"))
        create(cat, drinks_body(cat, name="company", scopes=[{"type": "company", "id": str(cat.company.id)}]))
        create(cat, drinks_body(cat, name="center", scopes=[{"type": "shop", "id": str(cat.shop.id)}]))
        create(cat, drinks_body(cat, name="bar", scopes=[{"type": "area", "id": str(area.id)}]))
        create(cat, drinks_body(cat, name="till2", scopes=[{"type": "machine", "id": str(cat.tills[1].id)}]))
        create(cat, drinks_body(cat, name="paused", isPaused=True))
        create(cat, drinks_body(cat, name="over", validTo=str(TODAY - timedelta(days=30))))

        def names(till):
            return sorted(p["name"] for p in pull(cat, till)["promotions"])

        assert names(cat.tills[0]) == ["bar", "center", "company", "org"]
        assert names(cat.tills[1]) == ["center", "company", "org", "till2"]
        assert names(cat.other_till) == ["company", "org"]

    def test_categories_reach_their_sub_categories(self, cat):
        create(cat, drinks_body(cat))
        promo = pull(cat, cat.tills[0])["promotions"][0]
        assert set(promo["config"]["target"]["categoryIds"]) == {str(cat.drinks.id), str(cat.soft.id)}
        # What is stored is what was chosen.
        stored = cat.db.query(Promotion).one()
        assert stored.config["target"]["categoryIds"] == [str(cat.drinks.id)]

    def test_threshold_types_apply_once_unless_told(self, cat):
        create(cat, body(
            name="gift", type="threshold_gift",
            config={"threshold": 100, "giftProductId": str(cat.cola.id)},
        ))
        create(cat, body(
            name="every 100", type="threshold_gift", maxApplications=3,
            config={"threshold": 100, "giftProductId": str(cat.cola.id)},
        ))
        got = {p["name"]: p["maxApplications"] for p in pull(cat, cat.tills[0])["promotions"]}
        assert got == {"gift": 1, "every 100": 3}

    def test_priority_first_and_the_etag(self, cat):
        create(cat, drinks_body(cat, name="b"))
        create(cat, drinks_body(cat, name="a", priority=10))
        first = pull(cat, cat.tills[0])
        assert first["syncType"] == "full" and [p["name"] for p in first["promotions"]] == ["a", "b"]
        same = pull(cat, cat.tills[0], etag=first["etag"])
        assert same["syncType"] == "unchanged" and same["promotions"] == []
        create(cat, drinks_body(cat, name="c"))
        changed = pull(cat, cat.tills[0], etag=first["etag"])
        assert changed["syncType"] == "full" and changed["etag"] != first["etag"]


def _sale(w, till, shift, *, promo_id, number="5001", total="24.00"):
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed",
        "documentType": 320,
        "totalAmount": total, "documentDiscount": "12.00", "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": "12.00"}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": [{
            "id": str(uuid.uuid4()), "productName": "cola", "quantity": 2, "unitPrice": "12.00",
            "totalPrice": "24.00", "promotionDiscount": "12.00", "promotionId": str(promo_id),
        }],
        "promotions": [{"promotionId": str(promo_id), "name": "1+1 שתייה", "type": "buy_x_get_y",
                        "applications": 1, "discount": "12.00"}],
    })


class TestDocuments:
    def test_stored_replaced_and_counted(self, cat):
        till = cat.tills[0]
        shift = cat.shift(till, 1, status=ShiftStatus.OPEN)
        promo_id = uuid.uuid4()
        doc = _sale(cat, till, shift, promo_id=promo_id)
        assert [r.status for r in upsert_transactions(cat.db, till, [doc])] == ["accepted"]
        upsert_transactions(cat.db, till, [doc])  # a re-push replaces, never doubles
        rows = cat.db.query(TransactionPromotion).all()
        assert [(r.promotion_name, r.applications, r.discount_amount) for r in rows] == [
            ("1+1 שתייה", 1, Decimal("12.00"))
        ]
        item = cat.db.query(TransactionItem).one()
        assert (item.promotion_discount, item.promotion_id) == (Decimal("12.00"), promo_id)

        totals = compute_totals(cat.db, [shift.id])
        assert totals.promotion_discounts_total == Decimal("12.00")
        assert totals.line_discounts_total == Decimal("0")
        assert totals.discounts_total == Decimal("12.00")

    def test_an_unreadable_promotion_id_is_dropped_not_refused(self, cat):
        till = cat.tills[0]
        shift = cat.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _sale(cat, till, shift, promo_id=uuid.uuid4())
        doc.items[0].promotion_id = "p-12"
        doc.promotions[0].promotion_id = "p-12"
        assert [r.status for r in upsert_transactions(cat.db, till, [doc])] == ["accepted"]
        assert cat.db.query(TransactionItem).one().promotion_id is None
        assert cat.db.query(TransactionPromotion).one().promotion_id is None

    def test_the_document_copy_names_each_promotion(self, cat):
        from app.models.transaction import Transaction
        from app.services.print_documents import build_invoice_copy

        till = cat.tills[0]
        shift = cat.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(cat.db, till, [_sale(cat, till, shift, promo_id=uuid.uuid4())])
        tx = cat.db.query(Transaction).one()
        printed = build_invoice_copy(cat.db, tx).model_dump_json()
        assert "הנחת מבצע: 1+1 שתייה" in printed

    def test_the_z_prints_them_apart(self):
        z = ZReport(total_sales=Decimal("88.00"), total_refunds=Decimal("0"), discounts_total=Decimal("12.00"),
                    transactions_count=1, header={"promotionDiscountsTotal": "12.00"})
        labels = [r["label"] for r in _sales_rows(z) if r]
        assert "הנחות מבצעים (כלולות)" in labels

    def test_the_report(self, cat):
        till = cat.tills[0]
        shift = cat.shift(till, 1, status=ShiftStatus.OPEN)
        promo = create(cat, drinks_body(cat))
        upsert_transactions(cat.db, till, [_sale(cat, till, shift, promo_id=promo["id"])])
        upsert_transactions(cat.db, till, [_sale(cat, till, shift, promo_id=promo["id"], number="5002")])
        window = resolve_report_window(cat.db, cat.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1))
        out = P.build_promotions_report(cat.db, cat.admin, cat.tenant.id, window)
        assert out["totals"] == {"applications": 2, "documents": 2, "discount": 24.0}
        assert [(r["name"], r["discount"]) for r in out["byPromotion"]] == [("1+1 שתייה", 24.0)]
        assert [(r["name"], r["documents"]) for r in out["byShop"]] == [("Center", 2)]
        assert [r["name"] for r in out["byTill"]] == [till.name]
        assert len(out["byDay"]) == 1
        # Someone who sees no shop of it sees nothing of it.
        north = P.build_promotions_report(cat.db, cat.north_manager, cat.tenant.id, window)
        assert north["totals"]["documents"] == 0

    def test_promotions_are_not_a_cashier_discount(self, cat):
        from app.services import exceptions as E

        till = cat.tills[0]
        shift = cat.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(cat.db, till, [_sale(cat, till, shift, promo_id=uuid.uuid4())])
        from app.models.transaction import Transaction

        tx = cat.db.query(Transaction).one()
        rules = {"discount": E.EffectiveRule(type="discount", enabled=True, params={"minPercent": 0, "minAmount": 0})}
        assert not [f for f in E.detect_transaction(tx, rules) if f.type == "discount"]
        # A cashier's own line discount on top still is one.
        cat.db.query(TransactionItem).update({TransactionItem.discount: Decimal("2.00")})
        tx.document_discount = Decimal("14.00")
        cat.db.commit()
        cat.db.refresh(tx)
        hits = [f for f in E.detect_transaction(tx, rules) if f.type == "discount"]
        assert [h.amount for h in hits] == [Decimal("2.00")]
