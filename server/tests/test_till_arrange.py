"""The till's edit mode ("עריכת מסך"): the buttons' order saved at a level, and a product's
picture taken on the till.

Runs on the availability world (tests/test_product_availability.py): h1 stands in the bar
(an area of h_shop), as in tests/test_till_availability.py.
"""
from __future__ import annotations

import asyncio
import io
import uuid

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from app.database import Base
from app.middleware.auth import CatalogActor
from app.models.shop_area import ShopArea
from app.routers import images as images_router
from app.routers import sync as sync_router
from app.services import settings_notify
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers

from test_product_availability import world  # noqa: F401


@pytest.fixture
def w(world, monkeypatch):  # noqa: F811
    db = world.db
    Base.metadata.tables["sync_logs"].create(db.get_bind())
    world.woken = []
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda _db, m, reason: world.woken.append(("machine", str(m.id))))
    monkeypatch.setattr(settings_notify, "notify_machines_for_area_settings", lambda _db, a, reason: world.woken.append(("area", str(a))))
    monkeypatch.setattr(settings_notify, "notify_machines_for_shop_settings", lambda _db, s, reason: world.woken.append(("shop", str(s))))
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    db.commit()
    world.bar = bar
    return world


def _actor():
    return CatalogActor(pos_user_id=uuid.uuid4())


def _order(w, scope, ids, machine=None):
    body = sync_router.ProductOrderIn(scope=scope, productIds=ids)
    m = machine or w.h1
    return sync_router.machine_set_product_order(str(m.id), body, machine=m, actor=_actor(), db=w.db)


def _effective(w, machine):
    from app.models.company import Company

    company = w.db.get(Company, w.h_shop.company_id)
    area = w.db.get(ShopArea, machine.area_id) if machine.area_id else None
    return merge_all_settings_layers(company, shop=w.h_shop, machine=machine, area=area).get("productOrder")


class TestProductOrder:
    def test_it_is_a_setting_the_tills_are_sent(self):
        assert "productOrder" in MANAGED_SETTING_KEYS

    def test_this_till_alone(self, w):
        out = _order(w, "machine", ["b", "a", "b", " ", "c"])
        assert out == {"scope": "machine", "count": 3}
        assert w.h1.settings["productOrder"] == ["b", "a", "c"]
        assert not (w.h_shop.settings or {}).get("productOrder")
        assert w.woken == [("machine", str(w.h1.id))]

    def test_the_shop_lets_this_tills_own_go_and_wakes_the_shop(self, w):
        _order(w, "machine", ["x"])
        _order(w, "area", ["y"])
        assert "productOrder" not in (w.h1.settings or {})
        assert w.bar.settings["productOrder"] == ["y"]
        _order(w, "shop", ["a", "b"])
        assert w.h_shop.settings["productOrder"] == ["a", "b"]
        assert "productOrder" not in (w.bar.settings or {})
        assert w.woken[-1] == ("shop", str(w.h_shop.id))
        assert _effective(w, w.h1) == ["a", "b"]

    def test_the_categories_order_alone_leaves_the_products(self, w):
        _order(w, "machine", ["a", "b"])
        body = sync_router.ProductOrderIn(scope="machine", categoryIds=["c2", "c1"])
        sync_router.machine_set_product_order(str(w.h1.id), body, machine=w.h1, actor=_actor(), db=w.db)
        assert w.h1.settings["productOrder"] == ["a", "b"]
        assert w.h1.settings["categoryOrder"] == ["c2", "c1"]
        assert "categoryOrder" in MANAGED_SETTING_KEYS
        with pytest.raises(HTTPException):
            sync_router.machine_set_product_order(
                str(w.h1.id), sync_router.ProductOrderIn(scope="machine"), machine=w.h1, actor=_actor(), db=w.db,
            )

    def test_an_empty_list_clears_the_level(self, w):
        _order(w, "machine", ["a"])
        _order(w, "machine", [])
        assert "productOrder" not in (w.h1.settings or {})

    def test_a_till_in_no_area_cannot_save_for_its_area(self, w):
        with pytest.raises(HTTPException) as e:
            _order(w, "area", ["a"], machine=w.h2)
        assert e.value.status_code == 400


class TestProductImage:
    def _upload(self, w, product, keep=False):
        f = UploadFile(file=io.BytesIO(b"\x89PNG fake"), filename="p.jpg", headers=Headers({"content-type": "image/jpeg"}))
        return asyncio.run(sync_router.machine_upload_product_image(
            str(w.h1.id), str(product.id), file=f, keep_background=keep, machine=w.h1, actor=_actor(), db=w.db,
        ))

    def test_stored_and_set_on_a_product_of_this_shop_alone(self, w, monkeypatch):
        seen = {}

        async def fake_store(contents, tenant_id, resource, keep_background):
            seen.update(resource=resource, keep=keep_background)
            return images_router.ImageUploadResponse(
                url="https://img/cut.png", publicId="p1", originalUrl="https://img/orig.jpg", backgroundRemoved=True,
            )

        monkeypatch.setattr(images_router, "store_upload", fake_store)
        monkeypatch.setattr(sync_router, "_product_belongs_only_to", lambda db, p, sid: True)
        monkeypatch.setattr(sync_router, "notify_all_machines_for_tenant", lambda *a, **k: None)
        out = self._upload(w, w.P)
        assert out == {"url": "https://img/cut.png", "originalUrl": "https://img/orig.jpg", "backgroundRemoved": True}
        assert seen == {"resource": "products", "keep": False}
        assert w.db.get(type(w.P), w.P.id).image_url == "https://img/cut.png"

    def test_a_product_other_shops_list_too_is_refused(self, w, monkeypatch):
        monkeypatch.setattr(sync_router, "_product_belongs_only_to", lambda db, p, sid: False)
        with pytest.raises(HTTPException) as e:
            self._upload(w, w.P)
        assert (e.value.status_code, e.value.detail) == (403, "shared_product_master_readonly")
