"""Cover for a catalog per till: "all shop products" (as before) or a whitelist of them.

The rule: in "selected" mode a till shows only the products on its list that its shop
also sells; locks still apply on top; the general item is exempt; a product the shop
adds later is not added to anyone's list. Each test names a way this could look as if
it worked while doing damage:

* an existing till changing behaviour on upgrade (anything but "all" by default);
* a change that is saved in the cloud and never reaches a till pulling deltas, or a
  removal that vanishes instead of being re-sent;
* the general item disappearing from a "selected" till, taking the calculator with it;
* a list that can name another company's or another tenant's product, or be written
  by somebody who may not manage that till — the cross-company gaps past audits found.

Runs on the in-memory SQLite world of tests/test_product_availability.py — local,
private to the test, and never the configured database.
"""
from __future__ import annotations

import importlib.util
import io
import os
import pathlib
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, text

from app.main import app
from app.middleware.auth import CatalogActor, require_catalog_authority
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import MachineProductOverride
from app.models.shop_product_override import ShopProductOverride
from app.models.tenant import Tenant
from app.routers import machine_catalog as R
from app.routers import machines as machines_router
from app.routers import product_availability as availability_router
from app.routers import sync as sync_router
from app.schemas.machine_catalog import MachineCatalogSet
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.product_availability import AvailabilitySet
from app.services import machine_catalog as M
from app.services import sync as S
from app.services.permissions import Scope

from test_product_availability import OLD, SINCE, world  # noqa: F401


# ── A few more rows on the availability world ────────────────────────────────


@pytest.fixture
def w(world, monkeypatch):  # noqa: F811
    """
    The availability world (P and Q are H's, both in h_shop, P also in a_shop), plus:

    * R — company B's product, sold only in b_shop;
    * G — H's general item, in h_shop;
    * a second tenant with its own shop, till and product X.
    """
    db = world.db
    category_id = world.P.category_id
    # The till's write is audited; the availability world has no audit table.
    from app.database import Base

    for name in ("sync_logs", "shop_category_overrides"):  # audit; the full catalog pull
        Base.metadata.tables[name].create(db.get_bind())

    def product(name, sku, company, tenant_id=world.tid, general=False):
        p = Product(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=company, category_id=category_id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=Decimal("5.00"), sku=sku,
            is_available=True, is_general=general, is_open_price=general,
            updated_at=OLD, created_at=OLD,
        )
        db.add(p)
        return p

    def assign(p, shop):
        db.add(ShopProductOverride(
            id=uuid.uuid4(), shop_id=shop.id, global_product_id=p.id,
            is_listed=True, is_available=None, updated_at=OLD,
        ))

    R_ = product("Beta bread", "10", world.B.id)
    G = product("פריט כללי", "99", world.H.id, general=True)
    db.flush()
    assign(R_, world.b_shop)
    assign(G, world.h_shop)

    from app.models.company import Company
    from app.models.shop import Shop

    other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other")
    db.add(other_tenant)
    db.flush()
    other_company = Company(id=uuid.uuid4(), tenant_id=other_tenant.id, name="Other Co")
    db.add(other_company)
    db.flush()
    other_shop = Shop(
        id=uuid.uuid4(), tenant_id=other_tenant.id, company_id=other_company.id,
        name="Other shop", settings={},
    )
    db.add(other_shop)
    db.flush()
    other_till = POSMachine(
        id=uuid.uuid4(), tenant_id=other_tenant.id, shop_id=other_shop.id,
        distributor_id=uuid.uuid4(), name="x1", machine_code="OTHER-1", pos_number="1",
        is_active=True, last_sync_at=OLD,
    )
    db.add(other_till)
    X = product("Foreign", "20", other_company.id, tenant_id=other_tenant.id)
    db.flush()
    assign(X, other_shop)
    db.commit()

    notified: list = []
    monkeypatch.setattr(
        M, "notify_machine_catalog_changed",
        lambda tid, mid, reason: notified.append((str(mid), reason)),
    )
    world.R, world.G, world.X = R_, G, X
    world.other_tenant, world.other_shop, world.other_till = other_tenant, other_shop, other_till
    world.catalog_notified = notified
    return world


def _sync(w, machine, since=None):
    rows = S.get_products_for_sync(w.db, str(machine.tenant_id), str(machine.id), since=since)
    return {r["globalProductId"]: r for r in rows}


def _on_till(w, machine):
    """What the till shows: the shop's rows through the till's own rule, as the till applies it."""
    mode = S.machine_catalog_for_sync(machine)["mode"]
    return {
        pid for pid, r in _sync(w, machine).items()
        if r["shopListed"] and M.on_till(mode, r["inMachineCatalog"], r["isGeneral"])
    }


def _put(w, machine, mode, ids, user=None, tenant=None):
    return R.set_machine_catalog(
        str(machine.id), MachineCatalogSet(mode=mode, productIds=[str(i) for i in ids]),
        current_user=user or w.users.admin, active_tenant_id=tenant or w.tid, db=w.db,
    )


def _get(w, machine, user=None, tenant=None):
    return R.get_machine_catalog(
        str(machine.id), current_user=user or w.users.admin,
        active_tenant_id=tenant or w.tid, db=w.db,
    )


def _age(w):
    for model in (ShopProductOverride, MachineProductOverride, MachineCatalogItem, Product):
        for row in w.db.query(model).all():
            row.updated_at = OLD
    for m in w.db.query(POSMachine).all():
        if m.catalog_mode_updated_at is not None:
            m.catalog_mode_updated_at = OLD
    w.db.commit()


def _rows(w):
    w.db.expire_all()
    return sorted(
        (str(r.machine_id), str(r.product_id), r.is_included)
        for r in w.db.query(MachineCatalogItem).all()
    )


def _modes(w):
    w.db.expire_all()
    return {m.name: m.catalog_mode for m in w.db.query(POSMachine).all()}


# ── The rule itself ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "mode, included, general, expected",
    [
        ("all", False, False, True),
        ("all", True, False, True),
        ("selected", True, False, True),
        ("selected", False, False, False),
        ("selected", False, True, True),   # the general item is exempt
        ("all", False, True, True),
        ("bogus", False, False, True),     # unknown mode fails open to "all"
    ],
)
def test_the_rule(mode, included, general, expected):
    assert M.on_till(mode, included, general) is expected


def test_an_unknown_or_missing_mode_reads_as_all():
    assert M.mode_of(SimpleNamespace(catalog_mode=None)) == "all"
    assert M.mode_of(SimpleNamespace(catalog_mode="weird")) == "all"
    assert M.mode_of(SimpleNamespace(catalog_mode="selected")) == "selected"


# ── Default: nothing changes for existing tills ──────────────────────────────


class TestDefault:
    def test_every_till_starts_in_all_mode_and_sells_the_whole_shop(self, w):
        assert set(_modes(w).values()) == {"all"}
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.Q.id), str(w.G.id)}
        assert S.machine_catalog_for_sync(w.h1) == {"mode": "all", "updatedAt": None}

    def test_rows_carry_the_flag_even_in_all_mode(self, w):
        rows = _sync(w, w.h1)
        assert all("inMachineCatalog" in r for r in rows.values())
        assert rows[str(w.P.id)]["inMachineCatalog"] is False

    def test_the_model_defaults_to_all(self):
        col = POSMachine.__table__.c.catalog_mode
        assert col.server_default.arg == "all" and col.nullable is False


# ── Selected mode on the till ────────────────────────────────────────────────


class TestSelectedMode:
    def test_only_listed_products_of_the_shop_and_the_general_item(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.G.id)}
        assert _on_till(w, w.h2) == {str(w.P.id), str(w.Q.id), str(w.G.id)}, "the other till is untouched"

    def test_the_general_item_is_never_stored_on_a_list(self, w):
        _put(w, w.h1, "selected", [w.Q.id, w.G.id])
        assert _rows(w) == [(str(w.h1.id), str(w.Q.id), True)]
        assert str(w.G.id) in _on_till(w, w.h1)

    def test_an_empty_list_shows_only_the_general_item(self, w):
        _put(w, w.h1, "selected", [])
        assert _on_till(w, w.h1) == {str(w.G.id)}

    def test_a_lock_still_applies_on_top(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        availability_router.set_machine_availability(
            str(w.P.id), str(w.h1.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        row = _sync(w, w.h1)[str(w.P.id)]
        assert row["inMachineCatalog"] is True and row["isAvailable"] is False
        assert str(w.P.id) in _on_till(w, w.h1), "locked means dimmed, not hidden"

    def test_a_listed_product_the_shop_stops_selling_is_gone(self, w):
        _put(w, w.h1, "selected", [w.P.id, w.Q.id])
        w.db.query(ShopProductOverride).filter(
            ShopProductOverride.shop_id == w.h_shop.id,
            ShopProductOverride.global_product_id == w.Q.id,
        ).delete()
        w.db.commit()
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.G.id)}
        assert M.is_on_till(w.db, w.h1, w.Q) is False
        assert M.is_on_till(w.db, w.h1, w.P) is True

    def test_a_product_new_to_the_shop_is_not_added_to_a_selected_till(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        # R starts being sold in h_shop too.
        w.db.add(ShopProductOverride(
            id=uuid.uuid4(), shop_id=w.h_shop.id, global_product_id=w.R.id,
            is_listed=True, is_available=None,
        ))
        w.db.commit()
        assert str(w.R.id) not in _on_till(w, w.h1)
        assert str(w.R.id) in _on_till(w, w.h2), "an 'all' till picks it up as before"

    def test_switching_back_to_all_keeps_the_list(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        _put(w, w.h1, "all", [w.P.id])
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.Q.id), str(w.G.id)}
        _put(w, w.h1, "selected", [w.P.id])
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.G.id)}

    def test_removal_is_a_row_set_to_false_not_a_deletion(self, w):
        _put(w, w.h1, "selected", [w.P.id, w.Q.id])
        _put(w, w.h1, "selected", [w.P.id])
        assert _rows(w) == sorted([
            (str(w.h1.id), str(w.P.id), True), (str(w.h1.id), str(w.Q.id), False),
        ])

    def test_a_till_may_name_a_product_by_its_own_local_copy(self, w):
        # A catalog push gave h1 a machine-local copy of P; its pull sends the copy's id.
        copy = Product(
            id=uuid.uuid4(), tenant_id=w.tid, company_id=w.H.id, category_id=w.P.category_id,
            catalog_level=CatalogLevel.LOCAL, name="Cola", price=Decimal("10.00"), sku="1-h1",
            pos_machine_id=w.h1.id, global_product_id=w.P.id, is_available=True,
            updated_at=OLD, created_at=OLD,
        )
        w.db.add(copy)
        w.db.commit()
        assert _sync(w, w.h1)[str(w.P.id)]["id"] == str(copy.id)
        _till_put(w, w.h1, "selected", [copy.id])
        assert _rows(w) == [(str(w.h1.id), str(w.P.id), True)]
        assert _sync(w, w.h1)[str(w.P.id)]["inMachineCatalog"] is True
        # Another till cannot borrow h1's copy to reach P.
        _refused(w, lambda: _till_put(w, w.b1, "selected", [copy.id]), 404)

    def test_a_product_created_from_a_selected_till_is_put_on_its_list(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        assert M.include_product(w.db, w.h1, w.Q) is True
        w.db.commit()
        assert str(w.Q.id) in _on_till(w, w.h1)
        assert M.include_product(w.db, w.h2, w.Q) is False, "an 'all' till needs nothing"
        assert M.include_product(w.db, w.h1, w.G) is False, "never the general item"

    def test_the_till_create_endpoint_calls_it(self):
        source = pathlib.Path(sync_router.__file__).read_text(encoding="utf-8")
        body = source.split("def machine_create_cloud_product", 1)[1].split("@router", 1)[0]
        assert "machine_catalog.include_product(db, machine, product)" in body


# ── Reaching a till that pulls deltas ────────────────────────────────────────


class TestDelta:
    def test_an_added_product_is_resent_and_nothing_else(self, w):
        _age(w)
        assert _sync(w, w.h1, since=SINCE) == {}
        _put(w, w.h1, "selected", [w.P.id])
        rows = _sync(w, w.h1, since=SINCE)
        assert set(rows) == {str(w.P.id)}
        assert rows[str(w.P.id)]["inMachineCatalog"] is True

    def test_a_removed_product_is_resent_as_off_the_list(self, w):
        _put(w, w.h1, "selected", [w.P.id, w.Q.id])
        _age(w)
        _put(w, w.h1, "selected", [w.P.id])
        rows = _sync(w, w.h1, since=SINCE)
        assert set(rows) == {str(w.Q.id)}
        assert rows[str(w.Q.id)]["inMachineCatalog"] is False

    def test_saving_the_same_list_again_changes_and_wakes_nothing(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        _age(w)
        w.catalog_notified.clear()
        _put(w, w.h1, "selected", [w.P.id])
        assert _sync(w, w.h1, since=SINCE) == {}
        assert w.catalog_notified == []

    def test_the_other_tills_delta_is_untouched(self, w):
        _age(w)
        _put(w, w.h1, "selected", [w.P.id])
        assert _sync(w, w.h2, since=SINCE) == {}

    def test_the_mode_travels_on_every_pull(self, w, monkeypatch):
        monkeypatch.setattr(sync_router, "_ensure_shop_general_item", lambda *_a: None)
        _put(w, w.h1, "selected", [w.P.id])
        _age(w)
        for since in (None, SINCE.isoformat()):
            body = sync_router.get_catalog_sync(
                str(w.h1.id), since=since, machine=w.h1, db=w.db
            ).model_dump(by_alias=True)
            assert body["machineCatalog"]["mode"] == "selected"
        assert body["products"] == [], "a delta after nothing changed carries no rows, still the mode"


class TestWatermarkAndNotify:
    def _mark(self, w, machine):
        return S.get_catalog_change_watermark_for_machine(w.db, machine)

    def test_a_list_change_moves_that_till_only(self, w):
        _age(w)
        before = {m.name: self._mark(w, m) for m in (w.h1, w.h2)}
        _put(w, w.h1, "all", [w.P.id])
        assert self._mark(w, w.h1) > before["h1"]
        assert self._mark(w, w.h2) == before["h2"]

    def test_a_mode_change_alone_moves_it(self, w):
        _put(w, w.h1, "all", [w.P.id])
        _age(w)
        before = self._mark(w, w.h1)
        _put(w, w.h1, "selected", [w.P.id])
        assert self._mark(w, w.h1) > before
        assert S.machine_catalog_for_sync(w.h1)["updatedAt"] is not None

    def test_the_till_is_woken_on_a_change(self, w):
        _put(w, w.h1, "selected", [w.P.id])
        assert w.catalog_notified == [(str(w.h1.id), "machine_catalog")]


# ── Moving a till to another shop ────────────────────────────────────────────


class TestShopChange:
    def test_a_moved_till_goes_back_to_all_with_its_list_cleared(self, w, monkeypatch):
        _put(w, w.h1, "selected", [w.P.id, w.Q.id])

        def _set(_db, machine, shop_id):
            machine.shop_id = shop_id
            machine.pos_number = "9"

        monkeypatch.setattr(machines_router, "set_machine_shop", _set)
        monkeypatch.setattr(machines_router, "shop_belongs_to_company", lambda *_a: True)
        monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
        machines_router.update_machine(
            str(w.h1.id), POSMachineUpdate(shopId=w.a_shop.id), w.users.admin, w.tid, w.db
        )
        assert _modes(w)["h1"] == "all"
        assert all(not included for _m, _p, included in _rows(w))

    def test_reassigning_the_same_shop_keeps_it(self, w, monkeypatch):
        _put(w, w.h1, "selected", [w.P.id])
        monkeypatch.setattr(machines_router, "set_machine_shop", lambda _db, m, sid: None)
        monkeypatch.setattr(machines_router, "shop_belongs_to_company", lambda *_a: True)
        machines_router.update_machine(
            str(w.h1.id), POSMachineUpdate(shopId=w.h_shop.id), w.users.admin, w.tid, w.db
        )
        assert _modes(w)["h1"] == "selected"


# ── The dashboard: GET and PUT /machines/{id}/catalog ────────────────────────


class TestDashboard:
    def test_the_picture(self, w):
        _put(w, w.h1, "selected", [w.Q.id])
        availability_router.set_machine_availability(
            str(w.Q.id), str(w.h1.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        pic = _get(w, w.h1).model_dump(by_alias=True)
        assert (pic["mode"], pic["selectedCount"], pic["totalCount"]) == ("selected", 1, 2)
        assert pic["canEdit"] is True
        products = {p["name"]: p for p in pic["products"]}
        assert set(products) == {"Cola", "Soda"}, "the general item is not offered"
        assert (products["Soda"]["included"], products["Soda"]["available"], products["Soda"]["onTill"]) == (True, False, True)
        assert (products["Cola"]["included"], products["Cola"]["onTill"]) == (False, False)
        assert [c["name"] for c in pic["categories"]] == ["Drinks"]
        assert products["Cola"]["categoryName"] == "Drinks"

    def test_a_delisted_product_is_not_on_the_till_whatever_the_list(self, w):
        w.rows.p_h.is_listed = False
        w.db.commit()
        pic = _put(w, w.h1, "selected", [w.P.id]).model_dump(by_alias=True)
        cola = next(p for p in pic["products"] if p["name"] == "Cola")
        assert (cola["included"], cola["shopListed"], cola["onTill"]) == (True, False, False)

    def test_a_shop_manager_edits_their_own_till(self, w):
        pic = _put(w, w.h1, "selected", [w.P.id], user=w.users.h_shop_manager)
        assert pic.mode == "selected" and pic.selected_count == 1

    def test_a_company_manager_edits_a_subsidiarys_till(self, w):
        _put(w, w.a1, "selected", [w.P.id], user=w.users.h_manager)
        assert _modes(w)["a1"] == "selected"

    def test_a_cashier_may_look_but_not_edit(self, w):
        assert _get(w, w.h1, user=w.users.h_cashier).can_edit is False

    def test_the_body_is_checked(self):
        with pytest.raises(ValidationError):
            MachineCatalogSet.model_validate({"mode": "some", "productIds": []})
        with pytest.raises(ValidationError):
            MachineCatalogSet.model_validate({"productIds": []})
        assert MachineCatalogSet.model_validate({"mode": "all"}).product_ids == []

    def test_the_routes_are_mounted(self):
        mounted = {
            (method, route.path)
            for route in app.routes
            for method in (getattr(route, "methods", None) or ())
        }
        assert ("GET", "/api/v1/machines/{machine_id}/catalog") in mounted
        assert ("PUT", "/api/v1/machines/{machine_id}/catalog") in mounted


# ── Security: refused, and nothing written ───────────────────────────────────


def _refused(w, call, code):
    before = (_rows(w), _modes(w))
    w.catalog_notified.clear()
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == code, exc.value.detail
    w.db.rollback()
    assert (_rows(w), _modes(w)) == before, "a refused write must write nothing"
    assert w.catalog_notified == []


class TestSecurity:
    def test_another_companys_product_cannot_be_listed(self, w):
        # R is B's, sold only in b_shop: not in h1's shop, however it is asked for.
        _refused(w, lambda: _put(w, w.h1, "selected", [w.P.id, w.R.id]), 404)
        _refused(w, lambda: _put(w, w.h1, "selected", [w.R.id], user=w.users.h_shop_manager), 404)

    def test_another_tenants_product_cannot_be_listed(self, w):
        _refused(w, lambda: _put(w, w.h1, "selected", [w.X.id]), 404)

    def test_a_product_of_the_company_not_sold_in_that_shop_cannot_be_listed(self, w):
        _refused(w, lambda: _put(w, w.a1, "selected", [w.Q.id]), 404)  # Q is h_shop's only

    def test_a_made_up_id_cannot_be_listed(self, w):
        _refused(w, lambda: _put(w, w.h1, "selected", [uuid.uuid4()]), 404)

    def test_another_tenants_till_cannot_be_edited_or_read(self, w):
        _refused(w, lambda: _put(w, w.other_till, "selected", [w.X.id]), 403)
        with pytest.raises(HTTPException) as exc:
            _get(w, w.other_till)
        assert exc.value.status_code == 403

    def test_another_companys_till_cannot_be_edited(self, w):
        u = w.users
        _refused(w, lambda: _put(w, w.b1, "selected", [w.R.id], user=u.h_manager), 403)
        _refused(w, lambda: _put(w, w.b1, "selected", [w.R.id], user=u.a_manager), 403)
        _refused(w, lambda: _put(w, w.h1, "selected", [w.P.id], user=u.a_manager), 403)  # the parent's
        _refused(w, lambda: _put(w, w.h1, "selected", [w.P.id], user=u.b_manager), 403)

    def test_another_shops_manager_and_a_cashier_cannot_edit(self, w):
        u = w.users
        _refused(w, lambda: _put(w, w.h1, "selected", [w.P.id], user=u.a_shop_manager), 403)
        _refused(w, lambda: _put(w, w.h1, "selected", [w.P.id], user=u.h_cashier), 403)

    def test_another_companys_manager_cannot_read_it(self, w):
        with pytest.raises(HTTPException) as exc:
            _get(w, w.h1, user=w.users.b_manager)
        assert exc.value.status_code == 403

    def test_a_missing_till_is_404(self, w):
        with pytest.raises(HTTPException) as exc:
            R.set_machine_catalog(
                str(uuid.uuid4()), MachineCatalogSet(mode="all"),
                current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
            )
        assert exc.value.status_code == 404


# ── The till's own write: PUT /sync/{id}/machine-catalog ─────────────────────


def _till_put(w, machine, mode, ids):
    return sync_router.machine_set_own_catalog(
        str(machine.id), MachineCatalogSet(mode=mode, productIds=[str(i) for i in ids]),
        machine=machine, actor=CatalogActor(pos_user_id=uuid.uuid4()), db=w.db,
    )


class TestTillWrite:
    def test_a_till_sets_its_own_list(self, w):
        out = _till_put(w, w.h1, "selected", [w.P.id]).model_dump(by_alias=True)
        assert out == {"mode": "selected", "selectedCount": 1, "changed": True}
        assert _on_till(w, w.h1) == {str(w.P.id), str(w.G.id)}
        assert w.catalog_notified == [(str(w.h1.id), "machine_catalog")]

    def test_a_till_cannot_list_another_companys_or_tenants_product(self, w):
        _refused(w, lambda: _till_put(w, w.h1, "selected", [w.R.id]), 404)
        _refused(w, lambda: _till_put(w, w.h1, "selected", [w.X.id]), 404)
        _refused(w, lambda: _till_put(w, w.a1, "selected", [w.Q.id]), 404)

    def test_no_authority_is_401_elevation_required(self, w):
        dependency = require_catalog_authority(Scope.CATALOG_WRITE)
        with pytest.raises(HTTPException) as exc:
            dependency(machine=w.h1, elevation_token=None, operator_id=None, db=w.db)
        assert exc.value.status_code == 401

    def test_the_route_demands_catalog_authority(self):
        route = next(
            r for r in app.routes
            if getattr(r, "path", "") == "/api/v1/sync/{machine_id}/machine-catalog"
        )
        names = {d.call.__qualname__ for d in route.dependant.dependencies}
        assert any("require_catalog_authority" in n for n in names), names

    def test_the_audit_names_who_did_it(self, w):
        from app.models.sync_log import SyncLog

        _till_put(w, w.h1, "selected", [w.P.id])
        log = w.db.query(SyncLog).one()
        assert log.conflict_note == "machine_catalog mode=selected +1 -0"
        assert log.actor_pos_user_id is not None


# ── Which tills include a product, on the product page ───────────────────────


def test_the_product_page_says_which_tills_include_it(w):
    _put(w, w.h1, "selected", [w.Q.id])
    pic = availability_router.get_product_availability(
        str(w.P.id), current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
    ).model_dump(by_alias=True)
    tills = {
        m["name"]: m
        for c in pic["companies"] for s in c["shops"] for m in s["machines"]
    }
    assert (tills["h1"]["catalogMode"], tills["h1"]["inCatalog"]) == ("selected", False)
    assert (tills["h2"]["catalogMode"], tills["h2"]["inCatalog"]) == ("all", True)


# ── The migration ────────────────────────────────────────────────────────────


_HERE = pathlib.Path(__file__).resolve().parents[1]


def _migration():
    path = _HERE / "alembic" / "versions" / "f8a9b0c1d2e3_machine_catalog.py"
    spec = importlib.util.spec_from_file_location("machine_catalog_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _render(*args, downgrade=False) -> str:
    from alembic import command
    from alembic.config import Config

    buf = io.StringIO()
    cfg = Config(os.path.join(_HERE, "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", os.path.join(_HERE, "alembic"))
    (command.downgrade if downgrade else command.upgrade)(cfg, *args, sql=True)
    return " ".join(buf.getvalue().split())


class TestMigration:
    def test_chained_onto_the_general_item_and_the_only_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        m = _migration()
        assert (m.revision, m.down_revision) == ("f8a9b0c1d2e3", "e7f8a9b0c1d2")
        cfg = Config(str(_HERE / "alembic.ini"))
        cfg.set_main_option("script_location", str(_HERE / "alembic"))
        script = ScriptDirectory.from_config(cfg)
        # One head, and this revision on its line (later revisions build on it).
        heads = script.get_heads()
        assert len(heads) == 1
        assert "f8a9b0c1d2e3" in {r.revision for r in script.iterate_revisions(heads[0], "base")}

    def test_upgrade_adds_the_columns_and_the_table(self):
        sql = _render("e7f8a9b0c1d2:f8a9b0c1d2e3")
        assert "ADD COLUMN IF NOT EXISTS catalog_mode VARCHAR(16) NOT NULL DEFAULT 'all'" in sql
        assert "ADD COLUMN IF NOT EXISTS catalog_mode_updated_at TIMESTAMP WITH TIME ZONE" in sql
        assert "CREATE TABLE machine_catalog_items" in sql
        assert "ON DELETE CASCADE" in sql
        assert "CONSTRAINT uq_machine_catalog_item UNIQUE (machine_id, product_id)" in sql
        assert "CREATE INDEX ix_machine_catalog_items_machine_id" in sql
        assert "CREATE INDEX ix_machine_catalog_items_product_id" in sql

    def test_downgrade_drops_them(self):
        sql = _render("f8a9b0c1d2e3:e7f8a9b0c1d2", downgrade=True)
        assert "DROP TABLE machine_catalog_items" in sql
        assert "ALTER TABLE pos_machines DROP COLUMN catalog_mode_updated_at" in sql
        assert "ALTER TABLE pos_machines DROP COLUMN catalog_mode" in sql

    def test_existing_tills_come_out_in_all_mode(self):
        """The column statement itself, against a table of tills that predates it."""
        m = _migration()
        engine = create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE pos_machines (id TEXT PRIMARY KEY, name TEXT)"))
            conn.execute(text("INSERT INTO pos_machines VALUES ('a', 'till 1'), ('b', 'till 2')"))
            # SQLite has no ADD COLUMN IF NOT EXISTS; the column clause is otherwise the same.
            conn.execute(text(m.ADD_MODE.replace("IF NOT EXISTS ", "")))
            conn.execute(text(m.ADD_MODE_UPDATED_AT.replace("IF NOT EXISTS ", "")))
            rows = conn.execute(
                text("SELECT catalog_mode, catalog_mode_updated_at FROM pos_machines")
            ).all()
        assert rows == [("all", None), ("all", None)]
