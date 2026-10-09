"""
"פתיחת פריטים אוטומטית אחרי Z" (docs/SPEC_AVAILABILITY.md, app/services/availability_reopen.py).

What each test pins, and how it could look fine while doing damage:

* **Modes** — off reopens nothing; "day" only what was locked during the day the Z closes
  (since the scope's previous close, or 24 h); "all" every lock, however old.
* **"חסימה קבועה"** — never reopened, in any mode; a till's "sold out" is temporary unless
  the manager says so; re-sending a lock keeps when it began and its flag.
* **Inheritance** — tenant → company → shop → point of sale → till, each lock judged by the
  setting at its own level.
* **Stock** — an item that tracks stock and has none stays closed (logged), unless
  "ignore stock".
* **Which Z** — a till's locks with any Z that includes it; a point of sale's and the shop's
  only once no other till of theirs is still in its day (a per-till shop: the last Z; a
  kiosk still selling after the shop Z: its own Z). A stale open shift does not hold a day.
* **Idempotent** — a Z applied twice changes nothing more and logs nothing twice; a late Z
  never opens a lock set after it.
* **Never costs a Z** — a failure in here leaves the Z built.
* **The tills hear of it** — after the commit, never before, never on a rollback.

Runs on the in-memory SQLite world of tests/shift_world.py, through the real `build_z`.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.models.availability_reopen import AvailabilityDayClose, AvailabilityReopen
from app.models.category import Category
from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import AreaProductOverride, MachineProductOverride
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.stock_level import StockLevel
from app.models.z_report import ZOrigin
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import availability_reopen as R
from app.services import category_availability as C
from app.services import commit_signals
from app.services import local_shop_z
from app.services import product_availability as A
from app.services.settings_merge import MANAGED_SETTING_KEYS
from app.services.z_builder import build_z

from shift_world import NOW, make_world


@pytest.fixture
def w(z_activity_unchecked, monkeypatch):
    world = make_world()
    db = world.db
    world.signals = []
    monkeypatch.setattr(commit_signals, "publish", lambda t, m, why: world.signals.append((m, why)))
    cat = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Drinks")
    db.add(cat)
    db.flush()

    def product(name, track=False):
        p = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, category_id=cat.id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=Decimal("10"), sku=name,
            is_available=True, track_stock=track,
        )
        db.add(p)
        db.flush()
        db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=p.id, is_listed=True))
        return p

    world.cola, world.soda, world.beer, world.wine = (product(n) for n in ("cola", "soda", "beer", "wine"))
    world.cat = cat
    world.bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="Bar")
    db.add(world.bar)
    db.flush()
    db.commit()
    yield world
    db.close()


# ── helpers ──────────────────────────────────────────────────────────────────


def _setting(holder, mode=None, ignore_stock=None):
    s = dict(holder.settings or {})
    if mode is not None:
        s[R.SETTING_MODE] = mode
    if ignore_stock is not None:
        s[R.SETTING_IGNORE_STOCK] = ignore_stock
    holder.settings = s


def _assortment(w, product):
    return w.db.query(ShopProductOverride).filter(
        ShopProductOverride.shop_id == w.shop.id, ShopProductOverride.global_product_id == product.id
    ).one()


#: When a helper's lock began, unless a test says: during the world's day (its clock is
#: `NOW`, not the wall clock the write path stamps with).
DURING = NOW - timedelta(hours=1)


def lock_shop(w, product, *, permanent=None, at=DURING):
    row = A.set_shop_availability(_assortment(w, product), False, permanent)
    row.blocked_at = at
    w.db.commit()
    return row


def lock_area(w, product, *, area=None, permanent=None, at=DURING):
    row = A.set_area_availability(w.db, (area or w.bar).id, product.id, False, permanent)
    row.blocked_at = at
    w.db.commit()
    return row


def lock_till(w, till, product, *, permanent=None, at=DURING):
    row = A.set_machine_availability(w.db, till.id, product.id, False, permanent)
    row.blocked_at = at
    w.db.commit()
    return row


def locked_shop(w, product) -> bool:
    w.db.expire_all()
    return _assortment(w, product).is_available is False


def locked_area(w, product, area=None) -> bool:
    w.db.expire_all()
    row = w.db.query(AreaProductOverride).filter_by(area_id=(area or w.bar).id, product_id=product.id).first()
    return row is not None and row.is_available is False


def locked_till(w, till, product) -> bool:
    w.db.expire_all()
    row = w.db.query(MachineProductOverride).filter_by(machine_id=till.id, product_id=product.id).first()
    return row is not None and row.is_available is False


def shift(w, till, *, opened=None, open_=False):
    return w.shift(
        till, None,
        status=ShiftStatus.OPEN if open_ else ShiftStatus.CLOSED,
        opened_at=opened or NOW - timedelta(hours=8),
    )


def shop_z(w, tills, *, now=NOW, area=None):
    selections = [(t, shift(w, t).id) for t in tills]
    z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=selections, now=now,
                area_id=area.id if area is not None else None)
    w.db.commit()
    return z


def till_z(w, till, *, now=NOW, opened=None):
    till.z_mode = "till"
    s = shift(w, till, opened=opened)
    z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, s.id)], now=now,
                origin=ZOrigin.TILL)
    w.db.commit()
    return z


def runs(w, z=None):
    q = w.db.query(AvailabilityDayClose)
    if z is not None:
        q = q.filter(AvailabilityDayClose.z_report_id == z.id)
    return {(r.level, r.target_id): r for r in q.all()}


def logged(w, outcome=None):
    q = w.db.query(AvailabilityReopen)
    if outcome is not None:
        q = q.filter(AvailabilityReopen.outcome == outcome)
    return sorted(r.item_name for r in q.all())


# ── The setting ──────────────────────────────────────────────────────────────


class TestSetting:
    def test_off_by_default_nothing_is_reopened_or_logged(self, w):
        lock_shop(w, w.cola)
        lock_till(w, w.tills[0], w.soda)
        shop_z(w, w.tills)
        assert locked_shop(w, w.cola) and locked_till(w, w.tills[0], w.soda)
        assert w.db.query(AvailabilityDayClose).count() == 0
        assert w.signals == []

    def test_the_keys_reach_the_tills_and_the_patch_takes_only_the_three_modes(self):
        assert {"autoReopenAfterZ", "autoReopenIgnoreStock"} <= set(MANAGED_SETTING_KEYS)
        for mode in ("off", "day", "all"):
            assert PosSettingsV1Patch.model_validate({"autoReopenAfterZ": mode}).auto_reopen_after_z == mode
        with pytest.raises(ValidationError):
            PosSettingsV1Patch.model_validate({"autoReopenAfterZ": "sometimes"})
        from app.routers.settings import TIP_RESETTABLE_KEYS

        assert {"autoReopenAfterZ", "autoReopenIgnoreStock"} <= set(TIP_RESETTABLE_KEYS), "null = inherit"

    def test_mode_of_reads_anything_else_as_off(self):
        assert R.mode_of({}) == R.mode_of({"autoReopenAfterZ": "x"}) == R.mode_of(None) == R.OFF


class TestAll:
    def test_a_shop_z_reopens_every_temporary_lock_of_the_shop(self, w):
        _setting(w.shop, "all")
        t1, t2 = w.tills
        t1.area_id = w.bar.id
        w.db.commit()
        lock_shop(w, w.cola, at=NOW - timedelta(days=30))
        lock_area(w, w.soda)
        lock_till(w, t2, w.beer)
        C.set_override(w.db, C.SHOP, w.shop.id, w.cat.id, False).blocked_at = DURING
        w.db.commit()

        z = shop_z(w, w.tills)

        assert not locked_shop(w, w.cola), "however old"
        assert not locked_area(w, w.soda)
        assert not locked_till(w, t2, w.beer)
        cat_row = w.db.query(CategoryAvailabilityOverride).one()
        assert cat_row.is_active is None and cat_row.blocked_at is None
        assert set(runs(w, z)) == {
            ("machine", t1.id), ("machine", t2.id), ("area", w.bar.id), ("shop", w.shop.id),
        }
        assert logged(w, R.REOPENED) == ["Drinks", "beer", "cola", "soda"]
        assert {m for m, _ in w.signals} == {str(t1.id), str(t2.id)}
        assert {why for _, why in w.signals} == {R.NOTIFY_REASON}

    def test_reopened_means_inherit_not_available(self, w):
        _setting(w.shop, "all")
        lock_shop(w, w.cola, permanent=True)
        lock_till(w, w.tills[0], w.cola)
        shop_z(w, w.tills)
        assert not locked_till(w, w.tills[0], w.cola)
        assert locked_shop(w, w.cola), "the till's lock opened; the shop's permanent one still decides"


class TestPermanent:
    @pytest.mark.parametrize("mode", ["day", "all"])
    def test_never_reopened(self, w, mode):
        _setting(w.shop, mode)
        lock_shop(w, w.cola, permanent=True)
        lock_till(w, w.tills[0], w.soda, permanent=True)
        lock_shop(w, w.beer)
        shop_z(w, w.tills)
        assert locked_shop(w, w.cola) and locked_till(w, w.tills[0], w.soda)
        assert not locked_shop(w, w.beer)
        assert "cola" not in logged(w) and "soda" not in logged(w)

    def test_a_new_lock_is_temporary_and_a_repeat_keeps_when_it_began_and_its_flag(self, w):
        row = A.set_shop_availability(_assortment(w, w.cola), False)
        assert (row.block_permanent, row.blocked_at is not None) == (False, True)
        began = row.blocked_at
        A.set_shop_availability(row, False, True)
        assert (row.block_permanent, row.blocked_at) == (True, began)
        A.set_shop_availability(row, False)  # a till re-sending "sold out", no flag
        assert (row.block_permanent, row.blocked_at) == (True, began)
        A.set_shop_availability(row, None)
        assert (row.block_permanent, row.blocked_at) == (False, None)

    def test_a_category_switch_off_carries_the_same_marks(self, w):
        row = C.set_override(w.db, C.MACHINE, w.tills[0].id, w.cat.id, False)
        assert (row.block_permanent, row.blocked_at is not None) == (False, True)
        C.set_override(w.db, C.MACHINE, w.tills[0].id, w.cat.id, False, True)
        assert row.block_permanent is True
        C.set_override(w.db, C.MACHINE, w.tills[0].id, w.cat.id, True)
        assert (row.block_permanent, row.blocked_at) == (False, None)

    def test_a_lock_queued_offline_begins_when_the_till_set_it_never_later_than_now(self, w):
        from datetime import datetime, timezone

        earlier = datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc)
        row = A.set_machine_availability(w.db, w.tills[0].id, w.cola.id, False, None, earlier)
        assert row.blocked_at == earlier
        A.set_machine_availability(w.db, w.tills[0].id, w.cola.id, False, None, earlier + timedelta(hours=5))
        assert row.blocked_at == earlier, "a lock that stays a lock keeps when it began"
        row = A.set_machine_availability(w.db, w.tills[1].id, w.cola.id, False, None, datetime(2099, 1, 1, tzinfo=timezone.utc))
        assert row.blocked_at <= datetime.now(timezone.utc), "a clock ahead is not believed"

    def test_the_till_sends_the_moment_and_the_flag(self):
        from app.schemas.product_availability import TillAvailabilitySet

        body = TillAvailabilitySet.model_validate(
            {"scope": "machine", "active": False, "permanent": True, "blockedAt": "2026-10-06T09:00:00.000Z"}
        )
        assert (body.permanent, body.blocked_at.hour) == (True, 9)
        assert TillAvailabilitySet.model_validate({"scope": "shop", "active": False}).permanent is None


class TestDay:
    def test_only_what_was_locked_during_the_day(self, w):
        _setting(w.shop, "day")
        lock_shop(w, w.cola, at=NOW - timedelta(hours=30))  # before the day (no earlier close: 24 h)
        lock_shop(w, w.soda, at=NOW - timedelta(hours=3))
        legacy = lock_shop(w, w.beer)
        legacy.blocked_at = None  # a lock older than the column: when it began is unknown
        w.db.commit()
        shop_z(w, w.tills)
        assert (locked_shop(w, w.cola), locked_shop(w, w.soda), locked_shop(w, w.beer)) == (True, False, True)

    def test_the_day_starts_at_the_scopes_previous_close(self, w):
        _setting(w.shop, "day")
        yesterday = NOW - timedelta(hours=20)
        shop_z(w, w.tills, now=yesterday)
        lock_shop(w, w.cola, at=yesterday - timedelta(hours=1))  # within 24 h, but before the last close
        lock_shop(w, w.soda, at=yesterday + timedelta(hours=1))
        for t in w.tills:
            shift(w, t, opened=NOW - timedelta(hours=8))
        z = build_z(
            w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, now=NOW,
            selections=[(t, w.db.query(R.Shift).filter_by(machine_id=t.id, z_report_id=None).one().id) for t in w.tills],
        )
        w.db.commit()
        assert runs(w, z)[("shop", w.shop.id)].mode == "day"
        assert (locked_shop(w, w.cola), locked_shop(w, w.soda)) == (True, False)


class TestInheritance:
    @pytest.mark.parametrize(
        "tenant, company, shop, expected",
        [
            ("all", None, None, False),      # the tenant's, inherited
            ("all", "off", None, True),      # the company switches it off for its shops
            ("off", None, "all", False),     # the shop switches it on for itself
            (None, "all", "off", True),
        ],
    )
    def test_the_shop_lock_follows_the_shops_effective_setting(self, w, tenant, company, shop, expected):
        _setting(w.tenant, tenant)
        _setting(w.company, company)
        _setting(w.shop, shop)
        w.db.commit()
        lock_shop(w, w.cola)
        shop_z(w, w.tills)
        assert locked_shop(w, w.cola) is expected

    def test_each_lock_is_judged_at_its_own_level(self, w):
        t1, t2 = w.tills
        t1.area_id = w.bar.id
        _setting(w.shop, "off")
        _setting(w.bar, "all")       # the point of sale opts in
        _setting(t2, "all")          # and one till of its own
        w.db.commit()
        lock_shop(w, w.cola)
        lock_area(w, w.soda)
        lock_till(w, t1, w.beer)     # t1 inherits the bar's "all"
        lock_till(w, t2, w.wine)
        shop_z(w, w.tills)
        assert locked_shop(w, w.cola), "the shop's own setting is off"
        assert not locked_area(w, w.soda)
        assert not locked_till(w, t1, w.beer)
        assert not locked_till(w, t2, w.wine)


class TestStock:
    def _tracked(self, w, qty):
        w.cola.track_stock = True
        if qty is not None:
            w.db.add(StockLevel(tenant_id=w.tenant.id, shop_id=w.shop.id, product_id=w.cola.id, quantity=Decimal(qty)))
        w.db.commit()

    @pytest.mark.parametrize("qty", [None, "0", "-2"])
    def test_kept_closed_while_it_has_none(self, w, qty):
        _setting(w.shop, "all")
        self._tracked(w, qty)
        lock_shop(w, w.cola)
        shop_z(w, w.tills)
        assert locked_shop(w, w.cola)
        assert logged(w, R.KEPT_STOCK) == ["cola"]
        assert runs(w)[("shop", w.shop.id)].kept_count == 1

    def test_reopened_when_it_has_some(self, w):
        _setting(w.shop, "all")
        self._tracked(w, "3")
        lock_shop(w, w.cola)
        shop_z(w, w.tills)
        assert not locked_shop(w, w.cola)

    def test_reopened_regardless_when_the_setting_ignores_stock(self, w):
        _setting(w.shop, "all", ignore_stock=True)
        self._tracked(w, "0")
        lock_shop(w, w.cola)
        shop_z(w, w.tills)
        assert not locked_shop(w, w.cola)
        assert runs(w)[("shop", w.shop.id)].ignore_stock is True


class TestWhichZ:
    def test_a_per_till_shop_waits_for_the_last_till(self, w):
        _setting(w.shop, "all")
        t1, t2 = w.tills
        lock_shop(w, w.cola)
        lock_till(w, t1, w.soda)
        shift(w, t2, opened=NOW - timedelta(hours=6), open_=True)  # t2 still selling
        till_z(w, t1, now=NOW - timedelta(hours=1))
        assert not locked_till(w, t1, w.soda), "t1's own day is over"
        assert locked_shop(w, w.cola), "t2 is still in the day"
        t2.z_mode = "till"
        open_shift = w.db.query(R.Shift).filter_by(machine_id=t2.id).one()
        open_shift.status = ShiftStatus.CLOSED
        open_shift.closed_at = NOW - timedelta(minutes=5)
        w.db.flush()
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(t2, open_shift.id)],
                    now=NOW, origin=ZOrigin.TILL)
        w.db.commit()
        assert not locked_shop(w, w.cola), "the last till closed the shop's day"
        assert runs(w, z)[("shop", w.shop.id)].closed_at.replace(tzinfo=None) == NOW.replace(tzinfo=None)

    def test_a_kiosk_still_selling_after_the_shop_z_holds_the_shop_and_its_own_z_opens_it(self, w):
        _setting(w.shop, "all")
        t1, t2 = w.tills
        kiosk = w.other_till
        kiosk.shop_id, kiosk.z_mode, kiosk.area_id = w.shop.id, "till", w.bar.id
        w.db.commit()
        lock_shop(w, w.cola)
        lock_area(w, w.soda)  # the kiosk's point of sale
        shift(w, kiosk, opened=NOW - timedelta(hours=9), open_=True)
        shop_z(w, [t1, t2])
        assert locked_shop(w, w.cola) and locked_area(w, w.soda)
        open_shift = w.db.query(R.Shift).filter_by(machine_id=kiosk.id).one()
        open_shift.status = ShiftStatus.CLOSED
        open_shift.closed_at = NOW + timedelta(hours=5)
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(kiosk, open_shift.id)],
                now=NOW + timedelta(hours=6), origin=ZOrigin.TILL)
        w.db.commit()
        assert not locked_shop(w, w.cola) and not locked_area(w, w.soda)
        assert str(kiosk.id) in {m for m, _ in w.signals}

    def test_an_area_z_opens_the_area_but_not_the_shop_while_others_trade(self, w):
        _setting(w.shop, "all")
        t1, t2 = w.tills
        t1.area_id = w.bar.id
        w.db.commit()
        lock_shop(w, w.cola)
        lock_area(w, w.soda)
        shift(w, t2, opened=NOW - timedelta(hours=3), open_=True)
        shop_z(w, [t1], area=w.bar)
        assert not locked_area(w, w.soda)
        assert locked_shop(w, w.cola)

    def test_a_till_that_died_with_its_shift_open_does_not_hold_the_day(self, w):
        _setting(w.shop, "all")
        t1, t2 = w.tills
        shift(w, t2, opened=NOW - timedelta(days=3), open_=True)
        lock_shop(w, w.cola)
        shop_z(w, [t1])
        assert not locked_shop(w, w.cola)

    def test_a_late_z_never_opens_a_lock_set_after_it(self, w):
        _setting(w.shop, "all")
        t1 = w.tills[0]
        lock_till(w, t1, w.cola, at=NOW - timedelta(hours=1))  # set after the Z closed
        lock_till(w, t1, w.soda, at=NOW - timedelta(hours=3))
        till_z(w, t1, now=NOW - timedelta(hours=2), opened=NOW - timedelta(hours=9))
        assert locked_till(w, t1, w.cola) and not locked_till(w, t1, w.soda)


class TestIdempotent:
    def test_applying_a_z_again_changes_and_logs_nothing_more(self, w):
        _setting(w.shop, "all")
        lock_shop(w, w.cola)
        z = shop_z(w, w.tills)
        before = (w.db.query(AvailabilityDayClose).count(), w.db.query(AvailabilityReopen).count())
        lock_shop(w, w.soda, at=NOW - timedelta(hours=1))  # a lock the Z could have opened…
        w.signals.clear()
        assert R.after_z(w.db, z, w.tills) == []
        w.db.commit()
        assert locked_shop(w, w.soda), "…but this Z has been applied already"
        assert (w.db.query(AvailabilityDayClose).count(), w.db.query(AvailabilityReopen).count()) == before
        assert w.signals == []


class TestSafety:
    def test_a_failure_never_costs_the_z(self, w, monkeypatch):
        _setting(w.shop, "all")
        lock_shop(w, w.cola)

        def boom(*a, **k):
            raise RuntimeError("boom")

        monkeypatch.setattr(R, "scopes_of", boom)
        z = shop_z(w, w.tills)
        assert z.id is not None and locked_shop(w, w.cola)

    def test_no_signal_before_the_commit_nor_after_a_rollback(self, w):
        _setting(w.shop, "all")
        lock_shop(w, w.cola)
        selections = [(t, shift(w, t).id) for t in w.tills]
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=selections, now=NOW)
        assert w.signals == []
        w.db.rollback()
        w.db.commit()
        assert w.signals == []
        assert locked_shop(w, w.cola)

    def test_the_local_shop_z_upload_calls_the_hook(self):
        assert "after_z(db, z, part_machines)" in inspect.getsource(local_shop_z)


class TestLog:
    def test_the_dashboard_reads_what_each_z_reopened(self, w):
        from app.routers.availability_reopen import list_reopens

        _setting(w.shop, "all")
        w.cola.track_stock = True
        w.db.commit()
        lock_shop(w, w.cola)
        lock_shop(w, w.soda)
        z = shop_z(w, w.tills)
        out = list_reopens(shop_id=w.shop.id, limit=10, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert len(out) == 1
        run = out[0].model_dump(by_alias=True)
        assert (run["zReportId"], run["level"], run["targetName"], run["mode"]) == (z.id, "shop", "Center", "all")
        assert (run["reopenedCount"], run["keptCount"]) == (1, 1)
        assert {(i["name"], i["outcome"]) for i in run["items"]} == {("soda", "reopened"), ("cola", "kept_stock")}
