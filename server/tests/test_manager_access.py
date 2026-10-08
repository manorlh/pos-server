"""
"תבנה קבוצת הרשאות לזה" — the manager's permission group for the cockpit ("הניהול שלי").

* the six sections exist with exactly the ids the other features use, on both sides;
* "מנהל סניף / אירוע" and "מנהל אזור" give exactly what a manager who runs a place needs —
  never users, accounting, branding, till settings, organization or till users;
* "חסימות ואזל" opens a product's sold-out / blocked state without the catalog;
* "תצוגת מנהל פשוטה" is on by default for a shop manager and for a user on a manager
  template, off for owners and admins, and the user's own choice wins.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.dashboard_access import DashboardAccessProfile
from app.routers import users as users_router
from app.schemas.user import UserPreferencesUpdate
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import user_preferences as UP
from test_shop_areas import w  # noqa: F401

NEW_SECTIONS = ("cockpit", "quick_actions", "item_blocks", "device_control", "live_event", "alerts")


def test_the_manager_sections_are_in_the_catalogue():
    assert set(NEW_SECTIONS) <= DS.SECTION_IDS
    labels = {s.id: s.label for s in DS.SECTIONS}
    assert labels["cockpit"] == "הניהול שלי"
    assert labels["quick_actions"] == "פעולות מהירות"
    assert labels["item_blocks"] == "חסימות ואזל"
    assert labels["device_control"] == "שליטה מרחוק בקופות וקיוסקים"
    assert labels["live_event"] == "מצב אירוע חי"
    assert labels["alerts"] == "התראות"
    # Insights stays a report.
    assert "insights" not in DS.SECTION_IDS


def test_the_branch_manager_template():
    spec = DS.BUILTIN_TEMPLATES[DS.BRANCH_MANAGER_TEMPLATE]
    assert spec["label"] == "מנהל סניף / אירוע" and spec["fullAccess"] is False
    sections = spec["sections"]
    for view in ("cockpit", "reports", "z", "live_event", "alerts", "prepaid_vouchers", "promotions"):
        assert sections[view] == DS.VIEW, view
    for edit in ("quick_actions", "item_blocks", "device_control", "till_messages", "kiosks", "stock"):
        assert sections[edit] == DS.EDIT, edit
    for never in ("users", "accounting", "branding", "till_settings", "organization", "pos_users"):
        assert never not in sections, never
    assert DS.clean_sections(sections) == dict(sorted(sections.items()))


def test_the_area_manager_template_is_the_same_for_an_area():
    spec = DS.BUILTIN_TEMPLATES[DS.AREA_MANAGER_TEMPLATE]
    assert spec["label"] == "מנהל אזור"
    assert spec["sections"] == DS.BUILTIN_TEMPLATES[DS.BRANCH_MANAGER_TEMPLATE]["sections"]
    assert set(DS.MANAGER_TEMPLATES) == {"branch_manager", "area_manager"}


def test_the_templates_are_offered_where_admins_assign_them():
    ids = [t["id"] for t in DA.builtin_templates_out()]
    assert ids == ["org_manager", "full", "branch_manager", "area_manager"]


@pytest.mark.parametrize(
    "method,path,level",
    [
        ("GET", "/products/{}/availability", DS.VIEW),
        ("PUT", "/products/{}/availability/shops/{}", DS.EDIT),
        ("PUT", "/products/{}/availability/machines/{}", DS.EDIT),
        ("POST", "/products/availability-summary", DS.VIEW),
        ("GET", "/availability/reopens", DS.VIEW),
    ],
)
def test_blocks_and_sold_outs_open_with_item_blocks(method, path, level):
    rule = DS.rule_for(method, path.replace("{}", "{id}"))  # route templates, as the app registers them
    assert rule.kind == "section" and set(rule.sections) == {"products", "item_blocks"}
    assert rule.needed_level(method) == level
    blocks = DA.EffectiveAccess(restricted=True, sections={"item_blocks": level}, has_profile=True, full_access=False)
    assert DA.check_rule(blocks, rule, method) is None
    nothing = DA.EffectiveAccess(restricted=True, sections={"cockpit": DS.VIEW}, has_profile=True, full_access=False)
    assert DA.check_rule(nothing, rule, method).status_code == 403


def test_a_branch_manager_does_not_get_the_catalog_itself():
    rule = DS.rule_for("PUT", "/products/{product_id}")
    manager = DA.EffectiveAccess(
        restricted=True, sections=dict(DS.BRANCH_MANAGER_SECTIONS), has_profile=True, full_access=False,
    )
    assert DA.check_rule(manager, rule, "PUT").status_code == 403


class TestSimpleManagerMode:
    def _profile(self, w, user, template, full=False):
        w.db.add(DashboardAccessProfile(user_id=user.id, full_access=full, sections={}, builtin_template=template))
        w.db.commit()

    def test_on_for_a_shop_manager_off_for_an_admin(self, w):
        assert UP.read_preferences(w.manager, w.db)["simpleMode"] is True
        assert UP.read_preferences(w.admin, w.db)["simpleMode"] is False
        assert UP.read_preferences(w.company_manager, w.db)["simpleMode"] is False

    def test_on_for_a_user_on_a_manager_template(self, w):
        self._profile(w, w.company_manager, DS.AREA_MANAGER_TEMPLATE)
        prefs = UP.read_preferences(w.company_manager, w.db)
        assert prefs["simpleMode"] is True and prefs["simpleModeDefault"] is True
        # Their opening page is the cockpit (the board).
        assert prefs["homePage"] == "board"

    def test_the_users_own_choice_wins_and_null_restores_the_default(self, w):
        out = users_router.update_my_preferences(UserPreferencesUpdate(simpleMode=False), current_user=w.manager, db=w.db)
        assert out.simple_mode is False and out.simple_mode_default is True
        back = users_router.update_my_preferences(UserPreferencesUpdate(simpleMode=None), current_user=w.manager, db=w.db)
        assert back.simple_mode is True
        on = users_router.update_my_preferences(UserPreferencesUpdate(simpleMode=True), current_user=w.admin, db=w.db)
        assert on.simple_mode is True and on.simple_mode_default is False

    def test_a_bad_value_is_refused(self, w):
        with pytest.raises(HTTPException) as e:
            UP.update_preferences(w.db, w.manager, {"simpleMode": "yes"})
        assert e.value.status_code == 422
