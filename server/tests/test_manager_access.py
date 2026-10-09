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
    for view in ("cockpit", "reports", "z", "live_event", "prepaid_vouchers", "promotions"):
        assert sections[view] == DS.VIEW, view
    # "alerts" at edit (the coordinator, 09.10.2026): the branch managers mark alerts "טופל".
    for edit in ("quick_actions", "item_blocks", "device_control", "till_messages", "stock", "alerts"):
        assert sections[edit] == DS.EDIT, edit
    # Kiosks at view: edit would open a kiosk's Z, closing its shift and till↔kiosk conversion.
    assert sections["kiosks"] == DS.VIEW
    # Never the device admin, never full promotions.
    assert "devices" not in sections and sections["promotions"] == DS.VIEW
    for never in ("users", "accounting", "branding", "till_settings", "organization", "pos_users"):
        assert never not in sections, never
    assert DS.clean_sections(sections) == dict(sorted(sections.items()))


def test_the_area_manager_template_is_the_same_for_an_area():
    spec = DS.BUILTIN_TEMPLATES[DS.AREA_MANAGER_TEMPLATE]
    # No area scope yet: the label says so, and it is not offered (`hidden`).
    assert spec["label"] == "מנהל אזור (בקרוב: הגבלה לנקודת מכירה)" and spec["hidden"] is True
    assert spec["sections"] == DS.BUILTIN_TEMPLATES[DS.BRANCH_MANAGER_TEMPLATE]["sections"]
    assert set(DS.MANAGER_TEMPLATES) == {"branch_manager", "area_manager"}


def test_the_templates_are_offered_where_admins_assign_them():
    ids = [t["id"] for t in DA.builtin_templates_out()]
    # "מנהל אזור" is kept out of the assign UI until dashboard users can be scoped to an area.
    assert ids == ["org_manager", "full", "branch_manager"]


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

    def test_off_by_role_alone(self, w):
        # Not by role: a shop manager keeps the full menu unless on a manager template.
        assert UP.read_preferences(w.manager, w.db)["simpleMode"] is False
        assert UP.read_preferences(w.admin, w.db)["simpleMode"] is False
        assert UP.read_preferences(w.company_manager, w.db)["simpleMode"] is False

    def test_on_for_a_shop_manager_on_the_branch_template(self, w):
        self._profile(w, w.manager, DS.BRANCH_MANAGER_TEMPLATE)
        assert UP.read_preferences(w.manager, w.db)["simpleMode"] is True

    def test_on_for_a_user_on_a_manager_template(self, w):
        self._profile(w, w.company_manager, DS.AREA_MANAGER_TEMPLATE)
        prefs = UP.read_preferences(w.company_manager, w.db)
        assert prefs["simpleMode"] is True and prefs["simpleModeDefault"] is True
        # Their opening page is the cockpit (the board).
        assert prefs["homePage"] == "board"

    def test_the_users_own_choice_wins_and_null_restores_the_default(self, w):
        self._profile(w, w.manager, DS.BRANCH_MANAGER_TEMPLATE)
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


@pytest.mark.parametrize(
    "method,path,sections",
    [
        # What the cockpit reads.
        ("GET", "/reports/overview", {"reports", "cockpit"}),
        ("GET", "/reports/hourly", {"reports", "cockpit"}),
        ("GET", "/reports/live-items", {"reports", "cockpit"}),
        ("GET", "/reports/compare", {"reports", "cockpit"}),
        ("GET", "/reports/side-by-side", {"reports", "cockpit"}),
        ("GET", "/reports/event-options", {"reports", "cockpit", "live_event"}),
        ("GET", "/reports/prepaid-vouchers", {"reports", "prepaid_vouchers", "cockpit"}),
        ("GET", "/app-releases/rollout", {"devices", "reports", "cockpit"}),
        ("GET", "/failed-payments", {"reports", "z", "cockpit"}),
        # The cockpit's till message (full sheet: "הודעות לקופות" only — a quick-actions-only manager
        # sends banners through the quick actions), remote control, live event and alerts.
        ("POST", "/till-messages", {"till_messages"}),
        ("POST", "/insights/quick-actions/messages", {"quick_actions"}),
        ("POST", "/machines/{machine_id}/reboot", {"devices", "device_control"}),
        ("DELETE", "/machines/{machine_id}/reboot", {"devices", "device_control"}),
        ("POST", "/machines/{machine_id}/sync", {"devices", "device_control"}),
        ("GET", "/report-events/{event_id}", {"reports", "live_event"}),
        ("GET", "/exception-log", {"reports", "exception_alerts", "alerts"}),
    ],
)
def test_the_new_sections_open_the_routes_the_cockpit_calls(method, path, sections):
    rule = DS.rule_for(method, path)
    assert rule.kind == "section" and set(rule.sections) == sections


def test_a_branch_manager_reaches_every_route_the_cockpit_calls(monkeypatch):
    manager = DA.EffectiveAccess(
        restricted=True, sections=dict(DS.BRANCH_MANAGER_SECTIONS), has_profile=True, full_access=False,
    )
    for method, path in [
        ("GET", "/reports/overview"), ("GET", "/reports/compare"), ("GET", "/reports/prepaid-vouchers"),
        ("GET", "/failed-payments"), ("POST", "/till-messages"), ("POST", "/machines/{machine_id}/reboot"),
        ("POST", "/machines/{machine_id}/sync"), ("GET", "/report-events/{event_id}"), ("GET", "/machines"),
        ("PUT", "/products/{product_id}/availability/shops/{shop_id}"),
    ]:
        assert DA.check_rule(manager, DS.rule_for(method, path), method) is None, (method, path)
    # …and still not the device admin.
    assert DA.check_rule(manager, DS.rule_for("PUT", "/machines/{machine_id}"), "PUT").status_code == 403
    # Nor the kiosk Z: since feat/live-control the kiosk-command route admits remote control
    # (kiosks|device_control, to pause / resume), and the action itself is checked
    # (app/routers/kiosks.py KIOSK_ACTION_SECTIONS): a Z, a shift close and the schedule stay the
    # kiosks section's (a Z also the Z's) — a branch manager holds kiosks at view only.
    from app.routers import kiosks as kiosks_router

    assert DA.check_rule(manager, DS.rule_for("POST", "/kiosks/{machine_id}/commands"), "POST") is None
    monkeypatch.setattr(DA, "effective_access", lambda db, user: manager)
    for action in ("pause", "resume"):
        kiosks_router.check_kiosk_action(None, object(), action)
    for action in ("schedule", "bon_print"):
        with pytest.raises(HTTPException) as refused:
            kiosks_router.check_kiosk_action(None, object(), action)
        assert refused.value.status_code == 403, action
    # A Z / shift close: the branch manager holds Z at view — refused too (Z at edit is not theirs).
    for action in ("till_z", "close_shift"):
        assert DS.BRANCH_MANAGER_SECTIONS.get("z") != DS.EDIT
        with pytest.raises(HTTPException) as refused:
            kiosks_router.check_kiosk_action(None, object(), action)
        assert refused.value.status_code == 403, action


class TestTillMoney:
    """`/machines` is a look-up for everyone; its ₪ only for reports, Z or devices."""

    def _list(self, w, user):
        from app.routers import machines as machines_router

        return machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None, include_inactive=False,
            area_id=None, current_user=user, active_tenant_id=w.tenant.id, db=w.db,
        )

    def _profile(self, w, user, sections):
        w.db.add(DashboardAccessProfile(user_id=user.id, full_access=False, sections=sections))
        w.db.commit()
        DA.forget(w.db)

    def test_stripped_without_reports_z_or_devices(self, w):
        self._profile(w, w.manager, {"products": "edit", "cockpit": "view"})
        rows = self._list(w, w.manager)
        assert rows and all(r["pendingTransmissionAmount"] is None and r["untransmittedCardAmount"] is None for r in rows)
        # The state stays: online, the shift, the alerts.
        assert all("shiftStatus" in r and "lastHeartbeatAt" in r for r in rows)

    @pytest.mark.parametrize("section", ["reports", "z", "devices"])
    def test_kept_with_any_of_them(self, w, section):
        from app.routers import machines as machines_router

        self._profile(w, w.manager, {section: "view"})
        assert machines_router._may_read_till_money(w.db, w.manager)

    def test_kept_for_the_super_admin_and_strip_money_touches_only_the_money(self, w):
        from app.routers import machines as machines_router

        assert machines_router._may_read_till_money(w.db, w.admin)
        self._profile(w, w.manager, {"products": "edit"})
        row = {"pendingTransmissionAmount": "12.00", "untransmittedCardAmount": "3.00", "name": "Till 1"}
        assert machines_router.strip_money([row], w.db, w.manager) == [
            {"pendingTransmissionAmount": None, "untransmittedCardAmount": None, "name": "Till 1"}
        ]
