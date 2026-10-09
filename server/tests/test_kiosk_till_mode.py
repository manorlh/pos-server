"""
"מצב עבודה: קיוסק / קופה" and the kiosk's screen (P:/specs/kiosk-landscape-till-mode.md §2, §3, §5;
app/services/kiosk_till_mode.py).

* The till parameters: built in with safe defaults (off / 0 / manager / auto), their layers, their
  values checked (minutes 0–240, the three orientations).
* The owner's gate `kioskTillModeEnabled`: a super admin or a distributor only — on the parameters
  page's routes and on the kiosk's own switch (`PUT /kiosks/{id}/till-mode`), recorded.
* The dashboard's switch (`enter_till` / `return_kiosk`): refused while the gate is closed, handed to the kiosk on
  kiosk/sync (the latest only; an older one superseded, a day-old one expired), done by the kiosk's
  `commandsDone`; the same sections as a pause.
* The status: `flowState = till_mode`, `tillMode` and `display` cleaned and in the summary; the
  device health says "till_mode" (info, not a fault); the till event `kiosk_till_mode` accepted.
* A controlling till's quick reprints (`reprint_bon` / `reprint_receipt`): requested, delivered
  with the bon commands, done by `commandsDone`.
* The shared golden fixture of the display profile is the same bytes as the till's.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import hashlib
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.models.kiosk import KioskCommand, KioskDevice
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import UserRole
from app.routers import kiosks as R
from app.routers import till_parameters as TPR
from app.schemas.till_parameter import TillParameterValueIn
from app.services import exceptions as EX
from app.services import kiosk_control as S
from app.services import kiosk_health
from app.services import kiosk_till_mode as KTM
from app.services import till_parameters as TP
from test_kiosks import _user, convert, dashboard_command, out_of, sync, till_command, w  # noqa: F401 - the fixture

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def _param(w, key):
    TP.ensure_builtin_parameters(w.db)
    w.db.flush()
    return w.db.query(TillParameter).filter(TillParameter.key == key).one()


def _set(w, key, scope_type, scope_id, value):
    p = _param(w, key)
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type=scope_type, scope_id=scope_id, value=value))
    w.db.flush()


def _enable(w, machine=None, scope="machine"):
    target = {"machine": (machine or w.kiosk).id, "shop": w.shop.id, "company": w.company.id}[scope]
    _set(w, KTM.ENABLED_KEY, scope, target, True)


# ── The parameters ───────────────────────────────────────────────────────────


def test_the_parameters_are_built_in_with_safe_defaults():
    by_key = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    assert by_key[KTM.ENABLED_KEY].value_type == "boolean" and by_key[KTM.ENABLED_KEY].default_value is False
    assert by_key[KTM.ENABLED_KEY].admin_only is True
    assert by_key[KTM.IDLE_KEY].value_type == "integer" and by_key[KTM.IDLE_KEY].default_value == 3
    # Always a manager's code with KIOSK_TILL_MODE: no parameter turns it off (web-till-spec-v2 §6.9).
    assert "kioskTillModeRequireManager" not in by_key
    assert by_key[KTM.ORIENTATION_KEY].value_type == "enum"
    assert by_key[KTM.ORIENTATION_KEY].enum_options == ("auto", "portrait", "landscape")
    assert by_key[KTM.ORIENTATION_KEY].default_value == "auto"
    # Only the owner's gate is admin only.
    assert TP.ADMIN_ONLY_KEYS == frozenset({KTM.ENABLED_KEY})
    # No "screen size" parameter: the device works it out (§1).
    assert not any("screensize" in k.lower() or "screen_size" in k.lower() for k in by_key)


def test_values_beyond_their_type():
    assert TP.validate_keyed_value(KTM.IDLE_KEY, 3) == 3
    assert TP.validate_keyed_value(KTM.IDLE_KEY, 5.0) == 5
    for bad in (-1, 241, 2.5, True, "3"):
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value(KTM.IDLE_KEY, bad)
    assert TP.validate_keyed_value(KTM.ORIENTATION_KEY, "landscape") == "landscape"
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value(KTM.ORIENTATION_KEY, "sideways")


def test_the_layers_company_shop_area_device(w):
    convert(w)
    assert KTM.effective(w.db, w.kiosk) == {"enabled": False, "idleReturnMinutes": 3, "orientation": "auto"}
    _enable(w, scope="company")
    _set(w, KTM.IDLE_KEY, "shop", w.shop.id, 3)
    _set(w, KTM.ORIENTATION_KEY, "machine", w.kiosk.id, "landscape")
    assert KTM.effective(w.db, w.kiosk) == {"enabled": True, "idleReturnMinutes": 3, "orientation": "landscape"}
    _set(w, KTM.IDLE_KEY, "machine", w.kiosk.id, 0)
    assert KTM.effective(w.db, w.kiosk)["idleReturnMinutes"] == 0
    # The device's own level wins over the company's.
    _set(w, KTM.ENABLED_KEY, "machine", w.kiosk.id, False)
    assert KTM.effective(w.db, w.kiosk)["enabled"] is False
    # The till receives them on its parameters pull like any other.
    resolved = TP.till_parameters_for_machine(w.db, w.kiosk).parameters
    assert resolved[KTM.ORIENTATION_KEY] == "landscape" and resolved[KTM.IDLE_KEY] == 0


# ── The owner's gate: a super admin or a distributor only ───────────────────


def test_the_gate_is_a_super_admins_or_a_distributors(w):
    convert(w)
    distributor = _user(w, "dist", UserRole.DISTRIBUTOR)
    for user in (w.manager, w.company_manager, w.supervisor, w.cashier):
        with pytest.raises(HTTPException) as caught:
            KTM.set_gate(w.db, w.kiosk, True, user)
        assert caught.value.status_code == 403 and caught.value.detail == KTM.ADMIN_ONLY_DETAIL
    assert KTM.set_gate(w.db, w.kiosk, True, distributor)["enabled"] is True
    assert KTM.set_gate(w.db, w.kiosk, False, w.admin)["enabled"] is False
    # Null: back to what it inherits (nothing set above → off).
    assert KTM.set_gate(w.db, w.kiosk, None, w.admin)["enabled"] is False
    assert w.db.query(TillParameterValue).filter(TillParameterValue.scope_id == w.kiosk.id).count() == 0
    # Every change in the parameters' log, with who made it.
    log = w.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == KTM.ENABLED_KEY).all()
    assert [c.user_role for c in log] == ["distributor", "super_admin", "super_admin"]
    assert [c.action for c in log] == ["set", "set", "clear"]


def test_the_kiosk_page_switch_over_the_route(w, monkeypatch):
    convert(w)
    monkeypatch.setattr(S, "notify_device_lock", lambda m: None)
    out = R.put_kiosk_till_mode_gate(
        machine_id=w.kiosk.id, body=R.TillModeGateIn(enabled=True), current_user=w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["tillMode"]["enabled"] is True and out["tillMode"]["mode"] == "kiosk"
    with pytest.raises(HTTPException) as caught:
        R.put_kiosk_till_mode_gate(
            machine_id=w.kiosk.id, body=R.TillModeGateIn(enabled=False), current_user=w.manager,
            active_tenant_id=w.tenant.id, db=w.db,
        )
    assert caught.value.status_code == 403


def test_the_parameters_page_refuses_the_gate_to_anyone_but_an_admin(w):
    p = _param(w, KTM.ENABLED_KEY)
    body = TillParameterValueIn(scopeType="company", scopeId=w.company.id, value=True)
    # Even past the super-admin route guard (a page that lets others in later), the key itself is refused.
    with pytest.raises(HTTPException) as caught:
        TPR._refuse_restricted(p.key, w.company_manager)
    assert caught.value.status_code == 403 and caught.value.detail == KTM.ADMIN_ONLY_DETAIL
    TPR._refuse_restricted(p.key, _user(w, "dist2", UserRole.DISTRIBUTOR))
    TPR._refuse_restricted(p.key, w.admin)
    # Any other key: as before.
    TPR._refuse_restricted(KTM.IDLE_KEY, w.company_manager)
    out = TPR._out(p, 0)
    assert out.admin_only is True and TPR._out(_param(w, KTM.IDLE_KEY), 0).admin_only is False
    assert body.value is True


# ── The dashboard's switch ───────────────────────────────────────────────────


def test_the_switch_is_refused_while_the_gate_is_closed(w):
    convert(w)
    for action in ("enter_till", "return_kiosk"):
        out, _ = dashboard_command(w, w.kiosk, action)
        assert isinstance(out, JSONResponse) and out.status_code == 409 and b"till_mode_disabled" in out.body
    assert {c.status for c in w.db.query(KioskCommand).all()} == {"refused"}
    assert sync(w, w.kiosk)["workMode"] is None


def test_the_switch_reaches_the_kiosk_and_ends_by_its_word(w):
    convert(w)
    _enable(w)
    out, code = dashboard_command(w, w.kiosk, "enter_till")
    assert code == 201 and out["status"] == "requested"
    pending = sync(w, w.kiosk)["workMode"]
    assert pending == {"id": out["id"], "mode": "till", "by": "admin"}
    # A second one supersedes it: the kiosk only ever hears the latest.
    second, _ = dashboard_command(w, w.kiosk, "return_kiosk")
    assert sync(w, w.kiosk)["workMode"] == {"id": second["id"], "mode": "kiosk", "by": "admin"}
    assert w.db.get(KioskCommand, uuid.UUID(out["id"])).status == "refused"
    # The kiosk did it: it says so, and nothing is pending any more.
    after = sync(w, w.kiosk, {"flowState": "attract", "commandsDone": [second["id"]]})
    assert after["workMode"] is None
    assert w.db.get(KioskCommand, uuid.UUID(second["id"])).status == "applied"


def test_a_day_old_switch_expires(w):
    convert(w)
    _enable(w)
    out, _ = dashboard_command(w, w.kiosk, "enter_till")
    row = w.db.get(KioskCommand, uuid.UUID(out["id"]))
    row.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
    w.db.flush()
    assert sync(w, w.kiosk)["workMode"] is None
    assert row.status == "refused" and "expired" in row.detail


def test_remote_control_may_switch_as_it_pauses():
    assert R.KIOSK_ACTION_SECTIONS["enter_till"] == R.KIOSK_ACTION_SECTIONS["return_kiosk"] == R.KIOSK_ACTION_SECTIONS["pause"]
    assert R.KIOSK_ACTION_SECTIONS["pause"] == ("kiosks", "device_control")
    assert R.KIOSK_ACTION_SECTIONS["reprint_bon"] == ("kiosks",)


# ── What the cloud sees ─────────────────────────────────────────────────────


def test_till_mode_in_the_status_the_summary_and_the_health(w):
    convert(w)
    _enable(w)
    sync(w, w.kiosk, {
        "flowState": "till_mode",
        "tillMode": {"since": "2026-10-09T18:00:00.000Z", "enteredBy": "מנהל", "employee": "דנה",
                     "source": "manual", "returnBlocked": "basket_open", "junk": 1},
        "display": {"orientation": "landscape", "sizeClass": "21", "diagonalInches": 21.5, "physical": True,
                    "scale": 0.86, "widthDp": 1488, "heightDp": 837, "junk": "x"},
    })
    device = w.db.get(KioskDevice, w.kiosk.id)
    assert device.status["flowState"] == "till_mode"
    assert device.status["tillMode"] == {"since": "2026-10-09T18:00:00.000Z", "enteredBy": "מנהל", "employee": "דנה",
                                         "source": "manual", "returnBlocked": "basket_open"}
    assert device.status["display"]["sizeClass"] == "21" and "junk" not in device.status["display"]
    summary = out_of(sync(w, w.till)["controls"], w.kiosk)
    assert summary["flowState"] == "till_mode"
    till = summary["tillMode"]
    assert till["enabled"] is True and till["mode"] == "till" and till["employee"] == "דנה"
    assert till["blocked"] == "basket_open" and till["blockedText"] == KTM.BLOCKED_TEXTS["basket_open"]
    assert summary["display"]["widthDp"] == 1488
    part = kiosk_health.app_part(summary, {}, True, datetime.now(timezone.utc))
    assert part["level"] == "info" and part["code"] == "till_mode" and part["detail"]["employee"] == "דנה"


def test_a_bad_report_is_dropped_never_refused():
    assert KTM.clean_till_mode("x") is None
    assert KTM.clean_till_mode({"since": 5, "employee": " "}) == {}
    assert KTM.clean_display({"orientation": "diagonal", "widthDp": -3, "scale": "big"}) is None
    assert KTM.clean_display({"orientation": "portrait", "widthDp": 720, "heightDp": 1280}) == {
        "orientation": "portrait", "widthDp": 720, "heightDp": 1280,
    }
    assert S.clean_status({"flowState": "till_mode"})["flowState"] == "till_mode"


def test_the_till_event_is_accepted():
    assert "kiosk_till_mode" in EX.TILL_EVENT_TYPES
    from app.schemas.audit_exception import TillEventIn

    e = TillEventIn(id=uuid.uuid4(), type="kiosk_till_mode", occurredAt=datetime.now(timezone.utc),
                    details={"action": "enter", "reason": "manual", "by": "מנהל"})
    assert e.type == "kiosk_till_mode"


# ── A controlling till's quick reprints ─────────────────────────────────────


def test_the_quick_reprints_from_a_controlling_till(w):
    convert(w)
    out, code = till_command(w, w.till, w.kiosk, "reprint_bon")
    assert code == 201 and out["status"] == "requested"
    receipt, code = till_command(w, w.till, w.kiosk, "reprint_receipt", message="last")
    assert code == 201
    missing, _ = till_command(w, w.till, w.kiosk, "reprint_receipt", message="no-such-order")
    assert isinstance(missing, JSONResponse) and missing.status_code == 404
    commands = sync(w, w.kiosk)["bonCommands"]
    assert [(c["action"], c["localId"]) for c in commands] == [("reprint_bon", "last"), ("reprint_receipt", "last")]
    sync(w, w.kiosk, {"commandsDone": [out["id"], receipt["id"]]})
    assert sync(w, w.kiosk)["bonCommands"] == []


# ── The display profile's golden fixture: the same bytes as the till's ──────


def test_the_display_profile_fixture_is_pinned():
    data = (FIXTURES / "display_profiles_golden.json").read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == "1beefb2a4720c099a55c60f9c0e1e386b4b56052f52e419c3a476f085eb44d6a"
