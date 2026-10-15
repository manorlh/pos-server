"""
"הגדרה מהירה לשלבי הגשה" (app/services/courses_quick_setup.py): the courses, the category mapping and
`coursesEnabled` at a level in one call, its undo, and the status line's on/off switch.

What each class pins, and how it could look fine while doing damage:

* **Suggestions** — the keyword rules: a food course before a drink ("בר סלטים" is starters, not the bar),
  a word not a substring ("ברביקיו" is not the bar), Hebrew prefixes ("הסלטים", "ומשקאות"); bread / water
  offered "יוצא בלי בון"; three courses proposed only to a company none reaches; a category's own course kept.
* **Apply** — one transaction: courses created, categories mapped, the parameter at the chosen level only
  (the other shop's tills stay off); a refused call (an unknown category, a bad value) writes nothing — not
  even the courses created before the check that failed.
* **Re-run** — the same body twice creates no second course, writes nothing, keeps the undo record.
* **Permissions** — the menu's and the till parameters' at that level, both, before anything is written,
  each refused with a Hebrew message.
* **Undo** — puts back what the quick setup wrote, but not a value edited by hand since; removes a course it
  created only when no product, category or open table order names it.
* **The switch** — off clears `coursesEnabled` wherever it is on (the tills go back to "everything at once",
  the mappings stay); on puts it back at those levels; with nowhere known, 409.

Runs on the world of tests/test_menu.py (SQLite).
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.category import Category
from app.models.menu import MenuCourse
from app.models.product import Product
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.user import User, UserRole
from app.routers import menu as R
from app.schemas.courses_quick_setup import CoursesSwitchIn, QuickCompanyIn, QuickSetupIn
from app.services import courses_quick_setup as Q
from app.services import till_parameters as TP
from test_menu import _run, menu, pull  # noqa: F401 - fixtures
from test_shop_areas import _ctx, refused, w  # noqa: F401


# ── Helpers ───────────────────────────────────────────────────────────────────


def view(w, user=None):
    return R.get_courses_quick_setup(company_id=w.company.id, **_ctx(w, user))


def apply(w, body, user=None):
    tasks = BackgroundTasks()
    out = R.post_courses_quick_setup(
        QuickSetupIn.model_validate({"companyId": str(w.company.id), **body}), tasks, **_ctx(w, user),
    )
    _run(tasks)
    return out


def undo(w, user=None):
    tasks = BackgroundTasks()
    out = R.undo_courses_quick_setup(QuickCompanyIn.model_validate({"companyId": str(w.company.id)}), tasks,
                                     **_ctx(w, user))
    _run(tasks)
    return out


def switch(w, on, user=None):
    tasks = BackgroundTasks()
    out = R.put_courses_enabled(CoursesSwitchIn.model_validate({"companyId": str(w.company.id), "on": on}), tasks,
                                **_ctx(w, user))
    _run(tasks)
    return out


def enabled(w, till):
    TP.ensure_builtin_parameters(w.db)
    return TP.till_parameters_for_machine(w.db, till).parameters["coursesEnabled"]


def courses(w):
    return w.db.query(MenuCourse).filter(MenuCourse.tenant_id == w.tenant.id).order_by(MenuCourse.sort_order).all()


def detail(exc: HTTPException):
    return exc.detail if isinstance(exc.detail, dict) else {"code": exc.detail}


@pytest.fixture
def kitchen(menu):
    """The menu world (Food › Burgers, Drinks) plus starters, desserts and bread."""
    w = menu

    def category(name, parent=None, company=w.company.id):
        c = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=company, name=name,
                     parent_id=parent.id if parent else None)
        w.db.add(c)
        w.db.flush()
        return c

    w.starters = category("מנות ראשונות")
    w.desserts = category("קינוחים")
    w.bread = category("לחם הבית")
    w.db.commit()
    return w


def proposed_body(w, **over):
    """What the wizard sends after its suggestions, unchanged: the three courses, every category, the shop."""
    got = view(w)
    refs = {c["key"]: c["key"] for c in got["proposedCourses"]}
    body = {
        "courses": [{"ref": c["key"], "name": c["name"], "autoFireMinutes": c["autoFireMinutes"]}
                    for c in got["proposedCourses"]],
        "mapping": [
            {"categoryId": c["id"], "courseId": refs.get(c["suggestedKey"])} for c in got["categories"]
        ],
        "enable": {"level": "shop", "id": str(w.shop.id), "coursesEnabled": True},
    }
    body.update(over)
    return body


def by_name(w):
    names = {str(c.id): c.name for c in courses(w)}
    return {c.name: names.get(str(c.course_id)) for c in w.db.query(Category).all()}


# ── Suggestions ───────────────────────────────────────────────────────────────


class TestSuggestions:
    @pytest.mark.parametrize("name, key", [
        ("מנות ראשונות", "starters"), ("פתיחים", "starters"), ("הסלטים שלנו", "starters"), ("Starters", "starters"),
        ("Salads", "starters"), ("בר סלטים", "starters"),
        ("מנות עיקריות", "mains"), ("בשרים", "mains"), ("דגים", "mains"), ("פסטות", "mains"), ("פיצות", "mains"),
        ("המבורגרים", "mains"), ("Grill", "mains"), ("Pizza & Pasta", "mains"), ("Main courses", "mains"),
        ("קינוחים", "desserts"), ("מתוקים", "desserts"), ("Desserts", "desserts"), ("קינוחים וקפה", "desserts"),
        ("שתייה", "none"), ("שתיה קלה", "none"), ("ומשקאות", "none"), ("בר", "none"), ("יינות", "none"),
        ("בירה מהחבית", "none"), ("קפה", "none"), ("Drinks", "none"), ("Coffee bar", "none"),
        ("Food", None), ("ברביקיו", None), ("ארוחות ילדים", None), ("", None), ("מָנוֹת רִאשׁוֹנוֹת", "starters"),
    ])
    def test_keyword_rules(self, name, key):
        assert Q.suggest_key(name) == key

    @pytest.mark.parametrize("name, silent", [
        ("לחם הבית", True), ("מים", True), ("Bread", True), ("המים", True), ("מימוזה", False), ("Burgers", False),
    ])
    def test_bread_and_water(self, name, silent):
        assert Q.silent_candidate(name) is silent

    def test_the_view_proposes_three_courses_and_suggests_per_category(self, kitchen):
        w = kitchen
        got = view(w)
        assert [(c["key"], c["name"], c["autoFireMinutes"]) for c in got["proposedCourses"]] == [
            ("starters", "ראשונות", 15), ("mains", "עיקריות", 15), ("desserts", "קינוחים", 15),
        ]
        rows = {c["name"]: c for c in got["categories"]}
        assert rows["Burgers"]["suggestedKey"] == "mains" and rows["Burgers"]["parentId"] == str(w.food.id)
        assert rows["Burgers"]["depth"] == 1 and rows["Food"]["suggestedKey"] is None
        assert rows["Drinks"]["suggestedKey"] == "none" and rows["מנות ראשונות"]["suggestedKey"] == "starters"
        assert rows["לחם הבית"]["silentCandidate"] is True and rows["Drinks"]["silentCandidate"] is False
        # Parents before their children.
        names = [c["name"] for c in got["categories"]]
        assert names.index("Food") < names.index("Burgers")
        assert all(c["canEdit"] for c in got["categories"])
        assert got["status"] == {"on": False, "enabledAt": [], "mapped": 0, "unmapped": 6, "paused": 0,
                                 "canResume": False}
        assert got["undo"] is None
        levels = [(lv["scopeType"], lv["name"]) for lv in got["levels"]]
        assert levels[0] == ("company", "Acme") and ("shop", "Center") in levels
        assert ("machine", "Center › Till 1") in levels and all(lv["canEdit"] for lv in got["levels"])

    def test_no_proposal_when_a_course_reaches_the_company_and_an_own_course_is_kept(self, kitchen):
        w = kitchen
        mains = MenuCourse(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=None, name="מנות עיקריות", sort_order=0)
        w.db.add(mains)
        w.burgers.course_id = mains.id
        w.db.commit()
        got = view(w)
        assert got["proposedCourses"] == []
        assert [(c["name"], c["key"]) for c in got["courses"]] == [("מנות עיקריות", "mains")]
        rows = {c["name"]: c for c in got["categories"]}
        assert rows["Burgers"]["courseId"] == str(mains.id) and rows["Food"]["courseId"] is None
        assert got["status"]["mapped"] == 1


# ── Apply ─────────────────────────────────────────────────────────────────────


class TestApply:
    def test_one_call_courses_mapping_and_the_level(self, kitchen):
        w = kitchen
        body = proposed_body(w)
        for m in body["mapping"]:
            if m["categoryId"] == str(w.bread.id):
                m["sendSilently"] = True
        out = apply(w, body)
        assert [c.name for c in courses(w)] == ["ראשונות", "עיקריות", "קינוחים"]
        assert all(c.company_id == w.company.id and c.auto_fire_minutes == 15 for c in courses(w))
        mapped = by_name(w)
        assert (mapped["Burgers"], mapped["מנות ראשונות"], mapped["קינוחים"]) == ("עיקריות", "ראשונות", "קינוחים")
        # Food has no rule, Drinks go at once: none.
        assert mapped["Food"] is None and mapped["Drinks"] is None
        assert w.db.get(Category, w.bread.id).send_silently is True
        # The shop's tills, not the other shop's.
        assert enabled(w, w.tills[0]) is True and enabled(w, w.tills[1]) is True
        assert enabled(w, w.other_till) is False
        status = out["view"]["status"]
        assert status["on"] is True and [lv["name"] for lv in status["enabledAt"]] == ["Center"]
        assert (status["mapped"], status["unmapped"]) == (3, 3)
        assert out["changes"]["params"] == [
            {"scopeType": "shop", "scopeId": str(w.shop.id), "key": "coursesEnabled", "before": None, "after": True},
        ]
        assert out["view"]["undo"]["courses"] == 3 and out["view"]["undo"]["categories"] == 4
        # The tills get the courses with the menu.
        assert [c["name"] for c in pull(w, w.tills[0]).menu["courses"]] == ["ראשונות", "עיקריות", "קינוחים"]

    def test_the_fire_options_at_the_level(self, kitchen):
        w = kitchen
        enable = {"level": "machine", "id": str(w.tills[0].id), "coursesEnabled": True,
                  "fireAskOnSend": "never", "autoFire": "after_minutes"}
        apply(w, proposed_body(w, enable=enable))
        got = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert (got["coursesEnabled"], got["fireAskOnSend"], got["autoFire"]) == (True, "never", "after_minutes")
        assert enabled(w, w.tills[1]) is False

    def test_the_value_the_level_already_gets_is_not_written(self, kitchen):
        w = kitchen
        out = apply(w, proposed_body(w, enable={"level": "shop", "id": str(w.shop.id), "coursesEnabled": True,
                                               "fireAskOnSend": "ask", "autoFire": "off"}))
        # "ask" and "off" are the defaults: only coursesEnabled is written.
        assert [p["key"] for p in out["changes"]["params"]] == ["coursesEnabled"]

    def test_an_existing_course_by_id_and_a_new_one(self, kitchen):
        w = kitchen
        own = MenuCourse(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="עיקריות", sort_order=4)
        w.db.add(own)
        w.db.commit()
        apply(w, {
            "courses": [{"id": str(own.id), "name": "עיקריות"}, {"ref": "d", "name": "קינוחים"}],
            "mapping": [{"categoryId": str(w.burgers.id), "courseId": str(own.id)},
                        {"categoryId": str(w.desserts.id), "courseId": "d"}],
        })
        assert [(c.name, c.sort_order) for c in courses(w)] == [("עיקריות", 4), ("קינוחים", 5)]
        assert by_name(w)["Burgers"] == "עיקריות" and by_name(w)["קינוחים"] == "קינוחים"
        assert enabled(w, w.tills[0]) is False  # no `enable`: no parameter written

    @pytest.mark.parametrize("case", ["unknown category", "unknown course", "foreign category"])
    def test_a_refused_call_writes_nothing(self, kitchen, case):
        w = kitchen
        body = proposed_body(w)
        if case == "unknown category":
            body["mapping"].append({"categoryId": str(uuid.uuid4()), "courseId": None})
        elif case == "unknown course":
            next(m for m in body["mapping"] if m["categoryId"] == str(w.burgers.id))["courseId"] = "nope"
        else:
            from app.models.company import Company

            other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other")
            w.db.add(other)
            w.db.flush()
            far = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="סלטים")
            w.db.add(far)
            w.db.commit()
            body["mapping"].append({"categoryId": str(far.id), "courseId": "starters"})
        assert refused(apply, w, body).status_code == 400
        assert courses(w) == [] and by_name(w)["Burgers"] is None and enabled(w, w.tills[0]) is False

    def test_a_bad_parameter_value_rolls_the_courses_back(self, kitchen):
        w = kitchen
        body = proposed_body(w, enable={"level": "shop", "id": str(w.shop.id), "autoFire": "sometimes"})
        exc = refused(apply, w, body)
        assert exc.status_code == 422 and detail(exc)["code"] == "invalid_value"
        assert courses(w) == [] and by_name(w)["Burgers"] is None and enabled(w, w.tills[0]) is False
        assert "coursesQuickSetup" not in (w.db.get(type(w.company), w.company.id).settings or {})

    def test_the_body_holds_together(self, kitchen):
        w = kitchen
        with pytest.raises(ValidationError):
            QuickSetupIn.model_validate({"companyId": str(w.company.id),
                                         "courses": [{"name": "א"}, {"name": "א"}]})
        with pytest.raises(ValidationError):
            QuickSetupIn.model_validate({"companyId": str(w.company.id), "mapping": [
                {"categoryId": str(w.food.id)}, {"categoryId": str(w.food.id)}]})
        with pytest.raises(ValidationError):
            QuickSetupIn.model_validate({"companyId": str(w.company.id),
                                         "enable": {"level": "tenant", "id": str(w.company.id)}})

    def test_a_level_of_another_company_is_refused(self, kitchen):
        w = kitchen
        exc = refused(apply, w, proposed_body(w, enable={"level": "shop", "id": str(w.foreign_shop.id)}))
        assert exc.status_code == 404 and detail(exc)["code"] == "quick_setup_level_not_found"
        assert courses(w) == []


class TestRerun:
    def test_the_same_body_twice_changes_nothing_the_second_time(self, kitchen):
        w = kitchen
        body = proposed_body(w)
        apply(w, body)
        record = json.dumps(w.db.get(type(w.company), w.company.id).settings["coursesQuickSetup"], sort_keys=True)
        again = apply(w, body)
        assert again["changes"] == {"courses": [], "categories": [], "params": []}
        assert [c.name for c in courses(w)] == ["ראשונות", "עיקריות", "קינוחים"]
        after = json.dumps(w.db.get(type(w.company), w.company.id).settings["coursesQuickSetup"], sort_keys=True)
        assert after == record

    def test_a_rerun_from_fresh_suggestions_reuses_the_courses_and_keeps_the_first_before(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        # The wizard opened again: the courses now exist, the categories are set.
        got = view(w)
        assert got["proposedCourses"] == []
        ids = {c["key"]: c["id"] for c in got["courses"]}
        mapping = [{"categoryId": c["id"], "courseId": c["courseId"] or ids.get(c["suggestedKey"])}
                   for c in got["categories"]]
        # One change by the second run: Food → mains.
        for m in mapping:
            if m["categoryId"] == str(w.food.id):
                m["courseId"] = ids["mains"]
        out = apply(w, {"courses": [], "mapping": mapping})
        assert [c["field"] for c in out["changes"]["categories"]] == ["courseId"] and len(courses(w)) == 3
        undo(w)
        assert set(by_name(w).values()) == {None} and courses(w) == []


# ── Permissions ───────────────────────────────────────────────────────────────


def grant(w, user, *, full=True, sections=None):
    """A dashboard access profile (no row: "מנהל ארגון" — products, no till settings)."""
    from app.models.dashboard_access import DashboardAccessProfile
    from app.services import dashboard_access as DA

    w.db.add(DashboardAccessProfile(user_id=user.id, full_access=full, sections=dict(sections or {})))
    w.db.commit()
    DA.forget(w.db)
    return user


def _user(w, role, name, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{name}@x", username=name, **kw)
    w.db.add(u)
    w.db.commit()
    return grant(w, u)


class TestPermissions:
    def test_a_cashier_and_a_manager_without_the_company_menu_are_refused(self, kitchen):
        w = kitchen
        for user in (w.cashier, w.manager):
            exc = refused(apply, w, proposed_body(w), user=user)
            assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_menu_forbidden"
            assert "התפריט" in detail(exc)["message"]
        assert courses(w) == []

    def test_the_company_manager_at_the_company(self, kitchen):
        w = kitchen
        grant(w, w.company_manager)
        apply(w, proposed_body(w, enable={"level": "company", "id": str(w.company.id)}), user=w.company_manager)
        assert enabled(w, w.tills[0]) is True and enabled(w, w.other_till) is True

    def test_the_till_settings_section_of_the_dashboard_too(self, kitchen):
        """The routes are the menu's (products); the parameters need till settings (or tables) at edit."""
        w = kitchen
        # No profile: "מנהל ארגון" — the menu, not the till settings.
        got = view(w, user=w.company_manager)
        assert got["canEditMenu"] is True and not any(lv["canEdit"] for lv in got["levels"])
        exc = refused(apply, w, proposed_body(w, enable={"level": "company", "id": str(w.company.id)}),
                      user=w.company_manager)
        assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_params_forbidden"
        assert courses(w) == []
        # Without a level: the menu part alone is theirs.
        apply(w, proposed_body(w, enable=None), user=w.company_manager)
        assert len(courses(w)) == 3 and enabled(w, w.tills[0]) is False
        grant(w, w.company_manager, full=False, sections={"products": "edit", "till_settings": "edit"})
        apply(w, proposed_body(w, enable={"level": "company", "id": str(w.company.id)}), user=w.company_manager)
        assert enabled(w, w.tills[0]) is True

    def test_a_shop_manager_writes_their_shop_not_the_company_nor_another_shop(self, kitchen):
        w = kitchen
        boss = _user(w, UserRole.SHOP_MANAGER, "boss", shop_id=w.shop.id, company_id=w.company.id)
        for level, ident in (("company", w.company.id), ("shop", w.other_shop.id), ("machine", w.other_till.id)):
            exc = refused(apply, w, proposed_body(w, enable={"level": level, "id": str(ident)}), user=boss)
            assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_params_forbidden"
            assert "פרמטרי קופה" in detail(exc)["message"]
        assert courses(w) == [] and by_name(w)["Burgers"] is None
        apply(w, proposed_body(w, enable={"level": "shop", "id": str(w.shop.id)}), user=boss)
        assert enabled(w, w.tills[0]) is True and enabled(w, w.other_till) is False
        levels = {lv["scopeId"]: lv["canEdit"] for lv in view(w, user=boss)["levels"]}
        assert levels[str(w.shop.id)] is True and levels[str(w.company.id)] is False

    def test_an_organization_category_needs_an_admin(self, kitchen):
        w = kitchen
        org = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=None, name="Pizza")
        w.db.add(org)
        w.db.commit()
        grant(w, w.company_manager)
        got = view(w, user=w.company_manager)
        assert {c["name"]: c["canEdit"] for c in got["categories"]}["Pizza"] is False
        body = proposed_body(w)
        exc = refused(apply, w, body, user=w.company_manager)
        assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_category_forbidden"
        assert "Pizza" in detail(exc)["message"] and courses(w) == []
        # Left as it is (null), the row is no change: allowed.
        for m in body["mapping"]:
            if m["categoryId"] == str(org.id):
                m["courseId"] = None
        apply(w, body, user=w.company_manager)
        assert len(courses(w)) == 3

    def test_reading_needs_the_company(self, kitchen):
        w = kitchen
        stranger = _user(w, UserRole.CASHIER, "stranger")
        exc = refused(view, w, user=stranger)
        assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_forbidden"


# ── Undo ──────────────────────────────────────────────────────────────────────


class TestUndo:
    def test_puts_everything_back(self, kitchen):
        w = kitchen
        w.drinks.send_silently = False
        w.db.commit()
        body = proposed_body(w, enable={"level": "shop", "id": str(w.shop.id), "autoFire": "after_ready"})
        for m in body["mapping"]:
            if m["categoryId"] in (str(w.bread.id), str(w.drinks.id)):
                m["sendSilently"] = True
        apply(w, body)
        out = undo(w)
        assert courses(w) == [] and set(by_name(w).values()) == {None}
        assert w.db.get(Category, w.bread.id).send_silently is None
        assert w.db.get(Category, w.drinks.id).send_silently is False
        got = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert (got["coursesEnabled"], got["autoFire"]) == (False, "off")
        assert len(out["result"]["restored"]["coursesRemoved"]) == 3
        assert out["result"]["kept"] == {"categories": [], "params": [], "courses": []}
        assert out["view"]["undo"] is None and out["view"]["status"]["on"] is False
        assert refused(undo, w).status_code == 409

    def test_a_value_edited_by_hand_since_is_kept(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        dessert = next(c for c in courses(w) if c.name == "קינוחים")
        mains = next(c for c in courses(w) if c.name == "עיקריות")
        # By hand, after the quick setup: Burgers → desserts (odd, but theirs); the shop's parameter turned off.
        w.db.get(Category, w.burgers.id).course_id = dessert.id
        from app.services import table_restore as TR

        TR.save_values(w.db, "shop", w.shop.id, {"coursesEnabled": False}, user=w.admin, groups=Q._GROUPS)
        w.db.commit()
        out = undo(w)["result"]
        assert {(c["name"], c["field"]) for c in out["kept"]["categories"]} == {("Burgers", "courseId")}
        assert out["kept"]["params"] == [{"scopeType": "shop", "scopeId": str(w.shop.id), "key": "coursesEnabled"}]
        assert enabled(w, w.tills[0]) is False
        # The course Burgers still names stays; the others go.
        assert [c["name"] for c in out["kept"]["courses"]] == ["קינוחים"]
        assert out["kept"]["courses"][0]["references"] == {"categories": 1}
        assert {c.name for c in courses(w)} == {"קינוחים"} and w.db.get(MenuCourse, mains.id) is None

    def test_a_course_a_product_or_an_open_order_names_is_kept(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        starters = next(c for c in courses(w) if c.name == "ראשונות")
        mains = next(c for c in courses(w) if c.name == "עיקריות")
        w.db.get(Product, w.fries.id).course_id = starters.id
        zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם", layout="grid")
        w.db.add(zone)
        w.db.flush()
        table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=4)
        w.db.add(table)
        w.db.flush()
        w.db.add(TableOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, table_number=4,
            status="open", source="synced", total=Decimal("52"),
            cart_json=json.dumps([{"id": "l1", "details": {"course": {"id": str(mains.id), "name": "עיקריות"}}}]),
        ))
        w.db.commit()
        out = undo(w)["result"]
        kept = {c["name"]: c["references"] for c in out["kept"]["courses"]}
        assert kept == {"ראשונות": {"products": 1}, "עיקריות": {"orders": 1}}
        assert {c.name for c in courses(w)} == {"ראשונות", "עיקריות"}
        # The categories went back all the same.
        assert set(by_name(w).values()) == {None}

    def test_a_level_deleted_since_does_not_block_the_undo(self, kitchen):
        from app.models.shop_area import ShopArea

        w = kitchen
        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
        w.db.add(area)
        w.db.commit()
        apply(w, proposed_body(w, enable={"level": "area", "id": str(area.id)}))
        w.db.delete(w.db.get(ShopArea, area.id))
        w.db.commit()
        out = undo(w)["result"]
        assert out["restored"]["params"] == [] and courses(w) == []

    def test_undo_needs_the_parameters_level_too(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w, enable={"level": "company", "id": str(w.company.id)}))
        boss = _user(w, UserRole.SHOP_MANAGER, "boss", shop_id=w.shop.id, company_id=w.company.id)
        exc = refused(undo, w, user=boss)
        assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_params_forbidden"
        assert len(courses(w)) == 3 and enabled(w, w.tills[0]) is True


# ── The switch ────────────────────────────────────────────────────────────────


class TestSwitch:
    def test_off_then_on(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        from app.services import table_restore as TR

        TR.save_values(w.db, "machine", w.other_till.id, {"coursesEnabled": True}, user=w.admin, groups=Q._GROUPS)
        w.db.commit()
        out = switch(w, False)
        assert sorted(out["levels"]) == sorted([str(w.shop.id), str(w.other_till.id)])
        assert not any(enabled(w, t) for t in (*w.tills, w.other_till))
        status = out["view"]["status"]
        assert status["on"] is False and status["paused"] == 2 and status["canResume"] is True
        # The mappings stay (inert while off).
        assert by_name(w)["Burgers"] == "עיקריות" and status["mapped"] == 3
        out = switch(w, True)
        assert all(enabled(w, t) for t in (*w.tills, w.other_till))
        assert out["view"]["status"]["on"] is True and out["view"]["status"]["paused"] == 0
        # Already on: nothing to do.
        assert switch(w, True)["levels"] == []

    def test_on_without_a_known_level_is_refused(self, kitchen):
        w = kitchen
        exc = refused(switch, w, True)
        assert exc.status_code == 409 and detail(exc)["code"] == "quick_setup_no_level"
        apply(w, proposed_body(w, enable=None))
        assert refused(switch, w, True).status_code == 409

    def test_on_after_the_quick_setup_level(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        from app.services import table_restore as TR

        # Turned off by hand on the parameters page: the switch turns it on where the quick setup did.
        TR.save_values(w.db, "shop", w.shop.id, {"coursesEnabled": None}, user=w.admin, groups=Q._GROUPS)
        w.db.commit()
        switch(w, True)
        assert enabled(w, w.tills[0]) is True and enabled(w, w.other_till) is False

    def test_the_switch_needs_the_level(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w, enable={"level": "company", "id": str(w.company.id)}))
        boss = _user(w, UserRole.SHOP_MANAGER, "boss", shop_id=w.shop.id, company_id=w.company.id)
        exc = refused(switch, w, False, user=boss)
        assert exc.status_code == 403 and detail(exc)["code"] == "quick_setup_params_forbidden"
        assert enabled(w, w.tills[0]) is True

    def test_undo_after_the_switch_turned_it_off(self, kitchen):
        w = kitchen
        apply(w, proposed_body(w))
        switch(w, False)
        out = undo(w)
        assert out["result"]["kept"]["params"] == [] and out["view"]["status"]["canResume"] is False
        assert enabled(w, w.tills[0]) is False and courses(w) == []
