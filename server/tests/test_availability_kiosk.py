"""
"אם אני חוסם פריט בנקודת מכירה או בסניף, הוא נחסם אוטומטית בקיוסק?" — yes: a kiosk is a till
of its shop (docs/SPEC_KIOSK.md), synced with the same catalog, so every block that reaches a
till reaches it (docs/SPEC_AVAILABILITY.md §1). Each test pins one road and how it could look
fine while the kiosk kept selling:

* a shop lock — dashboard or a till's "sold out" for the whole shop — reaches the kiosk's own
  catalog rows and wakes it;
* a point-of-sale lock reaches a kiosk standing in that point of sale (the machine's own
  `area_id`, set in the dashboard's "נקודת מכירה" dialog like any till's) and only then;
* another till's own lock (scope "machine") does not;
* reopening reaches it on a delta pull;
* a category switched off for the shop / its point of sale is off on the kiosk;
* stock that runs out on another till's sale wakes the kiosk at once (it used to wait for
  the kiosk's next periodic sync);
* the row tells the till which lock decided it (`availabilityLock`), for its own Z offline.

Runs on the availability world (tests/test_product_availability.py).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import Base
from app.middleware.auth import CatalogActor
from app.models.pos_machine import POSMachine
from app.models.product_availability_override import AreaProductOverride
from app.models.shop_area import ShopArea
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovementReason
from app.routers import product_availability as R
from app.routers import sync as sync_router
from app.schemas.product_availability import AvailabilitySet, TillAvailabilitySet
from app.services import areas as areas_service
from app.services import category_availability as C
from app.services import commit_signals
from app.services import product_availability as A
from app.services import stock as stock_service
from app.services import sync as S

from test_product_availability import OLD, SINCE, world  # noqa: F401


@pytest.fixture
def k(world, monkeypatch):  # noqa: F811
    """h_shop gets a kiosk in no point of sale (the demo's), and a point of sale "Bar" for h1."""
    db = world.db
    for name in ("sync_logs", "shop_category_overrides", "stock_levels", "stock_movements"):
        Base.metadata.tables[name].create(db.get_bind())
    monkeypatch.setattr(
        C, "notify_machine_catalog_changed",
        lambda tid, mid, reason: world.notified.append(("machine", str(mid))),
    )
    monkeypatch.setattr(
        C, "notify_machines_for_shop",
        lambda _db, sid, reason: world.notified.append(("shop", str(sid))),
    )
    world.signals = []
    monkeypatch.setattr(commit_signals, "publish", lambda t, m, why: world.signals.append((m, why)))
    kiosk = POSMachine(
        id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, distributor_id=uuid.uuid4(),
        name="קיוסק", machine_code="M-kiosk", pos_number="9", is_active=True, last_sync_at=OLD,
    )
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    lobby = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Lobby")
    db.add_all([kiosk, bar, lobby])
    db.flush()
    world.h1.area_id = bar.id
    db.commit()
    world.kiosk, world.bar, world.lobby = kiosk, bar, lobby
    from app.models.category import Category

    world.drinks = db.query(Category).filter(Category.name == "Drinks").one()
    return world


def _row(w, machine, product=None, since=None):
    product = product or w.P
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


def _sells(w, machine, product=None) -> bool:
    return _row(w, machine, product)["isAvailable"]


def _dash(w, path_fn, target, value, permanent=None):
    return path_fn(
        str(w.P.id), str(target.id), AvailabilitySet(isAvailable=value, isPermanent=permanent),
        current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
    )


def _till(w, machine, scope, active, permanent=None):
    return sync_router.machine_set_product_availability(
        str(machine.id), str(w.P.id), TillAvailabilitySet(scope=scope, active=active, permanent=permanent),
        machine=machine, actor=CatalogActor(pos_user_id=uuid.uuid4()), db=w.db,
    )


def _put_kiosk_in(w, area):
    areas_service.assign_machine_area(w.db, w.kiosk, area.id if area is not None else None)
    w.db.commit()


class TestShopLevel:
    def test_a_dashboard_shop_lock_reaches_the_kiosk_and_wakes_it(self, k):
        assert _sells(k, k.kiosk) is True
        _dash(k, R.set_shop_availability, k.h_shop, False)
        assert _sells(k, k.kiosk) is False
        assert ("shop", str(k.h_shop.id)) in k.notified, "every till of the shop, the kiosk among them"

    def test_another_tills_sold_out_for_the_shop_reaches_the_kiosk(self, k):
        _till(k, k.h2, "shop", False)
        assert _sells(k, k.kiosk) is False
        assert ("shop", str(k.h_shop.id)) in k.notified

    def test_another_tills_own_lock_does_not(self, k):
        _till(k, k.h2, "machine", False)
        assert (_sells(k, k.h2), _sells(k, k.kiosk)) == (False, True)

    def test_reopening_reaches_a_kiosk_that_pulls_deltas(self, k):
        _dash(k, R.set_shop_availability, k.h_shop, False)
        for row in k.db.query(A.ShopProductOverride).all():
            row.updated_at = OLD
        k.P.updated_at = OLD
        k.db.commit()
        _dash(k, R.set_shop_availability, k.h_shop, None)
        row = _row(k, k.kiosk, since=SINCE)
        assert row is not None and row["isAvailable"] is True and row["availabilityLock"] is None


class TestPointOfSale:
    def test_a_point_of_sale_lock_reaches_a_kiosk_standing_in_it(self, k):
        _put_kiosk_in(k, k.lobby)
        k.notified.clear()
        _dash(k, R.set_area_availability, k.lobby, False)
        assert (_sells(k, k.kiosk), _sells(k, k.h1), _sells(k, k.h2)) == (False, True, True)
        assert k.notified == [("machine", str(k.kiosk.id))], "the area's tills: the kiosk"

    def test_not_a_kiosk_in_no_point_of_sale(self, k):
        _dash(k, R.set_area_availability, k.bar, False)
        assert (_sells(k, k.h1), _sells(k, k.kiosk)) == (False, True)

    def test_a_till_in_the_same_point_of_sale_locks_it_for_the_kiosk(self, k):
        _put_kiosk_in(k, k.bar)
        _till(k, k.h1, "area", False)
        assert (_sells(k, k.h1), _sells(k, k.kiosk), _sells(k, k.h2)) == (False, False, True)
        assert ("machine", str(k.kiosk.id)) in k.notified

    def test_moving_the_kiosk_into_a_locked_point_of_sale_locks_it_there(self, k):
        _dash(k, R.set_area_availability, k.bar, False)
        assert _sells(k, k.kiosk) is True
        _put_kiosk_in(k, k.bar)
        assert _sells(k, k.kiosk) is False
        _put_kiosk_in(k, None)
        assert _sells(k, k.kiosk) is True


class TestCategories:
    def test_a_category_off_for_the_shop_is_off_on_the_kiosk(self, k):
        sync_router.machine_set_category_availability(
            str(k.h2.id), str(k.drinks.id), TillAvailabilitySet(scope="shop", active=False),
            machine=k.h2, actor=CatalogActor(pos_user_id=uuid.uuid4()), db=k.db,
        )
        rows = S.get_categories_for_sync(k.db, str(k.tid), str(k.kiosk.id))
        row = next(r for r in rows if r["id"] == str(k.drinks.id))
        assert row["isActive"] is False
        assert row["activeLock"]["level"] == "shop" and row["activeLock"]["permanent"] is False

    def test_a_category_off_for_the_kiosks_point_of_sale_only(self, k):
        _put_kiosk_in(k, k.bar)
        C.set_override(k.db, C.AREA, k.bar.id, k.drinks.id, False)
        k.db.commit()
        rows = {m: S.get_categories_for_sync(k.db, str(k.tid), str(m.id)) for m in (k.kiosk, k.h2)}
        active = {m: next(r for r in rs if r["id"] == str(k.drinks.id))["isActive"] for m, rs in rows.items()}
        assert (active[k.kiosk], active[k.h2]) == (False, True)


class TestTheDecidingLock:
    def test_the_row_names_the_lock_that_decides(self, k):
        _dash(k, R.set_shop_availability, k.h_shop, False, permanent=True)
        lock = _row(k, k.kiosk)["availabilityLock"]
        assert (lock["level"], lock["permanent"], lock["inherited"]) == ("shop", True, True)
        assert lock["blockedAt"] is not None

    def test_a_till_lock_over_a_shop_lock_inherits_the_shop_lock(self, k):
        _dash(k, R.set_shop_availability, k.h_shop, False)
        _till(k, k.kiosk, "machine", False)
        lock = _row(k, k.kiosk)["availabilityLock"]
        assert (lock["level"], lock["inherited"]) == ("machine", False), "opening the till's own lock leaves the shop's"

    def test_company_and_product_locks_are_not_named(self, k):
        k.P.is_available = False
        k.db.commit()
        row = _row(k, k.kiosk)
        assert (row["isAvailable"], row["availabilityLock"]) == (False, None)


class TestStockRunsOut:
    @pytest.fixture
    def stock(self, k, monkeypatch):
        monkeypatch.setattr(stock_service, "pg_insert", sqlite_insert)
        k.P.track_stock = True
        k.db.add(StockLevel(tenant_id=k.tid, shop_id=k.h_shop.id, product_id=k.P.id, quantity=Decimal("1")))
        k.db.commit()
        return k

    def _sell(self, w, qty="-1"):
        stock_service.apply_movement(
            w.db, movement_id=uuid.uuid4(), tenant_id=w.tid, shop_id=w.h_shop.id, product_id=w.P.id,
            delta=Decimal(qty), reason=StockMovementReason.SALE,
            occurred_at=datetime.now(timezone.utc), machine_id=w.h1.id,
        )

    def test_the_last_unit_sold_on_a_till_wakes_the_kiosk_after_the_commit(self, stock):
        self._sell(stock)
        assert stock.signals == [], "nothing before the commit"
        stock.db.commit()
        woken = {m for m, _why in stock.signals}
        assert str(stock.kiosk.id) in woken and str(stock.h2.id) in woken
        assert str(stock.a1.id) not in woken, "another shop's tills"

    def test_a_sale_that_leaves_stock_wakes_nobody(self, stock):
        self._sell(stock, "1")  # a return: 1 → 2
        stock.db.commit()
        assert stock.signals == []

    def test_a_rolled_back_sale_wakes_nobody(self, stock):
        self._sell(stock)
        stock.db.rollback()
        stock.db.commit()
        assert stock.signals == []

    def test_an_item_that_does_not_track_stock_wakes_nobody(self, stock):
        stock.P.track_stock = False
        stock.db.commit()
        self._sell(stock)
        stock.db.commit()
        assert stock.signals == []
