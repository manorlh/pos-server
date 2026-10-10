"""
"חזרה אוטומטית לקיוסק" — `desktopIdleReturnMinutes` (app/services/desktop_idle_return.py): after a
manager took the Windows app out to the desktop (DESKTOP_EXIT), back in full screen after this many
idle minutes. The owner (08.10.2026): on, 10 minutes by default, controlled from the cloud.

Covers the schema (a whole number 0–240, 0 = off; nothing else), the layers (the deepest wins;
`null` resets), and what the device receives: always the resolved value, 10 when no layer sets it.
Style of tests/test_pay_order.py: no database, handlers on mocked sessions.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.models.user import UserRole
from app.routers.settings import TIP_RESETTABLE_KEYS, patch_machine_settings
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import desktop_idle_return as D
from app.services.settings_merge import MANAGED_SETTING_KEYS
from test_pay_order import _user, _world


def _sync(machine, db, area, since=None):
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ), patch("app.routers.sync.get_area", return_value=area):
        return get_settings_sync(machine_id=str(machine.id), since=since, machine=machine, db=db)


def _patch_machine(machine, area, db, body, role=UserRole.SHOP_MANAGER):
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ), patch("app.routers.settings.notify_machine_settings") as notify:
        patch_machine_settings(
            machine_id=str(machine.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(role),
            active_tenant_id=machine.tenant_id,
            db=db,
        )
    return notify


# ── The value ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("minutes", [0, 1, 10, 45, D.MAX_MINUTES, 30.0])
def test_a_whole_number_of_minutes_from_0_off_to_240(minutes):
    parsed = PosSettingsV1Patch.model_validate({"desktopIdleReturnMinutes": minutes})
    assert parsed.desktop_idle_return_minutes == int(minutes)
    assert isinstance(parsed.desktop_idle_return_minutes, int)


@pytest.mark.parametrize("bad", [-1, D.MAX_MINUTES + 1, 2.5, "10", True, False, [10], {"m": 10}])
def test_anything_else_is_refused(bad):
    with pytest.raises(ValidationError) as err:
        PosSettingsV1Patch.model_validate({"desktopIdleReturnMinutes": bad})
    assert "desktopIdleReturnMinutes" in str(err.value) or "desktop_idle_return_minutes" in str(err.value)


def test_it_is_a_managed_key_a_null_resets():
    assert "desktopIdleReturnMinutes" in MANAGED_SETTING_KEYS
    assert "desktopIdleReturnMinutes" in TIP_RESETTABLE_KEYS
    assert PosSettingsV1Patch.model_validate({"desktopIdleReturnMinutes": None}).desktop_idle_return_minutes is None


def test_resolve_defaults_to_ten_and_never_passes_a_bad_stored_value_on():
    assert D.resolve({}) == D.DEFAULT_MINUTES == 10
    assert D.resolve({"desktopIdleReturnMinutes": 0}) == 0
    assert D.resolve({"desktopIdleReturnMinutes": 25}) == 25
    # A value written around the API (a script, an old row): the default, not garbage.
    for stored in ("15", 999, -3, True, None):
        assert D.resolve({"desktopIdleReturnMinutes": stored}) == 10


# ── The layers and the device ────────────────────────────────────────────────


def test_the_device_gets_ten_when_no_layer_sets_it_on_a_full_and_a_delta_pull():
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {})
    assert _sync(machine, db, area).settings["desktopIdleReturnMinutes"] == 10
    delta = _sync(machine, db, area, since="2026-08-01T00:00:00+00:00")
    assert delta.sync_type == "delta" and delta.settings["desktopIdleReturnMinutes"] == 10


def test_the_deepest_layer_wins_and_zero_turns_it_off():
    _, _, _, area, machine, db = _world({}, {"desktopIdleReturnMinutes": 30}, {"desktopIdleReturnMinutes": 5}, {}, {})
    assert _sync(machine, db, area).settings["desktopIdleReturnMinutes"] == 5
    machine.settings = {"desktopIdleReturnMinutes": 0}
    assert _sync(machine, db, area).settings["desktopIdleReturnMinutes"] == 0


def test_a_devices_own_dialog_sets_it_and_a_null_inherits_again():
    _, _, _, area, machine, db = _world({}, {}, {"desktopIdleReturnMinutes": 20}, {}, {})
    notify = _patch_machine(machine, area, db, {"desktopIdleReturnMinutes": 0})
    assert machine.settings == {"desktopIdleReturnMinutes": 0}
    notify.assert_called_once()
    assert _sync(machine, db, area).settings["desktopIdleReturnMinutes"] == 0
    _patch_machine(machine, area, db, {"desktopIdleReturnMinutes": None})
    assert machine.settings == {}
    assert _sync(machine, db, area).settings["desktopIdleReturnMinutes"] == 20
