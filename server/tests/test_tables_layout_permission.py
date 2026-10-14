"""
"עריכת מפה ושולחנות" — the dashboard section `tables_layout` (the owner, 14.10.2026: "אפשר לתת למנהל לערוך
מפה ואפשר גם לא — דינמי"; P:/specs/live-tables-cloud.md §2 "הרשאות").

What each test pins, and how it could look fine while doing damage:

* **The routes** — every write to the floor itself (zones and their sketch, positions, bulk tables, tables,
  table types) needs `tables_layout` at edit; `tables` at edit alone (the open tables' actions) is refused
  there. Reading the floor stays open to `tables`. A layout route left under `tables` would let every
  manager who runs the floor redraw it.
* **The templates** — the branch / area manager runs the open tables (`tables`, `tables_manage` at edit)
  but never gets the map by default; full access keeps everything.
* **Nobody loses the map** — the migration gives `tables_layout` to every profile and saved template that
  had `tables` at edit (idempotent; one that names it already is left alone).
* **Through the app** — a branch manager is refused a zone edit (403 `section_forbidden`, `tables_layout`)
  before the route runs; the same user with the section is let through.

Runs on the world of tests/test_dashboard_access.py (SQLite).
"""
from __future__ import annotations

import importlib.util
import uuid

import pytest

from app.models.dashboard_access import DashboardAccessProfile, DashboardAccessTemplate
from app.models.user import UserRole
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from test_dashboard_access import ROOT, _headers, _is_section_refusal, _profile, _user, w  # noqa: F401 - fixtures

LAYOUT_WRITES = [
    ("POST", "/tables/zones"),
    ("PATCH", "/tables/zones/{zone_id}"),
    ("POST", "/tables/zones/{zone_id}/archive"),
    ("POST", "/tables/zones/{zone_id}/bulk"),
    ("PUT", "/tables/zones/{zone_id}/positions"),
    ("POST", "/tables/tables"),
    ("PATCH", "/tables/tables/{table_id}"),
    ("POST", "/tables/tables/{table_id}/archive"),
    ("POST", "/tables/types"),
    ("PATCH", "/tables/types/{type_id}"),
    ("POST", "/tables/types/{type_id}/archive"),
]


def access(sections) -> DA.EffectiveAccess:
    return DA.EffectiveAccess(restricted=True, sections=dict(sections), has_profile=True, full_access=False)


@pytest.mark.parametrize("method,path", LAYOUT_WRITES)
def test_every_write_to_the_floor_needs_tables_layout(method, path):
    rule = DS.rule_for(method, path)
    assert rule.sections == (DS.TABLES_LAYOUT_SECTION,) and rule.needed_level(method) == DS.EDIT
    # The open tables at edit, and their management: not the map.
    floor = access({"tables": DS.EDIT, "tables_manage": DS.EDIT})
    refusal = DA.check_rule(floor, rule, method)
    assert refusal.status_code == 403 and refusal.detail["code"] == DA.SECTION_FORBIDDEN
    assert DA.check_rule(access({"tables_layout": DS.VIEW}), rule, method).status_code == 403
    assert DA.check_rule(access({"tables_layout": DS.EDIT}), rule, method) is None
    assert DA.check_rule(DA.UNRESTRICTED, rule, method) is None


def test_reading_the_floor_and_the_live_actions_stay_with_tables():
    for path in ("/tables/layout", "/tables/types"):
        rule = DS.rule_for("GET", path)
        assert DA.check_rule(access({"tables": DS.VIEW}), rule, "GET") is None
        assert DA.check_rule(access({"tables_layout": DS.VIEW}), rule, "GET") is None
    for method, path in (
        ("POST", "/tables/tables/{table_id}/actions/{action}"),
        ("POST", "/tables/tables/{table_id}/cancel"),
        ("POST", "/tables/tables/{table_id}/force-release"),
        ("POST", "/tables/reservations"),
        ("GET", "/tables/tables/{table_id}/card"),
    ):
        rule = DS.rule_for(method, path)
        assert rule.sections == ("tables",), path
        assert DA.check_rule(access({"tables": DS.EDIT}), rule, method) is None
        assert DA.check_rule(access({"tables_layout": DS.EDIT}), rule, method).status_code == 403


def test_the_templates():
    for template in (DS.BRANCH_MANAGER_TEMPLATE, DS.AREA_MANAGER_TEMPLATE):
        sections = DS.BUILTIN_TEMPLATES[template]["sections"]
        assert sections["tables"] == DS.EDIT and sections["tables_manage"] == DS.EDIT
        assert "tables_layout" not in sections, template  # the owner opens the map per manager
        assert DS.clean_sections(sections) == dict(sorted(sections.items()))
    # "גישה מלאה" — everything the role allows, the map included.
    assert DS.BUILTIN_TEMPLATES[DS.FULL_TEMPLATE]["fullAccess"] is True
    assert DA.UNRESTRICTED.allows("tables_layout", DS.EDIT)
    # A template or a user may be given it like any section (the editor lists every section).
    assert DS.clean_sections({"tables_layout": DS.EDIT}) == {"tables_layout": DS.EDIT}
    assert "tables_layout" in DA.grantable(DA.UNRESTRICTED)
    assert DS.SECTION_BY_ID["tables_layout"].label == "עריכת מפה ושולחנות"


def test_a_branch_manager_is_refused_the_map_and_runs_it_with_the_section(w):
    manager = _user(w.db, "bm", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    _profile(w.db, manager, sections=DS.BRANCH_MANAGER_SECTIONS)
    w.db.commit()
    url = f"/api/v1/tables/zones/{uuid.uuid4()}"
    response = w.client.patch(url, headers=_headers(manager, w.tenant), json={"name": "x"})
    assert _is_section_refusal(response) and response.json()["detail"]["section"] == "tables_layout"
    profile = w.db.get(DashboardAccessProfile, manager.id)
    profile.sections = {**DS.BRANCH_MANAGER_SECTIONS, "tables_layout": DS.EDIT}
    w.db.commit()
    DA.forget(w.db)
    response = w.client.patch(url, headers=_headers(manager, w.tenant), json={"name": "x"})
    assert not _is_section_refusal(response)  # through the section check (the zone is not there: 404)


# ── The migration ────────────────────────────────────────────────────────────


def _migrate(w):
    path = next(ROOT.glob("alembic/versions/e3b9d7a41c62_*.py"))
    spec = importlib.util.spec_from_file_location("tables_layout_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    w.db.flush()
    with Operations.context(MigrationContext.configure(w.db.connection())):
        module.upgrade()
    w.db.expire_all()
    DA.forget(w.db)


def test_whoever_edited_the_map_keeps_it(w):
    editor = _user(w.db, "editor", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    viewer = _user(w.db, "viewer", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    chosen = _user(w.db, "chosen", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    full = _user(w.db, "full", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, editor, sections={"tables": "edit", "reports": "view"})
    _profile(w.db, viewer, sections={"tables": "view"})
    _profile(w.db, chosen, sections={"tables": "edit", "tables_layout": "view"})
    _profile(w.db, full, full=True)
    w.db.add(DashboardAccessTemplate(id=uuid.uuid4(), name="מלצרים ראשיים", sections={"tables": "edit"}))
    w.db.commit()

    _migrate(w)
    _migrate(w)  # idempotent

    sections = {u.username: w.db.get(DashboardAccessProfile, u.id).sections for u in (editor, viewer, chosen, full)}
    assert sections["editor"] == {"tables": "edit", "reports": "view", "tables_layout": "edit"}
    assert sections["viewer"] == {"tables": "view"}
    assert sections["chosen"] == {"tables": "edit", "tables_layout": "view"}  # named already: as it was
    assert sections["full"] == {}
    template = w.db.query(DashboardAccessTemplate).filter(DashboardAccessTemplate.name == "מלצרים ראשיים").one()
    assert template.sections == {"tables": "edit", "tables_layout": "edit"}
    assert DA.effective_access(w.db, editor).allows("tables_layout", DS.EDIT)
