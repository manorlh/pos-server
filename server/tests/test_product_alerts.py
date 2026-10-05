"""
"הודעות לעובד על פריט" and "פריטים נלווים" (app/services/product_alerts.py).

What each class pins:

* **Schemas** — an alert's text (1–200), kind, "חובה לאשר" and where it is shown; at most
  ten alerts; a companion's quantity, price mode and price (a set price only for
  "מחיר מותאם", required there); no product twice; the update leaves both alone unless
  sent, and never hands them to `model_dump` as plain columns.
* **Allergen text** — the allergen codes in Hebrew, in the fixed order, unknown ones
  dropped; none — no text.
* **Router** — create and update store them in the wire's keys, `[]` clears, an unsent
  field is left as it is; a companion must be another product of the same organization
  and not the general item.
* **Sync** — both catalog serialisers carry them, from the global row; a product that
  never set any carries empty lists, the allergen alert off and confirmation on.
* **Ack** — the till's acknowledgement is stored on the sold line, from the line or from
  its details, cleaned and bounded; a line without one stores none.
* **Parameter** — `productAlertsEnabled` is built in and on by default.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.models.category import Category
from app.models.product import Product
from app.models.shift import ShiftStatus
from app.models.tenant import Tenant
from app.models.transaction_item import TransactionItem
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.schemas.transaction import TransactionIn
from app.services import product_alerts as PA
from app.services.sync import _serialize_merged_product, _serialize_product
from app.services.till_parameters import ensure_builtin_parameters, till_parameters_for_machine
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_product_weighed import _product
from test_shop_areas import w  # noqa: F401

BASE = {"name": "קולה", "price": "8.00", "sku": "C-1", "categoryId": str(uuid.uuid4())}


class TestSchemas:
    def test_an_alert_and_its_defaults(self):
        p = ProductCreate.model_validate({**BASE, "alerts": [{"text": "  מכיל ביצים — תעדכן לקוח!  "}]})
        a = p.alerts[0]
        assert (a.text, a.kind, a.require_ack, a.where_shown) == ("מכיל ביצים — תעדכן לקוח!", "info", False, "both")
        full = ProductCreate.model_validate({
            **BASE,
            "alerts": [{"text": "חריף!", "kind": "warning", "requireAck": True, "whereShown": "tables"}],
        }).alerts[0]
        assert (full.kind, full.require_ack, full.where_shown) == ("warning", True, "tables")

    @pytest.mark.parametrize("alert", [
        {"text": ""},
        {"text": "   "},
        {"text": "x" * 201},
        {"text": "ok", "kind": "danger"},
        {"text": "ok", "whereShown": "kitchen"},
    ])
    def test_a_bad_alert_is_refused(self, alert):
        with pytest.raises(ValidationError):
            ProductCreate.model_validate({**BASE, "alerts": [alert]})

    def test_two_hundred_characters_and_ten_alerts_fit(self):
        ProductCreate.model_validate({**BASE, "alerts": [{"text": "x" * 200}] * 10})
        with pytest.raises(ValidationError):
            ProductUpdate.model_validate({"alerts": [{"text": "x"}] * 11})

    def test_companion_price_modes(self):
        pid = str(uuid.uuid4())
        item = ProductCreate.model_validate({**BASE, "companions": [{"productId": pid}]}).companions[0]
        assert (item.quantity, item.price_mode, item.price, item.kitchen_print) == (1, "item", None, None)
        # A price is kept only for "custom"; anything else is the companion's own or ₪0.
        free = ProductUpdate.model_validate({"companions": [{"productId": pid, "priceMode": "free", "price": "3"}]}).companions[0]
        assert free.price is None
        custom = ProductUpdate.model_validate(
            {"companions": [{"productId": pid, "priceMode": "custom", "price": "2.50", "quantity": 2, "kitchenPrint": False}]}
        ).companions[0]
        assert (custom.price, custom.quantity, custom.kitchen_print) == (Decimal("2.50"), 2, False)

    @pytest.mark.parametrize("companion", [
        {"priceMode": "custom"},
        {"priceMode": "half"},
        {"quantity": 0},
        {"quantity": 100},
        {"priceMode": "custom", "price": "-1"},
    ])
    def test_a_bad_companion_is_refused(self, companion):
        with pytest.raises(ValidationError):
            ProductUpdate.model_validate({"companions": [{"productId": str(uuid.uuid4()), **companion}]})

    def test_the_same_product_twice_is_refused(self):
        pid = str(uuid.uuid4())
        with pytest.raises(ValidationError):
            ProductUpdate.model_validate({"companions": [{"productId": pid}, {"productId": pid, "quantity": 2}]})

    def test_the_update_leaves_them_alone_and_out_of_model_dump(self):
        assert ProductUpdate.model_validate({"price": "9"}).model_fields_set == {"price"}
        u = ProductUpdate.model_validate({"alerts": [], "companions": [], "allergenAlert": True})
        dumped = u.model_dump(exclude_unset=True)
        assert not {"alerts", "companions", "allergen_alert"} & set(dumped)
        assert {"alerts", "companions", "allergen_alert"} <= u.model_fields_set



class TestAllergenText:
    def test_in_hebrew_in_the_fixed_order(self):
        assert PA.allergen_alert_text(["gluten", "eggs"]) == "מכיל: גלוטן, ביצים — עדכנו את הלקוח!"
        assert PA.allergen_alert_text(["EGGS", "sesame", "nonsense"]) == "מכיל: ביצים, שומשום — עדכנו את הלקוח!"

    def test_none_without_allergens(self):
        assert PA.allergen_alert_text([]) is None
        assert PA.allergen_alert_text(None) is None
        assert PA.allergen_alert_text(["nonsense"]) is None


def _router(w, monkeypatch):
    from app.routers import products as R

    monkeypatch.setattr(R, "_trigger_catalog_notify", lambda *a, **k: None)
    # The SKU counters use a Postgres-only regex; not what is under test here.
    monkeypatch.setattr(R, "allocate_global_sku", lambda *a, **k: "100001")
    monkeypatch.setattr(R, "resolve_sku_for_create", lambda db, tenant, sku: (sku, False))
    cat = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="שתייה")
    w.db.add(cat)
    w.db.commit()

    def create(name, sku, **extra):
        return R.create_product(
            ProductCreate.model_validate({
                "name": name, "price": "8.00", "sku": sku, "categoryId": str(cat.id),
                "companyId": str(w.company.id), **extra,
            }),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def update(product_id, body):
        return R.update_product(
            str(product_id), ProductUpdate.model_validate(body),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    return create, update


class TestRouter:
    def test_create_and_update_store_them(self, w, monkeypatch):
        create, update = _router(w, monkeypatch)
        ice = create("כוס קרח", "ICE")
        cola = create(
            "קולה", "COLA",
            alerts=[{"text": "מכיל קפאין", "kind": "info"}],
            allergenAlert=True,
            companions=[{"productId": str(ice.id), "priceMode": "free"}],
        )
        row = w.db.get(Product, cola.id)
        assert row.alerts == [{"text": "מכיל קפאין", "kind": "info", "requireAck": False, "whereShown": "both"}]
        assert (row.allergen_alert, row.allergen_alert_require_ack) == (True, True)
        assert row.companions == [{
            "productId": str(ice.id), "name": "כוס קרח", "quantity": 1, "priceMode": "free",
            "price": None, "kitchenPrint": None,
        }]

        # A price change alone leaves them exactly as they are.
        update(cola.id, {"price": "9.00"})
        w.db.expire_all()
        row = w.db.get(Product, cola.id)
        assert row.alerts and row.companions and row.allergen_alert is True

        # A set price; then `[]` clears.
        update(cola.id, {"companions": [{"productId": str(ice.id), "priceMode": "custom", "price": "1.5", "quantity": 2}],
                         "allergenAlertRequireAck": False})
        w.db.expire_all()
        row = w.db.get(Product, cola.id)
        assert row.companions[0]["price"] == 1.5 and row.companions[0]["quantity"] == 2
        assert row.allergen_alert_require_ack is False
        out = update(cola.id, {"alerts": [], "companions": []})
        assert out.alerts is None and out.companions is None

    def test_an_old_product_has_none(self, w, monkeypatch):
        create, _ = _router(w, monkeypatch)
        plain = create("מים", "WATER")
        row = w.db.get(Product, plain.id)
        assert row.alerts is None and row.companions is None
        assert (row.allergen_alert, row.allergen_alert_require_ack) == (False, True)
        sent = PA.sync_fields(row)
        assert sent == {"alerts": [], "allergenAlert": False, "allergenAlertRequireAck": True, "companions": []}
        out = ProductResponse.model_validate(row).model_dump(by_alias=True)
        assert (out["alerts"], out["allergenAlert"], out["allergenAlertRequireAck"], out["companions"]) == ([], False, True, [])

    def test_the_response_reads_what_is_stored(self, w, monkeypatch):
        create, _ = _router(w, monkeypatch)
        row = w.db.get(Product, create("חריף", "HOT").id)
        row.alerts = [{"text": "חם!", "kind": "warning", "requireAck": True, "whereShown": "quick"}, {"bad": 1}]
        w.db.commit()
        out = ProductResponse.model_validate(row).model_dump(by_alias=True)
        assert out["alerts"] == [{"text": "חם!", "kind": "warning", "requireAck": True, "whereShown": "quick"}]

    def test_a_companion_must_be_another_product_of_the_organization(self, w, monkeypatch):
        from fastapi import HTTPException

        create, update = _router(w, monkeypatch)
        cola = create("קולה", "COLA")
        with pytest.raises(HTTPException) as own:
            update(cola.id, {"companions": [{"productId": str(cola.id)}]})
        assert own.value.detail == "companion_is_the_product"
        with pytest.raises(HTTPException) as missing:
            update(cola.id, {"companions": [{"productId": str(uuid.uuid4())}]})
        assert missing.value.detail == "companion_product_not_found"

        other_tenant = Tenant(id=uuid.uuid4(), name="O", slug="o", timezone="Asia/Jerusalem")
        w.db.add(other_tenant)
        w.db.flush()
        foreign = Product(
            id=uuid.uuid4(), tenant_id=other_tenant.id, category_id=w.db.get(Product, cola.id).category_id,
            name="זר", price=Decimal("1"), sku="F-1",
        )
        w.db.add(foreign)
        w.db.commit()
        with pytest.raises(HTTPException) as elsewhere:
            update(cola.id, {"companions": [{"productId": str(foreign.id)}]})
        assert elsewhere.value.detail == "companion_product_not_found"

        general = create("פריט כללי", "GEN")
        w.db.get(Product, general.id).is_general = True
        w.db.commit()
        with pytest.raises(HTTPException) as gen:
            update(cola.id, {"companions": [{"productId": str(general.id)}]})
        assert gen.value.detail == "companion_is_general_item"


def _with_extras(p, **over):
    p.alerts = over.get("alerts")
    p.allergen_alert = over.get("allergen_alert", False)
    p.allergen_alert_require_ack = over.get("allergen_alert_require_ack", True)
    p.companions = over.get("companions")
    return p


class TestSync:
    ALERTS = [{"text": "מכיל ביצים — תעדכן לקוח!", "kind": "allergen", "requireAck": True, "whereShown": "both"}]

    def test_both_serialisers_ship_them(self):
        ice = str(uuid.uuid4())
        companions = [{"productId": ice, "name": "כוס קרח", "quantity": 1, "priceMode": "free", "price": None, "kitchenPrint": None}]
        p = _with_extras(_product(is_weighed=False, unit_label=None), alerts=self.ALERTS, allergen_alert=True,
                         companions=companions)
        for row in (_serialize_product(p), _serialize_merged_product(p, None, None, uuid.uuid4(), None)):
            assert row["alerts"] == self.ALERTS
            assert row["allergenAlert"] is True and row["allergenAlertRequireAck"] is True
            assert row["companions"] == companions

    def test_taken_from_the_global_row(self):
        global_p = _with_extras(_product(is_weighed=False, unit_label=None), alerts=self.ALERTS)
        local = _with_extras(_product(is_weighed=False, unit_label=None), alerts=None, allergen_alert=True)
        row = _serialize_merged_product(global_p, local, None, uuid.uuid4(), None)
        assert row["alerts"] == self.ALERTS and row["allergenAlert"] is False

    def test_a_custom_price_is_sent_as_money_and_junk_is_dropped(self):
        ok = str(uuid.uuid4())
        p = _with_extras(_product(is_weighed=False, unit_label=None), companions=[
            {"productId": ok, "quantity": 2, "priceMode": "custom", "price": 2.505},
            {"productId": "not-an-id"},
            {"quantity": 1},
            {"productId": str(uuid.uuid4()), "priceMode": "weird", "quantity": 500, "kitchenPrint": "yes"},
        ])
        sent = _serialize_product(p)["companions"]
        assert sent[0] == {"productId": ok, "name": None, "quantity": 2, "priceMode": "custom", "price": 2.51, "kitchenPrint": None}
        assert len(sent) == 2
        assert (sent[1]["priceMode"], sent[1]["quantity"], sent[1]["price"], sent[1]["kitchenPrint"]) == ("item", 99, None, None)


def _line(name, price, **over):
    line = {"id": str(uuid.uuid4()), "productName": name, "quantity": "1", "unitPrice": price, "totalPrice": price}
    line.update(over)
    return line


def _sale(shift, lines, number):
    total = sum(Decimal(l["totalPrice"]) for l in lines)
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": str(total), "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": str(total)}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": lines,
    })


ACK = {
    "at": "2026-10-06T12:30:00+03:00", "by": "u-1", "byName": "דנה",
    "alerts": [{"text": "מכיל ביצים — תעדכן לקוח!", "kind": "allergen"}],
}


class TestAck:
    def test_stored_on_the_sold_line(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        in_details = _line("שקשוקה", "52.00", details={"v": 1, "basePrice": 52, "modifiers": [], "alertsAck": [ACK]})
        on_line = _line("עוגה", "30.00", alertsAck=ACK)
        companion = _line("כוס קרח", "0.00", details={"v": 1, "basePrice": 0, "modifiers": [],
                                                     "companionOf": {"lineRef": in_details["id"], "parentName": "שקשוקה"}})
        plain = _line("מים", "8.00")
        out = upsert_transactions(w.db, till, [_sale(shift, [in_details, on_line, companion, plain], "9001")])
        w.db.commit()
        assert [r.status for r in out] == ["accepted"]
        rows = {r.product_name: r for r in w.db.query(TransactionItem).all()}
        assert rows["שקשוקה"].alerts_ack == [ACK]
        assert rows["עוגה"].alerts_ack == [ACK]
        assert rows["כוס קרח"].alerts_ack is None and rows["מים"].alerts_ack is None
        # The companion is an ordinary sale line, its link kept in its details.
        assert rows["כוס קרח"].details["companionOf"]["parentName"] == "שקשוקה"

    def test_cleaned_and_bounded(self):
        long = {"at": "x" * 80, "by": None, "byName": "n" * 300, "alerts": ["טקסט", {"text": "", "kind": "info"}, {"text": "a", "kind": "zzz"}]}
        cleaned = PA.clean_ack([long] * 30)
        assert len(cleaned) == PA.ACKS_MAX
        first = cleaned[0]
        assert len(first["at"]) == 40 and first["by"] is None and len(first["byName"]) == 100
        assert first["alerts"] == [{"text": "טקסט", "kind": "info"}, {"text": "a", "kind": "info"}]
        assert PA.clean_ack("nonsense") is None and PA.clean_ack([]) is None


class TestParameter:
    def test_built_in_and_on_by_default(self, w):
        created = ensure_builtin_parameters(w.db)
        w.db.commit()
        assert PA.PARAM_KEY in created
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters[PA.PARAM_KEY] is True
