"""
"נעילת קופה (מצב קיוסק)" as a till parameter (`kioskMode`).

A built-in boolean, off by default, read by the till only (pos-android
`system/KioskLock.kt`, `docs/KIOSK.md`): while it is on the till holds Android's lock task
mode. Resolved per till like every parameter — till, then area, then shop, then company,
then the default — so a whole company, one shop, one area or a single till can be locked.
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

KEY = "kioskMode"


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


def _kiosk(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_kiosk(world).id,
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


def test_it_is_a_builtin_boolean_off_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.label == "נעילת קופה (מצב קיוסק)"
    assert spec.value_type == "boolean"
    assert spec.default_value is False
    assert spec.enum_options is None


def test_the_description_says_what_it_locks_how_to_leave_and_what_needs_device_setup():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    text = spec.description
    # What it locks.
    for part in ("מסך הבית", "לאפליקציות אחרות", "שורת ההתראות", "\"חזור\""):
        assert part in text
    # Pinning on an ordinary device, and the full lock that needs a one-time device setup.
    assert "הצמדת אפליקציה" in text
    assert "Device Owner" in text and "חד-פעמית" in text
    assert "Kozen" in text and "Nayax" in text
    # How a manager leaves it, offline too, and for how long.
    assert "\"יציאה מנעילת קופה\"" in text and "קוד מנהל" in text and "בלי אינטרנט" in text
    assert "עד ההפעלה הבאה" in text and "\"נעילת הקופה מחדש\"" in text
    # The cloud stays the authority, at every level.
    assert "כיבוי הפרמטר משחרר" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_it_is_created_with_the_others_and_left_alone_afterwards(world):
    row = _kiosk(world)
    assert row.value_type == "boolean" and row.is_active
    assert row.default_value is False
    assert row.label == "נעילת קופה (מצב קיוסק)"

    # A super admin re-words it; the next startup keeps their wording.
    row.label = "קיוסק"
    world.db.commit()
    assert KEY not in TP.ensure_builtin_parameters(world.db)
    assert _kiosk(world).label == "קיוסק"


# ── Per company, shop, area and till ─────────────────────────────────────────


def test_every_till_gets_off_until_someone_turns_it_on(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is False


def test_on_for_the_company_locks_every_till_of_it(world):
    _set(world, "company", world.company.id, True)
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is True


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, True)
    _set(world, "shop", world.shop.id, False)
    # The shop's False beats the company's True; the other shop keeps the company's.
    assert _pulled(world, world.tills[1]) is False
    assert _pulled(world, world.other_till) is True

    _set(world, "area", world.area.id, True)
    assert _pulled(world, world.tills[0]) is True  # in the area
    assert _pulled(world, world.tills[1]) is False  # same shop, no area

    _set(world, "machine", world.tills[0].id, False)
    assert _pulled(world, world.tills[0]) is False
    _set(world, "machine", world.tills[1].id, True)
    assert _pulled(world, world.tills[1]) is True


@pytest.mark.parametrize("value", ["yes", 2, "maybe"])
def test_a_value_that_is_not_a_boolean_is_refused(world, value):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, value)
    assert exc.value.status_code == 422
