"""
"עובד מחובר בקופה אחת בלבד" (app/services/user_sessions.py, app/routers/user_sessions.py,
docs/SPEC_EXCLUSIVE_LOGIN.md).

* Off (the default): a claim records nothing and always succeeds.
* On: a claim is free → claimed; again from the same till → held (idempotent); from
  another till → 409 `user_signed_in_elsewhere` with where and since when.
* A till gone silent for the stale minutes loses the employee to the next claim.
* `force` needs a manager: a grant for `user-session:release` (spent: one PIN, one
  release) or a signed-in shop manager; the release is recorded as an exception.
* Release, heartbeat (refresh, re-claim after offline, kick after a manager's release),
  the dashboard's list and release, and a till that leaves its shop or is unpaired.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.audit_exception import AuditException, TillEvent
from app.models.pos_user import PosUser, PosUserRole
from app.models.pos_user_session import PosUserSession
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import user_sessions as R
from app.services import ably_notify
from app.services import elevation
from app.services import till_parameters as TP
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


def turn_on(w, stale_minutes=None):
    set_param(w, S.PARAM_ENABLED, "shop", w.shop.id, True)
    if stale_minutes is not None:
        set_param(w, S.PARAM_STALE_MINUTES, "shop", w.shop.id, stale_minutes)


def claim(w, till, pos_user, *, force=False, token=None, operator=None):
    return R.claim_user_session(
        machine_id=str(till.id),
        body=R.UserSessionClaimIn(posUserId=pos_user.id, force=force),
        machine=till, elevation_token=token, operator_id=operator, db=w.db,
    )


def heartbeat(w, till, pos_user):
    return R.heartbeat_user_session(
        machine_id=str(till.id), body=R.UserSessionIn(posUserId=pos_user.id), machine=till, db=w.db,
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
    def test_both_are_built_in_and_default_to_off_and_15(self, w):
        params = TP.till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert params[S.PARAM_ENABLED] is False
        assert params[S.PARAM_STALE_MINUTES] == 15
        assert S.policy_for_machine(w.db, w.tills[0]) == S.Policy(enabled=False, stale_minutes=15)

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


class TestStale:
    def test_a_silent_till_loses_the_employee_after_the_stale_minutes(self, w):
        turn_on(w)
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
        turn_on(w, stale_minutes=30)
        claim(w, w.tills[0], w.dana)
        age(w, live(w, w.dana)[0], 16)
        assert refused(claim, w, w.tills[1], w.dana).status_code == 409
        age(w, live(w, w.dana)[0], 31)
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"

    def test_a_heartbeat_keeps_the_session_fresh(self, w):
        turn_on(w)
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
        token = manager_grant(w, w.tills[1])
        assert claim(w, w.tills[1], w.dana, force=True, token=token)["status"] == "claimed"
        claim(w, w.tills[0], w.boss)
        # The PIN is still good for an actual release.
        assert claim(w, w.tills[1], w.boss, force=True, token=token)["status"] == "claimed"

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

    def test_a_shop_manager_signing_in_releases_their_own_other_session(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.boss)
        out = claim(w, w.tills[1], w.boss, force=True, operator=str(w.boss.id))
        assert out["status"] == "claimed" and out["tookOver"]["releasedBy"] == "manager"
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


class TestDashboard:
    def test_who_is_signed_in_where(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        claim(w, w.tills[1], w.boss)
        age(w, live(w, w.boss)[0], 30)
        out = R.list_user_sessions(
            shop_id=str(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["exclusive"] is True
        by_name = {s["posUserName"]: s for s in out["sessions"]}
        assert by_name["דנה כהן"]["machineName"] == "Till 1"
        assert by_name["דנה כהן"]["stale"] is False
        assert by_name["רותי לוי"]["stale"] is True

    def test_a_manager_releases_and_the_till_signs_out_on_its_next_heartbeat(self, w):
        turn_on(w)
        claim(w, w.tills[0], w.dana)
        session_id = live(w, w.dana)[0].id
        out = R.release_user_session_from_dashboard(
            shop_id=str(w.shop.id), session_id=session_id, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["status"] == "released"
        [row] = rows(w, w.dana)
        assert row.released_by == "manager" and row.released_by_name == "admin"
        assert claim(w, w.tills[1], w.dana)["status"] == "claimed"
        err = refused(heartbeat, w, w.tills[0], w.dana)
        assert err.detail["code"] == "user_session_released"
        assert err.detail["fromDashboard"] is True

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
