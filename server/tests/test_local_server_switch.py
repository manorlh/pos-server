"""
"העברת שרת מקומי" from the cloud only, and "סגירת משמרת מהענן" (app/services/local_server_switch.py,
app/routers/local_server.py; P:/specs/local-server-switch.md §7 the owner's decisions, §8 the contract).

* Who switches: the super admin, or a user the super admin granted "העברת שרת מקומי" — never by
  "גישה מלאה" alone, never given on by anyone else.
* The switch is the full move (main till, tables host, print server, shop Z master), the notice to
  every till, the audit; 409 `host_online` while the cloud hears the old server, unless `force`;
  the old server's shift closed in the same step; the shop Z released by the super admin.
* "סגירת משמרת מהענן": only a till not heard for 5 minutes (409 `till_online`), the remote close's
  people, no Z; the till learns it (`shiftClosedFromCloud`), its late documents are taken and flagged.
* Gap 1: a former server's `formerHost` report — `applied` / `conflict` per order, the conflicts kept
  for the shop page.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.audit_exception import AuditException
from app.models.dashboard_access import DashboardAccessProfile
from app.models.shift import ShiftStatus
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.till_message import TillMessage, TillMessageReceipt
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import local_server as LR
from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.tables import TablesReportIn
from app.services import ably_notify
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import local_server_switch as LSS
from app.services import main_till as MT
from app.services import tables as T
from app.services import till_parameters as TP
from app.services.printers import print_host_of_shop
from app.services.shifts import note_documents_after_close
from app.services.tables import tables_host_of_shop
from app.services.till_messages import SERVER_SWITCH_TITLE
from shift_world import accept_str_uuids, freeze_z_run_clock, make_world

LAN = "רשת מקומית (קופה ראשית)"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    for m in world.tills:
        heard(m, 10)
    world.db.flush()
    return world


def heard(till, ago_seconds):
    till.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=ago_seconds)


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.flush()


def user(w, role=UserRole.SHOP_MANAGER, *, sections=None, full_access=False, name="dana"):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=w.shop.id if role == UserRole.SHOP_MANAGER else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    if sections is not None or full_access:
        w.db.add(DashboardAccessProfile(user_id=u.id, full_access=full_access, sections=sections or {}))
        w.db.flush()
    DA.forget(w.db)
    return u


def support(w):
    """A support person: a shop manager the super admin granted "העברת שרת מקומי"."""
    return user(w, sections={"devices": "edit", LSS.SECTION: "edit"}, name="support")


def switch(w, target, *, by=None, **options):
    w.db.commit()  # the world as set up so far: a refusal rolls back to here
    body = LR.SwitchIn(targetMachineId=target.id, **options)
    return LR.post_local_server_switch(
        w.shop.id, body, BackgroundTasks(), current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def notices(w):
    out = []
    for m in w.db.query(TillMessage).filter(TillMessage.title == SERVER_SWITCH_TITLE).all():
        tills = {str(r.machine_id) for r in w.db.query(TillMessageReceipt).filter(TillMessageReceipt.message_id == m.id)}
        out.append((m, tills))
    return out


def exceptions_of(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


def held(w, key, till):
    return MT.is_on(TP.till_parameters_for_machine(w.db, till).parameters.get(key))


# ── Who ───────────────────────────────────────────────────────────────────────


def test_the_super_admin_and_a_granted_user_switch_nobody_else(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    heard(t1, 3600)
    assert LSS.may_switch(w.db, w.admin) is True
    # A shop manager, a full-access company manager, a view-only grant: no.
    for who in (
        user(w, name="plain"),
        user(w, UserRole.COMPANY_MANAGER, full_access=True, name="full"),
        user(w, sections={LSS.SECTION: "view"}, name="viewer"),
    ):
        assert LSS.may_switch(w.db, who) is False
        e = refused(switch, w, t2, by=who)
        assert e.status_code == 403 and e.detail["code"] == "local_server_switch_forbidden"
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t1.id
    # Support, granted it explicitly: yes.
    out = switch(w, t2, by=support(w))
    assert out["mainTill"]["machineId"] == str(t2.id) and out["switchedBy"] == "support"


def test_the_permission_is_granted_by_the_super_admin_alone(w):
    from app.routers.dashboard_access import check_grant

    full = user(w, UserRole.COMPANY_MANAGER, full_access=True, name="full")
    mine = DA.effective_access(w.db, full)
    # Full access holds every section but this one, and cannot give it on.
    assert LSS.SECTION not in DA.grantable(mine)
    assert DA.grantable(mine, super_admin=True)[LSS.SECTION] == DS.EDIT
    values = {"full_access": False, "sections": {LSS.SECTION: "edit"}, "org_wide": False, "company_ids": [], "shop_ids": []}
    e = refused(check_grant, w.db, full, values, current=None)
    assert e.status_code == 403 and e.detail["code"] == "grant_exceeds_own"
    check_grant(w.db, w.admin, values, current=None)  # the super admin: fine
    # Someone holding it does not give it on either; keeping it on a user who has it is fine.
    holder = support(w)
    assert LSS.SECTION not in DA.grantable(DA.effective_access(w.db, holder))
    had = DA.EffectiveAccess(restricted=True, sections={LSS.SECTION: "edit", "reports": "view"}, has_profile=True, full_access=False)
    check_grant(w.db, full, {**values, "sections": {LSS.SECTION: "edit", "reports": "view"}}, current=had)
    # Nor does "גישה מלאה" carry it: not with full access on, not from a full-access user turned
    # restricted (whose full access never included it).
    e = refused(check_grant, w.db, full, {**values, "full_access": True}, current=None)
    assert e.status_code == 403 and e.detail["code"] == "grant_exceeds_own" and "מנהל-על" in e.detail["message"]
    was_full = DA.EffectiveAccess(restricted=False, sections={}, has_profile=True, full_access=True)
    e = refused(check_grant, w.db, full, values, current=was_full)
    assert e.status_code == 403
    check_grant(w.db, full, {**values, "sections": {"reports": "view"}}, current=was_full)  # without it: fine
    # The permissions dialog marks it.
    [entry] = [s for s in DS.catalogue() if s["id"] == LSS.SECTION]
    assert entry["superAdminOnly"] is True and entry["pages"] == []
    assert DS.SUPER_ADMIN_GRANTED == frozenset({LSS.SECTION})


def test_the_routes_are_mapped_to_their_sections():
    import app.main as main

    def rule(path, method):
        [route] = [r for r in main.app.routes if getattr(r, "path", "") == "/api/v1" + path and method in r.methods]
        return DA.classify(route, method)

    switch_rule = rule("/shops/{shop_id}/local-server/switch", "POST")
    assert switch_rule.sections == (LSS.SECTION,)
    assert set(rule("/shops/{shop_id}/local-server", "GET").sections) == {"devices", LSS.SECTION}
    assert rule("/machines/{machine_id}/shifts/close-from-cloud", "POST").sections == ("z",)
    assert rule("/machines/{machine_id}/close-shift", "POST").sections == ("z",)  # the remote close: the same


# ── The switch ───────────────────────────────────────────────────────────────


def test_the_full_move_tells_every_till_and_is_recorded(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    for key in (MT.MAIN_TILL_KEY, "tablesHostTill", "printHostTill", MT.SHOP_Z_MASTER_KEY):
        set_param(w, key, "machine", t1.id, True)
    heard(t1, 3600)
    out = switch(w, t2)
    assert out["previous"]["machineId"] == str(t1.id) and out["mainTill"]["machineId"] == str(t2.id)
    assert set(out["moved"]) == {MT.MAIN_TILL_KEY, "tablesHostTill", "printHostTill", MT.SHOP_Z_MASTER_KEY}
    assert out["forced"] is False and out["closedShift"] is None and out["releasedShopZ"] is False
    for key in (MT.MAIN_TILL_KEY, "tablesHostTill", "printHostTill", MT.SHOP_Z_MASTER_KEY):
        assert held(w, key, t2) and not held(w, key, t1), key
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t2.id
    assert tables_host_of_shop(w.db, w.shop.id).id == t2.id
    assert print_host_of_shop(w.db, w.shop.id).id == t2.id
    # "השרת הוחלף — יש לבדוק תקינות נתונים" on every till, naming who.
    [(message, tills)] = notices(w)
    assert tills == {str(t1.id), str(t2.id)} and "admin" in message.body
    # The audit: who, when, from, to, what moved.
    [row] = exceptions_of(w, LSS.SWITCH_EXCEPTION)
    assert row.details["by"] == "admin" and row.details["from"]["machineId"] == str(t1.id)
    assert row.details["to"]["machineId"] == str(t2.id) and "הועבר" in row.details["summary"]
    assert row.machine_id == t2.id and row.severity == "medium"
    state = out["state"]
    assert state["lastSwitch"]["id"] == row.details["id"]
    assert state["server"]["machineId"] == str(t2.id)
    assert state["candidates"] == [] or all(c["machineId"] != str(t2.id) for c in state["candidates"])


def test_outside_the_lan_mode_too_and_a_first_server(w):
    t1, t2 = w.tills
    # No server at all yet (two tills, none named): the wizard names one.
    assert LSS.current_server(w.db, w.shop) is None
    out = switch(w, t1)
    assert out["previous"] is None and MT.main_till_of_shop(w.db, w.shop.id).id == t1.id
    assert notices(w) == []  # naming the first is no switch
    assert len(exceptions_of(w, LSS.SWITCH_EXCEPTION)) == 1


def test_host_online_is_refused_unless_forced(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    w.db.commit()
    e = refused(switch, w, t2)
    assert e.status_code == 409 and e.detail["code"] == "host_online"
    assert "בעיית רשת" in e.detail["message"] and e.detail["canForce"] is True
    assert e.detail["host"]["machineId"] == str(t1.id)
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t1.id
    # A support user may force too (§7.2) — recorded as forced, high.
    out = switch(w, t2, by=support(w), force=True)
    assert out["forced"] is True and MT.main_till_of_shop(w.db, w.shop.id).id == t2.id
    [row] = exceptions_of(w, LSS.SWITCH_EXCEPTION)
    assert row.severity == "high" and row.details["forced"] is True and "בכפייה" in row.details["summary"]


def test_the_target_must_be_an_online_android_till_of_the_shop(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    heard(t1, 3600)
    e = refused(switch, w, w.other_till)
    assert e.status_code == 422 and e.detail["code"] == "target_not_in_shop"
    heard(t2, 3600)
    e = refused(switch, w, t2)
    assert e.status_code == 409 and e.detail["code"] == "target_not_eligible" and e.detail["reason"] == "offline"
    heard(t2, 10)
    t2.platform = "windows"
    e = refused(switch, w, t2)
    assert e.detail["reason"] == "not_android" and "אנדרואיד" in e.detail["message"]
    t2.platform = "android"
    e = refused(switch, w, t1)
    assert e.detail["code"] in ("already_local_server", "target_not_eligible")
    heard(t1, 10)
    e = refused(switch, w, t1)
    assert e.status_code == 409 and e.detail["code"] == "already_local_server"
    # The wizard lists the others with why not.
    state = LSS.state(w.db, w.shop, w.admin)
    assert [c["machineId"] for c in state["candidates"]] == [str(t2.id)] and state["candidates"][0]["eligible"]


def test_the_old_servers_shift_closes_in_the_same_step(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    shift = w.shift(t1, 7, status=ShiftStatus.OPEN)
    w.doc(t1, shift, "50.00")
    w.db.commit()
    # Still heard: the shift cannot be closed from the cloud, even with force; nothing moves.
    e = refused(switch, w, t2, force=True, closeOldShift=True)
    assert e.status_code == 409 and e.detail["code"] == "till_online"
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t1.id and shift.status == ShiftStatus.OPEN
    heard(t1, 600)
    out = switch(w, t2, closeOldShift=True, countedCash=Decimal("140"))
    closed = out["closedShift"]
    assert closed["shiftId"] == str(shift.id) and closed["countedCash"] == "140.00"
    w.db.refresh(shift)
    assert shift.status == ShiftStatus.CLOSED and shift.z_report_id is None
    assert shift.reconstruction_basis["closedFromCloud"] is True
    assert shift.reconstruction_basis["label"] == "נסגרה מהענן — הקופה לא הייתה זמינה"
    assert shift.reconstruction_basis["context"] == "switch"
    # Opening 100 + cash 50 expected; 140 counted by hand.
    assert shift.expected_cash == Decimal("150.00") and shift.discrepancy == Decimal("-10.00")
    assert shift.unattended is False
    assert out["state"]["lastSwitch"]["closedShift"]["shiftId"] == str(shift.id)
    assert len(exceptions_of(w, LSS.CLOUD_CLOSE_EXCEPTION)) == 1


def test_close_old_shift_without_one_is_said(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    heard(t1, 600)
    e = refused(switch, w, t2, closeOldShift=True)
    assert e.status_code == 409 and e.detail["code"] == "no_open_shift"


def test_releasing_the_shop_z_is_the_super_admins(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    heard(t1, 600)
    helper = support(w)
    e = refused(switch, w, t2, by=helper, releaseShopZ=True)
    assert e.status_code == 403 and e.detail["code"] == "release_shop_z_super_admin_only"
    assert MT.main_till_of_shop(w.db, w.shop.id).id == t1.id
    assert LSS.state(w.db, w.shop, helper)["canReleaseShopZ"] is False
    assert LSS.state(w.db, w.shop, w.admin)["canReleaseShopZ"] is True
    out = switch(w, t2, releaseShopZ=True)
    assert out["releasedShopZ"] is True


def test_the_wizard_state(w):
    t1, t2 = w.tills
    MT.set_main_till(w.db, w.shop, t1.id)
    shift = w.shift(t1, 3, status=ShiftStatus.OPEN)
    t1.pending_documents = 4
    t1.pending_count_at = datetime.now(timezone.utc)
    heard(t1, 400)
    state = LSS.state(w.db, w.shop, w.admin)
    server = state["server"]
    assert server["machineId"] == str(t1.id) and server["online"] is False and server["silentSeconds"] >= 400
    assert server["openShift"]["shiftId"] == str(shift.id) and server["canCloseFromCloud"] is True
    assert server["pendingDocuments"] == 4
    assert state["canSwitch"] and state["canForce"] and state["canReleaseShopZ"]
    assert state["closeFromCloudAfterSeconds"] == 300
    plain = user(w, name="plain")
    seen = LSS.state(w.db, w.shop, plain)
    assert seen["canSwitch"] is False and seen["canForce"] is False and seen["canReleaseShopZ"] is False
    # The card says whether the wizard is offered.
    from app.routers import main_till as main_router

    assert main_router.get_main_till(w.shop.id, current_user=plain, active_tenant_id=w.tenant.id, db=w.db)["canSwitch"] is False
    assert main_router.get_main_till(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)["canSwitch"] is True


# ── "סגירת משמרת מהענן" ──────────────────────────────────────────────────────


def close(w, till, *, by=None, **body):
    w.db.commit()  # a refusal rolls back to here
    return LR.post_close_from_cloud(
        till.id, LR.CloseFromCloudIn(**body), current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def test_only_a_till_not_heard_for_five_minutes(w):
    t1, _ = w.tills
    shift = w.shift(t1, 1, status=ShiftStatus.OPEN)
    w.doc(t1, shift, "30.00")
    w.db.commit()
    heard(t1, 120)
    e = refused(close, w, t1)
    assert e.status_code == 409 and e.detail["code"] == "till_online"
    assert "סגירת משמרת מרחוק" in e.detail["message"] and e.detail["closeFromCloudAfterSeconds"] == 300
    assert shift.status == ShiftStatus.OPEN
    heard(t1, 301)
    out = close(w, t1, reason="הקופה נפלה במהלך הערב")
    assert out["shiftId"] == str(shift.id) and out["countedCash"] is None and out["documentsOnCloud"] == 1
    assert out["label"] == LSS.CLOUD_CLOSE_LABEL and out["closedBy"] == "admin"
    w.db.refresh(shift)
    assert shift.status == ShiftStatus.CLOSED and shift.unattended is True and shift.counted_cash is None
    assert shift.z_report_id is None and shift.reconstructed is True  # no Z
    assert shift.reconstruction_basis["note"] == "הקופה נפלה במהלך הערב"
    [row] = exceptions_of(w, LSS.CLOUD_CLOSE_EXCEPTION)
    assert row.shift_id == shift.id and "המזומן לא נספר" in row.details["summary"]
    # Again: nothing open any more.
    e = refused(close, w, t1)
    assert e.detail["code"] == "no_open_shift"


def test_never_heard_counts_as_silent_and_a_shift_not_in_the_cloud_is_said(w):
    t1, _ = w.tills
    t1.last_heartbeat_at = None
    t1.reported_open_shift_id = uuid.uuid4()
    e = refused(close, w, t1)
    assert e.detail["code"] == "shift_not_in_cloud"


def test_the_remote_closes_people(w):
    t1, _ = w.tills
    w.shift(t1, 1, status=ShiftStatus.OPEN)
    heard(t1, 900)
    w.db.commit()
    cashier = user(w, UserRole.CASHIER, name="cashier")
    assert refused(close, w, t1, by=cashier).status_code == 403
    other = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=w.other_shop.id,
                 email="o@x", username="other")
    w.db.add(other)
    w.db.flush()
    assert refused(close, w, t1, by=other).status_code == 403
    # The shop's manager (as with "סגירת משמרת מרחוק"): yes, with a count.
    out = close(w, t1, by=user(w, name="manager"), countedCash=Decimal("100"))
    assert out["countedCash"] == "100.00" and out["closedBy"] == "manager"


def test_the_till_learns_it_on_its_heartbeat_and_machines_me(w):
    t1, t2 = w.tills
    shift = w.shift(t1, 1, status=ShiftStatus.OPEN)
    heard(t1, 900)
    close(w, t1)
    body = MachineHeartbeatBody.model_validate({"openShiftId": str(shift.id)})
    out = machines_router.post_my_heartbeat(body, machine=t1, db=w.db)
    block = out["shiftClosedFromCloud"]
    assert block["shiftId"] == str(shift.id) and block["closedBy"] == "admin" and block["closedAt"]
    assert out["closedOpenShift"]["shiftId"] == str(shift.id)
    me = machines_router.get_my_machine(machine=t1, db=w.db)
    assert me["shiftClosedFromCloud"] == block
    # A new shift: nothing to say.
    fresh = w.shift(t1, 2, status=ShiftStatus.OPEN)
    out = machines_router.post_my_heartbeat(
        MachineHeartbeatBody.model_validate({"openShiftId": str(fresh.id)}), machine=t1, db=w.db,
    )
    assert "shiftClosedFromCloud" not in out
    assert machines_router.get_my_machine(machine=t1, db=w.db)["shiftClosedFromCloud"] is None
    # A shift the till closed itself, or support's administrative close, is not "from the cloud".
    other = w.shift(t2, 1, status=ShiftStatus.CLOSED)
    assert LSS.shift_closed_from_cloud(w.db, t2, other.id) is None


def test_late_documents_are_taken_and_flagged(w):
    t1, _ = w.tills
    shift = w.shift(t1, 1, status=ShiftStatus.OPEN)
    w.doc(t1, shift, "20.00")
    heard(t1, 900)
    close(w, t1, countedCash=Decimal("120"))
    w.db.refresh(shift)
    assert shift.discrepancy == Decimal("0.00")
    # The till comes back and uploads what it still held.
    w.doc(t1, shift, "15.00")
    w.db.commit()
    note_documents_after_close(w.db, {shift.id: 1}, machine_id=t1.id)
    w.db.commit()
    w.db.refresh(shift)
    assert shift.late_documents == 1 and shift.transactions_count == 2
    assert shift.expected_cash == Decimal("135.00") and shift.discrepancy == Decimal("-15.00")
    [row] = exceptions_of(w, LSS.LATE_EXCEPTION)
    assert row.details["lateDocuments"] == 1 and row.shift_id == shift.id and row.severity == "high"
    assert "אחרי שהמשמרת נסגרה מהענן" in row.details["summary"]
    [closed] = exceptions_of(w, LSS.CLOUD_CLOSE_EXCEPTION)
    assert closed.details["lateDocuments"] == 1
    # More: the same exception, counted on.
    w.doc(t1, shift, "5.00")
    note_documents_after_close(w.db, {shift.id: 1}, machine_id=t1.id)
    w.db.commit()
    [row] = exceptions_of(w, LSS.LATE_EXCEPTION)
    assert row.details["lateDocuments"] == 2


def test_an_ordinary_closed_shift_raises_no_cloud_close_exception(w):
    t1, _ = w.tills
    shift = w.shift(t1, 1, status=ShiftStatus.CLOSED)
    w.doc(t1, shift, "15.00")
    note_documents_after_close(w.db, {shift.id: 1}, machine_id=t1.id)
    assert exceptions_of(w, LSS.LATE_EXCEPTION) == []


# ── Gap 1: the former server's changes ───────────────────────────────────────


def a_table(w, number=5):
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
    w.db.add(zone)
    w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number)
    w.db.add(table)
    w.db.flush()
    return table


def order(table, oid, version, total, status="open"):
    return {
        "id": str(oid), "tableId": str(table.id), "status": status, "version": version, "guests": 2,
        "itemCount": 1, "total": total, "openedAt": datetime.now(timezone.utc).isoformat(),
    }


def report(w, till, orders, former_host=False):
    body = TablesReportIn.model_validate({"orders": orders, **({"formerHost": True} if former_host else {})})
    out = T.apply_local_report(w.db, till, body.orders, former_host=body.former_host)
    w.db.commit()
    return out


def test_the_former_server_applies_only_what_the_cloud_did_not_change(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    MT.set_main_till(w.db, w.shop, t1.id)
    table, other, third = a_table(w, 5), a_table(w, 6), a_table(w, 7)
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # The host mirrored three tables, then fell.
    plain = report(w, t1, [order(table, a, 3, 50), order(other, b, 2, 40), order(third, c, 1, 10)])
    assert "results" not in plain and "formerHost" not in plain
    heard(t1, 3600)
    switch(w, t2)
    # The new server changed table 5 since.
    report(w, t2, [order(table, a, 4, 80)])
    # The old one comes back: table 5 (changed in the cloud), table 6 (not), a new one, table 7 again.
    d = uuid.uuid4()
    out = report(w, t1, [
        order(table, a, 4, 55), order(other, b, 3, 45), order(table, d, 1, 20), order(third, c, 1, 10),
    ], former_host=True)
    assert out["formerHost"] is True
    assert out["conflict"] == [str(a)]
    assert set(out["applied"]) == {str(b), str(d), str(c)}
    assert {r["orderId"]: r["status"] for r in out["results"]} == {
        str(a): "conflict", str(b): "applied", str(d): "applied", str(c): "applied",
    }
    # The cloud kept the new server's table 5; took the rest.
    assert w.db.get(TableOrder, a).total == Decimal("80.00")
    assert w.db.get(TableOrder, b).version == 3 and w.db.get(TableOrder, d) is not None
    # "X שינויים מהשרת הקודם", with the list.
    changes = LSS.state(w.db, w.shop, w.admin)["formerHostChanges"]
    assert changes["count"] == 1
    [entry] = changes["items"]
    assert entry["orderId"] == str(a) and entry["tableNumber"] == 5
    assert entry["till"]["total"] == 55.0 and entry["cloud"]["total"] == 80.0
    assert entry["machine"]["machineId"] == str(t1.id)
    # Sent again: kept once.
    report(w, t1, [order(table, a, 4, 55)], former_host=True)
    assert LSS.former_host_changes_out(w.shop)["count"] == 1
    # "סמן כנבדק".
    out = LR.post_former_host_changes_ack(
        w.shop.id, LR.AckIn(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["acknowledged"] == 1 and out["formerHostChanges"]["count"] == 0
    assert out["formerHostChanges"]["checked"][0]["acknowledgedBy"] == "admin"


def test_a_dashboard_change_since_the_switch_is_a_conflict_too(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    MT.set_main_till(w.db, w.shop, t1.id)
    table = a_table(w)
    a = uuid.uuid4()
    report(w, t1, [order(table, a, 2, 30)])
    heard(t1, 3600)
    switch(w, t2)
    row = w.db.get(TableOrder, a)
    # As the dashboard's cancel writes it (app/services/tables.py): the cloud's clock, no till.
    row.version, row.status, row.updated_machine_id = 3, "cancelled", None
    row.cloud_updated_at = datetime.now(timezone.utc)
    w.db.commit()
    out = report(w, t1, [order(table, a, 3, 35)], former_host=True)
    assert out["conflict"] == [str(a)] and w.db.get(TableOrder, a).status == "cancelled"


def test_an_order_untouched_since_the_switch_is_applied_whoever_wrote_it_before(w):
    t1, t2 = w.tills
    set_param(w, "tablesMode", "shop", w.shop.id, LAN)
    MT.set_main_till(w.db, w.shop, t1.id)
    table = a_table(w)
    a = uuid.uuid4()
    # Written by a server before this one (till 2, long ago), never changed since.
    report(w, t2, [order(table, a, 2, 30)])
    w.db.get(TableOrder, a).cloud_updated_at = datetime.now(timezone.utc) - timedelta(hours=2)
    w.db.commit()
    heard(t1, 3600)
    switch(w, t2)
    out = report(w, t1, [order(table, a, 3, 35)], former_host=True)
    assert out["applied"] == [str(a)] and out["conflict"] == []
    assert w.db.get(TableOrder, a).total == Decimal("35.00")


def test_the_report_schema_takes_former_host():
    body = TablesReportIn.model_validate({"orders": [], "formerHost": True})
    assert body.former_host is True
    assert TablesReportIn.model_validate({"orders": []}).former_host is False


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).absolute().parents[1] / "alembic" / "versions" / "3bfb94dbebb2_table_orders_cloud_updated_at.py"
        spec = importlib.util.spec_from_file_location("migration_3bfb94dbebb2", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_and_offline(self):
        import io

        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == ("3bfb94dbebb2", "c7e4a2f9d1b6")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE table_orders (id CHAR(32) PRIMARY KEY)"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            cols = {c["name"] for c in sa.inspect(conn).get_columns("table_orders")}
            assert "cloud_updated_at" in cols
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        assert "ALTER TABLE table_orders ADD COLUMN cloud_updated_at TIMESTAMP WITH TIME ZONE" in buf.getvalue()

    def test_on_the_single_head(self):
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "3bfb94dbebb2" in {r.revision for r in script.walk_revisions("base", heads[0])}
