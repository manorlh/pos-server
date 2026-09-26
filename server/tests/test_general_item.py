"""Cover for the built-in general item ("פריט כללי") the till's calculator sells through.

Every company has exactly one, created with the company, sold in every active shop of
that company (and of no sub-company), open price with no VAT rate of its own, and it
cannot be deleted or turned into something else. Each test names a way this could look
as if it worked while doing damage:

* a company with no general item — its tills' calculator has nothing to sell through;
* two of them — the till cannot tell which one the calculator means;
* a shop opened later without it, or a sub-company's shop with its parent's;
* a merchant deleting it, unlisting it from a shop, or flipping it to a fixed price
  of 0 — every calculator line would ring up wrong or not at all;
* `isGeneral` missing from the payload — the till never finds it.

Runs on a real SQLAlchemy session over an in-memory SQLite database — local, private to
the test, never the configured database — so the partial unique index and the queries
the routers issue are the real ones. The migration is covered by rendering it offline.
"""
from __future__ import annotations

import importlib.util
import io
import itertools
import os
import pathlib
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.sql import sqltypes

import app.models  # noqa: F401  (every mapper, so relationships resolve)
from app.database import Base
from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.tenant import Tenant
from app.models.tenant_local_sku_sequence import TenantLocalSkuSequence
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import companies as companies_router
from app.routers import product_availability as availability_router
from app.routers import products as products_router
from app.routers import shops as shops_router
from app.routers import sync as sync_router
from app.schemas.company import CompanyCreate
from app.schemas.product import (
    ProductCreate,
    ProductResponse,
    ProductUpdate,
    ShopScopePreviewRequest,
)
from app.schemas.product_availability import AvailabilitySet
from app.schemas.shop import ShopCreate, ShopUpdate
from app.schemas.shop_product_override import ShopProductOverrideUpsert
from app.services import catalog_notify
from app.services import general_item as G
from app.services import settings_notify
from app.services import sync as S


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


_TABLES = (
    "tenants", "companies", "shops", "pos_machines", "categories", "vouchers", "products",
    "shop_product_overrides", "company_product_overrides", "machine_product_overrides",
    "customers", "tenant_local_sku_sequences", "shop_category_overrides", "sync_logs",
    "transaction_items", "users",
)


# ── A world on a real session ────────────────────────────────────────────────


@pytest.fixture
def world(monkeypatch):
    """
    Tenant T:
        H (holding, created through the endpoint) ── A (sub-company of H, likewise)
    Shops: h1, h2 (active) and h_off (inactive) in H; a1 in A.
    A till in h1 and one in a1.
    """
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
        catalog_notify, "publish_catalog_notify", lambda *a, **k: notified.append(a)
    )
    monkeypatch.setattr(settings_notify, "publish_settings_notify", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(shops_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    # Seeding a shop's default operator hashes a PIN and needs pos_users; not this test's.
    monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda _db, _shop: None)

    tenant = Tenant(id=uuid.uuid4(), name="T", slug="t")
    db.add(tenant)
    # The SKU allocator seeds a missing counter with a Postgres regex; start it here.
    db.add(TenantLocalSkuSequence(tenant_id=tenant.id, next_value=1000))
    db.commit()
    tid = tenant.id

    admin = User(
        id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tid,
        email="a@x", username="admin",
    )
    distributor = User(
        id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=tid,
        email="d@x", username="dist",
    )

    def new_company(name, parent=None):
        return companies_router.create_company(
            CompanyCreate(name=name, parentCompanyId=parent.id if parent else None),
            current_user=distributor, active_tenant_id=tid, db=db,
        )

    H = new_company("Holding")
    A = new_company("Alpha", parent=H)

    def shop(name, company, active=True):
        # Through the endpoint, so the product-rule hook runs as it does in production.
        return shops_router.create_shop(
            ShopCreate(name=name, companyId=company.id, isActive=active),
            current_user=admin, active_tenant_id=tid, db=db,
        )

    h1, h2, h_off, a1 = shop("h1", H), shop("h2", H), shop("h_off", H, False), shop("a1", A)
    codes = itertools.count(1)

    def till(s):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=tid, shop_id=s.id, distributor_id=uuid.uuid4(),
            name=f"till-{s.name}", machine_code=f"M-{next(codes)}", pos_number="1",
            is_active=True,
        )
        db.add(m)
        return m

    t_h1, t_a1 = till(h1), till(a1)
    drinks = Category(id=uuid.uuid4(), tenant_id=tid, company_id=H.id, name="Drinks")
    db.add(drinks)
    cola = Product(
        id=uuid.uuid4(), tenant_id=tid, company_id=H.id, category_id=drinks.id,
        catalog_level=CatalogLevel.GLOBAL, name="Cola", price=Decimal("8"), sku="COLA",
        is_available=True,
    )
    db.add(cola)
    db.flush()
    db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=h1.id, global_product_id=cola.id,
                               is_listed=True))
    db.commit()

    yield SimpleNamespace(
        db=db, tid=tid, H=H, A=A, h1=h1, h2=h2, h_off=h_off, a1=a1, t_h1=t_h1, t_a1=t_a1,
        drinks=drinks, cola=cola, admin=admin, distributor=distributor,
        new_company=new_company, notified=notified,
    )
    db.close()
    engine.dispose()


def _general(w, company) -> Product:
    rows = w.db.query(Product).filter(Product.company_id == company.id, Product.is_general.is_(True)).all()
    assert len(rows) == 1, f"{company.name} has {len(rows)} general items"
    return rows[0]


def _rows(w, product):
    return {
        str(r.shop_id): r
        for r in w.db.query(ShopProductOverride)
        .filter(ShopProductOverride.global_product_id == product.id)
        .all()
    }


def _refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as info:
        fn(*args, **kwargs)
    assert info.value.status_code == 400, info.value.detail
    return info.value


def _update(w, product, body, user=None):
    return products_router.update_product(
        str(product.id), ProductUpdate.model_validate(body),
        current_user=user or w.admin, active_tenant_id=w.tid, db=w.db,
    )


def _delete(w, product):
    return products_router.delete_product(
        str(product.id), current_user=w.admin, active_tenant_id=w.tid, db=w.db
    )


def _synced(w, machine, product):
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id))
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


_ACTOR = SimpleNamespace(user_id=None, pos_user_id=None)


# ── It exists: one per company, from the moment the company does ─────────────


class TestOnePerCompany:
    def test_a_new_company_has_exactly_one_general_item(self, world):
        w = world
        g = _general(w, w.H)
        assert g.name == "פריט כללי"
        assert g.is_open_price is True
        assert g.price == Decimal("0")
        assert g.tax_rate is None, "the till must apply the shop's standard VAT rate"
        assert g.is_weighed is False and g.track_stock is False and g.voucher_id is None
        assert g.catalog_level in (CatalogLevel.GLOBAL, "global")
        assert g.company_id == w.H.id and g.tenant_id == w.tid
        assert g.sku_auto_assigned is True and g.sku.isdigit()
        _general(w, w.A)  # the sub-company has its own

    def test_it_is_filed_under_a_general_category_of_its_own_company(self, world):
        cat = world.db.query(Category).filter(Category.id == _general(world, world.H).category_id).one()
        assert cat.name == "כללי" and cat.company_id == world.H.id and cat.is_active

    def test_an_existing_general_category_is_reused_not_duplicated(self, world):
        w = world
        company = Company(id=uuid.uuid4(), tenant_id=w.tid, name="Gamma")
        w.db.add(company)
        mine = Category(id=uuid.uuid4(), tenant_id=w.tid, company_id=company.id, name="כללי")
        w.db.add(mine)
        w.db.flush()
        G.ensure_general_item(w.db, company)
        assert _general(w, company).category_id == mine.id
        assert w.db.query(Category).filter(Category.company_id == company.id).count() == 1

    def test_ensuring_again_creates_nothing(self, world):
        w = world
        before = _general(w, w.H)
        again = G.ensure_general_item(w.db, w.H)
        assert again.product is before and again.created is False
        _general(w, w.H)

    def test_the_database_refuses_a_second_one_for_a_company(self, world):
        w = world
        w.db.add(Product(
            id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, category_id=w.drinks.id,
            catalog_level=CatalogLevel.GLOBAL, name="Second", price=Decimal("0"),
            sku="DUP", is_general=True, is_open_price=True,
        ))
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()

    def test_the_index_constrains_only_general_items(self, world):
        w = world
        for n in range(2):
            w.db.add(Product(
                id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, category_id=w.drinks.id,
                catalog_level=CatalogLevel.GLOBAL, name=f"Open {n}", price=Decimal("0"),
                sku=f"OPEN{n}", is_open_price=True,
            ))
        w.db.flush()  # any number of ordinary open-price products

    def test_a_request_cannot_create_one(self, world):
        w = world
        body = ProductCreate.model_validate(
            {"name": "Mine", "price": 0, "categoryId": str(w.drinks.id),
             "companyId": str(w.H.id), "isGeneral": True, "isOpenPrice": True}
        )
        _refused(products_router.create_product, body,
                 current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        _refused(sync_router.machine_create_cloud_product, str(w.t_h1.id), body,
                 machine=w.t_h1, actor=_ACTOR, db=w.db)
        _general(w, w.H)


# ── Where it is sold ─────────────────────────────────────────────────────────


class TestReach:
    def test_a_company_that_already_has_shops_gets_it_in_each_active_one(self, world):
        # The migration's case, and the safety net's: the shops predate the item.
        w = world
        company = Company(id=uuid.uuid4(), tenant_id=w.tid, name="Old")
        w.db.add(company)
        w.db.flush()
        shops = [
            Shop(id=uuid.uuid4(), tenant_id=w.tid, company_id=company.id, name=n,
                 settings={}, is_active=active)
            for n, active in (("o1", True), ("o2", True), ("o3", False))
        ]
        w.db.add_all(shops)
        w.db.flush()
        ensured = G.ensure_general_item(w.db, company)
        assert ensured.created
        assert set(_rows(w, ensured.product)) == {str(shops[0].id), str(shops[1].id)}
        assert ensured.shop_ids == {str(shops[0].id), str(shops[1].id)}

    def test_every_active_shop_of_its_company_as_rule_rows(self, world):
        w = world
        g = _general(w, w.H)
        rows = _rows(w, g)
        assert set(rows) == {str(w.h1.id), str(w.h2.id)}, "inactive shops get no row"
        for r in rows.values():
            assert r.assigned_by_rule is True and r.is_listed is True
            assert r.price is None and r.is_available is None
        assert (g.shop_scope_mode, g.shop_scope_company_id, g.shop_scope_include_subcompanies) == (
            "company", w.H.id, False,
        )

    def test_a_shop_opened_later_gets_it(self, world):
        w = world
        new = shops_router.create_shop(
            ShopCreate(name="h3", companyId=w.H.id),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        row = _rows(w, _general(w, w.H))[str(new.id)]
        assert row.assigned_by_rule and row.is_listed

    def test_a_reactivated_shop_gets_it(self, world):
        w = world
        shops_router.update_shop(
            str(w.h_off.id), ShopUpdate(isActive=True),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert str(w.h_off.id) in _rows(w, _general(w, w.H))

    def test_never_a_sub_companys_shops(self, world):
        w = world
        assert str(w.a1.id) not in _rows(w, _general(w, w.H))
        assert set(_rows(w, _general(w, w.A))) == {str(w.a1.id)}
        later = shops_router.create_shop(
            ShopCreate(name="a2", companyId=w.A.id),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert str(later.id) not in _rows(w, _general(w, w.H))
        assert str(later.id) in _rows(w, _general(w, w.A))

    def test_a_sub_companys_till_sees_only_its_own(self, world):
        w = world
        assert _synced(w, w.t_a1, _general(w, w.H)) is None
        assert _synced(w, w.t_a1, _general(w, w.A))["isGeneral"] is True

    def test_a_parents_general_item_cannot_be_added_to_a_sub_companys_shop(self, world):
        w = world
        _refused(shops_router.assign_shop_product, str(w.a1.id), str(_general(w, w.H).id),
                 current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        listed = shops_router.list_shop_product_catalog_candidates(
            str(w.a1.id), page=1, page_size=100, search=None,
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert str(_general(w, w.H).id) not in {str(i.global_product_id) for i in listed.items}


# ── What cannot change ───────────────────────────────────────────────────────


class TestProtected:
    def test_it_cannot_be_deleted(self, world):
        w = world
        g = _general(w, w.H)
        err = _refused(_delete, w, g)
        assert "cannot be deleted" in err.detail
        _general(w, w.H)

    def test_an_ordinary_product_still_deletes(self, world):
        w = world
        _delete(w, w.cola)
        assert w.db.query(Product).filter(Product.id == w.cola.id).first() is None

    @pytest.mark.parametrize(
        "body",
        [
            {"isGeneral": False},
            {"isOpenPrice": False, "price": 10},
            {"taxRate": 0},
            {"taxRate": 17},
            {"isWeighed": True},
            {"trackStock": True},
            {"voucherId": str(uuid.uuid4())},
        ],
    )
    def test_what_it_is_cannot_change(self, world, body):
        w = world
        g = _general(w, w.H)
        if "voucherId" in body:
            # The voucher's existence is checked first; make the guard the one that answers.
            from app.models.voucher import Voucher

            w.db.add(Voucher(id=uuid.UUID(body["voucherId"]), tenant_id=w.tid, name="V"))
            w.db.flush()
        _refused(_update, w, g, body)
        w.db.rollback()
        g = _general(w, w.H)
        assert g.is_open_price is True and g.tax_rate is None and g.is_general is True

    def test_no_other_product_can_become_it(self, world):
        w = world
        _refused(_update, w, w.cola, {"isGeneral": True})
        _general(w, w.H)

    @pytest.mark.parametrize(
        "scope",
        [
            {"mode": "shops", "shopIds": []},
            {"mode": "company", "companyId": "SELF", "includeSubcompanies": True},
            {"mode": "company", "companyId": "SUB"},
        ],
    )
    def test_where_it_is_sold_cannot_change(self, world, scope):
        w = world
        g = _general(w, w.H)
        scope = dict(scope)
        if scope.get("companyId") == "SELF":
            scope["companyId"] = str(w.H.id)
        elif scope.get("companyId") == "SUB":
            scope["companyId"] = str(w.A.id)
        _refused(_update, w, g, {"shopScope": scope})
        _refused(products_router.preview_shop_scope,
                 ShopScopePreviewRequest.model_validate({"shopScope": scope, "productId": str(g.id)}),
                 current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        assert set(_rows(w, g)) == {str(w.h1.id), str(w.h2.id)}

    def test_a_shop_cannot_unlist_or_drop_it(self, world):
        w = world
        g = _general(w, w.H)
        _refused(shops_router.upsert_shop_product_override, str(w.h1.id), str(g.id),
                 ShopProductOverrideUpsert(isListed=False),
                 current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        _refused(shops_router.unassign_shop_product, str(w.h1.id), str(g.id),
                 current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        row = _rows(w, g)[str(w.h1.id)]
        assert row.is_listed is True and row.assigned_by_rule is True

    def test_the_till_cannot_unlist_delete_or_reshape_it(self, world):
        w = world
        g = _general(w, w.H)
        # (The till unlists through DELETE: ProductUpdate carries no isListed.)
        for body in ({"isOpenPrice": False, "price": 5}, {"isGeneral": False}, {"taxRate": 0}):
            _refused(sync_router.machine_update_cloud_product, str(w.t_h1.id), str(g.id),
                     ProductUpdate.model_validate(body), machine=w.t_h1, actor=_ACTOR, db=w.db)
        _refused(sync_router.machine_delete_cloud_product, str(w.t_h1.id), str(g.id),
                 machine=w.t_h1, actor=_ACTOR, db=w.db)
        assert _rows(w, g)[str(w.h1.id)].is_listed is True


# ── What stays the merchant's ────────────────────────────────────────────────


class TestAllowed:
    def test_rename_image_category_price_and_description(self, world):
        w = world
        g = _general(w, w.H)
        other = Category(id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, name="Misc")
        w.db.add(other)
        w.db.commit()
        _update(w, g, {"name": "סכום חופשי", "imageUrl": "https://x/i.png",
                       "categoryId": str(other.id), "price": 5, "description": "d"})
        g = _general(w, w.H)
        assert (g.name, g.image_url, g.category_id, g.price) == (
            "סכום חופשי", "https://x/i.png", other.id, Decimal("5"),
        )
        assert g.is_open_price is True

    def test_the_dashboard_echoing_the_whole_product_back_is_not_a_change(self, world):
        w = world
        g = _general(w, w.H)
        echo = ProductResponse.model_validate(g).model_dump(by_alias=True, mode="json")
        body = {k: echo[k] for k in (
            "name", "price", "sku", "categoryId", "imageUrl", "inStock", "stockQuantity",
            "barcode", "taxRate", "voucherId", "trackStock", "isOpenPrice", "isWeighed",
            "unitLabel", "isGeneral",
        )}
        body["name"] = "Renamed"
        body["shopScope"] = {"mode": "company", "companyId": str(w.H.id), "includeSubcompanies": False}
        _update(w, g, body)
        assert _general(w, w.H).name == "Renamed"

    def test_a_shop_prices_and_locks_it(self, world):
        w = world
        g = _general(w, w.H)
        shops_router.upsert_shop_product_override(
            str(w.h1.id), str(g.id), ShopProductOverrideUpsert(price=3, isAvailable=False),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        row = _synced(w, w.t_h1, g)
        assert row["price"] == 3.0 and row["isAvailable"] is False and row["isGeneral"] is True

    def test_a_company_lock_works_on_it_like_on_any_product(self, world):
        w = world
        g = _general(w, w.H)
        availability_router.set_company_availability(
            str(g.id), str(w.H.id), AvailabilitySet(isAvailable=False),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert _synced(w, w.t_h1, g)["isAvailable"] is False
        availability_router.set_company_availability(
            str(g.id), str(w.H.id), AvailabilitySet(isAvailable=None),
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert _synced(w, w.t_h1, g)["isAvailable"] is True

    def test_the_till_may_reprice_it_for_its_shop(self, world):
        w = world
        g = _general(w, w.H)
        sync_router.machine_update_cloud_product(
            str(w.t_h1.id), str(g.id), ProductUpdate(price=Decimal("2")),
            machine=w.t_h1, actor=_ACTOR, db=w.db,
        )
        assert _synced(w, w.t_h1, g)["price"] == 2.0


# ── isGeneral on the wire ────────────────────────────────────────────────────


class TestOnTheWire:
    def test_sync_flags_it_and_nothing_else(self, world):
        w = world
        g = _general(w, w.H)
        row = _synced(w, w.t_h1, g)
        assert row["isGeneral"] is True
        assert row["isOpenPrice"] is True and row["taxRate"] is None and row["price"] == 0.0
        assert row["name"] == "פריט כללי"
        assert _synced(w, w.t_h1, w.cola)["isGeneral"] is False

    def test_every_product_row_carries_the_key(self, world):
        w = world
        rows = S.get_products_for_sync(w.db, str(w.tid), str(w.t_h1.id))
        assert rows and all(isinstance(r["isGeneral"], bool) for r in rows)
        tenant_rows = S.get_products_for_sync(w.db, str(w.tid), None)
        assert {r["isGeneral"] for r in tenant_rows} == {True, False}

    def test_a_tills_local_copy_reads_as_general_through_its_global_row(self, world):
        w = world
        g = _general(w, w.H)
        local = Product(
            id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, category_id=g.category_id,
            global_product_id=g.id, pos_machine_id=w.t_h1.id,
            catalog_level=CatalogLevel.LOCAL, name=g.name, price=g.price, sku=g.sku + "L",
            is_open_price=True, is_general=False,
        )
        w.db.add(local)
        w.db.flush()
        assert S._serialize_product(local)["isGeneral"] is True
        assert S._serialize_product(w.cola)["isGeneral"] is False

    def test_the_api_response_and_list_carry_it(self, world):
        w = world
        g = _general(w, w.H)
        got = products_router.get_product(str(g.id), current_user=w.admin, active_tenant_id=w.tid, db=w.db)
        assert ProductResponse.model_validate(got).model_dump(by_alias=True)["isGeneral"] is True
        listed = products_router.list_products(
            page=1, page_size=100, company_id=None, shop_id=None, pos_machine_id=None,
            category_id=None, catalog_level=None, in_stock=None, search=None,
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        flags = {
            str(p.id): ProductResponse.model_validate(p).model_dump(by_alias=True)["isGeneral"]
            for p in listed.items
        }
        assert flags[str(g.id)] is True and flags[str(w.cola.id)] is False

    def test_the_assortment_page_marks_it(self, world):
        w = world
        res = shops_router.list_shop_product_overrides(
            str(w.h1.id), page=1, page_size=100,
            current_user=w.admin, active_tenant_id=w.tid, db=w.db,
        )
        flags = {str(i.global_product_id): i.is_general for i in res.items}
        assert flags[str(_general(w, w.H).id)] is True and flags[str(w.cola.id)] is False


# ── The safety net and the company's end ─────────────────────────────────────


class TestLifecycle:
    def test_a_catalog_pull_creates_a_missing_one_and_sends_it(self, world):
        w = world
        g = _general(w, w.H)
        w.db.query(ShopProductOverride).filter(ShopProductOverride.global_product_id == g.id).delete()
        w.db.delete(g)
        w.db.commit()
        res = sync_router.get_catalog_sync(str(w.t_h1.id), since=None, machine=w.t_h1, db=w.db)
        new = _general(w, w.H)
        assert new.id != g.id
        assert [p for p in res.products if p["globalProductId"] == str(new.id)][0]["isGeneral"] is True
        assert set(_rows(w, new)) == {str(w.h1.id), str(w.h2.id)}

    def test_a_catalog_pull_leaves_an_existing_one_alone(self, world):
        w = world
        before = _general(w, w.H).id
        sync_router.get_catalog_sync(str(w.t_h1.id), since=None, machine=w.t_h1, db=w.db)
        assert _general(w, w.H).id == before

    def test_deleting_a_company_takes_its_general_item_and_category(self, world):
        w = world
        c = w.new_company("Short-lived")
        g = _general(w, c)
        cat_id = g.category_id
        companies_router.delete_company(str(c.id), current_user=w.distributor,
                                        active_tenant_id=w.tid, db=w.db)
        assert w.db.query(Product).filter(Product.id == g.id).first() is None
        assert w.db.query(Category).filter(Category.id == cat_id).first() is None

    def test_a_general_item_that_was_sold_blocks_deleting_its_company(self, world):
        w = world
        c = w.new_company("Traded")
        g = _general(w, c)
        w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=uuid.uuid4(), product_id=g.id,
                                 quantity=1, unit_price=5, total_price=5))
        w.db.commit()
        with pytest.raises(HTTPException) as info:
            companies_router.delete_company(str(c.id), current_user=w.distributor,
                                            active_tenant_id=w.tid, db=w.db)
        assert info.value.status_code == 422


# ── The migration ────────────────────────────────────────────────────────────


_HERE = pathlib.Path(__file__).resolve().parents[1]


def _migration():
    path = _HERE / "alembic" / "versions" / "e7f8a9b0c1d2_general_item.py"
    spec = importlib.util.spec_from_file_location("general_item_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestMigration:
    """
    Rendered, not run: `alembic upgrade --sql` needs no database, and the backfill is
    PL/pgSQL, which SQLite cannot execute.
    """

    @pytest.fixture(scope="class")
    def sql(self) -> str:
        from alembic import command
        from alembic.config import Config

        buf = io.StringIO()
        cfg = Config(os.path.join(_HERE, "alembic.ini"), output_buffer=buf)
        cfg.set_main_option("script_location", os.path.join(_HERE, "alembic"))
        command.upgrade(cfg, "d6e7f8a9b0c1:e7f8a9b0c1d2", sql=True)
        return " ".join(buf.getvalue().split())

    def test_chained_onto_availability_and_the_only_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        m = _migration()
        assert (m.revision, m.down_revision) == ("e7f8a9b0c1d2", "d6e7f8a9b0c1")
        cfg = Config(str(_HERE / "alembic.ini"))
        cfg.set_main_option("script_location", str(_HERE / "alembic"))
        assert ScriptDirectory.from_config(cfg).get_heads() == ["e7f8a9b0c1d2"]

    def test_the_column_and_the_one_per_company_index(self, sql):
        assert "ADD COLUMN IF NOT EXISTS is_general BOOLEAN NOT NULL DEFAULT false" in sql
        assert (
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_products_general_per_company "
            "ON products (company_id) WHERE is_general" in sql
        )
        # The index exists before the backfill writes a single row under it.
        assert sql.index("uq_products_general_per_company") < sql.index("DO $$")

    def test_the_model_declares_the_same_index(self):
        idx = {i.name: i for i in Product.__table__.indexes}["uq_products_general_per_company"]
        assert idx.unique and [c.name for c in idx.columns] == ["company_id"]

    def test_one_per_company_that_lacks_one_and_a_rerun_creates_nothing(self, sql):
        assert "FROM companies co WHERE co.tenant_id IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM products p WHERE p.company_id = co.id AND p.is_general )" in sql
        assert sql.count("INSERT INTO products") == 1

    def test_the_product_is_open_price_standard_vat_and_ruled_to_its_own_company(self, sql):
        insert = sql[sql.index("INSERT INTO products"):sql.index("INSERT INTO shop_product_overrides")]
        assert "'פריט כללי'" in insert
        # is_open_price, is_weighed, unit_label, is_general
        assert "true, false, NULL, true," in insert
        # tax_rate and voucher_id NULL, track_stock false
        assert "0, NULL, NULL, NULL, false," in insert
        # the company rule on its own company, without sub-companies
        assert "'company', c.id, false," in insert
        assert "sku_no::TEXT, NULL, true" in insert  # SKU from the counter, no global SKU

    def test_the_sku_comes_from_the_counter_and_never_collides(self, sql):
        assert "ON CONFLICT (tenant_id) DO NOTHING" in sql
        assert "RETURNING q.next_value - 1 INTO sku_no" in sql
        assert "MAX(p.sku::BIGINT) + 1" in sql and "p.sku ~ '^[0-9]{1,18}$'" in sql

    def test_the_category_is_reused_or_created_per_company(self, sql):
        assert "AND k.company_id = c.id" in sql and "AND k.name = 'כללי'" in sql
        assert "IF cat_id IS NULL THEN" in sql

    def test_assortment_rows_for_each_active_shop_of_its_own_company_only(self, sql):
        rows = sql[sql.index("INSERT INTO shop_product_overrides"):sql.index("END LOOP")]
        assert "SELECT gen_random_uuid(), s.id, prod_id, NULL, true, NULL, true, now(), now()" in rows
        assert "WHERE s.company_id = c.id AND s.tenant_id = c.tenant_id AND s.is_active" in rows
        assert "ON CONFLICT (shop_id, global_product_id) DO NOTHING" in rows
        assert "parent_company_id" not in rows, "a sub-company's shops get their own item"
