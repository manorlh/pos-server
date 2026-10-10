"""
The digital channels' profiles, the shared effective-state resolver and the public read API
(app/services/presentation_profiles.py, app/services/digital_effective_rules.py,
app/services/digital_effective.py, app/routers/presentation_profiles.py, app/routers/public_digital.py;
specs/digital-menu-ordering-cards-plan.md §4.4, §6, §8, §9).

What could look right and still be wrong:

* a customer seeing a draft, a parent template's unpublished edit, an internal reason or another
  point's products and prices (the cache);
* a product switched on for the web after publication appearing without a reviewed publication;
* a web-only block reaching a till, or a till block silently reaching the web;
* a published revision changing; two editors overwriting each other; two profiles of one target
  active at once at one priority;
* the digital menu taking an order.

The rule is pinned by tests/fixtures/digital_effective_state_golden.json; the database half runs on
the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.database import Base
from app.models.catalog_menu import CatalogMenu, CatalogMenuAssignment, CatalogMenuCategory, CatalogMenuProduct
from app.models.kiosk import KioskDevice, KioskSettings
from app.models.presentation_profile import PresentationAudit, PresentationRevision
from app.models.product import CatalogLevel, Product
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.routers import presentation_profiles as R
from app.services import commit_signals
from app.services import digital_effective as DE
from app.services import digital_effective_rules as ER
from app.services import display_ordering as DO
from app.services import presentation_profiles as PP
from app.services import product_channels as PC
from app.services import public_digital_cache as cache
from app.services import sold_out as SO
from app.services import sync as S

from test_product_availability import world  # noqa: F401

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "digital_effective_state_golden.json"
#: The LF-normalised bytes' SHA-256 of the resolver's golden cases.
GOLDEN_SHA256 = "828805a76276948e5f581f0bb92ea2c74cc52a5f0ebfe7c8bfee0ffbdd0018d2"

NOW = datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)  # Sunday 12:00 in Israel


# ── The rule (golden) ────────────────────────────────────────────────────────


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_golden_file_is_pinned():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


@pytest.mark.parametrize("case", _golden()["cases"], ids=lambda c: c["name"])
def test_the_rule_gives_each_golden_answer(case):
    facts = dict(case["facts"])
    sel = case.get("selection")
    if sel is not None:
        parent = ER.Selected(**sel["parent"]) if sel.get("parent") else None
        hidden = (set(sel["kioskHidden"][0]), set(sel["kioskHidden"][1])) if sel.get("kioskHidden") else None
        selected = ER.select(sel["selection"], facts["product_id"], facts.get("category_chain", []), parent=parent, kiosk_hidden=hidden)
        assert {"selected": selected.selected, "reason": selected.reason, "include_future": selected.include_future} == facts["selected"]
    facts["selected"] = ER.Selected(**facts["selected"])
    d = ER.decide(ER.Facts(**facts), ER.Context(**case["context"]))
    expect = case["expect"]
    assert (d.display, d.orderable, d.reasons, d.public_reason) == (
        expect["display"], expect["orderable"], expect["reasons"], expect["publicReason"],
    )
    assert ((d.block or {}).get("id") if d.block else None) == expect["block"]


def test_block_channels():
    for case in _golden()["blockChannels"]:
        assert sorted(ER.block_channels(case["block"])) == case["expect"]


# ── On a real session ────────────────────────────────────────────────────────


_EXTRA = (
    "kiosk_devices", "kiosk_settings", "sold_out_marks", "report_events", "report_event_machines",
    "machine_groups", "machine_group_members", "stock_levels", "display_orderings", "display_ordering_bindings",
    "presentation_profiles", "presentation_revisions", "presentation_audit", "product_channel_overrides",
    "catalog_menus", "catalog_menu_categories", "catalog_menu_products", "catalog_menu_assignments",
    "catalog_menu_fallbacks", "catalog_menu_sync_state", "sync_logs",
)


@pytest.fixture
def dw(world, monkeypatch):  # noqa: F811
    """h_shop sells P (Cola) and Q (Soda), Drinks; h1 a till in point of sale "Bar", h2 a kiosk; a1 in a_shop."""
    db = world.db
    for name in _EXTRA:
        if name in Base.metadata.tables and not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    for mod in (PC, PP):
        mod._READY.clear()
    DO._READY = None
    cache.clear()
    world.signals = []
    monkeypatch.setattr(commit_signals, "publish", lambda t, m, why: world.signals.append((m, why)))
    monkeypatch.setattr(DO, "publish", lambda t, m, why: None)
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    db.add(KioskDevice(machine_id=world.h2.id, tenant_id=world.tid, shop_id=world.h_shop.id, name="Kiosk", enabled=True))
    # Both on the digital menu and online.
    for p in (world.P, world.Q):
        PC.apply(p, {"online": True, "menu": True})
    world.rows.p_h.price = 12
    db.commit()
    world.bar = bar
    world.drinks = str(world.P.category_id)
    return world


def _create(w, kind="menu", *, user=None, level="shop", target=None, **extra):
    body = {
        "internalName": f"{kind} profile", "publicTitle": {"he": "תפריט"}, "targetLevel": level,
        "targetId": str(target or w.h_shop.id), "serviceTypes": ["takeaway"], "languages": ["he", "en"], **extra,
    }
    p = PP.create(w.db, user or w.users.admin, w.tid, kind, body)
    w.db.commit()
    return p


def _select(w, p, selection, **content):
    d = PP.draft_of(w.db, p)
    PP.put_draft(w.db, p, content={**(d.content or {}), "selection": selection, **content}, field_states=None, version=d.version)
    w.db.commit()


def _view(w, p, *, mode="public", channel=None, at=NOW, **kw):
    rev = PP.revision(w.db, p.published_revision_id) if mode == "public" else PP.draft_of(w.db, p)
    return DE.resolve(w.db, DE.Request(profile=p, revision=rev, channel=channel or p.kind, mode=mode, at=at, **kw))


SEL_DRINKS = {"mode": "independent", "categories": [{"id": None, "includeFuture": False}]}


def _drinks(w, future=False):
    return {"mode": "independent", "categories": [{"id": w.drinks, "includeFuture": future}]}


class TestProfiles:
    def test_draft_save_publish_and_a_published_revision_never_changes(self, dw):
        p = _create(dw)
        assert p.status == "draft" and p.slug.startswith("m-")
        _select(dw, p, _drinks(dw))
        PP.save_draft(dw.db, p, dw.users.admin)
        assert p.status == "saved"
        pub = PP.publish(dw.db, p, dw.users.admin, note="first")
        dw.db.commit()
        assert (p.status, pub.state, pub.number) == ("published", "published", 1)
        assert sorted(pub.exposure["products"]) == sorted([str(dw.P.id), str(dw.Q.id)])
        frozen = json.dumps(pub.content, sort_keys=True)
        # The next edit opens a new draft; the published one stays as it was.
        _select(dw, p, {"mode": "independent", "products": [str(dw.P.id)]})
        assert json.dumps(PP.revision(dw.db, p.published_revision_id).content, sort_keys=True) == frozen
        assert PP.draft_of(dw.db, p).number == 2

    def test_two_editors_one_is_told(self, dw):
        p = _create(dw)
        d = PP.draft_of(dw.db, p)
        v = d.version
        PP.put_draft(dw.db, p, content=d.content, field_states=None, version=v)
        with pytest.raises(HTTPException) as e:
            PP.put_draft(dw.db, p, content=d.content, field_states=None, version=v)
        assert e.value.status_code == 409 and e.value.detail["code"] == "revision_changed"
        with pytest.raises(HTTPException) as e:
            PP.update_meta(dw.db, p, {"internalName": "x"}, version=p.version + 5)
        assert e.value.status_code == 409 and e.value.detail["code"] == "profile_changed"

    def test_publication_is_refused_with_its_reasons(self, dw):
        p = _create(dw, publicTitle={})
        with pytest.raises(HTTPException) as e:
            PP.publish(dw.db, p, dw.users.admin)
        codes = {x["code"] for x in e.value.detail["errors"]}
        assert {"title_required", "nothing_exposed"} <= codes

    def test_overlap_at_one_priority_is_refused(self, dw):
        a = _create(dw)
        _select(dw, a, _drinks(dw))
        PP.publish(dw.db, a, dw.users.admin)
        dw.db.commit()
        b = _create(dw)
        _select(dw, b, _drinks(dw))
        with pytest.raises(HTTPException) as e:
            PP.publish(dw.db, b, dw.users.admin)
        assert "overlap" in {x["code"] for x in e.value.detail["errors"]}
        # Evening only and a breakfast-only profile do not overlap.
        PP.put_draft(dw.db, b, content={**PP.draft_of(dw.db, b).content,
                                         "schedule": {"access": {"ranges": [["18:00", "23:00"]]}}}, field_states=None, version=None)
        PP.put_draft(dw.db, a, content={**PP.draft_of(dw.db, a).content,
                                         "schedule": {"access": {"ranges": [["06:00", "11:00"]]}}}, field_states=None, version=None)
        PP.publish(dw.db, a, dw.users.admin)
        PP.publish(dw.db, b, dw.users.admin)
        dw.db.commit()
        assert b.status == "published"

    def test_inheritance_reads_the_parents_published_revision_only(self, dw):
        template = _create(dw, level="company", target=dw.H.id)
        _select(dw, template, _drinks(dw), theme={"template": "chef", "tokens": {"color": "#111"}})
        PP.publish(dw.db, template, dw.users.admin)
        dw.db.commit()
        child = _create(dw, parentProfileId=str(template.id))
        eff = PP.effective_fields(dw.db, child, PP.draft_of(dw.db, child))
        assert eff["theme"]["value"]["template"] == "chef"
        assert eff["theme"]["source"]["kind"] == "inherited" and eff["theme"]["source"]["revision"] == 1
        # The template's unpublished edit does not leak.
        PP.put_draft(dw.db, template, content={**PP.draft_of(dw.db, template).content, "theme": {"template": "wolt"}},
                     field_states=None, version=None)
        dw.db.commit()
        assert PP.effective_fields(dw.db, child, PP.draft_of(dw.db, child))["theme"]["value"]["template"] == "chef"
        # Local, even empty, is the child's own; hidden is not empty.
        d = PP.draft_of(dw.db, child)
        PP.put_draft(dw.db, child, content={**d.content, "texts": {}}, field_states={"texts": "local", "sections": "hidden"}, version=d.version)
        eff = PP.effective_fields(dw.db, child, PP.draft_of(dw.db, child))
        assert eff["texts"] == {"value": {}, "state": "local", "source": {"profileId": str(child.id), "revision": 1, "kind": "local"}}
        assert eff["sections"]["state"] == "hidden" and eff["sections"]["value"] is None
        # A parent must be wider than the child.
        with pytest.raises(HTTPException):
            _create(dw, level="company", target=dw.H.id, parentProfileId=str(child.id))

    def test_rollback_publishes_a_copy_and_everything_is_audited(self, dw):
        p = _create(dw)
        _select(dw, p, _drinks(dw))
        PP.publish(dw.db, p, dw.users.admin)
        _select(dw, p, {"mode": "independent", "products": [str(dw.P.id)]})
        PP.publish(dw.db, p, dw.users.admin)
        dw.db.commit()
        first = dw.db.query(PresentationRevision).filter_by(profile_id=p.id, number=1).one()
        back = PP.rollback(dw.db, p, first.id, dw.users.admin, reason="oops")
        dw.db.commit()
        assert back.number == 3 and back.content["selection"] == first.content["selection"]
        actions = [a.action for a in dw.db.query(PresentationAudit).filter_by(profile_id=p.id).order_by(PresentationAudit.created_at)]
        assert actions[0] == "create" and actions.count("publish") == 3 and "rollback" in actions

    def test_a_shop_manager_cannot_write_the_companys_profiles(self, dw):
        with pytest.raises(HTTPException) as e:
            _create(dw, level="company", target=dw.H.id, user=dw.users.h_shop_manager)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException):
            _create(dw, target=dw.b_shop.id, user=dw.users.h_manager)

    def test_match_kiosk_links_the_order_and_follows_its_hides(self, dw):
        dw.db.add(KioskSettings(id=uuid.uuid4(), tenant_id=dw.tid, level="shop", shop_id=dw.h_shop.id,
                                overrides={"catalog": {"productOrder": {dw.drinks: [str(dw.Q.id), str(dw.P.id)]},
                                                       "hiddenProducts": [str(dw.Q.id)]}}))
        dw.db.commit()
        p = _create(dw, kind="online", start={"mode": "match_kiosk", "level": "shop", "targetId": str(dw.h_shop.id)})
        view = DO.resolve_view(dw.db, "online", DO.resolve_target(dw.db, "profile", p.id, dw.tid))
        assert view["linkedLabel"] == "מקושר לקיוסק (H shop)"
        out = _view(dw, p, mode="preview", service="takeaway")
        assert out["products"][str(dw.Q.id)]["display"] == "hide", "hidden at the kiosk"
        assert out["products"][str(dw.P.id)]["orderable"] is True
        assert p.created_from["mode"] == "match_kiosk"

    def test_copy_from_another_profile(self, dw):
        src = _create(dw)
        _select(dw, src, _drinks(dw, future=True))
        p = _create(dw, kind="online", start={"mode": "copy", "profileId": str(src.id), "revision": "draft"})
        assert PP.draft_of(dw.db, p).content["selection"]["categories"][0]["includeFuture"] is True
        assert p.created_from["name"] == "menu profile"


class TestResolver:
    def _published(self, dw, kind="menu", **select):
        p = _create(dw, kind=kind)
        _select(dw, p, select.pop("selection", _drinks(dw)), **select)
        PP.publish(dw.db, p, dw.users.admin)
        dw.db.commit()
        return p

    def test_the_menu_shows_and_never_orders(self, dw):
        p = self._published(dw)
        out = _view(dw, p)
        row = out["products"][str(dw.P.id)]
        assert (row["display"], row["orderable"], row["price"]) == ("show", False, "12.00"), "the shop's price"
        assert out["categories"][0]["products"] == sorted([str(dw.P.id), str(dw.Q.id)], key=lambda i: {str(dw.P.id): "Cola", str(dw.Q.id): "Soda"}[i])

    def test_a_product_switched_on_after_publication_waits(self, dw):
        PC.apply(dw.Q, {"menu": False})
        dw.db.commit()
        p = self._published(dw)
        PC.apply(dw.Q, {"menu": True})
        dw.db.commit()
        row = _view(dw, p)["products"][str(dw.Q.id)]
        assert (row["display"], row["reasons"]) == ("hide", ["not_published"])
        assert _view(dw, p, mode="preview")["products"][str(dw.Q.id)]["display"] == "show", "the preview shows it"
        # Switching it off acts at once.
        PC.apply(dw.P, {"menu": False})
        dw.db.commit()
        assert _view(dw, p)["products"][str(dw.P.id)]["reasons"] == ["channel_off"]

    def test_a_category_taking_future_products_needs_no_publication(self, dw):
        PC.apply(dw.Q, {"menu": False})
        dw.db.commit()
        p = self._published(dw, selection=_drinks(dw, future=True))
        PC.apply(dw.Q, {"menu": True})
        dw.db.commit()
        assert _view(dw, p)["products"][str(dw.Q.id)]["display"] == "show"

    def test_a_web_block_reaches_the_web_and_no_till_a_till_block_not_the_web(self, dw):
        p = self._published(dw)
        web = SO.block(dw.db, tenant_id=dw.tid, product=dw.P, target=SO.resolve_target(dw.db, "shop", dw.h_shop.id, dw.tid),
                       kind="blocked", channels=["menu"], now=NOW)
        till = SO.block(dw.db, tenant_id=dw.tid, product=dw.Q, target=SO.resolve_target(dw.db, "shop", dw.h_shop.id, dw.tid),
                        kind="blocked", now=NOW)
        dw.db.commit()
        assert web.target == "all" and web.channels == ["menu"]
        out = _view(dw, p)
        assert (out["products"][str(dw.P.id)]["display"], out["products"][str(dw.P.id)]["publicReason"]) == ("label", "לא זמין כרגע")
        assert out["products"][str(dw.Q.id)]["display"] == "show", "a block for the tills and kiosks is not the web's"
        till_rows = {r["globalProductId"]: r for r in S.get_products_for_sync(dw.db, str(dw.tid), str(dw.h1.id))}
        assert [b["id"] for b in till_rows[str(dw.P.id)]["blocks"]] == [], "the web-only block never reaches a till"
        assert till_rows[str(dw.P.id)]["isAvailable"] is True
        assert [b["id"] for b in till_rows[str(dw.Q.id)]["blocks"]] == [str(till.id)]
        assert set(till_rows[str(dw.Q.id)]["blocks"][0]) == {
            "id", "scope", "scopeId", "target", "kind", "source", "until", "createdAt", "by", "note", "productId",
            "categoryId", "kioskDisplay",
        }, "the block a till reads has the keys it always had"
        # An internal note never reaches the public view.
        assert "note" not in json.dumps(DE.public_view(out), ensure_ascii=False)

    def test_online_hours_service_and_the_shop_override(self, dw):
        p = self._published(dw, kind="online", schedule={"order": {"takeaway": {"ranges": [["13:00", "22:00"]]}}})
        closed = _view(dw, p, service="takeaway")
        assert closed["open"] == {"access": True, "order": False}
        row = closed["products"][str(dw.P.id)]
        assert (row["display"], row["orderable"], row["reasons"]) == ("show", False, ["closed"])
        later = _view(dw, p, service="takeaway", at=datetime(2026, 10, 11, 11, 0, tzinfo=timezone.utc))
        assert later["products"][str(dw.P.id)]["orderable"] is True
        assert _view(dw, p, service="dine_in")["products"][str(dw.P.id)]["reasons"] == ["service_unavailable"]
        from app.models.product_channel_override import ProductChannelOverride

        dw.db.add(ProductChannelOverride(id=uuid.uuid4(), tenant_id=dw.tid, product_id=dw.P.id, level="area",
                                         target_id=dw.bar.id, channel="online", allowed=False))
        dw.db.commit()
        assert _view(dw, p, area_id=dw.bar.id)["products"][str(dw.P.id)]["reasons"][0] == "channel_off"
        assert _view(dw, p)["products"][str(dw.P.id)]["display"] == "show", "the shop as a whole still has it"

    def test_a_time_menu_offered_on_the_web(self, dw):
        p = self._published(dw)
        menu = CatalogMenu(id=uuid.uuid4(), tenant_id=dw.tid, name="Happy", channel="both", always=True, web_channels=["menu"])
        dw.db.add(menu)
        dw.db.flush()
        dw.db.add(CatalogMenuProduct(id=uuid.uuid4(), menu_id=menu.id, product_id=dw.P.id, sort_order=0, price=5))
        dw.db.add(CatalogMenuAssignment(id=uuid.uuid4(), tenant_id=dw.tid, menu_id=menu.id, level="shop", target_id=dw.h_shop.id, priority=0))
        dw.db.commit()
        out = _view(dw, p)
        assert out["menu"]["mode"] == "menu"
        assert out["products"][str(dw.P.id)]["price"] == "5.00"
        assert out["products"][str(dw.Q.id)]["reasons"] == ["menu_inactive"]
        # The tills' menus block is as it was: no web key in it.
        from app.services import catalog_menus as CM

        block = CM.block_for_machine(dw.db, dw.h1)
        assert "webChannels" not in json.dumps(block)
        assert not _view(dw, p, channel="menu")["products"][str(dw.Q.id)]["orderable"]

    def test_a_company_profile_in_a_named_shop_only_and_never_another_companys(self, dw):
        p = _create(dw, level="company", target=dw.H.id)
        _select(dw, p, _drinks(dw))
        PP.publish(dw.db, p, dw.users.admin)
        dw.db.commit()
        at_h = _view(dw, p, shop_id=dw.h_shop.id)
        assert at_h["products"][str(dw.P.id)]["price"] == "12.00"
        at_a = _view(dw, p, shop_id=dw.a_shop.id)
        assert at_a["products"][str(dw.P.id)]["price"] == "10.00"
        assert str(dw.Q.id) not in at_a["products"], "Q is not sold in a_shop"
        with pytest.raises(HTTPException):
            _view(dw, p, shop_id=dw.b_shop.id)


class TestRoutes:
    def test_list_create_preview_through_the_router(self, dw):
        made = R.menu_router  # the routes exist for both kinds
        assert made is not None and R.online_router is not None
        from app.routers.presentation_profiles import make_router

        router = make_router("online", "/online-ordering")
        create = next(r.endpoint for r in router.routes if r.path.endswith("/profiles") and "POST" in r.methods)
        listing = next(r.endpoint for r in router.routes if r.path.endswith("/profiles") and "GET" in r.methods)
        preview = next(r.endpoint for r in router.routes if r.path.endswith("/preview"))
        out = create({"internalName": "Site", "publicTitle": {"he": "אתר"}, "targetLevel": "shop",
                      "targetId": str(dw.h_shop.id), "serviceTypes": ["takeaway"]},
                     current_user=dw.users.admin, active_tenant_id=dw.tid, db=dw.db)
        pid = out["profile"]["id"]
        rows = listing(company_id=None, shop_id=None, area_id=None, status_=None, search=None, service=None, language=None,
                       counts=True, current_user=dw.users.admin, active_tenant_id=dw.tid, db=dw.db)["profiles"]
        assert [r["id"] for r in rows] == [pid] and rows[0]["counts"] == {"selected": 0, "visible": 0}
        view = preview(pid, R.PreviewIn(), current_user=dw.users.admin, active_tenant_id=dw.tid, db=dw.db)
        assert view["context"]["mode"] == "preview"
        others = listing(company_id=None, shop_id=None, area_id=None, status_=None, search=None, service=None, language=None,
                         counts=False, current_user=dw.users.b_manager, active_tenant_id=dw.tid, db=dw.db)["profiles"]
        assert others == [], "another company's manager does not see it"
