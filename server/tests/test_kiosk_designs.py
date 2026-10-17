"""
"עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md, app/services/kiosk_designs.py, app/routers/kiosk_designs.py).

* Groups: a design keeps only its groups' paths — operational settings never ride along.
* Precedence: DEFAULTS ⊕ company ⊕ shop ⊕ [design] ⊕ machine — the design beats every inherited look (an
  explicit parent value and a key it leaves at its default alike), the assigning level's own overrides beat
  the design; the nearest assignment wins; "ללא עיצוב" stops one from above.
* Versions: a design change moves the configVersion of exactly the kiosks using it; its media enter their
  manifests.
* Library: create (from a whole config), rename, duplicate, archive / restore, delete only when unused,
  stale revision 409, names unique, a shop's own design only on that shop; audit; scope and permissions.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskSettings
from app.models.kiosk_design import KioskDesign, KioskDesignAudit
from app.models.user import UserRole
from app.routers import kiosk_designs as D
from app.routers import kiosks as R
from app.services import ably_notify
from app.services import kiosk_config as C
from app.services import kiosk_designs as KD
from shift_world import accept_str_uuids, make_world
from test_kiosks import _user, convert, get_settings, put

RED, BLUE, GREEN, PINK = "#FF0000", "#0000FF", "#00FF00", "#FF00AA"
IMG = {"url": "https://cdn.example/bg-a.jpg", "kind": "image", "sha256": "b" * 64, "bytes": 1000}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    world.kiosk, world.kiosk2 = world.tills
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north-mgr", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    convert(world, world.kiosk, controllers=[])
    convert(world, world.kiosk2, controllers=[])
    convert(world, world.other_till, controllers=[])
    return world


def create(w, name="A", groups=("look", "layout"), *, overrides=None, config=None, shop=None, user=None):
    body = D.DesignCreateIn(
        name=name, groups=list(groups), companyId=None if shop else w.company.id, shopId=shop.id if shop else None,
        overrides=overrides, config=config,
    )
    return D.create_design(body=body, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def assign(w, level, entity_id, design_id=None, *, off=False, clear=False, user=None):
    return R.put_settings_design(
        body=R.KioskDesignAssignIn(designId=design_id, off=off, clearOverlapping=clear), level=level,
        scope_id=entity_id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def update(w, design_id, user=None, **fields):
    return D.update_design(
        design_id=design_id, body=D.DesignUpdateIn(**fields), current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def eff(w, machine):
    w.db.expire_all()
    return C.effective_bundle(w.db, machine)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


# ── Groups ───────────────────────────────────────────────────────────────────


def test_pick_and_strip_keep_only_the_groups_paths():
    layer = {
        "theme": {"primaryColor": RED}, "payment": {"methods": ["card", "voucher"], "waitLogo": {"media": None, "style": "plate"}},
        "general": {"skipCart": "direct", "fulfillmentMode": "KDS"}, "printing": {"bonCopies": 2},
    }
    assert KD.pick(layer, ["look", "flow"]) == {
        "theme": {"primaryColor": RED}, "payment": {"waitLogo": {"media": None, "style": "plate"}},
        "general": {"skipCart": "direct"},
    }
    assert KD.strip(layer, ["look", "flow"]) == {
        "payment": {"methods": ["card", "voucher"]}, "general": {"fulfillmentMode": "KDS"}, "printing": {"bonCopies": 2},
    }
    assert KD.strip({"general": {"skipCart": "direct"}}, ["flow"]) == {}
    assert KD.clean_groups(["motion", "nope", "look", "look"]) == ["look", "motion"]


def test_operational_settings_never_enter_a_design(w):
    out = create(w, overrides={"theme": {"primaryColor": RED}, "payment": {"methods": ["voucher", "card"]}, "printing": {"bonCopies": 3}})
    assert out["overrides"] == {"theme": {"primaryColor": RED}}
    # "שמירה כעיצוב…" from a whole effective config: the groups only, never payments / printing / pickup.
    cfg = C.resolve({"theme": {"primaryColor": BLUE}, "payment": {"methods": ["card", "cash_at_till"]}})
    out = create(w, "Full", ["look"], config=cfg)
    assert set(out["overrides"]) <= {"theme", "screenImages", "payment", "catalog"}
    assert "methods" not in out["overrides"].get("payment", {})
    assert out["overrides"]["theme"]["primaryColor"] == BLUE


def test_invalid_design_layer_is_refused_with_paths(w):
    err = refused(create, w, overrides={"theme": {"primaryColor": "red"}})
    assert err.status_code == 422 and err.detail["code"] == "invalid_kiosk_config"
    assert any(e["path"] == "theme.primaryColor" for e in err.detail["errors"])
    assert refused(create, w, groups=[]).status_code == 422


# ── Precedence ───────────────────────────────────────────────────────────────


def test_design_wins_over_inherited_look_and_loses_to_the_kiosks_own(w):
    put(w, "company", w.company.id, {"theme": {"primaryColor": RED, "backgroundColor": PINK}, "payment": {"tipEnabled": True}})
    put(w, "shop", w.shop.id, {"theme": {"accentColor": RED}})
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    assign(w, "machine", w.kiosk.id, a["id"])
    cfg = eff(w, w.kiosk)["config"]
    assert cfg["theme"]["primaryColor"] == BLUE  # the design over the company's explicit red
    assert cfg["theme"]["backgroundColor"] is None  # …and its default over the company's pink
    assert cfg["theme"]["accentColor"] == C.DEFAULT_CONFIG["theme"]["accentColor"]  # the shop's look too
    assert cfg["payment"]["tipEnabled"] is True  # operational: inherited as before
    # "עריכה רק לקיוסק הזה": the kiosk's own over the design.
    put(w, "machine", w.kiosk.id, {"theme": {"primaryColor": GREEN}})
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == GREEN
    # The other kiosk: no design — the inherited look.
    other = eff(w, w.kiosk2)["config"]["theme"]
    assert other["primaryColor"] == RED and other["backgroundColor"] == PINK and other["accentColor"] == RED


def test_shop_assignment_sits_before_the_shops_own_layer(w):
    put(w, "company", w.company.id, {"theme": {"primaryColor": RED}})
    put(w, "shop", w.shop.id, {"theme": {"accentColor": RED}})
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE, "accentColor": BLUE}})
    assign(w, "shop", w.shop.id, a["id"])
    cfg = eff(w, w.kiosk)["config"]["theme"]
    assert cfg["primaryColor"] == BLUE  # over the company
    assert cfg["accentColor"] == RED  # the shop's own edit over its design
    assert eff(w, w.other_till)["config"]["theme"]["primaryColor"] == RED  # another shop: untouched


def test_nearest_assignment_wins_and_off_stops_it(w):
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    b = create(w, "B", ["look"], overrides={"theme": {"primaryColor": GREEN}})
    assign(w, "company", w.company.id, a["id"])
    assign(w, "machine", w.kiosk2.id, b["id"])
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == BLUE
    assert eff(w, w.kiosk2)["config"]["theme"]["primaryColor"] == GREEN
    assert eff(w, w.other_till)["config"]["theme"]["primaryColor"] == BLUE
    view = assign(w, "machine", w.kiosk.id, off=True)
    assert view["design"]["off"] is True and view["design"]["effective"] is None
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == C.DEFAULT_CONFIG["theme"]["primaryColor"]
    # Back to inherit: the company's design again.
    view = assign(w, "machine", w.kiosk.id)
    assert view["design"]["effective"]["id"] == a["id"] and view["design"]["effective"]["inherited"] is True
    assert view["design"]["effective"]["level"] == "company"


def test_settings_view_inherits_the_design_and_lists_own_edits_over_it(w):
    a = create(w, "A", ["look", "flow"], overrides={"theme": {"primaryColor": BLUE}, "general": {"skipCart": "direct"}})
    put(w, "machine", w.kiosk.id, {"theme": {"primaryColor": GREEN}, "timers": {"inactivitySec": 90}})
    view = assign(w, "machine", w.kiosk.id, a["id"])
    assert view["inherited"]["theme"]["primaryColor"] == BLUE
    assert view["inherited"]["general"]["skipCart"] == "direct"
    assert view["effective"]["theme"]["primaryColor"] == GREEN
    assert view["design"]["assigned"]["name"] == "A"
    assert view["design"]["overDesign"] == ["theme.primaryColor"]
    # "הסר עריכות שגוברות על העיצוב": the level's own look goes, its other settings stay.
    view = assign(w, "machine", w.kiosk.id, a["id"], clear=True)
    assert view["overrides"] == {"timers": {"inactivitySec": 90}}
    assert view["effective"]["theme"]["primaryColor"] == BLUE
    assert view["design"]["overDesign"] == []


def test_validation_of_a_level_runs_over_its_design(w):
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    assign(w, "machine", w.kiosk.id, a["id"])
    out = put(w, "machine", w.kiosk.id, {"timers": {"inactivitySec": 90}})
    assert out["inherited"]["theme"]["primaryColor"] == BLUE
    row = C.layer_row(w.db, "machine", w.kiosk.id)
    assert str(row.design_id) == a["id"]  # a settings save keeps the assignment


# ── Versions and media ───────────────────────────────────────────────────────


def test_design_change_moves_only_the_affected_kiosks_version(w):
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    b = create(w, "B", ["look"], overrides={"theme": {"primaryColor": GREEN}})
    assign(w, "machine", w.kiosk.id, a["id"])
    assign(w, "machine", w.kiosk2.id, b["id"])
    v1, v2, v3 = (eff(w, m)["configVersion"] for m in (w.kiosk, w.kiosk2, w.other_till))
    update(w, a["id"], revision=a["revision"], overrides={"theme": {"primaryColor": PINK, "backgroundImage": IMG}})
    after = eff(w, w.kiosk)
    assert after["configVersion"] != v1 and after["config"]["theme"]["primaryColor"] == PINK
    assert eff(w, w.kiosk2)["configVersion"] == v2
    assert eff(w, w.other_till)["configVersion"] == v3
    # The design's media in the kiosk's download manifest, and only there.
    assert IMG["url"] in {m["url"] for m in after["media"]}
    assert IMG["url"] not in {m["url"] for m in eff(w, w.kiosk2)["media"]}


def test_stale_revision_is_refused(w):
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    update(w, a["id"], revision=a["revision"], name="A1")
    err = refused(update, w, a["id"], revision=a["revision"], name="A2")
    assert err.status_code == 409 and err.detail["code"] == KD.DESIGN_CHANGED


# ── Library ──────────────────────────────────────────────────────────────────


def test_library_rename_duplicate_archive_delete_and_audit(w):
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    assert refused(create, w, "a ").detail["code"] == KD.DESIGN_NAME_TAKEN
    renamed = update(w, a["id"], revision=a["revision"], name="Morning")
    assert renamed["name"] == "Morning"
    copy_ = D.duplicate_design(design_id=a["id"], body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert copy_["name"] == "Morning (עותק)" and copy_["overrides"] == renamed["overrides"] and copy_["id"] != a["id"]
    assign(w, "machine", w.kiosk.id, a["id"])
    err = refused(D.delete_design, design_id=a["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.status_code == 409 and err.detail["code"] == KD.DESIGN_IN_USE
    assert err.detail["assignments"][0]["level"] == "machine"
    # Archive: hidden from the list, the kiosk keeps it.
    D.archive_design(design_id=a["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    listed = D.list_designs(company_id=w.company.id, shop_id=None, archived=False, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert [d["name"] for d in listed["designs"]] == ["Morning (עותק)"]
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == BLUE
    # An archived design is not assigned anew.
    assert refused(assign, w, "machine", w.kiosk2.id, a["id"]).status_code == 422
    D.restore_design(design_id=a["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    D.delete_design(design_id=copy_["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert w.db.get(KioskDesign, uuid.UUID(copy_["id"])) is None
    detail = D.get_design(design_id=a["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert [k["name"] for k in detail["kiosks"]] == [w.db.get(R.svc.KioskDevice, w.kiosk.id).name]
    actions = {r.action for r in w.db.query(KioskDesignAudit).all()}
    assert {"create", "rename", "duplicate", "assign", "archive", "restore", "delete"} <= actions


def test_shop_designs_and_scope(w):
    own = create(w, "Center only", ["look"], overrides={"theme": {"primaryColor": GREEN}}, shop=w.shop, user=w.manager)
    assert own["shopId"] == str(w.shop.id)
    # A shop manager neither creates nor edits a company design, and reads the company's and their own shop's.
    assert refused(create, w, "Co", user=w.manager).status_code == 403
    company_design = create(w, "Co", ["look"])
    assert refused(update, w, company_design["id"], user=w.manager, name="X").status_code == 403
    mine = D.list_designs(company_id=None, shop_id=w.shop.id, archived=False, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
    assert {d["name"] for d in mine["designs"]} == {"Center only", "Co"}
    assert refused(D.get_design, design_id=own["id"], current_user=w.north_manager, active_tenant_id=w.tenant.id, db=w.db).status_code == 404
    # A shop's own design only on that shop and below.
    assign(w, "machine", w.kiosk.id, own["id"], user=w.manager)
    assert refused(assign, w, "machine", w.other_till.id, own["id"]).status_code == 422
    assert refused(assign, w, "company", w.company.id, own["id"]).status_code == 422
    # A cashier: no kiosk role at all.
    assert refused(D.list_designs, company_id=None, shop_id=w.shop.id, archived=False, current_user=w.cashier, active_tenant_id=w.tenant.id, db=w.db).status_code == 403


def test_editor_view_of_a_design_inherits_the_defaults(w):
    a = create(w, "A", ["look"], overrides={"theme": {"uiStyle": "classic", "primaryColor": BLUE}})
    view = a["settings"]
    assert view["level"] == "design" and view["inheritedLayers"] == {}
    assert view["effective"]["theme"]["uiStyle"] == "classic" and view["effective"]["theme"]["primaryColor"] == BLUE
    assert view["configVersion"] == C.config_version(view["effective"])


def test_routes_are_in_the_kiosk_designs_section():
    from app.services import dashboard_sections as S

    ids = {s.id for s in S.SECTIONS}
    assert "kiosk_designs" in ids


def test_the_dashboard_has_the_same_groups():
    """client/src/lib/kioskDesignGroups.ts: the same ids, order, paths and defaults as GROUPS."""
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "client" / "src" / "lib" / "kioskDesignGroups.ts").read_text(encoding="utf-8")
    rows = re.findall(r"\{ id: '(\w+)'.*?paths: \[([^\]]*)\], default: (true|false) \}", source)
    assert [r[0] for r in rows] == list(KD.GROUP_IDS)
    for (gid, paths, default), group in zip(rows, KD.GROUPS):
        assert re.findall(r"'([\w.]+)'", paths) == [".".join(p) for p in group.paths], gid
        assert (default == "true") == (gid in KD.DEFAULT_GROUPS), gid


def test_a_point_of_sale_assigns_a_design_to_its_kiosks(w):
    """With the point-of-sale layer (feat/area-management): an area's design reaches only its kiosks."""
    if not hasattr(KioskSettings, "area_id"):
        pytest.skip("no point-of-sale kiosk layer on this branch yet")
    from app.models.shop_area import ShopArea

    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.kiosk.area_id = area.id
    w.db.commit()
    put(w, "shop", w.shop.id, {"theme": {"primaryColor": RED}})
    a = create(w, "A", ["look"], overrides={"theme": {"primaryColor": BLUE}})
    view = assign(w, "area", area.id, a["id"])
    assert view["design"]["effective"]["level"] == "area"
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == BLUE
    assert eff(w, w.kiosk2)["config"]["theme"]["primaryColor"] == RED
    put(w, "machine", w.kiosk.id, {"theme": {"primaryColor": GREEN}})
    assert eff(w, w.kiosk)["config"]["theme"]["primaryColor"] == GREEN
