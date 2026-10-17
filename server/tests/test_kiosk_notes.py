"""
"הערה בקיוסק" per dish (app/services/kiosk_notes.py; owner 17.10, "הערות זה פר פריט"): the kiosk offers a
note on a dish only where the dish allows it — its own value, else its category's up the tree, else none.

* The rule against the shared golden kiosk_notes_golden.json (the same bytes in pos-android; the
  dashboard's kioskNotes.test.ts reads this copy).
* The values reach the kiosks in the menu block (`kioskNotes`, explicit values only), and every write
  bumps the menu so the next delta pull carries it.
* The product / category routes keep a value, reset it with null, and leave it alone when omitted.
* "מופיע ב — עריכה בכמות" sets it for many products at once (on / off / inherit).

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

import pytest

from app.models.category import Category
from app.models.product import Product
from app.routers import categories as RC
from app.routers import product_channels as RB
from app.routers import products as RP
from app.schemas.category import CategoryUpdate
from app.schemas.product import ProductUpdate
from app.services import kiosk_notes as KN
from app.services import menu as M

from test_product_availability import world  # noqa: F401

GOLDEN_SHA256 = "d4ccf2aec7faff55c9287a3f9f8e4d89e0be7b1cad09ca87433bbb1b0f6d3e20"
FIX = Path(__file__).parent / "fixtures" / "kiosk_notes_golden.json"


def _golden():
    data = FIX.read_bytes().replace(b"\r\n", b"\n")
    return data, json.loads(data)


def test_the_golden_is_the_pinned_one():
    data, doc = _golden()
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256
    assert doc["default"] is KN.DEFAULT is False


@pytest.mark.parametrize("case", _golden()[1]["cases"], ids=lambda c: c["name"][:60])
def test_every_case_of_the_golden(case):
    parents = _golden()[1]["parents"]
    assert KN.allowed(case["kioskNotes"], case["productIds"], case["categoryId"], parents.get) is case["allowed"]


# ── The routes, the menu block, the bump ─────────────────────────────────────


@pytest.fixture
def nw(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr(RP, "_trigger_catalog_notify", lambda db, p: None)
    monkeypatch.setattr(RC, "_trigger_catalog_notify", lambda db, c: None)
    monkeypatch.setattr(RB, "notify_all_machines_for_tenant", lambda _db, tid, reason: None)
    return world


def _put_product(w, body):
    return RP.update_product(str(w.P.id), ProductUpdate.model_validate(body), current_user=w.users.admin,
                             active_tenant_id=w.tid, db=w.db)


def _put_category(w, body):
    return RC.update_category(str(w.P.category_id), CategoryUpdate.model_validate(body), current_user=w.users.admin,
                              active_tenant_id=w.tid, db=w.db)


def test_nothing_set_nothing_sent_and_no_note(nw):
    assert KN.block(nw.db, nw.tid) == {"categories": {}, "products": {}}
    assert KN.allowed(KN.block(nw.db, nw.tid), [str(nw.P.id)], str(nw.P.category_id), lambda c: None) is False


def test_a_product_allows_it_and_the_menu_carries_it(nw):
    before = M.menu_changed_at(nw.db, nw.tid)
    out = _put_product(nw, {"kioskNotes": True})
    assert out.kiosk_notes is True
    assert KN.block(nw.db, nw.tid) == {"categories": {}, "products": {str(nw.P.id): True}}
    after = M.menu_changed_at(nw.db, nw.tid)
    assert after is not None and (before is None or after > before), "the next delta pull carries the menu"
    # Omitted: left as it is; null: back to the category's.
    _put_product(nw, {"name": "Cola 2"})
    assert nw.db.get(Product, nw.P.id).kiosk_notes is True
    _put_product(nw, {"kioskNotes": None})
    assert nw.db.get(Product, nw.P.id).kiosk_notes is None
    assert KN.block(nw.db, nw.tid)["products"] == {}


def test_a_category_allows_it_for_its_dishes_and_a_dish_may_still_block(nw):
    _put_category(nw, {"kioskNotes": True})
    assert nw.db.get(Category, nw.P.category_id).kiosk_notes is True
    _put_product(nw, {"kioskNotes": False})
    block = KN.block(nw.db, nw.tid)
    cat = str(nw.P.category_id)
    assert KN.allowed(block, [str(nw.Q.id)], cat, lambda c: None) is True
    assert KN.allowed(block, [str(nw.P.id)], cat, lambda c: None) is False


def test_the_menu_block_has_it(nw):
    _put_product(nw, {"kioskNotes": True})
    block = M.menu_block(nw.db, nw.h1)
    assert block["kioskNotes"] == {"categories": {}, "products": {str(nw.P.id): True}}


def test_a_value_that_is_not_a_boolean_is_refused():
    with pytest.raises(Exception):
        ProductUpdate.model_validate({"kioskNotes": "sometimes"})


# ── In bulk ("מופיע ב — עריכה בכמות") ────────────────────────────────────────


def _bulk(w, body):
    return RB.bulk_product_channels(RB.BulkIn.model_validate(body), current_user=w.users.admin, active_tenant_id=w.tid, db=w.db)


def test_bulk_allows_blocks_and_inherits(nw):
    ids = [str(nw.P.id), str(nw.Q.id)]
    dry = _bulk(nw, {"selection": {"ids": ids}, "kioskNotes": "on", "dryRun": True})
    assert (dry["changed"], dry["applied"]) == (2, False)
    assert nw.db.get(Product, nw.P.id).kiosk_notes is None
    before = M.menu_changed_at(nw.db, nw.tid)
    got = _bulk(nw, {"selection": {"ids": ids}, "kioskNotes": "on", "dryRun": False})
    assert got["applied"] is True and got["changed"] == 2
    assert {nw.db.get(Product, nw.P.id).kiosk_notes, nw.db.get(Product, nw.Q.id).kiosk_notes} == {True}
    assert before is None or M.menu_changed_at(nw.db, nw.tid) > before
    # The channels stay as they were.
    assert _bulk(nw, {"selection": {"ids": ids}, "kioskNotes": "on", "dryRun": False})["changed"] == 0
    _bulk(nw, {"selection": {"ids": [str(nw.P.id)]}, "kioskNotes": "off", "dryRun": False})
    assert nw.db.get(Product, nw.P.id).kiosk_notes is False
    _bulk(nw, {"selection": {"ids": ids}, "kioskNotes": "inherit", "dryRun": False})
    assert {nw.db.get(Product, nw.P.id).kiosk_notes, nw.db.get(Product, nw.Q.id).kiosk_notes} == {None}
    # The list shows it.
    rows = RB.list_products(page=1, page_size=50, search=None, category_ids=None, channel_on=None, channel_off=None,
                            current_user=nw.users.admin, active_tenant_id=nw.tid, db=nw.db)["items"]
    assert all("kioskNotes" in r for r in rows)
