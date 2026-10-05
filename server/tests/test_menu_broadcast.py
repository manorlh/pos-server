"""
"סקירת שינויים לפני שידור לקופות" (docs/SPEC_MENU_BROADCAST_REVIEW.md).

What each class pins, and how it could look fine while doing damage:

* **Live stays live** — a shop without tables pulls the live catalog exactly as before:
  an edit reaches its tills at once, and no publication is ever made for it.
* **The first publication is the live catalog** — the moment a shop enters review mode
  (its first pull), every till of it is sent byte for byte what it was sent before: the
  same rows, the same values, the same stamps — its area, its own local copy, its own
  list and its own locks included. Anything else would change the tills of a shop the
  moment the feature landed.
* **Drafts** — in review mode an edit (price, name, a product added or delisted, a group)
  reaches no till, full pull or delta, until "אישור ושידור"; then all of it does, and a
  product the broadcast dropped is sent locked.
* **Operational stays immediate** — a till's (or the shop's) sold-out lock and a category
  switched off for a till reach the tills at once in review mode; the product's own
  availability, set in the dashboard, waits for the broadcast.
* **The review** — each kind of change lands in its section, named.
* **The mode** — tables on any till of the shop, the override both ways, leaving review
  mode sends the live catalog in full once, coming back starts from the live catalog.
* **Approve** — refused out of review mode, when nothing changed, and when the draft moved
  after the review shown; the shop's tills are woken.

Runs on the in-memory SQLite world of tests/shift_world.py (every table, foreign keys on).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.category import Category
from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.menu import MenuCourse, UpsellRule
from app.models.menu_broadcast import CatalogPublication, ShopWorkTypes
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import AreaProductOverride, MachineProductOverride
from app.models.shop_area import ShopArea
from app.models.shop_category_override import ShopCategoryOverride
from app.models.shop_product_override import ShopProductOverride
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import menu as menu_router
from app.routers import sync as sync_router
from app.schemas.menu import GroupIn
from app.services import catalog_notify
from app.services import category_availability as C
from app.services import menu as M
from app.services import menu_broadcast as B
from app.services import product_availability as A
from app.services import sync as S
from app.services import till_parameters as TP
from test_shop_areas import _ctx, w  # noqa: F401

OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── The world ────────────────────────────────────────────────────────────────


@pytest.fixture
def m(w, monkeypatch):  # noqa: F811
    """
    The shop "Center" (tills 1 and 2; till 1 in the area Bar) sells a burger, fries and a
    cola; Food › Burgers and Drinks. Till 1 has its own local stock copy of the cola and a
    list row for the burger. Every stamp is old, so a delta from `OLD` sees only what a
    test does. Tables are off: the default.
    """
    # The general item's SKU allocation is Postgres-only (`~`); not what is tested here.
    monkeypatch.setattr(sync_router, "_ensure_shop_general_item", lambda *_a: None)
    woken: list = []
    monkeypatch.setattr(
        catalog_notify, "publish_catalog_notify",
        lambda tid, mid, reason=None: woken.append((str(mid), reason)),
    )
    db = w.db
    TP.ensure_builtin_parameters(db)

    def category(name, parent=None, sort=0):
        c = Category(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name,
            parent_id=parent.id if parent else None, sort_order=sort, updated_at=OLD, created_at=OLD,
        )
        db.add(c)
        db.flush()
        return c

    def product(name, cat, price, shop=None):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=cat.id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=Decimal(price), sku=f"sku-{name}",
            is_available=True, updated_at=OLD, created_at=OLD,
        )
        db.add(p)
        db.flush()
        db.add(ShopProductOverride(
            id=uuid.uuid4(), shop_id=(shop or w.shop).id, global_product_id=p.id, is_listed=True,
            updated_at=OLD, created_at=OLD,
        ))
        return p

    w.food = category("Food", sort=1)
    w.burgers = category("Burgers", w.food, sort=2)
    w.drinks = category("Drinks", sort=3)
    w.burger = product("burger", w.burgers, "52.00")
    w.fries = product("fries", w.food, "18.00")
    w.cola = product("cola", w.drinks, "12.00")
    w.north_only = product("north tea", w.drinks, "9.00", shop=w.other_shop)

    w.t1, w.t2 = w.tills
    w.bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    db.add(w.bar)
    db.flush()
    w.t1.area_id = w.bar.id
    w.t1.area_changed_at = OLD
    w.t2.area_changed_at = OLD
    # Till 1's own stock copy of the cola, and its own list row for the burger.
    w.cola_local = Product(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=w.drinks.id,
        catalog_level=CatalogLevel.LOCAL, name="cola", price=Decimal("12.00"), sku="sku-cola-local",
        pos_machine_id=w.t1.id, global_product_id=w.cola.id, stock_quantity=7, in_stock=True,
        is_available=True, updated_at=OLD, created_at=OLD,
    )
    db.add(w.cola_local)
    db.add(MachineCatalogItem(
        id=uuid.uuid4(), machine_id=w.t1.id, product_id=w.burger.id, is_included=True,
        updated_at=OLD, created_at=OLD,
    ))
    db.commit()
    w.woken = woken
    return w


def _tables_param(w) -> TillParameter:
    return w.db.query(TillParameter).filter(TillParameter.key == "tablesMode").one()


def set_param(w, key, scope_type, scope_id, value):
    """A till parameter's value at one level, as the parameters page saves it."""
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    row = (
        w.db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == scope_id,
        )
        .first()
    )
    if row is None:
        w.db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
        ))
    else:
        row.value = value
    w.db.commit()


def tables_on(w, mode="קופה אחת", shop=None):
    set_param(w, "tablesMode", "shop", (shop or w.shop).id, mode)


def tables_off(w, shop=None):
    set_param(w, "tablesMode", "shop", (shop or w.shop).id, "כבוי")


def pull(w, till, since=None):
    """What the till is sent: `GET /sync/{m}/catalog`, as a dict."""
    out = sync_router.get_catalog_sync(
        str(till.id), since=since.isoformat() if isinstance(since, datetime) else since, machine=till, db=w.db
    )
    return out.model_dump(by_alias=True)


def by_global(payload):
    return {p.get("globalProductId") or p["id"]: p for p in payload["products"]}


def by_id(rows):
    return {r["id"]: r for r in rows}


def live_payload(w, till, since=None):
    """The live catalog, straight from the sync service (what a shop out of review gets)."""
    tid, mid = str(w.tenant.id), str(till.id)
    products = S.get_products_for_sync(w.db, tid, mid, since=since)
    categories = S.get_categories_for_sync(w.db, tid, mid, since=since)
    if since and products:
        categories = S.merge_categories_referenced_by_products(w.db, till, products, categories)
    menu = M.menu_block(w.db, till) if M.include_menu(w.db, till, since) else None
    return {"products": products, "categories": categories, "menu": menu}


def publications(w, shop=None):
    return (
        w.db.query(CatalogPublication)
        .filter(CatalogPublication.shop_id == (shop or w.shop).id)
        .order_by(CatalogPublication.version)
        .all()
    )


def age_publications(w, minutes=30):
    """Every publication made `minutes` ago, so a pull from a few minutes ago is after it."""
    for p in w.db.query(CatalogPublication).all():
        p.published_at = _now() - timedelta(minutes=minutes)
        if p.closed_at is not None:
            p.closed_at = _now() - timedelta(minutes=minutes)
    w.db.commit()


def broadcast(w, shop=None, **kw):
    shop = shop or w.shop
    return B.broadcast(w.db, shop, w.admin, **kw)


def review(w, shop=None):
    return B.preview(w.db, shop or w.shop)


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def create_group(w, body):
    tasks = BackgroundTasks()
    out = menu_router.create_group(GroupIn.model_validate(body), tasks, **_ctx(w))
    _run(tasks)
    return out


ADDONS = {
    "name": "תוספות", "kind": "addon", "minSelect": 0, "maxSelect": 3,
    "options": [{"name": "cheese", "price": "5"}, {"name": "egg", "price": "4"}],
}


# ── Live stays live ──────────────────────────────────────────────────────────


class TestNoTablesStaysLive:
    def test_an_edit_reaches_the_till_at_once_and_nothing_is_published(self, m):
        assert B.review_state(m.db, m.shop).enabled is False
        assert by_global(pull(m, m.t1))[str(m.burger.id)]["price"] == 52.0
        since = _now() - timedelta(seconds=30)
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).one()
        row.price = Decimal("55.00")
        m.burger.name = "big burger"
        m.db.commit()
        sent = by_global(pull(m, m.t1, since))
        assert sent[str(m.burger.id)]["price"] == 55.0
        assert sent[str(m.burger.id)]["name"] == "big burger"
        assert publications(m) == []

    def test_the_payload_is_the_live_one_full_and_delta(self, m):
        for till in (m.t1, m.t2):
            full = pull(m, till)
            live = live_payload(m, till)
            assert by_id(full["products"]) == by_id(live["products"])
            assert by_id(full["categories"]) == by_id(live["categories"])
            assert full["menu"] == live["menu"]
            delta = pull(m, till, OLD + timedelta(days=1))
            assert delta["products"] == [] and delta["menu"] is None

    def test_the_review_screen_says_off_and_why(self, m):
        out = review(m)
        assert out["review"]["enabled"] is False
        assert out["review"]["reason"] == B.REASON_NO_TABLES
        assert out["total"] == 0 and out["publication"] is None
        with pytest.raises(HTTPException) as refused:
            broadcast(m)
        assert refused.value.status_code == 409 and refused.value.detail == B.REVIEW_OFF


# ── The first publication is the live catalog ────────────────────────────────


class TestFirstPublicationIsTheLiveCatalog:
    def _decorate(self, m):
        """Everything per-till the overlay must keep: locks at every level, a rename, a switch-off."""
        A.set_machine_availability(m.db, m.t1.id, m.fries.id, False)
        m.db.add(AreaProductOverride(id=uuid.uuid4(), area_id=m.bar.id, product_id=m.cola.id, is_available=False))
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).one()
        row.price = Decimal("49.90")
        cola_row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.cola.id).one()
        A.set_shop_availability(cola_row, True)
        A.set_company_availability(m.db, m.company.id, m.fries.id, False)
        m.db.add(ShopCategoryOverride(id=uuid.uuid4(), shop_id=m.shop.id, category_id=m.drinks.id, name="Shtiya"))
        C.set_override(m.db, C.MACHINE, m.t2.id, m.food.id, False)
        m.db.commit()

    @pytest.mark.parametrize("decorated", [False, True])
    def test_every_till_gets_exactly_what_it_got_live(self, m, decorated):
        if decorated:
            self._decorate(m)
        create_group(m, ADDONS)
        before = {t.id: live_payload(m, t) for t in (m.t1, m.t2)}
        tables_on(m, "רשת מקומית (קופה ראשית)")
        for till in (m.t1, m.t2):
            got = pull(m, till)
            assert by_id(got["products"]) == by_id(before[till.id]["products"])
            assert by_id(got["categories"]) == by_id(before[till.id]["categories"])
            assert got["menu"] == before[till.id]["menu"]
        pubs = publications(m)
        assert [(p.version, p.kind) for p in pubs] == [(1, "initial")]
        assert pubs[0].summary["initial"] is True

    def test_a_delta_pull_after_switching_resends_the_same_rows(self, m):
        since = _now() - timedelta(seconds=5)
        tables_on(m)
        got = pull(m, m.t1, since)
        live = live_payload(m, m.t1)
        assert by_id(got["products"]) == by_id(live["products"])
        assert got["menu"] == live["menu"]

    def test_switching_on_makes_one_publication_however_many_tills_pull(self, m):
        tables_on(m)
        pull(m, m.t1)
        pull(m, m.t2)
        pull(m, m.t1, _now())
        assert len(publications(m)) == 1


# ── Drafts until the broadcast ───────────────────────────────────────────────


class TestDraftsWaitForTheBroadcast:
    def _edit(self, m):
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).one()
        row.price = Decimal("58.00")
        m.cola.name = "cola zero"
        fries_row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.fries.id).one()
        fries_row.is_listed = False
        m.salad = Product(
            id=uuid.uuid4(), tenant_id=m.tenant.id, company_id=m.company.id, category_id=m.food.id,
            catalog_level=CatalogLevel.GLOBAL, name="salad", price=Decimal("33.00"), sku="sku-salad",
        )
        m.db.add(m.salad)
        m.db.flush()
        m.db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=m.shop.id, global_product_id=m.salad.id, is_listed=True))
        m.db.commit()
        create_group(m, ADDONS)

    def test_no_till_sees_an_edit_until_it_is_broadcast(self, m):
        tables_on(m)
        first = pull(m, m.t1)
        age_publications(m)
        since = _now() - timedelta(minutes=5)
        self._edit(m)

        for got in (pull(m, m.t1), pull(m, m.t2)):
            sent = by_global(got)
            assert sent[str(m.burger.id)]["price"] == 52.0
            assert sent[str(m.cola.id)]["name"] == "cola"
            assert str(m.salad.id) not in sent
            assert sent[str(m.fries.id)]["isAvailable"] is True
            assert got["menu"] == first["menu"]
        delta = pull(m, m.t1, since)
        for row in delta["products"]:
            assert row["name"] != "cola zero" and row.get("globalProductId") != str(m.salad.id)
        assert delta["menu"] is None

        made = broadcast(m)
        assert made.version == 2 and made.kind == "broadcast"
        assert sorted(w for w in m.woken) == sorted([(str(m.t1.id), B.NOTIFY_REASON), (str(m.t2.id), B.NOTIFY_REASON)])
        after = pull(m, m.t1, since)
        sent = by_global(after)
        assert sent[str(m.burger.id)]["price"] == 58.0
        assert sent[str(m.cola.id)]["name"] == "cola zero"
        assert sent[str(m.salad.id)]["price"] == 33.0
        assert sent[str(m.fries.id)]["isAvailable"] is False and sent[str(m.fries.id)]["shopListed"] is False
        assert [g["name"] for g in after["menu"]["groups"]] == ["תוספות"]
        # Now the published catalog is the live one again.
        assert by_id(pull(m, m.t2)["products"]) == by_id(live_payload(m, m.t2)["products"])

    def test_a_product_the_broadcast_dropped_is_sent_locked(self, m):
        tables_on(m)
        pull(m, m.t1)
        age_publications(m)
        since = _now() - timedelta(minutes=5)
        m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.cola.id).delete()
        m.db.commit()
        assert str(m.cola.id) in by_global(pull(m, m.t1))  # still published
        broadcast(m)
        sent = by_global(pull(m, m.t1, since))
        dropped = sent[str(m.cola.id)]
        assert (dropped["isAvailable"], dropped["inStock"], dropped["shopListed"]) == (False, False, False)
        assert dropped["id"] == str(m.cola_local.id)  # the row the till holds it under
        # A full pull simply leaves it out (the till delists what a full pull leaves out).
        assert str(m.cola.id) not in by_global(pull(m, m.t1))

    def test_a_pull_well_after_the_publication_gets_only_what_moved_live(self, m):
        tables_on(m)
        pull(m, m.t1)
        age_publications(m)
        since = _now() - timedelta(minutes=5)
        assert pull(m, m.t1, since)["products"] == []
        assert pull(m, m.t1, since)["menu"] is None
        # A till racing the commit (pulled just after it) still gets it whole.
        p = publications(m)[-1]
        p.published_at = _now() - timedelta(seconds=30)
        m.db.commit()
        assert len(pull(m, m.t1, _now() - timedelta(seconds=10))["products"]) == 3


# ── Operational stays immediate ──────────────────────────────────────────────


class TestOperationalChangesStayImmediate:
    def _ready(self, m):
        tables_on(m)
        pull(m, m.t1)
        pull(m, m.t2)
        age_publications(m)
        return _now() - timedelta(minutes=5)

    def test_a_tills_sold_out_lock_reaches_it_at_once(self, m):
        since = self._ready(m)
        A.set_machine_availability(m.db, m.t1.id, m.burger.id, False)
        m.db.commit()
        delta = by_global(pull(m, m.t1, since))
        assert delta[str(m.burger.id)]["isAvailable"] is False
        assert str(m.burger.id) not in by_global(pull(m, m.t2, since))

    def test_a_shop_and_an_area_lock_reach_the_tills_at_once(self, m):
        since = self._ready(m)
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.fries.id).one()
        A.set_shop_availability(row, False)
        A.set_area_availability(m.db, m.bar.id, m.cola.id, False)
        m.db.commit()
        t1 = by_global(pull(m, m.t1, since))
        t2 = by_global(pull(m, m.t2, since))
        assert t1[str(m.fries.id)]["isAvailable"] is False and t2[str(m.fries.id)]["isAvailable"] is False
        assert t1[str(m.cola.id)]["isAvailable"] is False
        assert str(m.cola.id) not in t2  # till 2 is not in the bar

    def test_the_till_lock_endpoint_itself(self, m):
        from app.middleware.auth import CatalogActor
        from app.schemas.product_availability import TillAvailabilitySet

        since = self._ready(m)
        sync_router.machine_set_product_availability(
            str(m.t2.id), str(m.cola.id), TillAvailabilitySet(scope="machine", active=False),
            machine=m.t2, actor=CatalogActor(user_id=m.admin.id), db=m.db,
        )
        assert by_global(pull(m, m.t2, since))[str(m.cola.id)]["isAvailable"] is False

    def test_a_category_switched_off_for_a_till_reaches_it_at_once(self, m):
        since = self._ready(m)
        C.set_override(m.db, C.MACHINE, m.t1.id, m.drinks.id, False)
        m.db.commit()
        cats = by_id(pull(m, m.t1, since)["categories"])
        assert cats[str(m.drinks.id)]["isActive"] is False

    def test_the_tills_own_list_and_stock_are_live(self, m):
        since = self._ready(m)
        item = m.db.query(MachineCatalogItem).filter_by(machine_id=m.t1.id, product_id=m.burger.id).one()
        item.is_included = False
        item.updated_at = _now()
        m.cola_local.stock_quantity = 2
        m.cola_local.updated_at = _now()
        m.db.commit()
        sent = by_global(pull(m, m.t1, since))
        assert sent[str(m.burger.id)]["inMachineCatalog"] is False
        assert sent[str(m.cola.id)]["stockQuantity"] == 2

    def test_a_picture_is_live(self, m):
        since = self._ready(m)
        m.burger.image_url = "https://img/burger.png"
        m.db.commit()
        assert by_global(pull(m, m.t1, since))[str(m.burger.id)]["imageUrl"] == "https://img/burger.png"

    def test_the_products_own_availability_waits_for_the_broadcast(self, m):
        since = self._ready(m)
        m.burger.is_available = False
        m.db.commit()
        assert by_global(pull(m, m.t1))[str(m.burger.id)]["isAvailable"] is True
        out = review(m)
        assert [(i["name"], i["changes"][0]["after"]) for i in out["sections"]["availability"]] == [("burger", False)]
        broadcast(m)
        assert by_global(pull(m, m.t1, since))[str(m.burger.id)]["isAvailable"] is False


# ── The review ───────────────────────────────────────────────────────────────


class TestTheReview:
    def test_each_change_lands_in_its_section(self, m):
        tables_on(m)
        pull(m, m.t1)
        # Products and prices.
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).one()
        row.price = Decimal("60.00")
        m.cola.category_id = m.food.id
        m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.fries.id).delete()
        # Categories.
        m.drinks.name = "Beverages"
        m.burgers.sort_order = 9
        m.food.is_active = False
        dessert = Category(id=uuid.uuid4(), tenant_id=m.tenant.id, company_id=m.company.id, name="Desserts")
        m.db.add(dessert)
        # Hours and the menu: an upsell's window, a new course.
        m.db.add(MenuCourse(id=uuid.uuid4(), tenant_id=m.tenant.id, name="ראשונות", sort_order=1))
        m.db.commit()
        group = create_group(m, ADDONS)
        tasks = BackgroundTasks()
        menu_router.put_category_menu(str(m.burgers.id), _category_menu(group["id"]), tasks, **_ctx(m))
        _run(tasks)

        out = review(m)
        s = out["sections"]
        assert [(i["type"], i["name"]) for i in s["prices"]] == [("changed", "burger")]
        assert s["prices"][0]["changes"][0] == {"field": "price", "before": 52.0, "after": 60.0}
        products = {(i["type"], i["name"]) for i in s["products"]}
        assert ("removed", "fries") in products and ("changed", "cola") in products
        cola = next(i for i in s["products"] if i["name"] == "cola")
        assert cola["changes"] == [{"field": "categoryId", "before": "Drinks", "after": "Food"}]
        categories = {(i["type"], i["name"]) for i in s["categories"]}
        assert {("changed", "Beverages"), ("changed", "Burgers"), ("changed", "Food")} <= categories
        food = next(i for i in s["categories"] if i["name"] == "Food")
        assert {"field": "isActive", "before": True, "after": False} in food["changes"]
        modifiers = {(i["type"], i.get("detail"), i["name"]) for i in s["modifiers"]}
        assert ("added", "group", "תוספות") in modifiers
        assert ("changed", "links_category", "Burgers") in modifiers
        assert [(i["type"], i.get("detail"), i["name"]) for i in s["menu"]] == [("added", "course", "ראשונות")]
        assert out["total"] == sum(out["counts"].values()) == len([i for v in s.values() for i in v])
        assert [t["name"] for t in out["targets"]] == ["Till 1", "Till 2"]
        assert out["hasChanges"] is True

        made = broadcast(m, expected_fingerprint=out["fingerprint"])
        assert made.summary["total"] == out["total"]
        assert review(m)["total"] == 0 and review(m)["hasChanges"] is False

    def test_an_upsells_hours_are_their_own_section(self, m):
        rule = UpsellRule(
            id=uuid.uuid4(), tenant_id=m.tenant.id, name="קינוח", trigger_type="product",
            trigger_ids=[str(m.burger.id)], product_id=m.fries.id, start_time="12:00", end_time="16:00",
        )
        m.db.add(rule)
        M.bump(m.db, m.tenant.id)
        m.db.commit()
        tables_on(m)
        pull(m, m.t1)
        rule.end_time = "18:00"
        M.bump(m.db, m.tenant.id)
        m.db.commit()
        s = review(m)["sections"]
        assert s["hours"] == [{
            "type": "changed", "id": str(rule.id), "name": "קינוח", "detail": "upsell",
            "changes": [{"field": "endTime", "before": "16:00", "after": "18:00"}],
        }]
        assert s["menu"] == []

    def test_an_option_price_is_a_modifier_change(self, m):
        group = create_group(m, ADDONS)
        tables_on(m)
        pull(m, m.t1)
        body = dict(ADDONS)
        body["options"] = [
            {"id": o["id"], "name": o["name"], "price": "6" if o["name"] == "cheese" else o["price"]}
            for o in group["options"]
        ]
        tasks = BackgroundTasks()
        menu_router.update_group(group["id"], GroupIn.model_validate(body), tasks, **_ctx(m))
        item = review(m)["sections"]["modifiers"]
        assert item[0]["name"] == "תוספות"
        assert {"field": "option.price", "before": 5.0, "after": 6.0, "label": "cheese"} in item[0]["changes"]

    def test_another_shops_product_is_not_this_shops_change(self, m):
        tables_on(m)
        pull(m, m.t1)
        m.north_only.name = "north chai"
        m.db.commit()
        assert review(m)["total"] == 0


def _category_menu(group_id):
    from app.schemas.menu import CategoryMenuIn

    return CategoryMenuIn.model_validate({"links": {"mode": "groups", "groupIds": [group_id]}})


# ── The mode ─────────────────────────────────────────────────────────────────


class TestTheMode:
    def test_tables_on_one_till_make_the_shop_a_tables_shop(self, m):
        set_param(m, "tablesMode", "machine", m.t2.id, "קופה אחת")
        state = B.review_state(m.db, m.shop)
        assert state.enabled and state.tables_enabled and state.reason == B.REASON_TABLES
        assert [t["machineId"] for t in state.tables_tills] == [str(m.t2.id)]
        assert B.review_state(m.db, m.other_shop).enabled is False

    def test_a_company_value_reaches_its_shops(self, m):
        set_param(m, "tablesMode", "company", m.company.id, "מסונכרן בין הקופות")
        assert B.review_state(m.db, m.shop).enabled and B.review_state(m.db, m.other_shop).enabled

    def test_a_till_set_off_alone_does_not_switch_the_shop_off(self, m):
        tables_on(m)
        set_param(m, "tablesMode", "machine", m.t1.id, "כבוי")
        state = B.review_state(m.db, m.shop)
        assert state.enabled and [t["machineId"] for t in state.tables_tills] == [str(m.t2.id)]

    def test_always_reviews_without_tables(self, m):
        set_param(m, B.REVIEW_KEY, "shop", m.shop.id, B.REVIEW_ALWAYS)
        state = B.review_state(m.db, m.shop)
        assert (state.enabled, state.reason, state.tables_enabled) == (True, B.REASON_ALWAYS, False)
        pull(m, m.t1)
        m.burger.name = "x"
        m.db.commit()
        assert by_global(pull(m, m.t1))[str(m.burger.id)]["name"] == "burger"

    def test_never_stays_live_with_tables(self, m):
        tables_on(m)
        set_param(m, B.REVIEW_KEY, "company", m.company.id, B.REVIEW_NEVER)
        state = B.review_state(m.db, m.shop)
        assert (state.enabled, state.reason, state.tables_enabled) == (False, B.REASON_NEVER, True)
        m.burger.name = "x"
        m.db.commit()
        assert by_global(pull(m, m.t1))[str(m.burger.id)]["name"] == "x"
        assert publications(m) == []

    def test_a_shop_value_beats_its_companys(self, m):
        set_param(m, B.REVIEW_KEY, "company", m.company.id, B.REVIEW_NEVER)
        set_param(m, B.REVIEW_KEY, "shop", m.shop.id, B.REVIEW_ALWAYS)
        assert B.review_state(m.db, m.shop).enabled is True
        assert B.review_state(m.db, m.other_shop).enabled is False

    def test_leaving_review_mode_sends_the_live_catalog_in_full_once(self, m):
        tables_on(m)
        pull(m, m.t1)
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).one()
        row.price = Decimal("61.00")
        row.updated_at = OLD  # an edit the till's delta alone would never resend
        m.db.commit()
        since = _now()
        assert by_global(pull(m, m.t1, since - timedelta(seconds=1)))[str(m.burger.id)]["price"] == 52.0
        tables_off(m)
        got = pull(m, m.t1, since)
        assert by_global(got)[str(m.burger.id)]["price"] == 61.0
        assert len(got["products"]) == 3 and got["menu"] is not None
        assert publications(m)[-1].closed_at is not None
        # Once the window has passed, deltas are deltas again.
        age_publications(m)
        assert pull(m, m.t1, _now() - timedelta(minutes=5))["products"] == []

    def test_coming_back_starts_from_the_live_catalog(self, m):
        tables_on(m)
        pull(m, m.t1)
        tables_off(m)
        pull(m, m.t1)
        m.burger.name = "burger deluxe"
        m.db.commit()
        tables_on(m)
        assert by_global(pull(m, m.t1))[str(m.burger.id)]["name"] == "burger deluxe"
        assert [(p.version, p.kind) for p in publications(m)] == [(1, "initial"), (2, "initial")]


# ── Approve ──────────────────────────────────────────────────────────────────


class TestApprove:
    def test_nothing_to_broadcast(self, m):
        tables_on(m)
        with pytest.raises(HTTPException) as refused:
            broadcast(m)
        assert refused.value.detail == B.NOTHING_TO_BROADCAST

    def test_the_draft_moved_after_the_review(self, m):
        tables_on(m)
        pull(m, m.t1)
        m.burger.name = "x"
        m.db.commit()
        shown = review(m)
        m.burger.name = "y"
        m.db.commit()
        with pytest.raises(HTTPException) as refused:
            broadcast(m, expected_fingerprint=shown["fingerprint"])
        assert refused.value.detail["code"] == B.CHANGED_SINCE_PREVIEW
        assert len(publications(m)) == 1

    def test_an_operational_change_does_not_move_the_draft(self, m):
        tables_on(m)
        pull(m, m.t1)
        m.burger.name = "x"
        m.db.commit()
        shown = review(m)
        row = m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.fries.id).one()
        A.set_shop_availability(row, False)
        A.set_machine_availability(m.db, m.t1.id, m.cola.id, False)
        m.burger.image_url = "https://img/x.png"
        m.db.commit()
        assert broadcast(m, expected_fingerprint=shown["fingerprint"]).version == 2

    def test_old_snapshots_are_pruned_but_the_history_stays(self, m, monkeypatch):
        monkeypatch.setattr(B, "KEEP_SNAPSHOTS", 2)
        tables_on(m)
        pull(m, m.t1)
        for name in ("a", "b", "c"):
            m.burger.name = name
            m.db.commit()
            broadcast(m)
        m.db.expire_all()
        pubs = publications(m)
        assert [p.version for p in pubs] == [1, 2, 3, 4]
        assert [p.snapshot is not None for p in pubs] == [False, False, True, True]
        assert [h["version"] for h in B.history(m.db, m.shop)] == [4, 3, 2, 1]


# ── "סוגי עבודה" ──────────────────────────────────────────────────────────────


class TestWorkTypes:
    def test_ticking_tables_turns_review_on_and_publishes_the_live_catalog(self, m):
        B.set_work_types(m.db, m.shop, m.admin, tables=True, take_away=True, quick_order=True, delivery=False)
        out = B.work_types_out(m.db, m.shop, m.admin)
        assert out["tables"] is True and out["tablesMode"] == "קופה אחת"
        assert (out["takeAway"], out["quickOrder"], out["delivery"]) == (True, True, False)
        assert out["review"]["enabled"] is True
        assert [(p.version, p.kind) for p in publications(m)] == [(1, "initial")]

    def test_unticking_tables_clears_the_tills_own_values(self, m):
        set_param(m, "tablesMode", "machine", m.t1.id, "רשת מקומית (קופה ראשית)")
        set_param(m, "tablesMode", "area", m.bar.id, "קופה אחת")
        assert B.review_state(m.db, m.shop).enabled
        B.set_work_types(m.db, m.shop, m.admin, tables=False)
        state = B.review_state(m.db, m.shop)
        assert state.enabled is False and state.tables_enabled is False
        assert m.db.query(TillParameterValue).filter(TillParameterValue.scope_type.in_(("area", "machine"))).count() == 0

    def test_the_review_override_from_the_card(self, m):
        B.set_work_types(m.db, m.shop, m.admin, review_override=B.REVIEW_ALWAYS)
        assert B.review_state(m.db, m.shop).reason == B.REASON_ALWAYS
        with pytest.raises(HTTPException):
            B.set_work_types(m.db, m.shop, m.admin, review_override="maybe")

    def test_work_types_alone_change_nothing_else(self, m):
        B.set_work_types(m.db, m.shop, m.admin, take_away=True)
        assert B.review_state(m.db, m.shop).enabled is False
        assert m.db.query(ShopWorkTypes).one().take_away is True
        assert publications(m) == []

    def test_only_the_super_admin(self, m):
        with pytest.raises(HTTPException) as refused:
            B.set_work_types(m.db, m.shop, m.manager, tables=True)
        assert refused.value.status_code == 403


# ── The dashboard's endpoints ────────────────────────────────────────────────


class TestEndpoints:
    def _ctx(self, m, user=None):
        return dict(current_user=user or m.admin, active_tenant_id=m.tenant.id, db=m.db)

    def test_status_lists_the_review_shops_and_their_pending_changes(self, m):
        from app.routers import menu_broadcast as R

        tables_on(m)
        pull(m, m.t1)
        m.burger.name = "x"
        m.db.commit()
        out = R.get_status(company_id=None, shop_id=None, **self._ctx(m))
        assert [(s["shopName"], s["pending"], s["hasChanges"]) for s in out["shops"]] == [("Center", 1, True)]
        assert out["pending"] == 1
        # A shop manager of another shop sees none of it.
        assert R.get_status(company_id=None, shop_id=None, **self._ctx(m, m.north_manager))["shops"] == []

    def test_reading_and_broadcasting_are_guarded(self, m):
        from app.routers import menu_broadcast as R
        from app.routers.menu_broadcast import BroadcastIn

        tables_on(m)
        with pytest.raises(HTTPException) as refused:
            R.get_shop_preview(m.shop.id, **self._ctx(m, m.north_manager))
        assert refused.value.status_code == 403
        pull(m, m.t1)
        m.burger.name = "x"
        m.db.commit()
        with pytest.raises(HTTPException) as refused:
            R.post_shop_broadcast(m.shop.id, BroadcastIn(), **self._ctx(m, m.cashier))
        assert refused.value.status_code == 403
        out = R.post_shop_broadcast(m.shop.id, BroadcastIn(note="ערב"), **self._ctx(m, m.manager))
        assert out["publication"]["version"] == 2 and out["publication"]["publishedByName"] == "manager"
        assert out["publication"]["note"] == "ערב"
        history = R.get_shop_history(m.shop.id, limit=50, **self._ctx(m, m.manager))["versions"]
        assert [(v["version"], v["kind"]) for v in history] == [(2, "broadcast"), (1, "initial")]

    def test_the_company_previews_and_broadcasts_its_shops(self, m):
        from app.routers import menu_broadcast as R
        from app.routers.menu_broadcast import CompanyBroadcastIn

        set_param(m, "tablesMode", "company", m.company.id, "קופה אחת")
        pull(m, m.t1)
        pull(m, m.other_till)
        m.burger.name = "x"  # Center only
        m.north_only.name = "y"  # North only
        m.db.commit()
        out = R.get_company_preview(m.company.id, **self._ctx(m))
        assert sorted((p["shopName"], p["total"]) for p in out["shops"]) == [("Center", 1), ("North", 1)]
        body = CompanyBroadcastIn.model_validate({
            "shops": [{"shopId": str(p["shopId"]), "fingerprint": p["fingerprint"]} for p in out["shops"]],
        })
        results = R.post_company_broadcast(m.company.id, body, **self._ctx(m))["results"]
        assert all(r["ok"] for r in results) and len(results) == 2
        assert by_global(pull(m, m.other_till))[str(m.north_only.id)]["name"] == "y"
        again = R.post_company_broadcast(m.company.id, body, **self._ctx(m))["results"]
        assert {r["error"] for r in again} == {B.NOTHING_TO_BROADCAST}

    def test_the_work_types_card(self, m):
        from app.routers import menu_broadcast as R
        from app.routers.menu_broadcast import WorkTypesIn

        out = R.get_work_types(m.shop.id, **self._ctx(m, m.manager))
        assert out["tables"] is False and out["canEdit"] is False
        assert "כבוי" not in out["tablesModeOptions"] and out["tablesModeDefault"] == "קופה אחת"
        tasks = BackgroundTasks()
        out = R.put_work_types(
            m.shop.id, WorkTypesIn.model_validate({"tables": True, "tablesMode": "מסונכרן בין הקופות"}), tasks,
            **self._ctx(m),
        )
        assert out["tables"] is True and out["tablesMode"] == "מסונכרן בין הקופות"
        assert out["review"]["enabled"] is True and len(tasks.tasks) == 1
        with pytest.raises(HTTPException) as refused:
            R.put_work_types(m.shop.id, WorkTypesIn(tables=False), BackgroundTasks(), **self._ctx(m, m.manager))
        assert refused.value.status_code == 403
