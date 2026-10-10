"""
The public read API of a published profile (app/routers/public_digital.py, app/services/public_digital_cache.py;
specs/digital-menu-ordering-cards-plan.md §9): only safe fields, an ETag, a draft / paused / unknown
profile never served, the cache never crossing points, a direct link to a hidden product neutral.

Runs on the digital world of tests/test_digital_effective.py.
"""
from __future__ import annotations

import json
import uuid

from starlette.requests import Request

from app.routers import public_digital as PUB
from app.services import presentation_profiles as PP
from app.services import public_digital_cache as cache

from test_digital_effective import _create, _drinks, _select, _set, dw  # noqa: F401
from test_product_availability import world  # noqa: F401


class TestPublicApi:
    def _request(self, headers=None):
        scope = {"type": "http", "method": "GET", "path": "/", "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
                 "client": (f"10.0.0.{uuid.uuid4().int % 250}", 1), "query_string": b""}
        return Request(scope)

    def _published(self, dw, kind="menu"):
        p = _create(dw, kind=kind)
        _select(dw, p, _drinks(dw))
        PP.publish(dw.db, p, dw.users.admin)
        dw.db.commit()
        return p

    def test_only_safe_fields_an_etag_and_a_304(self, dw):
        p = self._published(dw)
        resp = PUB.public_profile("menu", p.slug, self._request(), db=dw.db)
        body = json.loads(resp.body)
        row = body["products"][str(dw.P.id)]
        assert set(row) == {"id", "categoryId", "name", "description", "imageUrl", "tags", "allergens", "dietaryTags",
                            "price", "display", "orderable", "publicReason"}
        assert "reasons" not in json.dumps(body)
        etag = resp.headers["etag"]
        again = PUB.public_profile("menu", p.slug, self._request({"If-None-Match": etag}), db=dw.db)
        assert again.status_code == 304

    def test_drafts_paused_and_unknown(self, dw):
        draft = _create(dw)
        assert PUB.public_profile("menu", draft.slug, self._request(), db=dw.db).status_code == 404
        p = self._published(dw)
        assert PUB.public_profile("online", p.slug, self._request(), db=dw.db).status_code == 404, "the menu is not the ordering site"
        PP.set_status(dw.db, p, "pause", dw.users.admin)
        dw.db.commit()
        cache.invalidate(p.id)
        assert PUB.public_profile("menu", p.slug, self._request(), db=dw.db).status_code == 503

    def test_the_cache_never_crosses_points(self, dw):
        p = _create(dw, level="company", target=dw.H.id)
        _select(dw, p, _drinks(dw))
        PP.publish(dw.db, p, dw.users.admin)
        dw.db.commit()
        h = json.loads(PUB.public_profile("menu", p.slug, self._request(), shop_id=str(dw.h_shop.id), db=dw.db).body)
        a = json.loads(PUB.public_profile("menu", p.slug, self._request(), shop_id=str(dw.a_shop.id), db=dw.db).body)
        assert h["products"][str(dw.P.id)]["price"] == "12.00" and a["products"][str(dw.P.id)]["price"] == "10.00"
        assert str(dw.Q.id) in h["products"] and str(dw.Q.id) not in a["products"]
        assert PUB.public_profile("menu", p.slug, self._request(), shop_id=str(dw.b_shop.id), db=dw.db).status_code == 404

    def test_a_direct_link_to_a_hidden_product_is_neutral(self, dw):
        p = self._published(dw)
        _set(dw.P, menu=False)
        dw.db.commit()
        cache.clear()
        resp = PUB.public_product("menu", p.slug, str(dw.P.id), self._request(), db=dw.db)
        assert resp.status_code == 404 and json.loads(resp.body)["code"] == "unavailable"
        ok = PUB.public_product("menu", p.slug, str(dw.Q.id), self._request(), db=dw.db)
        assert json.loads(ok.body)["product"]["id"] == str(dw.Q.id)
