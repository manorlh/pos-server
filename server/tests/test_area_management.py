"""
Chain → shops → points of sale (P:/specs/chain-areas.md): the area manager's reach across the dashboard API
(app/services/area_scope.py), "שיוך מוצר לנקודות מכירה" (app/services/product_areas.py), prices per level and the
chain's price policy (app/services/price_policy.py), till users' points of sale, the dashboard's saved scope, the
point of sale's X and the area Z from its master till.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.category import Category
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile
from app.models.pos_user import PosUser
from app.models.price_policy import PriceChange, PricePolicy
from app.models.product import Product
from app.models.product_availability_override import AreaProductOverride
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.services import area_scope
from app.services import price_policy as PP
from app.services import product_areas as PA
from app.services import sync as S
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401


# ── The world: one shop, two points of sale (bar: till 1, kitchen: till 2), an area manager of the bar ─────


@pytest.fixture
def a(w, monkeypatch):  # noqa: F811
    from app.services import catalog_notify, product_availability

    for mod in (catalog_notify, product_availability):
        for name in ("notify_machines_for_shop", "notify_area_change", "notify_shop_change"):
            if hasattr(mod, name):
                monkeypatch.setattr(mod, name, lambda *x, **k: None)
    from app.routers import area_management as AM

    monkeypatch.setattr(AM, "_notify_shop", lambda *x, **k: None)
    w.t1, w.t2 = w.tills
    w.bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
    w.kitchen = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="מטבח")
    w.db.add_all([w.bar, w.kitchen])
    w.db.flush()
    w.t1.area_id, w.t2.area_id = w.bar.id, w.kitchen.id
    w.manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=w.shop.id,
                     email="m@x", username="manager")
    w.ahmash = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    email="b@x", username="bar")
    w.chain = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, company_id=w.company.id,
                   email="c@x", username="chain")
    w.db.add_all([w.manager, w.ahmash, w.chain])
    w.db.flush()
    w.db.add(DashboardAccessProfile(user_id=w.ahmash.id, full_access=True, sections={}, area_ids=[str(w.bar.id)]))
    w.db.add(DashboardAccessProfile(user_id=w.manager.id, full_access=True, sections={}))
    w.db.add(DashboardAccessProfile(user_id=w.chain.id, full_access=True, sections={}))
    w.cat = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="שתייה")
    w.db.add(w.cat)
    w.db.flush()
    w.cola = _product(w, "קולה", "10", "K1")
    w.beer = _product(w, "בירה", "20", "B1")
    w.db.commit()
    area_scope.forget(w.db)
    return w


def _product(w, name, price, sku, company=True):
    p = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, category_id=w.cat.id, name=name, price=Decimal(price), sku=sku,
                company_id=w.company.id if company else None)
    w.db.add(p)
    w.db.flush()
    w.db.add(ShopProductOverride(shop_id=w.shop.id, global_product_id=p.id, is_listed=True))
    w.db.flush()
    return p


def _ctx(w, user):
    area_scope.forget(w.db)
    return dict(current_user=user, active_tenant_id=w.tenant.id, db=w.db)


def _row(w, product, shop=None):
    return w.db.query(ShopProductOverride).filter_by(shop_id=(shop or w.shop).id, global_product_id=product.id).one()


def _synced(w, till, product):
    rows = S.get_products_for_sync(w.db, str(w.tenant.id), str(till.id))
    return next(r for r in rows if r["globalProductId"] == str(product.id))


def _forbidden(fn, *args, detail=None, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*args, **kw)
    assert e.value.status_code == 403, e.value.detail
    if detail is not None:
        got = e.value.detail.get("code") if isinstance(e.value.detail, dict) else e.value.detail
        assert got == detail, e.value.detail
    w_db = kw.get("db")
    if w_db is not None:
        w_db.rollback()
    return e.value


# ── The reach ───────────────────────────────────────────────────────────────


class TestReach:
    def test_an_area_manager_reaches_their_point_of_sale_and_its_devices(self, a):
        reach = area_scope.reach_of(a.db, a.ahmash)
        assert reach.narrowed and reach.area_ids == {a.bar.id}
        assert reach.covers_machine(a.t1) and not reach.covers_machine(a.t2)
        assert reach.covers_shop(a.shop.id) and not reach.covers_shop(a.other_shop.id)

    def test_nobody_else_is_narrowed(self, a):
        for user in (a.admin, a.manager, a.chain):
            area_scope.forget(a.db)
            assert not area_scope.reach_of(a.db, user).narrowed

    def test_a_device_moved_out_leaves_the_reach(self, a):
        a.t1.area_id = a.kitchen.id
        a.db.flush()
        area_scope.forget(a.db)
        assert not area_scope.machine_ok(a.db, a.ahmash, a.t1)


# ── Enforcement per endpoint group ───────────────────────────────────────────


class TestEnforcement:
    def test_rows_by_device_transactions_and_reports(self, a):
        from app.services.scoping import scope_transactions_by_user

        s1 = a.shift(a.t1, 1)
        s2 = a.shift(a.t2, 1)
        a.doc(a.t1, s1, "10.00")
        a.doc(a.t2, s2, "20.00")
        a.db.commit()
        area_scope.forget(a.db)
        mine = scope_transactions_by_user(a.db.query(Transaction), a.ahmash, a.db).all()
        assert {t.machine_id for t in mine} == {a.t1.id}
        area_scope.forget(a.db)
        everyone = scope_transactions_by_user(a.db.query(Transaction), a.manager, a.db).all()
        assert {t.machine_id for t in everyone} == {a.t1.id, a.t2.id}

    def test_one_device_and_the_machines_list(self, a):
        from app.routers import machines as M
        from app.services.company_hierarchy import user_may_use_machine

        area_scope.forget(a.db)
        assert user_may_use_machine(a.db, a.ahmash, a.t1) and not user_may_use_machine(a.db, a.ahmash, a.t2)
        assert M._check_machine_list_access(a.ahmash, a.t1, a.db) and not M._check_machine_list_access(a.ahmash, a.t2, a.db)
        listed = M.list_machines(skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
                                 include_inactive=False, area_id=None, **_ctx(a, a.ahmash))
        assert {str(m["id"]) for m in listed} == {str(a.t1.id)}

    def test_shop_level_writes_are_refused(self, a):
        from app.routers import product_availability as PAV
        from app.routers import shops as SH
        from app.schemas.product_availability import AvailabilitySet
        from app.schemas.shop_product_override import ShopProductOverrideUpsert

        _forbidden(SH.upsert_shop_product_override, str(a.shop.id), str(a.cola.id),
                   ShopProductOverrideUpsert(price=5), detail=area_scope.NEEDS_SHOP, **_ctx(a, a.ahmash))
        _forbidden(PAV.set_shop_availability, str(a.cola.id), str(a.shop.id), AvailabilitySet(isAvailable=False),
                   detail=area_scope.NEEDS_SHOP, **_ctx(a, a.ahmash))

    def test_their_point_of_sale_yes_another_no(self, a):
        from app.routers import product_availability as PAV
        from app.schemas.product_availability import AvailabilitySet

        out = PAV.set_area_availability(str(a.cola.id), str(a.bar.id), AvailabilitySet(isAvailable=False), **_ctx(a, a.ahmash))
        assert out.level == "area"
        _forbidden(PAV.set_area_availability, str(a.cola.id), str(a.kitchen.id), AvailabilitySet(isAvailable=False),
                   detail=area_scope.OUTSIDE, **_ctx(a, a.ahmash))
        _forbidden(PAV.set_machine_availability, str(a.cola.id), str(a.t2.id), AvailabilitySet(isAvailable=False),
                   **_ctx(a, a.ahmash))

    def test_z_wizard_only_their_area(self, a):
        from app.routers import z_runs as ZRR

        _forbidden(ZRR.get_z_candidates, a.shop.id, area_id=None, detail=area_scope.NEEDS_SHOP, **_ctx(a, a.ahmash))
        _forbidden(ZRR.get_z_candidates, a.shop.id, area_id=a.kitchen.id, detail=area_scope.OUTSIDE, **_ctx(a, a.ahmash))
        out = ZRR.get_z_candidates(a.shop.id, area_id=a.bar.id, **_ctx(a, a.ahmash))
        assert [str(t.machine_id) for t in out.machines] == [str(a.t1.id)]

    def test_z_reports_only_their_areas_zs(self, a):
        from app.routers import z_reports as ZRP

        shop_z = ZReport(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.shop.id, shop_sequence_number=1, area_id=None,
                         business_date=NOW.date(), closed_at=NOW)
        bar_z = ZReport(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.shop.id, shop_sequence_number=2, area_id=a.bar.id,
                        business_date=NOW.date(), closed_at=NOW)
        a.db.add_all([shop_z, bar_z])
        a.db.commit()
        area_scope.forget(a.db)
        ids = {z.id for z in ZRP._scope_by_user(a.db.query(ZReport), a.ahmash, a.db).all()}
        assert ids == {bar_z.id}

    def test_messages_kds_settings_and_kiosk_layers(self, a):
        from app.routers import kds as KR
        from app.schemas.kds import KdsDeviceIn
        from app.services import till_messages as TM

        _forbidden(TM.resolve_target, a.db, a.ahmash, a.tenant.id, "shop", a.shop.id)
        assert TM.resolve_target(a.db, a.ahmash, a.tenant.id, "area", a.bar.id).id == a.bar.id
        _forbidden(TM.resolve_target, a.db, a.ahmash, a.tenant.id, "area", a.kitchen.id)
        area_scope.forget(a.db)
        with pytest.raises(HTTPException) as e:
            KR._check_device_scope(a.db, a.ahmash, a.t1.id, KdsDeviceIn.model_validate({"role": "station"}))
        assert e.value.detail == area_scope.NEEDS_SHOP
        KR._check_device_scope(
            a.db, a.ahmash, a.t1.id, KdsDeviceIn.model_validate({"role": "station", "scope": {"areaIds": [str(a.bar.id)]}})
        )

    def test_areas_list_shows_their_own(self, a):
        from app.routers import areas as AR

        out = AR.list_shop_areas(a.shop.id, include_archived=False, **_ctx(a, a.ahmash))
        assert [str(x["id"]) for x in out] == [str(a.bar.id)]
        out = AR.list_shop_areas(a.shop.id, include_archived=False, **_ctx(a, a.manager))
        assert len(out) == 2


# ── Product points of sale ───────────────────────────────────────────────────


class TestProductAreas:
    def test_null_is_everywhere_and_a_list_hides_it_elsewhere(self, a):
        assert _synced(a, a.t2, a.beer)["shopListed"] is True
        change = PA.plan(a.db, a.manager, a.shop, a.beer, area_ids=[a.bar.id])
        PA.apply(a.db, a.shop, a.beer, change)
        a.db.commit()
        assert _row(a, a.beer).area_ids == [str(a.bar.id)]
        bar, kitchen = _synced(a, a.t1, a.beer), _synced(a, a.t2, a.beer)
        assert bar["shopListed"] is True and bar["inStock"] is True
        assert kitchen["shopListed"] is False and kitchen["inStock"] is False and kitchen["isAvailable"] is False

    def test_a_device_in_no_area_is_not_narrowed(self, a):
        PA.apply(a.db, a.shop, a.beer, PA.plan(a.db, a.manager, a.shop, a.beer, area_ids=[a.bar.id]))
        a.t2.area_id = None
        a.db.commit()
        assert _synced(a, a.t2, a.beer)["shopListed"] is True

    def test_every_area_is_null_and_none_unlists(self, a):
        PA.apply(a.db, a.shop, a.beer, PA.plan(a.db, a.manager, a.shop, a.beer, area_ids=[a.bar.id, a.kitchen.id]))
        assert _row(a, a.beer).area_ids is None
        PA.apply(a.db, a.shop, a.beer, PA.plan(a.db, a.manager, a.shop, a.beer, remove=[a.bar.id, a.kitchen.id]))
        assert _row(a, a.beer).is_listed is False
        PA.apply(a.db, a.shop, a.beer, PA.plan(a.db, a.manager, a.shop, a.beer, add=[a.kitchen.id]))
        row = _row(a, a.beer)
        assert row.is_listed is True and row.area_ids == [str(a.kitchen.id)]

    def test_an_area_manager_changes_only_their_point_of_sale(self, a):
        PA.apply(a.db, a.shop, a.beer, PA.plan(a.db, a.ahmash, a.shop, a.beer, remove=[a.bar.id]))
        assert _row(a, a.beer).area_ids == [str(a.kitchen.id)]
        with pytest.raises(HTTPException) as e:
            PA.plan(a.db, a.ahmash, a.shop, a.beer, remove=[a.kitchen.id])
        assert e.value.status_code == 403

    def test_bad_points_of_sale(self, a):
        other = ShopArea(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.other_shop.id, name="X")
        a.db.add(other)
        a.db.flush()
        with pytest.raises(HTTPException) as e:
            PA.plan(a.db, a.manager, a.shop, a.beer, area_ids=[other.id])
        assert e.value.status_code == 400

    def test_the_routes_and_the_bulk_action(self, a):
        from app.routers import area_management as AM

        out = AM.put_product_areas(str(a.beer.id), AM.ProductAreasIn(shopId=a.shop.id, areaIds=[a.bar.id]), **_ctx(a, a.manager))
        shop = out["shops"][0]
        assert [x["sold"] for x in shop["areas"]] == [True, False] and shop["allAreas"] is False
        res = AM.bulk_product_areas(AM.BulkAreasIn(productIds=[a.beer.id, a.cola.id], shopId=a.shop.id,
                                                  areaIds=[a.kitchen.id], action="remove"), **_ctx(a, a.ahmash))
        # beer is not in the kitchen: nothing changes; cola is everywhere → removing the kitchen is outside the bar's
        # manager: refused.
        assert [r["productId"] for r in res["refused"]] == [str(a.cola.id)] and res["unchanged"] == [str(a.beer.id)]
        res = AM.bulk_product_areas(AM.BulkAreasIn(productIds=[a.cola.id], shopId=a.shop.id,
                                                  areaIds=[a.bar.id], action="remove"), **_ctx(a, a.ahmash))
        assert res["changed"] == [str(a.cola.id)] and _row(a, a.cola).area_ids == [str(a.kitchen.id)]

    def test_a_new_product_starts_in_the_area_managers_points_of_sale(self, a):
        chosen = PA.default_for_new(a.db, a.ahmash, a.shop.id, None)
        assert chosen == [str(a.bar.id)]
        assert PA.default_for_new(a.db, a.manager, a.shop.id, [a.kitchen.id]) == [str(a.kitchen.id)]
        assert PA.default_for_new(a.db, a.manager, a.shop.id, None) is None


# ── Prices ───────────────────────────────────────────────────────────────────


class TestPrices:
    def test_area_then_shop_then_chain(self, a):
        assert _synced(a, a.t1, a.cola)["price"] == 10.0 and _synced(a, a.t1, a.cola)["priceLevel"] == "base"
        _row(a, a.cola).price = Decimal("11")
        a.db.add(AreaProductOverride(area_id=a.bar.id, product_id=a.cola.id, price=Decimal("12.50")))
        a.db.commit()
        bar, kitchen = _synced(a, a.t1, a.cola), _synced(a, a.t2, a.cola)
        assert (bar["price"], bar["priceLevel"]) == (12.5, "area")
        assert (kitchen["price"], kitchen["priceLevel"]) == (11.0, "shop")

    def test_managers_change_their_own_level_and_it_is_logged(self, a):
        PP.set_area_price(a.db, a.ahmash, a.cola, a.bar, 9)
        PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), 11)
        a.db.commit()
        log = a.db.query(PriceChange).order_by(PriceChange.level).all()
        assert [(c.level, c.new_price) for c in log] == [("area", Decimal("9.00")), ("shop", Decimal("11.00"))]
        assert a.cola.price == Decimal("10")  # the chain's never moved

    def test_only_the_chain_changes_the_chains_price(self, a):
        area_scope.forget(a.db)
        assert PP.actor_level(a.db, a.chain, a.cola) == PP.CHAIN
        assert PP.actor_level(a.db, a.manager, a.cola) == PP.SHOP
        assert PP.actor_level(a.db, a.ahmash, a.cola) == PP.AREA
        with pytest.raises(HTTPException) as e:
            PP.check(a.db, a.manager, a.cola, level=PP.LEVEL_BASE, shop_id=None, new_price=11)
        assert e.value.detail["reason"] == "base_is_chain"
        PP.check(a.db, a.chain, a.cola, level=PP.LEVEL_BASE, shop_id=None, new_price=11)

    def test_policy_chain_only(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="chain"))
        a.db.flush()
        with pytest.raises(HTTPException) as e:
            PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), 11)
        assert e.value.detail == {"code": "price_policy", "reason": "editors", "message": PP.MSG_CHAIN_ONLY, "editors": "chain"}
        PP.set_shop_price(a.db, a.chain, a.cola, _row(a, a.cola), 11)

    def test_policy_shop_keeps_area_managers_out(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="shop"))
        a.db.flush()
        PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), 11)
        with pytest.raises(HTTPException) as e:
            PP.set_area_price(a.db, a.ahmash, a.cola, a.bar, 9)
        assert e.value.detail["message"] == PP.MSG_SHOP_ONLY

    def test_a_shop_exception(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="area",
                             shop_editors={str(a.shop.id): "chain"}))
        a.db.flush()
        with pytest.raises(HTTPException):
            PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), 11)
        other = ShopProductOverride(shop_id=a.other_shop.id, global_product_id=a.cola.id, is_listed=True)
        a.db.add(other)
        a.db.flush()
        PP.check(a.db, a.manager, a.cola, level=PP.SHOP, shop_id=a.other_shop.id, new_price=11)

    def test_locked_product_and_category(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="area",
                             locked_product_ids=[str(a.cola.id)]))
        a.db.flush()
        with pytest.raises(HTTPException) as e:
            PP.set_area_price(a.db, a.ahmash, a.cola, a.bar, 9)
        assert e.value.detail["message"] == PP.MSG_LOCKED
        PP.set_area_price(a.db, a.ahmash, a.beer, a.bar, 19)
        a.db.get(PricePolicy, a.company.id).locked_category_ids = [str(a.cat.id)]
        a.db.flush()
        with pytest.raises(HTTPException):
            PP.set_area_price(a.db, a.ahmash, a.beer, a.bar, 18)

    def test_allowed_range(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="area", max_delta_pct=Decimal("10")))
        a.db.flush()
        PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), 11)
        with pytest.raises(HTTPException) as e:
            PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), "11.01")
        assert e.value.detail["reason"] == "range" and e.value.detail["max"] == 11.0 and "₪9.00–₪11.00" in e.value.detail["message"]
        PP.set_shop_price(a.db, a.manager, a.cola, _row(a, a.cola), None)  # back to the chain's: always

    def test_a_franchisee_cannot_open_what_the_chain_closed(self, a):
        franchise = Company(id=uuid.uuid4(), tenant_id=a.tenant.id, name="זכיין", parent_company_id=a.company.id)
        a.db.add(franchise)
        a.db.flush()
        a.other_shop.company_id = franchise.id
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="chain"))
        a.db.add(PricePolicy(company_id=franchise.id, tenant_id=a.tenant.id, editors="area", max_delta_pct=Decimal("5")))
        a.db.flush()
        pol = PP.effective(a.db, shop_id=a.other_shop.id)
        assert pol.editors == "chain" and pol.max_delta_pct == Decimal("5")

    def test_till_price_change_follows_the_policy(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="chain"))
        a.db.flush()
        with pytest.raises(HTTPException) as e:
            PP.check_till(a.db, a.cola, shop_id=a.shop.id, new_price=11)
        assert e.value.detail["code"] == "price_policy"

    def test_the_prices_view_says_why_not(self, a):
        a.db.add(PricePolicy(company_id=a.company.id, tenant_id=a.tenant.id, editors="shop"))
        a.db.flush()
        area_scope.forget(a.db)
        view = PP.prices_view(a.db, a.ahmash, a.cola, [a.shop])
        shop = view["shops"][0]
        assert view["baseEditable"] is False and shop["editable"] is False
        assert all(x["editable"] is False for x in shop["areas"])
        area_scope.forget(a.db)
        view = PP.prices_view(a.db, a.manager, a.cola, [a.shop])
        assert view["shops"][0]["editable"] is True and all(x["editable"] for x in view["shops"][0]["areas"])

    def test_policy_routes_chain_only(self, a):
        from app.routers import area_management as AM

        _forbidden(AM.put_price_policy, str(a.company.id), AM.PricePolicyIn(editors="chain"), **_ctx(a, a.manager))
        out = AM.put_price_policy(str(a.company.id), AM.PricePolicyIn(editors="chain", maxDeltaPct=10), **_ctx(a, a.chain))
        assert out["effective"]["editors"] == "chain" and out["effective"]["maxDeltaPct"] == 10.0
        out = AM.put_price_lock(str(a.cola.id), AM.PriceLockIn(locked=True), **_ctx(a, a.chain))
        assert out["policy"]["own"]["lockedProductIds"] == [str(a.cola.id)]


# ── Till users ───────────────────────────────────────────────────────────────


class TestTillUsers:
    def test_area_ids_reach_the_till(self, a):
        from app.schemas.pos_user import PosUserSyncRow

        pu = PosUser(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.shop.id, username="dana", pin_hash="x",
                     area_ids=[str(a.bar.id)])
        a.db.add(pu)
        a.db.commit()
        row = PosUserSyncRow.model_validate(pu).model_dump(by_alias=True)
        assert row["areaIds"] == [str(a.bar.id)]

    def test_an_area_manager_makes_and_keeps_their_own(self, a):
        from app.routers import pos_users as PR
        from app.schemas.pos_user import PosUserCreate, PosUserUpdate

        out = PR.create_pos_user(str(a.shop.id), PosUserCreate(username="yossi", pin="1234"), **_ctx(a, a.ahmash))
        assert out.area_ids == [str(a.bar.id)]
        _forbidden(PR.update_pos_user, str(a.shop.id), str(out.id), PosUserUpdate(areaIds=[a.kitchen.id]), **_ctx(a, a.ahmash))
        shop_wide = PR.create_pos_user(str(a.shop.id), PosUserCreate(username="avi", pin="1234"), **_ctx(a, a.manager))
        assert shop_wide.area_ids is None
        _forbidden(PR.update_pos_user, str(a.shop.id), str(shop_wide.id), PosUserUpdate(firstName="x"), **_ctx(a, a.ahmash))


# ── The saved scope ──────────────────────────────────────────────────────────


class TestDashboardScope:
    def test_saved_per_organization_and_validated(self, a):
        from app.services import user_preferences as UP

        tid = str(a.tenant.id)
        out = UP.update_preferences(a.db, a.manager, {"dashboardScope": {tid: {"shopId": str(a.shop.id), "areaId": str(a.bar.id)}}})
        assert out["dashboardScope"] == {tid: {"shopId": str(a.shop.id), "areaId": str(a.bar.id)}}
        with pytest.raises(HTTPException):
            UP.update_preferences(a.db, a.manager, {"dashboardScope": {tid: {"areaId": "nope"}}})
        out = UP.update_preferences(a.db, a.manager, {"dashboardScope": {tid: None}})
        assert out["dashboardScope"] == {}

    def test_the_access_summary_names_the_points_of_sale(self, a):
        from app.services import dashboard_access as DA

        out = DA.summary_for(a.db, a.ahmash)
        assert out["areaIds"] == [str(a.bar.id)] and out["areas"] == [{"id": str(a.bar.id), "name": "בר", "shopId": str(a.shop.id)}]
        assert DA.summary_for(a.db, a.manager)["areaIds"] == []


# ── X and Z of a point of sale ───────────────────────────────────────────────


class TestAreaXZ:
    def test_the_x_of_a_point_of_sale(self, a):
        from app.services import shop_x as SX

        a.doc(a.t1, a.shift(a.t1, 1), "10.00")
        a.doc(a.t2, a.shift(a.t2, 1), "20.00")
        a.db.commit()
        settings = SX.shop_settings(a.db, a.shop)
        report = SX.build(a.db, a.shop, settings=settings, area=a.bar, now=NOW)
        assert report["areaName"] == "בר" and report["summary"]["tills"] == 1
        doc = SX.print_document(a.db, report, a.shop, tzinfo=None, now=NOW)
        assert "אזור בר" in doc["subtitle"]

    def test_the_dashboard_x_for_an_area_manager(self, a):
        from app.routers import till_shop_x as TX

        _forbidden(TX.dashboard_shop_x, a.shop.id, refresh=False, area_id=None, detail=area_scope.NEEDS_SHOP, **_ctx(a, a.ahmash))
        out = TX.dashboard_shop_x(a.shop.id, refresh=False, area_id=a.bar.id, **_ctx(a, a.ahmash))
        assert out["report"]["areaId"] == str(a.bar.id)

    def test_the_area_master_closes_its_area(self, a):
        from app.routers import till_shop_z as R
        from app.services import main_till as MT

        assert MT.till_area_z_refusal(a.db, a.t1) is None or MT.till_area_z_refusal(a.db, a.t1) == MT.AREA_NOT_MASTER
        set_param(a, MT.SHOP_Z_MASTER_KEY, "area", a.bar.id, True)
        a.db.commit()
        assert MT.till_area_z_refusal(a.db, a.t1) is None
        a.t2.area_id = None
        a.db.flush()
        assert MT.till_area_z_refusal(a.db, a.t2) == MT.NOT_IN_AREA
        a.doc(a.t1, a.shift(a.t1, 1), "10.00")
        a.db.commit()
        status_ = R.till_shop_z_status(str(a.t1.id), scope="area", machine=a.t1, db=a.db)
        assert status_["scope"] == "area" and status_["areaZ"]["available"] is True
        assert [t["id"] for t in status_["tills"]] == [str(a.t1.id)]
        run = R.till_shop_z_start(str(a.t1.id), R.ShopZStartIn(scope="area", posUserName="דנה"), machine=a.t1, db=a.db)
        assert run["areaId"] == str(a.bar.id)


# ── Migration ────────────────────────────────────────────────────────────────


class TestMigration:
    def test_one_head_on_main_s(self):
        import pathlib

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        here = pathlib.Path(__file__).absolute().parents[1]
        cfg = Config(str(here / "alembic.ini"))
        cfg.set_main_option("script_location", str(here / "alembic"))
        script = ScriptDirectory.from_config(cfg)
        heads = script.get_heads()
        assert len(heads) == 1
        line = {r.revision for r in script.walk_revisions("base", heads[0])}
        assert {"a3d7e1c9b5f2", "b87054615214"} <= line
        assert script.get_revision("a3d7e1c9b5f2").down_revision == "b87054615214"

    def test_add_only_on_postgres(self):
        from test_table_scope import _render

        sql = _render("b87054615214:a3d7e1c9b5f2")
        assert "ALTER TABLE shop_product_overrides ADD COLUMN area_ids JSONB" in sql
        assert "ALTER TABLE pos_users ADD COLUMN area_ids JSONB" in sql
        assert "ALTER TABLE area_product_overrides ADD COLUMN price NUMERIC(10, 2)" in sql
        assert "CREATE TABLE price_policies" in sql and "CREATE TABLE price_changes" in sql
        assert sql.count("UPDATE ") == 1 and "DROP " not in sql
