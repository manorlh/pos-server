"""
"עקיפת בדיקת מספר מסוף" — the till parameter `terminalNumberCheckBypass` (docs/SPEC_KIOSK.md §20.1,
app/services/terminal_check_bypass.py).

A built-in boolean, off by default, set per company / shop / point of sale / till. On, the card
lock's terminal-number check never locks card payment — on the till (domain/CardLock.kt), and so
not in the cloud's view of the lock either (`terminal_status.card_lock_status`, the machines page,
the kiosk summary and its device health). Only the owner and managers may change it, and every
change of a parameter on the parameters page is recorded (app/services/till_parameter_audit.py).
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterChange
from app.models.user import User, UserRole
from app.routers import machines as MR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.till_parameter import TillParameterUpdate, TillParameterValueIn
from app.services import kiosk_health as H
from app.services import terminal_check_bypass as TCB
from app.services import terminal_status as TS
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, make_world

KEY = "terminalNumberCheckBypass"


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
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


def _user(role=UserRole.SUPER_ADMIN, email="owner@x"):
    return MagicMock(spec=User, role=role, id=uuid.uuid4(), email=email)


def _definition(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value, user=None):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=user or _user(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _clear(world, value_id, user=None):
    R.delete_till_parameter_value(
        parameter_id=_definition(world).id,
        value_id=value_id,
        background_tasks=BackgroundTasks(),
        _admin=user or _user(),
        db=world.db,
    )


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def _changes(world):
    return (
        world.db.query(TillParameterChange)
        .filter(TillParameterChange.parameter_key == KEY)
        .order_by(TillParameterChange.created_at)
        .all()
    )


# ── The definition ───────────────────────────────────────────────────────────


def test_it_is_a_builtin_boolean_off_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.label == "עקיפת בדיקת מספר מסוף"
    assert spec.value_type == "boolean"
    assert spec.default_value is False
    assert spec.enum_options is None


def test_the_description_warns_and_says_what_stays():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    text = spec.description
    # The warning: charges may reach another business's terminal; tests or a known-right number only.
    assert "אזהרה" in text and "שאינו של העסק או של הקופה הזו" in text
    assert "רק לבדיקות" in text and "שמספר המסוף נכון" in text
    # What it skips, and what stays.
    assert "מספר אחר" in text and "לא הוגדר מספר מסוף על הקופה עצמה" in text
    assert "\"לא זמין\"" in text and "עסקה אחת בכל פעם" in text
    # Where it shows, who may change it, the log, the levels.
    assert "\"בדיקת מספר מסוף מושבתת\"" in text
    assert "רק בעלים ומנהלים" in text and "נרשם" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_it_is_created_with_the_others(world):
    row = _definition(world)
    assert row.value_type == "boolean" and row.is_active and row.default_value is False
    assert KEY not in TP.ensure_builtin_parameters(world.db)


# ── Per company, shop, area and till ─────────────────────────────────────────


def test_off_everywhere_until_set(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is False
    got = TCB.bypass_for_machines(world.db, [*world.tills, world.other_till])
    assert all(b == TCB.Bypass(False, "default") for b in got.values())


def test_the_most_specific_level_wins_and_says_where_from(world):
    t_area, t_shop = world.tills
    _set(world, "company", world.company.id, True)
    got = TCB.bypass_for_machines(world.db, [t_area, t_shop, world.other_till])
    assert got[world.other_till.id] == TCB.Bypass(True, "company")
    assert _pulled(world, world.other_till) is True

    _set(world, "shop", world.shop.id, False)
    got = TCB.bypass_for_machines(world.db, [t_area, t_shop, world.other_till])
    assert got[t_shop.id] == TCB.Bypass(False, "shop")
    assert got[world.other_till.id] == TCB.Bypass(True, "company")

    _set(world, "area", world.area.id, True)
    got = TCB.bypass_for_machines(world.db, [t_area, t_shop])
    assert got[t_area.id] == TCB.Bypass(True, "area")
    assert got[t_shop.id] == TCB.Bypass(False, "shop")

    _set(world, "machine", t_area.id, False)
    _set(world, "machine", t_shop.id, True)
    got = TCB.bypass_for_machines(world.db, [t_area, t_shop])
    assert got[t_area.id] == TCB.Bypass(False, "machine")
    assert got[t_shop.id] == TCB.Bypass(True, "machine")
    # The cloud's view is what the till pulls.
    for till in (t_area, t_shop, world.other_till):
        assert _pulled(world, till) is TCB.bypass_for_machine(world.db, till).on


def test_an_inactive_definition_is_off(world):
    _set(world, "company", world.company.id, True)
    _definition(world).is_active = False
    world.db.commit()
    assert TCB.bypass_for_machine(world.db, world.tills[0]) == TCB.Bypass()
    assert _pulled(world, world.tills[0]) is None


@pytest.mark.parametrize("value", ["yes", 1, "true"])
def test_a_value_that_is_not_a_boolean_is_refused(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, value)
    assert exc.value.status_code == 422
    assert _changes(world) == []


# ── Who may change it ────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", [UserRole.SUPER_ADMIN, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER])
def test_owner_and_managers_may_change_it(world, role):
    _set(world, "machine", world.tills[0].id, True, user=_user(role))
    assert TCB.bypass_for_machine(world.db, world.tills[0]).on is True


@pytest.mark.parametrize("role", [UserRole.DISTRIBUTOR, UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER])
def test_anyone_else_is_refused_and_nothing_changes(world, role):
    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, True, user=_user(role))
    assert exc.value.status_code == 403 and exc.value.detail == "till_parameter_restricted"
    value = _set(world, "machine", world.tills[0].id, True)
    with pytest.raises(HTTPException):
        _clear(world, value.id, user=_user(role))
    with pytest.raises(HTTPException):
        R.update_till_parameter(
            parameter_id=_definition(world).id,
            body=TillParameterUpdate(defaultValue=True),
            background_tasks=BackgroundTasks(),
            _admin=_user(role),
            db=world.db,
        )
    assert _definition(world).default_value is False
    # Another parameter is not restricted by this rule.
    assert TCB.may_change("kioskMode", _user(role)) is True


# ── Every change is recorded ─────────────────────────────────────────────────


def test_every_change_is_recorded_with_who_when_level_and_value(world):
    owner = _user(email="ran@x")
    value = _set(world, "shop", world.shop.id, True, user=owner)
    # The same value again is not a change.
    _set(world, "shop", world.shop.id, True, user=owner)
    _set(world, "shop", world.shop.id, False, user=_user(UserRole.SHOP_MANAGER, "mgr@x"))
    _clear(world, value.id, user=owner)

    rows = _changes(world)
    assert [(r.action, r.scope_type, r.old_value, r.new_value) for r in rows] == [
        ("set", "shop", None, True),
        ("set", "shop", True, False),
        ("clear", "shop", False, None),
    ]
    assert all(r.scope_id == world.shop.id for r in rows)
    assert [r.user_email for r in rows] == ["ran@x", "mgr@x", "ran@x"]
    assert [r.user_role for r in rows] == ["super_admin", "shop_manager", "super_admin"]
    assert all(r.created_at is not None for r in rows)


def test_a_change_of_the_default_or_the_activation_is_recorded(world):
    for body in (TillParameterUpdate(defaultValue=True), TillParameterUpdate(isActive=False)):
        R.update_till_parameter(
            parameter_id=_definition(world).id, body=body, background_tasks=BackgroundTasks(),
            _admin=_user(email="ran@x"), db=world.db,
        )
    rows = _changes(world)
    assert [(r.action, r.scope_type, r.old_value, r.new_value) for r in rows] == [
        ("default", "default", False, True),
        ("active", "default", True, False),
    ]


def test_the_change_log_is_listed_newest_first_with_level_names(world):
    _set(world, "machine", world.tills[0].id, True, user=_user(email="ran@x"))
    out = R.list_till_parameter_changes(parameter_id=_definition(world).id, _admin=_user(), db=world.db)
    assert len(out) == 1
    (row,) = out
    assert row["action"] == "set" and row["scopeType"] == "machine" and row["newValue"] is True
    assert row["userEmail"] == "ran@x" and row["scopeName"].endswith("Till 1")


def test_other_parameters_are_recorded_too(world):
    tasks = BackgroundTasks()
    kiosk = world.db.query(TillParameter).filter(TillParameter.key == "kioskMode").one()
    R.set_till_parameter_value(
        parameter_id=kiosk.id,
        body=TillParameterValueIn(scopeType="company", scopeId=world.company.id, value=True),
        background_tasks=tasks, _admin=_user(), db=world.db,
    )
    assert world.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == "kioskMode").count() == 1


# ── The cloud's card lock respects it ────────────────────────────────────────


def _report(till, number):
    till.terminal_number = number
    till.terminal_reported_at = NOW - timedelta(minutes=1)


def test_the_lock_rule_itself_is_unchanged():
    assert TS.card_lock_of("agamento", "882612", "shop", False, "1807770", NOW) == TS.LOCK_MISMATCH
    assert TS.card_lock_of("nayax_lan", None, None, False, None, None) == TS.LOCK_NOT_CONFIGURED


def test_bypass_lifts_the_clouds_lock_and_says_which_it_would_have_been(world):
    till = world.tills[1]
    world.shop.settings = {"expectedTerminalNumber": "882612"}
    _report(till, "1807770")
    world.db.commit()

    fields = TS.machine_terminal_fields(till, TS.terminal_settings_for(world.db, [till])[till.id])
    assert fields["cardLock"] == "mismatch"
    assert fields["terminalNumberCheckBypass"] is False and fields["cardLockBypassed"] is None
    assert fields["terminalNumberCheckBypassChange"] is None

    _set(world, "shop", world.shop.id, True, user=_user(email="ran@x"))
    settings = TS.terminal_settings_for(world.db, [till])[till.id]
    assert settings.number_check_bypass is True and settings.number_check_bypass_source == "shop"
    assert TS.card_lock_status(till, settings) is None
    fields = TS.machine_terminal_fields(till, settings)
    assert fields["cardLock"] is None
    assert fields["cardLockBypassed"] == "mismatch"
    assert fields["terminalNumberCheckBypass"] is True
    assert fields["terminalNumberCheckBypassSource"] == "shop"
    change = fields["terminalNumberCheckBypassChange"]
    assert change["userEmail"] == "ran@x" and change["scopeType"] == "shop" and change["newValue"] is True
    # Still the real comparison beside it: the bypass hides nothing.
    assert fields["terminalStatus"] == "mismatch"


def test_bypass_covers_a_network_pinpad_with_no_number_of_its_own(world):
    till = world.tills[1]
    till.device_model = "P18"  # no terminal of its own: it charges on the network pinpad
    till.settings = {"nayaxEnabled": True, "nayaxDeviceHost": "192.168.0.167"}
    world.db.commit()
    settings = TS.terminal_settings_for(world.db, [till])[till.id]
    assert TS.card_lock_status(till, settings) == TS.LOCK_NOT_CONFIGURED

    _set(world, "machine", till.id, True)
    settings = TS.terminal_settings_for(world.db, [till])[till.id]
    assert TS.card_lock_status(till, settings) is None
    assert TS.machine_terminal_fields(till, settings)["cardLockBypassed"] == TS.LOCK_NOT_CONFIGURED


def test_only_the_tills_it_is_on_for(world):
    world.shop.settings = {"expectedTerminalNumber": "882612"}
    world.other_shop.settings = {"expectedTerminalNumber": "882612"}
    for t in (*world.tills, world.other_till):
        _report(t, "1807770")
    world.db.commit()
    _set(world, "area", world.area.id, True)
    every = TS.terminal_settings_for(world.db, [*world.tills, world.other_till])
    assert TS.card_lock_status(world.tills[0], every[world.tills[0].id]) is None
    assert TS.card_lock_status(world.tills[1], every[world.tills[1].id]) == "mismatch"
    assert TS.card_lock_status(world.other_till, every[world.other_till.id]) == "mismatch"


# ── The till's report, and the kiosk views ───────────────────────────────────


def test_the_heartbeat_keeps_what_the_till_applies(world):
    till = world.tills[0]
    body = MachineHeartbeatBody.model_validate({"terminalNumberCheckBypass": True})
    MR.post_my_heartbeat(body=body, machine=till, db=world.db, request=None)
    assert till.terminal_number_check_bypass_reported is True
    # A beat that does not say (an older build) leaves it as it was.
    MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate({}), machine=till, db=world.db, request=None)
    assert till.terminal_number_check_bypass_reported is True
    MR.post_my_heartbeat(
        body=MachineHeartbeatBody.model_validate({"terminalNumberCheckBypass": False}),
        machine=till, db=world.db, request=None,
    )
    assert till.terminal_number_check_bypass_reported is False
    fields = TS.machine_terminal_fields(till, TS.terminal_settings_for(world.db, [till])[till.id])
    assert fields["terminalNumberCheckBypassReported"] is False


def test_an_unreadable_report_never_fails_the_beat():
    body = MachineHeartbeatBody.model_validate({"terminalNumberCheckBypass": {"x": 1}})
    assert body.terminal_number_check_bypass is None


def test_kiosk_health_shows_no_lock_and_the_warning():
    identity = {"cardLock": None, "numberCheckBypass": True, "expected": "882612", "reportedNumber": "1807770"}
    part = H.terminal_part({"terminalIdentity": identity}, {"terminal": {"state": "ready"}})
    assert part["code"] == "ready" and part["level"] == "ok"
    assert part["detail"]["numberCheckBypass"] is True
    # Off: nothing added.
    part = H.terminal_part({"terminalIdentity": {"cardLock": "mismatch"}}, {})
    assert part["code"] == "card_lock" and "numberCheckBypass" not in part["detail"]


def test_kiosk_summary_identity_carries_it(world):
    from app.services.kiosk_control import _terminal_identity

    till = world.tills[0]
    till.terminal_number_check_bypass_reported = True
    settings = TS.TerminalSettings(expected="882612", number_check_bypass=True, number_check_bypass_source="machine")
    ident = _terminal_identity(till, settings, TS.card_lock_status)
    assert ident["cardLock"] is None
    assert ident["numberCheckBypass"] is True and ident["numberCheckBypassSource"] == "machine"
    assert ident["numberCheckBypassReported"] is True
