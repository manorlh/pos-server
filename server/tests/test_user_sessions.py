"""
"עובד מחובר בקופה אחת בלבד" (app/services/user_sessions.py, app/routers/user_sessions.py,
docs/SPEC_EXCLUSIVE_LOGIN.md).

* Off (the default): a claim records nothing and always succeeds.
* On: a claim is free → claimed; again from the same till → held (idempotent); from
  another till → 409 `user_signed_in_elsewhere` with where, since when, and since when that
  device stopped reporting (`holderSilentSince`).
* v2 (P:/specs/exclusive-login-v2.md): the rule binds only who lacks MULTI_DEVICE_LOGIN — by
  role, or by the employee's own override (`exempt`, nothing recorded); a till gone silent
  loses the employee only with `exclusiveUserLoginAutoRelease = minutes` (default off); every
  answer carries the policy (`autoRelease`, `offline`, `duplicate`); `duplicate = signout`
  hands the session to the device that signed in first.
* `force` needs a manager: a grant for `user-session:release` (spent: one PIN, one
  release) or a signed-in manager bound by the rule; the release is recorded as an exception.
* Release, heartbeat (refresh, re-claim after offline, kick after a manager's release),
  the dashboard's list and release (its own permission `user_sessions_release`, recorded as an
  exception too), and a till that leaves its shop or is unpaired.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions. The
phone's "שחרור עובד מחובר" end to end: tests/test_remote_approvals.py `TestUserRelease`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.audit_exception import AuditException, TillEvent
from app.models.dashboard_access import DashboardAccessProfile
from app.models.pos_user import PosUser, PosUserRole
from app.models.pos_user_session import PosUserSession
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import user_sessions as R
from app.services import ably_notify
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import elevation
from app.services import till_parameters as TP
from app.services import till_permissions as PERMS
from app.services import till_roles
from app.services import user_sessions as S
from app.services.permissions import Scope
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    world.dana = _pos_user(world, "dana", "דנה", "כהן")
    world.boss = _pos_user(world, "boss", "רותי", "לוי", role=PosUserRole.SHOP_MANAGER)
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
    w.db.commit()


def turn_on(w, stale_minutes=None, *, auto_release=None, offline=None, duplicate=None):
    set_param(w, S.PARAM_ENABLED, "shop", w.shop.id, True)
    if stale_minutes is not None:
        set_param(w, S.PARAM_STALE_MINUTES, "shop", w.shop.id, stale_minutes)
    for key, value in ((S.PARAM_AUTO_RELEASE, auto_release), (S.PARAM_OFFLINE, offline), (S.PARAM_DUPLICATE, duplicate)):
        if value is not None:
            set_param(w, key, "shop", w.shop.id, value)


def override(w, pos_user, **states):
    """The employee card's own value for a till permission ("עקיפה לעובד")."""
    pos_user.permission_overrides = {"states": states}
    w.db.commit()


def give_role(w, pos_user, key):
    """One of the company's built-in till roles (`waiter`, `cashier`, `supervisor`, `manager`)."""
    roles = {r.builtin_key: r for r in till_roles.ensure_company_roles(w.db, w.company) if r.builtin_key}
    pos_user.till_role_id = roles[key].id
    pos_user.till_role = roles[key]
    w.db.commit()


def claim(w, till, pos_user, *, force=False, token=None, operator=None):
    return R.claim_user_session(
        machine_id=str(till.id),
        body=R.UserSessionClaimIn(posUserId=pos_user.id, force=force),
        machine=till, elevation_token=token, operator_id=operator, db=w.db,
    )


def heartbeat(w, till, pos_user, signed_in_at=None):
    return R.heartbeat_user_session(
        machine_id=str(till.id), body=R.UserSessionHeartbeatIn(posUserId=pos_user.id, signedInAt=signed_in_at),
        machine=till, db=w.db,
    )


def release(w, till, pos_user):
    return R.release_user_session(
        machine_id=str(till.id), body=R.UserSessionIn(posUserId=pos_user.id), machine=till, db=w.db,
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


def rows(w, pos_user):
    return (
        w.db.query(PosUserSession)
        .filter(PosUserSession.pos_user_id == pos_user.id)
        .order_by(PosUserSession.started_at)
        .all()
    )


def live(w, pos_user):
    return [r for r in rows(w, pos_user) if r.released_at is None]


def age(w, row, minutes):
    row.last_seen_at = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    w.db.commit()


def manager_grant(w, till, scopes=(Scope.USER_SESSION_RELEASE,)):
    raw, _session = elevation.create_session(w.db, None, till, list(scopes), pos_user=w.boss)
    w.db.commit()
    return raw


# ── The parameters ──────────────────────────────────────────────────────────


class TestParameters:
    def test_all_five_are_built_in_with_their_defaults(self, w):
        params = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert params[S.PARAM_ENABLED] is False
        assert params[S.PARAM_STALE_MINUTES] == 15
        # v2: a silent device no longer releases by itself (the owner: only a manager releases).
        assert params[S.PARAM_AUTO_RELEASE] == "off"
        assert params[S.PARAM_OFFLINE] == "allow"
        assert params[S.PARAM_DUPLICATE] == "warn"
        assert S.policy_for_machine(w.db, w.tills[0]) == S.Policy(
            enabled=False, stale_minutes=15, auto_release="off", offline="allow", duplicate="warn",
        )

    def test_the_three_new_ones_are_enums_of_codes_with_their_hebrew(self, w):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        for key, options in (
            (S.PARAM_AUTO_RELEASE, ("off", "minutes")),
            (S.PARAM_OFFLINE, ("allow", "lan", "manager")),
            (S.PARAM_DUPLICATE, ("warn", "signout")),
        ):
            spec = specs[key]
            assert spec.value_type == "enum" and tuple(spec.enum_options) == options, key
            assert set(spec.enum_labels) == set(options), key
            assert spec.label.startswith("עובד בקופה אחת — "), key
        # The rule's own wording says who it binds and who releases.
        assert "עבודה בכמה מכשירים במקביל" in specs[S.PARAM_ENABLED].description
        assert "רק מנהל" in specs[S.PARAM_ENABLED].description

    @pytest.mark.parametrize("value, expected", [
        ("minutes", "minutes"), ("MINUTES", "minutes"), ("off", "off"), ("x", "off"), (None, "off"), (True, "off"),
    ])
    def test_an_unknown_mode_is_the_default(self, value, expected):
        assert S.choice_of(value, S.AUTO_RELEASE_MODES, S.AUTO_RELEASE_OFF) == expected

    def test_a_level_sets_each_mode(self, w):
        turn_on(w, auto_release="minutes", offline="manager", duplicate="signout")
        assert S.policy_for_machine(w.db, w.tills[0]) == S.Policy(
            enabled=True, stale_minutes=15, auto_release="minutes", offline="manager", duplicate="signout",
        )

    def test_a_till_level_value_wins(self, w):
        turn_on(w)
        set_param(w, S.PARAM_ENABLED, "machine", w.tills[1].id, False)
        assert S.policy_for_machine(w.db, w.tills[0]).enabled is True
        assert S.policy_for_machine(w.db, w.tills[1]).enabled is False

    @pytest.mark.parametrize("value, expected", [
        (15, 15), ("30", 30), (1, 2), (100000, 720), (0, 15), (-5, 15), ("x", 15), (None, 15), (True, 15),
    ])
    def test_stale_minutes_are_kept_within_bounds(self, value, expected):
        assert S.stale_minutes_of(value) == expected

    @pytest.mark.parametrize("value, expected", [(True, True), ("true", True), (False, False), ("false", False), (None, False), (1, False)])
    def test_enabled_reads_only_a_true(self, value, expected):
        assert S.enabled_of(value) is expected


# ── Off ─────────────────────────────────────────────────────────────────────


class TestOff:
    def test_a_claim_always_succeeds_and_records_nothing(self, w):
        assert claim(w, w.tills[0], w.dana)["status"] == "off"
        assert claim(w, w.tills[1], w.dana)["status"] == "off"
        assert heartbeat(w, w.tills[1], w.dana)["status"] == "off"
        assert rows(w, w.dana) == []

    def test_turned_on_later_it_applies_from_the_next_heartbeat(self, w):
        claim(w, w.tills[0], w.dana)
        turn_on(w)
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "claimed"
        err = refused(claim, w, w.tills[1], w.dana)
        assert err.status_code == 409


# ── On ──────────────────────────────────────────────────────────────────────


class TestClaim:
    def test_a_free_employee_is_claimed(self, w):
        turn_on(w)
        out = claim(w, w.tills[0], w.dana)
        assert out["status"] == "claimed"
        assert out["exclusive"] is True and out["staleMinutes"] == 15
        assert (out["autoRelease"], out["offline"], out["duplicate"]) == ("off", "allow", "warn")
        [row] = live(w, w.dana)
        assert str(row.machine_id) == str(w.tills[0].id)
        assert str(row.shop_id) == str(w.shop.id) and str(row.tenant_id) == str(w.tenant.id)

    def test_claiming_again_at_the_same_till_is_idempotent(self, w):
        turn_on(w)
        first = claim(w, w.tills[0], w.dana)
        again = claim(w, w.tills[0], w.dana)
        assert again["status"] == "held"
        assert again["sessionId"] == first["sessionId"]
        assert len(rows(w, w.dana)) == 1

    def test_signed_in_elsewhere_is_409_with_where_and_since(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        err = refused(claim, w, w.tills[1], w.dana)
        assert err.status_code == 409
        detail = err.detail
        assert detail["code"] == "user_signed_in_elsewhere"
        assert detail["machineName"] == "Till 1"
        assert detail["posNumber"] == w.tills[0].pos_number
        assert detail["posUserName"] == "דנה כהן"
        assert detail["since"]
        # Till 1 reports: nothing to say about silence. The policy rides along.
        assert detail["holderSilentSince"] is None
        assert (detail["exclusive"], detail["autoRelease"], detail["duplicate"]) == (True, "off", "warn")
        # Nothing changed hands.
        [row] = live(w, w.dana)
        assert str(row.machine_id) == str(w.tills[0].id)

    def test_two_employees_at_two_tills_do_not_collide(self, w):
        turn_on(w)
        other = _pos_user(w, "yossi", "יוסי", None)
        w.db.commit()
        assert claim(w, w.tills[0], w.dana)["status"] == "claimed"
        assert claim(w, w.tills[1], other)["status"] == "claimed"

    def test_a_till_holds_one_employee_so_a_new_claim_lets_go_of_a_leftover(self, w):
        turn_on(w)
        other = _pos_user(w, "yossi", "יוסי", None)
        w.db.commit()
        claim(w, w.tills[0], other)  # its release never arrived
        claim(w, w.tills[0], w.dana)
        [left] = rows(w, other)
        assert left.released_by == "self"
        # So the other employee is free to sign in elsewhere.
        assert claim(w, w.tills[1], other)["status"] == "claimed"

    def test_an_employee_of_another_shop_is_404(self, w):
        turn_on(w)
        stranger = _pos_user(w, "north", "צפון", None, shop=w.other_shop)
        w.db.commit()
        err = refused(claim, w, w.tills[0], stranger)
        assert err.status_code == 404

    def test_the_database_allows_one_live_session_per_employee(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        w.db.add(PosUserSession(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id,
            pos_user_id=w.dana.id, machine_id=w.tills[1].id,
        ))
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()

    def test_losing_the_race_for_the_index_is_a_409_not_a_500(self, w):
        """Two tills claim at once: the one whose insert meets the index hears where the other is."""
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        with pytest.raises(S.SignedInElsewhere) as lost:
            S._insert(w.db, w.tills[1], w.dana, datetime.now(timezone.utc))
        assert lost.value.info["machineName"] == "Till 1"
        # The savepoint kept the rest of the transaction usable.
        assert len(live(w, w.dana)) == 1


class TestAutoReleaseOff:
    """The default (v2 §3): a device that stops reporting holds its employee until a manager releases."""

    def test_a_silent_till_keeps_the_employee_and_the_409_says_since_when_it_is_silent(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        row = live(w, w.dana)[0]
        age(w, row, 240)
        err = refused(claim, w, w.tills[1], w.dana)
        assert err.status_code == 409 and err.detail["code"] == "user_signed_in_elsewhere"
        assert err.detail["holderSilentSince"] == S._iso(row.last_seen_at)
        assert err.detail["autoRelease"] == "off"
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[0].id)

    def test_silent_means_three_missed_heartbeats(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 2)
        assert refused(claim, w, w.tills[1], w.dana).detail["holderSilentSince"] is None
        age(w, live(w, w.dana)[0], 3)
        assert refused(claim, w, w.tills[1], w.dana).detail["holderSilentSince"] is not None

    def test_a_heartbeat_from_another_till_does_not_take_it_either(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 600)
        err = refused(heartbeat, w, w.tills[1], w.dana)
        assert err.detail["code"] == "user_signed_in_elsewhere" and err.detail["holderSilentSince"]

    def test_signing_out_still_frees_the_employee(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 600)
        release(w, w.tills[0], w.dana)
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"


class TestStale:
    """`exclusiveUserLoginAutoRelease = minutes`: as v1, after the stale minutes."""

    def test_a_silent_till_loses_the_employee_after_the_stale_minutes(self, w):
        turn_on(w, auto_release="minutes")
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 16)
        out = claim(w, w.tills[1], w.dana)
        assert out["status"] == "claimed"
        assert out["tookOver"]["releasedBy"] == "stale"
        assert out["tookOver"]["machineName"] == "Till 1"
        old, new = rows(w, w.dana)
        assert old.released_by == "stale" and old.released_at is not None
        assert str(new.machine_id) == str(w.tills[1].id) and new.released_at is None
        # Not an exception: nobody forced anything.
        assert w.db.query(AuditException).count() == 0

    def test_the_stale_minutes_come_from_the_parameter(self, w):
        turn_on(w, stale_minutes=30, auto_release="minutes")
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 16)
        assert refused(claim, w, w.tills[1], w.dana).status_code == 409
        age(w, live(w, w.dana)[0], 31)
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"

    def test_a_heartbeat_keeps_the_session_fresh(self, w):
        turn_on(w, auto_release="minutes")
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 14)
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "held"
        age(w, live(w, w.dana)[0], 2)
        assert refused(claim, w, w.tills[1], w.dana).status_code == 409


class TestForce:
    def test_force_without_a_manager_is_401(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        err = refused(claim, w, w.tills[1], w.dana, force=True)
        assert err.status_code == 401 and err.detail == "elevation_required"
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[0].id)

    def test_a_managers_grant_releases_the_other_till_and_is_an_exception(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        token = manager_grant(w, w.tills[1])
        out = claim(w, w.tills[1], w.dana, force=True, token=token)
        assert out["status"] == "claimed"
        assert out["tookOver"]["releasedBy"] == "manager"
        assert out["tookOver"]["approvedBy"] == "רותי לוי"
        old, new = rows(w, w.dana)
        assert old.released_by == "manager" and old.released_by_name == "רותי לוי"
        assert str(old.released_by_machine_id) == str(w.tills[1].id)
        assert str(new.machine_id) == str(w.tills[1].id)

        event = w.db.query(TillEvent).filter(TillEvent.event_type == S.EXCEPTION_TYPE).one()
        assert str(event.machine_id) == str(w.tills[1].id)
        assert event.pos_user_id == str(w.dana.id)
        assert event.details["fromMachineName"] == "Till 1"
        assert event.details["approvedBy"] == "רותי לוי"
        assert event.details["via"] == "till" and event.details["approvalRequestId"] is None
        found = w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).one()
        assert found.pos_user_id == str(w.dana.id)
        assert "אישר: רותי לוי" in found.details["summary"]

    def test_the_grant_is_one_pin_one_release(self, w):
        turn_on(w)
        other = _pos_user(w, "yossi", "יוסי", None)
        w.db.commit()
        claim(w, w.tills[0], w.dana)
        token = manager_grant(w, w.tills[1])
        assert claim(w, w.tills[1], w.dana, force=True, token=token)["status"] == "claimed"
        claim(w, w.tills[0], other)
        err = refused(claim, w, w.tills[1], other, force=True, token=token)
        assert err.status_code == 401 and err.detail == "elevation_already_used"

    def test_force_when_nothing_is_held_does_not_spend_the_grant(self, w):
        turn_on(w)
        other = _pos_user(w, "yossi", "יוסי", None)
        w.db.commit()
        token = manager_grant(w, w.tills[1])
        assert claim(w, w.tills[1], w.dana, force=True, token=token)["status"] == "claimed"
        claim(w, w.tills[0], other)
        # The PIN is still good for an actual release.
        assert claim(w, w.tills[1], other, force=True, token=token)["status"] == "claimed"

    def test_a_grant_without_the_scope_is_refused(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        token = manager_grant(w, w.tills[1], scopes=(Scope.REFUND,))
        err = refused(claim, w, w.tills[1], w.dana, force=True, token=token)
        assert err.status_code == 403

    def test_a_grant_from_another_till_is_refused(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        token = manager_grant(w, w.tills[0])
        err = refused(claim, w, w.tills[1], w.dana, force=True, token=token)
        assert err.status_code == 403 and err.detail == "elevation_wrong_machine"

    def test_a_manager_bound_by_the_rule_signing_in_releases_their_own_other_session(self, w):
        turn_on(w)
        # A shop manager may work on several devices by default; this one's card says otherwise.
        override(w, w.boss, MULTI_DEVICE_LOGIN="deny")
        claim(w, w.tills[0], w.boss)
        out = claim(w, w.tills[1], w.boss, force=True, operator=str(w.boss.id))
        assert out["status"] == "claimed" and out["tookOver"]["releasedBy"] == "manager"
        assert out["tookOver"]["via"] == "till"
        assert w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).count() == 1

    def test_a_cashier_as_operator_is_not_a_manager(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        err = refused(claim, w, w.tills[1], w.dana, force=True, operator=str(w.dana.id))
        assert err.status_code == 401


class TestRelease:
    def test_release_frees_the_employee_for_another_till(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        assert release(w, w.tills[0], w.dana)["status"] == "released"
        assert rows(w, w.dana)[0].released_by == "self"
        assert release(w, w.tills[0], w.dana)["status"] == "not_held"
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"

    def test_another_till_cannot_release_it(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        assert release(w, w.tills[1], w.dana)["status"] == "not_held"
        assert len(live(w, w.dana)) == 1

    def test_release_works_with_the_rule_off_too(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        set_param(w, S.PARAM_ENABLED, "shop", w.shop.id, False)
        assert release(w, w.tills[0], w.dana)["status"] == "released"


class TestHeartbeat:
    def test_after_an_offline_sign_in_the_heartbeat_claims(self, w):
        turn_on(w)
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "claimed"
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "held"

    def test_signed_in_elsewhere_meanwhile_is_a_409_not_a_kick(self, w):
        turn_on(w)
        claim(w, w.tills[1], w.dana)
        err = refused(heartbeat, w, w.tills[0], w.dana)
        assert err.status_code == 409 and err.detail["code"] == "user_signed_in_elsewhere"
        assert err.detail["machineName"] == "Till 2"

    def test_a_till_whose_session_a_manager_released_is_told_so(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], w.dana, force=True, token=manager_grant(w, w.tills[1]))
        err = refused(heartbeat, w, w.tills[0], w.dana)
        assert err.status_code == 409
        assert err.detail["code"] == "user_session_released"
        assert err.detail["releasedBy"] == "manager"
        assert err.detail["releasedByName"] == "רותי לוי"
        assert err.detail["fromDashboard"] is False
        assert err.detail["now"]["machineName"] == "Till 2"
        # It does not take the employee back.
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[1].id)

    def test_a_stale_session_is_taken_back_by_its_own_till_when_free(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], w.boss)
        age(w, live(w, w.dana)[0], 20)
        # Till 1 was offline; meanwhile nobody claimed dana. Its next heartbeat holds again.
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "held"


def list_sessions(w, user):
    return R.list_user_sessions(shop_id=str(w.shop.id), current_user=user, active_tenant_id=w.tenant.id, db=w.db)


def dash_release(w, user, session_id, shop=None):
    return R.release_user_session_from_dashboard(
        shop_id=str((shop or w.shop).id), session_id=session_id, current_user=user,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def dash_user(w, username, role, *, full=False, sections=None, template=None):
    user = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=w.shop.id if role in (UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER) else None,
        email=f"{username}@x", username=username, is_active=True,
    )
    w.db.add(user)
    w.db.flush()
    if full or sections is not None or template is not None:
        if template is not None:
            sections = DS.BUILTIN_TEMPLATES[template]["sections"]
        w.db.add(DashboardAccessProfile(
            user_id=user.id, full_access=full, sections=dict(sections or {}), builtin_template=template,
        ))
    w.db.commit()
    DA.forget(w.db)
    return user


class TestDashboard:
    def test_who_is_signed_in_where(self, w):
        turn_on(w)
        yossi = _pos_user(w, "yossi", "יוסי", "לוי")
        w.db.commit()
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], yossi)
        age(w, live(w, yossi)[0], 30)
        out = list_sessions(w, w.admin)
        assert out["exclusive"] is True and out["canRelease"] is True
        by_name = {s["posUserName"]: s for s in out["sessions"]}
        assert by_name["דנה כהן"]["machineName"] == "Till 1"
        assert by_name["דנה כהן"]["silent"] is False and by_name["דנה כהן"]["silentSince"] is None
        # "לא מדווח": Till 2 went quiet. Auto release is off, so nothing would take it ("stale").
        assert by_name["יוסי לוי"]["silent"] is True and by_name["יוסי לוי"]["silentSince"]
        assert by_name["יוסי לוי"]["stale"] is False and by_name["יוסי לוי"]["autoRelease"] == "off"

    def test_stale_is_said_only_where_auto_release_would_take_it(self, w):
        turn_on(w, auto_release="minutes")
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 30)
        [row] = list_sessions(w, w.admin)["sessions"]
        assert row["stale"] is True and row["silent"] is True and row["staleMinutes"] == 15

    def test_a_manager_releases_and_the_till_signs_out_on_its_next_heartbeat(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        session_id = live(w, w.dana)[0].id
        out = dash_release(w, w.admin, session_id)
        assert out["status"] == "released"
        [row] = rows(w, w.dana)
        assert row.released_by == "manager" and row.released_by_name == "admin"
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"
        err = refused(heartbeat, w, w.tills[0], w.dana)
        assert err.detail["code"] == "user_session_released"
        assert err.detail["fromDashboard"] is True
        # Again: nothing left to release.
        assert dash_release(w, w.admin, session_id)["status"] == "not_held"

    def test_another_shops_session_is_404(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        err = refused(
            R.release_user_session_from_dashboard,
            shop_id=str(w.other_shop.id), session_id=live(w, w.dana)[0].id, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert err.status_code == 404


class TestATillThatLeaves:
    @pytest.mark.parametrize("change", ["unpair", "deactivate", "move"])
    def test_its_sessions_are_released(self, w, change):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        till = w.tills[0]
        if change == "unpair":
            till.token_version = (till.token_version or 1) + 1
        elif change == "deactivate":
            till.is_active = False
        else:
            till.shop_id = w.other_shop.id
        w.db.commit()
        [row] = rows(w, w.dana)
        assert row.released_by == "unpair" and row.released_at is not None

    def test_an_unrelated_change_releases_nothing(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        w.tills[0].name = "Bar"
        w.tills[0].is_active = True
        w.db.commit()
        assert len(live(w, w.dana)) == 1


# ── v2: who the rule binds — MULTI_DEVICE_LOGIN (§1) ──────────────────────────


class TestWhoIsBound:
    def test_the_permission_is_in_the_catalogue_with_the_spec_defaults(self):
        spec = PERMS.PERMISSIONS_BY_CODE["MULTI_DEVICE_LOGIN"]
        assert spec.label == "עבודה בכמה מכשירים במקביל" and spec.scope is None
        assert PERMS.DEVICE_WINDOWS in spec.devices
        expected = {
            PERMS.WAITER: "deny", PERMS.CASHIER: "deny", PERMS.SUPERVISOR: "allow", PERMS.MANAGER: "allow",
            # The legacy roles as v1 behaved for a cashier (bound), and as the spec's manager (exempt).
            PERMS.LEGACY_CASHIER: "deny", PERMS.LEGACY_MANAGER: "allow",
        }
        for key, state in expected.items():
            assert PERMS.DEFAULTS[key]["MULTI_DEVICE_LOGIN"] == state, key

    def test_release_is_a_supervisors_and_a_managers_own_right_now(self):
        """§2: a waiter or a cashier no longer asks with someone's code on their own — the default changed."""
        got = {k: PERMS.DEFAULTS[k]["USER_SESSION_RELEASE"] for k in PERMS.SPEC_ROLE_KEYS}
        assert got == {"waiter": "deny", "cashier": "deny", "supervisor": "allow", "manager": "allow"}
        # The legacy cashier is "exactly as before roles" and keeps asking a manager.
        assert PERMS.DEFAULTS[PERMS.LEGACY_CASHIER]["USER_SESSION_RELEASE"] == "approval"

    def test_a_built_in_role_row_follows_the_new_default_and_one_that_set_its_own_keeps_it(self, w):
        """Changing a default touches no stored row: a role that saved its own value keeps it."""
        roles = {r.builtin_key: r for r in till_roles.ensure_company_roles(w.db, w.company) if r.builtin_key}
        cashier = roles[PERMS.CASHIER]
        assert till_roles.role_effective(cashier).state("USER_SESSION_RELEASE") == "deny"
        cashier.permissions = {"USER_SESSION_RELEASE": "approval"}
        w.db.commit()
        assert till_roles.role_effective(cashier).state("USER_SESSION_RELEASE") == "approval"
        assert till_roles.role_effective(cashier).state("MULTI_DEVICE_LOGIN") == "deny"

    @pytest.mark.parametrize("role_key, status", [
        (PERMS.WAITER, "claimed"), (PERMS.CASHIER, "claimed"), (PERMS.SUPERVISOR, "exempt"), (PERMS.MANAGER, "exempt"),
    ])
    def test_by_role(self, w, role_key, status):
        turn_on(w)
        give_role(w, w.dana, role_key)
        assert claim(w, w.tills[0], w.dana)["status"] == status
        if status == "exempt":
            # Signed in at both, nothing recorded.
            out = claim(w, w.tills[1], w.dana)
            assert out["status"] == "exempt" and out["sessionId"] is None and out["exclusive"] is True
            assert heartbeat(w, w.tills[0], w.dana)["status"] == "exempt"
            assert rows(w, w.dana) == []
        else:
            assert refused(claim, w, w.tills[1], w.dana).status_code == 409

    def test_the_legacy_roles(self, w):
        turn_on(w)
        assert claim(w, w.tills[0], w.dana)["status"] == "claimed"  # a legacy cashier: bound
        assert claim(w, w.tills[0], w.boss)["status"] == "exempt"  # a legacy shop manager: not
        assert claim(w, w.tills[1], w.boss)["status"] == "exempt"
        assert rows(w, w.boss) == []

    def test_an_override_on_the_employee_card_wins_both_ways(self, w):
        turn_on(w)
        override(w, w.dana, MULTI_DEVICE_LOGIN="allow")
        assert claim(w, w.tills[0], w.dana)["status"] == "exempt"
        assert claim(w, w.tills[1], w.dana)["status"] == "exempt"
        override(w, w.boss, MULTI_DEVICE_LOGIN="deny")
        assert claim(w, w.tills[0], w.boss)["status"] == "claimed"
        assert refused(claim, w, w.tills[1], w.boss).status_code == 409

    def test_given_the_permission_while_signed_in_the_old_session_goes_at_its_tills_next_heartbeat(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        override(w, w.dana, MULTI_DEVICE_LOGIN="allow")
        assert claim(w, w.tills[1], w.dana)["status"] == "exempt"
        assert heartbeat(w, w.tills[0], w.dana)["status"] == "exempt"
        assert live(w, w.dana) == []
        # And losing it again: bound from the next claim.
        override(w, w.dana, MULTI_DEVICE_LOGIN="deny")
        assert claim(w, w.tills[0], w.dana)["status"] == "claimed"

    def test_an_exempt_sign_in_still_lets_go_of_who_the_till_held_before(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)  # her sign-out never arrived
        assert claim(w, w.tills[0], w.boss)["status"] == "exempt"
        assert rows(w, w.dana)[0].released_by == "self"

    def test_the_rule_off_wins_over_everything(self, w):
        override(w, w.dana, MULTI_DEVICE_LOGIN="deny")
        assert claim(w, w.tills[0], w.dana)["status"] == "off"
        assert claim(w, w.tills[0], w.boss)["status"] == "off"


# ── v2: the policy in every answer (§3, §4) ──────────────────────────────────


class TestPolicyInAnswers:
    def test_claim_and_heartbeat_say_the_modes_set_for_this_till(self, w):
        turn_on(w, auto_release="minutes", offline="lan", duplicate="signout")
        set_param(w, S.PARAM_OFFLINE, "machine", w.tills[1].id, "manager")
        out = claim(w, w.tills[0], w.dana)
        assert (out["autoRelease"], out["offline"], out["duplicate"]) == ("minutes", "lan", "signout")
        assert heartbeat(w, w.tills[0], w.dana)["offline"] == "lan"
        err = refused(claim, w, w.tills[1], w.dana)
        assert err.detail["offline"] == "manager" and err.detail["duplicate"] == "signout"

    def test_off_and_exempt_answers_carry_them_too(self, w):
        set_param(w, S.PARAM_OFFLINE, "shop", w.shop.id, "manager")
        out = claim(w, w.tills[0], w.dana)
        assert out["status"] == "off" and out["offline"] == "manager" and out["exclusive"] is False
        turn_on(w)
        out = claim(w, w.tills[0], w.boss)
        assert out["status"] == "exempt" and out["offline"] == "manager"

    def test_the_released_409_carries_them(self, w):
        turn_on(w, duplicate="signout")
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], w.dana, force=True, token=manager_grant(w, w.tills[1]))
        err = refused(heartbeat, w, w.tills[0], w.dana)
        assert err.detail["code"] == "user_session_released" and err.detail["duplicate"] == "signout"


# ── v2: found at two devices after an offline sign-in (§4) ────────────────────


def _ago(minutes):
    return datetime.now(timezone.utc) - timedelta(minutes=minutes)


class TestDuplicate:
    def test_warn_is_a_409_whatever_the_times(self, w):
        turn_on(w)
        claim(w, w.tills[1], w.dana)
        err = refused(heartbeat, w, w.tills[0], w.dana, signed_in_at=_ago(30))
        assert err.detail["code"] == "user_signed_in_elsewhere" and err.detail["duplicate"] == "warn"
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[1].id)

    def test_signout_the_till_that_signed_in_last_hears_it_is_the_one(self, w):
        turn_on(w, duplicate="signout")
        claim(w, w.tills[1], w.dana)
        # Till 1 let her in offline a moment after Till 2 claimed her: Till 1 signed in last.
        err = refused(heartbeat, w, w.tills[0], w.dana, signed_in_at=datetime.now(timezone.utc))
        assert err.detail["code"] == "user_signed_in_elsewhere" and err.detail["duplicate"] == "signout"
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[1].id)

    def test_signout_the_till_that_signed_in_first_takes_it_and_the_other_signs_out(self, w):
        turn_on(w, duplicate="signout")
        claim(w, w.tills[1], w.dana)
        # Till 1 let her in offline 30 minutes ago, before Till 2's claim: Till 2 signed in last.
        out = heartbeat(w, w.tills[0], w.dana, signed_in_at=_ago(30))
        assert out["status"] == "claimed" and out["tookOver"]["releasedBy"] == "duplicate"
        assert out["tookOver"]["machineName"] == "Till 2"
        assert str(live(w, w.dana)[0].machine_id) == str(w.tills[0].id)
        err = refused(heartbeat, w, w.tills[1], w.dana)
        assert err.detail["code"] == "user_session_released" and err.detail["releasedBy"] == "duplicate"
        assert err.detail["fromDashboard"] is False and err.detail["now"]["machineName"] == "Till 1"
        # Not a manager's release: no exception.
        assert w.db.query(TillEvent).filter(TillEvent.event_type == S.EXCEPTION_TYPE).count() == 0

    def test_a_sign_in_time_from_a_clock_far_ahead_is_not_believed(self, w):
        turn_on(w, duplicate="signout")
        claim(w, w.tills[1], w.dana)
        err = refused(heartbeat, w, w.tills[0], w.dana, signed_in_at=datetime.now(timezone.utc) + timedelta(hours=1))
        assert err.detail["code"] == "user_signed_in_elsewhere"

    def test_without_a_sign_in_time_an_older_till_hears_the_409_as_before(self, w):
        turn_on(w, duplicate="signout")
        claim(w, w.tills[1], w.dana)
        assert refused(heartbeat, w, w.tills[0], w.dana).detail["code"] == "user_signed_in_elsewhere"

    def test_signed_in_again_after_a_release_is_a_new_sign_in_not_a_kick(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        dash_release(w, w.admin, live(w, w.dana)[0].id)
        # The till signs her out, then she signs in again there with no connection.
        assert refused(heartbeat, w, w.tills[0], w.dana, signed_in_at=_ago(60)).detail["code"] == "user_session_released"
        assert heartbeat(w, w.tills[0], w.dana, signed_in_at=datetime.now(timezone.utc))["status"] == "claimed"


# ── v2: the dashboard's own permission (§2) ───────────────────────────────────


class TestDashboardPermission:
    def _held(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        return live(w, w.dana)[0].id

    @pytest.mark.parametrize("role", [UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.DISTRIBUTOR])
    def test_a_manager_with_full_access_releases(self, w, role):
        session_id = self._held(w)
        user = dash_user(w, "m", role, full=True)
        assert list_sessions(w, user)["canRelease"] is True
        assert dash_release(w, user, session_id)["status"] == "released"

    def test_the_shop_managers_template_holds_it_and_the_area_managers_does_not(self, w):
        session_id = self._held(w)
        branch = dash_user(w, "branch", UserRole.SHOP_MANAGER, template=DS.BRANCH_MANAGER_TEMPLATE)
        area = dash_user(w, "area", UserRole.SHOP_MANAGER, template=DS.AREA_MANAGER_TEMPLATE)
        assert DS.BRANCH_MANAGER_SECTIONS[S.RELEASE_SECTION] == DS.EDIT
        assert S.RELEASE_SECTION not in DS.AREA_MANAGER_SECTIONS
        assert S.may_release_from_dashboard(w.db, area) is False
        assert refused(dash_release, w, area, session_id).status_code == 403
        assert dash_release(w, branch, session_id)["status"] == "released"

    def test_editing_the_employees_is_no_longer_enough(self, w):
        session_id = self._held(w)
        user = dash_user(w, "staff", UserRole.SHOP_MANAGER, sections={"pos_users": "edit"})
        out = list_sessions(w, user)
        assert out["canRelease"] is False and len(out["sessions"]) == 1
        err = refused(dash_release, w, user, session_id)
        assert err.status_code == 403 and err.detail["section"] == "user_sessions_release"

    def test_the_permission_alone_reads_and_releases(self, w):
        session_id = self._held(w)
        user = dash_user(w, "rel", UserRole.SHOP_MANAGER, sections={"user_sessions_release": "edit"})
        assert list_sessions(w, user)["canRelease"] is True
        assert dash_release(w, user, session_id)["status"] == "released"

    @pytest.mark.parametrize("role", [UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER])
    def test_never_a_role_below_a_manager(self, w, role):
        session_id = self._held(w)
        user = dash_user(w, "low", role, sections={"user_sessions_release": "edit"})
        assert S.may_release_from_dashboard(w.db, user) is False
        assert refused(dash_release, w, user, session_id).status_code == 403

    def test_a_shop_manager_of_another_shop_cannot(self, w):
        set_param(w, S.PARAM_ENABLED, "shop", w.other_shop.id, True)
        north = _pos_user(w, "north", "צפון", None, shop=w.other_shop)
        w.db.commit()
        claim(w, w.other_till, north)
        user = dash_user(w, "sm", UserRole.SHOP_MANAGER, full=True)
        err = refused(dash_release, w, user, live(w, north)[0].id, shop=w.other_shop)
        assert err.status_code == 403

    def test_the_route_rules(self):
        get = DS.rule_for("GET", "/shops/{shop_id}/user-sessions")
        assert set(get.sections) == {"pos_users", "user_sessions_release"} and get.needed_level("GET") == DS.VIEW
        post = DS.rule_for("POST", "/shops/{shop_id}/user-sessions/{session_id}/release")
        assert post.sections == ("user_sessions_release",) and post.needed_level("POST") == DS.EDIT
        assert "user_sessions_release" in DS.SECTION_IDS


# ── v2: every manager's release is an exception (§2) ─────────────────────────


def _exceptions(w):
    return w.db.query(AuditException).filter(AuditException.exception_type == S.EXCEPTION_TYPE).all()


class TestEveryReleaseIsAnException:
    def test_a_code_at_the_till(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], w.dana, force=True, token=manager_grant(w, w.tills[1]))
        [found] = _exceptions(w)
        assert found.details["via"] == "till" and "אישר: רותי לוי" in found.details["summary"]

    def test_the_signed_in_manager(self, w):
        turn_on(w)
        override(w, w.boss, MULTI_DEVICE_LOGIN="deny")
        claim(w, w.tills[0], w.boss)
        claim(w, w.tills[1], w.boss, force=True, operator=str(w.boss.id))
        [found] = _exceptions(w)
        assert found.details["via"] == "till" and found.details["approvedByPosUserId"] == str(w.boss.id)

    def test_the_dashboard_at_the_till_it_was_released_from(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        dash_release(w, w.admin, live(w, w.dana)[0].id)
        event = w.db.query(TillEvent).filter(TillEvent.event_type == S.EXCEPTION_TYPE).one()
        assert str(event.machine_id) == str(w.tills[0].id) and event.pos_user_id == str(w.dana.id)
        assert event.details["via"] == "dashboard" and event.details["approvedBy"] == "admin"
        assert event.details["approvedByUserId"] == str(w.admin.id)
        [found] = _exceptions(w)
        assert "מהדשבורד" in found.details["summary"] and "אישר: admin" in found.details["summary"]

    def test_not_a_stale_one_nor_a_sign_out(self, w):
        turn_on(w, auto_release="minutes")
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 20)
        claim(w, w.tills[1], w.dana)
        release(w, w.tills[1], w.dana)
        assert _exceptions(w) == []

    def test_a_dashboard_release_of_a_session_already_gone_records_nothing(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        session_id = live(w, w.dana)[0].id
        release(w, w.tills[0], w.dana)
        assert dash_release(w, w.admin, session_id)["status"] == "not_held"
        assert _exceptions(w) == []


# ── v2: "בקשת שחרור ממנהל" — the request's payload (§2) ───────────────────────


class TestApprovalPayload:
    def test_the_line_the_approver_reads(self, w):
        turn_on(w)
        w.tills[0].pos_number, w.tills[0].name = "1", "בר"
        w.tills[1].pos_number, w.tills[1].name = "3", "קופה 3"
        w.db.commit()
        claim(w, w.tills[0], w.dana)
        out = S.approval_payload(w.db, w.tills[1], w.dana, {"note": "x"})
        assert out["note"] == "x" and out["posUserId"] == str(w.dana.id) and out["posUserName"] == "דנה כהן"
        assert out["holder"]["machineName"] == "בר" and out["holder"]["holderSilentSince"] is None
        assert out["summary"].startswith("דנה כהן מנסה להתחבר בקופה 3, ומחובר/ת בקופה 1 (בר) מאז ")
        age(w, live(w, w.dana)[0], 10)
        assert "המכשיר לא מדווח מאז" in S.approval_payload(w.db, w.tills[1], w.dana, None)["summary"]

    def test_the_employee_named_by_the_till_and_never_one_of_another_shop(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        out = S.approval_payload(w.db, w.tills[1], None, {"posUserId": str(w.dana.id)})
        assert out["posUserName"] == "דנה כהן" and "holder" in out
        north = _pos_user(w, "north", "צפון", None, shop=w.other_shop)
        w.db.commit()
        out = S.approval_payload(w.db, w.tills[1], None, {"posUserId": str(north.id)})
        assert "summary" not in out and "holder" not in out


# ── The wording on an existing database (alembic 7c4e2a9d1b6f) ───────────────


def _wording_migration():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).parents[1] / "alembic" / "versions" / "7c4e2a9d1b6f_exclusive_login_v2_wording.py"
    spec = importlib.util.spec_from_file_location("exclusive_login_v2_wording_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Conn:
    """`till_parameters` as Postgres returns it (key → [id, description]), and the updates made."""

    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def execute(self, statement, params):
        from types import SimpleNamespace

        sql = str(statement)
        if sql.startswith("SELECT"):
            row = self.rows.get(params["key"])
            return SimpleNamespace(first=lambda: None if row is None else (row[0], row[1]))
        self.updates.append(params["id"])
        for row in self.rows.values():
            if row[0] == params["id"]:
                row[1] = params["description"]
        return None


def _run(module, conn, step):
    from types import SimpleNamespace

    module.op = SimpleNamespace(get_bind=lambda: conn)
    getattr(module, step)()


class TestWordingMigration:
    def test_it_speaks_the_built_in_definitions(self):
        m = _wording_migration()
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        assert m.down_revision == "bb6205ba290c"
        assert m.NEW_ENABLED_DESCRIPTION == specs[S.PARAM_ENABLED].description
        assert m.NEW_STALE_DESCRIPTION == specs[S.PARAM_STALE_MINUTES].description
        # The v1 texts, word for word as the built-ins were.
        assert "קופה שהפסיקה לדווח משתחררת לבד" in m.OLD_ENABLED_DESCRIPTION
        assert m.OLD_STALE_DESCRIPTION.startswith("קופה שמחובר בה עובד ולא דיווחה לענן")

    def test_it_rewords_the_old_texts_once_and_back(self):
        m = _wording_migration()
        conn = _Conn({
            S.PARAM_ENABLED: ["p-1", m.OLD_ENABLED_DESCRIPTION],
            S.PARAM_STALE_MINUTES: ["p-2", m.OLD_STALE_DESCRIPTION],
        })
        _run(m, conn, "upgrade")
        assert conn.rows[S.PARAM_ENABLED][1] == m.NEW_ENABLED_DESCRIPTION
        assert conn.rows[S.PARAM_STALE_MINUTES][1] == m.NEW_STALE_DESCRIPTION
        assert conn.updates == ["p-1", "p-2"]
        _run(m, conn, "upgrade")
        assert conn.updates == ["p-1", "p-2"]
        _run(m, conn, "downgrade")
        assert conn.rows[S.PARAM_ENABLED][1] == m.OLD_ENABLED_DESCRIPTION
        assert conn.rows[S.PARAM_STALE_MINUTES][1] == m.OLD_STALE_DESCRIPTION

    def test_a_super_admins_own_wording_and_a_missing_definition_are_left_alone(self):
        m = _wording_migration()
        conn = _Conn({S.PARAM_ENABLED: ["p-1", "הניסוח שלנו"]})
        _run(m, conn, "upgrade")
        assert conn.rows[S.PARAM_ENABLED][1] == "הניסוח שלנו" and conn.updates == []
