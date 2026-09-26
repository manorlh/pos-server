"""Cover for choosing where a product is sold.

A global product reaches a till only through a `shop_product_overrides` row. The shop
scope adds those rows for you, and each test below names a way that could look as if it
worked while doing damage:

* a rule that ignores "include sub-companies" and quietly puts a product on every branch;
* a rule that overwrites a price somebody set for one shop;
* a shop leaving scope losing its row — and its price — instead of being unlisted;
* a rule reaching into a row somebody added by hand;
* a new shop opening with none of the products its company's rule covers;
* a sibling company's product landing on this company's till;
* a caller who may not write a shop's assortment putting the product there anyway.

No database, like the rest of tests/. `_FakeDb` evaluates the few SQLAlchemy filter
shapes these queries use against in-memory rows, so dropping a filter from a query
fails a test here rather than passing silently. The company tree is a dict.
"""
from __future__ import annotations

import enum
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import (
    BinaryExpression,
    BindParameter,
    BooleanClauseList,
    False_,
    Grouping,
    Null,
    True_,
)

from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
from app.routers import companies as companies_router
from app.routers import products as products_router
from app.routers import shops as shops_router
from app.schemas.company import CompanyUpdate
from app.schemas.product import (
    ProductCreate,
    ProductResponse,
    ProductUpdate,
    ShopScopePreviewRequest,
)
from app.schemas.shop import ShopCreate, ShopUpdate
from app.schemas.shop_product_override import ShopProductOverrideUpsert
from app.services import company_hierarchy as H
from app.services import product_shop_scope as S


# ── A session that applies its filters ───────────────────────────────────────


def _norm(value):
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def _value(expr, row):
    if isinstance(expr, BindParameter):
        return expr.value
    if isinstance(expr, True_):
        return True
    if isinstance(expr, False_):
        return False
    if isinstance(expr, Null):
        return None
    if isinstance(expr, Grouping):
        return _value(expr.element, row)
    key = getattr(expr, "key", None)
    if key is not None and getattr(expr, "table", None) is not None:
        return getattr(row, key)
    raise NotImplementedError(type(expr))


def _matches(clause, row) -> bool:
    if isinstance(clause, BooleanClauseList):
        results = [_matches(c, row) for c in clause.clauses]
        return any(results) if clause.operator is operators.or_ else all(results)
    if isinstance(clause, Grouping):
        return _matches(clause.element, row)
    if isinstance(clause, BinaryExpression):
        op = clause.operator
        left = _norm(_value(clause.left, row))
        if op is operators.in_op:
            return left in [_norm(v) for v in clause.right.value]
        right = _norm(_value(clause.right, row))
        if op is operators.eq:
            return left == right
        if op is operators.ne:
            return left != right
        if op is operators.is_:
            return left is right or left == right
        raise NotImplementedError(op)
    raise NotImplementedError(type(clause))


class _Query:
    def __init__(self, rows):
        self._rows = list(rows)
        self._clauses = []

    def filter(self, *clauses):
        self._clauses.extend(clauses)
        return self

    def order_by(self, *_):
        return self

    def _hits(self):
        return [r for r in self._rows if all(_matches(c, r) for c in self._clauses)]

    def first(self):
        hits = self._hits()
        return hits[0] if hits else None

    def all(self):
        return self._hits()

    def count(self):
        return len(self._hits())


class _FakeDb:
    def __init__(self, *rows):
        self.rows: dict = {}
        self.info: dict = {}
        self.commits = 0
        self.deleted: list = []
        for row in rows:
            self.add(row)

    def query(self, model):
        return _Query(self.rows.get(model, []))

    def add(self, obj):
        # A real flush fills the column default; the hooks read `shop.id` right after.
        if getattr(obj, "id", "absent") is None:
            obj.id = uuid.uuid4()
        bucket = self.rows.setdefault(type(obj), [])
        if obj not in bucket:
            bucket.append(obj)

    def delete(self, obj):
        self.deleted.append(obj)
        self.rows[type(obj)].remove(obj)

    def flush(self):
        pass

    def commit(self):
        self.commits += 1

    def refresh(self, _obj):
        pass

    def of(self, model):
        return list(self.rows.get(model, []))


# ── The company tree, as a dict ──────────────────────────────────────────────


class _Tree:
    """child id -> parent id. Patched in for the recursive CTEs the tests cannot run."""

    def __init__(self, parents: dict):
        self.parents = dict(parents)

    def descendants(self, _db, company_id):
        if company_id is None:
            return []
        root = str(company_id)
        out, frontier = [company_id], [root]
        while frontier:
            current = frontier.pop()
            for child, parent in self.parents.items():
                if parent is not None and str(parent) == current:
                    out.append(child)
                    frontier.append(str(child))
        return out

    def ancestors(self, _db, company_id):
        out, cursor = [], self.parents.get(company_id)
        while cursor is not None:
            out.append(cursor)
            cursor = self.parents.get(cursor)
        return out


@pytest.fixture
def world(monkeypatch):
    """
    Tenant T:
        H (holding)
        ├── A ── A1 (sub-company of A)
        └── B          (A's sibling)
    Shops: a_shop1, a_shop2 in A; a1_shop in A1; b_shop in B; h_shop in H;
    a_closed (inactive) in A. Plus a shop of another tenant.
    """
    tenant, other_tenant = uuid.uuid4(), uuid.uuid4()
    H_id, A, A1, B = (uuid.uuid4() for _ in range(4))
    tree = _Tree({H_id: None, A: H_id, A1: A, B: H_id})
    for target in (S, H):
        monkeypatch.setattr(target, "descendant_company_ids", tree.descendants)
        monkeypatch.setattr(target, "ancestor_company_ids", tree.ancestors)
    monkeypatch.setattr(shops_router, "ancestor_company_ids", tree.ancestors)

    notified: list = []
    monkeypatch.setattr(
        shops_router, "notify_machines_for_shop", lambda _db, sid, reason: notified.append(sid)
    )
    monkeypatch.setattr(
        products_router, "notify_machines_for_shop", lambda _db, sid, reason: notified.append(sid)
    )
    monkeypatch.setattr(
        companies_router, "notify_machines_for_shop", lambda _db, sid, reason: notified.append(sid)
    )
    monkeypatch.setattr(products_router, "_trigger_catalog_notify", lambda *_a, **_k: None)

    def shop(name, company, *, active=True, tenant_id=tenant):
        return Shop(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company, name=name, is_active=active)

    shops = SimpleNamespace(
        a1=shop("A shop 1", A),
        a2=shop("A shop 2", A),
        a_closed=shop("A closed", A, active=False),
        a1_sub=shop("A1 shop", A1),
        b=shop("B shop", B),
        h=shop("H shop", H_id),
        foreign=shop("Other tenant", A, tenant_id=other_tenant),
    )
    companies = [
        Company(id=cid, tenant_id=tenant, name=name, parent_company_id=tree.parents[cid])
        for cid, name in ((H_id, "Holding"), (A, "Alpha"), (A1, "Alpha One"), (B, "Beta"))
    ]
    category = Category(id=uuid.uuid4(), tenant_id=tenant, name="Drinks")
    db = _FakeDb(*vars(shops).values(), *companies, category)
    return SimpleNamespace(
        db=db, tenant=tenant, H=H_id, A=A, A1=A1, B=B, tree=tree, shops=shops,
        category=category, notified=notified,
    )


def _product(w, company_id, **kw):
    p = Product(
        id=uuid.uuid4(),
        tenant_id=w.tenant,
        company_id=company_id,
        category_id=w.category.id,
        catalog_level=CatalogLevel.GLOBAL,
        pos_machine_id=None,
        name=kw.pop("name", "Cola"),
        price=Decimal("10.00"),
        sku=kw.pop("sku", "1"),
        shop_scope_mode=kw.pop("mode", None),
        shop_scope_company_id=kw.pop("scope_company", None),
        shop_scope_include_subcompanies=kw.pop("include_sub", False),
        **kw,
    )
    w.db.add(p)
    return p


def _row(w, product, shop, *, by_rule, listed=True, price=None):
    r = ShopProductOverride(
        id=uuid.uuid4(),
        shop_id=shop.id,
        global_product_id=product.id,
        price=price,
        is_listed=listed,
        is_available=True,
        assigned_by_rule=by_rule,
    )
    w.db.add(r)
    return r


def _rows(w, product):
    return {
        str(r.shop_id): r
        for r in w.db.of(ShopProductOverride)
        if str(r.global_product_id) == str(product.id)
    }


def _response(product):
    from datetime import datetime, timezone

    product.created_at = product.updated_at = datetime.now(timezone.utc)
    return ProductResponse.model_validate(product).model_dump(by_alias=True)


def _user(role, *, company_id=None, shop_id=None):
    u = User()
    u.id = uuid.uuid4()
    u.role = role
    u.company_id = company_id
    u.shop_id = shop_id
    return u


def _distributor():
    return _user(UserRole.DISTRIBUTOR)


# ── Where a product may be sold at all ───────────────────────────────────────


class TestProductAllowedInShop:
    def test_own_company_and_every_company_beneath_it(self, world):
        p = _product(world, world.A)
        assert S.product_allowed_in_shop(world.db, p, world.shops.a1)
        assert S.product_allowed_in_shop(world.db, p, world.shops.a1_sub)

    def test_a_holding_companys_product_reaches_a_sub_companys_shop(self, world):
        # The bug: equality alone refused this, contradicting catalog_company_ids.
        p = _product(world, world.H)
        assert S.product_allowed_in_shop(world.db, p, world.shops.a1_sub)
        assert shops_router._global_product_allowed_for_shop(world.db, p, world.shops.b)

    def test_a_sibling_companys_product_is_refused(self, world):
        p = _product(world, world.B)
        assert not S.product_allowed_in_shop(world.db, p, world.shops.a1)
        assert not shops_router._global_product_allowed_for_shop(world.db, p, world.shops.a1)

    def test_it_never_flows_upwards(self, world):
        # A sub-company's product is not the holding company's to sell.
        p = _product(world, world.A1)
        assert not S.product_allowed_in_shop(world.db, p, world.shops.a1)
        assert not S.product_allowed_in_shop(world.db, p, world.shops.h)

    def test_never_across_tenants(self, world):
        p = _product(world, world.A)
        assert not S.product_allowed_in_shop(world.db, p, world.shops.foreign)
        tenant_wide = _product(world, None)
        assert S.product_allowed_in_shop(world.db, tenant_wide, world.shops.b)
        assert not S.product_allowed_in_shop(world.db, tenant_wide, world.shops.foreign)


class TestAssignEndpointFollowsTheTree:
    """`POST /shops/{id}/product-overrides/{pid}` — the one-at-a-time path, both ways."""

    def _assign(self, w, product, shop):
        return shops_router.assign_shop_product(
            str(shop.id), str(product.id), _distributor(), w.tenant, w.db
        )

    def test_a_parents_product_can_be_assigned_to_a_sub_companys_shop(self, world):
        p = _product(world, world.A)
        self._assign(world, p, world.shops.a1_sub)
        assert str(world.shops.a1_sub.id) in _rows(world, p)

    def test_a_siblings_product_is_still_refused(self, world):
        p = _product(world, world.B)
        with pytest.raises(HTTPException) as e:
            self._assign(world, p, world.shops.a1)
        assert e.value.status_code == 403
        assert _rows(world, p) == {}


class TestAssortmentListsFollowTheTree:
    """The shop's assortment list and "add from catalog" library read the same rule."""

    def test_a_sub_company_shop_lists_its_parents_products_but_not_a_siblings(self, world):
        predicate = shops_router._global_product_company_scope(world.db, world.shops.a1_sub)
        visible = {
            name
            for name, company in (("holding", world.H), ("parent", world.A), ("own", world.A1),
                                  ("sibling", world.B), ("tenant-wide", None))
            if _matches(predicate, _product(world, company, name=name, sku=name))
        }
        assert visible == {"holding", "parent", "own", "tenant-wide"}


# ── Which shops a rule covers ────────────────────────────────────────────────


class TestShopsInScope:
    def _ids(self, shops):
        return {s.name for s in shops}

    def test_without_sub_companies_only_the_companys_own_active_shops(self, world):
        p = _product(world, world.H, mode="company", scope_company=world.A)
        assert self._ids(S.shops_in_scope(world.db, p)) == {"A shop 1", "A shop 2"}

    def test_with_sub_companies_the_descendants_shops_too(self, world):
        p = _product(world, world.H, mode="company", scope_company=world.A, include_sub=True)
        assert self._ids(S.shops_in_scope(world.db, p)) == {"A shop 1", "A shop 2", "A1 shop"}

    def test_the_whole_group_from_the_top(self, world):
        p = _product(world, world.H, mode="company", scope_company=world.H, include_sub=True)
        assert self._ids(S.shops_in_scope(world.db, p)) == {
            "A shop 1", "A shop 2", "A1 shop", "B shop", "H shop",
        }

    def test_a_rule_can_never_reach_a_shop_the_product_may_not_be_in(self, world):
        # A sub-company's product scoped at the holding company: only the sub's own
        # shops qualify, and the rule company itself is refused on write.
        p = _product(world, world.A1, mode="company", scope_company=world.H, include_sub=True)
        assert self._ids(S.shops_in_scope(world.db, p)) == {"A1 shop"}
        assert not S.scope_company_allowed(world.db, p, world.H)

    def test_a_siblings_company_is_not_a_scope_the_product_can_have(self, world):
        p = _product(world, world.A)
        assert S.scope_company_allowed(world.db, p, world.A1)
        assert not S.scope_company_allowed(world.db, p, world.B)

    def test_other_tenants_shops_are_never_in_scope(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        assert "Other tenant" not in self._ids(S.shops_in_scope(world.db, p))

    def test_a_hand_managed_product_has_no_scope(self, world):
        assert S.shops_in_scope(world.db, _product(world, world.A)) == []


# ── Applying a rule ──────────────────────────────────────────────────────────


class TestApplyRule:
    def test_every_shop_in_scope_gets_a_row_on_the_base_price(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        touched = S.apply_rule(world.db, p)
        rows = _rows(world, p)
        assert set(rows) == {str(world.shops.a1.id), str(world.shops.a2.id)}
        assert touched == set(rows)
        for r in rows.values():
            # Availability not set for the shop: it inherits (app/services/product_availability.py).
            assert (r.is_listed, r.is_available, r.price, r.assigned_by_rule) == (True, None, None, True)

    def test_a_price_somebody_set_is_never_overwritten(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        existing = _row(world, p, world.shops.a1, by_rule=True, price=Decimal("7.50"))
        S.apply_rule(world.db, p)
        assert existing.price == Decimal("7.50")
        assert _rows(world, p)[str(world.shops.a1.id)] is existing

    def test_a_shop_leaving_scope_is_unlisted_not_deleted(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A, include_sub=True)
        S.apply_rule(world.db, p)
        sub_row = _rows(world, p)[str(world.shops.a1_sub.id)]
        sub_row.price = Decimal("12.00")

        p.shop_scope_include_subcompanies = False
        S.apply_rule(world.db, p)

        assert world.db.deleted == []
        assert _rows(world, p)[str(world.shops.a1_sub.id)] is sub_row
        assert sub_row.is_listed is False
        assert sub_row.price == Decimal("12.00")

    def test_coming_back_into_scope_relists_with_the_price_it_had(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        row = _row(world, p, world.shops.a1, by_rule=True, listed=False, price=Decimal("8.00"))
        S.apply_rule(world.db, p)
        assert row.is_listed is True
        assert row.price == Decimal("8.00")

    def test_a_hand_added_row_is_never_touched(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        # Out of scope and listed: stays listed. In scope and hidden: stays hidden.
        outside = _row(world, p, world.shops.a1_sub, by_rule=False, listed=True)
        hidden = _row(world, p, world.shops.a1, by_rule=False, listed=False)
        plan = S.plan_rule(world.db, p)
        assert outside not in plan.unlist and hidden not in plan.relist
        S.apply_rule(world.db, p)
        assert (outside.is_listed, outside.assigned_by_rule) == (True, False)
        assert (hidden.is_listed, hidden.assigned_by_rule) == (False, False)

    def test_an_inactive_shop_gets_nothing_and_loses_nothing(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        S.apply_rule(world.db, p)
        assert str(world.shops.a_closed.id) not in _rows(world, p)

        row = _row(world, p, world.shops.a_closed, by_rule=True, listed=True)
        S.apply_rule(world.db, p)
        assert row.is_listed is True

    def test_applying_twice_changes_nothing_the_second_time(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        S.apply_rule(world.db, p)
        assert S.plan_rule(world.db, p).is_empty()

    def test_a_hand_managed_product_is_left_exactly_as_it_is(self, world):
        p = _product(world, world.A)
        _row(world, p, world.shops.b, by_rule=True, listed=True)  # even a stray flag
        assert S.apply_rule(world.db, p) == set()
        assert _rows(world, p)[str(world.shops.b.id)].is_listed is True


# ── Hooks: a shop appears, moves, or its company moves ───────────────────────


class TestShopHooks:
    def test_a_new_shop_receives_every_product_whose_rule_covers_it(self, world, monkeypatch):
        monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda *_: None)
        own = _product(world, world.A, mode="company", scope_company=world.A1, sku="1")
        from_top = _product(world, world.H, mode="company", scope_company=world.H, include_sub=True, sku="2")
        top_only = _product(world, world.H, mode="company", scope_company=world.H, sku="3")
        picked = _product(world, world.A, mode="shops", sku="4")
        by_hand = _product(world, world.A, sku="5")

        shop = shops_router.create_shop(
            ShopCreate(name="New A1 shop", companyId=world.A1),
            _distributor(),
            world.tenant,
            world.db,
        )

        sid = str(shop.id)
        assert sid in _rows(world, own) and sid in _rows(world, from_top)
        assert _rows(world, own)[sid].assigned_by_rule is True
        assert sid not in _rows(world, top_only), "include-subcompanies was off"
        assert sid not in _rows(world, picked), "an explicit list adds nothing on its own"
        assert sid not in _rows(world, by_hand)

    def test_the_hook_only_touches_the_new_shop(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        # A2 has no row (drift); the new-shop hook must not fix other shops behind
        # the caller's back.
        new = Shop(id=uuid.uuid4(), tenant_id=world.tenant, company_id=world.A, name="New", is_active=True)
        world.db.add(new)
        assert S.reconcile_shops(world.db, [new]) == {str(new.id)}
        assert set(_rows(world, p)) == {str(new.id)}

    def test_a_shop_moving_company_leaves_one_rule_and_joins_another(self, world):
        old_rule = _product(world, world.A, mode="company", scope_company=world.A, sku="1")
        new_rule = _product(world, world.H, mode="company", scope_company=world.B, sku="2")
        S.apply_rule(world.db, old_rule)
        moving = world.shops.a2
        row = _rows(world, old_rule)[str(moving.id)]
        row.price = Decimal("9.90")

        moving.company_id = world.B
        touched = S.reconcile_shops(world.db, [moving])

        assert touched == {str(moving.id)}
        assert row.is_listed is False and row.price == Decimal("9.90")
        assert _rows(world, new_rule)[str(moving.id)].is_listed is True

    def test_reactivating_a_shop_runs_the_rules_for_it(self, world, monkeypatch):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        closed = world.shops.a_closed
        shops_router.update_shop(
            str(closed.id), ShopUpdate(isActive=True), _distributor(), world.tenant, world.db
        )
        assert _rows(world, p)[str(closed.id)].is_listed is True
        assert str(closed.id) in world.notified

    def test_a_company_moving_parent_carries_its_shops_between_rules(self, world, monkeypatch):
        # A1 moves from under A to under B.
        a_rule = _product(world, world.A, mode="company", scope_company=world.A, include_sub=True, sku="1")
        b_rule = _product(world, world.B, mode="company", scope_company=world.B, include_sub=True, sku="2")
        S.apply_rule(world.db, a_rule)
        sub = str(world.shops.a1_sub.id)
        assert _rows(world, a_rule)[sub].is_listed is True

        monkeypatch.setattr(companies_router, "_resolve_parent_company", lambda *a, **k: None)
        monkeypatch.setattr(companies_router, "notify_machines_for_company_settings", lambda *a, **k: None)
        world.tree.parents[world.A1] = world.B
        a1 = next(c for c in world.db.of(Company) if c.id == world.A1)
        companies_router.update_company(
            str(world.A1),
            CompanyUpdate.model_validate({"parentCompanyId": str(world.B)}),
            _distributor(),
            world.tenant,
            world.db,
        )

        assert a1.parent_company_id == world.B
        # A's product may no longer be sold under B: unlisted, row kept.
        assert _rows(world, a_rule)[sub].is_listed is False
        assert _rows(world, b_rule)[sub].is_listed is True
        assert sub in world.notified

    def test_echoing_the_parent_does_not_run_the_rules(self, world, monkeypatch):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        monkeypatch.setattr(companies_router, "notify_machines_for_company_settings", lambda *a, **k: None)
        companies_router.update_company(
            str(world.A),
            CompanyUpdate.model_validate({"name": "Alpha", "parentCompanyId": str(world.H)}),
            _distributor(),
            world.tenant,
            world.db,
        )
        assert _rows(world, p) == {}


# ── Switching modes ──────────────────────────────────────────────────────────


class TestModeSwitching:
    def test_company_to_shops_keeps_the_chosen_and_unlists_the_rest(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A, include_sub=True)
        S.apply_rule(world.db, p)
        by_hand = _row(world, p, world.shops.h, by_rule=False, listed=True)
        rows = _rows(world, p)

        products_router.update_product(
            str(p.id),
            ProductUpdate.model_validate({"shopScope": {"mode": "shops", "shopIds": [str(world.shops.a1.id)]}}),
            _distributor(),
            world.tenant,
            world.db,
        )

        assert p.shop_scope_mode == "shops" and p.shop_scope_company_id is None
        assert rows[str(world.shops.a1.id)].is_listed is True
        assert rows[str(world.shops.a2.id)].is_listed is False
        assert rows[str(world.shops.a1_sub.id)].is_listed is False
        assert (by_hand.is_listed, by_hand.assigned_by_rule) == (True, False)

        # And it no longer adds itself anywhere.
        new = Shop(id=uuid.uuid4(), tenant_id=world.tenant, company_id=world.A, name="New", is_active=True)
        world.db.add(new)
        S.reconcile_shops(world.db, [new])
        assert str(new.id) not in _rows(world, p)

    def test_an_explicit_list_adopts_a_hand_row_it_names_and_leaves_the_others(self, world):
        p = _product(world, world.A)
        chosen = _row(world, p, world.shops.a1, by_rule=False, listed=False, price=Decimal("5"))
        other = _row(world, p, world.shops.a2, by_rule=False, listed=True)
        plan = S.plan_explicit(world.db, p, [world.shops.a1.id, world.shops.a1_sub.id])
        S.execute_plan(world.db, p, plan)
        assert (chosen.is_listed, chosen.assigned_by_rule, chosen.price) == (True, True, Decimal("5"))
        assert (other.is_listed, other.assigned_by_rule) == (True, False)
        assert _rows(world, p)[str(world.shops.a1_sub.id)].assigned_by_rule is True

        # Taking a shop off the list later unlists it.
        S.execute_plan(world.db, p, S.plan_explicit(world.db, p, [world.shops.a1_sub.id]))
        assert chosen.is_listed is False

    def test_shops_back_to_a_rule(self, world):
        p = _product(world, world.A, mode="shops")
        S.execute_plan(world.db, p, S.plan_explicit(world.db, p, [world.shops.a1_sub.id]))
        products_router.update_product(
            str(p.id),
            ProductUpdate.model_validate(
                {"shopScope": {"mode": "company", "companyId": str(world.A)}}
            ),
            _distributor(),
            world.tenant,
            world.db,
        )
        rows = _rows(world, p)
        assert rows[str(world.shops.a1_sub.id)].is_listed is False
        assert rows[str(world.shops.a1.id)].is_listed is True
        assert rows[str(world.shops.a2.id)].is_listed is True

    def test_an_edit_without_shop_scope_leaves_the_scope_alone(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        products_router.update_product(
            str(p.id), ProductUpdate.model_validate({"name": "Cola Zero"}), _distributor(), world.tenant, world.db
        )
        assert p.name == "Cola Zero" and _rows(world, p) == {}


# ── Create / update through the API ──────────────────────────────────────────


@pytest.fixture
def create(world, monkeypatch):
    monkeypatch.setattr(products_router, "resolve_sku_for_create", lambda *_: ("100", True))
    monkeypatch.setattr(products_router, "allocate_global_sku", lambda *_: "G-100")

    def _create(body, user=None):
        payload = {"name": "Cola", "price": 10, "categoryId": str(world.category.id), **body}
        return products_router.create_product(
            ProductCreate.model_validate(payload), user or _distributor(), world.tenant, world.db
        )

    return _create


class TestCreateWithScope:
    def test_all_shops_of_a_company_with_one_shop_priced_differently(self, world, create):
        p = create({
            "companyId": str(world.A),
            "shopScope": {"mode": "company", "companyId": str(world.A), "includeSubcompanies": True},
            "shopPrices": [{"shopId": str(world.shops.a1_sub.id), "price": 12.5}],
        })
        rows = _rows(world, p)
        assert set(rows) == {str(world.shops.a1.id), str(world.shops.a2.id), str(world.shops.a1_sub.id)}
        assert rows[str(world.shops.a1_sub.id)].price == Decimal("12.5")
        assert rows[str(world.shops.a1.id)].price is None
        assert world.db.commits == 1

        body = _response(p)
        assert body["shopScope"] == {
            "mode": "company", "companyId": world.A, "includeSubcompanies": True,
        }

    def test_without_shop_scope_a_product_is_on_no_shop_exactly_as_before(self, world, create):
        p = create({"companyId": str(world.A)})
        assert p.shop_scope_mode is None and _rows(world, p) == {}
        assert _response(p)["shopScope"] is None

    def test_a_price_for_a_shop_outside_the_scope_is_refused(self, world, create):
        with pytest.raises(HTTPException) as e:
            create({
                "companyId": str(world.A),
                "shopScope": {"mode": "company", "companyId": str(world.A)},
                "shopPrices": [{"shopId": str(world.shops.a1_sub.id), "price": 3}],
            })
        assert e.value.status_code == 400
        assert world.db.commits == 0

    def test_a_scope_on_a_sibling_company_is_refused(self, world, create):
        with pytest.raises(HTTPException) as e:
            create({"companyId": str(world.A), "shopScope": {"mode": "company", "companyId": str(world.B)}})
        assert e.value.status_code == 400
        assert world.db.commits == 0

    def test_an_explicit_shop_of_a_sibling_company_is_refused(self, world, create):
        with pytest.raises(HTTPException) as e:
            create({"companyId": str(world.A), "shopScope": {"mode": "shops", "shopIds": [str(world.shops.b.id)]}})
        assert e.value.status_code == 400


class TestPermissions:
    def test_a_manager_of_a_sub_company_cannot_scope_to_its_parent(self, world, create):
        manager = _user(UserRole.COMPANY_MANAGER, company_id=world.A1)
        with pytest.raises(HTTPException) as e:
            create(
                {"companyId": str(world.H), "shopScope": {"mode": "company", "companyId": str(world.H), "includeSubcompanies": True}},
                manager,
            )
        assert e.value.status_code == 403
        assert world.db.commits == 0 and world.db.of(ShopProductOverride) == []

    def test_a_shop_manager_cannot_rule_over_the_other_shops_of_their_company(self, world, create):
        # They cover their own company for the scope check, but not the second shop.
        manager = _user(UserRole.SHOP_MANAGER, company_id=world.A, shop_id=world.shops.a1.id)
        with pytest.raises(HTTPException) as e:
            create({"companyId": str(world.A), "shopScope": {"mode": "company", "companyId": str(world.A)}}, manager)
        assert e.value.status_code == 403
        # The whole request, not "the shops you may write" — nothing was written.
        assert world.db.commits == 0 and world.db.of(ShopProductOverride) == []

    def test_an_explicit_list_with_one_forbidden_shop_is_refused_whole(self, world, create):
        manager = _user(UserRole.COMPANY_MANAGER, company_id=world.A1)
        with pytest.raises(HTTPException) as e:
            create(
                {"companyId": str(world.H), "shopScope": {"mode": "shops", "shopIds": [str(world.shops.a1_sub.id), str(world.shops.b.id)]}},
                manager,
            )
        assert e.value.status_code == 403
        assert world.db.of(ShopProductOverride) == []

    def test_unlisting_a_shop_you_cannot_write_is_refused_too(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A, include_sub=True)
        S.apply_rule(world.db, p)
        # A1's manager cannot edit A's product at all; a manager of A can, but here the
        # change would unlist A1's shop, which a shop manager of A shop 1 may not write.
        manager = _user(UserRole.SHOP_MANAGER, company_id=world.A, shop_id=world.shops.a1.id)
        p.shop_id = world.shops.a1.id  # the only kind of product a shop manager may edit
        with pytest.raises(HTTPException) as e:
            products_router.update_product(
                str(p.id),
                ProductUpdate.model_validate({"shopScope": {"mode": "shops", "shopIds": [str(world.shops.a1.id)]}}),
                manager,
                world.tenant,
                world.db,
            )
        assert e.value.status_code == 403
        assert all(r.is_listed for r in _rows(world, p).values())

    def test_a_price_for_a_shop_you_cannot_write_is_refused(self, world, create):
        manager = _user(UserRole.COMPANY_MANAGER, company_id=world.A)
        with pytest.raises(HTTPException) as e:
            create(
                {
                    "companyId": str(world.A),
                    "shopScope": {"mode": "company", "companyId": str(world.A)},
                    "shopPrices": [{"shopId": str(world.shops.b.id), "price": 1}],
                },
                manager,
            )
        assert e.value.status_code == 403


# ── Preview, the per-shop list, and the shop price write ─────────────────────


class TestPreview:
    def _machine(self, shop, *, status=PairingStatus.ASSIGNED, active=True):
        return POSMachine(id=uuid.uuid4(), shop_id=shop.id, tenant_id=shop.tenant_id,
                          pairing_status=status, is_active=active, name="till", machine_code=str(uuid.uuid4()))

    def test_counts_shops_and_their_assigned_active_tills(self, world):
        s = world.shops
        for m in (
            self._machine(s.a1), self._machine(s.a1), self._machine(s.a2), self._machine(s.a1_sub),
            self._machine(s.a1, status=PairingStatus.PAIRED),    # not assigned
            self._machine(s.a2, active=False),                   # retired
            self._machine(s.b),                                  # out of scope
            self._machine(s.a_closed),                           # inactive shop
        ):
            world.db.add(m)

        def preview(scope):
            return products_router.preview_shop_scope(
                ShopScopePreviewRequest.model_validate({"shopScope": scope, "companyId": str(world.A)}),
                _distributor(), world.tenant, world.db,
            )

        without = preview({"mode": "company", "companyId": str(world.A)})
        assert (without.shop_count, without.machine_count) == (2, 3)
        with_sub = preview({"mode": "company", "companyId": str(world.A), "includeSubcompanies": True})
        assert (with_sub.shop_count, with_sub.machine_count) == (3, 4)
        picked = preview({"mode": "shops", "shopIds": [str(s.a2.id)]})
        assert (picked.shop_count, picked.machine_count) == (1, 1)
        assert picked.model_dump(by_alias=True)["shops"] == [
            {"id": s.a2.id, "name": "A shop 2", "companyId": world.A}
        ]
        # Read-only.
        assert world.db.of(ShopProductOverride) == [] and world.db.commits == 0

    def test_refused_where_the_save_would_be(self, world):
        with pytest.raises(HTTPException) as e:
            products_router.preview_shop_scope(
                ShopScopePreviewRequest.model_validate(
                    {"shopScope": {"mode": "company", "companyId": str(world.H), "includeSubcompanies": True}}
                ),
                _user(UserRole.COMPANY_MANAGER, company_id=world.A),
                world.tenant,
                world.db,
            )
        assert e.value.status_code == 403


class TestProductShopsAndPrices:
    def test_lists_every_assigned_shop_listed_or_not(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        S.apply_rule(world.db, p)
        _rows(world, p)[str(world.shops.a2.id)].price = Decimal("8")
        _row(world, p, world.shops.a1_sub, by_rule=False, listed=False)

        out = products_router.list_product_shops(str(p.id), _distributor(), world.tenant, world.db)
        body = {r.shop_name: r.model_dump(by_alias=True) for r in out}
        assert set(body) == {"A shop 1", "A shop 2", "A1 shop"}
        assert body["A shop 2"]["price"] == Decimal("8") and body["A shop 2"]["effectivePrice"] == Decimal("8")
        assert body["A shop 1"]["price"] is None and body["A shop 1"]["effectivePrice"] == Decimal("10.00")
        assert body["A1 shop"]["isListed"] is False and body["A1 shop"]["assignedByRule"] is False
        assert body["A shop 1"]["companyName"] == "Alpha"

    def test_a_manager_sees_only_the_shops_they_reach(self, world):
        p = _product(world, world.H, mode="company", scope_company=world.H, include_sub=True)
        S.apply_rule(world.db, p)
        # Rows in shops outside the caller's companies are left out, not refused.
        everyone = products_router.list_product_shops(
            str(p.id), _user(UserRole.COMPANY_MANAGER, company_id=world.H), world.tenant, world.db
        )
        assert len(everyone) == 5
        p.company_id = world.A  # so A's manager may open it at all
        mine = products_router.list_product_shops(
            str(p.id), _user(UserRole.COMPANY_MANAGER, company_id=world.A), world.tenant, world.db
        )
        assert {r.shop_name for r in mine} == {"A shop 1", "A shop 2", "A1 shop"}

    def _put(self, w, product, shop, body):
        return shops_router.upsert_shop_product_override(
            str(shop.id), str(product.id), ShopProductOverrideUpsert.model_validate(body),
            _distributor(), w.tenant, w.db,
        )

    def test_the_existing_override_write_sets_and_resets_a_shop_price(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        S.apply_rule(world.db, p)
        row = _rows(world, p)[str(world.shops.a1.id)]
        self._put(world, p, world.shops.a1, {"price": 11})
        assert row.price == 11 and row.assigned_by_rule is True  # a price edit keeps the rule's row
        self._put(world, p, world.shops.a1, {"price": None})
        assert row.price is None

    def test_hiding_a_rule_row_by_hand_takes_it_out_of_the_rules_hands(self, world):
        p = _product(world, world.A, mode="company", scope_company=world.A)
        S.apply_rule(world.db, p)
        row = _rows(world, p)[str(world.shops.a1.id)]
        # The assortment dialog always sends isListed; unchanged is not a hand choice.
        self._put(world, p, world.shops.a1, {"price": None, "isListed": True, "isAvailable": True})
        assert row.assigned_by_rule is True
        self._put(world, p, world.shops.a1, {"isListed": False})
        assert row.assigned_by_rule is False
        S.apply_rule(world.db, p)
        assert row.is_listed is False, "the rule must not re-list what a person hid"
