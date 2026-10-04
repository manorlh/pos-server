"""
The menu layer ("תוספות ושינויים", docs/SPEC_MENU_MODIFIERS.md).

What each class pins:

* **GroupRules** — a group's numbers hold together (min ≤ max, free ≤ max, a required
  group has something to choose, no more defaults than the max, a removal group takes no
  quantities or pre-modifiers); allergens are the fixed list.
* **Choosing** — min / max / quantity / pre-modifier validation, and the price: the
  cheapest units are the free ones whatever the order, "הרבה" doubles.
* **Writes** — create / update keeps option ids; only an admin writes for the whole
  organization; delete takes the links with it.
* **Inheritance** — a product's own list wins over its category's (an explicit "none"
  included), a category inherits its parent's; note chips the same; the group editor's
  "categories" seeds a category with what it inherited.
* **Meals** — slots stored and read back; a meal inside a meal is refused.
* **Sync** — the full pull carries the menu, a delta only after a change (deletes
  included); another company's groups stay out; products carry allergens and course;
  category triggers arrive with their sub-categories.
* **Allocation** — a meal's money over its components adds up to the agora, upcharges
  and paid modifiers stay with their component.
* **Documents** — details stored and taken apart, a re-push replaces; an old line
  without details is untouched; the product report counts burgers inside meals and still
  adds up; the modifier, meal and upsell reports.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.category import Category
from app.models.menu import MenuSyncState, ModifierLink, TransactionItemPart, UpsellStat
from app.models.product import Product
from app.models.shift import ShiftStatus
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction_item import TransactionItem
from app.routers import menu as R
from app.routers import sync as sync_router
from app.schemas.menu import GroupIn, LinksIn, MealIn, NotesIn, ProductMenuIn, UpsellIn, UpsellStatsIn
from app.schemas.transaction import TransactionIn
from app.services import menu as M
from app.services.reports import build_product_sales_report, resolve_report_window
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


@pytest.fixture
def menu(w, monkeypatch):
    """Food › Burgers, Drinks; a burger, fries, a cola and a burger meal, all sold in the shop."""
    # The general item's SKU allocation is Postgres-only (`~`); not what is tested here.
    monkeypatch.setattr(sync_router, "_ensure_shop_general_item", lambda *_a: None)

    def category(name, parent=None):
        c = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name,
                     parent_id=parent.id if parent else None)
        w.db.add(c)
        w.db.flush()
        return c

    def product(name, cat, price):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=cat.id,
            name=name, price=Decimal(price), sku=f"sku-{name}",
        )
        w.db.add(p)
        w.db.flush()
        w.db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=w.shop.id, global_product_id=p.id, is_listed=True))
        return p

    w.food = category("Food")
    w.burgers = category("Burgers", w.food)
    w.drinks = category("Drinks")
    w.burger = product("burger", w.burgers, "52.00")
    w.fries = product("fries", w.food, "18.00")
    w.cola = product("cola", w.drinks, "12.00")
    w.meal = product("burger meal", w.burgers, "62.00")
    w.db.commit()
    return w


def group_body(**over):
    base = {
        "name": "מידת עשייה", "kind": "choice", "minSelect": 1, "maxSelect": 1,
        "options": [{"name": "Rare"}, {"name": "Medium", "isDefault": True}, {"name": "Well done"}],
    }
    base.update(over)
    return GroupIn.model_validate(base)


def addons_body(**over):
    base = {
        "name": "תוספות", "kind": "addon", "minSelect": 0, "maxSelect": 5, "freeCount": 2,
        "options": [
            {"name": "cheese", "price": "5", "allergens": ["milk"]},
            {"name": "egg", "price": "4", "allergens": ["eggs"]},
            {"name": "onion", "price": "2"},
            {"name": "mushrooms", "price": "3"},
        ],
    }
    base.update(over)
    return GroupIn.model_validate(base)


def create_group(w, body, user=None):
    tasks = BackgroundTasks()
    out = R.create_group(body, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def put_product(w, product, body, user=None):
    tasks = BackgroundTasks()
    out = R.put_product_menu(str(product.id), ProductMenuIn.model_validate(body), tasks, **_ctx(w, user))
    _run(tasks)
    return out


def put_category(w, category, body, user=None):
    from app.schemas.menu import CategoryMenuIn

    tasks = BackgroundTasks()
    out = R.put_category_menu(str(category.id), CategoryMenuIn.model_validate(body), tasks, **_ctx(w, user))
    _run(tasks)
    return out


def pull(w, till, since=None):
    return sync_router.get_catalog_sync(str(till.id), since=since, machine=till, db=w.db)


# ── Group rules ───────────────────────────────────────────────────────────────


class TestGroupRules:
    def test_min_cannot_exceed_max(self):
        with pytest.raises(ValidationError):
            group_body(minSelect=2, maxSelect=1)

    def test_free_cannot_exceed_max(self):
        with pytest.raises(ValidationError):
            addons_body(freeCount=6)

    def test_a_required_group_needs_an_option(self):
        with pytest.raises(ValidationError):
            group_body(options=[])

    def test_removal_takes_no_quantity_or_pre(self):
        with pytest.raises(ValidationError):
            group_body(kind="removal", minSelect=0, allowPre=True)
        with pytest.raises(ValidationError):
            group_body(kind="removal", minSelect=0, allowQuantity=True)

    def test_no_more_defaults_than_the_max(self):
        with pytest.raises(ValidationError):
            group_body(options=[{"name": "a", "isDefault": True}, {"name": "b", "isDefault": True}])

    def test_two_options_of_one_name(self):
        with pytest.raises(ValidationError):
            group_body(options=[{"name": "Rare"}, {"name": "rare"}])

    def test_allergens_are_the_fixed_list_in_order(self):
        body = addons_body(options=[{"name": "x", "allergens": ["SESAME", "gluten", "gluten"]}])
        assert body.options[0].allergens == ["gluten", "sesame"]
        with pytest.raises(ValidationError):
            addons_body(options=[{"name": "x", "allergens": ["chocolate"]}])


# ── Choosing ──────────────────────────────────────────────────────────────────


def _rules(**over):
    base = dict(min_select=0, max_select=5, free_count=2, allow_quantity=True, allow_pre=True,
                prices={"cheese": 500, "egg": 400, "onion": 200, "mushrooms": 300}, limits={})
    base.update(over)
    return M.GroupRules(**base)


class TestChoosing:
    def test_the_cheapest_units_are_free_whatever_the_order(self):
        picks = [M.Pick("egg"), M.Pick("onion"), M.Pick("mushrooms")]
        assert M.price_picks(_rules(), picks) == [400, 0, 0]
        assert sum(M.price_picks(_rules(), list(reversed(picks)))) == 400

    def test_extra_doubles_and_quantities_count(self):
        assert M.price_picks(_rules(free_count=0), [M.Pick("cheese", pre="extra")]) == [1000]
        assert M.price_picks(_rules(free_count=1), [M.Pick("onion", qty=3)]) == [400]

    def test_min_max_quantity_and_pre(self):
        assert M.validate_picks(_rules(min_select=1), []) == ["below_min"]
        assert M.validate_picks(_rules(max_select=2), [M.Pick("egg", qty=3)]) == ["above_max"]
        assert "quantity_not_allowed" in M.validate_picks(_rules(allow_quantity=False), [M.Pick("egg", qty=2)])
        assert "duplicate_option" in M.validate_picks(_rules(allow_quantity=False), [M.Pick("egg"), M.Pick("egg")])
        assert M.validate_picks(_rules(allow_pre=False), [M.Pick("egg", pre="extra")]) == ["pre_not_allowed"]
        assert M.validate_picks(_rules(), [M.Pick("bacon")]) == ["unknown_option", "below_min"][:1]
        assert M.validate_picks(_rules(min_select=1, max_select=1), [M.Pick("egg")]) == []


# ── Writes ────────────────────────────────────────────────────────────────────


class TestWrites:
    def test_create_list_and_update_keep_option_ids(self, menu):
        made = create_group(menu, addons_body())
        assert made["freeCount"] == 2 and [o["name"] for o in made["options"]] == ["cheese", "egg", "onion", "mushrooms"]
        cheese = made["options"][0]["id"]
        body = addons_body(options=[
            {"id": cheese, "name": "cheese", "price": "6"},
            {"name": "bacon", "price": "8"},
        ])
        tasks = BackgroundTasks()
        out = R.update_group(made["id"], body, tasks, **_ctx(menu))
        assert [(o["name"], o["price"]) for o in out["options"]] == [("cheese", 6.0), ("bacon", 8.0)]
        assert out["options"][0]["id"] == cheese
        assert [g["name"] for g in R.list_groups(**_ctx(menu))["items"]] == ["תוספות"]

    def test_the_whole_organization_is_for_admins(self, menu):
        e = refused(create_group, menu, addons_body(), menu.company_manager)
        assert e.status_code == 403 and e.detail == M.WHOLE_ORG_FORBIDDEN
        made = create_group(menu, addons_body(companyId=str(menu.company.id)), menu.company_manager)
        assert made["companyId"] == str(menu.company.id) and made["canEdit"]

    def test_a_cashier_writes_nothing(self, menu):
        assert refused(create_group, menu, addons_body(companyId=str(menu.company.id)), menu.cashier).status_code == 403

    def test_delete_takes_its_links(self, menu):
        made = create_group(menu, addons_body(categoryIds=[str(menu.burgers.id)]))
        assert menu.db.query(ModifierLink).count() == 1
        tasks = BackgroundTasks()
        R.delete_group(made["id"], tasks, **_ctx(menu))
        assert menu.db.query(ModifierLink).count() == 0
        assert R.list_groups(**_ctx(menu))["items"] == []


# ── Inheritance ───────────────────────────────────────────────────────────────


class TestInheritance:
    def test_a_product_list_wins_over_its_category(self, menu):
        doneness = create_group(menu, group_body())
        addons = create_group(menu, addons_body())
        put_category(menu, menu.burgers, {"links": {"mode": "groups", "groupIds": [doneness["id"], addons["id"]]}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger) == ([doneness["id"], addons["id"]], str(menu.burgers.id))
        put_product(menu, menu.burger, {"links": {"mode": "groups", "groupIds": [addons["id"]]}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger) == ([addons["id"]], "product")
        put_product(menu, menu.burger, {"links": {"mode": "none"}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger) == ([], "product")
        put_product(menu, menu.burger, {"links": {"mode": "inherit"}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger)[1] == str(menu.burgers.id)

    def test_a_category_inherits_its_parent(self, menu):
        addons = create_group(menu, addons_body())
        put_category(menu, menu.food, {"links": {"mode": "groups", "groupIds": [addons["id"]]}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger) == ([addons["id"]], str(menu.food.id))
        put_category(menu, menu.burgers, {"links": {"mode": "none"}})
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger) == ([], str(menu.burgers.id))
        section = R.get_product_menu(str(menu.burger.id), **_ctx(menu))
        assert section["links"]["mode"] == "inherit" and section["links"]["inheritedFromName"] == "Burgers"

    def test_the_group_editor_seeds_what_a_category_inherited(self, menu):
        addons = create_group(menu, addons_body())
        put_category(menu, menu.food, {"links": {"mode": "groups", "groupIds": [addons["id"]]}})
        doneness = create_group(menu, group_body(categoryIds=[str(menu.burgers.id)]))
        assert M.resolve_groups(menu.db, menu.tenant.id, menu.burger)[0] == [addons["id"], doneness["id"]]

    def test_note_chips_follow_the_same_rule(self, menu):
        put_category(menu, menu.burgers, {"notes": {"mode": "own", "notes": [{"text": "חתוך לחצי"}]}})
        section = R.get_product_menu(str(menu.burger.id), **_ctx(menu))
        assert [n["text"] for n in section["notes"]["inherited"]] == ["חתוך לחצי"]
        put_product(menu, menu.burger, {"notes": {"mode": "own", "notes": [{"text": "לילד", "isImportant": True}]}})
        section = R.get_product_menu(str(menu.burger.id), **_ctx(menu))
        assert section["notes"]["mode"] == "own" and section["notes"]["notes"][0]["isImportant"] is True

    def test_a_product_of_another_company_is_not_the_managers(self, menu):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=menu.tenant.id, name="Other")
        menu.db.add(other)
        menu.burger.company_id = other.id
        menu.db.commit()
        e = refused(put_product, menu, menu.burger, {"allergens": ["milk"]}, menu.company_manager)
        assert e.status_code == 403


# ── Meals ─────────────────────────────────────────────────────────────────────


def meal_body(w):
    return {"meal": {"slots": [
        {"name": "עיקרית", "options": [{"productId": str(w.burger.id), "isDefault": True}]},
        {"name": "תוספת", "options": [{"productId": str(w.fries.id), "isDefault": True, "upcharge": "0"}]},
        {"name": "שתייה", "options": [{"productId": str(w.cola.id), "isDefault": True}]},
    ]}}


class TestMeals:
    def test_slots_are_stored_and_read_back(self, menu):
        out = put_product(menu, menu.meal, meal_body(menu))
        assert [s["name"] for s in out["meal"]["slots"]] == ["עיקרית", "תוספת", "שתייה"]
        assert out["meal"]["slots"][0]["options"][0]["productName"] == "burger"
        assert R.get_product_menu(str(menu.burger.id), **_ctx(menu))["componentOf"] == ["burger meal"]

    def test_a_meal_inside_a_meal_is_refused(self, menu):
        put_product(menu, menu.meal, meal_body(menu))
        e = refused(put_product, menu, menu.burger, {"meal": {"slots": [
            {"name": "x", "options": [{"productId": str(menu.fries.id)}]},
        ]}})
        assert e.detail == M.MEAL_IN_MEAL
        e = refused(put_product, menu, menu.fries, {"meal": {"slots": [
            {"name": "x", "options": [{"productId": str(menu.meal.id)}]},
        ]}})
        assert e.detail == M.MEAL_IN_MEAL

    def test_a_slot_needs_a_product(self):
        with pytest.raises(ValidationError):
            MealIn.model_validate({"slots": [{"name": "x", "options": []}]})


# ── The till's pull ───────────────────────────────────────────────────────────


class TestSync:
    def test_the_full_pull_carries_the_menu(self, menu):
        doneness = create_group(menu, group_body())
        put_category(menu, menu.burgers, {"links": {"mode": "groups", "groupIds": [doneness["id"]]}})
        put_product(menu, menu.cola, {"links": {"mode": "none"}, "allergens": ["gluten"]})
        put_product(menu, menu.meal, meal_body(menu))
        out = pull(menu, menu.tills[0])
        block = out.menu
        assert [g["name"] for g in block["groups"]] == ["מידת עשייה"]
        assert block["groups"][0]["options"][1] == {
            "id": doneness["options"][1]["id"], "name": "Medium", "kitchenName": None, "price": 0.0,
            "isDefault": True, "allergens": [], "linkedProductId": None, "maxQty": None,
        }
        assert block["links"]["categories"] == {str(menu.burgers.id): [doneness["id"]]}
        assert block["links"]["products"] == {str(menu.cola.id): []}
        assert [s["name"] for s in block["meals"][str(menu.meal.id)]] == ["עיקרית", "תוספת", "שתייה"]
        cola = next(p for p in out.products if p["id"] == str(menu.cola.id))
        assert cola["allergens"] == ["gluten"] and cola["courseId"] is None

    def test_a_delta_carries_it_only_after_a_change(self, menu):
        create_group(menu, group_body())
        first = pull(menu, menu.tills[0])
        assert first.menu is not None
        assert pull(menu, menu.tills[0], since=first.server_time).menu is None
        made = create_group(menu, addons_body())
        later = pull(menu, menu.tills[0], since=first.server_time)
        assert [g["name"] for g in later.menu["groups"]] == ["מידת עשייה", "תוספות"]
        # A delete is a change too: the block comes whole, without it.
        tasks = BackgroundTasks()
        R.delete_group(made["id"], tasks, **_ctx(menu))
        after = pull(menu, menu.tills[0], since=later.server_time)
        assert [g["name"] for g in after.menu["groups"]] == ["מידת עשייה"]

    def test_another_companys_groups_stay_out(self, menu):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=menu.tenant.id, name="Other")
        menu.db.add(other)
        menu.db.commit()
        create_group(menu, addons_body(name="ours", companyId=str(menu.company.id)))
        create_group(menu, addons_body(name="theirs", companyId=str(other.id)))
        create_group(menu, addons_body(name="everyone"))
        names = {g["name"] for g in pull(menu, menu.tills[0]).menu["groups"]}
        assert names == {"ours", "everyone"}

    def test_upsell_category_triggers_arrive_expanded(self, menu):
        tasks = BackgroundTasks()
        R.create_upsell(UpsellIn.model_validate({
            "name": "צ'יפס?", "triggerType": "category", "triggerIds": [str(menu.food.id)],
            "action": "add", "productId": str(menu.fries.id), "startTime": "11:00", "endTime": "16:00",
        }), tasks, **_ctx(menu))
        rule = pull(menu, menu.tills[0]).menu["upsells"][0]
        assert set(rule["triggerIds"]) == {str(menu.food.id), str(menu.burgers.id)}
        assert (rule["action"], rule["startTime"], rule["endTime"]) == ("add", "11:00", "16:00")

    def test_a_course_reaches_the_product_and_category_rows(self, menu):
        from app.schemas.menu import CoursesIn

        tasks = BackgroundTasks()
        out = R.put_courses(CoursesIn.model_validate({"courses": [{"name": "ראשונות"}, {"name": "עיקריות"}]}),
                            tasks, **_ctx(menu))
        mains = out["items"][1]["id"]
        put_category(menu, menu.burgers, {"setCourse": True, "courseId": mains})
        put_product(menu, menu.fries, {"setCourse": True, "courseId": mains})
        pulled = pull(menu, menu.tills[0])
        assert [c["name"] for c in pulled.menu["courses"]] == ["ראשונות", "עיקריות"]
        assert next(c for c in pulled.categories if c["id"] == str(menu.burgers.id))["courseId"] == mains
        assert next(p for p in pulled.products if p["id"] == str(menu.fries.id))["courseId"] == mains
        assert refused(put_product, menu, menu.fries, {"setCourse": True, "courseId": str(uuid.uuid4())}).detail == M.UNKNOWN_COURSE

    def test_the_watermark_moves_with_the_menu(self, menu):
        from app.services.sync import get_catalog_change_watermark_for_machine

        before = get_catalog_change_watermark_for_machine(menu.db, menu.tills[0])
        create_group(menu, group_body())
        after = get_catalog_change_watermark_for_machine(menu.db, menu.tills[0])
        assert after is not None and (before is None or after >= before)
        state = menu.db.query(MenuSyncState).one()
        stamp = state.changed_at if state.changed_at.tzinfo else state.changed_at.replace(tzinfo=timezone.utc)
        assert after == stamp


# ── Allocation ────────────────────────────────────────────────────────────────


class TestAllocation:
    def test_largest_remainder_is_exact(self):
        assert M.largest_remainder(6200, [5200, 1800, 1200]) == [3932, 1361, 907]
        assert M.largest_remainder(100, [1, 1, 1]) == [34, 33, 33]
        assert M.largest_remainder(7, [0, 0]) == [4, 3]
        assert M.largest_remainder(-100, [1, 1, 1]) == [-34, -33, -33]

    def test_the_spec_example(self):
        components = [
            {"listPrice": 52, "qty": 1, "modifiers": [{"charged": 5}]},
            {"listPrice": 18, "qty": 1, "upcharge": 3},
            {"listPrice": 12, "qty": 1},
        ]
        shares = M.allocate_meal(7000, 0, Decimal("1"), components)
        assert [s.gross for s in shares] == [4432, 1661, 907]

    def test_always_adds_up(self):
        rng = random.Random(7)
        for _ in range(500):
            n = rng.randint(1, 5)
            components = [
                {"listPrice": rng.randint(0, 6000) / 100, "qty": rng.randint(1, 3),
                 "upcharge": rng.choice([0, 0, 1.5, 3]), "modifiers": [{"charged": rng.choice([0, 2, 5])}]}
                for _ in range(n)
            ]
            qty = Decimal(rng.randint(1, 4))
            extras = sum(
                int(round((c["upcharge"] + c["modifiers"][0]["charged"]) * c["qty"] * int(qty) * 100))
                for c in components
            )
            gross = extras + rng.randint(0, 20000)
            discount = rng.randint(0, gross)
            shares = M.allocate_meal(gross, discount, qty, components)
            assert sum(s.gross for s in shares) == gross
            assert sum(s.discount for s in shares) == discount

    def test_upcharges_stay_with_their_component(self):
        shares = M.allocate_meal(6500, 0, Decimal("1"), [
            {"listPrice": 52}, {"listPrice": 18, "upcharge": 3}, {"listPrice": 12},
        ])
        base = M.largest_remainder(6200, [5200, 1800, 1200])
        assert [s.gross for s in shares] == [base[0], base[1] + 300, base[2]]

    def test_a_line_below_its_extras_falls_back(self):
        shares = M.allocate_meal(500, 0, Decimal("1"), [{"listPrice": 10, "upcharge": 3}, {"listPrice": 10, "upcharge": 3}])
        assert sum(s.gross for s in shares) == 500 and all(s.gross >= 0 for s in shares)


# ── Documents and reports ─────────────────────────────────────────────────────


def _meal_line(w, *, qty=1, discount=None, line_id=None, refund_of=None):
    unit = Decimal("70.00")
    line = {
        "id": line_id or str(uuid.uuid4()), "productId": str(w.meal.id), "productName": "burger meal",
        "quantity": qty, "unitPrice": str(unit), "totalPrice": str(unit * qty),
        "details": {
            "v": 1, "basePrice": 62,
            "meal": {"productId": str(w.meal.id), "name": "burger meal", "components": [
                {"productId": str(w.burger.id), "name": "burger", "listPrice": 52, "qty": 1,
                 "modifiers": [
                     {"groupId": None, "groupName": "תוספות", "kind": "addon", "optionId": None,
                      "name": "cheese", "price": 5, "qty": 1, "charged": 5},
                     {"groupName": "הסרות", "kind": "removal", "name": "tomato", "price": 0, "qty": 1, "charged": 0},
                 ]},
                {"productId": str(w.fries.id), "name": "fries", "listPrice": 18, "qty": 1, "upcharge": 3},
                {"productId": str(w.cola.id), "name": "cola", "listPrice": 12, "qty": 1},
            ]},
        },
    }
    if discount is not None:
        line["discount"] = discount
    if refund_of is not None:
        line["refundOfItemId"] = refund_of
    return line


def _burger_line(*, product, details=None, total="52.00"):
    line = {"id": str(uuid.uuid4()), "productId": str(product.id), "productName": "burger",
            "quantity": 1, "unitPrice": total, "totalPrice": total}
    if details is not None:
        line["details"] = details
    return line


def _doc(w, shift, items, *, number, credit=False, refund_of=None):
    total = sum(Decimal(str(i["totalPrice"])) for i in items)
    discount = Decimal("0") if credit else sum(Decimal(str(i.get("discount") or 0)) for i in items)
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed",
        "documentType": 330 if credit else 320,
        "totalAmount": str(total), "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": str(total - discount)}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY), "items": items,
    }
    if discount:
        body["documentDiscount"] = str(discount)
    if refund_of is not None:
        body["refundOfTransactionId"] = refund_of
    return TransactionIn.model_validate(body)


def _window(w):
    return resolve_report_window(w.db, w.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1))


class TestDocuments:
    def test_details_are_stored_and_taken_apart(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _doc(menu, shift, [_meal_line(menu)], number="7001")
        assert [r.status for r in upsert_transactions(menu.db, till, [doc])] == ["accepted"]
        upsert_transactions(menu.db, till, [doc])  # a re-push replaces, never doubles
        item = menu.db.query(TransactionItem).one()
        assert item.details["meal"]["name"] == "burger meal"
        parts = menu.db.query(TransactionItemPart).all()
        components = sorted((p for p in parts if p.kind == "component"), key=lambda p: p.component_index)
        assert [(p.name, p.gross) for p in components] == [
            ("burger", Decimal("44.32")), ("fries", Decimal("16.61")), ("cola", Decimal("9.07")),
        ]
        assert sum(p.gross for p in components) == item.total_price
        mods = [p for p in parts if p.kind == "modifier"]
        assert {(m.name, m.component_index, m.gross) for m in mods} == {
            ("cheese", 0, Decimal("5.00")), ("tomato", 0, Decimal("0.00")),
        }

    def test_an_old_line_without_details_is_untouched(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(menu.db, till, [_doc(menu, shift, [_burger_line(product=menu.burger)], number="7002")])
        assert menu.db.query(TransactionItem).one().details is None
        assert menu.db.query(TransactionItemPart).count() == 0

    def test_details_that_are_not_an_object_or_too_big_are_dropped(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        lines = [
            _burger_line(product=menu.burger, details="cheese"),
            _burger_line(product=menu.burger, details={"noteText": "x" * 40_000}),
        ]
        assert [r.status for r in upsert_transactions(menu.db, till, [_doc(menu, shift, lines, number="7003")])] == ["accepted"]
        assert [i.details for i in menu.db.query(TransactionItem).all()] == [None, None]

    def test_the_product_report_counts_burgers_inside_meals(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        upsert_transactions(menu.db, till, [
            _doc(menu, shift, [_burger_line(product=menu.burger)] * 1 + [_burger_line(product=menu.burger)], number="7010"),
            _doc(menu, shift, [_meal_line(menu, qty=2, discount="10.00")], number="7011"),
        ])
        report = build_product_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu))
        rows = {r.product_name: r for r in report.rows}
        assert rows["burger"].units_sold == 4 and rows["burger"].units_in_meals == 2
        assert "burger meal" not in rows
        assert rows["fries"].units_sold == 2 and rows["cola"].units_sold == 2
        # The money adds up to the documents', to the agora.
        assert round(report.totals.gross, 2) == 104.0 + 140.0
        assert round(report.totals.discounts, 2) == 10.0
        meals_view = build_product_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu), meals="meals")
        assert {r.product_name: r.units_sold for r in meals_view.rows} == {"burger": 2, "burger meal": 2}
        assert round(meals_view.totals.gross, 2) == round(report.totals.gross, 2)

    def test_a_refunded_meal_takes_its_components_back(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(menu, shift, [_meal_line(menu)], number="7020")
        upsert_transactions(menu.db, till, [sale])
        credit = _doc(menu, shift, [_meal_line(menu, refund_of=str(sale.items[0].id))], number="7021",
                      credit=True, refund_of=str(sale.id))
        assert [r.status for r in upsert_transactions(menu.db, till, [credit])] == ["accepted"]
        rows = {r.product_name: r for r in build_product_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu)).rows}
        assert rows["burger"].units_net == 0 and rows["burger"].refunds == pytest.approx(44.32)
        assert rows["cola"].net == pytest.approx(0.0)

    def test_the_modifier_and_meal_reports(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        burger = _burger_line(product=menu.burger, total="57.00", details={"modifiers": [
            {"groupName": "תוספות", "kind": "addon", "name": "cheese", "price": 5, "qty": 1, "charged": 5},
        ]})
        upsert_transactions(menu.db, till, [_doc(menu, shift, [burger, _meal_line(menu)], number="7030")])
        mods = M.build_modifier_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu))
        cheese = next(r for r in mods["rows"] if r["name"] == "cheese")
        assert cheese["unitsSold"] == 2 and cheese["revenue"] == 10.0
        assert mods["totals"]["removals"] == 1
        meals = M.build_meal_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu))
        row = meals["rows"][0]
        assert row["name"] == "burger meal" and row["unitsSold"] == 1 and row["gross"] == 70.0
        assert {c["name"]: c["gross"] for c in row["components"]} == {"burger": 44.32, "fries": 16.61, "cola": 9.07}
        assert next(c for c in row["components"] if c["name"] == "fries")["upcharges"] == 3.0


class TestLimitsAndEntitlements:
    """docs/SPEC_MENU_MODIFIERS.md §3.9: per-option limits, slot quantities, refills, order limits."""

    def test_an_option_limit_needs_quantities_and_fits_the_group(self):
        eggs = {"name": "eggs", "maxQty": 3}
        body = addons_body(allowQuantity=True, options=[eggs, {"name": "cheese"}])
        assert body.options[0].max_qty == 3 and body.options[1].max_qty is None
        with pytest.raises(ValidationError):
            addons_body(allowQuantity=False, options=[eggs])
        with pytest.raises(ValidationError):
            addons_body(allowQuantity=True, maxSelect=2, freeCount=0, options=[eggs])

    def test_choosing_more_of_an_option_than_its_limit(self):
        rules = _rules(max_select=5, free_count=0, limits={"egg": 3})
        assert M.validate_picks(rules, [M.Pick("egg", qty=3), M.Pick("cheese", qty=2)]) == []
        assert M.validate_picks(rules, [M.Pick("egg", qty=4)]) == ["option_above_max"]
        # The same option picked twice still counts as one option.
        assert "option_above_max" in M.validate_picks(rules, [M.Pick("egg", qty=2), M.Pick("egg", qty=2)])

    def test_slot_quantities_repeats_and_refills(self, menu):
        breakfast = {"meal": {"slots": [
            {"name": "שתייה חמה", "quantity": 2, "minSelect": 0, "maxSelect": 2, "allowRepeat": True,
             "deferred": True, "refillable": True, "maxRefills": 2,
             "options": [{"productId": str(menu.cola.id), "isDefault": True}]},
        ]}}
        out = put_product(menu, menu.meal, breakfast)
        slot = out["meal"]["slots"][0]
        assert (slot["quantity"], slot["allowRepeat"], slot["deferred"], slot["refillable"], slot["maxRefills"]) == (
            2, True, True, True, 2,
        )
        synced = pull(menu, menu.tills[0]).menu["meals"][str(menu.meal.id)][0]
        assert (synced["quantity"], synced["maxSelect"], synced["deferred"]) == (2, 2, True)
        with pytest.raises(ValidationError):
            MealIn.model_validate({"slots": [{"name": "x", "quantity": 1, "maxSelect": 2,
                                              "options": [{"productId": str(menu.cola.id)}]}]})
        with pytest.raises(ValidationError):  # two required, one product, no repeats
            MealIn.model_validate({"slots": [{"name": "x", "quantity": 2, "minSelect": 2, "maxSelect": 2,
                                              "options": [{"productId": str(menu.cola.id)}]}]})

    def test_product_order_limit_and_refills_reach_the_till(self, menu):
        put_product(menu, menu.cola, {"setLimits": True, "maxPerOrder": 2, "refillable": True, "maxRefills": 3})
        pulled = pull(menu, menu.tills[0])
        row = next(p for p in pulled.products if p["id"] == str(menu.cola.id))
        assert (row["maxPerOrder"], row["refillable"], row["maxRefills"]) == (2, True, 3)
        assert pulled.menu["productLimits"] == {str(menu.cola.id): {"maxPerOrder": 2, "refillable": True, "maxRefills": 3}}
        section = R.get_product_menu(str(menu.cola.id), **_ctx(menu))
        assert (section["maxPerOrder"], section["refillable"], section["maxRefills"]) == (2, True, 3)
        put_product(menu, menu.cola, {"setLimits": True, "maxPerOrder": None, "refillable": False, "maxRefills": 3})
        assert R.get_product_menu(str(menu.cola.id), **_ctx(menu))["maxRefills"] is None

    def test_the_meal_report_counts_what_was_left_taken_later_and_refilled(self, menu):
        till = menu.tills[0]
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        meal = _meal_line(menu)
        meal["details"]["entitlements"] = [
            {"slotId": "s1", "slotName": "שתייה", "included": 2, "used": 1, "remaining": 1},
        ]
        late = _burger_line(product=menu.cola, total="0.00", details={
            "mealRef": {"lineRef": "L1", "mealProductId": str(menu.meal.id), "slotName": "שתייה", "kind": "deferred"},
        })
        refill = _burger_line(product=menu.cola, total="0.00", details={
            "mealRef": {"lineRef": "L1", "mealProductId": str(menu.meal.id), "slotName": "שתייה", "kind": "refill"},
        })
        late["productName"] = refill["productName"] = "cola"
        upsert_transactions(menu.db, till, [_doc(menu, shift, [meal, late, refill], number="7050")])
        row = M.build_meal_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu))["rows"][0]
        assert row["unredeemed"] == [{"slotName": "שתייה", "count": 1.0}]
        assert (row["takenLater"], row["refills"]) == (1.0, 1.0)
        # The ₪0 lines still count as colas sold; the meal's money is unchanged.
        rows = {r.product_name: r for r in build_product_sales_report(menu.db, menu.admin, menu.tenant.id, _window(menu)).rows}
        assert rows["cola"].units_sold == 3 and rows["cola"].gross == pytest.approx(9.07)


class TestKitchenRelay:
    def test_a_relayed_ticket_keeps_how_the_dish_is_made(self):
        from app.schemas.kitchen_printers import PrintJobIn

        body = PrintJobIn.model_validate({
            "id": str(uuid.uuid4()), "printerId": str(uuid.uuid4()),
            "ticket": {"source": "table", "createdAt": "2026-10-04T12:00:00+03:00", "lines": [{
                "productId": "p", "name": "המבורגר", "quantity": 1, "notes": "חתוך לחצי",
                "mods": ["מדיום", "+ גבינה"], "removals": ["בלי עגבנייה"], "important": True,
                "allergies": ["בוטנים"], "seat": "סועד 2", "course": "עיקריות", "mealName": "ארוחת המבורגר",
            }]},
        })
        line = body.ticket.model_dump(by_alias=True)["lines"][0]
        assert (line["mods"], line["removals"], line["important"], line["allergies"]) == (
            ["מדיום", "+ גבינה"], ["בלי עגבנייה"], True, ["בוטנים"],
        )
        assert (line["seat"], line["course"], line["mealName"]) == ("סועד 2", "עיקריות", "ארוחת המבורגר")


class TestUpsells:
    def _rule(self, w):
        tasks = BackgroundTasks()
        return R.create_upsell(UpsellIn.model_validate({
            "name": "make it a meal", "triggerType": "product", "triggerIds": [str(w.burger.id)],
            "action": "upgrade", "productId": str(w.meal.id),
        }), tasks, **_ctx(w))

    def test_a_product_cannot_suggest_itself(self, menu):
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", "triggerType": "product", "triggerIds": [str(menu.fries.id)],
                                     "action": "add", "productId": str(menu.fries.id)})
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
                                     "productId": str(menu.fries.id), "startTime": "11:00"})

    def test_stats_keep_the_larger_count_and_the_report_reads_them(self, menu):
        rule = self._rule(menu)
        till = menu.tills[0]
        today = str(TODAY)
        R.post_upsell_stats(str(till.id), UpsellStatsIn.model_validate(
            {"stats": [{"ruleId": rule["id"], "day": today, "shown": 4, "accepted": 1, "dismissed": 2}]}), till, menu.db)
        # A late or retried report never counts twice.
        R.post_upsell_stats(str(till.id), UpsellStatsIn.model_validate(
            {"stats": [{"ruleId": rule["id"], "day": today, "shown": 3, "accepted": 1, "dismissed": 2}]}), till, menu.db)
        assert menu.db.query(UpsellStat).one().shown == 4
        shift = menu.shift(till, 1, status=ShiftStatus.OPEN)
        line = _meal_line(menu)
        line["upsellRuleId"] = rule["id"]
        upsert_transactions(menu.db, till, [_doc(menu, shift, [line], number="7040")])
        out = M.build_upsell_report(menu.db, menu.admin, menu.tenant.id, _window(menu))
        row = out["rows"][0]
        assert (row["name"], row["shown"], row["accepted"], row["dismissed"]) == ("make it a meal", 4, 1, 2)
        assert row["acceptanceRate"] == 0.25 and row["revenue"] == 70.0 and row["lines"] == 1
