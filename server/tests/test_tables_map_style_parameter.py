"""
"סגנון מפת שולחנות" as a till parameter (`tablesMapStyle`).

A built-in enum read by the till only (pos-android `domain/Tables.kt`, `TablesMapStyle`): how
the tables' floor map is drawn — «קלאסי — עץ וזהב» (the default: wood floor, wooden chairs,
a ring and a pill, gold when picked) or «מודרני — נקי» (the clean floor, crisp tables).
Resolved per till like every parameter — till, then area, then shop, then company, then the
default — so a whole company, one shop, one area or a single till can have either look.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import till_parameters as TP
from shift_world import make_world

KEY = "tablesMapStyle"
CLASSIC = "קלאסי — עץ וזהב"
MODERN = "מודרני — נקי"


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _style(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_style(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


# ── The definition ───────────────────────────────────────────────────────────


def test_it_is_a_builtin_enum_classic_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.label == "סגנון מפת שולחנות"
    assert spec.value_type == "enum"
    # The till reads these exact words (TablesMapStyle.CLASSIC_OPTION / MODERN_OPTION).
    assert spec.enum_options == (CLASSIC, MODERN)
    assert spec.default_value == CLASSIC
    assert (TP.TABLES_MAP_STYLE_KEY, TP.TABLES_MAP_STYLE_CLASSIC, TP.TABLES_MAP_STYLE_MODERN) == (KEY, CLASSIC, MODERN)


def test_the_description_says_what_each_look_is_and_that_only_the_look_changes():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    text = spec.description
    assert f"«{CLASSIC}»" in text and "ברירת המחדל" in text and "פרקט עץ" in text and "זהובה" in text
    assert f"«{MODERN}»" in text and "רשת עדינה" in text
    assert "רק המראה משתנה" in text
    assert "חברה, לסניף, לנקודת מכירה או לקופה" in text


def test_it_is_created_with_the_others_and_left_alone_afterwards(world):
    row = _style(world)
    assert row.value_type == "enum" and row.is_active
    assert row.enum_options == [CLASSIC, MODERN]
    assert row.default_value == CLASSIC

    # A super admin re-words it; the next startup keeps their wording.
    row.label = "מראה מסך שולחנות"
    world.db.commit()
    assert KEY not in TP.ensure_builtin_parameters(world.db)
    assert _style(world).label == "מראה מסך שולחנות"


# ── Per company, shop, area and till ─────────────────────────────────────────


def test_every_till_gets_the_classic_look_until_someone_picks_the_modern_one(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == CLASSIC


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, MODERN)
    _set(world, "shop", world.shop.id, CLASSIC)
    # The shop's classic beats the company's modern; the other shop keeps the company's.
    assert _pulled(world, world.tills[1]) == CLASSIC
    assert _pulled(world, world.other_till) == MODERN

    _set(world, "area", world.area.id, MODERN)
    assert _pulled(world, world.tills[0]) == MODERN  # in the area
    assert _pulled(world, world.tills[1]) == CLASSIC  # same shop, no area

    _set(world, "machine", world.tills[0].id, CLASSIC)
    assert _pulled(world, world.tills[0]) == CLASSIC
    _set(world, "machine", world.tills[1].id, MODERN)
    assert _pulled(world, world.tills[1]) == MODERN


@pytest.mark.parametrize("value", ["modern", "neon", True, 2])
def test_a_value_that_is_not_one_of_the_options_is_refused(world, value):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, value)
    assert exc.value.status_code == 422
