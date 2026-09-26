"""Cover for locking a product per company, per shop and per till.

The rule: machine → shop → the shop's own company → the product's own flag, nearest
set level wins, and no company above the shop's own is ever consulted. Each test names
a way this could look as if it worked while doing damage:

* a till ignoring its own setting, or a shop's "not set" read as "available" — either
  makes a company lock unreachable or a till unlock ineffective;
* a parent company's lock reaching a sub-company's shop, because the parent's product
  is sold there;
* a lock saved in the cloud that never reaches the till, because the catalog watermark
  or the delta pull did not move;
* somebody without the right locking another company's, shop's or till's product.

Everything below the pure rule runs against a real SQLAlchemy session on an in-memory
SQLite database — local, private to the test, and never the configured database — so
the queries the sync and the watermark actually issue are the ones being tested. The
company tree's recursive CTEs run on it too.
"""
from __future__ import annotations

import importlib.util
import itertools
import pathlib
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.sql import sqltypes

import app.models  # noqa: F401  (every mapper, so relationships resolve)
from app.database import Base
from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import (
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import product_availability as R
from app.routers import shops as shops_router
from app.schemas.product_availability import AvailabilitySet
from app.schemas.shop_product_override import ShopProductOverrideUpsert
from app.services import product_availability as A
from app.services import sync as S
from app.services.product_availability import Level


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


_TABLES = (
    "tenants", "companies", "shops", "pos_machines", "categories", "vouchers", "products",
    "shop_product_overrides", "company_product_overrides", "machine_product_overrides",
    "customers",
)

OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)
SINCE = datetime(2026, 6, 1, tzinfo=timezone.utc)


# ── The rule itself ──────────────────────────────────────────────────────────

N, T, F = None, True, False


@pytest.mark.parametrize(
    "product, company, shop, machine, expected, source",
    [
        # Nothing set anywhere: the product's own flag.
        (T, N, N, N, T, Level.PRODUCT),
        (F, N, N, N, F, Level.PRODUCT),
        # Each level over everything above it.
        (T, F, N, N, F, Level.COMPANY),
        (T, F, T, N, T, Level.SHOP),      # shop unlocks what its company locked
        (T, N, F, N, F, Level.SHOP),
        (T, T, F, N, F, Level.SHOP),
        (T, F, F, T, T, Level.MACHINE),   # till unlocks what its shop locked
        (T, T, T, F, F, Level.MACHINE),   # till locks what everyone else allows
        (T, N, N, F, F, Level.MACHINE),
        (F, T, N, N, T, Level.COMPANY),   # company unlocks a product locked at its root
        (F, N, T, N, T, Level.SHOP),
        (F, N, N, T, T, Level.MACHINE),
        # "Not set" is transparent at every level, never a value.
        (F, F, N, N, F, Level.COMPANY),
        (T, F, N, N, F, Level.COMPANY),
        (T, N, F, N, F, Level.SHOP),
    ],
)
def test_nearest_set_level_wins(product, company, shop, machine, expected, source):
    got = A.resolve(product, company, shop, machine)
    assert (got.available, got.source) == (expected, source)


def test_every_level_resolves_top_down():
    levels = A.resolve_levels(True, False, None, True)
    assert levels[Level.PRODUCT].available is True
    assert levels[Level.COMPANY].available is False
    assert (levels[Level.SHOP].available, levels[Level.SHOP].source) == (False, Level.COMPANY)
    assert (levels[Level.MACHINE].available, levels[Level.MACHINE].source) == (True, Level.MACHINE)


def test_the_company_level_is_the_shops_own_company():
    shop = SimpleNamespace(company_id=uuid.uuid4())
    assert A.company_level_company_id(shop) == shop.company_id
    assert A.company_level_company_id(None) is None


# ── A world on a real session ────────────────────────────────────────────────


@pytest.fixture
def world(monkeypatch):
    """
    Tenant T:
        H (holding) ── A (sub-company of H)
        B (unrelated root)
    Shops: h_shop in H, a_shop in A, b_shop in B.
    Tills: h1, h2 in h_shop; a1 in a_shop; b1 in b_shop.
    Product P belongs to H and is sold in h_shop and in a_shop ("include sub-companies").
    Product Q belongs to H and is sold in h_shop only.
    """
    # Routers take ids as strings, which Postgres casts and SQLite's UUID binding does
    # not. Teach this test's binding to accept a string id the way Postgres does.
    original_bind = sqltypes.Uuid.bind_processor

    def _bind_accepting_str(self, dialect):
        inner = original_bind(self, dialect)
        if inner is None:
            return None
        return lambda v: inner(uuid.UUID(v) if isinstance(v, str) else v)

    monkeypatch.setattr(sqltypes.Uuid, "bind_processor", _bind_accepting_str)
    engine = create_engine("sqlite://")
    for name in _TABLES:
        Base.metadata.tables[name].create(engine)
    db = sessionmaker(bind=engine)()

    notified: list = []
    monkeypatch.setattr(
        A, "notify_machine_catalog_changed", lambda tid, mid, reason: notified.append(("machine", str(mid)))
    )
    monkeypatch.setattr(
        A, "notify_machines_for_shop", lambda _db, sid, reason: notified.append(("shop", str(sid)))
    )
    monkeypatch.setattr(
        shops_router, "notify_machines_for_shop", lambda _db, sid, reason: notified.append(("shop", str(sid)))
    )

    tenant = Tenant(id=uuid.uuid4(), name="T", slug="t")
    db.add(tenant)
    db.flush()
    tid = tenant.id
    H = Company(id=uuid.uuid4(), tenant_id=tid, name="Holding")
    B = Company(id=uuid.uuid4(), tenant_id=tid, name="Beta")
    db.add_all([H, B])
    db.flush()
    A_ = Company(id=uuid.uuid4(), tenant_id=tid, name="Alpha", parent_company_id=H.id)
    db.add(A_)
    db.flush()

    def shop(name, company):
        s = Shop(id=uuid.uuid4(), tenant_id=tid, company_id=company.id, name=name, settings={})
        db.add(s)
        return s

    h_shop, a_shop, b_shop = shop("H shop", H), shop("A shop", A_), shop("B shop", B)
    db.flush()

    codes = itertools.count(1)

    def till(name, s):
        m = POSMachine(
            id=uuid.uuid4(),
            tenant_id=tid,
            shop_id=s.id,
            distributor_id=uuid.uuid4(),
            name=name,
            machine_code=f"M-{next(codes)}",
            pos_number=str(next(codes)),
            is_active=True,
            last_sync_at=OLD,
        )
        db.add(m)
        return m

    h1, h2, a1, b1 = till("h1", h_shop), till("h2", h_shop), till("a1", a_shop), till("b1", b_shop)
    category = Category(id=uuid.uuid4(), tenant_id=tid, name="Drinks", updated_at=OLD)
    db.add(category)
    db.flush()

    def product(name, sku, owner):
        p = Product(
            id=uuid.uuid4(),
            tenant_id=tid,
            company_id=owner.id,
            category_id=category.id,
            catalog_level=CatalogLevel.GLOBAL,
            name=name,
            price=Decimal("10.00"),
            sku=sku,
            is_available=True,
            updated_at=OLD,
            created_at=OLD,
        )
        db.add(p)
        return p

    P, Q = product("Cola", "1", H), product("Soda", "2", H)
    db.flush()

    def assign(p, s, value=None):
        r = ShopProductOverride(
            id=uuid.uuid4(), shop_id=s.id, global_product_id=p.id,
            is_listed=True, is_available=value, updated_at=OLD,
        )
        db.add(r)
        return r

    rows = SimpleNamespace(
        p_h=assign(P, h_shop), p_a=assign(P, a_shop), q_h=assign(Q, h_shop),
    )
    db.commit()

    def user(role, *, company=None, shop_=None):
        return User(
            id=uuid.uuid4(), role=role, tenant_id=tid,
            company_id=company.id if company else None,
            shop_id=shop_.id if shop_ else None,
            email=f"{uuid.uuid4()}@x", username=str(uuid.uuid4()),
        )

    users = SimpleNamespace(
        admin=user(UserRole.SUPER_ADMIN),
        h_manager=user(UserRole.COMPANY_MANAGER, company=H),
        a_manager=user(UserRole.COMPANY_MANAGER, company=A_),
        b_manager=user(UserRole.COMPANY_MANAGER, company=B),
        a_shop_manager=user(UserRole.SHOP_MANAGER, company=A_, shop_=a_shop),
        h_shop_manager=user(UserRole.SHOP_MANAGER, company=H, shop_=h_shop),
        h_cashier=user(UserRole.CASHIER, company=H, shop_=h_shop),
    )

    yield SimpleNamespace(
        db=db, tid=tid, H=H, A=A_, B=B, h_shop=h_shop, a_shop=a_shop, b_shop=b_shop,
        h1=h1, h2=h2, a1=a1, b1=b1, P=P, Q=Q, rows=rows, users=users, notified=notified,
    )
    db.close()
    engine.dispose()


def _synced(w, machine, product=None, since=None):
    """What the till is sent for `product` (P by default), or None if it is not sent."""
    product = product or w.P
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


def _avail(w, machine, product=None):
    return _synced(w, machine, product)["isAvailable"]


def _set_company(w, company, value, user=None):
    return R.set_company_availability(
        str(w.P.id), str(company.id), AvailabilitySet(isAvailable=value),
        current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )


def _set_shop(w, shop, value, user=None):
    return R.set_shop_availability(
        str(w.P.id), str(shop.id), AvailabilitySet(isAvailable=value),
        current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )


def _set_machine(w, machine, value, user=None):
    return R.set_machine_availability(
        str(w.P.id), str(machine.id), AvailabilitySet(isAvailable=value),
        current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )


def _age_everything(w):
    """Push every stored timestamp back, so the next write is the newest thing there is."""
    for model in (ShopProductOverride, CompanyProductOverride, MachineProductOverride, Product):
        for row in w.db.query(model).all():
            row.updated_at = OLD
    w.db.commit()


# ── Sync: the effective value, per machine ───────────────────────────────────


class TestSyncSendsTheEffectiveValue:
    def test_nothing_set_is_the_products_own_flag(self, world):
        assert _avail(world, world.h1) is True
        world.P.is_available = False
        world.db.commit()
        assert _avail(world, world.h1) is False, "a shop's 'not set' must not read as available"

    def test_a_company_lock_reaches_its_own_shops_tills(self, world):
        _set_company(world, world.H, False)
        assert _avail(world, world.h1) is False
        assert _avail(world, world.h2) is False
        assert _avail(world, world.h1, world.Q) is True, "only the product that was locked"

    def test_a_parent_lock_never_reaches_a_sub_companys_shop(self, world):
        # P is H's product and is sold in A's shop; H locking it changes nothing there.
        _set_company(world, world.H, False)
        assert _avail(world, world.a1) is True
        # Only A's own setting counts in A's shop.
        _set_company(world, world.A, False)
        assert _avail(world, world.a1) is False
        _set_company(world, world.H, True)
        assert _avail(world, world.a1) is False, "a parent's unlock does not flow down either"

    def test_a_sub_companys_lock_never_reaches_its_parents_shop(self, world):
        _set_company(world, world.A, False)
        assert _avail(world, world.h1) is True

    def test_a_shop_unlocks_what_its_company_locked(self, world):
        _set_company(world, world.H, False)
        _set_shop(world, world.h_shop, True)
        assert _avail(world, world.h1) is True

    def test_a_shop_locks_what_its_company_allows(self, world):
        _set_company(world, world.H, True)
        _set_shop(world, world.h_shop, False)
        assert _avail(world, world.h1) is False

    def test_a_till_unlocks_what_its_shop_locked(self, world):
        _set_shop(world, world.h_shop, False)
        _set_machine(world, world.h1, True)
        assert _avail(world, world.h1) is True
        assert _avail(world, world.h2) is False, "the other till in the shop keeps the shop's lock"

    def test_a_till_locks_on_its_own(self, world):
        _set_machine(world, world.h2, False)
        assert _avail(world, world.h2) is False
        assert _avail(world, world.h1) is True

    def test_clearing_each_level_goes_back_to_inherit(self, world):
        _set_company(world, world.H, False)
        _set_shop(world, world.h_shop, True)
        _set_machine(world, world.h1, False)
        assert _avail(world, world.h1) is False  # the till
        _set_machine(world, world.h1, None)
        assert _avail(world, world.h1) is True  # back to the shop
        _set_shop(world, world.h_shop, None)
        assert _avail(world, world.h1) is False  # back to the company
        _set_company(world, world.H, None)
        assert _avail(world, world.h1) is True  # back to the product
        # Cleared, not deleted: the rows stay with a NULL for the delta pull to see.
        assert world.db.query(MachineProductOverride).one().is_available is None
        assert world.db.query(CompanyProductOverride).one().is_available is None
        assert world.rows.p_h.is_available is None

    def test_delisted_is_never_sellable_whatever_the_levels_say(self, world):
        world.rows.p_h.is_listed = False
        world.db.commit()
        _set_machine(world, world.h1, True)
        assert _avail(world, world.h1) is False

    def test_the_single_product_resolver_agrees_with_the_sync(self, world):
        _set_company(world, world.H, False)
        _set_machine(world, world.h2, True)
        for m in (world.h1, world.h2, world.a1):
            assert A.effective_availability(world.db, world.P, m) == _avail(world, m)


class TestDeltaPullSeesEveryLevel:
    @pytest.mark.parametrize("level", ["company", "shop", "machine"])
    def test_a_change_after_since_is_resent(self, world, level):
        _age_everything(world)
        assert _synced(world, world.h1, since=SINCE) is None, "nothing changed since"
        {
            "company": lambda: _set_company(world, world.H, False),
            "shop": lambda: _set_shop(world, world.h_shop, False),
            "machine": lambda: _set_machine(world, world.h1, False),
        }[level]()
        row = _synced(world, world.h1, since=SINCE)
        assert row is not None, f"a {level}-level lock must reach a till that pulls deltas"
        assert row["isAvailable"] is False

    def test_a_parent_change_is_not_resent_to_a_sub_companys_till(self, world):
        _age_everything(world)
        _set_company(world, world.H, False)
        assert _synced(world, world.a1, since=SINCE) is None


# ── The watermark and the wake-up ────────────────────────────────────────────


class TestWatermarkAndNotify:
    def _mark(self, w, machine):
        return S.get_catalog_change_watermark_for_machine(w.db, machine)

    def test_a_company_change_moves_its_own_shops_tills_only(self, world):
        _age_everything(world)
        before = {m.name: self._mark(world, m) for m in (world.h1, world.a1, world.b1)}
        _set_company(world, world.H, False)
        assert self._mark(world, world.h1) > before["h1"]
        assert self._mark(world, world.a1) == before["a1"], "a sub-company's till is not reached"
        assert self._mark(world, world.b1) == before["b1"]
        woken = {mid for kind, mid in world.notified if kind == "machine"}
        assert woken == {str(world.h1.id), str(world.h2.id)}

    def test_a_company_change_on_a_product_the_shop_does_not_sell_does_not_move_it(self, world):
        _age_everything(world)
        before = self._mark(world, world.a1)
        # Q is not sold in A's shop.
        R.set_company_availability(
            str(world.Q.id), str(world.A.id), AvailabilitySet(isAvailable=False),
            current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
        )
        assert self._mark(world, world.a1) == before
        assert world.notified == []

    def test_a_shop_change_moves_the_shops_tills(self, world):
        _age_everything(world)
        before = self._mark(world, world.h1)
        _set_shop(world, world.h_shop, False)
        assert self._mark(world, world.h1) > before
        assert world.notified == [("shop", str(world.h_shop.id))]

    def test_resending_the_same_shop_value_still_moves_it(self, world):
        _set_shop(world, world.h_shop, False)
        _age_everything(world)
        before = self._mark(world, world.h1)
        _set_shop(world, world.h_shop, False)
        assert self._mark(world, world.h1) > before

    def test_a_machine_change_moves_that_till_only(self, world):
        _age_everything(world)
        before = {m.name: self._mark(world, m) for m in (world.h1, world.h2)}
        _set_machine(world, world.h1, False)
        assert self._mark(world, world.h1) > before["h1"]
        assert self._mark(world, world.h2) == before["h2"]
        assert world.notified == [("machine", str(world.h1.id))]

    @pytest.mark.parametrize("level", ["company", "machine"])
    def test_clearing_moves_it_too(self, world, level):
        setter = {"company": lambda v: _set_company(world, world.H, v),
                  "machine": lambda v: _set_machine(world, world.h1, v)}[level]
        setter(False)
        _age_everything(world)
        before = self._mark(world, world.h1)
        setter(None)
        assert self._mark(world, world.h1) > before


# ── Permissions: refused, and nothing written ────────────────────────────────


def _snapshot(w):
    w.db.expire_all()
    return (
        [(str(r.company_id), r.is_available) for r in w.db.query(CompanyProductOverride).all()],
        [(str(r.shop_id), r.is_available) for r in w.db.query(ShopProductOverride).all()],
        [(str(r.machine_id), r.is_available) for r in w.db.query(MachineProductOverride).all()],
    )


def _refused(w, call):
    before = _snapshot(w)
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == 403
    w.db.rollback()
    assert _snapshot(w) == before, "a refused write must write nothing"
    assert w.notified == []


class TestPermissions:
    def test_company_level_refusals(self, world):
        u = world.users
        _refused(world, lambda: _set_company(world, world.A, False, u.a_shop_manager))
        _refused(world, lambda: _set_company(world, world.H, False, u.a_manager))  # the parent
        _refused(world, lambda: _set_company(world, world.A, False, u.b_manager))  # unrelated
        _refused(world, lambda: _set_company(world, world.H, False, u.h_cashier))

    def test_company_level_allowed_for_whoever_covers_it(self, world):
        _set_company(world, world.A, False, world.users.a_manager)
        _set_company(world, world.A, True, world.users.h_manager)  # H covers its sub-company
        assert world.db.query(CompanyProductOverride).one().is_available is True

    def test_shop_level_refusals(self, world):
        u = world.users
        _refused(world, lambda: _set_shop(world, world.h_shop, False, u.h_cashier))
        _refused(world, lambda: _set_shop(world, world.h_shop, False, u.a_shop_manager))
        _refused(world, lambda: _set_shop(world, world.h_shop, False, u.a_manager))

    def test_shop_level_allowed_for_its_manager(self, world):
        _set_shop(world, world.h_shop, False, world.users.h_shop_manager)
        assert world.rows.p_h.is_available is False

    def test_machine_level_refusals(self, world):
        u = world.users
        _refused(world, lambda: _set_machine(world, world.h1, False, u.h_cashier))
        _refused(world, lambda: _set_machine(world, world.h1, False, u.a_shop_manager))
        _refused(world, lambda: _set_machine(world, world.a1, False, u.h_shop_manager))
        _refused(world, lambda: _set_machine(world, world.a1, False, u.b_manager))

    def test_machine_level_allowed_for_its_shops_manager(self, world):
        _set_machine(world, world.h1, False, world.users.h_shop_manager)
        assert world.db.query(MachineProductOverride).one().is_available is False

    def test_a_product_not_sold_in_the_tills_shop_is_refused(self, world):
        with pytest.raises(HTTPException) as exc:
            R.set_machine_availability(
                str(world.Q.id), str(world.a1.id), AvailabilitySet(isAvailable=False),
                current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
            )
        assert exc.value.status_code == 404
        assert world.db.query(MachineProductOverride).count() == 0

    def test_a_company_that_may_not_sell_the_product_is_refused(self, world):
        with pytest.raises(HTTPException) as exc:
            _set_company(world, world.B, False)  # P is H's; B is not beneath H
        assert exc.value.status_code == 400
        assert world.db.query(CompanyProductOverride).count() == 0

    def test_another_tenant_is_refused(self, world):
        with pytest.raises(HTTPException) as exc:
            R.set_shop_availability(
                str(world.P.id), str(world.h_shop.id), AvailabilitySet(isAvailable=False),
                current_user=world.users.admin, active_tenant_id=uuid.uuid4(), db=world.db,
            )
        assert exc.value.status_code == 403

    def test_the_body_must_say_what_it_sets(self, world):
        with pytest.raises(Exception):
            AvailabilitySet.model_validate({})
        assert AvailabilitySet.model_validate({"isAvailable": None}).is_available is None


# ── The picture the dashboard shows ──────────────────────────────────────────


class TestPicture:
    def _get(self, w, user=None):
        return R.get_product_availability(
            str(w.P.id), current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
        ).model_dump(by_alias=True)

    def test_each_level_with_its_resolved_value(self, world):
        _set_company(world, world.H, False)
        _set_shop(world, world.h_shop, True)
        _set_machine(world, world.h2, False)
        pic = self._get(world)
        assert pic["productAvailable"] is True
        companies = {c["companyName"]: c for c in pic["companies"]}
        assert set(companies) == {"Holding", "Alpha"}, "the companies whose shops sell it"

        h = companies["Holding"]
        assert (h["value"], h["inherited"], h["effective"], h["source"]) == (False, True, False, "company")
        (h_shop,) = h["shops"]
        assert (h_shop["value"], h_shop["inherited"], h_shop["effective"], h_shop["source"]) == (
            True, False, True, "shop",
        )
        tills = {m["name"]: m for m in h_shop["machines"]}
        assert (tills["h1"]["value"], tills["h1"]["effective"], tills["h1"]["source"]) == (None, True, "shop")
        assert (tills["h2"]["value"], tills["h2"]["inherited"], tills["h2"]["effective"]) == (False, True, False)

        # A's shop sits under A — its own company — not under H, and H's lock is absent.
        a = companies["Alpha"]
        (a_shop,) = a["shops"]
        assert a_shop["shopId"] == world.a_shop.id
        assert (a["value"], a["effective"]) == (None, True)
        assert a_shop["machines"][0]["effective"] is True

    def test_the_picture_matches_what_each_till_is_sent(self, world):
        _set_company(world, world.A, False)
        _set_machine(world, world.h1, False)
        pic = self._get(world)
        for company in pic["companies"]:
            for shop in company["shops"]:
                for m in shop["machines"]:
                    machine = world.db.get(POSMachine, m["machineId"])
                    assert m["effective"] == _avail(world, machine)

    def test_shops_out_of_reach_are_left_out_and_edit_rights_are_marked(self, world):
        pic = self._get(world, world.users.a_manager)
        assert [c["companyName"] for c in pic["companies"]] == ["Alpha"]
        a = pic["companies"][0]
        assert a["canEdit"] is True
        assert a["shops"][0]["canEdit"] is True
        assert a["shops"][0]["machines"][0]["canEdit"] is True

    def test_a_shop_manager_sees_their_shop_and_may_not_edit_the_company(self, world):
        pic = self._get(world, world.users.a_shop_manager)
        (a,) = pic["companies"]
        assert a["canEdit"] is False
        assert [s["shopName"] for s in a["shops"]] == ["A shop"]
        assert a["shops"][0]["canEdit"] is True

    def test_an_unrelated_company_cannot_see_it(self, world):
        with pytest.raises(HTTPException) as exc:
            self._get(world, world.users.b_manager)
        assert exc.value.status_code == 403


# ── The assortment page ──────────────────────────────────────────────────────


class TestAssortmentRows:
    def test_rows_carry_the_shop_setting_and_the_shop_effective_value(self, world):
        _set_company(world, world.H, False)
        page = shops_router.list_shop_product_overrides(
            str(world.h_shop.id), page=1, page_size=100,
            current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
        )
        rows = {str(i.global_product_id): i for i in page.items}
        p = rows[str(world.P.id)]
        assert (p.is_available, p.inherited_available, p.effective_available) == (None, False, False)
        q = rows[str(world.Q.id)]
        assert (q.is_available, q.inherited_available, q.effective_available) == (None, True, True)
        _set_shop(world, world.h_shop, True)
        page = shops_router.list_shop_product_overrides(
            str(world.h_shop.id), page=1, page_size=100,
            current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
        )
        p = {str(i.global_product_id): i for i in page.items}[str(world.P.id)]
        assert (p.is_available, p.inherited_available, p.effective_available) == (True, False, True)
        dumped = p.model_dump(by_alias=True)
        assert {"isAvailable", "inheritedAvailable", "effectiveAvailable"} <= set(dumped)

    def test_the_existing_write_accepts_null_as_inherit(self, world):
        def put(body):
            return shops_router.upsert_shop_product_override(
                str(world.h_shop.id), str(world.P.id), ShopProductOverrideUpsert.model_validate(body),
                current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
            )

        put({"isAvailable": False})
        assert world.rows.p_h.is_available is False
        put({"isAvailable": None})
        assert world.rows.p_h.is_available is None, "null used to be read as bool(None), a lock"
        put({"price": 12})
        assert world.rows.p_h.is_available is None, "a price edit leaves availability alone"

    def test_a_new_assortment_row_inherits(self, world):
        shops_router.assign_shop_product(
            str(world.a_shop.id), str(world.Q.id),
            current_user=world.users.admin, active_tenant_id=world.tid, db=world.db,
        )
        row = (
            world.db.query(ShopProductOverride)
            .filter(ShopProductOverride.shop_id == world.a_shop.id,
                    ShopProductOverride.global_product_id == world.Q.id)
            .one()
        )
        assert row.is_available is None


# ── The migration ────────────────────────────────────────────────────────────


def _migration():
    path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "alembic" / "versions" / "d6e7f8a9b0c1_product_availability_levels.py"
    )
    spec = importlib.util.spec_from_file_location("availability_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestMigration:
    def test_chained_onto_the_register_number_head_and_the_only_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        m = _migration()
        assert (m.revision, m.down_revision) == ("d6e7f8a9b0c1", "c5d6e7f8a9b0")
        here = pathlib.Path(__file__).resolve().parents[1]
        cfg = Config(str(here / "alembic.ini"))
        cfg.set_main_option("script_location", str(here / "alembic"))
        # No longer the head itself since the general item (e7f8a9b0c1d2) was chained on.
        script = ScriptDirectory.from_config(cfg)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "d6e7f8a9b0c1" in {r.revision for r in script.walk_revisions("base", heads[0])}

    def test_true_becomes_inherit_and_false_stays_a_lock(self, world):
        w = world
        locked_product = Product(
            id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, category_id=w.Q.category_id,
            catalog_level=CatalogLevel.GLOBAL, name="Old", price=Decimal("1"), sku="3",
            is_available=False,
        )
        w.db.add(locked_product)
        w.db.flush()
        w.rows.p_h.is_available = True
        w.rows.p_a.is_available = False
        w.rows.q_h.is_available = True
        sold_anyway = ShopProductOverride(
            id=uuid.uuid4(), shop_id=w.h_shop.id, global_product_id=locked_product.id,
            is_listed=True, is_available=True,
        )
        w.db.add(sold_anyway)
        w.db.commit()
        pairs = ((w.h1, w.P), (w.a1, w.P), (w.h1, w.Q), (w.h1, locked_product))
        before = {(m.name, p.name): _avail(w, m, p) for m, p in pairs}

        w.db.execute(text(_migration().TRUE_TO_INHERIT))
        w.db.commit()
        w.db.expire_all()

        assert w.rows.p_h.is_available is None
        assert w.rows.q_h.is_available is None
        assert w.rows.p_a.is_available is False, "an explicit lock is kept"
        # Its own flag is false and the old sync ignored it: the shop's `true` meant
        # "sell it anyway", and stays explicit so this till keeps selling it.
        assert sold_anyway.is_available is True
        after = {(m.name, p.name): _avail(w, m, p) for m, p in pairs}
        assert after == before, "no till's answer changes on upgrade"

    def test_the_conversion_runs_only_while_the_column_is_not_null(self):
        source = pathlib.Path(_migration().__file__).read_text()
        assert "is_nullable = 'NO'" in source
        assert "DROP NOT NULL" in source

    def test_downgrade_folds_the_company_level_back_into_the_shop_row(self, world):
        _set_company(world, world.H, False)
        world.db.execute(text(_migration().INHERIT_TO_EXPLICIT))
        world.db.commit()
        world.db.expire_all()
        assert world.rows.p_h.is_available is False  # H's lock, now on the shop row
        assert world.rows.p_a.is_available is True   # A set nothing: the product's flag


def test_the_routes_are_mounted():
    # Handlers are called directly above; this proves a request can reach them.
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for method, path in (
        ("GET", "/api/v1/products/{product_id}/availability"),
        ("PUT", "/api/v1/products/{product_id}/availability/companies/{company_id}"),
        ("PUT", "/api/v1/products/{product_id}/availability/shops/{shop_id}"),
        ("PUT", "/api/v1/products/{product_id}/availability/machines/{machine_id}"),
    ):
        assert (method, path) in mounted, (method, path)
