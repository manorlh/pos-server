"""Cover for writes that name a company, shop or till the caller does not manage.

Management flows downwards: a company manager manages their company and its
subsidiaries, never a sibling or a parent. Reads were already scoped that way; these
are the *creates* (and the one move) that were not:

* `POST /shops` put a shop under any company in the tenant, and creating a shop runs
  the product rules, so the new shop was filled with that company's catalog at once;
* `POST /products` and `POST /categories` accepted any `companyId`, `shopId` and
  `posMachineId` — a product pinned to another company's till is sold on that till;
* `PUT /machines/{id}` checked the target shop for company managers only, so a shop
  manager could seat their till in any shop of the tenant and take its register number.

Every refusal is also checked for what it must not have left behind: no shop, product,
category or override row, no seeded operator, no SKU drawn, no register number, no commit.

Same fake session and company tree as `test_product_shop_scope.py`:
    H (holding)
    ├── A ── A1 (sub-company of A)
    └── B          (A's sibling)
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.category import Category
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.shop_register_sequence import ShopRegisterSequence
from app.models.user import UserRole
from app.routers import categories as categories_router
from app.routers import machines as machines_router
from app.routers import products as products_router
from app.routers import shops as shops_router
from app.schemas.category import CategoryCreate
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.product import ProductCreate
from app.schemas.shop import ShopCreate

from test_product_shop_scope import _distributor, _product, _rows, _user, world  # noqa: F401


def _manager_of_a(w):
    return _user(UserRole.COMPANY_MANAGER, company_id=w.A)


def _forbidden(call):
    with pytest.raises(HTTPException) as e:
        call()
    assert e.value.status_code == 403
    return e.value


def _machine(w, shop, *, distributor_id=None):
    m = POSMachine(
        id=uuid.uuid4(),
        tenant_id=w.tenant,
        shop_id=shop.id,
        pairing_status=PairingStatus.ASSIGNED,
        is_active=True,
        name="till",
        machine_code=str(uuid.uuid4()),
        distributor_id=distributor_id,
    )
    m.shop = shop
    w.db.add(m)
    return m


# ── POST /shops ──────────────────────────────────────────────────────────────


class TestCreateShop:
    @pytest.fixture
    def seeded(self, world, monkeypatch):
        seeded: list = []
        monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda _db, shop: seeded.append(shop))
        return seeded

    def _create(self, w, company_id, user):
        return shops_router.create_shop(
            ShopCreate(name="New shop", companyId=company_id), user, w.tenant, w.db
        )

    def test_a_manager_opens_a_shop_in_their_own_company(self, world, seeded):
        rule = _product(world, world.A, mode="company", scope_company=world.A)
        shop = self._create(world, world.A, _manager_of_a(world))
        assert shop.company_id == world.A and world.db.commits == 1
        assert seeded == [shop]
        assert str(shop.id) in _rows(world, rule), "the company's rules still run for it"

    def test_and_in_a_subsidiary(self, world, seeded):
        shop = self._create(world, world.A1, _manager_of_a(world))
        assert shop.company_id == world.A1 and world.db.commits == 1

    @pytest.mark.parametrize("target", ["B", "H"], ids=["sibling", "parent"])
    def test_never_in_a_sibling_or_a_parent_and_nothing_is_written(self, world, seeded, target):
        company = getattr(world, target)
        rule = _product(world, company, mode="company", scope_company=company)
        shops_before = list(world.db.of(Shop))

        _forbidden(lambda: self._create(world, company, _manager_of_a(world)))

        assert world.db.of(Shop) == shops_before
        assert seeded == [], "no operator seeded"
        assert _rows(world, rule) == {} and world.db.of(ShopProductOverride) == []
        assert world.db.of(ShopRegisterSequence) == []
        assert world.db.commits == 0

    def test_a_sub_company_manager_cannot_open_one_in_its_parent(self, world, seeded):
        _forbidden(lambda: self._create(world, world.A, _user(UserRole.COMPANY_MANAGER, company_id=world.A1)))
        assert seeded == []

    def test_a_distributor_still_opens_one_anywhere_in_the_tenant(self, world, seeded):
        shop = self._create(world, world.B, _distributor())
        assert shop.company_id == world.B


# ── POST /products ───────────────────────────────────────────────────────────


@pytest.fixture
def skus(world, monkeypatch):
    drawn: list = []

    def _sku(*_a):
        drawn.append("sku")
        return ("100", True)

    def _global(*_a):
        drawn.append("global")
        return "G-100"

    monkeypatch.setattr(products_router, "resolve_sku_for_create", _sku)
    monkeypatch.setattr(products_router, "allocate_global_sku", _global)
    return drawn


def _create_product(w, user, **body):
    payload = {"name": "Cola", "price": 10, "categoryId": str(w.category.id), **body}
    return products_router.create_product(ProductCreate.model_validate(payload), user, w.tenant, w.db)


class TestCreateProduct:
    def test_a_manager_creates_one_for_their_own_company(self, world, skus):
        p = _create_product(world, _manager_of_a(world), companyId=str(world.A))
        assert p.company_id == world.A and world.db.commits == 1

    def test_omitting_the_company_still_means_their_own(self, world, skus):
        p = _create_product(world, _manager_of_a(world))
        assert p.company_id == world.A

    def test_and_for_a_subsidiary(self, world, skus):
        p = _create_product(world, _manager_of_a(world), companyId=str(world.A1))
        assert p.company_id == world.A1 and world.db.commits == 1

    @pytest.mark.parametrize("target", ["B", "H"], ids=["sibling", "parent"])
    def test_never_for_a_sibling_or_a_parent_and_nothing_is_written(self, world, skus, target):
        _forbidden(lambda: _create_product(world, _manager_of_a(world), companyId=str(getattr(world, target))))
        assert world.db.of(Product) == []
        assert skus == [], "no SKU drawn from the tenant's counters"
        assert world.db.commits == 0

    def test_a_shop_manager_cannot_create_one_for_the_company_above_theirs(self, world, skus):
        manager = _user(UserRole.SHOP_MANAGER, company_id=world.A, shop_id=world.shops.a1.id)
        _forbidden(lambda: _create_product(world, manager, companyId=str(world.H)))
        assert world.db.of(Product) == [] and skus == []

    def test_pinned_to_a_shop_of_a_subsidiary(self, world, skus):
        p = _create_product(world, _manager_of_a(world), shopId=str(world.shops.a1_sub.id))
        assert p.shop_id == world.shops.a1_sub.id

    @pytest.mark.parametrize("shop", ["b", "h"], ids=["sibling", "parent"])
    def test_never_pinned_to_a_sibling_or_parent_shop(self, world, skus, shop):
        target = getattr(world.shops, shop)
        _forbidden(lambda: _create_product(world, _manager_of_a(world), shopId=str(target.id)))
        assert world.db.of(Product) == [] and skus == [] and world.db.commits == 0

    def test_on_a_till_of_a_subsidiary(self, world, skus):
        till = _machine(world, world.shops.a1_sub)
        p = _create_product(world, _manager_of_a(world), posMachineId=str(till.id), catalogLevel="local")
        assert p.pos_machine_id == till.id

    @pytest.mark.parametrize("shop", ["b", "h"], ids=["sibling", "parent"])
    def test_never_on_a_sibling_or_parent_till(self, world, skus, shop):
        # A product pinned to a till is sold on it: this was a way onto another company's register.
        till = _machine(world, getattr(world.shops, shop))
        _forbidden(lambda: _create_product(
            world, _manager_of_a(world), posMachineId=str(till.id), catalogLevel="local"
        ))
        assert world.db.of(Product) == [] and skus == [] and world.db.commits == 0

    def test_a_scope_rule_is_never_run_for_a_refused_company(self, world, skus):
        _forbidden(lambda: _create_product(
            world, _manager_of_a(world),
            companyId=str(world.B),
            shopScope={"mode": "company", "companyId": str(world.B)},
        ))
        assert world.db.of(ShopProductOverride) == []

    def test_a_distributor_still_creates_one_for_any_company(self, world, skus):
        p = _create_product(world, _distributor(), companyId=str(world.B), shopId=str(world.shops.h.id))
        assert p.company_id == world.B


# ── POST /categories ─────────────────────────────────────────────────────────


class TestCreateCategory:
    @pytest.fixture(autouse=True)
    def _quiet(self, monkeypatch):
        monkeypatch.setattr(categories_router, "_trigger_catalog_notify", lambda *_a, **_k: None)

    def _create(self, w, user, **body):
        return categories_router.create_category(
            CategoryCreate.model_validate({"name": "Snacks", **body}), user, w.tenant, w.db
        )

    def _new(self, w):
        return [c for c in w.db.of(Category) if c is not w.category]

    def test_a_manager_creates_one_for_their_own_company(self, world):
        c = self._create(world, _manager_of_a(world), companyId=str(world.A))
        assert c.company_id == world.A and world.db.commits == 1

    def test_and_for_a_subsidiary(self, world):
        c = self._create(world, _manager_of_a(world), companyId=str(world.A1))
        assert c.company_id == world.A1 and world.db.commits == 1

    @pytest.mark.parametrize("target", ["B", "H"], ids=["sibling", "parent"])
    def test_never_for_a_sibling_or_a_parent_and_nothing_is_written(self, world, target):
        _forbidden(lambda: self._create(world, _manager_of_a(world), companyId=str(getattr(world, target))))
        assert self._new(world) == [] and world.db.commits == 0

    @pytest.mark.parametrize("shop", ["b", "h"], ids=["sibling", "parent"])
    def test_never_on_a_sibling_or_parent_shop_or_till(self, world, shop):
        target = getattr(world.shops, shop)
        _forbidden(lambda: self._create(world, _manager_of_a(world), shopId=str(target.id)))
        till = _machine(world, target)
        _forbidden(lambda: self._create(world, _manager_of_a(world), posMachineId=str(till.id)))
        assert self._new(world) == [] and world.db.commits == 0

    def test_on_a_subsidiarys_shop_and_till(self, world):
        till = _machine(world, world.shops.a1_sub)
        c = self._create(
            world, _manager_of_a(world), shopId=str(world.shops.a1_sub.id), posMachineId=str(till.id)
        )
        assert (c.shop_id, c.pos_machine_id) == (world.shops.a1_sub.id, till.id)

    def test_a_distributor_still_creates_one_for_any_company(self, world):
        c = self._create(world, _distributor(), companyId=str(world.B))
        assert c.company_id == world.B


# ── PUT /machines/{id} with a new shop ───────────────────────────────────────


class TestMoveMachine:
    @pytest.fixture
    def moves(self, world, monkeypatch):
        moved: list = []

        def _set(_db, machine, shop_id):
            moved.append(shop_id)
            machine.shop_id = shop_id
            machine.pos_number = "1"

        monkeypatch.setattr(machines_router, "set_machine_shop", _set)
        monkeypatch.setattr(machines_router, "shop_belongs_to_company", lambda *_a: True)
        # Moving a till also clears its own catalog list (tests/test_machine_catalog.py
        # covers that); this fake session has no list to clear.
        monkeypatch.setattr(machines_router.machine_catalog, "reset_for_new_shop", lambda *_a: False)
        return moved

    def _move(self, w, machine, shop, user):
        return machines_router.update_machine(
            str(machine.id), POSMachineUpdate(shopId=shop.id), user, w.tenant, w.db
        )

    def _refused(self, w, machine, shop, user, moves):
        before = (machine.shop_id, machine.pos_number, machine.pairing_status)
        _forbidden(lambda: self._move(w, machine, shop, user))
        assert (machine.shop_id, machine.pos_number, machine.pairing_status) == before
        assert moves == [], "no register number drawn"
        assert w.db.of(ShopRegisterSequence) == [] and w.db.commits == 0

    def test_a_company_manager_moves_a_till_within_their_company(self, world, moves):
        till = _machine(world, world.shops.a1)
        self._move(world, till, world.shops.a2, _manager_of_a(world))
        assert till.shop_id == world.shops.a2.id and world.db.commits == 1

    def test_and_into_a_subsidiary(self, world, moves):
        till = _machine(world, world.shops.a1)
        self._move(world, till, world.shops.a1_sub, _manager_of_a(world))
        assert till.shop_id == world.shops.a1_sub.id

    @pytest.mark.parametrize("shop", ["b", "h"], ids=["sibling", "parent"])
    def test_a_company_manager_never_into_a_sibling_or_parent(self, world, moves, shop):
        till = _machine(world, world.shops.a1)
        self._refused(world, till, getattr(world.shops, shop), _manager_of_a(world), moves)

    @pytest.mark.parametrize("shop", ["b", "h", "a2"], ids=["sibling", "parent", "same-company"])
    def test_a_shop_manager_cannot_seat_their_till_in_another_shop(self, world, moves, shop):
        manager = _user(UserRole.SHOP_MANAGER, company_id=world.A, shop_id=world.shops.a1.id)
        till = _machine(world, world.shops.a1)
        self._refused(world, till, getattr(world.shops, shop), manager, moves)

    def test_a_shop_manager_may_still_re_seat_it_in_their_own_shop(self, world, moves):
        manager = _user(UserRole.SHOP_MANAGER, company_id=world.A, shop_id=world.shops.a1.id)
        till = _machine(world, world.shops.a1)
        self._move(world, till, world.shops.a1, manager)
        assert till.shop_id == world.shops.a1.id

    def test_a_distributor_still_moves_their_till_anywhere(self, world, moves):
        dist = _distributor()
        till = _machine(world, world.shops.a1, distributor_id=dist.id)
        self._move(world, till, world.shops.b, dist)
        assert till.shop_id == world.shops.b.id
