"""
Courses FIRE v2, the settings (P:/specs/courses-fire-v2.md §1, §2, the contract in §5).

What each class pins, and how it could look fine while doing damage:

* **The parameters** — `autoFire` is off unless a level says otherwise (a shop that never asked would
  find its mains leaving by themselves), resolved company → shop → point of sale → till like every till
  parameter, and only the three codes the till parses; `autoFireMinutesOverride` absent by default (each
  course's own minutes), 1–180 only. Both edited on the tables page, in a group of their own.
* **A course's minutes** — 15 unless set, kept when a save does not name them, shipped to the till as
  `courses[].autoFireMinutes`; nothing outside 1–180.
* **"יוצא בלי בון"** — tri-state on the product and the category (null inherits), in the catalog rows
  like `courseId`, and resolved product → category → parent → off (the cloud's own fire reads it so).
* **Publications** — the new fields at their "before" value change no shop's fingerprint (else every
  shop would show unpublished changes the day this ships).

Runs on the world of tests/test_menu.py (SQLite).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.menu import MenuCourse
from app.routers import menu as R
from app.routers import table_restore as RR
from app.schemas.audit_exception import TillEventIn
from app.schemas.menu import CourseIn, CoursesIn
from app.services import course_auto_fire as F
from app.services import menu as M
from app.services import menu_broadcast as MB
from app.services import till_parameters as TP
from test_menu import _run, menu, pull, put_category, put_product  # noqa: F401 - fixtures
from test_shop_areas import _ctx, refused, w  # noqa: F401


def put_level(w, scope_type, scope_id, values):
    body = RR.TableRestoreParamsIn(scopeType=scope_type, scopeId=scope_id, values=values)
    return RR.put_table_restore_params(str(w.company.id), body, **_ctx(w))


def params(w, till):
    return TP.till_parameters_for_machine(w.db, till).parameters


def put_courses(w, courses):
    tasks = BackgroundTasks()
    out = R.put_courses(CoursesIn.model_validate({"courses": courses}), tasks, **_ctx(w))
    _run(tasks)
    return out


# ── The parameters ────────────────────────────────────────────────────────────


class TestParameters:
    def test_builtins_off_by_default(self, w):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        fire, minutes = specs["autoFire"], specs["autoFireMinutesOverride"]
        assert (fire.value_type, fire.default_value, fire.enum_options) == (
            "enum", "off", ("off", "after_minutes", "after_ready"),
        )
        assert TP.enum_labels("autoFire") == {
            "off": "כבוי", "after_minutes": "אחרי מספר דקות", "after_ready": "כשהשלב הקודם מוכן ב-KDS",
        }
        assert (minutes.value_type, minutes.default_value) == ("integer", None)
        TP.ensure_builtin_parameters(w.db)
        w.db.commit()
        got = params(w, w.tills[0])
        # Off for every till; the override absent — each course's own minutes.
        assert got["autoFire"] == "off" and "autoFireMinutesOverride" not in got
        assert F.mode_of(got) == "off" and F.minutes_override_of(got) is None

    def test_by_level_the_most_specific_wins(self, w):
        a, b = w.tills[0], w.tills[1]
        put_level(w, "company", w.company.id, {"autoFire": "after_minutes", "autoFireMinutesOverride": 20})
        put_level(w, "machine", a.id, {"autoFire": "after_ready"})
        assert (params(w, a)["autoFire"], params(w, a)["autoFireMinutesOverride"]) == ("after_ready", 20)
        assert (params(w, b)["autoFire"], params(w, b)["autoFireMinutesOverride"]) == ("after_minutes", 20)
        put_level(w, "machine", a.id, {"autoFire": None})
        assert params(w, a)["autoFire"] == "after_minutes"
        put_level(w, "company", w.company.id, {"autoFireMinutesOverride": None})
        assert "autoFireMinutesOverride" not in params(w, b)

    @pytest.mark.parametrize("values", [
        {"autoFire": "sometimes"},
        {"autoFire": "כבוי"},
        {"autoFireMinutesOverride": 0},
        {"autoFireMinutesOverride": 181},
        {"autoFireMinutesOverride": "15"},
        {"autoFireMinutesOverride": True},
    ])
    def test_only_what_the_till_parses(self, w, values):
        assert refused(put_level, w, "shop", w.shop.id, values).status_code == 422
        with pytest.raises(TP.TillParameterValueError):
            key, value = next(iter(values.items()))
            TP.validate_keyed_value(key, value)

    def test_on_the_tables_page_in_a_group_of_their_own(self, w):
        got = RR.get_table_restore_params(str(w.company.id), scope_type="shop", scope_id=w.shop.id, **_ctx(w))
        courses = [p for p in got["parameters"] if p["group"] == "courses"]
        assert [p["key"] for p in courses] == ["autoFire", "autoFireMinutesOverride"]
        assert courses[0]["enumLabels"]["after_minutes"] == "אחרי מספר דקות"
        # Then "מתי עיקריות?", scheduled items and the hints (P:/specs/fire-restaurant-flow.md §8.1).
        assert got["groups"][-2] == {"key": "courses", "label": "שלבי הגשה: הוצאה אוטומטית"}
        out = put_level(w, "shop", w.shop.id, {"autoFire": "after_minutes", "autoFireMinutesOverride": 5})
        assert out["own"] == {"autoFire": "after_minutes", "autoFireMinutesOverride": 5}

    def test_the_till_reports_its_own_fire(self):
        """`course_auto_fired` is a till event the cloud takes (the LAN host's and the single till's)."""
        body = TillEventIn.model_validate({
            "id": str(uuid.uuid4()), "type": "course_auto_fired", "occurredAt": "2026-10-14T18:00:00Z",
            "details": {"orderId": "o", "courseId": "c", "courseName": "עיקריות", "trigger": "after_minutes"},
        })
        assert body.type == "course_auto_fired"
        from app.services.exceptions import TILL_EVENT_TYPES

        assert "course_auto_fired" in TILL_EVENT_TYPES


# ── A course's minutes ────────────────────────────────────────────────────────


class TestCourseMinutes:
    def test_fifteen_unless_set_kept_unless_named_and_in_the_till_menu(self, menu):
        out = put_courses(menu, [{"name": "ראשונות"}, {"name": "עיקריות", "autoFireMinutes": 20}])
        assert [(c["name"], c["autoFireMinutes"]) for c in out["items"]] == [("ראשונות", 15), ("עיקריות", 20)]
        starters, mains = out["items"]
        # A save that does not name the minutes keeps them.
        out = put_courses(menu, [
            {"id": starters["id"], "name": "ראשונות", "autoFireMinutes": 2}, {"id": mains["id"], "name": "עיקריות"},
        ])
        assert [c["autoFireMinutes"] for c in out["items"]] == [2, 20]
        pulled = pull(menu, menu.tills[0])
        assert [(c["name"], c["autoFireMinutes"]) for c in pulled.menu["courses"]] == [("ראשונות", 2), ("עיקריות", 20)]

    @pytest.mark.parametrize("minutes", [0, 181, -5])
    def test_one_to_one_eighty(self, minutes):
        with pytest.raises(ValidationError):
            CourseIn.model_validate({"name": "עיקריות", "autoFireMinutes": minutes})

    def test_a_course_row_without_minutes_reads_fifteen(self, menu):
        row = MenuCourse(id=uuid.uuid4(), tenant_id=menu.tenant.id, name="קינוחים")
        assert M.course_minutes(row) == 15
        row.auto_fire_minutes = 7
        assert M.course_out(row)["autoFireMinutes"] == 7


# ── "יוצא בלי בון" ────────────────────────────────────────────────────────────


class TestSendSilently:
    def test_tri_state_on_the_forms_and_in_the_catalog_rows(self, menu):
        assert put_product(menu, menu.fries, {})["sendSilently"] is None
        assert put_category(menu, menu.drinks, {})["sendSilently"] is None
        assert put_product(menu, menu.fries, {"setSendSilently": True, "sendSilently": True})["sendSilently"] is True
        assert put_category(menu, menu.drinks, {"setSendSilently": True, "sendSilently": True})["sendSilently"] is True
        # Not named: left alone.
        assert put_product(menu, menu.fries, {"setCourse": False})["sendSilently"] is True
        pulled = pull(menu, menu.tills[0])
        rows = {p["id"]: p for p in pulled.products}
        cats = {c["id"]: c for c in pulled.categories}
        assert rows[str(menu.fries.id)]["sendSilently"] is True
        assert rows[str(menu.cola.id)]["sendSilently"] is None  # its category's
        assert cats[str(menu.drinks.id)]["sendSilently"] is True
        assert cats[str(menu.food.id)]["sendSilently"] is None
        # False is a value (the product says no, whatever its category says), null inherits again.
        assert put_product(menu, menu.cola, {"setSendSilently": True, "sendSilently": False})["sendSilently"] is False
        assert put_product(menu, menu.fries, {"setSendSilently": True, "sendSilently": None})["sendSilently"] is None

    def test_resolved_product_then_category_then_parent(self, menu):
        def silent(*products):
            lines = [F.Line(f"l{i}", str(p.id), str(p.category_id), p.name, 1.0, None, None) for i, p in enumerate(products)]
            names = {str(p.id): p.name for p in products}
            return {names[i] for i in F.silent_products(menu.db, lines)}

        assert silent(menu.burger, menu.fries, menu.cola) == set()
        put_category(menu, menu.food, {"setSendSilently": True, "sendSilently": True})
        # Burgers inherits Food; fries is in Food.
        assert silent(menu.burger, menu.fries, menu.cola) == {"burger", "fries"}
        put_category(menu, menu.burgers, {"setSendSilently": True, "sendSilently": False})
        assert silent(menu.burger, menu.fries) == {"fries"}
        # The product wins.
        put_product(menu, menu.burger, {"setSendSilently": True, "sendSilently": True})
        put_product(menu, menu.fries, {"setSendSilently": True, "sendSilently": False})
        assert silent(menu.burger, menu.fries) == {"burger"}

    def test_a_line_of_a_product_the_cloud_does_not_know_goes_by_its_category(self, menu):
        put_category(menu, menu.drinks, {"setSendSilently": True, "sendSilently": True})
        line = F.Line("l1", str(uuid.uuid4()), str(menu.drinks.id), "local water", 1.0, None, None)
        assert F.silent_products(menu.db, [line]) == {line.product_id}


# ── Publications ──────────────────────────────────────────────────────────────


class TestPublications:
    def test_the_new_fields_at_their_before_value_change_no_fingerprint(self):
        before = {
            "products": {"p": {"name": "burger", "courseId": None}},
            "categories": {"c": {"name": "Food", "courseId": None}},
            "menu": {"courses": [{"id": "k", "name": "עיקריות", "sortOrder": 0}]},
        }
        after = {
            "products": {"p": {"name": "burger", "courseId": None, "sendSilently": None}},
            "categories": {"c": {"name": "Food", "courseId": None, "sendSilently": None}},
            "menu": {"courses": [{"id": "k", "name": "עיקריות", "sortOrder": 0, "autoFireMinutes": 15}]},
        }
        assert MB.content_of(before) == MB.content_of(after)
        changed = {
            "products": {"p": {"name": "burger", "courseId": None, "sendSilently": True}},
            "categories": {"c": {"name": "Food", "courseId": None, "sendSilently": False}},
            "menu": {"courses": [{"id": "k", "name": "עיקריות", "sortOrder": 0, "autoFireMinutes": 20}]},
        }
        assert MB.content_of(before) != MB.content_of(changed)


# ── The migration ─────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_the_release():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    # One head: #105's e3b9d7a41c62 chains on this one, and release 14.10b joins that with its other
    # heads (5d1f8b3e7a92, e4b7c2d9a6f1) in bb6205ba290c; later ones chain on top.
    assert len(heads) == 1
    assert "b637e9784d58" in {r.revision for r in script.walk_revisions("base", heads[0])}
    # On the release's merge of 14.10 (ba584f6fb704), nothing else.
    assert script.get_revision("b637e9784d58").down_revision == "ba584f6fb704"
