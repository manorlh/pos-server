"""
"תפריט דמה" — the demo menu (app/services/demo_menu.py, the templates in
app/services/demo_menu_templates.py, docs/SPEC_TRAINING_MODE.md).

* The restaurant + bar template is the "רויאל ספיריט" demo (14 categories, 76 products,
  22 groups, 4 meals, 2 upsells); every template's plan holds together.
* A load creates everything through the dashboard's own functions, with a shop scope —
  so the products come back in the catalog pull of a till of that shop (and, for a
  one-shop load, of no other shop) — and records each row in `demo_menu_items`.
* The company's own chips and courses are added to, never replaced.
* One load per shop. Who: as for training mode.
* Removal deletes what was recorded, whatever was edited since, and nothing else; a
  product sold in a real transaction is made inactive instead (and its category kept,
  inactive); a group the customer linked to a product of theirs is kept.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import itertools
import uuid
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.category import Category
from app.models.menu import MealSlot, MenuCourse, ModifierGroup, ModifierLink, PrepNotePreset, UpsellRule
from app.models.product import Product
from app.models.shift import ShiftStatus
from app.models.training import DemoMenuItem
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import products as products_router
from app.routers import training_mode as R
from app.services import ably_notify
from app.services import demo_menu as DM
from app.services import demo_menu_templates as T
from app.services import menu as M
from app.services import training_mode as TM
from app.services.sync import get_products_for_sync
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    skus = itertools.count(100)
    # The SKU counters are Postgres sequences; here, a plain counter.
    monkeypatch.setattr(products_router, "resolve_sku_for_create", lambda *_: (str(next(skus)), True))
    monkeypatch.setattr(products_router, "allocate_global_sku", lambda *_: f"G-{next(skus)}")
    world.catalog_notified = []
    monkeypatch.setattr(ably_notify, "publish_catalog_notify",
                        lambda tenant_id, machine_id, **kw: world.catalog_notified.append(machine_id))
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _load(w, template="restaurant_bar", shop=True, user=None):
    return R.load_demo_menu(
        R.DemoLoadIn(companyId=w.company.id, shopId=w.shop.id if shop else None, template=template),
        BackgroundTasks(), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _remove(w, load_id, user=None):
    return R.remove_demo_menu(
        uuid.UUID(load_id), BackgroundTasks(), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _tracked(w, entity_type=None):
    q = w.db.query(DemoMenuItem)
    if entity_type:
        q = q.filter(DemoMenuItem.entity_type == entity_type)
    return q.all()


def _synced_names(w, till):
    return {p["name"] for p in get_products_for_sync(w.db, str(w.tenant.id), str(till.id))}


def _by_name(w, name):
    return w.db.query(Product).filter(Product.name == name).one()


# ── The templates ─────────────────────────────────────────────────────────────


def test_the_restaurant_and_bar_template_is_the_royal_spirit_demo():
    templates = {t["key"]: t for t in DM.templates_out()["templates"]}
    assert set(templates) == {"restaurant", "bar", "cafe", "restaurant_bar"}
    assert templates["restaurant_bar"]["counts"] == {
        "categories": 14, "products": 76, "groups": 22, "meals": 4, "upsells": 2, "notes": 6, "courses": 3,
    }
    names = [n for _c, _color, items in T.CATEGORIES for n, _p in items]
    assert len(names) == len(set(names)), "a product name is a key: unique across the catalogue"


@pytest.mark.parametrize("key", sorted(T.TEMPLATES))
def test_every_template_plan_holds_together(key):
    p = DM.plan(key)
    products = {n for _c, _color, items in p["categories"] for n, _p in items}
    for group in p["groups"].values():
        assert all(o.get("linked") in (None, *products) for o in group["options"])
    for meal, slots in p["meals"].items():
        assert meal in products
        assert all(o[0] in products for s in slots for o in s["options"])
    assert all(u["product"] in products for u in p["upsells"])


def test_an_unknown_template_is_refused(w):
    with pytest.raises(HTTPException) as refused:
        _load(w, "pizzeria")
    assert refused.value.status_code == 422 and refused.value.detail["code"] == "unknown_template"


# ── Load ──────────────────────────────────────────────────────────────────────


def test_a_load_for_one_shop_reaches_that_shops_tills_and_no_other(w):
    out = _load(w)
    assert out["counts"] == {"category": 14, "product": 76, "modifier_group": 22, "prep_note": 6, "course": 3,
                             "upsell": 2}
    assert out["shopId"] == str(w.shop.id)
    # Every product is on the shop's tills (its shop scope), and on no other shop's.
    names = _synced_names(w, w.tills[0])
    assert {"המבורגר קלאסי", "ארוחה זוגית", "גינס מהחבית", "צ׳יפס"} <= names
    assert len(names & {n for _c, _color, items in T.CATEGORIES for n, _p in items}) == 76
    assert _synced_names(w, w.other_till) & names == set()
    # Recorded, row for row, under one load id and the shop's scope.
    rows = _tracked(w)
    assert len(rows) == sum(out["counts"].values())
    assert {str(r.load_id) for r in rows} == {out["loadId"]}
    assert {r.shop_id for r in rows} == {w.shop.id} and {r.template for r in rows} == {"restaurant_bar"}


def test_the_menu_is_loaded_as_the_dashboard_makes_it(w):
    _load(w)
    db = w.db
    groups = {g.name: g for g in db.query(ModifierGroup).all()}
    assert groups["בלי — המבורגר"].kind == "removal"
    assert groups["רטבים"].allow_pre is True
    assert groups["תוספות להמבורגר"].allow_quantity is True
    side = M.one_group_out(db, w.admin, w.tenant.id, groups["תוספת בצד"])
    chips = {o["name"]: o for o in side["options"]}
    assert chips["צ׳יפס"]["linkedProductId"] == str(_by_name(w, "צ׳יפס").id)
    meal = _by_name(w, "ארוחה זוגית")
    slots = db.query(MealSlot).filter(MealSlot.product_id == meal.id).all()
    assert sorted(s.name for s in slots) == sorted(["שני המבורגרים", "שתי תוספות", "שתי שתיות"])
    # Courses assigned to the categories (the seed's `.get("courses")` missed `items`).
    burgers = db.query(Category).filter(Category.name == "המבורגרים").one()
    mains = db.query(MenuCourse).filter(MenuCourse.name == "עיקריות").one()
    assert burgers.course_id == mains.id
    upsell = db.query(UpsellRule).filter(UpsellRule.name == "טבעות בצל להמבורגר").one()
    assert upsell.product_id == _by_name(w, "טבעות בצל").id
    # The till's menu block carries it.
    block = M.menu_block(db, w.tills[0])
    assert len(block["groups"]) == 22


def test_a_company_wide_load_reaches_every_shop_of_the_company(w):
    out = _load(w, "bar", shop=False)
    assert out["shopId"] is None
    assert "מוחיטו" in _synced_names(w, w.tills[0])
    assert "מוחיטו" in _synced_names(w, w.other_till)


@pytest.mark.parametrize("key", ["restaurant", "bar", "cafe"])
def test_each_template_loads(w, key):
    out = _load(w, key)
    counts = DM.templates_out()["templates"]
    expected = next(t["counts"] for t in counts if t["key"] == key)
    assert out["counts"]["product"] == expected["products"]
    assert out["counts"]["category"] == expected["categories"]
    assert out["counts"].get("modifier_group", 0) == expected["groups"]


def test_one_demo_menu_per_shop(w):
    first = _load(w, "cafe")
    with pytest.raises(HTTPException) as refused:
        _load(w, "bar")
    assert refused.value.status_code == 409
    assert refused.value.detail == {"code": "demo_menu_loaded", "loadId": first["loadId"]}


def test_the_companys_own_chips_and_courses_are_added_to_not_replaced(w):
    db = w.db
    own_note = PrepNotePreset(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, target_type="all",
                              text="ללא גלוטן", is_important=True, sort_order=0)
    other_note = PrepNotePreset(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, target_type="all",
                                text="שלנו", sort_order=1)
    own_course = MenuCourse(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="ראשונות",
                            sort_order=0)
    db.add_all([own_note, other_note, own_course])
    db.flush()
    out = _load(w)
    assert out["counts"]["prep_note"] == 5 and out["counts"]["course"] == 2
    starters = db.query(Category).filter(Category.name == "ראשונות").one()
    assert starters.course_id == own_course.id  # the company's own course, reused
    _remove(w, out["loadId"])
    w.db.expire_all()
    assert db.get(PrepNotePreset, own_note.id) and db.get(PrepNotePreset, other_note.id)
    assert db.get(MenuCourse, own_course.id) is not None
    assert db.query(PrepNotePreset).filter(PrepNotePreset.target_type == "all").count() == 2


def test_who_may_load(w):
    manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=w.shop.id,
                   email="m@x", username="m")
    w.db.add(manager)
    w.db.flush()
    with pytest.raises(HTTPException) as refused:
        _load(w, user=manager)
    assert refused.value.status_code == 403
    status_out = R.get_demo_status(company_id=w.company.id, shop_id=w.shop.id, current_user=manager,
                                   active_tenant_id=w.tenant.id, db=w.db)
    assert status_out["canManage"] is False and status_out["loaded"] is False


# ── Remove ────────────────────────────────────────────────────────────────────


def test_removal_takes_back_exactly_what_was_loaded(w):
    db = w.db
    own_category = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="שלנו")
    db.add(own_category)
    db.flush()
    own_product = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id,
                          category_id=own_category.id, name="המנה שלנו", price=Decimal("50"), sku="own-1")
    db.add(own_product)
    db.flush()
    out = _load(w)
    # Edited since: still the demo's.
    burger = _by_name(w, "המבורגר קלאסי")
    burger.price = Decimal("99")
    db.flush()
    status_out = R.get_demo_status(company_id=w.company.id, shop_id=w.shop.id, current_user=w.admin,
                                   active_tenant_id=w.tenant.id, db=db)
    assert status_out["loaded"] is True and status_out["loads"][0]["loadId"] == out["loadId"]

    result = _remove(w, out["loadId"])
    assert result["deleted"] == out["counts"]
    assert result["deactivated"] == {} and result["kept"] == {}
    db.expire_all()
    assert _tracked(w) == []
    assert db.query(Product).filter(Product.id != own_product.id).count() == 0
    assert db.query(Category).filter(Category.id != own_category.id).count() == 0
    assert db.query(ModifierGroup).count() == 0 and db.query(UpsellRule).count() == 0
    assert db.query(MealSlot).count() == 0 and db.query(ModifierLink).count() == 0
    assert db.get(Product, own_product.id) is not None and db.get(Category, own_category.id) is not None
    assert _synced_names(w, w.tills[0]) & {"המבורגר קלאסי", "צ׳יפס"} == set()


def test_a_load_that_fails_half_way_takes_back_what_it_had_created(w, monkeypatch):
    db = w.db

    def _boom(*_a, **_k):
        raise RuntimeError("upsell store down")

    monkeypatch.setattr(M, "create_upsell", _boom)
    with pytest.raises(RuntimeError):
        _load(w, "cafe")
    db.expire_all()
    assert _tracked(w) == []
    assert db.query(Product).count() == 0 and db.query(Category).count() == 0
    assert db.query(ModifierGroup).count() == 0
    # And the shop is free to load again.
    monkeypatch.undo()
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(products_router, "resolve_sku_for_create", lambda *_: (uuid.uuid4().hex[:8], True))
    monkeypatch.setattr(products_router, "allocate_global_sku", lambda *_: uuid.uuid4().hex[:8])
    assert _load(w, "cafe")["counts"]["product"] == 35


def test_a_product_sold_for_real_is_made_inactive_not_deleted(w):
    db = w.db
    out = _load(w, "cafe")
    sold = _by_name(w, "קרואסון חמאה")
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.CLOSED)
    tx = w.doc(till, shift, "14.00")
    db.add(TransactionItem(id=uuid.uuid4(), transaction_id=tx.id, product_id=sold.id, product_name=sold.name,
                           quantity=1, unit_price=Decimal("14"), total_price=Decimal("14")))
    db.flush()
    preview = R.get_demo_remove_preview(uuid.UUID(out["loadId"]), current_user=w.admin,
                                        active_tenant_id=w.tenant.id, db=db)
    assert preview["soldProducts"] == 1 and preview["counts"]["product"] == out["counts"]["product"]
    result = _remove(w, out["loadId"])
    assert result["deactivated"] == {"product": 1, "category": 1}
    assert result["deleted"]["product"] == out["counts"]["product"] - 1
    db.expire_all()
    kept = db.get(Product, sold.id)
    assert kept is not None and kept.is_available is False
    pastries = db.get(Category, kept.category_id)
    assert pastries is not None and pastries.is_active is False
    assert db.query(Product).count() == 1
    assert _tracked(w) == []


def test_a_group_the_customer_linked_to_their_own_product_is_kept(w):
    db = w.db
    out = _load(w, "cafe")
    own_category = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="שלנו")
    db.add(own_category)
    db.flush()
    own = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=own_category.id,
                  name="לאטה שלנו", price=Decimal("15"), sku="own-2")
    db.add(own)
    db.flush()
    milk = db.query(ModifierGroup).filter(ModifierGroup.name == "סוג חלב").one()
    db.add(ModifierLink(id=uuid.uuid4(), tenant_id=w.tenant.id, target_type="product", target_id=own.id,
                        group_id=milk.id))
    db.flush()
    result = _remove(w, out["loadId"])
    assert result["kept"] == {"modifier_group": 1}
    db.expire_all()
    assert db.get(ModifierGroup, milk.id) is not None
    assert db.query(ModifierLink).filter(ModifierLink.target_id == own.id).count() == 1


def test_leaving_training_mode_can_take_the_demo_menu_with_it(w):
    TM.start(w.db, w.shop, w.admin)
    _load(w, "bar")
    preview = R.get_disable_preview(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert preview["demoMenu"]["loaded"] is True and preview["demoMenu"]["loads"][0]["template"] == "bar"
    out = R.disable_training_mode(
        w.shop.id, R.DisableIn(confirmName=w.shop.name, removeDemoMenu=True), BackgroundTasks(),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["demoMenu"]["deleted"]["product"] == 40
    w.db.expire_all()
    assert _tracked(w) == [] and w.db.query(Product).count() == 0
