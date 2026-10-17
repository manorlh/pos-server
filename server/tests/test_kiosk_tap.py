"""
A tap on a dish's card at the kiosk (app/services/kiosk_tap.py; owner 17.10): "הוספה מהירה" no_choices by
default, a dish that offers a note opens its window, and the dish's own "בקיוסק: פתיחת חלון" (window /
direct, inherited from its category) wins.

* The rule against the shared golden kiosk_tap_golden.json (the same bytes in pos-android; the dashboard's
  kioskTap.test.ts reads this copy).
* The routes keep `kioskOpen`, it reaches the kiosks in the menu block, and a write bumps the menu.
* "מופיע ב — עריכה בכמות" sets it for many products (kiosk / window / direct).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.models.category import Category
from app.models.product import Product
from app.routers import categories as RC
from app.routers import product_channels as RB
from app.routers import products as RP
from app.schemas.category import CategoryUpdate
from app.schemas.product import ProductUpdate
from app.services import kiosk_layout as L
from app.services import kiosk_tap as KT
from app.services import menu as M

from test_product_availability import world  # noqa: F401

GOLDEN_SHA256 = "cfa6a95b275ff6504b4a7ef46a7f4d1f521250648724c5e8cdaf365f5d73f961"
FIX = Path(__file__).parent / "fixtures" / "kiosk_tap_golden.json"


def _golden():
    data = FIX.read_bytes().replace(b"\r\n", b"\n")
    return data, json.loads(data)


def test_the_golden_is_the_pinned_one_and_speaks_the_layouts_vocabulary():
    data, doc = _golden()
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256
    assert tuple(doc["quickAdds"]) == L.LAYOUT_QUICK_ADDS == KT.QUICK_ADDS
    assert doc["default"] == L.LAYOUT_DEFAULTS["quickAdd"]


@pytest.mark.parametrize("case", _golden()[1]["tapCases"], ids=lambda c: json.dumps({k: v for k, v in c.items() if k != "path"})[:90])
def test_every_tap_case(case):
    assert KT.tap_path(
        quick_add=case["quickAdd"], plus=case["plus"], sold_out=case["soldOut"], add_path=case["addPath"], meal=case["meal"],
        defaults_answer=case["defaultsAnswer"], has_choices=case["hasChoices"], kiosk_open=case["kioskOpen"],
        notes_on=case["notesOn"],
    ) == case["path"]


@pytest.mark.parametrize("case", _golden()[1]["openCases"], ids=lambda c: c["name"][:60])
def test_every_open_case(case):
    parents = _golden()[1]["parents"]
    assert KT.open_for(case["kioskOpen"], case["productIds"], case["categoryId"], parents.get) == case["open"]


def test_the_owners_examples():
    tap = lambda **kw: KT.tap_path(**{**dict(quick_add="no_choices", plus=False, sold_out=False, add_path="direct",  # noqa: E731
                                            meal=False, defaults_answer=False, has_choices=False, kiosk_open=None,
                                            notes_on=False), **kw})
    assert tap() == "direct", "a cola: nothing to choose, straight in"
    assert tap(has_choices=True) == "sheet", "optional add-ons: its window (\"ואם יש לו תוספות ובחירות — זה גם יפתח\")"
    assert tap(notes_on=True) == "sheet", "a note it offers must be reachable"
    assert tap(notes_on=True, kiosk_open="direct") == "direct", "unless the dish says straight in"
    assert tap(kiosk_open="window") == "sheet"
    assert tap(has_choices=True, kiosk_open="direct") == "direct", "optional add-ons, set to straight in"
    assert tap(add_path="sheet", has_choices=True, kiosk_open="direct") == "sheet", "a required choice without a default"
    assert tap(add_path="sheet", has_choices=True, defaults_answer=True, kiosk_open="direct") == "direct"


# ── The routes, the menu block, in bulk ──────────────────────────────────────


@pytest.fixture
def tw(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr(RP, "_trigger_catalog_notify", lambda db, p: None)
    monkeypatch.setattr(RC, "_trigger_catalog_notify", lambda db, c: None)
    monkeypatch.setattr(RB, "notify_all_machines_for_tenant", lambda _db, tid, reason: None)
    return world


def test_kiosk_open_is_kept_sent_and_bumps_the_menu(tw):
    before = M.menu_changed_at(tw.db, tw.tid)
    RP.update_product(str(tw.P.id), ProductUpdate.model_validate({"kioskOpen": "window"}), current_user=tw.users.admin,
                      active_tenant_id=tw.tid, db=tw.db)
    assert tw.db.get(Product, tw.P.id).kiosk_open == "window"
    assert before is None or M.menu_changed_at(tw.db, tw.tid) > before
    RC.update_category(str(tw.P.category_id), CategoryUpdate.model_validate({"kioskOpen": "direct"}), current_user=tw.users.admin,
                       active_tenant_id=tw.tid, db=tw.db)
    assert tw.db.get(Category, tw.P.category_id).kiosk_open == "direct"
    block = M.menu_block(tw.db, tw.h1)["kioskOpen"]
    assert block == {"categories": {str(tw.P.category_id): "direct"}, "products": {str(tw.P.id): "window"}}
    assert KT.open_for(block, [str(tw.Q.id)], str(tw.P.category_id), lambda c: None) == "direct"
    RP.update_product(str(tw.P.id), ProductUpdate.model_validate({"kioskOpen": None}), current_user=tw.users.admin,
                      active_tenant_id=tw.tid, db=tw.db)
    assert tw.db.get(Product, tw.P.id).kiosk_open is None


def test_an_unknown_value_is_refused():
    with pytest.raises(Exception):
        ProductUpdate.model_validate({"kioskOpen": "sometimes"})
    with pytest.raises(Exception):
        RB.BulkIn.model_validate({"selection": {"ids": []}, "kioskOpen": "sometimes"})


def test_bulk_kiosk_open(tw):
    ids = [str(tw.P.id), str(tw.Q.id)]
    body = {"selection": {"ids": ids}, "kioskOpen": "direct", "dryRun": False}
    got = RB.bulk_product_channels(RB.BulkIn.model_validate(body), current_user=tw.users.admin, active_tenant_id=tw.tid, db=tw.db)
    assert got["changed"] == 2 and {tw.db.get(Product, tw.P.id).kiosk_open, tw.db.get(Product, tw.Q.id).kiosk_open} == {"direct"}
    back = {**body, "kioskOpen": "kiosk"}
    RB.bulk_product_channels(RB.BulkIn.model_validate(back), current_user=tw.users.admin, active_tenant_id=tw.tid, db=tw.db)
    assert {tw.db.get(Product, tw.P.id).kiosk_open, tw.db.get(Product, tw.Q.id).kiosk_open} == {None}
