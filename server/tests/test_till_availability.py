"""Cover for making a product or a category inactive from the till, per till, area or shop.

The till's manager screen no longer deletes; it switches things off for this till, for
the area (point of sale) the till stands in, or for the whole shop, and the cloud
carries that to every till it reaches. Each test names a way this could look as if it
worked while doing damage:

* an area level that resolves in the wrong place — above the shop, or below the till —
  so a shop's or a till's own decision stops counting;
* a category switched off at an area that still reaches its tills as active, because
  the sync sent the tenant flag, or a delta pull never resent it;
* a till able to switch something on that the tenant switched off;
* a write that wakes the wrong tills, or none, so the change sits in the cloud;
* the old delete still deleting.

Runs on the availability world (tests/test_product_availability.py): a real session on
in-memory SQLite, so the sync's own queries are what is tested.
"""
from __future__ import annotations

import importlib.util
import inspect
import pathlib
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.database import Base
from app.middleware.auth import CatalogActor, require_catalog_authority
from app.models.category import Category
from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.pos_machine import POSMachine
from app.models.product_availability_override import AreaProductOverride, MachineProductOverride
from app.models.shop_area import ShopArea
from app.models.sync_log import SyncLog
from app.routers import categories as categories_router
from app.routers import product_availability as R
from app.routers import sync as sync_router
from app.schemas.product_availability import AvailabilitySet, TillAvailabilitySet
from app.services import category_availability as C
from app.services import product_availability as A
from app.services import sync as S
from app.services.permissions import Scope
from app.services.product_availability import Level

from test_product_availability import OLD, SINCE, world  # noqa: F401

N, T, F = None, True, False


# ── The rules themselves ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "product, company, shop, area, machine, expected, source",
    [
        (T, N, N, N, N, T, Level.PRODUCT),
        (T, N, N, F, N, F, Level.AREA),       # the area locks for its tills
        (T, N, F, T, N, T, Level.AREA),       # the area unlocks what its shop locked
        (T, F, N, T, N, T, Level.AREA),       # ...and what the company locked
        (T, N, T, F, N, F, Level.AREA),
        (T, N, N, F, T, T, Level.MACHINE),    # a till unlocks what its area locked
        (T, N, N, T, F, F, Level.MACHINE),
        (F, N, N, T, N, T, Level.AREA),
        (T, N, F, N, N, F, Level.SHOP),       # "not set" at the area is transparent
        (T, F, N, N, N, F, Level.COMPANY),
    ],
)
def test_product_area_sits_between_shop_and_machine(product, company, shop, area, machine, expected, source):
    got = A.resolve(product, company, shop, machine, area=area)
    assert (got.available, got.source) == (expected, source)


def test_product_levels_resolve_top_down_with_the_area():
    levels = A.resolve_levels(True, None, False, None, area=True)
    assert (levels[Level.SHOP].available, levels[Level.AREA].available) == (False, True)
    assert levels[Level.MACHINE].source == Level.AREA
    assert A.level_above(Level.MACHINE) == Level.AREA
    assert A.level_above(Level.AREA) == Level.SHOP


@pytest.mark.parametrize(
    "tenant, shop, area, machine, expected",
    [
        (T, N, N, N, T),
        (F, N, N, N, F),
        (T, F, N, N, F),
        (T, F, T, N, T),   # the area switches on what its shop switched off
        (T, N, F, N, F),
        (T, N, F, T, T),   # the till switches on what its area switched off
        (T, T, T, F, F),
        (F, T, T, T, F),   # nothing below switches on what the tenant switched off
        (T, T, N, N, T),
    ],
)
def test_category_nearest_set_level_wins_under_the_tenant_flag(tenant, shop, area, machine, expected):
    assert C.resolve(tenant, shop, area, machine) is expected


# ── The world: h1 stands in the bar; h2 in no area ───────────────────────────


@pytest.fixture
def w(world, monkeypatch):  # noqa: F811
    db = world.db
    for name in ("sync_logs", "shop_category_overrides"):  # audit; the category pull
        Base.metadata.tables[name].create(db.get_bind())
    monkeypatch.setattr(
        C, "notify_machine_catalog_changed",
        lambda tid, mid, reason: world.notified.append(("machine", str(mid))),
    )
    monkeypatch.setattr(
        C, "notify_machines_for_shop",
        lambda _db, sid, reason: world.notified.append(("shop", str(sid))),
    )

    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    # A category another shop placed: never sent to h_shop's tills.
    foreign = Category(
        id=uuid.uuid4(), tenant_id=world.tid, company_id=world.B.id, shop_id=world.b_shop.id,
        name="B only", updated_at=OLD,
    )
    db.add(foreign)
    db.commit()
    world.bar = bar
    world.drinks = db.query(Category).filter(Category.name == "Drinks").one()
    world.foreign = foreign
    return world


def _actor():
    return CatalogActor(pos_user_id=uuid.uuid4())


def _product_put(w, machine, scope, active, product=None):
    return sync_router.machine_set_product_availability(
        str(machine.id), str((product or w.P).id), TillAvailabilitySet(scope=scope, active=active),
        machine=machine, actor=_actor(), db=w.db,
    )


def _category_put(w, machine, scope, active, category=None):
    return sync_router.machine_set_category_availability(
        str(machine.id), str((category or w.drinks).id), TillAvailabilitySet(scope=scope, active=active),
        machine=machine, actor=_actor(), db=w.db,
    )


def _avail(w, machine, product=None, since=None):
    product = product or w.P
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0]["isAvailable"] if hits else None


def _category(w, machine, category=None, since=None):
    category = category or w.drinks
    rows = S.get_categories_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["id"] == str(category.id)]
    return hits[0] if hits else None


def _age(w):
    for model in (AreaProductOverride, MachineProductOverride, CategoryAvailabilityOverride):
        for row in w.db.query(model).all():
            row.updated_at = OLD
    for row in w.rows.__dict__.values():
        row.updated_at = OLD
    w.P.updated_at = OLD
    w.db.commit()


# ── PUT /sync/{id}/products/{id}/availability ────────────────────────────────


class TestTillProductAvailability:
    def test_machine_scope_locks_this_till_only(self, w):
        out = _product_put(w, w.h1, "machine", False).model_dump(by_alias=True)
        assert out == {"id": w.P.id, "scope": "machine", "active": False, "effectiveActive": False}
        assert (_avail(w, w.h1), _avail(w, w.h2)) == (False, True)
        assert w.notified == [("machine", str(w.h1.id))]

    def test_area_scope_reaches_the_tills_in_the_area_only(self, w):
        out = _product_put(w, w.h1, "area", False)
        assert (out.active, out.effective_active) == (False, False)
        row = w.db.query(AreaProductOverride).one()
        assert (row.area_id, row.is_available) == (w.bar.id, False)
        assert (_avail(w, w.h1), _avail(w, w.h2)) == (False, True)
        assert w.notified == [("machine", str(w.h1.id))], "the area's tills, nobody else"

    def test_shop_scope_lands_on_the_assortment_row(self, w):
        out = _product_put(w, w.h2, "shop", False)
        assert (out.scope, out.effective_active) == ("shop", False)
        assert w.rows.p_h.is_available is False
        assert (_avail(w, w.h1), _avail(w, w.h2), _avail(w, w.a1)) == (False, False, True)
        assert w.notified == [("shop", str(w.h_shop.id))]

    def test_null_clears_each_scope_back_to_inherit(self, w):
        _product_put(w, w.h1, "shop", False)
        _product_put(w, w.h1, "area", True)
        assert _avail(w, w.h1) is True, "the area unlocks what its shop locked"
        _product_put(w, w.h1, "machine", False)
        assert _avail(w, w.h1) is False
        out = _product_put(w, w.h1, "machine", None)
        assert (out.active, out.effective_active) == (None, True)
        out = _product_put(w, w.h1, "area", None)
        assert out.effective_active is False, "back to the shop's lock"
        out = _product_put(w, w.h1, "shop", None)
        assert out.effective_active is True
        # Cleared, not deleted: the rows stay with a NULL for the delta pull to see.
        assert w.db.query(AreaProductOverride).one().is_available is None
        assert w.db.query(MachineProductOverride).one().is_available is None

    def test_area_scope_without_an_area_is_400_and_writes_nothing(self, w):
        with pytest.raises(HTTPException) as exc:
            _product_put(w, w.h2, "area", False)
        assert (exc.value.status_code, exc.value.detail) == (400, "machine_has_no_area")
        w.db.rollback()
        assert w.db.query(AreaProductOverride).count() == 0
        assert w.db.query(SyncLog).count() == 0
        assert w.notified == []

    def test_a_product_not_in_the_shop_is_404(self, w):
        with pytest.raises(HTTPException) as exc:
            _product_put(w, w.a1, "machine", False, product=w.Q)  # Q is not sold in a_shop
        assert exc.value.status_code == 404
        assert w.db.query(MachineProductOverride).count() == 0

    def test_it_is_audited_with_the_scope(self, w):
        _product_put(w, w.h1, "area", False)
        log = w.db.query(SyncLog).one()
        assert log.entity_id == w.P.id
        assert "scope=area" in log.conflict_note

    def test_an_area_change_reaches_a_till_that_pulls_deltas(self, w):
        _age(w)
        assert _avail(w, w.h1, since=SINCE) is None, "nothing changed since"
        _product_put(w, w.h1, "area", False)
        assert _avail(w, w.h1, since=SINCE) is False
        assert _avail(w, w.h2, since=SINCE) is None, "a till in no area is not resent"

    def test_moving_a_till_to_another_area_resends_its_products(self, w):
        _product_put(w, w.h1, "area", False)
        _age(w)
        w.h1.area_id = None
        w.h1.area_changed_at = datetime.now(timezone.utc)
        w.db.commit()
        assert _avail(w, w.h1, since=SINCE) is True, "the bar's lock left with the till"

    def test_the_area_moves_the_watermark_of_its_tills_only(self, w):
        _age(w)
        before = {m.name: S.get_catalog_change_watermark_for_machine(w.db, m) for m in (w.h1, w.h2)}
        _product_put(w, w.h1, "area", False)
        assert S.get_catalog_change_watermark_for_machine(w.db, w.h1) > before["h1"]
        assert S.get_catalog_change_watermark_for_machine(w.db, w.h2) == before["h2"]

    def test_the_single_product_resolver_sees_the_area(self, w):
        _product_put(w, w.h1, "area", False)
        assert A.effective_availability(w.db, w.P, w.h1) is False
        assert A.effective_availability(w.db, w.P, w.h2) is True


# ── PUT /sync/{id}/categories/{id}/availability ──────────────────────────────


class TestTillCategoryAvailability:
    def test_machine_scope(self, w):
        out = _category_put(w, w.h1, "machine", False).model_dump(by_alias=True)
        assert out == {"id": w.drinks.id, "scope": "machine", "active": False, "effectiveActive": False}
        assert (_category(w, w.h1)["isActive"], _category(w, w.h2)["isActive"]) == (False, True)
        assert w.notified == [("machine", str(w.h1.id))]

    def test_area_scope(self, w):
        _category_put(w, w.h1, "area", False)
        row = w.db.query(CategoryAvailabilityOverride).one()
        assert (row.level, row.target_id, row.is_active) == ("area", w.bar.id, False)
        assert (_category(w, w.h1)["isActive"], _category(w, w.h2)["isActive"]) == (False, True)
        assert w.notified == [("machine", str(w.h1.id))]

    def test_shop_scope(self, w):
        _category_put(w, w.h2, "shop", False)
        assert (_category(w, w.h1)["isActive"], _category(w, w.h2)["isActive"]) == (False, False)
        assert _category(w, w.a1)["isActive"] is True, "another shop keeps it"
        assert w.notified == [("shop", str(w.h_shop.id))]

    def test_nearest_wins_and_null_resets(self, w):
        _category_put(w, w.h1, "shop", False)
        assert _category_put(w, w.h1, "area", True).effective_active is True
        assert _category_put(w, w.h1, "machine", False).effective_active is False
        assert _category_put(w, w.h1, "machine", None).effective_active is True
        assert _category_put(w, w.h1, "area", None).effective_active is False
        out = _category_put(w, w.h1, "shop", None)
        assert (out.active, out.effective_active) == (None, True)
        assert _category(w, w.h1)["isActive"] is True
        assert {r.is_active for r in w.db.query(CategoryAvailabilityOverride).all()} == {None}

    def test_the_tenant_flag_is_the_floor(self, w):
        w.drinks.is_active = False
        w.db.commit()
        out = _category_put(w, w.h1, "machine", True)
        assert (out.active, out.effective_active) == (True, False)
        assert _category(w, w.h1)["isActive"] is False

    def test_area_scope_without_an_area_is_400(self, w):
        with pytest.raises(HTTPException) as exc:
            _category_put(w, w.h2, "area", False)
        assert (exc.value.status_code, exc.value.detail) == (400, "machine_has_no_area")
        w.db.rollback()
        assert w.db.query(CategoryAvailabilityOverride).count() == 0
        assert w.notified == []

    def test_a_category_the_till_is_not_sent_is_404(self, w):
        with pytest.raises(HTTPException) as exc:
            _category_put(w, w.h1, "machine", False, category=w.foreign)
        assert exc.value.status_code == 404
        assert w.db.query(CategoryAvailabilityOverride).count() == 0

    def test_another_tenants_category_is_refused(self, w):
        other = Category(id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="Elsewhere")
        w.db.add(other)
        w.db.commit()
        with pytest.raises(HTTPException) as exc:
            _category_put(w, w.h1, "shop", False, category=other)
        assert exc.value.status_code == 403


class TestCategoryDelta:
    def test_a_change_at_each_scope_is_resent_on_a_delta(self, w):
        assert _category(w, w.h1, since=SINCE) is None, "nothing changed since"
        _category_put(w, w.h1, "area", False)
        row = _category(w, w.h1, since=SINCE)
        assert row is not None and row["isActive"] is False
        assert _category(w, w.h2, since=SINCE) is None, "not h2's area"
        _category_put(w, w.h2, "shop", False)
        assert _category(w, w.h2, since=SINCE)["isActive"] is False

    def test_clearing_is_resent_too(self, w):
        _category_put(w, w.h1, "machine", False)
        _age(w)
        assert _category(w, w.h1, since=SINCE) is None
        _category_put(w, w.h1, "machine", None)
        assert _category(w, w.h1, since=SINCE)["isActive"] is True

    def test_moving_area_resends_every_category(self, w):
        _category_put(w, w.h1, "area", False)
        _age(w)
        w.h1.area_id = None
        w.h1.area_changed_at = datetime.now(timezone.utc)
        w.db.commit()
        assert _category(w, w.h1, since=SINCE)["isActive"] is True

    def test_the_watermark_moves_for_the_tills_reached(self, w):
        before = {m.name: S.get_catalog_change_watermark_for_machine(w.db, m) for m in (w.h1, w.h2, w.a1)}
        _category_put(w, w.h1, "area", False)
        assert S.get_catalog_change_watermark_for_machine(w.db, w.h1) > before["h1"]
        assert S.get_catalog_change_watermark_for_machine(w.db, w.h2) == before["h2"]
        _category_put(w, w.h2, "shop", False)
        assert S.get_catalog_change_watermark_for_machine(w.db, w.h2) > before["h2"]
        assert S.get_catalog_change_watermark_for_machine(w.db, w.a1) == before["a1"]

    def test_a_category_merged_in_for_a_product_carries_the_effective_flag(self, w):
        _category_put(w, w.h1, "area", False)
        merged = S.merge_categories_referenced_by_products(
            w.db, w.h1, [{"categoryId": str(w.drinks.id)}], []
        )
        assert [c["isActive"] for c in merged] == [False]


# ── Authority, and the delete that no longer deletes ─────────────────────────


class TestAuthorityAndDelete:
    @pytest.mark.parametrize(
        "handler",
        [sync_router.machine_set_product_availability, sync_router.machine_set_category_availability],
    )
    def test_both_writes_require_catalog_authority(self, handler):
        dependency = inspect.signature(handler).parameters["actor"].default.dependency
        assert dependency.__qualname__.startswith("require_catalog_authority.")

    def test_no_grant_and_no_operator_is_elevation_required(self, w):
        gate = require_catalog_authority(Scope.CATALOG_WRITE)
        with pytest.raises(HTTPException) as exc:
            gate(machine=w.h1, elevation_token=None, operator_id=None, db=w.db)
        assert exc.value.status_code == 401

    def test_the_deletes_refuse_and_change_nothing(self, w):
        for handler, entity in (
            (sync_router.machine_delete_cloud_product, w.P),
            (sync_router.machine_delete_cloud_category, w.drinks),
        ):
            with pytest.raises(HTTPException) as exc:
                handler(str(w.h1.id), str(entity.id), machine=w.h1, actor=_actor(), db=w.db)
            assert (exc.value.status_code, exc.value.detail) == (409, "delete_disabled_use_deactivate")
        w.db.expire_all()
        assert w.rows.p_h.is_listed is True
        assert w.db.get(Category, w.drinks.id) is not None
        assert w.db.query(SyncLog).count() == 0
        assert w.notified == []


# ── The dashboard ────────────────────────────────────────────────────────────


class TestDashboard:
    def test_the_picture_has_the_area_and_each_till_inherits_from_it(self, w):
        R.set_area_availability(
            str(w.P.id), str(w.bar.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert w.notified == [("machine", str(w.h1.id))]
        pic = R.get_product_availability(
            str(w.P.id), current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        ).model_dump(by_alias=True)
        h = next(c for c in pic["companies"] if c["companyName"] == "Holding")
        (shop,) = h["shops"]
        (bar,) = shop["areas"]
        assert (bar["name"], bar["value"], bar["inherited"], bar["effective"], bar["source"]) == (
            "Bar", False, True, False, "area",
        )
        tills = {m["name"]: m for m in shop["machines"]}
        assert (tills["h1"]["areaId"], tills["h1"]["inherited"], tills["h1"]["effective"]) == (
            w.bar.id, False, False,
        )
        assert tills["h1"]["source"] == "area"
        assert (tills["h2"]["areaId"], tills["h2"]["effective"]) == (None, True)
        for m in shop["machines"]:
            assert m["effective"] == _avail(w, w.db.get(POSMachine, m["machineId"]))

    def test_the_area_write_is_the_shops_to_make(self, w):
        with pytest.raises(HTTPException) as exc:
            R.set_area_availability(
                str(w.P.id), str(w.bar.id), AvailabilitySet(isAvailable=False),
                current_user=w.users.a_shop_manager, active_tenant_id=w.tid, db=w.db,
            )
        assert exc.value.status_code == 403
        w.db.rollback()
        assert w.db.query(AreaProductOverride).count() == 0
        R.set_area_availability(
            str(w.P.id), str(w.bar.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.h_shop_manager, active_tenant_id=w.tid, db=w.db,
        )
        assert w.db.query(AreaProductOverride).one().is_available is False

    def test_the_category_list_says_where_it_is_switched_off(self, w):
        _category_put(w, w.h1, "area", False)
        _category_put(w, w.h2, "machine", False)
        _category_put(w, w.h2, "shop", True)  # switched *on* here: not listed
        rows = categories_router.list_categories(
            skip=0, limit=100, company_id=None, shop_id=None, pos_machine_id=None,
            parent_id=None, catalog_level=None, is_active=None, include_children=False,
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        drinks = next(r for r in rows if r.id == w.drinks.id).model_dump(by_alias=True)
        assert [(i["level"], i["name"]) for i in drinks["inactiveAt"]] == [("area", "Bar"), ("machine", "h2")]
        assert next(r for r in rows if r.id == w.foreign.id).inactive_at == []


# ── Mounted, and migrated ────────────────────────────────────────────────────


def test_the_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for method, path in (
        ("PUT", "/api/v1/sync/{machine_id}/products/{product_id}/availability"),
        ("PUT", "/api/v1/sync/{machine_id}/categories/{category_id}/availability"),
        ("PUT", "/api/v1/products/{product_id}/availability/areas/{area_id}"),
    ):
        assert (method, path) in mounted, (method, path)


def test_the_migration_is_chained_onto_the_previous_head_and_is_the_only_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    here = pathlib.Path(__file__).resolve().parents[1]
    path = here / "alembic" / "versions" / "f0a1b2c3d4e9_area_and_category_availability.py"
    spec = importlib.util.spec_from_file_location("area_category_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert (module.revision, module.down_revision) == ("f0a1b2c3d4e9", "f0a1b2c3d4e8")
    cfg = Config(str(here / "alembic.ini"))
    cfg.set_main_option("script_location", str(here / "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert len(heads) == 1
    source = path.read_text(encoding="utf-8")
    assert "not in tables" in source, "creates are guarded like its neighbours"
