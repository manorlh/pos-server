"""
"גודל תצוגה" — the till parameter `displayScale` (P:/specs/display-scale.md).

The owner (16.10.2026, "אפשר בענן להגדיר וגם בקיוסק עצמו בהגדרות ולשמור"): auto (the default, as today) or a percent
70–150 of the size every till and kiosk computes for its screen, per company / shop / point of sale / till; the device's
own local choice wins. The parsing and the precedence are one rule with kiosk-desktop and pos-android, pinned by the
shared golden display_scale_golden.json.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import settings as settings_router
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify, settings_notify
from app.services import display_scale as D
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURE = Path(__file__).parent / "fixtures" / "display_scale_golden.json"
GOLDEN_SHA256 = "c9e7826aa22b595809b8814c37544d80394011e4bc52c7aa48c165a295ad6a38"
KEY = "displayScale"


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


# ── The shared golden fixture ────────────────────────────────────────────────


def test_the_fixture_is_pinned():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


def test_the_fixture_matches_the_definition():
    g = _golden()
    assert g["options"] == list(D.OPTIONS)
    assert g["default"] == D.DEFAULT == "auto"
    assert (g["minPercent"], g["maxPercent"], g["step"], g["minRead"]) == (70, 150, 5, 10)
    assert g["levels"] == list(D.LEVELS) == ["device", "area", "shop", "company"]


@pytest.mark.parametrize("case", _golden()["parse"], ids=lambda c: repr(c["in"]))
def test_parse(case):
    assert D.parse(case["in"]) == case["out"]


@pytest.mark.parametrize("case", _golden()["effective"], ids=lambda c: c["name"])
def test_effective(case):
    assert D.effective(case["levels"], case["local"]) == case["out"]


def test_every_option_parses_to_itself():
    assert D.parse("auto") == "auto"
    for option in D.PERCENT_OPTIONS:
        assert D.parse(option) == int(option)
    assert len(D.OPTIONS) == 18


# ── The definition ───────────────────────────────────────────────────────────


def _spec():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    return spec


def test_a_builtin_enum_auto_by_default_with_hebrew_labels():
    spec = _spec()
    assert spec.label == "גודל תצוגה"
    assert spec.value_type == "enum"
    assert spec.enum_options == D.OPTIONS
    assert spec.enum_options[0] == "auto" and spec.enum_options[1:] == tuple(str(p) for p in range(70, 155, 5))
    assert spec.default_value == "auto"
    assert TP.enum_labels(KEY) == {"auto": "אוטומטי (ברירת מחדל)", **{str(p): f"{p}%" for p in range(70, 155, 5)}}
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(KEY) == 1
    assert TP.validate_key(KEY) == KEY
    text = spec.description
    for words in ("«אוטומטי (ברירת מחדל)»", "כמו היום", "70%–150%", "מסך הטכנאי", "גובר על הענן",
                  "ענן / מקומי / אוטומטי", "קופות וקיוסקים", "חברה, סניף, נקודת מכירה או קופה"):
        assert words in text
    assert "Windows" in text and "אנדרואיד" in text


# ── Per company, shop, point of sale and till ────────────────────────────────


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.kiosk, w.till = w.tills
    w.kiosk.area_id = area.id
    w.area = area
    w.db.commit()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _definition(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    world.db.commit()
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def test_created_with_the_others(world):
    row = _definition(world)
    assert row.is_active and row.value_type == "enum"
    assert row.enum_options == list(D.OPTIONS)
    assert row.default_value == "auto"
    assert row.label == "גודל תצוגה"


def test_every_device_gets_auto_until_a_level_sets_it(world):
    assert _pulled(world, world.kiosk) == "auto"
    assert _pulled(world, world.till) == "auto"


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, "110")
    assert (_pulled(world, world.kiosk), _pulled(world, world.till)) == ("110", "110")
    _set(world, "shop", world.shop.id, "90")
    assert (_pulled(world, world.kiosk), _pulled(world, world.till)) == ("90", "90")
    _set(world, "area", world.area.id, "125")
    assert (_pulled(world, world.kiosk), _pulled(world, world.till)) == ("125", "90")
    _set(world, "machine", world.kiosk.id, "auto")
    assert (_pulled(world, world.kiosk), _pulled(world, world.till)) == ("auto", "90")
    _set(world, "machine", world.till.id, "150")
    assert _pulled(world, world.till) == "150"
    # What each device then shows, by the shared rule (no local choice).
    assert D.effective({"device": _pulled(world, world.till)}) == {
        "setting": 150, "percent": 150, "factor": 1.5, "source": "cloud", "level": "device",
    }


@pytest.mark.parametrize("bad", ["65", "155", "big", "87", 100])
def test_only_the_options_are_stored(world, bad):
    with pytest.raises(Exception):
        _set(world, "shop", world.shop.id, bad)
    assert _pulled(world, world.kiosk) == "auto"
