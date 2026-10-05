"""Cover for the products page: search, category / status / "available at" filters, and
the per-row availability summary.

Runs on the same in-memory SQLite world as `test_product_availability.py` (imported
from there), so the filters are the SQL the list actually issues and the summary is
checked against the availability picture it summarises. What could go wrong, and is
pinned here:

* a search that misses `מק"ט` when the merchant types `מקט`, or a `%` that matches all;
* "available at" disagreeing with the rule — a parent company's lock reaching a
  sub-company's shop, an area or till setting ignored, a delisted product shown active;
* a filter reaching a shop the caller cannot see;
* the summary costing a query per product.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from app.models.category import Category
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.product import CatalogLevel, Product
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.routers import product_availability as R
from app.routers import products as products_router
from app.schemas.product_availability import AvailabilitySet, AvailabilitySummaryRequest
from app.services import product_list_filters as F

from test_product_availability import (  # noqa: F401  (the fixture, by name)
    OLD,
    _set_company,
    _set_machine,
    _set_shop,
    world,
)


def _list(w, user=None, **filters):
    """Names on the first page, sorted, for these filters."""
    args = dict(
        page=1, page_size=200, company_id=None, shop_id=None, pos_machine_id=None,
        category_id=None, catalog_level=None, in_stock=None, search=None,
    )
    args.update(filters)
    res = products_router.list_products(
        **args, current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )
    return sorted(p.name for p in res.items)


def _product(w, name, sku, *, category=None, barcode=None, owner=None):
    p = Product(
        id=uuid.uuid4(), tenant_id=w.tid, company_id=(owner or w.H).id,
        category_id=category.id if category else w.P.category_id,
        catalog_level=CatalogLevel.GLOBAL, name=name, price=Decimal("5.00"), sku=sku,
        barcode=barcode, is_available=True, updated_at=OLD, created_at=OLD,
    )
    w.db.add(p)
    w.db.commit()
    return p


def _area(w, shop, name, *machines):
    a = ShopArea(id=uuid.uuid4(), tenant_id=w.tid, shop_id=shop.id, name=name, settings={})
    w.db.add(a)
    w.db.flush()
    for m in machines:
        m.area_id = a.id
    w.db.commit()
    return a


# ── Search ───────────────────────────────────────────────────────────────────


class TestNormalize:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ('מק"ט', "מקט"),
            ("מק״ט", "מקט"),
            ("שָׁלוֹם", "שלום"),
            ("  Coca   Cola ", "coca cola"),
            ("ג׳ינג׳ר", "גינגר"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_like_the_sidebar_search(self, raw, expected):
        assert F.normalize_search(raw) == expected

    def test_words(self):
        assert F.search_terms(" a  b ") == ["a", "b"]
        assert F.search_terms("   ") == []


class TestSearch:
    def test_name_sku_global_sku_and_barcode(self, world):
        w = world
        w.P.global_sku = "G-777"
        w.Q.barcode = "7290001"
        w.db.commit()
        assert _list(w, search="col") == ["Cola"]
        assert _list(w, search="g-777") == ["Cola"]
        assert _list(w, search="72900") == ["Soda"]
        assert _list(w, search="2") == ["Soda"], "the SKU"

    def test_quotes_and_niqqud_do_not_matter(self, world):
        w = world
        _product(w, 'מיץ תפו"ז', "30")
        _product(w, "ג׳ינג׳ר בירה", "31")
        assert _list(w, search="תפוז") == ['מיץ תפו"ז']
        assert _list(w, search='תפו"ז') == ['מיץ תפו"ז']
        assert _list(w, search="תַּפּוּז") == ['מיץ תפו"ז']
        assert _list(w, search="גינגר") == ["ג׳ינג׳ר בירה"]

    def test_every_word_must_match_somewhere(self, world):
        w = world
        _product(w, "Cola Zero", "40", barcode="999")
        assert _list(w, search="cola zero") == ["Cola Zero"]
        assert _list(w, search="zero 999") == ["Cola Zero"], "one word in the name, one in the barcode"
        assert _list(w, search="cola soda") == []

    def test_wildcards_are_literal(self, world):
        assert _list(world, search="%") == []
        assert _list(world, search="_") == []

    def test_blank_is_no_filter(self, world):
        assert _list(world, search="  ") == ["Cola", "Soda"]


# ── Categories ───────────────────────────────────────────────────────────────


class TestCategories:
    def test_any_of_several(self, world):
        w = world
        snacks = Category(id=uuid.uuid4(), tenant_id=w.tid, name="Snacks", updated_at=OLD)
        sweets = Category(id=uuid.uuid4(), tenant_id=w.tid, name="Sweets", updated_at=OLD)
        w.db.add_all([snacks, sweets])
        w.db.commit()
        _product(w, "Chips", "50", category=snacks)
        _product(w, "Candy", "51", category=sweets)
        assert _list(w, category_ids=[str(snacks.id)]) == ["Chips"]
        assert _list(w, category_ids=[str(snacks.id), str(sweets.id)]) == ["Candy", "Chips"]
        assert _list(w, category_ids=[str(w.P.category_id)]) == ["Cola", "Soda"]

    def test_uncategorized_is_a_category_that_is_not_there(self, world):
        w = world
        # A category of another tenant: not one this catalog has.
        other = Tenant(id=uuid.uuid4(), name="Other", slug="other")
        w.db.add(other)
        w.db.flush()
        foreign = Category(id=uuid.uuid4(), tenant_id=other.id, name="Foreign", updated_at=OLD)
        w.db.add(foreign)
        w.db.commit()
        _product(w, "Stray", "60", category=foreign)
        assert _list(w, uncategorized=True) == ["Stray"]
        assert _list(w, uncategorized=True, category_ids=[str(w.P.category_id)]) == [
            "Cola", "Soda", "Stray",
        ]
        assert _list(w, uncategorized=False) == ["Cola", "Soda", "Stray"]


# ── Status and "available at" ────────────────────────────────────────────────


def _at(level, target):
    return f"{level}:{target.id}"


class TestStatusAnywhere:
    def test_a_lock_anywhere_makes_it_inactive(self, world):
        w = world
        assert _list(w, product_status="active") == ["Cola", "Soda"]
        assert _list(w, product_status="inactive") == []
        _set_machine(w, w.h2, False)
        assert _list(w, product_status="active") == ["Soda"]
        assert _list(w, product_status="inactive") == ["Cola"]

    def test_an_unknown_status_is_refused(self, world):
        with pytest.raises(HTTPException) as exc:
            _list(world, product_status="maybe")
        assert exc.value.status_code == 400


class TestAvailableAt:
    def test_a_shop(self, world):
        w = world
        assert _list(w, available_at=_at("shop", w.h_shop)) == ["Cola", "Soda"]
        assert _list(w, available_at=_at("shop", w.a_shop)) == ["Cola"], "Soda is not sold there"
        assert _list(w, available_at=_at("shop", w.b_shop)) == []

        _set_company(w, w.H, False)
        assert _list(w, available_at=_at("shop", w.h_shop)) == ["Soda"]
        assert _list(w, available_at=_at("shop", w.h_shop), product_status="inactive") == ["Cola"]
        # H's lock stays in H's own shops.
        assert _list(w, available_at=_at("shop", w.a_shop)) == ["Cola"]

        _set_shop(w, w.h_shop, True)
        assert _list(w, available_at=_at("shop", w.h_shop)) == ["Cola", "Soda"], "the shop unlocks it"

    def test_a_delisted_product_is_not_active(self, world):
        w = world
        w.rows.q_h.is_listed = False
        w.db.commit()
        assert _list(w, available_at=_at("shop", w.h_shop)) == ["Cola"]
        assert _list(w, available_at=_at("shop", w.h_shop), product_status="inactive") == ["Soda"]

    def test_areas_and_tills(self, world):
        w = world
        bar = _area(w, w.h_shop, "Bar", w.h1)
        R.set_area_availability(
            str(w.P.id), str(bar.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        assert _list(w, available_at=_at("area", bar)) == ["Soda"]
        assert _list(w, available_at=_at("machine", w.h1)) == ["Soda"], "h1 stands in the bar"
        assert _list(w, available_at=_at("machine", w.h2)) == ["Cola", "Soda"]
        assert _list(w, available_at=_at("shop", w.h_shop)) == ["Cola", "Soda"]

        _set_machine(w, w.h1, True)
        assert _list(w, available_at=_at("machine", w.h1)) == ["Cola", "Soda"], "the till unlocks it"

    def test_a_till_showing_selected_products_only(self, world):
        w = world
        w.h2.catalog_mode = "selected"
        w.db.add(MachineCatalogItem(machine_id=w.h2.id, product_id=w.Q.id, is_included=True))
        w.db.commit()
        assert _list(w, available_at=_at("machine", w.h2)) == ["Soda"]
        assert _list(w, available_at=_at("machine", w.h2), product_status="inactive") == ["Cola"]

    def test_a_company_is_its_own_shops(self, world):
        w = world
        assert _list(w, available_at=_at("company", w.A)) == ["Cola"]
        assert _list(w, available_at=_at("company", w.H)) == ["Cola", "Soda"]
        assert _list(w, available_at=_at("company", w.B)) == []
        _set_company(w, w.A, False)
        assert _list(w, available_at=_at("company", w.A)) == []
        assert _list(w, available_at=_at("company", w.A), product_status="inactive") == ["Cola"]
        assert _list(w, available_at=_at("company", w.H)) == ["Cola", "Soda"]

    def test_combines_with_search_and_category(self, world):
        w = world
        assert _list(
            w, available_at=_at("shop", w.h_shop), search="so",
            category_ids=[str(w.P.category_id)],
        ) == ["Soda"]

    def test_out_of_reach_or_malformed(self, world):
        w = world
        for raw in (_at("shop", w.h_shop), _at("machine", w.h1), _at("company", w.H)):
            with pytest.raises(HTTPException) as exc:
                _list(w, user=w.users.b_manager, available_at=raw)
            assert exc.value.status_code == 403, raw
        for raw in ("shop", "shop:", "galaxy:" + str(w.h_shop.id), "shop:not-a-uuid"):
            with pytest.raises(HTTPException) as exc:
                _list(w, available_at=raw)
            assert exc.value.status_code == 400, raw
        with pytest.raises(HTTPException) as exc:
            _list(w, available_at=f"shop:{uuid.uuid4()}")
        assert exc.value.status_code == 404


# ── The summary ──────────────────────────────────────────────────────────────


def _summary(w, *products, user=None):
    res = R.summarize_product_availability(
        AvailabilitySummaryRequest(productIds=[p.id for p in products]),
        current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )
    return {str(i.product_id): i.model_dump(by_alias=True) for i in res.items}


class TestSummary:
    def test_counts_everything_reachable(self, world):
        w = world
        s = _summary(w, w.P, w.Q)
        p, q = s[str(w.P.id)], s[str(w.Q.id)]
        assert (p["companyCount"], p["shopCount"], p["activeShopCount"]) == (2, 2, 2)
        assert (p["machineCount"], p["activeMachineCount"]) == (3, 3)
        assert p["exceptions"] == [] and p["exceptionCount"] == 0
        assert (q["shopCount"], q["machineCount"], q["activeMachineCount"]) == (1, 2, 2)

    def test_locks_are_named(self, world):
        w = world
        _set_machine(w, w.h2, False)
        p = _summary(w, w.P)[str(w.P.id)]
        assert (p["activeShopCount"], p["activeMachineCount"]) == (2, 2)
        (lock,) = p["exceptions"]
        assert lock["level"] == "machine" and lock["value"] is False
        assert lock["posNumber"] == w.h2.pos_number and lock["shopName"] == "H shop"

    def test_a_company_lock_and_a_shop_unlock(self, world):
        w = world
        _set_company(w, w.H, False)
        p = _summary(w, w.P)[str(w.P.id)]
        assert (p["shopCount"], p["activeShopCount"]) == (2, 1), "A's shop is not H's"
        assert (p["machineCount"], p["activeMachineCount"]) == (3, 1)
        assert [(e["level"], e["value"]) for e in p["exceptions"]] == [("company", False)]
        _set_shop(w, w.h_shop, True)
        p = _summary(w, w.P)[str(w.P.id)]
        assert p["activeShopCount"] == 2
        assert [(e["level"], e["value"]) for e in p["exceptions"]] == [
            ("company", False), ("shop", True),
        ], "locks first"

    def test_areas_and_selected_catalogs(self, world):
        w = world
        bar = _area(w, w.h_shop, "Bar", w.h1)
        R.set_area_availability(
            str(w.P.id), str(bar.id), AvailabilitySet(isAvailable=False),
            current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        w.a1.catalog_mode = "selected"
        w.db.commit()
        p = _summary(w, w.P)[str(w.P.id)]
        assert (p["areaCount"], p["activeAreaCount"]) == (1, 0)
        assert (p["machineCount"], p["activeMachineCount"]) == (3, 1), "h1 in the bar, a1 not on its list"
        assert [e["level"] for e in p["exceptions"]] == ["area"]

    def test_matches_the_picture(self, world):
        w = world
        _set_company(w, w.A, False)
        _set_machine(w, w.h1, False)
        pic = R.get_product_availability(
            str(w.P.id), current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
        )
        active_tills = sum(
            1 for c in pic.companies for s in c.shops for m in s.machines
            if m.effective and m.in_catalog and s.is_listed
        )
        assert _summary(w, w.P)[str(w.P.id)]["activeMachineCount"] == active_tills

    def test_only_reachable_shops(self, world):
        w = world
        p = _summary(w, w.P, user=w.users.a_manager)[str(w.P.id)]
        assert (p["companyCount"], p["shopCount"], p["machineCount"]) == (1, 1, 1)

    def test_unseen_products_are_left_out(self, world):
        w = world
        hidden = _product(w, "B only", "70", owner=w.B)
        got = _summary(w, w.P, hidden, user=w.users.a_manager)
        assert set(got) == {str(w.P.id)}

    def test_a_fixed_number_of_queries(self, world):
        w = world
        extra = [_product(w, f"X{i}", f"8{i}") for i in range(5)]
        for p in extra:
            w.db.add(
                type(w.rows.p_h)(id=uuid.uuid4(), shop_id=w.h_shop.id, global_product_id=p.id,
                                 is_listed=True, updated_at=OLD)
            )
        w.db.commit()

        def count(products):
            ids = [p.id for p in products]
            w.db.expire_all()
            seen = []
            engine = w.db.get_bind()
            listener = lambda *a, **k: seen.append(1)  # noqa: E731
            event.listen(engine, "before_cursor_execute", listener)
            try:
                R.summarize_product_availability(
                    AvailabilitySummaryRequest(productIds=ids),
                    current_user=w.users.admin, active_tenant_id=w.tid, db=w.db,
                )
            finally:
                event.remove(engine, "before_cursor_execute", listener)
            return len(seen)

        assert count([w.P] + extra) == count([w.P])

    def test_empty(self, world):
        assert _summary(world) == {}
