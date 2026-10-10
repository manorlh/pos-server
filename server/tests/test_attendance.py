"""
"נוכחות עובדים" — phase 1 (app/services/attendance.py, app/routers/attendance.py,
docs/SPEC_ATTENDANCE.md).

* The parameters: built in, and their defaults change nothing.
* The till's outbox: idempotent by the till's ids, set-once per field, tolerant of
  actions that arrive late, twice or out of order; device and cloud times both kept, a
  wrong device clock flagged (and an offline delay not).
* The state machine: working → on break → working → finished; worked time less breaks.
* The separation (§2): signing in, out, switching user or the idle lock (the exclusive
  login's claim / release) never start or end an attendance shift.
* Open tables: the till's clock-out over them is kept and flagged (an exception when a
  manager approved it); a manager's close is refused under the parameter unless confirmed.
* Corrections: requested at the till, approved / rejected / edited on the dashboard,
  with the old and the new values; a manager's own correction and close; the audit.
* Permissions: read by every dashboard role but the cashier, scoped to their shops;
  written by the till users' managers.
* The report: rows, notes and per-employee totals.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response

from app.models.attendance import AttendanceAdjustment, AttendanceBreak, AttendanceShift, EmployeeRole
from app.models.audit_exception import AuditException
from app.models.pos_user import PosUser, PosUserRole
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import attendance as R
from app.routers import user_sessions as US
from app.schemas.attendance import (
    AttendanceActionIn,
    DecisionIn,
    EmployeeRoleAssignIn,
    ManagerAdjustmentIn,
    ManagerCloseIn,
)
from app.services import ably_notify
from app.services import attendance as S
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    world.dana = _pos_user(world, "dana", "דנה", "כהן")
    world.yossi = _pos_user(world, "yossi", "יוסי", "לוי")
    world.boss = _pos_user(world, "boss", "רותי", "מנהלת", role=PosUserRole.SHOP_MANAGER)
    world.north = _pos_user(world, "nir", "ניר", "צפון", shop=world.other_shop)
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north-mgr", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    world.supervisor = _user(world, "sup", UserRole.SHIFT_SUPERVISOR, shop=world.shop)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    return world


def _pos_user(w, username, first, last, role=PosUserRole.CASHIER, shop=None):
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, username=username,
        first_name=first, last_name=last, pin_hash="x", role=role, is_active=True,
    )
    w.db.add(pu)
    w.db.flush()
    return pu


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def set_param(w, key, value, scope_type="shop", scope_id=None):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    scope_id = scope_id or w.shop.id
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def act(w, till, user, type_, *, shift_id=None, at=None, sent_at="now", break_id=None, **extra):
    """One action as the till's outbox delivers it; (body, http status)."""
    at = at or now()
    payload = {
        "id": str(uuid.uuid4()),
        "type": type_,
        "posUserId": str(user.id),
        "shiftId": str(shift_id) if shift_id else None,
        "breakId": str(break_id) if break_id else None,
        "at": at.isoformat(),
        "sentAt": (now() if sent_at == "now" else sent_at).isoformat() if sent_at else None,
        **extra,
    }
    response = Response()
    out = R.post_attendance_action(
        machine_id=str(till.id), body=AttendanceActionIn.model_validate(payload), response=response,
        machine=till, db=w.db,
    )
    return out, response.status_code


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


def shift_row(w, shift_id) -> AttendanceShift:
    w.db.expire_all()
    return w.db.get(AttendanceShift, shift_id)


def open_table(w, waiter: PosUser, number=12, total="428.00", opener: PosUser = None):
    zone = w.db.query(TableZone).filter(TableZone.shop_id == w.shop.id).first()
    if zone is None:
        zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם", layout="grid")
        w.db.add(zone)
        w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number)
    w.db.add(table)
    w.db.flush()
    order = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, table_number=number,
        status="open", source="synced", total=Decimal(total), guests=4,
        opened_by_pos_user_id=str((opener or waiter).id), opened_by_pos_user_name="x",
        waiter_pos_user_id=str(waiter.id) if opener is None else str(waiter.id),
    )
    w.db.add(order)
    w.db.commit()
    return order


def clock_in(w, user, till=None, at=None):
    sid = uuid.uuid4()
    out, code = act(w, till or w.tills[0], user, "clock_in", shift_id=sid, at=at)
    assert code == 201
    return sid, out


# ── The parameters ──────────────────────────────────────────────────────────


class TestParameters:
    def test_built_in_with_defaults_that_change_nothing(self, w):
        params = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert params[S.PARAM_ENABLED] is False
        assert params[S.PARAM_REQUIRE_CLOCK_IN] is False
        assert params[S.PARAM_PREVENT_OPEN_TABLES] is True
        assert params[S.PARAM_REQUIRE_MANAGER] is False
        assert S.policy_for_machine(w.db, w.tills[0]) == S.Policy()

    def test_labels_are_hebrew(self, w):
        labels = {p.key: p.label for p in TP.BUILTIN_PARAMETERS}
        assert labels[S.PARAM_ENABLED].startswith("נוכחות")
        assert "שולחנות פתוחים" in labels[S.PARAM_PREVENT_OPEN_TABLES]

    def test_a_shop_value_wins(self, w):
        set_param(w, S.PARAM_ENABLED, True)
        set_param(w, S.PARAM_REQUIRE_MANAGER, True)
        policy = S.policy_for_machine(w.db, w.tills[0])
        assert policy.enabled and policy.require_manager and policy.prevent_open_tables

    def test_values_as_text(self):
        assert S.policy_of({S.PARAM_ENABLED: "כן", S.PARAM_PREVENT_OPEN_TABLES: "false"}) == S.Policy(
            enabled=True, prevent_open_tables=False,
        )


# ── The till's outbox: idempotent, order-tolerant ───────────────────────────


class TestOfflineSync:
    def test_clock_in_twice_is_one_shift(self, w):
        sid = uuid.uuid4()
        at = now() - timedelta(hours=2)
        first, code1 = act(w, w.tills[0], w.dana, "clock_in", shift_id=sid, at=at)
        again, code2 = act(w, w.tills[0], w.dana, "clock_in", shift_id=sid, at=at + timedelta(minutes=9))
        assert (code1, code2) == (201, 200)
        assert again["status"] == "duplicate"
        assert w.db.query(AttendanceShift).count() == 1
        # Set once: the replay's other time never overwrites the first.
        assert S.as_utc(shift_row(w, sid).clock_in_at) == at

    def test_breaks_and_clock_out_replayed(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=4))
        bid = uuid.uuid4()
        for _ in range(3):
            act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=bid, at=now() - timedelta(hours=3))
            act(w, w.tills[0], w.dana, "break_end", shift_id=sid, break_id=bid, at=now() - timedelta(hours=2, minutes=30))
        out_at = now() - timedelta(minutes=10)
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=out_at)
        replay, code = act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=now())
        assert code == 200 and replay["status"] == "duplicate"
        assert w.db.query(AttendanceBreak).count() == 1
        row = shift_row(w, sid)
        assert S.as_utc(row.clock_out_at) == out_at
        assert row.status == "finished"

    def test_clock_out_before_its_clock_in_arrives(self, w):
        sid = uuid.uuid4()
        cin = now() - timedelta(hours=8)
        out, _ = act(w, w.tills[1], w.dana, "clock_out", shift_id=sid, at=now() - timedelta(hours=1),
                     shiftClockInAt=cin.isoformat(), shiftClockInMachineId=str(w.tills[0].id))
        row = shift_row(w, sid)
        assert S.as_utc(row.clock_in_at) == cin
        assert row.clock_in_machine_id == w.tills[0].id
        assert row.clock_out_machine_id == w.tills[1].id
        assert S.FLAG_LATE_EVENT in row.flags
        # The clock-in itself arrives later: nothing changes.
        late, code = act(w, w.tills[0], w.dana, "clock_in", shift_id=sid, at=cin + timedelta(minutes=3))
        assert code == 200 and late["status"] == "duplicate"
        assert S.as_utc(shift_row(w, sid).clock_in_at) == cin
        assert shift_row(w, sid).status == "finished"

    def test_break_end_before_its_start(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=3))
        bid = uuid.uuid4()
        started = now() - timedelta(hours=2)
        act(w, w.tills[0], w.dana, "break_end", shift_id=sid, break_id=bid, at=now() - timedelta(hours=1),
            breakStartedAt=started.isoformat())
        act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=bid, at=started)
        row = w.db.get(AttendanceBreak, bid)
        assert S.as_utc(row.start_at) == started and row.end_at is not None
        assert shift_row(w, sid).status == "working"

    def test_correction_request_replayed_is_one(self, w):
        sid, _ = clock_in(w, w.dana)
        cid = str(uuid.uuid4())
        correction = {"id": cid, "kind": "missing_in", "requestedTime": (now() - timedelta(hours=1)).isoformat(),
                      "reason": "שכחתי"}
        act(w, w.tills[0], w.dana, "correction_request", shift_id=sid, correction=correction)
        again, code = act(w, w.tills[0], w.dana, "correction_request", shift_id=sid, correction=correction)
        assert code == 200 and again["status"] == "duplicate"
        assert w.db.query(AttendanceAdjustment).count() == 1

    def test_a_correction_before_its_shift_places_the_shift(self, w):
        sid = uuid.uuid4()
        cin = now() - timedelta(hours=1)
        act(w, w.tills[0], w.dana, "correction_request", shift_id=sid, shiftClockInAt=cin.isoformat(), correction={
            "id": str(uuid.uuid4()), "kind": "missing_in", "requestedTime": (cin - timedelta(hours=1)).isoformat(),
            "reason": "שכחתי",
        })
        row = shift_row(w, sid)
        assert row is not None and S.as_utc(row.clock_in_at) == cin
        assert w.db.query(AttendanceAdjustment).one().shift_id == sid

    def test_device_and_cloud_times_kept(self, w):
        at = now() - timedelta(hours=3)
        sid, _ = clock_in(w, w.dana, at=at)
        row = shift_row(w, sid)
        assert S.as_utc(row.clock_in_device_at) == at
        assert row.clock_in_server_at is not None and S.as_utc(row.clock_in_server_at) > at

    def test_an_offline_delay_is_not_a_wrong_clock(self, w):
        # Clocked in 3 hours ago, delivered now with the device's clock right.
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=3))
        row = shift_row(w, sid)
        assert abs(row.clock_skew_seconds) < 60
        assert S.FLAG_CLOCK_SKEW not in (row.flags or [])

    def test_a_wrong_device_clock_is_flagged(self, w):
        sid = uuid.uuid4()
        act(w, w.tills[0], w.dana, "clock_in", shift_id=sid, at=now() - timedelta(minutes=20),
            sent_at=now() - timedelta(minutes=12))
        row = shift_row(w, sid)
        assert row.clock_skew_seconds >= 11 * 60
        assert S.FLAG_CLOCK_SKEW in row.flags

    def test_another_employees_shift_id_is_refused(self, w):
        sid, _ = clock_in(w, w.dana)
        err = refused(act, w, w.tills[0], w.yossi, "clock_out", shift_id=sid)
        assert err.status_code == 409 and err.detail["code"] == "attendance_id_conflict"

    def test_an_employee_of_another_shop_is_unknown_here(self, w):
        err = refused(act, w, w.tills[0], w.north, "clock_in", shift_id=uuid.uuid4())
        assert err.status_code == 404


# ── The state machine ───────────────────────────────────────────────────────


class TestRules:
    def test_working_break_working_finished(self, w):
        start = now() - timedelta(hours=5)
        sid, out = clock_in(w, w.dana, at=start)
        assert out["shift"]["status"] == "working"
        bid = uuid.uuid4()
        out, _ = act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=bid, at=start + timedelta(hours=2))
        assert out["shift"]["status"] == "on_break"
        out, _ = act(w, w.tills[0], w.dana, "break_end", shift_id=sid, break_id=bid,
                     at=start + timedelta(hours=2, minutes=30))
        assert out["shift"]["status"] == "working"
        out, _ = act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=start + timedelta(hours=5))
        assert out["shift"]["status"] == "finished"
        assert out["shift"]["breakSeconds"] == 30 * 60
        assert out["shift"]["workedSeconds"] == 4 * 3600 + 30 * 60
        assert out["shift"]["closedBy"] == "self"

    def test_clock_out_during_a_break_ends_it(self, w):
        start = now() - timedelta(hours=3)
        sid, _ = clock_in(w, w.dana, at=start)
        bid = uuid.uuid4()
        act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=bid, at=start + timedelta(hours=2))
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=start + timedelta(hours=2, minutes=20))
        row = w.db.get(AttendanceBreak, bid)
        assert S.as_utc(row.end_at) == start + timedelta(hours=2, minutes=20)

    def test_one_shift_across_tills(self, w):
        # In at till 1, a break at till 2, out at till 1 — one shift (spec §8).
        start = now() - timedelta(hours=6)
        sid, _ = clock_in(w, w.dana, till=w.tills[0], at=start)
        bid = uuid.uuid4()
        act(w, w.tills[1], w.dana, "break_start", shift_id=sid, break_id=bid, at=start + timedelta(hours=1))
        act(w, w.tills[1], w.dana, "break_end", shift_id=sid, break_id=bid, at=start + timedelta(hours=1, minutes=15))
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=start + timedelta(hours=6))
        assert w.db.query(AttendanceShift).count() == 1
        row = shift_row(w, sid)
        assert (row.clock_in_machine_id, row.clock_out_machine_id) == (w.tills[0].id, w.tills[0].id)

    def test_two_open_shifts_of_one_employee_are_flagged(self, w):
        first, _ = clock_in(w, w.dana, till=w.tills[0])
        second, _ = clock_in(w, w.dana, till=w.tills[1])
        assert S.FLAG_OVERLAP in shift_row(w, first).flags
        assert S.FLAG_OVERLAP in shift_row(w, second).flags

    def test_a_clock_out_never_precedes_the_clock_in(self, w):
        start = now() - timedelta(hours=1)
        sid, _ = clock_in(w, w.dana, at=start)
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=start - timedelta(minutes=5))
        row = shift_row(w, sid)
        assert S.as_utc(row.clock_out_at) == start

    def test_the_till_state_shows_the_open_shift_from_any_till(self, w):
        sid, _ = clock_in(w, w.dana, till=w.tills[0], at=now() - timedelta(hours=1))
        state = R.get_attendance_state(machine_id=str(w.tills[1].id), pos_user_id=str(w.dana.id), shift_id=None,
                                       machine=w.tills[1], db=w.db)
        assert state["shift"]["id"] == str(sid)
        assert state["shift"]["status"] == "working"
        assert state["openTables"] == []
        nobody = R.get_attendance_state(machine_id=str(w.tills[1].id), pos_user_id=str(w.yossi.id), shift_id=None,
                                        machine=w.tills[1], db=w.db)
        assert nobody["shift"] is None

    def test_the_till_asks_about_a_shift_a_manager_closed(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        R.close_shift(shift_id=sid, body=ManagerCloseIn(reason="שכחה לצאת"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        state = R.get_attendance_state(machine_id=str(w.tills[0].id), pos_user_id=str(w.dana.id), shift_id=str(sid),
                                       machine=w.tills[0], db=w.db)
        assert state["shift"] is None
        assert state["known"]["status"] == "finished" and state["known"]["closedBy"] == "manager"


# ── §2: the login is not attendance ─────────────────────────────────────────


class TestSeparation:
    def _exclusive_on(self, w):
        from app.services import user_sessions as USS

        set_param(w, USS.PARAM_ENABLED, True)

    def test_sign_in_sign_out_and_switching_tills_never_touch_the_shift(self, w):
        self._exclusive_on(w)
        sid, _ = clock_in(w, w.dana, till=w.tills[0])
        before = shift_row(w, sid).status
        for till in (w.tills[0], w.tills[1]):
            US.claim_user_session(machine_id=str(till.id), body=US.UserSessionClaimIn(posUserId=w.dana.id, force=False),
                                  machine=till, elevation_token=None, operator_id=str(w.boss.id), db=w.db)
            US.heartbeat_user_session(machine_id=str(till.id), body=US.UserSessionIn(posUserId=w.dana.id),
                                      machine=till, db=w.db)
            # A sign-out, a switch of user and the idle lock all release the same way.
            US.release_user_session(machine_id=str(till.id), body=US.UserSessionIn(posUserId=w.dana.id),
                                    machine=till, db=w.db)
        row = shift_row(w, sid)
        assert row.clock_out_at is None and row.status == before == "working"
        assert w.db.query(AttendanceShift).count() == 1

    def test_signing_in_does_not_clock_anyone_in(self, w):
        self._exclusive_on(w)
        US.claim_user_session(machine_id=str(w.tills[0].id), body=US.UserSessionClaimIn(posUserId=w.yossi.id),
                              machine=w.tills[0], elevation_token=None, operator_id=None, db=w.db)
        assert w.db.query(AttendanceShift).count() == 0

    def test_a_dashboard_release_of_the_login_leaves_the_shift(self, w):
        self._exclusive_on(w)
        sid, _ = clock_in(w, w.dana)
        US.claim_user_session(machine_id=str(w.tills[0].id), body=US.UserSessionClaimIn(posUserId=w.dana.id),
                              machine=w.tills[0], elevation_token=None, operator_id=None, db=w.db)
        from app.models.pos_user_session import PosUserSession

        session = w.db.query(PosUserSession).filter(PosUserSession.pos_user_id == w.dana.id).one()
        US.release_user_session_from_dashboard(shop_id=str(w.shop.id), session_id=session.id, current_user=w.manager,
                                               active_tenant_id=w.tenant.id, db=w.db)
        assert shift_row(w, sid).clock_out_at is None

    def test_the_service_never_reads_the_login(self):
        # The live page *shows* the till signed in at; nothing in the rules reads it.
        import inspect

        source = inspect.getsource(S)
        # The code (not the module's docstring, which explains the rule) up to the dashboard.
        rules = source.split('"""', 2)[2].split("# ── The dashboard's scope")[0]
        assert "PosUserSession" not in rules and "user_sessions" not in rules


# ── Open tables ─────────────────────────────────────────────────────────────


class TestOpenTables:
    def test_the_waiters_open_tables(self, w):
        open_table(w, w.dana, 12, "428.00")
        open_table(w, w.yossi, 14, "90.00")
        tables = S.open_tables_for(w.db, w.shop.id, w.dana.id)
        assert [(t["number"], t["total"]) for t in tables] == [(12, 428.0)]

    def test_the_till_state_lists_them(self, w):
        open_table(w, w.dana, 7, "100.00")
        state = R.get_attendance_state(machine_id=str(w.tills[0].id), pos_user_id=str(w.dana.id), shift_id=None,
                                       machine=w.tills[0], db=w.db)
        assert [t["number"] for t in state["openTables"]] == [7]

    def test_a_till_clock_out_over_open_tables_is_kept_flagged_and_reported(self, w):
        open_table(w, w.dana, 12)
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        out, code = act(
            w, w.tills[0], w.dana, "clock_out", shift_id=sid,
            approval={"posUserId": str(w.boss.id), "name": "רותי", "reason": "open_tables"},
            openTables=[{"tableId": "t", "number": 12, "total": 428.0}],
        )
        assert code == 201 and out["shift"]["status"] == "finished"
        row = shift_row(w, sid)
        assert S.FLAG_OPEN_TABLES in row.flags
        assert row.details["clockOutApproval"]["verified"] is True
        exc = w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).one()
        assert "שולחנות פתוחים" in exc.details["summary"]

    def test_an_approver_who_is_not_a_manager_is_flagged(self, w):
        sid, _ = clock_in(w, w.dana)
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid,
            approval={"posUserId": str(w.yossi.id), "name": "יוסי", "reason": "require_manager"})
        assert S.FLAG_APPROVAL_UNVERIFIED in shift_row(w, sid).flags

    def test_a_managers_close_is_refused_over_open_tables(self, w):
        open_table(w, w.dana, 12, "428.00")
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        err = refused(R.close_shift, shift_id=sid, body=ManagerCloseIn(reason="יצאה"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        assert err.status_code == 409 and err.detail["code"] == "open_tables"
        assert [t["number"] for t in err.detail["tables"]] == [12]
        assert shift_row(w, sid).clock_out_at is None

    def test_confirmed_it_closes_and_keeps_the_tables(self, w):
        open_table(w, w.dana, 12)
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        R.close_shift(shift_id=sid, body=ManagerCloseIn(reason="יצאה", ignoreOpenTables=True),
                      current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        row = shift_row(w, sid)
        assert row.status == "finished" and S.FLAG_OPEN_TABLES in row.flags

    def test_the_parameter_off_lets_the_manager_close(self, w):
        set_param(w, S.PARAM_PREVENT_OPEN_TABLES, False)
        open_table(w, w.dana, 12)
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        R.close_shift(shift_id=sid, body=ManagerCloseIn(reason="יצאה"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        assert shift_row(w, sid).status == "finished"


# ── Corrections ─────────────────────────────────────────────────────────────


def _request(w, sid, kind, requested, *, field=None, end=None, reason="שכחתי"):
    cid = uuid.uuid4()
    correction = {"id": str(cid), "kind": kind, "requestedTime": requested.isoformat(), "reason": reason}
    if field:
        correction["field"] = field
    if end:
        correction["requestedEndTime"] = end.isoformat()
    act(w, w.tills[0], w.dana, "correction_request", shift_id=sid, correction=correction)
    return cid


def _decide(w, cid, decision="approve", user=None, **times):
    body = DecisionIn.model_validate({"decision": decision, **{k: v.isoformat() for k, v in times.items()}})
    return R.decide_adjustment(adjustment_id=cid, body=body, current_user=user or w.manager,
                               active_tenant_id=w.tenant.id, db=w.db)


class TestCorrections:
    def test_requested_at_the_till_it_waits(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=2))
        adj = w.db.get(AttendanceAdjustment, cid)
        assert adj.status == "pending" and adj.source == "till"
        assert adj.original_time is not None and adj.requested_by_name == "דנה כהן"
        # Open shift: still working; listed as pending for managers.
        assert shift_row(w, sid).status == "working"
        listed = R.list_adjustments(status_filter="pending", company_id=None, shop_id=None, pos_user_id=None,
                                    current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert [a["id"] for a in listed["adjustments"]] == [str(cid)] and listed["canManage"] is True

    def test_a_finished_shift_with_a_request_is_pending_approval(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=3))
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "wrong_time", now() - timedelta(minutes=30), field="clock_out")
        assert shift_row(w, sid).status == "pending_approval"
        _decide(w, cid, "reject")
        assert shift_row(w, sid).status == "finished"

    def test_approved_the_time_changes_with_its_audit(self, w):
        cin = now() - timedelta(hours=1)
        sid, _ = clock_in(w, w.dana, at=cin)
        wanted = now() - timedelta(hours=2)
        cid = _request(w, sid, "missing_in", wanted)
        out = _decide(w, cid)
        assert out["status"] == "approved" and out["decidedByName"] == "mgr"
        assert S.as_utc(shift_row(w, sid).clock_in_at) == wanted
        adj = w.db.get(AttendanceAdjustment, cid)
        assert adj.old_value["clockInAt"] == cin.isoformat()
        assert adj.new_value["clockInAt"] == wanted.isoformat()
        exc = w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).one()
        assert exc.details["adjustmentId"] == str(cid) and exc.pos_user_id == str(w.dana.id)

    def test_edited_another_time_is_approved(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=3))
        edited = now() - timedelta(hours=2)
        out = _decide(w, cid, approvedTime=edited)
        assert out["approvedTime"] == edited.isoformat() and out["requestedTime"] != out["approvedTime"]
        assert S.as_utc(shift_row(w, sid).clock_in_at) == edited

    def test_rejected_nothing_changes(self, w):
        cin = now() - timedelta(hours=1)
        sid, _ = clock_in(w, w.dana, at=cin)
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=3))
        _decide(w, cid, "reject")
        assert S.as_utc(shift_row(w, sid).clock_in_at) == cin
        assert w.db.query(AuditException).count() == 0

    def test_decided_once(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=3))
        _decide(w, cid, "reject")
        err = refused(_decide, w, cid)
        assert err.status_code == 409 and err.detail["code"] == "already_decided"

    def test_an_impossible_result_is_refused_and_changes_nothing(self, w):
        cin = now() - timedelta(hours=3)
        sid, _ = clock_in(w, w.dana, at=cin)
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "wrong_time", cin - timedelta(hours=1), field="clock_out")
        err = refused(_decide, w, cid)
        assert err.status_code == 400 and err.detail["code"] == "clock_out_before_clock_in"
        assert w.db.get(AttendanceAdjustment, cid).status == "pending"

    def test_a_missing_out_closes_the_open_shift(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=9))
        cid = _request(w, sid, "missing_out", now() - timedelta(hours=1))
        _decide(w, cid)
        row = shift_row(w, sid)
        assert row.status == "finished" and row.closed_by == "manager" and row.closed_by_name == "mgr"

    def test_a_whole_missing_shift_is_opened_on_approval(self, w):
        cid = uuid.uuid4()
        start, end = now() - timedelta(hours=10), now() - timedelta(hours=2)
        act(w, w.tills[0], w.dana, "correction_request", correction={
            "id": str(cid), "kind": "missing_in", "requestedTime": start.isoformat(),
            "requestedEndTime": end.isoformat(), "reason": "לא הייתה קופה",
        })
        _decide(w, cid)
        adj = w.db.get(AttendanceAdjustment, cid)
        row = shift_row(w, adj.shift_id)
        assert row.source == "dashboard" and row.status == "finished"
        assert S.as_utc(row.clock_in_at) == start and S.as_utc(row.clock_out_at) == end

    def test_a_managers_own_correction_applies_at_once(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=4))
        start, end = now() - timedelta(hours=3), now() - timedelta(hours=2, minutes=30)
        out = R.create_adjustment(body=ManagerAdjustmentIn.model_validate({
            "shopId": str(w.shop.id), "posUserId": str(w.dana.id), "kind": "break", "shiftId": str(sid),
            "time": start.isoformat(), "endTime": end.isoformat(), "reason": "הפסקה שלא נרשמה",
        }), current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert out["status"] == "approved" and out["source"] == "dashboard"
        (row,) = w.db.query(AttendanceBreak).filter(AttendanceBreak.shift_id == sid).all()
        assert row.source == "dashboard" and S.as_utc(row.end_at) == end

    def test_a_managers_close_needs_a_reason_and_is_audited(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=2))
        shift = shift_row(w, sid)
        with pytest.raises(S.AttendanceError) as caught:
            S.manager_close(w.db, shift, at=None, reason="  ", user=w.manager)
        assert caught.value.code == "reason_required"
        R.close_shift(shift_id=sid, body=ManagerCloseIn(reason="שכחה לצאת"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        adj = w.db.query(AttendanceAdjustment).filter(AttendanceAdjustment.kind == "manager_close").one()
        assert adj.reason == "שכחה לצאת" and adj.old_value["clockOutAt"] is None and adj.new_value["clockOutAt"]
        assert shift_row(w, sid).closed_by == "manager"
        assert w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).count() == 1
        err = refused(R.close_shift, shift_id=sid, body=ManagerCloseIn(reason="שוב"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        assert err.status_code == 409


# ── Permissions ─────────────────────────────────────────────────────────────


def _live(w, user, **kw):
    return R.get_live(company_id=kw.get("company_id"), shop_id=kw.get("shop_id"), role_id=kw.get("role_id"),
                      current_user=user, active_tenant_id=w.tenant.id, db=w.db)


class TestPermissions:
    def _two_shops(self, w):
        clock_in(w, w.dana, till=w.tills[0])
        sid = uuid.uuid4()
        act(w, w.other_till, w.north, "clock_in", shift_id=sid)
        return sid

    def test_a_dashboard_cashier_sees_nothing(self, w):
        self._two_shops(w)
        assert refused(_live, w, w.cashier).status_code == 403

    def test_a_shop_manager_sees_their_shop(self, w):
        self._two_shops(w)
        assert [c["posUserName"] for c in _live(w, w.manager)["shifts"]] == ["דנה כהן"]
        assert [c["posUserName"] for c in _live(w, w.north_manager)["shifts"]] == ["ניר צפון"]

    def test_company_manager_and_admin_see_the_companys(self, w):
        self._two_shops(w)
        assert len(_live(w, w.company_manager)["shifts"]) == 2
        assert len(_live(w, w.admin)["shifts"]) == 2
        assert len(_live(w, w.admin, shop_id=w.other_shop.id)["shifts"]) == 1

    def test_a_supervisor_reads_but_does_not_decide(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        assert len(_live(w, w.supervisor)["shifts"]) == 1
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=2))
        assert refused(_decide, w, cid, user=w.supervisor).status_code == 403
        assert refused(R.close_shift, shift_id=sid, body=ManagerCloseIn(reason="x"), current_user=w.supervisor,
                       active_tenant_id=w.tenant.id, db=w.db).status_code == 403

    def test_another_shops_manager_cannot_touch_it(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=2))
        assert refused(_decide, w, cid, user=w.north_manager).status_code == 403
        # Not even visible to close.
        assert refused(R.close_shift, shift_id=sid, body=ManagerCloseIn(reason="x"), current_user=w.north_manager,
                       active_tenant_id=w.tenant.id, db=w.db).status_code == 404

    def test_the_live_card(self, w):
        open_table(w, w.dana, 3)
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(minutes=90))
        (card,) = _live(w, w.manager)["shifts"]
        assert card["id"] == str(sid) and card["openTables"] == 1
        assert card["durationSeconds"] >= 90 * 60 - 5
        assert card["clockInMachine"]["name"] == "Till 1"
        assert card["currentMachine"] is None  # not signed in anywhere: still on shift


# ── The report ──────────────────────────────────────────────────────────────


class TestReport:
    def _report(self, w, user=None, **kw):
        today = now().date()
        return R.get_report(from_date=today - timedelta(days=2), to_date=today + timedelta(days=1),
                            company_id=None, shop_id=kw.get("shop_id"), pos_user_id=kw.get("pos_user_id"),
                            role_id=kw.get("role_id"), current_user=user or w.manager,
                            active_tenant_id=w.tenant.id, db=w.db)

    def test_rows_notes_and_totals(self, w):
        start = now() - timedelta(hours=10)
        sid, _ = clock_in(w, w.dana, at=start)
        bid = uuid.uuid4()
        act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=bid, at=start + timedelta(hours=3))
        act(w, w.tills[0], w.dana, "break_end", shift_id=sid, break_id=bid, at=start + timedelta(hours=3, minutes=30))
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, at=start + timedelta(hours=8))
        other, _ = clock_in(w, w.yossi, at=now() - timedelta(hours=3))
        R.close_shift(shift_id=other, body=ManagerCloseIn(reason="יצא"), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        out = self._report(w)
        rows = {r["posUserName"]: r for r in out["rows"]}
        dana = rows["דנה כהן"]
        assert dana["workedSeconds"] == 7 * 3600 + 30 * 60 and dana["breakCount"] == 1
        assert dana["breakSeconds"] == 30 * 60 and dana["notes"] == []
        assert dana["date"] == S.as_utc(start).astimezone(__import__("zoneinfo").ZoneInfo("Asia/Jerusalem")).date().isoformat()
        assert "closed_by_manager" in rows["יוסי לוי"]["notes"]
        assert out["totals"]["shifts"] == 2
        by = {r["posUserName"]: r for r in out["byEmployee"]}
        assert by["דנה כהן"]["workedSeconds"] == 7 * 3600 + 30 * 60

    def test_filters(self, w):
        clock_in(w, w.dana, at=now() - timedelta(hours=2))
        clock_in(w, w.yossi, at=now() - timedelta(hours=2))
        assert [r["posUserName"] for r in self._report(w, pos_user_id=w.dana.id)["rows"]] == ["דנה כהן"]
        assert self._report(w, w.north_manager)["rows"] == []
        assert refused(self._report, w, w.cashier).status_code == 403

    def test_an_approved_correction_is_noted(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=1))
        cid = _request(w, sid, "missing_in", now() - timedelta(hours=2))
        _decide(w, cid)
        (row,) = self._report(w)["rows"]
        assert "corrected" in row["notes"] and row["correctionCount"] == 1


# ── Job titles ──────────────────────────────────────────────────────────────


class TestRoles:
    def test_defaults_once_and_assignment_snapshot_on_clock_in(self, w):
        out = R.add_default_roles(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        names = [r["name"] for r in out["roles"]]
        assert names[:3] == ["מלצר", "ברמן", "ראנר"] and len(names) == 6
        R.add_default_roles(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert w.db.query(EmployeeRole).count() == 6
        waiter = w.db.query(EmployeeRole).filter(EmployeeRole.name == "מלצר").one()
        assert float(waiter.tip_weight) == 1.0
        R.assign_role(pos_user_id=w.dana.id, body=EmployeeRoleAssignIn(roleId=waiter.id), current_user=w.manager,
                      active_tenant_id=w.tenant.id, db=w.db)
        # The permission role is untouched.
        assert w.db.get(PosUser, w.dana.id).role == PosUserRole.CASHIER
        sid, out = clock_in(w, w.dana)
        assert out["shift"]["roleName"] == "מלצר"
        assert len(_live(w, w.manager, role_id=waiter.id)["shifts"]) == 1

    def test_a_shop_manager_assigns_but_does_not_define(self, w):
        assert refused(R.add_default_roles, current_user=w.manager, active_tenant_id=w.tenant.id,
                       db=w.db).status_code == 403
        listed = R.list_roles(include_inactive=False, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db)
        assert listed["canEdit"] is False


# ── "קוד עובד בכל פעולה" and "שעון נוכחות" (the owner, 09.10: "חייב קוד") ──────


class TestCodePerAction:
    """
    `attendanceRequireCodePerAction`: on by default, resolved through the layers like every
    till parameter. The till checks the code (offline, as its sign-in does) and says how
    each action was confirmed; the cloud keeps that on the shift once per action, flags what
    a manager should see, and reports a manager acting for an employee as an exception.
    """

    def test_built_in_on_by_default_with_a_hebrew_label(self, w):
        params = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert params[S.PARAM_REQUIRE_CODE] is True
        assert S.policy_for_machine(w.db, w.tills[0]).require_code_per_action is True
        spec = {p.key: p for p in TP.BUILTIN_PARAMETERS}[S.PARAM_REQUIRE_CODE]
        assert spec.value_type == "boolean" and spec.default_value is True
        assert spec.label.startswith("נוכחות") and "קוד" in spec.label
        assert "שעון נוכחות" in spec.description and "מנהל" in spec.description
        # The clock on the sign-in screen is described where attendance is turned on.
        assert "שעון נוכחות" in {p.key: p for p in TP.BUILTIN_PARAMETERS}[S.PARAM_ENABLED].description

    def test_resolved_company_shop_area_till(self, w):
        from app.models.shop_area import ShopArea

        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
        w.db.add(area)
        w.db.flush()
        w.tills[0].area_id = area.id
        w.db.commit()

        def resolved():
            w.db.expire_all()
            return S.policy_for_machine(w.db, w.tills[0]).require_code_per_action

        set_param(w, S.PARAM_REQUIRE_CODE, False, "company", w.company.id)
        assert resolved() is False
        set_param(w, S.PARAM_REQUIRE_CODE, True, "shop", w.shop.id)
        assert resolved() is True
        set_param(w, S.PARAM_REQUIRE_CODE, False, "area", area.id)
        assert resolved() is False
        set_param(w, S.PARAM_REQUIRE_CODE, True, "machine", w.tills[0].id)
        assert resolved() is True
        # The other till of the shop has no area value: the shop's.
        assert S.policy_for_machine(w.db, w.tills[1]).require_code_per_action is True

    def test_values_as_text(self):
        assert S.policy_of({S.PARAM_REQUIRE_CODE: "לא"}).require_code_per_action is False
        assert S.policy_of({}).require_code_per_action is True

    def test_each_action_is_logged_once_with_how_it_was_confirmed(self, w):
        sid = uuid.uuid4()
        clock = {"verifiedBy": "code", "origin": "clock"}
        body = {
            "id": str(uuid.uuid4()), "type": "clock_in", "posUserId": str(w.dana.id), "shiftId": str(sid),
            "at": now().isoformat(), "sentAt": now().isoformat(), **clock,
        }
        for _ in range(2):  # the outbox delivers it twice
            R.post_attendance_action(
                machine_id=str(w.tills[0].id), body=AttendanceActionIn.model_validate(body), response=Response(),
                machine=w.tills[0], db=w.db,
            )
        bid = uuid.uuid4()
        act(w, w.tills[1], w.dana, "break_start", shift_id=sid, break_id=bid, verifiedBy="code", origin="session")
        row = shift_row(w, sid)
        log = row.details["actionLog"]
        assert [(e["type"], e["verifiedBy"], e["origin"]) for e in log] == [
            ("clock_in", "code", "clock"),
            ("break_start", "code", "session"),
        ]
        assert log[1]["machineId"] == str(w.tills[1].id)
        assert not {S.FLAG_NO_CODE, S.FLAG_ON_BEHALF} & set(row.flags or [])

    def test_a_session_action_without_the_code_is_flagged_where_required(self, w):
        sid, _ = clock_in(w, w.dana)
        act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=uuid.uuid4(), verifiedBy="session",
            origin="session")
        assert S.FLAG_NO_CODE in shift_row(w, sid).flags

    def test_with_the_parameter_off_a_session_action_is_fine(self, w):
        set_param(w, S.PARAM_REQUIRE_CODE, False)
        sid, _ = clock_in(w, w.dana)
        act(w, w.tills[0], w.dana, "clock_out", shift_id=sid, verifiedBy="session", origin="session")
        row = shift_row(w, sid)
        assert S.FLAG_NO_CODE not in (row.flags or [])
        assert row.details["actionLog"][-1]["verifiedBy"] == "session"

    def test_an_older_till_sends_nothing_and_nothing_is_logged(self, w):
        sid, _ = clock_in(w, w.dana)
        row = shift_row(w, sid)
        assert "actionLog" not in (row.details or {}) and S.FLAG_NO_CODE not in (row.flags or [])

    def test_a_manager_acting_for_an_employee_is_logged_flagged_and_reported(self, w):
        sid, _ = clock_in(w, w.dana, at=now() - timedelta(hours=3))
        out, code = act(
            w, w.tills[0], w.dana, "clock_out", shift_id=sid, verifiedBy="manager", origin="session",
            onBehalf={"posUserId": str(w.boss.id), "name": "רותי", "reason": "on_behalf"},
        )
        assert code == 201 and out["shift"]["status"] == "finished"
        row = shift_row(w, sid)
        entry = row.details["actionLog"][-1]
        assert entry["verifiedBy"] == "manager"
        assert entry["onBehalf"] == {"posUserId": str(w.boss.id), "name": "רותי מנהלת", "verified": True}
        assert S.FLAG_ON_BEHALF in row.flags and S.FLAG_APPROVAL_UNVERIFIED not in row.flags
        exc = w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).one()
        assert exc.details["kind"] == "on_behalf" and exc.details["action"] == "clock_out"
        assert "יציאה באישור מנהל" in exc.details["summary"] and "רותי" in exc.details["summary"]

    def test_one_acting_for_another_who_is_no_manager_is_flagged(self, w):
        sid, _ = clock_in(w, w.dana)
        act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=uuid.uuid4(), verifiedBy="manager",
            origin="session", onBehalf={"posUserId": str(w.yossi.id), "name": "יוסי", "reason": "on_behalf"})
        flags = shift_row(w, sid).flags
        assert S.FLAG_ON_BEHALF in flags and S.FLAG_APPROVAL_UNVERIFIED in flags

    def test_a_correction_requested_at_the_clock_is_logged_on_its_shift(self, w):
        sid, _ = clock_in(w, w.dana)
        out, code = act(
            w, w.tills[0], w.dana, "correction_request", shift_id=sid, verifiedBy="code", origin="clock",
            correction={"id": str(uuid.uuid4()), "kind": "wrong_time", "field": "clock_in",
                        "requestedTime": (now() - timedelta(minutes=30)).isoformat(), "reason": "שכחתי"},
        )
        assert code == 201 and out["adjustment"]["status"] == "pending"
        assert shift_row(w, sid).details["actionLog"][-1]["type"] == "correction_request"

    def test_an_unknown_word_is_kept_not_refused(self, w):
        sid, _ = clock_in(w, w.dana)
        _, code = act(w, w.tills[0], w.dana, "break_start", shift_id=sid, break_id=uuid.uuid4(),
                      verifiedBy="card", origin="clock")
        assert code == 201
        assert shift_row(w, sid).details["actionLog"][-1]["verifiedBy"] == "card"

    def test_no_code_ever_reaches_the_cloud(self):
        fields = {f.alias or name for name, f in AttendanceActionIn.model_fields.items()}
        fields |= set(AttendanceActionIn.model_fields)
        assert not {f for f in fields if any(w in f.lower() for w in ("pin", "code", "password"))}


# ── The wiring ──────────────────────────────────────────────────────────────


def test_the_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for route in (
        ("POST", "/api/v1/sync/{machine_id}/attendance/actions"),
        ("GET", "/api/v1/sync/{machine_id}/attendance/state"),
        ("GET", "/api/v1/attendance/live"),
        ("GET", "/api/v1/attendance/report"),
        ("GET", "/api/v1/attendance/adjustments"),
        ("POST", "/api/v1/attendance/adjustments/{adjustment_id}/decision"),
        ("POST", "/api/v1/attendance/shifts/{shift_id}/close"),
    ):
        assert route in mounted, route


def test_the_exception_type_is_in_the_catalog():
    from app.services import exceptions as EX

    spec = EX.RULES_BY_TYPE[S.EXCEPTION_TYPE]
    assert spec.default_enabled and spec.available
