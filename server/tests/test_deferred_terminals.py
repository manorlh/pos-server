"""
"מצב לא מקוון לכל המסופונים" — the cloud's side (P:/specs/nayax-deferred-all.md §8, §9;
app/services/deferred_control.py, app/routers/deferred_terminals.py).

Each test names a way it could look fine and still fail the owner:

* a parameter that takes junk (a till list the till cannot parse, a command that lives a week);
* the permission open to a cashier, or the phone approval on by default;
* a command that reaches a till after its time, two commands fighting (the older one done last),
  a "received" that closes the command, or an answer the cloud refuses for a word it does not know;
* "העבר הכל" reaching a Z-Credit till, a till too old to understand it, or a kiosk when kiosks are out;
* a manager switching another shop's terminals, or a user without the section switching at all;
* the controller's list naming a till off the shop's LAN, or the wrong address;
* a heartbeat refused for a malformed block, or a block that grows without bound.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException, Response

from app.models.audit_exception import TillEvent
from app.models.dashboard_access import DashboardAccessProfile
from app.models.device_command import DeviceCommand
from app.models.kiosk import KioskDevice
from app.models.printers import KitchenPrintHost
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import User, UserRole
from app.routers import deferred_terminals as R
from app.routers import device_commands as DCR
from app.routers import exceptions as ER
from app.routers import machines as MR
from app.schemas.audit_exception import TillEventIn
from app.schemas.pos_machine import MachineHeartbeatBody
from app.services import ably_notify
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import deferred_control as D
from app.services import device_commands as DC
from app.services import local_shop_z as LZ
from app.services import till_parameters as TP
from app.services import till_permissions as TPerm
from app.services.exceptions import TILL_EVENT_TYPES
from app.services.remote_approvals import catalog as AC
from app.services.remote_approvals import policy as AP
from shift_world import accept_str_uuids, make_world

CAP = [D.CAPABILITY]

REPORT = {
    "terminal": {
        "kind": "nayax_lan", "model": "C4", "eligible": True, "reason": None, "allowed": True,
        "pinpad": {"host": "192.168.1.40", "port": 8080, "path": "/SPICy", "https": True},
    },
    "offline": {"working": False, "pending": 3, "txLimit": 50, "txLeft": 47, "amountLimit": None,
                "amountLeft": None, "readAt": "2026-10-14T20:14:00Z"},
    "control": None,
    "kiosk": False,
    "at": "2026-10-14T20:14:05Z",
}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("publish_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    world.woken = []
    monkeypatch.setattr(DC, "wake", lambda machines: world.woken.extend(str(m.id) for m in machines))
    TP.ensure_builtin_parameters(world.db)
    world.t1, world.t2 = world.tills
    for m in world.tills:
        m.capabilities = list(CAP)
    world.db.commit()

    def user(name, role, *, shop=None, full=True, sections=None):
        u = User(
            id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, company_id=world.company.id,
            shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name, is_active=True,
        )
        world.db.add(u)
        world.db.flush()
        if full or sections is not None:
            world.db.add(DashboardAccessProfile(user_id=u.id, full_access=full, sections=dict(sections or {})))
        world.db.commit()
        DA.forget(world.db)
        return u

    world.user = user
    world.manager = user("mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.other_manager = user("north", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.company_manager = user("cm", UserRole.COMPANY_MANAGER)
    return world


def set_param(w, key, scope_type, scope_id, value):
    param = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=param.id, scope_type=scope_type, scope_id=scope_id, value=value))
    w.db.commit()


def view(w, user=None, shop=None):
    return R.get_deferred_terminals(
        (shop or w.shop).id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def switch(w, on, machine_ids=None, user=None, shop=None):
    body = R.SwitchIn(on=on, machineIds=machine_ids)
    return R.post_deferred_switch((shop or w.shop).id, body, current_user=user or w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)


def ack(w, till, command_id, status, detail=None, result=None):
    body = DCR.AckIn.model_validate({"status": status, "detail": detail, "result": result})
    return DCR.till_ack(str(till.id), str(command_id), body, machine=till, db=w.db)


def beat(w, machine, body):
    MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate(body), machine=machine, db=w.db, request=None)
    w.db.commit()


def row_of(out, machine):
    return next(t for t in out["tills"] if t["machineId"] == str(machine.id))


# ═════════════════════════════════════════════════════════════════════════════
# The parameters (§1, §8.1)
# ═════════════════════════════════════════════════════════════════════════════


class TestParameters:
    def test_six_built_ins_with_the_contracts_defaults(self, w):
        rows = {p.key: p for p in w.db.query(TillParameter).filter(TillParameter.key.in_(D.KEYS)).all()}
        assert set(rows) == set(D.KEYS)
        assert rows["deferredControlTills"].value_type == "string" and rows["deferredControlTills"].default_value in ("", None)
        assert (rows["deferredControlIncludeKiosks"].value_type, rows["deferredControlIncludeKiosks"].default_value) == ("boolean", False)
        assert rows["deferredAutoOff"].value_type == "enum" and rows["deferredAutoOff"].default_value == "ask"
        assert list(rows["deferredAutoOff"].enum_options) == ["ask", "auto", "never"]
        assert TP.enum_labels("deferredAutoOff")["ask"].startswith("לשאול")
        assert (rows["deferredAutoOffMinutes"].value_type, rows["deferredAutoOffMinutes"].default_value) == ("integer", 5)
        assert (rows["deferredAllowUnknownNayax"].value_type, rows["deferredAllowUnknownNayax"].default_value) == ("boolean", False)
        assert (rows["deferredCommandTtlMin"].value_type, rows["deferredCommandTtlMin"].default_value) == ("integer", 120)
        # Nothing set: the feature is off everywhere — no till controls.
        assert D.machine_settings(w.db, w.t1) == D.Settings()

    def test_the_tills_are_stored_canonical_and_junk_is_refused(self, w):
        a, b = uuid.uuid4(), uuid.uuid4()
        got = TP.validate_keyed_value("deferredControlTills", f" {str(a).upper()} ;{b}, {a}")
        assert got == f"{a},{b}"
        assert TP.validate_keyed_value("deferredControlTills", "") == ""
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value("deferredControlTills", "קופה 3")
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value("deferredControlTills", ",".join(str(uuid.uuid4()) for _ in range(51)))

    @pytest.mark.parametrize("key,good,bad", [
        ("deferredAutoOffMinutes", (1, 120), (0, 121, True, "5")),
        ("deferredCommandTtlMin", (5, 1440), (4, 1441, False, 60.5)),
    ])
    def test_the_minutes_ranges(self, key, good, bad):
        for value in good:
            assert TP.validate_keyed_value(key, value) == value
        for value in bad:
            with pytest.raises(TP.TillParameterValueError):
                TP.validate_keyed_value(key, value)

    def test_auto_off_is_one_of_three(self):
        assert TP.validate_keyed_value("deferredAutoOff", "never") == "never"
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value("deferredAutoOff", "sometimes")

    def test_resolved_per_till_most_specific_first(self, w):
        set_param(w, "deferredControlTills", "shop", w.shop.id, f"{w.t1.id}")
        set_param(w, "deferredCommandTtlMin", "company", w.company.id, 30)
        set_param(w, "deferredCommandTtlMin", "machine", w.t2.id, 10)
        got = D.resolve_for_machines(w.db, [w.t1, w.t2, w.other_till])
        assert got[w.t1.id].controls(w.t1.id) and not got[w.t2.id].controls(w.t2.id)
        assert (got[w.t1.id].ttl_minutes, got[w.t2.id].ttl_minutes, got[w.other_till.id].ttl_minutes) == (30, 10, 30)
        assert got[w.other_till.id].till_ids == ()


# ═════════════════════════════════════════════════════════════════════════════
# The permission and the phone approval (§8.1)
# ═════════════════════════════════════════════════════════════════════════════


class TestPermission:
    def test_waiter_and_cashier_never_supervisor_with_a_code_manager_alone(self):
        spec = TPerm.PERMISSIONS_BY_CODE["TERMINAL_OFFLINE_ALL"]
        assert spec.label == "מצב לא מקוון לכל המסופונים" and spec.scope is None
        got = tuple(TPerm.DEFAULTS[r]["TERMINAL_OFFLINE_ALL"] for r in ("waiter", "cashier", "supervisor", "manager"))
        assert got == ("deny", "deny", "approval", "allow")
        assert TPerm.DEFAULTS["legacy_cashier"]["TERMINAL_OFFLINE_ALL"] == "deny"
        assert TPerm.DEFAULTS["legacy_manager"]["TERMINAL_OFFLINE_ALL"] == "allow"
        # An older till reading `role` only is told nothing new: not one of the senior codes.
        assert "TERMINAL_OFFLINE_ALL" not in TPerm.LEGACY_SENIOR_CODES

    def test_the_phone_approval_type_off_by_default_and_its_approver_must_be_allowed(self):
        t = AC.TYPES_BY_KEY["terminal_offline_all"]
        assert (t.label, t.phase, t.unit) == ("מצב לא מקוון לכל המסופונים", 1, None)
        assert t.permission_code == "APPROVE_REMOTE.terminal_offline_all"
        assert t.approver_code == "TERMINAL_OFFLINE_ALL" and t.approver_section == "terminals_offline"
        assert "הקופה המנהלת" in t.sees and t.scopes == ()
        assert AC.type_defaults("terminal_offline_all")["enabled"] is False
        assert TPerm.DEFAULTS["supervisor"]["APPROVE_REMOTE.terminal_offline_all"] == "allow"
        assert TPerm.DEFAULTS["cashier"]["APPROVE_REMOTE.terminal_offline_all"] == "deny"
        assert TPerm.DEFAULTS["legacy_cashier"]["APPROVE_REMOTE.terminal_offline_all"] == "deny"
        assert "terminal_offline_all" in [x["key"] for x in AC.catalog_json()["types"]]

    def test_off_in_the_effective_policy_of_a_till(self, w):
        assert AP.for_machine(w.db, w.t1).type("terminal_offline_all")["enabled"] is False

    def test_the_shared_matrix_fixture_has_it(self):
        data = json.loads((Path(__file__).parent / "fixtures" / "till_permissions_matrix.json").read_text(encoding="utf-8"))
        assert data["codes"][-1] == "TERMINAL_OFFLINE_ALL" and "APPROVE_REMOTE.terminal_offline_all" in data["codes"]
        assert data["roles"]["supervisor"]["states"]["TERMINAL_OFFLINE_ALL"] == "approval"
        assert data["roles"]["legacy_cashier"]["states"]["TERMINAL_OFFLINE_ALL"] == "deny"


# ═════════════════════════════════════════════════════════════════════════════
# The command (§8.5)
# ═════════════════════════════════════════════════════════════════════════════


class TestCommand:
    def test_the_switch_body_with_its_own_request_id_and_the_ttl(self, w):
        set_param(w, "deferredCommandTtlMin", "machine", w.t2.id, 30)
        out = switch(w, True)
        assert {c["machineId"] for c in out["created"]} == {str(w.t1.id), str(w.t2.id)} and out["skipped"] == []
        assert sorted(w.woken) == sorted([str(w.t1.id), str(w.t2.id)])
        rows = {str(r.machine_id): r for r in w.db.query(DeviceCommand).all()}
        r1, r2 = rows[str(w.t1.id)], rows[str(w.t2.id)]
        assert r1.batch_id is not None and r1.batch_id == r2.batch_id and r1.action == "terminal_offline"
        p = r1.params
        assert p["requestId"] == str(r1.id) and p["on"] is True and p["source"] == "cloud"
        assert p["from"] == {"machineId": None, "name": "דשבורד"}
        assert p["by"] == {"id": str(w.admin.id), "name": "admin"} and p["requestedBy"] == p["by"]
        issued = datetime.fromisoformat(p["issuedAt"])
        assert issued.tzinfo is not None and abs((issued - datetime.now(timezone.utc)).total_seconds()) < 60
        created = DC._aware(r1.created_at)
        assert DC._aware(r1.expires_at) - created == timedelta(minutes=120)
        assert DC._aware(r2.expires_at) - DC._aware(r2.created_at) == timedelta(minutes=30)
        # The audit: who asked, from the dashboard.
        assert (r1.created_by_name, r1.source, r1.created_by_user_id) == ("admin", "dashboard", w.admin.id)

    def test_the_latest_wins(self, w):
        first = switch(w, True, [w.t1.id])["created"][0]["commandId"]
        DC.pull(w.db, w.t1)  # the till has it
        w.db.commit()
        second = switch(w, False, [w.t1.id])["created"][0]["commandId"]
        old, new = w.db.get(DeviceCommand, uuid.UUID(first)), w.db.get(DeviceCommand, uuid.UUID(second))
        assert (old.status, old.detail) == ("cancelled", "superseded") and new.status == "pending"
        assert [c["id"] for c in DC.pull(w.db, w.t1)["commands"]] == [second]

    def test_never_delivered_after_its_end(self, w):
        set_param(w, "deferredCommandTtlMin", "machine", w.t1.id, 5)
        cid = switch(w, True, [w.t1.id])["created"][0]["commandId"]
        later = datetime.now(timezone.utc) + timedelta(minutes=6)
        assert DC.pull(w.db, w.t1, now=later)["commands"] == []
        w.db.commit()
        assert w.db.get(DeviceCommand, uuid.UUID(cid)).status == "expired"

    def test_received_is_no_answer_then_the_final_one_is_cleaned(self, w):
        cid = switch(w, False, [w.t1.id])["created"][0]["commandId"]
        DC.pull(w.db, w.t1)
        w.db.commit()
        out = ack(w, w.t1, cid, "received")
        assert out["status"] == "delivered" and out["result"]["receivedAt"]
        received_at = out["result"]["receivedAt"]
        # Still the till's open command, and "התקבל" on the dashboard.
        assert [c["id"] for c in DC.pull(w.db, w.t1)["commands"]] == [cid]
        assert row_of(view(w), w.t1)["lastCommand"]["state"] == "received"
        # A second "received" changes nothing.
        assert ack(w, w.t1, cid, "received")["result"]["receivedAt"] == received_at
        raw = {
            "working": False, "pending": 0, "error": None, "secret": "x" * 5000,
            "authorization": {"ok": True, "statusCode": 0, "approved": 5, "declined": 1, "approvedAmount": "412.50",
                              "pan": "4580000000000000"},
        }
        out = ack(w, w.t1, cid, "done", None, raw)
        assert out["status"] == "done" and out["detail"] is None
        assert out["result"] == {
            "receivedAt": received_at, "working": False, "pending": 0, "error": None,
            "authorization": {"ok": True, "statusCode": 0, "approved": 5, "declined": 1, "approvedAmount": "412.50"},
        }
        last = row_of(view(w), w.t1)["lastCommand"]
        assert (last["state"], last["on"], last["receivedAt"]) == ("done", False, received_at)
        assert last["result"]["authorization"]["declined"] == 1

    @pytest.mark.parametrize("status,detail,state", [
        ("refused", "not_eligible:zcredit", "failed"),
        ("refused", "stale", "failed"),
        ("failed", "timeout_busy", "failed"),
        ("failed", "Terminal said: " + "e" * 400, "failed"),
        ("refused", "a_word_the_cloud_never_heard_of", "failed"),
    ])
    def test_any_reason_the_till_gives_is_kept_clipped(self, w, status, detail, state):
        cid = switch(w, True, [w.t1.id])["created"][0]["commandId"]
        DC.pull(w.db, w.t1)
        out = ack(w, w.t1, cid, status, detail, {"working": "yes", "pending": -3, "error": 7})
        assert out["status"] == status and out["detail"] == detail[:300]
        assert out["result"] == {"working": None, "pending": None, "error": None}
        assert row_of(view(w), w.t1)["lastCommand"]["state"] == state

    def test_received_is_only_for_this_command(self, w):
        other = DC.create(w.db, [w.t1], "sync_now", user=w.admin)[0]
        w.db.commit()
        with pytest.raises(HTTPException) as refused:
            ack(w, w.t1, other.id, "received")
        assert refused.value.status_code == 422

    def test_an_answer_after_its_end_is_kept_once_it_was_received(self, w):
        set_param(w, "deferredCommandTtlMin", "machine", w.t1.id, 5)
        cid = switch(w, True, [w.t1.id])["created"][0]["commandId"]
        DC.pull(w.db, w.t1)
        ack(w, w.t1, cid, "received")
        # The internet went away; the deadline passed with no answer.
        later = datetime.now(timezone.utc) + timedelta(hours=3)
        DC.expire_old(w.db, now=later)
        w.db.commit()
        row = w.db.get(DeviceCommand, uuid.UUID(cid))
        assert (row.status, row.detail) == ("expired", "not_answered")
        out = ack(w, w.t1, cid, "done", None, {"working": True, "pending": 0})
        assert out["status"] == "done" and out["detail"] is None and out["result"]["working"] is True

    def test_an_overtaken_command_keeps_what_the_till_did_with_it(self, w):
        first = switch(w, True, [w.t1.id])["created"][0]["commandId"]
        DC.pull(w.db, w.t1)
        switch(w, False, [w.t1.id])
        out = ack(w, w.t1, first, "done", None, {"working": True})
        assert (out["status"], out["detail"]) == ("cancelled", "superseded")
        assert out["result"]["answer"] == {"status": "done", "detail": None, "working": True}

    def test_a_kiosk_takes_it(self, w):
        w.db.add(KioskDevice(machine_id=w.t2.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="K", enabled=True))
        w.db.commit()
        rows = DC.create(w.db, [w.t2], "terminal_offline", user=w.admin, params={"on": True})
        assert len(rows) == 1


# ═════════════════════════════════════════════════════════════════════════════
# The dashboard (§9)
# ═════════════════════════════════════════════════════════════════════════════


class TestDashboard:
    def test_the_list_from_the_tills_word_and_from_what_the_cloud_knows(self, w):
        beat(w, w.t1, {"capabilities": CAP, "deferredTerminal": {**REPORT, "offline": {**REPORT["offline"], "working": True}}})
        w.t2.settings = {"paymentIntegration": "zcredit"}
        w.db.commit()
        out = view(w)
        assert out["settings"] == {"includeKiosks": False, "autoOff": "ask", "autoOffMinutes": 5,
                                   "allowUnknownNayax": False, "ttlMinutes": 120}
        assert out["canSwitch"] is True and out["open"] is False and out["controllers"] == []
        one, two = row_of(out, w.t1), row_of(out, w.t2)
        assert (one["kind"], one["model"], one["eligible"], one["reason"], one["mode"]) == ("nayax_lan", "C4", True, None, "offline")
        assert (one["pending"], one["txLimit"], one["txLeft"], one["eligibilitySource"]) == (3, 50, 47, "till")
        assert one["terminal"]["terminal"]["pinpad"]["host"] == "192.168.1.40" and one["reportedAt"]
        assert (two["kind"], two["eligible"], two["reason"], two["reasonText"]) == ("zcredit", False, "zcredit", "Z-Credit — לא נתמך")
        assert two["mode"] == "unknown" and two["lastCommand"] is None
        assert {t["machineId"] for t in out["tills"]} == {str(w.t1.id), str(w.t2.id)}  # never another shop's

    def test_switch_all_skips_whoever_cannot_take_it(self, w):
        w.t2.settings = {"paymentIntegration": "zcredit"}
        third = _till(w, "Old", capabilities=[])
        fourth = _till(w, "Kiosk", capabilities=list(CAP))
        w.db.add(KioskDevice(machine_id=fourth.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="K", enabled=True))
        w.db.commit()
        out = switch(w, True)
        assert [c["machineId"] for c in out["created"]] == [str(w.t1.id)]
        assert {s["machineId"]: s["reason"] for s in out["skipped"]} == {
            str(w.t2.id): "not_eligible:zcredit", str(third.id): "needs_update", str(fourth.id): "kiosk_excluded",
        }
        listed = view(w)
        assert row_of(listed, third)["reasonText"] == "הקופה צריכה עדכון"
        assert row_of(listed, fourth)["isKiosk"] is True and row_of(listed, fourth)["reason"] == "kiosk_excluded"
        assert listed["open"] is True

    def test_kiosks_once_included(self, w):
        kiosk = _till(w, "Kiosk", capabilities=list(CAP))
        w.db.add(KioskDevice(machine_id=kiosk.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="K", enabled=True))
        w.db.commit()
        beat(w, kiosk, {"capabilities": CAP, "deferredTerminal": {**REPORT, "kiosk": True}})
        assert switch(w, True, [kiosk.id])["skipped"] == [{"machineId": str(kiosk.id), "reason": "kiosk_excluded"}]
        set_param(w, "deferredControlIncludeKiosks", "shop", w.shop.id, True)
        out = switch(w, True, [kiosk.id])
        assert [c["machineId"] for c in out["created"]] == [str(kiosk.id)] and out["skipped"] == []

    def test_the_tills_word_decides_and_a_downgraded_build_needs_an_update(self, w):
        beat(w, w.t1, {"capabilities": CAP, "deferredTerminal": {
            **REPORT, "terminal": {**REPORT["terminal"], "model": "VX520", "eligible": False, "reason": "other_model"}}})
        beat(w, w.t2, {"capabilities": [], "deferredTerminal": REPORT})
        out = switch(w, True)
        assert out["created"] == []
        assert {s["reason"] for s in out["skipped"]} == {"not_eligible:other_model", "needs_update"}
        assert row_of(view(w), w.t1)["reasonText"] == "דגם VX520 — לא נתמך"

    def test_an_unknown_nayax_without_a_report_only_when_allowed(self, w):
        w.t1.settings = {"paymentIntegration": "nayax_lan"}
        w.db.commit()
        assert switch(w, True, [w.t1.id])["skipped"] == [{"machineId": str(w.t1.id), "reason": "not_eligible:unknown_model"}]
        set_param(w, "deferredAllowUnknownNayax", "shop", w.shop.id, True)
        assert len(switch(w, True, [w.t1.id])["created"]) == 1

    def test_training_mode_is_out(self, w):
        w.shop.training_mode = True
        w.db.commit()
        assert switch(w, True, [w.t1.id])["skipped"][0]["reason"] == "not_eligible:training"

    def test_a_till_of_another_shop_is_never_switched(self, w):
        out = switch(w, True, [w.other_till.id])
        assert out["created"] == [] and out["skipped"] == [{"machineId": str(w.other_till.id), "reason": "not_found"}]

    def test_who_may(self, w):
        # The shop's manager and a company manager over it: yes.
        assert len(switch(w, True, [w.t1.id], user=w.manager)["created"]) == 1
        assert len(switch(w, False, [w.t1.id], user=w.company_manager)["created"]) == 1
        # Another shop's manager: 403, nothing sent.
        before = w.db.query(DeviceCommand).count()
        with pytest.raises(HTTPException) as refused:
            switch(w, True, user=w.other_manager)
        assert refused.value.status_code == 403
        with pytest.raises(HTTPException):
            view(w, user=w.other_manager)
        # A distributor or a shift supervisor: not theirs (§9: super admin, company and shop managers).
        for role in (UserRole.DISTRIBUTOR, UserRole.SHIFT_SUPERVISOR):
            with pytest.raises(HTTPException) as refused:
                switch(w, True, user=w.user(f"u-{role.value}", role, shop=w.shop))
            assert refused.value.status_code == 403
        assert w.db.query(DeviceCommand).count() == before

    def test_the_section(self, w):
        viewer = w.user("viewer", UserRole.SHOP_MANAGER, shop=w.shop, full=False,
                        sections={"terminals_offline": "view"})
        assert view(w, user=viewer)["canSwitch"] is False
        with pytest.raises(HTTPException) as refused:
            switch(w, True, user=viewer)
        assert refused.value.status_code == 403 and refused.value.detail["code"] == "section_forbidden"
        # The routes by the route table: view to read, edit to switch; nothing without the section.
        for method, path, level in (
            ("GET", "/shops/{shop_id}/deferred-terminals", DS.VIEW),
            ("POST", "/shops/{shop_id}/deferred-terminals/switch", DS.EDIT),
            ("PUT", "/shops/{shop_id}/deferred-terminals/controllers", DS.EDIT),
        ):
            rule = DS.rule_for(method, path)
            assert rule.kind == "section" and rule.sections == ("terminals_offline",) and rule.needed_level(method) == level
            others = DA.EffectiveAccess(restricted=True, sections={"device_control": DS.EDIT}, has_profile=True, full_access=False)
            assert DA.check_rule(others, rule, method).status_code == 403
            mine = DA.EffectiveAccess(restricted=True, sections={"terminals_offline": level}, has_profile=True, full_access=False)
            assert DA.check_rule(mine, rule, method) is None
        assert DS.rule_for("GET", "/sync/{machine_id}/deferred-control").kind == "till"

    def test_on_by_default_for_the_shop_manager_template_not_the_area_manager(self):
        assert DS.SECTION_BY_ID["terminals_offline"].label == "מסופונים — מצב לא מקוון"
        assert DS.SECTION_BY_ID["terminals_offline"].pages == ("/dashboard/deferred-terminals",)
        assert DS.BRANCH_MANAGER_SECTIONS["terminals_offline"] == DS.EDIT
        assert "terminals_offline" not in DS.AREA_MANAGER_SECTIONS
        assert DA.effective_access(None, None).allows("terminals_offline", DS.EDIT)  # the super admin's way: unrestricted

    def test_the_device_page_marks_a_controller_at_the_shops_level(self, w):
        body = R.ControllerIn(machineId=w.t2.id, on=True)
        out = R.put_deferred_controller(w.shop.id, body, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert out["changed"] is True and out["controllers"] == [str(w.t2.id)]
        value = w.db.query(TillParameterValue).join(TillParameter).filter(TillParameter.key == "deferredControlTills").one()
        assert (value.scope_type, value.scope_id, value.value) == ("shop", w.shop.id, str(w.t2.id))
        # Written as the parameters page writes: in the change log, with who.
        assert w.db.query(TillParameterChange).count() == 1
        R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.t1.id, on=True), current_user=w.manager,
                                  active_tenant_id=w.tenant.id, db=w.db)
        assert set(D.parse_tills(value.value)) == {str(w.t1.id), str(w.t2.id)}
        again = R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.t1.id, on=True), current_user=w.manager,
                                          active_tenant_id=w.tenant.id, db=w.db)
        assert again["changed"] is False
        R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.t1.id, on=False), current_user=w.manager,
                                  active_tenant_id=w.tenant.id, db=w.db)
        R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.t2.id, on=False), current_user=w.manager,
                                  active_tenant_id=w.tenant.id, db=w.db)
        # Empty and nothing inherited: the shop's own row goes.
        assert w.db.query(TillParameterValue).count() == 0
        with pytest.raises(HTTPException) as refused:
            R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.other_till.id, on=True),
                                      current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert refused.value.status_code == 404

    def test_a_shop_says_none_over_its_companys_list(self, w):
        set_param(w, "deferredControlTills", "company", w.company.id, f"{w.t1.id}")
        R.put_deferred_controller(w.shop.id, R.ControllerIn(machineId=w.t1.id, on=False), current_user=w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)
        own = w.db.query(TillParameterValue).filter(TillParameterValue.scope_type == "shop").one()
        assert own.value == "" and D.machine_settings(w.db, w.t1).till_ids == ()


def _till(w, name, *, capabilities, lan_ip=None):
    from app.models.pos_machine import PairingStatus, POSMachine

    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name=name,
        machine_code=f"M-{uuid.uuid4().hex[:8]}", pos_number=str(uuid.uuid4().int % 900 + 10), is_active=True,
        pairing_status=PairingStatus.ASSIGNED, capabilities=capabilities, lan_ip=lan_ip,
        last_heartbeat_at=datetime.now(timezone.utc),
    )
    w.db.add(m)
    w.db.flush()
    return m


# ═════════════════════════════════════════════════════════════════════════════
# The controller's list (§8.4)
# ═════════════════════════════════════════════════════════════════════════════


class TestControllerList:
    def test_not_a_controller_gets_nothing(self, w):
        out = R.till_deferred_control(str(w.t1.id), machine=w.t1, db=w.db)
        assert out["controller"] is False and out["tills"] == [] and out["settings"]["autoOff"] == "ask"

    def test_a_controller_gets_the_shops_tills_with_their_addresses(self, w):
        set_param(w, "deferredControlTills", "shop", w.shop.id, f"{w.t1.id}")
        set_param(w, "deferredAutoOff", "shop", w.shop.id, "auto")
        w.db.add(KitchenPrintHost(machine_id=w.t2.id, shop_id=w.shop.id, lan_address="192.168.1.23", port=8400))
        w.t1.lan_ip = "192.168.1.21"
        plain = _till(w, "Plain", capabilities=[], lan_ip="192.168.1.30")
        nowhere = _till(w, "Nowhere", capabilities=list(CAP))
        remote = _till(w, "Remote", capabilities=list(CAP), lan_ip="10.0.0.5")
        kiosk = _till(w, "Kiosk", capabilities=list(CAP), lan_ip="192.168.1.50")
        w.db.add(KioskDevice(machine_id=kiosk.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="K", enabled=True))
        LZ.set_remote_till_ids(w.shop, [remote.id])
        w.db.commit()
        beat(w, w.t2, {"capabilities": CAP, "deferredTerminal": REPORT})
        out = R.till_deferred_control(str(w.t1.id), machine=w.t1, db=w.db)
        assert out["controller"] is True and out["settings"]["autoOff"] == "auto" and out["serverTime"]
        tills = {t["machineId"]: t for t in out["tills"]}
        # Never the till off the shop's LAN, nor a kiosk while kiosks are out, nor another shop's.
        assert set(tills) == {str(w.t1.id), str(w.t2.id), str(plain.id), str(nowhere.id)}
        me, two = tills[str(w.t1.id)], tills[str(w.t2.id)]
        assert me["isSelf"] is True and (me["lanAddress"], me["lanPort"]) == ("192.168.1.21", 8399)
        assert (two["lanAddress"], two["lanPort"], two["isSelf"], two["capable"]) == ("192.168.1.23", 8400, False, True)
        assert two["terminal"]["terminal"]["model"] == "C4" and two["terminal"]["offline"]["pending"] == 3
        assert two["reportedAt"] == two["terminal"]["reportedAt"]
        assert (tills[str(plain.id)]["lanAddress"], tills[str(plain.id)]["capable"]) == ("192.168.1.30", False)
        assert (tills[str(nowhere.id)]["lanAddress"], tills[str(nowhere.id)]["lanPort"]) == (None, None)
        assert tills[str(nowhere.id)]["terminal"] is None
        # Kiosks included: the kiosk too.
        set_param(w, "deferredControlIncludeKiosks", "shop", w.shop.id, True)
        out = R.till_deferred_control(str(w.t1.id), machine=w.t1, db=w.db)
        assert {t["machineId"]: t["isKiosk"] for t in out["tills"]}[str(kiosk.id)] is True


# ═════════════════════════════════════════════════════════════════════════════
# The heartbeat (§8.5 "דופק") and the log
# ═════════════════════════════════════════════════════════════════════════════


class TestHeartbeat:
    def test_kept_nested_cleaned_and_absent_leaves_it(self, w):
        block = {
            **REPORT,
            "terminal": {**REPORT["terminal"], "model": "C" * 500, "eligible": "yes", "serial": "S/N 123",
                         "pinpad": {"host": "192.168.1.40", "port": 99999, "path": "/SPICy", "https": "true"}},
            "offline": {"working": True, "pending": -1, "txLimit": 50.0, "txLeft": "47", "amountLimit": "1500.00",
                        "amountLeft": -2, "readAt": "2026-10-14T20:14:00Z"},
            "control": {"on": True, "by": "דנה", "byId": "u1", "from": "קופה 1", "fromId": str(w.t1.id),
                        "at": "2026-10-14T20:14:00Z", "source": "lan", "requestId": "r1", "extra": {"a": 1}},
            "last": {"requestId": "r1"},
            "kiosk": False,
        }
        beat(w, w.t1, {"deferredTerminal": block})
        kept = w.t1.device_info["deferredTerminal"]
        assert kept["terminal"]["model"] == "C" * 64 and kept["terminal"]["eligible"] is None
        assert "serial" not in kept["terminal"] and "last" not in kept
        assert kept["terminal"]["pinpad"] == {"host": "192.168.1.40", "port": None, "path": "/SPICy", "https": None}
        assert kept["offline"] == {"working": True, "pending": None, "txLimit": 50, "txLeft": None,
                                   "amountLimit": "1500.00", "amountLeft": None, "readAt": "2026-10-14T20:14:00Z"}
        assert kept["control"]["by"] == "דנה" and "extra" not in kept["control"]
        assert kept["kiosk"] is False and kept["reportedAt"]
        # Another beat without it: as it was.
        beat(w, w.t1, {"appVersion": "1.2.3"})
        assert w.t1.device_info["deferredTerminal"] == kept

    def test_a_malformed_block_is_never_a_refused_beat(self, w):
        beat(w, w.t1, {"deferredTerminal": "broken", "appVersion": "9"})
        assert (w.t1.device_info or {}).get("deferredTerminal") is None and w.t1.app_version == "9"
        beat(w, w.t1, {"deferredTerminal": {"terminal": 5, "unknown": True}})
        assert (w.t1.device_info or {}).get("deferredTerminal") is None

    def test_other_device_info_is_kept(self, w):
        w.t1.device_info = {"platform": "android", "model": "F20"}
        w.db.commit()
        beat(w, w.t1, {"deferredTerminal": REPORT})
        assert w.t1.device_info["platform"] == "android" and w.t1.device_info["model"] == "F20"


class TestTillEvents:
    @pytest.mark.parametrize("kind", ["deferred_mode_on", "deferred_mode_off"])
    def test_recorded_feeding_no_rule(self, w, kind):
        assert kind in TILL_EVENT_TYPES
        body = TillEventIn.model_validate({
            "id": str(uuid.uuid4()), "type": kind, "occurredAt": "2026-10-14T20:14:00Z",
            "details": {"requestId": "r1", "source": "lan", "by": "דנה", "from": "קופה 1", "kind": "nayax_lan",
                        "model": "C4", "pending": 3, "approved": 5, "declined": 1, "approvedAmount": "412.50"},
        })
        out = ER.post_till_event(str(w.t1.id), body, Response(), machine=w.t1, db=w.db)
        assert out.status == "accepted"
        row = w.db.get(TillEvent, body.id)
        assert row is not None and row.event_type == kind
        from app.models.audit_exception import AuditException

        assert w.db.query(AuditException).count() == 0
