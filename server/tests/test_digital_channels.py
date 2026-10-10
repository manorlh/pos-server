"""
"מופיע ב" — four channels on a product (app/services/product_channels.py,
app/routers/product_channels.py, specs/digital-menu-ordering-cards-plan.md §4.2).

What could look right and still be wrong:

* a till or a kiosk of today being sent a different `salesChannel` than before — every stored
  code is sent as itself, to both kinds of device, live and from a publication;
* the new pair "neither tills nor kiosks" reaching a device as a code it reads as "everywhere";
* the web channels starting on (new exposure must start as a draft);
* an exception of one shop reaching another shop's devices, or a delta pull missing it;
* the bulk screen's "all matching" acting only on the loaded page, or silently skipping products
  the caller may not edit.

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.database import Base
from app.models.kiosk import KioskDevice
from app.models.product import CatalogLevel, Product
from app.models.product_channel_override import ProductChannelOverride
from app.models.shop_area import ShopArea
from app.routers import product_channels as R
from app.routers import products as products_router
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.services import product_channels as PC
from app.services import sales_channel as SC
from app.services import sync as S

from test_product_availability import world  # noqa: F401

LEGACY = ("all", "kiosk_only", "pos_only")


# ── The rule ─────────────────────────────────────────────────────────────────


class TestRule:
    def test_every_older_code_is_sent_as_itself_to_tills_and_kiosks(self):
        for code in LEGACY:
            for kiosk in (False, True):
                assert PC.device_code(code, kiosk) == code
        # A row before the column, or a stray value: everywhere, as before.
        for stray in (None, "", "web"):
            assert PC.device_code(stray, False) == "all" and PC.device_code(stray, True) == "all"

    def test_neither_is_hidden_on_the_device_that_reads_it(self):
        assert PC.device_code("none", False) == "kiosk_only", "a till hides kiosk_only"
        assert PC.device_code("none", True) == "pos_only", "a kiosk hides pos_only"
        assert PC.device_code("all", True, (False, False)) == "pos_only"

    def test_the_pair_and_the_code(self):
        assert [PC.pair_of(c) for c in LEGACY + ("none",)] == [(True, True), (False, True), (True, False), (False, False)]
        for code in LEGACY + ("none",):
            assert SC.code_of_pair(*PC.pair_of(code)) == code

    def test_web_channels_start_off(self):
        p = SimpleNamespace(sales_channel="all", channel_online=False, channel_menu=False)
        assert PC.of(p) == {"pos": True, "kiosk": True, "online": False, "menu": False}
        legacy_row = SimpleNamespace(sales_channel="kiosk_only")  # no web columns read yet
        assert PC.of(legacy_row) == {"pos": False, "kiosk": True, "online": False, "menu": False}

    def test_apply_changes_only_what_is_sent(self):
        p = SimpleNamespace(sales_channel="all", channel_online=False, channel_menu=False)
        assert PC.apply(p, {"online": True}) == ["online"]
        assert (p.sales_channel, p.channel_online, p.channel_menu) == ("all", True, False)
        assert PC.apply(p, {"pos": False, "kiosk": False}) == ["pos", "kiosk"]
        assert p.sales_channel == "none" and p.channel_online is True
        assert PC.apply(p, {"pos": False}) == []

    def test_the_nearest_exception_wins_and_null_says_nothing(self):
        shop, area, other = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        rows = [
            {"level": "shop", "targetId": shop, "channel": "kiosk", "allowed": False},
            {"level": "area", "targetId": area, "channel": "kiosk", "allowed": True},
            {"level": "shop", "targetId": shop, "channel": "online", "allowed": None},
            {"level": "shop", "targetId": other, "channel": "pos", "allowed": False},
        ]
        defaults = {"pos": True, "kiosk": True, "online": True, "menu": False}
        at_shop = PC.resolve(defaults, rows, shop_id=shop)
        assert (at_shop["kiosk"].allowed, at_shop["kiosk"].source) == (False, "shop")
        assert (at_shop["online"].allowed, at_shop["online"].source) == (True, "product")
        assert at_shop["pos"].allowed is True, "another shop's exception is not this shop's"
        at_area = PC.resolve(defaults, rows, shop_id=shop, area_id=area)
        assert (at_area["kiosk"].allowed, at_area["kiosk"].source) == (True, "area")

    def test_the_sheet_reads_back_what_it_writes(self):
        assert SC.code_of(SC.label("none")) == "none"
        for code in LEGACY:
            assert SC.code_of(SC.label(code)) == code
        assert SC.on_pos("none") is False and SC.on_kiosk("none") is False


class TestSchemas:
    BASE = {"name": "במבה", "price": "1.00", "sku": "K-1", "categoryId": str(uuid.uuid4())}

    def test_channels_are_validated(self):
        assert ProductCreate.model_validate({**self.BASE, "channels": {"online": True}}).appears_in == {"online": True}
        for bad in ({"web": True}, {"online": "yes"}, ["online"]):
            with pytest.raises(Exception):
                ProductCreate.model_validate({**self.BASE, "channels": bad})
        assert "appears_in" not in ProductUpdate.model_validate({"channels": {"menu": True}}).model_dump(exclude_unset=True)


# ── On a real session ────────────────────────────────────────────────────────


@pytest.fixture
def cw(world, monkeypatch):  # noqa: F811
    """h1 a till in point of sale "Bar", h2 a kiosk, both in h_shop; a1 a till in a_shop."""
    db = world.db
    for name in ("kiosk_devices", "product_channel_overrides", "sync_logs"):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    PC._READY.clear()
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    db.add(KioskDevice(machine_id=world.h2.id, tenant_id=world.tid, shop_id=world.h_shop.id, name="Kiosk", enabled=True))
    db.commit()
    world.bar = bar
    world.woken = []
    monkeypatch.setattr(R, "notify_all_machines_for_tenant", lambda _db, tid, reason: world.woken.append(("tenant", tid)))
    monkeypatch.setattr(R, "notify_machines_for_shop", lambda _db, sid, reason: world.woken.append(("shop", sid)))
    return world


def _row(w, machine, product=None, since=None):
    product = product or w.P
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


class TestWhatDevicesAreSent:
    @pytest.mark.parametrize("code", LEGACY)
    def test_no_change_for_any_existing_code_on_a_till_or_a_kiosk(self, cw, code):
        cw.P.sales_channel = code
        cw.db.commit()
        before = {k: v for k, v in _row(cw, cw.h1).items() if k != "updatedAt"}
        assert before["salesChannel"] == code
        assert _row(cw, cw.h2)["salesChannel"] == code
        assert _row(cw, cw.a1)["salesChannel"] == code
        # The web switches change nothing a device reads.
        PC.apply(cw.P, {"online": True, "menu": True})
        cw.db.commit()
        after = {k: v for k, v in _row(cw, cw.h1).items() if k != "updatedAt"}
        assert after == before, "the row a till reads is the same (only its stamp moves: the product was edited)"
        assert not ({"channels", "channelOnline", "channelMenu"} & set(after))

    def test_neither_reaches_each_device_as_hidden_there(self, cw):
        PC.apply(cw.P, {"pos": False, "kiosk": False, "online": True})
        cw.db.commit()
        assert _row(cw, cw.h1)["salesChannel"] == "kiosk_only"
        assert _row(cw, cw.h2)["salesChannel"] == "pos_only"

    def test_an_exception_reaches_its_shop_only_and_a_delta_carries_it(self, cw):
        since = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert _row(cw, cw.h2, since=since) is None, "nothing changed yet"
        R.put_product_channels(
            str(cw.P.id),
            R.ProductChannelsIn.model_validate({"overrides": [
                {"level": "shop", "targetId": str(cw.h_shop.id), "channel": "kiosk", "allowed": False},
            ]}),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        assert _row(cw, cw.h2, since=since)["salesChannel"] == "pos_only", "the kiosk hides it, in the delta"
        assert _row(cw, cw.h1)["salesChannel"] == "pos_only", "the till of that shop reads the same pair"
        assert _row(cw, cw.a1)["salesChannel"] == "all", "another shop is untouched"
        assert ("shop", str(cw.h_shop.id)) in cw.woken
        # The point of sale lets the till's area have it back on the kiosk channel — the kiosk is not in it.
        R.put_product_channels(
            str(cw.P.id),
            R.ProductChannelsIn.model_validate({"overrides": [
                {"level": "area", "targetId": str(cw.bar.id), "channel": "kiosk", "allowed": True},
            ]}),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        assert _row(cw, cw.h1)["salesChannel"] == "all"
        assert _row(cw, cw.h2)["salesChannel"] == "pos_only"
        # Let go: back to the default, and the delta still sees it.
        since = datetime.now(timezone.utc) - timedelta(milliseconds=1)
        R.put_product_channels(
            str(cw.P.id),
            R.ProductChannelsIn.model_validate({"overrides": [
                {"level": "shop", "targetId": str(cw.h_shop.id), "channel": "kiosk", "allowed": None},
            ]}),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        assert _row(cw, cw.h2, since=since)["salesChannel"] == "all"

    def test_a_publications_rows_are_projected_not_changed(self, cw):
        rows = [{"globalProductId": str(cw.P.id), "salesChannel": "none"}]
        out = PC.project_rows(cw.db, cw.h2, rows)
        assert out[0]["salesChannel"] == "pos_only" and rows[0]["salesChannel"] == "none"


class TestDashboard:
    def test_create_starts_with_the_web_channels_off_and_reads_back_four(self, cw, monkeypatch):
        monkeypatch.setattr(products_router, "_trigger_catalog_notify", lambda *a, **k: None)
        monkeypatch.setattr(products_router, "allocate_global_sku", lambda *a, **k: "100001")
        monkeypatch.setattr(products_router, "resolve_sku_for_create", lambda db, tenant, sku: (sku, False))
        made = products_router.create_product(
            ProductCreate.model_validate({
                "name": "מאפה", "price": "9", "sku": "M-1", "categoryId": str(cw.P.category_id),
                "companyId": str(cw.H.id), "salesChannel": "kiosk_only",
            }),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        out = ProductResponse.model_validate(made).model_dump(by_alias=True)
        assert out["channels"] == {"pos": False, "kiosk": True, "online": False, "menu": False}
        assert out["salesChannel"] == "kiosk_only"
        updated = products_router.update_product(
            str(made.id), ProductUpdate.model_validate({"channels": {"menu": True, "pos": True}}),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        out = ProductResponse.model_validate(updated).model_dump(by_alias=True)
        assert out["channels"] == {"pos": True, "kiosk": True, "online": False, "menu": True}
        assert out["salesChannel"] == "all"

    def test_the_view_lists_exceptions_with_their_source(self, cw):
        view = R.put_product_channels(
            str(cw.P.id),
            R.ProductChannelsIn.model_validate({
                "channels": {"online": True},
                "overrides": [{"level": "area", "targetId": str(cw.bar.id), "channel": "online", "allowed": False}],
            }),
            current_user=cw.users.admin, active_tenant_id=cw.tid, db=cw.db,
        )
        assert view["channels"]["online"] is True
        (o,) = view["overrides"]
        assert (o["level"], o["targetName"], o["shopName"], o["allowed"]) == ("area", "Bar", "H shop", False)
        (eff,) = view["effective"]
        assert eff["channels"]["online"] == {"allowed": False, "source": "area"}
        assert eff["channels"]["pos"] == {"allowed": True, "source": "product"}
        assert ("tenant", str(cw.tid)) in cw.woken, "a default change wakes every device"

    def test_another_companys_shop_is_refused_whole(self, cw):
        with pytest.raises(HTTPException) as e:
            R.put_product_channels(
                str(cw.P.id),
                R.ProductChannelsIn.model_validate({
                    "channels": {"menu": True},
                    "overrides": [{"level": "shop", "targetId": str(cw.b_shop.id), "channel": "pos", "allowed": False}],
                }),
                current_user=cw.users.h_manager, active_tenant_id=cw.tid, db=cw.db,
            )
        assert e.value.status_code == 403
        cw.db.rollback()
        assert cw.db.get(Product, cw.P.id).channel_menu is False, "nothing of the request was kept"
        assert cw.db.query(ProductChannelOverride).count() == 0

    def test_list_filters_by_channel(self, cw):
        PC.apply(cw.Q, {"online": True})
        cw.db.commit()
        page = products_router.list_products(
            page=1, page_size=100, company_id=None, shop_id=None, pos_machine_id=None, category_id=None,
            catalog_level=None, in_stock=None, search=None, current_user=cw.users.admin,
            active_tenant_id=cw.tid, db=cw.db, channel_on=["online"],
        )
        assert [p.id for p in page.items] == [cw.Q.id]
        page = products_router.list_products(
            page=1, page_size=100, company_id=None, shop_id=None, pos_machine_id=None, category_id=None,
            catalog_level=None, in_stock=None, search=None, current_user=cw.users.admin,
            active_tenant_id=cw.tid, db=cw.db, channel_off=["online"],
        )
        assert cw.Q.id not in [p.id for p in page.items]


class TestBulk:
    def _bulk(self, cw, user, body):
        return R.bulk_product_channels(R.BulkIn.model_validate(body), current_user=user, active_tenant_id=cw.tid, db=cw.db)

    def test_all_matching_runs_on_the_server_and_dry_run_changes_nothing(self, cw):
        for i in range(30):
            cw.db.add(Product(
                id=uuid.uuid4(), tenant_id=cw.tid, company_id=cw.H.id, category_id=cw.P.category_id,
                name=f"Extra {i:02d}", price=5, sku=f"X-{i}", catalog_level=CatalogLevel.GLOBAL,
            ))
        cw.db.commit()
        body = {"selection": {"allMatching": {"search": "Extra"}}, "set": {"online": True}, "dryRun": True}
        got = self._bulk(cw, cw.users.admin, body)
        assert (got["matched"], got["changed"], got["applied"]) == (30, 30, False)
        assert len(got["sample"]) == R.SAMPLE_SIZE
        assert cw.db.query(Product).filter(Product.channel_online.is_(True)).count() == 0
        got = self._bulk(cw, cw.users.admin, {**body, "dryRun": False})
        assert got["applied"] is True and got["changed"] == 30
        assert cw.db.query(Product).filter(Product.channel_online.is_(True)).count() == 30
        again = self._bulk(cw, cw.users.admin, {**body, "dryRun": False})
        assert (again["changed"], again["unchanged"]) == (0, 30)

    def test_products_the_caller_may_not_edit_are_reported(self, cw):
        other = Product(
            id=uuid.uuid4(), tenant_id=cw.tid, company_id=cw.B.id, category_id=cw.P.category_id,
            name="Beta only", price=5, sku="B-1", catalog_level=CatalogLevel.GLOBAL,
        )
        cw.db.add(other)
        cw.db.commit()
        got = self._bulk(cw, cw.users.h_manager, {
            "selection": {"ids": [str(cw.P.id), str(other.id), str(uuid.uuid4())]},
            "set": {"menu": True}, "dryRun": False,
        })
        assert (got["changed"], got["refused"]) == (1, 2)
        assert {r["reason"] for r in got["refusedSample"]} == {"not_yours", "not_found"}
        assert cw.db.get(Product, other.id).channel_menu is False
        assert cw.db.get(Product, cw.P.id).channel_menu is True
