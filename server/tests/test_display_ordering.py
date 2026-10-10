"""
"סדר תצוגה" — one ordering model for the four channels (app/services/display_ordering_rules.py,
app/services/display_ordering.py, app/routers/display_orderings.py, migration 701a25694d3c).

What could look right and still be wrong:

* the migration changing what a till or a kiosk reads (it must write nothing they read);
* the tills' flat list losing its interleaving when written back unchanged;
* "linked" levels not moving together — or "unlink" moving the positions;
* a till's own "עריכת מסך" not reaching the kiosk it is linked with, or a level it cleared keeping
  a binding that no longer says anything;
* a hidden or blocked item moving the others, a pinned one losing its place to a sort;
* two editors overwriting each other (the version).

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import uuid
from copy import deepcopy

import pytest
from fastapi import HTTPException

from app.database import Base
from app.middleware.auth import CatalogActor
from app.models.category import Category
from app.models.display_ordering import DisplayOrdering, DisplayOrderingBinding
from app.models.kiosk import KioskDevice, KioskSettings
from app.models.shop_area import ShopArea
from app.routers import display_orderings as router
from app.routers import sync as sync_router
from app.services import display_ordering as DO
from app.services import display_ordering_rules as R
from app.services.settings_merge import merge_all_settings_layers

from test_product_availability import world  # noqa: F401

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "display_ordering_golden.json"
#: The LF-normalised bytes' SHA-256 (a till that reads this rule later pins the same value).
GOLDEN_SHA256 = "38b577d103c821bbb1480e4f2d6d7d90652e7fbd367dff81acf2fa81bb872446"
MIGRATION = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "701a25694d3c_display_orderings.py"


# ── The rule (golden) ────────────────────────────────────────────────────────


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_golden_file_is_pinned():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


@pytest.mark.parametrize("case", _golden()["arrange"], ids=lambda c: c["name"])
def test_arrange(case):
    cat = _golden()["catalog"]
    got = R.arrange(case["ordering"], cat["categories"], cat["products"], hidden=case.get("hidden", ()),
                    sort=case.get("sort", "manual"), rank=case.get("rank"))
    assert got == case["expect"]


@pytest.mark.parametrize("case", _golden()["posImport"], ids=lambda c: c["name"])
def test_pos_import_and_an_unchanged_write_back_is_the_same_list(case):
    category_of = {p["id"]: p["categoryId"] for p in _golden()["catalog"]["products"]}
    content = R.import_pos(case["productOrder"], case["categoryOrder"], category_of)
    assert {k: content[k] for k in ("categories", "products", "legacyFlat")} == case["expectImport"]
    back = R.pos_legacy(content, content["legacyFlat"], category_of)
    assert back == case["expectUnchangedWriteBack"]
    assert back["productOrder"] == (case["productOrder"] or None), "interleaving and unknown ids kept"


@pytest.mark.parametrize("case", _golden()["posWriteBack"], ids=lambda c: c["name"])
def test_pos_write_back(case):
    category_of = {p["id"]: p["categoryId"] for p in _golden()["catalog"]["products"]}
    assert R.pos_legacy(case["ordering"], case["legacyFlat"], category_of) == case["expect"]


def test_merge_shown_is_the_tills_rule():
    for case in _golden()["mergeShown"]:
        assert R.merge_shown(case["full"], case["shown"]) == case["expect"]


def test_kiosk_keys_one_to_one():
    for case in _golden()["kiosk"]:
        assert R.kiosk_legacy(R.import_kiosk(case["catalog"])) == case["expect"]


@pytest.mark.parametrize("case", _golden()["inherit"], ids=lambda c: c["name"])
def test_inheritance(case):
    assert R.effective_along(case["channel"], case["chain"]) == case["expect"]


# ── On a real session ────────────────────────────────────────────────────────


@pytest.fixture
def ow(world, monkeypatch):  # noqa: F811
    """h_shop: h1 a till in point of sale "Bar", h2 a kiosk. Drinks: P (Cola), Q (Soda); Food: F1, F2."""
    db = world.db
    for name in ("kiosk_devices", "kiosk_settings", "display_orderings", "display_ordering_bindings", "sync_logs"):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    DO._READY = None
    world.signals = []
    monkeypatch.setattr(DO, "publish", lambda t, m, why: world.signals.append(m))
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    db.add(KioskDevice(machine_id=world.h2.id, tenant_id=world.tid, shop_id=world.h_shop.id, name="Kiosk", enabled=True))
    food = Category(id=uuid.uuid4(), tenant_id=world.tid, name="Food", sort_order=0)
    db.add(food)
    db.flush()
    from app.models.product import CatalogLevel, Product
    from app.models.shop_product_override import ShopProductOverride

    def product(name):
        p = Product(id=uuid.uuid4(), tenant_id=world.tid, company_id=world.H.id, category_id=food.id,
                    catalog_level=CatalogLevel.GLOBAL, name=name, price=10, sku=name)
        db.add(p)
        db.flush()
        db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.h_shop.id, global_product_id=p.id, is_listed=True))
        return p

    world.F1, world.F2 = product("Burger"), product("Fries")
    world.food = food
    world.drinks = world.P.category_id
    world.bar = bar
    # Today: the shop's tills have an interleaved flat list and a category order; the shop's kiosks
    # a map; one till its own list.
    P, Q, F1, F2 = (str(x.id) for x in (world.P, world.Q, world.F1, world.F2))
    world.h_shop.settings = {"productOrder": [F2, Q, F1, P], "categoryOrder": [str(food.id), str(world.drinks)], "other": 1}
    world.h1.settings = {"productOrder": [P, Q]}
    db.add(KioskSettings(id=uuid.uuid4(), tenant_id=world.tid, level="shop", shop_id=world.h_shop.id,
                         overrides={"catalog": {"categoryOrder": [str(world.drinks)], "productOrder": {str(world.drinks): [Q, P]},
                                                "hiddenProducts": [F2]}}))
    db.commit()
    return world


def _device_view(w):
    """What the tills and the kiosk read: the merged settings of each till, the kiosk layers' keys."""
    from app.models.company import Company

    company = w.db.get(Company, w.h_shop.company_id)
    out = {}
    for m in (w.h1, w.h2, w.a1):
        area = w.db.get(ShopArea, m.area_id) if m.area_id else None
        shop = w.db.get(type(w.h_shop), m.shop_id)
        merged = merge_all_settings_layers(company if m.shop_id == w.h_shop.id else w.db.get(Company, shop.company_id), shop, None, m, area)
        out[str(m.id)] = {k: merged.get(k) for k in ("productOrder", "categoryOrder")}
    out["kiosk"] = [deepcopy(r.overrides) for r in w.db.query(KioskSettings).order_by(KioskSettings.level).all()]
    return out


def _run_migration(w):
    spec = importlib.util.spec_from_file_location("m701a25694d3c", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    w.db.commit()
    with w.db.get_bind().begin() as conn:
        made = module.materialize(conn)
    w.db.expire_all()
    return made


class TestMigration:
    def test_it_records_each_level_and_writes_nothing_a_device_reads(self, ow):
        before = _device_view(ow)
        settings_before = deepcopy(ow.h_shop.settings)
        assert _run_migration(ow) == 3, "the shop's tills, one till, the shop's kiosks"
        assert _device_view(ow) == before
        assert ow.db.get(type(ow.h_shop), ow.h_shop.id).settings == settings_before
        rows = {(b.level, b.channel): b for b in ow.db.query(DisplayOrderingBinding).all()}
        assert set(rows) == {("shop", "pos"), ("machine", "pos"), ("shop", "kiosk")}
        assert len({b.ordering_id for b in rows.values()}) == 3, "nothing linked"
        shop_pos = ow.db.get(DisplayOrdering, rows[("shop", "pos")].ordering_id)
        P, Q, F1, F2 = (str(x.id) for x in (ow.P, ow.Q, ow.F1, ow.F2))
        assert shop_pos.products == {str(ow.food.id): [F2, F1], str(ow.drinks): [Q, P]}
        assert shop_pos.legacy_flat == [F2, Q, F1, P]
        # Run again: nothing more.
        assert _run_migration(ow) == 0

    def test_the_service_reads_the_same_as_the_migration(self, ow):
        made = DO.materialize_legacy(ow.db, ow.tid)
        ow.db.commit()
        assert made == 3
        shop_pos = DO.binding_at(ow.db, ow.tid, "shop", ow.h_shop.id, "pos")
        assert DO.content_of(ow.db.get(DisplayOrdering, shop_pos.ordering_id))["products"][str(ow.food.id)] == [
            str(ow.F2.id), str(ow.F1.id),
        ]

    def test_the_view_says_where_the_order_comes_from(self, ow):
        h1 = DO.resolve_target(ow.db, "machine", ow.h1.id, ow.tid)
        view = DO.resolve_view(ow.db, "pos", h1)
        assert view["source"] == {"level": "machine", "targetId": str(ow.h1.id), "kind": "legacy"}
        assert view["ordering"]["implicit"] is True
        # The till's flat list wins whole; the categories come from the shop.
        assert view["effective"]["categories"] == [str(ow.food.id), str(ow.drinks)]
        assert view["effective"]["products"] == {str(ow.drinks): [str(ow.P.id), str(ow.Q.id)]}


class TestLinking:
    def _shop(self, w):
        return DO.resolve_target(w.db, "shop", w.h_shop.id, w.tid)

    def test_linked_levels_move_together_and_the_devices_get_it(self, ow):
        shop = self._shop(ow)
        DO.link(ow.db, shop, "kiosk", shop, "pos")
        ow.db.commit()
        view = DO.resolve_view(ow.db, "kiosk", shop)
        assert view["linkedLabel"] == "מקושר לקופה (H shop)"
        # The kiosk layer now has the tills' order; its own hide list is untouched.
        layer = DO._kiosk_row(ow.db, "shop", ow.h_shop.id).overrides["catalog"]
        assert layer["productOrder"] == {str(ow.food.id): [str(ow.F2.id), str(ow.F1.id)], str(ow.drinks): [str(ow.Q.id), str(ow.P.id)]}
        assert layer["hiddenProducts"] == [str(ow.F2.id)]
        # Saving from the kiosk's side reorders the tills too.
        ordering = view["ordering"]
        content = {**ordering, "products": {**ordering["products"], str(ow.food.id): [str(ow.F1.id), str(ow.F2.id)]}}
        wake = DO.save(ow.db, shop, "kiosk", content, version=ordering["version"])
        DO.wake_after_commit(ow.db, wake)
        ow.db.commit()
        settings = ow.db.get(type(ow.h_shop), ow.h_shop.id).settings
        P, Q, F1, F2 = (str(x.id) for x in (ow.P, ow.Q, ow.F1, ow.F2))
        assert settings["productOrder"] == [F1, Q, F2, P], "Food re-slotted into its places, Drinks kept"
        assert settings["other"] == 1
        assert {str(ow.h1.id), str(ow.h2.id)} <= set(ow.signals), "the tills and the kiosk are woken after the commit"

    def test_a_kiosk_layer_wakes_kiosks_not_a_tills_kiosk_mode_row(self, ow):
        # Integration (10.10.2026): every kiosk query keeps `home_role IS NULL`; a till in kiosk mode ("מצב עבודה")
        # has a KioskDevice row with home_role "till" and stays a till.
        ow.db.add(KioskDevice(machine_id=ow.h1.id, tenant_id=ow.tid, shop_id=ow.h_shop.id, name="Till in kiosk mode",
                              enabled=True, home_role="till"))
        ow.db.commit()
        woken = DO.devices_of(ow.db, DO.Wake(pos=[], kiosks=[("shop", str(ow.h_shop.id)), ("machine", str(ow.h1.id))]))
        assert {m for _t, m in woken} == {str(ow.h2.id)}

    def test_unlink_keeps_the_positions(self, ow):
        shop = self._shop(ow)
        DO.link(ow.db, shop, "kiosk", shop, "pos")
        ow.db.commit()
        before = DO.resolve_view(ow.db, "kiosk", shop)["effective"]
        DO.unlink(ow.db, shop, "kiosk")
        ow.db.commit()
        after = DO.resolve_view(ow.db, "kiosk", shop)
        assert after["effective"] == before
        assert after["linkedWith"] == [] and after["binding"]["copiedFromOrderingId"] is not None
        pos = DO.binding_at(ow.db, ow.tid, "shop", ow.h_shop.id, "pos")
        assert str(pos.ordering_id) != after["binding"]["orderingId"]

    def test_copy_once_has_no_link_after(self, ow):
        shop = self._shop(ow)
        bar = DO.resolve_target(ow.db, "area", ow.bar.id, ow.tid)
        DO.copy_from(ow.db, bar, "online", shop, "kiosk")
        ow.db.commit()
        view = DO.resolve_view(ow.db, "online", bar)
        assert view["effective"]["products"][str(ow.drinks)] == [str(ow.Q.id), str(ow.P.id)]
        assert view["linkedWith"] == []
        # A later kiosk change does not reach it.
        kiosk = DO.resolve_view(ow.db, "kiosk", shop)
        DO.save(ow.db, shop, "kiosk", {"products": {str(ow.drinks): [str(ow.P.id), str(ow.Q.id)]}}, version=None)
        ow.db.commit()
        assert DO.resolve_view(ow.db, "online", bar)["effective"]["products"][str(ow.drinks)] == [str(ow.Q.id), str(ow.P.id)]
        assert kiosk is not None

    def test_two_editors_one_wins_the_other_is_told(self, ow):
        shop = self._shop(ow)
        DO.save(ow.db, shop, "online", {"categories": [str(ow.drinks)]}, version=None)
        ow.db.commit()
        v = DO.resolve_view(ow.db, "online", shop)["ordering"]["version"]
        DO.save(ow.db, shop, "online", {"categories": [str(ow.food.id)]}, version=v)
        ow.db.commit()
        with pytest.raises(HTTPException) as e:
            DO.save(ow.db, shop, "online", {"categories": []}, version=v)
        assert e.value.status_code == 409 and e.value.detail["code"] == "ordering_changed"


class TestOlderWritePoints:
    def test_a_tills_edit_mode_reaches_the_kiosk_it_is_linked_with(self, ow):
        shop = DO.resolve_target(ow.db, "shop", ow.h_shop.id, ow.tid)
        DO.link(ow.db, shop, "kiosk", shop, "pos")
        ow.db.commit()
        P, Q, F1, F2 = (str(x.id) for x in (ow.P, ow.Q, ow.F1, ow.F2))
        body = sync_router.ProductOrderIn(scope="shop", productIds=[P, F1, Q, F2])
        sync_router.machine_set_product_order(str(ow.h1.id), body, machine=ow.h1,
                                              actor=CatalogActor(pos_user_id=uuid.uuid4()), db=ow.db)
        layer = DO._kiosk_row(ow.db, "shop", ow.h_shop.id).overrides["catalog"]
        assert layer["productOrder"][str(ow.drinks)] == [P, Q]
        assert layer["productOrder"][str(ow.food.id)] == [F1, F2]
        # The till's own level was cleared by the shop save: it inherits now (no binding kept for it).
        assert DO.binding_at(ow.db, ow.tid, "machine", ow.h1.id, "pos") is None

    def test_a_till_that_is_not_bound_writes_as_before(self, ow):
        P, Q = str(ow.P.id), str(ow.Q.id)
        body = sync_router.ProductOrderIn(scope="machine", productIds=[Q, P])
        sync_router.machine_set_product_order(str(ow.h1.id), body, machine=ow.h1,
                                              actor=CatalogActor(pos_user_id=uuid.uuid4()), db=ow.db)
        assert ow.h1.settings["productOrder"] == [Q, P]
        assert ow.db.query(DisplayOrderingBinding).count() == 0


class TestRouter:
    def test_save_and_view_with_the_catalog(self, ow):
        user = ow.users.h_manager
        body = router.SaveIn.model_validate({
            "channel": "menu", "level": "shop", "targetId": str(ow.h_shop.id),
            "ordering": {"products": {str(ow.food.id): [str(ow.F2.id), str(ow.F1.id)]},
                         "pinned": {"products": {str(ow.food.id): [str(ow.F1.id)]}}},
        })
        router.put_view(body, current_user=user, active_tenant_id=ow.tid, db=ow.db)
        view = router.get_view(channel="menu", level="shop", target_id=str(ow.h_shop.id), include_catalog=True,
                               current_user=user, active_tenant_id=ow.tid, db=ow.db)
        assert view["arranged"]["products"][str(ow.food.id)] == [str(ow.F1.id), str(ow.F2.id)], "pinned first"

    def test_another_companys_manager_is_refused(self, ow):
        with pytest.raises(HTTPException) as e:
            router.get_view(channel="pos", level="shop", target_id=str(ow.h_shop.id), include_catalog=False,
                            current_user=ow.users.b_manager, active_tenant_id=ow.tid, db=ow.db)
        assert e.value.status_code == 403

    def test_a_kiosk_has_no_point_of_sale_level(self, ow):
        with pytest.raises(HTTPException) as e:
            router.get_view(channel="kiosk", level="area", target_id=str(ow.bar.id), include_catalog=False,
                            current_user=ow.users.admin, active_tenant_id=ow.tid, db=ow.db)
        assert e.value.status_code == 422
