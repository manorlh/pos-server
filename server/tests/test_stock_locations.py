"""
Stock over the hierarchy — locations, "אופן ניהול מלאי", the quick stock screen, transfers,
area-scoped managers, low-stock alerts, the switch wizard and the daily reset
(app/services/stock_locations.py, stock.py, stock_admin.py, stock_alerts.py, stock_reset.py,
stock_scope.py; app/routers/stock_live.py).

Each test names a way stock could look right and still be wrong on the floor: a sale taken from
the wrong location, a total that double-counts or misses a level, an automatic "אזל" stopping
devices that still have stock, a transfer that creates or loses units, a point-of-sale manager
touching another area or the shop's store, a switch that moves quantities silently, a reset that
runs twice, at the wrong hour, or eats a late sale into today's stock.

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import Base
from app.models.dashboard_access import DashboardAccessProfile
from app.models.shop_area import ShopArea
from app.models.sold_out import SoldOutMark
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovement, StockMovementReason
from app.models.stock_setting import StockAlert, StockLevelSetting, StockReset, StockResetItem
from app.routers import stock_live as R
from app.services import commit_signals
from app.services import sold_out
from app.services import stock as stock_service
from app.services import stock_admin
from app.services import stock_locations as L
from app.services import stock_reset
from app.services.stock_locations import Location, Path

from test_product_availability import world  # noqa: F401

D = Decimal


# ── The rule, pure ───────────────────────────────────────────────────────────

C, S, A, M = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
IN_AREA = Path(company_id=C, shop_id=S, area_id=A, machine_id=M, node_level="machine")
NO_AREA = Path(company_id=C, shop_id=S, machine_id=M, node_level="machine")


@pytest.mark.parametrize(
    "levels, path, expected",
    [
        (("shop",), IN_AREA, Location("shop", S)),
        (("shop", "area"), IN_AREA, Location("area", A)),
        (("shop", "area"), NO_AREA, Location("shop", S)),
        (("area",), IN_AREA, Location("area", A)),
        (("area",), NO_AREA, Location("shop", S)),  # under no managed location: its shop
        (("company", "shop", "machine"), IN_AREA, Location("machine", M)),
        (("machine",), NO_AREA, Location("machine", M)),
        (("company",), IN_AREA, Location("company", C)),
        (("company", "area"), NO_AREA, Location("company", C)),
    ],
)
def test_a_sale_takes_from_the_lowest_managed_location_containing_the_device(levels, path, expected):
    assert L.sell_from(path, levels) == expected


def test_an_update_at_a_node_without_stock_goes_to_the_nearest_managed_above():
    assert L.update_location(IN_AREA, ("shop", "area")) == Location("area", A)
    assert L.update_location(NO_AREA, ("shop",)) == Location("shop", S)
    with pytest.raises(L.NotManaged):
        L.update_location(Path(company_id=C, shop_id=S, node_level="shop"), ("area", "machine"))


def test_the_most_specific_rule_wins():
    P, K = uuid.uuid4(), uuid.uuid4()
    rules = [
        L.Rule("company", str(C), None, None, ("company", "shop")),
        L.Rule("shop", str(S), None, None, ("shop",)),
        L.Rule("company", str(C), "category", str(K), ("shop", "area")),
        L.Rule("shop", str(S), "product", str(P), ("machine",)),
    ]
    def m(**kw):
        return L.resolve_managed(rules, company_id=str(C), shop_id=str(S), **kw)
    assert m(product_id=str(P), category_id=str(K)) == ("machine",)
    assert m(product_id=str(uuid.uuid4()), category_id=str(K)) == ("shop", "area")
    assert m(product_id=str(uuid.uuid4()), category_id=None) == ("shop",)
    assert L.resolve_managed([], company_id=str(C), shop_id=str(S), product_id=None, category_id=None) == ("shop",)


def test_levels_are_normalised_top_down_and_unknown_ones_refused():
    assert L.normalize_levels(["area", "shop", "area"]) == ("shop", "area")
    with pytest.raises(ValueError):
        L.normalize_levels(["warehouse"])
    with pytest.raises(ValueError):
        L.normalize_levels([])


# ── On a real session ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _locations_on(monkeypatch):
    """This module tests stock locations themselves: the flag on (TestFlagOff turns it off)."""
    monkeypatch.setenv("STOCK_LOCATIONS_ENABLED", "true")


@pytest.fixture
def s(world, monkeypatch):  # noqa: F811
    """h_shop: points of sale Bar (h1) and Lobby (h2); P tracks stock."""
    db = world.db
    for name in (
        "sync_logs", "stock_levels", "stock_movements", "sold_out_marks", "kiosk_devices", "report_events",
        "report_event_machines", "stock_level_settings", "stock_alerts", "stock_resets", "stock_reset_items",
        "dashboard_access_profiles", "shop_category_overrides",
    ):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    world.signals = []
    monkeypatch.setattr(commit_signals, "publish", lambda t, m, why: world.signals.append((m, why)))
    monkeypatch.setattr(stock_service, "pg_insert", sqlite_insert)
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    lobby = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Lobby")
    db.add_all([bar, lobby])
    db.flush()
    world.h1.area_id, world.h2.area_id = bar.id, lobby.id
    world.P.track_stock = True
    db.commit()
    world.bar, world.lobby = bar, lobby
    world.shop_loc = Location("shop", world.h_shop.id)
    world.bar_loc, world.lobby_loc = Location("area", bar.id), Location("area", lobby.id)
    return world


def _levels(w, levels, *, scope="shop", item=None):
    scope_id = w.h_shop.id if scope == "shop" else w.H.id
    kind, item_id = (item or (None, None))
    w.db.add(StockLevelSetting(
        id=uuid.uuid4(), tenant_id=w.tid, scope_level=scope, scope_id=scope_id, item_kind=kind, item_id=item_id,
        rule_key=L.rule_key(scope, scope_id, kind, item_id), levels=list(levels),
    ))
    w.db.commit()


def _qty(w, loc):
    return stock_service.quantity_at(w.db, loc, w.P.id)


def _set(w, loc, qty):
    stock_service.set_quantity(w.db, tenant_id=w.tid, shop_id=None, product_id=w.P.id, target_quantity=D(qty), location=loc)
    w.db.commit()


def _sell(w, machine, qty="1", when=None):
    loc = stock_service.sale_location(w.db, machine, w.P.id)
    stock_service.apply_movement(
        w.db, movement_id=uuid.uuid4(), tenant_id=w.tid, shop_id=machine.shop_id, product_id=w.P.id,
        delta=-D(qty), reason=StockMovementReason.SALE, occurred_at=when or datetime.now(timezone.utc),
        machine_id=machine.id, location=loc,
    )
    w.db.commit()
    return loc


class TestFlagOff:
    """`STOCK_LOCATIONS_ENABLED` off (the default until Saturday): shop stock exactly as before."""

    @pytest.fixture(autouse=True)
    def _off(self, monkeypatch):
        monkeypatch.setenv("STOCK_LOCATIONS_ENABLED", "false")

    def test_a_saved_area_rule_is_ignored_sales_and_tills_are_the_shops(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 5)
        assert _sell(s, s.h1) == s.shop_loc
        assert _qty(s, s.shop_loc) == 4
        mine = {l.product_id: l for l in stock_service.levels_for_machine(s.db, s.h1)}
        assert mine[s.P.id].quantity == 4 and mine[s.P.id].reset_at is None
        assert s.db.query(StockAlert).count() == 0, "no low-stock alerts while off"

    def test_its_screens_say_off(self, s):
        user = s.users.admin
        for call in (
            lambda: R.post_transfer(R.TransferIn(productId=s.P.id, **{"from": {"level": "shop", "targetId": s.h_shop.id}, "to": {"level": "area", "targetId": s.bar.id}}, quantity=1), current_user=user, active_tenant_id=s.tid, db=s.db),
            lambda: R.post_reset(R.NodeIn(level="shop", targetId=s.h_shop.id), current_user=user, active_tenant_id=s.tid, db=s.db),
            lambda: R.get_leftover(None, s.h_shop.id, None, current_user=user, active_tenant_id=s.tid, db=s.db),
            lambda: R.get_quick("area", s.bar.id, None, None, None, current_user=user, active_tenant_id=s.tid, db=s.db),
        ):
            with pytest.raises(HTTPException) as off:
                call()
            assert off.value.status_code == 404 and off.value.detail["code"] == "stock_locations_off"
        assert R.get_alerts(None, s.h_shop.id, current_user=user, active_tenant_id=s.tid, db=s.db) == []
        tree = R.get_tree("shop", s.h_shop.id, current_user=user, active_tenant_id=s.tid, db=s.db)
        assert tree["locationsEnabled"] is False and tree["shops"][0]["areas"] == [] and tree["shops"][0]["machines"] == []
        assert R.get_features(current_user=user) == {"locations": False}

    def test_a_points_of_sale_manager_keeps_their_shops_stock(self, s):
        s.db.add(DashboardAccessProfile(user_id=s.users.h_shop_manager.id, full_access=True, sections={}, area_ids=[str(s.bar.id)]))
        s.db.commit()
        R._path(s.db, s.users.h_shop_manager, s.tid, "shop", s.h_shop.id)  # not narrowed while off


class TestRefunds:
    def test_a_refund_at_another_till_goes_back_where_the_sale_took_it(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.bar_loc, 5)
        sale_tx = uuid.uuid4()
        stock_service.apply_movement(
            s.db, movement_id=uuid.uuid4(), tenant_id=s.tid, shop_id=s.h_shop.id, product_id=s.P.id, delta=-D(1),
            reason=StockMovementReason.SALE, occurred_at=datetime.now(timezone.utc), machine_id=s.h1.id,
            transaction_id=sale_tx, location=stock_service.sale_location(s.db, s.h1, s.P.id),
        )
        s.db.commit()
        # Refunded at the lobby's till (h2): back to the bar, not the lobby.
        assert stock_service.refund_location(s.db, sale_tx, s.P.id) == s.bar_loc
        assert stock_service.sale_location(s.db, s.h2, s.P.id) == s.lobby_loc
        # The bar no longer managed: the refunding till's own location then.
        s.db.query(StockLevelSetting).delete()
        s.db.commit()
        _levels(s, ["shop"])
        assert stock_service.refund_location(s.db, sale_tx, s.P.id) is None


class TestAtomicWrites:
    """The review's scenario: two documents moving the same product, and two tills' first sale."""

    @staticmethod
    def _behind_the_session(s, qty):
        """Another till's write committed meanwhile, outside this session's identity map."""
        from sqlalchemy import update

        s.db.execute(
            update(StockLevel).where(StockLevel.product_id == s.P.id).values(quantity=D(qty)),
            execution_options={"synchronize_session": False},
        )

    def test_a_write_from_another_session_is_never_lost(self, s):
        _set(s, s.shop_loc, 5)
        assert stock_service.level_at(s.db, s.shop_loc, s.P.id).quantity == 5  # this session's copy: 5
        self._behind_the_session(s, 10)
        _sell(s, s.h1)
        assert _qty(s, s.shop_loc) == 9, "added in the database (10 − 1), never on a stale copy (5 − 1)"

    def test_the_first_sale_at_a_fresh_location_twice_makes_one_row(self, s):
        _sell(s, s.h1)
        _sell(s, s.h2)
        rows = s.db.query(StockLevel).filter(StockLevel.product_id == s.P.id, StockLevel.level == "shop").all()
        assert len(rows) == 1 and rows[0].quantity == -2

    def test_a_count_is_exact_on_the_fresh_row(self, s):
        _set(s, s.shop_loc, 5)
        assert stock_service.level_at(s.db, s.shop_loc, s.P.id).quantity == 5
        self._behind_the_session(s, 7)
        stock_service.set_quantity(s.db, tenant_id=s.tid, shop_id=s.h_shop.id, product_id=s.P.id, target_quantity=D(3))
        s.db.commit()
        assert _qty(s, s.shop_loc) == 3
        last = s.db.query(StockMovement).order_by(StockMovement.created_at.desc()).first()
        assert last.delta == -4, "the difference from what is really there (7), not from a stale 5"


class TestSales:
    def test_shop_only_is_todays_behaviour(self, s):
        _set(s, s.shop_loc, 5)
        assert _sell(s, s.h1) == s.shop_loc
        assert _qty(s, s.shop_loc) == 4

    def test_shop_and_area_sale_takes_from_the_area(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.bar_loc, 3)
        assert _sell(s, s.h1) == s.bar_loc
        assert (_qty(s, s.bar_loc), _qty(s, s.shop_loc)) == (2, 0)

    def test_device_level_under_company_and_shop(self, s):
        _levels(s, ["company", "shop", "machine"], scope="company")
        assert _sell(s, s.h2) == Location("machine", s.h2.id)

    def test_a_category_or_product_override_beats_the_shop(self, s):
        _levels(s, ["shop"])
        _levels(s, ["area"], item=("product", s.P.id))
        assert _sell(s, s.h1) == s.bar_loc

    def test_the_till_pulls_the_level_it_sells_from(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 50)
        _set(s, s.bar_loc, 7)
        mine = {l.product_id: l for l in stock_service.levels_for_machine(s.db, s.h1)}
        assert mine[s.P.id].quantity == 7 and mine[s.P.id].location == s.bar_loc
        other = {l.product_id: l for l in stock_service.levels_for_machine(s.db, s.h2)}
        assert other[s.P.id].quantity == 0 and other[s.P.id].location == s.lobby_loc


class TestTotalsAndTransfers:
    def test_the_shop_total_is_its_store_plus_every_area(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 10)
        _set(s, s.bar_loc, 3)
        _set(s, s.lobby_loc, 2)
        view = stock_admin.quick_view(s.db, s.users.admin, s.tid, L.path_of(s.db, "shop", s.h_shop.id))
        row = next(r for r in view["rows"] if r["productId"] == str(s.P.id))
        assert row["total"] == 15
        assert {(l["level"], l["quantity"]) for l in row["locations"] if l["managed"]} >= {("shop", 10), ("area", 3), ("area", 2)}

    def test_an_area_view_counts_the_area_only(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 10)
        _set(s, s.bar_loc, 3)
        view = stock_admin.quick_view(s.db, s.users.admin, s.tid, L.path_of(s.db, "area", s.bar.id))
        row = next(r for r in view["rows"] if r["productId"] == str(s.P.id))
        assert row["total"] == 3 and row["updateTarget"]["level"] == "area"

    def test_the_update_sheet_asks_for_one_product(self, s):
        view = stock_admin.quick_view(s.db, s.users.admin, s.tid, L.path_of(s.db, "shop", s.h_shop.id), product_id=s.P.id)
        assert [r["productId"] for r in view["rows"]] == [str(s.P.id)]

    def test_a_transfer_moves_units_and_never_makes_any(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 10)
        out = stock_admin.transfer(s.db, s.users.admin, s.tid, product_id=s.P.id, source=s.shop_loc, target=s.bar_loc, quantity=D(4))
        s.db.commit()
        assert (out["from"]["quantity"], out["to"]["quantity"]) == (6, 4)
        stock_admin.transfer(s.db, s.users.admin, s.tid, product_id=s.P.id, source=s.bar_loc, target=s.lobby_loc, quantity=D(1))
        s.db.commit()
        assert _qty(s, s.shop_loc) + _qty(s, s.bar_loc) + _qty(s, s.lobby_loc) == 10
        legs = s.db.query(StockMovement).filter(StockMovement.reason == StockMovementReason.TRANSFER).all()
        assert len(legs) == 4 and len({m.transfer_id for m in legs}) == 2

    def test_a_transfer_into_an_unmanaged_level_is_refused(self, s):
        _set(s, s.shop_loc, 10)  # shop only
        with pytest.raises(HTTPException) as refused:
            stock_admin.transfer(s.db, s.users.admin, s.tid, product_id=s.P.id, source=s.shop_loc, target=s.bar_loc, quantity=D(1))
        assert refused.value.detail["code"] == "not_managed_here"

    def test_an_update_at_a_till_goes_to_its_managed_location_and_says_so(self, s):
        _levels(s, ["shop", "area"])
        out = stock_admin.update(s.db, s.users.admin, s.tid, L.path_of(s.db, "machine", s.h1.id), product_id=s.P.id, op="receive", quantity=D(6))
        s.db.commit()
        assert out["location"]["level"] == "area" and out["redirected"] is True and _qty(s, s.bar_loc) == 6


class TestAutomaticSoldOut:
    def test_an_area_at_zero_stops_its_devices_only(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.bar_loc, 1)
        _set(s, s.lobby_loc, 4)
        _sell(s, s.h1)
        auto = s.db.query(SoldOutMark).filter(SoldOutMark.source == "auto", SoldOutMark.cleared_at.is_(None)).all()
        assert [(m.scope, str(m.scope_id)) for m in auto] == [("area", str(s.bar.id))]
        assert sold_out.blocks_for_machine(s.db, s.h1, [s.P.id]).get(str(s.P.id)).active
        assert not sold_out.blocks_for_machine(s.db, s.h2, [s.P.id])

    def test_a_shop_block_reaches_only_devices_selling_from_the_shop(self, s):
        _levels(s, ["shop", "area"])
        s.h2.area_id = None
        s.db.commit()
        _set(s, s.shop_loc, 1)
        _set(s, s.bar_loc, 5)
        _sell(s, s.h2)  # no area: sells from the shop
        assert sold_out.blocks_for_machine(s.db, s.h2, [s.P.id]).get(str(s.P.id)).active
        assert not sold_out.blocks_for_machine(s.db, s.h1, [s.P.id]), "the bar still has stock"


class TestPermissions:
    def _bar_manager(self, s):
        user = s.users.h_shop_manager
        s.db.add(DashboardAccessProfile(user_id=user.id, full_access=True, sections={}, area_ids=[str(s.bar.id)]))
        s.db.commit()
        return user

    def test_a_point_of_sale_manager_updates_their_area_only(self, s):
        _levels(s, ["shop", "area"])
        user = self._bar_manager(s)
        stock_admin.update(s.db, user, s.tid, L.path_of(s.db, "area", s.bar.id), product_id=s.P.id, op="count", quantity=D(5))
        s.db.commit()
        for level, target in (("area", s.lobby.id), ("shop", s.h_shop.id)):
            with pytest.raises(HTTPException) as refused:
                R._path(s.db, user, s.tid, level, target)
            assert refused.value.status_code == 403

    def test_they_may_move_stock_into_their_area_from_the_store(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 10)
        user = self._bar_manager(s)
        stock_admin.transfer(s.db, user, s.tid, product_id=s.P.id, source=s.shop_loc, target=s.bar_loc, quantity=D(3))
        with pytest.raises(HTTPException):
            stock_admin.transfer(s.db, user, s.tid, product_id=s.P.id, source=s.shop_loc, target=s.lobby_loc, quantity=D(1))
        # Nor out of another point of sale into theirs.
        _set(s, s.lobby_loc, 4)
        with pytest.raises(HTTPException) as refused:
            stock_admin.transfer(s.db, user, s.tid, product_id=s.P.id, source=s.lobby_loc, target=s.bar_loc, quantity=D(1))
        assert refused.value.status_code == 403

    def test_their_devices_blocks_and_kiosk_hides_are_their_points_of_sale_only(self, s):
        from app.routers import device_commands as DC
        from app.routers import item_blocks as IB
        from app.routers import kiosk_live as KL

        for name in ("device_commands", "device_remote_states"):
            if not s.db.get_bind().dialect.has_table(s.db.connection(), name):
                Base.metadata.tables[name].create(s.db.get_bind())
        user = self._bar_manager(s)
        # Remote control: the bar's till only; naming the lobby's is refused.
        assert [m.id for m in DC._devices(s.db, user, s.tid, shop_id=s.h_shop.id)] == [s.h1.id]
        with pytest.raises(HTTPException) as refused:
            DC._devices(s.db, user, s.tid, machine_ids=[s.h2.id])
        assert refused.value.status_code == 403
        # The block list: the bar's, not the shop's or the lobby's.
        for scope, target in (("shop", s.h_shop.id), ("area", s.lobby.id), ("area", s.bar.id)):
            sold_out.block(s.db, tenant_id=s.tid, product=s.P, target=sold_out.resolve_target(s.db, scope, target, s.tid))
        s.db.commit()
        rows = IB.list_blocks(None, s.h_shop.id, None, False, current_user=user, active_tenant_id=s.tid, db=s.db)
        assert [(r["scope"], r["scopeId"]) for r in rows] == [("area", str(s.bar.id))]
        # A quick kiosk hide is shop-wide: not theirs.
        with pytest.raises(HTTPException) as refused:
            KL._shop_checked(s.db, user, s.h_shop.id, s.tid)
        assert refused.value.status_code == 403

    def test_an_unknown_scope_or_target_is_a_404_never_a_500(self, s):
        from app.routers import item_blocks as IB

        with pytest.raises(HTTPException) as missing:
            R._check_setting_scope(s.db, s.users.admin, s.tid, "shop", uuid.uuid4())
        assert missing.value.status_code == 404
        user = self._bar_manager(s)
        gone = sold_out.Target("area", uuid.uuid4(), "", s.H.id, s.h_shop.id)
        with pytest.raises(HTTPException) as missing:
            IB._check_target(s.db, user, gone, s.tid)
        assert missing.value.status_code == 404

    def test_their_resets_and_leftovers_are_their_points_of_sale_only(self, s):
        user = self._bar_manager(s)
        rows = [{"location": {"level": "area", "targetId": str(t)}} for t in (s.bar.id, s.lobby.id)]
        rows.append({"location": {"level": "shop", "targetId": str(s.h_shop.id)}})
        assert [r["location"]["targetId"] for r in R._covered_rows(s.db, user, rows)] == [str(s.bar.id)]
        assert R._shops_and_companies(s.db, user, s.tid)[1] == set(), "never the company's store"

    def test_they_never_block_a_whole_shop_or_the_company(self, s):
        from app.routers import item_blocks as IB
        from app.services import sold_out

        user = self._bar_manager(s)
        for scope, scope_id in (("company", s.H.id), ("shop", s.h_shop.id)):
            with pytest.raises(HTTPException) as refused:
                IB._check_target(s.db, user, sold_out.Target(scope, scope_id, "", s.H.id, s.h_shop.id if scope == "shop" else None), s.tid)
            assert refused.value.status_code == 403
        IB._check_target(s.db, user, sold_out.Target("area", s.bar.id, "", s.H.id, s.h_shop.id, s.bar.id), s.tid)

    def test_an_opening_for_another_tenants_product_is_refused(self, s):
        with pytest.raises(HTTPException) as refused:
            stock_admin.set_opening(s.db, s.users.admin, s.tid, s.shop_loc, [{"productId": str(uuid.uuid4()), "openingQuantity": 3}])
        assert refused.value.status_code == 404
        with pytest.raises(HTTPException):
            stock_admin.set_opening(s.db, s.users.admin, s.tid, s.shop_loc, [{"productId": str(s.P.id), "openingQuantity": -2}])

    def test_their_quick_view_shows_their_locations_only(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.lobby_loc, 9)
        user = self._bar_manager(s)
        view = stock_admin.quick_view(s.db, user, s.tid, L.path_of(s.db, "area", s.bar.id))
        row = next(r for r in view["rows"] if r["productId"] == str(s.P.id))
        assert {l["targetId"] for l in row["locations"]} <= {str(s.bar.id), str(s.h1.id)}

    def test_the_profile_says_which_points_of_sale(self, s):
        from app.services import dashboard_access as DA

        self._bar_manager(s)
        out = DA.profile_out(s.db.get(DashboardAccessProfile, s.users.h_shop_manager.id))
        assert out["areaIds"] == [str(s.bar.id)] and out["machineIds"] == []

    def test_another_shops_manager_sees_nothing_here(self, s):
        with pytest.raises(HTTPException):
            R._path(s.db, s.users.a_shop_manager, s.tid, "shop", s.h_shop.id)


class TestSwitchWizard:
    def test_from_shop_only_to_shop_and_area_needs_openings(self, s):
        _set(s, s.shop_loc, 10)
        preview = stock_admin.preview_switch(s.db, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["shop", "area"])
        assert {n["location"]["targetId"] for n in preview["newlyManaged"]} >= {str(s.bar.id), str(s.lobby.id)}
        with pytest.raises(HTTPException) as refused:
            stock_admin.apply_switch(s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["shop", "area"])
        assert refused.value.status_code == 409 and refused.value.detail["code"] == "openings_required"
        s.db.rollback()
        out = stock_admin.apply_switch(
            s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None,
            levels=["shop", "area"], openings=[{"productId": str(s.P.id), "level": "area", "targetId": str(s.bar.id), "quantity": 4}],
            openings_confirmed=True,
        )
        s.db.commit()
        assert out["levels"] == ["shop", "area"] and _qty(s, s.bar_loc) == 4 and _qty(s, s.shop_loc) == 10

    def test_to_area_only_never_moves_the_store_silently(self, s):
        _set(s, s.shop_loc, 10)
        with pytest.raises(HTTPException) as refused:
            stock_admin.apply_switch(s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["area"], openings_confirmed=True)
        assert refused.value.detail["code"] == "stock_left_outside"
        s.db.rollback()
        assert _qty(s, s.shop_loc) == 10
        stock_admin.apply_switch(
            s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["area"],
            transfers=[{"productId": str(s.P.id), "from": {"level": "shop", "targetId": str(s.h_shop.id)}, "to": {"level": "area", "targetId": str(s.bar.id)}, "quantity": 10}],
            openings_confirmed=True,
        )
        s.db.commit()
        assert (_qty(s, s.shop_loc), _qty(s, s.bar_loc)) == (0, 10)

    def test_only_the_plans_own_rows_are_accepted(self, s):
        _set(s, s.shop_loc, 10)
        a_shop = {"level": "shop", "targetId": str(s.a_shop.id)}
        h_shop = {"level": "shop", "targetId": str(s.h_shop.id)}
        bar = {"level": "area", "targetId": str(s.bar.id)}
        p = str(s.P.id)
        cases = [
            # An opening in another shop (outside the scope switched).
            ({"openings": [{"productId": p, **a_shop, "quantity": 5}]}, "opening_outside_the_switch"),
            # A negative opening.
            ({"openings": [{"productId": p, **bar, "quantity": -3}]}, "invalid_quantity"),
            # A transfer into another shop, and more than the store holds.
            ({"transfers": [{"productId": p, "from": h_shop, "to": a_shop, "quantity": 1}]}, "transfer_outside_the_switch"),
            ({"transfers": [{"productId": p, "from": h_shop, "to": bar, "quantity": 11}]}, "transfer_more_than_there_is"),
            # A row with no location.
            ({"openings": [{"productId": p, "quantity": 1}]}, "invalid_location"),
        ]
        for extra, code in cases:
            with pytest.raises(HTTPException) as refused:
                stock_admin.apply_switch(
                    s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None,
                    levels=["area"], openings_confirmed=True, write_off=True, **extra,
                )
            assert refused.value.detail["code"] == code, code
            s.db.rollback()
        assert _qty(s, s.shop_loc) == 10

    def test_a_more_specific_rule_that_still_wins_is_not_stranded(self, s):
        # P has its own rule (shop only); switching the shop's general rule to areas leaves P alone.
        _levels(s, ["shop"], item=("product", s.P.id))
        _set(s, s.shop_loc, 7)
        preview = stock_admin.preview_switch(s.db, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["area"])
        assert all(e["productId"] != str(s.P.id) for e in preview["stranded"] + preview["newlyManaged"])
        stock_admin.apply_switch(s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["area"], write_off=True, openings_confirmed=True)
        s.db.commit()
        assert _qty(s, s.shop_loc) == 7, "never written off while it is still where P is held"

    def test_a_write_off_is_explicit_and_recorded(self, s):
        _set(s, s.shop_loc, 3)
        stock_admin.apply_switch(s.db, s.users.admin, s.tid, scope_level="shop", scope_id=s.h_shop.id, item_kind=None, item_id=None, levels=["area"], write_off=True, openings_confirmed=True)
        s.db.commit()
        assert _qty(s, s.shop_loc) == 0
        assert s.db.query(StockMovement).filter(StockMovement.note.like("מחיקה מאושרת%")).count() == 1


class TestAlerts:
    def test_low_in_an_area_suggests_a_transfer_from_the_store(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 20)
        row = StockLevel(tenant_id=s.tid, shop_id=s.h_shop.id, level="area", target_id=s.bar.id, product_id=s.P.id, quantity=D(5), reorder_min=3, reorder_opt=8)
        s.db.add(row)
        s.db.commit()
        _sell(s, s.h1, "2")
        alert = s.db.query(StockAlert).filter(StockAlert.cleared_at.is_(None)).one()
        assert (alert.kind, alert.suggest_level, alert.suggest_quantity) == ("low", "shop", D(5))
        stock_admin.transfer(s.db, s.users.admin, s.tid, product_id=s.P.id, source=s.shop_loc, target=s.bar_loc, quantity=D(5))
        s.db.commit()
        assert s.db.query(StockAlert).filter(StockAlert.cleared_at.is_(None)).count() == 0


class TestReorderMinimum:
    def test_a_minimum_set_on_the_opening_screen_raises_and_clears_the_alert_at_once(self, s):
        _set(s, s.shop_loc, 5)
        item = {"productId": str(s.P.id)}
        stock_admin.set_opening(s.db, s.users.admin, s.tid, s.shop_loc, [{**item, "reorderMin": 8}])
        s.db.commit()
        alert = s.db.query(StockAlert).filter(StockAlert.cleared_at.is_(None)).one()
        assert (alert.kind, alert.threshold) == ("low", D(8))
        view = stock_admin.quick_view(s.db, s.users.admin, s.tid, L.path_of(s.db, "shop", s.h_shop.id), product_id=s.P.id)
        assert view["rows"][0]["low"] and view["rows"][0]["locations"][0]["reorderMin"] == 8
        stock_admin.set_opening(s.db, s.users.admin, s.tid, s.shop_loc, [{**item, "reorderMin": None}])
        s.db.commit()
        assert s.db.query(StockAlert).filter(StockAlert.cleared_at.is_(None)).count() == 0

    @pytest.mark.parametrize("bad", [-1, 2.5, "x"])
    def test_a_minimum_is_a_whole_number(self, s, bad):
        with pytest.raises(HTTPException) as refused:
            stock_admin.set_opening(s.db, s.users.admin, s.tid, s.shop_loc, [{"productId": str(s.P.id), "reorderMin": bad}])
        assert refused.value.detail["code"] == "invalid_reorder_min"


class TestDailyReset:
    def _opening(self, s, loc, opening, mode="set"):
        stock_admin.set_opening(s.db, s.users.admin, s.tid, loc, [{"productId": str(s.P.id), "openingQuantity": opening, "dailyReset": True, "resetMode": mode}])
        s.db.commit()

    def test_switching_it_on_starts_tomorrow(self, s):
        _set(s, s.shop_loc, 3)
        self._opening(s, s.shop_loc, 20)
        assert stock_reset.run_due(s.db) == 0, "today counts as done"
        assert _qty(s, s.shop_loc) == 3

    def test_set_mode_and_the_leftover_report(self, s):
        _set(s, s.shop_loc, 3)
        self._opening(s, s.shop_loc, 20)
        reset = stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        assert _qty(s, s.shop_loc) == 20 and reset.items == 1
        left = stock_reset.leftover(s.db, shop_ids=[s.h_shop.id])
        assert (left[0]["leftover"], left[0]["opening"]) == (3, 20)

    def test_top_up_from_the_store_and_the_shortfall(self, s):
        _levels(s, ["shop", "area"])
        _set(s, s.shop_loc, 4)
        _set(s, s.bar_loc, 1)
        self._opening(s, s.bar_loc, 10, mode="top_up")
        stock_reset.run(s.db, s.bar_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        assert (_qty(s, s.bar_loc), _qty(s, s.shop_loc)) == (5, 0)
        item = s.db.query(StockResetItem).one()
        assert (item.delta, item.shortfall, item.from_level) == (D(4), D(5), "shop")

    def test_the_scheduled_run_happens_once_per_business_day(self, s):
        _set(s, s.shop_loc, 3)
        self._opening(s, s.shop_loc, 20)
        s.db.query(StockReset).delete()
        s.db.commit()
        assert stock_reset.run_due(s.db) == 1
        assert stock_reset.run_due(s.db) == 0
        assert stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="schedule") is None

    def test_the_business_day_starts_at_four_in_jerusalem_dst_included(self, s):
        clock = stock_reset.clock_for(s.db, s.shop_loc)
        assert clock.day_start == "04:00", "the one business day of blocks, the reset and targets"
        # 03:00 local on 10.10 belongs to the 9th's business day.
        day, start = stock_reset.business_day(datetime(2026, 10, 10, 0, 0, tzinfo=timezone.utc), clock)
        assert (day, start) == (date(2026, 10, 9), datetime(2026, 10, 9, 1, 0, tzinfo=timezone.utc))
        # Summer time ends 25.10 at 02:00: 04:00 that morning is 02:00 UTC.
        day, start = stock_reset.business_day(datetime(2026, 10, 25, 4, 0, tzinfo=timezone.utc), clock)
        assert (day, start) == (date(2026, 10, 25), datetime(2026, 10, 25, 2, 0, tzinfo=timezone.utc))

    def test_a_late_sale_of_yesterday_is_absorbed_and_lowers_the_leftover(self, s):
        _set(s, s.shop_loc, 3)
        self._opening(s, s.shop_loc, 20)
        stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        _sell(s, s.h1, "2", when=datetime.now(timezone.utc) - timedelta(hours=1))
        assert _qty(s, s.shop_loc) == 20, "today's opening stock untouched"
        assert stock_reset.leftover(s.db, shop_ids=[s.h_shop.id])[0]["leftover"] == 1
        _sell(s, s.h1, "1")
        assert _qty(s, s.shop_loc) == 19, "a sale after the reset applies after it"

    def test_the_reset_clears_the_automatic_sold_out(self, s):
        _set(s, s.shop_loc, 1)
        _sell(s, s.h1)
        assert s.db.query(SoldOutMark).filter(SoldOutMark.source == "auto", SoldOutMark.cleared_at.is_(None)).count() == 1
        self._opening(s, s.shop_loc, 12)
        stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        assert s.db.query(SoldOutMark).filter(SoldOutMark.source == "auto", SoldOutMark.cleared_at.is_(None)).count() == 0

    def test_a_manual_reset_ends_end_of_day_sold_out_of_what_it_reset_only(self, s):
        target = sold_out.resolve_target(s.db, "shop", s.h_shop.id, s.tid)
        end = datetime.now(timezone.utc) + timedelta(hours=5)
        day = sold_out.block(s.db, tenant_id=s.tid, product=s.P, target=target, until=end, until_mode="end_of_day")
        reason = sold_out.block(s.db, tenant_id=s.tid, product=s.P, target=target, kind="blocked", until=end, until_mode="end_of_day")
        not_reset = sold_out.block(s.db, tenant_id=s.tid, product=s.Q, target=target, until=end, until_mode="end_of_day")
        s.db.commit()
        self._opening(s, s.shop_loc, 5)
        stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        assert day.cleared_at is not None, "P's day is over: its 'אזל' ends"
        assert reason.cleared_at is None, "a 'חסום' has a reason, not a count"
        assert not_reset.cleared_at is None, "Q was not reset"

    def test_the_till_counts_only_unsynced_sales_after_the_reset(self, s):
        self._opening(s, s.shop_loc, 8)
        stock_reset.run(s.db, s.shop_loc, tenant_id=s.tid, trigger="manual", user=s.users.admin)
        s.db.commit()
        mine = {l.product_id: l for l in stock_service.levels_for_machine(s.db, s.h1)}
        assert mine[s.P.id].reset_at is not None and mine[s.P.id].quantity == 8


def test_the_stock_migration_chains_after_fridays():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert len(script.get_heads()) == 1
    assert script.get_revision("7c4e2a9d1f63").down_revision == "9e6a4c1f3b85"
