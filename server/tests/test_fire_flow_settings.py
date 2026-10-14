"""
"FIRE כמו במסעדות" + "שיגור מתוזמן של פריט", the settings (P:/specs/fire-restaurant-flow.md §8.1–§8.2).

What each class pins, and how it could look fine while doing damage:

* **The parameters** — the six with their defaults (ask / "10,15,20" / on / "5,10,15,20,30" / ask / true), by
  level, and only values the till parses (a `default:999` or "10,,15" would leave the till guessing); on the
  tables page in a group of their own.
* **The catalog's rule** — on the product and the category forms, in the catalog rows, resolved as a pair
  product → category → parent (0 minutes and no course stops it); a course of another tenant refused.
* **Publications** — the new fields at their "before" value change no shop's fingerprint.
* **Till design** — `behavior.fireHints` (auto by default) validated like every field.
* **The migration** — the single head, on the release's head.

Runs on the world of tests/test_menu.py (SQLite).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.services import fire_flow as FF
from app.services import menu_broadcast as MB
from app.services import till_design as TD
from app.services import till_parameters as TP
from test_course_settings import params, put_courses, put_level
from test_menu import menu, pull, put_category, put_product  # noqa: F401 - fixtures
from test_shop_areas import _ctx, w  # noqa: F401


# ── The parameters ────────────────────────────────────────────────────────────


class TestParameters:
    def test_defaults_and_labels(self, w):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        assert {k: specs[k].default_value for k in FF.LEVEL_KEYS} == {
            "fireAskOnSend": "ask", "fireAskMinutes": "10,15,20", "fireHints": "on",
            "itemScheduleMinutes": "5,10,15,20,30", "itemScheduleOnClose": "ask", "kdsShowScheduled": True,
        }
        assert specs["fireHints"].enum_options == ("on", "first_time", "off")
        assert specs["itemScheduleOnClose"].enum_options == ("ask", "send", "cancel")
        assert all(specs[k].label and specs[k].description for k in FF.LEVEL_KEYS)
        TP.ensure_builtin_parameters(w.db)
        w.db.commit()
        got = params(w, w.tills[0])
        assert got["fireAskOnSend"] == "ask" and got["kdsShowScheduled"] is True
        assert got["fireAskMinutes"] == "10,15,20" and got["itemScheduleMinutes"] == "5,10,15,20,30"

    def test_by_level(self, w):
        a, b = w.tills[0], w.tills[1]
        put_level(w, "company", w.company.id, {"fireAskOnSend": "default:15", "fireHints": "first_time"})
        put_level(w, "machine", a.id, {"fireAskOnSend": "never", "fireAskMinutes": " 5, 10 ,25"})
        assert params(w, a)["fireAskOnSend"] == "never" and params(w, a)["fireAskMinutes"] == "5,10,25"
        assert params(w, b)["fireAskOnSend"] == "default:15" and params(w, b)["fireHints"] == "first_time"

    @pytest.mark.parametrize("value, out", [
        ("ask", "ask"), ("never", "never"), ("default:manual", "default:manual"), ("default:ready", "default:ready"),
        ("default:now", "default:now"), ("default:15", "default:15"), ("default:180", "default:180"),
    ])
    def test_ask_values(self, value, out):
        assert TP.validate_keyed_value("fireAskOnSend", value) == out

    @pytest.mark.parametrize("key, value", [
        ("fireAskOnSend", "default:181"), ("fireAskOnSend", "default:0"), ("fireAskOnSend", "default:"),
        ("fireAskOnSend", "sometimes"), ("fireAskOnSend", 15),
        ("fireAskMinutes", "10,,15"), ("fireAskMinutes", "10,10"), ("fireAskMinutes", "0"), ("fireAskMinutes", "181"),
        ("fireAskMinutes", "1,2,3,4,5,6,7"), ("fireAskMinutes", ""),
        ("itemScheduleMinutes", "601"), ("itemScheduleMinutes", "1,2,3,4,5,6,7,8,9"), ("itemScheduleMinutes", "x"),
        ("fireHints", "sometimes"), ("itemScheduleOnClose", "later"),
    ])
    def test_only_what_the_till_parses(self, key, value):
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value(key, value)

    def test_on_the_tables_page_in_a_group_of_their_own(self, w):
        from app.routers import table_restore as RR

        got = RR.get_table_restore_params(str(w.company.id), scope_type="company", scope_id=w.company.id, **_ctx(w))
        keys = [p["key"] for p in got["parameters"] if p["group"] == "fireFlow"]
        assert keys == list(FF.LEVEL_KEYS)
        assert [g["key"] for g in got["groups"]][-1] == "fireFlow"


# ── The catalog's rule ────────────────────────────────────────────────────────


def rule_of(menu, product):
    from app.models.category import Category

    menu.db.expire_all()
    cats = {str(c.id): c for c in menu.db.query(Category).all()}
    return FF.rule_of(menu.db.get(type(product), product.id), cats)


class TestCatalogRule:
    def test_on_the_forms_and_in_the_catalog_rows(self, menu):
        courses = put_courses(menu, [{"name": "ראשונות", "sortOrder": 0}, {"name": "עיקריות", "sortOrder": 1}])
        mains = courses["items"][1]["id"]
        out = put_product(menu, menu.fries, {})
        assert (out["scheduleAfterMinutes"], out["scheduleAfterCourseReady"]) == (None, None)
        out = put_product(menu, menu.fries, {"setSchedule": True, "scheduleAfterMinutes": 10, "scheduleAfterCourseReady": str(mains)})
        assert (out["scheduleAfterMinutes"], out["scheduleAfterCourseReady"]) == (10, str(mains))
        out = put_category(menu, menu.drinks, {"setSchedule": True, "scheduleAfterMinutes": 5})
        assert (out["scheduleAfterMinutes"], out["scheduleAfterCourseReady"]) == (5, None)
        # Not named: left alone.
        assert put_product(menu, menu.fries, {"setCourse": False})["scheduleAfterMinutes"] == 10
        pulled = pull(menu, menu.tills[0])
        rows = {p["id"]: p for p in pulled.products}
        cats = {c["id"]: c for c in pulled.categories}
        assert (rows[str(menu.fries.id)]["scheduleAfterMinutes"], rows[str(menu.fries.id)]["scheduleAfterCourseReady"]) == (10, str(mains))
        assert rows[str(menu.cola.id)]["scheduleAfterMinutes"] is None  # its category's
        assert cats[str(menu.drinks.id)]["scheduleAfterMinutes"] == 5
        assert cats[str(menu.food.id)]["scheduleAfterCourseReady"] is None

    def test_a_course_of_nobody_is_refused(self, menu):
        with pytest.raises(HTTPException):
            put_product(menu, menu.fries, {"setSchedule": True, "scheduleAfterCourseReady": str(uuid.uuid4())})

    def test_resolved_product_then_category_then_parent(self, menu):
        assert rule_of(menu, menu.burger) is None
        put_category(menu, menu.food, {"setSchedule": True, "scheduleAfterMinutes": 10})
        # Burgers inherits Food.
        assert rule_of(menu, menu.burger) == FF.Rule(10, None)
        # "בלי תזמון" on Burgers stops it.
        put_category(menu, menu.burgers, {"setSchedule": True, "scheduleAfterMinutes": 0})
        assert rule_of(menu, menu.burger) is None
        assert rule_of(menu, menu.fries) == FF.Rule(10, None)
        # The product wins.
        put_product(menu, menu.burger, {"setSchedule": True, "scheduleAfterMinutes": 20})
        assert rule_of(menu, menu.burger) == FF.Rule(20, None)
        # Back to inheriting.
        put_product(menu, menu.burger, {"setSchedule": True, "scheduleAfterMinutes": None})
        assert rule_of(menu, menu.burger) is None


class TestPublications:
    def test_the_new_fields_at_their_before_value_change_no_fingerprint(self):
        before = {"products": {"p": {"name": "burger"}}, "categories": {"c": {"name": "Food"}}, "menu": {}}
        after = {
            "products": {"p": {"name": "burger", "scheduleAfterMinutes": None, "scheduleAfterCourseReady": None}},
            "categories": {"c": {"name": "Food", "scheduleAfterMinutes": None, "scheduleAfterCourseReady": None}},
            "menu": {},
        }
        assert MB.content_of(before) == MB.content_of(after)
        changed = {"products": {"p": {"name": "burger", "scheduleAfterMinutes": 10}}, "categories": before["categories"], "menu": {}}
        assert MB.content_of(before) != MB.content_of(changed)


# ── Till design ───────────────────────────────────────────────────────────────


class TestTillDesign:
    def test_fire_hints_field(self):
        assert TD.FIRE_HINTS == ("on", "first_time", "off")
        # Absent from the defaults (today's sync bytes and version; the shared fixture unchanged).
        assert "hints" not in TD.DEFAULT_CONFIG
        assert TD.validate_config(TD.DEFAULT_CONFIG) == []
        cleaned, errors = TD.validate_layer({"hints": {"fireHints": "first_time"}})
        assert errors == [] and cleaned == {"hints": {"fireHints": "first_time"}}
        _cleaned, errors = TD.validate_layer({"hints": {"fireHints": "sometimes"}})
        assert errors


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
    assert len(heads) == 1
    assert "c5e8a2f19d47" in {r.revision for r in script.walk_revisions("base", heads[0])}
    # On release 14.10d's merge (4ff6c2ab6d7c), nothing else.
    assert script.get_revision("c5e8a2f19d47").down_revision == "4ff6c2ab6d7c"


def _render(*args) -> str:
    """`alembic upgrade --sql` from this checkout's own path — `absolute()`, never `resolve()` (a subst drive such
    as P: resolves to the long path, where Windows cannot open the revisions)."""
    import io
    import logging
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    here = Path(__file__).absolute().parents[1]
    buf = io.StringIO()
    cfg = Config(str(here / "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", str(here / "alembic"))
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    try:
        command.upgrade(cfg, *args, sql=True)
    finally:
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


def test_the_migration_adds_nullable_columns_only():
    """Offline (from the short path P:): five nullable columns and the two on kds_tasks / pos_users, nothing else."""
    sql = _render("4ff6c2ab6d7c:c5e8a2f19d47")
    for table in ("products", "categories"):
        assert f"ALTER TABLE {table} ADD COLUMN schedule_after_minutes INTEGER" in sql
        assert f"ALTER TABLE {table} ADD COLUMN schedule_after_course_ready UUID" in sql
    assert "ALTER TABLE kds_tasks ADD COLUMN scheduled_at TIMESTAMP WITH TIME ZONE" in sql
    assert "ALTER TABLE kds_tasks ADD COLUMN scheduled_note VARCHAR(60)" in sql
    assert "ALTER TABLE pos_users ADD COLUMN hints_dismissed JSONB" in sql
    assert "NOT NULL" not in sql.split("4ff6c2ab6d7c", 1)[-1].replace("version_num VARCHAR(32) NOT NULL", "")
    assert "DROP" not in sql
